import { expect } from "chai";
import { LOG_STRINGS, tLog } from "./i18n-logs";

describe("tLog", () => {
  it("returns the EN template for the requested key", () => {
    expect(tLog("en", "noDevicesConfigured")).to.equal(
      "No devices configured — set 'startPairing' to true to add a device",
    );
  });

  it("returns the DE template for known German locale", () => {
    expect(tLog("de", "pairingTimeout")).to.equal("Pairing-Modus nach 60 Sekunden automatisch beendet");
  });

  it("falls back to EN for unknown languages", () => {
    expect(tLog("klingon", "pairingTimeout")).to.equal("Pairing mode automatically disabled after 60 seconds timeout");
  });

  it("substitutes {token} placeholders from params", () => {
    const msg = tLog("en", "rebootingDevice", { name: "P1 Meter", ip: "192.168.1.50" });
    expect(msg).to.equal("Rebooting P1 Meter (192.168.1.50)");
  });

  it("renders null params as '(none)' so callers don't need to branch", () => {
    const msg = tLog("en", "deviceErrorContext", { name: "p1", context: "ws", error: null });
    expect(msg).to.equal("p1 ws: (none)");
  });

  it("keeps undefined token literal so caller-bug surfaces in the log", () => {
    const msg = tLog("en", "rebootingDevice", { name: "p1" });
    expect(msg).to.equal("Rebooting p1 ({ip})");
  });

  it("keeps EN template when params is omitted", () => {
    const msg = tLog("en", "noDevicesConfigured");
    expect(msg).to.contain("No devices configured");
  });

  it("covers all 11 ioBroker languages for every key", () => {
    const expectedLangs = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
    for (const [key, bundle] of Object.entries(LOG_STRINGS)) {
      for (const lang of expectedLangs) {
        const value = (bundle as Record<string, string>)[lang];
        expect(value, `${key} missing ${lang}`).to.be.a("string");
        expect(value.length, `${key}.${lang} empty`).to.be.greaterThan(0);
      }
    }
  });
});
