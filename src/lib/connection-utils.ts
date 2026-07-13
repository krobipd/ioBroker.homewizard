import { HomeWizardApiError } from "./homewizard-client";
import type { DeviceConfig, DeviceConnection } from "./types";

/** After this many short-lived connections, switch to unstable mode */
export const UNSTABLE_DISCONNECT_THRESHOLD = 3;

/**
 * Create a fresh DeviceConnection with default values.
 *
 * @param config device configuration
 * @param ip device IP address
 */
export function createDeviceConnection(config: DeviceConfig, ip: string): DeviceConnection {
  return {
    config,
    ip,
    wsClient: null,
    wsAuthenticated: false,
    pollTimer: undefined,
    reconnectTimer: undefined,
    wsFailCount: 0,
    authFailCount: 0,
    lastErrorCode: "",
    lastConnectedAt: 0,
    recentDisconnects: 0,
    recovering: false,
    removed: false,
  };
}

/**
 * Classify an error for deduplication and log-level decisions.
 * Returns a stable category string regardless of error message details.
 *
 * @param err the error to classify
 */
export function classifyError(err: unknown): string {
  if (err instanceof HomeWizardApiError) {
    if (err.errorCode === "user:unauthorized") {
      return "AUTH";
    }
    return `HTTP_${err.statusCode}`;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ECONNREFUSED" ||
      code === "EHOSTUNREACH" ||
      code === "ENOTFOUND" ||
      code === "ECONNRESET" ||
      code === "ENETUNREACH" ||
      code === "EAI_AGAIN"
    ) {
      return "NETWORK";
    }
    if (code === "ETIMEDOUT" || err.message.includes("Timeout")) {
      return "TIMEOUT";
    }
    return code || "UNKNOWN";
  }
  return "UNKNOWN";
}

/**
 * Whether an error is an authentication failure — a bad/revoked bearer token.
 * True for the canonical `user:unauthorized` error code AND for a bare HTTP 401
 * whose body does not parse to that exact shape (non-JSON body → errorCode
 * `"unknown"`, `{"error":"forbidden"}` → `"forbidden"`, …). A 401 semantically IS
 * "unauthorized" for this API, so it must trigger the auth-stop regardless of the
 * body shape — single source of truth for every auth-stop decision (main.ts
 * WS-disconnect, REST-fallback and `handleAuthFailure`), so the three sites can
 * never drift apart.
 *
 * @param err The error to classify.
 */
export function isAuthError(err: unknown): boolean {
  return err instanceof HomeWizardApiError && (err.errorCode === "user:unauthorized" || err.statusCode === 401);
}
