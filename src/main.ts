import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import type * as https from "node:https";
import { join } from "node:path";
import {
  coerceFiniteNumber,
  errText,
  isAssignableDeviceIpv4,
  isValidIpv4,
  parseBatteryPermissions,
  sanitizeForLog,
  validateBatteryMode,
} from "./lib/coerce";
import { createDeviceConnection } from "./lib/connection-utils";
import { ConnectionManager, WS_RECONNECT_MAX_MS, type ConnectionManagerHost } from "./lib/connection-manager";
import { HomeWizardDiscovery } from "./lib/discovery";
import {
  CA_NOT_AFTER,
  caDaysUntilExpiry,
  createDeviceAgent,
  createDeviceAgentForSerial,
  dropDeviceAgent,
} from "./lib/cacert";
import { HomeWizardApiError, HomeWizardClient } from "./lib/homewizard-client";
import { StateManager } from "./lib/state-manager";
import type {
  BatteryControl,
  DeviceConfig,
  DeviceConnection,
  DiscoveredDevice,
  Measurement,
  SystemInfo,
} from "./lib/types";
import { HomeWizardWebSocket, type TimerDeps, type WsCallbacks } from "./lib/websocket-client";

/** Pairing timeout in milliseconds (60 seconds) */
const PAIRING_TIMEOUT_MS = 60_000;
/** Pairing poll interval in milliseconds */
const PAIRING_POLL_MS = 2_000;
/** System info poll interval in milliseconds */
const SYSTEM_POLL_MS = 60_000;
/** mDNS IP recovery timeout in milliseconds */
const IP_RECOVERY_TIMEOUT_MS = 60_000;

/**
 * Pick the TLS agent for a device client/WebSocket:
 * - a stored full CN → exact-match pin ({@link createDeviceAgent});
 * - else a known serial → CN-suffix pin from connect #1 ({@link createDeviceAgentForSerial},
 *   M4 — closes the legacy-migration window where a pre-v0.13.0 device would send its
 *   token once under a CN-unchecked blanket agent);
 * - else (pairing, identity genuinely unknown) → undefined = blanket HW_AGENT.
 *
 * @param certCn Stored certificate CN, if captured.
 * @param serial Device serial, if known.
 */
function pinnedAgent(certCn?: string, serial?: string): https.Agent | undefined {
  if (certCn) {
    return createDeviceAgent(certCn);
  }
  if (serial) {
    return createDeviceAgentForSerial(serial);
  }
  return undefined;
}

/**
 * HomeWizard adapter — manages multiple devices over API v2 (HTTPS + WebSocket):
 * pairing, real-time push, REST fallback, reconnect/recovery and state mapping.
 * Exported so the orchestration unit tests can drive its handlers directly.
 */
