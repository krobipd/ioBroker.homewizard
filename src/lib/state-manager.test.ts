import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => {
  const i18nDir = join(__dirname, "../../admin/i18n");
  const i18nData: Record<string, Record<string, string>> = {};
  for (const f of readdirSync(i18nDir).filter(f => f.endsWith(".json"))) {
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

import { I18n } from "@iobroker/adapter-core";
import {
  EXTERNAL_METER_LEAF_KEYS,
  EXTERNAL_METER_TYPE_NAMES,
  LABELLED_OBJECT_IDS,
  MEASUREMENT_STATE_DEFS,
  MOMENTARY_KEYS,
} from "./state-defs";
import { StateManager } from "./state-manager";
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
  /** Count of extendObject calls — the DP-retrofit create path for states (createState). */
  extendObjectCalls: number;
  /** Count of actual state writes (setState always; setStateChangedAsync only on change). */
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
  /** Ids of every extendObject call that carried `preserve.common` — see the preserve-scope test. */
  preservedIds: string[];
  log: { debug: (msg: string) => void };
  extendObject: (id: string, obj: Partial<ObjectDef>, options?: { preserve?: { common?: string[] } }) => Promise<void>;
  setObjectNotExistsAsync: (id: string, obj: Partial<ObjectDef>) => Promise<void>;
  setForeignObject: (id: string, obj: Partial<ObjectDef>) => Promise<void>;
  getObjectAsync: (id: string) => Promise<ObjectDef | null>;
  setState: (id: string, state: StateValue) => Promise<void>;
  setStateChangedAsync: (id: string, state: StateValue) => Promise<void>;
  delObjectAsync: (id: string, opts?: { recursive: boolean }) => Promise<void>;
}

/**
 * Plain object in the sense node.extend uses (`is.hash`): not null, not an array.
 *
 * @param value The value to classify.
 */
function isHash(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `node.extend(true, target, source)` — the exact merge js-controller performs on
 * an `extendObject` (`objectsInRedisClient._extendObject`, the single merge site of
 * the object store).
 *
 * This is NOT the same as a spread of `common`, which is what this mock used to do.
 * Two differences decide real defects:
 *   • a key that exists only in the OLD object SURVIVES — a spread drops it, so a
 *     leftover entry in `common.states` was invisible here while it stays in a real
 *     tree forever (that is what `repairCommonStatesIfBuggy` is actually for);
 *   • an object value is merged key by key, not replaced wholesale.
 * A plain value (string, number, boolean) DOES overwrite an object — measured
 * against node.extend, contrary to what the repair's comment used to claim.
 *
 * @param target The stored object — merged into and returned.
 * @param source The update.
 */
function extendDeep(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [name, copy] of Object.entries(source)) {
    if (copy === target) {
      continue; // never-ending loop guard, as in node.extend
    }
    if (isHash(copy)) {
      const src = target[name];
      target[name] = extendDeep(isHash(src) ? src : {}, copy);
    } else if (Array.isArray(copy)) {
      // node.extend merges arrays BY INDEX; it does not replace them.
      const src = target[name];
      target[name] = extendDeep(
        (Array.isArray(src) ? src : []) as unknown as Record<string, unknown>,
        copy as unknown as Record<string, unknown>,
      );
    } else if (copy !== undefined) {
      target[name] = copy;
    }
  }
  return target;
}

/**
 * `tools.removePreservedProperties` — js-controller strips the preserved keys from
 * the UPDATE before merging, and only where the key exists on both sides.
 *
 * @param preserve The `preserve` option as passed to extendObject.
 * @param preserve.common The `common` keys whose stored value must survive.
 * @param oldObj   The stored object.
 * @param newObj   The update, modified in place.
 */
function removePreserved(
  preserve: { common?: string[] },
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
): void {
  for (const [prop, rmProps] of Object.entries(preserve)) {
    const oldProp = oldObj[prop];
    const newProp = newObj[prop];
    if (!Array.isArray(rmProps) || !isHash(oldProp) || !isHash(newProp)) {
      continue;
    }
    for (const rmProp of rmProps) {
      if (oldProp[rmProp] !== undefined && newProp[rmProp] !== undefined) {
        delete newProp[rmProp];
      }
    }
  }
}

function createMockAdapter(): MockAdapter {
  const objects = new Map<string, ObjectDef>();
  const states = new Map<string, StateValue>();
  const metrics: MockAdapterMetrics = { setObjectNotExistsCalls: 0, extendObjectCalls: 0, stateWrites: 0 };
  const preservedIds: string[] = [];

  return {
    namespace: "homewizard.0",
    language: "en",
    objects,
    states,
    metrics,
    preservedIds,
    log: { debug: (): void => {} },
    extendObject: (
      id: string,
      obj: Partial<ObjectDef>,
      options?: { preserve?: { common?: string[] } },
    ): Promise<void> => {
      metrics.extendObjectCalls++;
      if (options?.preserve?.common?.length) {
        preservedIds.push(id);
      }
      const existing = objects.get(id);
      // Same order as js-controller: clone the update, strip the preserved keys,
      // then deep-merge into the stored object — or, when there is none, store the
      // update as-is ("if old object is not existing, we behave like setObject").
      const update = structuredClone(obj) as Record<string, unknown>;
      if (!existing) {
        objects.set(id, {
          type: (update.type as string) || "",
          common: (update.common as Record<string, unknown>) || {},
          native: (update.native as Record<string, unknown>) || {},
        });
        return Promise.resolve();
      }
      if (options?.preserve) {
        removePreserved(options.preserve, existing as unknown as Record<string, unknown>, update);
      }
      objects.set(id, extendDeep(existing as unknown as Record<string, unknown>, update) as unknown as ObjectDef);
      return Promise.resolve();
    },
    setObjectNotExistsAsync: (id: string, obj: Partial<ObjectDef>): Promise<void> => {
      metrics.setObjectNotExistsCalls++;
      if (objects.has(id)) {
        return Promise.resolve();
      }
      objects.set(id, {
        type: obj.type || "",
        common: obj.common || {},
        native: obj.native || {},
      });
      return Promise.resolve();
    },
    // The adapter writes whole objects only through setForeignObject, with the full id.
    setForeignObject: (fullId: string, obj: Partial<ObjectDef>): Promise<void> => {
      const id = fullId.startsWith("homewizard.0.") ? fullId.slice("homewizard.0.".length) : fullId;
      objects.set(id, {
        type: obj.type || "",
        common: obj.common || {},
        native: obj.native || {},
      });
      return Promise.resolve();
    },
    // Like the controller, every read hands out a fresh copy — a change the code makes
    // on what it read must not reach the store without a write.
    getObjectAsync: (id: string): Promise<ObjectDef | null> => {
      const obj = objects.get(id);
      return Promise.resolve(obj ? structuredClone(obj) : null);
    },
    setState: (id: string, state: StateValue): Promise<void> => {
      metrics.stateWrites++;
      states.set(id, state);
      return Promise.resolve();
    },
    // Faithful to ioBroker: write only when the value OR the ack flag changed — the
    // controller compares both, so an unconfirmed user value equal to the device value
    // still gets confirmed.
    setStateChangedAsync: (id: string, state: StateValue): Promise<void> => {
      const prev = states.get(id);
      if (prev && prev.val === state.val && prev.ack === state.ack) {
        return Promise.resolve();
      }
      metrics.stateWrites++;
      states.set(id, state);
      return Promise.resolve();
    },
    // As in js-controller: without `recursive` only the object itself (and its value)
    // goes; with it, every object below the id goes too — even when the id itself has
    // no object any more.
    delObjectAsync: (id: string, opts?: { recursive: boolean }): Promise<void> => {
      const hit = (key: string): boolean => key === id || (!!opts?.recursive && key.startsWith(`${id}.`));
      for (const key of objects.keys()) {
        if (hit(key)) {
          objects.delete(key);
        }
      }
      for (const key of states.keys()) {
        if (hit(key)) {
          states.delete(key);
        }
      }
      return Promise.resolve();
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

    it("gives the device object the pictogram of its type — existing installations too", async () => {
      // An installation that updates already has the device object; the icon has to
      // reach it, not only a freshly paired device.
      adapter.objects.set("hwe-p1_aabbccddeeff", {
        type: "device",
        common: { name: "P1 Meter" },
        native: {},
      });
      await manager.createDeviceStates(testDevice);

      const icon = adapter.objects.get("hwe-p1_aabbccddeeff")!.common.icon as string;
      expect(icon.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(Buffer.from(icon.split(",")[1], "base64").toString("utf8")).toContain('viewBox="0 0 64 64"');
    });

    it("leaves the icon field untouched for a product type it has no drawing for", async () => {
      await manager.createDeviceStates({ ...testDevice, productType: "HWE-FUTURE" });
      const obj = adapter.objects.get("hwe-future_aabbccddeeff")!;
      expect(obj.common.icon).toBeUndefined();
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

    it("refreshes the info channel name so a corrected label reaches an existing installation", async () => {
      await manager.createDeviceStates(testDevice);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.info")!;
      // What an installation upgraded from an older version carries: the label
      // this adapter shipped back then. The channel name is the adapter's own
      // translated text, so a new version has to be able to replace it —
      // `preserve` here would freeze it forever and let the change reach fresh
      // installations only.
      obj.common.name = "Device Information";
      // An installation that carries an old label is one the adapter STARTS on —
      // a new process with an empty per-run cache. Driving the second pass through
      // the same manager would instead test the cache, which by design skips what
      // it has already written in this very run.
      await new StateManager(adapter as never).createDeviceStates(testDevice);
      const after = adapter.objects.get("hwe-p1_aabbccddeeff.info")!;
      expect(after.common.name).toEqual(expect.objectContaining({ en: expect.any(String) }));
      expect(after.common.name).not.toBe("Device Information");
    });

    it("puts a rename made in the object tree back to the device's own name", async () => {
      // The adapter owns every name in its own tree — the source of THIS one is the
      // device, so it follows the name in the HomeWizard app. A user's own data points
      // belong in `0_userdata`, not in an adapter's namespace.
      await manager.createDeviceStates(testDevice);
      adapter.objects.get("hwe-p1_aabbccddeeff")!.common.name = "Meter in the basement";

      await manager.createDeviceStates(testDevice);

      expect(adapter.objects.get("hwe-p1_aabbccddeeff")!.common.name).toBe("P1 Meter");
    });
  });

  describe("setProductName / setFirmware", () => {
    // Both are called from the periodic device-info fetch as well: a device renamed
    // in the app, or one that updated its own firmware, has to reach the tree while
    // the adapter runs — not only at the next start.
    it("writes the current name and firmware, and skips a write that changes nothing", async () => {
      await manager.createDeviceStates(testDevice);
      await manager.setFirmware(testDevice, "6.4");
      expect(adapter.states.get("hwe-p1_aabbccddeeff.info.firmware")?.val).toBe("6.4");

      const writes = adapter.metrics.stateWrites;
      await manager.setFirmware(testDevice, "6.4");
      expect(adapter.metrics.stateWrites, "the same version must not be written again").toBe(writes);

      await manager.setFirmware(testDevice, "6.5");
      expect(adapter.states.get("hwe-p1_aabbccddeeff.info.firmware")?.val).toBe("6.5");

      await manager.setProductName({ ...testDevice, productName: "Meter renamed in the app" });
      expect(adapter.states.get("hwe-p1_aabbccddeeff.info.productName")?.val).toBe("Meter renamed in the app");
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

    it("keeps writing momentary values even when they repeat, but skips slow ones", async () => {
      const data: Measurement = { power_w: 1234, energy_import_kwh: 42.5 };
      await manager.updateMeasurement(testDevice, data);
      const afterFirst = adapter.metrics.stateWrites;

      // Same numbers again — a 1 Hz meter reports an unchanged power reading all
      // the time. Routing power through changed-only would freeze its timestamp
      // and the value looks stale in every history/visualisation.
      await manager.updateMeasurement(testDevice, data);
      const momentaryWrites = adapter.metrics.stateWrites - afterFirst;
      expect(momentaryWrites, "power_w rewritten, energy total skipped").toBe(1);
    });

    it("builds each measurement object — and its translations — once, not on every push", async () => {
      const translate = I18n.getTranslatedObject as unknown as { mock: { calls: unknown[] } };
      const data: Measurement = { power_w: 100, voltage_l1_v: 230.5, energy_import_kwh: 1 };
      await manager.updateMeasurement(testDevice, data);
      const objectCalls = adapter.metrics.extendObjectCalls;
      const translations = translate.mock.calls.length;
      expect(objectCalls).toBeGreaterThan(0);
      expect(translations).toBeGreaterThan(0);

      // A P1 meter pushes ~30 fields once per second. The object write is
      // guarded twice over, but building the translated name/description for
      // every field on every push is pure allocation that is thrown away — the
      // exact waste the cold-path/hot-path split exists to remove.
      await manager.updateMeasurement(testDevice, { power_w: 101, voltage_l1_v: 231, energy_import_kwh: 2 });
      await manager.updateMeasurement(testDevice, { power_w: 102, voltage_l1_v: 232, energy_import_kwh: 3 });
      expect(adapter.metrics.extendObjectCalls).toBe(objectCalls);
      expect(translate.mock.calls.length, "no translation work on the hot path").toBe(translations);
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

    it("strips line breaks from a device-supplied external meter type before it becomes an object name", async () => {
      // The meter type is a device string that lands in common.name — a hostile
      // device must not carry CR/LF into the object tree (same rule as the
      // product name, L9). The object id is sanitised separately.
      await manager.updateMeasurement(testDevice, {
        external: [{ unique_id: "g1", type: "gas\nmeter", timestamp: "t", value: 1, unit: "m3" }],
      } as unknown as Measurement);
      const channel = [...adapter.objects.entries()].find(([k]) => k.includes(".external.gas_meter_g1"));
      expect(channel, "external meter channel created").toBeDefined();
      expect(channel![1].common.name).toBe("gas meter");
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
      const objectsAfterFirst = adapter.metrics.extendObjectCalls;
      await manager.updateSystem(testDevice, system); // identical → all changed-only system fields skip
      expect(adapter.metrics.stateWrites).toBe(writesAfterFirst);
      // The 60 s system poll must not re-touch its objects either: createState
      // uses extendObject (to retrofit changed `common` on upgraded installs),
      // so without the once-per-restart cache every poll would rewrite every
      // object — and re-run the common.states repair read on top.
      expect(adapter.metrics.extendObjectCalls, "no object churn on a repeat poll").toBe(objectsAfterFirst);
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
      expect(states.standby).toBe("Standby (legacy)");
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

    it("explains the sign of both battery power values the way the API reports it — charging is positive", async () => {
      // Official API v2 docs (docs/v2/batteries): with only charging allowed the
      // group reports target_power_w 400, with only discharging allowed -400, and
      // charge_to_full reports the positive consumption maximum.
      await manager.updateBattery(testDevice, battery);
      for (const id of ["battery.power_w", "battery.target_power_w"]) {
        const desc = adapter.objects.get(`hwe-p1_aabbccddeeff.${id}`)?.common.desc as Record<string, string>;
        expect(desc.en).toMatch(/positive means charging, negative means discharging/);
        expect(desc.de).toMatch(/positiv bedeutet Laden, negativ Entladen/);
      }
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
      for (const v of Object.values(states)) {
        expect(typeof v).toBe("string");
      }
    });

    it("battery.mode common.states VALUES are plain-string in system language", async () => {
      const battery: BatteryControl = { mode: "zero" };
      await manager.updateBattery(testDevice, battery);
      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.battery.mode");
      const states = obj!.common.states as Record<string, unknown>;
      for (const v of Object.values(states)) {
        expect(typeof v).toBe("string");
      }
    });

    it("a leftover states key from an older version is thrown out, not merged along", async () => {
      // The case the repair actually exists for, and the one a deep merge cannot
      // fix by itself: a key the CURRENT map no longer carries. It survives every
      // extendObject forever, and while it holds a translation object, opening the
      // dropdown in Admin dies with React error #31.
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
            T1: { en: "Tariff 1", de: "Tarif 1" } as unknown as string,
          },
        },
        native: {},
      });

      await manager.updateMeasurement(testDevice, { tariff: 1 });

      const states = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.tariff")!.common.states as Record<
        string,
        unknown
      >;
      expect(Object.keys(states).sort()).toEqual(["1", "2", "3", "4"]);
      for (const v of Object.values(states)) {
        expect(typeof v).toBe("string");
      }
    });

    it("a states key the new map also carries is replaced by the merge itself", async () => {
      // Measured against node.extend(true, …): a plain string DOES overwrite an
      // object value. Held here so the repair above is never justified with a
      // mechanism that does not exist.
      adapter.objects.set("hwe-p1_aabbccddeeff.measurement.tariff", {
        type: "state",
        common: {
          name: "Tariff",
          type: "number",
          role: "value",
          read: true,
          write: false,
          states: { 1: { en: "Tariff 1" } as unknown as string },
        },
        native: {},
      });

      await manager.updateMeasurement(testDevice, { tariff: 1 });

      const obj = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.tariff")!;
      expect(typeof (obj.common.states as Record<string, unknown>)["1"]).toBe("string");
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

  describe("markAllDisconnected / writeDeviceRollup (shutdown + summary writes)", () => {
    it("markAllDisconnected sets every given device to not connected", async () => {
      const second: DeviceConfig = { ...testDevice, serial: "112233445566" };
      await manager.setDeviceConnected(testDevice, true);
      await manager.setDeviceConnected(second, true);
      await manager.markAllDisconnected([testDevice, second]);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.info.connected")?.val).toBe(false);
      expect(adapter.states.get("hwe-p1_112233445566.info.connected")?.val).toBe(false);
    });

    it("writeDeviceRollup: allOnline only when EVERY set-up device answers, never for an empty setup", async () => {
      await manager.writeDeviceRollup(2, 1);
      expect(adapter.states.get("info.devicesTotal")?.val).toBe(2);
      expect(adapter.states.get("info.devicesOnline")?.val).toBe(1);
      // One of two answering is not "all of them".
      expect(adapter.states.get("info.devicesAllOnline")?.val).toBe(false);
      await manager.writeDeviceRollup(2, 2);
      expect(adapter.states.get("info.devicesAllOnline")?.val).toBe(true);
      // No device paired: "all connected" would be a success message for an empty setup.
      await manager.writeDeviceRollup(0, 0);
      expect(adapter.states.get("info.devicesAllOnline")?.val).toBe(false);
    });
  });

  describe("createdIds cache (hot-path performance)", () => {
    it("creates each measurement state only once across repeated updateMeasurement calls", async () => {
      // First call creates 4 states (DP-retrofit path = extendObject).
      await manager.updateMeasurement(testDevice, {
        power_w: 100,
        voltage_l1_v: 230,
        current_l1_a: 0.5,
        frequency_hz: 50,
      });
      const firstPass = adapter.metrics.extendObjectCalls;
      // Second call with the same fields must NOT re-touch the object create
      // for those same IDs — they are cached (createdIds) after the first creation.
      await manager.updateMeasurement(testDevice, {
        power_w: 200,
        voltage_l1_v: 231,
        current_l1_a: 0.6,
        frequency_hz: 49.9,
      });
      expect(adapter.metrics.extendObjectCalls).toBe(firstPass);
      // Values were updated.
      expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.power_w")?.val).toBe(200);
    });

    it("cache miss creates a state on next updateMeasurement when a new field shows up", async () => {
      await manager.updateMeasurement(testDevice, { power_w: 100 });
      const firstPass = adapter.metrics.extendObjectCalls;
      await manager.updateMeasurement(testDevice, { power_w: 200, voltage_l1_v: 230 });
      expect(adapter.metrics.extendObjectCalls).toBeGreaterThan(firstPass);
    });

    it("removeDevice clears the cache so re-pairing the same device re-creates states", async () => {
      await manager.createDeviceStates(testDevice);
      await manager.updateMeasurement(testDevice, { power_w: 100 });
      await manager.removeDevice(testDevice);
      const beforeRecreate = adapter.metrics.extendObjectCalls;
      // Re-pair: createDeviceStates + updateMeasurement must write the objects again
      await manager.createDeviceStates(testDevice);
      await manager.updateMeasurement(testDevice, { power_w: 50 });
      expect(adapter.metrics.extendObjectCalls).toBeGreaterThan(beforeRecreate);
    });
  });

  describe("DP-retrofit: schema AND name changes reach existing installs", () => {
    const batDevice: DeviceConfig = {
      token: "t",
      productType: "HWE-BAT",
      serial: "bat123456789",
      productName: "Plug-In Battery",
    };

    it("updates cloud_enabled role switch→indicator AND the label on an already-existing state (M3)", async () => {
      const id = "hwe-bat_bat123456789.system.cloud_enabled";
      // Simulate an install from before the M3 fix: the object already exists
      // with the old switch role and the fixed English label of that version.
      adapter.objects.set(id, {
        type: "state",
        common: { name: "Cloud", type: "boolean", role: "switch", read: true, write: false },
        native: {},
      });
      await manager.updateSystem(batDevice, {
        wifi_ssid: "net",
        wifi_rssi_db: -50,
        uptime_s: 1,
        cloud_enabled: true,
        status_led_brightness_pct: 50,
      });
      const obj = adapter.objects.get(id);
      // extendObject retrofit reached the existing state...
      expect(obj?.common.role).toBe("indicator");
      // ...and so did the label: this name is the adapter's own translated text,
      // so it must NOT be preserved — otherwise a corrected wording reaches
      // fresh installations only and no gate ever notices.
      expect(obj?.common.name).toEqual(expect.objectContaining({ en: expect.any(String) }));
    });

    it("retrofits min/max onto an already-existing status_led_brightness_pct state (L11)", async () => {
      const id = "hwe-bat_bat123456789.system.status_led_brightness_pct";
      adapter.objects.set(id, {
        type: "state",
        common: { name: "LED", type: "number", role: "level", read: true, write: true },
        native: {},
      });
      await manager.updateSystem(batDevice, {
        wifi_ssid: "net",
        wifi_rssi_db: -50,
        uptime_s: 1,
        cloud_enabled: true,
        status_led_brightness_pct: 50,
      });
      const obj = adapter.objects.get(id);
      expect(obj?.common.min).toBe(0);
      expect(obj?.common.max).toBe(100);
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

  describe("cleanupMovedStates", () => {
    it("deletes the pre-v0.4.0 device-root paths and the retired telegram state", async () => {
      // What an installation from before the measurement/ channel carries: the
      // values sat directly under the device, plus the raw P1 telegram that
      // v0.11.0 retired.
      const prefix = "hwe-p1_aabbccddeeff";
      for (const id of [`${prefix}.power_w`, `${prefix}.external`, `${prefix}.measurement.telegram`]) {
        adapter.objects.set(id, { type: "state", common: {}, native: {} });
      }
      // …and one that must survive: the current location of the same value.
      adapter.objects.set(`${prefix}.measurement.power_w`, { type: "state", common: {}, native: {} });
      const existing = new Set([...adapter.objects.keys()].map(id => `homewizard.0.${id}`));

      await manager.cleanupMovedStates(testDevice, existing);

      expect(adapter.objects.has(`${prefix}.power_w`)).toBe(false);
      expect(adapter.objects.has(`${prefix}.external`)).toBe(false);
      expect(adapter.objects.has(`${prefix}.measurement.telegram`)).toBe(false);
      expect(adapter.objects.has(`${prefix}.measurement.power_w`)).toBe(true);
    });

    it("deletes nothing when the tree holds none of the old paths", async () => {
      adapter.objects.set("hwe-p1_aabbccddeeff.measurement.power_w", { type: "state", common: {}, native: {} });
      const before = adapter.objects.size;

      await manager.cleanupMovedStates(testDevice, new Set(["homewizard.0.hwe-p1_aabbccddeeff.measurement.power_w"]));

      expect(adapter.objects.size).toBe(before);
    });
  });

  describe("removeBatteryStates", () => {
    it("removes the whole battery branch and reports that it did", async () => {
      await manager.createDeviceStates(testDevice);
      await manager.updateBattery(testDevice, {
        mode: "zero",
        battery_count: 1,
        power_w: 10,
      } as unknown as BatteryControl);
      expect(adapter.objects.has("hwe-p1_aabbccddeeff.battery.power_w")).toBe(true);

      const removed = await manager.removeBatteryStates(testDevice);

      expect(removed).toBe(true);
      expect([...adapter.objects.keys()].filter(id => id.includes(".battery"))).toEqual([]);
      // The rest of the device is untouched — this removes a branch, not a device.
      expect(adapter.objects.has("hwe-p1_aabbccddeeff")).toBe(true);
    });

    it("reports false when there is no battery branch — the caller must not log a removal", async () => {
      expect(await manager.removeBatteryStates(testDevice)).toBe(false);
    });

    it("drops the branch from the created-ids cache so a returning battery is rebuilt", async () => {
      await manager.updateBattery(testDevice, { mode: "zero", battery_count: 1 } as unknown as BatteryControl);
      await manager.removeBatteryStates(testDevice);

      // Without the cache eviction this second pass would write nothing at all and
      // the battery would come back as an empty branch.
      await manager.updateBattery(testDevice, { mode: "zero", battery_count: 2 } as unknown as BatteryControl);

      expect(adapter.objects.has("hwe-p1_aabbccddeeff.battery")).toBe(true);
      expect(adapter.states.get("hwe-p1_aabbccddeeff.battery.battery_count")?.val).toBe(2);
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
      await manager.updateMeasurement(testDevice, { power_w: NaN });
      expect(adapter.states.has("hwe-p1_aabbccddeeff.measurement.power_w")).toBe(false);
    });

    it("rejects Infinity in number field", async () => {
      await manager.updateMeasurement(testDevice, { power_w: Infinity });
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
      await manager.updateMeasurement(testDevice, { meter_model: "" });
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
      await manager.updateMeasurement(testDevice, { external: [] });
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
      });
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

describe("name ownership — which objects may keep their stored name", () => {
  let adapter: MockAdapter;
  let manager: StateManager;

  const device: DeviceConfig = {
    token: "t",
    productType: "HWE-P1",
    serial: "aabbccddeeff",
    productName: "P1 Meter",
  };

  beforeEach(() => {
    adapter = createMockAdapter();
    manager = new StateManager(adapter as never);
  });

  it("preserves the stored name ONLY where the name comes from outside the adapter", async () => {
    // A full pass over every object-creating path.
    await manager.createDeviceStates(device);
    await manager.updateMeasurement(device, {
      power_w: 100,
      energy_import_kwh: 5,
      voltage_sag_l1_count: 2,
      tariff: 1,
      external: [{ type: "gas_meter", unique_id: "g1", value: 12.5, unit: "m3", timestamp: "2026-09-04T09:00:00" }],
    } as unknown as Measurement);
    await manager.updateSystem(device, {
      wifi_ssid: "net",
      wifi_rssi_db: -50,
      uptime_s: 10,
      cloud_enabled: true,
      status_led_brightness_pct: 50,
      api_v1_enabled: false,
    });
    await manager.updateBattery(device, { mode: "zero", battery_count: 1, charge_to_full: false });

    // `preserve: { common: ["name"] }` keeps whatever name is already stored — which
    // means a corrected label never reaches an existing installation. Since v0.19.0 not
    // a single write carries it: the adapter owns every name in its own tree, and the
    // two that come from the device (the device object, a meter type the API does not
    // define) are WRITTEN from the device's current value, not frozen. No gate sees a
    // `preserve` that sneaks back in, so this empty list is the guard.
    expect([...new Set(adapter.preservedIds)]).toEqual([]);

    const channel = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.external.gas_meter_g1")!;
    expect(channel.common.name).toEqual(expect.objectContaining({ en: "Gas meter" }));
  });

  it("an external meter type the API does not document keeps its raw name — that one IS the device's", async () => {
    await manager.updateMeasurement(device, {
      external: [{ type: "future_meter", unique_id: "f1", value: 1, unit: "x", timestamp: "2026-09-06T09:00:00" }],
    } as unknown as Measurement);

    const channel = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.external.future_meter_f1")!;
    expect(channel.common.name).toBe("future_meter");
    // The device's text, written — not the stored one, kept.
    expect(adapter.preservedIds).not.toContain("hwe-p1_aabbccddeeff.measurement.external.future_meter_f1");
  });

  it("creates no object through a create-only write — every path must reach existing installs", async () => {
    await manager.createDeviceStates(device);
    await manager.updateMeasurement(device, { power_w: 100 });
    await manager.updateSystem(device, {
      wifi_ssid: "net",
      wifi_rssi_db: -50,
      uptime_s: 10,
      cloud_enabled: true,
      status_led_brightness_pct: 50,
    });
    await manager.updateBattery(device, { mode: "zero", battery_count: 1 });

    // setObjectNotExists writes only when the object is missing, so a changed
    // name or description would land on fresh installations only. Channels,
    // buttons and the legacy marker used to be created that way.
    expect(adapter.metrics.setObjectNotExistsCalls).toBe(0);
  });
});

describe("the legacy-cleanup marker and the quality channel", () => {
  let adapter: MockAdapter;
  let manager: StateManager;

  const device: DeviceConfig = {
    token: "t",
    productType: "HWE-P1",
    serial: "aabbccddeeff",
    productName: "P1 Meter",
  };

  beforeEach(() => {
    adapter = createMockAdapter();
    manager = new StateManager(adapter as never);
  });

  it("removes the retired internal markers instead of relabelling them", async () => {
    // They were adapter bookkeeping in a USER's object tree: one noted that a
    // one-off cleanup had run, the other which version the labels came from.
    // Neither is needed — both jobs work off the object list — and neither was
    // ever something a user asked for.
    adapter.objects.set("info.legacyMigrated", { type: "state", common: { name: "x" }, native: {} });
    adapter.objects.set("info.labelsVersion", { type: "state", common: { name: "y" }, native: {} });

    const removed = await manager.removeRetiredMarkers(
      new Set(["homewizard.0.info.legacyMigrated", "homewizard.0.info.labelsVersion"]),
    );

    expect(removed.sort()).toEqual(["info.labelsVersion", "info.legacyMigrated"]);
    expect(adapter.objects.has("info.legacyMigrated")).toBe(false);
    expect(adapter.objects.has("info.labelsVersion")).toBe(false);
  });

  it("reports nothing when the retired markers are not there", async () => {
    expect(await manager.removeRetiredMarkers(new Set())).toEqual([]);
  });

  it("creates the quality channel before the power-quality counters live under it", async () => {
    // Every parent path of a dynamic child needs its own object first —
    // otherwise the counters are orphaned (E3009) and Admin shows an unnamed
    // folder.
    await manager.updateMeasurement(device, {
      power_w: 100,
      voltage_sag_l1_count: 2,
      long_power_fail_count: 1,
    });

    const channel = adapter.objects.get("hwe-p1_aabbccddeeff.measurement.quality");
    expect(channel, "the quality channel must exist").toBeDefined();
    expect(channel!.type).toBe("channel");
    expect(adapter.objects.has("hwe-p1_aabbccddeeff.measurement.quality.voltage_sag_l1_count")).toBe(true);
    expect(adapter.states.get("hwe-p1_aabbccddeeff.measurement.quality.long_power_fail_count")?.val).toBe(1);
  });

  it("does not create the quality channel for a device that reports no counters", async () => {
    await manager.updateMeasurement(device, { power_w: 100 });
    expect(adapter.objects.has("hwe-p1_aabbccddeeff.measurement.quality")).toBe(false);
  });
});

describe("the label retrofit covers every object the adapter names itself", () => {
  let adapter: MockAdapter;
  let manager: StateManager;

  const device: DeviceConfig = {
    token: "t",
    productType: "HWE-P1",
    serial: "aabbccddeeff",
    productName: "P1 Meter",
  };
  const prefix = "hwe-p1_aabbccddeeff";

  beforeEach(() => {
    adapter = createMockAdapter();
    manager = new StateManager(adapter as never);
  });

  /** Drive every writing path with a payload that produces all optional objects. */
  async function fullPass(): Promise<void> {
    await manager.createDeviceStates(device);
    const measurement: Record<string, unknown> = {
      external: [{ type: "gas_meter", unique_id: "g1", value: 12.5, unit: "m3", timestamp: "2026-09-04T09:00" }],
    };
    for (const def of MEASUREMENT_STATE_DEFS) {
      measurement[def.key] = def.type === "number" ? 1 : "x";
    }
    await manager.updateMeasurement(device, measurement);
    await manager.updateSystem(device, {
      wifi_ssid: "net",
      wifi_rssi_db: -50,
      uptime_s: 10,
      cloud_enabled: true,
      status_led_brightness_pct: 50,
      api_v1_enabled: false,
    });
    await manager.updateBattery(device, {
      mode: "zero",
      permissions: [],
      charge_to_full: false,
      battery_count: 1,
      power_w: 10,
      target_power_w: 20,
      max_consumption_w: 30,
      max_production_w: 40,
    } as unknown as BatteryControl);
  }

  it("lists every adapter-named object a full pass creates", async () => {
    await fullPass();

    // The one name that comes from the DEVICE, not from this adapter, and is
    // therefore not retrofitted: the device object itself. (A meter channel of a
    // KNOWN type carries the adapter's own translated text and IS retrofitted; only
    // an unknown type keeps the device's raw string.)
    const deviceOwned = new Set([prefix]);
    const created = [...adapter.objects.keys()]
      .filter(id => id.startsWith(prefix) && !deviceOwned.has(id))
      .map(id => id.slice(prefix.length + 1));

    const covered = new Set(LABELLED_OBJECT_IDS);
    // An external meter sits behind a device-supplied id segment, so the retrofit
    // reaches its channel and its three leaves by pattern instead of by fixed id.
    const externalLeaf = /^measurement\.external\.[^.]+\.([^.]+)$/;
    const externalChannel = /^measurement\.external\.([^.]+)$/;
    const knownTypes = Object.keys(EXTERNAL_METER_TYPE_NAMES);
    const missing = created.filter(id => {
      if (covered.has(id)) {
        return false;
      }
      const leaf = externalLeaf.exec(id);
      if (leaf && EXTERNAL_METER_LEAF_KEYS.includes(leaf[1])) {
        return false;
      }
      const channel = externalChannel.exec(id);
      return !(channel && knownTypes.some(t => channel[1].startsWith(`${t}_`)));
    });
    // A new datapoint that nobody adds to DEVICE_LABELLED_OBJECTS would silently
    // keep the label of whatever version created it on every installation whose
    // device is quiet. This list is the only thing that notices.
    expect(missing, "objects created but not covered by the retrofit").toEqual([]);
  });

  it("refreshes exactly the objects that already exist, and creates none", async () => {
    await fullPass();
    // Simulate an upgraded installation: the tree holds the objects, but with the
    // labels of an older version.
    for (const [id, obj] of adapter.objects) {
      if (id.startsWith(prefix)) {
        obj.common.name = "old label";
      }
    }
    const before = adapter.objects.size;
    const existing = new Set([...adapter.objects.keys()].map(id => `homewizard.0.${id}`));

    // A tree with old labels means the adapter is STARTING on it — a fresh process
    // with an empty per-run cache, which is what the retrofit runs in. Reusing the
    // manager that just wrote every one of these objects would measure the cache,
    // not the retrofit.
    const refreshed = await new StateManager(adapter as never).refreshExistingNames(device, existing);

    expect(refreshed).toBeGreaterThan(20);
    expect(adapter.objects.size, "the retrofit must not create objects").toBe(before);
    expect(adapter.objects.get(`${prefix}.measurement.power_w`)!.common.name).toEqual(
      expect.objectContaining({ en: expect.any(String) }),
    );
    expect(adapter.objects.get(`${prefix}.system.reboot`)!.common.name).toEqual(
      expect.objectContaining({ en: expect.any(String) }),
    );
    // The device-supplied names stay as they are.
    expect(adapter.objects.get(prefix)!.common.name).toBe("old label");
  });

  it("touches nothing for a device whose objects are not in the tree", async () => {
    const refreshed = await manager.refreshExistingNames(device, new Set());
    expect(refreshed).toBe(0);
    expect(adapter.objects.size).toBe(0);
  });

  // The retrofit works off ONE object list, read once at start-up. A branch that goes
  // away AFTER that list was taken — the battery branch of a device that answers 404 —
  // is still in it, and `extendObject` on a missing object creates it. Measured in the
  // upgrade suite before the guard: all nine battery objects came back, as husks with
  // a name and nothing else.
  // A meter channel is only written when the meter reports. On an installation whose
  // device is offline — or whose meter was unplugged — the channel kept the wording of
  // whatever version created it, while its three leaves below were refreshed.
  it("refreshes the channel of an external meter of a known type, not just its leaves", async () => {
    await fullPass();
    const channelId = `${prefix}.measurement.external.gas_meter_g1`;
    adapter.objects.get(channelId)!.common.name = "old label";
    const existing = new Set([...adapter.objects.keys()].map(id => `homewizard.0.${id}`));

    // A fresh manager = a fresh adapter start on an existing tree.
    await new StateManager(adapter as never).refreshExistingNames(device, existing);

    expect(adapter.objects.get(channelId)!.common.name).toEqual(expect.objectContaining({ en: expect.any(String) }));
  });

  it("leaves the channel of an unknown meter type alone (the name is the device's)", async () => {
    await fullPass();
    await manager.updateMeasurement(device, {
      external: [{ type: "future_meter", unique_id: "f1", value: 1, unit: "m3", timestamp: "2026-01-01T00:00:00" }],
    } as unknown as Measurement);
    const channelId = `${prefix}.measurement.external.future_meter_f1`;
    const existing = new Set([...adapter.objects.keys()].map(id => `homewizard.0.${id}`));

    await new StateManager(adapter as never).refreshExistingNames(device, existing);

    expect(adapter.objects.get(channelId)!.common.name).toBe("future_meter");
  });

  it("does not resurrect a branch this start-up removed", async () => {
    await manager.createDeviceStates(device);
    await manager.updateBattery(device, { mode: "zero", battery_count: 2, power_w: -400 });
    const existing = new Set([...adapter.objects.keys()].map(id => `homewizard.0.${id}`));
    expect(existing.has(`homewizard.0.${prefix}.battery.mode`)).toBe(true);

    expect(await manager.removeBatteryStates(device)).toBe(true);
    const afterRemoval = adapter.objects.size;

    // The list still carries the battery ids — that is exactly the situation.
    await manager.refreshExistingNames(device, existing);

    expect(adapter.objects.size, "the retrofit must not bring the branch back").toBe(afterRemoval);
    expect(adapter.objects.has(`${prefix}.battery.mode`)).toBe(false);
    expect(adapter.objects.has(`${prefix}.battery`)).toBe(false);
  });

  it("does not write again what this very start-up already wrote", async () => {
    await fullPass();
    const existing = new Set([...adapter.objects.keys()].map(id => `homewizard.0.${id}`));
    const writesBefore = adapter.metrics.extendObjectCalls;

    // Same manager = same adapter run: createDeviceStates and the data paths have
    // just written every one of these labels with the current text. Refreshing
    // them is a second object write per object, for nothing — on a P1 that is
    // ~40 writes on every single start.
    const refreshed = await manager.refreshExistingNames(device, existing);

    expect(refreshed).toBe(0);
    expect(adapter.metrics.extendObjectCalls).toBe(writesBefore);
  });
});
