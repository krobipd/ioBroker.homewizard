/**
 * Boundary coercion helpers for external API data (REST + WebSocket).
 * HomeWizard API v2 is well-documented but field types still drift in practice
 * (firmware bugs, future additions, null values). These helpers guard against
 * NaN/Infinity/non-string values reaching ioBroker states.
 */

/**
 * Coerce to a finite number or null.
 * Accepts numbers directly; parses numeric strings; rejects NaN/Infinity/other.
 *
 * @param value Unknown external value
 */
export function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerce to a non-empty string, or null.
 *
 * @param value Unknown external value
 */
export function coerceString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

/**
 * Coerce to a boolean (only `true`/`false` accepted — no truthy/falsy JS rules).
 *
 * @param value Unknown external value
 */
export function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

/**
 * Guard for plain objects (not arrays, not null).
 *
 * @param value Unknown external value
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Allowed values for `battery.mode` per HomeWizard API v2. */
export const BATTERY_MODES = ["zero", "to_full", "standby"] as const;
export type BatteryMode = (typeof BATTERY_MODES)[number];

/**
 * Validate user input for `battery.mode` against the API-allowed enum. Returns
 * the typed mode on success, or `null` if the input is not in the whitelist.
 *
 * @param value Raw user input (`String(state.val)`).
 */
export function validateBatteryMode(value: unknown): BatteryMode | null {
  return typeof value === "string" && (BATTERY_MODES as readonly string[]).includes(value)
    ? (value as BatteryMode)
    : null;
}

/** Outcome of {@link parseBatteryPermissions} — either a parsed array or a diagnostic. */
export type BatteryPermissionsResult = { ok: true; perms: string[] } | { ok: false; reason: string; sample: string };

/**
 * Parse a JSON string for `battery.permissions`. Expected shape: `string[]`.
 * Wraps `JSON.parse` so a malformed user input becomes a typed warning instead
 * of a thrown exception, and rejects non-array results explicitly.
 *
 * @param raw Raw user input (`String(state.val)`).
 */
export function parseBatteryPermissions(raw: string): BatteryPermissionsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: errText(err), sample: raw.slice(0, 200) };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "expected JSON array", sample: raw.slice(0, 200) };
  }
  // permissions are documented as string array — coerce defensively.
  const perms: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") {
      return {
        ok: false,
        reason: `non-string entry: ${typeof item}`,
        sample: raw.slice(0, 200),
      };
    }
    perms.push(item);
  }
  return { ok: true, perms };
}

/**
 * Extract a log-friendly message from a thrown / rejected value. Centralizes the
 * `err instanceof Error ? err.message : String(err)` pattern that otherwise
 * gets repeated at every catch-site. Plain objects are JSON-stringified so a
 * `[object Object]` log is avoided when adapters throw bag-of-fields.
 *
 * @param err Caught value of unknown shape (Error, string, undefined, ...).
 */
export function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (err === null) {
    return "null";
  }
  if (err === undefined) {
    return "undefined";
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  // Plain objects + symbols would otherwise stringify to "[object Object]" / fail.
  // Prefer JSON for the common case so the log is at least diagnosable.
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}
