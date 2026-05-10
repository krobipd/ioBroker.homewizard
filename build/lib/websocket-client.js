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
  AUTH_TIMEOUT_MS: () => AUTH_TIMEOUT_MS,
  HomeWizardWebSocket: () => HomeWizardWebSocket,
  PING_INTERVAL_MS: () => PING_INTERVAL_MS,
  PONG_TIMEOUT_MS: () => PONG_TIMEOUT_MS
});
module.exports = __toCommonJS(websocket_client_exports);
var import_ws = __toESM(require("ws"));
var import_cacert = require("./cacert");
var import_coerce = require("./coerce");
const AUTH_TIMEOUT_MS = 45e3;
const PING_INTERVAL_MS = 3e4;
const PONG_TIMEOUT_MS = 1e4;
class HomeWizardWebSocket {
  ip;
  token;
  callbacks;
  ws = null;
  destroyed = false;
  authTimer = null;
  pingInterval = null;
  pongTimer = null;
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
    this.authTimer = setTimeout(() => {
      this.callbacks.log.debug(`WS auth-timeout (${AUTH_TIMEOUT_MS}ms) \u2014 terminating`);
      this.forceDisconnect();
    }, AUTH_TIMEOUT_MS);
    this.ws.on("open", () => {
      this.callbacks.log.debug(`WS open to ${this.ip}`);
    });
    this.ws.on("message", (raw) => {
      this.handleMessage(raw);
    });
    this.ws.on("pong", () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });
    this.ws.on("close", (code, reason) => {
      this.callbacks.log.debug(`WS closed: ${code} ${reason.toString()}`);
      this.clearTimers();
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
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.callbacks.log.warn(`WS invalid JSON: ${text.substring(0, 200)}`);
      return;
    }
    if (!(0, import_coerce.isPlainObject)(parsed)) {
      this.callbacks.log.warn(`WS non-object message: ${text.substring(0, 200)}`);
      return;
    }
    const type = parsed.type;
    if (typeof type !== "string") {
      this.callbacks.log.warn(`WS message without string type`);
      return;
    }
    switch (type) {
      case "authorization_requested":
        this.callbacks.log.debug("WS auth requested, sending token");
        this.sendRaw({ type: "authorization", data: this.token });
        break;
      case "authorized":
        this.callbacks.log.debug("WS authorized, subscribing to measurement");
        this.sendRaw({ type: "subscribe", data: "measurement" });
        if (this.authTimer) {
          clearTimeout(this.authTimer);
          this.authTimer = null;
        }
        this.startHeartbeat();
        this.callbacks.onConnected();
        break;
      case "measurement":
        if ((0, import_coerce.isPlainObject)(parsed.data)) {
          this.callbacks.onMeasurement(parsed.data);
        } else {
          this.callbacks.log.warn(`WS measurement without object payload`);
        }
        break;
      default:
        this.callbacks.log.debug(`WS message type: ${type}`);
        break;
    }
  }
  /**
   * Send a message over WebSocket
   *
   * @param msg Message envelope
   * @param msg.type Message type identifier
   * @param msg.data Optional payload
   */
  sendRaw(msg) {
    var _a;
    if (((_a = this.ws) == null ? void 0 : _a.readyState) === import_ws.default.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
  /**
   * Start the ping/pong heartbeat. Sends a WS-layer ping every
   * PING_INTERVAL_MS and arms a pong-timer; a missing pong terminates.
   * This catches half-dead links where the TCP stream is buffered but the
   * device has stopped responding (the documented "API-Lockup" mode).
   */
  startHeartbeat() {
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== import_ws.default.OPEN) {
        return;
      }
      this.pongTimer = setTimeout(() => {
        this.callbacks.log.debug(`WS pong-timeout (${PONG_TIMEOUT_MS}ms) \u2014 terminating`);
        this.forceDisconnect();
      }, PONG_TIMEOUT_MS);
      try {
        this.ws.ping();
      } catch (err) {
        this.callbacks.log.debug(`WS ping send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, PING_INTERVAL_MS);
  }
  /** Terminate the socket — triggers close-event → onDisconnected → reconnect. */
  forceDisconnect() {
    if (!this.ws) {
      return;
    }
    try {
      this.ws.terminate();
    } catch {
    }
  }
  /** Clear all timers. Called on close, cleanup, and from the close-event. */
  clearTimers() {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }
  /** Close WebSocket without triggering reconnect */
  cleanup() {
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on("error", () => {
      });
      this.ws.terminate();
      this.ws = null;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AUTH_TIMEOUT_MS,
  HomeWizardWebSocket,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS
});
//# sourceMappingURL=websocket-client.js.map
