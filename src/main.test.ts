import { vi } from "vitest";

// Stub the adapter-core base so HomeWizard can be instantiated without the ioBroker runtime.
// Methods main.ts uses are vi.fn / trivial impls; tests drive the private methods directly
// and assert on the fakes (client/ws factories) injected below.
vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "homewizard.0";
    public adapterDir = "/tmp";
    public config: Record<string, unknown> = {};
    public on = vi.fn();
    public setStateAsync = vi.fn(async () => {});
    public setStateChangedAsync = vi.fn(async () => {});
    public getStateAsync = vi.fn(async () => null);
    public subscribeStatesAsync = vi.fn(async () => {});
    public setTimeout = vi.fn(() => ({}) as unknown);
    public clearTimeout = vi.fn();
    public setInterval = vi.fn(() => ({}) as unknown);
    public clearInterval = vi.fn();
    public encrypt = vi.fn((t: string) => t);
    public decrypt = vi.fn((t: string) => t);
    public getAdapterObjectsAsync = vi.fn(async () => ({}));
    public extendObjectAsync = vi.fn(async () => {});
    public extendForeignObjectAsync = vi.fn(async () => {});
    public delObjectAsync = vi.fn(async () => {});
    public getObjectAsync = vi.fn(async () => null);
    public setObjectNotExistsAsync = vi.fn(async () => {});
    public setState = vi.fn(async () => {});
    constructor(_opts: unknown) {}
  }
  return {
    Adapter,
    I18n: {
      init: vi.fn(async () => {}),
      getTranslatedObject: (k: string) => ({ en: k }),
      translate: (k: string) => k,
    },
  };
});

import { HomeWizard } from "./main";
import { HomeWizardApiError } from "./lib/homewizard-client";
import type { DeviceConnection, DiscoveredDevice } from "./lib/types";

interface FakeClient {
  reboot: ReturnType<typeof vi.fn>;
  identify: ReturnType<typeof vi.fn>;
  setSystem: ReturnType<typeof vi.fn>;
  setBatteries: ReturnType<typeof vi.fn>;
  deleteUser: ReturnType<typeof vi.fn>;
  getSystem: ReturnType<typeof vi.fn>;
  getDeviceInfo: ReturnType<typeof vi.fn>;
  getBatteries: ReturnType<typeof vi.fn>;
  getMeasurement: ReturnType<typeof vi.fn>;
  requestPairing: ReturnType<typeof vi.fn>;
  getServerCertCn: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return {
    reboot: vi.fn(async () => {}),
    identify: vi.fn(async () => {}),
    setSystem: vi.fn(async () => ({})),
    setBatteries: vi.fn(async () => ({})),
    deleteUser: vi.fn(async () => {}),
    getSystem: vi.fn(async () => ({ cloud_enabled: true })),
    getDeviceInfo: vi.fn(async () => ({ product_name: "P1" })),
    getBatteries: vi.fn(async () => ({})),
    getMeasurement: vi.fn(async () => ({ power_w: 1 })),
    requestPairing: vi.fn(async () => ({ token: "fresh-token" })),
    getServerCertCn: vi.fn(() => null),
  };
}

interface FakeWs {
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** Shape of the WsCallbacks bundle main.ts wires into makeWebSocket. */
interface WsCallbacksShape {
  onMeasurement: (data: unknown) => void;
  onSystem: (data: unknown) => void;
  onBattery: (data: unknown) => void;
  onConnected: () => void;
  onDisconnected: (error?: Error) => void;
  log: unknown;
}

/** Shape of the TimerDeps closures main.ts wires into makeWebSocket. */
interface TimerDepsShape {
  schedule: (cb: () => void, ms: number) => unknown;
  cancel: (h: unknown) => void;
  scheduleRepeating: (cb: () => void, ms: number) => unknown;
  cancelRepeating: (h: unknown) => void;
}

interface FakeDiscovery {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  /** Captured discovery callback — tests invoke it to simulate an mDNS hit. */
  callback: ((d: DiscoveredDevice) => void) | null;
}

/** Let queued microtasks/immediates from fire-and-forget paths settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function makeConn(overrides: Partial<DeviceConnection> = {}): DeviceConnection {
  return {
    config: { token: "tok", productType: "HWE-P1", serial: "aabb", productName: "P1" },
    ip: "192.168.1.5",
    wsClient: null,
    wsAuthenticated: false,
    pollTimer: undefined,
    reconnectTimer: undefined,
    wsFailCount: 0,
    authFailCount: 0,
    lastErrorCode: "",
    lastConnectedAt: 0,
    recentDisconnects: 0,
    recovering: false,
    removed: false,
    ...overrides,
  };
}

interface FakeStateMgr {
  devicePrefix: ReturnType<typeof vi.fn>;
  removeDevice: ReturnType<typeof vi.fn>;
  setDeviceConnected: ReturnType<typeof vi.fn>;
  updateMeasurement: ReturnType<typeof vi.fn>;
  updateSystem: ReturnType<typeof vi.fn>;
  updateBattery: ReturnType<typeof vi.fn>;
  createDeviceStates: ReturnType<typeof vi.fn>;
  cleanupMovedStates: ReturnType<typeof vi.fn>;
}

/** Build a HomeWizard with fake client/ws/discovery factories + a fake stateManager + one registered conn. */
function setup(): {
  hw: HomeWizard;
  client: FakeClient;
  conn: DeviceConnection;
  stateMgr: FakeStateMgr;
  wsInstances: FakeWs[];
  wsArgs: Array<{ callbacks: WsCallbacksShape; timers: TimerDepsShape }>;
  discovery: FakeDiscovery;
} {
  const hw = new HomeWizard();
  const client = makeFakeClient();
  const conn = makeConn();
  const internal = hw as unknown as {
    makeClient: () => FakeClient;
    makeWebSocket: () => FakeWs;
    makeDiscovery: () => FakeDiscovery;
    stateManager: unknown;
    connections: Map<string, DeviceConnection>;
  };
  internal.makeClient = () => client;

  const wsInstances: FakeWs[] = [];
  const wsArgs: Array<{ callbacks: WsCallbacksShape; timers: TimerDepsShape }> = [];
  (internal.makeWebSocket as unknown) = (
    _ip: string,
    _token: string,
    callbacks: WsCallbacksShape,
    timers: TimerDepsShape,
  ) => {
    const ws: FakeWs = { connect: vi.fn(), close: vi.fn() };
    wsInstances.push(ws);
    wsArgs.push({ callbacks, timers });
    return ws;
  };

  const discovery: FakeDiscovery = {
    start: vi.fn((cb: (d: DiscoveredDevice) => void) => {
      discovery.callback = cb;
    }),
    stop: vi.fn(),
    callback: null,
  };
  internal.makeDiscovery = () => discovery;

  const stateMgr: FakeStateMgr = {
    // Same shape the real sanitize produces — pairing tests register new serials.
    devicePrefix: vi.fn((cfg: { productType: string; serial: string }) =>
      `${cfg.productType}_${cfg.serial}`.toLowerCase(),
    ),
    removeDevice: vi.fn(async () => {}),
    setDeviceConnected: vi.fn(async () => {}),
    updateMeasurement: vi.fn(async () => {}),
    updateSystem: vi.fn(async () => {}),
    updateBattery: vi.fn(async () => {}),
    createDeviceStates: vi.fn(async () => {}),
    cleanupMovedStates: vi.fn(async () => {}),
  };
  internal.stateManager = stateMgr;
  internal.connections.set("hwe-p1_aabb", conn);
  return { hw, client, conn, stateMgr, wsInstances, wsArgs, discovery };
}

function call(hw: HomeWizard, method: string, ...args: unknown[]): Promise<void> {
  return (hw as unknown as Record<string, (...a: unknown[]) => Promise<void>>)[method](...args);
}

const active = (val: unknown): ioBroker.State => ({ val, ack: false }) as ioBroker.State;

describe("HomeWizard onStateChange routing", () => {
  it("battery.mode: forwards a valid mode and acks", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.mode", active("predictive"));
    expect(client.setBatteries).toHaveBeenCalledWith({ mode: "predictive" });
  });

  it("battery.mode: rejects an invalid mode (no setBatteries, warn)", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.mode", active("turbo"));
    expect(client.setBatteries).not.toHaveBeenCalled();
  });

