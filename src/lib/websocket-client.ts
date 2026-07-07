import type * as https from "node:https";
import WebSocket from "ws";
import { HW_AGENT } from "./cacert";
import { isPlainObject, sanitizeForLog } from "./coerce";
import { HomeWizardApiError } from "./homewizard-client";
import type { BatteryControl, Measurement, SystemInfo } from "./types";

/** Auth handshake must complete within this window (Doku says 40s, +5s slack). */
export const AUTH_TIMEOUT_MS = 45_000;
/** WS-layer ping interval after `authorized`. */
export const PING_INTERVAL_MS = 30_000;
/** Max time to wait for a pong reply before declaring the link dead. */
export const PONG_TIMEOUT_MS = 10_000;

/** Timer dependency injection — allows adapter-managed timers instead of native ones. */
export interface TimerDeps {
  /** Schedule a one-shot callback */
  schedule(cb: () => void, ms: number): unknown;
  /** Cancel a one-shot timer */
  cancel(handle: unknown): void;
  /** Schedule a recurring callback */
  scheduleRepeating(cb: () => void, ms: number): unknown;
  /** Cancel a recurring timer */
  cancelRepeating(handle: unknown): void;
}

/** Callback interface for WebSocket events */
export interface WsCallbacks {
  /** Called when measurement data is received */
  onMeasurement: (data: Measurement) => void;
  /** Called when a real-time system push is received (cloud/led changes etc.). Optional. */
  onSystem?: (data: SystemInfo) => void;
  /** Called when a real-time battery-group push is received (mode/permissions/target power). Optional. */
  onBattery?: (data: BatteryControl) => void;
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
 * Handles auth handshake, subscription, heartbeat (WS-layer ping/pong),
 * and termination of half-dead connections (TCP open, no traffic).
 *
 * The push is event-driven (P1 Power ~1/s, Gas ~5min, Battery undocumented),
 * so we cannot rely on measurement frames as a liveness signal. Instead we
 * use the WS-layer ping/pong frames, which the device must answer regardless
 * of data activity.
 */
export class HomeWizardWebSocket {
  private readonly ip: string;
  private readonly token: string;
  private readonly callbacks: WsCallbacks;
  private readonly timers: TimerDeps;
  private readonly agent: https.Agent;
  /** Override target port — only used by tests against a local wss stub-server. */
  private readonly port: number;
  private ws: WebSocket | null = null;
  private destroyed = false;
  private authTimer: unknown = null;
  private pingInterval: unknown = null;
  private pongTimer: unknown = null;
  /** True once the device sent "authorized" — gates auth-error classification. */
  private authorized = false;
  /** Set when the device rejected the handshake (bad token) — passed to onDisconnected. */
  private authError: Error | null = null;
  /** L8: last error-frame detail logged — dedups consecutive identical error frames. */
  private lastErrorDetail: string | null = null;

  /**
   * @param ip Device IP address
   * @param token Bearer token
   * @param callbacks Event callbacks
   * @param timers Timer functions (use adapter-managed timers in production)
   * @param options Optional overrides — primarily for unit tests against a local wss stub.
   * @param options.agent HTTPS agent to use; defaults to {@link HW_AGENT} (with HomeWizard CA pinning).
   * @param options.port  Target port; defaults to 443.
   */
  constructor(
    ip: string,
    token: string,
    callbacks: WsCallbacks,
    timers: TimerDeps,
    options: { agent?: https.Agent; port?: number } = {},
  ) {
    this.ip = ip;
    this.token = token;
    this.callbacks = callbacks;
    this.timers = timers;
    this.agent = options.agent ?? HW_AGENT;
    this.port = options.port ?? 443;
  }

