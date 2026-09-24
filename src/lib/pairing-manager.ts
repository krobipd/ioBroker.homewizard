import type * as utils from "@iobroker/adapter-core";
import { errText, isAssignableDeviceIpv4, sanitizeForLog } from "./coerce";
import { HomeWizardApiError, type HomeWizardClient } from "./homewizard-client";
import type { StateManager } from "./state-manager";
import type { DeviceConfig, DiscoveredDevice } from "./types";

/** Pairing timeout in milliseconds (60 seconds) */
const PAIRING_TIMEOUT_MS = 60_000;
/** Pairing poll interval in milliseconds */
const PAIRING_POLL_MS = 2_000;
/**
 * Cap for the discovery list — a flood of spoofed mDNS announcements (unique
 * serials defeat the dedup) could otherwise grow it unbounded for the whole
 * 60 s window.
 */
const MAX_DISCOVERED = 50;

/**
 * What the {@link PairingManager} needs from the adapter. Everything is called
 * lazily, never captured, so the unit-test seams (`makeClient`, `stateManager`)
 * that are replaced AFTER construction still take effect.
 *
 * The mDNS browser is deliberately NOT in here as an object: main owns the single
 * browser because IP recovery shares it, and hands out start/stop instead.
 */
export interface PairingManagerHost {
  /** The state manager (built in onReady; resolved lazily so the test seam propagates). */
  getStateManager(): StateManager;
  /**
   * REST client factory (test seam).
   *
   * @param ip    Device IP.
   * @param token Bearer token — empty while pairing.
   */
  makeClient(ip: string, token: string): HomeWizardClient;
  /**
   * (Re)start the mDNS browser. Main owns it and shares it with IP recovery; its
   * announcements reach {@link PairingManager.onDeviceDiscovered} through main,
   * which already filtered out devices that are paired and healthy.
   */
  startDiscovery(): void;
  /** Release the mDNS browser — main keeps it while IP recovery still needs it. */
  stopDiscovery(): void;
  /** True once the adapter is shutting down — a running poll pass stops there. */
  isUnloading(): boolean;
  /**
   * Persist a device config to its device object.
   *
   * @param config The device configuration.
   */
  saveDeviceToObject(config: DeviceConfig): Promise<void>;
  /**
   * Take a freshly paired device into operation: replace any previous connection
   * for the same device, register it and start connecting.
   *
   * @param config The device configuration.
   * @param ip     The address it was reached at.
   */
  adoptPairedDevice(config: DeviceConfig, ip: string): void;
  /**
   * Put a momentary button back to `false, ack:true`.
   *
   * @param id Full state ID.
   */
  resetButton(id: string): Promise<void>;
}

/**
 * Owns the pairing window: the 60-second timer, the discovery queue, the 2-second
 * poll that asks every queued device for a token, and everything that happens when
 * one answers.
 *
 * Split out of `main.ts` — it is a self-contained episode with its own state
 * (window open? which candidates? which poll is in flight?) that only starts when
 * a user presses a button. Lifecycle, persistence and the mDNS browser stay in
 * main; the two sides talk over {@link PairingManagerHost}.
 */
export class PairingManager {
  private readonly adapter: utils.AdapterInstance;
  private readonly host: PairingManagerHost;

  private pairingTimer: ioBroker.Timeout | undefined = undefined;
  private pollTimer: ioBroker.Interval | undefined = undefined;
  private pairing = false;
  /**
   * In-flight guard for {@link poll}: the poll runs every 2 s, but a single
   * device's requestPairing can hang up to the 10 s HTTP timeout — without the
   * guard, overlapping polls would fire concurrent POST /api/user against the
   * same device.
   */
  private pollBusy = false;
  private manualIp = "";
  private discovered: DiscoveredDevice[] = [];
  /**
   * Addresses that already produced a warning in THIS window. Everything except the
   * expected 403 ("button not pressed yet") is worth one line — a mistyped manual IP,
   * a device that only speaks API v1, a full user store — but the poll repeats every
   * 2 s for 60 s, so only the first one per device is a warning.
   */
  private warnedIps = new Set<string>();
  /** Paired devices already named as "already paired" in THIS window — one line each. */
  private notedPaired = new Set<string>();
  /** Devices found (mDNS or the manual address) in THIS window — for the closing line. */
  private foundInWindow = 0;
  /** Devices paired in THIS window — for the closing line. */
  private pairedInWindow = 0;

