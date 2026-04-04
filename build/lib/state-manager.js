"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var state_manager_exports = {};
__export(state_manager_exports, {
  StateManager: () => StateManager
});
module.exports = __toCommonJS(state_manager_exports);
function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}
const MEASUREMENT_STATE_DEFS = [
  // Power
  {
    key: "power_w",
    id: "power_w",
    name: "Total power",
    type: "number",
    role: "value.power",
    unit: "W"
  },
  {
    key: "power_l1_w",
    id: "power_l1_w",
    name: "Power L1",
    type: "number",
    role: "value.power",
    unit: "W"
  },
  {
    key: "power_l2_w",
    id: "power_l2_w",
    name: "Power L2",
    type: "number",
    role: "value.power",
    unit: "W"
  },
  {
    key: "power_l3_w",
    id: "power_l3_w",
    name: "Power L3",
    type: "number",
    role: "value.power",
    unit: "W"
  },
  // Voltage
  {
    key: "voltage_v",
    id: "voltage_v",
    name: "Voltage",
    type: "number",
    role: "value.voltage",
    unit: "V"
  },
  {
    key: "voltage_l1_v",
    id: "voltage_l1_v",
    name: "Voltage L1",
    type: "number",
    role: "value.voltage",
    unit: "V"
  },
  {
    key: "voltage_l2_v",
    id: "voltage_l2_v",
    name: "Voltage L2",
    type: "number",
    role: "value.voltage",
    unit: "V"
  },
  {
    key: "voltage_l3_v",
    id: "voltage_l3_v",
    name: "Voltage L3",
    type: "number",
    role: "value.voltage",
    unit: "V"
  },
  // Current
  {
    key: "current_a",
    id: "current_a",
    name: "Current",
    type: "number",
    role: "value.current",
    unit: "A"
  },
  {
    key: "current_l1_a",
    id: "current_l1_a",
    name: "Current L1",
    type: "number",
    role: "value.current",
    unit: "A"
  },
  {
    key: "current_l2_a",
    id: "current_l2_a",
    name: "Current L2",
    type: "number",
    role: "value.current",
    unit: "A"
  },
  {
    key: "current_l3_a",
    id: "current_l3_a",
    name: "Current L3",
    type: "number",
    role: "value.current",
    unit: "A"
  },
  // Frequency
  {
    key: "frequency_hz",
    id: "frequency_hz",
    name: "Frequency",
    type: "number",
    role: "value",
    unit: "Hz"
  },
  // Energy import
  {
    key: "energy_import_kwh",
    id: "energy_import_kwh",
    name: "Energy import total",
    type: "number",
    role: "value.energy",
    unit: "kWh"
  },
  {
    key: "energy_import_t1_kwh",
    id: "energy_import_t1_kwh",
    name: "Energy import T1",
    type: "number",
    role: "value.energy",
    unit: "kWh"
  },
  {
    key: "energy_import_t2_kwh",
    id: "energy_import_t2_kwh",
    name: "Energy import T2",
    type: "number",
    role: "value.energy",
    unit: "kWh"
  },
  {
    key: "energy_import_t3_kwh",
    id: "energy_import_t3_kwh",
    name: "Energy import T3",
    type: "number",
    role: "value.energy",
    unit: "kWh"
  },
  {
    key: "energy_import_t4_kwh",
    id: "energy_import_t4_kwh",
    name: "Energy import T4",
    type: "number",
    role: "value.energy",
    unit: "kWh"
  },
  // Energy export
  {
    key: "energy_export_kwh",
    id: "energy_export_kwh",
    name: "Energy export total",
    type: "number",
    role: "value.energy",
    unit: "kWh"
  },
  {
    key: "energy_export_t1_kwh",
    id: "energy_export_t1_kwh",
    name: "Energy export T1",
    type: "number",
    role: "value.energy",
    unit: "kWh"
  },
  {
    key: "energy_export_t2_kwh",
    id: "energy_export_t2_kwh",
    name: "Energy export T2",
    type: "number",
    role: "value.energy",
    unit: "kWh"
  },
  {
    key: "energy_export_t3_kwh",
    id: "energy_export_t3_kwh",
    name: "Energy export T3",
    type: "number",
    role: "value.energy",
    unit: "kWh"
  },
  {
    key: "energy_export_t4_kwh",
    id: "energy_export_t4_kwh",
    name: "Energy export T4",
    type: "number",
    role: "value.energy",
    unit: "kWh"
  },
  // Tariff
  {
    key: "tariff",
    id: "tariff",
    name: "Active tariff",
    type: "number",
    role: "value"
  },
  // Power quality
  {
    key: "voltage_sag_l1_count",
    id: "quality.voltage_sag_l1_count",
    name: "Voltage sag L1",
    type: "number",
    role: "value"
  },
  {
    key: "voltage_sag_l2_count",
    id: "quality.voltage_sag_l2_count",
    name: "Voltage sag L2",
    type: "number",
    role: "value"
  },
  {
    key: "voltage_sag_l3_count",
    id: "quality.voltage_sag_l3_count",
    name: "Voltage sag L3",
    type: "number",
    role: "value"
  },
  {
    key: "voltage_swell_l1_count",
    id: "quality.voltage_swell_l1_count",
    name: "Voltage swell L1",
    type: "number",
    role: "value"
  },
  {
    key: "voltage_swell_l2_count",
    id: "quality.voltage_swell_l2_count",
    name: "Voltage swell L2",
    type: "number",
    role: "value"
  },
  {
    key: "voltage_swell_l3_count",
    id: "quality.voltage_swell_l3_count",
    name: "Voltage swell L3",
    type: "number",
    role: "value"
  },
  {
    key: "any_power_fail_count",
    id: "quality.power_fail_count",
    name: "Power fail count",
    type: "number",
    role: "value"
  },
  {
    key: "long_power_fail_count",
    id: "quality.long_power_fail_count",
    name: "Long power fail count",
    type: "number",
    role: "value"
  },
  // Capacity tariff (Belgium)
  {
    key: "average_power_15m_w",
    id: "average_power_15m_w",
    name: "Average power 15min",
    type: "number",
    role: "value.power",
    unit: "W"
  },
  {
    key: "monthly_power_peak_w",
    id: "monthly_power_peak_w",
    name: "Monthly power peak",
    type: "number",
    role: "value.power",
    unit: "W"
  },
  {
    key: "monthly_power_peak_timestamp",
    id: "monthly_power_peak_timestamp",
    name: "Monthly power peak time",
    type: "string",
    role: "date"
  },
  // kWh meter specifics
  {
    key: "apparent_current_a",
    id: "apparent_current_a",
    name: "Apparent current",
    type: "number",
    role: "value.current",
    unit: "A"
  },
  {
    key: "reactive_current_a",
    id: "reactive_current_a",
    name: "Reactive current",
    type: "number",
    role: "value.current",
    unit: "A"
  },
  {
    key: "apparent_power_va",
    id: "apparent_power_va",
    name: "Apparent power",
    type: "number",
    role: "value.power",
    unit: "VA"
  },
  {
    key: "reactive_power_var",
    id: "reactive_power_var",
    name: "Reactive power",
    type: "number",
    role: "value.power",
    unit: "var"
  },
  {
    key: "power_factor",
    id: "power_factor",
    name: "Power factor",
    type: "number",
    role: "value"
  },
  // Battery specifics
  {
    key: "state_of_charge_pct",
    id: "state_of_charge_pct",
    name: "State of charge",
    type: "number",
    role: "value.battery",
    unit: "%"
  },
  {
    key: "cycles",
    id: "cycles",
    name: "Charge cycles",
    type: "number",
    role: "value"
  },
  // Metadata
  {
    key: "meter_model",
    id: "meter_model",
    name: "Meter model",
    type: "string",
    role: "text"
  },
  {
    key: "timestamp",
    id: "timestamp",
    name: "Measurement timestamp",
    type: "string",
    role: "date"
  }
];
class StateManager {
  adapter;
  /** @param adapter The ioBroker adapter instance */
  constructor(adapter) {
    this.adapter = adapter;
  }
  /**
   * Create device channel and info states
   *
   * @param config Device configuration
   */
  async createDeviceStates(config) {
    const prefix = this.devicePrefix(config);
    await this.adapter.extendObjectAsync(prefix, {
      type: "device",
      common: { name: config.productName || config.productType },
      native: {}
    });
    await this.adapter.extendObjectAsync(`${prefix}.info`, {
      type: "channel",
      common: { name: "Device Information" },
      native: {}
    });
    await this.createState(
      `${prefix}.info.productName`,
      "Product name",
      "string",
      "text",
      false
    );
    await this.createState(
      `${prefix}.info.productType`,
      "Product type",
      "string",
      "text",
      false
    );
    await this.createState(
      `${prefix}.info.firmware`,
      "Firmware version",
      "string",
      "text",
      false
    );
    await this.createState(
      `${prefix}.info.connected`,
      "Device connected",
      "boolean",
      "indicator.reachable",
      false
    );
    await this.createState(
      `${prefix}.info.wifi_rssi_db`,
      "WiFi signal strength",
      "number",
      "value",
      false,
      "dB"
    );
    await this.createState(
      `${prefix}.info.uptime_s`,
      "Uptime",
      "number",
      "value",
      false,
      "s"
    );
    await this.adapter.setStateAsync(`${prefix}.info.productName`, {
      val: config.productName,
      ack: true
    });
    await this.adapter.setStateAsync(`${prefix}.info.productType`, {
      val: config.productType,
      ack: true
    });
  }
  /**
   * Update measurement states — only creates states that have values
   *
   * @param config Device configuration
   * @param data Measurement data
   */
  async updateMeasurement(config, data) {
    var _a;
    const prefix = this.devicePrefix(config);
    const fields = MEASUREMENT_STATE_DEFS;
    for (const def of fields) {
      const rawValue = data[def.key];
      if (rawValue !== void 0 && rawValue !== null && !Array.isArray(rawValue)) {
        await this.ensureAndSet(
          `${prefix}.${def.id}`,
          def.name,
          def.type,
          def.role,
          rawValue,
          def.unit
        );
      }
    }
    if ((_a = data.external) == null ? void 0 : _a.length) {
      await this.adapter.extendObjectAsync(`${prefix}.external`, {
        type: "channel",
        common: { name: "External Meters" },
        native: {}
      });
      for (const ext of data.external) {
        const extId = `${prefix}.external.${sanitize(ext.type)}_${sanitize(ext.unique_id)}`;
        await this.adapter.extendObjectAsync(extId, {
          type: "channel",
          common: { name: ext.type },
          native: {}
        });
        await this.ensureAndSet(
          `${extId}.value`,
          "Value",
          "number",
          "value",
          ext.value,
          ext.unit
        );
        await this.ensureAndSet(
          `${extId}.unit`,
          "Unit",
          "string",
          "text",
          ext.unit
        );
        await this.ensureAndSet(
          `${extId}.timestamp`,
          "Timestamp",
          "string",
          "date",
          ext.timestamp
        );
      }
    }
  }
  /**
   * Update system states
   *
   * @param config Device configuration
   * @param system System info data
   */
  async updateSystem(config, system) {
    const prefix = this.devicePrefix(config);
    await this.ensureAndSet(
      `${prefix}.info.wifi_rssi_db`,
      "WiFi signal strength",
      "number",
      "value",
      system.wifi_rssi_db,
      "dB"
    );
    await this.ensureAndSet(
      `${prefix}.info.uptime_s`,
      "Uptime",
      "number",
      "value",
      system.uptime_s,
      "s"
    );
    await this.adapter.extendObjectAsync(`${prefix}.system`, {
      type: "channel",
      common: { name: "System Settings" },
      native: {}
    });
    await this.ensureAndSet(
      `${prefix}.system.cloud_enabled`,
      "Cloud enabled",
      "boolean",
      "switch",
      system.cloud_enabled,
      void 0,
      true
    );
    await this.ensureAndSet(
      `${prefix}.system.status_led_brightness_pct`,
      "LED brightness",
      "number",
      "level",
      system.status_led_brightness_pct,
      "%",
      true
    );
    if (system.api_v1_enabled !== void 0) {
      await this.ensureAndSet(
        `${prefix}.system.api_v1_enabled`,
        "API v1 enabled",
        "boolean",
        "switch",
        system.api_v1_enabled,
        void 0,
        true
      );
    }
    await this.createState(
      `${prefix}.system.reboot`,
      "Reboot device",
      "boolean",
      "button",
      true
    );
    await this.createState(
      `${prefix}.system.identify`,
      "Identify (blink LED)",
      "boolean",
      "button",
      true
    );
  }
  /**
   * Update battery control states
   *
   * @param config Device configuration
   * @param battery Battery control data
   */
  async updateBattery(config, battery) {
    const prefix = this.devicePrefix(config);
    await this.adapter.extendObjectAsync(`${prefix}.battery`, {
      type: "channel",
      common: { name: "Battery Control" },
      native: {}
    });
    await this.ensureAndSet(
      `${prefix}.battery.mode`,
      "Battery mode",
      "string",
      "text",
      battery.mode,
      void 0,
      true
    );
    if (battery.permissions !== void 0) {
      await this.ensureAndSet(
        `${prefix}.battery.permissions`,
        "Battery permissions",
        "string",
        "json",
        JSON.stringify(battery.permissions),
        void 0,
        true
      );
    }
    if (battery.battery_count !== void 0) {
      await this.ensureAndSet(
        `${prefix}.battery.battery_count`,
        "Connected batteries",
        "number",
        "value",
        battery.battery_count
      );
    }
    if (battery.power_w !== void 0) {
      await this.ensureAndSet(
        `${prefix}.battery.power_w`,
        "Battery power",
        "number",
        "value.power",
        battery.power_w,
        "W"
      );
    }
    if (battery.target_power_w !== void 0) {
      await this.ensureAndSet(
        `${prefix}.battery.target_power_w`,
        "Target power",
        "number",
        "value.power",
        battery.target_power_w,
        "W"
      );
    }
    if (battery.max_consumption_w !== void 0) {
      await this.ensureAndSet(
        `${prefix}.battery.max_consumption_w`,
        "Max consumption",
        "number",
        "value.power",
        battery.max_consumption_w,
        "W"
      );
    }
    if (battery.max_production_w !== void 0) {
      await this.ensureAndSet(
        `${prefix}.battery.max_production_w`,
        "Max production",
        "number",
        "value.power",
        battery.max_production_w,
        "W"
      );
    }
  }
  /**
   * Set device connected state
   *
   * @param config Device configuration
   * @param connected Connection status
   */
  async setDeviceConnected(config, connected) {
    const prefix = this.devicePrefix(config);
    await this.adapter.setStateAsync(`${prefix}.info.connected`, {
      val: connected,
      ack: true
    });
  }
  /**
   * Remove all states for a device
   *
   * @param config Device configuration
   */
  async removeDevice(config) {
    const prefix = this.devicePrefix(config);
    await this.adapter.delObjectAsync(prefix, { recursive: true });
  }
  /**
   * Get device object ID prefix
   *
   * @param config Device configuration
   */
  devicePrefix(config) {
    return `${sanitize(config.productType)}_${sanitize(config.serial)}`;
  }
  /**
   * Create a state if it doesn't exist
   *
   * @param id State ID
   * @param name State name
   * @param type Value type
   * @param role ioBroker role
   * @param write Whether state is writable
   * @param unit Optional unit
   */
  async createState(id, name, type, role, write, unit) {
    const common = {
      name,
      type,
      role,
      read: true,
      write
    };
    if (unit) {
      common.unit = unit;
    }
    await this.adapter.extendObjectAsync(id, {
      type: "state",
      common,
      native: {}
    });
  }
  /**
   * Ensure state exists and set value
   *
   * @param id State ID
   * @param name State name
   * @param type Value type
   * @param role ioBroker role
   * @param value State value
   * @param unit Optional unit
   * @param write Whether state is writable
   */
  async ensureAndSet(id, name, type, role, value, unit, write) {
    await this.createState(id, name, type, role, write != null ? write : false, unit);
    await this.adapter.setStateAsync(id, { val: value, ack: true });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateManager
});
//# sourceMappingURL=state-manager.js.map
