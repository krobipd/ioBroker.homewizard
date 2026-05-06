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
  isPlainObject: () => isPlainObject,
  parseBatteryPermissions: () => parseBatteryPermissions,
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
const BATTERY_MODES = ["zero", "to_full", "standby"];
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BATTERY_MODES,
  coerceBoolean,
  coerceFiniteNumber,
  coerceString,
  errText,
  isPlainObject,
  parseBatteryPermissions,
  validateBatteryMode
});
//# sourceMappingURL=coerce.js.map
