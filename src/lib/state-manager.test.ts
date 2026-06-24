import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => {
  const i18nDir = join(__dirname, "../../admin/i18n");
  const i18nData: Record<string, Record<string, string>> = {};
  for (const f of readdirSync(i18nDir).filter((f) => f.endsWith(".json"))) {
    i18nData[f.replace(".json", "")] = JSON.parse(readFileSync(join(i18nDir, f), "utf8"));
  }
  return {
    I18n: {
      getTranslatedObject: vi.fn((key: string) => {
        const result: Record<string, string> = {};
        for (const [lang, translations] of Object.entries(i18nData)) {
          result[lang] = translations[key] ?? key;
        }
        return result;
      }),
      translate: vi.fn((key: string) => i18nData.en?.[key] ?? key),
    },
  };
});

import { MEASUREMENT_STATE_DEFS, MOMENTARY_KEYS, StateManager } from "./state-manager";
import type { DeviceConfig, Measurement, SystemInfo, BatteryControl } from "./types";

interface CommonNameTranslated {
  en: string;
  de: string;
  [key: string]: string;
}
interface ObjectDef {
  type: string;
  common: Record<string, unknown>;
  native: Record<string, unknown>;
}

interface MockAdapterMetrics {
  setObjectNotExistsCalls: number;
  /** Count of actual state writes (setStateAsync always; setStateChangedAsync only on change). */
  stateWrites: number;
}

interface StateValue {
  val: unknown;
  ack: boolean;
}

interface MockAdapter {
  namespace: string;
  language: string;
  objects: Map<string, ObjectDef>;
  states: Map<string, StateValue>;
  metrics: MockAdapterMetrics;
  log: { debug: (msg: string) => void };
  extendObjectAsync: (
    id: string,
    obj: Partial<ObjectDef>,
    options?: { preserve?: { common?: string[] } },
  ) => Promise<void>;
  setObjectNotExistsAsync: (id: string, obj: Partial<ObjectDef>) => Promise<void>;
  setObjectAsync: (id: string, obj: Partial<ObjectDef>) => Promise<void>;
  getObjectAsync: (id: string) => Promise<ObjectDef | null>;
  setStateAsync: (id: string, state: StateValue) => Promise<void>;
  setStateChangedAsync: (id: string, state: StateValue) => Promise<void>;
  delObjectAsync: (id: string, opts?: { recursive: boolean }) => Promise<void>;
}

