import * as https from "node:https";
import { AddressInfo } from "node:net";
import { HomeWizardApiError, HomeWizardClient } from "./homewizard-client";

// Pre-generated self-signed RSA-2048 cert/key pair for `localhost` (CN+SAN), 100-year validity.
// Used only by the test stub-server below. The client agent in tests runs with
// `rejectUnauthorized: false`, so the cert pinning is not under test here — the
// purpose is to exercise the real HTTPS request/response pipeline of HomeWizardClient.
const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0NzX0WQlFVj+Y
5QN7kS0zfQlnIhNxQ3ehH8kGNz84cN550G5yoS33zU4Y+tK+VOHktyvSIuJOMxd2
ef3AW++uTmEVhNG5OjdHFaDJG/cK9PHFnA5CHnxl9m3/yRSxlYBhk4u2eJ32kqG4
4mLKteF6W8Km7lDjrWnocSGkao8qYYYWJnHe3fEQNCskQW+uGZdoi/QMI0icnID5
GbywOdIv6SJgBm/RKKT2wvsyWUH/lXGAg4fQTuz+/udbjAPsMHDIExxIndYXGQdk
9bH2WveRGxFRK+z3CS5KRvxbO4Q6i3DgTNoeX20ELfxley/Cr0VQ47l6PnpT3WI9
ZUt8jQlzAgMBAAECggEAAdx2HAVqtpga77R3HOjAFkGK03wDG7mDe/BXmPmrbKT3
GeagqrdmbEznAGlgEXjP8mw/3BuMdHFLozzESvRyx707Jx09iz5XgXju4FTVGtGy
c4TWktvnaKgrClK5z3xd8eQJCS6QDGgG7+Ff/XxJDVny6zAX5BoPjMfU/fKJyE7A
GNJwNx0nvCv8qKrIaYXfx6lCBSDk24mrHzgW1y86iOsKhHQYE9Wj5qcJ7Dre+ijL
jmpEdoItnavwjFpp4beHqV20XeSMzCcW50M3tD0MA7eZpiIDvRteHoGATHwZpj5R
q8WWv7T1ZCIy4/fV/4x0BXo0XPOWuGpOUtvhr52IYQKBgQDXewd5F7ezAZ13Ble6
PArjLLsZbVqiThx5chadISOK68Zzb8/GBHhkG7QEEuzpJC9pVd0j00YpaNEdn0Mz
DSOxj0F89Sg2Fo69DGepQbX10QoT9Mvpi28NLWnDQ6sxTctdHQ4zNU+tOP5zzK1u
smoISBROvlxESx8hvQw1UNkjkwKBgQDWGpJhp42Oj0runxnnQalZcdNeuq3tMBsL
Sgl3taP4KQAJVnutzEp7n4J8mZtr8j3blO/QT3+bnSe3V/D6LN931qe9W8/jMA0T
Dc7p1VRpKOtX2/dq8mbLHOG1qWkQKbh7XSZf0SeKbZovlhIJqiqL7ArL8Yw5b80q
L7T64EnuoQKBgBC+0dzaN/9kP71xM74YTmxLHJskQWfdlB7n+9PoMF/qZLix1r63
uDdnY7zxT5HqqviPoKjZEVnEeIPJzaoY+k4hKOCyGJbjd+I/JYskvSRGQ3c7jeEv
YcjvX4m6J4KkXgp1aJYYLYHzrOqI3G1+1figyVs5Nehkwh2YGGvIRaebAoGBAJUe
SqejOC97U7ggrbzoeZendIz8vhh9schKF4/9vacgfzsBtgBVUecKMKqxnZMwU670
65YNWJY8faXvpRHJYRcpNQjowkC8fc6whlVMVI8thcRamtcs3zVF91o8FMXCGRAq
z4hatwxty76q6gM7NojfrKFgqcZzPNTOB2HYBwYhAoGAdBsYcdf3mZuudUSLJO/M
junEaVzpmy27RSp5Q1RH0EEdnWXjTTyN77MdfXEcHdR71WnB+TvlMqw0ALqvtMan
0a3LfSTuIFrV2bk2H9O0+zvq4zXvcAep+WAN5Uatqh0ZxdhfPCOaKp0KUBAzpX8x
7T6ukX6Zi9r0SZUJvMlVt7o=
-----END PRIVATE KEY-----
`;

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUW+ip2M+6bB8FbLfJD4d4DlEliWYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDUwNjIyMDkxMFoYDzIxMjYw
NDEyMjIwOTEwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC0NzX0WQlFVj+Y5QN7kS0zfQlnIhNxQ3ehH8kGNz84
cN550G5yoS33zU4Y+tK+VOHktyvSIuJOMxd2ef3AW++uTmEVhNG5OjdHFaDJG/cK
9PHFnA5CHnxl9m3/yRSxlYBhk4u2eJ32kqG44mLKteF6W8Km7lDjrWnocSGkao8q
YYYWJnHe3fEQNCskQW+uGZdoi/QMI0icnID5GbywOdIv6SJgBm/RKKT2wvsyWUH/
lXGAg4fQTuz+/udbjAPsMHDIExxIndYXGQdk9bH2WveRGxFRK+z3CS5KRvxbO4Q6
i3DgTNoeX20ELfxley/Cr0VQ47l6PnpT3WI9ZUt8jQlzAgMBAAGjbzBtMB0GA1Ud
DgQWBBQUdhJjntmiQeqLorSl4XdbeoiMoTAfBgNVHSMEGDAWgBQUdhJjntmiQeqL
orSl4XdbeoiMoTAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEARZAYtfMWHvW7S/CiyhAyLz+qvDzb
b78O6oIxnRQp8yzlGwxNF61zZora26tGcriwyOs5ewxQkIxkJNU2uw89J3E8FUzO
yF9JYcS2eaXFypAyGhcPkoSBViHR2P7OabeM2yqW31is/tVRolPxE9idzfyp2quJ
hN/PWkbk1dqk0Gu8LffEO9mUR5tsmerEr0tIZzePfnC09HAo4tvosGr4PLB2d2kZ
diNwXp48ZTGxYk1XdiQP1YbLBk+D3OrVjvAsyzUT8vFex/r6MmcuaDlJyloVxR/M
dGlxE9spFWzvVJpQghYsgldpPTDSQD+7b0cirusNND+qnXUCr0kE+6uOow==
-----END CERTIFICATE-----
`;