  it("battery.charge_to_full: forwards a boolean", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.charge_to_full", active(true));
    expect(client.setBatteries).toHaveBeenCalledWith({ charge_to_full: true });
  });

  it("battery.permissions: forwards parsed array, rejects malformed JSON", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.permissions", active('["charge_allowed"]'));
    expect(client.setBatteries).toHaveBeenCalledWith({ permissions: ["charge_allowed"] });
    client.setBatteries.mockClear();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.permissions", active("{bad"));
    expect(client.setBatteries).not.toHaveBeenCalled();
  });

  it("system.reboot: calls reboot", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.reboot", active(true));
    expect(client.reboot).toHaveBeenCalled();
  });

  it("system.cloud_enabled: forwards the boolean to setSystem", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.cloud_enabled", active(false));
    expect(client.setSystem).toHaveBeenCalledWith({ cloud_enabled: false });
  });

  it("system.status_led_brightness_pct: forwards a valid 0-100 number", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.status_led_brightness_pct", active(50));
    expect(client.setSystem).toHaveBeenCalledWith({ status_led_brightness_pct: 50 });
  });

  it("system.status_led_brightness_pct: rejects a non-numeric or out-of-range value (S1-4)", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.status_led_brightness_pct", active("abc"));
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.status_led_brightness_pct", active(150));
    expect(client.setSystem).not.toHaveBeenCalled();
  });

  it("system.api_v1_enabled: forwards the toggle (and warns when enabling) (S5-1b)", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.api_v1_enabled", active(true));
    expect(client.setSystem).toHaveBeenCalledWith({ api_v1_enabled: true });
  });

  it("ignores acked states", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.mode", {
      val: "zero",
      ack: true,
    } as ioBroker.State);
    expect(client.setBatteries).not.toHaveBeenCalled();
  });
});

describe("HomeWizard removeDevice (A2 token revoke)", () => {
  it("revokes the token (DELETE /api/user) and removes the device", async () => {
    const { hw, client, stateMgr } = setup();
    await call(hw, "removeDevice", "homewizard.0.hwe-p1_aabb.remove");
    expect(client.deleteUser).toHaveBeenCalled();
    expect(stateMgr.removeDevice).toHaveBeenCalled();
  });
});

describe("HomeWizard isUnstable", () => {
  it("becomes unstable at the disconnect threshold (T3 — real method, not a literal compare)", () => {
    const { hw, conn } = setup();
    const isUnstable = (c: DeviceConnection): boolean =>
      (hw as unknown as { isUnstable: (c: DeviceConnection) => boolean }).isUnstable(c);
    expect(isUnstable(conn)).toBe(false);
    conn.recentDisconnects = 2;
    expect(isUnstable(conn)).toBe(false);
    conn.recentDisconnects = 3;
    expect(isUnstable(conn)).toBe(true);
  });
});