function createMockAdapter(): MockAdapter {
  const objects = new Map<string, ObjectDef>();
  const states = new Map<string, StateValue>();
  const metrics: MockAdapterMetrics = { setObjectNotExistsCalls: 0, stateWrites: 0 };

  return {
    namespace: "homewizard.0",
    language: "en",
    objects,
    states,
    metrics,
    log: { debug: (): void => {} },
    extendObjectAsync: async (
      id: string,
      obj: Partial<ObjectDef>,
      options?: { preserve?: { common?: string[] } },
    ): Promise<void> => {
      const existing = objects.get(id) || { type: "", common: {}, native: {} };
      const newCommon: Record<string, unknown> = { ...existing.common, ...(obj.common || {}) };
      if (options?.preserve?.common && objects.has(id)) {
        for (const key of options.preserve.common) {
          if (key in existing.common) {
            newCommon[key] = existing.common[key];
          }
        }
      }
      objects.set(id, {
        type: obj.type || existing.type,
        common: newCommon,
        native: { ...existing.native, ...(obj.native || {}) },
      });
    },
    setObjectNotExistsAsync: async (id: string, obj: Partial<ObjectDef>): Promise<void> => {
      metrics.setObjectNotExistsCalls++;
      if (objects.has(id)) {
        return;
      }
      objects.set(id, {
        type: obj.type || "",
        common: obj.common || {},
        native: obj.native || {},
      });
    },
    setObjectAsync: async (id: string, obj: Partial<ObjectDef>): Promise<void> => {
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
      metrics.stateWrites++;
      states.set(id, state);
    },
    // Faithful to ioBroker: write only when the value actually changed.
    setStateChangedAsync: async (id: string, state: StateValue): Promise<void> => {
      const prev = states.get(id);
      if (prev && prev.val === state.val) {
        return;
      }
      metrics.stateWrites++;
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

describe("MOMENTARY_KEYS invariant", () => {
  it("every momentary key references an existing measurement def (typo guard)", () => {
    // A MOMENTARY_KEYS entry without a matching def key would silently do
    // nothing — the field would fall back to changed-only writes and the
    // 1/s push optimization would quietly stop applying to it.
    const defKeys = new Set(MEASUREMENT_STATE_DEFS.map(d => d.key));
    const orphans = [...MOMENTARY_KEYS].filter(k => !defKeys.has(k));
    expect(orphans).toEqual([]);
  });

  it("momentary keys are the instantaneous electrical values, not totals/metadata", () => {
    // Energy totals and metadata must NOT be momentary — they change slowly,
    // so skipping redundant writes (setStateChangedAsync) is the whole point.
    for (const slowKey of ["energy_import_kwh", "energy_export_kwh", "tariff", "meter_model", "timestamp"]) {
      expect(MOMENTARY_KEYS.has(slowKey), `${slowKey} must not be momentary`).toBe(false);
    }
  });
});

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
      expect(prefix).toBe("hwe-p1_aabbccddeeff");
    });

    it("should replace special characters with underscore", () => {
      const device: DeviceConfig = {
        ...testDevice,
        productType: "HWE/P1.v2",
        serial: "aa:bb:cc",
      };
      const prefix = manager.devicePrefix(device);
      expect(prefix).toBe("hwe_p1_v2_aa_bb_cc");
    });

    it("should lowercase the prefix", () => {
      const device: DeviceConfig = {
        ...testDevice,
        productType: "HWE-KWH3",
        serial: "AABBCC",
      };
      const prefix = manager.devicePrefix(device);
      expect(prefix).toBe("hwe-kwh3_aabbcc");
    });
  });

  describe("createDeviceStates", () => {
    it("should create device object with productName as plain string (device-specific identifier, not translated)", async () => {
      await manager.createDeviceStates(testDevice);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff");
      expect(obj).not.toBeUndefined();
      expect(obj!.type).toBe("device");
      // Device names stay as plain strings — they are user/hardware identifiers, not localizable.
      expect(obj!.common.name).toBe("P1 Meter");
    });

    it("should create info channel with translated name", async () => {
      await manager.createDeviceStates(testDevice);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.info");
      expect(obj).not.toBeUndefined();
      expect(obj!.type).toBe("channel");
      const name = obj!.common.name as CommonNameTranslated;
      expect(name.en).toBe("Device Information");
      expect(name.de).toBe("Geräteinformationen");
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
        expect(adapter.objects.has(id)).toBe(true);
      }
    });

    it("should set initial productName and productType values", async () => {
      await manager.createDeviceStates(testDevice);
      const name = adapter.states.get("hwe-p1_aabbccddeeff.info.productName");
      expect(name?.val).toBe("P1 Meter");
      expect(name?.ack).toBe(true);

      const type = adapter.states.get("hwe-p1_aabbccddeeff.info.productType");
      expect(type?.val).toBe("HWE-P1");
    });

    it("should use productType as name fallback", async () => {
      const device: DeviceConfig = { ...testDevice, productName: "" };
      await manager.createDeviceStates(device);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff");
      expect(obj!.common.name).toBe("HWE-P1");
    });

    it("should create remove button with translated name + desc + read:false + initial value", async () => {
      await manager.createDeviceStates(testDevice);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.remove");
      expect(obj).not.toBeUndefined();
      expect(obj!.common.role).toBe("button");
      expect(obj!.common.read).toBe(false);
      expect(obj!.common.write).toBe(true);
      const name = obj!.common.name as CommonNameTranslated;
      expect(name.en).toBe("Remove device");
      expect(name.de).toBe("Gerät entfernen");
      const desc = obj!.common.desc as CommonNameTranslated;
      expect(desc.en).toContain("disconnect");
      expect(desc.de).toContain("trennen");

      const state = adapter.states.get("hwe-p1_aabbccddeeff.remove");
      expect(state).not.toBeUndefined();
      expect(state!.val).toBe(false);
      expect(state!.ack).toBe(true);
    });

    it("should preserve user-modified info channel name on re-create", async () => {
      await manager.createDeviceStates(testDevice);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.info")!;
      obj.common.name = "My Custom Name";
      await manager.createDeviceStates(testDevice);
      const after = adapter.objects.get("hwe-p1_aabbccddeeff.info")!;
      expect(after.common.name).toBe("My Custom Name");
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
      expect(power?.val).toBe(1234);
      expect(power?.ack).toBe(true);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_l1_w")?.val).toBe(400);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_l2_w")?.val).toBe(500);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_l3_w")?.val).toBe(334);
    });

    it("should create state objects with correct roles and units", async () => {
      const data: Measurement = { power_w: 100, voltage_l1_v: 230.5 };
      await manager.updateMeasurement(testDevice, data);

      const powerObj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.power_w");
      expect(powerObj?.common.role).toBe("value.power");
      expect(powerObj?.common.unit).toBe("W");

      const voltObj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.voltage_l1_v");
      expect(voltObj?.common.role).toBe("value.voltage");
      expect(voltObj?.common.unit).toBe("V");
    });

    it("should skip undefined/null values", async () => {
      const data: Measurement = { power_w: 100 };
      await manager.updateMeasurement(testDevice, data);

      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).toBe(true);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_l1_w")).toBe(false);
    });

    it("should handle energy import/export values", async () => {
      const data: Measurement = {
        energy_import_kwh: 12345.678,
        energy_export_kwh: 9876.543,
        energy_import_t1_kwh: 6000,
        energy_import_t2_kwh: 6345.678,
      };
      await manager.updateMeasurement(testDevice, data);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.energy_import_kwh")?.val).toBe(12345.678);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.energy_export_kwh")?.val).toBe(9876.543);

      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.energy_import_kwh");
      expect(obj?.common.unit).toBe("kWh");
      expect(obj?.common.role).toBe("value.energy");
    });

    it("should handle voltage quality counters in quality channel", async () => {
      const data: Measurement = {
        voltage_sag_l1_count: 3,
        voltage_swell_l2_count: 1,
        any_power_fail_count: 5,
      };
      await manager.updateMeasurement(testDevice, data);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.quality.voltage_sag_l1_count")?.val).toBe(3);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.quality.voltage_swell_l2_count")?.val).toBe(1);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.quality.power_fail_count")?.val).toBe(5);
    });

    it("should handle battery-specific fields", async () => {
      const data: Measurement = {
        state_of_charge_pct: 85,
        cycles: 142,
      };
      await manager.updateMeasurement(testDevice, data);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.state_of_charge_pct")?.val).toBe(85);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.state_of_charge_pct");
      expect(obj?.common.role).toBe("value.battery");
      expect(obj?.common.unit).toBe("%");
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
      expect(extChannel?.type).toBe("channel");

      // Gas meter channel
      const gasChannel = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_gas001");
      expect(gasChannel?.type).toBe("channel");

      // Values
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_gas001.value")?.val).toBe(1234.567);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_gas001.unit")?.val).toBe("m3");
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_gas001.timestamp")?.val).toBe(
        "2026-04-04T12:00:00",
      );
    });

    it("should handle multiple external meters", async () => {
      const data: Measurement = {
        external: [
          { unique_id: "gas1", type: "gas_meter", timestamp: "t1", value: 100, unit: "m3" },
          { unique_id: "water1", type: "water_meter", timestamp: "t2", value: 50, unit: "l" },
        ],
      };
      await manager.updateMeasurement(testDevice, data);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_gas1.value")?.val).toBe(100);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.water_meter_water1.value")?.val).toBe(50);
    });

    it("should handle empty measurement", async () => {
      const data: Measurement = {};
      await manager.updateMeasurement(testDevice, data);
      // No states should be created (besides any from previous calls)
      expect(adapter.states.size).toBe(0);
    });

    it("should handle metadata fields and add common.states map for tariff", async () => {
      const data: Measurement = {
        meter_model: "Landis+Gyr E350",
        timestamp: "2026-04-04T12:00:00",
        tariff: 2,
      };
      await manager.updateMeasurement(testDevice, data);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.meter_model")?.val).toBe("Landis+Gyr E350");
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.timestamp")?.val).toBe("2026-04-04T12:00:00");
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.tariff")?.val).toBe(2);

      // tariff dropdown labels are plain-string in system language
      // (Admin renders states-values as React child; translation objects
      // trigger React Error #31 → "Error in GUI" on dropdown open).
      const tariffObj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.tariff");
      const states = tariffObj!.common.states as Record<string, string>;
      expect(states["1"]).toContain("Tariff 1");
      expect(states["4"]).toContain("Tariff 4");
      for (const v of Object.values(states)) {
        expect(typeof v).toBe("string");
      }
    });

    it("should attach common.desc for power-quality and Belgian capacity tariff states", async () => {
      await manager.updateMeasurement(testDevice, {
        voltage_sag_l1_count: 1,
        any_power_fail_count: 1,
        average_power_15m_w: 1500,
        power_factor: 0.98,
      });
      const sagDesc = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.quality.voltage_sag_l1_count")!.common
        .desc as CommonNameTranslated;
      expect(sagDesc.en).toContain("voltage sag");
      const failDesc = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.quality.power_fail_count")!.common
        .desc as CommonNameTranslated;
      expect(failDesc.en).toContain("outages");
      const avgDesc = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.average_power_15m_w")!.common
        .desc as CommonNameTranslated;
      expect(avgDesc.en).toContain("Belgian");
      const pfDesc = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.power_factor")!.common
        .desc as CommonNameTranslated;
      expect(pfDesc.en).toContain("active to apparent");
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

    it("skips redundant writes when an identical system poll repeats (changed-only, Design-Decision 11) — D4-3", async () => {
      await manager.updateSystem(testDevice, system);
      const writesAfterFirst = adapter.metrics.stateWrites;
      await manager.updateSystem(testDevice, system); // identical → all changed-only system fields skip
      expect(adapter.metrics.stateWrites).toBe(writesAfterFirst);
    });

    it("should update wifi and uptime in info channel", async () => {
      await manager.updateSystem(testDevice, system);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.info.wifi_rssi_db")?.val).toBe(-65);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.info.uptime_s")?.val).toBe(3600);
    });

    it("should create system channel with translated name", async () => {
      await manager.updateSystem(testDevice, system);

      const channel = adapter.objects.get("hwe-p1_aabbccddeeff.system");
      expect(channel?.type).toBe("channel");
      const name = channel!.common.name as CommonNameTranslated;
      expect(name.en).toBe("System Settings");
      expect(name.de).toBe("Systemeinstellungen");
    });

    it("should create writable system states", async () => {
      await manager.updateSystem(testDevice, system);

      const cloud = adapter.objects.get("hwe-p1_aabbccddeeff.system.cloud_enabled");
      expect(cloud?.common.write).toBe(true);
      expect(cloud?.common.role).toBe("switch");
      expect(adapter.states.get("hwe-p1_aabbccddeeff.system.cloud_enabled")?.val).toBe(true);

      const led = adapter.objects.get("hwe-p1_aabbccddeeff.system.status_led_brightness_pct");
      expect(led?.common.write).toBe(true);
      expect(led?.common.unit).toBe("%");
      expect(adapter.states.get("hwe-p1_aabbccddeeff.system.status_led_brightness_pct")?.val).toBe(50);
    });

    it("should create api_v1_enabled when present", async () => {
      await manager.updateSystem(testDevice, system);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.system.api_v1_enabled")?.val).toBe(false);
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

      expect(adapter.states.has("hwe-p1_aabbccddeeff.system.api_v1_enabled")).toBe(false);
    });

    it("should create reboot and identify buttons with translated names + read:false + initial value", async () => {
      await manager.updateSystem(testDevice, system);

      const reboot = adapter.objects.get("hwe-p1_aabbccddeeff.system.reboot");
      expect(reboot?.common.role).toBe("button");
      expect(reboot?.common.write).toBe(true);
      expect(reboot?.common.read).toBe(false);
      const rebootName = reboot!.common.name as CommonNameTranslated;
      expect(rebootName.en).toBe("Reboot device");
      expect(rebootName.de).toBe("Gerät neu starten");

      const identify = adapter.objects.get("hwe-p1_aabbccddeeff.system.identify");
      expect(identify?.common.role).toBe("button");
      expect(identify?.common.write).toBe(true);
      expect(identify?.common.read).toBe(false);
      const identifyName = identify!.common.name as CommonNameTranslated;
      expect(identifyName.en).toContain("Identify");
      expect(identifyName.de).toContain("Identifizieren");

      // Buttons should have initial state value
      const rebootState = adapter.states.get("hwe-p1_aabbccddeeff.system.reboot");
      expect(rebootState).not.toBeUndefined();
      expect(rebootState!.val).toBe(false);

      const identifyState = adapter.states.get("hwe-p1_aabbccddeeff.system.identify");
      expect(identifyState).not.toBeUndefined();
      expect(identifyState!.val).toBe(false);
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

    it("should create battery channel with translated name", async () => {
      await manager.updateBattery(testDevice, battery);

      const channel = adapter.objects.get("hwe-p1_aabbccddeeff.battery");
      expect(channel?.type).toBe("channel");
      const name = channel!.common.name as CommonNameTranslated;
      expect(name.en).toBe("Battery Control");
      expect(name.de).toBe("Batteriesteuerung");
    });

    it("should create writable mode state with common.states translation map", async () => {
      await manager.updateBattery(testDevice, battery);

      const mode = adapter.objects.get("hwe-p1_aabbccddeeff.battery.mode");
      expect(mode?.common.write).toBe(true);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.mode")?.val).toBe("zero");

      // Dropdown labels — plain-string in system language
      // (translation-object as states-value → React Error #31 in Admin)
      const states = mode!.common.states as Record<string, string>;
      expect(states.zero).toContain("Zero");
      expect(states.to_full).toContain("To full");
      expect(states.standby).toBe("Standby");
      for (const v of Object.values(states)) {
        expect(typeof v).toBe("string");
      }
    });

    it("should store permissions as JSON string", async () => {
      await manager.updateBattery(testDevice, battery);

      const perms = adapter.states.get("hwe-p1_aabbccddeeff.battery.permissions");
      expect(perms?.val).toBe(JSON.stringify(["charge_allowed", "discharge_allowed"]));

      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.battery.permissions");
      expect(obj?.common.role).toBe("json");
    });

    it("should set battery count", async () => {
      await manager.updateBattery(testDevice, battery);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.battery_count")?.val).toBe(2);
    });

    it("should set power values with units", async () => {
      await manager.updateBattery(testDevice, battery);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.power_w")?.val).toBe(-500);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.target_power_w")?.val).toBe(0);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.max_consumption_w")?.val).toBe(800);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.max_production_w")?.val).toBe(800);

      const powerObj = adapter.objects.get("hwe-p1_aabbccddeeff.battery.power_w");
      expect(powerObj?.common.unit).toBe("W");
      expect(powerObj?.common.role).toBe("value.power");
    });

    it("should skip optional fields when undefined", async () => {
      const minimal: BatteryControl = { mode: "standby" };
      await manager.updateBattery(testDevice, minimal);

      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.mode")?.val).toBe("standby");
      expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.permissions")).toBe(false);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.battery_count")).toBe(false);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.power_w")).toBe(false);
    });
  });

  describe("common.states plain-string invariant (React #31, v0.7.6)", () => {
    it("tariff common.states VALUES are plain-string in system language", async () => {
      await manager.updateMeasurement(testDevice, { tariff: 2 });
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.tariff");
      const states = obj!.common.states as Record<string, unknown>;
      for (const [k, v] of Object.entries(states)) {
        expect(typeof v).toBe("string");
      }
    });

    it("battery.mode common.states VALUES are plain-string in system language", async () => {
      const battery: BatteryControl = { mode: "zero" };
      await manager.updateBattery(testDevice, battery);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.battery.mode");
      const states = obj!.common.states as Record<string, unknown>;
      for (const [k, v] of Object.entries(states)) {
        expect(typeof v).toBe("string");
      }
    });

    it("repairs existing object that has translation-object VALUES in common.states", async () => {
      // Seed object with the buggy shape that v0.7.0-v0.7.5 wrote
      adapter.objects.set("hwe-p1_aabbccddeeff.measurement.tariff", {
        type: "state",
        common: {
          name: "Tariff",
          type: "number",
          role: "value",
          read: true,
          write: false,
          states: {
            1: { en: "Tariff 1", de: "Tarif 1" } as unknown as string,
            2: { en: "Tariff 2", de: "Tarif 2" } as unknown as string,
          },
        },
        native: {},
      });
      await manager.updateMeasurement(testDevice, { tariff: 1 });
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.tariff");
      const states = obj!.common.states as Record<string, unknown>;
      // After repair: all values plain-string, all 4 tariff keys present
      expect(Object.keys(states)).toHaveLength(4);
      for (const v of Object.values(states)) {
        expect(typeof v).toBe("string");
      }
    });
  });

  describe("setDeviceConnected", () => {
    it("should set connected state to true", async () => {
      await manager.setDeviceConnected(testDevice, true);
      const state = adapter.states.get("hwe-p1_aabbccddeeff.info.connected");
      expect(state?.val).toBe(true);
      expect(state?.ack).toBe(true);
    });

    it("should set connected state to false", async () => {
      await manager.setDeviceConnected(testDevice, false);
      const state = adapter.states.get("hwe-p1_aabbccddeeff.info.connected");
      expect(state?.val).toBe(false);
    });
  });

  describe("createdIds cache (hot-path performance)", () => {
    it("calls setObjectNotExistsAsync only once per state across repeated updateMeasurement calls", async () => {
      // First call creates 4 states.
      await manager.updateMeasurement(testDevice, {
        power_w: 100,
        voltage_l1_v: 230,
        current_l1_a: 0.5,
        frequency_hz: 50,
      });
      const firstPass = adapter.metrics.setObjectNotExistsCalls;
      // Second call with the same fields must NOT re-touch setObjectNotExistsAsync
      // for those same IDs — they are cached after the first creation.
      await manager.updateMeasurement(testDevice, {
        power_w: 200,
        voltage_l1_v: 231,
        current_l1_a: 0.6,
        frequency_hz: 49.9,
      });
      expect(adapter.metrics.setObjectNotExistsCalls).toBe(firstPass);
      // Values were updated.
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_w")?.val).toBe(200);
    });

    it("cache miss creates a state on next updateMeasurement when a new field shows up", async () => {
      await manager.updateMeasurement(testDevice, { power_w: 100 });
      const firstPass = adapter.metrics.setObjectNotExistsCalls;
      await manager.updateMeasurement(testDevice, { power_w: 200, voltage_l1_v: 230 });
      expect(adapter.metrics.setObjectNotExistsCalls).toBeGreaterThan(firstPass);
    });

    it("removeDevice clears the cache so re-pairing the same device re-creates states", async () => {
      await manager.createDeviceStates(testDevice);
      await manager.updateMeasurement(testDevice, { power_w: 100 });
      await manager.removeDevice(testDevice);
      const beforeRecreate = adapter.metrics.setObjectNotExistsCalls;
      // Re-pair: createDeviceStates + updateMeasurement must hit setObjectNotExists again
      await manager.createDeviceStates(testDevice);
      await manager.updateMeasurement(testDevice, { power_w: 50 });
      expect(adapter.metrics.setObjectNotExistsCalls).toBeGreaterThan(beforeRecreate);
    });
  });

  describe("WiFi RSSI uses dBm (B7)", () => {
    it("createDeviceStates declares unit dBm on info.wifi_rssi_db", async () => {
      await manager.createDeviceStates(testDevice);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.info.wifi_rssi_db");
      expect(obj?.common.unit).toBe("dBm");
    });

    it("updateSystem keeps unit dBm on info.wifi_rssi_db", async () => {
      await manager.updateSystem(testDevice, {
        wifi_ssid: "x",
        wifi_rssi_db: -65,
        uptime_s: 100,
        cloud_enabled: true,
        status_led_brightness_pct: 50,
      });
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.info.wifi_rssi_db");
      expect(obj?.common.unit).toBe("dBm");
      expect(adapter.states.get("hwe-p1_aabbccddeeff.info.wifi_rssi_db")?.val).toBe(-65);
    });
  });

  describe("removeDevice", () => {
    it("should remove all device objects and states", async () => {
      await manager.createDeviceStates(testDevice);
      await manager.updateMeasurement(testDevice, { power_w: 100 });

      // Verify things exist
      expect(adapter.objects.size).toBeGreaterThan(0);
      expect(adapter.states.size).toBeGreaterThan(0);

      await manager.removeDevice(testDevice);

      // All objects/states with the device prefix should be gone
      for (const key of adapter.objects.keys()) {
        expect(key.startsWith("hwe-p1_aabbccddeeff")).toBe(false);
      }
      for (const key of adapter.states.keys()) {
        expect(key.startsWith("hwe-p1_aabbccddeeff")).toBe(false);
      }
    });
  });

  describe("updateMeasurement — boundary hardening", () => {
    it("silently drops non-object payload", async () => {
      await manager.updateMeasurement(testDevice, null as unknown as Measurement);
      await manager.updateMeasurement(testDevice, "junk" as unknown as Measurement);
      await manager.updateMeasurement(testDevice, [] as unknown as Measurement);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).toBe(false);
    });

    it("rejects NaN in number field", async () => {
      await manager.updateMeasurement(testDevice, { power_w: NaN } as unknown as Measurement);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).toBe(false);
    });

    it("rejects Infinity in number field", async () => {
      await manager.updateMeasurement(testDevice, { power_w: Infinity } as unknown as Measurement);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).toBe(false);
    });

    it("parses numeric string into number field", async () => {
      await manager.updateMeasurement(testDevice, { power_w: "123.45" } as unknown as Measurement);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_w")?.val).toBe(123.45);
    });

    it("rejects object for number field", async () => {
      await manager.updateMeasurement(testDevice, { power_w: { val: 100 } } as unknown as Measurement);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).toBe(false);
    });

    it("rejects number for string field (meter_model)", async () => {
      await manager.updateMeasurement(testDevice, { meter_model: 42 } as unknown as Measurement);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.meter_model")).toBe(false);
    });

    it("rejects empty string for string field", async () => {
      await manager.updateMeasurement(testDevice, { meter_model: "" } as Measurement);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.meter_model")).toBe(false);
    });

    it("accepts coexistent valid + invalid fields (writes only valid)", async () => {
      await manager.updateMeasurement(testDevice, {
        power_w: 100,
        voltage_v: NaN,
        current_a: "2.5",
        frequency_hz: "not-a-number",
      } as unknown as Measurement);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_w")?.val).toBe(100);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.voltage_v")).toBe(false);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.current_a")?.val).toBe(2.5);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.frequency_hz")).toBe(false);
    });

    it("external: skips non-object entries", async () => {
      await manager.updateMeasurement(testDevice, {
        external: ["not-an-object", null, 42],
      } as unknown as Measurement);
      // No ext channels created
      expect(adapter.objects.size).toBe(1); // only measurement channel
    });

    it("external: skips entries without string type/unique_id", async () => {
      await manager.updateMeasurement(testDevice, {
        external: [
          { type: 42, unique_id: "x", value: 1, unit: "m3", timestamp: "2026-01-01" },
          { type: "gas_meter", unique_id: null, value: 1, unit: "m3", timestamp: "2026-01-01" },
        ],
      } as unknown as Measurement);
      const extKeys = Array.from(adapter.objects.keys()).filter(k => k.includes(".external."));
      expect(extKeys).toHaveLength(0);
    });

    it("external: handles non-finite value (writes unit/timestamp only)", async () => {
      await manager.updateMeasurement(testDevice, {
        external: [{ type: "gas_meter", unique_id: "abc", value: NaN, unit: "m3", timestamp: "2026-01-01" }],
      } as unknown as Measurement);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.external.gas_meter_abc.value")).toBe(false);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_abc.unit")?.val).toBe("m3");
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_abc.timestamp")?.val).toBe(
        "2026-01-01",
      );
    });

    it("ignores empty external array", async () => {
      await manager.updateMeasurement(testDevice, { external: [] } as unknown as Measurement);
      const extKeys = Array.from(adapter.objects.keys()).filter(k => k.includes(".external"));
      expect(extKeys).toHaveLength(0);
    });

    it("ignores non-array external field", async () => {
      await manager.updateMeasurement(testDevice, { external: "corrupted" } as unknown as Measurement);
      const extKeys = Array.from(adapter.objects.keys()).filter(k => k.includes(".external"));
      expect(extKeys).toHaveLength(0);
    });
  });

  describe("updateSystem — boundary hardening", () => {
    it("silently drops non-object payload", async () => {
      await manager.updateSystem(testDevice, null as unknown as SystemInfo);
      await manager.updateSystem(testDevice, "garbage" as unknown as SystemInfo);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.info.wifi_rssi_db")).toBe(false);
    });

    it("rejects NaN rssi", async () => {
      await manager.updateSystem(testDevice, {
        wifi_rssi_db: NaN,
        uptime_s: 100,
        cloud_enabled: true,
        status_led_brightness_pct: 50,
        wifi_ssid: "x",
      } as unknown as SystemInfo);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.info.wifi_rssi_db")).toBe(false);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.info.uptime_s")?.val).toBe(100);
    });

    it("rejects non-boolean cloud_enabled", async () => {
      await manager.updateSystem(testDevice, {
        wifi_rssi_db: -60,
        uptime_s: 100,
        cloud_enabled: "yes",
        status_led_brightness_pct: 50,
        wifi_ssid: "x",
      } as unknown as SystemInfo);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.system.cloud_enabled")).toBe(false);
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
      expect(adapter.states.has("hwe-p1_aabbccddeeff.system.api_v1_enabled")).toBe(false);
    });

    it("parses numeric string for led brightness", async () => {
      await manager.updateSystem(testDevice, {
        wifi_rssi_db: -60,
        uptime_s: 100,
        cloud_enabled: true,
        status_led_brightness_pct: "75",
        wifi_ssid: "x",
      } as unknown as SystemInfo);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.system.status_led_brightness_pct")?.val).toBe(75);
    });
  });

  describe("updateBattery — boundary hardening", () => {
    it("silently drops non-object payload", async () => {
      await manager.updateBattery(testDevice, null as unknown as BatteryControl);
      await manager.updateBattery(testDevice, undefined as unknown as BatteryControl);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.mode")).toBe(false);
    });

    it("rejects non-string mode", async () => {
      await manager.updateBattery(testDevice, { mode: 42 } as unknown as BatteryControl);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.mode")).toBe(false);
    });

    it("rejects non-array permissions", async () => {
      await manager.updateBattery(testDevice, { mode: "zero", permissions: "read" } as unknown as BatteryControl);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.permissions")).toBe(false);
    });

    it("rejects NaN for battery_count", async () => {
      await manager.updateBattery(testDevice, { mode: "zero", battery_count: NaN } as unknown as BatteryControl);
      expect(adapter.states.has("hwe-p1_aabbccddeeff.battery.battery_count")).toBe(false);
    });

    it("accepts numeric string for power_w", async () => {
      await manager.updateBattery(testDevice, { mode: "zero", power_w: "250" } as unknown as BatteryControl);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.power_w")?.val).toBe(250);
    });
  });

  describe("v0.10.0 — API v2 completeness", () => {
    const fullSystem: SystemInfo = {
      wifi_ssid: "MyNetwork",
      wifi_rssi_db: -65,
      uptime_s: 3600,
      cloud_enabled: true,
      status_led_brightness_pct: 50,
    };

    it("A4: createDeviceStates declares info.wifi_ssid (string/text)", async () => {
      await manager.createDeviceStates(testDevice);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.info.wifi_ssid");
      expect(obj?.type).toBe("state");
      expect(obj?.common.role).toBe("text");
    });

    it("A4: updateSystem writes info.wifi_ssid", async () => {
      await manager.updateSystem(testDevice, fullSystem);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.info.wifi_ssid")?.val).toBe("MyNetwork");
    });

    it("A1: battery.mode states include the predictive label", async () => {
      await manager.updateBattery(testDevice, { mode: "predictive" });
      const states = adapter.objects.get("hwe-p1_aabbccddeeff.battery.mode")!.common.states as Record<string, string>;
      expect(states.predictive).toContain("Predictive");
      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.mode")?.val).toBe("predictive");
    });

    it("A1: charge_to_full is created as a writable switch", async () => {
      await manager.updateBattery(testDevice, { mode: "zero", charge_to_full: true });
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.battery.charge_to_full");
      expect(obj?.common.role).toBe("switch");
      expect(obj?.common.write).toBe(true);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.charge_to_full")?.val).toBe(true);
    });

    it("A6: HWE-BAT gets no reboot button and a read-only cloud_enabled", async () => {
      const battery: DeviceConfig = { ...testDevice, productType: "HWE-BAT", serial: "bat001" };
      await manager.updateSystem(battery, fullSystem);
      expect(adapter.objects.has("hwe-bat_bat001.system.reboot")).toBe(false);
      expect(adapter.objects.has("hwe-bat_bat001.system.identify")).toBe(true);
      expect(adapter.objects.get("hwe-bat_bat001.system.cloud_enabled")?.common.write).toBe(false);
    });

    it("A6: non-battery device keeps reboot button and writable cloud_enabled", async () => {
      await manager.updateSystem(testDevice, fullSystem);
      expect(adapter.objects.has("hwe-p1_aabbccddeeff.system.reboot")).toBe(true);
      expect(adapter.objects.get("hwe-p1_aabbccddeeff.system.cloud_enabled")?.common.write).toBe(true);
    });
  });
});
