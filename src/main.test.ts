import { vi } from "vitest";

// Stub the adapter-core base so HomeWizard can be instantiated without the ioBroker runtime.
// Methods main.ts uses are vi.fn / trivial impls; tests drive the private methods directly
// and assert on the fakes (client/ws factories) injected below.
vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "homewizard.0";
    public adapterDir = "/tmp";
    public host = "iob-host";
    public instance = 0;
    public config: Record<string, unknown> = {};
    public on = vi.fn();
    public setStateChangedAsync = vi.fn(async () => {});
    public getStateAsync = vi.fn(() => Promise.resolve(null));
    public subscribeStatesAsync = vi.fn(async () => {});
    public setTimeout = vi.fn(() => ({}));
    public clearTimeout = vi.fn();
    public setInterval = vi.fn(() => ({}));
    public clearInterval = vi.fn();
    // Not the identity: a token stored in plain text (`encryptedToken: config.token`)
    // must show up as a failed expectation, not pass as "encrypted".
    public encrypt = vi.fn((t: string) => `enc:${t}`);
    public decrypt = vi.fn((t: string) => (t.startsWith("enc:") ? t.slice(4) : t));
    public getAdapterObjectsAsync = vi.fn(() => Promise.resolve({}));
    public extendObject = vi.fn(async () => {});
    public getForeignObjectAsync = vi.fn((): Promise<unknown> => Promise.resolve(null));
    public extendForeignObjectAsync = vi.fn(async () => {});
    public delObjectAsync = vi.fn(async () => {});
    public getObjectAsync = vi.fn(() => Promise.resolve(null));
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

// Everything real except `dropDeviceAgent`: the ORDER of that call against the
// token revoke is what the removal tests below check, and a real eviction closes
// sockets the fake client does not have.
vi.mock("./lib/cacert", async importOriginal => {
  const actual = await importOriginal<typeof CacertModule>();
  return { ...actual, dropDeviceAgent: vi.fn() };
});

import type * as CacertModule from "./lib/cacert";
import { HomeWizard } from "./main";
import { createDeviceAgent, createDeviceAgentForSerial, dropDeviceAgent, HW_AGENT } from "./lib/cacert";
import { HomeWizardApiError } from "./lib/homewizard-client";
import { createDeviceConnection } from "./lib/connection-utils";
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
    setSystem: vi.fn(() => Promise.resolve({})),
    setBatteries: vi.fn(() => Promise.resolve({})),
    deleteUser: vi.fn(async () => {}),
    getSystem: vi.fn(() => Promise.resolve({ cloud_enabled: true })),
    getDeviceInfo: vi.fn(() => Promise.resolve({ product_name: "P1" })),
    getBatteries: vi.fn(() => Promise.resolve({})),
    getMeasurement: vi.fn(() => Promise.resolve({ power_w: 1 })),
    requestPairing: vi.fn(() => Promise.resolve({ token: "fresh-token" })),
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
    restHealthy: false,
    pollTimer: undefined,
    reconnectTimer: undefined,
    wsFailCount: 0,
    authFailCount: 0,
    lastErrorCode: "",
    lastConnectedAt: 0,
    recentDisconnects: 0,
    removed: false,
    ...overrides,
  };
}

interface FakeStateMgr {
  devicePrefix: ReturnType<typeof vi.fn>;
  removeDevice: ReturnType<typeof vi.fn>;
  removeDeviceByPrefix: ReturnType<typeof vi.fn>;
  setDeviceConnected: ReturnType<typeof vi.fn>;
  setProductName: ReturnType<typeof vi.fn>;
  setFirmware: ReturnType<typeof vi.fn>;
  markAllDisconnected: ReturnType<typeof vi.fn>;
  writeDeviceRollup: ReturnType<typeof vi.fn>;
  updateMeasurement: ReturnType<typeof vi.fn>;
  updateSystem: ReturnType<typeof vi.fn>;
  updateBattery: ReturnType<typeof vi.fn>;
  createDeviceStates: ReturnType<typeof vi.fn>;
  cleanupMovedStates: ReturnType<typeof vi.fn>;
  removeRetiredMarkers: ReturnType<typeof vi.fn>;
  refreshExistingNames: ReturnType<typeof vi.fn>;
  removeBatteryStates: ReturnType<typeof vi.fn>;
}

/** Build a HomeWizard with fake client/ws/discovery factories + a fake stateManager + one registered conn. */
function setup(): {
  hw: HomeWizard;
  client: FakeClient;
  conn: DeviceConnection;
  stateMgr: FakeStateMgr;
  wsInstances: FakeWs[];
  wsArgs: Array<{ callbacks: WsCallbacksShape; timers: TimerDepsShape; certCn?: string; serial?: string }>;
  discovery: FakeDiscovery;
  /** Every makeClient call as [ip, token, certCn, serial] — the pinning arguments included. */
  clientCalls: Array<[string, string, string | undefined, string | undefined]>;
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
  const clientCalls: Array<[string, string, string | undefined, string | undefined]> = [];
  (internal.makeClient as unknown) = (ip: string, token: string, certCn?: string, serial?: string) => {
    clientCalls.push([ip, token, certCn, serial]);
    return client;
  };

  const wsInstances: FakeWs[] = [];
  const wsArgs: Array<{ callbacks: WsCallbacksShape; timers: TimerDepsShape; certCn?: string; serial?: string }> = [];
  (internal.makeWebSocket as unknown) = (
    _ip: string,
    _token: string,
    callbacks: WsCallbacksShape,
    timers: TimerDepsShape,
    certCn?: string,
    serial?: string,
  ) => {
    const ws: FakeWs = { connect: vi.fn(), close: vi.fn() };
    wsInstances.push(ws);
    wsArgs.push({ callbacks, timers, certCn, serial });
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
    removeDeviceByPrefix: vi.fn(async () => {}),
    setDeviceConnected: vi.fn(async () => {}),
    setProductName: vi.fn(async () => {}),
    setFirmware: vi.fn(async () => {}),
    markAllDisconnected: vi.fn(async () => {}),
    writeDeviceRollup: vi.fn(async () => {}),
    updateMeasurement: vi.fn(async () => {}),
    updateSystem: vi.fn(async () => {}),
    updateBattery: vi.fn(async () => {}),
    createDeviceStates: vi.fn(async () => {}),
    cleanupMovedStates: vi.fn(async () => {}),
    removeRetiredMarkers: vi.fn(() => Promise.resolve([] as string[])),
    refreshExistingNames: vi.fn(() => Promise.resolve(0)),
    removeBatteryStates: vi.fn(() => Promise.resolve(false)),
  };
  internal.stateManager = stateMgr;
  internal.connections.set("hwe-p1_aabb", conn);
  return { hw, client, conn, stateMgr, wsInstances, wsArgs, discovery, clientCalls };
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

  it("system.reboot: calls reboot and resets the button to false/ack (v0.12.2, L19)", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.reboot", active(true));
    expect(client.reboot).toHaveBeenCalled();
    // Button must not stay stuck `true, ack=false` — it resets so it stays clickable.
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.reboot", { val: false, ack: true });
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

  it("system.api_v1_enabled: forwards the toggle and warns when enabling (S5-1b, L19)", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.api_v1_enabled", active(true));
    expect(client.setSystem).toHaveBeenCalledWith({ api_v1_enabled: true });
    // Enabling the insecure legacy API must surface a security warning.
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("legacy v1 API"));
  });

  it("system.api_v1_enabled: does NOT warn when disabling", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.api_v1_enabled", active(false));
    expect(client.setSystem).toHaveBeenCalledWith({ api_v1_enabled: false });
    expect(i.log.warn).not.toHaveBeenCalled();
  });

  it("ignores acked states", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.mode", {
      val: "zero",
      ack: true,
    });
    expect(client.setBatteries).not.toHaveBeenCalled();
  });
});

describe("HomeWizard removeDevice (A2 token revoke)", () => {
  beforeEach(() => {
    vi.mocked(dropDeviceAgent).mockClear();
  });

  it("revokes the token (DELETE /api/user) and removes the device", async () => {
    const { hw, client, stateMgr } = setup();
    await call(hw, "removeDevice", "homewizard.0.hwe-p1_aabb.remove");
    // A device paired before v0.20.0 carries no stored name: it was paired as local/iobroker.
    expect(client.deleteUser).toHaveBeenCalledWith("local/iobroker");
    expect(stateMgr.removeDevice).toHaveBeenCalled();
    // The summary is derived from the registry — a removed device must leave it.
    expect(stateMgr.writeDeviceRollup).toHaveBeenLastCalledWith(0, 0);
  });

  // The revoke rides on the device's pinned TLS agent. Destroying that agent while the
  // request is in flight kills the socket (measured: ECONNRESET, the device never sees
  // the DELETE) — so the eviction has to wait for the revoke to finish.
  it("deletes the user under the name the device was paired with", async () => {
    const { hw, client, conn } = setup();
    conn.config.userName = "local/iobroker_other-host_2";
    await call(hw, "removeDevice", "homewizard.0.hwe-p1_aabb.remove");
    expect(client.deleteUser).toHaveBeenCalledWith("local/iobroker_other-host_2");
  });

  it("evicts the pinned agents only after the revoke has finished", async () => {
    const { hw, client } = setup();
    let finish!: () => void;
    client.deleteUser.mockImplementation(() => new Promise<void>(resolve => (finish = resolve)));

    await call(hw, "removeDevice", "homewizard.0.hwe-p1_aabb.remove");
    expect(client.deleteUser).toHaveBeenCalled();
    expect(dropDeviceAgent, "agents must still carry the in-flight request").not.toHaveBeenCalled();

    finish();
    await settle();
    expect(dropDeviceAgent).toHaveBeenCalledTimes(1);
    expect(dropDeviceAgent).toHaveBeenCalledWith(undefined, "aabb");
  });

  it("keeps the agents when the same device was paired again while the revoke ran", async () => {
    const { hw, conn, client } = setup();
    const i = internalOf(hw);
    let finish!: () => void;
    client.deleteUser.mockImplementation(() => new Promise<void>(resolve => (finish = resolve)));

    await call(hw, "removeDevice", "homewizard.0.hwe-p1_aabb.remove");
    // Re-pairing puts a fresh connection under the same key — its agents are the ones
    // that would be torn down here.
    i.connections.set("hwe-p1_aabb", conn);
    finish();
    await settle();

    expect(dropDeviceAgent).not.toHaveBeenCalled();
  });

  it("evicts the agents right away when there is no token to revoke", async () => {
    const { hw, conn, client } = setup();
    conn.config.token = "";
    await call(hw, "removeDevice", "homewizard.0.hwe-p1_aabb.remove");
    await settle();

    expect(client.deleteUser).not.toHaveBeenCalled();
    expect(dropDeviceAgent).toHaveBeenCalledTimes(1);
  });

  it("says who has to finish the job when the device cannot be reached", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    client.deleteUser.mockRejectedValue(new Error("connect EHOSTUNREACH"));

    await call(hw, "removeDevice", "homewizard.0.hwe-p1_aabb.remove");
    await settle();

    expect(i.log.info).toHaveBeenCalledWith(
      "P1 (hwe-p1_aabb): the access token could not be revoked (connect EHOSTUNREACH) — the user " +
        "'local/iobroker' stays on the device until it is deleted through the device's local API (DELETE /api/user).",
    );
    expect(dropDeviceAgent, "a failed revoke must not leak the agents").toHaveBeenCalledTimes(1);
  });
});

describe("HomeWizard removeDevice / onUnload — in-flight work must stop", () => {
  // Replaces the former "drops a push for a removed device", which set the flag
  // by hand and therefore never checked that removeDevice actually sets it.
  it("a push arriving after removeDevice writes nothing", async () => {
    const { hw, conn, stateMgr } = setup();
    await call(hw, "removeDevice", "homewizard.0.hwe-p1_aabb.remove");
    stateMgr.updateMeasurement.mockClear();

    // The SAME connection object the in-flight WS frame / REST poll still holds
    // must carry the removal mark — writing its data would re-create the objects
    // that removeDevice just deleted.
    expect(conn.removed, "removeDevice must mark the live connection").toBe(true);
    internalOf(hw).connectionManager.onWsMeasurement(conn, { power_w: 100 });
    expect(stateMgr.updateMeasurement).not.toHaveBeenCalled();
  });

  it("no new socket is opened once the adapter is unloading", () => {
    const { hw, conn, wsInstances } = setup();
    const i = internalOf(hw);
    const before = wsInstances.length;

    const callback = vi.fn();
    i.onUnload(callback);

    // A reconnect timer that fired just before teardown, or an mDNS broadcast
    // arriving during unload, must not spawn a socket on a dying adapter.
    i.connectionManager.connectWebSocket(conn);
    expect(wsInstances.length, "no socket after unload").toBe(before);
  });
});

