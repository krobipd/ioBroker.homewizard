"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var connection_manager_exports = {};
__export(connection_manager_exports, {
  ConnectionManager: () => ConnectionManager,
  WS_RECONNECT_MAX_MS: () => WS_RECONNECT_MAX_MS
});
module.exports = __toCommonJS(connection_manager_exports);
var import_connection_utils = require("./connection-utils");
var import_coerce = require("./coerce");
var import_homewizard_client = require("./homewizard-client");
var import_main_helpers = require("./main-helpers");
const WS_RECONNECT_BASE_MS = 5e3;
const WS_RECONNECT_MAX_MS = 3e5;
const REST_POLL_MS = 1e4;
const MAX_AUTH_FAILURES = 3;
const WS_FAILURES_BEFORE_MDNS = 3;
const MDNS_RETRY_EVERY = 12;
const STABLE_THRESHOLD_MS = 6e5;
const WS_RECONNECT_MAX_UNSTABLE_MS = 6e4;
const REST_POLL_UNSTABLE_MS = 3e4;
const WARN_COOLDOWN_MS = 60 * 60 * 1e3;
const INFO_COOLDOWN_MS = 60 * 60 * 1e3;
class ConnectionManager {
  adapter;
  host;
  /** Device connections keyed by state-ID prefix (`<productType>_<serial>`). */
  connections = /* @__PURE__ */ new Map();
  /**
   * Per-device last-warn timestamp for chronic-bouncing cooldown. Key =
   * `conn.config.serial` (category-spanning). The classifyError-based
   * `lastErrorCode`-dedup in {@link logDeviceError} resets on every recovery,
   * so on chronic bouncing a new disconnect counts as "first occurrence" →
   * warn again. This stamp persists across recoveries so the user sees max one
   * warn per WARN_COOLDOWN_MS per device.
   */
  lastWarnAt = /* @__PURE__ */ new Map();
  /** Per-device last-info timestamp for `connection restored`. Analog cooldown. */
  lastInfoAt = /* @__PURE__ */ new Map();
  /**
   * @param adapter The ioBroker adapter instance (timers, state writes, log, namespace).
   * @param host    Collaborators owned by main (see {@link ConnectionManagerHost}).
   */
  constructor(adapter, host) {
    this.adapter = adapter;
    this.host = host;
  }
  /**
   * Drop the per-device warn/info cooldown stamps for a serial (on device removal).
   *
   * @param serial The device serial whose cooldown stamps to drop.
   */
  dropCooldowns(serial) {
    this.lastWarnAt.delete(serial);
    this.lastInfoAt.delete(serial);
  }
  /**
   * Find the connection that owns a state ID. Delegates to the pure helper so the
   * lookup math is unit-tested separately (`lib/main-helpers.test.ts`).
   *
   * @param stateId Full state ID.
   */
  findConnectionForState(stateId) {
    return (0, import_main_helpers.findConnectionForState)(stateId, this.adapter.namespace, this.connections);
  }
  /**
   * Close a connection's WebSocket and clear its poll + reconnect timers.
   *
   * @param conn Device connection to tear down.
   */
  teardownConnection(conn) {
    var _a;
    (_a = conn.wsClient) == null ? void 0 : _a.close();
    if (conn.pollTimer) {
      this.adapter.clearInterval(conn.pollTimer);
      conn.pollTimer = void 0;
    }
    if (conn.reconnectTimer) {
      this.adapter.clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = void 0;
    }
  }
  /**
   * Initialize a newly discovered device — fetch info and connect WebSocket.
   *
   * @param conn Device connection with IP set.
   */
  async initDevice(conn) {
    if (this.host.isUnloading() || conn.removed) {
      return;
    }
    try {
      const client = this.host.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);
      const info = await client.getDeviceInfo();
      if (this.host.isUnloading() || conn.removed) {
        return;
      }
      let configChanged = false;
      if (!conn.config.certCn) {
        const certCn = client.getServerCertCn();
        if (certCn) {
          conn.config.certCn = certCn;
          configChanged = true;
        }
      }
      const newName = (0, import_coerce.sanitizeForLog)(info.product_name);
      if (info.product_name && newName !== conn.config.productName) {
        this.adapter.log.info(`${conn.config.productName}: name changed to '${newName}' \u2014 updating object`);
        conn.config.productName = newName;
        configChanged = true;
      }
      if (configChanged) {
        this.host.saveDeviceToObject(conn.config).catch(
          (err) => this.adapter.log.debug(`Failed to persist device config for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`)
        );
      }
      const key = this.host.getStateManager().devicePrefix(conn.config);
      await this.adapter.setStateAsync(`${key}.info.firmware`, {
        val: info.firmware_version,
        ack: true
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
  connectWebSocket(conn) {
    if (this.host.isUnloading() || !conn.ip) {
      return;
    }
    if (conn.authFailCount >= MAX_AUTH_FAILURES) {
      return;
    }
    conn.recovering = true;
    if (conn.wsClient) {
      conn.wsClient.close();
      conn.wsClient = null;
    }
    if ((0, import_main_helpers.shouldStartIpRecovery)(conn.wsFailCount, WS_FAILURES_BEFORE_MDNS, MDNS_RETRY_EVERY)) {
      this.host.requestIpRecovery();
    }
    const wsClient = this.host.makeWebSocket(
      conn.ip,
      conn.config.token,
      {
        onMeasurement: (data) => this.onWsMeasurement(conn, data),
        onSystem: (data) => this.onWsSystem(conn, data),
        onBattery: (data) => this.onWsBattery(conn, data),
        onConnected: () => this.onWsConnected(conn),
        onDisconnected: (error) => this.onWsDisconnected(conn, error),
        log: this.adapter.log
      },
      {
        schedule: (cb, ms) => this.adapter.setTimeout(cb, ms),
        cancel: (h) => {
          this.adapter.clearTimeout(h);
        },
        scheduleRepeating: (cb, ms) => this.adapter.setInterval(cb, ms),
        cancelRepeating: (h) => {
          this.adapter.clearInterval(h);
        }
      },
      conn.config.certCn,
      conn.config.serial
    );
    conn.wsClient = wsClient;
    try {
      wsClient.connect();
    } catch (err) {
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
  onWsMeasurement(conn, data) {
    if (conn.removed || this.host.isUnloading()) {
      return;
    }
    if (conn.measurementBusy) {
      return;
    }
    conn.measurementBusy = true;
    this.host.getStateManager().updateMeasurement(conn.config, data, () => conn.removed || this.host.isUnloading()).catch((err) => {
      this.adapter.log.debug(`updateMeasurement failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`);
    }).finally(() => {
      conn.measurementBusy = false;
    });
  }
  /**
   * Handle a real-time system push (cloud/led changes etc.).
   *
   * @param conn Device connection.
   * @param data System payload.
   */
  onWsSystem(conn, data) {
    if (conn.removed || this.host.isUnloading()) {
      return;
    }
    if (conn.systemBusy) {
      return;
    }
    conn.systemBusy = true;
    this.host.getStateManager().updateSystem(conn.config, data, () => conn.removed || this.host.isUnloading()).catch((err) => {
      this.adapter.log.debug(`updateSystem (ws) failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`);
    }).finally(() => {
      conn.systemBusy = false;
    });
  }
  /**
   * Handle a real-time battery-group push (mode/permissions/target power).
   *
   * @param conn Device connection.
   * @param data Battery-control payload.
   */
  onWsBattery(conn, data) {
    if (conn.removed || this.host.isUnloading()) {
      return;
    }
    if (!data.battery_count || data.battery_count <= 0) {
      return;
    }
    if (conn.batteryBusy) {
      return;
    }
    conn.batteryBusy = true;
    this.host.getStateManager().updateBattery(conn.config, data).catch((err) => {
      this.adapter.log.debug(`updateBattery (ws) failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`);
    }).finally(() => {
      conn.batteryBusy = false;
    });
  }
  /**
   * WebSocket authenticated — mark connected, stop REST fallback, log recovery (cooldowned).
   *
   * @param conn Device connection.
   */
  onWsConnected(conn) {
    var _a;
    conn.wsAuthenticated = true;
    conn.wsFailCount = 0;
    conn.authFailCount = 0;
    conn.lastConnectedAt = Date.now();
    conn.recovering = false;
    this.host.getStateManager().setDeviceConnected(conn.config, true).catch(
      (err) => this.adapter.log.debug(`setDeviceConnected(true) failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`)
    );
    this.updateGlobalConnection();
    if (conn.pollTimer) {
      this.adapter.clearInterval(conn.pollTimer);
      conn.pollTimer = void 0;
    }
    this.host.onDeviceConnected();
    if (conn.lastErrorCode) {
      const now = Date.now();
      const lastInfo = (_a = this.lastInfoAt.get(conn.config.serial)) != null ? _a : 0;
      const msg = this.isUnstable(conn) ? `${conn.config.productName}: connection restored (unstable mode)` : `${conn.config.productName}: connection restored`;
      if ((0, import_main_helpers.shouldEmitAfterCooldown)(lastInfo, now, INFO_COOLDOWN_MS)) {
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
  onWsDisconnected(conn, error) {
    if (conn.lastConnectedAt > 0 && !(0, import_connection_utils.isAuthError)(error)) {
      const duration = Date.now() - conn.lastConnectedAt;
      const transition = (0, import_main_helpers.decideUnstableTransition)(
        conn.recentDisconnects,
        duration,
        STABLE_THRESHOLD_MS,
        import_connection_utils.UNSTABLE_DISCONNECT_THRESHOLD
      );
      if (duration < STABLE_THRESHOLD_MS) {
        conn.recentDisconnects++;
      } else {
        conn.recentDisconnects = 0;
      }
      if (transition === "becameUnstable") {
        this.adapter.log.debug(`${conn.config.productName}: unstable connection detected \u2014 using faster reconnect`);
      } else if (transition === "stabilized") {
        this.adapter.log.debug(`${conn.config.productName}: connection stabilized \u2014 using normal reconnect`);
      }
    }
    conn.wsAuthenticated = false;
    conn.wsClient = null;
    conn.recovering = false;
    conn.lastConnectedAt = 0;
    this.host.getStateManager().setDeviceConnected(conn.config, false).catch(
      (err) => this.adapter.log.debug(`setDeviceConnected(false) failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`)
    );
    this.updateGlobalConnection();
    if (error) {
      this.logDeviceError(conn, "ws", error);
    }
    if (!this.handleAuthFailure(
      conn,
      error,
      /* cleanupTimers */
      false
    )) {
      return;
    }
    this.startRestFallback(conn);
    conn.wsFailCount++;
    const maxDelay = this.isUnstable(conn) ? WS_RECONNECT_MAX_UNSTABLE_MS : WS_RECONNECT_MAX_MS;
    const delay = (0, import_main_helpers.computeReconnectDelay)(conn.wsFailCount, WS_RECONNECT_BASE_MS, maxDelay);
    const key = this.host.getStateManager().devicePrefix(conn.config);
    this.adapter.log.debug(`${key}: WS reconnect in ${delay / 1e3}s (attempt ${conn.wsFailCount})`);
    conn.reconnectTimer = this.adapter.setTimeout(() => {
      conn.reconnectTimer = void 0;
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
  startRestFallback(conn) {
    if (conn.pollTimer || !conn.ip) {
      return;
    }
    const unstable = this.isUnstable(conn);
    const interval = (0, import_main_helpers.pickRestPollInterval)(unstable, REST_POLL_MS, REST_POLL_UNSTABLE_MS);
    const client = this.host.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);
    conn.pollTimer = this.adapter.setInterval(async () => {
      if (conn.removed || this.host.isUnloading()) {
        return;
      }
      if (conn.restPollBusy) {
        return;
      }
      conn.restPollBusy = true;
      try {
        const data = await client.getMeasurement();
        if (conn.removed || this.host.isUnloading()) {
          return;
        }
        await this.host.getStateManager().updateMeasurement(conn.config, data, () => conn.removed || this.host.isUnloading());
      } catch (err) {
        if (this.host.isUnloading()) {
          return;
        }
        this.logDeviceError(conn, "rest", err);
        if ((0, import_connection_utils.isAuthError)(err)) {
          this.handleAuthFailure(
            conn,
            err,
            /* cleanupTimers */
            true
          );
          return;
        }
        if (!unstable && (0, import_connection_utils.classifyError)(err) === "NETWORK" && conn.pollTimer) {
          this.adapter.clearInterval(conn.pollTimer);
          conn.pollTimer = void 0;
        }
      } finally {
        conn.restPollBusy = false;
      }
    }, interval);
  }
  /** Poll system info for all connected devices in parallel. */
  async pollAllSystemInfo() {
    if (this.host.isUnloading()) {
      return;
    }
    const tasks = Array.from(this.connections.values()).filter((c) => c.ip && c.wsAuthenticated && !c.removed).map((c) => this.pollSystemInfo(c));
    await Promise.all(tasks);
  }
  /**
   * Poll system info for a single device.
   *
   * @param conn Device connection.
   */
  async pollSystemInfo(conn) {
    var _a;
    if (!conn.ip || conn.removed || this.host.isUnloading()) {
      return;
    }
    try {
      const client = this.host.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);
      const system = await client.getSystem();
      if (conn.removed || this.host.isUnloading()) {
        return;
      }
      await this.host.getStateManager().updateSystem(conn.config, system, () => conn.removed || this.host.isUnloading());
      conn.systemPollCount = ((_a = conn.systemPollCount) != null ? _a : 0) + 1;
      if (conn.systemPollCount % 10 === 0) {
        try {
          const info = await client.getDeviceInfo();
          const newName = (0, import_coerce.sanitizeForLog)(info.product_name);
          if (!conn.removed && !this.host.isUnloading() && info.product_name && newName !== conn.config.productName) {
            this.adapter.log.info(`${conn.config.productName}: name changed to '${newName}' \u2014 updating object`);
            conn.config.productName = newName;
            await this.host.saveDeviceToObject(conn.config);
          }
        } catch {
        }
      }
      if (conn.removed || this.host.isUnloading()) {
        return;
      }
      try {
        const battery = await client.getBatteries();
        if (conn.removed || this.host.isUnloading()) {
          return;
        }
        if (battery && battery.battery_count && battery.battery_count > 0) {
          await this.host.getStateManager().updateBattery(conn.config, battery);
        }
      } catch (err) {
        if (err instanceof import_homewizard_client.HomeWizardApiError && err.statusCode === 404) {
          return;
        }
        this.adapter.log.debug(`${conn.config.productName} batteries: ${(0, import_coerce.errText)(err)}`);
      }
    } catch (err) {
      if (this.host.isUnloading()) {
        return;
      }
      this.logDeviceError(conn, "system", err);
    }
  }
  /** Update global info.connection based on all device states. */
  updateGlobalConnection() {
    const anyConnected = Array.from(this.connections.values()).some((c) => c.wsAuthenticated);
    this.adapter.setStateChangedAsync("info.connection", {
      val: anyConnected,
      ack: true
    }).catch((err) => this.adapter.log.debug(`Failed to update info.connection: ${(0, import_coerce.errText)(err)}`));
  }
  /**
   * Whether a device has unstable connectivity (frequent short-lived connections).
   * Unstable devices get faster reconnect and persistent REST fallback.
   *
   * @param conn Device connection.
   */
  isUnstable(conn) {
    return conn.recentDisconnects >= import_connection_utils.UNSTABLE_DISCONNECT_THRESHOLD;
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
  handleAuthFailure(conn, error, cleanupTimers) {
    if (!(0, import_connection_utils.isAuthError)(error)) {
      return true;
    }
    conn.authFailCount++;
    if (conn.authFailCount < MAX_AUTH_FAILURES) {
      return true;
    }
    this.adapter.log.warn(`${conn.config.productName}: token invalid \u2014 re-pair device to fix`);
    if (cleanupTimers) {
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
  logDeviceError(conn, context, err) {
    var _a;
    const errorCode = (0, import_connection_utils.classifyError)(err);
    const isRepeat = errorCode === conn.lastErrorCode;
    conn.lastErrorCode = errorCode;
    if (isRepeat) {
      this.adapter.log.debug(`${conn.config.productName} ${context}: ${(0, import_coerce.errText)(err)}`);
      return;
    }
    const now = Date.now();
    const lastWarn = (_a = this.lastWarnAt.get(conn.config.serial)) != null ? _a : 0;
    if (!(0, import_main_helpers.shouldEmitAfterCooldown)(lastWarn, now, WARN_COOLDOWN_MS)) {
      this.adapter.log.debug(`${conn.config.productName} ${context} (cooldown): ${(0, import_coerce.errText)(err)}`);
      return;
    }
    this.lastWarnAt.set(conn.config.serial, now);
    if (errorCode === "NETWORK") {
      this.adapter.log.warn(`${conn.config.productName}: device unreachable \u2014 will keep retrying`);
    } else {
      this.adapter.log.warn(`${conn.config.productName} ${context}: ${(0, import_coerce.errText)(err)}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ConnectionManager,
  WS_RECONNECT_MAX_MS
});
//# sourceMappingURL=connection-manager.js.map
