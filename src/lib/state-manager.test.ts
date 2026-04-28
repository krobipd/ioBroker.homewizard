import { expect } from "chai";
import { StateManager } from "./state-manager";
import type { DeviceConfig, Measurement, SystemInfo, BatteryControl } from "./types";

interface ObjectDef {
    type: string;
    common: Record<string, unknown>;
    native: Record<string, unknown>;
}

interface StateValue {
    val: unknown;
    ack: boolean;
}

interface MockAdapter {
    namespace: string;
    objects: Map<string, ObjectDef>;
    states: Map<string, StateValue>;
    log: { debug: (msg: string) => void };
    extendObjectAsync: (id: string, obj: Partial<ObjectDef>) => Promise<void>;
    setObjectNotExistsAsync: (id: string, obj: Partial<ObjectDef>) => Promise<void>;
    getObjectAsync: (id: string) => Promise<ObjectDef | null>;
    setStateAsync: (id: string, state: StateValue) => Promise<void>;
    delObjectAsync: (id: string, opts?: { recursive: boolean }) => Promise<void>;
}

function createMockAdapter(): MockAdapter {
    const objects = new Map<string, ObjectDef>();
    const states = new Map<string, StateValue>();

    return {
        namespace: "homewizard.0",
        objects,
        states,
        log: { debug: (): void => {} },
        extendObjectAsync: async (id: string, obj: Partial<ObjectDef>): Promise<void> => {
            const existing = objects.get(id) || { type: "", common: {}, native: {} };
            objects.set(id, {
                type: obj.type || existing.type,
                common: { ...existing.common, ...(obj.common || {}) },
                native: { ...existing.native, ...(obj.native || {}) },
            });
        },
        setObjectNotExistsAsync: async (id: string, obj: Partial<ObjectDef>): Promise<void> => {
            if (objects.has(id)) {
                return;
            }
            objects.set(id, {
                type: obj.type || "",
                common: obj.common || {},
                native: obj.native || {},
            });
        },
        getObjectAsync: async (id: string): Promise<ObjectDef | null> => {
            return objects.get(id) || null;
        },
        setStateAsync: async (id: string, state: StateValue): Promise<void> => {
            states.set(id, state);
        },
        delObjectAsync: async (id: string, _opts?: { recursive: boolean }): Promise<void> => {
            // Delete the object and all children
            for (const key of objects.keys()) {
                if (key === id || key.startsWith(`${id}.`)) {
                    objects.delete(key);
                }
            }
            for (const key of states.keys()) {
                if (key === id || key.startsWith(`${id}.`)) {
                    states.delete(key);
                }
            }
        },
    };
}

const testDevice: DeviceConfig = {
    token: "abcdef1234567890",
    productType: "HWE-P1",
    serial: "aabbccddeeff",
    productName: "P1 Meter",
};

