import type * as utils from "@iobroker/adapter-core";
import { coerceBoolean, coerceFiniteNumber, coerceString, isPlainObject } from "./coerce";
import type { I18nKey } from "./i18n";
import { resolveLabel, tDesc, tName } from "./i18n";
import type { BatteryControl, DeviceConfig, Measurement, SystemInfo } from "./types";

/** Measurement field to state definition mapping */
interface MeasurementStateDef {
  /** Measurement field key */
  key: string;
  /** ioBroker state ID suffix */
  id: string;
  /** Translation key for `common.name` (resolved via {@link tName}) */
  nameKey: I18nKey;
  /** Optional translation key for `common.desc` (resolved via {@link tDesc}) */
  descKey?: I18nKey;
  /** State value type */
  type: ioBroker.CommonType;
  /** ioBroker role */
  role: string;
  /** Unit string */
  unit?: string;
}

/**
 * Sanitize a string for use as ioBroker object ID (see adapter.FORBIDDEN_CHARS).
 *
 * @param str Raw string to sanitize
 */
function sanitize(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

const MEASUREMENT_STATE_DEFS: MeasurementStateDef[] = [
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
  { key: "frequency_hz", id: "frequency_hz", nameKey: "frequency", type: "number", role: "value", unit: "Hz" },
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
  { key: "tariff", id: "tariff", nameKey: "tariff", type: "number", role: "value" },
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
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "apparent_current_l1_a",
    id: "apparent_current_l1_a",
    nameKey: "apparentCurrentL1",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "apparent_current_l2_a",
    id: "apparent_current_l2_a",
    nameKey: "apparentCurrentL2",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "apparent_current_l3_a",
    id: "apparent_current_l3_a",
    nameKey: "apparentCurrentL3",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "reactive_current_a",
    id: "reactive_current_a",
    nameKey: "reactiveCurrent",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "reactive_current_l1_a",
    id: "reactive_current_l1_a",
    nameKey: "reactiveCurrentL1",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "reactive_current_l2_a",
    id: "reactive_current_l2_a",
    nameKey: "reactiveCurrentL2",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "reactive_current_l3_a",
    id: "reactive_current_l3_a",
    nameKey: "reactiveCurrentL3",
    type: "number",
    role: "value.current",
    unit: "A",
  },
  {
    key: "apparent_power_va",
    id: "apparent_power_va",
    nameKey: "apparentPower",
    type: "number",
    role: "value.power",
    unit: "VA",
  },
  {
    key: "apparent_power_l1_va",
    id: "apparent_power_l1_va",
    nameKey: "apparentPowerL1",
    type: "number",
    role: "value.power",
    unit: "VA",
  },
  {
    key: "apparent_power_l2_va",
    id: "apparent_power_l2_va",
    nameKey: "apparentPowerL2",
    type: "number",
    role: "value.power",
    unit: "VA",
  },
  {
    key: "apparent_power_l3_va",
    id: "apparent_power_l3_va",
    nameKey: "apparentPowerL3",
    type: "number",
    role: "value.power",
    unit: "VA",
  },
  {
    key: "reactive_power_var",
    id: "reactive_power_var",
    nameKey: "reactivePower",
    type: "number",
    role: "value.power",
    unit: "var",
  },
  {
    key: "reactive_power_l1_var",
    id: "reactive_power_l1_var",
    nameKey: "reactivePowerL1",
    type: "number",
    role: "value.power",
    unit: "var",
  },
  {
    key: "reactive_power_l2_var",
    id: "reactive_power_l2_var",
    nameKey: "reactivePowerL2",
    type: "number",
    role: "value.power",
    unit: "var",
  },
  {
    key: "reactive_power_l3_var",
    id: "reactive_power_l3_var",
    nameKey: "reactivePowerL3",
    type: "number",
    role: "value.power",
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
    unit: "%",
  },
  { key: "cycles", id: "cycles", nameKey: "cycles", type: "number", role: "value" },
  // Metadata
  { key: "meter_model", id: "meter_model", nameKey: "meterModel", type: "string", role: "text" },
  { key: "timestamp", id: "timestamp", nameKey: "measurementTimestamp", type: "string", role: "date" },
];

/**
 * Build a `common.states` map for tariff (T1-T4) with plain-string labels.
 *
 * **VALUES MUST be plain-string** — Admin renders states-values as React
 * children. Translation objects trigger React Error #31 → fatal "Error in GUI"
 * on dropdown open (verified hassemu v1.28.4, 2026-05-12).
 *
 */
