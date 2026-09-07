import { describe, expect, it } from "vitest";
import { EXTERNAL_METER_TYPE_NAMES } from "./state-defs";

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
