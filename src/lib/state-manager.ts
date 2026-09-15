import type * as utils from "@iobroker/adapter-core";
import { coerceBoolean, coerceFiniteNumber, coerceString, isPlainObject, sanitizeForLog } from "./coerce";
import { deviceIcon } from "./device-icons";
import type { I18nKey } from "./i18n";
import { resolveLabel, tName } from "./i18n";
import type { MeasurementStateDef } from "./state-defs";
import {
  DEVICE_LABELLED_OBJECTS,
  EXTERNAL_METER_LEAVES,
  EXTERNAL_METER_TYPE_NAMES,
  MEASUREMENT_STATE_DEFS,
  MOMENTARY_KEYS,
  QUALITY_KEYS,
  SYSTEM_INFO_FIELDS,
} from "./state-defs";
import type { BatteryControl, DeviceConfig, Measurement, SystemInfo } from "./types";

/** Options for {@link StateManager.createState} (avoids long positional argument lists). */
interface StateDef {
  /** Full state ID */
  id: string;
  /** State name (translation object or device-identifier string) */
  name: ioBroker.StringOrTranslated;
  /** Value type */
  type: ioBroker.CommonType;
  /** ioBroker role */
  role: string;
  /** Whether the state is writable (default false) */
  write?: boolean;
  /** Optional unit */
  unit?: string;
  /** Optional `common.desc` */
  desc?: ioBroker.StringOrTranslated;
  /** Optional `common.states` map (plain-string values) */
  states?: Record<string, string>;
  /** Optional numeric min (L11/I2: bounds for level/percent states → Admin slider). */
  min?: number;
  /** Optional numeric max. */
  max?: number;
}

/** Options for {@link StateManager.ensureAndSet} — a {@link StateDef} plus the value to write. */
interface StateSet extends StateDef {
  /** Value to write */
  value: ioBroker.StateValue;
  /** Use setStateChangedAsync (skip redundant writes) instead of setStateAsync */
  changedOnly?: boolean;
}

/**
 * Sanitize a string for use as ioBroker object ID (see adapter.FORBIDDEN_CHARS).
 *
 * @param str Raw string to sanitize
 */