function tariffStates(): Record<string, string> {
  return {
    1: resolveLabel("tariff1"),
    2: resolveLabel("tariff2"),
    3: resolveLabel("tariff3"),
    4: resolveLabel("tariff4"),
  };
}

/**
 * Build a `common.states` map for HWE-BAT battery.mode with plain-string labels.
 * Same constraint as {@link tariffStates}.
 *
 */
function batteryModeStates(): Record<string, string> {
  return {
    zero: resolveLabel("modeZero"),
    to_full: resolveLabel("modeToFull"),
    standby: resolveLabel("modeStandby"),
  };
}

/** Manages ioBroker state creation and updates for HomeWizard devices */
export class StateManager {
  private readonly adapter: utils.AdapterInstance;
  /**
   * Cache of state / channel IDs that have already passed
   * `setObjectNotExistsAsync`. Skips repeat DB lookups on the hot path —
   * a P1 meter pushes ~1 measurement/s with up to ~30 active fields, which
   * otherwise meant ~30 Redis lookups per second just to ask „does it
   * exist". On `removeDevice(prefix)` all `prefix.*` IDs are dropped.
   */
  private readonly createdIds = new Set<string>();

  /** @param adapter The ioBroker adapter instance */
  constructor(adapter: utils.AdapterInstance) {
    this.adapter = adapter;
  }

  /**
   * Create device channel and info states
   *
   * @param config Device configuration
   */
  async createDeviceStates(config: DeviceConfig): Promise<void> {
    const prefix = this.devicePrefix(config);

    this.adapter.log.debug(`state-manager: createDeviceStates ${prefix} (productType=${config.productType})`);

    // Device-Object: common.name keeps the user-supplied product name (or product type as fallback) —
    // these are device-specific identifiers, NOT translatable.
    await this.adapter.extendObjectAsync(
      prefix,
      {
        type: "device",
        common: {
          name: config.productName || config.productType,
          statusStates: {
            onlineId: `${this.adapter.namespace}.${prefix}.info.connected`,
          },
        },
        native: {},
      },
      { preserve: { common: ["name"] } },
    );

    await this.adapter.extendObjectAsync(
      `${prefix}.info`,
      {
        type: "channel",
        common: { name: tName("deviceInformation") },
        native: {},
      },
      { preserve: { common: ["name"] } },
    );

    await this.createState(`${prefix}.info.productName`, tName("productName"), "string", "text", false);
    await this.createState(`${prefix}.info.productType`, tName("productType"), "string", "text", false);
    await this.createState(`${prefix}.info.firmware`, tName("firmware"), "string", "text", false);
    await this.createState(`${prefix}.info.connected`, tName("connected"), "boolean", "indicator.reachable", false);
    await this.createState(`${prefix}.info.wifi_rssi_db`, tName("wifiRssi"), "number", "value", false, "dBm");
    await this.createState(`${prefix}.info.uptime_s`, tName("uptime"), "number", "value", false, "s");

    // Remove device button
    await this.createButton(`${prefix}.remove`, tName("removeDevice"), tDesc("removeDeviceDesc"));

    // Set initial info values
    await this.adapter.setStateAsync(`${prefix}.info.productName`, {
      val: config.productName,
      ack: true,
    });
    await this.adapter.setStateAsync(`${prefix}.info.productType`, {
      val: config.productType,
      ack: true,
    });
  }

