import WebSocket from "ws";
import { HW_AGENT } from "./cacert";
import type { Measurement, WsMessage } from "./types";

/** Callback interface for WebSocket events */
export interface WsCallbacks {
  /** Called when measurement data is received */
  onMeasurement: (data: Measurement) => void;
  /** Called when connection is established and authenticated */
  onConnected: () => void;
  /** Called when connection is lost */
  onDisconnected: (error?: Error) => void;
  /** Log functions */
  log: {
    debug: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

/**
 * WebSocket client for HomeWizard real-time measurement push.
 * Handles auth handshake, subscription, and auto-reconnect.
 */
export class HomeWizardWebSocket {
  private readonly ip: string;
  private readonly token: string;
  private readonly callbacks: WsCallbacks;
  private ws: WebSocket | null = null;
  private destroyed = false;

  /**
   * @param ip Device IP address
   * @param token Bearer token
   * @param callbacks Event callbacks
   */
  constructor(ip: string, token: string, callbacks: WsCallbacks) {
    this.ip = ip;
    this.token = token;
    this.callbacks = callbacks;
  }

  /** Connect to WebSocket and start auth handshake */
  connect(): void {
    if (this.destroyed) {
      return;
    }

    this.cleanup();

    const url = `wss://${this.ip}/api/ws`;
    this.callbacks.log.debug(`WS connecting to ${url}`);

    this.ws = new WebSocket(url, {
      agent: HW_AGENT,
      handshakeTimeout: 10_000,
    });

    this.ws.on("open", () => {
      this.callbacks.log.debug(`WS open to ${this.ip}`);
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      this.handleMessage(raw);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this.callbacks.log.debug(`WS closed: ${code} ${reason.toString()}`);
      this.ws = null;
      if (!this.destroyed) {
        this.callbacks.onDisconnected();
      }
    });

    this.ws.on("error", (err: Error) => {
      this.callbacks.log.debug(`WS error: ${err.message}`);
      // close event will follow
    });
  }

  /** Gracefully close connection */
  close(): void {
    this.destroyed = true;
    this.cleanup();
  }

  /** Whether the WebSocket is currently open */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Handle incoming WebSocket message
   *
   * @param raw Raw message data
   */
  private handleMessage(raw: WebSocket.RawData): void {
    const text = Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString("utf8")
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : "";
    let msg: WsMessage;
    try {
      msg = JSON.parse(text) as WsMessage;
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
          this.callbacks.onMeasurement(msg.data as Measurement);
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
  private send(msg: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Close WebSocket without triggering reconnect */
  private cleanup(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      // Prevent uncaught errors from frames received during close
      this.ws.on("error", () => {});
      this.ws.terminate();
      this.ws = null;
    }
  }
}