  /**
   * @param adapter The ioBroker adapter instance (timers, state writes, log).
   * @param host    Collaborators owned by main (see {@link PairingManagerHost}).
   */
  constructor(adapter: utils.AdapterInstance, host: PairingManagerHost) {
    this.adapter = adapter;
    this.host = host;
  }

  /** Whether the pairing window is currently open — IP recovery must not run then. */
  get active(): boolean {
    return this.pairing;
  }

  /** Start pairing mode — discover devices and attempt to pair. */
  async start(): Promise<void> {
    if (this.pairing) {
      this.adapter.log.debug("Pairing already active");
      // Put the button back anyway — the pairing window IS open, so pressing it a
      // second time is not an error, but leaving it at `true, ack:false` makes it
      // look stuck until the next successful pairing start resets it (DD25).
      await this.host.resetButton("startPairing");
      return;
    }

    // The flag goes up BEFORE the first await: a second press arriving while the
    // state writes below are pending must hit the guard above, not open a second
    // window with its own timers.
    this.pairing = true;
    this.discovered = [];
    this.foundInWindow = 0;
    this.pairedInWindow = 0;
    try {
      await this.openWindow();
    } catch (err: unknown) {
      // Without this the flag stayed up with no timer to take it down again: every
      // later press answered "already active" until the adapter restarted.
      this.adapter.log.warn(`Pairing could not start: ${errText(err)}`);
      this.stop();
    }
  }

  /** The part of {@link start} after the guard: read the address, start the search and the timers. */
  private async openWindow(): Promise<void> {
    // Reset startPairing immediately so it doesn't survive a restart
    await this.adapter.setState("startPairing", { val: false, ack: true });

    // Check if manual IP is set, then clear pairingIp immediately
    const ipState = await this.adapter.getStateAsync("pairingIp");
    this.manualIp = ipState?.val ? String(ipState.val).trim() : "";
    await this.adapter.setState("pairingIp", { val: "", ack: true });

    if (this.manualIp) {
      // Validate manual-IP up front — better to fail fast than wait 60s while
      // requestPairing keeps timing out against a malformed input.
      if (!isAssignableDeviceIpv4(this.manualIp)) {
        this.adapter.log.warn(
          `Invalid pairing IP '${this.manualIp}' — expected a LAN IPv4 (e.g. 192.168.1.42), ` +
            `not loopback/link-local/broadcast`,
        );
        this.pairing = false;
        this.manualIp = "";
        return;
      }
      this.adapter.log.info(
        `Pairing mode enabled for ${this.manualIp} — press the button on your HomeWizard device now (60 seconds timeout)`,
      );
      // Add as discovered device immediately
      this.discovered.push({
        ip: this.manualIp,
        productType: "unknown",
        serial: "unknown",
        name: this.manualIp,
      });
      this.foundInWindow++;
    } else {
      this.adapter.log.info(
        `Pairing mode enabled — searching for devices via mDNS, press the button on your HomeWizard device now (60 seconds timeout)`,
      );
      // Restart the shared mDNS browser for a fresh query — a device announced in an
      // earlier run is not reported again otherwise and pairing would never find it.
      // IP recovery keeps running on the same browser (I9 used to stop it here).
      this.host.startDiscovery();
    }

    // Poll discovered devices for pairing
    this.pollTimer = this.adapter.setInterval(() => {
      this.poll().catch((err: unknown) => this.adapter.log.debug(`pollPairing failed: ${errText(err)}`));
    }, PAIRING_POLL_MS);

    // Timeout pairing — the window announced a search, so it closes with its result.
    this.pairingTimer = this.adapter.setTimeout(() => {
      const found = this.foundInWindow;
      const paired = this.pairedInWindow;
      const manual = this.manualIp !== "";
      this.stop();
      if (paired > 0) {
        this.adapter.log.info(`Pairing window closed — ${paired} device(s) paired`);
      } else if (found === 0 && !manual) {
        this.adapter.log.info(
          `Pairing window closed — no HomeWizard device found via mDNS; set 'pairingIp' to pair one by its address`,
        );
      } else {
        this.adapter.log.info(
          `Pairing window closed — no device was paired; press the device's button within the 60 seconds ` +
            `(on a kWh Meter, hold it for 1–3 seconds)`,
        );
      }
    }, PAIRING_TIMEOUT_MS);
  }

