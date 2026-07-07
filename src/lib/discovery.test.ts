import { vi } from "vitest";

// I5: mock bonjour-service so the start/stop lifecycle tests exercise
// HomeWizardDiscovery's own logic (stop-before-start, null handling) without
// binding real mDNS multicast sockets (slow, flaky, leaks handles in CI).
vi.mock("bonjour-service", () => {
  class FakeBonjour {
    find(_opts: unknown, _cb: unknown): { stop: () => void } {
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