describe("HomeWizard isUnstable", () => {
  it("becomes unstable at the disconnect threshold (T3 — real method, not a literal compare)", () => {
    const { hw, conn } = setup();
    const isUnstable = (c: DeviceConnection): boolean => internalOf(hw).connectionManager.isUnstable(c);
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
    internalOf(hw).connectionManager.onWsDisconnected(conn);
    expect(conn.wsFailCount).toBe(1);
    expect(setTimeoutSpy).toHaveBeenCalled();
  });

  it("stops reconnecting after repeated auth failures", () => {
    const { hw, conn } = setup();
    conn.authFailCount = 2; // one more reaches MAX_AUTH_FAILURES (3)
    const authErr = new HomeWizardApiError(401, JSON.stringify({ error: { code: "user:unauthorized" } }), "ws");
    const setTimeoutSpy = (hw as unknown as { setTimeout: ReturnType<typeof vi.fn> }).setTimeout;
    setTimeoutSpy.mockClear();
    internalOf(hw).connectionManager.onWsDisconnected(conn, authErr);
    expect(setTimeoutSpy).not.toHaveBeenCalled(); // auth-stop → no reconnect scheduled
  });

  it("a WebSocket auth-stop also ends a running fallback, and says so once", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    const authErr = new HomeWizardApiError(401, JSON.stringify({ error: { code: "user:unauthorized" } }), "ws");
    // The fallback from an earlier drop is running.
    i.connectionManager.startRestFallback(conn);
    const poll = i.setInterval.mock.calls.at(-1)![0] as () => Promise<void>;
    expect(conn.pollTimer).toBeDefined();

    conn.authFailCount = 2;
    i.connectionManager.onWsDisconnected(conn, authErr);
    expect(conn.pollTimer, "the fallback would keep sending the rejected token").toBeUndefined();

    // A request already in flight on the fallback is rejected too — same news.
    client.getMeasurement.mockRejectedValue(authErr);
    await poll();
    const tokenWarnings = i.log.warn.mock.calls.filter(c => String(c[0]).includes("token invalid"));
    expect(tokenWarnings).toHaveLength(1);
  });

  it("F1: a bare 401 with a non-canonical body also auth-stops after repeated failures", () => {
    const { hw, conn } = setup();
    conn.authFailCount = 2; // one more reaches MAX_AUTH_FAILURES (3)
    // 401 whose body is not the canonical {"error":{"code":"user:unauthorized"}} → errorCode "unknown".
    // Before F1 this slipped past handleAuthFailure and reconnected forever.
    const bare401 = new HomeWizardApiError(401, "gateway error", "ws");
    const setTimeoutSpy = (hw as unknown as { setTimeout: ReturnType<typeof vi.fn> }).setTimeout;
    setTimeoutSpy.mockClear();
    internalOf(hw).connectionManager.onWsDisconnected(conn, bare401);
    expect(conn.authFailCount).toBe(3);
    expect(setTimeoutSpy).not.toHaveBeenCalled(); // 401 → auth-stop even without the canonical code
  });

  it("a network outage is NOT an auth failure — reconnects keep running", () => {
    const { hw, conn } = setup();
    const setTimeoutSpy = (hw as unknown as { setTimeout: ReturnType<typeof vi.fn> }).setTimeout;
    const netErr = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

    // Three network drops in a row. Counting them as auth failures would stop
    // the adapter for good on a device that is simply offline — the exact
    // opposite of "the adapter never gives up" for bad-WiFi devices.
    for (let n = 0; n < 3; n++) {
      setTimeoutSpy.mockClear();
      internalOf(hw).connectionManager.onWsDisconnected(conn, netErr);
      expect(setTimeoutSpy, `reconnect still scheduled after drop ${n + 1}`).toHaveBeenCalled();
    }
    expect(conn.authFailCount).toBe(0);
  });

  it("a device that does not answer logs no warning — offline is a state, info.connected carries it", () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);
    i.connectionManager.onWsDisconnected(
      conn,
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    i.connectionManager.onWsDisconnected(conn, Object.assign(new Error("Timeout: GET /api"), { code: "ETIMEDOUT" }));
    expect(i.log.warn).not.toHaveBeenCalled();
    expect(i.log.info).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("device unreachable (connect ECONNREFUSED)"));

    // …and its return is no news either: nothing was warned that it could close.
    i.connectionManager.onWsConnected(conn);
    expect(i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("connection restored"));
  });

  it("a device error that was warned is closed by one 'connection restored' line", () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);
    i.connectionManager.onWsDisconnected(conn, new HomeWizardApiError(500, "{}", "ws"));
    expect(i.log.warn).toHaveBeenCalledTimes(1);
    i.connectionManager.onWsConnected(conn);
    expect(i.log.info).toHaveBeenCalledWith("P1 (hwe-p1_aabb): connection restored");
  });

  it("repeats of the same error stay on debug — one warn per outage", () => {
    const { hw, conn } = setup();
    const warn = (hw as unknown as { log: { warn: ReturnType<typeof vi.fn> } }).log.warn;
    const srvErr = new HomeWizardApiError(503, "{}", "ws");
    warn.mockClear();

    internalOf(hw).connectionManager.onWsDisconnected(conn, srvErr);
    internalOf(hw).connectionManager.onWsDisconnected(conn, srvErr);
    internalOf(hw).connectionManager.onWsDisconnected(conn, srvErr);
    // A device that keeps failing the same way — a warn per failure floods the log
    // that a real problem would have to be found in.
    expect(warn.mock.calls.length, "one warn for a repeating failure").toBe(1);

    // The repeats must go down the plain repeat-path, NOT the cooldown path:
    // "(cooldown)" means "a NEW error category, suppressed for now" and sends
    // whoever reads the log looking for a second, different fault.
    const debug = (hw as unknown as { log: { debug: ReturnType<typeof vi.fn> } }).log.debug;
    const cooldownLines = debug.mock.calls.filter(c => String(c[0]).includes("(cooldown)"));
    expect(cooldownLines, "a repeat is not a cooldown-suppressed new category").toHaveLength(0);
  });

  it("M1: a single outage with failed reconnects does not flip the device to unstable", () => {
    const { hw, conn } = setup();
    const api = internalOf(hw).connectionManager;
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
    internalOf(hw).connectionManager.onWsConnected(conn);
    expect(conn.wsAuthenticated).toBe(true);
    expect(conn.wsFailCount).toBe(0);
    expect(conn.authFailCount).toBe(0);
    expect(conn.lastErrorCode).toBe("");
    expect(stateMgr.setDeviceConnected).toHaveBeenCalledWith(conn.config, true);
  });

  it("onWsBattery forwards a push when batteries are connected (battery_count > 0)", () => {
    const { hw, conn, stateMgr } = setup();
    internalOf(hw).connectionManager.onWsBattery(conn, {
      mode: "zero",
      battery_count: 2,
    });
    expect(stateMgr.updateBattery).toHaveBeenCalled();
  });

  it("onWsBattery drops a push without battery_count (gate, consistent with the REST poll)", () => {
    const { hw, conn, stateMgr } = setup();
    internalOf(hw).connectionManager.onWsBattery(conn, { mode: "zero" });
    expect(stateMgr.updateBattery).not.toHaveBeenCalled();
  });

  it("onWsBattery drops a push for a device removed mid-flight (race guard)", () => {
    const { hw, conn, stateMgr } = setup();
    conn.removed = true;
    internalOf(hw).connectionManager.onWsBattery(conn, {
      mode: "zero",
      battery_count: 2,
    });
    expect(stateMgr.updateBattery).not.toHaveBeenCalled();
  });

  it("onWsSystem forwards a push to updateSystem", () => {
    const { hw, conn, stateMgr } = setup();
    internalOf(hw).connectionManager.onWsSystem(conn, {
      cloud_enabled: true,
    });
    expect(stateMgr.updateSystem).toHaveBeenCalled();
  });

  it("onWsSystem drops a push while a previous system write is in flight (L8 backpressure)", () => {
    const { hw, conn, stateMgr } = setup();
    conn.systemBusy = true;
    internalOf(hw).connectionManager.onWsSystem(conn, {
      cloud_enabled: true,
    });
    expect(stateMgr.updateSystem).not.toHaveBeenCalled();
  });

  it("onWsBattery drops a push while a previous battery write is in flight (L8 backpressure)", () => {
    const { hw, conn, stateMgr } = setup();
    conn.batteryBusy = true;
    internalOf(hw).connectionManager.onWsBattery(conn, {
      mode: "zero",
      battery_count: 2,
    });
    expect(stateMgr.updateBattery).not.toHaveBeenCalled();
  });

  it("onWsDisconnected clamps the reconnect delay tighter for an unstable device", () => {
    // Unstable device (recentDisconnects already past threshold) → 60s cap.
    const u = setup();
    u.conn.recentDisconnects = 3; // isUnstable → true
    u.conn.wsFailCount = 10; // exponential backoff would far exceed any cap
    const uSetTimeout = (u.hw as unknown as { setTimeout: ReturnType<typeof vi.fn> }).setTimeout;
    internalOf(u.hw).connectionManager.onWsDisconnected(u.conn);
    const unstableDelay = uSetTimeout.mock.calls[0][1] as number;

    // Stable device, same fail count → the normal 5-min cap.
    const s = setup();
    s.conn.recentDisconnects = 0; // isUnstable → false
    s.conn.wsFailCount = 10;
    const sSetTimeout = (s.hw as unknown as { setTimeout: ReturnType<typeof vi.fn> }).setTimeout;
    internalOf(s.hw).connectionManager.onWsDisconnected(s.conn);
    const stableDelay = sSetTimeout.mock.calls[0][1] as number;

    expect(unstableDelay).toBeLessThanOrEqual(60_000);
    expect(stableDelay).toBeGreaterThan(60_000);
  });
});

/**
 * Typed access to private fields/methods used by the orchestration tests below.
 *
 * @param hw Adapter instance under test
 */
function internalOf(hw: HomeWizard): {
  pairingManager: {
    active: boolean;
    pairing: boolean;
    discovered: DiscoveredDevice[];
    start: () => Promise<void>;
    poll: () => Promise<void>;
    stop: () => void;
    onDeviceDiscovered: (d: DiscoveredDevice) => void;
  };
  discovery: FakeDiscovery | null;
  systemPollTimer: unknown;
  ipRecoveryTimer: unknown;
  connections: Map<string, DeviceConnection>;
  config: Record<string, unknown>;
  log: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  getStateAsync: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  clearTimeout: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
  decrypt: ReturnType<typeof vi.fn>;
  encrypt: ReturnType<typeof vi.fn>;
  getAdapterObjectsAsync: ReturnType<typeof vi.fn>;
  getObjectAsync: ReturnType<typeof vi.fn>;
  delObjectAsync: ReturnType<typeof vi.fn>;
  extendObject: ReturnType<typeof vi.fn>;
  getForeignObjectAsync: ReturnType<typeof vi.fn>;
  extendForeignObjectAsync: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
  setStateChangedAsync: ReturnType<typeof vi.fn>;
  subscribeStatesAsync: ReturnType<typeof vi.fn>;
  startIpRecovery: () => void;
  loadDevicesFromObjects: (objects: Record<string, unknown>) => Promise<unknown[]>;
  saveDeviceToObject: (c: unknown) => Promise<void>;
  onReady: () => Promise<void>;
  onUnload: (cb: () => void) => void;
  removeDevice: (id: string) => Promise<void>;
  connectionManager: {
    connections: Map<string, DeviceConnection>;
    lastWarnAt: Map<string, number>;
    lastInfoAt: Map<string, number>;
    onWsMeasurement: (c: DeviceConnection, d: unknown) => void;
    onWsSystem: (c: DeviceConnection, d: unknown) => void;
    onWsBattery: (c: DeviceConnection, d: unknown) => void;
    onWsConnected: (c: DeviceConnection) => void;
    onWsDisconnected: (c: DeviceConnection, e?: Error) => void;
    isUnstable: (c: DeviceConnection) => boolean;
    isDeviceOnline: (c: DeviceConnection) => boolean;
    startRestFallback: (c: DeviceConnection) => void;
    pollSystemInfo: (c: DeviceConnection) => Promise<void>;
    pollAllSystemInfo: () => Promise<void>;
    initDevice: (c: DeviceConnection) => Promise<void>;
    connectWebSocket: (c: DeviceConnection) => void;
    dropCooldowns: (serial: string) => void;
    handleAuthFailure: (c: DeviceConnection, e: unknown, cleanupTimers: boolean) => boolean;
    refreshGroup: (c: DeviceConnection, group: "system" | "battery") => Promise<void>;
  };
} {
  return hw as unknown as ReturnType<typeof internalOf>;
}

describe("HomeWizard startPairing", () => {
  it("mDNS path: resets the button, starts discovery and installs poll + timeout timers", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    await i.pairingManager.start();

    expect(i.setState).toHaveBeenCalledWith("startPairing", { val: false, ack: true });
    expect(discovery.start).toHaveBeenCalledTimes(1);
    expect(i.setInterval).toHaveBeenCalled(); // pairing poll
    expect(i.setTimeout).toHaveBeenCalled(); // 60 s window
    expect(i.pairingManager.active).toBe(true);
  });

  it("is a no-op when pairing is already active", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    await i.pairingManager.start();
    await i.pairingManager.start();
    expect(discovery.start).toHaveBeenCalledTimes(1);
  });

  it("manual-IP path: uses the IP from pairingIp, clears the state, skips mDNS", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    i.getStateAsync.mockResolvedValueOnce({ val: "192.168.1.50" });
    await i.pairingManager.start();

    expect(i.pairingManager.discovered).toHaveLength(1);
    expect(i.pairingManager.discovered[0].ip).toBe("192.168.1.50");
    expect(i.setState).toHaveBeenCalledWith("pairingIp", { val: "", ack: true });
    expect(discovery.start).not.toHaveBeenCalled();
  });

  it("manual-IP path: rejects a malformed IP fast (warn, no pairing window)", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.getStateAsync.mockResolvedValueOnce({ val: "999.1.2.3" });
    await i.pairingManager.start();

    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Invalid pairing IP"));
    expect(i.pairingManager.active).toBe(false);
    expect(i.pairingManager.discovered).toHaveLength(0);
  });

  // DD23: a typed address is checked less strictly than an mDNS one — a home network
  // on a public range is rare but real, and nobody types an address by accident.
  // The mDNS path would drop the same address (isLanDeviceIpv4).
  it("manual-IP path: accepts a public address that the mDNS path would refuse (DD23)", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.getStateAsync.mockResolvedValueOnce({ val: "8.8.4.4" });
    await i.pairingManager.start();

    expect(i.pairingManager.active).toBe(true);
    expect(i.pairingManager.discovered.map(d => d.ip)).toEqual(["8.8.4.4"]);
    expect(i.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("Invalid pairing IP"));
  });

  it("manual-IP path: still refuses loopback (DD23)", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.getStateAsync.mockResolvedValueOnce({ val: "127.0.0.1" });
    await i.pairingManager.start();
    expect(i.pairingManager.active).toBe(false);
  });
});

describe("HomeWizard onDeviceDiscovered", () => {
  it("queues a new device and logs the button-press hint", () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.pairingManager.onDeviceDiscovered({
      ip: "192.168.1.60",
      productType: "HWE-BAT",
      serial: "bat01",
      name: "Battery",
    });
    expect(i.pairingManager.discovered).toHaveLength(1);
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("press the button"));
  });

  it("does not offer a paired, healthy device for pairing — it says once that it is already paired", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    await i.pairingManager.start();
    const announce = { ip: "192.168.1.61", productType: "HWE-P1", serial: "aabb", name: "P1" };
    discovery.callback!(announce);
    discovery.callback!(announce);
    expect(i.pairingManager.discovered).toHaveLength(0);
    const lines = i.log.info.mock.calls.filter((c: unknown[]) => String(c[0]).includes("is already paired"));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toContain("P1 (hwe-p1_aabb) is already paired");
  });

  it("offers a paired device whose token no longer works — 'token invalid — re-pair' can be fixed over mDNS", async () => {
    const { hw, conn, discovery } = setup();
    const i = internalOf(hw);
    conn.authFailCount = 3; // the auth-stop has fired
    await i.pairingManager.start();
    discovery.callback!({ ip: conn.ip, productType: "HWE-P1", serial: "aabb", name: "P1" });
    expect(i.pairingManager.discovered.map((d: DiscoveredDevice) => d.serial)).toEqual(["aabb"]);
  });

  it("skips duplicate discoveries (same serial twice)", () => {
    const { hw } = setup();
    const i = internalOf(hw);
    const d: DiscoveredDevice = { ip: "192.168.1.62", productType: "HWE-KWH1", serial: "kwh01", name: "kWh" };
    i.pairingManager.onDeviceDiscovered(d);
    i.pairingManager.onDeviceDiscovered(d);
    expect(i.pairingManager.discovered).toHaveLength(1);
  });
});

