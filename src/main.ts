import * as utils from "@iobroker/adapter-core";
import { HomeWizardDiscovery } from "./lib/discovery";
import { HomeWizardApiError, HomeWizardClient } from "./lib/homewizard-client";
import { StateManager } from "./lib/state-manager";
import type {
  DeviceConfig,
  DeviceConnection,
  DiscoveredDevice,
  Measurement,
} from "./lib/types";
import { HomeWizardWebSocket } from "./lib/websocket-client";

/** Pairing timeout in milliseconds (60 seconds) */
const PAIRING_TIMEOUT_MS = 60_000;
/** Pairing poll interval in milliseconds */
const PAIRING_POLL_MS = 2_000;
/** WebSocket reconnect base delay in milliseconds */
const WS_RECONNECT_BASE_MS = 5_000;
/** Maximum WebSocket reconnect delay in milliseconds */
const WS_RECONNECT_MAX_MS = 300_000;
/** REST fallback poll interval in milliseconds */
const REST_POLL_MS = 10_000;
/** System info poll interval in milliseconds */
const SYSTEM_POLL_MS = 60_000;
/** Max auth failures before giving up */
const MAX_AUTH_FAILURES = 3;
/** WS failures before starting mDNS IP recovery */
const WS_FAILURES_BEFORE_MDNS = 3;
/** mDNS IP recovery timeout in milliseconds */
const IP_RECOVERY_TIMEOUT_MS = 60_000;

