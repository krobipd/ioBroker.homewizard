import type * as utils from "@iobroker/adapter-core";
import { classifyError, isAuthError, UNSTABLE_DISCONNECT_THRESHOLD } from "./connection-utils";
import { errText, sanitizeForLog } from "./coerce";
import { HomeWizardApiError, type HomeWizardClient } from "./homewizard-client";
import {
  computeReconnectDelay,
  decideUnstableTransition,
  findConnectionForState as resolveConnectionForState,
  pickRestPollInterval,
  shouldEmitAfterCooldown,
  shouldStartIpRecovery,
} from "./main-helpers";
import type { StateManager } from "./state-manager";
import type { BatteryControl, DeviceConfig, DeviceConnection, Measurement, SystemInfo } from "./types";
import type { HomeWizardWebSocket, TimerDeps, WsCallbacks } from "./websocket-client";

/** WebSocket reconnect base delay in milliseconds */
const WS_RECONNECT_BASE_MS = 5_000;
/** Maximum WebSocket reconnect delay in milliseconds. Exported — main's IP-recovery log references it. */
export const WS_RECONNECT_MAX_MS = 300_000;
/** REST fallback poll interval in milliseconds */
const REST_POLL_MS = 10_000;
/** Max auth failures before giving up */
const MAX_AUTH_FAILURES = 3;
/** WS failures before starting mDNS IP recovery */
const WS_FAILURES_BEFORE_MDNS = 3;
/** Retry mDNS every N WS failures after first attempt (~1 hour at 5 min cap) */
const MDNS_RETRY_EVERY = 12;
/** Connection must last this long to count as "stable" */
const STABLE_THRESHOLD_MS = 600_000;
/** Max reconnect delay for unstable devices */
const WS_RECONNECT_MAX_UNSTABLE_MS = 60_000;
/** REST fallback interval for unstable devices (slower, not stopped) */
const REST_POLL_UNSTABLE_MS = 30_000;
/**
 * Cooldown window for `device unreachable` warns. Per-device, category-
 * spanning: bouncing hardware should produce max 1× warn per window, regardless
 * of whether each cycle's failure was TIMEOUT, NETWORK, or HTTP_503. Survives
 * the lastErrorCode-reset on recovery so chronic bouncing doesn't flap warn /
 * debug at every cycle.
 */
const WARN_COOLDOWN_MS = 60 * 60 * 1000;
/** Cooldown window for `connection restored` infos — analog to warn cooldown. */
const INFO_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Collaborators the {@link ConnectionManager} needs from the adapter. All members
 * are read/called lazily (never captured at construction) so the unit-test seams
 * — `makeClient`/`makeWebSocket`/`stateManager` overridden on the adapter AFTER
 * `new HomeWizard()` — still propagate. Discovery/pairing/IP-recovery stay in
 * main (they share the single mDNS browser); the manager only asks main to
 * `requestIpRecovery()` and reports `onDeviceConnected()`.
 */
export interface ConnectionManagerHost {
  /** The state manager (set in onReady; resolved lazily so the test seam propagates). */
  getStateManager(): StateManager;
  /** True once onUnload has begun — async paths bail before further writes. */
  isUnloading(): boolean;
  /**
   * REST client factory (test seam).
   *
   * @param ip Device IP.
   * @param token Bearer token.
   * @param certCn Stored cert CN for per-device TLS pinning.
   * @param serial Device serial — pins by CN-suffix when no CN is stored yet.
   */
  makeClient(ip: string, token: string, certCn?: string, serial?: string): HomeWizardClient;
  /**
   * WS client factory (test seam).
   *
   * @param ip Device IP.
   * @param token Bearer token.
   * @param callbacks WS event callbacks.
   * @param timers Adapter-managed timer bundle.
   * @param certCn Stored cert CN for per-device TLS pinning.
   * @param serial Device serial — pins by CN-suffix when no CN is stored yet.
   */
  makeWebSocket(
    ip: string,
    token: string,
    callbacks: WsCallbacks,
    timers: TimerDeps,
    certCn?: string,
    serial?: string,
  ): HomeWizardWebSocket;
  /**
   * Persist a device config to its device object native.
   *
   * @param config Device configuration.
   */
  saveDeviceToObject(config: DeviceConfig): Promise<void>;
  /** Start mDNS IP-recovery — owned by main (shares the discovery browser with pairing). */
  requestIpRecovery(): void;
  /** A device just authenticated — main may stop IP-recovery once all devices are connected. */
  onDeviceConnected(): void;
}