  /** Connect to WebSocket and start auth handshake */
  connect(): void {
    if (this.destroyed) {
      return;
    }

    this.cleanup();
    this.authorized = false;
    this.authError = null;

    const portSeg = this.port !== 443 ? `:${this.port}` : "";
    const url = `wss://${this.ip}${portSeg}/api/ws`;
    this.callbacks.log.debug(`WS connecting to ${url}`);

    this.ws = new WebSocket(url, {
      agent: this.agent,
      handshakeTimeout: 10_000,
      // v2 frames are a few KB; cap well below the ws 100 MiB default so a
      // hostile/buggy device cannot push an oversized frame at us.
      maxPayload: 1_048_576,
    });

    // Auth-watchdog: server must finish the auth handshake within
    // AUTH_TIMEOUT_MS or we declare the link dead. Doku timeout is 40s.
    this.authTimer = this.timers.schedule(() => {
      this.callbacks.log.debug(`WS auth-timeout (${AUTH_TIMEOUT_MS}ms) — terminating`);
      this.forceDisconnect();
    }, AUTH_TIMEOUT_MS);

    this.ws.on("open", () => {
      this.callbacks.log.debug(`WS open to ${this.ip}`);
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      // I14: defense-in-depth — a throw from a handler must not escape the ws
      // "message" emit (there is no process-level uncaught-handler backstop).
      try {
        this.handleMessage(raw);
      } catch (err) {
        this.callbacks.log.warn(`WS message handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.ws.on("pong", () => {
      // Pong arrived in time — clear pending pong-timer.
      if (this.pongTimer != null) {
        this.timers.cancel(this.pongTimer);
        this.pongTimer = null;
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this.callbacks.log.debug(`WS closed: ${code} ${sanitizeForLog(reason.toString())}`);
      this.clearTimers();
      this.ws = null;
      if (!this.destroyed) {
        // Pass a typed auth error if the device rejected us during the handshake,
        // so the reconnect loop can apply the auth-stop; else undefined = normal drop.
        this.callbacks.onDisconnected(this.authError ?? undefined);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.callbacks.log.warn(`WS invalid JSON: ${sanitizeForLog(text)}`);
      return;
    }

    if (!isPlainObject(parsed)) {
      this.callbacks.log.warn(`WS non-object message: ${sanitizeForLog(text)}`);
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
        // L3: ignore a duplicate "authorized" frame — a second one would start a
        // second heartbeat interval (leaking the first) and fire onConnected twice.
        if (this.authorized) {
          break;
        }
        this.authorized = true;
        // Subscribe to the three real-time topics this adapter consumes (explicit, not "*",
        // to avoid device/user-topic noise). system/batteries push control-state changes;
        // measurement is the ~1/s data feed.
        this.callbacks.log.debug("WS authorized, subscribing to measurement + system + batteries");
        this.sendRaw({ type: "subscribe", data: "measurement" });
        this.sendRaw({ type: "subscribe", data: "system" });
        this.sendRaw({ type: "subscribe", data: "batteries" });
        // Auth complete — clear auth-watchdog and start the heartbeat.
        if (this.authTimer != null) {
          this.timers.cancel(this.authTimer);
          this.authTimer = null;
        }
        this.startHeartbeat();
        this.callbacks.onConnected();
        break;

      case "measurement":
        // Ignore data frames received before the handshake completes — a server
        // that pushes data pre-"authorized" is misbehaving; don't trust it.
        if (!this.authorized) {
          break;
        }
        if (isPlainObject(parsed.data)) {
          this.callbacks.onMeasurement(parsed.data);
        } else {
          this.callbacks.log.warn(`WS measurement without object payload`);
        }
        break;

      case "system":
        if (!this.authorized) {
          break;
        }
        // isPlainObject-guarded WS payload; updateSystem re-validates every field, so the
        // boundary cast is safe (the typed shape is aspirational, not trusted).
        if (isPlainObject(parsed.data)) {
          this.callbacks.onSystem?.(parsed.data as unknown as SystemInfo);
        }
        break;

      case "batteries":
        if (!this.authorized) {
          break;
        }
        if (isPlainObject(parsed.data)) {
          this.callbacks.onBattery?.(parsed.data as unknown as BatteryControl);
        }
        break;

      case "error": {
        const detail = sanitizeForLog(
          isPlainObject(parsed.data) && typeof parsed.data.message === "string" ? parsed.data.message : text,
        );
        // L8: dedup consecutive identical error frames so a device that repeats the
        // same post-auth error can't flood the log. Pre-auth errors additionally
        // force a disconnect below, so they can't repeat within one session.
        if (detail !== this.lastErrorDetail) {
          this.callbacks.log.warn(`WS error: ${detail}`);
          this.lastErrorDetail = detail;
        }
        // An error frame during the auth handshake (before "authorized") means the
        // device rejected us — almost always a bad/revoked token. Surface it as a
        // typed auth error so the reconnect loop applies the auth-stop instead of
        // retrying forever. (A normal network drop closes without an error frame.)
        if (!this.authorized) {
          this.authError = new HomeWizardApiError(401, '{"error":{"code":"user:unauthorized"}}', "ws auth");
          this.forceDisconnect();
        }
        break;
      }

      default:
        this.callbacks.log.debug(`WS message type: ${sanitizeForLog(type)}`);
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
  private sendRaw(msg: { type: string; data?: unknown }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Start the ping/pong heartbeat. Sends a WS-layer ping every
   * PING_INTERVAL_MS and arms a pong-timer; a missing pong terminates.
   * This catches half-dead links where the TCP stream is buffered but the
   * device has stopped responding (the documented "API-Lockup" mode).
   */
  private startHeartbeat(): void {
    // L3: defensive — never leak a previous interval if this is ever re-entered.
    if (this.pingInterval != null) {
      this.timers.cancelRepeating(this.pingInterval);
    }
    this.pingInterval = this.timers.scheduleRepeating(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      // Arm the pong-timer first, then ping. If pong arrives, the pong
      // handler clears it; if it doesn't, we terminate. Clear any stale
      // pong-timer first (defensive — should already be null by here).
      if (this.pongTimer != null) {
        this.timers.cancel(this.pongTimer);
      }
      this.pongTimer = this.timers.schedule(() => {
        this.callbacks.log.debug(`WS pong-timeout (${PONG_TIMEOUT_MS}ms) — terminating`);
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
  private forceDisconnect(): void {
    if (!this.ws) {
      return;
    }
    try {
      this.ws.terminate();
    } catch {
      // ignore — already closed
    }
  }

  /** Clear all timers. Called on close, cleanup, and from the close-event. */
  private clearTimers(): void {
    if (this.authTimer != null) {
      this.timers.cancel(this.authTimer);
      this.authTimer = null;
    }
    if (this.pingInterval != null) {
      this.timers.cancelRepeating(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimer != null) {
      this.timers.cancel(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /** Close WebSocket without triggering reconnect */
  private cleanup(): void {
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      // Prevent uncaught errors from frames received during close
      this.ws.on("error", () => {});
      this.ws.terminate();
      this.ws = null;
    }
  }
}
