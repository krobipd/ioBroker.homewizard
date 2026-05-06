import type * as utils from "@iobroker/adapter-core";
import { coerceBoolean, coerceFiniteNumber, coerceString, isPlainObject } from "./coerce";
import type { StateName, STATE_DESCS, STATE_NAMES } from "./i18n-states";
import { tDesc, tLabel, tName } from "./i18n-states";
import type { BatteryControl, DeviceConfig, Measurement, SystemInfo } from "./types";

/** Measurement field to state definition mapping */
interface MeasurementStateDef {
  /** Measurement field key */
  key: string;
  /** ioBroker state ID suffix */
  id: string;
  /** Translation key for `common.name` (resolved via {@link tName}) */
  nameKey: keyof typeof STATE_NAMES;
  /** Optional translation key for `common.desc` (resolved via {@link tDesc}) */
  descKey?: keyof typeof STATE_DESCS;
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
 * Translation-object cast helper — ioBroker's `common.name`/`desc` accept `StringOrTranslated`.
 *
 * @param name Translation object from {@link STATE_NAMES} or {@link STATE_DESCS}.
 */
function asName(name: StateName): ioBroker.StringOrTranslated {
  return name;
}

/** Build a `common.states` map where the values are translation objects (admin v6+). */
function tariffStates(): Record<string, string> {
  return {
    1: tLabel("tariff1") as unknown as string,
    2: tLabel("tariff2") as unknown as string,
    3: tLabel("tariff3") as unknown as string,
    4: tLabel("tariff4") as unknown as string,
  };
}
function batteryModeStates(): Record<string, string> {
  return {
    zero: tLabel("modeZero") as unknown as string,
    to_full: tLabel("modeToFull") as unknown as string,
    standby: tLabel("modeStandby") as unknown as string,
  };
}

/** Manages ioBroker state creation and updates for HomeWizard devices */
export class StateManager {
  private readonly adapter: utils.AdapterInstance;

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

    // Device-Object: common.name keeps the user-supplied product name (or product type as fallback) —
    // these are device-specific identifiers, NOT translatable.
    await this.adapter.extendObjectAsync(prefix, {
      type: "device",
      common: {
        name: config.productName || config.productType,
        statusStates: {
          onlineId: `${this.adapter.namespace}.${prefix}.info.connected`,
        },
      } as ioBroker.DeviceCommon,
      native: {},
    });

    await this.adapter.extendObjectAsync(`${prefix}.info`, {
      type: "channel",
      common: { name: asName(tName("deviceInformation")) },
      native: {},
    });

    await this.createState(`${prefix}.info.productName`, tName("productName"), "string", "text", false);
    await this.createState(`${prefix}.info.productType`, tName("productType"), "string", "text", false);
    await this.createState(`${prefix}.info.firmware`, tName("firmware"), "string", "text", false);
    await this.createState(`${prefix}.info.connected`, tName("connected"), "boolean", "indicator.reachable", false);
    await this.createState(`${prefix}.info.wifi_rssi_db`, tName("wifiRssi"), "number", "value", false, "dB");
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

    // Ensure measurement channel exists
    await this.adapter.setObjectNotExistsAsync(mPrefix, {
      type: "channel",
      common: { name: asName(tName("measurement")) },
      native: {},
    });

    // Main measurement values — coerce per declared type
    const record = data;
    for (const def of MEASUREMENT_STATE_DEFS) {
      const raw = record[def.key];
      let coerced: number | string | null = null;
      if (def.type === "number") {
        coerced = coerceFiniteNumber(raw);
      } else if (def.type === "string") {
        coerced = coerceString(raw);
      }
      if (coerced !== null) {
        await this.ensureAndSet(
          `${mPrefix}.${def.id}`,
          tName(def.nameKey),
          def.type,
          def.role,
          coerced,
          def.unit,
          undefined,
          def.descKey ? tDesc(def.descKey) : undefined,
          def.key === "tariff" ? tariffStates() : undefined,
        );
      }
    }

