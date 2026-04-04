import { expect } from "chai";
import { HomeWizardDiscovery } from "../src/lib/discovery";
import type { DiscoveredDevice } from "../src/lib/types";

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
            expect(discovery).to.be.instanceOf(HomeWizardDiscovery);
        });
    });

    describe("start/stop lifecycle", () => {
        it("should not throw on start", () => {
            expect(() => discovery.start(() => {})).to.not.throw();
        });

        it("should log browse message on start", () => {
            discovery.start(() => {});
            const debugLogs = log._logs.filter((l) => l.level === "debug");
            expect(debugLogs.some((l) => l.msg.includes("_hwenergy._tcp"))).to.be.true;
        });

        it("should not throw on stop when not started", () => {
            expect(() => discovery.stop()).to.not.throw();
        });

        it("should not throw on stop after start", () => {
            discovery.start(() => {});
            expect(() => discovery.stop()).to.not.throw();
        });

        it("should handle multiple stop calls", () => {
            discovery.start(() => {});
            discovery.stop();
            expect(() => discovery.stop()).to.not.throw();
        });

        it("should handle start-stop-start cycle", () => {
            discovery.start(() => {});
            discovery.stop();
            expect(() => discovery.start(() => {})).to.not.throw();
        });

        it("should stop previous scan when starting a new one", () => {
            discovery.start(() => {});
            expect(() => discovery.start(() => {})).to.not.throw();
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
            expect(result).to.deep.equal({
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
            expect(result?.ip).to.equal("10.0.0.5");
        });

        it("should return null when no IPv4 address", () => {
            const service = {
                name: "test",
                addresses: ["fe80::1"],
                txt: { product_type: "HWE-P1" },
            };
            const result = parseService(discovery, service);
            expect(result).to.be.null;
        });

        it("should return null when no addresses", () => {
            const service = {
                name: "test",
                addresses: undefined,
                txt: { product_type: "HWE-P1" },
            };
            const result = parseService(discovery, service);
            expect(result).to.be.null;
        });

        it("should use type field as fallback for product_type", () => {
            const service = {
                name: "test",
                addresses: ["192.168.1.1"],
                txt: { type: "HWE-SKT" },
            };
            const result = parseService(discovery, service);
            expect(result?.productType).to.equal("HWE-SKT");
        });

        it("should use 'unknown' when no product type in TXT", () => {
            const service = {
                name: "test",
                addresses: ["192.168.1.1"],
                txt: {},
            };
            const result = parseService(discovery, service);
            expect(result?.productType).to.equal("unknown");
        });

        it("should use service name as serial fallback", () => {
            const service = {
                name: "energysocket-aabb",
                addresses: ["192.168.1.1"],
                txt: { product_type: "HWE-SKT" },
            };
            const result = parseService(discovery, service);
            expect(result?.serial).to.equal("energysocket-aabb");
        });

        it("should use product type as name fallback", () => {
            const service = {
                name: undefined,
                addresses: ["192.168.1.1"],
                txt: { product_type: "HWE-BAT" },
            };
            const result = parseService(discovery, service);
            expect(result?.name).to.equal("HWE-BAT");
        });

        it("should handle missing TXT records", () => {
            const service = {
                name: "device123",
                addresses: ["192.168.1.1"],
                txt: undefined,
            };
            const result = parseService(discovery, service);
            expect(result).to.not.be.null;
            expect(result!.productType).to.equal("unknown");
            expect(result!.serial).to.equal("device123");
        });
    });
});
