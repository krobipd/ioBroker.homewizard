import {
  BATTERY_MODES,
  coerceBoolean,
  coerceFiniteNumber,
  coerceString,
  errText,
  isAssignableDeviceIpv4,
  isPlainObject,
  isValidIpv4,
  parseBatteryPermissions,
  validateBatteryMode,
} from "./coerce";

describe("coerceFiniteNumber", () => {
  it("returns finite numbers as-is", () => {
    expect(coerceFiniteNumber(42)).toBe(42);
    expect(coerceFiniteNumber(0)).toBe(0);
    expect(coerceFiniteNumber(-1.5)).toBe(-1.5);
  });

  it("rejects NaN and Infinity", () => {
    expect(coerceFiniteNumber(NaN)).toBeNull();
    expect(coerceFiniteNumber(Infinity)).toBeNull();
    expect(coerceFiniteNumber(-Infinity)).toBeNull();
  });

  it("parses valid numeric strings", () => {
    expect(coerceFiniteNumber("123.45")).toBe(123.45);
    expect(coerceFiniteNumber("-0.5")).toBe(-0.5);
  });

  it("rejects empty string and non-numeric", () => {
    expect(coerceFiniteNumber("")).toBeNull();
    expect(coerceFiniteNumber("abc")).toBeNull();
    expect(coerceFiniteNumber({})).toBeNull();
    expect(coerceFiniteNumber(null)).toBeNull();
    expect(coerceFiniteNumber(undefined)).toBeNull();
  });

  it("rejects HEX strings (firmware drift / corrupted payload guard)", () => {
    expect(coerceFiniteNumber("0x1FBB")).toBeNull();
    expect(coerceFiniteNumber("0X10")).toBeNull();
  });

  it("rejects exponential notation strings", () => {
    expect(coerceFiniteNumber("1e3")).toBeNull();
    expect(coerceFiniteNumber("2.5E-3")).toBeNull();
  });

  it("rejects strings with leading/trailing whitespace or signs", () => {
    expect(coerceFiniteNumber(" 42")).toBeNull();
    expect(coerceFiniteNumber("42 ")).toBeNull();
    expect(coerceFiniteNumber("+42")).toBeNull();
    expect(coerceFiniteNumber(".5")).toBeNull();
    expect(coerceFiniteNumber("5.")).toBeNull();
  });

  it("accepts negative decimals", () => {
    expect(coerceFiniteNumber("-42")).toBe(-42);
    expect(coerceFiniteNumber("-0.5")).toBe(-0.5);
  });
});

describe("coerceString", () => {
  it("returns non-empty strings", () => {
    expect(coerceString("hello")).toBe("hello");
  });

  it("rejects empty string and non-string", () => {
    expect(coerceString("")).toBeNull();
    expect(coerceString(42)).toBeNull();
    expect(coerceString(null)).toBeNull();
    expect(coerceString(undefined)).toBeNull();
    expect(coerceString({})).toBeNull();
  });
});

describe("coerceBoolean", () => {
  it("returns booleans as-is", () => {
    expect(coerceBoolean(true)).toBe(true);
    expect(coerceBoolean(false)).toBe(false);
  });

  it("rejects truthy/falsy non-booleans", () => {
    expect(coerceBoolean(1)).toBeNull();
    expect(coerceBoolean(0)).toBeNull();
    expect(coerceBoolean("true")).toBeNull();
    expect(coerceBoolean(null)).toBeNull();
    expect(coerceBoolean(undefined)).toBeNull();
  });
});