describe("HomeWizard onWsDisconnected", () => {
  it("schedules a reconnect on a normal disconnect", () => {
    const { hw, conn } = setup();
    const setTimeoutSpy = (hw as unknown as { setTimeout: ReturnType<typeof vi.fn> }).setTimeout;
    (hw as unknown as { onWsDisconnected: (c: DeviceConnection, e?: Error) => void }).onWsDisconnected(conn);
    expect(conn.wsFailCount).toBe(1);
    expect(setTimeoutSpy).toHaveBeenCalled();
  });

  it("stops reconnecting after repeated auth failures", () => {
    const { hw, conn } = setup();
    conn.authFailCount = 2; // one more reaches MAX_AUTH_FAILURES (3)
    const authErr = new HomeWizardApiError(401, JSON.stringify({ error: { code: "user:unauthorized" } }), "ws");
    const setTimeoutSpy = (hw as unknown as { setTimeout: ReturnType<typeof vi.fn> }).setTimeout;
    setTimeoutSpy.mockClear();
    (hw as unknown as { onWsDisconnected: (c: DeviceConnection, e?: Error) => void }).onWsDisconnected(conn, authErr);
    expect(setTimeoutSpy).not.toHaveBeenCalled(); // auth-stop → no reconnect scheduled
  });

  it("M1: a single outage with failed reconnects does not flip the device to unstable", () => {
    const { hw, conn } = setup();
    const api = hw as unknown as {
      onWsConnected: (c: DeviceConnection) => void;
      onWsDisconnected: (c: DeviceConnection, e?: Error) => void;
      isUnstable: (c: DeviceConnection) => boolean;
    };
    api.onWsConnected(conn); // real connect → lastConnectedAt set, counters reset
    api.onWsDisconnected(conn); // real disconnect → recentDisconnects = 1, lastConnectedAt reset (M1)
    api.onWsDisconnected(conn); // failed reconnect — onWsConnected NOT called, never re-authenticated
    api.onWsDisconnected(conn); // failed reconnect
    api.onWsDisconnected(conn); // failed reconnect
    // Failed reconnects must NOT be miscounted as short connections (that would need
    // lastConnectedAt to persist across the drop). Device stays normal after one outage.
    expect(conn.recentDisconnects).toBe(1);
    expect(api.isUnstable(conn)).toBe(false);
  });
});

describe("HomeWizard WebSocket push handlers (A3, K3)", () => {
  it("onWsConnected resets backoff counters and clears the last error", () => {
    const { hw, conn, stateMgr } = setup();
    conn.wsFailCount = 5;
    conn.authFailCount = 2;
    conn.lastErrorCode = "NETWORK";
    (hw as unknown as { onWsConnected: (c: DeviceConnection) => void }).onWsConnected(conn);
    expect(conn.wsAuthenticated).toBe(true);
    expect(conn.wsFailCount).toBe(0);
    expect(conn.authFailCount).toBe(0);
    expect(conn.lastErrorCode).toBe("");
    expect(stateMgr.setDeviceConnected).toHaveBeenCalledWith(conn.config, true);
  });

  it("onWsBattery forwards a push when batteries are connected (battery_count > 0)", () => {
    const { hw, conn, stateMgr } = setup();
    (hw as unknown as { onWsBattery: (c: DeviceConnection, d: unknown) => void }).onWsBattery(conn, {
      mode: "zero",
      battery_count: 2,
    });
    expect(stateMgr.updateBattery).toHaveBeenCalled();
  });

  it("onWsBattery drops a push without battery_count (gate, consistent with the REST poll)", () => {
    const { hw, conn, stateMgr } = setup();
    (hw as unknown as { onWsBattery: (c: DeviceConnection, d: unknown) => void }).onWsBattery(conn, { mode: "zero" });
    expect(stateMgr.updateBattery).not.toHaveBeenCalled();
  });

  it("onWsBattery drops a push for a device removed mid-flight (race guard)", () => {
    const { hw, conn, stateMgr } = setup();
    conn.removed = true;
    (hw as unknown as { onWsBattery: (c: DeviceConnection, d: unknown) => void }).onWsBattery(conn, {
      mode: "zero",
      battery_count: 2,
    });
    expect(stateMgr.updateBattery).not.toHaveBeenCalled();
  });

  it("onWsSystem forwards a push to updateSystem", () => {
    const { hw, conn, stateMgr } = setup();
    (hw as unknown as { onWsSystem: (c: DeviceConnection, d: unknown) => void }).onWsSystem(conn, {
      cloud_enabled: true,
    });
    expect(stateMgr.updateSystem).toHaveBeenCalled();
  });

  it("onWsDisconnected clamps the reconnect delay tighter for an unstable device", () => {
    // Unstable device (recentDisconnects already past threshold) → 60s cap.
    const u = setup();
    u.conn.recentDisconnects = 3; // isUnstable → true
    u.conn.wsFailCount = 10; // exponential backoff would far exceed any cap
    const uSetTimeout = (u.hw as unknown as { setTimeout: ReturnType<typeof vi.fn> }).setTimeout;
    (u.hw as unknown as { onWsDisconnected: (c: DeviceConnection) => void }).onWsDisconnected(u.conn);
    const unstableDelay = uSetTimeout.mock.calls[0][1] as number;

    // Stable device, same fail count → the normal 5-min cap.
    const s = setup();
    s.conn.recentDisconnects = 0; // isUnstable → false
    s.conn.wsFailCount = 10;
    const sSetTimeout = (s.hw as unknown as { setTimeout: ReturnType<typeof vi.fn> }).setTimeout;
    (s.hw as unknown as { onWsDisconnected: (c: DeviceConnection) => void }).onWsDisconnected(s.conn);
    const stableDelay = sSetTimeout.mock.calls[0][1] as number;

    expect(unstableDelay).toBeLessThanOrEqual(60_000);
    expect(stableDelay).toBeGreaterThan(60_000);
  });
});