interface StubRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface StubResponse {
  statusCode: number;
  body?: unknown;
  bodyText?: string;
}

interface StubServer {
  port: number;
  requests: StubRequest[];
  queue: StubResponse[];
  stop: () => Promise<void>;
}

/**
 * Start a local HTTPS stub-server that responds with a queue of canned answers.
 * Returns the bound port and a recorder of incoming requests so tests can
 * verify what the client actually sent.
 */
async function startStubServer(): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const queue: StubResponse[] = [];

  const server = https.createServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const next = queue.shift();
      if (!next) {
        res.statusCode = 599;
        res.end("no canned response queued");
        return;
      }
      res.statusCode = next.statusCode;
      res.setHeader("Content-Type", "application/json");
      if (next.bodyText !== undefined) {
        res.end(next.bodyText);
      } else if (next.body !== undefined) {
        res.end(JSON.stringify(next.body));
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    requests,
    queue,
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

const TEST_AGENT = new https.Agent({
  rejectUnauthorized: false,
  checkServerIdentity: () => undefined,
});

describe("HomeWizardClient (against local TLS stub-server)", () => {
  let stub: StubServer;
  let client: HomeWizardClient;

  beforeEach(async () => {
    stub = await startStubServer();
    client = new HomeWizardClient("127.0.0.1", "test-token", { agent: TEST_AGENT, port: stub.port });
  });

  afterEach(async () => {
    await stub.stop();
  });

  describe("getDeviceInfo (GET /api)", () => {
    it("returns parsed JSON and includes Bearer token + X-Api-Version: 2", async () => {
      stub.queue.push({
        statusCode: 200,
        body: {
          product_name: "P1 Meter",
          product_type: "HWE-P1",
          serial: "aabbccddeeff",
          firmware_version: "6.4",
          api_version: "2.0.0",
        },
      });
      const info = await client.getDeviceInfo();
      expect(info.product_type).toBe("HWE-P1");
      expect(info.firmware_version).toBe("6.4");

      const req = stub.requests[0];
      expect(req.method).toBe("GET");
      expect(req.path).toBe("/api");
      expect(req.headers["x-api-version"]).toBe("2");
      expect(req.headers["authorization"]).toBe("Bearer test-token");
    });

    it("throws HomeWizardApiError on 4xx with parsed errorCode", async () => {
      stub.queue.push({
        statusCode: 401,
        body: { error: { code: "user:unauthorized", description: "invalid token" } },
      });
      try {
        await client.getDeviceInfo();
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HomeWizardApiError);
        if (err instanceof HomeWizardApiError) {
          expect(err.statusCode).toBe(401);
          expect(err.errorCode).toBe("user:unauthorized");
          expect(err.message).toContain("GET /api");
        }
      }
    });

    it("throws on invalid JSON body (non-API error)", async () => {
      stub.queue.push({ statusCode: 200, bodyText: "<html>oops</html>" });
      try {
        await client.getDeviceInfo();
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("Invalid JSON");
      }
    });
  });

  describe("requestPairing (POST /api/user)", () => {
    it("sends body with name, omits Bearer token when constructed without one", async () => {
      const bareClient = new HomeWizardClient("127.0.0.1", "", { agent: TEST_AGENT, port: stub.port });
      stub.queue.push({ statusCode: 200, body: { token: "newly-issued-token" } });
      const result = await bareClient.requestPairing();
      expect(result.token).toBe("newly-issued-token");

      const req = stub.requests[0];
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/api/user");
      expect(req.headers["authorization"]).toBeUndefined();
      expect(req.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(req.body)).toEqual({ name: "local/iobroker" });
    });

    it("403 surfaces as HomeWizardApiError so caller can poll until button-press", async () => {
      const bareClient = new HomeWizardClient("127.0.0.1", "", { agent: TEST_AGENT, port: stub.port });
      stub.queue.push({
        statusCode: 403,
        body: { error: { code: "user:creation-not-enabled" } },
      });
      try {
        await bareClient.requestPairing();
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HomeWizardApiError);
        if (err instanceof HomeWizardApiError) {
          expect(err.statusCode).toBe(403);
          expect(err.errorCode).toBe("user:creation-not-enabled");
        }
      }
    });

    it("rejects 200 response without token (malformed device reply)", async () => {
      const bareClient = new HomeWizardClient("127.0.0.1", "", { agent: TEST_AGENT, port: stub.port });
      stub.queue.push({ statusCode: 200, body: {} });
      try {
        await bareClient.requestPairing();
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HomeWizardApiError);
        if (err instanceof HomeWizardApiError) {
          expect(err.message).toContain("no token");
        }
      }
    });

    it("rejects 200 response with non-string token", async () => {
      const bareClient = new HomeWizardClient("127.0.0.1", "", { agent: TEST_AGENT, port: stub.port });
      stub.queue.push({ statusCode: 200, body: { token: null } });
      try {
        await bareClient.requestPairing();
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HomeWizardApiError);
      }
    });

    it("rejects 200 response with empty-string token", async () => {
      const bareClient = new HomeWizardClient("127.0.0.1", "", { agent: TEST_AGENT, port: stub.port });
      stub.queue.push({ statusCode: 200, body: { token: "" } });
      try {
        await bareClient.requestPairing();
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HomeWizardApiError);
      }
    });
  });

  describe("getMeasurement (GET /api/measurement)", () => {
    it("returns parsed payload", async () => {
      stub.queue.push({
        statusCode: 200,
        body: { power_w: 1234, voltage_l1_v: 230.4 },
      });
      const m = await client.getMeasurement();
      expect(m.power_w).toBe(1234);
      expect(m.voltage_l1_v).toBe(230.4);
    });
  });

  describe("getSystem / setSystem (GET / PUT /api/system)", () => {
    it("getSystem returns full system info", async () => {
      stub.queue.push({
        statusCode: 200,
        body: {
          wifi_ssid: "Net",
          wifi_rssi_db: -65,
          uptime_s: 3600,
          cloud_enabled: true,
          status_led_brightness_pct: 50,
        },
      });
      const s = await client.getSystem();
      expect(s.wifi_rssi_db).toBe(-65);
      expect(s.cloud_enabled).toBe(true);
    });

    it("setSystem PUTs the partial body and returns the merged response", async () => {
      stub.queue.push({
        statusCode: 200,
        body: {
          wifi_ssid: "Net",
          wifi_rssi_db: -65,
          uptime_s: 3600,
          cloud_enabled: false,
          status_led_brightness_pct: 50,
        },
      });
      const result = await client.setSystem({ cloud_enabled: false });
      expect(result.cloud_enabled).toBe(false);

      const req = stub.requests[0];
      expect(req.method).toBe("PUT");
      expect(req.path).toBe("/api/system");
      expect(JSON.parse(req.body)).toEqual({ cloud_enabled: false });
    });
  });

  describe("reboot / identify (PUT /api/system/{reboot,identify})", () => {
    it("reboot resolves with no body (204-style empty response)", async () => {
      stub.queue.push({ statusCode: 204, bodyText: "" });
      await client.reboot();
      expect(stub.requests[0].method).toBe("PUT");
      expect(stub.requests[0].path).toBe("/api/system/reboot");
    });

    it("identify resolves with no body (204-style empty response)", async () => {
      stub.queue.push({ statusCode: 204, bodyText: "" });
      await client.identify();
      expect(stub.requests[0].path).toBe("/api/system/identify");
    });
  });

  describe("getBatteries / setBatteries (GET / PUT /api/batteries)", () => {
    it("getBatteries returns parsed control state", async () => {
      stub.queue.push({
        statusCode: 200,
        body: {
          mode: "zero",
          permissions: ["charge_allowed", "discharge_allowed"],
          battery_count: 2,
          power_w: -500,
        },
      });
      const b = await client.getBatteries();
      expect(b.mode).toBe("zero");
      expect(b.permissions).toEqual(["charge_allowed", "discharge_allowed"]);
    });

    it("setBatteries PUTs mode change and returns full state", async () => {
      stub.queue.push({
        statusCode: 200,
        body: { mode: "to_full", battery_count: 1 },
      });
      const r = await client.setBatteries({ mode: "to_full" });
      expect(r.mode).toBe("to_full");

      const req = stub.requests[0];
      expect(req.method).toBe("PUT");
      expect(JSON.parse(req.body)).toEqual({ mode: "to_full" });
    });
  });

  describe("error paths shared across all methods", () => {
    it("500 with non-JSON body produces HomeWizardApiError with raw description", async () => {
      stub.queue.push({ statusCode: 500, bodyText: "Internal Server Error" });
      try {
        await client.getMeasurement();
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HomeWizardApiError);
        if (err instanceof HomeWizardApiError) {
          expect(err.statusCode).toBe(500);
          expect(err.message).toContain("Internal Server Error");
        }
      }
    });

    it("connection refused (no server listening) rejects with errno-bearing Error", async () => {
      const port = stub.port;
      await stub.stop();
      const dead = new HomeWizardClient("127.0.0.1", "test-token", { agent: TEST_AGENT, port });
      try {
        await dead.getDeviceInfo();
        throw new Error("expected throw");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        expect(e.code).toMatch(/^E(CONNREFUSED|CONNRESET)$/);
      }
      // Replace the closed server so afterEach() can stop a live one.
      stub = await startStubServer();
    });
  });
});