describe("HomeWizard pollPairing", () => {
  it("403 (button not pressed) keeps polling without saving anything", async () => {
    const { hw, client, stateMgr } = setup();
    const i = internalOf(hw);
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.70", productType: "HWE-P1", serial: "new01", name: "P1" }];
    client.requestPairing.mockRejectedValueOnce(
      new HomeWizardApiError(403, JSON.stringify({ error: { code: "user:creation-not-enabled" } }), "POST /api/user"),
    );
    await i.pairingManager.poll();

    expect(stateMgr.createDeviceStates).not.toHaveBeenCalled();
    expect(i.pairingManager.discovered).toHaveLength(1); // still waiting for the button
    // 403 is the EXPECTED state during the whole pairing window (the user has
    // not pressed the button yet). Logging it as an error would put one line
    // every 2 s into the log and send whoever reads it hunting a fault — and as a
    // WARNING it would greet every single pairing attempt.
    const errorLines = i.log.debug.mock.calls.filter((c: unknown[]) => String(c[0]).includes("Pairing poll error"));
    expect(errorLines, "403 is not a pairing error").toHaveLength(0);
    expect(i.log.warn, "the normal 'button not pressed yet' must not warn").not.toHaveBeenCalled();
  });

  // Everything that is not the expected 403 — a mistyped manual IP, a device that
  // does not answer, one whose local API v2 is off — used to be debug-only: the user
  // pressed the button and read nothing but "pairing mode automatically disabled" a
  // minute later.
  it("says once per device why pairing is not getting anywhere, and stays quiet afterwards", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.70", productType: "HWE-P1", serial: "new01", name: "P1" }];
    client.requestPairing.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));

    await i.pairingManager.poll();
    await i.pairingManager.poll();
    await i.pairingManager.poll();

    const warns = i.log.warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("192.168.1.70"));
    expect(warns, "one warning per device and window").toHaveLength(1);
    expect(String(warns[0][0])).toContain("ECONNREFUSED");
    // The hint names the real cause. The app's "Local API" switch is the old v1 API
    // and has nothing to do with v2 pairing (official docs, getting-started).
    expect(String(warns[0][0])).toContain("does not speak API v2");
    expect(String(warns[0][0])).not.toMatch(/local API/i);

    // A new window starts the count over — the user may have fixed the address.
    i.pairingManager.stop();
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.70", productType: "HWE-P1", serial: "new01", name: "P1" }];
    await i.pairingManager.poll();
    expect(i.log.warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("192.168.1.70"))).toHaveLength(2);
  });

  it("success: saves the device, creates states, registers the connection and drops it from the queue", async () => {
    const { hw, client, stateMgr } = setup();
    const i = internalOf(hw);
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.70", productType: "HWE-P1", serial: "new01", name: "P1" }];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "new01", product_name: "P1 Neu" });
    await i.pairingManager.poll();
    await settle();

    expect(client.requestPairing).toHaveBeenCalled();
    expect(i.encrypt).toHaveBeenCalledWith("fresh-token");
    expect(i.extendObject).toHaveBeenCalled(); // saveDeviceToObject
    expect(stateMgr.createDeviceStates).toHaveBeenCalled();
    expect(i.connections.has("hwe-p1_new01")).toBe(true);
    expect(i.pairingManager.discovered).toHaveLength(0);
    // The summary counts the new device right away (set up: 2, answering: 0 —
    // the fresh connection has not authenticated yet).
    expect(stateMgr.writeDeviceRollup).toHaveBeenLastCalledWith(2, 0);
  });

  it("removes the just-paired entry by identity, not serial (D1-1 manual-IP placeholder)", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    // Manual-IP path enqueues a placeholder with serial "unknown"; the device
    // reports its real serial. Filtering by serial would never match → re-POST loop.
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [
      { ip: "192.168.1.71", productType: "unknown", serial: "unknown", name: "192.168.1.71" },
    ];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "real99", product_name: "P1" });
    await i.pairingManager.poll();
    await settle();

    expect(i.pairingManager.discovered).toHaveLength(0); // removed by identity
  });

  it("revokes the just-issued token AND drops the device if setup fails (S1-1/F4, no orphaned token, no mint-loop)", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.72", productType: "HWE-P1", serial: "x", name: "P1" }];
    client.getDeviceInfo.mockRejectedValue(new Error("malformed device info"));
    await i.pairingManager.poll();
    await settle();

    expect(client.deleteUser).toHaveBeenCalled();
    // F4: dropped from the queue so it isn't re-minted+revoked every 2 s for the rest of the window.
    expect(i.pairingManager.discovered).toHaveLength(0);
    expect(i.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("paired, but the device could not be read or stored — token revoked"),
    );
  });

  it("does NOT revoke once the device is stored — a failed data-point create only delays the tree", async () => {
    const { hw, client, stateMgr } = setup();
    const i = internalOf(hw);
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.73", productType: "HWE-P1", serial: "st01", name: "P1" }];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "st01", product_name: "P1 Meter" });
    stateMgr.createDeviceStates.mockRejectedValueOnce(new Error("db write failed"));
    await i.pairingManager.poll();
    await settle();

    // The device object holds the token — revoking it would leave a stored device
    // that can never connect.
    expect(client.deleteUser).not.toHaveBeenCalled();
    expect(i.connections.has("hwe-p1_st01")).toBe(true);
    expect(i.log.warn).toHaveBeenCalledWith(
      "P1 Meter: paired, but its data points could not be created yet (db write failed) — they are created on the next start",
    );
  });

  it("a device answering after the window closed is not stored — and its token is revoked", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.74", productType: "HWE-P1", serial: "late01", name: "P1" }];
    let answer!: (v: { token: string }) => void;
    client.requestPairing.mockReturnValue(new Promise(resolve => (answer = resolve)));
    const pass = i.pairingManager.poll();
    i.pairingManager.stop();
    answer({ token: "late-token" });
    await pass;
    await settle();

    expect(i.extendObject).not.toHaveBeenCalled(); // saveDeviceToObject
    expect(i.connections.has("hwe-p1_late01")).toBe(false);
    expect(client.deleteUser).toHaveBeenCalled();
  });

  it("a device failing after the window closed adds no warning to a window that no longer exists", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.75", productType: "HWE-P1", serial: "late02", name: "P1" }];
    let fail!: (e: unknown) => void;
    client.requestPairing.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const pass = i.pairingManager.poll();
    i.pairingManager.stop();
    fail(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    await pass;
    expect(i.log.warn).not.toHaveBeenCalled();
  });

  it("re-pair of an existing serial tears down the previous connection (no zombie WS)", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    const oldWs = { connect: vi.fn(), close: vi.fn() };
    conn.wsClient = oldWs as unknown as DeviceConnection["wsClient"];
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.5", productType: "HWE-P1", serial: "aabb", name: "P1" }];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "aabb", product_name: "P1" });
    await i.pairingManager.poll();
    await settle();

    expect(oldWs.close).toHaveBeenCalled();
    expect(i.connections.has("hwe-p1_aabb")).toBe(true);
  });

  it("pairs under this instance's own user name and stores it with the device", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.6", productType: "HWE-P1", serial: "un01", name: "P1" }];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "un01", product_name: "P1" });
    await i.pairingManager.poll();
    await settle();

    expect(client.requestPairing).toHaveBeenCalledWith("local/iobroker_iob-host_0");
    expect(i.extendObject).toHaveBeenCalledWith(
      "hwe-p1_un01",
      expect.objectContaining({ native: expect.objectContaining({ userName: "local/iobroker_iob-host_0" }) }),
    );
  });

  it("re-pairing a device paired under the old shared name deletes that old user", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    expect(conn.config.userName).toBeUndefined(); // paired before v0.20.0
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.5", productType: "HWE-P1", serial: "aabb", name: "P1" }];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "aabb", product_name: "P1" });
    await i.pairingManager.poll();
    await settle();

    expect(client.deleteUser).toHaveBeenCalledWith("local/iobroker");
    expect(client.deleteUser).not.toHaveBeenCalledWith("local/iobroker_iob-host_0");
  });

  it("re-pairing under the same name deletes nothing — the new token already replaced the old one", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    conn.config.userName = "local/iobroker_iob-host_0";
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.5", productType: "HWE-P1", serial: "aabb", name: "P1" }];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "aabb", product_name: "P1" });
    await i.pairingManager.poll();
    await settle();

    expect(client.deleteUser).not.toHaveBeenCalled();
  });

  // The old connection can still have work in flight — a system poll or an initDevice
  // sitting in a 10 s timeout. Every one of those checks `removed` after its awaits, and
  // without the mark the tail of that work persists the OLD token over the fresh one and
  // opens a socket for a connection nobody holds any more.
  it("work still running on the replaced connection is stopped, not left to overwrite the new token", async () => {
    const { hw, client, conn, stateMgr, wsInstances } = setup();
    const i = internalOf(hw);
    let releaseInfo!: (v: { product_type: string; serial: string; product_name: string }) => void;
    // The old connection's device-info call hangs; the re-pairing below completes meanwhile.
    client.getDeviceInfo.mockImplementationOnce(() => new Promise(resolve => (releaseInfo = resolve)));
    const pending = i.connectionManager.initDevice(conn);

    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "aabb", product_name: "P1" });
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.9", productType: "HWE-P1", serial: "aabb", name: "P1" }];
    await i.pairingManager.poll();
    await settle();

    expect(conn.removed, "the replaced connection must be marked").toBe(true);
    stateMgr.setProductName.mockClear();
    const socketsAfterRepair = wsInstances.length;

    releaseInfo({ product_type: "HWE-P1", serial: "aabb", product_name: "Renamed while re-pairing" });
    await pending;
    await settle();

    // Nothing from the old connection reached the tree, and it started no second socket.
    expect(stateMgr.setProductName, "the old connection must not write any more").not.toHaveBeenCalled();
    expect(wsInstances.length, "no zombie socket from the replaced connection").toBe(socketsAfterRepair);
  });

  it("a re-paired device is stamped disconnected before its new connection", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    conn.wsClient = { connect: vi.fn(), close: vi.fn() } as unknown as DeviceConnection["wsClient"];
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.5", productType: "HWE-P1", serial: "aabb", name: "P1" }];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "aabb", product_name: "P1" });
    await i.pairingManager.poll();
    await settle();

    // Tearing down the old connection deliberately suppresses the WebSocket's
    // own disconnect handler, so nothing else clears the stale `true`.
    expect(stateMgr.setDeviceConnected).toHaveBeenCalledWith(expect.objectContaining({ serial: "aabb" }), false);
  });

  it("in-flight guard: a second poll while one is running returns without polling again", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.70", productType: "HWE-P1", serial: "new01", name: "P1" }];
    let release!: (v: never) => void;
    client.requestPairing.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          release = reject as (v: never) => void;
        }),
    );
    const first = i.pairingManager.poll();
    await i.pairingManager.poll(); // must bail out via pairingPollBusy
    expect(client.requestPairing).toHaveBeenCalledTimes(1);
    release(new HomeWizardApiError(403, "{}", "POST /api/user") as never);
    await first;
  });
});

describe("HomeWizard stopPairing", () => {
  it("clears the poll + timeout timers and stops mDNS", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    await i.pairingManager.start();
    i.pairingManager.stop();

    expect(i.clearInterval).toHaveBeenCalled();
    expect(i.clearTimeout).toHaveBeenCalled();
    expect(discovery.stop).toHaveBeenCalled();
    expect(i.pairingManager.active).toBe(false);
    expect(i.discovery).toBeNull();
    expect(i.pairingManager.discovered).toHaveLength(0);
  });
});

describe("HomeWizard loadDevicesFromObjects", () => {
  it("loads configs from device objects (decrypting the token)", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    // The caller (onReady) holds the namespace's objects and hands them in — the
    // loader must not query the object store a second time.
    const objects = {
      "homewizard.0.hwe-p1_dev1": {
        type: "device",
        native: { encryptedToken: "tok1", serial: "dev1", productType: "HWE-P1", productName: "P1", ip: "192.168.1.8" },
      },
      "homewizard.0.hwe-p1_dev1.info": { type: "channel", native: {} },
    };
    const devices = (await i.loadDevicesFromObjects(objects)) as Array<{ serial: string; token: string; ip?: string }>;

    expect(i.getAdapterObjectsAsync).not.toHaveBeenCalled();

    expect(devices).toHaveLength(1);
    expect(devices[0].serial).toBe("dev1");
    expect(devices[0].token).toBe("tok1"); // decrypt stub is identity
    expect(devices[0].ip).toBe("192.168.1.8");
  });

  it("skips a device object that carries no token", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    const objects = {
      // A half-written object (interrupted pairing, manual DB edit): loading it
      // would put a device into the connection list whose every request goes
      // out without a bearer token → an endless 401 loop against the device.
      "homewizard.0.hwe-p1_notoken": {
        type: "device",
        native: { serial: "notoken", productType: "HWE-P1", productName: "P1" },
      },
      "homewizard.0.hwe-p1_ok": {
        type: "device",
        native: { encryptedToken: "tok", serial: "ok", productType: "HWE-P1", productName: "P1" },
      },
    };

    const devices = (await i.loadDevicesFromObjects(objects)) as Array<{ serial: string }>;
    expect(devices.map(d => d.serial)).toEqual(["ok"]);
    // …and it says so, instead of letting the device vanish without a word: the
    // user is left with a folder of data points that never update again.
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("hwe-p1_notoken"));
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("'remove'"));
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
    const objects = {
      "homewizard.0.hwe-p1_bad": {
        type: "device",
        native: { encryptedToken: "BROKEN", serial: "bad", productType: "HWE-P1", productName: "P1" },
      },
      "homewizard.0.hwe-p1_good": {
        type: "device",
        native: { encryptedToken: "tok-good", serial: "good", productType: "HWE-P1", productName: "P1" },
      },
    };
    const devices = (await i.loadDevicesFromObjects(objects)) as Array<{ serial: string }>;

    expect(devices).toHaveLength(1);
    expect(devices[0].serial).toBe("good");
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Cannot decrypt token"));
  });

  it("migrates legacy native.devices configs to device objects and clears the old config", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.config.devices = [{ token: "legacy-tok", productType: "HWE-P1", serial: "leg01", productName: "P1" }];
    const devices = (await i.loadDevicesFromObjects({})) as Array<{ serial: string }>;

    expect(devices).toHaveLength(1);
    expect(devices[0].serial).toBe("leg01");
    expect(i.extendObject).toHaveBeenCalled(); // saveDeviceToObject
    expect(i.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.homewizard.0", {
      native: { devices: [] },
    });
  });
});

