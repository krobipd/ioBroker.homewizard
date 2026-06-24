import * as https from "node:https";
import { AddressInfo } from "node:net";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import {
  AUTH_TIMEOUT_MS,
  HomeWizardWebSocket,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  type TimerDeps,
  type WsCallbacks,
} from "./websocket-client";

// Pre-generated self-signed RSA-2048 cert/key for `localhost` (CN+SAN 127.0.0.1), 100-year validity.
// Same fixture as homewizard-client.test.ts. The client agent runs with `rejectUnauthorized: false`,
// so cert pinning is not under test — the purpose is the real TLS + WS handshake pipeline.
const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0NzX0WQlFVj+Y
5QN7kS0zfQlnIhNxQ3ehH8kGNz84cN550G5yoS33zU4Y+tK+VOHktyvSIuJOMxd2
ef3AW++uTmEVhNG5OjdHFaDJG/cK9PHFnA5CHnxl9m3/yRSxlYBhk4u2eJ32kqG4
4mLKteF6W8Km7lDjrWnocSGkao8qYYYWJnHe3fEQNCskQW+uGZdoi/QMI0icnID5
GbywOdIv6SJgBm/RKKT2wvsyWUH/lXGAg4fQTuz+/udbjAPsMHDIExxIndYXGQdk
9bH2WveRGxFRK+z3CS5KRvxbO4Q6i3DgTNoeX20ELfxley/Cr0VQ47l6PnpT3WI9
ZUt8jQlzAgMBAAECggEAAdx2HAVqtpga77R3HOjAFkGK03wDG7mDe/BXmPmrbKT3
GeagqrdmbEznAGlgEXjP8mw/3BuMdHFLozzESvRyx707Jx09iz5XgXju4FTVGtGy
c4TWktvnaKgrClK5z3xd8eQJCS6QDGgG7+Ff/XxJDVny6zAX5BoPjMfU/fKJyE7A
GNJwNx0nvCv8qKrIaYXfx6lCBSDk24mrHzgW1y86iOsKhHQYE9Wj5qcJ7Dre+ijL
jmpEdoItnavwjFpp4beHqV20XeSMzCcW50M3tD0MA7eZpiIDvRteHoGATHwZpj5R
q8WWv7T1ZCIy4/fV/4x0BXo0XPOWuGpOUtvhr52IYQKBgQDXewd5F7ezAZ13Ble6
PArjLLsZbVqiThx5chadISOK68Zzb8/GBHhkG7QEEuzpJC9pVd0j00YpaNEdn0Mz
DSOxj0F89Sg2Fo69DGepQbX10QoT9Mvpi28NLWnDQ6sxTctdHQ4zNU+tOP5zzK1u
smoISBROvlxESx8hvQw1UNkjkwKBgQDWGpJhp42Oj0runxnnQalZcdNeuq3tMBsL
Sgl3taP4KQAJVnutzEp7n4J8mZtr8j3blO/QT3+bnSe3V/D6LN931qe9W8/jMA0T
Dc7p1VRpKOtX2/dq8mbLHOG1qWkQKbh7XSZf0SeKbZovlhIJqiqL7ArL8Yw5b80q
L7T64EnuoQKBgBC+0dzaN/9kP71xM74YTmxLHJskQWfdlB7n+9PoMF/qZLix1r63
uDdnY7zxT5HqqviPoKjZEVnEeIPJzaoY+k4hKOCyGJbjd+I/JYskvSRGQ3c7jeEv
YcjvX4m6J4KkXgp1aJYYLYHzrOqI3G1+1figyVs5Nehkwh2YGGvIRaebAoGBAJUe
SqejOC97U7ggrbzoeZendIz8vhh9schKF4/9vacgfzsBtgBVUecKMKqxnZMwU670
65YNWJY8faXvpRHJYRcpNQjowkC8fc6whlVMVI8thcRamtcs3zVF91o8FMXCGRAq
z4hatwxty76q6gM7NojfrKFgqcZzPNTOB2HYBwYhAoGAdBsYcdf3mZuudUSLJO/M
junEaVzpmy27RSp5Q1RH0EEdnWXjTTyN77MdfXEcHdR71WnB+TvlMqw0ALqvtMan
0a3LfSTuIFrV2bk2H9O0+zvq4zXvcAep+WAN5Uatqh0ZxdhfPCOaKp0KUBAzpX8x
7T6ukX6Zi9r0SZUJvMlVt7o=
-----END PRIVATE KEY-----
`;

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUW+ip2M+6bB8FbLfJD4d4DlEliWYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDUwNjIyMDkxMFoYDzIxMjYw
NDEyMjIwOTEwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC0NzX0WQlFVj+Y5QN7kS0zfQlnIhNxQ3ehH8kGNz84
cN550G5yoS33zU4Y+tK+VOHktyvSIuJOMxd2ef3AW++uTmEVhNG5OjdHFaDJG/cK
9PHFnA5CHnxl9m3/yRSxlYBhk4u2eJ32kqG44mLKteF6W8Km7lDjrWnocSGkao8q
YYYWJnHe3fEQNCskQW+uGZdoi/QMI0icnID5GbywOdIv6SJgBm/RKKT2wvsyWUH/
lXGAg4fQTuz+/udbjAPsMHDIExxIndYXGQdk9bH2WveRGxFRK+z3CS5KRvxbO4Q6
i3DgTNoeX20ELfxley/Cr0VQ47l6PnpT3WI9ZUt8jQlzAgMBAAGjbzBtMB0GA1Ud
DgQWBBQUdhJjntmiQeqLorSl4XdbeoiMoTAfBgNVHSMEGDAWgBQUdhJjntmiQeqL
orSl4XdbeoiMoTAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEARZAYtfMWHvW7S/CiyhAyLz+qvDzb
b78O6oIxnRQp8yzlGwxNF61zZora26tGcriwyOs5ewxQkIxkJNU2uw89J3E8FUzO
yF9JYcS2eaXFypAyGhcPkoSBViHR2P7OabeM2yqW31is/tVRolPxE9idzfyp2quJ
hN/PWkbk1dqk0Gu8LffEO9mUR5tsmerEr0tIZzePfnC09HAo4tvosGr4PLB2d2kZ
diNwXp48ZTGxYk1XdiQP1YbLBk+D3OrVjvAsyzUT8vFex/r6MmcuaDlJyloVxR/M
dGlxE9spFWzvVJpQghYsgldpPTDSQD+7b0cirusNND+qnXUCr0kE+6uOow==
-----END CERTIFICATE-----
`;

