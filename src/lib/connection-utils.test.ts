import { classifyError, createDeviceConnection, isAuthError } from "./connection-utils";
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

describe("isAuthError", () => {
  it("is true for the canonical user:unauthorized code", () => {
    const err = new HomeWizardApiError(401, JSON.stringify({ error: { code: "user:unauthorized" } }), "GET /api");
    expect(isAuthError(err)).toBe(true);
  });

  it("is true for a bare HTTP 401 whose body is not the canonical shape (F1)", () => {
    expect(isAuthError(new HomeWizardApiError(401, "not json", "GET /api"))).toBe(true); // errorCode → "unknown"
    expect(isAuthError(new HomeWizardApiError(401, JSON.stringify({ error: "forbidden" }), "GET /api"))).toBe(true);
  });

  it("is false for non-401 API errors (403, 404, 500)", () => {
    expect(isAuthError(new HomeWizardApiError(403, "{}", "POST /api/user"))).toBe(false);
    expect(isAuthError(new HomeWizardApiError(404, "{}", "GET /api/batteries"))).toBe(false);
    expect(isAuthError(new HomeWizardApiError(500, "{}", "GET /api"))).toBe(false);
  });

  it("is false for non-API errors and non-Error values", () => {
    const netErr = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
    netErr.code = "ECONNREFUSED";
    expect(isAuthError(netErr)).toBe(false);
    expect(isAuthError(new Error("boom"))).toBe(false);
    expect(isAuthError("string")).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
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