/** Typed access to private fields/methods used by the orchestration tests below. */
function internalOf(hw: HomeWizard): {
  isPairing: boolean;
  pairingManualIp: string;
  discoveredDuringPairing: DiscoveredDevice[];
  discovery: FakeDiscovery | null;
  pairingTimer: unknown;
  pairingPollTimer: unknown;
  systemPollTimer: unknown;
  ipRecoveryTimer: unknown;
  lastWarnAt: Map<string, number>;
  lastInfoAt: Map<string, number>;
  connections: Map<string, DeviceConnection>;
  config: Record<string, unknown>;
  log: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  setStateAsync: ReturnType<typeof vi.fn>;
  getStateAsync: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  clearTimeout: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
  decrypt: ReturnType<typeof vi.fn>;
  encrypt: ReturnType<typeof vi.fn>;
  getAdapterObjectsAsync: ReturnType<typeof vi.fn>;
  extendObjectAsync: ReturnType<typeof vi.fn>;
  extendForeignObjectAsync: ReturnType<typeof vi.fn>;
  subscribeStatesAsync: ReturnType<typeof vi.fn>;
  startPairing: () => Promise<void>;
  pollPairing: () => Promise<void>;
  stopPairing: () => void;
  startIpRecovery: () => void;
  initDevice: (c: DeviceConnection) => Promise<void>;
  loadDevicesFromObjects: () => Promise<unknown[]>;
  saveDeviceToObject: (c: unknown) => Promise<void>;
  onDeviceDiscovered: (d: DiscoveredDevice) => void;
  onReady: () => Promise<void>;
  onUnload: (cb: () => void) => void;
  onWsMeasurement: (c: DeviceConnection, d: unknown) => void;
  pollAllSystemInfo: () => Promise<void>;
  pollSystemInfo: (c: DeviceConnection) => Promise<void>;
  removeDevice: (id: string) => Promise<void>;
} {
  return hw as unknown as ReturnType<typeof internalOf>;
}

describe("HomeWizard startPairing", () => {
  it("mDNS path: resets the button, starts discovery and installs poll + timeout timers", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    await i.startPairing();

    expect(i.setStateAsync).toHaveBeenCalledWith("startPairing", { val: false, ack: true });
    expect(discovery.start).toHaveBeenCalledTimes(1);
    expect(i.setInterval).toHaveBeenCalled(); // pairing poll
    expect(i.setTimeout).toHaveBeenCalled(); // 60 s window
    expect(i.isPairing).toBe(true);
  });

  it("is a no-op when pairing is already active", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    await i.startPairing();
    await i.startPairing();
    expect(discovery.start).toHaveBeenCalledTimes(1);
  });

  it("manual-IP path: uses the IP from pairingIp, clears the state, skips mDNS", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    i.getStateAsync.mockResolvedValueOnce({ val: "192.168.1.50" });
    await i.startPairing();

    expect(i.discoveredDuringPairing).toHaveLength(1);
    expect(i.discoveredDuringPairing[0].ip).toBe("192.168.1.50");
    expect(i.setStateAsync).toHaveBeenCalledWith("pairingIp", { val: "", ack: true });
    expect(discovery.start).not.toHaveBeenCalled();
  });

  it("manual-IP path: rejects a malformed IP fast (warn, no pairing window)", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.getStateAsync.mockResolvedValueOnce({ val: "999.1.2.3" });
    await i.startPairing();

    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Invalid pairing IP"));
    expect(i.isPairing).toBe(false);
    expect(i.discoveredDuringPairing).toHaveLength(0);
  });
});

describe("HomeWizard onDeviceDiscovered", () => {
  it("queues a new device and logs the button-press hint", () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.onDeviceDiscovered({ ip: "192.168.1.60", productType: "HWE-BAT", serial: "bat01", name: "Battery" });
    expect(i.discoveredDuringPairing).toHaveLength(1);
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("press the button"));
  });

  it("skips devices that are already paired (same serial)", () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.onDeviceDiscovered({ ip: "192.168.1.61", productType: "HWE-P1", serial: "aabb", name: "P1" });
    expect(i.discoveredDuringPairing).toHaveLength(0);
  });

  it("skips duplicate discoveries (same serial twice)", () => {
    const { hw } = setup();
    const i = internalOf(hw);
    const d: DiscoveredDevice = { ip: "192.168.1.62", productType: "HWE-KWH1", serial: "kwh01", name: "kWh" };
    i.onDeviceDiscovered(d);
    i.onDeviceDiscovered(d);
    expect(i.discoveredDuringPairing).toHaveLength(1);
  });
});