class HomeWizard extends utils.Adapter {
  private stateManager!: StateManager;
  private discovery: HomeWizardDiscovery | null = null;
  private readonly connections = new Map<string, DeviceConnection>();
  private pairingTimer: ioBroker.Timeout | undefined = undefined;
  private pairingPollTimer: ioBroker.Interval | undefined = undefined;
  private systemPollTimer: ioBroker.Interval | undefined = undefined;
  private ipRecoveryTimer: ioBroker.Timeout | undefined = undefined;
  private isPairing = false;
  private pairingManualIp = "";
  private discoveredDuringPairing: DiscoveredDevice[] = [];

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "homewizard" });
    this.on("ready", () => this.onReady());
    this.on("stateChange", (id, state) => this.onStateChange(id, state));
    this.on("unload", (callback) => this.onUnload(callback));
  }

  /** Adapter started */
  private async onReady(): Promise<void> {
    this.stateManager = new StateManager(this);

    // Create pairing states
    await this.extendObjectAsync("pairingIp", {
      type: "state",
      common: {
        name: "Device IP for manual pairing",
        type: "string",
        role: "text",
        read: true,
        write: true,
        def: "",
      },
      native: {},
    });

    // Reset pairing states on start (in case previous run was killed mid-pairing)
    await this.setStateAsync("startPairing", { val: false, ack: true });
    await this.setStateAsync("pairingIp", { val: "", ack: true });

    // Subscribe to pairing button and writable device states
    await this.subscribeStatesAsync("startPairing");
    await this.subscribeStatesAsync("*.system.reboot");
    await this.subscribeStatesAsync("*.system.identify");
    await this.subscribeStatesAsync("*.system.cloud_enabled");
    await this.subscribeStatesAsync("*.system.status_led_brightness_pct");
    await this.subscribeStatesAsync("*.system.api_v1_enabled");
    await this.subscribeStatesAsync("*.battery.mode");
    await this.subscribeStatesAsync("*.battery.permissions");
    await this.subscribeStatesAsync("*.remove");

    // Load devices from device objects (not from adapter config)
    const devices = await this.loadDevicesFromObjects();
    if (devices.length === 0) {
      this.log.info(
        "No devices configured — set 'startPairing' to true to add a device",
      );
      await this.setStateAsync("info.connection", { val: false, ack: true });
    }

    // Create connection entries for all configured devices
    for (const device of devices) {
      const key = this.stateManager.devicePrefix(device);
      await this.stateManager.createDeviceStates(device);
      const conn: DeviceConnection = {
        config: device,
        ip: device.ip || "",
        wsClient: null,
        wsAuthenticated: false,
        pollTimer: undefined,
        reconnectTimer: undefined,
        wsFailCount: 0,
        authFailCount: 0,
        lastErrorCode: "",
        ipRecoveryDone: false,
      };
      this.connections.set(key, conn);

      // If we have a stored IP, connect immediately
      if (conn.ip) {
        this.log.debug(`Using stored IP ${conn.ip} for ${device.productName}`);
        void this.initDevice(conn);
      }
    }

    // Periodic system info poll
    this.systemPollTimer = this.setInterval(() => {
      void this.pollAllSystemInfo();
    }, SYSTEM_POLL_MS);

    this.updateGlobalConnection();
  }

  /**
   * Load device configs from existing device objects
   * Tokens are stored encrypted in device object native
   */
  private async loadDevicesFromObjects(): Promise<DeviceConfig[]> {
    const devices: DeviceConfig[] = [];

    // Also migrate from old adapter config if devices exist there
    const oldDevices: DeviceConfig[] =
      ((this.config as Record<string, unknown>).devices as DeviceConfig[]) ||
      [];
    if (oldDevices.length > 0) {
      this.log.debug(
        `Migrating ${oldDevices.length} device(s) from adapter config to device objects`,
      );
      for (const device of oldDevices) {
        await this.saveDeviceToObject(device);
      }
      // Clear old config (this triggers one restart, but only during migration)
      await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
        native: { devices: [] },
      });
      return oldDevices;
    }

    // Read device objects from our namespace
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
      const token = this.decrypt(native.encryptedToken);
      devices.push({
        token,
        productType: native.productType || "unknown",
        serial: native.serial,
        productName: native.productName || native.productType || "unknown",
        ...(native.ip ? { ip: native.ip } : {}),
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
    await this.extendObjectAsync(prefix, {
      type: "device",
      common: { name: config.productName || config.productType },
      native: {
        encryptedToken,
        productType: config.productType,
        serial: config.serial,
        productName: config.productName,
        ...(config.ip ? { ip: config.ip } : {}),
      },
    });
  }

  /**
   * Remove device config from its device object
   *
   * @param config Device configuration to remove
   */
  private async removeDeviceFromObject(config: DeviceConfig): Promise<void> {
    await this.stateManager.removeDevice(config);
  }

  /**
   * Handle a discovered device from mDNS (only active during pairing)
   *
   * @param discovered Discovered device info
   */
  private onDeviceDiscovered(discovered: DiscoveredDevice): void {
    // Skip already paired devices
    const existing = Array.from(this.connections.values()).find(
      (c) => c.config.serial === discovered.serial,
    );
    if (existing) {
      return;
    }

    // Skip duplicates
    if (
      this.discoveredDuringPairing.find((d) => d.serial === discovered.serial)
    ) {
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

    this.discovery?.stop();

    for (const conn of this.connections.values()) {
      conn.wsClient?.close();
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
  private async onStateChange(
    id: string,
    state: ioBroker.State | null | undefined,
  ): Promise<void> {
    if (!state || state.ack) {
      return;
    }

    // Pairing button
    if (id.endsWith(".startPairing")) {
      if (state.val) {
        await this.startPairing();
      }
      return;
    }

    // Remove device button
    if (id.endsWith(".remove")) {
      if (state.val) {
        await this.removeDevice(id);
      }
      return;
    }

    // Find which device this state belongs to
    const conn = this.findConnectionForState(id);
    if (!conn || !conn.ip) {
      return;
    }

    const client = new HomeWizardClient(conn.ip, conn.config.token);

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
          status_led_brightness_pct: Number(state.val),
        });
        await this.setStateAsync(id, { val: state.val, ack: true });
      } else if (id.endsWith(".system.api_v1_enabled")) {
        await client.setSystem({ api_v1_enabled: !!state.val });
        await this.setStateAsync(id, { val: state.val, ack: true });
      } else if (id.endsWith(".battery.mode")) {
        await client.setBatteries({
          mode: String(state.val) as "zero" | "to_full" | "standby",
        });
        await this.setStateAsync(id, { val: state.val, ack: true });
      } else if (id.endsWith(".battery.permissions")) {
        const perms = JSON.parse(String(state.val));
        await client.setBatteries({ permissions: perms });
        await this.setStateAsync(id, { val: state.val, ack: true });
      }
    } catch (err) {
      this.log.warn(
        `Failed to set ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
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

    this.isPairing = true;
    this.discoveredDuringPairing = [];

    // Stop IP recovery if running — pairing takes priority
    this.stopIpRecovery();

    // Check if manual IP is set, then clear pairingIp immediately
    const ipState = await this.getStateAsync("pairingIp");
    this.pairingManualIp = ipState?.val ? String(ipState.val).trim() : "";
    await this.setStateAsync("pairingIp", { val: "", ack: true });

    if (this.pairingManualIp) {
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
        "Pairing mode enabled — searching for devices via mDNS, press the button on your HomeWizard device now (60 seconds timeout)",
      );
      // Restart mDNS browser to trigger fresh query — already-cached devices
      // won't be re-announced otherwise and pairing would never find them
      if (!this.discovery) {
        this.discovery = new HomeWizardDiscovery(this.log);
      }
      this.discovery.start((discovered) => {
        this.onDeviceDiscovered(discovered);
      });
    }

    // Poll discovered devices for pairing
    this.pairingPollTimer = this.setInterval(() => {
      void this.pollPairing();
    }, PAIRING_POLL_MS);

    // Timeout pairing
    this.pairingTimer = this.setTimeout(() => {
      this.stopPairing();
      this.log.info(
        "Pairing mode automatically disabled after 60 seconds timeout",
      );
    }, PAIRING_TIMEOUT_MS);
  }

  /** Poll all discovered devices to attempt pairing */
  private async pollPairing(): Promise<void> {
    for (const device of this.discoveredDuringPairing) {
      try {
        const client = new HomeWizardClient(device.ip);
        const result = await client.requestPairing();

        // Success! Button was pressed
        this.log.info(
          `Successfully paired with ${device.name} (${device.productType}) at ${device.ip} — connecting...`,
        );

        // Get device info
        const authedClient = new HomeWizardClient(device.ip, result.token);
        const info = await authedClient.getDeviceInfo();

        const deviceConfig: DeviceConfig = {
          token: result.token,
          productType: info.product_type,
          serial: info.serial,
          productName: info.product_name,
          ip: device.ip,
        };

        // Save to device object (no adapter restart!)
        await this.saveDeviceToObject(deviceConfig);
        await this.stateManager.createDeviceStates(deviceConfig);

        // Create connection and connect
        const key = this.stateManager.devicePrefix(deviceConfig);
        const conn: DeviceConnection = {
          config: deviceConfig,
          ip: device.ip,
          wsClient: null,
          wsAuthenticated: false,
          pollTimer: undefined,
          reconnectTimer: undefined,
          wsFailCount: 0,
          authFailCount: 0,
          lastErrorCode: "",
          ipRecoveryDone: false,
        };
        this.connections.set(key, conn);
        void this.initDevice(conn);

        // Remove from discovery list
        this.discoveredDuringPairing = this.discoveredDuringPairing.filter(
          (d) => d.serial !== info.serial,
        );

        this.stopPairing();
        this.updateGlobalConnection();
        return;
      } catch (err) {
        // 403 = button not pressed yet — expected, keep polling
        if (err instanceof HomeWizardApiError && err.statusCode === 403) {
          continue;
        }
        this.log.debug(
          `Pairing poll error for ${device.ip}: ${err instanceof Error ? err.message : String(err)}`,
        );
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

    this.log.info("Device unreachable — searching for new IP via mDNS");

    this.discovery = new HomeWizardDiscovery(this.log);
    this.discovery.start((discovered) => {
      // Match against disconnected devices
      for (const conn of this.connections.values()) {
        if (conn.config.serial !== discovered.serial) {
          continue;
        }
        if (discovered.ip === conn.ip || conn.wsAuthenticated) {
          return; // Same IP or already connected
        }

        this.log.info(
          `${conn.config.productName}: found at new IP ${discovered.ip} (was ${conn.ip})`,
        );

        // Update IP and persist
        conn.ip = discovered.ip;
        conn.config.ip = discovered.ip;
        conn.wsFailCount = 0;
        void this.saveDeviceToObject(conn.config);

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

    // Stop after timeout — mark device offline, stop reconnecting
    this.ipRecoveryTimer = this.setTimeout(() => {
      this.ipRecoveryTimer = undefined;
      this.stopIpRecovery();

      // Mark all unreachable devices as offline
      for (const conn of this.connections.values()) {
        if (!conn.wsAuthenticated && conn.wsFailCount > 0) {
          conn.ipRecoveryDone = true;
          // Stop reconnect timer and REST fallback
          if (conn.reconnectTimer) {
            this.clearTimeout(conn.reconnectTimer);
            conn.reconnectTimer = undefined;
          }
          if (conn.pollTimer) {
            this.clearInterval(conn.pollTimer);
            conn.pollTimer = undefined;
          }
          this.log.warn(
            `${conn.config.productName}: device offline — check network or re-pair with new IP`,
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

  /**
   * Initialize a newly discovered device — fetch info and connect WebSocket
   *
   * @param conn Device connection with IP set
   */
  private async initDevice(conn: DeviceConnection): Promise<void> {
    try {
      const client = new HomeWizardClient(conn.ip, conn.config.token);
      const info = await client.getDeviceInfo();
      const key = this.stateManager.devicePrefix(conn.config);
      await this.setStateAsync(`${key}.info.firmware`, {
        val: info.firmware_version,
        ack: true,
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
  private connectWebSocket(conn: DeviceConnection): void {
    if (!conn.ip) {
      return; // No IP yet — wait for mDNS
    }

    // Stop reconnecting if auth keeps failing
    if (conn.authFailCount >= MAX_AUTH_FAILURES) {
      return;
    }

    // After repeated failures, try mDNS once to find a new IP
    if (conn.wsFailCount >= WS_FAILURES_BEFORE_MDNS && !conn.ipRecoveryDone) {
      this.startIpRecovery();
    }

    const key = this.stateManager.devicePrefix(conn.config);

    const wsClient = new HomeWizardWebSocket(conn.ip, conn.config.token, {
      onMeasurement: (data: Measurement) => {
        void this.stateManager.updateMeasurement(conn.config, data);
      },
      onConnected: () => {
        conn.wsAuthenticated = true;
        conn.wsFailCount = 0;
        conn.authFailCount = 0;
        conn.ipRecoveryDone = false;
        void this.stateManager.setDeviceConnected(conn.config, true);
        this.updateGlobalConnection();

        // Stop REST fallback if active
        if (conn.pollTimer) {
          this.clearInterval(conn.pollTimer);
          conn.pollTimer = undefined;
        }

        // Stop IP recovery if all devices are connected
        if (this.discovery && !this.isPairing) {
          const allConnected = Array.from(this.connections.values()).every(
            (c) => c.wsAuthenticated,
          );
          if (allConnected) {
            this.stopIpRecovery();
          }
        }

        // Log restoration if we had errors before
        if (conn.lastErrorCode) {
          this.log.info(`${conn.config.productName}: connection restored`);
          conn.lastErrorCode = "";
        }

        this.log.debug(
          `WebSocket connected to ${conn.config.productName} (${conn.ip})`,
        );
      },
      onDisconnected: (error?: Error) => {
        conn.wsAuthenticated = false;
        conn.wsClient = null;
        void this.stateManager.setDeviceConnected(conn.config, false);
        this.updateGlobalConnection();

        if (error) {
          this.logDeviceError(conn, "ws", error);
        }

        // Check if this was an auth failure
        if (
          error instanceof HomeWizardApiError &&
          error.errorCode === "user:unauthorized"
        ) {
          conn.authFailCount++;
          if (conn.authFailCount >= MAX_AUTH_FAILURES) {
            this.log.warn(
              `${conn.config.productName}: token invalid — re-pair device to fix`,
            );
            return;
          }
        }

        // Start REST fallback
        this.startRestFallback(conn);

        // Schedule reconnect with exponential backoff
        conn.wsFailCount++;
        const delay = Math.min(
          WS_RECONNECT_BASE_MS * Math.pow(2, conn.wsFailCount - 1),
          WS_RECONNECT_MAX_MS,
        );
        this.log.debug(
          `${key}: WS reconnect in ${delay / 1000}s (attempt ${conn.wsFailCount})`,
        );

        conn.reconnectTimer = this.setTimeout(() => {
          conn.reconnectTimer = undefined;
          this.connectWebSocket(conn);
        }, delay);
      },
      log: this.log,
    });

    conn.wsClient = wsClient;
    wsClient.connect();
  }

  /**
   * Start REST polling as fallback when WebSocket is down
   *
   * @param conn Device connection
   */
  private startRestFallback(conn: DeviceConnection): void {
    if (conn.pollTimer || !conn.ip) {
      return;
    }

    const client = new HomeWizardClient(conn.ip, conn.config.token);

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
  private async pollAllSystemInfo(): Promise<void> {
    for (const conn of this.connections.values()) {
      // Only poll devices that have an IP and are connected or at least reachable
      if (conn.ip && (conn.wsAuthenticated || conn.pollTimer)) {
        await this.pollSystemInfo(conn);
      }
    }
  }

  /**
   * Poll system info for a single device
   *
   * @param conn Device connection
   */
  private async pollSystemInfo(conn: DeviceConnection): Promise<void> {
    if (!conn.ip) {
      return;
    }

    try {
      const client = new HomeWizardClient(conn.ip, conn.config.token);
      const system = await client.getSystem();
      await this.stateManager.updateSystem(conn.config, system);

      // Also poll battery if device supports it
      try {
        const battery = await client.getBatteries();
        // Only create battery states if batteries are actually connected
        if (battery.battery_count && battery.battery_count > 0) {
          await this.stateManager.updateBattery(conn.config, battery);
        }
      } catch {
        // Device may not support batteries — that's fine
      }
    } catch (err) {
      this.logDeviceError(conn, "system", err);
    }
  }

  /** Update global info.connection based on all device states */
  private updateGlobalConnection(): void {
    const anyConnected = Array.from(this.connections.values()).some(
      (c) => c.wsAuthenticated,
    );
    void this.setStateAsync("info.connection", {
      val: anyConnected,
      ack: true,
    });
  }

  /**
   * Remove a device — disconnect, delete states and object
   *
   * @param stateId The remove state ID
   */
  private async removeDevice(stateId: string): Promise<void> {
    const conn = this.findConnectionForState(stateId);
    if (!conn) {
      return;
    }

    const key = this.stateManager.devicePrefix(conn.config);
    this.log.info(
      `Removing device ${conn.config.productName} (${conn.config.serial})`,
    );

    // Disconnect
    conn.wsClient?.close();
    if (conn.pollTimer) {
      this.clearInterval(conn.pollTimer);
    }
    if (conn.reconnectTimer) {
      this.clearTimeout(conn.reconnectTimer);
    }
    this.connections.delete(key);

    // Delete device object and all states (no adapter restart!)
    await this.removeDeviceFromObject(conn.config);

    this.updateGlobalConnection();
  }

  /**
   * Find connection for a state ID
   *
   * @param stateId Full state ID
   */
  private findConnectionForState(
    stateId: string,
  ): DeviceConnection | undefined {
    const localId = stateId.replace(`${this.namespace}.`, "");
    for (const conn of this.connections.values()) {
      const prefix = this.stateManager.devicePrefix(conn.config);
      if (localId.startsWith(`${prefix}.`)) {
        return conn;
      }
    }
    return undefined;
  }

  /**
   * Log device error with deduplication
   *
   * @param conn Device connection
   * @param context Error context
   * @param err Error object
   */
  private logDeviceError(
    conn: DeviceConnection,
    context: string,
    err: unknown,
  ): void {
    const code =
      err instanceof HomeWizardApiError
        ? err.errorCode
        : err instanceof Error
          ? err.message
          : "unknown";
    const key = `${context}:${code}`;

    if (conn.lastErrorCode === key) {
      // Same error as last time — debug only
      this.log.debug(
        `${conn.config.productName} (${conn.ip}) ${context}: ${code}`,
      );
    } else {
      conn.lastErrorCode = key;
      this.log.warn(
        `${conn.config.productName} (${conn.ip}) ${context}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) =>
    new HomeWizard(options);
} else {
  (() => new HomeWizard())();
}
