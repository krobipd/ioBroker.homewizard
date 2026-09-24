import { EventEmitter } from "node:events";
import { vi } from "vitest";

// The client must settle its promise ITSELF when it aborts a request. Since Node 26.10,
// `req.destroy(err)` after a fully buffered response emits no `error` — only `end` and
// `close` follow — so a client that left the rejection to that event hung for good
// (measured 2026-09-24; reference_node2610_destroy_ohne_error_nach_voller_antwort).
// The TLS-stub tests only show this on a runtime that behaves that way. This fake
// request behaves that way on EVERY Node version: its destroy() emits nothing.

/** A request whose destroy() is silent, like Node 26.10 after a buffered body. */
class SilentRequest extends EventEmitter {
  destroyed = false;
  write(): boolean {
    return true;
  }
  end(): this {
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

const control: {
  onRequest: ((req: SilentRequest, respond: (res: EventEmitter & { statusCode?: number }) => void) => void) | null;
} = { onRequest: null };

vi.mock("node:https", async importOriginal => {
  const real = await importOriginal<typeof import("node:https")>();
  return {
    ...real,
    request: (_opts: unknown, respond: (res: EventEmitter) => void): SilentRequest => {
      const req = new SilentRequest();
      setImmediate(() => control.onRequest?.(req, respond));
      return req;
    },
  };
});

import { HomeWizardClient } from "./homewizard-client";

/**
 * Settle within `ms` or report "hung".
 *
 * @param p  The promise under test.
 * @param ms How long to wait.
 */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    p.then(
      v => ({ resolved: v }),
      (e: unknown) => ({ rejected: e }),
    ),
    new Promise(resolve => setTimeout(() => resolve("hung"), ms)),
  ]);
}

describe("HomeWizardClient settles without the error event of destroy()", () => {
  afterEach(() => {
    control.onRequest = null;
  });

  it("an oversized body rejects even when destroy() emits no error and the body then ends", async () => {
    control.onRequest = (_req, respond) => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      respond(res);
      res.emit("data", Buffer.alloc(64));
      res.emit("end"); // what Node 26.10 does after destroy(err) on a buffered body
      res.emit("close");
    };
    const client = new HomeWizardClient("127.0.0.1", "tok", { maxResponseBytes: 16 });
    const outcome = await settleWithin(client.getSystem(), 500);
    expect(outcome, "the request must not hang").not.toBe("hung");
    expect(String((outcome as { rejected?: Error }).rejected?.message)).toMatch(/Response body too large/);
  });

  it("a timeout rejects even when destroy() emits no error", async () => {
    control.onRequest = req => {
      req.emit("timeout"); // the socket went quiet — no response, no error
    };
    const client = new HomeWizardClient("127.0.0.1", "tok", { requestTimeoutMs: 50 });
    const outcome = await settleWithin(client.getSystem(), 500);
    expect(outcome, "the request must not hang").not.toBe("hung");
    expect(String((outcome as { rejected?: Error }).rejected?.message)).toBe("Timeout: GET /api/system");
  });
});
