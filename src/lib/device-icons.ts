import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pictogram file per product type. A type that is not in here gets no icon — the
 * object's `common.icon` is then left untouched rather than cleared, so a device
 * type added by a future firmware keeps whatever it has.
 *
 * The two SDM types are the kWh meters' older product identifiers; they draw the
 * same meter as their HWE-KWH counterparts.
 */
export const ICON_BY_TYPE: Readonly<Record<string, string>> = {
  "HWE-P1": "p1meter.svg",
  "HWE-KWH1": "kwhmeter1.svg",
  "SDM230-wifi": "kwhmeter1.svg",
  "HWE-KWH3": "kwhmeter3.svg",
  "SDM630-wifi": "kwhmeter3.svg",
  "HWE-BAT": "battery.svg",
};

/** Every file the map points at, each exactly once — for the "no orphan" test. */
export const ICON_FILES: readonly string[] = [...new Set(Object.values(ICON_BY_TYPE))];

/** Admin renders an inline data-URI theme-aware; a path would be a fixed-colour image. */
export const ICON_URI_PREFIX = "data:image/svg+xml;base64,";

// `build/lib` and `src/lib` both sit two levels below the package root.
const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");

const cache = new Map<string, string>();

/**
 * Windows checks the repository out with CRLF, which would produce different bytes
 * — and therefore a different URI — for the same file. The inventory records the
 * URI, so without this the inventory test is red on a Windows runner.
 *
 * @param svg File contents as read from disk.
 */
export function normaliseLineEndings(svg: string): string {
  return svg.replace(/\r\n/g, "\n");
}

/**
 * The pictogram for a product type as an inline data-URI, or `undefined` when the
 * type has none.
 *
 * The value is the FILE itself, not a path: Admin inlines a `data:image/svg+xml`
 * URI into the DOM, where the drawing inherits the row's text colour and reads in
 * the light and the dark themes alike. Anything else — a path included — ends up in
 * a plain `<img>` with a fixed colour and disappears in one of the two families.
 *
 * @param type Product type as the device reports it (`HWE-P1`, …).
 */
export function deviceIcon(type: string | undefined): string | undefined {
  // API boundary: `hasOwn`, because inherited names ("constructor") would otherwise
  // resolve to a function and be read as a file name.
  if (type === undefined || !Object.hasOwn(ICON_BY_TYPE, type)) {
    return undefined;
  }
  const file = ICON_BY_TYPE[type];
  const cached = cache.get(file);
  if (cached) {
    return cached;
  }
  let svg: string;
  try {
    svg = readFileSync(join(ICON_DIR, file), "utf8");
  } catch {
    // An unreadable file must not cost the device its object: without an icon the
    // field stays as it is, it is never emptied.
    return undefined;
  }
  const uri = `${ICON_URI_PREFIX}${Buffer.from(normaliseLineEndings(svg)).toString("base64")}`;
  cache.set(file, uri);
  return uri;
}