describe("HomeWizard saveDeviceToObject", () => {
  it("round-trips: the stored ciphertext is decrypted back to the token on load", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    await i.saveDeviceToObject({ token: "secret", productType: "HWE-P1", serial: "rt1", productName: "P1" });
    const stored = (i.extendObject.mock.calls.at(-1) as unknown[])[1] as { type: string; native: unknown };
    expect((stored.native as { encryptedToken: string }).encryptedToken).not.toBe("secret");

    const loaded = await i.loadDevicesFromObjects({ "homewizard.0.hwe-p1_rt1": stored });
    expect(loaded).toEqual([expect.objectContaining({ token: "secret", serial: "rt1" })]);
    expect(i.decrypt).toHaveBeenCalledWith("enc:secret");
  });

  it("stores the encrypted token in device-object native and writes the name unconditionally", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    await i.saveDeviceToObject({ token: "tok", productType: "HWE-P1", serial: "s1", productName: "Mein P1" });

    expect(i.encrypt).toHaveBeenCalledWith("tok");
    // No options argument: `preserve` would freeze whatever name is stored, and the
    // adapter owns every name in its own tree — this one is the product name the
    // device reports.
    expect(i.extendObject).toHaveBeenCalledWith("hwe-p1_s1", {
      type: "device",
      common: { name: "Mein P1" },
      // The stored field carries what encrypt() returned — never the plain token.
      native: expect.objectContaining({ encryptedToken: "enc:tok", serial: "s1" }),
    });
  });
});

describe("HomeWizard initDevice", () => {
  it("writes the firmware state, connects the WebSocket and polls system info", async () => {
    const { hw, client, conn, stateMgr, wsInstances } = setup();
    const i = internalOf(hw);
    client.getDeviceInfo.mockResolvedValue({ product_name: "P1", firmware_version: "6.4" });
    await i.connectionManager.initDevice(conn);
    await settle();

    expect(stateMgr.setFirmware).toHaveBeenCalledWith(conn.config, "6.4");
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
    await i.connectionManager.initDevice(conn);
    await settle();

    expect(conn.config.certCn).toBe("appliance/p1dongle/aabb");
    expect(i.extendObject).toHaveBeenCalledWith(
      "hwe-p1_aabb",
      expect.objectContaining({ native: expect.objectContaining({ certCn: "appliance/p1dongle/aabb" }) }),
    );
  });

  it("F3: syncs a downtime-rename from the initial getDeviceInfo without a second round-trip", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    conn.config.productName = "Old Name";
    client.getDeviceInfo.mockResolvedValue({ product_name: "New Name", firmware_version: "6.4" });
    await i.connectionManager.initDevice(conn);
    await settle();

    expect(conn.config.productName).toBe("New Name");
    expect(client.getDeviceInfo).toHaveBeenCalledTimes(1); // initDevice's fetch only — no extra drift fetch
    expect(i.extendObject).toHaveBeenCalled(); // persisted via saveDeviceToObject
    // …and the data point that shows the device's product name follows along.
    // Without this it kept the name from the last adapter start.
    expect(stateMgr.setProductName).toHaveBeenCalledWith(conn.config);
  });

  it("writes the firmware on every device-info sync, not only on a rename", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    conn.config.productName = "P1";
    client.getDeviceInfo.mockResolvedValue({ product_name: "P1", firmware_version: "7.0" });
    await i.connectionManager.initDevice(conn);
    await settle();

    expect(stateMgr.setFirmware).toHaveBeenCalledWith(conn.config, "7.0");
    expect(stateMgr.setProductName).not.toHaveBeenCalled();
  });

  it("a device that reports no firmware version writes none — the connection still comes up", async () => {
    const { hw, client, conn, stateMgr, wsInstances } = setup();
    const i = internalOf(hw);
    client.getDeviceInfo.mockResolvedValue({ product_name: "P1" });
    await i.connectionManager.initDevice(conn);
    await settle();

    expect(stateMgr.setFirmware).not.toHaveBeenCalled();
    expect(wsInstances).toHaveLength(1);
  });

  it("does nothing for a device removed mid-flight", async () => {
    const { hw, conn, wsInstances } = setup();
    const i = internalOf(hw);
    conn.removed = true;
    await i.connectionManager.initDevice(conn);
    expect(wsInstances).toHaveLength(0);
  });

  it("still connects the WebSocket when the initial info fetch fails (offline at boot)", async () => {
    const { hw, client, conn, wsInstances } = setup();
    const i = internalOf(hw);
    const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    client.getDeviceInfo.mockRejectedValueOnce(err);
    await i.connectionManager.initDevice(conn);
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
    expect(i.extendObject).toHaveBeenCalled(); // IP persisted
    expect(wsInstances).toHaveLength(1); // immediate reconnect
  });

  it("ignores a broadcast with the unchanged IP", () => {
    const { hw, conn, discovery, wsInstances } = setup();
    const i = internalOf(hw);
    i.startIpRecovery();
    discovery.callback!({ ip: conn.ip, productType: "HWE-P1", serial: "aabb", name: "P1" });
    expect(wsInstances).toHaveLength(0);
  });

  // The production path, not a hand-set flag: connectWebSocket asks for recovery and
  // THEN opens the socket to the old (dead) address, so the device's answer always
  // arrives while that connect hangs. Dropping it — as the old `recovering` guard did —
  // wasted the only announcement of the whole window (bonjour-service announces a
  // service once per browser run), and the device stayed unreachable.
  it("takes the new IP from an answer that arrives while the connect to the old one hangs", () => {
    const { hw, conn, discovery, wsInstances } = setup();
    const i = internalOf(hw);
    conn.wsFailCount = 3; // third failure — this is the tick that asks mDNS
    conn.reconnectTimer = { id: "pending" } as unknown as ioBroker.Timeout;

    i.connectionManager.connectWebSocket(conn);

    expect(discovery.start).toHaveBeenCalled();
    expect(wsInstances).toHaveLength(1); // the doomed connect to the old address
    discovery.callback!({ ip: "10.0.0.99", productType: "HWE-P1", serial: "aabb", name: "P1" });

    expect(conn.ip).toBe("10.0.0.99");
    expect(conn.config.ip).toBe("10.0.0.99");
    expect(conn.wsFailCount).toBe(0);
    expect(i.extendObject).toHaveBeenCalled(); // new IP persisted
    expect(wsInstances).toHaveLength(2); // reconnect to the new address
    expect(wsInstances[0].close).toHaveBeenCalled(); // the pending one is dropped
    expect(conn.reconnectTimer).toBeUndefined(); // and so is its backoff timer
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("found at new IP 10.0.0.99"));
  });

  it("shares the browser with an open pairing window — a known device at a new IP is still switched over", async () => {
    const { hw, conn, discovery, wsInstances } = setup();
    const i = internalOf(hw);
    await i.pairingManager.start();
    i.startIpRecovery();
    discovery.callback!({ ip: "10.0.0.77", productType: "HWE-P1", serial: "aabb", name: "P1" });
    await settle();
    expect(conn.ip).toBe("10.0.0.77");
    expect(wsInstances).toHaveLength(1);
  });

  it("restarts the browser when a second request comes while a search is running", () => {
    // bonjour-service reports a service once per browser run: a running browser
    // cannot hear device B any more if it already reported B before B moved.
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    i.startIpRecovery();
    i.startIpRecovery();
    expect(discovery.start).toHaveBeenCalledTimes(2);
  });

  it("keeps the browser for an open recovery window when the pairing window closes", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    i.startIpRecovery();
    await i.pairingManager.start();
    i.pairingManager.stop();
    expect(discovery.stop).not.toHaveBeenCalled();
    // …and releases it once recovery is over too.
    (i as unknown as { stopIpRecovery: () => void }).stopIpRecovery();
    expect(discovery.stop).toHaveBeenCalled();
  });

  it("does not start a search once the adapter is shutting down", () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    (i as unknown as { unloading: boolean }).unloading = true;
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

    expect(i.setState).toHaveBeenCalledWith("startPairing", { val: false, ack: true });
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

  it("skips a device entry whose serial is not text and starts the others", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.connections.clear();
    i.getAdapterObjectsAsync.mockResolvedValue({
      "homewizard.0.hwe-p1_bad": {
        type: "device",
        native: { encryptedToken: "tokX", serial: 12345, productType: "HWE-P1", ip: "192.168.1.9" },
      },
      "homewizard.0.hwe-p1_dev1": {
        type: "device",
        native: { encryptedToken: "tok1", serial: "dev1", productType: "HWE-P1", productName: "P1", ip: "192.168.1.8" },
      },
    });
    await i.onReady();
    await settle();

    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("hwe-p1_bad: device entry is incomplete"));
    expect([...i.connections.keys()]).toEqual(["hwe-p1_dev1"]);
    expect(i.setInterval).toHaveBeenCalled(); // system poll
  });

  it("one device failing its setup does not stop the others, the poll timer or the summary", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.connections.clear();
    i.getAdapterObjectsAsync.mockResolvedValue({
      "homewizard.0.hwe-p1_dev1": {
        type: "device",
        native: { encryptedToken: "tok1", serial: "dev1", productType: "HWE-P1", productName: "P1", ip: "192.168.1.8" },
      },
      "homewizard.0.hwe-p1_dev2": {
        type: "device",
        native: { encryptedToken: "tok2", serial: "dev2", productType: "HWE-P1", productName: "P1", ip: "192.168.1.7" },
      },
    });
    // onReady builds its own StateManager — make the object write for the first
    // device's tree fail, the way a database hiccup would.
    i.extendObject.mockImplementation((id: string) =>
      id === "hwe-p1_dev1" ? Promise.reject(new Error("db write failed")) : Promise.resolve(),
    );
    await i.onReady();
    await settle();

    expect(i.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("P1 (hwe-p1_dev1): could not be set up (db write failed)"),
    );
    expect(i.connections.has("hwe-p1_dev2")).toBe(true);
    expect(i.setInterval).toHaveBeenCalled();
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.devicesTotal", { val: 1, ack: true });
    expect(i.log.error).not.toHaveBeenCalledWith(expect.stringContaining("onReady failed"));
  });

  it("sweeps a stored device's moved paths off the object list it already holds", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.connections.clear();
    i.getAdapterObjectsAsync.mockResolvedValue({
      "homewizard.0.hwe-p1_dev1": {
        type: "device",
        native: { encryptedToken: "tok1", serial: "dev1", productType: "HWE-P1", productName: "P1", ip: "192.168.1.8" },
      },
      // Pre-measurement/ layout: `external` sat at the device root.
      "homewizard.0.hwe-p1_dev1.external": { type: "channel", native: {} },
    });
    await i.onReady();
    await settle();

    // The real StateManager's cleanupMovedStates runs off the id set the device load
    // fetched anyway — nothing else in onReady deletes objects (mutation H35, 2026-09-08).
    expect(i.delObjectAsync).toHaveBeenCalledWith("hwe-p1_dev1.external", { recursive: true });
  });
});

describe("HomeWizard onUnload", () => {
  it("clears all global timers, tears down connections and always calls the callback", async () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);
    await i.pairingManager.start(); // installs the pairing window's timers + discovery
    // The two timers main owns itself. Asserting `undefined` on them without setting
    // them first proves nothing — and `pairingTimer`/`pairingPollTimer` are not even
    // fields of the adapter any more (they moved into the pairing manager), so those
    // assertions held on any object at all.
    const systemPoll = { id: "system-poll" };
    const ipRecovery = { id: "ip-recovery" };
    i.systemPollTimer = systemPoll;
    i.ipRecoveryTimer = ipRecovery;
    const ws = { connect: vi.fn(), close: vi.fn() };
    conn.wsClient = ws as unknown as DeviceConnection["wsClient"];
    conn.pollTimer = {} as never;
    conn.reconnectTimer = {} as never;

    const callback = vi.fn();
    await new Promise<void>(resolve => i.onUnload(() => (callback(), resolve())));

    expect(callback).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalled();
    expect(i.connections.size).toBe(0);
    expect(i.clearInterval).toHaveBeenCalledWith(systemPoll);
    expect(i.clearTimeout).toHaveBeenCalledWith(ipRecovery);
    expect(i.systemPollTimer).toBeUndefined();
    expect(i.ipRecoveryTimer).toBeUndefined();
    expect(i.pairingManager.active, "the pairing window is closed too").toBe(false);
    expect(conn.pollTimer).toBeUndefined();
    expect(conn.reconnectTimer).toBeUndefined();
  });

  it("marks every device disconnected and zeroes the online count", async () => {
    const { hw, conn, stateMgr } = setup();
    const i = internalOf(hw);

    await new Promise<void>(resolve => i.onUnload(resolve));

    // Nothing else resets these: closing the WebSocket suppresses its own
    // disconnect handler, so without this the whole tree stays green.
    expect(stateMgr.markAllDisconnected).toHaveBeenCalledWith([conn.config]);
    expect(i.setState).toHaveBeenCalledWith("info.connection", { val: false, ack: true });
    // The device count survives — how many are set up does not change because
    // the adapter is off; only how many answer does.
    expect(stateMgr.writeDeviceRollup).toHaveBeenCalledWith(1, 0);
  });

  it("reports done only after the last write has landed", async () => {
    const { hw, stateMgr } = setup();
    const i = internalOf(hw);

    // Settle a turn LATER than the call — a write that resolves synchronously
    // would let this pass even with the callback fired first.
    const order: string[] = [];
    stateMgr.markAllDisconnected.mockImplementation(
      async () => new Promise<void>(r => globalThis.setTimeout(() => (order.push("markers"), r()), 0)),
    );

    await new Promise<void>(resolve => i.onUnload(() => (order.push("callback"), resolve())));

    expect(order).toEqual(["markers", "callback"]);
  });

  it("still reports done when a final write is rejected", async () => {
    const { hw, stateMgr } = setup();
    const i = internalOf(hw);
    stateMgr.markAllDisconnected.mockRejectedValue(new Error("database gone"));

    // A teardown that never calls back is killed by js-controller, and an
    // unhandled rejection turns an orderly stop into a crash.
    const callback = vi.fn();
    await new Promise<void>(resolve => i.onUnload(() => (callback(), resolve())));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Final shutdown write failed"));
  });
});

