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

class HomeWizard extends utils.Adapter {
  private stateManager!: StateManager;
  private discovery: HomeWizardDiscovery | null = null;
  private readonly connections = new Map<string, DeviceConnection>();
  private pairingTimer: ioBroker.Timeout | undefined = undefined;
  private pairingPollTimer: ioBroker.Interval | undefined = undefined;
  private systemPollTimer: ioBroker.Interval | undefined = undefined;
  private isPairing = false;
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

    // Subscribe to pairing button and writable device states
    await this.subscribeStatesAsync("startPairing");
    await this.subscribeStatesAsync("*.system.reboot");
    await this.subscribeStatesAsync("*.system.identify");
    await this.subscribeStatesAsync("*.system.cloud_enabled");
    await this.subscribeStatesAsync("*.system.status_led_brightness_pct");
    await this.subscribeStatesAsync("*.system.api_v1_enabled");
    await this.subscribeStatesAsync("*.battery.mode");
    await this.subscribeStatesAsync("*.battery.permissions");

    // Connect to all configured devices
    const devices: DeviceConfig[] = this.config.devices || [];
    if (devices.length === 0) {
      this.log.info(
        "No devices configured — press 'Start Pairing' to add a HomeWizard device",
      );
      await this.setStateAsync("info.connection", { val: false, ack: true });
      return;
    }

    this.log.info(`Connecting to ${devices.length} device(s)`);
    for (const device of devices) {
      await this.connectDevice(device);
    }

