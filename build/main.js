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
var import_discovery = require("./lib/discovery");
var import_cacert = require("./lib/cacert");
var import_homewizard_client = require("./lib/homewizard-client");
var import_main_helpers = require("./lib/main-helpers");
var import_state_manager = require("./lib/state-manager");
var import_websocket_client = require("./lib/websocket-client");
const PAIRING_TIMEOUT_MS = 6e4;
const PAIRING_POLL_MS = 2e3;
const WS_RECONNECT_BASE_MS = 5e3;
const WS_RECONNECT_MAX_MS = 3e5;
const REST_POLL_MS = 1e4;
const SYSTEM_POLL_MS = 6e4;
const MAX_AUTH_FAILURES = 3;
const WS_FAILURES_BEFORE_MDNS = 3;
const IP_RECOVERY_TIMEOUT_MS = 6e4;
const MDNS_RETRY_EVERY = 12;
const STABLE_THRESHOLD_MS = 6e5;
const WS_RECONNECT_MAX_UNSTABLE_MS = 6e4;
const REST_POLL_UNSTABLE_MS = 3e4;
const WARN_COOLDOWN_MS = 60 * 60 * 1e3;
const INFO_COOLDOWN_MS = 60 * 60 * 1e3;
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
  connections = /* @__PURE__ */ new Map();
  /**
   * Per-device last-warn timestamp for chronic-bouncing cooldown. Key =
   * `conn.config.serial` (kategorienübergreifend). The classifyError-based
   * `lastErrorCode`-Dedup in {@link logDeviceError} resets on every recovery,
   * so on chronic bouncing a new disconnect counts as "first occurrence"
   * → wieder warn. This cooldown stamp persists across recoveries so the user
   * sees max one warn per WARN_COOLDOWN_MS per device.
   */
  lastWarnAt = /* @__PURE__ */ new Map();
  /** Per-device last-info timestamp for `connection restored`. Analog cooldown. */
  lastInfoAt = /* @__PURE__ */ new Map();
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
  /**
   * Close a connection's WebSocket and clear its poll + reconnect timers.
   *
   * @param conn Device connection to tear down
   */
  teardownConnection(conn) {
    var _a;
    (_a = conn.wsClient) == null ? void 0 : _a.close();
    if (conn.pollTimer) {
      this.clearInterval(conn.pollTimer);
      conn.pollTimer = void 0;
    }
    if (conn.reconnectTimer) {
      this.clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = void 0;
    }
  }
  /** @param options Adapter options */
  constructor(options = {}) {
    super({ ...options, name: "homewizard" });
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
      this.updateGlobalConnection();
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
        this.teardownConnection(conn);
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
      const conn = this.findConnectionForState(id);
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
          this.teardownConnection(previous);
        }
        const conn = (0, import_connection_utils.createDeviceConnection)(deviceConfig, device.ip);
        this.connections.set(key, conn);
        void this.initDevice(conn).catch(
          (err) => this.log.error(`initDevice failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`)
        );
        this.discoveredDuringPairing = this.discoveredDuringPairing.filter((d) => d !== device);
        this.updateGlobalConnection();
        continue;
      } catch (err) {
        if (err instanceof import_homewizard_client.HomeWizardApiError && err.statusCode === 403) {
          continue;
        }
        if (issuedToken) {
          this.makeClient(device.ip, issuedToken).deleteUser().catch(() => {
          });
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
            `${conn.config.productName}: device offline \u2014 will keep retrying every ${WS_RECONNECT_MAX_MS / 1e3}s`
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
  /**
   * Initialize a newly discovered device — fetch info and connect WebSocket
   *
   * @param conn Device connection with IP set
   */
  async initDevice(conn) {
    if (this.unloading || conn.removed) {
      return;
    }
    try {
      const client = this.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);
      const info = await client.getDeviceInfo();
      if (this.unloading || conn.removed) {
        return;
      }
      if (!conn.config.certCn) {
        const certCn = client.getServerCertCn();
        if (certCn) {
          conn.config.certCn = certCn;
          this.saveDeviceToObject(conn.config).catch(
            (err) => this.log.debug(`Failed to persist cert CN for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`)
          );
        }
      }
      const key = this.stateManager.devicePrefix(conn.config);
      await this.setStateAsync(`${key}.info.firmware`, {
        val: info.firmware_version,
        ack: true
      });
    } catch (err) {
      if (this.unloading) {
        return;
      }
      this.logDeviceError(conn, "init", err);
    }
    if (this.unloading || conn.removed) {
      return;
    }
    this.connectWebSocket(conn);
    void this.pollSystemInfo(conn);
  }
  /**
   * Connect WebSocket for a device
   *
   * @param conn Device connection
   */
  connectWebSocket(conn) {
    if (this.unloading || !conn.ip) {
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
      this.startIpRecovery();
    }
    const wsClient = this.makeWebSocket(
      conn.ip,
      conn.config.token,
      {
        onMeasurement: (data) => this.onWsMeasurement(conn, data),
        onSystem: (data) => this.onWsSystem(conn, data),
        onBattery: (data) => this.onWsBattery(conn, data),
        onConnected: () => this.onWsConnected(conn),
        onDisconnected: (error) => this.onWsDisconnected(conn, error),
        log: this.log
      },
      {
        schedule: (cb, ms) => this.setTimeout(cb, ms),
        cancel: (h) => {
          this.clearTimeout(h);
        },
        scheduleRepeating: (cb, ms) => this.setInterval(cb, ms),
        cancelRepeating: (h) => {
          this.clearInterval(h);
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
   * @param conn Device connection
   * @param data Measurement payload
   */
  onWsMeasurement(conn, data) {
    if (conn.removed || this.unloading) {
      return;
    }
    if (conn.measurementBusy) {
      return;
    }
    conn.measurementBusy = true;
    this.stateManager.updateMeasurement(conn.config, data, () => conn.removed || this.unloading).catch((err) => {
      this.log.debug(`updateMeasurement failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`);
    }).finally(() => {
      conn.measurementBusy = false;
    });
  }
  /**
   * Handle a real-time system push (cloud/led changes etc.).
   *
   * @param conn Device connection
   * @param data System payload
   */
  onWsSystem(conn, data) {
    if (conn.removed || this.unloading) {
      return;
    }
    if (conn.systemBusy) {
      return;
    }
    conn.systemBusy = true;
    this.stateManager.updateSystem(conn.config, data, () => conn.removed || this.unloading).catch((err) => {
      this.log.debug(`updateSystem (ws) failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`);
    }).finally(() => {
      conn.systemBusy = false;
    });
  }
  /**
   * Handle a real-time battery-group push (mode/permissions/target power).
   *
   * @param conn Device connection
   * @param data Battery-control payload
   */
  onWsBattery(conn, data) {
    if (conn.removed || this.unloading) {
      return;
    }
    if (!data.battery_count || data.battery_count <= 0) {
      return;
    }
    if (conn.batteryBusy) {
      return;
    }
    conn.batteryBusy = true;
    this.stateManager.updateBattery(conn.config, data).catch((err) => {
      this.log.debug(`updateBattery (ws) failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`);
    }).finally(() => {
      conn.batteryBusy = false;
    });
  }
  /**
   * WebSocket authenticated — mark connected, stop REST fallback, log recovery (cooldowned).
   *
   * @param conn Device connection
   */
  onWsConnected(conn) {
    var _a;
    conn.wsAuthenticated = true;
    conn.wsFailCount = 0;
    conn.authFailCount = 0;
    conn.lastConnectedAt = Date.now();
    conn.recovering = false;
    this.stateManager.setDeviceConnected(conn.config, true).catch(
      (err) => this.log.debug(`setDeviceConnected(true) failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`)
    );
    this.updateGlobalConnection();
    if (conn.pollTimer) {
      this.clearInterval(conn.pollTimer);
      conn.pollTimer = void 0;
    }
    if (this.discovery && !this.isPairing) {
      const allConnected = Array.from(this.connections.values()).every((c) => c.wsAuthenticated);
      if (allConnected) {
        this.stopIpRecovery();
      }
    }
    if (conn.lastErrorCode) {
      const now = Date.now();
      const lastInfo = (_a = this.lastInfoAt.get(conn.config.serial)) != null ? _a : 0;
      const msg = this.isUnstable(conn) ? `${conn.config.productName}: connection restored (unstable mode)` : `${conn.config.productName}: connection restored`;
      if ((0, import_main_helpers.shouldEmitAfterCooldown)(lastInfo, now, INFO_COOLDOWN_MS)) {
        this.lastInfoAt.set(conn.config.serial, now);
        this.log.info(msg);
      } else {
        this.log.debug(`${msg} (cooldown)`);
      }
      conn.lastErrorCode = "";
    }
    this.log.debug(`WebSocket connected to ${conn.config.productName} (${conn.ip})`);
  }
  /**
   * WebSocket disconnected — track stability, start REST fallback, schedule backed-off reconnect
   * (unless an auth failure stops the loop).
   *
   * @param conn Device connection
   * @param error Disconnect error, if any
   */
  onWsDisconnected(conn, error) {
    const isAuthError = error instanceof import_homewizard_client.HomeWizardApiError && (error.errorCode === "user:unauthorized" || error.statusCode === 401);
    if (conn.lastConnectedAt > 0 && !isAuthError) {
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
        this.log.debug(`${conn.config.productName}: unstable connection detected \u2014 using faster reconnect`);
      } else if (transition === "stabilized") {
        this.log.debug(`${conn.config.productName}: connection stabilized \u2014 using normal reconnect`);
      }
    }
    conn.wsAuthenticated = false;
    conn.wsClient = null;
    conn.recovering = false;
    conn.lastConnectedAt = 0;
    this.stateManager.setDeviceConnected(conn.config, false).catch(
      (err) => this.log.debug(`setDeviceConnected(false) failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`)
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
    const key = this.stateManager.devicePrefix(conn.config);
    this.log.debug(`${key}: WS reconnect in ${delay / 1e3}s (attempt ${conn.wsFailCount})`);
    conn.reconnectTimer = this.setTimeout(() => {
      conn.reconnectTimer = void 0;
      this.connectWebSocket(conn);
    }, delay);
  }
  /**
   * Start REST polling as fallback when WebSocket is down.
   * For stable devices: stops on network errors (WS reconnect handles recovery).
   * For unstable devices: slows down instead of stopping to minimize data gaps.
   *
   * @param conn Device connection
   */
  startRestFallback(conn) {
    if (conn.pollTimer || !conn.ip) {
      return;
    }
    const unstable = this.isUnstable(conn);
    const interval = (0, import_main_helpers.pickRestPollInterval)(unstable, REST_POLL_MS, REST_POLL_UNSTABLE_MS);
    const client = this.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);
    conn.pollTimer = this.setInterval(async () => {
      if (conn.removed || this.unloading) {
        return;
      }
      if (conn.restPollBusy) {
        return;
      }
      conn.restPollBusy = true;
      try {
        const data = await client.getMeasurement();
        if (conn.removed || this.unloading) {
          return;
        }
        await this.stateManager.updateMeasurement(conn.config, data, () => conn.removed || this.unloading);
      } catch (err) {
        if (this.unloading) {
          return;
        }
        this.logDeviceError(conn, "rest", err);
        if (err instanceof import_homewizard_client.HomeWizardApiError && (err.errorCode === "user:unauthorized" || err.statusCode === 401)) {
          this.handleAuthFailure(
            conn,
            err,
            /* cleanupTimers */
            true
          );
          return;
        }
        if (!unstable && (0, import_connection_utils.classifyError)(err) === "NETWORK" && conn.pollTimer) {
          this.clearInterval(conn.pollTimer);
          conn.pollTimer = void 0;
        }
      } finally {
        conn.restPollBusy = false;
      }
    }, interval);
  }
  /** Poll system info for all connected devices in parallel */
  async pollAllSystemInfo() {
    if (this.unloading) {
      return;
    }
    const tasks = Array.from(this.connections.values()).filter((c) => c.ip && c.wsAuthenticated && !c.removed).map((c) => this.pollSystemInfo(c));
    await Promise.all(tasks);
  }
  /**
   * Poll system info for a single device
   *
   * @param conn Device connection
   */
  async pollSystemInfo(conn) {
    var _a;
    if (!conn.ip || conn.removed || this.unloading) {
      return;
    }
    try {
      const client = this.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);
      const system = await client.getSystem();
      if (conn.removed || this.unloading) {
        return;
      }
      await this.stateManager.updateSystem(conn.config, system, () => conn.removed || this.unloading);
      conn.systemPollCount = ((_a = conn.systemPollCount) != null ? _a : 0) + 1;
      if (conn.systemPollCount % 10 === 1) {
        try {
          const info = await client.getDeviceInfo();
          const newName = (0, import_coerce.sanitizeForLog)(info.product_name);
          if (!conn.removed && !this.unloading && info.product_name && newName !== conn.config.productName) {
            this.log.info(`${conn.config.productName}: name changed to '${newName}' \u2014 updating object`);
            conn.config.productName = newName;
            await this.saveDeviceToObject(conn.config);
          }
        } catch {
        }
      }
      if (conn.removed || this.unloading) {
        return;
      }
      try {
        const battery = await client.getBatteries();
        if (conn.removed || this.unloading) {
          return;
        }
        if (battery && battery.battery_count && battery.battery_count > 0) {
          await this.stateManager.updateBattery(conn.config, battery);
        }
      } catch (err) {
        if (err instanceof import_homewizard_client.HomeWizardApiError && err.statusCode === 404) {
          return;
        }
        this.log.debug(`${conn.config.productName} batteries: ${(0, import_coerce.errText)(err)}`);
      }
    } catch (err) {
      if (this.unloading) {
        return;
      }
      this.logDeviceError(conn, "system", err);
    }
  }
  /** Update global info.connection based on all device states */
  updateGlobalConnection() {
    const anyConnected = Array.from(this.connections.values()).some((c) => c.wsAuthenticated);
    this.setStateChangedAsync("info.connection", {
      val: anyConnected,
      ack: true
    }).catch((err) => this.log.debug(`Failed to update info.connection: ${(0, import_coerce.errText)(err)}`));
  }
  /**
   * Remove a device — disconnect, delete states and object
   *
   * @param stateId The remove state ID
   */
  async removeDevice(stateId) {
    const conn = this.findConnectionForState(stateId);
    if (!conn) {
      return;
    }
    const key = this.stateManager.devicePrefix(conn.config);
    this.log.info(`Removing device ${conn.config.productName} (${(0, import_coerce.sanitizeForLog)(conn.config.serial)})`);
    conn.removed = true;
    if (conn.ip && conn.config.token) {
      void this.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial).deleteUser().catch((err) => this.log.debug(`Token revoke failed for ${conn.config.productName}: ${(0, import_coerce.errText)(err)}`));
    }
    this.teardownConnection(conn);
    this.connections.delete(key);
    (0, import_cacert.dropDeviceAgent)(conn.config.certCn, conn.config.serial);
    this.lastWarnAt.delete(conn.config.serial);
    this.lastInfoAt.delete(conn.config.serial);
    await this.stateManager.removeDevice(conn.config);
    this.updateGlobalConnection();
  }
  /**
   * Find connection for a state ID. Delegates to the pure helper so the
   * lookup math is unit-tested separately (`lib/main-helpers.test.ts`).
   *
   * @param stateId Full state ID
   */
  findConnectionForState(stateId) {
    return (0, import_main_helpers.findConnectionForState)(stateId, this.namespace, this.connections);
  }
  /**
   * Whether a device has unstable connectivity (frequent short-lived connections).
   * Unstable devices get faster reconnect and persistent REST fallback.
   *
   * @param conn Device connection
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
    if (!(error instanceof import_homewizard_client.HomeWizardApiError) || error.errorCode !== "user:unauthorized") {
      return true;
    }
    conn.authFailCount++;
    if (conn.authFailCount < MAX_AUTH_FAILURES) {
      return true;
    }
    this.log.warn(`${conn.config.productName}: token invalid \u2014 re-pair device to fix`);
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
   *    after recovery surfaces as warn again. Designtechnisch correct for
   *    „new failure mode" but blind to chronic bouncing.
   * 2. {@link lastWarnAt} per device serial — survives recovery. Even if the
   *    `lastErrorCode`-Dedup says „first occurrence", the cooldown stamp keeps
   *    the warn-emit suppressed if we've warned for this device within
   *    {@link WARN_COOLDOWN_MS}. Chronic bouncing produces at most 1× warn per
   *    hour per device.
   *
   * Cooldown key is the device serial — category-spanning. A flapping P1 that
   * cycles TIMEOUT→NETWORK→TIMEOUT is one phenomenon, one warn-budget.
   *
   * @param conn Device connection
   * @param context Error context (for debug messages only)
   * @param err Error object
   */
  logDeviceError(conn, context, err) {
    var _a;
    const errorCode = (0, import_connection_utils.classifyError)(err);
    const isRepeat = errorCode === conn.lastErrorCode;
    conn.lastErrorCode = errorCode;
    if (isRepeat) {
      this.log.debug(`${conn.config.productName} ${context}: ${(0, import_coerce.errText)(err)}`);
      return;
    }
    const now = Date.now();
    const lastWarn = (_a = this.lastWarnAt.get(conn.config.serial)) != null ? _a : 0;
    if (!(0, import_main_helpers.shouldEmitAfterCooldown)(lastWarn, now, WARN_COOLDOWN_MS)) {
      this.log.debug(`${conn.config.productName} ${context} (cooldown): ${(0, import_coerce.errText)(err)}`);
      return;
    }
    this.lastWarnAt.set(conn.config.serial, now);
    if (errorCode === "NETWORK") {
      this.log.warn(`${conn.config.productName}: device unreachable \u2014 will keep retrying`);
    } else {
      this.log.warn(`${conn.config.productName} ${context}: ${(0, import_coerce.errText)(err)}`);
    }
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