describe("isPlainObject", () => {
  it("accepts plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("rejects arrays, null, primitives", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe("errText", () => {
  it("returns Error.message for Error instances", () => {
    expect(errText(new Error("boom"))).toBe("boom");
  });

  it("returns 'null' for null and 'undefined' for undefined", () => {
    expect(errText(null)).toBe("null");
    expect(errText(undefined)).toBe("undefined");
  });

  it("returns strings as-is and primitives via String()", () => {
    expect(errText("plain string")).toBe("plain string");
    expect(errText(42)).toBe("42");
    expect(errText(true)).toBe("true");
  });

  it("JSON-stringifies plain objects (avoids [object Object])", () => {
    expect(errText({ code: "ECONN", port: 443 })).toBe('{"code":"ECONN","port":443}');
  });

  it("handles a custom Error subclass", () => {
    class MyErr extends Error {
      constructor() {
        super("custom");
        this.name = "MyErr";
      }
    }
    expect(errText(new MyErr())).toBe("custom");
  });
});

describe("validateBatteryMode", () => {
  it("accepts each documented enum value", () => {
    for (const m of BATTERY_MODES) {
      expect(validateBatteryMode(m)).toBe(m);
    }
  });

  it("rejects strings outside the whitelist", () => {
    expect(validateBatteryMode("auto")).toBeNull();
    expect(validateBatteryMode("ZERO")).toBeNull();
    expect(validateBatteryMode("")).toBeNull();
  });

  it("rejects non-string types", () => {
    expect(validateBatteryMode(0)).toBeNull();
    expect(validateBatteryMode(null)).toBeNull();
    expect(validateBatteryMode(undefined)).toBeNull();
    expect(validateBatteryMode({ mode: "zero" })).toBeNull();
  });
});

describe("parseBatteryPermissions", () => {
  it("parses a valid JSON string array", () => {
    const result = parseBatteryPermissions('["charge_allowed","discharge_allowed"]');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.perms).toEqual(["charge_allowed", "discharge_allowed"]);
    }
  });

  it("accepts an empty array", () => {
    const result = parseBatteryPermissions("[]");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.perms).toEqual([]);
    }
  });

  it("rejects malformed JSON with a useful reason", () => {
    const result = parseBatteryPermissions("[unclosed");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.sample).toBe("[unclosed");
    }
  });

  it("rejects non-array JSON values", () => {
    const obj = parseBatteryPermissions('{"perm":"charge_allowed"}');
    expect(obj.ok).toBe(false);
    if (!obj.ok) {
      expect(obj.reason).toBe("expected JSON array");
    }
    const num = parseBatteryPermissions("42");
    expect(num.ok).toBe(false);
    const str = parseBatteryPermissions('"charge_allowed"');
    expect(str.ok).toBe(false);
  });

  it("rejects arrays with non-string entries", () => {
    const result = parseBatteryPermissions('["charge_allowed",42]');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("non-string");
    }
  });

  it("truncates the input sample at 200 chars to avoid log-spam", () => {
    const huge = "x".repeat(500);
    const result = parseBatteryPermissions(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.sample.length).toBe(200);
    }
  });
});

describe("isValidIpv4", () => {
  it("accepts well-formed IPv4 addresses", () => {
    expect(isValidIpv4("192.168.1.42")).toBe(true);
    expect(isValidIpv4("10.0.0.1")).toBe(true);
    expect(isValidIpv4("0.0.0.0")).toBe(true);
    expect(isValidIpv4("255.255.255.255")).toBe(true);
    expect(isValidIpv4("8.8.8.8")).toBe(true);
  });

  it("rejects octet out of range", () => {
    expect(isValidIpv4("256.0.0.0")).toBe(false);
    expect(isValidIpv4("1.2.3.300")).toBe(false);
    expect(isValidIpv4("999.999.999.999")).toBe(false);
  });

  it("rejects wrong number of octets", () => {
    expect(isValidIpv4("1.2.3")).toBe(false);
    expect(isValidIpv4("1.2.3.4.5")).toBe(false);
    expect(isValidIpv4("")).toBe(false);
  });

  it("rejects leading zeros (octal-ambiguous)", () => {
    expect(isValidIpv4("192.168.01.1")).toBe(false);
    expect(isValidIpv4("01.0.0.0")).toBe(false);
  });

  it("rejects non-numeric octets", () => {
    expect(isValidIpv4("1.2.3.x")).toBe(false);
    expect(isValidIpv4("a.b.c.d")).toBe(false);
    expect(isValidIpv4("1.2.3.-4")).toBe(false);
    expect(isValidIpv4("1.2.3. 4")).toBe(false);
  });

  it("rejects IPv6 and hostnames", () => {
    expect(isValidIpv4("::1")).toBe(false);
    expect(isValidIpv4("fe80::1")).toBe(false);
    expect(isValidIpv4("homewizard.local")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidIpv4(undefined)).toBe(false);
    expect(isValidIpv4(null)).toBe(false);
    expect(isValidIpv4(42)).toBe(false);
    expect(isValidIpv4({})).toBe(false);
  });
});

describe("isAssignableDeviceIpv4 (S5-2 pairing IP guard)", () => {
  it("accepts normal LAN IPv4 addresses", () => {
    expect(isAssignableDeviceIpv4("192.168.1.42")).toBe(true);
    expect(isAssignableDeviceIpv4("10.0.0.5")).toBe(true);
    expect(isAssignableDeviceIpv4("172.16.3.9")).toBe(true);
  });

  it("rejects loopback, link-local (incl. cloud metadata), unspecified and broadcast", () => {
    expect(isAssignableDeviceIpv4("127.0.0.1")).toBe(false);
    expect(isAssignableDeviceIpv4("169.254.169.254")).toBe(false);
    expect(isAssignableDeviceIpv4("0.0.0.0")).toBe(false);
    expect(isAssignableDeviceIpv4("255.255.255.255")).toBe(false);
  });

  it("rejects anything that is not a clean IPv4 (no hostnames, no IPv6)", () => {
    expect(isAssignableDeviceIpv4("homewizard.local")).toBe(false);
    expect(isAssignableDeviceIpv4("fe80::1")).toBe(false);
    expect(isAssignableDeviceIpv4("192.168.1.300")).toBe(false);
    expect(isAssignableDeviceIpv4(undefined)).toBe(false);
  });
});
