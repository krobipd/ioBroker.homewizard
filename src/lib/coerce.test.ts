import { expect } from "chai";
import {
  BATTERY_MODES,
  coerceBoolean,
  coerceFiniteNumber,
  coerceString,
  errText,
  isPlainObject,
  isValidIpv4,
  parseBatteryPermissions,
  validateBatteryMode,
} from "./coerce";

describe("coerceFiniteNumber", () => {
  it("returns finite numbers as-is", () => {
    expect(coerceFiniteNumber(42)).to.equal(42);
    expect(coerceFiniteNumber(0)).to.equal(0);
    expect(coerceFiniteNumber(-1.5)).to.equal(-1.5);
  });

  it("rejects NaN and Infinity", () => {
    expect(coerceFiniteNumber(NaN)).to.be.null;
    expect(coerceFiniteNumber(Infinity)).to.be.null;
    expect(coerceFiniteNumber(-Infinity)).to.be.null;
  });

  it("parses valid numeric strings", () => {
    expect(coerceFiniteNumber("123.45")).to.equal(123.45);
    expect(coerceFiniteNumber("-0.5")).to.equal(-0.5);
  });

  it("rejects empty string and non-numeric", () => {
    expect(coerceFiniteNumber("")).to.be.null;
    expect(coerceFiniteNumber("abc")).to.be.null;
    expect(coerceFiniteNumber({})).to.be.null;
    expect(coerceFiniteNumber(null)).to.be.null;
    expect(coerceFiniteNumber(undefined)).to.be.null;
  });

  it("rejects HEX strings (firmware drift / corrupted payload guard)", () => {
    expect(coerceFiniteNumber("0x1FBB")).to.be.null;
    expect(coerceFiniteNumber("0X10")).to.be.null;
  });

  it("rejects exponential notation strings", () => {
    expect(coerceFiniteNumber("1e3")).to.be.null;
    expect(coerceFiniteNumber("2.5E-3")).to.be.null;
  });

  it("rejects strings with leading/trailing whitespace or signs", () => {
    expect(coerceFiniteNumber(" 42")).to.be.null;
    expect(coerceFiniteNumber("42 ")).to.be.null;
    expect(coerceFiniteNumber("+42")).to.be.null;
    expect(coerceFiniteNumber(".5")).to.be.null;
    expect(coerceFiniteNumber("5.")).to.be.null;
  });

  it("accepts negative decimals", () => {
    expect(coerceFiniteNumber("-42")).to.equal(-42);
    expect(coerceFiniteNumber("-0.5")).to.equal(-0.5);
  });
});

describe("coerceString", () => {
  it("returns non-empty strings", () => {
    expect(coerceString("hello")).to.equal("hello");
  });

  it("rejects empty string and non-string", () => {
    expect(coerceString("")).to.be.null;
    expect(coerceString(42)).to.be.null;
    expect(coerceString(null)).to.be.null;
    expect(coerceString(undefined)).to.be.null;
    expect(coerceString({})).to.be.null;
  });
});

describe("coerceBoolean", () => {
  it("returns booleans as-is", () => {
    expect(coerceBoolean(true)).to.be.true;
    expect(coerceBoolean(false)).to.be.false;
  });

  it("rejects truthy/falsy non-booleans", () => {
    expect(coerceBoolean(1)).to.be.null;
    expect(coerceBoolean(0)).to.be.null;
    expect(coerceBoolean("true")).to.be.null;
    expect(coerceBoolean(null)).to.be.null;
    expect(coerceBoolean(undefined)).to.be.null;
  });
});

describe("isPlainObject", () => {
  it("accepts plain objects", () => {
    expect(isPlainObject({})).to.be.true;
    expect(isPlainObject({ a: 1 })).to.be.true;
  });

  it("rejects arrays, null, primitives", () => {
    expect(isPlainObject([])).to.be.false;
    expect(isPlainObject(null)).to.be.false;
    expect(isPlainObject("x")).to.be.false;
    expect(isPlainObject(42)).to.be.false;
    expect(isPlainObject(undefined)).to.be.false;
  });
});

describe("errText", () => {
  it("returns Error.message for Error instances", () => {
    expect(errText(new Error("boom"))).to.equal("boom");
  });

  it("returns 'null' for null and 'undefined' for undefined", () => {
    expect(errText(null)).to.equal("null");
    expect(errText(undefined)).to.equal("undefined");
  });

  it("returns strings as-is and primitives via String()", () => {
    expect(errText("plain string")).to.equal("plain string");
    expect(errText(42)).to.equal("42");
    expect(errText(true)).to.equal("true");
  });

  it("JSON-stringifies plain objects (avoids [object Object])", () => {
    expect(errText({ code: "ECONN", port: 443 })).to.equal('{"code":"ECONN","port":443}');
  });

  it("handles a custom Error subclass", () => {
    class MyErr extends Error {
      constructor() {
        super("custom");
        this.name = "MyErr";
      }
    }
    expect(errText(new MyErr())).to.equal("custom");
  });
});

