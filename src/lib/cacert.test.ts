import { X509Certificate } from "node:crypto";
import * as https from "node:https";
import type { PeerCertificate } from "node:tls";
import { describe, expect, it } from "vitest";
import {
  CA_NOT_AFTER,
  caDaysUntilExpiry,
  createDeviceAgent,
  createDeviceAgentForSerial,
  dropDeviceAgent,
  HOMEWIZARD_CA_CERT,
  HW_AGENT,
} from "./cacert";

/** Build a minimal PeerCertificate stub with the given CN. */
function certWithCn(cn: string | undefined): PeerCertificate {
  return { subject: { CN: cn } } as unknown as PeerCertificate;
}

function checkOf(agent: https.Agent): (host: string, cert: PeerCertificate) => Error | undefined {
  return (agent.options as { checkServerIdentity?: (h: string, c: PeerCertificate) => Error | undefined })
    .checkServerIdentity!;
}

describe("createDeviceAgent — TLS CN pinning (D6-1)", () => {
  const CN = "appliance/p1dongle/5c2fafaabbcc";

  it("accepts a cert whose CN matches the device identity", () => {
    expect(checkOf(createDeviceAgent(CN))("192.168.1.42", certWithCn(CN))).toBeUndefined();
  });

  it("rejects a cert whose CN belongs to a different device (MITM with another HW cert)", () => {
    const result = checkOf(createDeviceAgent(CN))("192.168.1.42", certWithCn("appliance/p1dongle/deadbeef0000"));
    expect(result).toBeInstanceOf(Error);
  });

  it("rejects a cert with no CN", () => {
    expect(checkOf(createDeviceAgent(CN))("192.168.1.42", certWithCn(undefined))).toBeInstanceOf(Error);
  });

  it("pins the HomeWizard CA + a TLS 1.2 floor + rejectUnauthorized", () => {
    const agent = createDeviceAgent("appliance/x/0001");
    expect(agent.options.rejectUnauthorized).toBe(true);
    expect(agent.options.minVersion).toBe("TLSv1.2");
    expect(agent.options.ca).toBeDefined();
  });

  it("memoizes one agent per CN", () => {
    expect(createDeviceAgent("appliance/x/0002")).toBe(createDeviceAgent("appliance/x/0002"));
    expect(createDeviceAgent("appliance/x/0002")).not.toBe(createDeviceAgent("appliance/x/0003"));
  });
});

describe("dropDeviceAgent (I8)", () => {
  it("evicts the memoized agent so the next createDeviceAgent builds a fresh one", () => {
    const cn = "appliance/x/drop-me";
    const first = createDeviceAgent(cn);
    dropDeviceAgent(cn);
    expect(createDeviceAgent(cn)).not.toBe(first);
  });

  it("is a no-op for a CN that was never created", () => {
    expect(() => dropDeviceAgent("appliance/x/never-created")).not.toThrow();
  });

  it("also evicts the serial-suffix agent (M4)", () => {
    const first = createDeviceAgentForSerial("dropserial01");
    dropDeviceAgent(undefined, "dropserial01");
    expect(createDeviceAgentForSerial("dropserial01")).not.toBe(first);
  });
});

describe("createDeviceAgentForSerial — first-connect serial-suffix pinning (M4)", () => {
  // Official HW v2 doc: cert CN = `appliance/<type>/<serial>`, serial = lowercase-hex MAC.
  const SERIAL = "5c2faf19b76e";

  it("accepts a cert whose CN ends with the device serial", () => {
    const check = checkOf(createDeviceAgentForSerial(SERIAL));
    expect(check("192.168.1.42", certWithCn(`appliance/p1dongle/${SERIAL}`))).toBeUndefined();
  });

  it("rejects a cert carrying a different serial (foreign HomeWizard device)", () => {
    const check = checkOf(createDeviceAgentForSerial(SERIAL));
    expect(check("192.168.1.42", certWithCn("appliance/p1dongle/deadbeef0000"))).toBeInstanceOf(Error);
  });

  it("matches case-insensitively (hex serial)", () => {
    const check = checkOf(createDeviceAgentForSerial(SERIAL.toUpperCase()));
    expect(check("192.168.1.42", certWithCn(`appliance/p1dongle/${SERIAL}`))).toBeUndefined();
  });

  it("rejects a cert with no CN", () => {
    expect(checkOf(createDeviceAgentForSerial(SERIAL))("192.168.1.42", certWithCn(undefined))).toBeInstanceOf(Error);
  });

  it("does not accept the serial appearing mid-CN without the `/` boundary", () => {
    // A CN like `appliance/x/<serial>deadbeef` must not pass — endsWith("/"+serial) guards this.
    const check = checkOf(createDeviceAgentForSerial(SERIAL));
    expect(check("192.168.1.42", certWithCn(`appliance/p1dongle/${SERIAL}00`))).toBeInstanceOf(Error);
  });

  it("memoizes one agent per serial", () => {
    expect(createDeviceAgentForSerial("aabbccddeeff")).toBe(createDeviceAgentForSerial("aabbccddeeff"));
  });
});

describe("HW_AGENT — pairing blanket agent", () => {
  it("skips the hostname check (identity unknown pre-pairing) but keeps CA validation", () => {
    expect(checkOf(HW_AGENT)("any-host", certWithCn("whatever"))).toBeUndefined();
    expect(HW_AGENT.options.rejectUnauthorized).toBe(true);
    expect(HW_AGENT.options.minVersion).toBe("TLSv1.2");
  });
});

describe("CA_NOT_AFTER (L20)", () => {
  it("equals the bundled certificate's actual notAfter (parsed, not a hand-copied literal)", () => {
    // The old test mirrored the literal against itself. Parse the real cert so a
    // future CA swap that forgets to update CA_NOT_AFTER (or vice versa) fails here.
    const cert = new X509Certificate(HOMEWIZARD_CA_CERT);
    expect(CA_NOT_AFTER.getTime()).toBe(cert.validToDate.getTime());
  });
});

describe("caDaysUntilExpiry (L18)", () => {
  it("returns a large positive number well before expiry", () => {
    expect(caDaysUntilExpiry(Date.UTC(2026, 0, 1))).toBeGreaterThan(2000); // ~5.9 years left
  });

  it("drops below the 90-day warn threshold shortly before expiry, still non-negative", () => {
    const near = CA_NOT_AFTER.getTime() - 80 * 86_400_000;
    expect(caDaysUntilExpiry(near)).toBeLessThan(90);
    expect(caDaysUntilExpiry(near)).toBeGreaterThanOrEqual(0);
  });

  it("goes negative once the CA has expired", () => {
    expect(caDaysUntilExpiry(CA_NOT_AFTER.getTime() + 86_400_000)).toBeLessThan(0);
  });
});
