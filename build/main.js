"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  HomeWizard: () => HomeWizard
});
module.exports = __toCommonJS(main_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_adapter_core = require("@iobroker/adapter-core");
var import_node_path = require("node:path");
var import_coerce = require("./lib/coerce");
var import_connection_utils = require("./lib/connection-utils");
var import_connection_manager = require("./lib/connection-manager");
var import_discovery = require("./lib/discovery");
var import_cacert = require("./lib/cacert");
var import_homewizard_client = require("./lib/homewizard-client");
var import_state_manager = require("./lib/state-manager");
var import_websocket_client = require("./lib/websocket-client");
const PAIRING_TIMEOUT_MS = 6e4;
const PAIRING_POLL_MS = 2e3;
const SYSTEM_POLL_MS = 6e4;
const IP_RECOVERY_TIMEOUT_MS = 6e4;
function pinnedAgent(certCn, serial) {
  if (certCn) {
    return (0, import_cacert.createDeviceAgent)(certCn);
  }
  if (serial) {
    return (0, import_cacert.createDeviceAgentForSerial)(serial);
  }
  return void 0;
}
class HomeWizard extends utils.Adapter {
  stateManager;
  discovery = null;
  /**
   * Owns the connection registry + the reconnect/error state machine (connect,
   * WS push, REST fallback, backoff reconnect, unstable-mode, system poll,
   * auth-stop, deduped error logging). Constructed in the constructor so the
   * direct-method orchestration tests reach it before onReady runs. Lifecycle,
   * pairing, persistence and mDNS IP-recovery stay here (they own the browser).
   */
  connectionManager;
  /** Device connections — the registry lives in the connection manager. */
  get connections() {
    return this.connectionManager.connections;
  }
  /** Per-device warn cooldown stamps — owned by the connection manager. */
  get lastWarnAt() {
    return this.connectionManager.lastWarnAt;
  }
  /** Per-device info cooldown stamps — owned by the connection manager. */
  get lastInfoAt() {
    return this.connectionManager.lastInfoAt;
  }
  pairingTimer = void 0;
  pairingPollTimer = void 0;
  systemPollTimer = void 0;
  ipRecoveryTimer = void 0;
  isPairing = false;
  /**
   * In-flight guard for {@link pollPairing}: the poll runs every 2 s, but a
   * single device's requestPairing can hang up to the 10 s HTTP timeout —
   * without the guard, overlapping polls would fire concurrent POST /api/user
   * against the same device.
   */
  pairingPollBusy = false;
  pairingManualIp = "";
  discoveredDuringPairing = [];
  /** Set during onUnload — async paths bail before further setStateAsync calls. */
  unloading = false;
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
  makeClient = (ip, token, certCn, serial) => new import_homewizard_client.HomeWizardClient(ip, token, { log: this.log, agent: pinnedAgent(certCn, serial) });
  makeWebSocket = (ip, token, callbacks, timers, certCn, serial) => {
    const agent = pinnedAgent(certCn, serial);
    return new import_websocket_client.HomeWizardWebSocket(ip, token, callbacks, timers, agent ? { agent } : void 0);
  };
  makeDiscovery = () => new import_discovery.HomeWizardDiscovery(this.log);
  /** @param options Adapter options */
  constructor(options = {}) {
    super({ ...options, name: "homewizard" });
    const host = {
      getStateManager: () => this.stateManager,
      isUnloading: () => this.unloading,
      makeClient: (ip, token, certCn, serial) => this.makeClient(ip, token, certCn, serial),
      makeWebSocket: (ip, token, callbacks, timers, certCn, serial) => this.makeWebSocket(ip, token, callbacks, timers, certCn, serial),
      saveDeviceToObject: (config) => this.saveDeviceToObject(config),
      requestIpRecovery: () => this.startIpRecovery(),
      onDeviceConnected: () => this.onDeviceConnected()
    };
    this.connectionManager = new import_connection_manager.ConnectionManager(this, host);
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a;
    try {
      await import_adapter_core.I18n.init((0, import_node_path.join)(this.adapterDir, "admin"), this);
      this.stateManager = new import_state_manager.StateManager(this);
      const caDaysLeft = (0, import_cacert.caDaysUntilExpiry)(Date.now());
      if (caDaysLeft < 90) {
        this.log.warn(
          `Bundled HomeWizard CA certificate expires in ${caDaysLeft} days (${import_cacert.CA_NOT_AFTER.toISOString().slice(0, 10)}) \u2014 an adapter update will be needed to keep connecting.`
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
        this.log.info(`No devices configured \u2014 set 'startPairing' to true to add a device`);
        await this.setStateChangedAsync("info.connection", { val: false, ack: true });
      }
      const legacyCleanupDone = ((_a = await this.getStateAsync("info.legacyMigrated")) == null ? void 0 : _a.val) === true;
      for (const device of devices) {
        const key = this.stateManager.devicePrefix(device);
        if (!legacyCleanupDone) {
          await this.stateManager.cleanupMovedStates(device);
        }
        await this.stateManager.createDeviceStates(device);
        const conn = (0, import_connection_utils.createDeviceConnection)(device, device.ip || "");
        this.connections.set(key, conn);
        if (conn.ip) {
          this.log.debug(`Using stored IP ${conn.ip} for ${device.productName}`);
          void this.initDevice(conn).catch(
            (err) => this.log.error(`initDevice failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`)
          );
        }
      }
      if (!legacyCleanupDone) {
        await this.stateManager.markLegacyCleanupDone();
      }
      this.systemPollTimer = this.setInterval(() => {
        void this.pollAllSystemInfo();
      }, SYSTEM_POLL_MS);
      this.connectionManager.updateGlobalConnection();
    } catch (err) {
      this.log.error(`onReady failed: ${(0, import_coerce.errText)(err)}`);
    }
  }
  /**
   * Load device configs from existing device objects
   * Tokens are stored encrypted in device object native
   */
  async loadDevicesFromObjects() {
    const devices = [];
    const rawOldDevices = this.config.devices;
    const oldDevices = Array.isArray(rawOldDevices) ? rawOldDevices : [];
    if (oldDevices.length > 0) {
      this.log.debug(`Migrating ${oldDevices.length} device(s) from adapter config to device objects`);
      const migrated = [];
      for (const device of oldDevices) {
        try {
          await this.saveDeviceToObject(device);
          migrated.push(device);
        } catch (err) {
          this.log.warn(`Skipping a corrupt legacy device entry during migration: ${(0, import_coerce.errText)(err)}`);
        }
      }
      await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
        native: { devices: [] }
      });
      return migrated;
    }
    const objects = await this.getAdapterObjectsAsync();
    for (const [id, obj] of Object.entries(objects)) {
      if (obj.type !== "device") {
        continue;
      }
      const native = obj.native;
      if (!(native == null ? void 0 : native.encryptedToken) || !native.serial) {
        continue;
      }
      const localId = id.replace(`${this.namespace}.`, "");
      this.log.debug(`Loading device from object: ${localId}`);
      let token;
      try {
        token = this.decrypt(native.encryptedToken);
      } catch (err) {
        this.log.warn(
          `Cannot decrypt token for ${localId} \u2014 re-pair the device. (${(0, import_coerce.errText)(err)}). Other devices remain unaffected.`
        );
        continue;
      }
      devices.push({
        token,
        productType: native.productType || "unknown",
        serial: native.serial,
        // L9: clean a possibly-dirty stored name on load too (pre-fix install or
        // a manual DB edit) — keeps the object name and every log line newline-free.
        productName: (0, import_coerce.sanitizeForLog)(native.productName || native.productType || "unknown"),
        ...native.ip && (0, import_coerce.isValidIpv4)(native.ip) ? { ip: native.ip } : {},
        ...native.certCn ? { certCn: native.certCn } : {}
      });
    }
    return devices;
  }
  /**
   * Save device config to its device object native (encrypted token)
   *
   * @param config Device configuration to save
   */
  async saveDeviceToObject(config) {
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
          ...config.ip ? { ip: config.ip } : {},
          ...config.certCn ? { certCn: config.certCn } : {}
        }
      },
      { preserve: { common: ["name"] } }
    );
  }
  /**
   * Handle a discovered device from mDNS (only active during pairing)
   *
   * @param discovered Discovered device info
   */
  onDeviceDiscovered(discovered) {
    const existing = Array.from(this.connections.values()).find((c) => c.config.serial === discovered.serial);
    if (existing) {
      return;
    }
    if (this.discoveredDuringPairing.find((d) => d.serial === discovered.serial)) {
      return;
    }
    if (this.discoveredDuringPairing.length >= 50) {
      this.log.debug(`mDNS: discovery list full (50) \u2014 ignoring ${discovered.name}`);
      return;
    }
    this.discoveredDuringPairing.push(discovered);
    this.log.info(
      `Found ${discovered.name} (${discovered.productType}) at ${discovered.ip} \u2014 press the button on the device to pair`
    );
  }
  /**
   * Adapter stopping — MUST be synchronous
   *
   * @param callback Completion callback
   */
  onUnload(callback) {
    var _a;
    this.unloading = true;
    try {
      if (this.pairingTimer) {
        this.clearTimeout(this.pairingTimer);
        this.pairingTimer = void 0;
      }
      if (this.pairingPollTimer) {
        this.clearInterval(this.pairingPollTimer);
        this.pairingPollTimer = void 0;
      }
      if (this.systemPollTimer) {
        this.clearInterval(this.systemPollTimer);
        this.systemPollTimer = void 0;
      }
      if (this.ipRecoveryTimer) {
        this.clearTimeout(this.ipRecoveryTimer);
        this.ipRecoveryTimer = void 0;
      }
      (_a = this.discovery) == null ? void 0 : _a.stop();
      for (const conn of this.connections.values()) {
        this.connectionManager.teardownConnection(conn);
      }
      this.connections.clear();
      this.setState("info.connection", { val: false, ack: true }).catch(() => {
      });
    } finally {
      callback();
    }
  }
  async onStateChange(id, state) {
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
        this.log.debug(`stateChange ${id}: no matching connected device \u2014 ignored`);
        return;
      }
      const client = this.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);
      try {
        if (id.endsWith(".system.reboot")) {
          this.log.info(`Rebooting ${conn.config.productName} (${conn.ip})`);
          await client.reboot();
          await this.setStateAsync(id, { val: false, ack: true });
        } else if (id.endsWith(".system.identify")) {
          await client.identify();
          await this.setStateAsync(id, { val: false, ack: true });
        } else if (id.endsWith(".system.cloud_enabled")) {
          await client.setSystem({ cloud_enabled: !!state.val });
          await this.setStateAsync(id, { val: state.val, ack: true });
        } else if (id.endsWith(".system.status_led_brightness_pct")) {
          const pct = (0, import_coerce.coerceFiniteNumber)(state.val);
          if (pct === null || pct < 0 || pct > 100) {
            this.log.warn(`Invalid status_led_brightness_pct '${String(state.val)}' \u2014 expected a number 0-100`);
            return;
          }
          await client.setSystem({ status_led_brightness_pct: pct });
          await this.setStateAsync(id, { val: pct, ack: true });
        } else if (id.endsWith(".system.api_v1_enabled")) {
          if (state.val) {
            this.log.warn(
              `${conn.config.productName}: enabling the legacy v1 API \u2014 it has no TLS and no token, so any host on the LAN can then read and control this device without authentication.`
            );
          }
          await client.setSystem({ api_v1_enabled: !!state.val });
          await this.setStateAsync(id, { val: state.val, ack: true });
        } else if (id.endsWith(".battery.mode")) {
          const mode = (0, import_coerce.validateBatteryMode)(String(state.val));
          if (!mode) {
            this.log.warn(
              `Invalid battery.mode value: '${String(state.val)}' \u2014 expected one of: zero, to_full, standby, predictive`
            );
            return;
          }
          await client.setBatteries({ mode });
          await this.setStateAsync(id, { val: state.val, ack: true });
        } else if (id.endsWith(".battery.permissions")) {
          const result = (0, import_coerce.parseBatteryPermissions)(String(state.val));
          if (!result.ok) {
            this.log.warn(
              `Invalid JSON for battery.permissions: ${result.reason} \u2014 expected array, got: ${result.sample}`
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
        this.log.warn(`Failed to set ${id}: ${(0, import_coerce.errText)(err)}`);
      }
    } catch (err) {
      this.log.error(`stateChange failed: ${(0, import_coerce.errText)(err)}`);
    }
  }
  /** Start pairing mode — discover devices and attempt to pair */
  async startPairing() {
    if (this.isPairing) {
      this.log.debug("Pairing already active");
      return;
    }
    await this.setStateAsync("startPairing", { val: false, ack: true });
    this.stopIpRecovery();
    this.isPairing = true;
    this.discoveredDuringPairing = [];
    const ipState = await this.getStateAsync("pairingIp");
    this.pairingManualIp = (ipState == null ? void 0 : ipState.val) ? String(ipState.val).trim() : "";
    await this.setStateAsync("pairingIp", { val: "", ack: true });
    if (this.pairingManualIp) {
      if (!(0, import_coerce.isAssignableDeviceIpv4)(this.pairingManualIp)) {
        this.log.warn(
          `Invalid pairing IP '${this.pairingManualIp}' \u2014 expected a LAN IPv4 (e.g. 192.168.1.42), not loopback/link-local/broadcast`
        );
        this.isPairing = false;
        this.pairingManualIp = "";
        return;
      }
      this.log.info(
        `Pairing mode enabled for ${this.pairingManualIp} \u2014 press the button on your HomeWizard device now (60 seconds timeout)`
      );
      this.discoveredDuringPairing.push({
        ip: this.pairingManualIp,
        productType: "unknown",
        serial: "unknown",
        name: this.pairingManualIp
      });
    } else {
      this.log.info(
        `Pairing mode enabled \u2014 searching for devices via mDNS, press the button on your HomeWizard device now (60 seconds timeout)`
      );
      if (!this.discovery) {
        this.discovery = this.makeDiscovery();
      }
      this.discovery.start((discovered) => {
        this.onDeviceDiscovered(discovered);
      });
    }
    this.pairingPollTimer = this.setInterval(() => {
      this.pollPairing().catch((err) => this.log.debug(`pollPairing failed: ${(0, import_coerce.errText)(err)}`));
    }, PAIRING_POLL_MS);
    this.pairingTimer = this.setTimeout(() => {
      this.stopPairing();
      this.log.info(`Pairing mode automatically disabled after 60 seconds timeout`);
    }, PAIRING_TIMEOUT_MS);
  }
  /** Poll all discovered devices to attempt pairing */
  async pollPairing() {
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
  async pollPairingDevices() {
    for (const device of this.discoveredDuringPairing) {
      let issuedToken;
      try {
        const client = this.makeClient(device.ip, "");
        const result = await client.requestPairing();
        issuedToken = result.token;
        this.log.info(
          `Successfully paired with ${device.name} (${device.productType}) at ${device.ip} \u2014 connecting...`
        );
        const authedClient = this.makeClient(device.ip, result.token);
        const info = await authedClient.getDeviceInfo();
        const certCn = authedClient.getServerCertCn();
        if (certCn && !certCn.includes(info.serial)) {
          this.log.warn(
            `${(0, import_coerce.sanitizeForLog)(info.product_name)}: paired certificate CN "${(0, import_coerce.sanitizeForLog)(certCn)}" does not contain the reported serial "${(0, import_coerce.sanitizeForLog)(info.serial)}" \u2014 verify this is the intended device.`
          );
        }
        const deviceConfig = {
          token: result.token,
          productType: info.product_type,
          serial: info.serial,
          // L9: productName is device-supplied and becomes the object's common.name
          // AND prefixes almost every device log line — strip CR/LF so a hostile
          // device can't inject newlines into the object tree or forge log lines.
          // (serial/productType stay raw: they feed the sanitized object ID and the
          // HWE-BAT comparison, never a raw log except the one wrapped call site.)
          productName: (0, import_coerce.sanitizeForLog)(info.product_name),
          ip: device.ip,
          ...certCn ? { certCn } : {}
        };
        await this.saveDeviceToObject(deviceConfig);
        await this.stateManager.createDeviceStates(deviceConfig);
        const key = this.stateManager.devicePrefix(deviceConfig);
        const previous = this.connections.get(key);
        if (previous) {
          this.log.debug(`Re-pair: closing previous connection for ${deviceConfig.productName}`);
          this.connectionManager.teardownConnection(previous);
        }
        const conn = (0, import_connection_utils.createDeviceConnection)(deviceConfig, device.ip);
        this.connections.set(key, conn);
        void this.initDevice(conn).catch(
          (err) => this.log.error(`initDevice failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`)
        );
        this.discoveredDuringPairing = this.discoveredDuringPairing.filter((d) => d !== device);
        this.connectionManager.updateGlobalConnection();
        continue;
      } catch (err) {
        if (err instanceof import_homewizard_client.HomeWizardApiError && err.statusCode === 403) {
          continue;
        }
        if (issuedToken) {
          this.makeClient(device.ip, issuedToken).deleteUser().catch(() => {
          });
          this.discoveredDuringPairing = this.discoveredDuringPairing.filter((d) => d !== device);
          this.log.warn(
            `${(0, import_coerce.sanitizeForLog)(device.name)}: paired but could not read device info \u2014 token revoked, please retry pairing. (${(0, import_coerce.errText)(err)})`
          );
          continue;
        }
        this.log.debug(`Pairing poll error for ${device.ip}: ${(0, import_coerce.errText)(err)}`);
      }
    }
  }
  /** Stop pairing mode */
  stopPairing() {
    this.isPairing = false;
    this.pairingManualIp = "";
    this.discoveredDuringPairing = [];
    if (this.discovery) {
      this.discovery.stop();
      this.discovery = null;
    }
    if (this.pairingPollTimer) {
      this.clearInterval(this.pairingPollTimer);
      this.pairingPollTimer = void 0;
    }
    if (this.pairingTimer) {
      this.clearTimeout(this.pairingTimer);
      this.pairingTimer = void 0;
    }
  }
  /** Start mDNS to find devices that changed IP */
  startIpRecovery() {
    if (this.discovery || this.isPairing) {
      return;
    }
    this.log.debug(`Device unreachable \u2014 searching for new IP via mDNS`);
    this.discovery = this.makeDiscovery();
    this.discovery.start((discovered) => {
      for (const conn of this.connections.values()) {
        if (conn.config.serial !== discovered.serial) {
          continue;
        }
        if (discovered.ip === conn.ip || conn.wsAuthenticated) {
          return;
        }
        if (conn.recovering) {
          return;
        }
        this.log.info(`${conn.config.productName}: found at new IP ${discovered.ip} (was ${conn.ip})`);
        conn.ip = discovered.ip;
        conn.config.ip = discovered.ip;
        conn.wsFailCount = 0;
        conn.recentDisconnects = 0;
        this.saveDeviceToObject(conn.config).catch(
          (err) => this.log.debug(`Failed to persist new IP for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`)
        );
        if (conn.reconnectTimer) {
          this.clearTimeout(conn.reconnectTimer);
          conn.reconnectTimer = void 0;
        }
        if (conn.pollTimer) {
          this.clearInterval(conn.pollTimer);
          conn.pollTimer = void 0;
        }
        this.connectWebSocket(conn);
        return;
      }
    });
    this.ipRecoveryTimer = this.setTimeout(() => {
      this.ipRecoveryTimer = void 0;
      this.stopIpRecovery();
      for (const conn of this.connections.values()) {
        if (!conn.wsAuthenticated && conn.wsFailCount > 0) {
          this.log.debug(
            `${conn.config.productName}: device offline \u2014 will keep retrying every ${import_connection_manager.WS_RECONNECT_MAX_MS / 1e3}s`
          );
        }
      }
    }, IP_RECOVERY_TIMEOUT_MS);
  }
  /** Stop mDNS IP recovery */
  stopIpRecovery() {
    if (this.ipRecoveryTimer) {
      this.clearTimeout(this.ipRecoveryTimer);
      this.ipRecoveryTimer = void 0;
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
  onDeviceConnected() {
    if (this.discovery && !this.isPairing) {
      const allConnected = Array.from(this.connections.values()).every((c) => c.wsAuthenticated);
      if (allConnected) {
        this.stopIpRecovery();
      }
    }
  }
  initDevice(conn) {
    return this.connectionManager.initDevice(conn);
  }
  connectWebSocket(conn) {
    this.connectionManager.connectWebSocket(conn);
  }
  onWsMeasurement(conn, data) {
    this.connectionManager.onWsMeasurement(conn, data);
  }
  onWsSystem(conn, data) {
    this.connectionManager.onWsSystem(conn, data);
  }
  onWsBattery(conn, data) {
    this.connectionManager.onWsBattery(conn, data);
  }
  onWsConnected(conn) {
    this.connectionManager.onWsConnected(conn);
  }
  onWsDisconnected(conn, error) {
    this.connectionManager.onWsDisconnected(conn, error);
  }
  startRestFallback(conn) {
    this.connectionManager.startRestFallback(conn);
  }
  pollAllSystemInfo() {
    return this.connectionManager.pollAllSystemInfo();
  }
  pollSystemInfo(conn) {
    return this.connectionManager.pollSystemInfo(conn);
  }
  /**
   * Remove a device — disconnect, delete states and object
   *
   * @param stateId The remove state ID
   */
  async removeDevice(stateId) {
    const conn = this.connectionManager.findConnectionForState(stateId);
    if (!conn) {
      return;
    }
    const key = this.stateManager.devicePrefix(conn.config);
    this.log.info(`Removing device ${conn.config.productName} (${(0, import_coerce.sanitizeForLog)(conn.config.serial)})`);
    conn.removed = true;
    if (conn.ip && conn.config.token) {
      void this.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial).deleteUser().catch((err) => this.log.debug(`Token revoke failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`));
    }
    this.connectionManager.teardownConnection(conn);
    this.connections.delete(key);
    (0, import_cacert.dropDeviceAgent)(conn.config.certCn, conn.config.serial);
    this.connectionManager.dropCooldowns(conn.config.serial);
    await this.stateManager.removeDevice(conn.config);
    this.connectionManager.updateGlobalConnection();
  }
  isUnstable(conn) {
    return this.connectionManager.isUnstable(conn);
  }
}
if (require.main !== module) {
  module.exports = (options) => new HomeWizard(options);
} else {
  (() => new HomeWizard())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HomeWizard
});
//# sourceMappingURL=main.js.map