describe("validateBatteryMode", () => {
  it("accepts each documented enum value", () => {
    for (const m of BATTERY_MODES) {
      expect(validateBatteryMode(m)).to.equal(m);
    }
  });

  it("rejects strings outside the whitelist", () => {
    expect(validateBatteryMode("auto")).to.be.null;
    expect(validateBatteryMode("ZERO")).to.be.null;
    expect(validateBatteryMode("")).to.be.null;
  });

  it("rejects non-string types", () => {
    expect(validateBatteryMode(0)).to.be.null;
    expect(validateBatteryMode(null)).to.be.null;
    expect(validateBatteryMode(undefined)).to.be.null;
    expect(validateBatteryMode({ mode: "zero" })).to.be.null;
  });
});

describe("parseBatteryPermissions", () => {
  it("parses a valid JSON string array", () => {
    const result = parseBatteryPermissions('["charge_allowed","discharge_allowed"]');
    expect(result.ok).to.be.true;
    if (result.ok) {
      expect(result.perms).to.deep.equal(["charge_allowed", "discharge_allowed"]);
    }
  });

  it("accepts an empty array", () => {
    const result = parseBatteryPermissions("[]");
    expect(result.ok).to.be.true;
    if (result.ok) {
      expect(result.perms).to.deep.equal([]);
    }
  });

  it("rejects malformed JSON with a useful reason", () => {
    const result = parseBatteryPermissions("[unclosed");
    expect(result.ok).to.be.false;
    if (!result.ok) {
      expect(result.reason).to.be.a("string");
      expect(result.reason.length).to.be.greaterThan(0);
      expect(result.sample).to.equal("[unclosed");
    }
  });

  it("rejects non-array JSON values", () => {
    const obj = parseBatteryPermissions('{"perm":"charge_allowed"}');
    expect(obj.ok).to.be.false;
    if (!obj.ok) {
      expect(obj.reason).to.equal("expected JSON array");
    }
    const num = parseBatteryPermissions("42");
    expect(num.ok).to.be.false;
    const str = parseBatteryPermissions('"charge_allowed"');
    expect(str.ok).to.be.false;
  });

  it("rejects arrays with non-string entries", () => {
    const result = parseBatteryPermissions('["charge_allowed",42]');
    expect(result.ok).to.be.false;
    if (!result.ok) {
      expect(result.reason).to.contain("non-string");
    }
  });

  it("truncates the input sample at 200 chars to avoid log-spam", () => {
    const huge = "x".repeat(500);
    const result = parseBatteryPermissions(huge);
    expect(result.ok).to.be.false;
    if (!result.ok) {
      expect(result.sample.length).to.equal(200);
    }
  });
});

describe("isValidIpv4", () => {
  it("accepts well-formed IPv4 addresses", () => {
    expect(isValidIpv4("192.168.1.42")).to.be.true;
    expect(isValidIpv4("10.0.0.1")).to.be.true;
    expect(isValidIpv4("0.0.0.0")).to.be.true;
    expect(isValidIpv4("255.255.255.255")).to.be.true;
    expect(isValidIpv4("8.8.8.8")).to.be.true;
  });

  it("rejects octet out of range", () => {
    expect(isValidIpv4("256.0.0.0")).to.be.false;
    expect(isValidIpv4("1.2.3.300")).to.be.false;
    expect(isValidIpv4("999.999.999.999")).to.be.false;
  });

  it("rejects wrong number of octets", () => {
    expect(isValidIpv4("1.2.3")).to.be.false;
    expect(isValidIpv4("1.2.3.4.5")).to.be.false;
    expect(isValidIpv4("")).to.be.false;
  });

  it("rejects leading zeros (octal-ambiguous)", () => {
    expect(isValidIpv4("192.168.01.1")).to.be.false;
    expect(isValidIpv4("01.0.0.0")).to.be.false;
  });

  it("rejects non-numeric octets", () => {
    expect(isValidIpv4("1.2.3.x")).to.be.false;
    expect(isValidIpv4("a.b.c.d")).to.be.false;
    expect(isValidIpv4("1.2.3.-4")).to.be.false;
    expect(isValidIpv4("1.2.3. 4")).to.be.false;
  });

  it("rejects IPv6 and hostnames", () => {
    expect(isValidIpv4("::1")).to.be.false;
    expect(isValidIpv4("fe80::1")).to.be.false;
    expect(isValidIpv4("homewizard.local")).to.be.false;
  });

  it("rejects non-string input", () => {
    expect(isValidIpv4(undefined)).to.be.false;
    expect(isValidIpv4(null)).to.be.false;
    expect(isValidIpv4(42)).to.be.false;
    expect(isValidIpv4({})).to.be.false;
  });
});
