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
class HomeWizard extends utils.Adapter {
  stateManager;
  discovery = null;
  connections = /* @__PURE__ */ new Map();
  pairingTimer = void 0;
  pairingPollTimer = void 0;
  systemPollTimer = void 0;
  isPairing = false;
  discoveredDuringPairing = [];
  /** @param options Adapter options */
  constructor(options = {}) {
    super({ ...options, name: "homewizard" });
    this.on("ready", () => this.onReady());
    this.on("stateChange", (id, state) => this.onStateChange(id, state));
    this.on("unload", (callback) => this.onUnload(callback));
  }
  /** Adapter started */
  async onReady() {
    this.stateManager = new import_state_manager.StateManager(this);
    await this.subscribeStatesAsync("startPairing");
    await this.subscribeStatesAsync("*.system.reboot");
    await this.subscribeStatesAsync("*.system.identify");
    await this.subscribeStatesAsync("*.system.cloud_enabled");
    await this.subscribeStatesAsync("*.system.status_led_brightness_pct");
    await this.subscribeStatesAsync("*.system.api_v1_enabled");
    await this.subscribeStatesAsync("*.battery.mode");
    await this.subscribeStatesAsync("*.battery.permissions");
    const devices = this.config.devices || [];
    if (devices.length === 0) {
      this.log.info(
        "No devices configured \u2014 press 'Start Pairing' to add a HomeWizard device"
      );
      await this.setStateAsync("info.connection", { val: false, ack: true });
      return;
    }
    this.log.info(`Connecting to ${devices.length} device(s)`);
    for (const device of devices) {
      await this.connectDevice(device);
    }
    this.systemPollTimer = this.setInterval(() => {
      void this.pollAllSystemInfo();
    }, SYSTEM_POLL_MS);
    this.updateGlobalConnection();
  }
  /**
   * Adapter stopping — MUST be synchronous
   *
   * @param callback Completion callback
   */
  onUnload(callback) {
    var _a, _b;
    if (this.pairingTimer) {
      this.clearTimeout(this.pairingTimer);
    }
    if (this.pairingPollTimer) {
      this.clearInterval(this.pairingPollTimer);
    }
    if (this.systemPollTimer) {
      this.clearInterval(this.systemPollTimer);
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
    void this.setState("info.connection", { val: false, ack: true });
    callback();
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
        this.startPairing();
      }
      return;
    }
    const device = this.findDeviceForState(id);
    if (!device) {
      return;
    }
    const client = new import_homewizard_client.HomeWizardClient(device.ip, device.token);
    try {
      if (id.endsWith(".system.reboot")) {
        this.log.info(`Rebooting ${device.productName} (${device.ip})`);
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
  startPairing() {
    if (this.isPairing) {
      this.log.debug("Pairing already active");
      return;
    }
    this.isPairing = true;
    this.discoveredDuringPairing = [];
    this.log.info(
      "Pairing mode started \u2014 press the button on your HomeWizard device within 60 seconds!"
    );
    this.discovery = new import_discovery.HomeWizardDiscovery(this.log);
    this.discovery.start((device) => {
      const existing = (this.config.devices || []).find(
        (d) => d.serial === device.serial
      );
      if (existing) {
        this.log.debug(`Pairing: ${device.name} already configured, skipping`);
        return;
      }
      if (!this.discoveredDuringPairing.find((d) => d.serial === device.serial)) {
        this.discoveredDuringPairing.push(device);
        this.log.info(
          `Discovered: ${device.name} (${device.productType}) at ${device.ip} \u2014 waiting for button press...`
        );
      }
    });
    this.pairingPollTimer = this.setInterval(() => {
      void this.pollPairing();
    }, PAIRING_POLL_MS);
    this.pairingTimer = this.setTimeout(() => {
      this.stopPairing();
      this.log.info("Pairing mode timed out");
    }, PAIRING_TIMEOUT_MS);
  }
  /** Poll all discovered devices to attempt pairing */
  async pollPairing() {
    for (const device of this.discoveredDuringPairing) {
      try {
        const client = new import_homewizard_client.HomeWizardClient(device.ip);
        const result = await client.requestPairing();
        this.log.info(
          `Paired with ${device.name} (${device.productType}) at ${device.ip}`
        );
        const authedClient = new import_homewizard_client.HomeWizardClient(device.ip, result.token);
        const info = await authedClient.getDeviceInfo();
        const deviceConfig = {
          ip: device.ip,
          token: result.token,
          productType: info.product_type,
          serial: info.serial,
          productName: info.product_name
        };
        const devices = [...this.config.devices || [], deviceConfig];
        await this.extendForeignObjectAsync(
          `system.adapter.${this.namespace}`,
          {
            native: { devices }
          }
        );
        await this.stateManager.createDeviceStates(deviceConfig);
        await this.connectDevice(deviceConfig);
        this.discoveredDuringPairing = this.discoveredDuringPairing.filter(
          (d) => d.serial !== device.serial
        );
        this.updateGlobalConnection();
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
    var _a;
    this.isPairing = false;
    this.discoveredDuringPairing = [];
    if (this.pairingPollTimer) {
      this.clearInterval(this.pairingPollTimer);
      this.pairingPollTimer = void 0;
    }
    if (this.pairingTimer) {
      this.clearTimeout(this.pairingTimer);
      this.pairingTimer = void 0;
    }
    (_a = this.discovery) == null ? void 0 : _a.stop();
    this.discovery = null;
    void this.setStateAsync("startPairing", { val: false, ack: true });
  }
  /**
   * Connect to a device via WebSocket
   *
   * @param config Device configuration
   */
  async connectDevice(config) {
    const key = `${config.productType}_${config.serial}`;
    await this.stateManager.createDeviceStates(config);
    const conn = {
      config,
      wsClient: null,
      wsAuthenticated: false,
      pollTimer: void 0,
      reconnectTimer: void 0,
      wsFailCount: 0,
      lastErrorCode: ""
    };
    this.connections.set(key, conn);
    try {
      const client = new import_homewizard_client.HomeWizardClient(config.ip, config.token);
      const info = await client.getDeviceInfo();
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
    const key = `${conn.config.productType}_${conn.config.serial}`;
    const wsClient = new import_websocket_client.HomeWizardWebSocket(
      conn.config.ip,
      conn.config.token,
      {
        onMeasurement: (data) => {
          void this.stateManager.updateMeasurement(conn.config, data);
        },
        onConnected: () => {
          conn.wsAuthenticated = true;
          conn.wsFailCount = 0;
          conn.lastErrorCode = "";
          void this.stateManager.setDeviceConnected(conn.config, true);
          this.updateGlobalConnection();
          if (conn.pollTimer) {
            this.clearInterval(conn.pollTimer);
            conn.pollTimer = void 0;
          }
          this.log.debug(
            `WebSocket connected to ${conn.config.productName} (${conn.config.ip})`
          );
        },
        onDisconnected: (error) => {
          conn.wsAuthenticated = false;
          void this.stateManager.setDeviceConnected(conn.config, false);
          this.updateGlobalConnection();
          if (error) {
            this.logDeviceError(conn, "ws", error);
          }
          this.startRestFallback(conn);
          conn.wsFailCount++;
          const delay = Math.min(
            WS_RECONNECT_BASE_MS * Math.pow(2, conn.wsFailCount - 1),
            WS_RECONNECT_MAX_MS
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
      }
    );
    wsClient.connect();
  }
  /**
   * Start REST polling as fallback when WebSocket is down
   *
   * @param conn Device connection
   */
  startRestFallback(conn) {
    if (conn.pollTimer) {
      return;
    }
    const client = new import_homewizard_client.HomeWizardClient(conn.config.ip, conn.config.token);
    conn.pollTimer = this.setInterval(async () => {
      try {
        const data = await client.getMeasurement();
        await this.stateManager.updateMeasurement(conn.config, data);
        await this.stateManager.setDeviceConnected(conn.config, true);
      } catch (err) {
        this.logDeviceError(conn, "rest", err);
        await this.stateManager.setDeviceConnected(conn.config, false);
      }
      this.updateGlobalConnection();
    }, REST_POLL_MS);
  }
  /** Poll system info for all connected devices */
  async pollAllSystemInfo() {
    for (const conn of this.connections.values()) {
      await this.pollSystemInfo(conn);
    }
  }
  /**
   * Poll system info for a single device
   *
   * @param conn Device connection
   */
  async pollSystemInfo(conn) {
    try {
      const client = new import_homewizard_client.HomeWizardClient(conn.config.ip, conn.config.token);
      const system = await client.getSystem();
      await this.stateManager.updateSystem(conn.config, system);
      try {
        const battery = await client.getBatteries();
        await this.stateManager.updateBattery(conn.config, battery);
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
   * Find device config for a state ID
   *
   * @param stateId Full state ID
   */
  findDeviceForState(stateId) {
    const localId = stateId.replace(`${this.namespace}.`, "");
    for (const conn of this.connections.values()) {
      const prefix = this.stateManager.devicePrefix(conn.config);
      if (localId.startsWith(`${prefix}.`)) {
        return conn.config;
      }
    }
    return void 0;
  }
  /**
   * Log device error with deduplication
   *
   * @param conn Device connection
   * @param context Error context
   * @param err Error object
   */
  logDeviceError(conn, context, err) {
    const code = err instanceof import_homewizard_client.HomeWizardApiError ? err.errorCode : err instanceof Error ? err.message : "unknown";
    const key = `${context}:${code}`;
    if (conn.lastErrorCode === key) {
      this.log.debug(
        `${conn.config.productName} (${conn.config.ip}) ${context}: ${code}`
      );
    } else {
      conn.lastErrorCode = key;
      this.log.warn(
        `${conn.config.productName} (${conn.config.ip}) ${context}: ${err instanceof Error ? err.message : String(err)}`
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