describe("HomeWizard onUnload before the start-up got anywhere", () => {
  it("still writes info.connection and reports done when no state manager was ever built", async () => {
    // The stopInstance correction returns from onReady BEFORE the state manager
    // exists, and the host then restarts the instance — so this unload runs on a
    // process that never built one. It used to throw inside the teardown
    // ("Teardown failed") and skip even the info.connection write.
    const hw = new HomeWizard();
    const i = internalOf(hw);
    const callback = vi.fn();

    await new Promise<void>(resolve => i.onUnload(() => (callback(), resolve())));

    expect(callback).toHaveBeenCalledTimes(1);
    expect(i.setState).toHaveBeenCalledWith("info.connection", { val: false, ack: true });
    expect(i.log.debug).not.toHaveBeenCalledWith(expect.stringContaining("Teardown failed"));
  });
});

describe("HomeWizard onStateChange acks the value it sent, not the raw write", () => {
  it("cloud_enabled written as the string 'true' is sent and acked as boolean true", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.cloud_enabled", active("true"));
    expect(client.setSystem).toHaveBeenCalledWith({ cloud_enabled: true });
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.cloud_enabled", {
      val: true,
      ack: true,
    });
  });

  it("charge_to_full written as 0 is sent and acked as boolean false", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.charge_to_full", active(0));
    expect(client.setBatteries).toHaveBeenCalledWith({ charge_to_full: false });
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.battery.charge_to_full", {
      val: false,
      ack: true,
    });
  });

  it("cloud_enabled written as the text 'false' switches the cloud OFF, not on", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.cloud_enabled", active("false"));
    expect(client.setSystem).toHaveBeenCalledWith({ cloud_enabled: false });
  });

  it("api_v1_enabled written as 'yes' is refused with a warning — nothing reaches the device", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.api_v1_enabled", active("yes"));
    expect(client.setSystem).not.toHaveBeenCalled();
    expect(i.log.warn).toHaveBeenCalledWith("Invalid api_v1_enabled value 'yes' — expected true or false");
    expect(i.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("enabling the legacy v1 API"));
  });

  it("charge_to_full written as 'on' is refused — nothing reaches the device", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.charge_to_full", active("on"));
    expect(client.setBatteries).not.toHaveBeenCalled();
  });

  it("a button written false does NOT fire — a script resetting system.reboot must not reboot the device", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.reboot", active(false));
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.identify", active("false"));
    expect(client.reboot).not.toHaveBeenCalled();
    expect(client.identify).not.toHaveBeenCalled();
    // …but it is still acknowledged back to false, so it does not stay unconfirmed.
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.reboot", { val: false, ack: true });
  });

  it("startPairing written as the text 'false' opens no pairing window", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.startPairing", active("false"));
    expect(i.pairingManager.active).toBe(false);
  });

  it("api_v1_enabled written as 1 is sent and acked as boolean true", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.api_v1_enabled", active(1));
    expect(client.setSystem).toHaveBeenCalledWith({ api_v1_enabled: true });
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.api_v1_enabled", {
      val: true,
      ack: true,
    });
  });
});

describe("HomeWizard onWsMeasurement", () => {
  it("forwards a push to updateMeasurement", () => {
    const { hw, conn, stateMgr } = setup();
    internalOf(hw).connectionManager.onWsMeasurement(conn, { power_w: 42 });
    expect(stateMgr.updateMeasurement).toHaveBeenCalledWith(conn.config, { power_w: 42 }, expect.any(Function));
  });

  it("catches a rejected write (transient Redis hiccup) as debug instead of an unhandled rejection", async () => {
    const { hw, conn, stateMgr } = setup();
    const i = internalOf(hw);
    stateMgr.updateMeasurement.mockImplementation(() => {
      return Promise.reject(new Error("redis hiccup"));
    });
    i.connectionManager.onWsMeasurement(conn, { power_w: 42 });
    await settle();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("redis hiccup"));
  });
});

describe("every connection to a paired device carries its certificate pin", () => {
  // Without certCn/serial a client falls back to the blanket agent — the token then
  // goes to whatever answers at the address, CN unchecked. A lost argument at any of
  // the call sites stayed green while the factories dropped them.
  it("REST, WebSocket, commands, polls, read-backs, removal and the old-user delete", async () => {
    const { hw, conn, clientCalls, wsArgs, client } = setup();
    const i = internalOf(hw);
    conn.config.certCn = "appliance/p1dongle/aabb";

    await i.connectionManager.initDevice(conn);
    await settle();
    i.connectionManager.connectWebSocket(conn);
    conn.pollTimer = undefined;
    i.connectionManager.startRestFallback(conn);
    await (i.setInterval.mock.calls.at(-1)![0] as () => Promise<void>)();
    await i.connectionManager.pollSystemInfo(conn);
    await i.connectionManager.refreshGroup(conn, "system");
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.cloud_enabled", active(true));

    // Re-pair under the new name: the old user is deleted over the OLD pinned connection.
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered = [{ ip: "192.168.1.5", productType: "HWE-P1", serial: "aabb", name: "P1" }];
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "aabb", product_name: "P1" });
    await i.pairingManager.poll();
    await settle();
    await call(hw, "removeDevice", "homewizard.0.hwe-p1_aabb.remove");
    await settle();

    // Pairing itself runs before the identity is known (DD7) — everything else is pinned.
    const established = clientCalls.filter(([, token]) => token === "tok");
    expect(established.length).toBeGreaterThanOrEqual(6);
    for (const [, , certCn, serial] of established) {
      expect([certCn, serial]).toEqual(["appliance/p1dongle/aabb", "aabb"]);
    }
    expect(wsArgs[0]).toMatchObject({ certCn: "appliance/p1dongle/aabb", serial: "aabb" });
  });
});

describe("HomeWizard refreshGroup", () => {
  it("a battery read-back with no battery on the meter creates no battery branch", async () => {
    const { hw, client, conn, stateMgr } = setup();
    client.getBatteries.mockResolvedValue({ mode: "zero", battery_count: 0 });
    await internalOf(hw).connectionManager.refreshGroup(conn, "battery");
    expect(stateMgr.updateBattery).not.toHaveBeenCalled();

    client.getBatteries.mockResolvedValue({ mode: "zero", battery_count: 1 });
    await internalOf(hw).connectionManager.refreshGroup(conn, "battery");
    expect(stateMgr.updateBattery).toHaveBeenCalledTimes(1);
  });
});

describe("HomeWizard pollSystemInfo", () => {
  it("updates system states and skips batteries on 404 (device does not manage any)", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    client.getBatteries.mockRejectedValue(new HomeWizardApiError(404, "{}", "GET /api/batteries"));
    await i.connectionManager.pollSystemInfo(conn);

    expect(stateMgr.updateSystem).toHaveBeenCalled();
    expect(stateMgr.updateBattery).not.toHaveBeenCalled();
    expect(i.log.warn).not.toHaveBeenCalled();
  });

  it("never asks a Plug-In Battery for /api/batteries — the route lives on the meter (docs/v2/batteries)", async () => {
    const { hw, client, conn, stateMgr } = setup();
    conn.config.productType = "HWE-BAT";
    await internalOf(hw).connectionManager.pollSystemInfo(conn);
    expect(stateMgr.updateSystem).toHaveBeenCalled();
    expect(client.getBatteries).not.toHaveBeenCalled();
    expect(stateMgr.updateBattery).not.toHaveBeenCalled();
  });

  it("updates battery states when batteries are connected", async () => {
    const { hw, client, conn, stateMgr } = setup();
    client.getBatteries.mockResolvedValue({ mode: "zero", battery_count: 2 });
    await internalOf(hw).connectionManager.pollSystemInfo(conn);
    expect(stateMgr.updateBattery).toHaveBeenCalledWith(
      conn.config,
      { mode: "zero", battery_count: 2 },
      expect.any(Function),
    );
  });

  it("a device removed while its system poll hangs logs nothing when the request then fails", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    let fail!: (e: unknown) => void;
    client.getSystem.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const poll = i.connectionManager.pollSystemInfo(conn);
    conn.removed = true;
    fail(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    await poll;
    expect(i.log.warn).not.toHaveBeenCalled();
    expect(i.log.info).not.toHaveBeenCalled();
  });

  it("syncs productName drift on the periodic (every 10th) poll (I7/F3)", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    conn.systemPollCount = 9; // next poll is the 10th → drift check fires
    client.getDeviceInfo.mockResolvedValue({ product_name: "P1 Umbenannt" });
    await i.connectionManager.pollSystemInfo(conn);

    expect(client.getDeviceInfo).toHaveBeenCalled();
    expect(conn.config.productName).toBe("P1 Umbenannt");
    expect(i.extendObject).toHaveBeenCalled(); // persisted
    expect(stateMgr.setProductName).toHaveBeenCalledWith(conn.config);
  });

  it("picks up a firmware update on the periodic poll — not only at adapter start", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    conn.systemPollCount = 9;
    // Same name, new firmware: a device updates itself while the adapter runs, and
    // the version was written exactly once — at start-up — so it stayed stale until
    // the next restart, however long that took.
    client.getDeviceInfo.mockResolvedValue({ product_name: conn.config.productName, firmware_version: "7.1" });
    await i.connectionManager.pollSystemInfo(conn);

    expect(stateMgr.setFirmware).toHaveBeenCalledWith(conn.config, "7.1");
  });

  it("a failing device-info refresh is logged, not swallowed", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    conn.systemPollCount = 9;
    client.getDeviceInfo.mockRejectedValueOnce(new Error("boom"));
    await i.connectionManager.pollSystemInfo(conn);

    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("device-info refresh"));
  });

  it("F3: the first poll does not re-fetch getDeviceInfo (initDevice already synced the name)", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    // systemPollCount undefined → the first poll increments to 1 (1 % 10 !== 0).
    await i.connectionManager.pollSystemInfo(conn);

    expect(conn.systemPollCount).toBe(1);
    expect(client.getDeviceInfo).not.toHaveBeenCalled(); // no redundant round-trip
    expect(client.getSystem).toHaveBeenCalled(); // but the system poll itself ran
  });

  it("routes a failing system poll through the dedup logger (first occurrence warns)", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    client.getSystem.mockRejectedValue(new HomeWizardApiError(500, "{}", "GET /api/system"));
    await i.connectionManager.pollSystemInfo(conn);
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("P1 (hwe-p1_aabb) system:"));
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
    await i.connectionManager.pollAllSystemInfo();

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
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.reboot", { val: false, ack: true });
  });

  it("identify button is reset to false/ack after a successful identify", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.identify", active(true));
    expect(client.identify).toHaveBeenCalled();
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.identify", {
      val: false,
      ack: true,
    });
  });

  it("a failed reboot resets the button too, and still warns", async () => {
    // A button left at `true, ack:false` shows as permanently pressed in Admin.
    // The reset belongs in a finally around the device call — but only around
    // that one call, see the LED/switch test below.
    const { hw, client } = setup();
    const i = internalOf(hw);
    client.reboot.mockRejectedValueOnce(new Error("boom"));
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.reboot", active(true));
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.reboot", {
      val: false,
      ack: true,
    });
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to set"));
  });

  it("a failed identify resets its button too", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    client.identify.mockRejectedValueOnce(new Error("boom"));
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.identify", active(true));
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.identify", {
      val: false,
      ack: true,
    });
  });

  it("the button reset does NOT bleed into the non-button branches", async () => {
    // The reset must not sit in a finally around the whole handler: that would
    // overwrite the LED percentage — and every switch ack — with `false`.
    const { hw } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.status_led_brightness_pct", active(40));
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.status_led_brightness_pct", {
      val: 40,
      ack: true,
    });
    expect(i.setState).not.toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.status_led_brightness_pct", {
      val: false,
      ack: true,
    });
  });

  it("removeDevice drops the per-device warn/info cooldown stamps", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.connectionManager.lastWarnAt.set("aabb", 123);
    i.connectionManager.lastInfoAt.set("aabb", 456);
    await i.removeDevice("homewizard.0.hwe-p1_aabb.remove");

    expect(i.connectionManager.lastWarnAt.has("aabb")).toBe(false);
    expect(i.connectionManager.lastInfoAt.has("aabb")).toBe(false);
  });

  it("names the device in its log lines with the folder id — the product name alone is shared by every meter of a type", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    await i.removeDevice("homewizard.0.hwe-p1_aabb.remove");
    expect(i.log.info).toHaveBeenCalledWith("Removing device P1 (hwe-p1_aabb)");

    // The connection layer uses the same label.
    const conn = createDeviceConnection(
      { token: "t", productType: "HWE-P1", serial: "ccdd", productName: "P1" },
      "10.0.0.9",
    );
    for (let n = 0; n < 3; n++) {
      i.connectionManager.handleAuthFailure(conn, new HomeWizardApiError(401, "", "GET /api"), false);
    }
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("P1 (hwe-p1_ccdd): token invalid"));
  });

  it("a write to a state without matching device is surfaced at debug", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-x_unknown.system.reboot", active(true));
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("no matching connected device"));
  });
});

