import { expect } from "chai";
import {
  computeReconnectDelay,
  decideUnstableTransition,
  findConnectionForState,
  pickRestPollInterval,
  shouldEmitAfterCooldown,
  shouldStartIpRecovery,
  stripNamespace,
} from "./main-helpers";
import type { DeviceConnection } from "./types";

describe("decideUnstableTransition", () => {
  const STABLE = 600_000; // 10 min
  const THRESHOLD = 3;

  it("noChange when first short disconnect (counter goes 0 → 1)", () => {
    expect(decideUnstableTransition(0, 100, STABLE, THRESHOLD)).to.equal("noChange");
  });

  it("noChange on second short disconnect (1 → 2, threshold not yet hit)", () => {
    expect(decideUnstableTransition(1, 100, STABLE, THRESHOLD)).to.equal("noChange");
  });

  it("becameUnstable exactly when third short disconnect crosses the threshold", () => {
    expect(decideUnstableTransition(2, 100, STABLE, THRESHOLD)).to.equal("becameUnstable");
  });

  it("noChange when long-lived connection but never was unstable", () => {
    expect(decideUnstableTransition(0, 700_000, STABLE, THRESHOLD)).to.equal("noChange");
    expect(decideUnstableTransition(2, 700_000, STABLE, THRESHOLD)).to.equal("noChange");
  });

  it("stabilized when long-lived connection AND was previously unstable", () => {
    expect(decideUnstableTransition(3, 700_000, STABLE, THRESHOLD)).to.equal("stabilized");
    expect(decideUnstableTransition(5, 700_000, STABLE, THRESHOLD)).to.equal("stabilized");
  });

  it("does not re-emit becameUnstable past the threshold (stays noChange)", () => {
    expect(decideUnstableTransition(3, 100, STABLE, THRESHOLD)).to.equal("noChange");
    expect(decideUnstableTransition(10, 100, STABLE, THRESHOLD)).to.equal("noChange");
  });
});

describe("computeReconnectDelay", () => {
  const BASE = 5_000;
  const MAX = 300_000;

  it("returns base on first attempt (failCount=1)", () => {
    expect(computeReconnectDelay(1, BASE, MAX)).to.equal(BASE);
  });

  it("doubles each subsequent attempt", () => {
    expect(computeReconnectDelay(2, BASE, MAX)).to.equal(10_000);
    expect(computeReconnectDelay(3, BASE, MAX)).to.equal(20_000);
    expect(computeReconnectDelay(4, BASE, MAX)).to.equal(40_000);
  });

  it("caps at max (stable)", () => {
    expect(computeReconnectDelay(20, BASE, MAX)).to.equal(MAX);
  });

  it("caps at smaller max (unstable mode)", () => {
    expect(computeReconnectDelay(20, BASE, 60_000)).to.equal(60_000);
  });

  it("returns base for zero/negative failCount (defensive)", () => {
    expect(computeReconnectDelay(0, BASE, MAX)).to.equal(BASE);
    expect(computeReconnectDelay(-1, BASE, MAX)).to.equal(BASE);
  });
});

describe("shouldStartIpRecovery", () => {
  const BEFORE = 3;
  const RETRY_EVERY = 12;

  it("false until the threshold is reached", () => {
    expect(shouldStartIpRecovery(0, BEFORE, RETRY_EVERY)).to.be.false;
    expect(shouldStartIpRecovery(2, BEFORE, RETRY_EVERY)).to.be.false;
  });

  it("true on the exact threshold (first run)", () => {
    expect(shouldStartIpRecovery(3, BEFORE, RETRY_EVERY)).to.be.true;
  });

  it("false between retries", () => {
    expect(shouldStartIpRecovery(4, BEFORE, RETRY_EVERY)).to.be.false;
    expect(shouldStartIpRecovery(10, BEFORE, RETRY_EVERY)).to.be.false;
  });

  it("true again after RETRY_EVERY more failures", () => {
    expect(shouldStartIpRecovery(15, BEFORE, RETRY_EVERY)).to.be.true; // 3 + 12
    expect(shouldStartIpRecovery(27, BEFORE, RETRY_EVERY)).to.be.true; // 3 + 24
  });
});

describe("pickRestPollInterval", () => {
  it("uses the stable interval when unstable=false", () => {
    expect(pickRestPollInterval(false, 10_000, 30_000)).to.equal(10_000);
  });

  it("uses the unstable interval when unstable=true", () => {
    expect(pickRestPollInterval(true, 10_000, 30_000)).to.equal(30_000);
  });
});

