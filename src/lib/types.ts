import type { BatteryMode } from "./coerce";
import type { HomeWizardWebSocket } from "./websocket-client";

/** Persisted config for a single paired device (stored in device object native) */
export interface DeviceConfig {
  /** Bearer token (encrypted via adapter.encrypt) */
  token: string;
  /** Product type (e.g. HWE-P1) */
  productType: string;
  /** Device serial number */
  serial: string;
  /** Human-readable product name */
  productName: string;
  /** Fixed IP address (only when manually set, empty = mDNS) */
  ip?: string;
  /**
   * Server certificate CN captured at pairing (`appliance/<product_type>/<serial>`).
   * Pins the TLS identity for established connections (see {@link createDeviceAgent}).
   * Absent on devices paired before v0.13.0 — captured lazily on the next connect.
   */
  certCn?: string;
}

/** Response from GET /api */
export interface DeviceInfo {
  /** Product name */
  product_name: string;
  /** Product type identifier */
  product_type: string;
  /** Device serial number */
  serial: string;
  /** Firmware version string */
  firmware_version: string;
  /** API version string */
  api_version: string;
}

/** Response from POST /api/user (pairing) */
export interface PairingResponse {
  /** Bearer token for API access */
  token: string;
}

/** Measurement data from GET /api/measurement or WebSocket push */
export interface Measurement {
  /** Unique meter identifier */
  unique_id?: string;
  /** Protocol version */
  protocol_version?: number;
  /** Meter model */
  meter_model?: string;
  /** Measurement timestamp */
  timestamp?: string;
  /** Active tariff number */
  tariff?: number;

  /** Total energy import in kWh */
  energy_import_kwh?: number;
  /** Energy import tariff 1 */
  energy_import_t1_kwh?: number;
  /** Energy import tariff 2 */
  energy_import_t2_kwh?: number;
  /** Energy import tariff 3 */
  energy_import_t3_kwh?: number;
  /** Energy import tariff 4 */
  energy_import_t4_kwh?: number;
  /** Total energy export in kWh */
  energy_export_kwh?: number;
  /** Energy export tariff 1 */
  energy_export_t1_kwh?: number;
  /** Energy export tariff 2 */
  energy_export_t2_kwh?: number;
  /** Energy export tariff 3 */
  energy_export_t3_kwh?: number;
  /** Energy export tariff 4 */
  energy_export_t4_kwh?: number;

  /** Total active power in W */
  power_w?: number;
  /** Active power phase 1 */
  power_l1_w?: number;
  /** Active power phase 2 */
  power_l2_w?: number;
  /** Active power phase 3 */
  power_l3_w?: number;

  /** Voltage (single phase) */
  voltage_v?: number;
  /** Voltage phase 1 */
  voltage_l1_v?: number;
  /** Voltage phase 2 */
  voltage_l2_v?: number;
  /** Voltage phase 3 */
  voltage_l3_v?: number;

  /** Current (single phase) */
  current_a?: number;
  /** Current phase 1 */
  current_l1_a?: number;
  /** Current phase 2 */
  current_l2_a?: number;
  /** Current phase 3 */
  current_l3_a?: number;

  /** Grid frequency in Hz */
  frequency_hz?: number;

  /** Voltage sag count phase 1 */
  voltage_sag_l1_count?: number;
  /** Voltage sag count phase 2 */
  voltage_sag_l2_count?: number;
  /** Voltage sag count phase 3 */
  voltage_sag_l3_count?: number;
  /** Voltage swell count phase 1 */
  voltage_swell_l1_count?: number;
  /** Voltage swell count phase 2 */
  voltage_swell_l2_count?: number;
  /** Voltage swell count phase 3 */
  voltage_swell_l3_count?: number;
  /** Any power fail count */
  any_power_fail_count?: number;
  /** Long power fail count */
  long_power_fail_count?: number;

  /** Average power over 15 min (Belgium) */
  average_power_15m_w?: number;
  /** Monthly power peak (Belgium) */
  monthly_power_peak_w?: number;
  /** Monthly power peak timestamp (Belgium) */
  monthly_power_peak_timestamp?: string;

  /** Apparent current */
  apparent_current_a?: number;
  /** Reactive current */
  reactive_current_a?: number;
  /** Apparent power in VA */
  apparent_power_va?: number;
  /** Reactive power in var */
  reactive_power_var?: number;
  /** Power factor */
  power_factor?: number;
  /** Apparent current phase 1 */
  apparent_current_l1_a?: number;
  /** Apparent current phase 2 */
  apparent_current_l2_a?: number;
  /** Apparent current phase 3 */
  apparent_current_l3_a?: number;
  /** Reactive current phase 1 */
  reactive_current_l1_a?: number;
  /** Reactive current phase 2 */
  reactive_current_l2_a?: number;
  /** Reactive current phase 3 */
  reactive_current_l3_a?: number;
  /** Apparent power phase 1 */
  apparent_power_l1_va?: number;
  /** Apparent power phase 2 */
  apparent_power_l2_va?: number;
  /** Apparent power phase 3 */
  apparent_power_l3_va?: number;
  /** Reactive power phase 1 */
  reactive_power_l1_var?: number;
  /** Reactive power phase 2 */
  reactive_power_l2_var?: number;
  /** Reactive power phase 3 */
  reactive_power_l3_var?: number;
  /** Power factor phase 1 */
  power_factor_l1?: number;
  /** Power factor phase 2 */
  power_factor_l2?: number;
  /** Power factor phase 3 */
  power_factor_l3?: number;

