import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deviceIcon, ICON_BY_TYPE, ICON_FILES, ICON_URI_PREFIX, normaliseLineEndings } from "./device-icons";

const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");
const INVENTORY = join(__dirname, "..", "..", "test", "objects.inventory.json");

function decode(uri: string): string {
  return Buffer.from(uri.slice(ICON_URI_PREFIX.length), "base64").toString("utf8");
}

describe("deviceIcon", () => {
  it("returns the file itself as an inline data-URI, never a path", () => {
    const uri = deviceIcon("HWE-P1");
    expect(uri).toBeDefined();
    expect(uri!.startsWith(ICON_URI_PREFIX)).toBe(true);
    // Admin branches on the VALUE: a data-URI is inlined into the DOM and inherits the
    // row's colour; anything else — a path included — lands in a plain <img> with a
    // fixed colour and is invisible in one of the two theme families.
    expect(uri).not.toContain("/icons/");
    expect(decode(uri!)).toBe(normaliseLineEndings(readFileSync(join(ICON_DIR, "p1meter.svg"), "utf8")));
  });

  it("gives every supported product type its own drawing", () => {
    for (const [type, file] of Object.entries(ICON_BY_TYPE)) {
      const uri = deviceIcon(type);
      expect(uri, type).toBeDefined();
      expect(decode(uri!), type).toBe(normaliseLineEndings(readFileSync(join(ICON_DIR, file), "utf8")));
    }
  });

  it("returns the same value on every call (cached, and the cache does not drift)", () => {
    expect(deviceIcon("HWE-BAT")).toBe(deviceIcon("HWE-BAT"));
  });

  it("leaves an unknown product type without an icon", () => {
    expect(deviceIcon("HWE-SOMETHING-NEW")).toBeUndefined();
    expect(deviceIcon(undefined)).toBeUndefined();
    expect(deviceIcon("")).toBeUndefined();
  });

  it("does not fall for an inherited property name", () => {
    // Without `Object.hasOwn` this resolves to Object.prototype.constructor and the
    // lookup would try to read a function as a file name.
    expect(deviceIcon("constructor")).toBeUndefined();
    expect(deviceIcon("toString")).toBeUndefined();
  });

  it("produces the same bytes for a checkout with Windows line endings", () => {
    const crlf = readFileSync(join(ICON_DIR, "kwhmeter3.svg"), "utf8").replace(/\n/g, "\r\n");
    expect(normaliseLineEndings(crlf)).toBe(readFileSync(join(ICON_DIR, "kwhmeter3.svg"), "utf8"));
  });
});

describe("the icon files themselves", () => {
  const files = readdirSync(ICON_DIR).filter(f => f.endsWith(".svg"));

  it("has exactly the files the map points at — no orphan, none missing", () => {
    expect([...files].sort()).toEqual([...ICON_FILES].sort());
  });

  for (const file of readdirSync(ICON_DIR).filter(f => f.endsWith(".svg"))) {
    describe(file, () => {
      const svg = readFileSync(join(ICON_DIR, file), "utf8");

      it("paints with currentColor only, so it reads in both theme families", () => {
        // A fixed colour (#…, black, white, rgb()) breaks one of the two families —
        // the Admin does NOT invert object icons.
        expect(svg).not.toMatch(/(fill|stroke)\s*=\s*"(?!currentColor|none")[^"]+"/);
        expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(|\bblack\b|\bwhite\b/);
      });

      it("draws with path and circle only", () => {
        // The ID cell's CSS reaches INTO the inlined markup (`& *` { width: initial }),
        // and for rect/image/use/nested svg/foreignObject `initial` means 0 — such a
        // shape comes out zero pixels wide.
        expect(svg.replace(/^<svg[^>]*>/, "")).not.toMatch(/<(rect|image|use|svg|foreignObject)\b/);
      });

      it("is drawn for the 28 px row: one 64-box, stroke 4", () => {
        expect(svg).toContain('viewBox="0 0 64 64"');
        expect(svg).toContain('stroke-width="4"');
      });
    });
  }
});

describe("the object inventory", () => {
  it("carries a decodable icon on every device object, and each is one of the files", () => {
    const inventory = JSON.parse(readFileSync(INVENTORY, "utf8")) as Record<
      string,
      { type?: string; common?: { icon?: string } }
    >;
    const devices = Object.entries(inventory).filter(([, obj]) => obj.type === "device");
    expect(devices.length, "the inventory covers every product type").toBeGreaterThan(0);

    const known = new Set(ICON_FILES.map(f => normaliseLineEndings(readFileSync(join(ICON_DIR, f), "utf8"))));
    for (const [id, obj] of devices) {
      expect(obj.common?.icon, id).toBeDefined();
      expect(known.has(decode(obj.common!.icon!)), `${id} carries a drawing that is not one of the files`).toBe(true);
    }
  });
});
