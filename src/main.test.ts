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
import type { DeviceConnection } from "./lib/types";

interface FakeClient {
  reboot: ReturnType<typeof vi.fn>;
  identify: ReturnType<typeof vi.fn>;
  setSystem: ReturnType<typeof vi.fn>;
  setBatteries: ReturnType<typeof vi.fn>;
  deleteUser: ReturnType<typeof vi.fn>;
  getSystem: ReturnType<typeof vi.fn>;
  getDeviceInfo: ReturnType<typeof vi.fn>;
  getTelegram: ReturnType<typeof vi.fn>;
  getBatteries: ReturnType<typeof vi.fn>;
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
    getTelegram: vi.fn(async () => "/ISK5\\2M550E\r\n!1234"),
    getBatteries: vi.fn(async () => ({})),
  };
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

/** Build a HomeWizard with a fake client factory + a fake stateManager + one registered conn. */
function setup(): {
  hw: HomeWizard;
  client: FakeClient;
  conn: DeviceConnection;
  stateMgr: {
    devicePrefix: ReturnType<typeof vi.fn>;
    removeDevice: ReturnType<typeof vi.fn>;
    setDeviceConnected: ReturnType<typeof vi.fn>;
    updateMeasurement: ReturnType<typeof vi.fn>;
    updateSystem: ReturnType<typeof vi.fn>;
    updateBattery: ReturnType<typeof vi.fn>;
    updateTelegram: ReturnType<typeof vi.fn>;
  };
} {
  const hw = new HomeWizard();
  const client = makeFakeClient();
  const conn = makeConn();
  const internal = hw as unknown as {
    makeClient: () => FakeClient;
    stateManager: unknown;
    connections: Map<string, DeviceConnection>;
  };
  internal.makeClient = () => client;
  const stateMgr = {
    devicePrefix: vi.fn(() => "hwe-p1_aabb"),
    removeDevice: vi.fn(async () => {}),
    setDeviceConnected: vi.fn(async () => {}),
    updateMeasurement: vi.fn(async () => {}),
    updateSystem: vi.fn(async () => {}),
    updateBattery: vi.fn(async () => {}),
    updateTelegram: vi.fn(async () => {}),
  };
  internal.stateManager = stateMgr;
  internal.connections.set("hwe-p1_aabb", conn);
  return { hw, client, conn, stateMgr };
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

  it("ignores acked states", async () => {
    const { hw, client } = setup();
    await call(hw, "onStateChange", "homewizard.0.hwe-p1_aabb.battery.mode", { val: "zero", ack: true } as ioBroker.State);
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

describe("HomeWizard pollSystemInfo telegram branch (A5)", () => {
  it("fetches and stores the raw P1 telegram for a P1 meter", async () => {
    const { hw, client, stateMgr } = setup(); // default conn is HWE-P1
    await call(hw, "pollSystemInfo", makeConn());
    expect(client.getTelegram).toHaveBeenCalled();
    expect(stateMgr.updateTelegram).toHaveBeenCalledWith(expect.objectContaining({ productType: "HWE-P1" }), expect.any(String));
  });

  it("skips the telegram fetch for a non-P1 device (gate that avoids the 404)", async () => {
    const { hw, client, stateMgr } = setup();
    await call(hw, "pollSystemInfo", makeConn({ config: { token: "t", productType: "HWE-KWH1", serial: "kwh1", productName: "kWh" } }));
    expect(client.getTelegram).not.toHaveBeenCalled();
    expect(stateMgr.updateTelegram).not.toHaveBeenCalled();
  });
});
