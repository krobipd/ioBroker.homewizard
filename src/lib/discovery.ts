import Bonjour from "bonjour-service";
import { isAssignableDeviceIpv4, sanitizeForLog } from "./coerce";
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
    // Pick a LAN-assignable IPv4. `addr.includes(".")` alone would also accept an
    // IPv4-mapped IPv6 or a malformed string; isValidIpv4 alone would still accept
    // loopback / link-local (incl. 169.254.169.254) / public. L6: use the same guard
    // as the manual-IP path so a rogue mDNS responder can't point us at 127.0.0.1,
    // a metadata IP, or any off-LAN host.
    const ip = service.addresses?.find((addr: string) => isAssignableDeviceIpv4(addr));
    if (!ip) {
      this.log.debug(`mDNS: no IPv4 address for ${sanitizeForLog(service.name)}`);
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