  /**
   * Handle a discovered device from mDNS (only active during pairing).
   *
   * @param discovered Discovered device info.
   */
  onDeviceDiscovered(discovered: DiscoveredDevice): void {
    // Main decides which announcements reach this point: unknown devices, and known
    // ones whose token no longer works (they may be paired again).

    // Skip duplicates
    if (this.discovered.find(d => d.serial === discovered.serial)) {
      return;
    }

    if (this.discovered.length >= MAX_DISCOVERED) {
      this.adapter.log.debug(
        `mDNS: discovery list full (${MAX_DISCOVERED}) — ignoring ${sanitizeForLog(discovered.name)}`,
      );
      return;
    }
    this.discovered.push(discovered);
    this.foundInWindow++;
    // L9/DD17: name and product type come straight from an mDNS TXT record, so
    // any host on the LAN picks them. Without the CR/LF strip a crafted
    // announcement forges additional log lines. (The IP is already validated.)
    this.adapter.log.info(
      `Found ${sanitizeForLog(discovered.name)} (${sanitizeForLog(discovered.productType)}) at ${discovered.ip} — ` +
        `press the button on the device to pair`,
    );
  }

  /**
   * Say once per window that a device is already paired — otherwise a user who
   * wants to pair it again watches 60 silent seconds.
   *
   * @param discovered The announced device.
   * @param label      How the adapter names the paired device.
   */
  noteAlreadyPaired(discovered: DiscoveredDevice, label: string): void {
    if (this.notedPaired.has(discovered.serial)) {
      return;
    }
    this.notedPaired.add(discovered.serial);
    this.adapter.log.info(`${label} is already paired — remove it first, or set 'pairingIp' to pair it again`);
  }

  /** Poll all discovered devices to attempt pairing. */
  async poll(): Promise<void> {
    if (this.pollBusy) {
      return;
    }
    this.pollBusy = true;
    try {
      await this.pollDevices();
    } finally {
      this.pollBusy = false;
    }
  }

  /**
   * Whether the pass must end here: the window closed or the adapter is stopping
   * while a request was in flight. Checked after every await — without it, a
   * device answering after `stop()` was still saved and adopted during shutdown.
   */
  private passOver(): boolean {
    return !this.pairing || this.host.isUnloading();
  }

