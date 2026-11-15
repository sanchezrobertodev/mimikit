// Numbers, sizes, times and kind names for display, in the UI language. format.ts keeps the path helpers that the
// Node tests use.
import { KINDS, type Kind } from "../types";
import { formatLocale, t } from "./i18n";

export const kindLabel = Object.fromEntries(KINDS.map((k) => [k, t(`fmt.kinds.${k}`)])) as Record<Kind, string>;
/** The type of one asset ("Image"), where kindLabel names the group ("Images"). */
export const kindOne = Object.fromEntries(KINDS.map((k) => [k, t(`fmt.kindOne.${k}`)])) as Record<Kind, string>;

const nf = new Intl.NumberFormat(formatLocale());
const nf1 = new Intl.NumberFormat(formatLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat(formatLocale(), { maximumFractionDigits: 2 });
const lf = new Intl.ListFormat(formatLocale());
const rtf = new Intl.RelativeTimeFormat(formatLocale(), { style: t("fmt.time.relativeStyle") as Intl.RelativeTimeFormatStyle });

/** A count with the locale's digit grouping. */
export const num = (n: number) => nf.format(n);
const usd = new Intl.NumberFormat(formatLocale(), { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Dollars to the cent; under a cent shows as "< $0.01" rather than nothing. */
export const money = (n: number) => (n > 0 && n < 0.005 ? `< ${usd.format(0.01)}` : usd.format(n));
/** "a, b and c" in the UI language. */
export const list = (items: string[]) => lf.format(items);

export function bytes(n: number): string {
  if (n < 1024) return `${n} ${t("fmt.units.b")}`;
  const units = [t("fmt.units.kb"), t("fmt.units.mb"), t("fmt.units.gb"), t("fmt.units.tb")];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? nf1.format(v) : nf.format(Math.round(v))} ${units[i]}`;
}

/** "3h ago", "Yesterday", "4d ago", "2w ago", then a date. */
export function ago(ms: number, now = Date.now()): string {
  if (!ms) return t("fmt.time.never");
  const d = (now - ms) / 86_400_000;
  if (d < 1 / 24) return t("fmt.time.justNow");
  if (d < 1) return rtf.format(-Math.round(d * 24), "hour");
  if (d < 2) return t("fmt.time.yesterday");
  if (d < 7) return rtf.format(-Math.round(d), "day");
  if (d < 60) return rtf.format(-Math.round(d / 7), "week");
  return new Date(ms).toLocaleDateString(formatLocale(), { dateStyle: "medium" });
}

/** "0:03.2", "12:05.0": minutes, seconds and tenths. */
export function duration(ms: number): string {
  const tenths = Math.round(ms / 100);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

/** "0:03.2 · 44.1 kHz · stereo · 16-bit", leaving out what the header didn't tell. */
export function audioDetails(a: { durationMs: number | null; sampleRate: number | null; channels: number | null; bits: number | null }): string {
  const ch =
    a.channels === 1 ? t("fmt.audio.mono") : a.channels === 2 ? t("fmt.audio.stereo") : a.channels ? t("fmt.audio.channels", { count: a.channels }) : null;
  return [
    a.durationMs !== null ? duration(a.durationMs) : null,
    a.sampleRate ? t("fmt.audio.khz", { value: nf2.format(a.sampleRate / 1000) }) : null,
    ch,
    a.bits ? t("fmt.audio.bits", { bits: a.bits }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