describe("HomeWizard startRestFallback (poll body)", () => {
  /**
   * Start the fallback and return the captured interval callback.
   *
   * @param hw Adapter instance under test
   * @param conn Device connection the fallback polls
   */
  function startAndCapture(hw: HomeWizard, conn: DeviceConnection): () => Promise<void> {
    const i = internalOf(hw);
    internalOf(hw).connectionManager.startRestFallback(conn);
    const lastCall = i.setInterval.mock.calls.at(-1)!;
    return lastCall[0] as () => Promise<void>;
  }

  // The interval is a rule, not a detail: a device with a weak signal polls three
  // times more often, so the gap between two readings stays small while the
  // WebSocket is still reconnecting — that is the whole reason the fallback exists.
  // The rule used to sit in a helper with its own unit test; inlining the helper
  // took the test with it, and nothing went red. A mutation run found it (K26).
  it("polls faster for an unstable device and at the normal rate for a stable one", () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);

    conn.recentDisconnects = 3; // isUnstable → true
    internalOf(hw).connectionManager.startRestFallback(conn);
    expect(i.setInterval.mock.calls.at(-1)![1]).toBe(30_000);

    conn.pollTimer = undefined; // a running timer would make the second call a no-op
    conn.recentDisconnects = 0; // isUnstable → false
    internalOf(hw).connectionManager.startRestFallback(conn);
    expect(i.setInterval.mock.calls.at(-1)![1]).toBe(10_000);
  });

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

  it("another device at the address stops the fallback — even for an unstable device — with one clear warning", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    conn.recentDisconnects = 3; // unstable: a network error would keep it polling
    client.getMeasurement.mockRejectedValue(
      Object.assign(new Error('HomeWizard certificate CN mismatch: expected "a", got "b"'), {
        code: "HW_CERT_IDENTITY",
      }),
    );
    const poll = startAndCapture(hw, conn);
    await poll();
    expect(conn.pollTimer).toBeUndefined();
    expect(i.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/another device answers at .* — its address has probably changed$/),
    );
  });

  it("a device removed while its poll hangs logs nothing when the request then fails", async () => {
    const { hw, client, conn } = setup();
    const i = internalOf(hw);
    let fail!: (e: unknown) => void;
    client.getMeasurement.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const poll = startAndCapture(hw, conn);
    const running = poll();
    conn.removed = true;
    fail(new HomeWizardApiError(500, "{}", "GET /api/measurement"));
    await running;
    expect(i.log.warn).not.toHaveBeenCalled();
    expect(i.log.info).not.toHaveBeenCalled();
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
    internalOf(hw).connectionManager.startRestFallback(conn);
    const after = i.setInterval.mock.calls.length;
    internalOf(hw).connectionManager.startRestFallback(conn);
    expect(i.setInterval.mock.calls.length).toBe(after);
  });

  // The reachability indicators must describe the DEVICE, not one transport.
  // `indicator.reachable` is defined as "if a device is online" — a device that
  // answers every fallback poll is online, whatever the WebSocket is doing.
  it("a device answering the fallback counts as online — marker, summary and system poll", async () => {
    const { hw, conn, stateMgr } = setup();
    const i = internalOf(hw);
    conn.wsAuthenticated = false;
    const poll = startAndCapture(hw, conn);
    await poll();
    await settle();

    expect(conn.restHealthy).toBe(true);
    expect(i.connectionManager.isDeviceOnline(conn)).toBe(true);
    expect(stateMgr.setDeviceConnected).toHaveBeenCalledWith(conn.config, true);
    expect(stateMgr.writeDeviceRollup).toHaveBeenCalledWith(1, 1);

    // ...and it gets its system poll, so wifi_rssi_db/uptime_s do not freeze at
    // the last WebSocket values while the device is on the fallback.
    stateMgr.updateSystem.mockClear();
    await i.connectionManager.pollAllSystemInfo();
    expect(stateMgr.updateSystem).toHaveBeenCalledWith(conn.config, expect.anything(), expect.any(Function));
  });

  it("a failing fallback poll takes the device back offline", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    conn.wsAuthenticated = false;
    conn.recentDisconnects = 3; // unstable: keeps polling instead of stopping
    const poll = startAndCapture(hw, conn);
    await poll();
    await settle();
    expect(conn.restHealthy).toBe(true);

    const err = new Error("connect EHOSTUNREACH") as NodeJS.ErrnoException;
    err.code = "EHOSTUNREACH";
    client.getMeasurement.mockRejectedValue(err);
    stateMgr.setDeviceConnected.mockClear();
    await poll();
    await settle();

    expect(conn.restHealthy).toBe(false);
    expect(i.connectionManager.isDeviceOnline(conn)).toBe(false);
    expect(stateMgr.setDeviceConnected).toHaveBeenCalledWith(conn.config, false);
  });

  it("writes the marker only when the fallback state actually flips", async () => {
    const { hw, conn, stateMgr } = setup();
    conn.wsAuthenticated = false;
    const poll = startAndCapture(hw, conn);
    await poll();
    await settle();
    const afterFirst = stateMgr.setDeviceConnected.mock.calls.length;
    await poll();
    await poll();
    await settle();
    expect(stateMgr.setDeviceConnected.mock.calls.length).toBe(afterFirst);
  });

  it("a reconnected WebSocket ends the fallback's claim on the online state", async () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);
    conn.wsAuthenticated = false;
    const poll = startAndCapture(hw, conn);
    await poll();
    expect(conn.restHealthy).toBe(true);

    i.connectionManager.onWsConnected(conn);
    // The push is back and owns the state again; the stale fallback flag must
    // not keep a dead device green after the socket drops.
    expect(conn.restHealthy).toBe(false);
    expect(i.connectionManager.isDeviceOnline(conn)).toBe(true);
  });
});

describe("HomeWizard connectWebSocket wiring", () => {
  it("the WebSocket client's own log lines name the device", () => {
    const { hw, conn, wsArgs } = setup();
    const i = internalOf(hw);
    i.connectionManager.connectWebSocket(conn);
    const log = wsArgs[0].callbacks.log as { warn: (m: string) => void; debug: (m: string) => void };
    log.warn("WS error: bad frame");
    log.debug("WS open");
    expect(i.log.warn).toHaveBeenCalledWith("P1 (hwe-p1_aabb): WS error: bad frame");
    expect(i.log.debug).toHaveBeenCalledWith("P1 (hwe-p1_aabb): WS open");
  });

  it("gives a Plug-In Battery no battery callback — so it subscribes no batteries topic", () => {
    const { hw, conn, wsArgs } = setup();
    conn.config.productType = "HWE-BAT";
    internalOf(hw).connectionManager.connectWebSocket(conn);
    expect(wsArgs).toHaveLength(1);
    expect("onBattery" in wsArgs[0].callbacks).toBe(false);
    expect(typeof wsArgs[0].callbacks.onSystem).toBe("function");
  });

  it("wires the WS callbacks to the push handlers and the timer deps to adapter timers", () => {
    const { hw, conn, stateMgr, wsArgs } = setup();
    const i = internalOf(hw);
    internalOf(hw).connectionManager.connectWebSocket(conn);
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
    internalOf(hw).connectionManager.connectWebSocket(conn);
    expect(wsInstances).toHaveLength(0);
  });

  it("closes a leftover wsClient before opening the next one (IP-recovery path)", () => {
    const { hw, conn, wsInstances } = setup();
    const leftover = { connect: vi.fn(), close: vi.fn() };
    conn.wsClient = leftover as unknown as DeviceConnection["wsClient"];
    internalOf(hw).connectionManager.connectWebSocket(conn);
    expect(leftover.close).toHaveBeenCalled();
    expect(wsInstances).toHaveLength(1);
  });
});

describe("HomeWizard onWsDisconnected reconnect timer", () => {
  it("the scheduled timer callback re-runs connectWebSocket", () => {
    const { hw, conn, wsInstances } = setup();
    const i = internalOf(hw);
    internalOf(hw).connectionManager.onWsDisconnected(conn);
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
    await i.pairingManager.start();
    discovery.callback!({ ip: "192.168.1.80", productType: "HWE-KWH3", serial: "kwh3a", name: "kWh 3-phase" });
    expect(i.pairingManager.discovered.some(d => d.serial === "kwh3a")).toBe(true);
  });
});

describe("HomeWizard start-up marker", () => {
  it("stamps every device as disconnected before its first connection attempt", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    i.connections.clear();
    // Watch the first connection attempt: initDevice starts with a client.
    const makeClient = vi.fn(() => client);
    (i as unknown as { makeClient: unknown }).makeClient = makeClient;
    i.getAdapterObjectsAsync.mockResolvedValue({
      "homewizard.0.hwe-p1_dev1": {
        type: "device",
        native: { encryptedToken: "tok1", serial: "dev1", productType: "HWE-P1", productName: "P1", ip: "192.168.1.8" },
      },
    });

    await i.onReady();
    await settle();

    // The previous run's value survives in the database — a device that was green
    // when the adapter died would stay green until its first WebSocket result,
    // and forever if it never reconnects. onReady replaces the fake state manager
    // with a real one, so this asserts at the adapter boundary.
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("hwe-p1_dev1.info.connected", { val: false, ack: true });
    // …and it has to land BEFORE the first connection attempt — the test promised that
    // and used to check only that the stamp exists at all.
    const stampCall = i.setStateChangedAsync.mock.calls.findIndex(
      c => c[0] === "hwe-p1_dev1.info.connected" && (c[1] as { val: unknown }).val === false,
    );
    expect(stampCall).toBeGreaterThanOrEqual(0);
    expect(makeClient).toHaveBeenCalled();
    expect(i.setStateChangedAsync.mock.invocationCallOrder[stampCall]).toBeLessThan(
      makeClient.mock.invocationCallOrder[0],
    );
  });

  it("counts the devices and how many answer in one place", async () => {
    const { hw } = setup();
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

    // One device set up, none answering yet — and "all online" must NOT be true
    // for a fresh install with nothing paired, so it needs a device to exist.
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.devicesTotal", { val: 1, ack: true });
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.devicesOnline", { val: 0, ack: true });
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.devicesAllOnline", { val: false, ack: true });
  });

  it("an install without any device reports no devices, not all-online", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.connections.clear();

    await i.onReady();
    await settle();

    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.devicesTotal", { val: 0, ack: true });
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.devicesAllOnline", { val: false, ack: true });
  });
});

describe("HomeWizard leftover supportedMessages key", () => {
  it("deletes the whole key and stops the start-up when the instance object still carries stopInstance", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.getForeignObjectAsync.mockResolvedValue({ common: { supportedMessages: { stopInstance: true } } });

    await i.onReady();

    // `supportedMessages` is a positive list: writing `{ stopInstance: false }`
    // would leave the object behind and silently kill the messagebox. Only a
    // null deletes the key.
    expect(i.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.homewizard.0", {
      common: { supportedMessages: null },
    });
    // The host restarts the instance on any object change — carrying on here
    // arms timers of a process that is already going down.
    expect(i.getAdapterObjectsAsync).not.toHaveBeenCalled();
  });

  it("deletes a leftover empty object written by the earlier correction", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    // What v0.16.0/v0.17.0 left behind: the flag is falsy, but the key exists
    // and the empty positive list blocks every sendTo without logging anything.
    i.getForeignObjectAsync.mockResolvedValue({ common: { supportedMessages: { stopInstance: false } } });

    await i.onReady();

    expect(i.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.homewizard.0", {
      common: { supportedMessages: null },
    });
    expect(i.getAdapterObjectsAsync).not.toHaveBeenCalled();
  });

  it("deletes the key even when it is an empty object", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.getForeignObjectAsync.mockResolvedValue({ common: { supportedMessages: {} } });

    await i.onReady();

    expect(i.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.homewizard.0", {
      common: { supportedMessages: null },
    });
  });

  // The state of EVERY instance already corrected: the object store merges with
  // node.extend, which stores the `null` rather than deleting the key. Treating that
  // null as "still there" would write again on every start — a restart loop.
  it("writes nothing and starts normally when the key is already null (a corrected instance)", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.getForeignObjectAsync.mockResolvedValue({ common: { supportedMessages: null } });

    await i.onReady();

    expect(i.extendForeignObjectAsync).not.toHaveBeenCalled();
    expect(i.getAdapterObjectsAsync).toHaveBeenCalled();
  });

  it("writes nothing and starts normally when the key is absent", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.getForeignObjectAsync.mockResolvedValue({ common: {} });

    await i.onReady();

    // Every write to the instance object costs a restart — an unconditional one
    // would be a restart loop.
    expect(i.extendForeignObjectAsync).not.toHaveBeenCalled();
    expect(i.getAdapterObjectsAsync).toHaveBeenCalled();
  });
});

describe("device without a usable IP (silent-death guard)", () => {
  it("warns and kicks off the mDNS search instead of leaving it dead", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    i.connections.clear();
    // A stored IP that fails validation is dropped on load, and the device then
    // never reaches connectWebSocket — the only place that ever triggers IP
    // recovery. Without this it stays dead until a restart or a re-pair, and
    // nothing in the log says why.
    i.getAdapterObjectsAsync.mockResolvedValue({
      "homewizard.0.hwe-p1_dev9": {
        type: "device",
        native: {
          encryptedToken: "tok",
          serial: "dev9",
          productType: "HWE-P1",
          productName: "Cellar meter",
          ip: "not-an-ip",
        },
      },
    });

    await i.onReady();
    await settle();

    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("no usable IP address stored"));
    expect(discovery.start).toHaveBeenCalled();
  });

  it("starts no mDNS search when every device has an IP", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    i.connections.clear();
    i.getAdapterObjectsAsync.mockResolvedValue({
      "homewizard.0.hwe-p1_dev1": {
        type: "device",
        native: {
          encryptedToken: "tok",
          serial: "dev1",
          productType: "HWE-P1",
          productName: "P1",
          ip: "192.168.1.8",
        },
      },
    });

    await i.onReady();
    await settle();

    expect(discovery.start).not.toHaveBeenCalled();
  });
});