/**
 * Owns the per-device connection registry and the reconnect/error state machine:
 * initial connect, WebSocket push handling, REST fallback, exponential-backoff
 * reconnect, adaptive unstable-mode, system polling, auth-stop and de-duplicated
 * error logging. Lifecycle, pairing, device persistence and mDNS IP-recovery
 * stay in main.ts (they own the discovery browser); the two sides talk over the
 * narrow {@link ConnectionManagerHost} interface.
 */
export class ConnectionManager {
  private readonly adapter: utils.AdapterInstance;
  private readonly host: ConnectionManagerHost;
  /** Device connections keyed by state-ID prefix (`<productType>_<serial>`). */
  readonly connections = new Map<string, DeviceConnection>();
  /**
   * Per-device last-warn timestamp for chronic-bouncing cooldown. Key =
   * `conn.config.serial` (category-spanning). The classifyError-based
   * `lastErrorCode`-dedup in {@link logDeviceError} resets on every recovery,
   * so on chronic bouncing a new disconnect counts as "first occurrence" →
   * warn again. This stamp persists across recoveries so the user sees max one
   * warn per WARN_COOLDOWN_MS per device.
   */
  readonly lastWarnAt = new Map<string, number>();
  /** Per-device last-info timestamp for `connection restored`. Analog cooldown. */
  readonly lastInfoAt = new Map<string, number>();

  /**
   * @param adapter The ioBroker adapter instance (timers, state writes, log, namespace).
   * @param host    Collaborators owned by main (see {@link ConnectionManagerHost}).
   */
  constructor(adapter: utils.AdapterInstance, host: ConnectionManagerHost) {
    this.adapter = adapter;
    this.host = host;
  }

  /**
   * Drop the per-device warn/info cooldown stamps for a serial (on device removal).
   *
   * @param serial The device serial whose cooldown stamps to drop.
   */
  dropCooldowns(serial: string): void {
    this.lastWarnAt.delete(serial);
    this.lastInfoAt.delete(serial);
  }

  /**
   * Find the connection that owns a state ID. Delegates to the pure helper so the
   * lookup math is unit-tested separately (`lib/main-helpers.test.ts`).
   *
   * @param stateId Full state ID.
   */
  findConnectionForState(stateId: string): DeviceConnection | undefined {
    return resolveConnectionForState(stateId, this.adapter.namespace, this.connections);
  }

  /**
   * Close a connection's WebSocket and clear its poll + reconnect timers.
   *
   * @param conn Device connection to tear down.
   */
  teardownConnection(conn: DeviceConnection): void {
    conn.wsClient?.close();
    if (conn.pollTimer) {
      this.adapter.clearInterval(conn.pollTimer);
      conn.pollTimer = undefined;
    }
    if (conn.reconnectTimer) {
      this.adapter.clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = undefined;
    }
  }

  /**
   * Initialize a newly discovered device — fetch info and connect WebSocket.
   *
   * @param conn Device connection with IP set.
   */
  async initDevice(conn: DeviceConnection): Promise<void> {
    if (this.host.isUnloading() || conn.removed) {
      return;
    }
    try {
      const client = this.host.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);
      const info = await client.getDeviceInfo();
      if (this.host.isUnloading() || conn.removed) {
        return;
      }
      // Lazy migration + startup drift-sync, both from the `info` we just fetched
      // (one persist instead of two round-trips):
      //   • certCn — devices paired before v0.13.0 have none. M4: this first connect
      //     already ran under the serial-suffix pin (makeClient with conn.config.serial),
      //     so the token was never exposed under a blanket agent. Capture the full CN
      //     now for the exact-CN pin (createDeviceAgent) on later connects.
      //   • productName — pick up a rename that happened while the adapter was down.
      //     Doing it here means the first pollSystemInfo needs no redundant getDeviceInfo
      //     just to catch a downtime-rename (F3).
      let configChanged = false;
      if (!conn.config.certCn) {
        const certCn = client.getServerCertCn();
        if (certCn) {
          conn.config.certCn = certCn;
          configChanged = true;
        }
      }
      const newName = sanitizeForLog(info.product_name);
      if (info.product_name && newName !== conn.config.productName) {
        this.adapter.log.info(`${conn.config.productName}: name changed to '${newName}' — updating object`);
        conn.config.productName = newName;
        configChanged = true;
      }
      if (configChanged) {
        this.host
          .saveDeviceToObject(conn.config)
          .catch((err: unknown) =>
            this.adapter.log.debug(`Failed to persist device config for ${conn.config.productName}: ${errText(err)}`),
          );
      }
      const key = this.host.getStateManager().devicePrefix(conn.config);
      await this.adapter.setStateAsync(`${key}.info.firmware`, {
        val: info.firmware_version,
        ack: true,
      });
    } catch (err) {
      if (this.host.isUnloading()) {
        return;
      }
      this.logDeviceError(conn, "init", err);
    }

