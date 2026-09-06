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
  /** Serials that are already paired — a discovery hit for one of them is ignored. */
  knownSerials(): Iterable<string>;
  /**
   * Start the mDNS browser (owned by main, shared with IP recovery).
   *
   * @param onDiscovered Called for every announcement.
   */
  startDiscovery(onDiscovered: (device: DiscoveredDevice) => void): void;
  /** Stop the mDNS browser. */
  stopDiscovery(): void;
  /** Stop IP recovery before the pairing window opens — both use the one browser. */
  stopIpRecovery(): void;
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

    // Reset startPairing immediately so it doesn't survive a restart
    await this.adapter.setStateAsync("startPairing", { val: false, ack: true });

    // I9: stop IP recovery BEFORE setting the flag — stopIpRecovery only tears
    // down the discovery browser while pairing is inactive, so doing it after
    // would leave the recovery browser running alongside the pairing one.
    this.host.stopIpRecovery();

    this.pairing = true;
    this.discovered = [];

    // Check if manual IP is set, then clear pairingIp immediately
    const ipState = await this.adapter.getStateAsync("pairingIp");
    this.manualIp = ipState?.val ? String(ipState.val).trim() : "";
    await this.adapter.setStateAsync("pairingIp", { val: "", ack: true });

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
    } else {
      this.adapter.log.info(
        `Pairing mode enabled — searching for devices via mDNS, press the button on your HomeWizard device now (60 seconds timeout)`,
      );
      // Restart mDNS browser to trigger fresh query — already-cached devices
      // won't be re-announced otherwise and pairing would never find them
      this.host.startDiscovery(discovered => this.onDeviceDiscovered(discovered));
    }

    // Poll discovered devices for pairing
    this.pollTimer = this.adapter.setInterval(() => {
      this.poll().catch((err: unknown) => this.adapter.log.debug(`pollPairing failed: ${errText(err)}`));
    }, PAIRING_POLL_MS);

    // Timeout pairing
    this.pairingTimer = this.adapter.setTimeout(() => {
      this.stop();
      this.adapter.log.info(`Pairing mode automatically disabled after 60 seconds timeout`);
    }, PAIRING_TIMEOUT_MS);
  }

  /**
   * Handle a discovered device from mDNS (only active during pairing).
   *
   * @param discovered Discovered device info.
   */
  onDeviceDiscovered(discovered: DiscoveredDevice): void {
    // Skip already paired devices
    for (const serial of this.host.knownSerials()) {
      if (serial === discovered.serial) {
        return;
      }
    }

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
    // L9/DD17: name and product type come straight from an mDNS TXT record, so
    // any host on the LAN picks them. Without the CR/LF strip a crafted
    // announcement forges additional log lines. (The IP is already validated.)
    this.adapter.log.info(
      `Found ${sanitizeForLog(discovered.name)} (${sanitizeForLog(discovered.productType)}) at ${discovered.ip} — ` +
        `press the button on the device to pair`,
    );
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

  /** One pairing-poll pass over all discovered devices. */
  private async pollDevices(): Promise<void> {
    for (const device of this.discovered) {
      let issuedToken: string | undefined;
      try {
        const client = this.host.makeClient(device.ip, "");
        const result = await client.requestPairing();
        issuedToken = result.token;

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
        await this.host.saveDeviceToObject(deviceConfig);
        await this.host.getStateManager().createDeviceStates(deviceConfig);
        // Same stamp as at start-up, and it matters most on a RE-pair: the old
        // connection is torn down below, and tearing down deliberately suppresses
        // the WebSocket's disconnect handler — without this the device would keep
        // its stale `true` until the new connection authenticates.
        await this.host.getStateManager().setDeviceConnected(deviceConfig, false);

        // Replace any previous connection for this device (re-pair after a factory
        // reset) and start connecting — main owns the registry.
        this.host.adoptPairedDevice(deviceConfig, device.ip);

        // Remove the just-paired entry by identity (not by serial — the manual-IP
        // placeholder carries serial "unknown" and would never match info.serial,
        // so it would be re-POSTed every 2s and mint orphaned tokens). Keep the
        // window open so the user can button-press more devices this session.
        this.discovered = this.discovered.filter(d => d !== device);

        // Do NOT stop the window here — pairingTimer (60 s) closes it naturally;
        // meanwhile the user can pair more devices.
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
          this.host
            .makeClient(device.ip, issuedToken)
            .deleteUser()
            .catch(() => {
              /* best-effort revoke */
            });
          this.discovered = this.discovered.filter(d => d !== device);
          this.adapter.log.warn(
            `${sanitizeForLog(device.name)}: paired but could not read device info — token revoked, ` +
              `please retry pairing. (${errText(err)})`,
          );
          continue;
        }
        this.adapter.log.debug(`Pairing poll error for ${device.ip}: ${errText(err)}`);
      }
    }
  }

  /** Stop pairing mode — closes the window and drops everything it held. */
  stop(): void {
    this.pairing = false;
    this.manualIp = "";
    this.discovered = [];

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
