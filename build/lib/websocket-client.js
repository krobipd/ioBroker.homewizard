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
var websocket_client_exports = {};
__export(websocket_client_exports, {
  HomeWizardWebSocket: () => HomeWizardWebSocket
});
module.exports = __toCommonJS(websocket_client_exports);
var import_ws = __toESM(require("ws"));
var import_cacert = require("./cacert");
class HomeWizardWebSocket {
  ip;
  token;
  callbacks;
  ws = null;
  destroyed = false;
  /**
   * @param ip Device IP address
   * @param token Bearer token
   * @param callbacks Event callbacks
   */
  constructor(ip, token, callbacks) {
    this.ip = ip;
    this.token = token;
    this.callbacks = callbacks;
  }
  /** Connect to WebSocket and start auth handshake */
  connect() {
    if (this.destroyed) {
      return;
    }
    this.cleanup();
    const url = `wss://${this.ip}/api/ws`;
    this.callbacks.log.debug(`WS connecting to ${url}`);
    this.ws = new import_ws.default(url, {
      agent: import_cacert.HW_AGENT,
      handshakeTimeout: 1e4
    });
    this.ws.on("open", () => {
      this.callbacks.log.debug(`WS open to ${this.ip}`);
    });
    this.ws.on("message", (raw) => {
      this.handleMessage(raw);
    });
    this.ws.on("close", (code, reason) => {
      this.callbacks.log.debug(`WS closed: ${code} ${reason.toString()}`);
      this.ws = null;
      if (!this.destroyed) {
        this.callbacks.onDisconnected();
      }
    });
    this.ws.on("error", (err) => {
      this.callbacks.log.debug(`WS error: ${err.message}`);
    });
  }
  /** Gracefully close connection */
  close() {
    this.destroyed = true;
    this.cleanup();
  }
  /** Whether the WebSocket is currently open */
  get isConnected() {
    var _a;
    return ((_a = this.ws) == null ? void 0 : _a.readyState) === import_ws.default.OPEN;
  }
  /**
   * Handle incoming WebSocket message
   *
   * @param raw Raw message data
   */
  handleMessage(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : "";
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.callbacks.log.warn(`WS invalid JSON: ${text.substring(0, 200)}`);
      return;
    }
    switch (msg.type) {
      case "authorization_requested":
        this.callbacks.log.debug("WS auth requested, sending token");
        this.send({ type: "authorization", data: this.token });
        break;
      case "authorized":
        this.callbacks.log.debug("WS authorized, subscribing to measurement");
        this.send({ type: "subscribe", data: "measurement" });
        this.callbacks.onConnected();
        break;
      case "measurement":
        if (msg.data) {
          this.callbacks.onMeasurement(msg.data);
        }
        break;
      default:
        this.callbacks.log.debug(`WS message type: ${msg.type}`);
        break;
    }
  }
  /**
   * Send a message over WebSocket
   *
   * @param msg Message to send
   */
  send(msg) {
    var _a;
    if (((_a = this.ws) == null ? void 0 : _a.readyState) === import_ws.default.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
  /** Close WebSocket without triggering reconnect */
  cleanup() {
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === import_ws.default.OPEN || this.ws.readyState === import_ws.default.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HomeWizardWebSocket
});
//# sourceMappingURL=websocket-client.js.map