  /**
   * Update measurement states — only creates states that have values
   *
   * @param config Device configuration
   * @param data Measurement data
   */
  async updateMeasurement(config: DeviceConfig, data: Measurement): Promise<void> {
    if (!isPlainObject(data)) {
      return;
    }
    const prefix = this.devicePrefix(config);
    const mPrefix = `${prefix}.measurement`;

    // Ensure measurement channel exists (cached after first call per device)
    await this.ensureChannel(mPrefix, tName("measurement"));

    // Main measurement values — coerce per declared type. Once a state's object
    // is in the cache, ensureAndSet only does one setStateAsync per field — those
    // are independent and run in parallel via Promise.all instead of sequentially.
    const record = data;
    const writes: Promise<void>[] = [];
    for (const def of MEASUREMENT_STATE_DEFS) {
      const raw = record[def.key];
      let coerced: number | string | null = null;
      if (def.type === "number") {
        coerced = coerceFiniteNumber(raw);
      } else if (def.type === "string") {
        coerced = coerceString(raw);
      }
      if (coerced !== null) {
        writes.push(
          this.ensureAndSet(
            `${mPrefix}.${def.id}`,
            tName(def.nameKey),
            def.type,
            def.role,
            coerced,
            def.unit,
            undefined,
            def.descKey ? tDesc(def.descKey) : undefined,
            def.key === "tariff" ? tariffStates() : undefined,
          ),
        );
      }
    }
    await Promise.all(writes);

    // External meters (P1 gas/water/heat) — channel-create paths must run sequentially
    // because the parent `external` channel must exist before the per-meter channel
    // and the per-meter value/unit/timestamp states. Inside one meter, the three
    // value/unit/timestamp writes are independent and run in parallel.
    const external = record.external;
    if (Array.isArray(external) && external.length > 0) {
      for (const rawExt of external) {
        if (!isPlainObject(rawExt)) {
          continue;
        }
        const type = coerceString(rawExt.type);
        const uniqueId = coerceString(rawExt.unique_id);
        if (!type || !uniqueId) {
          continue;
        }

        const value = coerceFiniteNumber(rawExt.value);
        const unit = coerceString(rawExt.unit);
        const timestamp = coerceString(rawExt.timestamp);

        await this.ensureChannel(`${mPrefix}.external`, tName("externalMeters"));

        const extId = `${mPrefix}.external.${sanitize(type)}_${sanitize(uniqueId)}`;
        // External meter channel keeps the device-supplied type (e.g. "gas_meter")
        // as channel name — identifies the physical meter, not localizable.
        await this.ensureChannel(extId, type);

        const extWrites: Promise<void>[] = [];
        if (value !== null) {
          extWrites.push(
            this.ensureAndSet(`${extId}.value`, tName("externalValue"), "number", "value", value, unit ?? undefined),
          );
        }
        if (unit) {
          extWrites.push(this.ensureAndSet(`${extId}.unit`, tName("externalUnit"), "string", "text", unit));
        }
        if (timestamp) {
          extWrites.push(
            this.ensureAndSet(`${extId}.timestamp`, tName("externalTimestamp"), "string", "date", timestamp),
          );
        }
        await Promise.all(extWrites);
      }
    }
  }

  /**
   * Update system states
   *
   * @param config Device configuration
   * @param system System info data
   */
  async updateSystem(config: DeviceConfig, system: SystemInfo): Promise<void> {
    if (!isPlainObject(system)) {
      return;
    }
    const prefix = this.devicePrefix(config);
    const record = system as Record<string, unknown>;

    // WiFi/uptime in info channel
    const rssi = coerceFiniteNumber(record.wifi_rssi_db);
    if (rssi !== null) {
      await this.ensureAndSet(`${prefix}.info.wifi_rssi_db`, tName("wifiRssi"), "number", "value", rssi, "dBm");
    }
    const uptime = coerceFiniteNumber(record.uptime_s);
    if (uptime !== null) {
      await this.ensureAndSet(`${prefix}.info.uptime_s`, tName("uptime"), "number", "value", uptime, "s");
    }

    // System control channel (cached after first call per device)
    await this.ensureChannel(`${prefix}.system`, tName("systemSettings"));

    const cloudEnabled = coerceBoolean(record.cloud_enabled);
    if (cloudEnabled !== null) {
      await this.ensureAndSet(
        `${prefix}.system.cloud_enabled`,
        tName("cloudEnabled"),
        "boolean",
        "switch",
        cloudEnabled,
        undefined,
        true,
      );
    }
    const ledPct = coerceFiniteNumber(record.status_led_brightness_pct);
    if (ledPct !== null) {
      await this.ensureAndSet(
        `${prefix}.system.status_led_brightness_pct`,
        tName("ledBrightness"),
        "number",
        "level",
        ledPct,
        "%",
        true,
      );
    }

    const apiV1 = coerceBoolean(record.api_v1_enabled);
    if (apiV1 !== null) {
      await this.ensureAndSet(
        `${prefix}.system.api_v1_enabled`,
        tName("apiV1Enabled"),
        "boolean",
        "switch",
        apiV1,
        undefined,
        true,
      );
    }

    // Action buttons
    await this.createButton(`${prefix}.system.reboot`, tName("rebootDevice"));
    await this.createButton(`${prefix}.system.identify`, tName("identify"));
  }