const TEST_AGENT = new https.Agent({ rejectUnauthorized: false });

function createNativeTimerDeps(): TimerDeps {
  return {
    schedule: (cb, ms) => setTimeout(cb, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    scheduleRepeating: (cb, ms) => setInterval(cb, ms),
    cancelRepeating: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
}

interface LogEntry {
  level: string;
  msg: string;
}

interface CallbackTracker {
  measurements: unknown[];
  systems: unknown[];
  batteries: unknown[];
  connected: number;
  disconnected: number;
  disconnectErrors: (Error | undefined)[];
  logs: LogEntry[];
}

function createCallbackTracker(): { callbacks: WsCallbacks; tracker: CallbackTracker } {
  const tracker: CallbackTracker = {
    measurements: [],
    systems: [],
    batteries: [],
    connected: 0,
    disconnected: 0,
    disconnectErrors: [],
    logs: [],
  };

  const callbacks: WsCallbacks = {
    onMeasurement: data => {
      tracker.measurements.push(data);
    },
    onSystem: data => {
      tracker.systems.push(data);
    },
    onBattery: data => {
      tracker.batteries.push(data);
    },
    onConnected: () => {
      tracker.connected++;
    },
    onDisconnected: error => {
      tracker.disconnected++;
      tracker.disconnectErrors.push(error);
    },
    log: {
      debug: (msg: string) => {
        tracker.logs.push({ level: "debug", msg });
      },
      warn: (msg: string) => {
        tracker.logs.push({ level: "warn", msg });
      },
    },
  };

  return { callbacks, tracker };
}

describe("HomeWizardWebSocket", () => {
  describe("constructor", () => {
    it("should create an instance", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks, createNativeTimerDeps());
      expect(ws).toBeInstanceOf(HomeWizardWebSocket);
      ws.close();
    });

    it("does not open a socket until connect() is called", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks, createNativeTimerDeps());
      expect((ws as unknown as { ws: unknown }).ws).toBeNull();
      ws.close();
    });
  });

  describe("close", () => {
    it("should not throw when called before connect", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks, createNativeTimerDeps());
      expect(() => ws.close()).not.toThrow();
    });

    it("should not throw when called multiple times", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks, createNativeTimerDeps());
      ws.close();
      expect(() => ws.close()).not.toThrow();
    });

    it("should prevent reconnect after close", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks, createNativeTimerDeps());
      ws.close();
      // connect after close must be a no-op (destroyed flag) — no socket created
      ws.connect();
      expect((ws as unknown as { ws: unknown }).ws).toBeNull();
    });
  });

  describe("handleMessage (via internal access)", () => {
    function callHandleMessage(
      ws: HomeWizardWebSocket,
      msg: unknown,
      opts: { authorized?: boolean } = {},
    ): void {
      // Data frames (measurement/system/batteries) are only processed after the
      // handshake completes; preset the flag so these unit tests exercise the
      // post-auth path (pass { authorized: false } to test pre-auth dropping).
      (ws as unknown as { authorized: boolean }).authorized = opts.authorized ?? true;
      const raw = Buffer.from(JSON.stringify(msg));
      (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);
    }

    it("should handle authorization_requested by sending token", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, {
        type: "authorization_requested",
        data: { api_version: "2.0.0" },
      });

      const debugLogs = tracker.logs.filter(l => l.level === "debug");
      expect(debugLogs.some(l => l.msg.includes("auth requested"))).toBe(true);
      ws.close();
    });

    it("should handle authorized by calling onConnected", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "authorized" });

      expect(tracker.connected).toBe(1);
      ws.close();
    });

    it("should handle measurement by calling onMeasurement", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      const measurementData = {
        power_w: 1234,
        energy_import_kwh: 5678.9,
      };
      callHandleMessage(ws, { type: "measurement", data: measurementData });

      expect(tracker.measurements).toHaveLength(1);
      expect(tracker.measurements[0]).toEqual(measurementData);
      ws.close();
    });

    it("should ignore measurement without data", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "measurement" });

      expect(tracker.measurements).toHaveLength(0);
      ws.close();
    });

    it("should warn on non-object root message (array)", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, ["measurement"]);

      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("non-object"))).toBe(true);
      ws.close();
    });

    it("should warn on root message as string", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      const raw = Buffer.from(JSON.stringify("just a string"));
      (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);

      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("non-object"))).toBe(true);
      ws.close();
    });

    it("should warn on message without string type", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: 42, data: {} });

      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("string type"))).toBe(true);
      ws.close();
    });

    it("should warn on measurement with non-object data (string)", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "measurement", data: "corrupt" });

      expect(tracker.measurements).toHaveLength(0);
      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("object payload"))).toBe(true);
      ws.close();
    });

    it("should warn on measurement with array data", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "measurement", data: [1, 2, 3] });

      expect(tracker.measurements).toHaveLength(0);
      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("object payload"))).toBe(true);
      ws.close();
    });

    it("should warn on measurement with null data", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "measurement", data: null });

      expect(tracker.measurements).toHaveLength(0);
      ws.close();
    });

    it("should handle unknown message types gracefully", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "unknown_type", data: {} });

      const debugLogs = tracker.logs.filter(l => l.level === "debug");
      expect(debugLogs.some(l => l.msg.includes("unknown_type"))).toBe(true);
      ws.close();
    });

    it("should warn on invalid JSON", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      const raw = Buffer.from("not json at all");
      (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);

      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("invalid JSON"))).toBe(true);
      ws.close();
    });

    it("should handle multiple measurements in sequence", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "measurement", data: { power_w: 100 } });
      callHandleMessage(ws, { type: "measurement", data: { power_w: 200 } });
      callHandleMessage(ws, { type: "measurement", data: { power_w: 300 } });

      expect(tracker.measurements).toHaveLength(3);
      expect((tracker.measurements[2] as { power_w: number }).power_w).toBe(300);
      ws.close();
    });

    it("should forward a system push to onSystem (A3)", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "system", data: { cloud_enabled: true, wifi_rssi_db: -55 } });

      expect(tracker.systems).toHaveLength(1);
      expect((tracker.systems[0] as { cloud_enabled: boolean }).cloud_enabled).toBe(true);
      ws.close();
    });

    it("should ignore a system push with non-object data", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "system", data: "corrupt" });

      expect(tracker.systems).toHaveLength(0);
      ws.close();
    });

    it("should forward a batteries push to onBattery (A3)", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "batteries", data: { mode: "zero", power_w: 120 } });

      expect(tracker.batteries).toHaveLength(1);
      expect((tracker.batteries[0] as { mode: string }).mode).toBe("zero");
      ws.close();
    });

    it("should warn with the device message on an error frame (A6)", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "error", data: { message: "subscription rejected" } });

      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("WS error: subscription rejected"))).toBe(true);
      ws.close();
    });

    it("should warn on an error frame without a message field", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "error", data: { code: 7 } });

      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.startsWith("WS error:"))).toBe(true);
      ws.close();
    });

    it("ignores data frames received before the handshake completes (S3-5)", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      callHandleMessage(ws, { type: "measurement", data: { power_w: 99 } }, { authorized: false });

      expect(tracker.measurements).toHaveLength(0);
      ws.close();
    });

    it("stages a typed auth error on an error frame before authorization (D4-1/D2-1)", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      // An error frame during the handshake (before "authorized") stages a typed
      // auth error so onWsDisconnected can apply the auth-stop. (forceDisconnect is
      // a no-op here without a live socket; assert the staged error directly.)
      callHandleMessage(ws, { type: "error", data: { message: "unauthorized" } }, { authorized: false });

      const authError = (ws as unknown as { authError: Error | null }).authError;
      expect(authError).toBeInstanceOf(Error);
      expect((authError as unknown as { errorCode: string }).errorCode).toBe("user:unauthorized");
      ws.close();
    });

    it("fires the auth-timeout watchdog and terminates the socket (D4-2)", () => {
      const { callbacks } = createCallbackTracker();
      let authCb: (() => void) | undefined;
      const captureTimers = {
        schedule: (cb: () => void, ms: number) => {
          if (ms >= 40_000) {
            authCb = cb; // the auth watchdog (AUTH_TIMEOUT_MS)
          }
          return Symbol("t");
        },
        cancel: () => {},
        scheduleRepeating: () => Symbol("i"),
        cancelRepeating: () => {},
      };
      const ws = new HomeWizardWebSocket("192.168.1.1", "tok", callbacks, captureTimers);
      ws.connect();
      // Swap in a fake socket so the watchdog's forceDisconnect → terminate is observable.
      const fakeWs = { terminate: vi.fn(), removeAllListeners: vi.fn(), on: vi.fn(), readyState: 1 };
      (ws as unknown as { ws: unknown }).ws = fakeWs;

      expect(authCb).toBeDefined();
      authCb!(); // fire the auth-timeout watchdog

      expect(fakeWs.terminate).toHaveBeenCalled();
      ws.close();
    });
  });

  describe("full auth flow simulation", () => {
    function callHandleMessage(ws: HomeWizardWebSocket, msg: unknown): void {
      const raw = Buffer.from(JSON.stringify(msg));
      (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);
    }

    it("should complete auth flow: auth_requested → authorized → measurement", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks, createNativeTimerDeps());

      // Step 1: Device requests auth
      callHandleMessage(ws, {
        type: "authorization_requested",
        data: { api_version: "2.0.0" },
      });
      expect(tracker.connected).toBe(0); // Not yet connected

      // Step 2: Device confirms auth
      callHandleMessage(ws, { type: "authorized" });
      expect(tracker.connected).toBe(1); // Now connected

      // Step 3: Measurement data flows
      callHandleMessage(ws, {
        type: "measurement",
        data: { power_w: 456, voltage_l1_v: 230.1 },
      });
      expect(tracker.measurements).toHaveLength(1);
      expect((tracker.measurements[0] as { power_w: number }).power_w).toBe(456);

      ws.close();
    });
  });

  describe("heartbeat constants (Doku-aligned)", () => {
    it("AUTH_TIMEOUT_MS exceeds documented 40 s window", () => {
      // Doku: "Timeout: 40 Sekunden für Auth" — we add a 5 s margin so
      // a slow but valid handshake doesn't false-positive into terminate.
      expect(AUTH_TIMEOUT_MS).toBeGreaterThanOrEqual(40_000);
    });

    it("PING_INTERVAL_MS shorter than P1 5-min gas-update gap", () => {
      // Push is event-driven (Power 1/s, Gas ~5 min, Battery undocumented).
      // Frame-stille is NOT a liveness signal, that's what ping/pong is for.
      // The ping cadence must fit comfortably within the longest expected
      // user-tolerated outage (sub-minute).
      expect(PING_INTERVAL_MS).toBeLessThanOrEqual(60_000);
      expect(PING_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    });

    it("PONG_TIMEOUT_MS leaves room for slow LAN round-trip", () => {
      // 10 s is ample for any reasonable LAN; below 5 s would risk false-
      // positives on briefly congested WiFi.
      expect(PONG_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
      expect(PONG_TIMEOUT_MS).toBeLessThanOrEqual(PING_INTERVAL_MS / 2);
    });
  });

  describe("heartbeat lifecycle (internal-state inspection)", () => {
    type Internal = {
      authTimer: unknown;
      pingInterval: unknown;
      pongTimer: unknown;
      startHeartbeat: () => void;
      clearTimers: () => void;
    };

    it("close() leaves no leaked timers", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "tok", callbacks, createNativeTimerDeps());
      const internal = ws as unknown as Internal;

      // Force timers into all three slots, then close: we must end up
      // with all of them cleared so the process can exit cleanly even
      // after an aborted connect cycle.
      internal.authTimer = setTimeout(() => {}, 100_000);
      internal.pingInterval = setInterval(() => {}, 100_000);
      internal.pongTimer = setTimeout(() => {}, 100_000);

      ws.close();
      expect(internal.authTimer).toBeNull();
      expect(internal.pingInterval).toBeNull();
      expect(internal.pongTimer).toBeNull();
    });

    it("clearTimers is idempotent", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "tok", callbacks, createNativeTimerDeps());
      const internal = ws as unknown as Internal;

      internal.clearTimers();
      internal.clearTimers();
      expect(internal.authTimer).toBeNull();
      expect(internal.pingInterval).toBeNull();
      expect(internal.pongTimer).toBeNull();
      ws.close();
    });

    it("startHeartbeat installs a recurring ping interval", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "tok", callbacks, createNativeTimerDeps());
      const internal = ws as unknown as Internal;

      internal.startHeartbeat();
      expect(internal.pingInterval).not.toBeNull();

      ws.close();
      expect(internal.pingInterval).toBeNull();
    });
  });
});

