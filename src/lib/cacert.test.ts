import * as https from "node:https";
import type { PeerCertificate } from "node:tls";
import { describe, expect, it } from "vitest";
import { CA_NOT_AFTER, createDeviceAgent, HW_AGENT } from "./cacert";

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

describe("HW_AGENT — pairing blanket agent", () => {
  it("skips the hostname check (identity unknown pre-pairing) but keeps CA validation", () => {
    expect(checkOf(HW_AGENT)("any-host", certWithCn("whatever"))).toBeUndefined();
    expect(HW_AGENT.options.rejectUnauthorized).toBe(true);
    expect(HW_AGENT.options.minVersion).toBe("TLSv1.2");
  });
});

describe("CA_NOT_AFTER", () => {
  it("matches the bundled certificate's documented notAfter (2031-12-16)", () => {
    expect(CA_NOT_AFTER.toISOString().slice(0, 10)).toBe("2031-12-16");
  });
});