  /** Battery state of charge in percent */
  state_of_charge_pct?: number;
  /** Battery charge cycles */
  cycles?: number;

  /** External meters (gas, water, heat) */
  external?: ExternalMeter[];
}

/** External meter attached to P1 (gas, water, heat) */
export interface ExternalMeter {
  /** Unique meter identifier */
  unique_id: string;
  /** Meter type */
  type: "gas_meter" | "heat_meter" | "warm_water_meter" | "water_meter" | "inlet_heat_meter";
  /** Last reading timestamp */
  timestamp: string;
  /** Meter reading value */
  value: number;
  /** Measurement unit */
  unit: string;
}

/** System info from GET /api/system */
export interface SystemInfo {
  /** WiFi SSID */
  wifi_ssid: string;
  /** WiFi signal strength in dB */
  wifi_rssi_db: number;
  /** Uptime in seconds */
  uptime_s: number;
  /** Cloud communication enabled */
  cloud_enabled: boolean;
  /** Status LED brightness 0-100% */
  status_led_brightness_pct: number;
  /** Legacy API v1 enabled */
  api_v1_enabled?: boolean;
}

/** Writable subset of system settings (PUT /api/system) — read-only fields (uptime_s, wifi_*) stay unrepresentable in a write. */
export interface SystemSettingsWrite {
  /** Enable/disable the HomeWizard cloud connection. */
  cloud_enabled?: boolean;
  /** Status LED brightness 0-100%. */
  status_led_brightness_pct?: number;
  /** Enable/disable the legacy v1 API on the device. */
  api_v1_enabled?: boolean;
}

/** Writable subset of battery settings (PUT /api/batteries) — read-only fields (power_w, battery_count) stay unrepresentable in a write. */
export interface BatterySettingsWrite {
  /** Battery mode. */
  mode?: BatteryMode;
  /** Battery permissions (`charge_allowed` / `discharge_allowed`). */
  permissions?: string[];
  /** Charge all batteries to 100% (one-shot). */
  charge_to_full?: boolean;
}

/** Battery control from GET /api/batteries (battery-group level) */
export interface BatteryControl {
  /** Battery mode (`predictive` since API 2.3.0). Union derived from the single source {@link BatteryMode}. */
  mode: BatteryMode;
  /** Battery permissions (`charge_allowed` / `discharge_allowed`) */
  permissions?: string[];
  /** Charge all batteries to 100% (writable, API 2.3.0) */
  charge_to_full?: boolean;
  /** Number of connected batteries */
  battery_count?: number;
  /** Current combined power in W */
  power_w?: number;
  /** Target power in W */
  target_power_w?: number;
  /** Maximum consumption in W */
  max_consumption_w?: number;
  /** Maximum production in W */
  max_production_w?: number;
}

/** Device discovered via mDNS */
export interface DiscoveredDevice {
  /** Device IP address */
  ip: string;
  /** Product type from mDNS TXT record or device info */
  productType: string;
  /** Serial number from mDNS name */
  serial: string;
  /** Human-readable name */
  name: string;
}

/** Connection state for a single device */
export interface DeviceConnection {
  /** Device config */
  config: DeviceConfig;
  /** Current IP address (from mDNS or stored fixed IP) */
  ip: string;
  /** WebSocket client instance (if connected) */
  wsClient: HomeWizardWebSocket | null;
  /** Whether WS is authenticated */
  wsAuthenticated: boolean;
  /** REST fallback polling timer */
  pollTimer: ioBroker.Interval | undefined;
  /** Reconnect timer */
  reconnectTimer: ioBroker.Timeout | undefined;
  /** Consecutive WS failures for backoff */
  wsFailCount: number;
  /** Consecutive auth failures */
  authFailCount: number;
  /** Last error code for dedup */
  lastErrorCode: string;
  /** Timestamp when WS last connected (for stability tracking) */
  lastConnectedAt: number;
  /** Count of short-lived connections (< STABLE_THRESHOLD) */
  recentDisconnects: number;
  /** True while a connect/IP-recovery cycle is in flight — guards against duplicate connect attempts triggered by repeated mDNS broadcasts. */
  recovering: boolean;
  /** True after the device was removed — async tasks (in-flight REST/WS) check this before writing further state. */
  removed: boolean;
  /** True while a measurement write is in flight — drops flooded pushes (latest-wins backpressure). */
  measurementBusy?: boolean;
  /** L8: true while a system write is in flight — drops flooded system pushes (like measurementBusy). */
  systemBusy?: boolean;
  /** L8: true while a battery write is in flight — drops flooded battery pushes (like measurementBusy). */
  batteryBusy?: boolean;
  /** L2: true while a REST-fallback poll is in flight — skips the next tick if it overlaps. */
  restPollBusy?: boolean;
  /** I7: system-poll counter — the productName-rename getDeviceInfo runs only every Nth poll. */
  systemPollCount?: number;
}
