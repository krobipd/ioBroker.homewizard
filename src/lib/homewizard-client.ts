import * as https from "node:https";
import type * as tls from "node:tls";
import { HW_AGENT } from "./cacert";
import type {
  BatteryControl,
  BatterySettingsWrite,
  DeviceInfo,
  Measurement,
  PairingResponse,
  SystemInfo,
  SystemSettingsWrite,
} from "./types";

/** Minimal logger surface — only debug needed for HTTPS-trace. */
export interface HomeWizardClientLogger {
  /**
   * Debug-log delegate.
   *
   * @param msg Log message
   */
  debug(msg: string): void;
}

/**
 * Hard cap on a single HTTP response body — guards against a buggy/compromised/
 * MITM device streaming an unbounded body (OOM). Real v2 bodies are a few KB.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** HTTPS client for HomeWizard API v2 */
export class HomeWizardClient {
  private readonly ip: string;
  private readonly token: string;
  private readonly agent: https.Agent;
  /** Override target port — only used by tests against a local stub-server. */
  private readonly port: number;
  /** Optional logger for per-call debug-trace (request entry + response success/fail). */
  private readonly log: HomeWizardClientLogger | null;
  /** CN of the most recent server certificate — captured so the pairing flow can pin the device's TLS identity. */
  private lastServerCn: string | null = null;

  /**
   * @param ip      Device IP address
   * @param token   Bearer token (empty string for pairing requests)
   * @param options Optional overrides — primarily for unit tests against a local TLS stub.
   * @param options.agent HTTPS agent to use; defaults to {@link HW_AGENT} (with HomeWizard CA pinning).
   * @param options.port  Target port; defaults to 443.
   * @param options.log   Optional logger for per-call debug-trace (request/success/fail).
   */
  constructor(
    ip: string,
    token: string = "",
    options: { agent?: https.Agent; port?: number; log?: HomeWizardClientLogger } = {},
  ) {
    this.ip = ip;
    this.token = token;
    this.agent = options.agent ?? HW_AGENT;
    this.port = options.port ?? 443;
    this.log = options.log ?? null;
  }

  /** Get device info (GET /api) */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const info = await this.request<DeviceInfo>("GET", "/api");
    // Validate the shape like requestPairing does — getDeviceInfo feeds devicePrefix()
    // → sanitize(), which throws on a non-string product_type/serial. A malformed or
    // non-conformant response would otherwise crash (or orphan a token at pairing).
    if (
      !info ||
      typeof info.product_type !== "string" ||
      typeof info.serial !== "string" ||
      typeof info.product_name !== "string"
    ) {
      throw new HomeWizardApiError(200, JSON.stringify(info), "GET /api (malformed device info)");
    }
    return info;
  }

  /**
   * CN of the most recent server certificate seen on this client, or null.
   * Used at pairing to pin the device's TLS identity (see {@link createDeviceAgent}).
   */
  getServerCertCn(): string | null {
    return this.lastServerCn;
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
  async setSystem(settings: SystemSettingsWrite): Promise<SystemInfo> {
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
  async setBatteries(settings: BatterySettingsWrite): Promise<BatteryControl> {
    return this.request<BatteryControl>("PUT", "/api/batteries", settings);
  }

  /**
   * Revoke the adapter's token on the device (DELETE /api/user). The token was created
   * under the fixed name `local/iobroker` during pairing; deleting it stops orphaned tokens
   * accumulating on the device across pair/unpair cycles. Best-effort — callers ignore errors.
   */
  async deleteUser(): Promise<void> {
    await this.request("DELETE", "/api/user", { name: "local/iobroker" });
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

      // Per mcm-Linie + reference_iobroker_logging_levels: every API call gets
      // an entry-trace so a user-debug-log shows what the adapter actually
      // tried — not just what failed. auth=bearer/none discloses presence,
      // never the token itself.
      const startMs = Date.now();
      this.log?.debug(`HTTPS ${method} ${path} ip=${this.ip} auth=${this.token ? "bearer" : "none"}`);

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
          // Capture the server cert CN (leaf) so the pairing flow can pin the
          // device's TLS identity. Defensive: the socket may not expose a cert.
          const socket = res.socket as tls.TLSSocket | undefined;
          const cn = socket?.getPeerCertificate?.()?.subject?.CN;
          if (typeof cn === "string" && cn.length > 0) {
            this.lastServerCn = cn;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          res.on("error", reject);
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              // Abort an oversized/streaming body before it OOMs the process.
              req.destroy(new Error(`Response body too large (>${MAX_RESPONSE_BYTES} bytes): ${method} ${path}`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const data = Buffer.concat(chunks).toString();
            const elapsedMs = Date.now() - startMs;
            const statusCode = res.statusCode ?? 0;
            if (!statusCode || statusCode >= 400) {
              // Fail: emit detailed trace BEFORE constructing the error so the
              // body snippet is in the log even when the caller catches the
              // throw silently. 200-char snippet cap mirrors the HomeWizardApiError
              // constructor's parsing depth.
              const snippet = data.length > 200 ? `${data.slice(0, 200)}…` : data;
              this.log?.debug(`HTTPS ${method} ${path}: status=${statusCode} elapsed=${elapsedMs}ms body="${snippet}"`);
              const error = new HomeWizardApiError(statusCode, data, `${method} ${path}`);
              reject(error);
              return;
            }
            // Success: status + size + timing. Body itself stays out — too
            // big to log on debug, available at silly if ever wired.
            this.log?.debug(
              `HTTPS ${method} ${path}: status=${statusCode} elapsed=${elapsedMs}ms bytes=${data.length}`,
            );
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

      req.on("error", err => {
        // Pre-response errors (DNS, TCP reset, TLS): log endpoint + elapsed so
        // chronic-bouncing patterns are correlatable in the per-device trace.
        this.log?.debug(`HTTPS ${method} ${path}: error="${err.message}" elapsed=${Date.now() - startMs}ms`);
        reject(err);
      });
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