  /**
   * Update battery control states
   *
   * @param config Device configuration
   * @param battery Battery control data
   */
  async updateBattery(config: DeviceConfig, battery: BatteryControl): Promise<void> {
    if (!isPlainObject(battery)) {
      return;
    }
    const prefix = this.devicePrefix(config);
    const record = battery as Record<string, unknown>;

    await this.ensureChannel(`${prefix}.battery`, tName("batteryControl"));

    const mode = coerceString(record.mode);
    if (mode) {
      await this.ensureAndSet(
        `${prefix}.battery.mode`,
        tName("batteryMode"),
        "string",
        "text",
        mode,
        undefined,
        true,
        tDesc("batteryModeDesc"),
        batteryModeStates(),
      );
    }
    if (Array.isArray(record.permissions)) {
      await this.ensureAndSet(
        `${prefix}.battery.permissions`,
        tName("batteryPermissions"),
        "string",
        "json",
        JSON.stringify(record.permissions),
        undefined,
        true,
      );
    }

    const numberFields: Array<{
      key: string;
      id: string;
      nameKey: I18nKey;
      role: string;
      unit?: string;
    }> = [
      { key: "battery_count", id: "battery_count", nameKey: "batteryCount", role: "value" },
      { key: "power_w", id: "power_w", nameKey: "batteryPower", role: "value.power", unit: "W" },
      { key: "target_power_w", id: "target_power_w", nameKey: "batteryTargetPower", role: "value.power", unit: "W" },
      {
        key: "max_consumption_w",
        id: "max_consumption_w",
        nameKey: "batteryMaxConsumption",
        role: "value.power",
        unit: "W",
      },
      {
        key: "max_production_w",
        id: "max_production_w",
        nameKey: "batteryMaxProduction",
        role: "value.power",
        unit: "W",
      },
    ];
    for (const field of numberFields) {
      const coerced = coerceFiniteNumber(record[field.key]);
      if (coerced !== null) {
        await this.ensureAndSet(
          `${prefix}.battery.${field.id}`,
          tName(field.nameKey),
          "number",
          field.role,
          coerced,
          field.unit,
        );
      }
    }
  }

  /**
   * Set device connected state
   *
   * @param config Device configuration
   * @param connected Connection status
   */
  async setDeviceConnected(config: DeviceConfig, connected: boolean): Promise<void> {
    const prefix = this.devicePrefix(config);
    await this.adapter.setStateAsync(`${prefix}.info.connected`, {
      val: connected,
      ack: true,
    });
  }

  /**
   * Remove all states for a device
   *
   * @param config Device configuration
   */
  async removeDevice(config: DeviceConfig): Promise<void> {
    const prefix = this.devicePrefix(config);
    this.adapter.log.debug(`state-manager: removeDevice ${prefix}`);
    await this.adapter.delObjectAsync(prefix, { recursive: true });
    // Drop cache entries belonging to this device — re-pairing the same
    // device must re-create channels/states from scratch.
    let dropped = 0;
    for (const id of this.createdIds) {
      if (id === prefix || id.startsWith(`${prefix}.`)) {
        this.createdIds.delete(id);
        dropped++;
      }
    }
    this.adapter.log.debug(`state-manager: removeDevice ${prefix} done (dropped ${dropped} cached IDs)`);
  }

  /**
   * Remove measurement states from old locations (pre-v0.4.0: device root instead of measurement/ channel)
   *
   * @param config Device configuration
   */
  async cleanupMovedStates(config: DeviceConfig): Promise<void> {
    const prefix = this.devicePrefix(config);
    this.adapter.log.debug(`state-manager: cleanupMovedStates ${prefix} (scanning pre-v0.4.0 paths)`);

    // Old paths: states were at device root, now under measurement/
    const oldIds: string[] = [];
    for (const def of MEASUREMENT_STATE_DEFS) {
      oldIds.push(`${prefix}.${def.id}`);
    }
    // External was at device root too
    oldIds.push(`${prefix}.external`);

    let removed = 0;
    for (const id of oldIds) {
      if (await this.adapter.getObjectAsync(id)) {
        await this.adapter.delObjectAsync(id, { recursive: true });
        this.adapter.log.debug(`Removed obsolete state: ${id}`);
        removed++;
      }
    }
    if (removed > 0) {
      this.adapter.log.debug(`state-manager: cleanupMovedStates ${prefix} done (removed ${removed} obsolete paths)`);
    }
  }

  /**
   * Get device object ID prefix
   *
   * @param config Device configuration
   */
  devicePrefix(config: DeviceConfig): string {
    return `${sanitize(config.productType)}_${sanitize(config.serial)}`;
  }