export class HomeWizard extends utils.Adapter {
  private stateManager!: StateManager;
  private discovery: HomeWizardDiscovery | null = null;
  /**
   * Owns the connection registry + the reconnect/error state machine (connect,
   * WS push, REST fallback, backoff reconnect, unstable-mode, system poll,
   * auth-stop, deduped error logging). Constructed in the constructor so the
   * direct-method orchestration tests reach it before onReady runs. Lifecycle,
   * pairing, persistence and mDNS IP-recovery stay here (they own the browser).
   */
  private readonly connectionManager: ConnectionManager;
  /** Device connections — the registry lives in the connection manager. */
  private get connections(): Map<string, DeviceConnection> {
    return this.connectionManager.connections;
  }
  /** Per-device warn cooldown stamps — owned by the connection manager. */
  private get lastWarnAt(): Map<string, number> {
    return this.connectionManager.lastWarnAt;
  }
  /** Per-device info cooldown stamps — owned by the connection manager. */
  private get lastInfoAt(): Map<string, number> {
    return this.connectionManager.lastInfoAt;
  }
  private pairingTimer: ioBroker.Timeout | undefined = undefined;
  private pairingPollTimer: ioBroker.Interval | undefined = undefined;
  private systemPollTimer: ioBroker.Interval | undefined = undefined;
  private ipRecoveryTimer: ioBroker.Timeout | undefined = undefined;
  private isPairing = false;
  /**
   * In-flight guard for {@link pollPairing}: the poll runs every 2 s, but a
   * single device's requestPairing can hang up to the 10 s HTTP timeout —
   * without the guard, overlapping polls would fire concurrent POST /api/user
   * against the same device.
   */
  private pairingPollBusy = false;
  private pairingManualIp = "";
  private discoveredDuringPairing: DiscoveredDevice[] = [];
  /** Set during onUnload — async paths bail before further setStateAsync calls. */
  private unloading = false;
  /**
   * Factories for the REST/WS clients — default to the real constructors. Test seams:
   * a unit test can replace these with fakes to exercise the orchestration (initDevice,
   * onWsConnected/onWsDisconnected, onStateChange) without real network.
   *
   * @param ip Device IP address
   * @param token Bearer token (empty string for pairing requests)
   * @param certCn Stored cert CN for per-device TLS pinning (undefined during pairing/migration)
   * @param serial Device serial — pins by CN-suffix from connect #1 when no CN is stored yet (M4)
   */
  private makeClient: (ip: string, token: string, certCn?: string, serial?: string) => HomeWizardClient = (
    ip,
    token,
    certCn,
    serial,
  ) => new HomeWizardClient(ip, token, { log: this.log, agent: pinnedAgent(certCn, serial) });
  private makeWebSocket: (
    ip: string,
    token: string,
    callbacks: WsCallbacks,
    timers: TimerDeps,
    certCn?: string,
    serial?: string,
  ) => HomeWizardWebSocket = (ip, token, callbacks, timers, certCn, serial) => {
    const agent = pinnedAgent(certCn, serial);
    return new HomeWizardWebSocket(ip, token, callbacks, timers, agent ? { agent } : undefined);
  };
  private makeDiscovery: () => HomeWizardDiscovery = () => new HomeWizardDiscovery(this.log);

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "homewizard" });

    // The connection manager owns the connection registry + reconnect/error state
    // machine. Its host thunks resolve stateManager/makeClient/makeWebSocket/unloading
    // lazily off this adapter so the unit-test seams (overridden AFTER construction)
    // still propagate. Discovery/pairing/IP-recovery stay here (they own the browser).
    const host: ConnectionManagerHost = {
      getStateManager: () => this.stateManager,
      isUnloading: () => this.unloading,
      makeClient: (ip, token, certCn, serial) => this.makeClient(ip, token, certCn, serial),
      makeWebSocket: (ip, token, callbacks, timers, certCn, serial) =>
        this.makeWebSocket(ip, token, callbacks, timers, certCn, serial),
      saveDeviceToObject: config => this.saveDeviceToObject(config),
      requestIpRecovery: () => this.startIpRecovery(),
      onDeviceConnected: () => this.onDeviceConnected(),
    };
    this.connectionManager = new ConnectionManager(this, host);

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    // No process-level unhandledRejection/uncaughtException handlers: in compact mode they
    // are process-wide and cross-adapter-harmful. Every handler has .bind+try/catch and
    // fire-and-forget paths use .catch (Fleet pattern — hueemu/parcelapp/nut).
  }

  private async onReady(): Promise<void> {
    try {
      await I18n.init(join(this.adapterDir, "admin"), this);
      this.stateManager = new StateManager(this);

      // Warn if the bundled HomeWizard CA is close to expiry — after notAfter,
      // rejectUnauthorized:true rejects every device cert and all connections fail.
      const caDaysLeft = caDaysUntilExpiry(Date.now());
      if (caDaysLeft < 90) {
        this.log.warn(
          `Bundled HomeWizard CA certificate expires in ${caDaysLeft} days ` +
            `(${CA_NOT_AFTER.toISOString().slice(0, 10)}) — an adapter update will be needed to keep connecting.`,
        );
      }

      await this.setStateAsync("startPairing", { val: false, ack: true });
      await this.setStateAsync("pairingIp", { val: "", ack: true });

      await this.subscribeStatesAsync("startPairing");
      await this.subscribeStatesAsync("*.system.reboot");
      await this.subscribeStatesAsync("*.system.identify");
      await this.subscribeStatesAsync("*.system.cloud_enabled");
      await this.subscribeStatesAsync("*.system.status_led_brightness_pct");
      await this.subscribeStatesAsync("*.system.api_v1_enabled");
      await this.subscribeStatesAsync("*.battery.mode");
      await this.subscribeStatesAsync("*.battery.permissions");
      await this.subscribeStatesAsync("*.battery.charge_to_full");
      await this.subscribeStatesAsync("*.remove");

      const devices = await this.loadDevicesFromObjects();
      if (devices.length === 0) {
        this.log.info(`No devices configured — set 'startPairing' to true to add a device`);
        await this.setStateChangedAsync("info.connection", { val: false, ack: true });
      }

      // I6: one-shot marker for the pre-v0.4.0/v0.11.0 legacy-state cleanup. Those
      // orphan paths only exist on installs upgraded through those versions; once
      // swept, the marker lets later restarts skip ~62 getObject probes per device.
      // Fleet pattern (beszel L6). The marker is a write-once state, so getStateAsync
      // is reliable here (the lgtv stale-snapshot bug was about concurrently-modified
      // objects, not a value that only ever flips false→true once).
      const legacyCleanupDone = (await this.getStateAsync("info.legacyMigrated"))?.val === true;

      for (const device of devices) {
        const key = this.stateManager.devicePrefix(device);
        if (!legacyCleanupDone) {
          await this.stateManager.cleanupMovedStates(device);
        }
        await this.stateManager.createDeviceStates(device);
        const conn = createDeviceConnection(device, device.ip || "");
        this.connections.set(key, conn);

        if (conn.ip) {
          this.log.debug(`Using stored IP ${conn.ip} for ${device.productName}`);
          void this.initDevice(conn).catch((err: unknown) =>
            this.log.error(`initDevice failed for ${conn.config.productName}: ${errText(err)}`),
          );
        }
      }

      // I6: record the cleanup as done so the next start skips the legacy scan.
      if (!legacyCleanupDone) {
        await this.stateManager.markLegacyCleanupDone();
      }

      this.systemPollTimer = this.setInterval(() => {
        void this.pollAllSystemInfo();
      }, SYSTEM_POLL_MS);

      this.connectionManager.updateGlobalConnection();
    } catch (err: unknown) {
      this.log.error(`onReady failed: ${errText(err)}`);
    }
  }

  /**
   * Load device configs from existing device objects
   * Tokens are stored encrypted in device object native
   */
  private async loadDevicesFromObjects(): Promise<DeviceConfig[]> {
    const devices: DeviceConfig[] = [];

    // One-shot legacy migration: v0.1/0.2 stored devices in adapter `native.devices`;
    // v0.3.0 moved them to per-device objects. Any install that ran v0.3.0+ has already
    // migrated (native.devices cleared below), but removal is low-reward / non-zero-risk
    // for an install that has been dormant since v0.2 — keep until at least v1.0.0.
    // Defensive: native.devices could be a non-array if a previous version
    // wrote a different shape, or if the user edited it manually.
    const rawOldDevices = (this.config as Record<string, unknown>).devices;
    const oldDevices: DeviceConfig[] = Array.isArray(rawOldDevices) ? (rawOldDevices as DeviceConfig[]) : [];
    if (oldDevices.length > 0) {
      this.log.debug(`Migrating ${oldDevices.length} device(s) from adapter config to device objects`);
      const migrated: DeviceConfig[] = [];
      for (const device of oldDevices) {
        try {
          await this.saveDeviceToObject(device);
          migrated.push(device);
        } catch (err) {
          // I13: isolate a single malformed legacy entry (a missing serial /
          // productType / token makes devicePrefix.sanitize or encrypt throw) so
          // it can't abort the whole migration — mirrors the per-entry isolation
          // of the modern object-load path below.
          this.log.warn(`Skipping a corrupt legacy device entry during migration: ${errText(err)}`);
        }
      }
      // Clear old config (this triggers one restart, but only during migration)
      await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
        native: { devices: [] },
      });
      return migrated;
    }

    // Read device objects from our namespace. A corrupted encryptedToken
    // (e.g. after secret rotation, crypto-lib changes, manual DB edits) must
    // not take down the whole adapter — skip the broken device, keep the rest.
    const objects = await this.getAdapterObjectsAsync();
    for (const [id, obj] of Object.entries(objects)) {
      if (obj.type !== "device") {
        continue;
      }
      const native = obj.native as Record<string, string> | undefined;
      if (!native?.encryptedToken || !native.serial) {
        continue;
      }
      const localId = id.replace(`${this.namespace}.`, "");
      this.log.debug(`Loading device from object: ${localId}`);
      let token: string;
      try {
        token = this.decrypt(native.encryptedToken);
      } catch (err) {
        this.log.warn(
          `Cannot decrypt token for ${localId} — re-pair the device. ` +
            `(${errText(err)}). Other devices remain unaffected.`,
        );
        continue;
      }
      devices.push({
        token,
        productType: native.productType || "unknown",
        serial: native.serial,
        // L9: clean a possibly-dirty stored name on load too (pre-fix install or
        // a manual DB edit) — keeps the object name and every log line newline-free.
        productName: sanitizeForLog(native.productName || native.productType || "unknown"),
        ...(native.ip && isValidIpv4(native.ip) ? { ip: native.ip } : {}),
        ...(native.certCn ? { certCn: native.certCn } : {}),
      });
    }

    return devices;
  }

  /**
   * Save device config to its device object native (encrypted token)
   *
   * @param config Device configuration to save
   */
  private async saveDeviceToObject(config: DeviceConfig): Promise<void> {
    const prefix = this.stateManager.devicePrefix(config);
    const encryptedToken = this.encrypt(config.token);
    await this.extendObjectAsync(
      prefix,
      {
        type: "device",
        common: { name: config.productName || config.productType },
        native: {
          encryptedToken,
          productType: config.productType,
          serial: config.serial,
          productName: config.productName,
          ...(config.ip ? { ip: config.ip } : {}),
          ...(config.certCn ? { certCn: config.certCn } : {}),
        },
      },
      { preserve: { common: ["name"] } },
    );
  }

  /**
   * Handle a discovered device from mDNS (only active during pairing)
   *
   * @param discovered Discovered device info
   */
  private onDeviceDiscovered(discovered: DiscoveredDevice): void {
    // Skip already paired devices
    const existing = Array.from(this.connections.values()).find(c => c.config.serial === discovered.serial);
    if (existing) {
      return;
    }

    // Skip duplicates
    if (this.discoveredDuringPairing.find(d => d.serial === discovered.serial)) {
      return;
    }

    // Cap the list — a flood of spoofed mDNS announcements (unique serials defeat
    // the dedup above) could otherwise grow it unbounded for the 60s pairing window.
    if (this.discoveredDuringPairing.length >= 50) {
      this.log.debug(`mDNS: discovery list full (50) — ignoring ${discovered.name}`);
      return;
    }
    this.discoveredDuringPairing.push(discovered);
    this.log.info(
      `Found ${discovered.name} (${discovered.productType}) at ${discovered.ip} — press the button on the device to pair`,
    );
  }

  /**
   * Adapter stopping — MUST be synchronous
   *
   * @param callback Completion callback
   */
  private onUnload(callback: () => void): void {
    // Set first, before any clearTimeout — in-flight async paths
    // (REST poll, getMeasurement, getSystem) check this after each await
    // and bail out before further setStateAsync on a tearing-down adapter.
    this.unloading = true;
    try {
      if (this.pairingTimer) {
        this.clearTimeout(this.pairingTimer);
        this.pairingTimer = undefined;
      }
      if (this.pairingPollTimer) {
        this.clearInterval(this.pairingPollTimer);
        this.pairingPollTimer = undefined;
      }
      if (this.systemPollTimer) {
        this.clearInterval(this.systemPollTimer);
        this.systemPollTimer = undefined;
      }
      if (this.ipRecoveryTimer) {
        this.clearTimeout(this.ipRecoveryTimer);
        this.ipRecoveryTimer = undefined;
      }

      this.discovery?.stop();

      for (const conn of this.connections.values()) {
        this.connectionManager.teardownConnection(conn);
      }
      this.connections.clear();

      // onUnload must stay synchronous — fire-and-forget with a .catch (not await)
      // so a DB hiccup here can't become an unhandled rejection during teardown.
      this.setState("info.connection", { val: false, ack: true }).catch(() => {
        /* shutting down */
      });
    } finally {
      callback();
    }
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    try {
      if (!state || state.ack || this.unloading) {
        return;
      }

      if (id.endsWith(".startPairing")) {
        if (state.val) {
          await this.startPairing();
        }
        return;
      }

      if (id.endsWith(".remove")) {
        if (state.val) {
          await this.removeDevice(id);
        }
        return;
      }

      const conn = this.connectionManager.findConnectionForState(id);
      if (!conn || !conn.ip) {
        // Orphaned state (device removed but state written) or device without
        // IP yet — surface at debug so a user-side diagnosis is possible.
        this.log.debug(`stateChange ${id}: no matching connected device — ignored`);
        return;
      }

      const client = this.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);

      try {
        if (id.endsWith(".system.reboot")) {
          this.log.info(`Rebooting ${conn.config.productName} (${conn.ip})`);
          await client.reboot();
          // Reset the button so it is clickable again in Admin (fleet pattern,
          // same as startPairing above — a button must not stay `true, ack=false`).
          await this.setStateAsync(id, { val: false, ack: true });
        } else if (id.endsWith(".system.identify")) {
          await client.identify();
          await this.setStateAsync(id, { val: false, ack: true });
        } else if (id.endsWith(".system.cloud_enabled")) {
          await client.setSystem({ cloud_enabled: !!state.val });
          await this.setStateAsync(id, { val: state.val, ack: true });
        } else if (id.endsWith(".system.status_led_brightness_pct")) {
          const pct = coerceFiniteNumber(state.val);
          if (pct === null || pct < 0 || pct > 100) {
            this.log.warn(`Invalid status_led_brightness_pct '${String(state.val)}' — expected a number 0-100`);
            return;
          }
          await client.setSystem({ status_led_brightness_pct: pct });
          await this.setStateAsync(id, { val: pct, ack: true });
        } else if (id.endsWith(".system.api_v1_enabled")) {
          if (state.val) {
            this.log.warn(
              `${conn.config.productName}: enabling the legacy v1 API — it has no TLS and no token, so any ` +
                `host on the LAN can then read and control this device without authentication.`,
            );
          }
          await client.setSystem({ api_v1_enabled: !!state.val });
          await this.setStateAsync(id, { val: state.val, ack: true });
        } else if (id.endsWith(".battery.mode")) {
          const mode = validateBatteryMode(String(state.val));
          if (!mode) {
            this.log.warn(
              `Invalid battery.mode value: '${String(state.val)}' — expected one of: zero, to_full, standby, predictive`,
            );
            return;
          }
          await client.setBatteries({ mode });
          await this.setStateAsync(id, { val: state.val, ack: true });
        } else if (id.endsWith(".battery.permissions")) {
          const result = parseBatteryPermissions(String(state.val));
          if (!result.ok) {
            this.log.warn(
              `Invalid JSON for battery.permissions: ${result.reason} — expected array, got: ${result.sample}`,
            );
            return;
          }
          await client.setBatteries({ permissions: result.perms });
          await this.setStateAsync(id, { val: state.val, ack: true });
        } else if (id.endsWith(".battery.charge_to_full")) {
          await client.setBatteries({ charge_to_full: !!state.val });
          await this.setStateAsync(id, { val: state.val, ack: true });
        }
      } catch (err) {
        this.log.warn(`Failed to set ${id}: ${errText(err)}`);
      }
    } catch (err: unknown) {
      this.log.error(`stateChange failed: ${errText(err)}`);
    }
  }

  /** Start pairing mode — discover devices and attempt to pair */
  private async startPairing(): Promise<void> {
    if (this.isPairing) {
      this.log.debug("Pairing already active");
      return;
    }

    // Reset startPairing immediately so it doesn't survive a restart
    await this.setStateAsync("startPairing", { val: false, ack: true });

    // I9: stop IP recovery BEFORE setting isPairing — stopIpRecovery only tears
    // down the discovery browser when !isPairing, so doing it after the flag would
    // leave the recovery browser running alongside the pairing one.
    this.stopIpRecovery();

    this.isPairing = true;
    this.discoveredDuringPairing = [];

    // Check if manual IP is set, then clear pairingIp immediately
    const ipState = await this.getStateAsync("pairingIp");
    this.pairingManualIp = ipState?.val ? String(ipState.val).trim() : "";
    await this.setStateAsync("pairingIp", { val: "", ack: true });

    if (this.pairingManualIp) {
      // Validate manual-IP up front — better to fail fast than wait 60s while
      // requestPairing keeps timing out against a malformed input.
      if (!isAssignableDeviceIpv4(this.pairingManualIp)) {
        this.log.warn(
          `Invalid pairing IP '${this.pairingManualIp}' — expected a LAN IPv4 (e.g. 192.168.1.42), ` +
            `not loopback/link-local/broadcast`,
        );
        this.isPairing = false;
        this.pairingManualIp = "";
        return;
      }
      this.log.info(
        `Pairing mode enabled for ${this.pairingManualIp} — press the button on your HomeWizard device now (60 seconds timeout)`,
      );
      // Add as discovered device immediately
      this.discoveredDuringPairing.push({
        ip: this.pairingManualIp,
        productType: "unknown",
        serial: "unknown",
        name: this.pairingManualIp,
      });
    } else {
      this.log.info(
        `Pairing mode enabled — searching for devices via mDNS, press the button on your HomeWizard device now (60 seconds timeout)`,
      );
      // Restart mDNS browser to trigger fresh query — already-cached devices
      // won't be re-announced otherwise and pairing would never find them
      if (!this.discovery) {
        this.discovery = this.makeDiscovery();
      }
      this.discovery.start(discovered => {
        this.onDeviceDiscovered(discovered);
      });
    }

    // Poll discovered devices for pairing
    this.pairingPollTimer = this.setInterval(() => {
      this.pollPairing().catch((err: unknown) => this.log.debug(`pollPairing failed: ${errText(err)}`));
    }, PAIRING_POLL_MS);

    // Timeout pairing
    this.pairingTimer = this.setTimeout(() => {
      this.stopPairing();
      this.log.info(`Pairing mode automatically disabled after 60 seconds timeout`);
    }, PAIRING_TIMEOUT_MS);
  }

  /** Poll all discovered devices to attempt pairing */
  private async pollPairing(): Promise<void> {
    if (this.pairingPollBusy) {
      return;
    }
    this.pairingPollBusy = true;
    try {
      await this.pollPairingDevices();
    } finally {
      this.pairingPollBusy = false;
    }
  }

  /** One pairing-poll pass over all discovered devices. */
  private async pollPairingDevices(): Promise<void> {
    for (const device of this.discoveredDuringPairing) {
      let issuedToken: string | undefined;
      try {
        const client = this.makeClient(device.ip, "");
        const result = await client.requestPairing();
        issuedToken = result.token;

        // Success! Button was pressed
        this.log.info(
          `Successfully paired with ${device.name} (${device.productType}) at ${device.ip} — connecting...`,
        );

        // Get device info + capture the device's TLS cert CN to pin its identity on future connects
        const authedClient = this.makeClient(device.ip, result.token);
        const info = await authedClient.getDeviceInfo();
        const certCn = authedClient.getServerCertCn();

        // I10: cross-check the pinned CN (`appliance/<type>/<serial>`) against the
        // serial the device reports over the authenticated channel. A mismatch means
        // the identity we are about to pin and the device's self-report disagree —
        // warn (not block: CN formats vary across firmware and a hard reject could
        // break a legitimate pairing), then pin the CN as captured.
        if (certCn && !certCn.includes(info.serial)) {
          this.log.warn(
            `${sanitizeForLog(info.product_name)}: paired certificate CN "${sanitizeForLog(certCn)}" does not ` +
              `contain the reported serial "${sanitizeForLog(info.serial)}" — verify this is the intended device.`,
          );
        }

        const deviceConfig: DeviceConfig = {
          token: result.token,
          productType: info.product_type,
          serial: info.serial,
          // L9: productName is device-supplied and becomes the object's common.name
          // AND prefixes almost every device log line — strip CR/LF so a hostile
          // device can't inject newlines into the object tree or forge log lines.
          // (serial/productType stay raw: they feed the sanitized object ID and the
          // HWE-BAT comparison, never a raw log except the one wrapped call site.)
          productName: sanitizeForLog(info.product_name),
          ip: device.ip,
          ...(certCn ? { certCn } : {}),
        };

        // Save to device object (no adapter restart!)
        await this.saveDeviceToObject(deviceConfig);
        await this.stateManager.createDeviceStates(deviceConfig);

        // Re-pair of an existing device (e.g. after factory reset): close the
        // old connection's wsClient + timers before overwriting the map entry,
        // otherwise the old WS keeps running as a zombie until restart.
        const key = this.stateManager.devicePrefix(deviceConfig);
        const previous = this.connections.get(key);
        if (previous) {
          this.log.debug(`Re-pair: closing previous connection for ${deviceConfig.productName}`);
          this.connectionManager.teardownConnection(previous);
        }

        // Create connection and connect
        const conn = createDeviceConnection(deviceConfig, device.ip);
        this.connections.set(key, conn);
        void this.initDevice(conn).catch((err: unknown) =>
          this.log.error(`initDevice failed for ${conn.config.productName}: ${errText(err)}`),
        );

        // Remove the just-paired entry by identity (not by serial — the manual-IP
        // placeholder carries serial "unknown" and would never match info.serial,
        // so it would be re-POSTed every 2s and mint orphaned tokens). Keep the
        // window open so the user can button-press more devices this session.
        this.discoveredDuringPairing = this.discoveredDuringPairing.filter(d => d !== device);

        this.connectionManager.updateGlobalConnection();
        // Do NOT call stopPairing() here — pairingTimer (60 s) closes the
        // window naturally; meanwhile the user can pair more devices.
        continue;
      } catch (err) {
        // 403 = button not pressed yet — expected, keep polling
        if (err instanceof HomeWizardApiError && err.statusCode === 403) {
          continue;
        }
        // A token WAS issued this round (button was pressed) but device-info/setup
        // failed (e.g. a malformed GET /api). Revoke the orphaned token AND drop this
        // device from the pairing queue: a persistently-malformed device would otherwise
        // re-mint + revoke a token every 2 s for the rest of the 60 s window (F4). The
        // 403 path above still keeps polling — only an issued-but-failed pairing gives up.
        // Surfaced as warn since the user pressed the button and expects a result.
        if (issuedToken) {
          this.makeClient(device.ip, issuedToken)
            .deleteUser()
            .catch(() => {
              /* best-effort revoke */
            });
          this.discoveredDuringPairing = this.discoveredDuringPairing.filter(d => d !== device);
          this.log.warn(
            `${sanitizeForLog(device.name)}: paired but could not read device info — token revoked, ` +
              `please retry pairing. (${errText(err)})`,
          );
          continue;
        }
        this.log.debug(`Pairing poll error for ${device.ip}: ${errText(err)}`);
      }
    }
  }

  /** Stop pairing mode */
  private stopPairing(): void {
    this.isPairing = false;
    this.pairingManualIp = "";
    this.discoveredDuringPairing = [];

    // Stop mDNS — only needed during pairing
    if (this.discovery) {
      this.discovery.stop();
      this.discovery = null;
    }

    if (this.pairingPollTimer) {
      this.clearInterval(this.pairingPollTimer);
      this.pairingPollTimer = undefined;
    }
    if (this.pairingTimer) {
      this.clearTimeout(this.pairingTimer);
      this.pairingTimer = undefined;
    }
  }

  /** Start mDNS to find devices that changed IP */
  private startIpRecovery(): void {
    // Don't start if already running or pairing
    if (this.discovery || this.isPairing) {
      return;
    }

    // Internal recovery — debug only. The initial disconnect already produced
    // one warn via logDeviceError; repeating that hourly while a device stays
    // offline is just spam.
    this.log.debug(`Device unreachable — searching for new IP via mDNS`);

    this.discovery = this.makeDiscovery();
    this.discovery.start(discovered => {
      // Match against disconnected devices
      for (const conn of this.connections.values()) {
        if (conn.config.serial !== discovered.serial) {
          continue;
        }
        if (discovered.ip === conn.ip || conn.wsAuthenticated) {
          return; // Same IP or already connected
        }
        // Multiple mDNS broadcasts can arrive within one recovery window
        // (e.g. AP roam). Skip if a connect cycle is already in flight.
        if (conn.recovering) {
          return;
        }

        this.log.info(`${conn.config.productName}: found at new IP ${discovered.ip} (was ${conn.ip})`);

        // Update IP and persist — reset stability (new network conditions)
        conn.ip = discovered.ip;
        conn.config.ip = discovered.ip;
        conn.wsFailCount = 0;
        conn.recentDisconnects = 0;
        // Surface persist-failures (e.g. js-controller hiccup) instead of
        // swallowing them — the user otherwise sees "new IP" log but the
        // change is lost on next restart.
        this.saveDeviceToObject(conn.config).catch((err: unknown) =>
          this.log.debug(`Failed to persist new IP for ${conn.config.productName}: ${errText(err)}`),
        );

        // Cancel pending reconnect and connect immediately
        if (conn.reconnectTimer) {
          this.clearTimeout(conn.reconnectTimer);
          conn.reconnectTimer = undefined;
        }
        if (conn.pollTimer) {
          this.clearInterval(conn.pollTimer);
          conn.pollTimer = undefined;
        }
        this.connectWebSocket(conn);
        return;
      }
    });

    // Stop mDNS after timeout — WS reconnect continues with exponential
    // backoff. Don't log per-device warns here: the initial disconnect already
    // produced a `deviceUnreachable` warn via logDeviceError; spamming the
    // user hourly while the device stays offline adds zero information. If
    // someone needs to see retry cadence they can enable debug logging.
    this.ipRecoveryTimer = this.setTimeout(() => {
      this.ipRecoveryTimer = undefined;
      this.stopIpRecovery();

      for (const conn of this.connections.values()) {
        if (!conn.wsAuthenticated && conn.wsFailCount > 0) {
          this.log.debug(
            `${conn.config.productName}: device offline — will keep retrying every ${WS_RECONNECT_MAX_MS / 1000}s`,
          );
        }
      }
    }, IP_RECOVERY_TIMEOUT_MS);
  }

  /** Stop mDNS IP recovery */
  private stopIpRecovery(): void {
    if (this.ipRecoveryTimer) {
      this.clearTimeout(this.ipRecoveryTimer);
      this.ipRecoveryTimer = undefined;
    }
    if (this.discovery && !this.isPairing) {
      this.discovery.stop();
      this.discovery = null;
    }
  }

  // --- Connection-lifecycle delegators → ConnectionManager (owns the registry +
  // reconnect/error state machine, F5). Kept so the orchestration unit tests can
  // drive the handlers directly on the adapter. ---

  /** Stop mDNS IP-recovery once every device is connected (main owns the discovery browser). */
  private onDeviceConnected(): void {
    if (this.discovery && !this.isPairing) {
      const allConnected = Array.from(this.connections.values()).every(c => c.wsAuthenticated);
      if (allConnected) {
        this.stopIpRecovery();
      }
    }
  }

  private initDevice(conn: DeviceConnection): Promise<void> {
    return this.connectionManager.initDevice(conn);
  }

  private connectWebSocket(conn: DeviceConnection): void {
    this.connectionManager.connectWebSocket(conn);
  }

  private onWsMeasurement(conn: DeviceConnection, data: Measurement): void {
    this.connectionManager.onWsMeasurement(conn, data);
  }

  private onWsSystem(conn: DeviceConnection, data: SystemInfo): void {
    this.connectionManager.onWsSystem(conn, data);
  }

  private onWsBattery(conn: DeviceConnection, data: BatteryControl): void {
    this.connectionManager.onWsBattery(conn, data);
  }

  private onWsConnected(conn: DeviceConnection): void {
    this.connectionManager.onWsConnected(conn);
  }

  private onWsDisconnected(conn: DeviceConnection, error?: Error): void {
    this.connectionManager.onWsDisconnected(conn, error);
  }

  private startRestFallback(conn: DeviceConnection): void {
    this.connectionManager.startRestFallback(conn);
  }

  private pollAllSystemInfo(): Promise<void> {
    return this.connectionManager.pollAllSystemInfo();
  }

  private pollSystemInfo(conn: DeviceConnection): Promise<void> {
    return this.connectionManager.pollSystemInfo(conn);
  }

  /**
   * Remove a device — disconnect, delete states and object
   *
   * @param stateId The remove state ID
   */
  private async removeDevice(stateId: string): Promise<void> {
    const conn = this.connectionManager.findConnectionForState(stateId);
    if (!conn) {
      return;
    }

    const key = this.stateManager.devicePrefix(conn.config);
    this.log.info(`Removing device ${conn.config.productName} (${sanitizeForLog(conn.config.serial)})`);

    // Mark as removed FIRST — async tasks (in-flight WS frames, REST polls,
    // outstanding pollSystemInfo) check this flag after each await and bail
    // out before recreating just-deleted objects via setStateAsync.
    conn.removed = true;

    // Best-effort token revoke on the device (DELETE /api/user) so the local/iobroker user
    // doesn't linger across pair/unpair cycles. Fire-and-forget — never block removal on a
    // (possibly offline) device's 10s timeout.
    if (conn.ip && conn.config.token) {
      void this.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial)
        .deleteUser()
        .catch((err: unknown) => this.log.debug(`Token revoke failed for ${conn.config.productName}: ${errText(err)}`));
    }

    // Disconnect
    this.connectionManager.teardownConnection(conn);
    this.connections.delete(key);
    // I8: evict the pinned per-device TLS agents (CN + serial) and close their
    // pooled sockets so nothing lingers in the module maps after the device is gone.
    dropDeviceAgent(conn.config.certCn, conn.config.serial);
    // Drop the per-device cooldown stamps — otherwise a re-pair of the same
    // serial within the cooldown window inherits the old device's stamp and
    // its first warn/info is silently suppressed (and the maps grow forever
    // across pair/remove cycles).
    this.connectionManager.dropCooldowns(conn.config.serial);

    // Delete device object and all states (no adapter restart!)
    await this.stateManager.removeDevice(conn.config);

    this.connectionManager.updateGlobalConnection();
  }

  private isUnstable(conn: DeviceConnection): boolean {
    return this.connectionManager.isUnstable(conn);
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HomeWizard(options);
} else {
  (() => new HomeWizard())();
}