/** Live state recorded by the wss stub-server. */
interface WssStubState {
  token: string | null;
  subs: string[];
}

interface WssStub {
  port: number;
  state: WssStubState;
  /** Push a frame to the connected client. */
  send: (frame: unknown) => void;
  /** Close the server side of the client connection. */
  closeClientSocket: () => void;
  stop: () => Promise<void>;
}

/**
 * Start a local wss stub-server that speaks the HomeWizard auth handshake:
 * on connect it sends `authorization_requested`, replies `authorized` to the
 * client's token, and records every `subscribe` topic. Tests drive the real
 * connect() pipeline (TLS + ws + handleMessage) against it.
 */
async function startWssStub(): Promise<WssStub> {
  const state: WssStubState = { token: null, subs: [] };
  let socket: WsClient | null = null;

  const httpsServer = https.createServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM });
  const wss = new WebSocketServer({ server: httpsServer });

  wss.on("connection", s => {
    socket = s;
    s.send(JSON.stringify({ type: "authorization_requested", data: { api_version: "2.0.0" } }));
    s.on("message", raw => {
      let msg: { type?: string; data?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "authorization") {
        state.token = typeof msg.data === "string" ? msg.data : null;
        s.send(JSON.stringify({ type: "authorized" }));
      } else if (msg.type === "subscribe" && typeof msg.data === "string") {
        state.subs.push(msg.data);
      }
    });
  });

  await new Promise<void>(resolve => httpsServer.listen(0, "127.0.0.1", resolve));
  const port = (httpsServer.address() as AddressInfo).port;

  return {
    port,
    state,
    send: frame => socket?.send(JSON.stringify(frame)),
    closeClientSocket: () => socket?.close(),
    stop: () => new Promise<void>(resolve => wss.close(() => httpsServer.close(() => resolve()))),
  };
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function trackerWithSignals(): {
  callbacks: WsCallbacks;
  tracker: CallbackTracker;
  connected: Promise<void>;
  disconnected: Promise<void>;
} {
  const { callbacks, tracker } = createCallbackTracker();
  let resolveConnected!: () => void;
  let resolveDisconnected!: () => void;
  const connected = new Promise<void>(r => (resolveConnected = r));
  const disconnected = new Promise<void>(r => (resolveDisconnected = r));
  const baseConnected = callbacks.onConnected;
  const baseDisconnected = callbacks.onDisconnected;
  callbacks.onConnected = () => {
    baseConnected();
    resolveConnected();
  };
  callbacks.onDisconnected = e => {
    baseDisconnected(e);
    resolveDisconnected();
  };
  return { callbacks, tracker, connected, disconnected };
}

