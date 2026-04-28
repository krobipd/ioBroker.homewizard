import Bonjour, { type Service } from "bonjour-service";
import type { DiscoveredDevice } from "./types";

/** Callback for discovered devices */
export type DiscoveryCallback = (device: DiscoveredDevice) => void;

/**
 * mDNS discovery for HomeWizard Energy devices.
 * Browses for `_hwenergy._tcp` services on the local network.
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

    this.browser = this.bonjour.find({ type: "homewizard", protocol: "tcp" }, (service: Service) => {
      const device = this.parseService(service);
      if (device) {
        this.log.debug(`mDNS: found ${device.name} (${device.productType}) at ${device.ip}`);
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
  private parseService(service: Service): DiscoveredDevice | null {
    // IPv4 address
    const ip = service.addresses?.find(addr => addr.includes("."));
    if (!ip) {
      this.log.debug(`mDNS: no IPv4 address for ${service.name}`);
      return null;
    }

    // TXT records contain product_type, serial, etc.
    const txt = service.txt as Record<string, string> | undefined;
    const productType = txt?.product_type ?? "unknown";
    const serial = txt?.serial ?? service.name ?? "unknown";
    const name = txt?.product_name ?? service.name ?? productType;
    const apiVersion = txt?.api_version;

    if (apiVersion) {
      this.log.debug(`mDNS: TXT api_version=${apiVersion} serial=${serial}`);
    }

    return { ip, productType, serial, name };
  }
}
