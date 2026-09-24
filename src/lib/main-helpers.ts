/**
 * Pure decision helpers for the adapter lifecycle. Extracted from `main.ts` so
 * the math/branching can be unit-tested without spinning up an adapter mock.
 *
 * Nothing in here touches `this.adapter` / `this.log` / timers — caller wires
 * the result back to the actual side-effects.
 */

import type { DeviceConfig, DeviceConnection } from "./types";

/** Outcome of {@link decideUnstableTransition}. */
export type UnstableTransition = "becameUnstable" | "stabilized" | "noChange";

/**
 * Decide whether a device just crossed into "unstable" mode (too many short
 * connections in a row) or back to "stable". Pure function over the connection
 * counters — caller updates `recentDisconnects` and emits the info-log.
 *
 * @param prevDisconnects   `conn.recentDisconnects` before this disconnect.
 * @param durationMs        How long the connection lived this time (`now - lastConnectedAt`).
 * @param stableThresholdMs `STABLE_THRESHOLD_MS` constant.
 * @param unstableThreshold `UNSTABLE_DISCONNECT_THRESHOLD` constant.
 */
export function decideUnstableTransition(
  prevDisconnects: number,
  durationMs: number,
  stableThresholdMs: number,
  unstableThreshold: number,
): UnstableTransition {
  if (durationMs < stableThresholdMs) {
    // Disconnect happened within the stable window → counter goes up.
    const next = prevDisconnects + 1;
    return next === unstableThreshold ? "becameUnstable" : "noChange";
  }
  // Connection survived the stable window → counter resets.
  return prevDisconnects >= unstableThreshold ? "stabilized" : "noChange";
}

/**
 * Compute exponential-backoff delay for the next WebSocket reconnect attempt.
 *
 * @param failCount Consecutive failures (`conn.wsFailCount`, already incremented for this attempt).
 * @param baseMs    `WS_RECONNECT_BASE_MS`.
 * @param maxMs     `WS_RECONNECT_MAX_MS` (stable) or `WS_RECONNECT_MAX_UNSTABLE_MS`.
 */
export function computeReconnectDelay(failCount: number, baseMs: number, maxMs: number): number {
  if (failCount <= 0) {
    return baseMs;
  }
  return Math.min(baseMs * Math.pow(2, failCount - 1), maxMs);
}

/**
 * Decide whether mDNS IP-recovery should kick off on this WS-failure tick.
 * After `beforeMdns` failures, recovery runs once; thereafter it retries every
 * `retryEvery` failures (~hourly given the 5-minute cap).
 *
 * @param failCount  Consecutive failures (post-increment).
 * @param beforeMdns `WS_FAILURES_BEFORE_MDNS`.
 * @param retryEvery `MDNS_RETRY_EVERY`.
 */
export function shouldStartIpRecovery(failCount: number, beforeMdns: number, retryEvery: number): boolean {
  if (failCount < beforeMdns) {
    return false;
  }
  return (failCount - beforeMdns) % retryEvery === 0;
}

/**
 * Strip the adapter namespace prefix from a state-ID. Only strips when the
 * prefix matches at the start — defensive against unexpected IDs.
 *
 * @param stateId   Full state-ID (`<namespace>.<localId>`).
 * @param namespace Adapter namespace (e.g. `homewizard.0`).
 */
export function stripNamespace(stateId: string, namespace: string): string {
  const prefix = `${namespace}.`;
  return stateId.startsWith(prefix) ? stateId.slice(prefix.length) : stateId;
}

/**
 * Find the device connection that owns a given state-ID. Pure linear lookup
 * over the connection map — fine for the typical 1–10 paired devices.
 *
 * @param stateId       Full state-ID written by the user.
 * @param namespace     Adapter namespace.
 * @param connections   Iterable of `(prefix, connection)` pairs (`map.entries()`-shape).
 */
export function findConnectionForState<T extends DeviceConnection>(
  stateId: string,
  namespace: string,
  connections: Iterable<[string, T]>,
): T | undefined {
  const localId = stripNamespace(stateId, namespace);
  for (const [prefix, conn] of connections) {
    if (localId.startsWith(`${prefix}.`)) {
      return conn;
    }
  }
  return undefined;
}

/**
 * Cooldown gate: whether a warn/info should be emitted right now, given the
 * last-emit timestamp for the same key.
 *
 * - `lastMs === 0` (never emitted) → true (emit, set stamp).
 * - `now - lastMs >= cooldownMs` → true (window expired, emit, refresh stamp).
 * - otherwise → false (caller demotes to debug).
 *
 * Used per-device in main.ts: `logDeviceError` warn-path + `onConnected`
 * recovery-info-path. Caller owns the timestamp map and updates it iff this
 * returns true.
 *
 * @param lastMs     Last-emit timestamp (ms) or 0 if never.
 * @param now        Current timestamp (ms) — caller-controlled for test determinism.
 * @param cooldownMs Cooldown window in ms.
 */
export function shouldEmitAfterCooldown(lastMs: number, now: number, cooldownMs: number): boolean {
  if (lastMs === 0) {
    return true;
  }
  return now - lastMs >= cooldownMs;
}

/**
 * Sanitize a string for use in an ioBroker object ID (see adapter.FORBIDDEN_CHARS).
 *
 * @param str Raw string to sanitize.
 */
export function sanitizeIdPart(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

/**
 * The folder id of a device: `<productType>_<serial>`, e.g. `hwe-p1_5c2faf000011`.
 * Unique per device, because the serial is the device's MAC.
 *
 * @param config Device configuration.
 */
export function buildDevicePrefix(config: Pick<DeviceConfig, "productType" | "serial">): string {
  return `${sanitizeIdPart(config.productType)}_${sanitizeIdPart(config.serial)}`;
}

/**
 * The display name of the device object: the product name the device reports.
 *
 * The HomeWizard API has no field for the name a user gives the device in the app —
 * `product_name` is "a fixed, user-friendly name. This name is not the same that is
 * set by the user in the app" (official API v2 docs, device_information). Two
 * devices of the same type therefore carry the same display name; the folder id
 * tells them apart.
 *
 * @param config Device configuration.
 */
export function deviceObjectName(config: Pick<DeviceConfig, "productName" | "productType">): string {
  return config.productName || config.productType;
}

/**
 * How a log line names a device: `P1 Meter (hwe-p1_5c2faf000011)`.
 *
 * The product name alone does not identify a device — two meters of the same type
 * both report "P1 Meter" — so the folder id follows in brackets, the same form the
 * homeconnect adapter uses. Without a product name the id stands alone.
 *
 * @param config Device configuration.
 */
export function deviceLabel(config: Pick<DeviceConfig, "productName" | "productType" | "serial">): string {
  const prefix = buildDevicePrefix(config);
  const name = config.productName?.trim() ?? "";
  return name.length > 0 && name !== prefix ? `${name} (${prefix})` : prefix;
}