describe("HomeWizard pollPairing", () => {
  it("403 (button not pressed) keeps polling without saving anything", async () => {
    const { hw, client, stateMgr } = setup();
    const i = internalOf(hw);
    i.discoveredDuringPairing = [{ ip: "192.168.1.70", productType: "HWE-P1", serial: "new01", name: "P1" }];
    client.requestPairing.mockRejectedValueOnce(
      new HomeWizardApiError(403, JSON.stringify({ error: { code: "user:creation-not-enabled" } }), "POST /api/user"),
    );
    await i.pollPairing();

    expect(stateMgr.createDeviceStates).not.toHaveBeenCalled();
    expect(i.discoveredDuringPairing).toHaveLength(1); // still waiting for the button
  });

  it("success: saves the device, creates states, registers the connection and drops it from the queue", async () => {
    const { hw, client, stateMgr } = setup();
    const i = internalOf(hw);
    i.discoveredDuringPairing = [{ ip: "192.168.1.70", productType: "HWE-P1", serial: "new01", name: "P1" }];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "new01", product_name: "P1 Neu" });
    await i.pollPairing();
    await settle();

    expect(client.requestPairing).toHaveBeenCalled();
    expect(i.encrypt).toHaveBeenCalledWith("fresh-token");
    expect(i.extendObjectAsync).toHaveBeenCalled(); // saveDeviceToObject
    expect(stateMgr.createDeviceStates).toHaveBeenCalled();
    expect(i.connections.has("hwe-p1_new01")).toBe(true);
    expect(i.discoveredDuringPairing).toHaveLength(0);
  });

  it("removes the just-paired entry by identity, not serial (D1-1 manual-IP placeholder)", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    // Manual-IP path enqueues a placeholder with serial "unknown"; the device
    // reports its real serial. Filtering by serial would never match → re-POST loop.
    i.discoveredDuringPairing = [
      { ip: "192.168.1.71", productType: "unknown", serial: "unknown", name: "192.168.1.71" },
    ];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "real99", product_name: "P1" });
    await i.pollPairing();
    await settle();

    expect(i.discoveredDuringPairing).toHaveLength(0); // removed by identity
  });

  it("revokes the just-issued token if device setup fails (S1-1, no orphaned token)", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    i.discoveredDuringPairing = [{ ip: "192.168.1.72", productType: "HWE-P1", serial: "x", name: "P1" }];
    client.getDeviceInfo.mockRejectedValueOnce(new Error("malformed device info"));
    await i.pollPairing();
    await settle();

    expect(client.deleteUser).toHaveBeenCalled();
  });

  it("re-pair of an existing serial tears down the previous connection (no zombie WS)", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    const oldWs = { connect: vi.fn(), close: vi.fn() };
    conn.wsClient = oldWs as unknown as DeviceConnection["wsClient"];
    i.discoveredDuringPairing = [{ ip: "192.168.1.5", productType: "HWE-P1", serial: "aabb", name: "P1" }];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "aabb", product_name: "P1" });
    await i.pollPairing();
    await settle();

    expect(oldWs.close).toHaveBeenCalled();
    expect(i.connections.has("hwe-p1_aabb")).toBe(true);
  });

  it("in-flight guard: a second poll while one is running returns without polling again", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    i.discoveredDuringPairing = [{ ip: "192.168.1.70", productType: "HWE-P1", serial: "new01", name: "P1" }];
    let release!: (v: never) => void;
    client.requestPairing.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          release = reject as (v: never) => void;
        }),
    );
    const first = i.pollPairing();
    await i.pollPairing(); // must bail out via pairingPollBusy
    expect(client.requestPairing).toHaveBeenCalledTimes(1);
    release(new HomeWizardApiError(403, "{}", "POST /api/user") as never);
    await first;
  });
});

describe("HomeWizard stopPairing", () => {
  it("clears the poll + timeout timers and stops mDNS", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    await i.startPairing();
    i.stopPairing();

    expect(i.clearInterval).toHaveBeenCalled();
    expect(i.clearTimeout).toHaveBeenCalled();
    expect(discovery.stop).toHaveBeenCalled();
    expect(i.isPairing).toBe(false);
    expect(i.discovery).toBeNull();
    expect(i.discoveredDuringPairing).toHaveLength(0);
  });
});

describe("HomeWizard loadDevicesFromObjects", () => {
  it("loads configs from device objects (decrypting the token)", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.getAdapterObjectsAsync.mockResolvedValue({
      "homewizard.0.hwe-p1_dev1": {
        type: "device",
        native: { encryptedToken: "tok1", serial: "dev1", productType: "HWE-P1", productName: "P1", ip: "192.168.1.8" },
      },
      "homewizard.0.hwe-p1_dev1.info": { type: "channel", native: {} },
    });
    const devices = (await i.loadDevicesFromObjects()) as Array<{ serial: string; token: string; ip?: string }>;

    expect(devices).toHaveLength(1);
    expect(devices[0].serial).toBe("dev1");
    expect(devices[0].token).toBe("tok1"); // decrypt stub is identity
    expect(devices[0].ip).toBe("192.168.1.8");
  });

  it("isolates a corrupted token: warns, skips that device, keeps the rest", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.decrypt.mockImplementation((t: string) => {
      if (t === "BROKEN") {
        throw new Error("bad decrypt");
      }
      return t;
    });
    i.getAdapterObjectsAsync.mockResolvedValue({
      "homewizard.0.hwe-p1_bad": {
        type: "device",
        native: { encryptedToken: "BROKEN", serial: "bad", productType: "HWE-P1", productName: "P1" },
      },
      "homewizard.0.hwe-p1_good": {
        type: "device",
        native: { encryptedToken: "tok-good", serial: "good", productType: "HWE-P1", productName: "P1" },
      },
    });
    const devices = (await i.loadDevicesFromObjects()) as Array<{ serial: string }>;

    expect(devices).toHaveLength(1);
    expect(devices[0].serial).toBe("good");
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Cannot decrypt token"));
  });

  it("migrates legacy native.devices configs to device objects and clears the old config", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.config.devices = [{ token: "legacy-tok", productType: "HWE-P1", serial: "leg01", productName: "P1" }];
    const devices = (await i.loadDevicesFromObjects()) as Array<{ serial: string }>;

    expect(devices).toHaveLength(1);
    expect(devices[0].serial).toBe("leg01");
    expect(i.extendObjectAsync).toHaveBeenCalled(); // saveDeviceToObject
    expect(i.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.homewizard.0", {
      native: { devices: [] },
    });
  });
});

describe("HomeWizard saveDeviceToObject", () => {
  it("stores the encrypted token in device-object native and preserves user-modified names", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    await i.saveDeviceToObject({ token: "tok", productType: "HWE-P1", serial: "s1", productName: "Mein P1" });

    expect(i.encrypt).toHaveBeenCalledWith("tok");
    expect(i.extendObjectAsync).toHaveBeenCalledWith(
      "hwe-p1_s1",
      expect.objectContaining({
        type: "device",
        native: expect.objectContaining({ encryptedToken: "tok", serial: "s1" }),
      }),
      { preserve: { common: ["name"] } },
    );
  });
});