  /** One pairing-poll pass over all discovered devices. */
  private async pollDevices(): Promise<void> {
    for (const device of this.discovered) {
      if (this.passOver()) {
        return;
      }
      let issuedToken: string | undefined;
      let deviceConfig: DeviceConfig;
      try {
        const client = this.host.makeClient(device.ip, "");
        const result = await client.requestPairing();
        issuedToken = result.token;
        if (this.passOver()) {
          // The button was pressed, but the window is gone: nothing will store this
          // token, so it must not stay behind on the device.
          this.revoke(device.ip, issuedToken);
          return;
        }

        // Success! Button was pressed. Name and product type are the mDNS-supplied
        // values — same CR/LF strip as the error path below (L9/DD17).
        this.adapter.log.info(
          `Successfully paired with ${sanitizeForLog(device.name)} (${sanitizeForLog(device.productType)}) ` +
            `at ${device.ip} — connecting...`,
        );

        // Get device info + capture the device's TLS cert CN to pin its identity on future connects
        const authedClient = this.host.makeClient(device.ip, result.token);
        const info = await authedClient.getDeviceInfo();
        const certCn = authedClient.getServerCertCn();
        if (this.passOver()) {
          this.revoke(device.ip, issuedToken);
          return;
        }

        // I10: cross-check the pinned CN (`appliance/<type>/<serial>`) against the
        // serial the device reports over the authenticated channel. A mismatch means
        // the identity we are about to pin and the device's self-report disagree —
        // warn (not block: CN formats vary across firmware and a hard reject could
        // break a legitimate pairing), then pin the CN as captured.
        if (certCn && !certCn.includes(info.serial)) {
          this.adapter.log.warn(
            `${sanitizeForLog(info.product_name)}: paired certificate CN "${sanitizeForLog(certCn)}" does not ` +
              `contain the reported serial "${sanitizeForLog(info.serial)}" — verify this is the intended device.`,
          );
        }

        deviceConfig = {
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
        await this.host.saveDeviceToObject(deviceConfig);
      } catch (err) {
        // 403 = button not pressed yet — expected, keep polling
        if (err instanceof HomeWizardApiError && err.statusCode === 403) {
          continue;
        }
        if (this.passOver()) {
          return;
        }
        // A token WAS issued this round (button was pressed) but reading or storing
        // the device failed (e.g. a malformed GET /api). Nothing holds the token, so
        // it is revoked, and the device leaves the queue: a persistently-malformed
        // device would otherwise re-mint + revoke a token every 2 s for the rest of
        // the 60 s window (F4). The 403 path above still keeps polling.
        // Surfaced as warn since the user pressed the button and expects a result.
        if (issuedToken) {
          this.revoke(device.ip, issuedToken);
          this.discovered = this.discovered.filter(d => d !== device);
          this.adapter.log.warn(
            `${sanitizeForLog(device.name)}: paired, but the device could not be read or stored — token revoked, ` +
              `please retry pairing. (${errText(err)})`,
          );
          continue;
        }
        // Everything that is not the expected 403 used to end here, at debug: a
        // mistyped manual IP, a device that does not answer, one that speaks only the
        // v1 API, a device whose user store is full. The user pressed the button and
        // then read "pairing mode automatically disabled" 60 s later, with nothing in
        // between. One warning per device and window, repeats stay at debug.
        if (!this.warnedIps.has(device.ip)) {
          this.warnedIps.add(device.ip);
          this.adapter.log.warn(
            `Pairing with ${device.ip} failed — device unreachable, or it does not speak API v2? ` +
              `(${errText(err)})`,
          );
        } else {
          this.adapter.log.debug(`Pairing poll error for ${device.ip}: ${errText(err)}`);
        }
        continue;
      }

      // From here on the device is stored: its object carries the token, so the
      // token must NOT be revoked any more — the next start loads the device from
      // that object. A failure below only delays the data points.
      try {
        await this.host.getStateManager().createDeviceStates(deviceConfig);
        // Same stamp as at start-up, and it matters most on a RE-pair: the old
        // connection is torn down below, and tearing down deliberately suppresses
        // the WebSocket's disconnect handler — without this the device would keep
        // its stale `true` until the new connection authenticates.
        await this.host.getStateManager().setDeviceConnected(deviceConfig, false);
      } catch (err) {
        this.adapter.log.warn(
          `${sanitizeForLog(deviceConfig.productName)}: paired, but its data points could not be created yet ` +
            `(${errText(err)}) — they are created on the next start`,
        );
      }
      if (this.host.isUnloading()) {
        return;
      }

      // Replace any previous connection for this device (re-pair after a factory
      // reset) and start connecting — main owns the registry.
      this.host.adoptPairedDevice(deviceConfig, device.ip);
      this.pairedInWindow++;

      // Remove the just-paired entry by identity (not by serial — the manual-IP
      // placeholder carries serial "unknown" and would never match info.serial,
      // so it would be re-POSTed every 2s and mint orphaned tokens). Keep the
      // window open so the user can button-press more devices this session.
      // Do NOT stop the window here — pairingTimer (60 s) closes it naturally;
      // meanwhile the user can pair more devices.
      this.discovered = this.discovered.filter(d => d !== device);
    }
  }

  /**
   * Best-effort revoke of a token nothing will store.
   *
   * @param ip    Device address.
   * @param token The token the device issued.
   */
  private revoke(ip: string, token: string): void {
    this.host
      .makeClient(ip, token)
      .deleteUser()
      .catch((err: unknown) => this.adapter.log.debug(`Revoking an unused pairing token at ${ip}: ${errText(err)}`));
  }

  /** Stop pairing mode — closes the window and drops everything it held. */
  stop(): void {
    this.pairing = false;
    this.manualIp = "";
    this.discovered = [];
    this.warnedIps.clear();
    this.notedPaired.clear();

    // Stop mDNS — only needed during pairing
    this.host.stopDiscovery();

    if (this.pollTimer) {
      this.adapter.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.pairingTimer) {
      this.adapter.clearTimeout(this.pairingTimer);
      this.pairingTimer = undefined;
    }
  }
}
