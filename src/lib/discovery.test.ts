import type { EventEmitter } from "node:events";
import { vi } from "vitest";

// I5: mock bonjour-service so the start/stop lifecycle tests exercise
// HomeWizardDiscovery's own logic (stop-before-start, null handling) without
// binding real mDNS multicast sockets (slow, flaky, leaks handles in CI).
// The fake keeps the callback the adapter passes, so the path from an announcement
// to the adapter's callback can be driven — without it, a regression that never calls
// back (or hands over the raw service) stays green.
const announced: {
  emit: ((service: unknown) => void) | null;
  opts: unknown;
  mdns: EventEmitter | null;
} = { emit: null, opts: null, mdns: null };

vi.mock("bonjour-service", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeBonjour {
    // Same shape as the real library: the multicast socket's emitter sits on
    // `server.mdns`, and it throws an `error` event nobody listens to.
    server = { mdns: new EventEmitter() };
    constructor() {
      announced.mdns = this.server.mdns;
    }
    find(opts: unknown, cb: (service: unknown) => void): { stop: () => void } {
      announced.opts = opts;
      announced.emit = cb;
      return { stop: (): void => {} };
    }
    destroy(): void {}
  }
  return { default: FakeBonjour, Bonjour: FakeBonjour };
});

import { coerceTxtValue, HomeWizardDiscovery } from "./discovery";
import type { DiscoveredDevice } from "./types";

interface LogEntry {
  level: string;
  msg: string;
}

interface MockLog {
  debug: (msg: string) => void;
  warn: (msg: string) => void;
  _logs: LogEntry[];
}

function createMockLog(): MockLog {
  const logs: LogEntry[] = [];
  return {
    debug: (msg: string): void => {
      logs.push({ level: "debug", msg });
    },
    warn: (msg: string): void => {
      logs.push({ level: "warn", msg });
    },
    _logs: logs,
  };
}

