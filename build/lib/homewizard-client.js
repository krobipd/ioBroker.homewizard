"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var homewizard_client_exports = {};
__export(homewizard_client_exports, {
  HomeWizardApiError: () => HomeWizardApiError,
  HomeWizardClient: () => HomeWizardClient
});
module.exports = __toCommonJS(homewizard_client_exports);
var https = __toESM(require("node:https"));
var import_cacert = require("./cacert");
class HomeWizardClient {
  ip;
  token;
  agent;
  /** Override target port — only used by tests against a local stub-server. */
  port;
  /** Optional logger for per-call debug-trace (request entry + response success/fail). */
  log;
  /**
   * @param ip      Device IP address
   * @param token   Bearer token (empty string for pairing requests)
   * @param options Optional overrides — primarily for unit tests against a local TLS stub.
   * @param options.agent HTTPS agent to use; defaults to {@link HW_AGENT} (with HomeWizard CA pinning).
   * @param options.port  Target port; defaults to 443.
   * @param options.log   Optional logger for per-call debug-trace (request/success/fail).
   */
  constructor(ip, token = "", options = {}) {
    var _a, _b, _c;
    this.ip = ip;
    this.token = token;
    this.agent = (_a = options.agent) != null ? _a : import_cacert.HW_AGENT;
    this.port = (_b = options.port) != null ? _b : 443;
    this.log = (_c = options.log) != null ? _c : null;
  }
  /** Get device info (GET /api) */
  async getDeviceInfo() {
    return this.request("GET", "/api");
  }
  /** Request pairing token (POST /api/user) — 403 until button pressed */
  async requestPairing() {
    const result = await this.request("POST", "/api/user", {
      name: "local/iobroker"
    });
    if (!result || typeof result.token !== "string" || result.token.length === 0) {
      throw new HomeWizardApiError(200, JSON.stringify(result), "POST /api/user (no token in response)");
    }
    return result;
  }
  /** Get current measurement (REST fallback) */
  async getMeasurement() {
    return this.request("GET", "/api/measurement");
  }
  /** Get system info */
  async getSystem() {
    return this.request("GET", "/api/system");
  }
  /**
   * Update system settings
   *
   * @param settings System settings to update
   */
  async setSystem(settings) {
    return this.request("PUT", "/api/system", settings);
  }
  /** Reboot device */
  async reboot() {
    await this.request("PUT", "/api/system/reboot");
  }
  /** Identify device (blink LED) */
  async identify() {
    await this.request("PUT", "/api/system/identify");
  }
  /** Get battery control status */
  async getBatteries() {
    return this.request("GET", "/api/batteries");
  }
  /**
   * Set battery control
   *
   * @param settings Battery control settings to update
   */
  async setBatteries(settings) {
    return this.request("PUT", "/api/batteries", settings);
  }
  /**
   * Revoke the adapter's token on the device (DELETE /api/user). The token was created
   * under the fixed name `local/iobroker` during pairing; deleting it stops orphaned tokens
   * accumulating on the device across pair/unpair cycles. Best-effort — callers ignore errors.
   */
  async deleteUser() {
    await this.request("DELETE", "/api/user", { name: "local/iobroker" });
  }
  /** Get the most recent raw P1 telegram (GET /api/telegram, plain text — P1 Meter only). */
  async getTelegram() {
    return this.request("GET", "/api/telegram", void 0, false);
  }
  /**
   * @param method HTTP method
   * @param path API path
   * @param body Optional request body
   * @param parseJson Parse the response as JSON (default). `false` resolves the raw response
   *   text — used for `GET /api/telegram`, which returns a plain-text P1 datagram, not JSON.
   */
  request(method, path, body, parseJson = true) {
    return new Promise((resolve, reject) => {
      var _a;
      const bodyStr = body ? JSON.stringify(body) : void 0;
      const headers = {
        "X-Api-Version": "2"
      };
      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }
      if (bodyStr) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
      }
      const startMs = Date.now();
      (_a = this.log) == null ? void 0 : _a.debug(`HTTPS ${method} ${path} ip=${this.ip} auth=${this.token ? "bearer" : "none"}`);
      const req = https.request(
        {
          hostname: this.ip,
          port: this.port,
          path,
          method,
          headers,
          agent: this.agent,
          timeout: 1e4
        },
        (res) => {
          const chunks = [];
          res.on("error", reject);
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            var _a2, _b, _c;
            const data = Buffer.concat(chunks).toString();
            const elapsedMs = Date.now() - startMs;
            const statusCode = (_a2 = res.statusCode) != null ? _a2 : 0;
            if (!statusCode || statusCode >= 400) {
              const snippet = data.length > 200 ? `${data.slice(0, 200)}\u2026` : data;
              (_b = this.log) == null ? void 0 : _b.debug(`HTTPS ${method} ${path}: status=${statusCode} elapsed=${elapsedMs}ms body="${snippet}"`);
              const error = new HomeWizardApiError(statusCode, data, `${method} ${path}`);
              reject(error);
              return;
            }
            (_c = this.log) == null ? void 0 : _c.debug(
              `HTTPS ${method} ${path}: status=${statusCode} elapsed=${elapsedMs}ms bytes=${data.length}`
            );
            if (!data) {
              resolve(void 0);
              return;
            }
            if (!parseJson) {
              resolve(data);
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON from ${method} ${path}: ${data.substring(0, 200)}`));
            }
          });
        }
      );
      req.on("error", (err) => {
        var _a2;
        (_a2 = this.log) == null ? void 0 : _a2.debug(`HTTPS ${method} ${path}: error="${err.message}" elapsed=${Date.now() - startMs}ms`);
        reject(err);
      });
      req.on("timeout", () => {
        req.destroy(new Error(`Timeout: ${method} ${path}`));
      });
      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }
}
class HomeWizardApiError extends Error {
  statusCode;
  errorCode;
  /**
   * @param statusCode HTTP status code
   * @param body Response body
   * @param context Request context for error message
   */
  constructor(statusCode, body, context) {
    var _a, _b, _c, _d, _e, _f, _g;
    let errorCode = "unknown";
    let description = body;
    try {
      const parsed = JSON.parse(body);
      errorCode = (_c = (_b = (_a = parsed.error) == null ? void 0 : _a.code) != null ? _b : parsed.error) != null ? _c : "unknown";
      description = (_g = (_f = (_d = parsed.error) == null ? void 0 : _d.description) != null ? _f : (_e = parsed.error) == null ? void 0 : _e.code) != null ? _g : body;
    } catch {
    }
    super(`${context}: HTTP ${statusCode} \u2014 ${description}`);
    this.name = "HomeWizardApiError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HomeWizardApiError,
  HomeWizardClient
});
//# sourceMappingURL=homewizard-client.js.map
