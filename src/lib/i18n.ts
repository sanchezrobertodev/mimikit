// Translations. The strings live in src/locales/<language>/<namespace>.json (the i18next v4 JSON shape) and are
// registered by src/locales.ts. This file has no run-time imports, so the Node tests can load it.
//
// t("peek.title") looks a key up in the chosen language, then in English. {{name}} placeholders take `vars`, numbers
// formatted for the locale. With a numeric `count`, "key_one" / "key_other" (and "_zero", "_few", "_many" where the
// language has them) are picked by Intl.PluralRules.
import type agents from "../locales/en/agents.json";
import type analysis from "../locales/en/analysis.json";
import type api from "../locales/en/api.json";
import type app from "../locales/en/app.json";
import type appUpdate from "../locales/en/appUpdate.json";
import type assetBrowser from "../locales/en/assetBrowser.json";
import type audioView from "../locales/en/audioView.json";
import type collectionsView from "../locales/en/collectionsView.json";
import type colors from "../locales/en/colors.json";
import type duplicatesView from "../locales/en/duplicatesView.json";
import type errors from "../locales/en/errors.json";
import type filterPanel from "../locales/en/filterPanel.json";
import type fmt from "../locales/en/fmt.json";
import type fullView from "../locales/en/fullView.json";
import type header from "../locales/en/header.json";
import type homeView from "../locales/en/homeView.json";
import type insightsView from "../locales/en/insightsView.json";
import type meaning from "../locales/en/meaning.json";
import type modelView from "../locales/en/modelView.json";
import type palette from "../locales/en/palette.json";
import type peek from "../locales/en/peek.json";
import type settings from "../locales/en/settings.json";
import type shortcuts from "../locales/en/shortcuts.json";
import type sidebar from "../locales/en/sidebar.json";
import type store from "../locales/en/store.json";
import type tagging from "../locales/en/tagging.json";
import type themes from "../locales/en/themes.json";
import type thumb from "../locales/en/thumb.json";
import type ui from "../locales/en/ui.json";
import type viewers from "../locales/en/viewers.json";
import type welcome from "../locales/en/welcome.json";

interface Resources {
  agents: typeof agents;
  analysis: typeof analysis;
  api: typeof api;
  app: typeof app;
  appUpdate: typeof appUpdate;
  assetBrowser: typeof assetBrowser;
  audioView: typeof audioView;
  collectionsView: typeof collectionsView;
  colors: typeof colors;
  duplicatesView: typeof duplicatesView;
  errors: typeof errors;
  filterPanel: typeof filterPanel;
  fmt: typeof fmt;
  fullView: typeof fullView;
  header: typeof header;
  homeView: typeof homeView;
  insightsView: typeof insightsView;
  meaning: typeof meaning;
  modelView: typeof modelView;
  palette: typeof palette;
  peek: typeof peek;
  settings: typeof settings;
  shortcuts: typeof shortcuts;
  sidebar: typeof sidebar;
  store: typeof store;
  tagging: typeof tagging;
  themes: typeof themes;
  thumb: typeof thumb;
  ui: typeof ui;
  viewers: typeof viewers;
  welcome: typeof welcome;
}

