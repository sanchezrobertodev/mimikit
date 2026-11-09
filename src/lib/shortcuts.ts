// Every keyboard shortcut in one table. The shortcuts dialog (?), the library hint bar and the full-screen legend all
// read it. The keys themselves are handled in App.tsx (onKey), Palette.tsx, AssetBrowser.tsx, the viewers (useViewerKeys
// in Viewers.tsx and AudioView.tsx) and the star rating in Peek.tsx: when adding a binding there, add its row here and its label to locales/en/shortcuts.json.
import { t, type TKey } from "./i18n";

export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const mod = isMac ? "⌘" : `${t("shortcuts.keys.ctrl")} `;
const shift = isMac ? "⇧" : `${t("shortcuts.keys.shift")} `;
const arrows = "↑ ↓ ← →";

export const GROUPS = ["navigate", "preview", "organize", "search"] as const;
export type Group = (typeof GROUPS)[number];
export const groupName = (g: Group) => t(`shortcuts.groups.${g}`);

export interface Shortcut {
  id: string;
  group: Group;
  /** As shown in one key cap. */
  keys: string;
  label: string;
  /** Short lowercase label for the hint bar and the full-screen legend. */
  hint?: string;
}

const ROWS: [id: string, group: Group, keys: string][] = [
  ["move", "navigate", arrows],
  ["parent", "navigate", isMac ? "⌥↑" : `${t("shortcuts.keys.alt")} ↑`],
  ["back", "navigate", t("shortcuts.keys.esc")],
  ["skip", "navigate", t("shortcuts.keys.tab")],
  ["help", "navigate", "?"],
  ["sidebar", "navigate", `${mod}B`],
  ["fullscreen", "navigate", isMac ? "⌃⌘F" : "F11"],

  ["peek", "preview", t("shortcuts.keys.space")],
  ["full", "preview", "↵"],
  ["full-back", "preview", t("shortcuts.keys.esc")],
  ["zoom", "preview", "+ −"],
  ["zoom-fit", "preview", `${mod}0`],
  ["seek", "preview", "J L"],

  ["favorite", "organize", "F"],
  ["rate", "organize", "1–5"],
  ["unrate", "organize", "0"],
  ["stars", "organize", "← →"],
  ["tag", "organize", "↵"],
  ["select-all", "organize", `${mod}A`],
  ["toggle", "organize", isMac ? "⌘ click" : t("shortcuts.keys.ctrlClick")],
  ["range", "organize", t("shortcuts.keys.shiftClick")],
  ["range-keys", "organize", `${shift}${arrows}`],
  ["focus-keys", "organize", `${mod}${arrows}`],
  ["toggle-key", "organize", `${isMac ? "⌃" : mod}${t("shortcuts.keys.space")}`],
  ["undo", "organize", `${mod}Z`],

  ["search", "search", `${mod}K`],
  ["search-slash", "search", "/"],
  ["results", "search", "↑ ↓"],
  ["run", "search", "↵"],
  ["meaning", "search", `${shift}↵`],
  ["ask", "search", `${mod}↵`],
  ["close", "search", t("shortcuts.keys.esc")],
];

const HINTS = new Set(["move", "peek", "full", "full-back", "favorite", "rate", "unrate", "search"]);

export const SHORTCUTS: Shortcut[] = ROWS.map(([id, group, keys]) => ({
  id,
  group,
  keys,
  label: t(`shortcuts.label.${id}` as TKey),
  hint: HINTS.has(id) ? t(`shortcuts.hint.${id}` as TKey) : undefined,
}));

export const shortcut = (id: string) => SHORTCUTS.find((s) => s.id === id)!;