describe("HomeWizard initDevice", () => {
  it("writes the firmware state, connects the WebSocket and polls system info", async () => {
    const { hw, client, conn, stateMgr, wsInstances } = setup();
    const i = internalOf(hw);
    client.getDeviceInfo.mockResolvedValue({ product_name: "P1", firmware_version: "6.4" });
    await i.initDevice(conn);
    await settle();

    expect(i.setStateAsync).toHaveBeenCalledWith("hwe-p1_aabb.info.firmware", { val: "6.4", ack: true });
    expect(wsInstances).toHaveLength(1);
    expect(wsInstances[0].connect).toHaveBeenCalled();
    expect(stateMgr.updateSystem).toHaveBeenCalled(); // pollSystemInfo ran
  });

  it("captures and persists the cert CN on first connect when none is stored (lazy migration)", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    conn.config.certCn = undefined; // device paired before v0.13.0
    client.getDeviceInfo.mockResolvedValue({ product_name: "P1", firmware_version: "6.4" });
    client.getServerCertCn.mockReturnValue("appliance/p1dongle/aabb");
    await i.initDevice(conn);
    await settle();

    expect(conn.config.certCn).toBe("appliance/p1dongle/aabb");
    expect(i.extendObjectAsync).toHaveBeenCalledWith(
      "hwe-p1_aabb",
      expect.objectContaining({ native: expect.objectContaining({ certCn: "appliance/p1dongle/aabb" }) }),
      expect.anything(),
    );
  });

  it("does nothing for a device removed mid-flight", async () => {
    const { hw, conn, wsInstances } = setup();
    const i = internalOf(hw);
    conn.removed = true;
    await i.initDevice(conn);
    expect(wsInstances).toHaveLength(0);
  });

  it("still connects the WebSocket when the initial info fetch fails (offline at boot)", async () => {
    const { hw, client, conn, wsInstances } = setup();
    const i = internalOf(hw);
    const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    client.getDeviceInfo.mockRejectedValueOnce(err);
    await i.initDevice(conn);
    await settle();

    expect(wsInstances).toHaveLength(1); // reconnect logic takes over from here
  });
});

describe("HomeWizard startIpRecovery", () => {
  it("updates IP + persists + reconnects when mDNS finds the device elsewhere", async () => {
    const { hw, conn, discovery, wsInstances } = setup();
    const i = internalOf(hw);
    conn.wsFailCount = 5;
    i.startIpRecovery();
    expect(discovery.start).toHaveBeenCalled();

    discovery.callback!({ ip: "10.0.0.99", productType: "HWE-P1", serial: "aabb", name: "P1" });
    await settle();

    expect(conn.ip).toBe("10.0.0.99");
    expect(conn.wsFailCount).toBe(0);
    expect(i.extendObjectAsync).toHaveBeenCalled(); // IP persisted
    expect(wsInstances).toHaveLength(1); // immediate reconnect
  });

  it("ignores a broadcast with the unchanged IP", () => {
    const { hw, conn, discovery, wsInstances } = setup();
    const i = internalOf(hw);
    i.startIpRecovery();
    discovery.callback!({ ip: conn.ip, productType: "HWE-P1", serial: "aabb", name: "P1" });
    expect(wsInstances).toHaveLength(0);
  });

  it("skips when a connect cycle is already in flight (recovering guard)", () => {
    const { hw, conn, discovery, wsInstances } = setup();
    const i = internalOf(hw);
    conn.recovering = true;
    i.startIpRecovery();
    discovery.callback!({ ip: "10.0.0.99", productType: "HWE-P1", serial: "aabb", name: "P1" });
    expect(wsInstances).toHaveLength(0);
    expect(conn.ip).toBe("192.168.1.5");
  });

  it("does not start while pairing is active", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    await i.startPairing();
    discovery.start.mockClear();
    i.startIpRecovery();
    expect(discovery.start).not.toHaveBeenCalled();
  });
});

describe("HomeWizard onReady", () => {
  it("boots without devices: subscribes controls, resets buttons, reports disconnected", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    await i.onReady();
    await settle();

    expect(i.setStateAsync).toHaveBeenCalledWith("startPairing", { val: false, ack: true });
    expect(i.subscribeStatesAsync).toHaveBeenCalledWith("startPairing");
    expect(i.subscribeStatesAsync).toHaveBeenCalledWith("*.system.reboot");
    expect(i.subscribeStatesAsync).toHaveBeenCalledWith("*.battery.mode");
    expect(i.subscribeStatesAsync).toHaveBeenCalledWith("*.remove");
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("No devices configured"));
    expect(i.setInterval).toHaveBeenCalled(); // system poll
  });

  it("boots a stored device: creates states and starts its connection", async () => {
    const { hw, wsInstances } = setup();
    const i = internalOf(hw);
    i.connections.clear();
    i.getAdapterObjectsAsync.mockResolvedValue({
      "homewizard.0.hwe-p1_dev1": {
        type: "device",
        native: { encryptedToken: "tok1", serial: "dev1", productType: "HWE-P1", productName: "P1", ip: "192.168.1.8" },
      },
    });
    await i.onReady();
    await settle();

    expect(i.connections.has("hwe-p1_dev1")).toBe(true);
    expect(wsInstances.length).toBeGreaterThanOrEqual(1); // initDevice → connectWebSocket
  });
});

