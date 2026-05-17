import {
  AUTH_TIMEOUT_MS,
  HomeWizardWebSocket,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  type WsCallbacks,
} from "./websocket-client";

interface LogEntry {
  level: string;
  msg: string;
}

interface CallbackTracker {
  measurements: unknown[];
  connected: number;
  disconnected: number;
  disconnectErrors: (Error | undefined)[];
  logs: LogEntry[];
}

function createCallbackTracker(): { callbacks: WsCallbacks; tracker: CallbackTracker } {
  const tracker: CallbackTracker = {
    measurements: [],
    connected: 0,
    disconnected: 0,
    disconnectErrors: [],
    logs: [],
  };

  const callbacks: WsCallbacks = {
    onMeasurement: data => {
      tracker.measurements.push(data);
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
      const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks);
      expect(ws).toBeInstanceOf(HomeWizardWebSocket);
      ws.close();
    });

    it("should not be connected initially", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks);
      expect(ws.isConnected).toBe(false);
      ws.close();
    });
  });

  describe("close", () => {
    it("should not throw when called before connect", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks);
      expect(() => ws.close()).not.toThrow();
    });

    it("should not throw when called multiple times", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks);
      ws.close();
      expect(() => ws.close()).not.toThrow();
    });

    it("should prevent reconnect after close", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks);
      ws.close();
      // connect after close should be a no-op (destroyed flag)
      ws.connect();
      expect(ws.isConnected).toBe(false);
    });
  });

  describe("handleMessage (via internal access)", () => {
    function callHandleMessage(ws: HomeWizardWebSocket, msg: unknown): void {
      const raw = Buffer.from(JSON.stringify(msg));
      (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);
    }

    it("should handle authorization_requested by sending token", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

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
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      callHandleMessage(ws, { type: "authorized" });

      expect(tracker.connected).toBe(1);
      ws.close();
    });

    it("should handle measurement by calling onMeasurement", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

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
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      callHandleMessage(ws, { type: "measurement" });

      expect(tracker.measurements).toHaveLength(0);
      ws.close();
    });

    it("should warn on non-object root message (array)", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      callHandleMessage(ws, ["measurement"]);

      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("non-object"))).toBe(true);
      ws.close();
    });

    it("should warn on root message as string", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      const raw = Buffer.from(JSON.stringify("just a string"));
      (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);

      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("non-object"))).toBe(true);
      ws.close();
    });

    it("should warn on message without string type", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      callHandleMessage(ws, { type: 42, data: {} });

      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("string type"))).toBe(true);
      ws.close();
    });

    it("should warn on measurement with non-object data (string)", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      callHandleMessage(ws, { type: "measurement", data: "corrupt" });

      expect(tracker.measurements).toHaveLength(0);
      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("object payload"))).toBe(true);
      ws.close();
    });

    it("should warn on measurement with array data", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      callHandleMessage(ws, { type: "measurement", data: [1, 2, 3] });

      expect(tracker.measurements).toHaveLength(0);
      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("object payload"))).toBe(true);
      ws.close();
    });

    it("should warn on measurement with null data", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      callHandleMessage(ws, { type: "measurement", data: null });

      expect(tracker.measurements).toHaveLength(0);
      ws.close();
    });

    it("should handle unknown message types gracefully", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      callHandleMessage(ws, { type: "unknown_type", data: {} });

      const debugLogs = tracker.logs.filter(l => l.level === "debug");
      expect(debugLogs.some(l => l.msg.includes("unknown_type"))).toBe(true);
      ws.close();
    });

    it("should warn on invalid JSON", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      const raw = Buffer.from("not json at all");
      (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);

      const warnLogs = tracker.logs.filter(l => l.level === "warn");
      expect(warnLogs.some(l => l.msg.includes("invalid JSON"))).toBe(true);
      ws.close();
    });

    it("should handle multiple measurements in sequence", () => {
      const { callbacks, tracker } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

      callHandleMessage(ws, { type: "measurement", data: { power_w: 100 } });
      callHandleMessage(ws, { type: "measurement", data: { power_w: 200 } });
      callHandleMessage(ws, { type: "measurement", data: { power_w: 300 } });

      expect(tracker.measurements).toHaveLength(3);
      expect((tracker.measurements[2] as { power_w: number }).power_w).toBe(300);
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
      const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

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
      authTimer: NodeJS.Timeout | null;
      pingInterval: NodeJS.Timeout | null;
      pongTimer: NodeJS.Timeout | null;
      startHeartbeat: () => void;
      clearTimers: () => void;
    };

    it("close() leaves no leaked timers", () => {
      const { callbacks } = createCallbackTracker();
      const ws = new HomeWizardWebSocket("192.168.1.1", "tok", callbacks);
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
      const ws = new HomeWizardWebSocket("192.168.1.1", "tok", callbacks);
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
      const ws = new HomeWizardWebSocket("192.168.1.1", "tok", callbacks);
      const internal = ws as unknown as Internal;

      internal.startHeartbeat();
      expect(internal.pingInterval).not.toBeNull();

      ws.close();
      expect(internal.pingInterval).toBeNull();
    });
  });
});