    // External meters (P1 gas/water/heat)
    const external = record.external;
    if (Array.isArray(external) && external.length > 0) {
      let extChannelEnsured = false;

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

        if (!extChannelEnsured) {
          await this.adapter.setObjectNotExistsAsync(`${mPrefix}.external`, {
            type: "channel",
            common: { name: asName(tName("externalMeters")) },
            native: {},
          });
          extChannelEnsured = true;
        }

        const extId = `${mPrefix}.external.${sanitize(type)}_${sanitize(uniqueId)}`;
        // External meter channel keeps the device-supplied type (e.g. "gas_meter") as channel name —
        // identifies the physical meter, not localizable.
        await this.adapter.setObjectNotExistsAsync(extId, {
          type: "channel",
          common: { name: type },
          native: {},
        });
        if (value !== null) {
          await this.ensureAndSet(
            `${extId}.value`,
            tName("externalValue"),
            "number",
            "value",
            value,
            unit ?? undefined,
          );
        }
        if (unit) {
          await this.ensureAndSet(`${extId}.unit`, tName("externalUnit"), "string", "text", unit);
        }
        if (timestamp) {
          await this.ensureAndSet(`${extId}.timestamp`, tName("externalTimestamp"), "string", "date", timestamp);
        }
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
      await this.ensureAndSet(`${prefix}.info.wifi_rssi_db`, tName("wifiRssi"), "number", "value", rssi, "dB");
    }
    const uptime = coerceFiniteNumber(record.uptime_s);
    if (uptime !== null) {
      await this.ensureAndSet(`${prefix}.info.uptime_s`, tName("uptime"), "number", "value", uptime, "s");
    }

    // System control channel
    await this.adapter.setObjectNotExistsAsync(`${prefix}.system`, {
      type: "channel",
      common: { name: asName(tName("systemSettings")) },
      native: {},
    });

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

    await this.adapter.setObjectNotExistsAsync(`${prefix}.battery`, {
      type: "channel",
      common: { name: asName(tName("batteryControl")) },
      native: {},
    });

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
      nameKey: keyof typeof STATE_NAMES;
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
    await this.adapter.delObjectAsync(prefix, { recursive: true });
  }

  /**
   * Remove measurement states from old locations (pre-v0.4.0: device root instead of measurement/ channel)
   *
   * @param config Device configuration
   */
  async cleanupMovedStates(config: DeviceConfig): Promise<void> {
    const prefix = this.devicePrefix(config);

    // Old paths: states were at device root, now under measurement/
    const oldIds: string[] = [];
    for (const def of MEASUREMENT_STATE_DEFS) {
      oldIds.push(`${prefix}.${def.id}`);
    }
    // External was at device root too
    oldIds.push(`${prefix}.external`);

    for (const id of oldIds) {
      if (await this.adapter.getObjectAsync(id)) {
        await this.adapter.delObjectAsync(id, { recursive: true });
        this.adapter.log.debug(`Removed obsolete state: ${id}`);
      }
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
    name: StateName | string,
    type: ioBroker.CommonType,
    role: string,
    write: boolean,
    unit?: string,
    desc?: StateName,
    states?: Record<string, string>,
  ): Promise<void> {
    const common: Partial<ioBroker.StateCommon> = {
      name: typeof name === "string" ? name : asName(name),
      type,
      role,
      read: true,
      write,
    };
    if (unit) {
      common.unit = unit;
    }
    if (desc) {
      common.desc = asName(desc);
    }
    if (states) {
      common.states = states;
    }
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "state",
      common: common as ioBroker.StateCommon,
      native: {},
    });
  }

  /**
   * Create a button state (read: false, write: true) with initial value false
   *
   * @param id   State ID
   * @param name Button label (translation object)
   * @param desc Optional translation object for `common.desc`
   */
  private async createButton(id: string, name: StateName, desc?: StateName): Promise<void> {
    const common: Partial<ioBroker.StateCommon> = {
      name: asName(name),
      type: "boolean",
      role: "button",
      read: false,
      write: true,
    };
    if (desc) {
      common.desc = asName(desc);
    }
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "state",
      common: common as ioBroker.StateCommon,
      native: {},
    });
    await this.adapter.setStateAsync(id, { val: false, ack: true });
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
    name: StateName | string,
    type: ioBroker.CommonType,
    role: string,
    value: ioBroker.StateValue,
    unit?: string,
    write?: boolean,
    desc?: StateName,
    states?: Record<string, string>,
  ): Promise<void> {
    await this.createState(id, name, type, role, write ?? false, unit, desc, states);
    await this.adapter.setStateAsync(id, { val: value, ack: true });
  }
}
