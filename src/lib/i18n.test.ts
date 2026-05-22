import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
    translate: vi.fn((key: string) => key),
  },
}));

import { resolveLabel, tDesc, tName } from "./i18n";

describe("tName", () => {
  it("delegates to I18n.getTranslatedObject", () => {
    const result = tName("powerTotal" as never);
    expect(result).toEqual({ en: "powerTotal", de: "powerTotal_de" });
  });
});

describe("tDesc", () => {
  it("delegates to I18n.getTranslatedObject", () => {
    const result = tDesc("voltageSag" as never);
    expect(result).toEqual({ en: "voltageSag", de: "voltageSag_de" });
  });
});

describe("resolveLabel", () => {
  it("delegates to I18n.translate", () => {
    const result = resolveLabel("tariff1" as never);
    expect(result).toBe("tariff1");
  });
});

describe("i18n completeness", () => {
  const i18nDir = join(__dirname, "../../admin/i18n");
  const files = readdirSync(i18nDir).filter((f) => f.endsWith(".json"));
  const keysets = files.map((f) => ({
    lang: f.replace(".json", ""),
    keys: Object.keys(JSON.parse(readFileSync(join(i18nDir, f), "utf8"))),
  }));
  const enKeys = keysets.find((k) => k.lang === "en")!.keys;

  it("all 11 languages have identical keysets", () => {
    expect(files).toHaveLength(11);
    for (const { lang, keys } of keysets) {
      expect(keys, `${lang} keyset mismatch`).toEqual(enKeys);
    }
  });

  it("state name keys are present", () => {
    const required = [
      "powerTotal",
      "voltage",
      "current",
      "frequency",
      "tariff",
      "deviceInformation",
      "measurement",
      "systemSettings",
      "batteryControl",
      "removeDevice",
    ];
    for (const key of required) {
      expect(enKeys, `missing key: ${key}`).toContain(key);
    }
  });
});