  /**
   * Ensure a channel object exists. Skips the DB lookup once `id` is in the
   * cache — channels are static after first creation per device.
   *
   * @param id   Full channel ID (`<prefix>.<channelName>`).
   * @param name Display name (translation object or device-supplied string).
   */
  private async ensureChannel(id: string, name: ioBroker.StringOrTranslated): Promise<void> {
    if (this.createdIds.has(id)) {
      return;
    }
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "channel",
      common: { name },
      native: {},
    });
    this.createdIds.add(id);
  }

  /**
   * Create a state if it doesn't exist
   *
   * @param id    State ID
   * @param name  State name (translation object or string for device identifiers)
   * @param type  Value type
   * @param role  ioBroker role
   * @param write Whether state is writable
   * @param unit  Optional unit
   * @param desc  Optional translation object for `common.desc`
   * @param states Optional `common.states` map
   */
  private async createState(
    id: string,
    name: ioBroker.StringOrTranslated,
    type: ioBroker.CommonType,
    role: string,
    write: boolean,
    unit?: string,
    desc?: ioBroker.StringOrTranslated,
    states?: Record<string, string>,
  ): Promise<void> {
    if (this.createdIds.has(id)) {
      return;
    }
    const common: Partial<ioBroker.StateCommon> = {
      name,
      type,
      role,
      read: true,
      write,
    };
    if (unit) {
      common.unit = unit;
    }
    if (desc) {
      common.desc = desc;
    }
    if (states) {
      common.states = states;
    }
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "state",
      common: common as ioBroker.StateCommon,
      native: {},
    });
    if (states) {
      // Existing datapoints from earlier releases may carry translation-object
      // VALUES in `common.states` (v0.7.0 introduced tLabel-as-string casts).
      // setObjectNotExistsAsync is a no-op for those — actively replace if any
      // value is not plain-string. Admin renders states-values as React child:
      // an object triggers React Error #31 → fatal "Error in GUI" on dropdown.
      await this.repairCommonStatesIfBuggy(id, states);
    }
    this.createdIds.add(id);
  }

  /**
   * If the persisted object at `id` has `common.states` values that are not
   * plain-string (= translation objects from older releases), replace
   * `common.states` with the fresh map via `setObjectAsync`. Otherwise no-op.
   *
   * `extendObjectAsync` deep-merges and CANNOT replace an object-value with
   * a string — only a full `setObjectAsync` replaces. Pattern proven in
   * hassemu v1.27.2 (URL-dropdown) and v1.28.4 (mode-dropdown).
   *
   * @param id    State ID to repair.
   * @param fresh Plain-string `common.states` map to write.
   */
  private async repairCommonStatesIfBuggy(id: string, fresh: Record<string, string>): Promise<void> {
    const existing = await this.adapter.getObjectAsync(id);
    if (!existing) {
      return;
    }
    const states = existing.common?.states;
    if (!states || typeof states !== "object") {
      return;
    }
    const buggy = Object.values(states as Record<string, unknown>).some(v => typeof v !== "string");
    if (!buggy) {
      return;
    }
    existing.common = { ...existing.common, states: fresh } as ioBroker.StateCommon;
    await this.adapter.setObjectAsync(id, existing);
  }

  /**
   * Create a button state (read: false, write: true) with initial value false
   *
   * @param id   State ID
   * @param name Button label (translation object)
   * @param desc Optional translation object for `common.desc`
   */
  private async createButton(
    id: string,
    name: ioBroker.StringOrTranslated,
    desc?: ioBroker.StringOrTranslated,
  ): Promise<void> {
    if (this.createdIds.has(id)) {
      return;
    }
    const common: Partial<ioBroker.StateCommon> = {
      name: name,
      type: "boolean",
      role: "button",
      read: false,
      write: true,
    };
    if (desc) {
      common.desc = desc;
    }
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "state",
      common: common as ioBroker.StateCommon,
      native: {},
    });
    await this.adapter.setStateAsync(id, { val: false, ack: true });
    this.createdIds.add(id);
  }

  /**
   * Ensure state exists and set value
   *
   * @param id     State ID
   * @param name   State name (translation object or string)
   * @param type   Value type
   * @param role   ioBroker role
   * @param value  State value
   * @param unit   Optional unit
   * @param write  Whether state is writable
   * @param desc   Optional translation object for `common.desc`
   * @param states Optional `common.states` map (translation objects)
   */
  private async ensureAndSet(
    id: string,
    name: ioBroker.StringOrTranslated,
    type: ioBroker.CommonType,
    role: string,
    value: ioBroker.StateValue,
    unit?: string,
    write?: boolean,
    desc?: ioBroker.StringOrTranslated,
    states?: Record<string, string>,
  ): Promise<void> {
    await this.createState(id, name, type, role, write ?? false, unit, desc, states);
    await this.adapter.setStateAsync(id, { val: value, ack: true });
  }
}