describe("battery datapoints do not outlive the battery", () => {
  it("removes the branch after two consecutive polls reporting no battery", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    stateMgr.removeBatteryStates.mockResolvedValue(true);

    client.getBatteries.mockResolvedValue({ battery_count: 0 });
    await i.connectionManager.pollSystemInfo(conn);
    // One frame could be a firmware hiccup — churning the tree on it would cut
    // the history for nothing.
    expect(stateMgr.removeBatteryStates).not.toHaveBeenCalled();

    await i.connectionManager.pollSystemInfo(conn);
    expect(stateMgr.removeBatteryStates).toHaveBeenCalledWith(conn.config);
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("no battery connected any more"));
  });

  it("a battery that answers again resets the count", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);

    client.getBatteries.mockResolvedValue({ battery_count: 0 });
    await i.connectionManager.pollSystemInfo(conn);
    client.getBatteries.mockResolvedValue({ mode: "zero", battery_count: 2 });
    await i.connectionManager.pollSystemInfo(conn);
    client.getBatteries.mockResolvedValue({ battery_count: 0 });
    await i.connectionManager.pollSystemInfo(conn);

    expect(stateMgr.removeBatteryStates).not.toHaveBeenCalled();
  });

  // 404 is not the same statement as `battery_count: 0`: the route does not exist in
  // this firmware at all (per the API docs only the meters serve it), so a battery
  // branch still sitting there is dead and goes at once — no two-poll hysteresis, which
  // guards against a single odd frame from a device that HAS the route.
  it("drops a leftover battery branch as soon as the device answers 404 — once, not every minute", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    stateMgr.removeBatteryStates.mockResolvedValue(true);
    client.getBatteries.mockRejectedValue(new HomeWizardApiError(404, "{}", "GET /api/batteries"));

    await i.connectionManager.pollSystemInfo(conn);
    expect(stateMgr.removeBatteryStates).toHaveBeenCalledWith(conn.config);
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("does not manage batteries"));

    await i.connectionManager.pollSystemInfo(conn);
    await i.connectionManager.pollSystemInfo(conn);
    expect(stateMgr.removeBatteryStates, "the probe must not run every minute").toHaveBeenCalledTimes(1);
  });

  it("a device that answers 404 without a battery branch stays quiet", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    stateMgr.removeBatteryStates.mockResolvedValue(false); // nothing was there
    client.getBatteries.mockRejectedValue(new HomeWizardApiError(404, "{}", "GET /api/batteries"));

    await i.connectionManager.pollSystemInfo(conn);
    expect(i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("does not manage batteries"));
    expect(i.log.warn).not.toHaveBeenCalled();
  });

  it("a meter that starts serving batteries again is not blocked by the earlier 404", async () => {
    const { hw, client, conn, stateMgr } = setup();
    const i = internalOf(hw);
    client.getBatteries.mockRejectedValue(new HomeWizardApiError(404, "{}", "GET /api/batteries"));
    await i.connectionManager.pollSystemInfo(conn);

    client.getBatteries.mockResolvedValue({ mode: "zero", battery_count: 2 });
    await i.connectionManager.pollSystemInfo(conn);
    expect(stateMgr.updateBattery).toHaveBeenCalled();

    // …and a later 404 cleans up again instead of being swallowed by a stale flag.
    stateMgr.removeBatteryStates.mockClear();
    stateMgr.removeBatteryStates.mockResolvedValue(true);
    client.getBatteries.mockRejectedValue(new HomeWizardApiError(404, "{}", "GET /api/batteries"));
    await i.connectionManager.pollSystemInfo(conn);
    expect(stateMgr.removeBatteryStates).toHaveBeenCalledTimes(1);
  });
});

describe("the mDNS browser stops as soon as it has done its job", () => {
  // The only place a recovery window ends early. Without it the browser keeps
  // listening for its full minute after every device is back.
  it("stops the browser once every device has reconnected", () => {
    const { hw, conn, discovery } = setup();
    const i = internalOf(hw);
    conn.wsFailCount = 5;
    i.startIpRecovery();
    expect(discovery.start).toHaveBeenCalled();

    i.connectionManager.onWsConnected(conn);

    expect(discovery.stop).toHaveBeenCalled();
  });

  it("keeps it running while another device is still missing", () => {
    const { hw, conn, discovery } = setup();
    const i = internalOf(hw);
    const other = { ...conn, config: { ...conn.config, serial: "ccdd" }, wsAuthenticated: false };
    i.connections.set("hwe-p1_ccdd", other);
    i.startIpRecovery();

    i.connectionManager.onWsConnected(conn);

    expect(discovery.stop).not.toHaveBeenCalled();
  });
});

describe("log volume under a chronic fault", () => {
  // A device with bad WiFi can produce a new error CATEGORY every cycle. Without the
  // cooldown each one is a fresh warn, and the log of a house with one bad meter is
  // useless for finding a real fault.
  it("warns once per hour for a device that keeps producing new error categories", () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);
    i.log.warn.mockClear();

    // Three DIFFERENT categories that each warn — each one is a first occurrence for
    // the repeat-dedup, so only the per-device cooldown holds the line.
    i.connectionManager.onWsDisconnected(conn, new HomeWizardApiError(503, "{}", "ws"));
    i.connectionManager.onWsDisconnected(conn, Object.assign(new Error("b"), { code: "HW_CERT_IDENTITY" }));
    i.connectionManager.onWsDisconnected(conn, new HomeWizardApiError(500, "{}", "ws"));

    expect(i.log.warn.mock.calls.length, "one warn per device and hour").toBe(1);
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("(cooldown)"));
  });

  it("a device that is removed and paired again warns immediately, not after the old cooldown", () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);
    i.connectionManager.onWsDisconnected(conn, new HomeWizardApiError(503, "{}", "ws"));
    i.log.warn.mockClear();

    // Re-pairing builds a FRESH connection for the same serial; without dropping the
    // stamp it would inherit the old device's cooldown and swallow its first warning.
    i.connectionManager.dropCooldowns(conn.config.serial);
    const fresh = makeConn();
    i.connectionManager.onWsDisconnected(fresh, new HomeWizardApiError(500, "{}", "ws"));

    expect(i.log.warn.mock.calls.length).toBe(1);
  });
});

describe("the pairing queue is bounded", () => {
  // Anything on the LAN can announce itself. Without the cap a flood of announcements
  // would grow the queue without limit and the 2 s poll would walk all of it.
  it("ignores further devices once the queue is full", () => {
    const { hw } = setup();
    const i = internalOf(hw);
    for (let n = 0; n < 50; n++) {
      i.pairingManager.onDeviceDiscovered({
        ip: `192.168.1.${n + 100}`,
        productType: "HWE-P1",
        serial: `s${n}`,
        name: `P1 ${n}`,
      });
    }
    expect(i.pairingManager.discovered).toHaveLength(50);

    i.pairingManager.onDeviceDiscovered({
      ip: "192.168.1.250",
      productType: "HWE-P1",
      serial: "one-too-many",
      name: "P1 51",
    });

    expect(i.pairingManager.discovered).toHaveLength(50);
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("discovery list full"));
  });
});

describe("every control state the adapter offers is actually subscribed", () => {
  // A ninth entry in the command table without its subscribeStates would be a control
  // that silently does nothing: the write never reaches onStateChange. Nothing else
  // holds the two lists together.
  it("subscribes exactly the suffixes the command table handles", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    await i.onReady();
    await settle();

    const subscribed = new Set(i.subscribeStatesAsync.mock.calls.map((c: unknown[]) => String(c[0])));
    const commands = (hw as unknown as { deviceCommands: Array<{ suffix: string }> }).deviceCommands;
    for (const { suffix } of commands) {
      // `.system.reboot` → `*.system.reboot`
      expect(subscribed, `${suffix} is handled but never subscribed`).toContain(`*${suffix}`);
    }
    // …and the two that are not in the table.
    expect(subscribed).toContain("startPairing");
    expect(subscribed).toContain("*.remove");
  });
});

describe("a refused write does not leave the data point lying", () => {
  // Without the read-back the data point keeps the user's value, unacknowledged, until
  // the 60 s system poll corrects it — a minute in which the tree says the device is in
  // a state it never accepted (a battery rejects `cloud_enabled` every single time).
  it("reads the affected group back when the device refuses the write", async () => {
    const { hw, client, stateMgr } = setup();
    client.setSystem.mockRejectedValueOnce(new Error("device said no"));
    client.getSystem.mockResolvedValue({ cloud_enabled: false });

    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.cloud_enabled", active(true));

    expect(client.getSystem).toHaveBeenCalledTimes(1);
    expect(stateMgr.updateSystem).toHaveBeenCalledWith(
      expect.objectContaining({ serial: "aabb" }),
      { cloud_enabled: false },
      expect.any(Function),
    );
    // Only that group: a refused LED brightness has no business fetching the battery
    // group or the device info (which would also advance the identity-drift counter).
    expect(client.getBatteries).not.toHaveBeenCalled();
    expect(client.getDeviceInfo).not.toHaveBeenCalled();
  });

  it("reads the battery group back when a battery write is refused", async () => {
    const { hw, client, stateMgr } = setup();
    client.setBatteries.mockRejectedValueOnce(new Error("device said no"));
    client.getBatteries.mockResolvedValue({ mode: "standby", battery_count: 1 });

    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.mode", active("to_full"));

    expect(client.getBatteries).toHaveBeenCalledTimes(1);
    expect(stateMgr.updateBattery).toHaveBeenCalled();
    expect(client.getSystem).not.toHaveBeenCalled();
  });

  it("a failed button does not trigger a read-back — there is no value to correct", async () => {
    const { hw, client } = setup();
    client.reboot.mockRejectedValueOnce(new Error("boom"));

    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.reboot", active(true));

    expect(client.getSystem).not.toHaveBeenCalled();
  });

  it("an input the adapter itself rejects reaches no device and needs no read-back", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.status_led_brightness_pct", active(500));

    expect(client.setSystem).not.toHaveBeenCalled();
    expect(client.getSystem).not.toHaveBeenCalled();
  });
});

describe("acks carry the value that was sent", () => {
  it("battery.permissions acks the parsed list, not the raw text a script wrote", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.permissions", active('["a" ,  "b"]'));
    expect(client.setBatteries).toHaveBeenCalledWith({ permissions: ["a", "b"] });
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.battery.permissions", {
      val: '["a","b"]',
      ack: true,
    });
  });

  it("battery.mode acks the validated mode", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.mode", active("to_full"));
    expect(client.setBatteries).toHaveBeenCalledWith({ mode: "to_full" });
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.battery.mode", {
      val: "to_full",
      ack: true,
    });
  });
});

describe("the adapter's default client/WebSocket factories really pin", () => {
  // The factories are replaced by fakes in every other test, so their real
  // bodies never ran anywhere — exactly where a lost `pinnedAgent` call would
  // disable per-device TLS pinning without any visible change.
  interface AgentCarrier {
    agent: unknown;
  }

  it("makeClient hands the REST client the pinned agent for a stored CN", () => {
    const hw = new HomeWizard();
    const factory = hw as unknown as {
      makeClient: (ip: string, token: string, certCn?: string, serial?: string) => unknown;
    };
    const cn = "appliance/p1dongle/aabbccddeeff";
    const client = factory.makeClient("192.168.1.5", "tok", cn, "aabbccddeeff") as AgentCarrier;
    expect(client.agent).toBe(createDeviceAgent(cn));
  });

  it("makeClient falls back to the serial pin, never to the blanket agent", () => {
    const hw = new HomeWizard();
    const factory = hw as unknown as {
      makeClient: (ip: string, token: string, certCn?: string, serial?: string) => unknown;
    };
    const client = factory.makeClient("192.168.1.5", "tok", undefined, "aabbccddeeff") as AgentCarrier;
    expect(client.agent).toBe(createDeviceAgentForSerial("aabbccddeeff"));
    expect(client.agent).not.toBe(HW_AGENT);
  });

  it("makeClient uses the blanket agent only when nothing identifies the device (pairing)", () => {
    const hw = new HomeWizard();
    const factory = hw as unknown as {
      makeClient: (ip: string, token: string, certCn?: string, serial?: string) => unknown;
    };
    const client = factory.makeClient("192.168.1.5", "") as AgentCarrier;
    expect(client.agent).toBe(HW_AGENT);
  });

  it("makeWebSocket pins the same way", () => {
    const hw = new HomeWizard();
    const factory = hw as unknown as {
      makeWebSocket: (
        ip: string,
        token: string,
        callbacks: unknown,
        timers: unknown,
        certCn?: string,
        serial?: string,
      ) => unknown;
    };
    const callbacks = {
      onMeasurement: (): void => {},
      onConnected: (): void => {},
      onDisconnected: (): void => {},
      log: { debug: (): void => {}, warn: (): void => {} },
    };
    const timers = {
      schedule: (): unknown => null,
      cancel: (): void => {},
      scheduleRepeating: (): unknown => null,
      cancelRepeating: (): void => {},
    };
    const cn = "appliance/p1dongle/aabbccddeeff";
    const ws = factory.makeWebSocket("192.168.1.5", "tok", callbacks, timers, cn, "aabbccddeeff");
    expect((ws as AgentCarrier).agent).toBe(createDeviceAgent(cn));

    const wsBySerial = factory.makeWebSocket("192.168.1.5", "tok", callbacks, timers, undefined, "aabbccddeeff");
    expect((wsBySerial as AgentCarrier).agent).toBe(createDeviceAgentForSerial("aabbccddeeff"));

    // Nothing known → the WebSocket client's own default, the blanket agent.
    const wsPairing = factory.makeWebSocket("192.168.1.5", "", callbacks, timers);
    expect((wsPairing as AgentCarrier).agent).toBe(HW_AGENT);
  });
});