describe("HomeWizardApiError", () => {
  describe("JSON error body", () => {
    it("should parse error code from nested error object", () => {
      const body = JSON.stringify({
        error: { code: "user:unauthorized", description: "Token invalid" },
      });
      const err = new HomeWizardApiError(401, body, "GET /api");
      expect(err.statusCode).toBe(401);
      expect(err.errorCode).toBe("user:unauthorized");
      expect(err.message).toContain("Token invalid");
      expect(err.message).toContain("401");
      expect(err.name).toBe("HomeWizardApiError");
    });

    it("should parse error code from flat error string", () => {
      const body = JSON.stringify({ error: "user:creation-not-enabled" });
      const err = new HomeWizardApiError(403, body, "POST /api/user");
      expect(err.errorCode).toBe("user:creation-not-enabled");
      expect(err.message).toContain("403");
    });

    it("should use code as description when no description field", () => {
      const body = JSON.stringify({
        error: { code: "request:too-large" },
      });
      const err = new HomeWizardApiError(413, body, "PUT /api/system");
      expect(err.errorCode).toBe("request:too-large");
      expect(err.message).toContain("request:too-large");
    });

    it("should handle empty error object", () => {
      const body = JSON.stringify({ error: {} });
      const err = new HomeWizardApiError(500, body, "GET /api");
      // {} has no code property → falls through to parsed.error itself
      expect(err.statusCode).toBe(500);
    });
  });

  describe("non-JSON error body", () => {
    it("should use raw body as description", () => {
      const err = new HomeWizardApiError(500, "Internal Server Error", "GET /api");
      expect(err.errorCode).toBe("unknown");
      expect(err.message).toContain("Internal Server Error");
      expect(err.message).toContain("500");
    });

    it("should handle empty body", () => {
      const err = new HomeWizardApiError(404, "", "GET /api/missing");
      expect(err.errorCode).toBe("unknown");
      expect(err.message).toContain("404");
    });
  });

  describe("context in message", () => {
    it("should include method and path", () => {
      const err = new HomeWizardApiError(401, "{}", "GET /api/measurement");
      expect(err.message).toContain("GET /api/measurement");
    });
  });

  describe("instanceof", () => {
    it("should be an instance of Error", () => {
      const err = new HomeWizardApiError(500, "{}", "GET /api");
      expect(err).toBeInstanceOf(Error);
    });

    it("should be an instance of HomeWizardApiError", () => {
      const err = new HomeWizardApiError(500, "{}", "GET /api");
      expect(err).toBeInstanceOf(HomeWizardApiError);
    });
  });
});