function sanitize(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

/**
 * Build a `common.states` map for tariff (T1-T4) with plain-string labels.
 *
 * **VALUES MUST be plain-string** — Admin renders states-values as React
 * children. Translation objects trigger React Error #31 → fatal "Error in GUI"
 * on dropdown open (verified hassemu v1.28.4, 2026-05-12).
 *
 */
// Cached after first build — the system language is fixed for the adapter run
// (I18n.init runs once in onReady), so these label maps never change at runtime.
// Avoids rebuilding the object on every ~1/s measurement push.
let tariffStatesCache: Record<string, string> | null = null;
function tariffStates(): Record<string, string> {
  return (tariffStatesCache ??= {
    1: resolveLabel("tariff1"),
    2: resolveLabel("tariff2"),
    3: resolveLabel("tariff3"),
    4: resolveLabel("tariff4"),
  });
}

/**
 * Build a `common.states` map for HWE-BAT battery.mode with plain-string labels.
 * Same constraint + same memoization as {@link tariffStates}. `predictive` since API 2.3.0.
 */
let batteryModeStatesCache: Record<string, string> | null = null;
function batteryModeStates(): Record<string, string> {
  return (batteryModeStatesCache ??= {
    zero: resolveLabel("modeZero"),
    to_full: resolveLabel("modeToFull"),
    standby: resolveLabel("modeStandby"),
    predictive: resolveLabel("modePredictive"),
  });
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
  /**
   * L15: memoized device-ID prefix per config object. `devicePrefix` runs two
   * `sanitize()` regex passes; on the ~1/s measurement hot path that repeats for
   * an unchanging (productType, serial). Keyed by the config object identity
   * (stable per connection, immutable fields) → auto-dropped when the connection
   * is replaced on re-pair.
   */
  private readonly prefixCache = new WeakMap<DeviceConfig, string>();
  /**
   * Branches this run deleted. The label retrofit works off ONE object list, read once
   * at start-up; a branch removed after that list was taken is still in it, and
   * `extendObject` on a missing object CREATES it (js-controller: "if old object is not
   * existing, we behave like setObject"). Without this the retrofit resurrects what the
   * same start just removed, as a husk carrying only name and description. Entries are
   * prefixes: an id below one counts as removed too.
   */
  private readonly removedIds = new Set<string>();

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
    const icon = deviceIcon(config.productType);
    // No `preserve`: the adapter owns every name in its own tree, this one included.
    // The name's SOURCE is the device — it follows the name in the HomeWizard app,
    // and a rename made in the object tree is put back at the next sync, like every
    // other label. A user's own data points belong in `0_userdata`.
    await this.adapter.extendObjectAsync(prefix, {
      type: "device",
      common: {
        name: config.productName || config.productType,
        statusStates: {
          onlineId: `${this.adapter.namespace}.${prefix}.info.connected`,
        },
        // A type with no pictogram leaves the field untouched — never emptied.
        ...(icon ? { icon } : {}),
      },
      native: {},
    });

    // No `preserve` (ensureChannel only preserves for a device-owned name): the
    // channel name is the adapter's own translated text, so preserving the existing
    // one would freeze it on every upgraded install and a renamed channel would
    // only ever reach fresh installations. Going through `ensureChannel` also puts
    // the id into `createdIds`, which is what keeps the label retrofit from writing
    // this very name a second time in the same start-up.
    await this.ensureChannel(`${prefix}.info`, () => tName("deviceInformation"));

    await this.createState({
      id: `${prefix}.info.productName`,
      name: tName("productName"),
      type: "string",
      role: "text",
    });
    await this.createState({
      id: `${prefix}.info.productType`,
      name: tName("productType"),
      type: "string",
      role: "text",
    });
    await this.createState({ id: `${prefix}.info.firmware`, name: tName("firmware"), type: "string", role: "text" });
    await this.createState({
      id: `${prefix}.info.connected`,
      name: tName("connected"),
      desc: tName("connectedDesc"),
      type: "boolean",
      role: "indicator.reachable",
    });
    await this.createState({ id: `${prefix}.info.wifi_ssid`, name: tName("wifiSsid"), type: "string", role: "text" });
    await this.createState({
      id: `${prefix}.info.wifi_rssi_db`,
      name: tName("wifiRssi"),
      desc: tName("wifiRssiDesc"),
      type: "number",
      role: "value",
      unit: "dBm",
    });
    await this.createState({
      id: `${prefix}.info.uptime_s`,
      name: tName("uptime"),
      desc: tName("uptimeDesc"),
      type: "number",
      role: "value",
      unit: "s",
    });

    // Remove device button
    await this.createButton(`${prefix}.remove`, tName("removeDevice"), tName("removeDeviceDesc"));

    // Set initial info values. `setStateChanged`: both are device identifiers that
    // change at most on a rename, so a restart must not churn them.
    await this.setProductName(config);
    await this.adapter.setStateChangedAsync(`${prefix}.info.productType`, {
      val: config.productType,
      ack: true,
    });
  }

  /**
   * Write the device's own product name into its data point.
   *
   * Its own method because it has TWO callers: the start-up/pairing path above and
   * every rename the adapter picks up while running. Without the second one the
   * data point kept the name from the last adapter start. (Until v0.19.0 the object's
   * visible name was frozen by `preserve`, which made this state the only place the
   * device's current name showed up at all.)
   *
   * @param config Device configuration (already carrying the current name).
   */
  async setProductName(config: DeviceConfig): Promise<void> {
    await this.adapter.setStateChangedAsync(`${this.devicePrefix(config)}.info.productName`, {
      val: config.productName,
      ack: true,
    });
  }

  /**
   * Write the device's firmware version.
   *
   * Called from the initial connect AND from the periodic device-info fetch: a
   * HomeWizard device updates its firmware on its own, so a value written only at
   * adapter start is stale from the next update until the next restart.
   *
   * @param config   Device configuration.
   * @param firmware Firmware version string (already type-guarded by the caller).
   */
  async setFirmware(config: DeviceConfig, firmware: string): Promise<void> {
    await this.adapter.setStateChangedAsync(`${this.devicePrefix(config)}.info.firmware`, {
      val: firmware,
      ack: true,
    });
  }

  /**
   * Update measurement states — only creates states that have values
   *
   * @param config  Device configuration
   * @param data    Measurement data
   * @param isStale L1: optional guard `() => conn.removed || this.unloading`.
   *   The caller checks it before invoking, but a push carries many awaits;
   *   if the device is removed (or the adapter unloads) mid-write, re-creating
   *   objects after `delObjectAsync` would leave orphans. Re-checked after each
   *   channel-create await so a concurrent removal aborts before the next write.
   */
  async updateMeasurement(config: DeviceConfig, data: Measurement, isStale?: () => boolean): Promise<void> {
    if (!isPlainObject(data)) {
      return;
    }
    const prefix = this.devicePrefix(config);
    const mPrefix = `${prefix}.measurement`;

    // Ensure measurement channel exists (cached after first call per device)
    await this.ensureChannel(mPrefix, () => tName("measurement"));
    if (isStale?.()) {
      return;
    }

    // Main measurement values — coerce per declared type. Once a state's object
    // is in the cache, ensureAndSet only does one setStateAsync per field — those
    // are independent and run in parallel via Promise.all instead of sequentially.
    const record = data;
    // M2: the power-quality states live under measurement.quality — ensure the
    // parent channel exists before them (like the external-meter path below),
    // otherwise they are orphaned (E3009 "missing intermediate object" on a P1
    // object dump, and an unnamed folder in Admin).
    const hasQuality = QUALITY_KEYS.some(key => coerceFiniteNumber(record[key]) !== null);
    if (hasQuality) {
      await this.ensureChannel(`${mPrefix}.quality`, () => tName("powerQuality"));
    }
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
        writes.push(this.setMeasurementField(mPrefix, def, coerced));
      }
    }
    await Promise.all(writes);

    // External meters (P1 gas/water/heat) — channel-create paths must run sequentially
    // because the parent `external` channel must exist before the per-meter channel
    // and the per-meter value/unit/timestamp states. Inside one meter, the three
    // value/unit/timestamp writes are independent and run in parallel.
    const external = record.external;
    if (Array.isArray(external) && external.length > 0) {
      // L7: cap the meter count — a rogue/compromised (but paired) device could
      // otherwise send a huge external[] (bounded only by the 16 MB body cap) →
      // object-store bloat. Real devices report 1–3 meters; matches the mDNS
      // discovery-list cap of 50.
      for (const rawExt of external.slice(0, 50)) {
        if (isStale?.()) {
          return;
        }
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

        await this.ensureChannel(`${mPrefix}.external`, () => tName("externalMeters"));

        const extId = `${mPrefix}.external.${sanitize(type)}_${sanitize(uniqueId)}`;
        // The meter TYPE comes from a closed list in the API (gas, water, warm
        // water, heat, inlet heat), so its channel name is the adapter's own
        // translated text. A type outside that list is device-supplied and keeps the
        // raw value — with the same CR/LF strip as the product name (L9), because a
        // device string must not carry line breaks into the tree.
        const typeNameKey = EXTERNAL_METER_TYPE_NAMES[type];
        await this.ensureChannel(extId, () => (typeNameKey ? tName(typeNameKey) : sanitizeForLog(type)));

        const extWrites: Promise<void>[] = [];
        if (value !== null) {
          extWrites.push(
            this.ensureAndSet({
              id: `${extId}.value`,
              name: tName("externalValue"),
              desc: tName("externalValueDesc"),
              type: "number",
              role: "value",
              value,
              unit: unit ?? undefined,
              changedOnly: true,
            }),
          );
        }
        if (unit) {
          extWrites.push(
            this.ensureAndSet({
              id: `${extId}.unit`,
              name: tName("externalUnit"),
              type: "string",
              role: "text",
              value: unit,
              changedOnly: true,
            }),
          );
        }
        if (timestamp) {
          extWrites.push(
            this.ensureAndSet({
              id: `${extId}.timestamp`,
              name: tName("externalTimestamp"),
              type: "string",
              role: "date",
              value: timestamp,
              changedOnly: true,
            }),
          );
        }
        await Promise.all(extWrites);
      }
    }
  }

  /**
   * Update system states
   *
   * @param config  Device configuration
   * @param system  System info data
   * @param isStale L1: optional guard `() => conn.removed || this.unloading` —
   *   re-checked after the system-channel create so a device removed mid-poll
   *   doesn't get its `system.*` control states re-created as orphans.
   */
  async updateSystem(config: DeviceConfig, system: SystemInfo, isStale?: () => boolean): Promise<void> {
    if (!isPlainObject(system)) {
      return;
    }
    const prefix = this.devicePrefix(config);
    const record = system as Record<string, unknown>;

    // WiFi SSID/RSSI + uptime in the info channel — slow-changing → changedOnly.
    // One table instead of three hand-written blocks that differed only in key,
    // type and unit (same form as the battery number fields below).
    for (const field of SYSTEM_INFO_FIELDS) {
      const value = field.type === "number" ? coerceFiniteNumber(record[field.key]) : coerceString(record[field.key]);
      if (value === null) {
        continue;
      }
      await this.ensureAndSet({
        id: `${prefix}.info.${field.key}`,
        name: tName(field.nameKey),
        desc: field.descKey ? tName(field.descKey) : undefined,
        type: field.type,
        role: field.role,
        value,
        unit: field.unit,
        changedOnly: true,
      });
    }

    // System control channel (cached after first call per device)
    await this.ensureChannel(`${prefix}.system`, () => tName("systemSettings"));
    if (isStale?.()) {
      return;
    }

    // HWE-BAT: cloud_enabled is read-only (always true) and reboot is unsupported.
    const isBattery = config.productType === "HWE-BAT";

    const cloudEnabled = coerceBoolean(record.cloud_enabled);
    if (cloudEnabled !== null) {
      await this.ensureAndSet({
        id: `${prefix}.system.cloud_enabled`,
        name: tName("cloudEnabled"),
        desc: tName("cloudEnabledDesc"),
        type: "boolean",
        // M3: switch requires write:true (repochecker E1011). On HWE-BAT the field
        // is read-only (always true) → indicator, not switch.
        role: isBattery ? "indicator" : "switch",
        value: cloudEnabled,
        write: !isBattery,
        changedOnly: true,
      });
    }
    const ledPct = coerceFiniteNumber(record.status_led_brightness_pct);
    if (ledPct !== null) {
      await this.ensureAndSet({
        id: `${prefix}.system.status_led_brightness_pct`,
        name: tName("ledBrightness"),
        type: "number",
        role: "level",
        value: ledPct,
        unit: "%",
        min: 0,
        max: 100,
        write: true,
        changedOnly: true,
      });
    }

    const apiV1 = coerceBoolean(record.api_v1_enabled);
    if (apiV1 !== null) {
      await this.ensureAndSet({
        id: `${prefix}.system.api_v1_enabled`,
        name: tName("apiV1Enabled"),
        desc: tName("apiV1EnabledDesc"),
        type: "boolean",
        role: "switch",
        value: apiV1,
        write: true,
        changedOnly: true,
      });
    }

    // Action buttons (reboot is unsupported on the Plug-In Battery)
    if (!isBattery) {
      await this.createButton(`${prefix}.system.reboot`, tName("rebootDevice"));
    }
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

    await this.ensureChannel(`${prefix}.battery`, () => tName("batteryControl"));

    const mode = coerceString(record.mode);
    if (mode) {
      await this.ensureAndSet({
        id: `${prefix}.battery.mode`,
        name: tName("batteryMode"),
        type: "string",
        role: "text",
        value: mode,
        write: true,
        desc: tName("batteryModeDesc"),
        states: batteryModeStates(),
        changedOnly: true,
      });
    }
    if (Array.isArray(record.permissions)) {
      await this.ensureAndSet({
        id: `${prefix}.battery.permissions`,
        name: tName("batteryPermissions"),
        desc: tName("batteryPermissionsDesc"),
        type: "string",
        role: "json",
        value: JSON.stringify(record.permissions),
        write: true,
        changedOnly: true,
      });
    }
    // charge_to_full (API 2.3.0) — writable switch: charge all batteries to 100%.
    const chargeToFull = coerceBoolean(record.charge_to_full);
    if (chargeToFull !== null) {
      await this.ensureAndSet({
        id: `${prefix}.battery.charge_to_full`,
        name: tName("batteryChargeToFull"),
        desc: tName("batteryChargeToFullDesc"),
        type: "boolean",
        role: "switch",
        value: chargeToFull,
        write: true,
        changedOnly: true,
      });
    }

    const numberFields: Array<{
      key: string;
      id: string;
      nameKey: I18nKey;
      descKey?: I18nKey;
      role: string;
      unit?: string;
    }> = [
      { key: "battery_count", id: "battery_count", nameKey: "batteryCount", role: "value" },
      { key: "power_w", id: "power_w", nameKey: "batteryPower", role: "value.power", unit: "W" },
      {
        key: "target_power_w",
        id: "target_power_w",
        nameKey: "batteryTargetPower",
        descKey: "batteryTargetPowerDesc",
        role: "value.power",
        unit: "W",
      },
      {
        key: "max_consumption_w",
        id: "max_consumption_w",
        nameKey: "batteryMaxConsumption",
        descKey: "batteryLimitDesc",
        role: "value.power",
        unit: "W",
      },
      {
        key: "max_production_w",
        id: "max_production_w",
        nameKey: "batteryMaxProduction",
        descKey: "batteryLimitDesc",
        role: "value.power",
        unit: "W",
      },
    ];
    for (const field of numberFields) {
      const coerced = coerceFiniteNumber(record[field.key]);
      if (coerced !== null) {
        await this.ensureAndSet({
          id: `${prefix}.battery.${field.id}`,
          name: tName(field.nameKey),
          desc: field.descKey ? tName(field.descKey) : undefined,
          type: "number",
          role: field.role,
          value: coerced,
          unit: field.unit,
          changedOnly: true,
        });
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
    await this.adapter.setStateChangedAsync(`${prefix}.info.connected`, {
      val: connected,
      ack: true,
    });
  }

  /**
   * Mark every given device as not connected.
   *
   * Two moments need this and neither can wait for the network: start-up (the
   * previous run's values survive a crash, a power cut or a hard kill, so every
   * device would stay green until its first WebSocket result) and shutdown (the
   * WebSocket is closed deliberately without firing its disconnect handler, so
   * nothing else writes the markers).
   *
   * @param configs the devices to mark
   * @returns resolves once every write has landed
   */
  async markAllDisconnected(configs: readonly DeviceConfig[]): Promise<void> {
    await Promise.all(configs.map(config => this.setDeviceConnected(config, false)));
  }

  /**
   * Write the instance-level summary of how many devices there are and how many
   * of them are answering.
   *
   * `total` deliberately survives a shutdown — how many devices are set up does
   * not change because the adapter is off, and a `0` there would read as "no
   * devices paired". `allOnline` requires at least one device: with none paired,
   * "all of them are connected" would be a success message for an empty setup.
   *
   * @param total how many devices are set up
   * @param online how many of them are currently connected
   */
  async writeDeviceRollup(total: number, online: number): Promise<void> {
    await Promise.all([
      this.adapter.setStateChangedAsync("info.devicesTotal", { val: total, ack: true }),
      this.adapter.setStateChangedAsync("info.devicesOnline", { val: online, ack: true }),
      this.adapter.setStateChangedAsync("info.devicesAllOnline", { val: total > 0 && online === total, ack: true }),
    ]);
  }

  /**
   * Remove all states for a device
   *
   * @param config Device configuration
   */
  async removeDevice(config: DeviceConfig): Promise<void> {
    await this.removeDeviceByPrefix(this.devicePrefix(config));
  }

  /**
   * Remove a device branch addressed by its object-ID prefix instead of its config.
   *
   * A device whose stored token cannot be read (secret rotation, a hand-edited
   * database) never becomes a `DeviceConfig` — it is skipped while loading, so it
   * has no connection and no config. That is precisely the device a user wants to
   * get rid of, and the config-based path above could not touch it. The prefix is
   * the one thing that still exists for it: it is the object's own id.
   *
   * @param prefix Device object-ID prefix (`<productType>_<serial>`).
   */
  async removeDeviceByPrefix(prefix: string): Promise<void> {
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
   * Bring the labels of ALREADY EXISTING device objects up to the current version,
   * without waiting for the device to send anything.
   *
   * Nearly every object under a device prefix is written from `updateMeasurement`,
   * `updateSystem` or `updateBattery` — paths that only run while data flows. On an
   * installation whose meter is silent (the weak-signal case this adapter exists
   * for) a corrected or newly translated label would therefore arrive whenever the
   * device comes back, or never. The write paths are right; they are just not
   * reached. This walks {@link DEVICE_LABELLED_OBJECTS} instead and refreshes what
   * is already in the tree.
   *
   * Only name and description are written: role, type, unit and bounds keep coming
   * from the regular create path, and nothing is CREATED here — an object the device
   * never reported stays absent.
   *
   * @param config      Device configuration.
   * @param existingIds Full ids currently in the adapter namespace (one object query
   *   for all devices, instead of ~70 probes per device).
   * @returns how many objects were refreshed
   */
  async refreshExistingNames(config: DeviceConfig, existingIds: ReadonlySet<string>): Promise<number> {
    const prefix = this.devicePrefix(config);
    let refreshed = 0;
    for (const spec of DEVICE_LABELLED_OBJECTS) {
      const id = `${prefix}.${spec.id}`;
      if (!existingIds.has(`${this.adapter.namespace}.${id}`)) {
        continue;
      }
      // Deleted while this start was running: still in the caller's list, but writing
      // it would bring the object back (see `removedIds`).
      if (this.wasRemoved(id)) {
        continue;
      }
      // Already written in this very start-up (createDeviceStates, or a create
      // triggered by incoming data): those objects carry the current label by
      // definition, so refreshing them again is a second write for nothing.
      if (this.createdIds.has(id)) {
        continue;
      }
      const common: Record<string, unknown> = { name: tName(spec.nameKey) };
      if (spec.descKey) {
        common.desc = tName(spec.descKey);
      }
      // No `preserve`: these labels are the adapter's own text. No createdIds entry
      // either — the full create path (role/type/unit/min/max) must still run when
      // the device reports the field.
      if (spec.kind === "channel") {
        await this.adapter.extendObjectAsync(id, {
          type: "channel",
          common: common,
          native: {},
        });
      } else {
        await this.adapter.extendObjectAsync(id, {
          type: "state",
          common: common,
          native: {},
        });
      }
      refreshed++;
    }

    // External meters: the channel segment is device-supplied, so these three
    // leaves can only be reached by pattern (see EXTERNAL_METER_LEAVES).
    const externalPrefix = `${this.adapter.namespace}.${prefix}.measurement.external.`;
    for (const fullId of existingIds) {
      if (!fullId.startsWith(externalPrefix)) {
        continue;
      }
      const rest = fullId.slice(externalPrefix.length).split(".");
      const localId = fullId.slice(`${this.adapter.namespace}.`.length);
      if (this.wasRemoved(localId)) {
        continue;
      }
      // The meter's own channel (`<type>_<unique_id>`). Its name is the adapter's
      // translated text for every type the API knows, so it has to reach existing
      // installations like any other label — but it is only written when the meter
      // actually reports, which a silent device never does. A type OUTSIDE the list
      // is device-supplied and stays untouched here.
      if (rest.length === 1) {
        const typeKey = Object.keys(EXTERNAL_METER_TYPE_NAMES).find(t => rest[0].startsWith(`${sanitize(t)}_`));
        if (!typeKey || this.createdIds.has(localId)) {
          continue;
        }
        await this.adapter.extendObjectAsync(localId, {
          type: "channel",
          common: { name: tName(EXTERNAL_METER_TYPE_NAMES[typeKey]) },
          native: {},
        });
        refreshed++;
        continue;
      }
      if (rest.length !== 2) {
        continue;
      }
      const leaf = EXTERNAL_METER_LEAVES[rest[1]];
      if (!leaf) {
        continue;
      }
      // Same rule as the fixed ids above: skip what this run already wrote.
      if (this.createdIds.has(localId)) {
        continue;
      }
      const leafCommon: Record<string, unknown> = { name: tName(leaf.nameKey) };
      if (leaf.descKey) {
        leafCommon.desc = tName(leaf.descKey);
      }
      await this.adapter.extendObjectAsync(localId, {
        type: "state",
        common: leafCommon,
        native: {},
      });
      refreshed++;
    }
    return refreshed;
  }

  /**
   * Remove a device's whole `battery` branch — used when the meter reports that
   * no batteries are connected any more.
   *
   * The datapoints would otherwise keep showing the last values of a battery that
   * is gone, `battery_count` included: numbers that describe nothing. The adapter
   * owns its datapoint inventory, so it clears them instead of leaving them to
   * age. A battery that comes back re-creates the branch on the next poll.
   *
   * @param config Device configuration
   * @returns `true` when a branch was actually removed, `false` when there was none
   */
  async removeBatteryStates(config: DeviceConfig): Promise<boolean> {
    const prefix = this.devicePrefix(config);
    const channel = `${prefix}.battery`;
    if (!(await this.adapter.getObjectAsync(channel))) {
      return false;
    }
    await this.adapter.delObjectAsync(channel, { recursive: true });
    for (const id of this.createdIds) {
      if (id === channel || id.startsWith(`${channel}.`)) {
        this.createdIds.delete(id);
      }
    }
    this.removedIds.add(channel);
    return true;
  }

  /**
   * Whether this id — or a branch above it — was deleted during this run.
   *
   * @param id Device-relative object id.
   */
  private wasRemoved(id: string): boolean {
    for (const removed of this.removedIds) {
      if (id === removed || id.startsWith(`${removed}.`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Remove obsolete states: pre-v0.4.0 device-root paths (now under measurement/) plus
   * states retired in later versions (v0.11.0: raw P1 telegram).
   *
   * @param config      Device configuration
   * @param existingIds Full ids currently in the adapter namespace — the sweep is a
   *   set lookup instead of ~62 `getObject` probes per device.
   */
  async cleanupMovedStates(config: DeviceConfig, existingIds: ReadonlySet<string>): Promise<void> {
    const prefix = this.devicePrefix(config);

    // Old paths: states were at device root, now under measurement/
    const oldIds: string[] = [];
    for (const def of MEASUREMENT_STATE_DEFS) {
      oldIds.push(`${prefix}.${def.id}`);
    }
    // External was at device root too
    oldIds.push(`${prefix}.external`);
    // Retired in v0.11.0: raw P1 telegram (DSMR passthrough, not part of the v2 data model)
    oldIds.push(`${prefix}.measurement.telegram`);

    // Decided against the object store: the caller already holds every id in this
    // namespace, so the ~62 `getObject` probes this used to fire per device are a
    // set lookup now. That is also what made the old `info.legacyMigrated` marker
    // unnecessary — it existed only to skip those probes, and an internal marker
    // has no business sitting in a user's object tree.
    let removed = 0;
    for (const id of oldIds) {
      if (!existingIds.has(`${this.adapter.namespace}.${id}`)) {
        continue;
      }
      await this.adapter.delObjectAsync(id, { recursive: true });
      this.adapter.log.debug(`Removed obsolete state: ${id}`);
      removed++;
    }
    if (removed > 0) {
      this.adapter.log.debug(`state-manager: cleanupMovedStates ${prefix} done (removed ${removed} obsolete paths)`);
    }
  }

  /**
   * Drop the retired internal markers.
   *
   * `info.legacyMigrated` noted that a one-off cleanup had run, `info.labelsVersion`
   * which version the labels were brought to. Both were adapter bookkeeping in a
   * USER's object tree, and neither is needed: the cleanup and the label retrofit
   * both work off the object list the adapter already holds. The adapter owns its
   * datapoint inventory, so it clears them instead of leaving them lying around.
   *
   * @param existingIds Full ids currently in the adapter namespace.
   * @returns the ids that were actually removed
   */
  async removeRetiredMarkers(existingIds: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    for (const id of ["info.legacyMigrated", "info.labelsVersion"]) {
      if (!existingIds.has(`${this.adapter.namespace}.${id}`)) {
        continue;
      }
      await this.adapter.delObjectAsync(id);
      removed.push(id);
    }
    return removed;
  }

  /**
   * Get device object ID prefix
   *
   * @param config Device configuration
   */
  devicePrefix(config: DeviceConfig): string {
    let prefix = this.prefixCache.get(config);
    if (prefix === undefined) {
      prefix = `${sanitize(config.productType)}_${sanitize(config.serial)}`;
      this.prefixCache.set(config, prefix);
    }
    return prefix;
  }

  /**
   * Ensure a channel object exists and carries the current name. Skips the DB
   * write once `id` is in the cache — channels are static after first creation
   * per device.
   *
   * `extendObject`, not `setObjectNotExists`: a create-only write freezes the
   * name on every installation that already has the channel, so a renamed or
   * newly translated channel would only ever reach fresh installations.
   *
   * @param id   Full channel ID (`<prefix>.<channelName>`).
   * @param name Thunk returning the display name (translation object, or the
   *   device's own string for a meter type the API does not define).
   */
  private async ensureChannel(id: string, name: () => ioBroker.StringOrTranslated): Promise<void> {
    if (this.createdIds.has(id)) {
      return;
    }
    // The name is always a thunk so the caller's `tName(...)` — which builds an
    // 11-language object — only runs when the channel is really written. The
    // measurement channel is ensured on EVERY ~1 Hz push, so an eager argument
    // threw that object away once per second per device (same waste the
    // cold-path/hot-path split removed for the per-field names in L14). One form
    // instead of two: the value overload existed for three call sites that had no
    // reason to differ from the fourth.
    // No `preserve` anywhere: the adapter owns every name in its own tree. Where the
    // text comes from the device (a meter type the API does not define) the adapter
    // writes the device's current value — it does not freeze whatever stood there.
    await this.adapter.extendObjectAsync(id, {
      type: "channel" as const,
      common: { name: name() },
      native: {},
    });
    this.createdIds.add(id);
  }

  /**
   * Create a state if it doesn't exist.
   *
   * @param def State definition (options object — avoids long positional argument lists).
   */
  private async createState(def: StateDef): Promise<void> {
    if (this.createdIds.has(def.id)) {
      return;
    }
    const common: Partial<ioBroker.StateCommon> = {
      name: def.name,
      type: def.type,
      role: def.role,
      read: true,
      write: def.write ?? false,
    };
    if (def.unit) {
      common.unit = def.unit;
    }
    if (def.min !== undefined) {
      common.min = def.min;
    }
    if (def.max !== undefined) {
      common.max = def.max;
    }
    if (def.desc) {
      common.desc = def.desc;
    }
    if (def.states) {
      common.states = def.states;
    }
    // DP-retrofit: extendObject (not setObjectNotExists) on first touch so a
    // changed `common` — M3 cloud_enabled role switch→indicator, L11/I2 min/max,
    // I1 role precision — reaches states that already exist on an upgraded
    // install. createdIds-gated → runs once per state per restart, with NO
    // getObject read, so the fragile-snapshot migration anti-pattern
    // (lgtv #418/#421) cannot occur.
    //
    // Deliberately WITHOUT `preserve: { common: ["name"] }`: every name here is
    // the adapter's own translated text. Preserving would freeze it on each
    // existing installation, so a corrected or newly translated label would
    // reach fresh installs only — and no gate sees that, because the source
    // shows the correct tName() call either way. `preserve` belongs where the
    // name comes from outside (the device object's productName).
    await this.adapter.extendObjectAsync(def.id, {
      type: "state",
      common,
      native: {},
    });
    if (def.states) {
      // Existing datapoints from earlier releases may carry translation-object
      // VALUES in `common.states` (v0.7.0 introduced tLabel-as-string casts).
      // setObjectNotExistsAsync is a no-op for those — actively replace if any
      // value is not plain-string. Admin renders states-values as React child:
      // an object triggers React Error #31 → fatal "Error in GUI" on dropdown.
      await this.repairCommonStatesIfBuggy(def.id, def.states);
    }
    this.createdIds.add(def.id);
  }

  /**
   * If the persisted object at `id` has `common.states` values that are not
   * plain-string (= translation objects from older releases), replace
   * `common.states` wholesale via `setObjectAsync`. Otherwise no-op.
   *
   * Why a full write is needed, measured against the object store's only merge
   * site (`node.extend(true, …)` in `objectsInRedisClient._extendObject`): a
   * KEY THAT THE NEW MAP NO LONGER CARRIES SURVIVES THE MERGE, forever. If such a
   * leftover key holds a translation object — which is what v0.7.0–v0.7.5 wrote —
   * Admin renders it as a React child and the dropdown dies with React error #31
   * ("Error in GUI"). Only replacing the whole object gets rid of it.
   *
   * What this does NOT have to fix, contrary to what this comment claimed until
   * the v0.18.2 audit: a key that IS in the new map. A plain string overwrites an
   * object value just fine in a deep merge — the earlier claim was never measured
   * against js-controller, and the one test that named this repair reached it only
   * because the test double merged `common` with a shallow spread.
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
    // extendObject without `preserve`, like createState: label and description
    // are the adapter's own translated texts, and a create-only write would
    // leave every upgraded installation on the old wording forever.
    await this.adapter.extendObjectAsync(id, {
      type: "state",
      common,
      native: {},
    });
    await this.adapter.setStateAsync(id, { val: false, ack: true });
    this.createdIds.add(id);
  }

  /**
   * Ensure a state exists and set its value.
   *
   * `changedOnly` routes through `setStateChangedAsync` (skips the write when the value is
   * unchanged) — used for slow/static fields (energy totals, system, battery control) so the
   * ~1/s push doesn't churn the DB. Momentary 1 Hz values (power/voltage/current/…) stay on
   * `setStateAsync`. `changedOnly` also prevents double-writes when REST poll + WS push the
   * same field.
   *
   * @param def State definition + value + optional `changedOnly` flag.
   */
  private async ensureAndSet(def: StateSet): Promise<void> {
    await this.createState(def);
    if (def.changedOnly) {
      await this.adapter.setStateChangedAsync(def.id, { val: def.value, ack: true });
    } else {
      await this.adapter.setStateAsync(def.id, { val: def.value, ack: true });
    }
  }

  /**
   * Measurement hot-path writer (~1/s per P1, up to ~30 fields). L14: the
   * translated `common.name`/`desc` and the tariff `states` map are built ONLY
   * when the object is first created (cold path, `createdIds`-gated). Once the
   * state is cached this does a single value write with no `tName()` /
   * `tariffStates()` allocation — the eager per-field `tName()` in the old
   * `ensureAndSet` loop was thrown away on every push after the first.
   *
   * Momentary 1 Hz fields (power/voltage/current/…) use `setStateAsync`;
   * slow fields (energy totals) use `setStateChangedAsync` — same routing as
   * the old `changedOnly: !MOMENTARY_KEYS.has(def.key)`.
   *
   * @param mPrefix `<devicePrefix>.measurement`
   * @param def     Measurement field definition
   * @param value   Coerced value to write
   */
  private async setMeasurementField(mPrefix: string, def: MeasurementStateDef, value: number | string): Promise<void> {
    const id = `${mPrefix}.${def.id}`;
    if (!this.createdIds.has(id)) {
      await this.createState({
        id,
        name: tName(def.nameKey),
        type: def.type,
        role: def.role,
        unit: def.unit,
        min: def.min,
        max: def.max,
        desc: def.descKey ? tName(def.descKey) : undefined,
        states: def.key === "tariff" ? tariffStates() : undefined,
      });
    }
    if (MOMENTARY_KEYS.has(def.key)) {
      await this.adapter.setStateAsync(id, { val: value, ack: true });
    } else {
      await this.adapter.setStateChangedAsync(id, { val: value, ack: true });
    }
  }
}
