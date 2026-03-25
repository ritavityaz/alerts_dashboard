/**
 * i18n — build-time locale, runtime lookup.
 *
 * Language is read from <html lang="..."> (baked by Vite at build time).
 * Translations are imported statically — no runtime fetch, no DOM walk.
 */

import enTranslations from "../locales/en.json";
import heTranslations from "../locales/he.json";

const locales = { en: enTranslations, he: heTranslations };

/**
 * Current language code, read once from the document root element.
 */
export const lang = document.documentElement.lang || "en";

/**
 * Current text direction.
 */
export const dir = lang === "he" ? "rtl" : "ltr";

const translations = locales[lang] || locales.en;

/**
 * Look up a translation by dot-separated key path.
 * Example: t("stats.totalAlerts") → "Total Alerts"
 * Returns the key itself if not found.
 */
export function t(keyPath) {
  const parts = keyPath.split(".");
  let value = translations;
  for (const part of parts) {
    if (value == null || typeof value !== "object") return keyPath;
    value = value[part];
  }
  return value ?? keyPath;
}

/**
 * Format a number using the current locale.
 * Example: formatNumber(12345) → "12,345" (en) or "12,345" (he)
 */
const numberFormatter = new Intl.NumberFormat(lang);
export function formatNumber(number) {
  return numberFormatter.format(number);
}

/**
 * Format a UTC epoch ms as a date string in Israel time.
 * Example: formatDate(1710504000000) → "Mar 15, 2024" (en)
 */
const dateFormatter = new Intl.DateTimeFormat(lang, {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Asia/Jerusalem",
});
export function formatDate(epochMs) {
  return dateFormatter.format(new Date(epochMs));
}

/**
 * Format a UTC epoch ms as a short date+time string in Israel time.
 * Example: formatDateTime(1710504000000) → "Mar 15, 14:00" (en)
 */
const dateTimeFormatter = new Intl.DateTimeFormat(lang, {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Jerusalem",
});
export function formatDateTime(epochMs) {
  return dateTimeFormatter.format(new Date(epochMs));
}

/**
 * Format a UTC epoch ms range as a single date-time range string in Israel time.
 * Uses Intl.DateTimeFormat.formatRange for proper bidi and locale handling.
 * Example: formatDateTimeRange(start, end) → "Mar 15, 14:00 – Mar 20, 08:00" (en)
 */
export function formatDateTimeRange(startMs, endMs) {
  return dateTimeFormatter.formatRange(new Date(startMs), new Date(endMs));
}

/**
 * Build the URL path for the other language, preserving current query params.
 * Example: (on /en/?threat=1) → "/he/?threat=1"
 */
export function otherLangHref() {
  const otherLang = lang === "he" ? "en" : "he";
  return `/${otherLang}/${window.location.search}`;
}
