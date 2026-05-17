import { classifyError, createDeviceConnection, UNSTABLE_DISCONNECT_THRESHOLD } from "./lib/connection-utils";
import { HomeWizardApiError } from "./lib/homewizard-client";
import type { DeviceConfig } from "./lib/types";

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
      const body = JSON.stringify({
        error: { code: "user:creation-not-enabled" },
      });
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
    it("should classify ECONNREFUSED as NETWORK", () => {
      const err = new Error("connect ECONNREFUSED");
      (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
      expect(classifyError(err)).toBe("NETWORK");
    });

    it("should classify EHOSTUNREACH as NETWORK", () => {
      const err = new Error("host unreachable");
      (err as NodeJS.ErrnoException).code = "EHOSTUNREACH";
      expect(classifyError(err)).toBe("NETWORK");
    });

    it("should classify ENOTFOUND as NETWORK", () => {
      const err = new Error("getaddrinfo ENOTFOUND");
      (err as NodeJS.ErrnoException).code = "ENOTFOUND";
      expect(classifyError(err)).toBe("NETWORK");
    });

    it("should classify ECONNRESET as NETWORK", () => {
      const err = new Error("connection reset");
      (err as NodeJS.ErrnoException).code = "ECONNRESET";
      expect(classifyError(err)).toBe("NETWORK");
    });

    it("should classify ENETUNREACH as NETWORK", () => {
      const err = new Error("network unreachable");
      (err as NodeJS.ErrnoException).code = "ENETUNREACH";
      expect(classifyError(err)).toBe("NETWORK");
    });

    it("should classify EAI_AGAIN as NETWORK", () => {
      const err = new Error("getaddrinfo EAI_AGAIN");
      (err as NodeJS.ErrnoException).code = "EAI_AGAIN";
      expect(classifyError(err)).toBe("NETWORK");
    });
  });

  describe("timeout errors", () => {
    it("should classify ETIMEDOUT as TIMEOUT", () => {
      const err = new Error("connect ETIMEDOUT");
      (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
      expect(classifyError(err)).toBe("TIMEOUT");
    });

    it("should classify Timeout in message as TIMEOUT", () => {
      const err = new Error("Timeout: GET /api/measurement");
      expect(classifyError(err)).toBe("TIMEOUT");
    });
  });

  describe("other errors", () => {
    it("should return error code for unknown system errors", () => {
      const err = new Error("permission denied");
      (err as NodeJS.ErrnoException).code = "EACCES";
      expect(classifyError(err)).toBe("EACCES");
    });

    it("should return UNKNOWN for errors without code", () => {
      const err = new Error("something went wrong");
      expect(classifyError(err)).toBe("UNKNOWN");
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
    const conn = createDeviceConnection(testConfig, "");
    expect(conn.ip).toBe("");
  });
});

describe("UNSTABLE_DISCONNECT_THRESHOLD", () => {
  it("should be 3", () => {
    expect(UNSTABLE_DISCONNECT_THRESHOLD).toBe(3);
  });

  it("should classify device as unstable when threshold reached", () => {
    const conn = createDeviceConnection(testConfig, "192.168.1.1");
    expect(conn.recentDisconnects < UNSTABLE_DISCONNECT_THRESHOLD).toBe(true);

    conn.recentDisconnects = UNSTABLE_DISCONNECT_THRESHOLD;
    expect(conn.recentDisconnects >= UNSTABLE_DISCONNECT_THRESHOLD).toBe(true);
  });
});