describe("stripNamespace", () => {
  it("strips a matching prefix", () => {
    expect(stripNamespace("homewizard.0.hwe-p1_aabb.measurement.power_w", "homewizard.0")).to.equal(
      "hwe-p1_aabb.measurement.power_w",
    );
  });

  it("returns the input unchanged when prefix does not match", () => {
    expect(stripNamespace("other.adapter.foo", "homewizard.0")).to.equal("other.adapter.foo");
  });

  it("does not strip when the namespace is a partial substring (must be followed by '.')", () => {
    expect(stripNamespace("homewizard.0extra.foo", "homewizard.0")).to.equal("homewizard.0extra.foo");
  });
});

describe("findConnectionForState", () => {
  function fakeConnection(prefix: string): DeviceConnection {
    return {
      config: { token: "t", productType: "HWE-P1", serial: prefix.split("_")[1] || "x", productName: "P1" },
            ip: "192.168.1.1",
            wsClient: null,
            wsAuthenticated: false,
            pollTimer: undefined,
            reconnectTimer: undefined,
            wsFailCount: 0,
            authFailCount: 0,
            lastErrorCode: "",
            lastConnectedAt: 0,
            recentDisconnects: 0,
        } as DeviceConnection;
  }

  it("returns the matching connection by prefix", () => {
    const a = fakeConnection("hwe-p1_aabb");
    const b = fakeConnection("hwe-bat_ccdd");
    const conns: [string, DeviceConnection][] = [
      ["hwe-p1_aabb", a],
      ["hwe-bat_ccdd", b],
    ];
    expect(findConnectionForState("homewizard.0.hwe-bat_ccdd.battery.mode", "homewizard.0", conns)).to.equal(b);
    expect(findConnectionForState("homewizard.0.hwe-p1_aabb.measurement.power_w", "homewizard.0", conns)).to.equal(a);
  });

  it("returns undefined for an unknown prefix", () => {
    const a = fakeConnection("hwe-p1_aabb");
    const conns: [string, DeviceConnection][] = [["hwe-p1_aabb", a]];
    expect(findConnectionForState("homewizard.0.somewhereElse.foo", "homewizard.0", conns)).to.be.undefined;
  });

  it("returns undefined when state-ID is the prefix itself (no child)", () => {
    const a = fakeConnection("hwe-p1_aabb");
    const conns: [string, DeviceConnection][] = [["hwe-p1_aabb", a]];
    expect(findConnectionForState("homewizard.0.hwe-p1_aabb", "homewizard.0", conns)).to.be.undefined;
  });

  it("does not match a partial prefix (e.g. hwe-p1 vs hwe-p1_aabb)", () => {
    const long = fakeConnection("hwe-p1_aabb");
    const conns: [string, DeviceConnection][] = [["hwe-p1_aabb", long]];
    // A state-ID for a hypothetical short-prefix device must NOT pick up the long one.
    expect(findConnectionForState("homewizard.0.hwe-p1.foo", "homewizard.0", conns)).to.be.undefined;
  });
});

describe("shouldEmitAfterCooldown", () => {
  const COOLDOWN = 60 * 60 * 1000; // 1h

  it("emits when never seen before (lastMs=0)", () => {
    expect(shouldEmitAfterCooldown(0, 1_700_000_000_000, COOLDOWN)).to.equal(true);
  });

  it("suppresses when same instant as last emit", () => {
    expect(shouldEmitAfterCooldown(1_700_000_000_000, 1_700_000_000_000, COOLDOWN)).to.equal(false);
  });

  it("suppresses well inside the window (30 min after)", () => {
    const last = 1_700_000_000_000;
    expect(shouldEmitAfterCooldown(last, last + 30 * 60 * 1000, COOLDOWN)).to.equal(false);
  });

  it("emits at the window boundary (exactly cooldownMs later)", () => {
    const last = 1_700_000_000_000;
    expect(shouldEmitAfterCooldown(last, last + COOLDOWN, COOLDOWN)).to.equal(true);
  });

  it("emits well past the window (1h + 1 min)", () => {
    const last = 1_700_000_000_000;
    expect(shouldEmitAfterCooldown(last, last + COOLDOWN + 60_000, COOLDOWN)).to.equal(true);
  });

  it("scales with cooldownMs (1s window)", () => {
    const last = 1_700_000_000_000;
    expect(shouldEmitAfterCooldown(last, last + 500, 1_000)).to.equal(false);
    expect(shouldEmitAfterCooldown(last, last + 1_000, 1_000)).to.equal(true);
  });

  it("handles zero-cooldown (every call emits)", () => {
    const last = 1_700_000_000_000;
    expect(shouldEmitAfterCooldown(last, last, 0)).to.equal(true);
    expect(shouldEmitAfterCooldown(last, last + 1, 0)).to.equal(true);
  });
});
