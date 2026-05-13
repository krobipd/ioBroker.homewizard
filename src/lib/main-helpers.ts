/**
 * Pure decision helpers for the adapter lifecycle. Extracted from `main.ts` so
 * the math/branching can be unit-tested without spinning up an adapter mock.
 *
 * Nothing in here touches `this.adapter` / `this.log` / timers — caller wires
 * the result back to the actual side-effects.
 */

import type { DeviceConnection } from "./types";

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
 * Pick the REST-fallback poll interval based on connection stability. Unstable
 * devices poll faster to keep the data flowing while WS reconnect is still
 * trying.
 *
 * @param unstable           Whether the device is currently in unstable mode.
 * @param stableIntervalMs   `REST_POLL_MS`.
 * @param unstableIntervalMs `REST_POLL_UNSTABLE_MS`.
 */
export function pickRestPollInterval(unstable: boolean, stableIntervalMs: number, unstableIntervalMs: number): number {
  return unstable ? unstableIntervalMs : stableIntervalMs;
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
