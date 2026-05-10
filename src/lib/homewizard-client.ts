import * as https from "node:https";
import { HW_AGENT } from "./cacert";
import type { BatteryControl, DeviceInfo, Measurement, PairingResponse, SystemInfo } from "./types";

/** HTTPS client for HomeWizard API v2 */
export class HomeWizardClient {
  private readonly ip: string;
  private readonly token: string;
  private readonly agent: https.Agent;
  /** Override target port — only used by tests against a local stub-server. */
  private readonly port: number;

  /**
   * @param ip      Device IP address
   * @param token   Bearer token (empty string for pairing requests)
   * @param options Optional overrides — primarily for unit tests against a local TLS stub.
   * @param options.agent HTTPS agent to use; defaults to {@link HW_AGENT} (with HomeWizard CA pinning).
   * @param options.port  Target port; defaults to 443.
   */
  constructor(ip: string, token: string = "", options: { agent?: https.Agent; port?: number } = {}) {
    this.ip = ip;
    this.token = token;
    this.agent = options.agent ?? HW_AGENT;
    this.port = options.port ?? 443;
  }

  /** Get device info (GET /api) */
  async getDeviceInfo(): Promise<DeviceInfo> {
    return this.request<DeviceInfo>("GET", "/api");
  }

  /** Request pairing token (POST /api/user) — 403 until button pressed */
  async requestPairing(): Promise<PairingResponse> {
    const result = await this.request<PairingResponse>("POST", "/api/user", {
      name: "local/iobroker",
    });
    // Server returned 200 but we still validate the shape — a malformed or
    // missing token would otherwise crash later in this.encrypt(undefined).
    if (!result || typeof result.token !== "string" || result.token.length === 0) {
      throw new HomeWizardApiError(200, JSON.stringify(result), "POST /api/user (no token in response)");
    }
    return result;
  }

  /** Get current measurement (REST fallback) */
  async getMeasurement(): Promise<Measurement> {
    return this.request<Measurement>("GET", "/api/measurement");
  }

  /** Get system info */
  async getSystem(): Promise<SystemInfo> {
    return this.request<SystemInfo>("GET", "/api/system");
  }

  /**
   * Update system settings
   *
   * @param settings System settings to update
   */
  async setSystem(settings: Partial<SystemInfo>): Promise<SystemInfo> {
    return this.request<SystemInfo>("PUT", "/api/system", settings);
  }

  /** Reboot device */
  async reboot(): Promise<void> {
    await this.request("PUT", "/api/system/reboot");
  }

  /** Identify device (blink LED) */
  async identify(): Promise<void> {
    await this.request("PUT", "/api/system/identify");
  }

  /** Get battery control status */
  async getBatteries(): Promise<BatteryControl> {
    return this.request<BatteryControl>("GET", "/api/batteries");
  }

  /**
   * Set battery control
   *
   * @param settings Battery control settings to update
   */
  async setBatteries(settings: Partial<BatteryControl>): Promise<BatteryControl> {
    return this.request<BatteryControl>("PUT", "/api/batteries", settings);
  }

  /**
   * @param method HTTP method
   * @param path API path
   * @param body Optional request body
   */
  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {
        "X-Api-Version": "2",
      };

      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }
      if (bodyStr) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
      }

      const req = https.request(
        {
          hostname: this.ip,
          port: this.port,
          path,
          method,
          headers,
          agent: this.agent,
          timeout: 10_000,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on("error", reject);
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const data = Buffer.concat(chunks).toString();
            if (!res.statusCode || res.statusCode >= 400) {
              const error = new HomeWizardApiError(res.statusCode ?? 0, data, `${method} ${path}`);
              reject(error);
              return;
            }
            if (!data) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(new Error(`Invalid JSON from ${method} ${path}: ${data.substring(0, 200)}`));
            }
          });
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error(`Timeout: ${method} ${path}`));
      });

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }
}

/** API error with status code and parsed error body */
export class HomeWizardApiError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;

  /**
   * @param statusCode HTTP status code
   * @param body Response body
   * @param context Request context for error message
   */
  constructor(statusCode: number, body: string, context: string) {
    let errorCode = "unknown";
    let description = body;
    try {
      const parsed = JSON.parse(body);
      errorCode = parsed.error?.code ?? parsed.error ?? "unknown";
      description = parsed.error?.description ?? parsed.error?.code ?? body;
    } catch {
      // body is not JSON
    }
    super(`${context}: HTTP ${statusCode} — ${description}`);
    this.name = "HomeWizardApiError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}
