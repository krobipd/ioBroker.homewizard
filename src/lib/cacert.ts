import * as https from "node:https";

/**
 * HomeWizard Appliance Access CA certificate.
 * Used to validate the self-signed TLS certificates of HomeWizard devices.
 *
 * Issuer: C=NL, ST=ZH, O=HomeWizard, CN=Appliance Access CA
 * Valid: 2021-12-18 to 2031-12-16
 *
 * Source: https://github.com/homewizard/python-homewizard-energy
 */
export const HOMEWIZARD_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIDITCCAgkCFDn7cwYLioTM3VxdAygLl/Px9ovFMA0GCSqGSIb3DQEBCwUAME0x
CzAJBgNVBAYTAk5MMQswCQYDVQQIDAJaSDETMBEGA1UECgwKSG9tZVdpemFyZDEc
MBoGA1UEAwwTQXBwbGlhbmNlIEFjY2VzcyBDQTAeFw0yMTEyMTgxOTEyMTJaFw0z
MTEyMTYxOTEyMTJaME0xCzAJBgNVBAYTAk5MMQswCQYDVQQIDAJaSDETMBEGA1UE
CgwKSG9tZVdpemFyZDEcMBoGA1UEAwwTQXBwbGlhbmNlIEFjY2VzcyBDQTCCASIw
DQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAPBIvW8NRffqdvzHZY0M32fQHiGm
pJgNGhiaQmpJfRDhT9yihM0S/hYcN8IqnfrMqoCQb/56Ub0+dZizmtfcGsE+Lpm1
K1znkWqSDlpnuTNOb70TrsxBmbFuNOZQEi/xOjzT2j98wT0GSfxz1RVq6lZhDRRz
xoe08+Xo4+ttUGanfOggJi0BXygeFEVBpbctVVJ9EgqeEE9itjcMlcxMe1QN14f8
hCcOnId+9PSsdmyUCLrTB0FVYrbNfbJPk/vMU57fu6swBjWhYBxPx9ZhFy+7WnPR
9BFg4seHNVQIqZNrf1YwBXlmZQIL32SRPaiH/+AVNMrYGXBvncY0Km6ZHIMCAwEA
ATANBgkqhkiG9w0BAQsFAAOCAQEA6ybM8xm0PCXg8Rr/q0v1vPxQy44PmwXTDj0e
r2vW4ZMiEwXZCp0Kk2K16KJYz4iJyfiQk8ikAIMiRSbyXzmyQ7XmL1O4l4d8E1Pg
8EImvcyoBxFhd0Lq7VKriLc8Bw8SXbahPMGT+Y8Yz0uIsLAYVwlkLfgppVPmBaLD
QautcQnI8WxPvCIQf5anyzgAyJC5ac6/CkB+iyPcuWcG3RMYvXnC0QoTlRa5YMlE
FweVDlT2C/MdDyOxiAD/H1EP/eaySnU0zsxyD0yNFRKsQfQ+UJEPd2GS1AGA1lTy
CGdyYj/Gghrusw0hM4rYXQSERWGF0mpEnuJ+7bHDolHu0rzgTQ==
-----END CERTIFICATE-----`;

/**
 * notAfter of the bundled CA (see header above). After this instant, every device
 * certificate fails validation under `rejectUnauthorized:true` and all connections
 * break — the adapter must ship a refreshed CA before then.
 */
export const CA_NOT_AFTER = new Date("2031-12-16T19:12:12Z");

/**
 * Whole days from `now` until the bundled CA expires (negative once expired).
 * Pure seam so the startup expiry-warn threshold is unit-testable without mocking
 * Date.now(). (L18)
 *
 * @param now Current time in ms (the call site passes Date.now()).
 */
export function caDaysUntilExpiry(now: number): number {
  return Math.floor((CA_NOT_AFTER.getTime() - now) / 86_400_000);
}

/**
 * Blanket HTTPS agent — validates the cert chain against the HomeWizard CA but
 * does NOT verify the hostname/CN. Used ONLY during initial pairing, where the
 * device's identity (cert CN = `appliance/<product_type>/<serial>`) is not yet
 * known. Established devices use {@link createDeviceAgent}, which pins the CN.
 */
export const HW_AGENT = new https.Agent({
  ca: HOMEWIZARD_CA_CERT,
  rejectUnauthorized: true,
  minVersion: "TLSv1.2",
  // CN unknown pre-pairing — verified per-device once paired (createDeviceAgent).
  checkServerIdentity: () => undefined,
});

const deviceAgents = new Map<string, https.Agent>();

/**
 * Per-device HTTPS agent that pins the server certificate's Common Name to the
 * device's known identity (`appliance/<product_type>/<serial>`, captured at
 * pairing). HomeWizard API v2 best practice: the CA proves the cert belongs to a
 * genuine HomeWizard device, the CN check proves it is THIS device — so a LAN
 * attacker owning a *different* HomeWizard device (also CA-signed) cannot MITM the
 * connection and harvest the bearer token. Agents are memoized per CN.
 *
 * @param expectedCn The device's certificate CN captured at pairing.
 */
export function createDeviceAgent(expectedCn: string): https.Agent {
  let agent = deviceAgents.get(expectedCn);
  if (!agent) {
    agent = new https.Agent({
      ca: HOMEWIZARD_CA_CERT,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      checkServerIdentity: (_hostname, cert) => {
        const cn = typeof cert?.subject?.CN === "string" ? cert.subject.CN : undefined;
        if (cn === expectedCn) {
          return undefined;
        }
        return new Error(`HomeWizard certificate CN mismatch: expected "${expectedCn}", got "${cn ?? "?"}"`);
      },
    });
    deviceAgents.set(expectedCn, agent);
  }
  return agent;
}

/**
 * Evict the memoized per-device agent for a CN and close its pooled sockets.
 * Called from removeDevice so a removed/re-paired device leaves no agent behind.
 * The map is already bounded (one entry per paired device), but this keeps it
 * symmetric with device lifecycle instead of growing until adapter restart.
 *
 * @param expectedCn The device's certificate CN to evict.
 */
export function dropDeviceAgent(expectedCn: string): void {
  const agent = deviceAgents.get(expectedCn);
  if (agent) {
    agent.destroy();
    deviceAgents.delete(expectedCn);
  }
}
