import type { Asset, Collection, CollectionRule, FolderFilter, Kind, Notes, Root, ViewName } from "../types";
import { hasColor, parseColor, type LabSwatch } from "./colors.ts";
import { folderOf, rootLabel } from "./format.ts";
import type { SortKey } from "./prefs";

/** Extra filters from the Filters panel. null / empty means "any". */
export interface Filters {
  exts: string[];
  minW: number | null;
  maxW: number | null;
  minH: number | null;
  maxH: number | null;
  square: boolean;
  minBytes: number | null;
  maxBytes: number | null;
  /** Modified within this many days. */
  days: number | null;
  untagged: boolean;
  /** Only assets with tags Claude suggested, waiting for review. */
  suggested: boolean;
  /** Has at least one of these tags. */
  anyTags: string[];
  /** At least this many stars. */
  minRating: number | null;
  /** Audio length in milliseconds. */
  minMs: number | null;
  maxMs: number | null;
  /** A main colour: a name from NAMED_COLORS or "#rrggbb". */
  color: string | null;
}

/** Dominant colours by image id, for colour filters. */
export type Palettes = ReadonlyMap<number, LabSwatch[]>;
/** Search by meaning's score of each indexed image by id, for each `looks:` phrase the store has scored. */
export type Looks = ReadonlyMap<string, ReadonlyMap<number, number>>;

export const noFilters: Filters = {
  exts: [],
  minW: null,
  maxW: null,
  minH: null,
  maxH: null,
  square: false,
  minBytes: null,
  maxBytes: null,
  days: null,
  untagged: false,
  suggested: false,
  anyTags: [],
  minRating: null,
  minMs: null,
  maxMs: null,
  color: null,
};

/** How many filter groups are active, for the badge on the Filters button. */
export function activeFilterCount(f: Filters): number {
  const dims = f.minW !== null || f.maxW !== null || f.minH !== null || f.maxH !== null || f.square;
  const bytes = f.minBytes !== null || f.maxBytes !== null;
  const dur = f.minMs !== null || f.maxMs !== null;
  return [f.exts.length > 0, dims, bytes, dur, f.days !== null, f.untagged, f.suggested, f.anyTags.length > 0, f.minRating !== null, f.color !== null].filter(Boolean).length;
}

/** True without limits; with any, only a known length within them. */
const inRange = (ms: number | null, min: number | null, max: number | null) =>
  (min === null && max === null) || (ms !== null && (min === null || ms >= min) && (max === null || ms <= max));

export function matchesFilters(a: Asset, f: Filters, now = Date.now(), palettes?: Palettes | null): boolean {
  if (f.exts.length && !f.exts.includes(a.ext)) return false;
  // Dimension filters only make sense for images with known dimensions.
  if (f.minW !== null || f.maxW !== null || f.minH !== null || f.maxH !== null || f.square) {
    if (!a.width || !a.height) return false;
    if (f.minW !== null && a.width < f.minW) return false;
    if (f.maxW !== null && a.width > f.maxW) return false;
    if (f.minH !== null && a.height < f.minH) return false;
    if (f.maxH !== null && a.height > f.maxH) return false;
    if (f.square && a.width !== a.height) return false;
  }
  if (f.minBytes !== null && a.size < f.minBytes) return false;
  if (f.maxBytes !== null && a.size > f.maxBytes) return false;
  if (!inRange(a.durationMs, f.minMs, f.maxMs)) return false;
  if (f.days !== null && a.mtime < now - f.days * 86_400_000) return false;
  if (f.untagged && a.tags.length) return false;
  if (f.suggested && !a.suggested.length) return false;
  if (f.anyTags.length && !a.tags.some((t) => f.anyTags.includes(t))) return false;
  if (f.minRating !== null && a.rating < f.minRating) return false;
  if (f.color && !hasColor(palettes?.get(a.id), f.color)) return false;
  return true;
}

/**
 * A search like `type:audio in:sprites #player size:>1mb dur:<2s rating:>=4 note:redo color:red looks:red-potion hero`,
 * as used by the search bar and the ⌘K palette.
 */
