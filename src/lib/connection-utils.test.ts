import { classifyError, createDeviceConnection, UNSTABLE_DISCONNECT_THRESHOLD } from "./connection-utils";
import { HomeWizardApiError } from "./homewizard-client";
import type { DeviceConfig } from "./types";

const testConfig: DeviceConfig = {
  token: "test",
  productType: "HWE-P1",
  serial: "aabbcc",
  productName: "P1 Meter",
};

describe("classifyError", () => {
  describe("HomeWizardApiError", () => {
    it("should classify unauthorized as AUTH", () => {
      const body = JSON.stringify({ error: { code: "user:unauthorized" } });
      const err = new HomeWizardApiError(401, body, "GET /api");
      expect(classifyError(err)).toBe("AUTH");
    });

    it("should classify 403 as HTTP_403", () => {
      const body = JSON.stringify({ error: { code: "user:creation-not-enabled" } });
      const err = new HomeWizardApiError(403, body, "POST /api/user");
      expect(classifyError(err)).toBe("HTTP_403");
    });

    it("should classify 500 as HTTP_500", () => {
      const err = new HomeWizardApiError(500, "{}", "GET /api");
      expect(classifyError(err)).toBe("HTTP_500");
    });

    it("should classify 404 as HTTP_404", () => {
      const err = new HomeWizardApiError(404, "{}", "GET /api/missing");
      expect(classifyError(err)).toBe("HTTP_404");
    });
  });

  describe("network errors", () => {
    for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND", "ECONNRESET", "ENETUNREACH", "EAI_AGAIN"]) {
      it(`should classify ${code} as NETWORK`, () => {
        const err = new Error(code) as NodeJS.ErrnoException;
        err.code = code;
        expect(classifyError(err)).toBe("NETWORK");
      });
    }
  });

  describe("timeout errors", () => {
    it("should classify ETIMEDOUT as TIMEOUT", () => {
      const err = new Error("connect ETIMEDOUT") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      expect(classifyError(err)).toBe("TIMEOUT");
    });

    it("should classify Timeout in message as TIMEOUT", () => {
      expect(classifyError(new Error("Timeout: GET /api/measurement"))).toBe("TIMEOUT");
    });
  });

  describe("other errors", () => {
    it("should return error code for unknown system errors", () => {
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      expect(classifyError(err)).toBe("EACCES");
    });

    it("should return UNKNOWN for errors without code", () => {
      expect(classifyError(new Error("something went wrong"))).toBe("UNKNOWN");
    });

    it("should return UNKNOWN for non-Error values", () => {
      expect(classifyError("string error")).toBe("UNKNOWN");
      expect(classifyError(42)).toBe("UNKNOWN");
      expect(classifyError(null)).toBe("UNKNOWN");
      expect(classifyError(undefined)).toBe("UNKNOWN");
    });
  });
});

describe("createDeviceConnection", () => {
  it("should create connection with correct config and ip", () => {
    const conn = createDeviceConnection(testConfig, "192.168.1.100");
    expect(conn.config).toBe(testConfig);
    expect(conn.ip).toBe("192.168.1.100");
  });

  it("should initialize all fields to defaults", () => {
    const conn = createDeviceConnection(testConfig, "10.0.0.1");
    expect(conn.wsClient).toBeNull();
    expect(conn.wsAuthenticated).toBe(false);
    expect(conn.pollTimer).toBeUndefined();
    expect(conn.reconnectTimer).toBeUndefined();
    expect(conn.wsFailCount).toBe(0);
    expect(conn.authFailCount).toBe(0);
    expect(conn.lastErrorCode).toBe("");
    expect(conn.lastConnectedAt).toBe(0);
    expect(conn.recentDisconnects).toBe(0);
    expect(conn.recovering).toBe(false);
    expect(conn.removed).toBe(false);
  });

  it("should handle empty IP", () => {
    expect(createDeviceConnection(testConfig, "").ip).toBe("");
  });
});

describe("UNSTABLE_DISCONNECT_THRESHOLD", () => {
  it("should be 3", () => {
    expect(UNSTABLE_DISCONNECT_THRESHOLD).toBe(3);
  });
});
