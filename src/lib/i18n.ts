import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";

export type I18nKey = keyof typeof translations;

/**
 * Resolve a key to a translation object for `common.name` / `common.desc`
 * (Admin renders the active system language).
 *
 * @param key Translation key from admin/i18n/en.json
 */
export function tName(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}

/**
 * Resolve a key to a plain string in the system language (for `common.states` VALUES,
 * which must be plain-string — Admin renders them as React children).
 *
 * @param key Translation key from admin/i18n/en.json
 */
export function resolveLabel(key: I18nKey): string {
  return I18n.translate(key);
}
