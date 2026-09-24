import type { EventEmitter } from "node:events";
import Bonjour from "bonjour-service";
import { errText, isLanDeviceIpv4, sanitizeForLog } from "./coerce";
import type { DiscoveredDevice } from "./types";

type BonjourService = ReturnType<InstanceType<typeof Bonjour>["publish"]>;

/**
 * Coerce a raw Bonjour TXT-record value to a string. The library returns
 * either string, Buffer, or undefined depending on encoding — we normalize
 * here so downstream code sees one shape. Exported for unit-tests; the
 * production path uses it via {@link HomeWizardDiscovery#parseService}.
 *
 * @param value Raw TXT-record value.
 */
export function coerceTxtValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    const decoded = value.toString("utf8");
    return decoded.length > 0 ? decoded : undefined;
  }
  return undefined;
}

/** Callback for discovered devices */
export type DiscoveryCallback = (device: DiscoveredDevice) => void;

/**
 * mDNS discovery for HomeWizard Energy devices.
 * Browses for `_homewizard._tcp` services (API v2) on the local network.
 * `_hwenergy._tcp` is the deprecated v1 type and is intentionally NOT browsed —
 * this adapter is v2-only.
 */
export class HomeWizardDiscovery {
  /**
   * Whether the "mDNS search is not possible" warning was already given in this
   * process. The browser is recreated for every search, and a port that is taken
   * stays taken — one line says it, every later attempt stays at debug.
   */
  private static socketErrorReported = false;
  private bonjour: Bonjour | null = null;
  private browser: ReturnType<Bonjour["find"]> | null = null;
  private readonly log: {
    debug: (msg: string) => void;
    warn: (msg: string) => void;
  };

  /**
   * @param log Logger interface
   * @param log.debug Debug log function
   * @param log.warn Warning log function
   */
  constructor(log: { debug: (msg: string) => void; warn: (msg: string) => void }) {
    this.log = log;
  }

  /**
   * Start scanning for HomeWizard devices
   *
   * @param callback Called for each discovered device
   */
  start(callback: DiscoveryCallback): void {
    this.stop();

    this.bonjour = new Bonjour();
    this.watchSocketErrors(this.bonjour);
    this.log.debug("mDNS: browsing for _homewizard._tcp (v2)");

    this.browser = this.bonjour.find({ type: "homewizard", protocol: "tcp" }, (service: BonjourService) => {
      const device = this.parseService(service);
      if (device) {
        this.log.debug(
          `mDNS: found ${sanitizeForLog(device.name)} (${sanitizeForLog(device.productType)}) at ${device.ip}`,
        );
        callback(device);
      }
    });
  }

  /**
   * Catch errors of the multicast socket behind the browser.
   *
   * `multicast-dns` emits `error` when it cannot bind UDP port 5353 (EADDRINUSE,
   * EACCES — another program holds the port exclusively), and `bonjour-service`
   * registers no listener for it. An `error` event without a listener is thrown by
   * Node, asynchronously, so no try/catch around `start()` would see it: the whole
   * adapter process would crash and the host would restart it into the same crash.
   * The emitter is private in the library's typings, hence the guarded access.
   *
   * @param bonjour The freshly created Bonjour instance.
   */
  private watchSocketErrors(bonjour: Bonjour): void {
    const mdns = (bonjour as unknown as { server?: { mdns?: EventEmitter } }).server?.mdns;
    if (!mdns || typeof mdns.on !== "function") {
      this.log.debug("mDNS: socket emitter not found — socket errors are not intercepted");
      return;
    }
    mdns.on("error", (err: unknown) => {
      if (HomeWizardDiscovery.socketErrorReported) {
        this.log.debug(`mDNS: search not possible: ${errText(err)}`);
      } else {
        HomeWizardDiscovery.socketErrorReported = true;
        this.log.warn(
          `mDNS search is not possible: ${errText(err)} — another program holds UDP port 5353? ` +
            `Pair devices with 'pairingIp' instead`,
        );
      }
      this.stop();
    });
  }

  /** Stop scanning */
  stop(): void {
    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }
  }

  /**
   * Parse a Bonjour service into a DiscoveredDevice
   *
   * @param service Bonjour service record
   */
  private parseService(service: BonjourService): DiscoveredDevice | null {
    // Pick a private-range IPv4. `addr.includes(".")` alone would also accept an
    // IPv4-mapped IPv6 or a malformed string, and isValidIpv4 alone would accept
    // loopback / link-local (incl. 169.254.169.254) / any public address. L6/G:
    // nobody typed this address — a rogue responder on the LAN picks it freely,
    // and mDNS is link-local, so a genuine device can only ever announce an
    // RFC-1918 address here. The manual-IP path stays laxer on purpose.
    const ip = service.addresses?.find((addr: string) => isLanDeviceIpv4(addr));
    if (!ip) {
      this.log.debug(`mDNS: no usable private IPv4 address for ${sanitizeForLog(service.name)}`);
      return null;
    }

    // TXT records contain product_type, serial, etc. Library may hand us
    // strings or Buffers — coerce defensively before use.
    const txt = (service.txt ?? {}) as Record<string, unknown>;
    const productType = coerceTxtValue(txt.product_type) ?? "unknown";
    const serial = coerceTxtValue(txt.serial) ?? service.name ?? "unknown";
    const name = coerceTxtValue(txt.product_name) ?? service.name ?? productType;
    const apiVersion = coerceTxtValue(txt.api_version);

    if (apiVersion) {
      this.log.debug(`mDNS: TXT api_version=${sanitizeForLog(apiVersion)} serial=${sanitizeForLog(serial)}`);
    }

    return { ip, productType, serial, name };
  }
}