export interface Query {
  /** null = any type; an empty array = a `type:` that matched nothing. */
  types: Kind[] | null;
  folder: string | null;
  tags: string[];
  minBytes: number;
  maxBytes: number;
  minRating: number;
  maxRating: number;
  /** Words the asset's note must contain. */
  notes: string[];
  /** Audio length limits from `dur:`, in milliseconds. */
  minMs: number | null;
  maxMs: number | null;
  /** Colours the image must all have (see Filters.color); null for a `color:` that names no colour. */
  colors: (string | null)[];
  /** What the image must show (search by meaning), from `looks:red-potion-icon`: hyphens become spaces. */
  looks: string[];
  text: string[];
}

/** `type:` takes a kind or the start of its English name, whatever the UI language, so saved searches keep matching. */
export const KIND_NAMES: Record<Kind, string> = { image: "images", audio: "audio", model: "3d models", font: "fonts", video: "video", text: "text & data", other: "other" };
/** Full-width forms of the search operators, as Japanese and Chinese input methods type them. */
const FULL_WIDTH = /[：＃＞＜＝]/g;

export const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 ** 3 };
export const TIME_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000 };

export function parseQuery(q: string): Query {
  const out: Query = { types: null, folder: null, tags: [], minBytes: 0, maxBytes: Infinity, minMs: null, maxMs: null, minRating: 0, maxRating: 5, notes: [], colors: [], looks: [], text: [] };
  for (const t of q.replace(FULL_WIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase().split(/\s+/).filter(Boolean)) {
    if (t.startsWith("type:")) {
      const s = t.slice(5);
      if (!s) continue;
      const hits = (Object.keys(KIND_NAMES) as Kind[]).filter((k) => k.startsWith(s) || KIND_NAMES[k].startsWith(s));
      out.types = [...(out.types ?? []), ...hits];
    } else if (t.startsWith("in:")) {
      if (t.length > 3) out.folder = t.slice(3);
    } else if (t.startsWith("#")) {
      if (t.length > 1) out.tags.push(t.slice(1));
    } else if (t.startsWith("size:")) {
      const m = t.slice(5).match(/^([<>])?(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/);
      if (!m) continue;
      const b = parseFloat(m[2]) * UNITS[m[3] ?? "kb"];
      if (m[1] === "<") out.maxBytes = b;
      else out.minBytes = b;
    } else if (t.startsWith("dur:")) {
      const m = t.slice(4).match(/^([<>])?(\d+(?:\.\d+)?)(ms|s|m)?$/);
      if (!m) continue;
      const ms = parseFloat(m[2]) * TIME_UNITS[m[3] ?? "s"];
      if (m[1] === "<") out.maxMs = ms;
      else out.minMs = ms;
    } else if (t.startsWith("rating:")) {
      // rating:3 is exactly 3 stars; rating:>=4, rating:<2 and so on compare.
      const m = t.slice(7).match(/^(>=|<=|>|<)?([0-5])$/);
      if (!m) continue;
      const n = Number(m[2]);
      if (!m[1]) [out.minRating, out.maxRating] = [n, n];
      else if (m[1] === ">=") out.minRating = n;
      else if (m[1] === ">") out.minRating = n + 1;
      else if (m[1] === "<=") out.maxRating = n;
      else out.maxRating = n - 1;
    } else if (t.startsWith("note:")) {
      if (t.length > 5) out.notes.push(t.slice(5));
    } else if (t.startsWith("color:")) {
      if (t.length > 6) out.colors.push(parseColor(t.slice(6)));
    } else if (t.startsWith("looks:")) {
      const phrase = t.slice(6).replace(/-+/g, " ").trim();
      if (phrase) out.looks.push(phrase);
    } else out.text.push(t);
  }
  return out;
}

/**
 * `notes` is only read for `note:` words, `palettes` for `color:` ones and `looks` for `looks:` ones. A `looks:` word
 * only needs a score here: `closeLooks` then keeps the close matches.
 */
export function matchesQuery(a: Asset, q: Query, notes: Notes = {}, palettes?: Palettes | null, looks?: Looks | null): boolean {
  if (q.types && !q.types.includes(a.kind)) return false;
  if (q.folder && !folderOf(a.relPath).toLowerCase().split("/").some((seg) => seg.startsWith(q.folder!))) return false;
  if (!q.tags.every((t) => a.tags.some((g) => g.startsWith(t)))) return false;
  if (a.size < q.minBytes || a.size > q.maxBytes) return false;
  if (!inRange(a.durationMs, q.minMs, q.maxMs)) return false;
  if (a.rating < q.minRating || a.rating > q.maxRating) return false;
  if (q.notes.length) {
    const note = notes[a.id]?.toLowerCase();
    if (!note || !q.notes.every((w) => note.includes(w))) return false;
  }
  if (!q.colors.every((c) => c !== null && hasColor(palettes?.get(a.id), c))) return false;
  if (!q.looks.every((p) => looks?.get(p)?.has(a.id))) return false;
  const hay = a.relPath.toLowerCase();
  return q.text.every((t) => hay.includes(t) || a.tags.includes(t));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const compare: Record<SortKey, (a: Asset, b: Asset) => number> = {
  name: (a, b) => collator.compare(a.name, b.name),
  kind: (a, b) => a.kind.localeCompare(b.kind) || collator.compare(a.name, b.name),
  size: (a, b) => a.size - b.size,
  mtime: (a, b) => a.mtime - b.mtime,
  folder: (a, b) => collator.compare(folderOf(a.relPath), folderOf(b.relPath)) || collator.compare(a.name, b.name),
};

export interface Scope {
  view: ViewName;
  kinds: Kind[];
  folder: FolderFilter | null;
  /** With a folder: also show files in its subfolders. */
  subfolders: boolean;
  query: string;
  filters: Filters;
  /** The open collection, for the Collections view. */
  collection: Collection | null;
  notes: Notes;
  /** "Find similar" results, closest first: only these are shown, in this order. */
  similar?: number[] | null;
  /** Search by meaning: each indexed image's score. Only these are shown, best first, cut to the close matches. */
  meaning?: ReadonlyMap<number, number> | null;
  palettes?: Palettes | null;
  looks?: Looks | null;
  /** More narrowing (an agent's folder, or favorites inside a collection), before `looks:` takes its closest matches. */
  within?: (a: Asset) => boolean;
}

/** Search by meaning keeps at most this many results, all within `MEANING_SPREAD` of the best score (phase 0 eval). */
export const MEANING_TOP = 200;
export const MEANING_SPREAD = 0.05;

/** The close matches of a search by meaning: best first, at most MEANING_TOP, within MEANING_SPREAD of the best. Sorts `list`. */
function closest(list: Asset[], score: (a: Asset) => number): Asset[] {
  list.sort((a, b) => score(b) - score(a));
  const floor = list.length ? score(list[0]) - MEANING_SPREAD : 0;
  const end = list.findIndex((a, i) => i >= MEANING_TOP || score(a) < floor);
  return end < 0 ? list : list.slice(0, end);
}

/**
 * Keeps the assets of `list` that are close matches of every `looks:` phrase, best first (by their summed scores).
 * `list` matched everything else in the search, scores included, so a folder or filter gets its own best matches.
 */
export function closeLooks(list: Asset[], phrases: string[], looks?: Looks | null): Asset[] {
  if (!phrases.length || !list.length) return list;
  const maps = phrases.map((p) => looks!.get(p)!);
  const keep = maps.map((m) => new Set(closest([...list], (a) => m.get(a.id)!)));
  const sum = (a: Asset) => maps.reduce((n, m) => n + m.get(a.id)!, 0);
  return list.filter((a) => keep.every((k) => k.has(a))).sort((a, b) => sum(b) - sum(a));
}

/** A smart collection's members: the assets its saved search matches now, best first for a `looks:` one. */
export function ruleMembers(rule: CollectionRule, assets: Asset[], notes: Notes, now = Date.now(), palettes?: Palettes | null, looks?: Looks | null): Asset[] {
  const q = parseQuery(rule.query);
  const f = { ...noFilters, ...rule.filters };
  return closeLooks(assets.filter((a) => matchesFilters(a, f, now, palettes) && matchesQuery(a, q, notes, palettes, looks)), q.looks, looks);
}

/** Whether a smart collection searches by colour: only then do members change as colours are analysed. */
export const rulesWantColors = (collections: Collection[]) =>
  collections.some((c) => c.rule && (!!c.rule.filters.color || parseQuery(c.rule.query).colors.length > 0));

/** The `looks:` phrases smart collections search for: their members change as these are scored. */
export const ruleLooks = (collections: Collection[]) => collections.flatMap((c) => (c.rule ? parseQuery(c.rule.query).looks : []));

/** Each smart collection's current members, by collection id. */
export function smartMembers(collections: Collection[], assets: Asset[], notes: Notes, palettes?: Palettes | null, looks?: Looks | null): Map<number, Asset[]> {
  const now = Date.now();
  return new Map(collections.flatMap((c) => (c.rule ? [[c.id, ruleMembers(c.rule, assets, notes, now, palettes, looks)] as const] : [])));
}

/** Assets the current view shows, after type chips, folder, search and Filters panel, sorted (unless `sort` is null). */
export function visibleAssets(assets: Asset[], s: Scope, sort: { key: SortKey; desc: boolean } | null): Asset[] {
  const now = Date.now();
  const rule = s.view === "collections" && s.collection?.rule ? s.collection.rule : null;
  const smart = rule ? ruleMembers(rule, assets, s.notes, now, s.palettes, s.looks) : null;
  const members = s.view === "collections" ? new Set(smart?.map((a) => a.id) ?? s.collection?.assetIds ?? []) : null;
  // "Find similar" keeps its order, and so does a smart collection searching by meaning (best first).
  const order = s.similar ?? (rule && parseQuery(rule.query).looks.length ? smart!.map((a) => a.id) : null);
  const rank = order ? new Map(order.map((id, i) => [id, i])) : null;
  const q = parseQuery(s.query);
  const out = assets.filter((a) => {
    // A collection's members, narrowed by the type chips, search and Filters panel like any other view.
    if (members && !members.has(a.id)) return false;
    if (s.view === "favorites" && !a.favorite) return false;
    if (s.within && !s.within(a)) return false;
    if (rank && !rank.has(a.id)) return false;
    if (s.meaning && !s.meaning.has(a.id)) return false;
    if (s.kinds.length && !s.kinds.includes(a.kind)) return false;
    // Only the library and favorites show the open folder, so only they are narrowed by it.
    if (s.folder && (s.view === "library" || s.view === "favorites")) {
      if (a.rootId !== s.folder.rootId) return false;
      if (!s.subfolders) {
        if (folderOf(a.relPath) !== s.folder.path) return false;
      } else if (s.folder.path && !a.relPath.startsWith(s.folder.path + "/")) return false;
    }
    return matchesFilters(a, s.filters, now, s.palettes) && matchesQuery(a, q, s.notes, s.palettes, s.looks);
  });
  // The cuts are taken after the other filters, so a narrow folder still gets its own best matches; even unsorted
  // (the type chips' counts), since they decide what's in.
  const looked = closeLooks(out, q.looks, s.looks);
  const meaning = s.meaning;
  if (meaning) return closest(looked, (a) => meaning.get(a.id)!);
  // `looks:` words show the best matches first, whatever the sort.
  if (!sort || q.looks.length) return looked;
  if (rank) return out.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const dir = sort.desc ? -1 : 1;
  return out.sort((a, b) => dir * compare[sort.key](a, b));
}

export interface Group {
  key: string;
  label: string;
  items: Asset[];
  bytes: number;
}

/**
 * Splits a sorted list into folder groups (keeping the sort inside each), folders in name order. With `base` (the open
 * folder), labels start at that folder's name, like "hero/idle" inside characters/hero.
 */
export function groupByFolder(list: Asset[], roots: Root[], base: FolderFilter | null = null): Group[] {
  const rootName = new Map(roots.map((r) => [r.id, rootLabel(roots, r.id)]));
  const multi = roots.length > 1 && !base;
  const trim = base?.path ? folderOf(base.path) : "";
  const groups = new Map<string, Group>();
  for (const a of list) {
    const folder = folderOf(a.relPath);
    const key = `${a.rootId}:${folder}`;
    let g = groups.get(key);
    if (!g) {
      const rel = trim && folder.startsWith(trim + "/") ? folder.slice(trim.length + 1) : folder;
      const label = [multi ? rootName.get(a.rootId) : "", rel].filter(Boolean).join("/") || rootName.get(a.rootId) || "/";
      g = { key, label, items: [], bytes: 0 };
      groups.set(key, g);
    }
    g.items.push(a);
    g.bytes += a.size;
  }
  return [...groups.values()].sort((a, b) => collator.compare(a.label, b.label));
}
