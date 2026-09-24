import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import {
  coerceFiniteNumber,
  errText,
  isValidIpv4,
  parseBatteryPermissions,
  sanitizeForLog,
  validateBatteryMode,
} from "./lib/coerce";
import { createDeviceConnection } from "./lib/connection-utils";
import { ConnectionManager, WS_RECONNECT_MAX_MS, type ConnectionManagerHost } from "./lib/connection-manager";
import { HomeWizardDiscovery } from "./lib/discovery";
import { deviceLabel, deviceObjectName, stripNamespace } from "./lib/main-helpers";
import { PairingManager, type PairingManagerHost } from "./lib/pairing-manager";
import { CA_NOT_AFTER, caDaysUntilExpiry, dropDeviceAgent, pinnedAgent } from "./lib/cacert";
import { HomeWizardClient } from "./lib/homewizard-client";
import { tName } from "./lib/i18n";
import { StateManager } from "./lib/state-manager";
import type { DeviceConfig, DeviceConnection, DiscoveredDevice } from "./lib/types";
import { HomeWizardWebSocket, type TimerDeps, type WsCallbacks } from "./lib/websocket-client";

/** System info poll interval in milliseconds */
const SYSTEM_POLL_MS = 60_000;
/** mDNS IP recovery timeout in milliseconds */
const IP_RECOVERY_TIMEOUT_MS = 60_000;

/** What a control-state handler needs in order to talk to its device. */
interface CommandContext {
  /** REST client, already pinned to this device's TLS identity. */
  client: HomeWizardClient;
  /** The state exactly as the user wrote it (never acked, never null). */
  state: ioBroker.State;
  /** The device the state belongs to. */
  conn: DeviceConnection;
}

/** One writable control state and what writing it does on the device. */
interface DeviceCommand {
  /** State-ID suffix this entry owns (matched with `endsWith`). */
  suffix: string;
  /**
   * Momentary button. It is put back to `false, ack:true` afterwards — whether the
   * call succeeded, failed, or never happened because the device is unreachable.
   * A button left at `true, ack:false` cannot be clicked again in Admin (DD25).
   *
   * A button never returns an ack value and a value state is never a button, so
   * the reset can no longer overwrite an acknowledged value — the rule that used
   * to depend on wrapping exactly the right call in `finally` is now structural.
   */
  button?: boolean;
  /**
   * Send the write to the device.
   *
   * @returns the value to acknowledge — the value that was actually SENT, not the
   *   raw write (DD16) — or `null` when the input was rejected and nothing went
   *   out. In that case the handler has already said why.
   */
  send(ctx: CommandContext): Promise<ioBroker.StateValue | null>;
  /**
   * Which group of device values this entry writes. When the device rejects the
   * write, that group is read back once so the data point shows what the device
   * actually holds instead of the user's value — otherwise it keeps lying until
   * the next 60 s system poll. Buttons have no group: nothing to read back.
   */
  refresh?: "system" | "battery";
}

/**
 * HomeWizard adapter — manages multiple devices over API v2 (HTTPS + WebSocket):
 * pairing, real-time push, REST fallback, reconnect/recovery and state mapping.
 * Exported so the orchestration unit tests can drive its handlers directly.
 */