type Plural = "zero" | "one" | "two" | "few" | "many" | "other";
type Base<K extends string> = K extends `${infer B}_${Plural}` ? B : K;
type Keys<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${Base<K>}` : Keys<T[K], `${P}${K}.`>;
}[keyof T & string];
/** Every key in the English strings, plural forms without their suffix. */
export type TKey = Keys<Resources>;

export type Vars = Record<string, string | number>;
interface Dict {
  [k: string]: string | Dict;
}

const dicts = new Map<string, Dict>();
let lang = "en";
let region = "en";
let plural = new Intl.PluralRules("en");
const enPlural = plural;
let nf = new Intl.NumberFormat("en");

/** Adds one namespace file of a language. */
export function addLocale(code: string, ns: string, dict: Dict) {
  const d = dicts.get(code) ?? {};
  d[ns] = dict;
  dicts.set(code, d);
}

/** The languages that have strings, English first. */
export const locales = () => ["en", ...[...dicts.keys()].filter((c) => c !== "en").sort()];

/**
 * Picks the UI language (English when it has no strings) and the locale numbers and dates are formatted in: a regional
 * variant of the same language (en-GB for English), or the language itself.
 */
export function setLocale(code: string, format = code) {
  lang = dicts.has(code) ? code : "en";
  region = format.split("-")[0].toLowerCase() === lang.split("-")[0].toLowerCase() ? format : lang;
  plural = new Intl.PluralRules(lang);
  nf = new Intl.NumberFormat(region);
}

/**
 * The best of `available` for the OS languages in `wanted`, in order, or "en": the same tag, else the same language
 * (any Spanish gets es, any Portuguese pt-BR). Traditional Chinese (zh-Hant, zh-TW, zh-HK, zh-MO) doesn't get
 * Simplified.
 */
export function matchLocale(wanted: readonly string[], available: readonly string[]): string {
  const base = (l: string) => l.split("-")[0].toLowerCase();
  for (const w of wanted) {
    const same = available.find((a) => a.toLowerCase() === w.toLowerCase());
    if (same) return same;
    if (base(w) === "zh" && !/-hans(-|$)/i.test(w) && /-(hant|tw|hk|mo)(-|$)/i.test(w)) continue;
    const near = available.find((a) => base(a) === base(w));
    if (near) return near;
  }
  return "en";
}

export const locale = () => lang;
/** The locale for Intl formatters. */
export const formatLocale = () => region;

function lookup(code: string, key: string): string | undefined {
  let d: string | Dict | undefined = dicts.get(code);
  for (const part of key.split(".")) {
    if (typeof d !== "object") return undefined;
    d = d[part];
  }
  return typeof d === "string" ? d : undefined;
}

function find(key: string, count: unknown): string {
  for (const code of lang === "en" ? ["en"] : [lang, "en"]) {
    if (typeof count === "number") {
      const rules = code === lang ? plural : enPlural;
      const s =
        (count === 0 ? lookup(code, `${key}_zero`) : undefined) ?? lookup(code, `${key}_${rules.select(count)}`) ?? lookup(code, `${key}_other`);
      if (s !== undefined) return s;
    }
    const s = lookup(code, key);
    if (s !== undefined) return s;
  }
  return key;
}

const fill = (s: string, vars?: Vars) =>
  vars ? s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => (name in vars ? (typeof vars[name] === "number" ? nf.format(vars[name]) : vars[name]) : m)) : s;

export function t(key: TKey, vars?: Vars): string {
  return fill(find(key, vars?.count), vars);
}

/** Text with numbered tags: "Press <0>Space</0>" is ["Press ", { tag: 0, children: ["Space"] }]. `<0/>` has children null. */
export type TagNode = string | { tag: number; children: TagNode[] | null };

export function parseTags(s: string): TagNode[] {
  const root: TagNode[] = [];
  const stack: { tag: number; children: TagNode[] }[] = [];
  const out = () => (stack.length ? stack[stack.length - 1].children : root);
  let last = 0;
  for (const m of s.matchAll(/<(\/?)(\d+)(\/?)>/g)) {
    if (m.index > last) out().push(s.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = Number(m[2]);
    if (m[3]) out().push({ tag, children: null });
    else if (!m[1]) stack.push({ tag, children: [] });
    else if (stack.length && stack[stack.length - 1].tag === tag) {
      const node = stack.pop()!;
      out().push(node);
    } else out().push(m[0]);
  }
  if (last < s.length) out().push(s.slice(last));
  // An unclosed tag keeps its text.
  while (stack.length) {
    const node = stack.pop()!;
    out().push(`<${node.tag}>`, ...node.children);
  }
  return root;
}

/** {@link t} split at its tags, placeholders filled after the split so a value can't add tags. */
export function tNodes(key: TKey, vars?: Vars): TagNode[] {
  const walk = (nodes: TagNode[]): TagNode[] =>
    nodes.map((n) => (typeof n === "string" ? fill(n, vars) : { tag: n.tag, children: n.children && walk(n.children) }));
  return walk(parseTags(find(key, vars?.count)));
}

const ERROR_VAR = /\{\{\s*(\w+)\s*\}\}/g;
let errorPatterns: { key: string; re: RegExp; names: string[] }[] | null = null;

/**
 * A backend error in the UI language. The English "errors" strings are written like the Rust messages, with {{name}}
 * where Rust inserts a value; a message matching one is shown translated, and a value that is itself a known message
 * (a nested error) is translated too. Anything else (OS and library errors) is returned as it is.
 */
export function translateError(msg: string): string {
  if (lang === "en") return msg;
  errorPatterns ??= Object.entries((dicts.get("en")?.errors ?? {}) as Dict)
    .filter((e): e is [string, string] => typeof e[1] === "string")
    .map(([key, s]) => ({
      key: `errors.${key}`,
      names: [...s.matchAll(ERROR_VAR)].map((m) => m[1]),
      re: new RegExp(`^${s.split(ERROR_VAR).map((part, i) => (i % 2 ? "(.+?)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`, "s"),
    }));
  for (const p of errorPatterns) {
    const m = msg.match(p.re);
    if (m) return t(p.key as TKey, Object.fromEntries(p.names.map((n, i) => [n, translateError(m[i + 1])])));
  }
  return msg;
}