describe("StateManager", () => {
    let adapter: MockAdapter;
    let manager: StateManager;

    beforeEach(() => {
        adapter = createMockAdapter();
        manager = new StateManager(adapter as never);
    });

    describe("devicePrefix", () => {
        it("should sanitize product type and serial", () => {
            const prefix = manager.devicePrefix(testDevice);
            expect(prefix).to.equal("hwe-p1_aabbccddeeff");
        });

        it("should replace special characters with underscore", () => {
            const device: DeviceConfig = {
                ...testDevice,
                productType: "HWE/P1.v2",
                serial: "aa:bb:cc",
            };
            const prefix = manager.devicePrefix(device);
            expect(prefix).to.equal("hwe_p1_v2_aa_bb_cc");
        });

        it("should lowercase the prefix", () => {
            const device: DeviceConfig = {
                ...testDevice,
                productType: "HWE-KWH3",
                serial: "AABBCC",
            };
            const prefix = manager.devicePrefix(device);
            expect(prefix).to.equal("hwe-kwh3_aabbcc");
        });
    });

    describe("createDeviceStates", () => {
        it("should create device object", async () => {
            await manager.createDeviceStates(testDevice);
            const obj = adapter.objects.get("hwe-p1_aabbccddeeff");
            expect(obj).to.not.be.undefined;
            expect(obj!.type).to.equal("device");
            expect(obj!.common.name).to.equal("P1 Meter");
        });

        it("should create info channel", async () => {
            await manager.createDeviceStates(testDevice);
            const obj = adapter.objects.get("hwe-p1_aabbccddeeff.info");
            expect(obj).to.not.be.undefined;
            expect(obj!.type).to.equal("channel");
        });

        it("should create info states", async () => {
            await manager.createDeviceStates(testDevice);
            const expected = [
                "hwe-p1_aabbccddeeff.info.productName",
                "hwe-p1_aabbccddeeff.info.productType",
                "hwe-p1_aabbccddeeff.info.firmware",
                "hwe-p1_aabbccddeeff.info.connected",
                "hwe-p1_aabbccddeeff.info.wifi_rssi_db",
                "hwe-p1_aabbccddeeff.info.uptime_s",
            ];
            for (const id of expected) {
                expect(adapter.objects.has(id), `Missing: ${id}`).to.be.true;
            }
        });

        it("should set initial productName and productType values", async () => {
            await manager.createDeviceStates(testDevice);
            const name = adapter.states.get("hwe-p1_aabbccddeeff.info.productName");
            expect(name?.val).to.equal("P1 Meter");
            expect(name?.ack).to.be.true;

            const type = adapter.states.get("hwe-p1_aabbccddeeff.info.productType");
            expect(type?.val).to.equal("HWE-P1");
        });

        it("should use productType as name fallback", async () => {
            const device: DeviceConfig = { ...testDevice, productName: "" };
            await manager.createDeviceStates(device);
            const obj = adapter.objects.get("hwe-p1_aabbccddeeff");
            expect(obj!.common.name).to.equal("HWE-P1");
        });

        it("should create remove button with read:false and initial value", async () => {
            await manager.createDeviceStates(testDevice);
            const obj = adapter.objects.get("hwe-p1_aabbccddeeff.remove");
            expect(obj).to.not.be.undefined;
            expect(obj!.common.role).to.equal("button");
            expect(obj!.common.read).to.be.false;
            expect(obj!.common.write).to.be.true;

            const state = adapter.states.get("hwe-p1_aabbccddeeff.remove");
            expect(state).to.not.be.undefined;
            expect(state!.val).to.be.false;
            expect(state!.ack).to.be.true;
        });
    });

    describe("updateMeasurement", () => {
        it("should create and set power states", async () => {
            const data: Measurement = {
                power_w: 1234,
                power_l1_w: 400,
                power_l2_w: 500,
                power_l3_w: 334,
            };
            await manager.updateMeasurement(testDevice, data);

            const power = adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_w");
            expect(power?.val).to.equal(1234);
            expect(power?.ack).to.be.true;

            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_l1_w")?.val).to.equal(400);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_l2_w")?.val).to.equal(500);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_l3_w")?.val).to.equal(334);
        });

        it("should create state objects with correct roles and units", async () => {
            const data: Measurement = { power_w: 100, voltage_l1_v: 230.5 };
            await manager.updateMeasurement(testDevice, data);

            const powerObj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.power_w");
            expect(powerObj?.common.role).to.equal("value.power");
            expect(powerObj?.common.unit).to.equal("W");

            const voltObj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.voltage_l1_v");
            expect(voltObj?.common.role).to.equal("value.voltage");
            expect(voltObj?.common.unit).to.equal("V");
        });

        it("should skip undefined/null values", async () => {
            const data: Measurement = { power_w: 100 };
            await manager.updateMeasurement(testDevice, data);

            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).to.be.true;
            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_l1_w")).to.be.false;
        });

        it("should handle energy import/export values", async () => {
            const data: Measurement = {
                energy_import_kwh: 12345.678,
                energy_export_kwh: 9876.543,
                energy_import_t1_kwh: 6000,
                energy_import_t2_kwh: 6345.678,
            };
            await manager.updateMeasurement(testDevice, data);

            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.energy_import_kwh")?.val).to.equal(12345.678);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.energy_export_kwh")?.val).to.equal(9876.543);

            const obj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.energy_import_kwh");
            expect(obj?.common.unit).to.equal("kWh");
            expect(obj?.common.role).to.equal("value.energy");
        });

        it("should handle voltage quality counters in quality channel", async () => {
            const data: Measurement = {
                voltage_sag_l1_count: 3,
                voltage_swell_l2_count: 1,
                any_power_fail_count: 5,
            };
            await manager.updateMeasurement(testDevice, data);

            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.quality.voltage_sag_l1_count")?.val).to.equal(3);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.quality.voltage_swell_l2_count")?.val).to.equal(1);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.quality.power_fail_count")?.val).to.equal(5);
        });

        it("should handle battery-specific fields", async () => {
            const data: Measurement = {
                state_of_charge_pct: 85,
                cycles: 142,
            };
            await manager.updateMeasurement(testDevice, data);

            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.state_of_charge_pct")?.val).to.equal(85);
            const obj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.state_of_charge_pct");
            expect(obj?.common.role).to.equal("value.battery");
            expect(obj?.common.unit).to.equal("%");
        });

        it("should handle external meters", async () => {
            const data: Measurement = {
                power_w: 100,
                external: [
                    {
                        unique_id: "gas001",
                        type: "gas_meter",
                        timestamp: "2026-04-04T12:00:00",
                        value: 1234.567,
                        unit: "m3",
                    },
                ],
            };
            await manager.updateMeasurement(testDevice, data);

            // External channel
            const extChannel = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.external");
            expect(extChannel?.type).to.equal("channel");

            // Gas meter channel
            const gasChannel = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_gas001");
            expect(gasChannel?.type).to.equal("channel");

            // Values
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_gas001.value")?.val).to.equal(1234.567);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_gas001.unit")?.val).to.equal("m3");
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_gas001.timestamp")?.val).to.equal("2026-04-04T12:00:00");
        });

        it("should handle multiple external meters", async () => {
            const data: Measurement = {
                external: [
                    { unique_id: "gas1", type: "gas_meter", timestamp: "t1", value: 100, unit: "m3" },
                    { unique_id: "water1", type: "water_meter", timestamp: "t2", value: 50, unit: "l" },
                ],
            };
            await manager.updateMeasurement(testDevice, data);

            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_gas1.value")?.val).to.equal(100);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.water_meter_water1.value")?.val).to.equal(50);
        });

        it("should handle empty measurement", async () => {
            const data: Measurement = {};
            await manager.updateMeasurement(testDevice, data);
            // No states should be created (besides any from previous calls)
            expect(adapter.states.size).to.equal(0);
        });

        it("should handle metadata fields", async () => {
            const data: Measurement = {
                meter_model: "Landis+Gyr E350",
                timestamp: "2026-04-04T12:00:00",
                tariff: 2,
            };
            await manager.updateMeasurement(testDevice, data);

            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.meter_model")?.val).to.equal("Landis+Gyr E350");
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.timestamp")?.val).to.equal("2026-04-04T12:00:00");
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.tariff")?.val).to.equal(2);
        });
    });

    describe("updateSystem", () => {
        const system: SystemInfo = {
            wifi_ssid: "MyNetwork",
            wifi_rssi_db: -65,
            uptime_s: 3600,
            cloud_enabled: true,
            status_led_brightness_pct: 50,
            api_v1_enabled: false,
        };

        it("should update wifi and uptime in info channel", async () => {
            await manager.updateSystem(testDevice, system);

            expect(adapter.states.get("hwe-p1_aabbccddeeff.info.wifi_rssi_db")?.val).to.equal(-65);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.info.uptime_s")?.val).to.equal(3600);
        });

        it("should create system channel", async () => {
            await manager.updateSystem(testDevice, system);

            const channel = adapter.objects.get("hwe-p1_aabbccddeeff.system");
            expect(channel?.type).to.equal("channel");
            expect(channel?.common.name).to.equal("System Settings");
        });

        it("should create writable system states", async () => {
            await manager.updateSystem(testDevice, system);

            const cloud = adapter.objects.get("hwe-p1_aabbccddeeff.system.cloud_enabled");
            expect(cloud?.common.write).to.be.true;
            expect(cloud?.common.role).to.equal("switch");
            expect(adapter.states.get("hwe-p1_aabbccddeeff.system.cloud_enabled")?.val).to.be.true;

            const led = adapter.objects.get("hwe-p1_aabbccddeeff.system.status_led_brightness_pct");
            expect(led?.common.write).to.be.true;
            expect(led?.common.unit).to.equal("%");
            expect(adapter.states.get("hwe-p1_aabbccddeeff.system.status_led_brightness_pct")?.val).to.equal(50);
        });

        it("should create api_v1_enabled when present", async () => {
            await manager.updateSystem(testDevice, system);

            expect(adapter.states.get("hwe-p1_aabbccddeeff.system.api_v1_enabled")?.val).to.be.false;
        });

        it("should skip api_v1_enabled when undefined", async () => {
            const systemNoV1: SystemInfo = {
                wifi_ssid: "Test",
                wifi_rssi_db: -70,
                uptime_s: 100,
                cloud_enabled: false,
                status_led_brightness_pct: 100,
            };
            await manager.updateSystem(testDevice, systemNoV1);

            expect(adapter.states.has("hwe-p1_aabbccddeeff.system.api_v1_enabled")).to.be.false;
        });

        it("should create reboot and identify buttons with read:false and initial value", async () => {
            await manager.updateSystem(testDevice, system);

            const reboot = adapter.objects.get("hwe-p1_aabbccddeeff.system.reboot");
            expect(reboot?.common.role).to.equal("button");
            expect(reboot?.common.write).to.be.true;
            expect(reboot?.common.read).to.be.false;

            const identify = adapter.objects.get("hwe-p1_aabbccddeeff.system.identify");
            expect(identify?.common.role).to.equal("button");
            expect(identify?.common.write).to.be.true;
            expect(identify?.common.read).to.be.false;

            // Buttons should have initial state value
            const rebootState = adapter.states.get("hwe-p1_aabbccddeeff.system.reboot");
            expect(rebootState).to.not.be.undefined;
            expect(rebootState!.val).to.be.false;

            const identifyState = adapter.states.get("hwe-p1_aabbccddeeff.system.identify");
            expect(identifyState).to.not.be.undefined;
            expect(identifyState!.val).to.be.false;
        });
    });

    describe("updateBattery", () => {
        const battery: BatteryControl = {
            mode: "zero",
            permissions: ["charge_allowed", "discharge_allowed"],
            battery_count: 2,
            power_w: -500,
            target_power_w: 0,
            max_consumption_w: 800,
            max_production_w: 800,
        };

        it("should create battery channel", async () => {
            await manager.updateBattery(testDevice, battery);

            const channel = adapter.objects.get("hwe-p1_aabbccddeeff.battery");
            expect(channel?.type).to.equal("channel");
            expect(channel?.common.name).to.equal("Battery Control");
        });

        it("should create writable mode state", async () => {
            await manager.updateBattery(testDevice, battery);

            const mode = adapter.objects.get("hwe-p1_aabbccddeeff.battery.mode");
            expect(mode?.common.write).to.be.true;
            expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.mode")?.val).to.equal("zero");
        });

        it("should store permissions as JSON string", async () => {
            await manager.updateBattery(testDevice, battery);

            const perms = adapter.states.get("hwe-p1_aabbccddeeff.battery.permissions");
            expect(perms?.val).to.equal(JSON.stringify(["charge_allowed", "discharge_allowed"]));

            const obj = adapter.objects.get("hwe-p1_aabbccddeeff.battery.permissions");
            expect(obj?.common.role).to.equal("json");
        });

        it("should set battery count", async () => {
            await manager.updateBattery(testDevice, battery);

            expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.battery_count")?.val).to.equal(2);
        });

        it("should set power values with units", async () => {
            await manager.updateBattery(testDevice, battery);

            expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.power_w")?.val).to.equal(-500);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.target_power_w")?.val).to.equal(0);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.max_consumption_w")?.val).to.equal(800);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.max_production_w")?.val).to.equal(800);

            const powerObj = adapter.objects.get("hwe-p1_aabbccddeeff.battery.power_w");
            expect(powerObj?.common.unit).to.equal("W");
            expect(powerObj?.common.role).to.equal("value.power");
        });

        it("should skip optional fields when undefined", async () => {
            const minimal: BatteryControl = { mode: "standby" };
            await manager.updateBattery(testDevice, minimal);

            expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.mode")?.val).to.equal("standby");
            expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.permissions")).to.be.false;
            expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.battery_count")).to.be.false;
            expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.power_w")).to.be.false;
        });
    });

    describe("setDeviceConnected", () => {
        it("should set connected state to true", async () => {
            await manager.setDeviceConnected(testDevice, true);
            const state = adapter.states.get("hwe-p1_aabbccddeeff.info.connected");
            expect(state?.val).to.be.true;
            expect(state?.ack).to.be.true;
        });

        it("should set connected state to false", async () => {
            await manager.setDeviceConnected(testDevice, false);
            const state = adapter.states.get("hwe-p1_aabbccddeeff.info.connected");
            expect(state?.val).to.be.false;
        });
    });

    describe("removeDevice", () => {
        it("should remove all device objects and states", async () => {
            await manager.createDeviceStates(testDevice);
            await manager.updateMeasurement(testDevice, { power_w: 100 });

            // Verify things exist
            expect(adapter.objects.size).to.be.greaterThan(0);
            expect(adapter.states.size).to.be.greaterThan(0);

            await manager.removeDevice(testDevice);

            // All objects/states with the device prefix should be gone
            for (const key of adapter.objects.keys()) {
                expect(key.startsWith("hwe-p1_aabbccddeeff"), `Object not removed: ${key}`).to.be.false;
            }
            for (const key of adapter.states.keys()) {
                expect(key.startsWith("hwe-p1_aabbccddeeff"), `State not removed: ${key}`).to.be.false;
            }
        });
    });

    describe("updateMeasurement — boundary hardening", () => {
        it("silently drops non-object payload", async () => {
            await manager.updateMeasurement(testDevice, null as unknown as Measurement);
            await manager.updateMeasurement(testDevice, "junk" as unknown as Measurement);
            await manager.updateMeasurement(testDevice, [] as unknown as Measurement);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).to.be.false;
        });

        it("rejects NaN in number field", async () => {
            await manager.updateMeasurement(testDevice, { power_w: NaN } as unknown as Measurement);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).to.be.false;
        });

        it("rejects Infinity in number field", async () => {
            await manager.updateMeasurement(testDevice, { power_w: Infinity } as unknown as Measurement);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).to.be.false;
        });

        it("parses numeric string into number field", async () => {
            await manager.updateMeasurement(testDevice, { power_w: "123.45" } as unknown as Measurement);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_w")?.val).to.equal(123.45);
        });

        it("rejects object for number field", async () => {
            await manager.updateMeasurement(testDevice, { power_w: { val: 100 } } as unknown as Measurement);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).to.be.false;
        });

        it("rejects number for string field (meter_model)", async () => {
            await manager.updateMeasurement(testDevice, { meter_model: 42 } as unknown as Measurement);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.meter_model")).to.be.false;
        });

        it("rejects empty string for string field", async () => {
            await manager.updateMeasurement(testDevice, { meter_model: "" } as Measurement);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.meter_model")).to.be.false;
        });

        it("accepts coexistent valid + invalid fields (writes only valid)", async () => {
            await manager.updateMeasurement(testDevice, {
                power_w: 100,
                voltage_v: NaN,
                current_a: "2.5",
                frequency_hz: "not-a-number",
            } as unknown as Measurement);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_w")?.val).to.equal(100);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.voltage_v")).to.be.false;
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.current_a")?.val).to.equal(2.5);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.frequency_hz")).to.be.false;
        });

        it("external: skips non-object entries", async () => {
            await manager.updateMeasurement(testDevice, {
                external: ["not-an-object", null, 42],
            } as unknown as Measurement);
            // No ext channels created
            expect(adapter.objects.size).to.equal(1); // only measurement channel
        });

        it("external: skips entries without string type/unique_id", async () => {
            await manager.updateMeasurement(testDevice, {
                external: [
                    { type: 42, unique_id: "x", value: 1, unit: "m3", timestamp: "2026-01-01" },
                    { type: "gas_meter", unique_id: null, value: 1, unit: "m3", timestamp: "2026-01-01" },
                ],
            } as unknown as Measurement);
            const extKeys = Array.from(adapter.objects.keys()).filter(k => k.includes(".external."));
            expect(extKeys).to.have.length(0);
        });

        it("external: handles non-finite value (writes unit/timestamp only)", async () => {
            await manager.updateMeasurement(testDevice, {
                external: [
                    { type: "gas_meter", unique_id: "abc", value: NaN, unit: "m3", timestamp: "2026-01-01" },
                ],
            } as unknown as Measurement);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.external.gas_meter_abc.value")).to.be.false;
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_abc.unit")?.val).to.equal("m3");
            expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_abc.timestamp")?.val).to.equal("2026-01-01");
        });

        it("ignores empty external array", async () => {
            await manager.updateMeasurement(testDevice, { external: [] } as unknown as Measurement);
            const extKeys = Array.from(adapter.objects.keys()).filter(k => k.includes(".external"));
            expect(extKeys).to.have.length(0);
        });

        it("ignores non-array external field", async () => {
            await manager.updateMeasurement(testDevice, { external: "corrupted" } as unknown as Measurement);
            const extKeys = Array.from(adapter.objects.keys()).filter(k => k.includes(".external"));
            expect(extKeys).to.have.length(0);
        });
    });

    describe("updateSystem — boundary hardening", () => {
        it("silently drops non-object payload", async () => {
            await manager.updateSystem(testDevice, null as unknown as SystemInfo);
            await manager.updateSystem(testDevice, "garbage" as unknown as SystemInfo);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.info.wifi_rssi_db")).to.be.false;
        });

        it("rejects NaN rssi", async () => {
            await manager.updateSystem(testDevice, {
                wifi_rssi_db: NaN,
                uptime_s: 100,
                cloud_enabled: true,
                status_led_brightness_pct: 50,
                wifi_ssid: "x",
            } as unknown as SystemInfo);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.info.wifi_rssi_db")).to.be.false;
            expect(adapter.states.get("hwe-p1_aabbccddeeff.info.uptime_s")?.val).to.equal(100);
        });

        it("rejects non-boolean cloud_enabled", async () => {
            await manager.updateSystem(testDevice, {
                wifi_rssi_db: -60,
                uptime_s: 100,
                cloud_enabled: "yes",
                status_led_brightness_pct: 50,
                wifi_ssid: "x",
            } as unknown as SystemInfo);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.system.cloud_enabled")).to.be.false;
        });

        it("ignores api_v1_enabled when not boolean", async () => {
            await manager.updateSystem(testDevice, {
                wifi_rssi_db: -60,
                uptime_s: 100,
                cloud_enabled: true,
                status_led_brightness_pct: 50,
                wifi_ssid: "x",
                api_v1_enabled: 1,
            } as unknown as SystemInfo);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.system.api_v1_enabled")).to.be.false;
        });

        it("parses numeric string for led brightness", async () => {
            await manager.updateSystem(testDevice, {
                wifi_rssi_db: -60,
                uptime_s: 100,
                cloud_enabled: true,
                status_led_brightness_pct: "75",
                wifi_ssid: "x",
            } as unknown as SystemInfo);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.system.status_led_brightness_pct")?.val).to.equal(75);
        });
    });

    describe("updateBattery — boundary hardening", () => {
        it("silently drops non-object payload", async () => {
            await manager.updateBattery(testDevice, null as unknown as BatteryControl);
            await manager.updateBattery(testDevice, undefined as unknown as BatteryControl);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.mode")).to.be.false;
        });

        it("rejects non-string mode", async () => {
            await manager.updateBattery(testDevice, { mode: 42 } as unknown as BatteryControl);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.mode")).to.be.false;
        });

        it("rejects non-array permissions", async () => {
            await manager.updateBattery(testDevice, { mode: "zero", permissions: "read" } as unknown as BatteryControl);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.permissions")).to.be.false;
        });

        it("rejects NaN for battery_count", async () => {
            await manager.updateBattery(testDevice, { mode: "zero", battery_count: NaN } as unknown as BatteryControl);
            expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.battery_count")).to.be.false;
        });

        it("accepts numeric string for power_w", async () => {
            await manager.updateBattery(testDevice, { mode: "zero", power_w: "250" } as unknown as BatteryControl);
            expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.power_w")?.val).to.equal(250);
        });
    });
});
