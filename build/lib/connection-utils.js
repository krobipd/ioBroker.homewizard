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
var connection_utils_exports = {};
__export(connection_utils_exports, {
  UNSTABLE_DISCONNECT_THRESHOLD: () => UNSTABLE_DISCONNECT_THRESHOLD,
  classifyError: () => classifyError,
  createDeviceConnection: () => createDeviceConnection
});
module.exports = __toCommonJS(connection_utils_exports);
var import_homewizard_client = require("./homewizard-client");
const UNSTABLE_DISCONNECT_THRESHOLD = 3;
function createDeviceConnection(config, ip) {
  return {
    config,
    ip,
    wsClient: null,
    wsAuthenticated: false,
    pollTimer: void 0,
    reconnectTimer: void 0,
    wsFailCount: 0,
    authFailCount: 0,
    lastErrorCode: "",
    lastConnectedAt: 0,
    recentDisconnects: 0
  };
}
function classifyError(err) {
  if (err instanceof import_homewizard_client.HomeWizardApiError) {
    if (err.errorCode === "user:unauthorized") {
      return "AUTH";
    }
    return `HTTP_${err.statusCode}`;
  }
  if (err instanceof Error) {
    const code = err.code;
    if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "ENETUNREACH" || code === "EAI_AGAIN") {
      return "NETWORK";
    }
    if (code === "ETIMEDOUT" || err.message.includes("Timeout")) {
      return "TIMEOUT";
    }
    return code || "UNKNOWN";
  }
  return "UNKNOWN";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  UNSTABLE_DISCONNECT_THRESHOLD,
  classifyError,
  createDeviceConnection
});
//# sourceMappingURL=connection-utils.js.map