describe("HomeWizardDiscovery", () => {
  let discovery: HomeWizardDiscovery;
  let log: MockLog;

  beforeEach(() => {
    log = createMockLog();
    discovery = new HomeWizardDiscovery(log);
  });

  afterEach(() => {
    discovery.stop();
  });

  describe("constructor", () => {
    it("should create an instance", () => {
      expect(discovery).toBeInstanceOf(HomeWizardDiscovery);
    });
  });

  describe("what it searches for", () => {
    it("browses the API v2 service type, never the v1 type (DD4/DD5)", () => {
      discovery.start(() => {});
      expect(announced.opts).toEqual({ type: "homewizard", protocol: "tcp" });
    });
  });

  describe("socket errors of the multicast browser", () => {
    it("catches a taken UDP port instead of letting Node throw, warns once and stops", () => {
      discovery.start(() => {});
      const err = Object.assign(new Error("bind EADDRINUSE 0.0.0.0:5353"), { code: "EADDRINUSE" });
      // Without a listener this emit would throw — the adapter process would crash.
      expect(() => announced.mdns!.emit("error", err)).not.toThrow();
      const warns = log._logs.filter(l => l.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toContain("EADDRINUSE");
      expect(warns[0].msg).toContain("pairingIp");

      // A later search hits the same taken port: no second warning.
      discovery.start(() => {});
      expect(() => announced.mdns!.emit("error", err)).not.toThrow();
      expect(log._logs.filter(l => l.level === "warn")).toHaveLength(1);
    });
  });

  describe("start/stop lifecycle", () => {
    it("should not throw on start", () => {
      expect(() => discovery.start(() => {})).not.toThrow();
    });

    it("should log browse message on start", () => {
      discovery.start(() => {});
      const debugLogs = log._logs.filter(l => l.level === "debug");
      expect(debugLogs.some(l => l.msg.includes("_homewizard._tcp"))).toBe(true);
    });

    it("should not throw on stop when not started", () => {
      expect(() => discovery.stop()).not.toThrow();
    });

    it("should not throw on stop after start", () => {
      discovery.start(() => {});
      expect(() => discovery.stop()).not.toThrow();
    });

    it("should handle multiple stop calls", () => {
      discovery.start(() => {});
      discovery.stop();
      expect(() => discovery.stop()).not.toThrow();
    });

    it("should handle start-stop-start cycle", () => {
      discovery.start(() => {});
      discovery.stop();
      expect(() => discovery.start(() => {})).not.toThrow();
    });

    it("should stop previous scan when starting a new one", () => {
      discovery.start(() => {});
      expect(() => discovery.start(() => {})).not.toThrow();
    });
  });

  describe("the path from an announcement to the caller", () => {
    it("hands the parsed device to the callback and says so in the log", () => {
      const seen: DiscoveredDevice[] = [];
      discovery.start(d => seen.push(d));

      announced.emit!({
        name: "p1meter-aabbcc",
        addresses: ["192.168.1.100"],
        txt: { product_type: "HWE-P1", serial: "aabbccddeeff", product_name: "P1 Meter" },
      });

      expect(seen).toEqual([{ ip: "192.168.1.100", productType: "HWE-P1", serial: "aabbccddeeff", name: "P1 Meter" }]);
      expect(log._logs.some(l => l.msg.includes("mDNS: found P1 Meter (HWE-P1) at 192.168.1.100"))).toBe(true);
    });

    it("swallows an announcement it cannot use instead of calling back with nothing", () => {
      const seen: DiscoveredDevice[] = [];
      discovery.start(d => seen.push(d));

      announced.emit!({ name: "no-address", addresses: [], txt: { product_type: "HWE-P1" } });

      expect(seen).toEqual([]);
    });
  });

  describe("parseService (via internal access)", () => {
    // Access private method for unit testing
    function parseService(discovery: HomeWizardDiscovery, service: unknown): DiscoveredDevice | null {
      return (discovery as unknown as { parseService: (s: unknown) => DiscoveredDevice | null }).parseService(service);
    }

    it("should parse service with full TXT records", () => {
      const service = {
        name: "p1meter-aabbcc",
        addresses: ["192.168.1.100", "fe80::1"],
        txt: {
          product_type: "HWE-P1",
          serial: "aabbccddeeff",
          product_name: "P1 Meter",
        },
      };
      const result = parseService(discovery, service);
      expect(result).toEqual({
        ip: "192.168.1.100",
        productType: "HWE-P1",
        serial: "aabbccddeeff",
        name: "P1 Meter",
      });
    });

    it("should use first IPv4 address", () => {
      const service = {
        name: "test",
        addresses: ["fe80::1", "10.0.0.5", "192.168.1.1"],
        txt: { product_type: "HWE-KWH1" },
      };
      const result = parseService(discovery, service);
      expect(result?.ip).toBe("10.0.0.5");
    });

    it("should return null when no IPv4 address", () => {
      const service = {
        name: "test",
        addresses: ["fe80::1"],
        txt: { product_type: "HWE-P1" },
      };
      const result = parseService(discovery, service);
      expect(result).toBeNull();
    });

    it("ignores a public address announced over mDNS (rogue responder guard)", () => {
      // mDNS is link-local: a genuine device can only ever announce a private
      // address here. Anything public means someone is trying to send the
      // adapter — and its pairing request — off the LAN.
      const service = {
        name: "test",
        addresses: ["203.0.113.5", "8.8.8.8"],
        txt: { product_type: "HWE-P1" },
      };
      expect(parseService(discovery, service)).toBeNull();
    });

    it("picks the private address when a public one is announced alongside it", () => {
      const service = {
        name: "test",
        addresses: ["203.0.113.5", "192.168.1.7"],
        txt: { product_type: "HWE-P1" },
      };
      expect(parseService(discovery, service)?.ip).toBe("192.168.1.7");
    });

    it("should return null when no addresses", () => {
      const service = {
        name: "test",
        addresses: undefined,
        txt: { product_type: "HWE-P1" },
      };
      const result = parseService(discovery, service);
      expect(result).toBeNull();
    });

    it("should use product_type from TXT record", () => {
      const service = {
        name: "test",
        addresses: ["192.168.1.1"],
        txt: { product_type: "HWE-KWH1" },
      };
      const result = parseService(discovery, service);
      expect(result?.productType).toBe("HWE-KWH1");
    });

    it("should use 'unknown' when no product type in TXT", () => {
      const service = {
        name: "test",
        addresses: ["192.168.1.1"],
        txt: {},
      };
      const result = parseService(discovery, service);
      expect(result?.productType).toBe("unknown");
    });

    it("should use service name as serial fallback", () => {
      const service = {
        name: "p1meter-aabb",
        addresses: ["192.168.1.1"],
        txt: { product_type: "HWE-P1" },
      };
      const result = parseService(discovery, service);
      expect(result?.serial).toBe("p1meter-aabb");
    });

    it("should use product type as name fallback", () => {
      const service = {
        name: undefined,
        addresses: ["192.168.1.1"],
        txt: { product_type: "HWE-BAT" },
      };
      const result = parseService(discovery, service);
      expect(result?.name).toBe("HWE-BAT");
    });

    it("should handle missing TXT records", () => {
      const service = {
        name: "device123",
        addresses: ["192.168.1.1"],
        txt: undefined,
      };
      const result = parseService(discovery, service);
      expect(result).not.toBeNull();
      expect(result!.productType).toBe("unknown");
      expect(result!.serial).toBe("device123");
    });

    it("should accept TXT values delivered as Buffer", () => {
      const service = {
        name: "buf-device",
        addresses: ["192.168.1.5"],
        txt: {
          product_type: Buffer.from("HWE-P1", "utf8"),
          serial: Buffer.from("5c2faabbccdd", "utf8"),
          product_name: Buffer.from("P1 Meter", "utf8"),
        },
      };
      const result = parseService(discovery, service);
      expect(result).not.toBeNull();
      expect(result!.productType).toBe("HWE-P1");
      expect(result!.serial).toBe("5c2faabbccdd");
      expect(result!.name).toBe("P1 Meter");
    });
  });
});

describe("coerceTxtValue", () => {
  it("returns non-empty strings unchanged", () => {
    expect(coerceTxtValue("HWE-P1")).toBe("HWE-P1");
  });

  it("decodes Buffer values as utf8", () => {
    expect(coerceTxtValue(Buffer.from("hello", "utf8"))).toBe("hello");
  });

  it("returns undefined for empty string and empty Buffer", () => {
    expect(coerceTxtValue("")).toBeUndefined();
    expect(coerceTxtValue(Buffer.from("", "utf8"))).toBeUndefined();
  });

  it("returns undefined for unsupported shapes", () => {
    expect(coerceTxtValue(undefined)).toBeUndefined();
    expect(coerceTxtValue(null)).toBeUndefined();
    expect(coerceTxtValue(42)).toBeUndefined();
    expect(coerceTxtValue({ product_type: "x" })).toBeUndefined();
    expect(coerceTxtValue([1, 2, 3])).toBeUndefined();
  });
});
