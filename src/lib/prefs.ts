// Per-viewer UI preferences. Storage can be unavailable, so every access is guarded.

import { getCurrentWindow } from "@tauri-apps/api/window";
import type { FolderFilter } from "../types";
import { ACCENTS, THEMES, accentById, themeById, type AccentId, type Scheme, type ThemeId } from "./themes";

export type Theme = "system" | ThemeId;
export type SortKey = "name" | "kind" | "size" | "mtime" | "folder";
export type Layout = "grid" | "list";
/** How a type shows on its filter chip and label: icon and name, icon only, or name only. */
export type KindLabels = "both" | "icon" | "name";
/** The view Mimikit opens on. */
export type StartView = "home" | "library";
/** The left sidebar: full, or a rail of section icons. */
export type SidebarMode = "expanded" | "collapsed";
/** Claude models the AI features can use, cheapest first (ai.rs `Model` accepts the same ids). */
export const AI_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;
export const AI_EFFORTS = ["low", "medium", "high"] as const;
export interface AiPrefs {
  /** AI features at all: off hides Ask, Suggest tags and AI agents everywhere (Settings › General). Off at first while in beta. */
  on: boolean;
  model: (typeof AI_MODELS)[number];
  effort: (typeof AI_EFFORTS)[number];
  /** Suggest tags' model, always at low effort. Haiku by default: by far the cheapest (see the M3 eval). */
  tagModel: (typeof AI_MODELS)[number];
}

export interface Prefs {
  theme: Theme;
  accent: AccentId;
  /** "system" (the OS languages) or a folder in src/locales. */
  language: string;
  sort: { key: SortKey; desc: boolean };
  layout: Layout;
  thumbSize: number;
  pixelated: boolean;
  kindLabels: KindLabels;
  startView: StartView;
  /** The folders opened last, newest first, for Home and the folder menu. */
  recentFolders: FolderFilter[];
  /** Group the library by folder, as in the design. */
  grouped: boolean;
  /** With a folder open, also show its subfolders' files. */
  subfolders: boolean;
  /** Look for a new version of Mimikit shortly after launch. */
  checkUpdates: boolean;
  /** Audio previews start again when they end. */
  audioLoop: boolean;
  sidebar: SidebarMode;
  /** The model and effort for Ask (and later AI features), in Settings › AI. */
  ai: AiPrefs;
}

const defaults: Prefs = {
  theme: "system",
  accent: "green",
  language: "system",
  sort: { key: "name", desc: false },
  layout: "grid",
  thumbSize: 160,
  pixelated: false,
  kindLabels: "both",
  startView: "home",
  recentFolders: [],
  grouped: true,
  subfolders: true,
  checkUpdates: true,
  audioLoop: false,
  sidebar: "expanded",
  ai: { on: false, model: "claude-haiku-5-5", effort: "low", tagModel: "claude-haiku-5-5" },
};

const KEY = "assetden.prefs.v2";

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<Prefs>;
    const p: Prefs = { ...defaults, ...saved };
    // A theme or accent from a newer or older version falls back rather than leaving the page without colours.
    if (p.theme !== "system" && !THEMES.some((t) => t.id === p.theme)) p.theme = defaults.theme;
    if (!ACCENTS.some((a) => a.id === p.accent)) p.accent = defaults.accent;
    if (!["both", "icon", "name"].includes(p.kindLabels)) p.kindLabels = defaults.kindLabels;
    if (!["home", "library"].includes(p.startView)) p.startView = defaults.startView;
    if (!["expanded", "collapsed"].includes(p.sidebar)) p.sidebar = defaults.sidebar;
    if (!Array.isArray(p.recentFolders)) p.recentFolders = defaults.recentFolders;
    // A model a later version dropped falls back to the default rather than failing every Ask.
    p.ai = {
      // Saved before the switch existed: AI stays on, since Ask, Suggest tags or agents may already be in use.
      on: typeof saved.ai?.on === "boolean" ? saved.ai.on : true,
      model: AI_MODELS.includes(p.ai?.model) ? p.ai.model : defaults.ai.model,
      effort: AI_EFFORTS.includes(p.ai?.effort) ? p.ai.effort : defaults.ai.effort,
      tagModel: AI_MODELS.includes(p.ai?.tagModel) ? p.ai.tagModel : defaults.ai.tagModel,
    };
    return p;
  } catch {
    return defaults;
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: preferences just won't persist */
  }
}

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

/** The theme on screen: System follows the OS light/dark setting. */
export const resolveTheme = (theme: Theme): ThemeId => (theme !== "system" ? theme : media?.matches ? "dark" : "light");

let windowTheme: Scheme | null | undefined;

export function applyTheme(theme: Theme, accent: AccentId) {
  const t = themeById(resolveTheme(theme));
  const a = accentById(accent);
  const root = document.documentElement;
  root.dataset.theme = t.id;
  root.dataset.scheme = t.scheme;
  root.style.setProperty("--accent-h", String(a.h));
  root.style.setProperty("--accent-c-light", String(a.light));
  root.style.setProperty("--accent-c-dark", String(a.dark));
  // The native title bar follows the theme. System passes null: WebView2 copies the window theme into
  // prefers-color-scheme, so a fixed one would stop System from following the OS.
  const win = theme === "system" ? null : t.scheme;
  if (win === windowTheme) return;
  windowTheme = win;
  try {
    void getCurrentWindow()
      .setTheme(win)
      .catch(() => {});
  } catch {
    /* not running in Tauri (plain browser) */
  }
}

/** Calls `cb` whenever the theme or accent on screen changes, including when the OS switches light/dark. */
export function onThemeColors(cb: () => void) {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-scheme", "style"] });
  return () => o.disconnect();
}

/** A colour token's current value, for canvases that can't use CSS (waveforms, the 3D grid). */
export const themeColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** The OS "reduce motion" setting: then nothing animates or starts playing by itself. */
export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function onSystemThemeChange(cb: () => void) {
  media?.addEventListener("change", cb);
  return () => media?.removeEventListener("change", cb);
}