    if (this.host.isUnloading() || conn.removed) {
      return;
    }
    this.connectWebSocket(conn);
    void this.pollSystemInfo(conn);
  }

  /**
   * Connect WebSocket for a device.
   *
   * @param conn Device connection.
   */
  connectWebSocket(conn: DeviceConnection): void {
    // I16: bail during shutdown (defensive — callers + teardownConnection already
    // clear the reconnect timer, but a new caller must not spawn a socket on unload).
    if (this.host.isUnloading() || !conn.ip) {
      return; // shutting down, or no IP yet — wait for mDNS
    }

    // Stop reconnecting if auth keeps failing
    if (conn.authFailCount >= MAX_AUTH_FAILURES) {
      return;
    }

    // Mark as recovering so concurrent triggers (mDNS broadcast race,
    // overlapping reconnect timer) don't spawn a second wsClient.
    conn.recovering = true;

    // Close any existing wsClient before creating a new one. The normal
    // disconnect path nulls conn.wsClient, but IP-recovery jumps in directly
    // and would otherwise leak the old socket.
    if (conn.wsClient) {
      conn.wsClient.close();
      conn.wsClient = null;
    }

    // After repeated failures, try mDNS periodically to find a new IP
    if (shouldStartIpRecovery(conn.wsFailCount, WS_FAILURES_BEFORE_MDNS, MDNS_RETRY_EVERY)) {
      this.host.requestIpRecovery();
    }

    // Thin callbacks delegating to instance methods (extracted for readability + unit-testability).
    const wsClient = this.host.makeWebSocket(
      conn.ip,
      conn.config.token,
      {
        onMeasurement: data => this.onWsMeasurement(conn, data),
        onSystem: data => this.onWsSystem(conn, data),
        onBattery: data => this.onWsBattery(conn, data),
        onConnected: () => this.onWsConnected(conn),
        onDisconnected: error => this.onWsDisconnected(conn, error),
        log: this.adapter.log,
      },
      {
        schedule: (cb, ms) => this.adapter.setTimeout(cb, ms),
        cancel: h => {
          this.adapter.clearTimeout(h as ioBroker.Timeout);
        },
        scheduleRepeating: (cb, ms) => this.adapter.setInterval(cb, ms),
        cancelRepeating: h => {
          this.adapter.clearInterval(h as ioBroker.Interval);
        },
      },
      conn.config.certCn,
      conn.config.serial,
    );

    conn.wsClient = wsClient;
    try {
      wsClient.connect();
    } catch (err) {
      // connect() builds the WebSocket synchronously; a malformed URL (e.g. a
      // corrupted ip) would throw before the close handler is wired and leave
      // `recovering` stuck true, permanently blocking IP-recovery for this device.
      conn.recovering = false;
      conn.wsClient = null;
      this.logDeviceError(conn, "ws", err);
    }
  }

  /**
   * Handle a measurement push.
   *
   * @param conn Device connection.
   * @param data Measurement payload.
   */
  onWsMeasurement(conn: DeviceConnection, data: Measurement): void {
    // Skip updates for devices removed mid-flight (frame can race delObjectAsync) + teardown.
    if (conn.removed || this.host.isUnloading()) {
      return;
    }
    // Backpressure: drop a push while the previous write is still in flight. The data
    // is latest-wins telemetry, so dropping intermediate frames under an abnormal flood
    // is correct and avoids a setState storm. Defensive .catch — writes may reject on a
    // transient Redis hiccup; we want a debug-log, not an unhandled rejection.
    if (conn.measurementBusy) {
      return;
    }
    conn.measurementBusy = true;
    this.host
      .getStateManager()
      .updateMeasurement(conn.config, data, () => conn.removed || this.host.isUnloading())
      .catch((err: unknown) => {
        this.adapter.log.debug(`updateMeasurement failed for ${conn.config.productName}: ${errText(err)}`);
      })
      .finally(() => {
        conn.measurementBusy = false;
      });
  }

  /**
   * Handle a real-time system push (cloud/led changes etc.).
   *
   * @param conn Device connection.
   * @param data System payload.
   */
  onWsSystem(conn: DeviceConnection, data: SystemInfo): void {
    if (conn.removed || this.host.isUnloading()) {
      return;
    }
    // L8: backpressure like the measurement path — drop a system push while the
    // previous write is still in flight (system frames normally push only on a
    // control-state change, but a misbehaving device could still flood them).
    if (conn.systemBusy) {
      return;
    }
    conn.systemBusy = true;
    this.host
      .getStateManager()
      .updateSystem(conn.config, data, () => conn.removed || this.host.isUnloading())
      .catch((err: unknown) => {
        this.adapter.log.debug(`updateSystem (ws) failed for ${conn.config.productName}: ${errText(err)}`);
      })
      .finally(() => {
        conn.systemBusy = false;
      });
  }

  /**
   * Handle a real-time battery-group push (mode/permissions/target power).
   *
   * @param conn Device connection.
   * @param data Battery-control payload.
   */
  onWsBattery(conn: DeviceConnection, data: BatteryControl): void {
    if (conn.removed || this.host.isUnloading()) {
      return;
    }
    // Only surface battery states when batteries are actually connected.
    if (!data.battery_count || data.battery_count <= 0) {
      return;
    }
    // L8: backpressure like the measurement/system paths.
    if (conn.batteryBusy) {
      return;
    }
    conn.batteryBusy = true;
    this.host
      .getStateManager()
      .updateBattery(conn.config, data)
      .catch((err: unknown) => {
        this.adapter.log.debug(`updateBattery (ws) failed for ${conn.config.productName}: ${errText(err)}`);
      })
      .finally(() => {
        conn.batteryBusy = false;
      });
  }

  /**
   * WebSocket authenticated — mark connected, stop REST fallback, log recovery (cooldowned).
   *
   * @param conn Device connection.
   */
  onWsConnected(conn: DeviceConnection): void {
    conn.wsAuthenticated = true;
    conn.wsFailCount = 0;
    conn.authFailCount = 0;
    conn.lastConnectedAt = Date.now();
    conn.recovering = false;
    this.host
      .getStateManager()
      .setDeviceConnected(conn.config, true)
      .catch((err: unknown) =>
        this.adapter.log.debug(`setDeviceConnected(true) failed for ${conn.config.productName}: ${errText(err)}`),
      );
    this.updateGlobalConnection();

    // Stop REST fallback if active
    if (conn.pollTimer) {
      this.adapter.clearInterval(conn.pollTimer);
      conn.pollTimer = undefined;
    }

    // Main owns the mDNS browser — it stops IP recovery once all devices are connected.
    this.host.onDeviceConnected();

    // Log restoration if we had errors before. Per-device cooldown so chronic bouncing
    // doesn't emit one info per cycle — repeats go to debug.
    if (conn.lastErrorCode) {
      const now = Date.now();
      const lastInfo = this.lastInfoAt.get(conn.config.serial) ?? 0;
      const msg = this.isUnstable(conn)
        ? `${conn.config.productName}: connection restored (unstable mode)`
        : `${conn.config.productName}: connection restored`;
      if (shouldEmitAfterCooldown(lastInfo, now, INFO_COOLDOWN_MS)) {
        this.lastInfoAt.set(conn.config.serial, now);
        this.adapter.log.info(msg);
      } else {
        this.adapter.log.debug(`${msg} (cooldown)`);
      }
      conn.lastErrorCode = "";
    }

    this.adapter.log.debug(`WebSocket connected to ${conn.config.productName} (${conn.ip})`);
  }

  /**
   * WebSocket disconnected — track stability, start REST fallback, schedule backed-off reconnect
   * (unless an auth failure stops the loop).
   *
   * @param conn Device connection.
   * @param error Disconnect error, if any.
   */
  onWsDisconnected(conn: DeviceConnection, error?: Error): void {
    // Auth failures are not a connectivity-stability signal — they mean the token is bad,
    // not the WiFi. Counting them as short connections would flip the device into unstable mode.
    // L4/F1: isAuthError (connection-utils) covers the canonical `user:unauthorized` code AND a
    // bare HTTP 401 — single source of truth shared with the REST path and handleAuthFailure.

    // Track connection stability — pure decision in main-helpers, side-effects here.
    if (conn.lastConnectedAt > 0 && !isAuthError(error)) {
      const duration = Date.now() - conn.lastConnectedAt;
      const transition = decideUnstableTransition(
        conn.recentDisconnects,
        duration,
        STABLE_THRESHOLD_MS,
        UNSTABLE_DISCONNECT_THRESHOLD,
      );
      if (duration < STABLE_THRESHOLD_MS) {
        conn.recentDisconnects++;
      } else {
        conn.recentDisconnects = 0;
      }
      // Hysterese-transitions are internal reconnect-strategy adjustments → debug, not info.
      if (transition === "becameUnstable") {
        this.adapter.log.debug(`${conn.config.productName}: unstable connection detected — using faster reconnect`);
      } else if (transition === "stabilized") {
        this.adapter.log.debug(`${conn.config.productName}: connection stabilized — using normal reconnect`);
      }
    }

    conn.wsAuthenticated = false;
    conn.wsClient = null;
    conn.recovering = false;
    // M1: reset the connect-timestamp AFTER the stability block above has read it.
    // A FAILED reconnect never re-authenticates (onWsConnected is not called), so
    // lastConnectedAt would otherwise still hold the FIRST connect's time and every
    // failed retry gets miscounted as a short "connection" → one outage + a few
    // failed reconnects flips the device to unstable after a single drop. With the
    // reset, only a real connect (which sets lastConnectedAt again) counts.
    conn.lastConnectedAt = 0;
    this.host
      .getStateManager()
      .setDeviceConnected(conn.config, false)
      .catch((err: unknown) =>
        this.adapter.log.debug(`setDeviceConnected(false) failed for ${conn.config.productName}: ${errText(err)}`),
      );
    this.updateGlobalConnection();

    if (error) {
      this.logDeviceError(conn, "ws", error);
    }

    // Auth failure → stop the reconnect path.
    if (!this.handleAuthFailure(conn, error, /* cleanupTimers */ false)) {
      return;
    }

    // Start REST fallback
    this.startRestFallback(conn);

    // Schedule reconnect with exponential backoff (faster for unstable devices).
    conn.wsFailCount++;
    const maxDelay = this.isUnstable(conn) ? WS_RECONNECT_MAX_UNSTABLE_MS : WS_RECONNECT_MAX_MS;
    const delay = computeReconnectDelay(conn.wsFailCount, WS_RECONNECT_BASE_MS, maxDelay);
    const key = this.host.getStateManager().devicePrefix(conn.config);
    this.adapter.log.debug(`${key}: WS reconnect in ${delay / 1000}s (attempt ${conn.wsFailCount})`);

    conn.reconnectTimer = this.adapter.setTimeout(() => {
      conn.reconnectTimer = undefined;
      this.connectWebSocket(conn);
    }, delay);
  }

  /**
   * Start REST polling as fallback when WebSocket is down.
   * For stable devices: stops on network errors (WS reconnect handles recovery).
   * For unstable devices: slows down instead of stopping to minimize data gaps.
   *
   * @param conn Device connection.
   */
  startRestFallback(conn: DeviceConnection): void {
    if (conn.pollTimer || !conn.ip) {
      return;
    }

    const unstable = this.isUnstable(conn);
    const interval = pickRestPollInterval(unstable, REST_POLL_MS, REST_POLL_UNSTABLE_MS);
    const client = this.host.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);

    conn.pollTimer = this.adapter.setInterval(async () => {
      // Bail out if device was removed or adapter is shutting down — the
      // setStateAsync chain inside updateMeasurement would otherwise either
      // recreate deleted objects or hit a torn-down adapter.
      if (conn.removed || this.host.isUnloading()) {
        return;
      }
      // L2: skip this tick if the previous poll is still in flight — the 10 s HTTP
      // timeout equals the poll interval, so a slow request could otherwise overlap
      // the next tick (two concurrent getMeasurement/updateMeasurement writes).
      if (conn.restPollBusy) {
        return;
      }
      conn.restPollBusy = true;
      try {
        const data = await client.getMeasurement();
        if (conn.removed || this.host.isUnloading()) {
          return;
        }
        await this.host
          .getStateManager()
          .updateMeasurement(conn.config, data, () => conn.removed || this.host.isUnloading());
      } catch (err) {
        if (this.host.isUnloading()) {
          return;
        }
        this.logDeviceError(conn, "rest", err);

        // Auth failures: stop everything — token is bad, re-pair required.
        if (isAuthError(err)) {
          this.handleAuthFailure(conn, err, /* cleanupTimers */ true);
          return;
        }

        // Stop REST polling on network errors for stable devices.
        // Unstable devices keep polling (slower) to minimize data gaps.
        if (!unstable && classifyError(err) === "NETWORK" && conn.pollTimer) {
          this.adapter.clearInterval(conn.pollTimer);
          conn.pollTimer = undefined;
        }
      } finally {
        conn.restPollBusy = false;
      }
    }, interval);
  }

  /** Poll system info for all connected devices in parallel. */
  async pollAllSystemInfo(): Promise<void> {
    if (this.host.isUnloading()) {
      return;
    }
    const tasks = Array.from(this.connections.values())
      .filter(c => c.ip && c.wsAuthenticated && !c.removed)
      .map(c => this.pollSystemInfo(c));
    await Promise.all(tasks);
  }

  /**
   * Poll system info for a single device.
   *
   * @param conn Device connection.
   */
  async pollSystemInfo(conn: DeviceConnection): Promise<void> {
    if (!conn.ip || conn.removed || this.host.isUnloading()) {
      return;
    }

    try {
      const client = this.host.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);
      const system = await client.getSystem();
      if (conn.removed || this.host.isUnloading()) {
        return;
      }
      await this.host
        .getStateManager()
        .updateSystem(conn.config, system, () => conn.removed || this.host.isUnloading());

      // Sync productName drift: if the user renamed the device in the HomeWizard app
      // (or a firmware update changed product_name), pick up the new value instead of
      // staying stale until re-pair. I7/F3: the downtime-rename is already caught in
      // initDevice from its getDeviceInfo, so the poll only needs to catch renames that
      // happen WHILE running — every 10th poll (~10 min) is plenty and avoids a
      // redundant getDeviceInfo on the very first poll right after initDevice.
      conn.systemPollCount = (conn.systemPollCount ?? 0) + 1;
      if (conn.systemPollCount % 10 === 0) {
        try {
          const info = await client.getDeviceInfo();
          const newName = sanitizeForLog(info.product_name);
          if (!conn.removed && !this.host.isUnloading() && info.product_name && newName !== conn.config.productName) {
            this.adapter.log.info(`${conn.config.productName}: name changed to '${newName}' — updating object`);
            conn.config.productName = newName;
            await this.host.saveDeviceToObject(conn.config);
          }
        } catch {
          // device-info is best-effort here; the system-poll log already
          // surfaces real connectivity issues.
        }
      }

      // Also poll battery if device supports it. 404 = no battery — silent.
      // Other errors (500, timeout, malformed body) used to be swallowed
      // entirely; now they surface at debug so post-mortem diagnosis is
      // possible without losing any normal-flow logging.
      if (conn.removed || this.host.isUnloading()) {
        return;
      }
      try {
        const battery = await client.getBatteries();
        if (conn.removed || this.host.isUnloading()) {
          return;
        }
        // L5: a device returning 200 + empty body yields `undefined` from request();
        // guard the deref (the catch below would swallow the TypeError anyway, but
        // this avoids a misleading debug line). Only create states if batteries exist.
        if (battery && battery.battery_count && battery.battery_count > 0) {
          await this.host.getStateManager().updateBattery(conn.config, battery);
        }
      } catch (err) {
        if (err instanceof HomeWizardApiError && err.statusCode === 404) {
          return; // device doesn't support batteries — expected
        }
        this.adapter.log.debug(`${conn.config.productName} batteries: ${errText(err)}`);
      }
    } catch (err) {
      if (this.host.isUnloading()) {
        return;
      }
      this.logDeviceError(conn, "system", err);
    }
  }

  /** Update global info.connection based on all device states. */
  updateGlobalConnection(): void {
    const anyConnected = Array.from(this.connections.values()).some(c => c.wsAuthenticated);
    // setStateChanged: flips rarely (connect/disconnect), called on every WS event — skip no-op writes.
    this.adapter
      .setStateChangedAsync("info.connection", {
        val: anyConnected,
        ack: true,
      })
      .catch((err: unknown) => this.adapter.log.debug(`Failed to update info.connection: ${errText(err)}`));
  }

  /**
   * Whether a device has unstable connectivity (frequent short-lived connections).
   * Unstable devices get faster reconnect and persistent REST fallback.
   *
   * @param conn Device connection.
   */
  isUnstable(conn: DeviceConnection): boolean {
    return conn.recentDisconnects >= UNSTABLE_DISCONNECT_THRESHOLD;
  }

  /**
   * Handle a possible auth failure on a device connection. Counts failures and,
   * once `MAX_AUTH_FAILURES` is reached, warns the user and (optionally) tears
   * down active timers and the WebSocket — stops bombarding the device with a
   * known-bad token.
   *
   * @param conn          Device connection.
   * @param error         The error from the failing call (any error type accepted).
   * @param cleanupTimers If `true`, clears poll/reconnect timers and closes the WS
   *                      on threshold reach. Used by REST-fallback paths where
   *                      the WS would otherwise keep retrying indefinitely. The
   *                      WS-disconnect path passes `false` because the caller
   *                      decides the next step itself.
   * @returns `true` if the caller should continue normal flow (no auth-stop),
   *          `false` if the auth-stop fired and the caller should bail out.
   */
  handleAuthFailure(conn: DeviceConnection, error: unknown, cleanupTimers: boolean): boolean {
    // F1: isAuthError treats a bare HTTP 401 as an auth failure too (not only the
    // canonical `user:unauthorized` code) — consistent with the WS-disconnect and
    // REST-fallback call sites, so a non-canonical 401 body still triggers the auth-stop.
    if (!isAuthError(error)) {
      return true;
    }
    conn.authFailCount++;
    if (conn.authFailCount < MAX_AUTH_FAILURES) {
      return true;
    }
    this.adapter.log.warn(`${conn.config.productName}: token invalid — re-pair device to fix`);
    if (cleanupTimers) {
      // L13: same close-WS + clear-poll/reconnect-timer sequence as teardownConnection.
      this.teardownConnection(conn);
    }
    return false;
  }

  /**
   * Log device error with deduplication.
   *
   * Two-stage dedup:
   * 1. `lastErrorCode` per connection — repeats of the same error category go
   *    to debug. Resets on recovery (`onConnected` clears it) so a new category
   *    after recovery surfaces as warn again. Correct for a „new failure mode"
   *    but blind to chronic bouncing.
   * 2. {@link lastWarnAt} per device serial — survives recovery. Even if the
   *    `lastErrorCode`-dedup says „first occurrence", the cooldown stamp keeps
   *    the warn-emit suppressed if we've warned for this device within
   *    {@link WARN_COOLDOWN_MS}. Chronic bouncing produces at most 1× warn per
   *    hour per device.
   *
   * Cooldown key is the device serial — category-spanning. A flapping P1 that
   * cycles TIMEOUT→NETWORK→TIMEOUT is one phenomenon, one warn-budget.
   *
   * @param conn Device connection.
   * @param context Error context (for debug messages only).
   * @param err Error object.
   */
  logDeviceError(conn: DeviceConnection, context: string, err: unknown): void {
    const errorCode = classifyError(err);
    const isRepeat = errorCode === conn.lastErrorCode;
    conn.lastErrorCode = errorCode;

    if (isRepeat) {
      this.adapter.log.debug(`${conn.config.productName} ${context}: ${errText(err)}`);
      return;
    }

    // New category — apply per-device cooldown so chronic bouncing doesn't
    // emit warn at every cycle just because each cycle's first failure is
    // a fresh `lastErrorCode`.
    const now = Date.now();
    const lastWarn = this.lastWarnAt.get(conn.config.serial) ?? 0;
    if (!shouldEmitAfterCooldown(lastWarn, now, WARN_COOLDOWN_MS)) {
      this.adapter.log.debug(`${conn.config.productName} ${context} (cooldown): ${errText(err)}`);
      return;
    }

    this.lastWarnAt.set(conn.config.serial, now);
    if (errorCode === "NETWORK") {
      this.adapter.log.warn(`${conn.config.productName}: device unreachable — will keep retrying`);
    } else {
      this.adapter.log.warn(`${conn.config.productName} ${context}: ${errText(err)}`);
    }
  }
}