describe("timeout callbacks (the timers nobody drove before)", () => {
  /**
   * Grab the callback of the setTimeout call whose delay matches.
   *
   * @param i Internal adapter view
   * @param ms Expected delay in milliseconds
   */
  function timeoutCallbackFor(i: ReturnType<typeof internalOf>, ms: number): () => void {
    const call = i.setTimeout.mock.calls.find((c: unknown[]) => c[1] === ms);
    expect(call, `no setTimeout scheduled for ${ms}ms`).toBeDefined();
    return call![0] as () => void;
  }

  it("the 60s pairing timeout closes the window and says so", async () => {
    const { hw, discovery } = setup();
    const i = internalOf(hw);
    await i.pairingManager.start();
    expect(discovery.start).toHaveBeenCalled();

    timeoutCallbackFor(i, 60_000)();

    expect(discovery.stop).toHaveBeenCalled();
    // `pairingPollTimer` is not an adapter field (it lives in the pairing manager), so
    // asserting `undefined` on it held on any object — ask the manager instead.
    expect(i.pairingManager.active).toBe(false);
    // The window announced a search, so it closes with the search's result.
    expect(i.log.info).toHaveBeenCalledWith(
      "Pairing window closed — no HomeWizard device found via mDNS; set 'pairingIp' to pair one by its address",
    );
  });

  it("the closing line says how many devices were paired, or why none was", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await i.pairingManager.start();
    i.pairingManager.onDeviceDiscovered({ ip: "192.168.1.80", productType: "HWE-KWH1", serial: "k1", name: "kWh" });
    client.requestPairing.mockRejectedValue(new HomeWizardApiError(403, "{}", "POST /api/user"));
    await i.pairingManager.poll();
    timeoutCallbackFor(i, 60_000)();
    expect(i.log.info).toHaveBeenCalledWith(
      "Pairing window closed — no device was paired; press the device's button within the 60 seconds " +
        "(on a kWh Meter, hold it for 1–3 seconds)",
    );

    i.log.info.mockClear();
    i.setTimeout.mockClear();
    await i.pairingManager.start();
    i.pairingManager.onDeviceDiscovered({ ip: "192.168.1.81", productType: "HWE-P1", serial: "p9", name: "P1" });
    client.requestPairing.mockResolvedValue({ token: "tok" });
    client.getDeviceInfo.mockResolvedValue({ product_type: "HWE-P1", serial: "p9", product_name: "P1 Meter" });
    await i.pairingManager.poll();
    await settle();
    timeoutCallbackFor(i, 60_000)();
    expect(i.log.info).toHaveBeenCalledWith("Pairing window closed — 1 device(s) paired");
  });

  it("a start that fails midway does not leave the window stuck 'already active'", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.getStateAsync.mockRejectedValueOnce(new Error("db read failed"));
    await i.pairingManager.start();
    expect(i.pairingManager.active).toBe(false);
    expect(i.log.warn).toHaveBeenCalledWith("Pairing could not start: db read failed");
  });

  it("the 60s IP-recovery timeout stops the browser and keeps the retry going quietly", () => {
    const { hw, conn, discovery } = setup();
    const i = internalOf(hw);
    conn.wsAuthenticated = false;
    conn.wsFailCount = 4;
    i.startIpRecovery();
    expect(discovery.start).toHaveBeenCalled();

    timeoutCallbackFor(i, 60_000)();

    // The browser goes; the WS reconnect carries on, and the user is not warned
    // hourly about a device that is simply still offline.
    expect(discovery.stop).toHaveBeenCalled();
    expect(i.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("will keep retrying every"));
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("will keep retrying every"));
  });

  it("the pairing poll timer runs a pairing pass", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    await i.pairingManager.start();
    const pollCall = i.setInterval.mock.calls.find((c: unknown[]) => c[1] === 2_000);
    expect(pollCall).toBeDefined();
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered.push({ ip: "192.168.1.9", productType: "HWE-P1", serial: "s1", name: "P1" });
    (pollCall![0] as () => void)();
    await settle();
    expect(client.requestPairing).toHaveBeenCalled();
  });

  it("the system poll timer polls system info", async () => {
    const { hw, conn, stateMgr } = setup();
    const i = internalOf(hw);
    conn.wsAuthenticated = true;
    await i.onReady();
    const pollCall = i.setInterval.mock.calls.find((c: unknown[]) => c[1] === 60_000);
    expect(pollCall).toBeDefined();
    // onReady builds a real StateManager — put the fake back before driving the
    // timer, otherwise the poll writes through the real one.
    (hw as unknown as { stateManager: unknown }).stateManager = stateMgr;
    stateMgr.updateSystem.mockClear();
    i.connections.set("hwe-p1_aabb", conn);
    (pollCall![0] as () => void)();
    await settle();
    expect(stateMgr.updateSystem).toHaveBeenCalled();
  });
});

describe("manifest objects reach an existing installation", () => {
  it("refreshes all seven of them in onReady, each with its own label", async () => {
    // js-controller creates instanceObjects only where they are MISSING, so a
    // changed name or description otherwise lands on fresh installs only. The
    // labels must come from the same i18n keys sync-iopackage-from-i18n.py
    // renders into the manifest, or the two drift apart silently.
    const { hw } = setup();
    const i = internalOf(hw);
    i.connections.clear();
    await i.onReady();

    const expected: Array<[string, string, string | undefined]> = [
      ["info", "info", undefined],
      ["info.connection", "infoConnection", "infoConnectionDesc"],
      ["info.devicesTotal", "devicesTotal", "devicesTotalDesc"],
      ["info.devicesOnline", "devicesOnline", "devicesOnlineDesc"],
      ["info.devicesAllOnline", "devicesAllOnline", "devicesAllOnlineDesc"],
      ["startPairing", "startPairing", "startPairingDesc"],
      ["pairingIp", "pairingIp", "pairingIpDesc"],
    ];
    for (const [id, nameKey, descKey] of expected) {
      const call = i.extendObject.mock.calls.find((c: unknown[]) => c[0] === id);
      expect(call, `no extendObject for ${id}`).toBeDefined();
      const common = (call![1] as { common: { name: unknown; desc?: unknown } }).common;
      expect(common.name, `${id} carries the wrong label`).toEqual({ en: nameKey });
      if (descKey) {
        expect(common.desc, `${id} carries the wrong description`).toEqual({ en: descKey });
      } else {
        expect(common.desc).toBeUndefined();
      }
    }
    // The options argument is where `preserve` would sit — a guard that reads only the
    // object argument never sees it, and a preserved name freezes on every installation.
    for (const c of i.extendObject.mock.calls as unknown[][]) {
      expect(
        (c[2] as { preserve?: unknown } | undefined)?.preserve,
        `${String(c[0])} carries preserve`,
      ).toBeUndefined();
    }
  });
});

describe("device-supplied strings never reach the log raw", () => {
  it("strips CR/LF from an mDNS announcement before logging the find", () => {
    const { hw } = setup();
    const i = internalOf(hw);
    i.connections.clear();
    internalOf(hw).pairingManager.onDeviceDiscovered({
      ip: "192.168.1.9",
      productType: "HWE-P1\n[error] forged",
      serial: "s1",
      name: "Meter\n[error] forged line",
      // A hostile responder on the LAN picks these strings freely; without the
      // strip they forge extra lines in the user's log.
    });
    const line = i.log.info.mock.calls.map((c: unknown[]) => String(c[0])).join("\n---\n");
    expect(line).toContain("Found");
    expect(i.log.info.mock.calls.some((c: unknown[]) => String(c[0]).includes("Meter\n"))).toBe(false);
    expect(i.log.info.mock.calls.some((c: unknown[]) => String(c[0]).includes("HWE-P1\n"))).toBe(false);
  });

  it("strips CR/LF from the name in the successful-pairing line", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);
    client.requestPairing.mockResolvedValue({ token: "newtok" });
    client.getDeviceInfo.mockResolvedValue({
      product_type: "HWE-P1",
      serial: "s2",
      product_name: "P1",
      firmware_version: "4.0",
    });
    i.pairingManager.pairing = true; // the window is open
    i.pairingManager.discovered.push({
      ip: "192.168.1.9",
      productType: "HWE-P1\n[error] forged",
      serial: "s2",
      name: "Meter\n[error] forged",
    });
    await i.pairingManager.poll();
    await settle();
    expect(i.log.info.mock.calls.some((c: unknown[]) => String(c[0]).includes("Successfully paired"))).toBe(true);
    expect(i.log.info.mock.calls.some((c: unknown[]) => String(c[0]).includes("forged\n"))).toBe(false);
    expect(i.log.info.mock.calls.some((c: unknown[]) => String(c[0]).includes("Meter\n"))).toBe(false);
  });
});

describe("the fallback claim does not survive a WebSocket drop", () => {
  it("clears restHealthy when the socket goes down", () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);
    conn.restHealthy = true;
    conn.wsAuthenticated = true;
    i.connectionManager.onWsDisconnected(conn);
    // Nothing has answered over the fallback since the drop — claiming the
    // device is still reachable would be exactly the stale-green the whole
    // marker chain exists to prevent.
    expect(conn.restHealthy).toBe(false);
    expect(i.connectionManager.isDeviceOnline(conn)).toBe(false);
  });

  it("keeps the device online when a reconnect attempt fails while the fallback answers", () => {
    const { hw, conn, stateMgr } = setup();
    const i = internalOf(hw);
    // Situation after a drop: the WebSocket is down, the REST fallback runs and
    // has answered. A reconnect attempt now fails — ws emits `close` for a failed
    // handshake as well, which lands in onWsDisconnected.
    conn.wsAuthenticated = false;
    conn.restHealthy = true;
    conn.pollTimer = {} as ioBroker.Interval;
    stateMgr.setDeviceConnected.mockClear();

    i.connectionManager.onWsDisconnected(conn);

    expect(conn.restHealthy).toBe(true);
    expect(i.connectionManager.isDeviceOnline(conn)).toBe(true);
    expect(stateMgr.setDeviceConnected).not.toHaveBeenCalledWith(conn.config, false);
  });
});

describe("labels of existing objects are brought up to date at start", () => {
  interface LabelHost {
    refreshDeviceLabels: (devices: unknown[], ids: Set<string>) => Promise<void>;
  }

  it("clears the retired markers and refreshes every device's labels", async () => {
    const { hw, conn, stateMgr } = setup();
    stateMgr.removeRetiredMarkers.mockResolvedValue(["info.legacyMigrated"]);
    stateMgr.refreshExistingNames.mockResolvedValue(7);
    const ids = new Set(["homewizard.0.info.legacyMigrated"]);

    await (hw as unknown as LabelHost).refreshDeviceLabels([conn.config], ids);

    // Without this pass a corrected label waits for the device to send data —
    // on a meter that is offline for days, that means it never arrives.
    expect(stateMgr.removeRetiredMarkers).toHaveBeenCalledWith(ids);
    expect(stateMgr.refreshExistingNames).toHaveBeenCalledWith(conn.config, ids);
    expect(internalOf(hw).log.info).toHaveBeenCalledWith(expect.stringContaining("info.legacyMigrated"));
  });

  it("survives a failure without stopping the start-up", async () => {
    const { hw, conn, stateMgr } = setup();
    stateMgr.removeRetiredMarkers.mockRejectedValue(new Error("db down"));

    await (hw as unknown as LabelHost).refreshDeviceLabels([conn.config], new Set());

    expect(internalOf(hw).log.debug).toHaveBeenCalledWith(expect.stringContaining("Could not refresh"));
  });
});

describe("the two controls a user actually operates — driven through onStateChange", () => {
  // Everything below used to be tested by calling startPairing()/removeDevice()
  // as methods. The path a user takes — write the data point, let the subscription
  // deliver it — was never executed by any test, on the only two controls this
  // adapter has.

  it("writing true to startPairing opens the pairing window", async () => {
    const { hw, discovery } = setup();
    await call(hw, "onStateChange", "homewizard.0.startPairing", active(true));

    expect(internalOf(hw).pairingManager.active).toBe(true);
    expect(discovery.start).toHaveBeenCalled();
  });

  it("writing false to startPairing does nothing", async () => {
    const { hw, discovery } = setup();
    await call(hw, "onStateChange", "homewizard.0.startPairing", active(false));

    expect(internalOf(hw).pairingManager.active).toBe(false);
    expect(discovery.start).not.toHaveBeenCalled();
  });

  it("writing true to a device's remove button removes that device", async () => {
    const { hw, conn, stateMgr } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.remove", active(true));

    expect(conn.removed).toBe(true);
    expect(stateMgr.removeDevice).toHaveBeenCalledWith(conn.config);
  });

  it("an acked write is ignored — the adapter's own resets must not re-trigger anything", async () => {
    const { hw, stateMgr } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.remove", { val: true, ack: true });

    expect(stateMgr.removeDevice).not.toHaveBeenCalled();
  });
});

describe("a device the adapter could not load is still removable", () => {
  // The whole point: a device whose stored token cannot be read is skipped while
  // loading, so it has no connection — and removal used to start from exactly
  // that connection. Pressing remove did nothing, logged nothing, and left the
  // button pressed. It was the one device a user needed to get rid of.

  it("removes it by its object id and says the token could not be revoked", async () => {
    const { hw, stateMgr } = setup();
    const i = internalOf(hw);
    i.getObjectAsync.mockResolvedValue({ type: "device", native: {} });

    await call(hw, "onStateChange", "homewizard.0.hwe-p1_broken.remove", active(true));

    expect(stateMgr.removeDeviceByPrefix).toHaveBeenCalledWith("hwe-p1_broken");
    expect(i.log.info).toHaveBeenCalledWith(
      expect.stringContaining("user 'local/iobroker' on the device cannot be deleted"),
    );
  });

  it("does not delete anything when there is no device object behind the button", async () => {
    const { hw, stateMgr } = setup();
    const i = internalOf(hw);
    i.getObjectAsync.mockResolvedValue(null);

    await call(hw, "onStateChange", "homewizard.0.hwe-p1_ghost.remove", active(true));

    expect(stateMgr.removeDeviceByPrefix).not.toHaveBeenCalled();
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_ghost.remove", { val: false, ack: true });
  });

  it("refuses an id that is not a device-level remove button", async () => {
    const { hw, stateMgr } = setup();
    const i = internalOf(hw);
    i.getObjectAsync.mockResolvedValue({ type: "device", native: {} });

    await call(hw, "onStateChange", "homewizard.0.hwe-p1_x.system.remove", active(true));

    expect(stateMgr.removeDeviceByPrefix).not.toHaveBeenCalled();
    expect(i.getObjectAsync).not.toHaveBeenCalled();
  });
});

describe("a button never stays pressed", () => {
  it("pressing startPairing while the window is already open puts the button back", async () => {
    const { hw } = setup();
    const i = internalOf(hw);
    await i.pairingManager.start();
    i.setState.mockClear();

    await i.pairingManager.start();

    expect(i.setState).toHaveBeenCalledWith("startPairing", { val: false, ack: true });
  });

  it("a button pressed for an unreachable device is released again", async () => {
    const { hw, conn, client } = setup();
    const i = internalOf(hw);
    conn.ip = ""; // no usable address — nothing can be sent

    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.reboot", active(true));

    expect(client.reboot).not.toHaveBeenCalled();
    expect(i.setState).toHaveBeenCalledWith("homewizard.0.hwe-p1_aabb.system.reboot", { val: false, ack: true });
  });

  it("a VALUE state for an unreachable device is not written back to false", async () => {
    const { hw, conn } = setup();
    const i = internalOf(hw);
    conn.ip = "";

    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.system.cloud_enabled", active(true));

    // The button rule must never touch a value state — that would overwrite the
    // LED percentage and every switch with `false`.
    expect(i.setState).not.toHaveBeenCalled();
  });

  it("a write to a state this adapter does not control is ignored", async () => {
    const { hw, client } = setup();
    const i = internalOf(hw);

    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.measurement.power_w", active(1));

    expect(client.setSystem).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("no control state"));
  });
});
