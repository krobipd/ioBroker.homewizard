import * as utils from "@iobroker/adapter-core";
import { errText, isValidIpv4, parseBatteryPermissions, validateBatteryMode } from "./lib/coerce";
import { classifyError, createDeviceConnection, UNSTABLE_DISCONNECT_THRESHOLD } from "./lib/connection-utils";
import { HomeWizardDiscovery } from "./lib/discovery";
import { HomeWizardApiError, HomeWizardClient } from "./lib/homewizard-client";
import {
  computeReconnectDelay,
  decideUnstableTransition,
  findConnectionForState as resolveConnectionForState,
  pickRestPollInterval,
  shouldEmitAfterCooldown,
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

class HomeWizard extends utils.Adapter {
  private stateManager!: StateManager;
  private discovery: HomeWizardDiscovery | null = null;
  private readonly connections = new Map<string, DeviceConnection>();
  /**
   * Per-device last-warn timestamp for chronic-bouncing cooldown. Key =
   * `conn.config.serial` (kategorienübergreifend). The classifyError-based
   * `lastErrorCode`-Dedup in {@link logDeviceError} resets on every recovery,
   * so on chronic bouncing a new disconnect counts as "first occurrence"
   * → wieder warn. This cooldown stamp persists across recoveries so the user
   * sees max one warn per WARN_COOLDOWN_MS per device.
   */
  private readonly lastWarnAt = new Map<string, number>();
  /** Per-device last-info timestamp for `connection restored`. Analog cooldown. */
  private readonly lastInfoAt = new Map<string, number>();
  private pairingTimer: ioBroker.Timeout | undefined = undefined;
  private pairingPollTimer: ioBroker.Interval | undefined = undefined;
  private systemPollTimer: ioBroker.Interval | undefined = undefined;
  private ipRecoveryTimer: ioBroker.Timeout | undefined = undefined;
  private isPairing = false;
  private pairingManualIp = "";
  private discoveredDuringPairing: DiscoveredDevice[] = [];
  private unhandledRejectionHandler: ((reason: unknown) => void) | null = null;
  private uncaughtExceptionHandler: ((err: Error) => void) | null = null;
  /** Set during onUnload — async paths bail before further setStateAsync calls. */
  private unloading = false;

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "homewizard" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    // Safety net for fire-and-forget paths (e.g. `void this.initDevice()`).
    this.unhandledRejectionHandler = (reason: unknown) => {
      this.log.error(`Unhandled rejection: ${errText(reason)}`);
    };
    this.uncaughtExceptionHandler = (err: Error) => {
      this.log.error(`Uncaught exception: ${err.message}`);
    };
    process.on("unhandledRejection", this.unhandledRejectionHandler);
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }

  private async onReady(): Promise<void> {
    try {
      this.stateManager = new StateManager(this);

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
        this.log.info(`No devices configured — set 'startPairing' to true to add a device`);
        await this.setStateAsync("info.connection", { val: false, ack: true });
      }

      for (const device of devices) {
        const key = this.stateManager.devicePrefix(device);
        await this.stateManager.cleanupMovedStates(device);
        await this.stateManager.createDeviceStates(device);
        const conn = createDeviceConnection(device, device.ip || "");
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

    // Also migrate from old adapter config if devices exist there.
    // Defensive: native.devices could be a non-array if a previous version
    // wrote a different shape, or if the user edited it manually.
    const rawOldDevices = (this.config as Record<string, unknown>).devices;
    const oldDevices: DeviceConfig[] = Array.isArray(rawOldDevices) ? (rawOldDevices as DeviceConfig[]) : [];
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

      const conn = this.findConnectionForState(id);
      if (!conn || !conn.ip) {
        return;
      }

      const client = new HomeWizardClient(conn.ip, conn.config.token, { log: this.log });

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
          const mode = validateBatteryMode(String(state.val));
          if (!mode) {
            this.log.warn(
              `Invalid battery.mode value: '${String(state.val)}' — expected one of: zero, to_full, standby`,
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

    this.isPairing = true;
    this.discoveredDuringPairing = [];

    // Stop IP recovery if running — pairing takes priority
    this.stopIpRecovery();

    // Check if manual IP is set, then clear pairingIp immediately
    const ipState = await this.getStateAsync("pairingIp");
    this.pairingManualIp = ipState?.val ? String(ipState.val).trim() : "";
    await this.setStateAsync("pairingIp", { val: "", ack: true });

    if (this.pairingManualIp) {
      // Validate manual-IP up front — better to fail fast than wait 60s while
      // requestPairing keeps timing out against a malformed input.
      if (!isValidIpv4(this.pairingManualIp)) {
        this.log.warn(`Invalid pairing IP '${this.pairingManualIp}' — expected IPv4 (e.g. 192.168.1.42)`);
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
      this.log.info(`Pairing mode automatically disabled after 60 seconds timeout`);
    }, PAIRING_TIMEOUT_MS);
  }

  /** Poll all discovered devices to attempt pairing */
  private async pollPairing(): Promise<void> {
    for (const device of this.discoveredDuringPairing) {
      try {
        const client = new HomeWizardClient(device.ip, "", { log: this.log });
        const result = await client.requestPairing();

        // Success! Button was pressed
        this.log.info(
          `Successfully paired with ${device.name} (${device.productType}) at ${device.ip} — connecting...`,
        );

        // Get device info
        const authedClient = new HomeWizardClient(device.ip, result.token, { log: this.log });
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

        // Re-pair of an existing device (e.g. after factory reset): close the
        // old connection's wsClient + timers before overwriting the map entry,
        // otherwise the old WS keeps running as a zombie until restart.
        const key = this.stateManager.devicePrefix(deviceConfig);
        const previous = this.connections.get(key);
        if (previous) {
          this.log.debug(`Re-pair: closing previous connection for ${deviceConfig.productName}`);
          previous.wsClient?.close();
          if (previous.pollTimer) {
            this.clearInterval(previous.pollTimer);
          }
          if (previous.reconnectTimer) {
            this.clearTimeout(previous.reconnectTimer);
          }
        }

        // Create connection and connect
        const conn = createDeviceConnection(deviceConfig, device.ip);
        this.connections.set(key, conn);
        void this.initDevice(conn);

        // Remove from discovery list — but keep pairing window open so the
        // user can button-press additional devices in the same session.
        this.discoveredDuringPairing = this.discoveredDuringPairing.filter(d => d.serial !== info.serial);

        this.updateGlobalConnection();
        // Do NOT call stopPairing() here — pairingTimer (60 s) closes the
        // window naturally; meanwhile the user can pair more devices.
        continue;
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
    this.log.debug(`Device unreachable — searching for new IP via mDNS`);

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

  /**
   * Initialize a newly discovered device — fetch info and connect WebSocket
   *
   * @param conn Device connection with IP set
   */
  private async initDevice(conn: DeviceConnection): Promise<void> {
    if (this.unloading || conn.removed) {
      return;
    }
    try {
      const client = new HomeWizardClient(conn.ip, conn.config.token, { log: this.log });
      const info = await client.getDeviceInfo();
      if (this.unloading || conn.removed) {
        return;
      }
      const key = this.stateManager.devicePrefix(conn.config);
      await this.setStateAsync(`${key}.info.firmware`, {
        val: info.firmware_version,
        ack: true,
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
  private connectWebSocket(conn: DeviceConnection): void {
    if (!conn.ip) {
      return; // No IP yet — wait for mDNS
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
      this.startIpRecovery();
    }

    const key = this.stateManager.devicePrefix(conn.config);

    const wsClient = new HomeWizardWebSocket(conn.ip, conn.config.token, {
      onMeasurement: (data: Measurement) => {
        // Skip updates for devices removed mid-flight (frame can race
        // delObjectAsync), and for adapter teardown.
        if (conn.removed || this.unloading) {
          return;
        }
        // Defensive .catch — Promise.all writes inside updateMeasurement may
        // reject on transient Redis hiccups; we want a debug-log, not an
        // unhandled rejection that bubbles to the process-level handler.
        this.stateManager.updateMeasurement(conn.config, data).catch((err: unknown) => {
          this.log.debug(`updateMeasurement failed for ${conn.config.productName}: ${errText(err)}`);
        });
      },
      onConnected: () => {
        conn.wsAuthenticated = true;
        conn.wsFailCount = 0;
        conn.authFailCount = 0;
        conn.lastConnectedAt = Date.now();
        conn.recovering = false;
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

        // Log restoration if we had errors before. Per-device cooldown
        // (analog to logDeviceError) so chronic bouncing doesn't emit one
        // info per cycle — bouncing hardware is one phenomenon and one
        // restoration-info per hour is enough. Repeats go to debug.
        if (conn.lastErrorCode) {
          const now = Date.now();
          const lastInfo = this.lastInfoAt.get(conn.config.serial) ?? 0;
          const msg = this.isUnstable(conn)
            ? `${conn.config.productName}: connection restored (unstable mode)`
            : `${conn.config.productName}: connection restored`;
          if (shouldEmitAfterCooldown(lastInfo, now, INFO_COOLDOWN_MS)) {
            this.lastInfoAt.set(conn.config.serial, now);
            this.log.info(msg);
          } else {
            this.log.debug(`${msg} (cooldown)`);
          }
          conn.lastErrorCode = "";
        }

        this.log.debug(`WebSocket connected to ${conn.config.productName} (${conn.ip})`);
      },
      onDisconnected: (error?: Error) => {
        // Auth failures are not a connectivity-stability signal — they mean
        // the token is bad, not the WiFi. Counting them as short connections
        // would flip the device into unstable mode (faster reconnect spam,
        // misleading "unstable" log) on what is purely an auth issue.
        const isAuthError = error instanceof HomeWizardApiError && error.errorCode === "user:unauthorized";

        // Track connection stability — pure decision in main-helpers, side-effects here
        if (conn.lastConnectedAt > 0 && !isAuthError) {
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
          // Hysterese-transitions are internal reconnect-strategy adjustments,
          // not user-actionable events. Per the geschärfte mcm-Linie
          // (reference_iobroker_logging_levels HART-block): diagnostische
          // Prefixe / interne Hysterese-State gehören auf debug, nicht info.
          if (transition === "becameUnstable") {
            this.log.debug(`${conn.config.productName}: unstable connection detected — using faster reconnect`);
          } else if (transition === "stabilized") {
            this.log.debug(`${conn.config.productName}: connection stabilized — using normal reconnect`);
          }
        }

        conn.wsAuthenticated = false;
        conn.wsClient = null;
        conn.recovering = false;
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
    const client = new HomeWizardClient(conn.ip, conn.config.token, { log: this.log });

    conn.pollTimer = this.setInterval(async () => {
      // Bail out if device was removed or adapter is shutting down — the
      // setStateAsync chain inside updateMeasurement would otherwise either
      // recreate deleted objects or hit a torn-down adapter.
      if (conn.removed || this.unloading) {
        return;
      }
      try {
        const data = await client.getMeasurement();
        if (conn.removed || this.unloading) {
          return;
        }
        await this.stateManager.updateMeasurement(conn.config, data);
      } catch (err) {
        if (this.unloading) {
          return;
        }
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

  /** Poll system info for all connected devices in parallel */
  private async pollAllSystemInfo(): Promise<void> {
    if (this.unloading) {
      return;
    }
    const tasks = Array.from(this.connections.values())
      .filter(c => c.ip && c.wsAuthenticated && !c.removed)
      .map(c => this.pollSystemInfo(c));
    await Promise.all(tasks);
  }

  /**
   * Poll system info for a single device
   *
   * @param conn Device connection
   */
  private async pollSystemInfo(conn: DeviceConnection): Promise<void> {
    if (!conn.ip || conn.removed || this.unloading) {
      return;
    }

    try {
      const client = new HomeWizardClient(conn.ip, conn.config.token, { log: this.log });
      const system = await client.getSystem();
      if (conn.removed || this.unloading) {
        return;
      }
      await this.stateManager.updateSystem(conn.config, system);

      // Sync productName drift: if the user renamed the device in the
      // HomeWizard app (or a firmware update changed the product_name), pick
      // up the new value once per system-poll instead of staying stale until
      // re-pair. Cheap — only writes on actual change.
      try {
        const info = await client.getDeviceInfo();
        if (!conn.removed && !this.unloading && info.product_name && info.product_name !== conn.config.productName) {
          this.log.info(`${conn.config.productName}: name changed to '${info.product_name}' — updating object`);
          conn.config.productName = info.product_name;
          await this.saveDeviceToObject(conn.config);
        }
      } catch {
        // device-info is best-effort here; the system-poll log already
        // surfaces real connectivity issues.
      }

      // Also poll battery if device supports it. 404 = no battery — silent.
      // Other errors (500, timeout, malformed body) used to be swallowed
      // entirely; now they surface at debug so post-mortem diagnosis is
      // possible without losing any normal-flow logging.
      if (conn.removed || this.unloading) {
        return;
      }
      try {
        const battery = await client.getBatteries();
        if (conn.removed || this.unloading) {
          return;
        }
        // Only create battery states if batteries are actually connected
        if (battery.battery_count && battery.battery_count > 0) {
          await this.stateManager.updateBattery(conn.config, battery);
        }
      } catch (err) {
        if (err instanceof HomeWizardApiError && err.statusCode === 404) {
          return; // device doesn't support batteries — expected
        }
        this.log.debug(`${conn.config.productName} batteries: ${errText(err)}`);
      }
    } catch (err) {
      if (this.unloading) {
        return;
      }
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
    this.log.info(`Removing device ${conn.config.productName} (${conn.config.serial})`);

    // Mark as removed FIRST — async tasks (in-flight WS frames, REST polls,
    // outstanding pollSystemInfo) check this flag after each await and bail
    // out before recreating just-deleted objects via setStateAsync.
    conn.removed = true;

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
    this.log.warn(`${conn.config.productName}: token invalid — re-pair device to fix`);
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
  private logDeviceError(conn: DeviceConnection, context: string, err: unknown): void {
    const errorCode = classifyError(err);
    const isRepeat = errorCode === conn.lastErrorCode;
    conn.lastErrorCode = errorCode;

    if (isRepeat) {
      this.log.debug(`${conn.config.productName} ${context}: ${errText(err)}`);
      return;
    }

    // New category — apply per-device cooldown so chronic bouncing doesn't
    // emit warn at every cycle just because each cycle's first failure is
    // a fresh `lastErrorCode`.
    const now = Date.now();
    const lastWarn = this.lastWarnAt.get(conn.config.serial) ?? 0;
    if (!shouldEmitAfterCooldown(lastWarn, now, WARN_COOLDOWN_MS)) {
      this.log.debug(`${conn.config.productName} ${context} (cooldown): ${errText(err)}`);
      return;
    }

    this.lastWarnAt.set(conn.config.serial, now);
    if (errorCode === "NETWORK") {
      this.log.warn(`${conn.config.productName}: device unreachable — will keep retrying`);
    } else {
      this.log.warn(`${conn.config.productName} ${context}: ${errText(err)}`);
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HomeWizard(options);
} else {
  (() => new HomeWizard())();
}