    // Periodic system info poll
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
  private onUnload(callback: () => void): void {
    // Stop pairing
    if (this.pairingTimer) {
      this.clearTimeout(this.pairingTimer);
    }
    if (this.pairingPollTimer) {
      this.clearInterval(this.pairingPollTimer);
    }
    if (this.systemPollTimer) {
      this.clearInterval(this.systemPollTimer);
    }

    // Stop discovery
    this.discovery?.stop();

    // Close all device connections
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
        this.startPairing();
      }
      return;
    }

    // Find which device this state belongs to
    const device = this.findDeviceForState(id);
    if (!device) {
      return;
    }

    const client = new HomeWizardClient(device.ip, device.token);

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
  private startPairing(): void {
    if (this.isPairing) {
      this.log.debug("Pairing already active");
      return;
    }

    this.isPairing = true;
    this.discoveredDuringPairing = [];
    this.log.info(
      "Pairing mode started — press the button on your HomeWizard device within 60 seconds!",
    );

    // Start mDNS discovery
    this.discovery = new HomeWizardDiscovery(this.log);
    this.discovery.start((device) => {
      // Skip already configured devices
      const existing = (this.config.devices || []).find(
        (d) => d.serial === device.serial,
      );
      if (existing) {
        this.log.debug(`Pairing: ${device.name} already configured, skipping`);
        return;
      }

      // Add to list if not already discovered
      if (
        !this.discoveredDuringPairing.find((d) => d.serial === device.serial)
      ) {
        this.discoveredDuringPairing.push(device);
        this.log.info(
          `Discovered: ${device.name} (${device.productType}) at ${device.ip} — waiting for button press...`,
        );
      }
    });

    // Poll discovered devices for pairing
    this.pairingPollTimer = this.setInterval(() => {
      void this.pollPairing();
    }, PAIRING_POLL_MS);

    // Timeout pairing
    this.pairingTimer = this.setTimeout(() => {
      this.stopPairing();
      this.log.info("Pairing mode timed out");
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
          `Paired with ${device.name} (${device.productType}) at ${device.ip}`,
        );

        // Get device info
        const authedClient = new HomeWizardClient(device.ip, result.token);
        const info = await authedClient.getDeviceInfo();

        const deviceConfig: DeviceConfig = {
          ip: device.ip,
          token: result.token,
          productType: info.product_type,
          serial: info.serial,
          productName: info.product_name,
        };

        // Save to config
        const devices = [...(this.config.devices || []), deviceConfig];
        await this.extendForeignObjectAsync(
          `system.adapter.${this.namespace}`,
          {
            native: { devices },
          },
        );

        // Create states and connect
        await this.stateManager.createDeviceStates(deviceConfig);
        await this.connectDevice(deviceConfig);

        // Remove from discovery list
        this.discoveredDuringPairing = this.discoveredDuringPairing.filter(
          (d) => d.serial !== device.serial,
        );

        this.updateGlobalConnection();
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
    this.discoveredDuringPairing = [];

    if (this.pairingPollTimer) {
      this.clearInterval(this.pairingPollTimer);
      this.pairingPollTimer = undefined;
    }
    if (this.pairingTimer) {
      this.clearTimeout(this.pairingTimer);
      this.pairingTimer = undefined;
    }

    this.discovery?.stop();
    this.discovery = null;

    // Reset pairing button
    void this.setStateAsync("startPairing", { val: false, ack: true });
  }

  /**
   * Connect to a device via WebSocket
   *
   * @param config Device configuration
   */
  private async connectDevice(config: DeviceConfig): Promise<void> {
    const key = `${config.productType}_${config.serial}`;

    // Create states if they don't exist yet
    await this.stateManager.createDeviceStates(config);

    const conn: DeviceConnection = {
      config,
      wsClient: null,
      wsAuthenticated: false,
      pollTimer: undefined,
      reconnectTimer: undefined,
      wsFailCount: 0,
      lastErrorCode: "",
    };
    this.connections.set(key, conn);

    // Get initial device info
    try {
      const client = new HomeWizardClient(config.ip, config.token);
      const info = await client.getDeviceInfo();
      await this.setStateAsync(`${key}.info.firmware`, {
        val: info.firmware_version,
        ack: true,
      });
    } catch (err) {
      this.logDeviceError(conn, "init", err);
    }

    // Start WebSocket connection
    this.connectWebSocket(conn);

    // Fetch initial system info
    void this.pollSystemInfo(conn);
  }

  /**
   * Connect WebSocket for a device
   *
   * @param conn Device connection
   */
  private connectWebSocket(conn: DeviceConnection): void {
    const key = `${conn.config.productType}_${conn.config.serial}`;

    const wsClient = new HomeWizardWebSocket(
      conn.config.ip,
      conn.config.token,
      {
        onMeasurement: (data: Measurement) => {
          void this.stateManager.updateMeasurement(conn.config, data);
        },
        onConnected: () => {
          conn.wsAuthenticated = true;
          conn.wsFailCount = 0;
          conn.lastErrorCode = "";
          void this.stateManager.setDeviceConnected(conn.config, true);
          this.updateGlobalConnection();

          // Stop REST fallback if active
          if (conn.pollTimer) {
            this.clearInterval(conn.pollTimer);
            conn.pollTimer = undefined;
          }

          this.log.debug(
            `WebSocket connected to ${conn.config.productName} (${conn.config.ip})`,
          );
        },
        onDisconnected: (error?: Error) => {
          conn.wsAuthenticated = false;
          void this.stateManager.setDeviceConnected(conn.config, false);
          this.updateGlobalConnection();

          if (error) {
            this.logDeviceError(conn, "ws", error);
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
      },
    );

    conn.wsClient = wsClient;
    wsClient.connect();
  }

  /**
   * Start REST polling as fallback when WebSocket is down
   *
   * @param conn Device connection
   */
  private startRestFallback(conn: DeviceConnection): void {
    if (conn.pollTimer) {
      return; // Already polling
    }

    const client = new HomeWizardClient(conn.config.ip, conn.config.token);

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
      await this.pollSystemInfo(conn);
    }
  }

  /**
   * Poll system info for a single device
   *
   * @param conn Device connection
   */
  private async pollSystemInfo(conn: DeviceConnection): Promise<void> {
    try {
      const client = new HomeWizardClient(conn.config.ip, conn.config.token);
      const system = await client.getSystem();
      await this.stateManager.updateSystem(conn.config, system);

      // Also poll battery if device supports it
      try {
        const battery = await client.getBatteries();
        await this.stateManager.updateBattery(conn.config, battery);
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
   * Find device config for a state ID
   *
   * @param stateId Full state ID
   */
  private findDeviceForState(stateId: string): DeviceConfig | undefined {
    const localId = stateId.replace(`${this.namespace}.`, "");
    for (const conn of this.connections.values()) {
      const prefix = this.stateManager.devicePrefix(conn.config);
      if (localId.startsWith(`${prefix}.`)) {
        return conn.config;
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
        `${conn.config.productName} (${conn.config.ip}) ${context}: ${code}`,
      );
    } else {
      conn.lastErrorCode = key;
      this.log.warn(
        `${conn.config.productName} (${conn.config.ip}) ${context}: ${err instanceof Error ? err.message : String(err)}`,
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
