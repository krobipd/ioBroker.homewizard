"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var utils = __toESM(require("@iobroker/adapter-core"));
var import_connection_utils = require("./lib/connection-utils");
var import_discovery = require("./lib/discovery");
var import_homewizard_client = require("./lib/homewizard-client");
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
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}
class HomeWizard extends utils.Adapter {
  stateManager;
  discovery = null;
  connections = /* @__PURE__ */ new Map();
  pairingTimer = void 0;
  pairingPollTimer = void 0;
  systemPollTimer = void 0;
  ipRecoveryTimer = void 0;
  isPairing = false;
  pairingManualIp = "";
  discoveredDuringPairing = [];
  unhandledRejectionHandler = null;
  uncaughtExceptionHandler = null;
  /** @param options Adapter options */
  constructor(options = {}) {
    super({ ...options, name: "homewizard" });
    this.on("ready", () => {
      this.onReady().catch(
        (err) => this.log.error(`onReady failed: ${errText(err)}`)
      );
    });
    this.on("stateChange", (id, state) => {
      this.onStateChange(id, state).catch(
        (err) => this.log.error(`stateChange failed: ${errText(err)}`)
      );
    });
    this.on("unload", (callback) => this.onUnload(callback));
    this.unhandledRejectionHandler = (reason) => {
      this.log.error(`Unhandled rejection: ${errText(reason)}`);
    };
    this.uncaughtExceptionHandler = (err) => {
      this.log.error(`Uncaught exception: ${err.message}`);
    };
    process.on("unhandledRejection", this.unhandledRejectionHandler);
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }
  /** Adapter started */
  async onReady() {
    this.stateManager = new import_state_manager.StateManager(this);
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
    await this.subscribeStatesAsync("*.remove");
    const devices = await this.loadDevicesFromObjects();
    if (devices.length === 0) {
      this.log.info(
        "No devices configured \u2014 set 'startPairing' to true to add a device"
      );
      await this.setStateAsync("info.connection", { val: false, ack: true });
    }
    for (const device of devices) {
      const key = this.stateManager.devicePrefix(device);
      await this.stateManager.cleanupMovedStates(device);
      await this.stateManager.createDeviceStates(device);
      const conn = (0, import_connection_utils.createDeviceConnection)(device, device.ip || "");
      this.connections.set(key, conn);
      if (conn.ip) {
        this.log.debug(`Using stored IP ${conn.ip} for ${device.productName}`);
        void this.initDevice(conn);
      }
    }
    this.systemPollTimer = this.setInterval(() => {
      void this.pollAllSystemInfo();
    }, SYSTEM_POLL_MS);
    this.updateGlobalConnection();
  }
  /**
   * Load device configs from existing device objects
   * Tokens are stored encrypted in device object native
   */
  async loadDevicesFromObjects() {
    const devices = [];
    const oldDevices = this.config.devices || [];
    if (oldDevices.length > 0) {
      this.log.debug(
        `Migrating ${oldDevices.length} device(s) from adapter config to device objects`
      );
      for (const device of oldDevices) {
        await this.saveDeviceToObject(device);
      }
      await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
        native: { devices: [] }
      });
      return oldDevices;
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
      const token = this.decrypt(native.encryptedToken);
      devices.push({
        token,
        productType: native.productType || "unknown",
        serial: native.serial,
        productName: native.productName || native.productType || "unknown",
        ...native.ip ? { ip: native.ip } : {}
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
    await this.extendObjectAsync(prefix, {
      type: "device",
      common: { name: config.productName || config.productType },
      native: {
        encryptedToken,
        productType: config.productType,
        serial: config.serial,
        productName: config.productName,
        ...config.ip ? { ip: config.ip } : {}
      }
    });
  }
  /**
   * Handle a discovered device from mDNS (only active during pairing)
   *
   * @param discovered Discovered device info
   */
  onDeviceDiscovered(discovered) {
    const existing = Array.from(this.connections.values()).find(
      (c) => c.config.serial === discovered.serial
    );
    if (existing) {
      return;
    }
    if (this.discoveredDuringPairing.find((d) => d.serial === discovered.serial)) {
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
    var _a, _b;
    try {
      if (this.pairingTimer) {
        this.clearTimeout(this.pairingTimer);
      }
      if (this.pairingPollTimer) {
        this.clearInterval(this.pairingPollTimer);
      }
      if (this.systemPollTimer) {
        this.clearInterval(this.systemPollTimer);
      }
      if (this.ipRecoveryTimer) {
        this.clearTimeout(this.ipRecoveryTimer);
      }
      (_a = this.discovery) == null ? void 0 : _a.stop();
      for (const conn of this.connections.values()) {
        (_b = conn.wsClient) == null ? void 0 : _b.close();
        if (conn.pollTimer) {
          this.clearInterval(conn.pollTimer);
        }
        if (conn.reconnectTimer) {
          this.clearTimeout(conn.reconnectTimer);
        }
      }
      this.connections.clear();
      if (this.unhandledRejectionHandler) {
        process.off("unhandledRejection", this.unhandledRejectionHandler);
        this.unhandledRejectionHandler = null;
      }
      if (this.uncaughtExceptionHandler) {
        process.off("uncaughtException", this.uncaughtExceptionHandler);
        this.uncaughtExceptionHandler = null;
      }
      void this.setState("info.connection", { val: false, ack: true });
    } finally {
      callback();
    }
  }
  /**
   * Handle state changes
   *
   * @param id State ID
   * @param state State value
   */
  async onStateChange(id, state) {
    if (!state || state.ack) {
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
      return;
    }
    const client = new import_homewizard_client.HomeWizardClient(conn.ip, conn.config.token);
    try {
      if (id.endsWith(".system.reboot")) {
        this.log.info(`Rebooting ${conn.config.productName} (${conn.ip})`);
        await client.reboot();
      } else if (id.endsWith(".system.identify")) {
        await client.identify();
      } else if (id.endsWith(".system.cloud_enabled")) {
        await client.setSystem({ cloud_enabled: !!state.val });
        await this.setStateAsync(id, { val: state.val, ack: true });
      } else if (id.endsWith(".system.status_led_brightness_pct")) {
        await client.setSystem({
          status_led_brightness_pct: Number(state.val)
        });
        await this.setStateAsync(id, { val: state.val, ack: true });
      } else if (id.endsWith(".system.api_v1_enabled")) {
        await client.setSystem({ api_v1_enabled: !!state.val });
        await this.setStateAsync(id, { val: state.val, ack: true });
      } else if (id.endsWith(".battery.mode")) {
        await client.setBatteries({
          mode: String(state.val)
        });
        await this.setStateAsync(id, { val: state.val, ack: true });
      } else if (id.endsWith(".battery.permissions")) {
        const perms = JSON.parse(String(state.val));
        await client.setBatteries({ permissions: perms });
        await this.setStateAsync(id, { val: state.val, ack: true });
      }
    } catch (err) {
      this.log.warn(
        `Failed to set ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  /** Start pairing mode — discover devices and attempt to pair */
  async startPairing() {
    if (this.isPairing) {
      this.log.debug("Pairing already active");
      return;
    }
    await this.setStateAsync("startPairing", { val: false, ack: true });
    this.isPairing = true;
    this.discoveredDuringPairing = [];
    this.stopIpRecovery();
    const ipState = await this.getStateAsync("pairingIp");
    this.pairingManualIp = (ipState == null ? void 0 : ipState.val) ? String(ipState.val).trim() : "";
    await this.setStateAsync("pairingIp", { val: "", ack: true });
    if (this.pairingManualIp) {
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
        "Pairing mode enabled \u2014 searching for devices via mDNS, press the button on your HomeWizard device now (60 seconds timeout)"
      );
      if (!this.discovery) {
        this.discovery = new import_discovery.HomeWizardDiscovery(this.log);
      }
      this.discovery.start((discovered) => {
        this.onDeviceDiscovered(discovered);
      });
    }
    this.pairingPollTimer = this.setInterval(() => {
      void this.pollPairing();
    }, PAIRING_POLL_MS);
    this.pairingTimer = this.setTimeout(() => {
      this.stopPairing();
      this.log.info(
        "Pairing mode automatically disabled after 60 seconds timeout"
      );
    }, PAIRING_TIMEOUT_MS);
  }
  /** Poll all discovered devices to attempt pairing */
  async pollPairing() {
    for (const device of this.discoveredDuringPairing) {
      try {
        const client = new import_homewizard_client.HomeWizardClient(device.ip);
        const result = await client.requestPairing();
        this.log.info(
          `Successfully paired with ${device.name} (${device.productType}) at ${device.ip} \u2014 connecting...`
        );
        const authedClient = new import_homewizard_client.HomeWizardClient(device.ip, result.token);
        const info = await authedClient.getDeviceInfo();
        const deviceConfig = {
          token: result.token,
          productType: info.product_type,
          serial: info.serial,
          productName: info.product_name,
          ip: device.ip
        };
        await this.saveDeviceToObject(deviceConfig);
        await this.stateManager.createDeviceStates(deviceConfig);
        const key = this.stateManager.devicePrefix(deviceConfig);
        const conn = (0, import_connection_utils.createDeviceConnection)(deviceConfig, device.ip);
        this.connections.set(key, conn);
        void this.initDevice(conn);
        this.discoveredDuringPairing = this.discoveredDuringPairing.filter(
          (d) => d.serial !== info.serial
        );
        this.stopPairing();
        this.updateGlobalConnection();
        return;
      } catch (err) {
        if (err instanceof import_homewizard_client.HomeWizardApiError && err.statusCode === 403) {
          continue;
        }
        this.log.debug(
          `Pairing poll error for ${device.ip}: ${err instanceof Error ? err.message : String(err)}`
        );
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
    this.log.info("Device unreachable \u2014 searching for new IP via mDNS");
    this.discovery = new import_discovery.HomeWizardDiscovery(this.log);
    this.discovery.start((discovered) => {
      for (const conn of this.connections.values()) {
        if (conn.config.serial !== discovered.serial) {
          continue;
        }
        if (discovered.ip === conn.ip || conn.wsAuthenticated) {
          return;
        }
        this.log.info(
          `${conn.config.productName}: found at new IP ${discovered.ip} (was ${conn.ip})`
        );
        conn.ip = discovered.ip;
        conn.config.ip = discovered.ip;
        conn.wsFailCount = 0;
        conn.recentDisconnects = 0;
        void this.saveDeviceToObject(conn.config);
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
          this.log.warn(
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
    try {
      const client = new import_homewizard_client.HomeWizardClient(conn.ip, conn.config.token);
      const info = await client.getDeviceInfo();
      const key = this.stateManager.devicePrefix(conn.config);
      await this.setStateAsync(`${key}.info.firmware`, {
        val: info.firmware_version,
        ack: true
      });
    } catch (err) {
      this.logDeviceError(conn, "init", err);
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
    if (!conn.ip) {
      return;
    }
    if (conn.authFailCount >= MAX_AUTH_FAILURES) {
      return;
    }
    if (conn.wsFailCount >= WS_FAILURES_BEFORE_MDNS && (conn.wsFailCount - WS_FAILURES_BEFORE_MDNS) % MDNS_RETRY_EVERY === 0) {
      this.startIpRecovery();
    }
    const key = this.stateManager.devicePrefix(conn.config);
    const wsClient = new import_websocket_client.HomeWizardWebSocket(conn.ip, conn.config.token, {
      onMeasurement: (data) => {
        void this.stateManager.updateMeasurement(conn.config, data);
      },
      onConnected: () => {
        conn.wsAuthenticated = true;
        conn.wsFailCount = 0;
        conn.authFailCount = 0;
        conn.lastConnectedAt = Date.now();
        void this.stateManager.setDeviceConnected(conn.config, true);
        this.updateGlobalConnection();
        if (conn.pollTimer) {
          this.clearInterval(conn.pollTimer);
          conn.pollTimer = void 0;
        }
        if (this.discovery && !this.isPairing) {
          const allConnected = Array.from(this.connections.values()).every(
            (c) => c.wsAuthenticated
          );
          if (allConnected) {
            this.stopIpRecovery();
          }
        }
        if (conn.lastErrorCode) {
          const mode = this.isUnstable(conn) ? " (unstable mode)" : "";
          this.log.info(
            `${conn.config.productName}: connection restored${mode}`
          );
          conn.lastErrorCode = "";
        }
        this.log.debug(
          `WebSocket connected to ${conn.config.productName} (${conn.ip})`
        );
      },
      onDisconnected: (error) => {
        if (conn.lastConnectedAt > 0) {
          const duration = Date.now() - conn.lastConnectedAt;
          if (duration < STABLE_THRESHOLD_MS) {
            conn.recentDisconnects++;
            if (conn.recentDisconnects === import_connection_utils.UNSTABLE_DISCONNECT_THRESHOLD) {
              this.log.info(
                `${conn.config.productName}: unstable connection detected \u2014 using faster reconnect`
              );
            }
          } else {
            if (conn.recentDisconnects >= import_connection_utils.UNSTABLE_DISCONNECT_THRESHOLD) {
              this.log.info(
                `${conn.config.productName}: connection stabilized \u2014 using normal reconnect`
              );
            }
            conn.recentDisconnects = 0;
          }
        }
        conn.wsAuthenticated = false;
        conn.wsClient = null;
        void this.stateManager.setDeviceConnected(conn.config, false);
        this.updateGlobalConnection();
        if (error) {
          this.logDeviceError(conn, "ws", error);
        }
        if (error instanceof import_homewizard_client.HomeWizardApiError && error.errorCode === "user:unauthorized") {
          conn.authFailCount++;
          if (conn.authFailCount >= MAX_AUTH_FAILURES) {
            this.log.warn(
              `${conn.config.productName}: token invalid \u2014 re-pair device to fix`
            );
            return;
          }
        }
        this.startRestFallback(conn);
        conn.wsFailCount++;
        const maxDelay = this.isUnstable(conn) ? WS_RECONNECT_MAX_UNSTABLE_MS : WS_RECONNECT_MAX_MS;
        const delay = Math.min(
          WS_RECONNECT_BASE_MS * Math.pow(2, conn.wsFailCount - 1),
          maxDelay
        );
        this.log.debug(
          `${key}: WS reconnect in ${delay / 1e3}s (attempt ${conn.wsFailCount})`
        );
        conn.reconnectTimer = this.setTimeout(() => {
          conn.reconnectTimer = void 0;
          this.connectWebSocket(conn);
        }, delay);
      },
      log: this.log
    });
    conn.wsClient = wsClient;
    wsClient.connect();
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
    const interval = unstable ? REST_POLL_UNSTABLE_MS : REST_POLL_MS;
    const client = new import_homewizard_client.HomeWizardClient(conn.ip, conn.config.token);
    conn.pollTimer = this.setInterval(async () => {
      var _a;
      try {
        const data = await client.getMeasurement();
        await this.stateManager.updateMeasurement(conn.config, data);
      } catch (err) {
        this.logDeviceError(conn, "rest", err);
        if (err instanceof import_homewizard_client.HomeWizardApiError && err.errorCode === "user:unauthorized") {
          conn.authFailCount++;
          if (conn.authFailCount >= MAX_AUTH_FAILURES) {
            this.log.warn(
              `${conn.config.productName}: token invalid \u2014 re-pair device to fix`
            );
            if (conn.pollTimer) {
              this.clearInterval(conn.pollTimer);
              conn.pollTimer = void 0;
            }
            if (conn.reconnectTimer) {
              this.clearTimeout(conn.reconnectTimer);
              conn.reconnectTimer = void 0;
            }
            (_a = conn.wsClient) == null ? void 0 : _a.close();
          }
          return;
        }
        if (!unstable && (0, import_connection_utils.classifyError)(err) === "NETWORK" && conn.pollTimer) {
          this.clearInterval(conn.pollTimer);
          conn.pollTimer = void 0;
        }
      }
    }, interval);
  }
  /** Poll system info for all connected devices */
  async pollAllSystemInfo() {
    for (const conn of this.connections.values()) {
      if (conn.ip && conn.wsAuthenticated) {
        await this.pollSystemInfo(conn);
      }
    }
  }
  /**
   * Poll system info for a single device
   *
   * @param conn Device connection
   */
  async pollSystemInfo(conn) {
    if (!conn.ip) {
      return;
    }
    try {
      const client = new import_homewizard_client.HomeWizardClient(conn.ip, conn.config.token);
      const system = await client.getSystem();
      await this.stateManager.updateSystem(conn.config, system);
      try {
        const battery = await client.getBatteries();
        if (battery.battery_count && battery.battery_count > 0) {
          await this.stateManager.updateBattery(conn.config, battery);
        }
      } catch {
      }
    } catch (err) {
      this.logDeviceError(conn, "system", err);
    }
  }
  /** Update global info.connection based on all device states */
  updateGlobalConnection() {
    const anyConnected = Array.from(this.connections.values()).some(
      (c) => c.wsAuthenticated
    );
    void this.setStateAsync("info.connection", {
      val: anyConnected,
      ack: true
    });
  }
  /**
   * Remove a device — disconnect, delete states and object
   *
   * @param stateId The remove state ID
   */
  async removeDevice(stateId) {
    var _a;
    const conn = this.findConnectionForState(stateId);
    if (!conn) {
      return;
    }
    const key = this.stateManager.devicePrefix(conn.config);
    this.log.info(
      `Removing device ${conn.config.productName} (${conn.config.serial})`
    );
    (_a = conn.wsClient) == null ? void 0 : _a.close();
    if (conn.pollTimer) {
      this.clearInterval(conn.pollTimer);
    }
    if (conn.reconnectTimer) {
      this.clearTimeout(conn.reconnectTimer);
    }
    this.connections.delete(key);
    await this.stateManager.removeDevice(conn.config);
    this.updateGlobalConnection();
  }
  /**
   * Find connection for a state ID
   *
   * @param stateId Full state ID
   */
  findConnectionForState(stateId) {
    const localId = stateId.replace(`${this.namespace}.`, "");
    for (const conn of this.connections.values()) {
      const prefix = this.stateManager.devicePrefix(conn.config);
      if (localId.startsWith(`${prefix}.`)) {
        return conn;
      }
    }
    return void 0;
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
   * Log device error with deduplication (based on error category, not context).
   * First occurrence of a new error category logs as warn, repeats as debug.
   *
   * @param conn Device connection
   * @param context Error context (for debug messages only)
   * @param err Error object
   */
  logDeviceError(conn, context, err) {
    const errorCode = (0, import_connection_utils.classifyError)(err);
    const isRepeat = errorCode === conn.lastErrorCode;
    conn.lastErrorCode = errorCode;
    if (isRepeat) {
      this.log.debug(
        `${conn.config.productName} ${context}: ${err instanceof Error ? err.message : String(err)}`
      );
    } else if (errorCode === "NETWORK") {
      this.log.warn(
        `${conn.config.productName}: device unreachable \u2014 will keep retrying`
      );
    } else {
      this.log.warn(
        `${conn.config.productName} ${context}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new HomeWizard(options);
} else {
  (() => new HomeWizard())();
}
//# sourceMappingURL=main.js.map
