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