export class HomeWizard extends utils.Adapter {
  private stateManager!: StateManager;
  private discovery: HomeWizardDiscovery | null = null;
  /**
   * Owns the connection registry + the reconnect/error state machine (connect,
   * WS push, REST fallback, backoff reconnect, unstable-mode, system poll,
   * auth-stop, deduped error logging). Constructed in the constructor so the
   * direct-method orchestration tests reach it before onReady runs. Lifecycle,
   * pairing, persistence and mDNS IP-recovery stay here (they own the browser).
   */
  private readonly connectionManager: ConnectionManager;
  /**
   * Owns the pairing window (60 s timer, discovery queue, token poll). Main keeps
   * the single mDNS browser — IP recovery shares it — and hands it out.
   */
  private readonly pairingManager: PairingManager;
  /** Device connections — the registry lives in the connection manager. */
  private get connections(): Map<string, DeviceConnection> {
    return this.connectionManager.connections;
  }
  private systemPollTimer: ioBroker.Interval | undefined = undefined;
  private ipRecoveryTimer: ioBroker.Timeout | undefined = undefined;
  /** Set during onUnload — async paths bail before further setState calls. */
  private unloading = false;
  /**
   * Factories for the REST/WS clients — default to the real constructors. Test seams:
   * a unit test can replace these with fakes to exercise the orchestration (initDevice,
   * onWsConnected/onWsDisconnected, onStateChange) without real network.
   *
   * @param ip Device IP address
   * @param token Bearer token (empty string for pairing requests)
   * @param certCn Stored cert CN for per-device TLS pinning (undefined during pairing/migration)
   * @param serial Device serial — pins by CN-suffix from connect #1 when no CN is stored yet (M4)
   */
  private makeClient: (ip: string, token: string, certCn?: string, serial?: string) => HomeWizardClient = (
    ip,
    token,
    certCn,
    serial,
  ) => new HomeWizardClient(ip, token, { log: this.log, agent: pinnedAgent(certCn, serial) });
  private makeWebSocket: (
    ip: string,
    token: string,
    callbacks: WsCallbacks,
    timers: TimerDeps,
    certCn?: string,
    serial?: string,
  ) => HomeWizardWebSocket = (ip, token, callbacks, timers, certCn, serial) => {
    const agent = pinnedAgent(certCn, serial);
    return new HomeWizardWebSocket(ip, token, callbacks, timers, agent ? { agent } : undefined);
  };
  private makeDiscovery: () => HomeWizardDiscovery = () => new HomeWizardDiscovery(this.log);

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "homewizard" });

    // The connection manager owns the connection registry + reconnect/error state
    // machine. Its host thunks resolve stateManager/makeClient/makeWebSocket/unloading
    // lazily off this adapter so the unit-test seams (overridden AFTER construction)
    // still propagate. Discovery/pairing/IP-recovery stay here (they own the browser).
    const host: ConnectionManagerHost = {
      getStateManager: () => this.stateManager,
      isUnloading: () => this.unloading,
      makeClient: (ip, token, certCn, serial) => this.makeClient(ip, token, certCn, serial),
      makeWebSocket: (ip, token, callbacks, timers, certCn, serial) =>
        this.makeWebSocket(ip, token, callbacks, timers, certCn, serial),
      saveDeviceToObject: config => this.saveDeviceToObject(config),
      requestIpRecovery: () => this.startIpRecovery(),
      onDeviceConnected: () => this.onDeviceConnected(),
    };
    this.connectionManager = new ConnectionManager(this, host);

    const pairingHost: PairingManagerHost = {
      getStateManager: () => this.stateManager,
      makeClient: (ip, token) => this.makeClient(ip, token),
      startDiscovery: () => this.restartBrowser(),
      stopDiscovery: () => this.releaseBrowser(),
      isUnloading: () => this.unloading,
      saveDeviceToObject: config => this.saveDeviceToObject(config),
      adoptPairedDevice: (config, ip) => this.adoptPairedDevice(config, ip),
      resetButton: id => this.resetButton(id),
    };
    this.pairingManager = new PairingManager(this, pairingHost);

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    // No process-level unhandledRejection/uncaughtException handlers: in compact mode they
    // are process-wide and cross-adapter-harmful. Every handler has .bind+try/catch and
    // fire-and-forget paths use .catch (Fleet pattern — hueemu/parcelapp/nut).
  }

  /**
   * One-shot repair of a leftover `supportedMessages` entry in this instance's
   * own object.
   *
   * The manifest's `supportedMessages` is copied into the instance object in the
   * database. An update merges the manifest into that copy but never removes a
   * field from it, so dropping the manifest line alone leaves every existing
   * installation being hard-killed — `onUnload` would keep not running and the
   * markers would keep staying green.
   *
   * `supportedMessages` is a POSITIVE list: an entry that is merely `false` — and
   * even an empty object — still means "only these messages are supported", which
   * is none. The messagebox then dies silently: no `sendTo` reaches the adapter and
   * nothing is logged. Setting `{ stopInstance: false }` therefore does not repair
   * anything, it trades one defect for a quieter one. The key has to be DELETED
   * (`null`), and the trigger is its mere existence, not the flag's value. This
   * adapter declares no message at all (no `deviceManager`), so the whole key goes.
   *
   * Only write when the key is actually there: every change to an instance object
   * makes the host stop and restart the instance, so an unconditional write is a
   * restart loop. The caller must leave `onReady` immediately afterwards — the
   * host is already tearing this process down.
   *
   * @returns true when the key was deleted and this start-up must not continue
   */
  private async clearStopInstanceFlag(): Promise<boolean> {
    const id = `system.adapter.${this.namespace}`;
    try {
      const obj = await this.getForeignObjectAsync(id);
      const supported = obj?.common?.supportedMessages as Record<string, unknown> | undefined;
      if (supported === undefined || supported === null) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version — this instance restarts once");
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: null } });
      return true;
    } catch (err: unknown) {
      this.log.debug(`Could not check the supportedMessages key: ${errText(err)}`);
      return false;
    }
  }

  /**
   * Bring the manifest's `instanceObjects` up to the current labels on an
   * EXISTING installation.
   *
   * js-controller creates those objects only where they are missing, so a
   * changed `common.name`/`desc` in `io-package.json` otherwise reaches fresh
   * installations only — an installed tree keeps the old text while the manifest
   * and every gate look green. Each object therefore gets an explicit
   * `extendObject` here, spelled out one by one: a loop over the manifest would
   * be DRYer but leaves nothing a consistency check can match against the ids.
   *
   * The labels come from the same `admin/i18n` keys that
   * `sync-iopackage-from-i18n.py` renders into the manifest, so the two cannot
   * drift apart.
   */
  private async ensureManifestObjects(): Promise<void> {
    await this.extendObject("info", {
      type: "channel",
      common: { name: tName("info") },
      native: {},
    });
    await this.extendObject("info.connection", {
      type: "state",
      common: { name: tName("infoConnection"), desc: tName("infoConnectionDesc") },
      native: {},
    });
    await this.extendObject("info.devicesTotal", {
      type: "state",
      common: { name: tName("devicesTotal"), desc: tName("devicesTotalDesc") },
      native: {},
    });
    await this.extendObject("info.devicesOnline", {
      type: "state",
      common: { name: tName("devicesOnline"), desc: tName("devicesOnlineDesc") },
      native: {},
    });
    await this.extendObject("info.devicesAllOnline", {
      type: "state",
      common: { name: tName("devicesAllOnline"), desc: tName("devicesAllOnlineDesc") },
      native: {},
    });
    await this.extendObject("startPairing", {
      type: "state",
      common: { name: tName("startPairing"), desc: tName("startPairingDesc") },
      native: {},
    });
    await this.extendObject("pairingIp", {
      type: "state",
      common: { name: tName("pairingIp"), desc: tName("pairingIpDesc") },
      native: {},
    });
  }

  /**
   * Bring existing objects to this version's labels, and clear the retired markers.
   *
   * Almost everything below a device is written only while the device sends data, so
   * on an installation whose meter is silent — the weak-signal case this adapter is
   * built for — a corrected label would wait for the device to come back, possibly
   * forever. This walks the label table instead and refreshes what is already in the
   * tree. Nothing is created: an object the device never reported stays absent.
   *
   * Runs on every start, without a marker state. It costs one object query (which the
   * device load needs anyway) plus one write per existing object — far less than the
   * adapter does in a second of normal operation, and the price for not parking
   * adapter bookkeeping in a user's object tree.
   *
   * A failure is not fatal: labels stay as they are and the next start retries.
   *
   * @param devices     The devices loaded from their objects.
   * @param existingIds Every id in this namespace, already fetched by the caller.
   */
  private async refreshDeviceLabels(devices: readonly DeviceConfig[], existingIds: Set<string>): Promise<void> {
    try {
      const dropped = await this.stateManager.removeRetiredMarkers(existingIds);
      for (const id of dropped) {
        this.log.info(`Removed the obsolete internal data point ${id}`);
      }
      let refreshed = 0;
      for (const device of devices) {
        refreshed += await this.stateManager.refreshExistingNames(device, existingIds);
      }
      if (refreshed > 0) {
        this.log.debug(`Refreshed the labels of ${refreshed} existing object(s)`);
      }
    } catch (err: unknown) {
      this.log.debug(`Could not refresh the object labels: ${errText(err)}`);
    }
  }

  private async onReady(): Promise<void> {
    try {
      if (await this.clearStopInstanceFlag()) {
        return;
      }
      await I18n.init(join(this.adapterDir, "admin"), this);
      this.stateManager = new StateManager(this);
      await this.ensureManifestObjects();

      // Warn if the bundled HomeWizard CA is close to expiry — after notAfter,
      // rejectUnauthorized:true rejects every device cert and all connections fail.
      const caDaysLeft = caDaysUntilExpiry(Date.now());
      if (caDaysLeft < 90) {
        this.log.warn(
          `Bundled HomeWizard CA certificate expires in ${caDaysLeft} days ` +
            `(${CA_NOT_AFTER.toISOString().slice(0, 10)}) — an adapter update will be needed to keep connecting.`,
        );
      }

      await this.setState("startPairing", { val: false, ack: true });
      await this.setState("pairingIp", { val: "", ack: true });

      await this.subscribeStatesAsync("startPairing");
      await this.subscribeStatesAsync("*.system.reboot");
      await this.subscribeStatesAsync("*.system.identify");
      await this.subscribeStatesAsync("*.system.cloud_enabled");
      await this.subscribeStatesAsync("*.system.status_led_brightness_pct");
      await this.subscribeStatesAsync("*.system.api_v1_enabled");
      await this.subscribeStatesAsync("*.battery.mode");
      await this.subscribeStatesAsync("*.battery.permissions");
      await this.subscribeStatesAsync("*.battery.charge_to_full");
      await this.subscribeStatesAsync("*.remove");

      // ONE object query for everything that follows: loading the devices, the
      // legacy sweep, the label retrofit and the retired-marker cleanup all work
      // off the same list. Reading it once also replaced the `info.legacyMigrated`
      // marker, whose only job was to skip ~62 `getObject` probes per device —
      // adapter bookkeeping does not belong in a user's object tree.
      //
      // The one path that changes the list while it is held is the v0.2 legacy
      // migration, which creates device objects. That is harmless: none of the
      // three consumers below asks about a device object, and a device migrated
      // just now has no states to sweep or relabel yet.
      const objects = await this.getAdapterObjectsAsync();
      const existingIds = new Set(Object.keys(objects));

      const devices = await this.loadDevicesFromObjects(objects);
      if (devices.length === 0) {
        this.log.info(`No devices configured — set 'startPairing' to true to add a device`);
        await this.setStateChangedAsync("info.connection", { val: false, ack: true });
      }

      for (const device of devices) {
        const key = this.stateManager.devicePrefix(device);
        await this.stateManager.cleanupMovedStates(device, existingIds);
        await this.stateManager.createDeviceStates(device);
        // Stamp before the first connection attempt: the previous run's value
        // survives in the database, so without this a device that was green when
        // the adapter died stays green until its first WebSocket result — and
        // forever if it never reconnects.
        await this.stateManager.setDeviceConnected(device, false);
        const conn = createDeviceConnection(device, device.ip || "");
        this.connections.set(key, conn);

        if (conn.ip) {
          this.log.debug(`Using stored IP ${conn.ip} for ${deviceLabel(device)}`);
          void this.connectionManager
            .initDevice(conn)
            .catch((err: unknown) =>
              this.log.error(`initDevice failed for ${deviceLabel(conn.config)}: ${errText(err)}`),
            );
        }
      }

      // Bring existing objects to this version's labels. Almost everything under a
      // device lives behind `updateMeasurement`/`updateSystem`/`updateBattery`, which
      // only run while the device sends data — on an installation whose meter is
      // silent, a corrected label would otherwise never arrive.
      await this.refreshDeviceLabels(devices, existingIds);

      // A device whose stored IP is missing or was discarded as invalid gets no
      // connection attempt at all — and IP recovery is only ever triggered from
      // connectWebSocket, which such a device never reaches. Left alone it would
      // stay dead until the next restart with a valid IP or a re-pair, without a
      // single line saying so. Say it, and start the mDNS search once.
      if (devices.some(device => !device.ip)) {
        for (const device of devices.filter(d => !d.ip)) {
          this.log.warn(`${deviceLabel(device)}: no usable IP address stored — searching for the device via mDNS`);
        }
        this.startIpRecovery();
      }

      this.systemPollTimer = this.setInterval(() => {
        void this.connectionManager.pollAllSystemInfo();
      }, SYSTEM_POLL_MS);

      this.connectionManager.updateGlobalConnection();
    } catch (err: unknown) {
      this.log.error(`onReady failed: ${errText(err)}`);
    }
  }

  /**
   * Load device configs from existing device objects.
   * Tokens are stored encrypted in device object native.
   *
   * @param objects Every object in this namespace — already fetched by the caller,
   *   so this does not query the object store a second time.
   */
  private async loadDevicesFromObjects(objects: Record<string, ioBroker.Object>): Promise<DeviceConfig[]> {
    const devices: DeviceConfig[] = [];

    // One-shot legacy migration: v0.1/0.2 stored devices in adapter `native.devices`;
    // v0.3.0 moved them to per-device objects. Any install that ran v0.3.0+ has already
    // migrated (native.devices cleared below), but removal is low-reward / non-zero-risk
    // for an install that has been dormant since v0.2 — keep until at least v1.0.0.
    // Defensive: native.devices could be a non-array if a previous version
    // wrote a different shape, or if the user edited it manually.
    const rawOldDevices = (this.config as Record<string, unknown>).devices;
    const oldDevices: DeviceConfig[] = Array.isArray(rawOldDevices) ? (rawOldDevices as DeviceConfig[]) : [];
    if (oldDevices.length > 0) {
      this.log.debug(`Migrating ${oldDevices.length} device(s) from adapter config to device objects`);
      const migrated: DeviceConfig[] = [];
      for (const device of oldDevices) {
        try {
          await this.saveDeviceToObject(device);
          migrated.push(device);
        } catch (err) {
          // I13: isolate a single malformed legacy entry (a missing serial /
          // productType / token makes devicePrefix.sanitize or encrypt throw) so
          // it can't abort the whole migration — mirrors the per-entry isolation
          // of the modern object-load path below.
          this.log.warn(`Skipping a corrupt legacy device entry during migration: ${errText(err)}`);
        }
      }
      // Clear old config (this triggers one restart, but only during migration)
      await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
        native: { devices: [] },
      });
      return migrated;
    }

    // Read device objects from our namespace. A corrupted encryptedToken
    // (e.g. after secret rotation, crypto-lib changes, manual DB edits) must
    // not take down the whole adapter — skip the broken device, keep the rest.
    for (const [id, obj] of Object.entries(objects)) {
      if (obj.type !== "device") {
        continue;
      }
      const localId = id.replace(`${this.namespace}.`, "");
      const native = obj.native as Record<string, string> | undefined;
      if (!native?.encryptedToken || !native.serial) {
        // Every device object this adapter writes carries both fields, so one
        // without them is damaged (a hand-edited database, an interrupted write).
        // Say so: the device silently disappears from the adapter otherwise, and
        // the user is left with a folder full of data points that never update.
        this.log.warn(
          `${localId}: device entry is incomplete (no stored token or serial) — it is skipped. ` +
            `Set its 'remove' data point to true to delete it, then pair the device again.`,
        );
        continue;
      }
      this.log.debug(`Loading device from object: ${localId}`);
      let token: string;
      try {
        token = this.decrypt(native.encryptedToken);
      } catch (err) {
        this.log.warn(
          `Cannot decrypt token for ${localId} — pair the device again, or set its 'remove' data point ` +
            `to true to delete it. (${errText(err)}). Other devices remain unaffected.`,
        );
        continue;
      }
      devices.push({
        token,
        productType: native.productType || "unknown",
        serial: native.serial,
        // L9: clean a possibly-dirty stored name on load too (pre-fix install or
        // a manual DB edit) — keeps the object name and every log line newline-free.
        productName: sanitizeForLog(native.productName || native.productType || "unknown"),
        ...(native.ip && isValidIpv4(native.ip) ? { ip: native.ip } : {}),
        ...(native.certCn ? { certCn: native.certCn } : {}),
      });
    }

    return devices;
  }

  /**
   * Save device config to its device object native (encrypted token)
   *
   * @param config Device configuration to save
   */
  private async saveDeviceToObject(config: DeviceConfig): Promise<void> {
    const prefix = this.stateManager.devicePrefix(config);
    const encryptedToken = this.encrypt(config.token);
    await this.extendObject(prefix, {
      type: "device",
      // No `preserve`: the name follows the device (i.e. the HomeWizard app), like
      // every other label in this tree — see DD21.
      common: { name: deviceObjectName(config) },
      native: {
        encryptedToken,
        productType: config.productType,
        serial: config.serial,
        productName: config.productName,
        ...(config.ip ? { ip: config.ip } : {}),
        ...(config.certCn ? { certCn: config.certCn } : {}),
      },
    });
  }

  /**
   * Adapter stopping.
   *
   * Timers and sockets go down synchronously, but the last writes are awaited:
   * every device carries an online marker behind `statusStates`, and nothing
   * else resets it. Closing the WebSocket deliberately suppresses its disconnect
   * handler, and the host's own reset of `info.connection` writes to the wrong
   * id (js-controller#3472) — so if these writes are lost, the whole tree stays
   * green while the adapter is off. Waiting is safe because the manifest no
   * longer declares `supportedMessages.stopInstance`: the host grants the full
   * `common.stopTimeout` instead of killing the process outright.
   *
   * @param callback Completion callback
   */
  private onUnload(callback: () => void): void {
    // Set first, before any clearTimeout — in-flight async paths
    // (REST poll, getMeasurement, getSystem) check this after each await
    // and bail out before further setState on a tearing-down adapter.
    this.unloading = true;
    try {
      this.pairingManager.stop();
      if (this.systemPollTimer) {
        this.clearInterval(this.systemPollTimer);
        this.systemPollTimer = undefined;
      }
      if (this.ipRecoveryTimer) {
        this.clearTimeout(this.ipRecoveryTimer);
        this.ipRecoveryTimer = undefined;
      }

      this.discovery?.stop();

      // Read the configs off the registry BEFORE it is cleared — the markers are
      // written from this list, and onUnload must not await an object query.
      const configs = Array.from(this.connections.values(), conn => conn.config);
      for (const conn of this.connections.values()) {
        this.connectionManager.teardownConnection(conn);
      }
      this.connections.clear();

      const writes: Promise<unknown>[] = [this.setState("info.connection", { val: false, ack: true })];
      // The state manager exists only once onReady got past the stopInstance
      // correction (and I18n.init). A restart forced by that correction unloads a
      // process that never built one — the device markers cannot be written then,
      // and nothing was connected anyway. Without this guard the teardown threw
      // and even info.connection stayed unwritten.
      const stateManager = this.stateManager as StateManager | undefined;
      if (stateManager) {
        writes.push(stateManager.markAllDisconnected(configs), stateManager.writeDeviceRollup(configs.length, 0));
      }
      void Promise.all(writes)
        .catch((err: unknown) => {
          // A rejected write must not become an unhandled rejection — that turns
          // an orderly stop into a crash. The trace explains a stale green tree.
          this.log.debug(`Final shutdown write failed: ${errText(err)}`);
        })
        .finally(() => callback());
      return;
    } catch (err: unknown) {
      this.log.debug(`Teardown failed: ${errText(err)}`);
      callback();
    }
  }

  /**
   * Put a momentary button back to `false, ack:true` so Admin shows it as
   * clickable again.
   *
   * Runs from a `finally`, so it must never throw: a rejected write here would
   * replace the error the caller is about to report with a meaningless one.
   *
   * @param id Full state ID of the button.
   */
  private async resetButton(id: string): Promise<void> {
    try {
      await this.setState(id, { val: false, ack: true });
    } catch (err: unknown) {
      this.log.debug(`Could not reset the button ${id}: ${errText(err)}`);
    }
  }

  /**
   * Every writable control state, and what writing it does on the device.
   *
   * A table instead of a chain of `id.endsWith(...)` branches: the branches all
   * said the same three things — validate, send, acknowledge what was sent — and
   * repeated the button rule by hand at each button. Here the rule is stated once
   * in {@link onStateChange}, and a new control state is one entry.
   *
   * Order does not matter: the suffixes are mutually exclusive.
   */
  private readonly deviceCommands: DeviceCommand[] = [
    {
      suffix: ".system.reboot",
      button: true,
      send: async ({ client, conn }) => {
        this.log.info(`Rebooting ${deviceLabel(conn.config)} at ${conn.ip}`);
        await client.reboot();
        return null;
      },
    },
    {
      suffix: ".system.identify",
      button: true,
      send: async ({ client }) => {
        await client.identify();
        return null;
      },
    },
    {
      suffix: ".system.cloud_enabled",
      refresh: "system",
      // Ack the value that was actually sent (a script may write "true" or 1 into
      // the boolean state) — the ack must not carry the raw write (DD16).
      send: async ({ client, state }) => {
        const enabled = !!state.val;
        await client.setSystem({ cloud_enabled: enabled });
        return enabled;
      },
    },
    {
      suffix: ".system.status_led_brightness_pct",
      refresh: "system",
      send: async ({ client, state }) => {
        const pct = coerceFiniteNumber(state.val);
        if (pct === null || pct < 0 || pct > 100) {
          this.log.warn(`Invalid status_led_brightness_pct '${String(state.val)}' — expected a number 0-100`);
          return null;
        }
        await client.setSystem({ status_led_brightness_pct: pct });
        return pct;
      },
    },
    {
      suffix: ".system.api_v1_enabled",
      refresh: "system",
      send: async ({ client, state, conn }) => {
        if (state.val) {
          this.log.warn(
            `${deviceLabel(conn.config)}: enabling the legacy v1 API — it has no TLS and no token, so any ` +
              `host on the LAN can then read and control this device without authentication.`,
          );
        }
        const v1Enabled = !!state.val;
        await client.setSystem({ api_v1_enabled: v1Enabled });
        return v1Enabled;
      },
    },
    {
      suffix: ".battery.mode",
      refresh: "battery",
      // The validated mode, not the raw write. (The two cannot differ today,
      // because validateBatteryMode only lets the four exact strings through;
      // acking the sent value keeps it right if a normalisation step is ever added.)
      send: async ({ client, state }) => {
        const mode = validateBatteryMode(String(state.val));
        if (!mode) {
          this.log.warn(
            `Invalid battery.mode value: '${String(state.val)}' — expected one of: zero, to_full, standby, predictive`,
          );
          return null;
        }
        await client.setBatteries({ mode });
        return mode;
      },
    },
    {
      suffix: ".battery.permissions",
      refresh: "battery",
      // Ack the list that actually went to the device, not the raw text a script
      // wrote — otherwise its spacing stays in the data point while the device
      // holds the parsed value.
      send: async ({ client, state }) => {
        const result = parseBatteryPermissions(String(state.val));
        if (!result.ok) {
          this.log.warn(
            `Invalid JSON for battery.permissions: ${result.reason} — expected array, got: ${result.sample}`,
          );
          return null;
        }
        await client.setBatteries({ permissions: result.perms });
        return JSON.stringify(result.perms);
      },
    },
    {
      suffix: ".battery.charge_to_full",
      refresh: "battery",
      send: async ({ client, state }) => {
        const chargeToFull = !!state.val;
        await client.setBatteries({ charge_to_full: chargeToFull });
        return chargeToFull;
      },
    },
  ];

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    try {
      if (!state || state.ack || this.unloading) {
        return;
      }

      if (id.endsWith(".startPairing")) {
        if (state.val) {
          await this.pairingManager.start();
        }
        return;
      }

      if (id.endsWith(".remove")) {
        if (state.val) {
          await this.removeDevice(id);
        }
        return;
      }

      const command = this.deviceCommands.find(c => id.endsWith(c.suffix));
      if (!command) {
        this.log.debug(`stateChange ${id}: no control state of this adapter — ignored`);
        return;
      }

      const conn = this.connectionManager.findConnectionForState(id);
      if (!conn || !conn.ip) {
        // Orphaned state (device removed but state written) or device without
        // IP yet — surface at debug so a user-side diagnosis is possible.
        this.log.debug(`stateChange ${id}: no matching connected device — ignored`);
        // The button still has to fall back, or it stays pressed for good on a
        // device that never comes back.
        if (command.button) {
          await this.resetButton(id);
        }
        return;
      }

      const client = this.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial);

      try {
        const ack = await command.send({ client, state, conn });
        if (ack !== null) {
          await this.setState(id, { val: ack, ack: true });
        }
      } catch (err) {
        this.log.warn(`Failed to set ${id}: ${errText(err)}`);
        // The device refused (or never heard) the write, so the data point still shows
        // what the user asked for, unacknowledged — a value the device does not hold.
        // Read that one group back right away instead of letting the data point lie
        // until the next 60 s system poll corrects it.
        if (command.refresh) {
          await this.connectionManager.refreshGroup(conn, command.refresh);
        }
      } finally {
        // Whatever happened above, a momentary button goes back to false. It can
        // never collide with an acknowledged value: an entry is either a button
        // (ack `null`) or a value state (never `button`).
        if (command.button) {
          await this.resetButton(id);
        }
      }
    } catch (err: unknown) {
      this.log.error(`stateChange failed: ${errText(err)}`);
    }
  }

  /**
   * (Re)start the one mDNS browser, shared by IP recovery and the pairing window.
   *
   * A restart is a fresh browser with a fresh PTR query: bonjour-service reports a
   * service only ONCE per browser run (`up`; later answers are `srv-update`, which
   * nobody hears), so a second device asking for recovery, or a device that moved
   * while the browser was already running, is only heard by a new run.
   */
  private restartBrowser(): void {
    if (this.unloading) {
      return;
    }
    if (!this.discovery) {
      this.discovery = this.makeDiscovery();
    }
    this.discovery.start(discovered => this.onDiscovered(discovered));
  }

  /** Stop the browser once neither IP recovery nor the pairing window needs it. */
  private releaseBrowser(): void {
    if (this.discovery && !this.pairingManager.active && !this.ipRecoveryTimer) {
      this.discovery.stop();
      this.discovery = null;
    }
  }

  /**
   * One place that decides what an mDNS announcement means.
   *
   * - A known device: its address is taken over if it changed and it is not
   *   connected (IP recovery, DD35). While the pairing window is open, a known
   *   device whose token the device no longer accepts is offered to pairing, so
   *   "token invalid — re-pair" can be fixed over mDNS; a healthy one is named once
   *   as already paired.
   * - An unknown device: offered to pairing while the window is open.
   *
   * @param discovered The announced device.
   */
  private onDiscovered(discovered: DiscoveredDevice): void {
    const conn = Array.from(this.connections.values()).find(c => c.config.serial === discovered.serial);
    if (!conn) {
      if (this.pairingManager.active) {
        this.pairingManager.onDeviceDiscovered(discovered);
      }
      return;
    }
    if (this.pairingManager.active) {
      if (this.connectionManager.isAuthStopped(conn)) {
        this.pairingManager.onDeviceDiscovered(discovered);
      } else {
        this.pairingManager.noteAlreadyPaired(discovered, deviceLabel(conn.config));
      }
    }
    this.applyDiscoveredAddress(conn, discovered);
  }

  /**
   * Take over the address mDNS reports for a known device.
   *
   * @param conn       The device's connection.
   * @param discovered The announcement.
   */
  private applyDiscoveredAddress(conn: DeviceConnection, discovered: DiscoveredDevice): void {
    if (discovered.ip === conn.ip || conn.wsAuthenticated) {
      return; // Same IP or already connected
    }
    // A connect attempt in flight is NOT a reason to drop this answer — it is the
    // normal case. The recovery query goes out from connectWebSocket right before it
    // opens the socket to the OLD (dead) address, which then hangs for seconds; the
    // device's reply arrives inside exactly that window. `teardownConnection` below
    // closes that pending client (its close-event is suppressed), so the reconnect
    // below is the only one left.
    this.log.info(`${deviceLabel(conn.config)}: found at new IP ${discovered.ip} (was ${conn.ip})`);

    // Update IP and persist — reset stability (new network conditions)
    conn.ip = discovered.ip;
    conn.config.ip = discovered.ip;
    conn.wsFailCount = 0;
    conn.recentDisconnects = 0;
    // Surface persist-failures (e.g. js-controller hiccup) instead of swallowing
    // them — the user otherwise sees "new IP" log but the change is lost on next
    // restart.
    this.saveDeviceToObject(conn.config).catch((err: unknown) =>
      this.log.debug(`Failed to persist new IP for ${deviceLabel(conn.config)}: ${errText(err)}`),
    );

    // Drop everything that still points at the old address — the pending
    // WebSocket, the backoff timer and the REST fallback — then connect.
    this.connectionManager.teardownConnection(conn);
    this.connectionManager.connectWebSocket(conn);
  }

  /**
   * Search for devices that changed their IP.
   *
   * Every request restarts the browser and the 60-second window, even while a search
   * is already running: a dropped request used to wait ~50 minutes for the next one,
   * and a running browser cannot hear an answer it has already reported.
   */
  private startIpRecovery(): void {
    if (this.unloading) {
      return;
    }
    // Internal recovery — debug only. The state of every device is in its
    // `info.connected`; repeating that hourly while a device stays offline adds nothing.
    this.log.debug(`Device unreachable — searching for new IP via mDNS`);

    this.restartBrowser();
    if (this.ipRecoveryTimer) {
      this.clearTimeout(this.ipRecoveryTimer);
    }
    // Stop mDNS after the window — WS reconnect continues with exponential backoff.
    this.ipRecoveryTimer = this.setTimeout(() => {
      this.ipRecoveryTimer = undefined;
      this.releaseBrowser();

      for (const conn of this.connections.values()) {
        if (!conn.wsAuthenticated && conn.wsFailCount > 0) {
          this.log.debug(
            `${deviceLabel(conn.config)}: device offline — will keep retrying every ${WS_RECONNECT_MAX_MS / 1000}s`,
          );
        }
      }
    }, IP_RECOVERY_TIMEOUT_MS);
  }

  /** Stop mDNS IP recovery — the browser stays up while the pairing window needs it. */
  private stopIpRecovery(): void {
    if (this.ipRecoveryTimer) {
      this.clearTimeout(this.ipRecoveryTimer);
      this.ipRecoveryTimer = undefined;
    }
    this.releaseBrowser();
  }

  /** Stop mDNS IP-recovery once every device is connected (main owns the discovery browser). */
  private onDeviceConnected(): void {
    if (this.ipRecoveryTimer) {
      const allConnected = Array.from(this.connections.values()).every(c => c.wsAuthenticated);
      if (allConnected) {
        this.stopIpRecovery();
      }
    }
  }

  /**
   * Take a freshly paired device into operation.
   *
   * Stays in main because the connection registry does: on a RE-pair (a device
   * that was factory-reset and paired again) the old connection has to be torn
   * down before the map entry is overwritten, or its WebSocket keeps running as a
   * zombie until the next restart.
   *
   * @param config The device configuration just written.
   * @param ip     The address the device was reached at.
   */
  private adoptPairedDevice(config: DeviceConfig, ip: string): void {
    const key = this.stateManager.devicePrefix(config);
    const previous = this.connections.get(key);
    if (previous) {
      this.log.debug(`Re-pair: closing previous connection for ${deviceLabel(config)}`);
      // Mark it before the teardown, like removeDevice does: work that is already in
      // flight on the OLD connection (an initDevice or system poll waiting on a 10 s
      // timeout) checks this flag after each await. Without it such a task can still
      // persist the old device object — overwriting the token that was just issued —
      // and its tail even opens a fresh WebSocket for a connection nobody holds any more.
      previous.removed = true;
      this.connectionManager.teardownConnection(previous);
    }

    const conn = createDeviceConnection(config, ip);
    this.connections.set(key, conn);
    void this.connectionManager
      .initDevice(conn)
      .catch((err: unknown) => this.log.error(`initDevice failed for ${deviceLabel(conn.config)}: ${errText(err)}`));
    this.connectionManager.updateGlobalConnection();
  }

  /**
   * Remove a device the adapter never loaded.
   *
   * A device object whose stored token is missing or cannot be decrypted is
   * skipped while loading, so it has no connection — and the regular removal path
   * above, which starts from the connection, silently did nothing for it. Its data
   * points stayed in the tree, the button stayed pressed and no line was logged.
   * That was the one device a user actually needed to get rid of. The object's own
   * id is all that is left of it, and that is enough to delete it.
   *
   * The token cannot be revoked here — reading it is exactly what failed — so the
   * access may survive on the device itself. Say that, rather than pretend a clean
   * removal.
   *
   * @param stateId Full state ID of the `remove` button that was pressed.
   */
  private async removeUnloadedDevice(stateId: string): Promise<void> {
    const suffix = ".remove";
    const localId = stripNamespace(stateId, this.namespace);
    // A device prefix is `<productType>_<serial>` — one segment, never nested.
    const prefix = localId.endsWith(suffix) ? localId.slice(0, -suffix.length) : "";
    if (!prefix || prefix.includes(".")) {
      this.log.debug(`remove ${stateId}: not a device-level remove button — ignored`);
      await this.resetButton(stateId);
      return;
    }

    const obj = await this.getObjectAsync(prefix);
    if (obj?.type !== "device") {
      this.log.debug(`remove ${stateId}: no device object '${prefix}' to remove — ignored`);
      await this.resetButton(stateId);
      return;
    }

    this.log.info(
      `Removing ${prefix} — this device could not be used by the adapter (no readable token), so its ` +
        `access on the device itself cannot be revoked. Remove it in the HomeWizard app if you no longer want it.`,
    );
    await this.stateManager.removeDeviceByPrefix(prefix);
    // No `updateGlobalConnection()` here on purpose: the summary counts
    // connections, and this device never had one — nothing changed for it.
  }

  /**
   * Remove a device — disconnect, delete states and object
   *
   * @param stateId The remove state ID
   */
  private async removeDevice(stateId: string): Promise<void> {
    const conn = this.connectionManager.findConnectionForState(stateId);
    if (!conn) {
      await this.removeUnloadedDevice(stateId);
      return;
    }

    const key = this.stateManager.devicePrefix(conn.config);
    this.log.info(`Removing device ${deviceLabel(conn.config)}`);

    // Mark as removed FIRST — async tasks (in-flight WS frames, REST polls,
    // outstanding pollSystemInfo) check this flag after each await and bail
    // out before recreating just-deleted objects via setState.
    conn.removed = true;

    // Best-effort token revoke on the device (DELETE /api/user) so the local/iobroker user
    // doesn't linger across pair/unpair cycles. Fire-and-forget — never block removal on a
    // (possibly offline) device's 10s timeout.
    const revoke =
      conn.ip && conn.config.token
        ? this.makeClient(conn.ip, conn.config.token, conn.config.certCn, conn.config.serial)
            .deleteUser()
            .then(
              () => this.log.debug(`Token revoked for ${deviceLabel(conn.config)}`),
              (err: unknown) =>
                // Not a fault of the adapter's: the usual case is a device that is
                // already gone or offline. Say it at info, in the same words as the
                // path for a device without a readable token, because the user has to
                // finish the job in the app.
                this.log.info(
                  `${deviceLabel(conn.config)}: the access token could not be revoked (${errText(err)}) — ` +
                    `the local/iobroker user stays on the device, remove it in the HomeWizard app.`,
                ),
            )
        : Promise.resolve();

    // Disconnect
    this.connectionManager.teardownConnection(conn);
    this.connections.delete(key);
    // I8: evict the pinned per-device TLS agents (CN + serial) and close their pooled
    // sockets so nothing lingers in the module maps after the device is gone — but only
    // AFTER the revoke above is done with them. `agent.destroy()` tears down the socket
    // the DELETE is riding on (measured: ECONNRESET, the device never sees the request),
    // so evicting one statement later silently killed every revoke. Skip it when the
    // same device was paired again in the meantime: the agents are then in use.
    void revoke.finally(() => {
      if (!this.connections.has(key)) {
        dropDeviceAgent(conn.config.certCn, conn.config.serial);
      }
    });
    // Drop the per-device cooldown stamps — otherwise a re-pair of the same
    // serial within the cooldown window inherits the old device's stamp and
    // its first warn/info is silently suppressed (and the maps grow forever
    // across pair/remove cycles).
    this.connectionManager.dropCooldowns(conn.config.serial);

    // Delete device object and all states (no adapter restart!)
    await this.stateManager.removeDevice(conn.config);

    this.connectionManager.updateGlobalConnection();
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HomeWizard(options);
} else {
  (() => new HomeWizard())();
}
