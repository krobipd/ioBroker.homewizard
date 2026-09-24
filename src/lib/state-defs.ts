import type { I18nKey } from "./i18n";

/**
 * The declarative tables behind the state manager: which data points exist, what
 * they are called, which of them are written on every push, and which objects the
 * label retrofit has to reach.
 *
 * Split out of `state-manager.ts` because this is data, not behaviour — ~500 lines
 * of table sat in front of the ~1000 lines of logic that use them. Nothing in here
 * touches the adapter.
 */

/** Measurement field to state definition mapping */
export interface MeasurementStateDef {
  /** Measurement field key */
  key: string;
  /** ioBroker state ID suffix */
  id: string;
  /** Translation key for `common.name` (resolved via {@link tName}) */
  nameKey: I18nKey;
  /** Optional translation key for `common.desc` (resolved via {@link tName}) */
  descKey?: I18nKey;
  /** State value type */
  type: ioBroker.CommonType;
  /** ioBroker role */
  role: string;
  /** Unit string */
  unit?: string;
  /** Optional numeric minimum (I2: percentages 0–100). */
  min?: number;
  /** Optional numeric maximum. */
  max?: number;
}

// Exported for unit-tests only (invariant lock: every MOMENTARY_KEYS entry must
// reference an existing def key — a typo would silently demote the field to
// changed-only writes). Production code uses these via StateManager methods.
export const MEASUREMENT_STATE_DEFS: MeasurementStateDef[] = [
  // Power
  { key: "power_w", id: "power_w", nameKey: "powerTotal", type: "number", role: "value.power", unit: "W" },
  { key: "power_l1_w", id: "power_l1_w", nameKey: "powerL1", type: "number", role: "value.power", unit: "W" },
  { key: "power_l2_w", id: "power_l2_w", nameKey: "powerL2", type: "number", role: "value.power", unit: "W" },
  { key: "power_l3_w", id: "power_l3_w", nameKey: "powerL3", type: "number", role: "value.power", unit: "W" },
  // Voltage
  { key: "voltage_v", id: "voltage_v", nameKey: "voltage", type: "number", role: "value.voltage", unit: "V" },
  { key: "voltage_l1_v", id: "voltage_l1_v", nameKey: "voltageL1", type: "number", role: "value.voltage", unit: "V" },
  { key: "voltage_l2_v", id: "voltage_l2_v", nameKey: "voltageL2", type: "number", role: "value.voltage", unit: "V" },
  { key: "voltage_l3_v", id: "voltage_l3_v", nameKey: "voltageL3", type: "number", role: "value.voltage", unit: "V" },
  // Current
  { key: "current_a", id: "current_a", nameKey: "current", type: "number", role: "value.current", unit: "A" },
  { key: "current_l1_a", id: "current_l1_a", nameKey: "currentL1", type: "number", role: "value.current", unit: "A" },
  { key: "current_l2_a", id: "current_l2_a", nameKey: "currentL2", type: "number", role: "value.current", unit: "A" },
  { key: "current_l3_a", id: "current_l3_a", nameKey: "currentL3", type: "number", role: "value.current", unit: "A" },
  // Frequency
  {
    key: "frequency_hz",
    id: "frequency_hz",
    nameKey: "frequency",
    type: "number",
    role: "value.frequency",
    unit: "Hz",
  },
  // Energy import
  {
    key: "energy_import_kwh",
    id: "energy_import_kwh",
    nameKey: "energyImportTotal",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  {
    key: "energy_import_t1_kwh",
    id: "energy_import_t1_kwh",
    nameKey: "energyImportT1",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  {
    key: "energy_import_t2_kwh",
    id: "energy_import_t2_kwh",
    nameKey: "energyImportT2",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  {
    key: "energy_import_t3_kwh",
    id: "energy_import_t3_kwh",
    nameKey: "energyImportT3",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  {
    key: "energy_import_t4_kwh",
    id: "energy_import_t4_kwh",
    nameKey: "energyImportT4",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  // Energy export
  {
    key: "energy_export_kwh",
    id: "energy_export_kwh",
    nameKey: "energyExportTotal",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  {
    key: "energy_export_t1_kwh",
    id: "energy_export_t1_kwh",
    nameKey: "energyExportT1",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  {
    key: "energy_export_t2_kwh",
    id: "energy_export_t2_kwh",
    nameKey: "energyExportT2",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  {
    key: "energy_export_t3_kwh",
    id: "energy_export_t3_kwh",
    nameKey: "energyExportT3",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  {
    key: "energy_export_t4_kwh",
    id: "energy_export_t4_kwh",
    nameKey: "energyExportT4",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  // Tariff (common.states applied separately in updateMeasurement for translation labels)
  { key: "tariff", id: "tariff", nameKey: "tariff", descKey: "tariffDesc", type: "number", role: "value" },
  // Power quality
  {
    key: "voltage_sag_l1_count",
    id: "quality.voltage_sag_l1_count",
    nameKey: "voltageSagL1",
    descKey: "voltageSag",
    type: "number",
    role: "value",
  },
  {
    key: "voltage_sag_l2_count",
    id: "quality.voltage_sag_l2_count",
    nameKey: "voltageSagL2",
    descKey: "voltageSag",
    type: "number",
    role: "value",
  },
  {
    key: "voltage_sag_l3_count",
    id: "quality.voltage_sag_l3_count",
    nameKey: "voltageSagL3",
    descKey: "voltageSag",
    type: "number",
    role: "value",
  },
  {
    key: "voltage_swell_l1_count",
    id: "quality.voltage_swell_l1_count",
    nameKey: "voltageSwellL1",
    descKey: "voltageSwell",
    type: "number",
    role: "value",
  },
  {
    key: "voltage_swell_l2_count",
    id: "quality.voltage_swell_l2_count",
    nameKey: "voltageSwellL2",
    descKey: "voltageSwell",
    type: "number",
    role: "value",
  },
  {
    key: "voltage_swell_l3_count",
    id: "quality.voltage_swell_l3_count",
    nameKey: "voltageSwellL3",
    descKey: "voltageSwell",
    type: "number",
    role: "value",
  },
  {
    key: "any_power_fail_count",
    id: "quality.power_fail_count",
    nameKey: "powerFailCount",
    descKey: "powerFailCountDesc",
    type: "number",
    role: "value",
  },
  {
    key: "long_power_fail_count",
    id: "quality.long_power_fail_count",
    nameKey: "longPowerFailCount",
    descKey: "longPowerFailCountDesc",
    type: "number",
    role: "value",
  },
  // Capacity tariff (Belgium)
  {
    key: "average_power_15m_w",
    id: "average_power_15m_w",
    nameKey: "avgPower15m",
    descKey: "belgiumCapacityTariff",
    type: "number",
    role: "value.power",
    unit: "W",
  },
  {
    key: "monthly_power_peak_w",
    id: "monthly_power_peak_w",
    nameKey: "monthlyPowerPeak",
    descKey: "belgiumCapacityTariff",
    type: "number",
    role: "value.power",
    unit: "W",
  },
  {
    key: "monthly_power_peak_timestamp",
    id: "monthly_power_peak_timestamp",
    nameKey: "monthlyPowerPeakTimestamp",
    descKey: "belgiumCapacityTariff",
    type: "string",
    role: "date",
  },
  // kWh meter specifics — apparent / reactive
  {
    key: "apparent_current_a",
    id: "apparent_current_a",
    nameKey: "apparentCurrent",
    descKey: "apparentDesc",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "apparent_current_l1_a",
    id: "apparent_current_l1_a",
    nameKey: "apparentCurrentL1",
    descKey: "apparentDesc",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "apparent_current_l2_a",
    id: "apparent_current_l2_a",
    nameKey: "apparentCurrentL2",
    descKey: "apparentDesc",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "apparent_current_l3_a",
    id: "apparent_current_l3_a",
    nameKey: "apparentCurrentL3",
    descKey: "apparentDesc",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "reactive_current_a",
    id: "reactive_current_a",
    nameKey: "reactiveCurrent",
    descKey: "reactiveDesc",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "reactive_current_l1_a",
    id: "reactive_current_l1_a",
    nameKey: "reactiveCurrentL1",
    descKey: "reactiveDesc",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "reactive_current_l2_a",
    id: "reactive_current_l2_a",
    nameKey: "reactiveCurrentL2",
    descKey: "reactiveDesc",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "reactive_current_l3_a",
    id: "reactive_current_l3_a",
    nameKey: "reactiveCurrentL3",
    descKey: "reactiveDesc",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "apparent_power_va",
    id: "apparent_power_va",
    nameKey: "apparentPower",
    descKey: "apparentDesc",
    type: "number",
    role: "value.power",
    unit: "VA",
  },
  {
    key: "apparent_power_l1_va",
    id: "apparent_power_l1_va",
    nameKey: "apparentPowerL1",
    descKey: "apparentDesc",
    type: "number",
    role: "value.power",
    unit: "VA",
  },
  {
    key: "apparent_power_l2_va",
    id: "apparent_power_l2_va",
    nameKey: "apparentPowerL2",
    descKey: "apparentDesc",
    type: "number",
    role: "value.power",
    unit: "VA",
  },
  {
    key: "apparent_power_l3_va",
    id: "apparent_power_l3_va",
    nameKey: "apparentPowerL3",
    descKey: "apparentDesc",
    type: "number",
    role: "value.power",
    unit: "VA",
  },
  {
    key: "reactive_power_var",
    id: "reactive_power_var",
    nameKey: "reactivePower",
    descKey: "reactiveDesc",
    type: "number",
    role: "value.power.reactive",
    unit: "var",
  },
  {
    key: "reactive_power_l1_var",
    id: "reactive_power_l1_var",
    nameKey: "reactivePowerL1",
    descKey: "reactiveDesc",
    type: "number",
    role: "value.power.reactive",
    unit: "var",
  },
  {
    key: "reactive_power_l2_var",
    id: "reactive_power_l2_var",
    nameKey: "reactivePowerL2",
    descKey: "reactiveDesc",
    type: "number",
    role: "value.power.reactive",
    unit: "var",
  },
  {
    key: "reactive_power_l3_var",
    id: "reactive_power_l3_var",
    nameKey: "reactivePowerL3",
    descKey: "reactiveDesc",
    type: "number",
    role: "value.power.reactive",
    unit: "var",
  },
  {
    key: "power_factor",
    id: "power_factor",
    nameKey: "powerFactor",
    descKey: "powerFactorDesc",
    type: "number",
    role: "value",
  },
  {
    key: "power_factor_l1",
    id: "power_factor_l1",
    nameKey: "powerFactorL1",
    descKey: "powerFactorDesc",
    type: "number",
    role: "value",
  },
  {
    key: "power_factor_l2",
    id: "power_factor_l2",
    nameKey: "powerFactorL2",
    descKey: "powerFactorDesc",
    type: "number",
    role: "value",
  },
  {
    key: "power_factor_l3",
    id: "power_factor_l3",
    nameKey: "powerFactorL3",
    descKey: "powerFactorDesc",
    type: "number",
    role: "value",
  },
  // Battery specifics
  {
    key: "state_of_charge_pct",
    id: "state_of_charge_pct",
    nameKey: "stateOfCharge",
    type: "number",
    role: "value.battery",
    min: 0,
    max: 100,
    unit: "%",
  },
  { key: "cycles", id: "cycles", nameKey: "cycles", descKey: "cyclesDesc", type: "number", role: "value" },
  // Metadata
  { key: "meter_model", id: "meter_model", nameKey: "meterModel", type: "string", role: "text" },
  {
    key: "unique_id",
    id: "unique_id",
    nameKey: "meterIdentifier",
    descKey: "meterIdentifierDesc",
    type: "string",
    role: "text",
  },
  { key: "protocol_version", id: "protocol_version", nameKey: "protocolVersion", type: "number", role: "value" },
  {
    key: "timestamp",
    id: "timestamp",
    nameKey: "measurementTimestamp",
    descKey: "measurementTimestampDesc",
    type: "string",
    role: "date",
  },
];

// Instantaneous electrical values — change on (almost) every ~1/s push, so a setStateChanged
// read-compare buys nothing. These stay on setState; every other measurement field
// (energy totals, tariff, power-quality counts, capacity tariff, SoC/cycles, model/timestamp)
// is slow/static and uses setStateChangedAsync to skip redundant 1/s writes.
// Exported for unit-tests only (subset-invariant against MEASUREMENT_STATE_DEFS).
export const MOMENTARY_KEYS = new Set<string>([
  "power_w",
  "power_l1_w",
  "power_l2_w",
  "power_l3_w",
  "voltage_v",
  "voltage_l1_v",
  "voltage_l2_v",
  "voltage_l3_v",
  "current_a",
  "current_l1_a",
  "current_l2_a",
  "current_l3_a",
  "frequency_hz",
  "apparent_current_a",
  "apparent_current_l1_a",
  "apparent_current_l2_a",
  "apparent_current_l3_a",
  "reactive_current_a",
  "reactive_current_l1_a",
  "reactive_current_l2_a",
  "reactive_current_l3_a",
  "apparent_power_va",
  "apparent_power_l1_va",
  "apparent_power_l2_va",
  "apparent_power_l3_va",
  "reactive_power_var",
  "reactive_power_l1_var",
  "reactive_power_l2_var",
  "reactive_power_l3_var",
  "power_factor",
  "power_factor_l1",
  "power_factor_l2",
  "power_factor_l3",
]);

/** An object under a device prefix whose name and description the ADAPTER owns. */
export interface LabelledObject {
  /** ID relative to the device prefix. */
  id: string;
  /** Object type — needed when `extendObject` has to create nothing but merge. */
  kind: "channel" | "state";
  /** Translation key for `common.name`. */
  nameKey: I18nKey;
  /** Optional translation key for `common.desc`. */
  descKey?: I18nKey;
}

/**
 * Every object under a device prefix that carries an adapter-owned label.
 *
 * This is what the name retrofit walks (see {@link StateManager.refreshExistingNames}).
 * It exists because most of these objects are only ever written while device data
 * flows: a meter that is offline — the P1 in a cellar hallway this adapter is built
 * for — keeps the labels of whatever version created them, however correct the write
 * path is. The retrofit reaches them without the device.
 *
 * The list is NOT a second copy of the naming: the measurement entries are derived
 * from {@link MEASUREMENT_STATE_DEFS}, and `state-manager.test.ts` drives a full
 * pass over every writing path and fails if it produces an object that is missing
 * here. A new datapoint therefore cannot silently escape the retrofit.
 *
 * Deliberately absent: the device object itself and the external-meter channels —
 * their names come from the device, not from this adapter (see the `preserve`
 * argument of {@link StateManager.ensureChannel}).
 */
export const DEVICE_LABELLED_OBJECTS: LabelledObject[] = [
  { id: "info", kind: "channel", nameKey: "deviceInformation" },
  { id: "info.productName", kind: "state", nameKey: "productName" },
  { id: "info.productType", kind: "state", nameKey: "productType" },
  { id: "info.firmware", kind: "state", nameKey: "firmware" },
  { id: "info.connected", kind: "state", nameKey: "connected", descKey: "connectedDesc" },
  { id: "info.wifi_ssid", kind: "state", nameKey: "wifiSsid" },
  { id: "info.wifi_rssi_db", kind: "state", nameKey: "wifiRssi", descKey: "wifiRssiDesc" },
  { id: "info.uptime_s", kind: "state", nameKey: "uptime", descKey: "uptimeDesc" },
  { id: "remove", kind: "state", nameKey: "removeDevice", descKey: "removeDeviceDesc" },
  { id: "measurement", kind: "channel", nameKey: "measurement" },
  { id: "measurement.quality", kind: "channel", nameKey: "powerQuality" },
  { id: "measurement.external", kind: "channel", nameKey: "externalMeters" },
  ...MEASUREMENT_STATE_DEFS.map((d): LabelledObject => ({
    id: `measurement.${d.id}`,
    kind: "state",
    nameKey: d.nameKey,
    ...(d.descKey ? { descKey: d.descKey } : {}),
  })),
  { id: "system", kind: "channel", nameKey: "systemSettings" },
  { id: "system.cloud_enabled", kind: "state", nameKey: "cloudEnabled", descKey: "cloudEnabledDesc" },
  { id: "system.status_led_brightness_pct", kind: "state", nameKey: "ledBrightness" },
  { id: "system.api_v1_enabled", kind: "state", nameKey: "apiV1Enabled", descKey: "apiV1EnabledDesc" },
  { id: "system.reboot", kind: "state", nameKey: "rebootDevice" },
  { id: "system.identify", kind: "state", nameKey: "identify" },
  { id: "battery", kind: "channel", nameKey: "batteryControl" },
  { id: "battery.mode", kind: "state", nameKey: "batteryMode", descKey: "batteryModeDesc" },
  { id: "battery.permissions", kind: "state", nameKey: "batteryPermissions", descKey: "batteryPermissionsDesc" },
  { id: "battery.charge_to_full", kind: "state", nameKey: "batteryChargeToFull", descKey: "batteryChargeToFullDesc" },
  { id: "battery.battery_count", kind: "state", nameKey: "batteryCount" },
  { id: "battery.power_w", kind: "state", nameKey: "batteryPower", descKey: "batteryPowerDesc" },
  { id: "battery.target_power_w", kind: "state", nameKey: "batteryTargetPower", descKey: "batteryTargetPowerDesc" },
  { id: "battery.max_consumption_w", kind: "state", nameKey: "batteryMaxConsumption", descKey: "batteryLimitDesc" },
  { id: "battery.max_production_w", kind: "state", nameKey: "batteryMaxProduction", descKey: "batteryLimitDesc" },
];

/** Exported for the drift test only — production code reaches it via the retrofit. */
export const LABELLED_OBJECT_IDS: readonly string[] = DEVICE_LABELLED_OBJECTS.map(o => o.id);

/**
 * The three datapoints below an external meter (`measurement.external.<type>_<id>`).
 *
 * They cannot sit in {@link DEVICE_LABELLED_OBJECTS} because the channel segment
 * between them and the prefix is device-supplied and only known at runtime — but
 * the leaf labels are the adapter's own, so the retrofit has to reach them by
 * pattern. The channel itself keeps its device-given name.
 */
export const EXTERNAL_METER_LEAVES: Record<string, { nameKey: I18nKey; descKey?: I18nKey }> = {
  value: { nameKey: "externalValue", descKey: "externalValueDesc" },
  unit: { nameKey: "externalUnit" },
  timestamp: { nameKey: "externalTimestamp" },
};

/**
 * The external-meter types the API documents, and the label the adapter gives the
 * channel for each. The set is CLOSED (`ExternalMeter["type"]`), so these names are
 * the adapter's own translated text — not a device-supplied string that has to be
 * preserved. A type outside the list keeps its raw value, because then it really is
 * something only the device knows.
 */
export const EXTERNAL_METER_TYPE_NAMES: Record<string, I18nKey> = {
  gas_meter: "externalGasMeter",
  water_meter: "externalWaterMeter",
  warm_water_meter: "externalWarmWaterMeter",
  heat_meter: "externalHeatMeter",
  inlet_heat_meter: "externalInletHeatMeter",
};

/** Exported for the drift test only. */
export const EXTERNAL_METER_LEAF_KEYS: readonly string[] = Object.keys(EXTERNAL_METER_LEAVES);

/**
 * The three fields of `GET /api/system` that belong in the device's `info` channel
 * rather than in `system` — they describe the device's state, not a setting the
 * user can change. Kept as a table so the write loop states the rule once.
 */
export const SYSTEM_INFO_FIELDS: Array<{
  /** Field key in the system payload — also the state ID under `info.` */
  key: string;
  /** Translation key for `common.name` */
  nameKey: I18nKey;
  /** Optional translation key for `common.desc` */
  descKey?: I18nKey;
  /** Value type */
  type: "string" | "number";
  /** ioBroker role */
  role: string;
  /** Optional unit */
  unit?: string;
}> = [
  { key: "wifi_ssid", nameKey: "wifiSsid", type: "string", role: "text" },
  { key: "wifi_rssi_db", nameKey: "wifiRssi", descKey: "wifiRssiDesc", type: "number", role: "value", unit: "dBm" },
  { key: "uptime_s", nameKey: "uptime", descKey: "uptimeDesc", type: "number", role: "value", unit: "s" },
];

/**
 * The measurement keys that live under `measurement.quality`. Precomputed once:
 * deciding whether the quality channel is needed happens on every ~1 Hz push per
 * device, and scanning all ~66 definitions there is work thrown away on a P1 that
 * reports no power-quality counters at all.
 */
export const QUALITY_KEYS: string[] = MEASUREMENT_STATE_DEFS.filter(d => d.id.startsWith("quality.")).map(d => d.key);

/**
 * Product types of the kWh Meter family. The official API v2 docs (docs/v2/system,
 * availability badges) mark two system features as not available on them: the
 * status LED brightness and the Identify action.
 */
export const KWH_PRODUCT_TYPES: ReadonlySet<string> = new Set(["HWE-KWH1", "HWE-KWH3", "SDM230-wifi", "SDM630-wifi"]);

/** The Plug-In Battery. It has no `/api/batteries` endpoint of its own (docs/v2/batteries). */
export const BATTERY_PRODUCT_TYPE = "HWE-BAT";

/**
 * Whether a product type offers the Identify action (docs/v2/system: not on the kWh Meter).
 *
 * @param productType Product type as the device reports it.
 */
export function supportsIdentify(productType: string): boolean {
  return !KWH_PRODUCT_TYPES.has(productType);
}

/**
 * Whether a product type serves the battery group (`/api/batteries` and the
 * `batteries` WebSocket topic). The endpoint lives on the P1 and kWh Meter; the
 * Plug-In Battery itself does not have it (docs/v2/batteries).
 *
 * @param productType Product type as the device reports it.
 */
export function servesBatteryGroup(productType: string): boolean {
  return productType !== BATTERY_PRODUCT_TYPE;
}
