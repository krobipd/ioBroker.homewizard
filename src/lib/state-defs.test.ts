import { describe, expect, it } from "vitest";
import {
  DEVICE_LABELLED_OBJECTS,
  EXTERNAL_METER_LEAVES,
  EXTERNAL_METER_TYPE_NAMES,
  MEASUREMENT_STATE_DEFS,
  SYSTEM_INFO_FIELDS,
} from "./state-defs";

/**
 * Data points that carry NO `common.desc`, each with the reason.
 *
 * The fleet rule is that a description explains something a user cannot read off
 * the name and the unit — and stays EMPTY where there is nothing to explain,
 * because an invented sentence is worse than none. That decision cannot live in a
 * gate: only the adapter knows its own data. So it lives here, one line per data
 * point, and the test below makes sure no data point slips through undecided.
 *
 * Keys are the ids as they appear under a device prefix, and the measurement keys
 * as they appear in {@link MEASUREMENT_STATE_DEFS}.
 */
const SELF_EXPLAINING: Record<string, string> = {
  // Identifiers — the value IS the explanation.
  "info.productName": "the value is the name itself",
  "info.productType": "the value is the type identifier itself",
  "info.firmware": "the value is the version itself",
  "info.wifi_ssid": "the value is the network name itself",
  meter_model: "the value is the model designation itself",
  protocol_version: "the value is the protocol version itself",

  // Buttons — the label already says what pressing does.
  "system.reboot": "the label is the action",
  "system.identify": "the label is the action",

  // A percentage with a name that says what it sets.
  "system.status_led_brightness_pct": "name plus the percent unit say it",

  // Battery basics.
  "battery.battery_count": "a count of what the name says",
  "battery.power_w": "name plus the W unit say it",
  state_of_charge_pct: "name plus the percent unit say it",

  // Electrical basics: the name names the quantity, the unit gives the scale.
  // Anything that needs more than that (apparent, reactive, power factor, power
  // quality, the Belgian capacity tariff) does carry a description.
  power_w: "name plus the W unit say it",
  power_l1_w: "name plus the W unit say it",
  power_l2_w: "name plus the W unit say it",
  power_l3_w: "name plus the W unit say it",
  voltage_v: "name plus the V unit say it",
  voltage_l1_v: "name plus the V unit say it",
  voltage_l2_v: "name plus the V unit say it",
  voltage_l3_v: "name plus the V unit say it",
  current_a: "name plus the A unit say it",
  current_l1_a: "name plus the A unit say it",
  current_l2_a: "name plus the A unit say it",
  current_l3_a: "name plus the A unit say it",
  frequency_hz: "name plus the Hz unit say it",
  energy_import_kwh: "name plus the kWh unit say it",
  energy_import_t1_kwh: "name plus the kWh unit say it",
  energy_import_t2_kwh: "name plus the kWh unit say it",
  energy_import_t3_kwh: "name plus the kWh unit say it",
  energy_import_t4_kwh: "name plus the kWh unit say it",
  energy_export_kwh: "name plus the kWh unit say it",
  energy_export_t1_kwh: "name plus the kWh unit say it",
  energy_export_t2_kwh: "name plus the kWh unit say it",
  energy_export_t3_kwh: "name plus the kWh unit say it",
  energy_export_t4_kwh: "name plus the kWh unit say it",

  // External meters: the reading carries the explanation, its two companions
  // do not need one.
  unit: "the value is the unit itself",
  timestamp: "the label says what the time refers to",
};

/** Every data point the adapter names, as `id → carries a description`. */
function describedById(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const spec of DEVICE_LABELLED_OBJECTS) {
    if (spec.kind === "state" && !spec.id.startsWith("measurement.")) {
      out.set(spec.id, Boolean(spec.descKey));
    }
  }
  for (const def of MEASUREMENT_STATE_DEFS) {
    out.set(def.key, Boolean(def.descKey));
  }
  for (const field of SYSTEM_INFO_FIELDS) {
    out.set(`info.${field.key}`, Boolean(field.descKey));
  }
  for (const [leaf, spec] of Object.entries(EXTERNAL_METER_LEAVES)) {
    out.set(leaf, Boolean(spec.descKey));
  }
  return out;
}

describe("every data point either explains itself or carries an explanation", () => {
  it("no data point is left undecided", () => {
    const undecided = [...describedById()]
      .filter(([id, described]) => !described && !(id in SELF_EXPLAINING))
      .map(([id]) => id);

    // A new data point lands here until someone decides: does a user need a
    // sentence for it, or does the name plus the unit already say everything?
    // That is the whole point — the decision is made, not skipped.
    expect(undecided, "data points without a description and without a reason").toEqual([]);
  });

  it("no reason is left behind for a data point that no longer exists", () => {
    const known = describedById();
    const stale = Object.keys(SELF_EXPLAINING).filter(id => !known.has(id));
    expect(stale, "entries in SELF_EXPLAINING with no data point").toEqual([]);
  });

  it("a data point never has both a description and a reason to have none", () => {
    const both = [...describedById()].filter(([id, described]) => described && id in SELF_EXPLAINING).map(([id]) => id);
    expect(both).toEqual([]);
  });
});

describe("the external meter types the adapter can name", () => {
  it("covers exactly the types the API documents", () => {
    // Kept in step with `ExternalMeter["type"]` in types.ts — a type that shows up
    // here but not there (or the other way round) means the channel would fall
    // back to the raw string on a device that reports it.
    expect(Object.keys(EXTERNAL_METER_TYPE_NAMES).sort()).toEqual([
      "gas_meter",
      "heat_meter",
      "inlet_heat_meter",
      "warm_water_meter",
      "water_meter",
    ]);
  });
});
