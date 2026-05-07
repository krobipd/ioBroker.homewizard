import * as utils from "@iobroker/adapter-core";
import { errText, parseBatteryPermissions, validateBatteryMode } from "./lib/coerce";
import { classifyError, createDeviceConnection, UNSTABLE_DISCONNECT_THRESHOLD } from "./lib/connection-utils";
import { HomeWizardDiscovery } from "./lib/discovery";
import { HomeWizardApiError, HomeWizardClient } from "./lib/homewizard-client";
import { tLog } from "./lib/i18n-logs";
import {
  computeReconnectDelay,
  decideUnstableTransition,
  findConnectionForState as resolveConnectionForState,
  pickRestPollInterval,
  shouldStartIpRecovery,
} from "./lib/main-helpers";
import { StateManager } from "./lib/state-manager";
import type { DeviceConfig, DeviceConnection, DiscoveredDevice, Measurement } from "./lib/types";
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
/** Retry mDNS every N WS failures after first attempt (~1 hour at 5 min cap) */
const MDNS_RETRY_EVERY = 12;
/** Connection must last this long to count as "stable" */
const STABLE_THRESHOLD_MS = 600_000;
/** Max reconnect delay for unstable devices */
const WS_RECONNECT_MAX_UNSTABLE_MS = 60_000;
/** REST fallback interval for unstable devices (slower, not stopped) */
const REST_POLL_UNSTABLE_MS = 30_000;

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
  private unhandledRejectionHandler: ((reason: unknown) => void) | null = null;
  private uncaughtExceptionHandler: ((err: Error) => void) | null = null;
  /** ioBroker system language — read once in `onReady` from `system.config`. EN fallback. */
  private systemLang: string = "en";

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "homewizard" });
    // Wrap async handlers with .catch() so a rejection can never become an
    // unhandled promise rejection (→ SIGKILL → js-controller restart loop).
    this.on("ready", () => {
      this.onReady().catch((err: unknown) =>
        this.log.error(tLog(this.systemLang, "onReadyFailed", { error: errText(err) })),
      );
    });
    this.on("stateChange", (id, state) => {
      this.onStateChange(id, state).catch((err: unknown) =>
        this.log.error(tLog(this.systemLang, "stateChangeFailed", { error: errText(err) })),
      );
    });
    this.on("unload", callback => this.onUnload(callback));

    // Last-line-of-defence against unhandled rejections / sync throws from
    // fire-and-forget paths. The per-handler wrappers cover documented async
    // paths; this catches anything that slips past during refactors.
    this.unhandledRejectionHandler = (reason: unknown) => {
      this.log.error(tLog(this.systemLang, "unhandledRejection", { error: errText(reason) }));
    };
    this.uncaughtExceptionHandler = (err: Error) => {
      this.log.error(tLog(this.systemLang, "uncaughtException", { error: err.message }));
    };
    process.on("unhandledRejection", this.unhandledRejectionHandler);
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }

  /** Adapter started */
  private async onReady(): Promise<void> {
    // Read ioBroker system language for user-facing logs + state names. EN fallback for unknown values.
    try {
      const sysCfg = await this.getForeignObjectAsync("system.config");
      const lang = sysCfg?.common?.language;
      if (typeof lang === "string" && lang.length > 0) {
        this.systemLang = lang;
      }
    } catch {
      // EN fallback already in place
    }

    this.stateManager = new StateManager(this);

    // `pairingIp` is declared in io-package.json instanceObjects — just reset state.
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
      this.log.info(tLog(this.systemLang, "noDevicesConfigured"));
      await this.setStateAsync("info.connection", { val: false, ack: true });
    }

    // Create connection entries for all configured devices
    for (const device of devices) {
      const key = this.stateManager.devicePrefix(device);
      await this.stateManager.cleanupMovedStates(device);
      await this.stateManager.createDeviceStates(device);
      const conn = createDeviceConnection(device, device.ip || "");
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
    const oldDevices: DeviceConfig[] = ((this.config as Record<string, unknown>).devices as DeviceConfig[]) || [];
    if (oldDevices.length > 0) {
      this.log.debug(`Migrating ${oldDevices.length} device(s) from adapter config to device objects`);
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

    this.discoveredDuringPairing.push(discovered);
    this.log.info(
      tLog(this.systemLang, "deviceFound", {
        name: discovered.name,
        type: discovered.productType,
        ip: discovered.ip,
      }),
    );
  }

  /**
   * Adapter stopping — MUST be synchronous
   *
   * @param callback Completion callback
   */
  private onUnload(callback: () => void): void {
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

      // Detach process-level last-line-of-defence handlers
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
  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
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
        this.log.info(tLog(this.systemLang, "rebootingDevice", { name: conn.config.productName, ip: conn.ip }));
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
        const mode = validateBatteryMode(String(state.val));
        if (!mode) {
          this.log.warn(tLog(this.systemLang, "invalidBatteryMode", { value: String(state.val) }));
          return;
        }
        await client.setBatteries({ mode });
        await this.setStateAsync(id, { val: state.val, ack: true });
      } else if (id.endsWith(".battery.permissions")) {
        const result = parseBatteryPermissions(String(state.val));
        if (!result.ok) {
          this.log.warn(
            tLog(this.systemLang, "invalidPermissionsJson", { error: result.reason, value: result.sample }),
          );
          return;
        }
        await client.setBatteries({ permissions: result.perms });
        await this.setStateAsync(id, { val: state.val, ack: true });
      }
    } catch (err) {
      this.log.warn(tLog(this.systemLang, "failedToSetState", { id, error: errText(err) }));
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
      this.log.info(tLog(this.systemLang, "pairingEnabledManual", { ip: this.pairingManualIp }));
      // Add as discovered device immediately
      this.discoveredDuringPairing.push({
        ip: this.pairingManualIp,
        productType: "unknown",
        serial: "unknown",
        name: this.pairingManualIp,
      });
    } else {
      this.log.info(tLog(this.systemLang, "pairingEnabledMdns"));
      // Restart mDNS browser to trigger fresh query — already-cached devices
      // won't be re-announced otherwise and pairing would never find them
      if (!this.discovery) {
        this.discovery = new HomeWizardDiscovery(this.log);
      }
      this.discovery.start(discovered => {
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
      this.log.info(tLog(this.systemLang, "pairingTimeout"));
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
          tLog(this.systemLang, "pairingSuccess", {
            name: device.name,
            type: device.productType,
            ip: device.ip,
          }),
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
        const conn = createDeviceConnection(deviceConfig, device.ip);
        this.connections.set(key, conn);
        void this.initDevice(conn);

        // Remove from discovery list
        this.discoveredDuringPairing = this.discoveredDuringPairing.filter(d => d.serial !== info.serial);

        this.stopPairing();
        this.updateGlobalConnection();
        return;
      } catch (err) {
        // 403 = button not pressed yet — expected, keep polling
        if (err instanceof HomeWizardApiError && err.statusCode === 403) {
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
    this.log.debug(tLog(this.systemLang, "searchingNewIp"));

    this.discovery = new HomeWizardDiscovery(this.log);
    this.discovery.start(discovered => {
      // Match against disconnected devices
      for (const conn of this.connections.values()) {
        if (conn.config.serial !== discovered.serial) {
          continue;
        }
        if (discovered.ip === conn.ip || conn.wsAuthenticated) {
          return; // Same IP or already connected
        }

        this.log.info(
          tLog(this.systemLang, "foundAtNewIp", {
            name: conn.config.productName,
            newIp: discovered.ip,
            oldIp: conn.ip,
          }),
        );

        // Update IP and persist — reset stability (new network conditions)
        conn.ip = discovered.ip;
        conn.config.ip = discovered.ip;
        conn.wsFailCount = 0;
        conn.recentDisconnects = 0;
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
            tLog(this.systemLang, "deviceOfflineRetrying", {
              name: conn.config.productName,
              seconds: WS_RECONNECT_MAX_MS / 1000,
            }),
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

    // After repeated failures, try mDNS periodically to find a new IP
    if (shouldStartIpRecovery(conn.wsFailCount, WS_FAILURES_BEFORE_MDNS, MDNS_RETRY_EVERY)) {
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
        conn.lastConnectedAt = Date.now();
        void this.stateManager.setDeviceConnected(conn.config, true);
        this.updateGlobalConnection();

        // Stop REST fallback if active
        if (conn.pollTimer) {
          this.clearInterval(conn.pollTimer);
          conn.pollTimer = undefined;
        }

        // Stop IP recovery if all devices are connected
        if (this.discovery && !this.isPairing) {
          const allConnected = Array.from(this.connections.values()).every(c => c.wsAuthenticated);
          if (allConnected) {
            this.stopIpRecovery();
          }
        }

        // Log restoration if we had errors before
        if (conn.lastErrorCode) {
          this.log.info(
            tLog(this.systemLang, this.isUnstable(conn) ? "connectionRestoredUnstable" : "connectionRestored", {
              name: conn.config.productName,
            }),
          );
          conn.lastErrorCode = "";
        }

        this.log.debug(`WebSocket connected to ${conn.config.productName} (${conn.ip})`);
      },
      onDisconnected: (error?: Error) => {
        // Track connection stability — pure decision in main-helpers, side-effects here
        if (conn.lastConnectedAt > 0) {
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
          if (transition === "becameUnstable") {
            this.log.info(tLog(this.systemLang, "unstableDetected", { name: conn.config.productName }));
          } else if (transition === "stabilized") {
            this.log.info(tLog(this.systemLang, "connectionStabilized", { name: conn.config.productName }));
          }
        }

        conn.wsAuthenticated = false;
        conn.wsClient = null;
        void this.stateManager.setDeviceConnected(conn.config, false);
        this.updateGlobalConnection();

        if (error) {
          this.logDeviceError(conn, "ws", error);
        }

        // Check if this was an auth failure (returns false → stop reconnect path)
        if (!this.handleAuthFailure(conn, error, /* cleanupTimers */ false)) {
          return;
        }

        // Start REST fallback
        this.startRestFallback(conn);

        // Schedule reconnect with exponential backoff (faster for unstable devices)
        conn.wsFailCount++;
        const maxDelay = this.isUnstable(conn) ? WS_RECONNECT_MAX_UNSTABLE_MS : WS_RECONNECT_MAX_MS;
        const delay = computeReconnectDelay(conn.wsFailCount, WS_RECONNECT_BASE_MS, maxDelay);
        this.log.debug(`${key}: WS reconnect in ${delay / 1000}s (attempt ${conn.wsFailCount})`);

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
   * Start REST polling as fallback when WebSocket is down.
   * For stable devices: stops on network errors (WS reconnect handles recovery).
   * For unstable devices: slows down instead of stopping to minimize data gaps.
   *
   * @param conn Device connection
   */
  private startRestFallback(conn: DeviceConnection): void {
    if (conn.pollTimer || !conn.ip) {
      return;
    }

    const unstable = this.isUnstable(conn);
    const interval = pickRestPollInterval(unstable, REST_POLL_MS, REST_POLL_UNSTABLE_MS);
    const client = new HomeWizardClient(conn.ip, conn.config.token);

    conn.pollTimer = this.setInterval(async () => {
      try {
        const data = await client.getMeasurement();
        await this.stateManager.updateMeasurement(conn.config, data);
      } catch (err) {
        this.logDeviceError(conn, "rest", err);

        // Auth failures: stop everything — token is bad, re-pair required.
        if (err instanceof HomeWizardApiError && err.errorCode === "user:unauthorized") {
          this.handleAuthFailure(conn, err, /* cleanupTimers */ true);
          return;
        }

        // Stop REST polling on network errors for stable devices.
        // Unstable devices keep polling (slower) to minimize data gaps.
        if (!unstable && classifyError(err) === "NETWORK" && conn.pollTimer) {
          this.clearInterval(conn.pollTimer);
          conn.pollTimer = undefined;
        }
      }
    }, interval);
  }

  /** Poll system info for all connected devices */
  private async pollAllSystemInfo(): Promise<void> {
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
    const anyConnected = Array.from(this.connections.values()).some(c => c.wsAuthenticated);
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
      tLog(this.systemLang, "removingDevice", { name: conn.config.productName, serial: conn.config.serial }),
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
    await this.stateManager.removeDevice(conn.config);

    this.updateGlobalConnection();
  }

  /**
   * Find connection for a state ID. Delegates to the pure helper so the
   * lookup math is unit-tested separately (`lib/main-helpers.test.ts`).
   *
   * @param stateId Full state ID
   */
  private findConnectionForState(stateId: string): DeviceConnection | undefined {
    return resolveConnectionForState(stateId, this.namespace, this.connections);
  }

  /**
   * Whether a device has unstable connectivity (frequent short-lived connections).
   * Unstable devices get faster reconnect and persistent REST fallback.
   *
   * @param conn Device connection
   */
  private isUnstable(conn: DeviceConnection): boolean {
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
  private handleAuthFailure(conn: DeviceConnection, error: unknown, cleanupTimers: boolean): boolean {
    if (!(error instanceof HomeWizardApiError) || error.errorCode !== "user:unauthorized") {
      return true;
    }
    conn.authFailCount++;
    if (conn.authFailCount < MAX_AUTH_FAILURES) {
      return true;
    }
    this.log.warn(tLog(this.systemLang, "tokenInvalid", { name: conn.config.productName }));
    if (cleanupTimers) {
      if (conn.pollTimer) {
        this.clearInterval(conn.pollTimer);
        conn.pollTimer = undefined;
      }
      if (conn.reconnectTimer) {
        this.clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = undefined;
      }
      conn.wsClient?.close();
    }
    return false;
  }

  /**
   * Log device error with deduplication (based on error category, not context).
   * First occurrence of a new error category logs as warn, repeats as debug.
   *
   * @param conn Device connection
   * @param context Error context (for debug messages only)
   * @param err Error object
   */
  private logDeviceError(conn: DeviceConnection, context: string, err: unknown): void {
    const errorCode = classifyError(err);
    const isRepeat = errorCode === conn.lastErrorCode;
    conn.lastErrorCode = errorCode;

    if (isRepeat) {
      this.log.debug(`${conn.config.productName} ${context}: ${errText(err)}`);
    } else if (errorCode === "NETWORK") {
      this.log.warn(tLog(this.systemLang, "deviceUnreachable", { name: conn.config.productName }));
    } else {
      this.log.warn(
        tLog(this.systemLang, "deviceErrorContext", {
          name: conn.config.productName,
          context,
          error: errText(err),
        }),
      );
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HomeWizard(options);
} else {
  (() => new HomeWizard())();
}
