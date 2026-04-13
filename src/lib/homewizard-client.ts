import * as https from "node:https";
import { HW_AGENT } from "./cacert";
import type {
  BatteryControl,
  DeviceInfo,
  Measurement,
  PairingResponse,
  SystemInfo,
} from "./types";

/** HTTPS client for HomeWizard API v2 */
export class HomeWizardClient {
  private readonly ip: string;
  private readonly token: string;

  /**
   * @param ip Device IP address
   * @param token Bearer token (empty string for pairing requests)
   */
  constructor(ip: string, token: string = "") {
    this.ip = ip;
    this.token = token;
  }

  /** Get device info (GET /api) */
  async getDeviceInfo(): Promise<DeviceInfo> {
    return this.request<DeviceInfo>("GET", "/api");
  }

  /** Request pairing token (POST /api/user) — 403 until button pressed */
  async requestPairing(): Promise<PairingResponse> {
    return this.request<PairingResponse>("POST", "/api/user", {
      name: "local/iobroker",
    });
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
  async setBatteries(
    settings: Partial<BatteryControl>,
  ): Promise<BatteryControl> {
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
          port: 443,
          path,
          method,
          headers,
          agent: HW_AGENT,
          timeout: 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("error", reject);
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const data = Buffer.concat(chunks).toString();
            if (!res.statusCode || res.statusCode >= 400) {
              const error = new HomeWizardApiError(
                res.statusCode ?? 0,
                data,
                `${method} ${path}`,
              );
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
              reject(
                new Error(
                  `Invalid JSON from ${method} ${path}: ${data.substring(0, 200)}`,
                ),
              );
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