describe("HomeWizard onUnload", () => {
  it("clears all global timers, tears down connections and always calls the callback", async () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);
    await i.startPairing(); // installs pairing timers + discovery
    const ws = { connect: vi.fn(), close: vi.fn() };
    conn.wsClient = ws as unknown as DeviceConnection["wsClient"];
    conn.pollTimer = {} as never;
    conn.reconnectTimer = {} as never;

    const callback = vi.fn();
    i.onUnload(callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalled();
    expect(i.connections.size).toBe(0);
    expect(i.pairingTimer).toBeUndefined();
    expect(i.pairingPollTimer).toBeUndefined();
    expect(i.systemPollTimer).toBeUndefined();
    expect(i.ipRecoveryTimer).toBeUndefined();
    expect(conn.pollTimer).toBeUndefined();
    expect(conn.reconnectTimer).toBeUndefined();
  });
});

describe("HomeWizard onWsMeasurement", () => {
  it("forwards a push to updateMeasurement", () => {
    const { hw, conn, stateMgr } = setup();
    internalOf(hw).onWsMeasurement(conn, { power_w: 42 });
    expect(stateMgr.updateMeasurement).toHaveBeenCalledWith(conn.config, { power_w: 42 }, expect.any(Function));
  });

  it("drops a push for a removed device", () => {
    const { hw, conn, stateMgr } = setup();
    conn.removed = true;
    internalOf(hw).onWsMeasurement(conn, { power_w: 42 });
    expect(stateMgr.updateMeasurement).not.toHaveBeenCalled();
  });

  it("catches a rejected write (transient Redis hiccup) as debug instead of an unhandled rejection", async () => {
    const { hw, conn, stateMgr } = setup();
    const i = internalOf(hw);
    stateMgr.updateMeasurement.mockImplementation(async () => {
      throw new Error("redis hiccup");
    });
    i.onWsMeasurement(conn, { power_w: 42 });
    await settle();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("redis hiccup"));
  });
});

describe("HomeWizard pollSystemInfo", () => {
  it("updates system states and silently skips batteries on 404 (device has none)", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    client.getBatteries.mockRejectedValue(new HomeWizardApiError(404, "{}", "GET /api/batteries"));
    await i.pollSystemInfo(conn);

    expect(stateMgr.updateSystem).toHaveBeenCalled();
    expect(stateMgr.updateBattery).not.toHaveBeenCalled();
    expect(i.log.warn).not.toHaveBeenCalled();
  });

  it("updates battery states when batteries are connected", async () => {
    const { hw, client, conn, stateMgr } = setup();
    client.getBatteries.mockResolvedValue({ mode: "zero", battery_count: 2 });
    await internalOf(hw).pollSystemInfo(conn);
    expect(stateMgr.updateBattery).toHaveBeenCalledWith(conn.config, { mode: "zero", battery_count: 2 });
  });

  it("syncs productName drift from the device into the stored object", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    client.getDeviceInfo.mockResolvedValue({ product_name: "P1 Umbenannt" });
    await i.pollSystemInfo(conn);

    expect(conn.config.productName).toBe("P1 Umbenannt");
    expect(i.extendObjectAsync).toHaveBeenCalled(); // persisted
  });

  it("routes a failing system poll through the dedup logger (first occurrence warns)", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    const err = new Error("connect EHOSTUNREACH") as NodeJS.ErrnoException;
    err.code = "EHOSTUNREACH";
    client.getSystem.mockRejectedValue(err);
    await i.pollSystemInfo(conn);
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("unreachable"));
  });
});

describe("HomeWizard pollAllSystemInfo", () => {
  it("polls only connected devices (skips offline + removed)", async () => {
    const { hw, conn, stateMgr } = setup();
    const i = internalOf(hw);
    conn.wsAuthenticated = true;
    const offline = makeConn({ wsAuthenticated: false, config: { ...conn.config, serial: "off1" } });
    const removed = makeConn({ removed: true, wsAuthenticated: true, config: { ...conn.config, serial: "rem1" } });
    i.connections.set("hwe-p1_off1", offline);
    i.connections.set("hwe-p1_rem1", removed);
    await i.pollAllSystemInfo();

    expect(stateMgr.updateSystem).toHaveBeenCalledTimes(1);
    expect(stateMgr.updateSystem).toHaveBeenCalledWith(conn.config, expect.anything(), expect.any(Function));
  });
});

describe("v0.12.2 regressions", () => {
  it("reboot button is reset to false/ack after a successful reboot", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.reboot", active(true));
    expect(client.reboot).toHaveBeenCalled();
    expect(i.setStateAsync).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.reboot", { val: false, ack: true });
  });

  it("identify button is reset to false/ack after a successful identify", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.identify", active(true));
    expect(client.identify).toHaveBeenCalled();
    expect(i.setStateAsync).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.identify", {
      val: false,
      ack: true,
    });
  });

  it("a failed reboot does NOT reset the button (warn instead)", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    client.reboot.mockRejectedValueOnce(new Error("boom"));
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.reboot", active(true));
    expect(i.setStateAsync).not.toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.reboot", {
      val: false,
      ack: true,
    });
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to set"));
  });

  it("removeDevice drops the per-device warn/info cooldown stamps", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.lastWarnAt.set("aabb", 123);
    i.lastInfoAt.set("aabb", 456);
    await i.removeDevice("homewizard.0.hwe-p1_aabb.remove");

    expect(i.lastWarnAt.has("aabb")).toBe(false);
    expect(i.lastInfoAt.has("aabb")).toBe(false);
  });

  it("a write to a state without matching device is surfaced at debug", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-x_unknown.system.reboot", active(true));
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("no matching connected device"));
  });
});