describe("HomeWizardWebSocket against a real wss stub-server (T4)", () => {
  let stub: WssStub;
  let ws: HomeWizardWebSocket | null = null;

  beforeEach(async () => {
    stub = await startWssStub();
  });

  afterEach(async () => {
    ws?.close();
    ws = null;
    await stub.stop();
  });

  it("performs the real TLS + auth handshake and subscribes to measurement, system and batteries", async () => {
    const { callbacks, connected } = trackerWithSignals();
    ws = new HomeWizardWebSocket("127.0.0.1", "mytoken", callbacks, createNativeTimerDeps(), {
      agent: TEST_AGENT,
      port: stub.port,
    });
    ws.connect();

    await connected;
    expect(stub.state.token).toBe("mytoken");
    await waitUntil(() => stub.state.subs.length === 3);
    expect([...stub.state.subs].sort()).toEqual(["batteries", "measurement", "system"]);
  });

  it("delivers pushed measurement / system / battery frames to the callbacks", async () => {
    const { callbacks, tracker, connected } = trackerWithSignals();
    ws = new HomeWizardWebSocket("127.0.0.1", "mytoken", callbacks, createNativeTimerDeps(), {
      agent: TEST_AGENT,
      port: stub.port,
    });
    ws.connect();
    await connected;

    stub.send({ type: "measurement", data: { power_w: 42 } });
    stub.send({ type: "system", data: { cloud_enabled: true } });
    stub.send({ type: "batteries", data: { mode: "zero" } });

    await waitUntil(() => tracker.measurements.length > 0 && tracker.systems.length > 0 && tracker.batteries.length > 0);
    expect((tracker.measurements[0] as { power_w: number }).power_w).toBe(42);
    expect((tracker.systems[0] as { cloud_enabled: boolean }).cloud_enabled).toBe(true);
    expect((tracker.batteries[0] as { mode: string }).mode).toBe("zero");
  });

  it("reports onDisconnected when the server closes the socket", async () => {
    const { callbacks, tracker, connected, disconnected } = trackerWithSignals();
    ws = new HomeWizardWebSocket("127.0.0.1", "mytoken", callbacks, createNativeTimerDeps(), {
      agent: TEST_AGENT,
      port: stub.port,
    });
    ws.connect();
    await connected;

    stub.closeClientSocket();
    await disconnected;
    expect(tracker.disconnected).toBeGreaterThanOrEqual(1);
  });
});
