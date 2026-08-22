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
var coerce_exports = {};
__export(coerce_exports, {
  BATTERY_MODES: () => BATTERY_MODES,
  coerceBoolean: () => coerceBoolean,
  coerceFiniteNumber: () => coerceFiniteNumber,
  coerceString: () => coerceString,
  errText: () => errText,
  isAssignableDeviceIpv4: () => isAssignableDeviceIpv4,
  isPlainObject: () => isPlainObject,
  isValidIpv4: () => isValidIpv4,
  parseBatteryPermissions: () => parseBatteryPermissions,
  sanitizeForLog: () => sanitizeForLog,
  validateBatteryMode: () => validateBatteryMode
});
module.exports = __toCommonJS(coerce_exports);
const DECIMAL_NUMBER_RE = /^-?\d+(\.\d+)?$/;
function coerceFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && DECIMAL_NUMBER_RE.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function coerceString(value) {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}
function coerceBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isValidIpv4(value) {
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
    if (part.length > 1 && part.startsWith("0")) {
      return false;
    }
  }
  return true;
}
function isAssignableDeviceIpv4(value) {
  if (!isValidIpv4(value)) {
    return false;
  }
  const parts = value.split(".").map(Number);
  const [a, b] = parts;
  if (a === 127) {
    return false;
  }
  if (a === 169 && b === 254) {
    return false;
  }
  if (a === 0) {
    return false;
  }
  if (parts.every((p) => p === 255)) {
    return false;
  }
  return true;
}
const BATTERY_MODES = ["zero", "to_full", "standby", "predictive"];
function validateBatteryMode(value) {
  return typeof value === "string" && BATTERY_MODES.includes(value) ? value : null;
}
function parseBatteryPermissions(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: errText(err), sample: raw.slice(0, 200) };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "expected JSON array", sample: raw.slice(0, 200) };
  }
  const perms = [];
  for (const item of parsed) {
    if (typeof item !== "string") {
      return {
        ok: false,
        reason: `non-string entry: ${typeof item}`,
        sample: raw.slice(0, 200)
      };
    }
    perms.push(item);
  }
  return { ok: true, perms };
}
function errText(err) {
  if (err instanceof Error) {
    return err.message;
  }
  if (err === null) {
    return "null";
  }
  if (err === void 0) {
    return "undefined";
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}
function sanitizeForLog(value, maxLength = 200) {
  const s = typeof value === "string" ? value : String(value);
  const oneLine = s.replace(/[\r\n\t]+/g, " ");
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}\u2026` : oneLine;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BATTERY_MODES,
  coerceBoolean,
  coerceFiniteNumber,
  coerceString,
  errText,
  isAssignableDeviceIpv4,
  isPlainObject,
  isValidIpv4,
  parseBatteryPermissions,
  sanitizeForLog,
  validateBatteryMode
});
//# sourceMappingURL=coerce.js.map