describe("HomeWizard startRestFallback (poll body)", () => {
  /** Start the fallback and return the captured interval callback. */
  function startAndCapture(hw: HomeWizard, conn: DeviceConnection): () => Promise<void> {
    const i = internalOf(hw);
    (hw as unknown as { startRestFallback: (c: DeviceConnection) => void }).startRestFallback(conn);
    const lastCall = i.setInterval.mock.calls.at(-1)!;
    return lastCall[0] as () => Promise<void>;
  }

  it("polls the measurement endpoint and forwards the data", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const poll = startAndCapture(hw, conn);
    await poll();
    expect(client.getMeasurement).toHaveBeenCalled();
    expect(stateMgr.updateMeasurement).toHaveBeenCalledWith(conn.config, { power_w: 1 }, expect.any(Function));
  });

  it("stops polling on a network error for a stable device (WS reconnect owns recovery)", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    client.getMeasurement.mockRejectedValue(err);
    const poll = startAndCapture(hw, conn);
    await poll();
    expect(i.clearInterval).toHaveBeenCalled();
    expect(conn.pollTimer).toBeUndefined();
  });

  it("keeps polling through network errors for an unstable device (minimize data gaps)", async () => {
    const { hw, client, conn } = setup();
    conn.recentDisconnects = 3; // unstable
    const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    client.getMeasurement.mockRejectedValue(err);
    const poll = startAndCapture(hw, conn);
    await poll();
    expect(conn.pollTimer).not.toBeUndefined();
  });

  it("stops everything once auth failures reach the threshold (re-pair required)", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    conn.authFailCount = 2; // next failure reaches MAX_AUTH_FAILURES (3)
    client.getMeasurement.mockRejectedValue(
      new HomeWizardApiError(401, JSON.stringify({ error: { code: "user:unauthorized" } }), "GET /api/measurement"),
    );
    const poll = startAndCapture(hw, conn);
    await poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("token invalid"));
    expect(conn.pollTimer).toBeUndefined();
  });

  it("does not fetch for a removed device or during unload", async () => {
    const { hw, client, conn } = setup();
    const poll = startAndCapture(hw, conn);
    conn.removed = true;
    await poll();
    expect(client.getMeasurement).not.toHaveBeenCalled();
  });

  it("does not start a second poll while one timer is active", () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);
    (hw as unknown as { startRestFallback: (c: DeviceConnection) => void }).startRestFallback(conn);
    const after = i.setInterval.mock.calls.length;
    (hw as unknown as { startRestFallback: (c: DeviceConnection) => void }).startRestFallback(conn);
    expect(i.setInterval.mock.calls.length).toBe(after);
  });
});

describe("HomeWizard connectWebSocket wiring", () => {
  it("wires the WS callbacks to the push handlers and the timer deps to adapter timers", () => {
    const { hw, conn, stateMgr, wsArgs } = setup();
    const i = internalOf(hw);
    (hw as unknown as { connectWebSocket: (c: DeviceConnection) => void }).connectWebSocket(conn);
    expect(wsArgs).toHaveLength(1);
    const { callbacks, timers } = wsArgs[0];

    callbacks.onMeasurement({ power_w: 7 });
    expect(stateMgr.updateMeasurement).toHaveBeenCalledWith(conn.config, { power_w: 7 }, expect.any(Function));
    callbacks.onSystem({ cloud_enabled: true });
    expect(stateMgr.updateSystem).toHaveBeenCalled();
    callbacks.onBattery({ mode: "zero", battery_count: 1 });
    expect(stateMgr.updateBattery).toHaveBeenCalled();
    callbacks.onConnected();
    expect(conn.wsAuthenticated).toBe(true);
    callbacks.onDisconnected();
    expect(conn.wsAuthenticated).toBe(false);

    const cb = vi.fn();
    const h1 = timers.schedule(cb, 100);
    timers.cancel(h1);
    const h2 = timers.scheduleRepeating(cb, 100);
    timers.cancelRepeating(h2);
    expect(i.setTimeout).toHaveBeenCalledWith(cb, 100);
    expect(i.clearTimeout).toHaveBeenCalled();
    expect(i.setInterval).toHaveBeenCalledWith(cb, 100);
    expect(i.clearInterval).toHaveBeenCalled();
  });

  it("skips connecting once auth failures exhausted the retries", () => {
    const { hw, conn, wsInstances } = setup();
    conn.authFailCount = 3;
    (hw as unknown as { connectWebSocket: (c: DeviceConnection) => void }).connectWebSocket(conn);
    expect(wsInstances).toHaveLength(0);
  });

  it("closes a leftover wsClient before opening the next one (IP-recovery path)", () => {
    const { hw, conn, wsInstances } = setup();
    const leftover = { connect: vi.fn(), close: vi.fn() };
    conn.wsClient = leftover as unknown as DeviceConnection["wsClient"];
    (hw as unknown as { connectWebSocket: (c: DeviceConnection) => void }).connectWebSocket(conn);
    expect(leftover.close).toHaveBeenCalled();
    expect(wsInstances).toHaveLength(1);
  });
});

describe("HomeWizard onWsDisconnected reconnect timer", () => {
  it("the scheduled timer callback re-runs connectWebSocket", () => {
    const { hw, conn, wsInstances } = setup();
    const i = internalOf(hw);
    (hw as unknown as { onWsDisconnected: (c: DeviceConnection) => void }).onWsDisconnected(conn);
    const timerCb = i.setTimeout.mock.calls.at(-1)![0] as () => void;
    timerCb();
    expect(conn.reconnectTimer).toBeUndefined();
    expect(wsInstances).toHaveLength(1); // reconnect created a fresh WS
  });
});

describe("HomeWizard pairing discovery callback", () => {
  it("routes an mDNS hit during pairing into the discovery queue", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    await i.startPairing();
    discovery.callback!({ ip: "192.168.1.80", productType: "HWE-KWH3", serial: "kwh3a", name: "kWh 3-phase" });
    expect(i.discoveredDuringPairing.some(d => d.serial === "kwh3a")).toBe(true);
  });
});
