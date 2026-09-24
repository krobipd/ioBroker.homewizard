/**
 * Boundary coercion helpers for external API data (REST + WebSocket).
 * HomeWizard API v2 is well-documented but field types still drift in practice
 * (firmware bugs, future additions, null values). These helpers guard against
 * NaN/Infinity/non-string values reaching ioBroker states.
 */

// Strict decimal regex — only optional minus sign + digits + optional fractional part.
// Rejects HEX (`0x...`), exponential (`1e3`), Infinity, NaN, leading/trailing whitespace.
// hassemu (E8 in v1.9.0) hardened the same coerce-helper this way; consistency item D8.
const DECIMAL_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Coerce to a finite number or null.
 * Accepts numbers directly; parses strict decimal strings; rejects NaN, Infinity,
 * HEX (`0x...`) and exponential notation (`1e3`).
 *
 * @param value Unknown external value
 */
export function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && DECIMAL_NUMBER_RE.test(value)) {
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
 * Read a value a user or script wrote into a switch data point.
 *
 * Stricter than truthiness on purpose: `!!"false"` is `true`, so a script that
 * writes the text "false" would switch the device ON. Accepted are the booleans,
 * the numbers 1/0 and the texts "true"/"false"/"1"/"0" (trimmed, any case);
 * everything else is `null` — the caller warns instead of guessing.
 *
 * @param value Value of a state written with `ack: false`
 */
export function coerceSwitch(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 1 || value === 0) {
    return value === 1;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true" || text === "1") {
      return true;
    }
    if (text === "false" || text === "0") {
      return false;
    }
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

/**
 * Validate that a string is an IPv4 address (octets 0-255, exactly 4 parts).
 * Used to fail manual-pairing input fast instead of waiting on a 60s timeout.
 *
 * @param value Raw user input.
 */
export function isValidIpv4(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      return false;
    }
    // Reject leading zeros: "01" / "001" — ambiguous, may be parsed as octal elsewhere.
    if (part.length > 1 && part.startsWith("0")) {
      return false;
    }
  }
  return true;
}

/**
 * True for a syntactically-valid IPv4 that is not one of the addresses a device
 * can never legitimately be reached at: loopback (127/8), link-local (169.254/16,
 * including the cloud-metadata IP), unspecified (0.x) and broadcast
 * (255.255.255.255).
 *
 * Deliberately still accepts public addresses: this guards the IP a USER types
 * in for manual pairing, and a home network on a public IPv4 range is unusual but
 * real — rejecting those would lock those users out of pairing entirely. What it
 * does prevent is the input being abused as a connect/port-probe oracle against
 * the host itself or a metadata endpoint. For an address nobody typed — one
 * announced over mDNS — use {@link isLanDeviceIpv4}, which is strict.
 *
 * @param value Raw user input.
 */
export function isAssignableDeviceIpv4(value: unknown): boolean {
  if (!isValidIpv4(value)) {
    return false;
  }
  const parts = (value as string).split(".").map(Number);
  const [a, b] = parts;
  if (a === 127) {
    return false; // loopback
  }
  if (a === 169 && b === 254) {
    return false; // link-local (incl. 169.254.169.254 cloud metadata)
  }
  if (a === 0) {
    return false; // unspecified / "this network"
  }
  if (parts.every(p => p === 255)) {
    return false; // limited broadcast
  }
  return true;
}

/**
 * True only for an IPv4 out of the private ranges a home network actually uses:
 * `10/8`, `172.16/12` and `192.168/16` (RFC 1918).
 *
 * This is the guard for an address the adapter was never told by a human — one
 * announced over mDNS. mDNS is link-local by definition, so a genuine HomeWizard
 * device cannot announce a public address there; a hostile responder on the LAN,
 * however, can announce any address it likes and would otherwise send the adapter
 * off to an arbitrary internet host with a pairing request. The manual pairing
 * path keeps the laxer {@link isAssignableDeviceIpv4} on purpose, because there a
 * person deliberately typed the address.
 *
 * Carrier-grade NAT (`100.64/10`) is NOT included: it lives on the WAN side of
 * the router, never on a LAN segment where a device announces itself.
 *
 * @param value Raw address from an mDNS announcement.
 */
export function isLanDeviceIpv4(value: unknown): boolean {
  if (!isAssignableDeviceIpv4(value)) {
    return false;
  }
  const [a, b] = (value as string).split(".").map(Number);
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return a === 192 && b === 168;
}

// Allowed values for `battery.mode` per HomeWizard API v2 (`zero`, `to_full`,
// `standby`, `predictive` since API 2.3.0). This whitelist is only the
// user-friendly early warning — the device itself rejects unknown modes with an
// ERR response, so it is kept in sync with the API but is not the source of truth.
export const BATTERY_MODES = ["zero", "to_full", "standby", "predictive"] as const;
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
 * One readable line for anything a `catch` receives — never `[object Object]`, never without the reason.
 *
 * @param err the caught value
 * @returns the text
 */
export function errText(err: unknown): string {
  // It runs inside a `catch` and must not throw there: any property of a caught value can be a
  // getter that throws, or hold something other than a string.
  try {
    if (err instanceof Error) {
      // An empty message carries its reason in `code`: `http.get`/`net.connect` to `localhost`
      // reject with an AggregateError (message "", code ECONNREFUSED).
      const code = "code" in err ? err.code : undefined;
      const message: unknown = err.message;
      const name: unknown = err.name;
      const text = String(message || (typeof code === "string" ? code : name));
      // `fetch` rejects with TypeError("fetch failed", { cause }) — ENOTFOUND, ECONNREFUSED,
      // "other side closed" live only in the cause. One level, never the chain (`e.cause = e` is legal).
      const cause = err.cause;
      let reason = "";
      if (cause instanceof Error) {
        const causeCode = "code" in cause ? cause.code : undefined;
        const causeMessage: unknown = cause.message;
        reason =
          (typeof causeMessage === "string" ? causeMessage : "") || (typeof causeCode === "string" ? causeCode : "");
      } else if (cause !== undefined && cause !== null) {
        reason = errText(cause);
      }
      // A wrapper that copies its cause's message would say it twice.
      return reason && !text.includes(reason) ? `${text} (${reason})` : text;
    }
    if (typeof err === "string") {
      return err;
    }
    if (typeof err === "function") {
      // A thrown function or class: `String()` would print its whole source text.
      return Object.prototype.toString.call(err);
    }
    if (err === null || err === undefined || typeof err !== "object") {
      return String(err); // number, boolean, bigint, symbol (`${symbol}` would throw)
    }
    // A thrown object ({ code: "ECONNRESET" }, an HTTP client's error object): JSON.stringify
    // yields `undefined` for what it cannot render and throws on a circular structure.
    return JSON.stringify(err) ?? Object.prototype.toString.call(err);
  } catch {
    // A getter that threw, a circular structure for JSON.stringify: the type tag.
    return Object.prototype.toString.call(err);
  }
}

/**
 * Sanitize a device-supplied string before logging it. Device/mDNS fields
 * (product_name, serial, meter type, discovery name) are attacker-influencable
 * on a hostile LAN; a value with embedded newlines could forge extra log lines.
 * Collapse CR/LF/tab to spaces and cap the length. Fleet helper (beszel SEC-8).
 *
 * @param value     Raw value (string or anything String()-able).
 * @param maxLength Max characters kept before truncating with an ellipsis (default 200).
 */
export function sanitizeForLog(value: unknown, maxLength = 200): string {
  const s = typeof value === "string" ? value : String(value);
  const oneLine = s.replace(/[\r\n\t]+/g, " ");
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine;
}
