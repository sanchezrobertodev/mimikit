import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { api, errorText } from "./api";
import { toLab, type LabSwatch, type Swatch } from "./lib/colors";
import { applyDeltas, deltasAfter, type AssetsDelta } from "./lib/delta";
import { noFilters, parseQuery, ruleMembers, type Filters, type Looks } from "./lib/filter";
import { ancestorKeys } from "./lib/folders";
import { t, type TKey, type Vars } from "./lib/i18n";
import { latestRequest } from "./lib/latest";
import type { TaggingStatus } from "./lib/tagging";
import { markSeen, seenVersion } from "./lib/news";
import { applyTheme, loadPrefs, savePrefs, type AiPrefs, type KindLabels, type Layout, type Prefs, type SortKey, type StartView, type Theme } from "./lib/prefs";
import type { AccentId } from "./lib/themes";
import { forgetThumbnails, saveFontSample, thumbnailFor } from "./lib/thumbs";
import type { AnalysisStatus, Asset, Collection, CollectionRule, DupGroup, FolderFilter, Kind, MeaningStatus, Notes, Root, SpriteSheet, ViewName } from "./types";

export interface Toast {
  id: number;
  message: string;
  undo?: () => void | Promise<void>;
  /** Label of the `undo` button, when it does something else. */
  action?: string;
  error?: boolean;
}

interface State extends Prefs {
  roots: Root[];
  assets: Asset[];
  collections: Collection[];
  /** Files indexed so far, per root being scanned. */
  scanning: Record<number, number>;
  /** Roots whose folder couldn't be read on their last scan. */
  missing: Record<number, boolean>;
  view: ViewName;
  kinds: Kind[];
  folder: FolderFilter | null;
  query: string;
  filters: Filters;
  selected: Set<number>;
  activeId: number | null;
  /** Side panel with the active asset (Space). */
  peek: boolean;
  /** Full-screen view of the active asset (Enter). */
  full: boolean;
  /** The app window fills the screen (F11), not to be confused with `full`. */
  fullscreen: boolean;
  /** The window is too narrow for the full sidebar, so it shows the rail unless `narrowOpen`. */
  narrow: boolean;
  /** The full sidebar opened by hand in a narrow window; not saved. */
  narrowOpen: boolean;
  palette: boolean;
  /** Open app dialog: keyboard shortcuts (?) or Settings. */
  modal: "shortcuts" | "settings" | null;
  toast: Toast | null;
  /** Open collection in the Collections view. */
  colSel: number | null;
  dups: DupGroup[] | null;
  /** The open duplicate group, by hash. */
  dupSel: string | null;
  /** Folder-tree nodes that are open, by folder key. */
  expanded: Set<string>;
  /** Most recently opened folders, newest first. */
  recentFolders: FolderFilter[];
  /** Saved sprite-sheet slicing by asset id, loaded on demand; null when the asset has none. */
  sheets: Record<number, SpriteSheet | null>;
  /** Every asset note, loaded with the library: the side panel edits them and `note:` searches them. */
  notes: Notes;
  /** Dominant colours by image id, loaded the first time a colour filter is used; null until then. */
  palettes: Map<number, LabSwatch[]> | null;
  /** How many images are analysed for colours and similarity, and the analysis pass the user started. */
  analysis: AnalysisStatus;
  /** Search by meaning: its download and index. */
  meaning: MeaningStatus;
  /** Suggest tags: batches out with Claude, and the last run whose results are in. */
  tagging: TaggingStatus;
  /** The assets the Suggest tags dialog is open for. */
  suggestFor: number[] | null;
  /** "Find similar" scope of the library: images like `id` within `max` bits, closest first. */
  similar: { id: number; name: string; max: number; ids: number[] } | null;
  /**
   * Search by meaning: images that show `text`, with every indexed image's score (cosine) by id. With `id`, Find
   * related: the images closest to that image (named `text`) by meaning.
   */
  meaningQuery: { text: string; id?: number; scores: ReadonlyMap<number, number> } | null;
  /** Search by meaning's scores for the `looks:` phrases being searched for, by phrase (see resolveLooks). */
  looks: Looks;
  /** Assets an AI agent showed the user (its `show` tool), in its order, and the agent app's name. */
  shown: { ids: number[]; by: string } | null;

  init: () => Promise<void>;
  reload: () => Promise<void>;
  importFolder: () => Promise<void>;
  removeRoot: (id: number) => Promise<void>;
  rescan: (id: number) => Promise<void>;
  /** Points a library folder at the place it moved to, keeping its assets' tags and collections. */
  relinkRoot: (id: number, path: string) => Promise<void>;
  setError: (e: unknown) => void;
  showToast: (message: string, undo?: Toast["undo"], action?: string) => void;
  dismissToast: () => void;
  /** Stops the toast's timer while the pointer or focus is on it; false starts it again. */
  holdToast: (hold: boolean) => void;
  /** Runs a toast's button, or with no argument the last Undo offered (Ctrl+Z, also after its toast has closed). */
  undo: (run?: Toast["undo"]) => void;
  go: (view: ViewName, extra?: Partial<Pick<State, "kinds" | "folder" | "colSel" | "dupSel" | "query">>) => void;
  setQuery: (q: string) => void;
  toggleKind: (k: Kind | "all") => void;
  setFolder: (f: FolderFilter | null) => void;
  setFilters: (f: Partial<Filters>) => void;
  /** Clears the Filters panel, type chips, folder and search. */
  clearFilters: () => void;
  setSort: (key: SortKey) => void;
  setLayout: (l: Layout) => void;
  setGrouped: (g: boolean) => void;
  setSubfolders: (on: boolean) => void;
  toggleExpanded: (key: string) => void;
  setThumbSize: (n: number) => void;
  setTheme: (t: Theme) => void;
  setAccent: (a: AccentId) => void;
  /** Saves the UI language and reloads the window in it. */
  setLanguage: (language: string) => void;
  setPixelated: (p: boolean) => void;
  setKindLabels: (l: KindLabels) => void;
  setStartView: (v: StartView) => void;
  setCheckUpdates: (on: boolean) => void;
  setAudioLoop: (on: boolean) => void;
  setAi: (ai: Partial<AiPrefs>) => void;
  /** Collapses or expands the sidebar; in a narrow window only until it widens again. */
  toggleSidebar: () => void;
  setFullscreen: (on: boolean) => void;
  /** Click selection: plain replaces, toggle adds/removes, range extends from the active item over `order`. */
  select: (id: number, mode?: "replace" | "toggle" | "range", order?: number[]) => void;
  setSelected: (ids: number[]) => void;
  setPeek: (open: boolean) => void;
  setFull: (open: boolean) => void;
  setPalette: (open: boolean) => void;
  setModal: (modal: State["modal"]) => void;
  setFavorite: (ids: number[], favorite: boolean) => Promise<void>;
  addTag: (ids: number[], tag: string) => Promise<void>;
  removeTag: (ids: number[], tag: string) => Promise<void>;
  setSuggestFor: (ids: number[] | null) => void;
  /** Makes Claude's suggestions of `ids` real tags: those in `tags`, or all of them. */
  acceptSuggestions: (ids: number[], tags?: string[]) => Promise<void>;
  rejectSuggestions: (ids: number[], tags?: string[]) => Promise<void>;
  cancelTagging: () => Promise<void>;
  /** 1 to 5 stars, or 0 to clear. */
  setRating: (ids: number[], rating: number) => Promise<void>;
  setNote: (id: number, note: string) => Promise<void>;
  newCollection: () => Promise<void>;
  /** Saves the current search (with its type chips and filters) as a smart collection. False if the name was refused. */
  saveSmartCollection: (name: string) => Promise<boolean>;
  /** Replaces a smart collection's search, by default with the current one. */
  setCollectionRule: (id: number, rule?: CollectionRule) => Promise<void>;
  renameCollection: (id: number, name: string) => Promise<boolean>;
  deleteCollection: (id: number) => Promise<void>;
  setInCollection: (collection: number, ids: number[], member: boolean) => Promise<void>;
  copyCollection: (id: number) => Promise<void>;
  findDuplicates: () => Promise<void>;
  ignoreDuplicate: (hash: string) => Promise<void>;
  trashDuplicates: (keep: number, remove: number[]) => Promise<void>;
  loadSheet: (id: number) => Promise<void>;
  saveSheet: (id: number, sheet: SpriteSheet) => Promise<void>;
  loadPalettes: () => Promise<void>;
  findSimilar: (id: number, max?: number) => Promise<void>;
  clearSimilar: () => void;
  /**
   * Images that show `text`. With `query` (the other search words), opens the library on the results, keeping the open
   * folder, type chips and filters; without, refreshes the open results.
   */
  findByMeaning: (text: string, query?: string) => Promise<void>;
  /** Find related: images close to image `id` by meaning, in the open folder, type chips and filters like findByMeaning. */
  findRelated: (id: number) => Promise<void>;
  /** Drops a search by meaning started from search that hasn't opened yet, when search closes first; true if one was. */
  dropMeaningOpening: () => boolean;
  clearMeaning: () => void;
  /**
   * The `looks:` phrases one part of the window (`by`: the library, search or agents) searches for: scores those not
   * scored yet into `looks`, which keeps only phrases some part wants, and returns the scores of `phrases`. Scores
   * nothing while search by meaning is off.
   */
  resolveLooks: (by: string, phrases: string[]) => Promise<Looks>;
  /** Opens the library on just these assets, for an agent's `show`. */
  showAssets: (ids: number[], by: string) => void;
}

const prefs = loadPrefs();
/** Below this width the sidebar starts as a rail, whatever the saved setting. */
const narrowQuery = typeof window !== "undefined" ? window.matchMedia("(max-width: 1099px)") : null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastMs = 0;
let toastSeq = 0;
/** The newest Undo a toast offered, until it runs. */
let lastUndo: Toast["undo"];
/** Undos still running. */
let undoing = 0;
/** Number of the last delta `assets` includes; -1 until the first full load. */
let seq = -1;
/** Full loads in flight. Deltas wait in `incoming` meanwhile, and the load's `seq` says which of them it already has. */
let loading = 0;
let incoming: AssetsDelta[] = [];
/** A full load failed. Until one succeeds (`seq` >= 0), each new delta retries it. */
let loadFailed = false;
/** The last note save; each one waits for the one before. */
let noteSaves: Promise<unknown> = Promise.resolve();
/** Colours reported while the palettes load, applied on top of what the load returns. */
let paletteBacklog: [number, Swatch[]][] | null = null;
/** "Find similar": answers to superseded (slider drags) or cancelled requests are dropped; re-asked as analysis goes on. */
const similarAsk = latestRequest<{ id: number; max: number }>(2000);
/** Search by meaning (its text, or Find related's image id), the same way: re-asked as the index grows. */
const meaningAsk = latestRequest<string | number>(2000);
/**
 * The other search words of a search by meaning the user just started, until its results open. Whichever answer
 * lands first opens them: a re-ask as the index grows can supersede the user's request while the model loads.
 */
let meaningOpening: string | null = null;
const noMeaning = () => {
  meaningAsk.cancel();
  meaningOpening = null;
  return { meaningQuery: null };
};
/** Scores by image id, from meaning_scores' pairs of id (i32) and score (f32). */
const scoresOf = (buf: ArrayBuffer) => {
  const view = new DataView(buf);
  const scores = new Map<number, number>();
  for (let i = 0; i + 8 <= buf.byteLength; i += 8) scores.set(view.getInt32(i, true), view.getFloat32(i + 4, true));
  return scores;
};
/** The `looks:` phrases each part of the window searches for (resolveLooks). */
const looksWanted = new Map<string, string[]>();
const wantedLooks = () => new Set([...looksWanted.values()].flat());
/** `looks:` phrases being scored. Replaced when the scores go stale, so answers already on their way aren't kept. */
let looksAsked = new Map<string, Promise<Map<number, number>>>();
/** `looks:` phrases are scored again as the index grows, at most every 2 s, like search by meaning (meaningAsk). */
let looksAgain: ReturnType<typeof setTimeout> | null = null;
/** Ends "Find similar" and search by meaning, including a request still on its way, and an agent's `show`. */
const noSimilar = () => {
  similarAsk.cancel();
  return { similar: null, shown: null, ...noMeaning() };
};

export const useStore = create<State>((set, get, store) => {
  const persist = () => {
    const { theme, accent, language, sort, layout, thumbSize, pixelated, kindLabels, startView, recentFolders, grouped, subfolders, checkUpdates, audioLoop, sidebar, ai } = get();
    savePrefs({ theme, accent, language, sort, layout, thumbSize, pixelated, kindLabels, startView, recentFolders, grouped, subfolders, checkUpdates, audioLoop, sidebar, ai });
  };
  narrowQuery?.addEventListener("change", (e) => set({ narrow: e.matches, narrowOpen: false }));
  // Every way of opening a folder updates the recent list, so it is saved here rather than by each one.
  store.subscribe((s, prev) => s.recentFolders !== prev.recentFolders && persist());
  const patchAssets = (ids: number[], f: (a: Asset) => Asset) => {
    const s = new Set(ids);
    set((st) => ({ assets: st.assets.map((a) => (s.has(a.id) ? f(a) : a)) }));
  };
  /** Runs a backend write; on failure shows the error and reloads, undoing any optimistic change. */
  const write = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch (e) {
      get().setError(e);
      await get().reload();
      return false;
    }
  };
  /** Side effects of opening a folder: the tree expands down to it and it joins the recent list. */
  const folderState = (f: FolderFilter | null | undefined): Partial<State> => {
    if (!f) return {};
    const { expanded, recentFolders } = get();
    const same = (x: FolderFilter) => x.rootId === f.rootId && x.path === f.path;
    return {
      expanded: new Set([...expanded, ...ancestorKeys(f).slice(0, -1)]),
      recentFolders: [f, ...recentFolders.filter((x) => !same(x))].slice(0, 6),
    };
  };
  /** Scores a `looks:` phrase once, however many ask; `looks` keeps the answer while some part of the window wants it. */
  const askLook = (phrase: string) => {
    const asked = looksAsked;
    const had = asked.get(phrase);
    if (had) return had;
    const run = api.meaningScores(phrase).then(scoresOf);
    asked.set(phrase, run);
    run.then(
      (scores) => {
        if (asked !== looksAsked) return;
        asked.delete(phrase);
        const wanted = wantedLooks();
        set((s) => ({ looks: new Map([...s.looks, [phrase, scores] as const].filter(([p]) => wanted.has(p))) }));
      },
      () => asked.delete(phrase),
    );
    return run;
  };
  const nameOf = (id: number) => get().assets.find((a) => a.id === id)?.name ?? t("store.unnamedAsset");
  /** A message about `ids`: `one` names the asset, `many` counts them. */
  const about = (ids: number[], one: TKey, many: TKey, vars?: Vars) =>
    ids.length === 1 ? t(one, { ...vars, name: nameOf(ids[0]) }) : t(many, { ...vars, count: ids.length });
  /** The current search as a smart-collection rule. Type chips become type: words, unless the query names types itself. */
  const currentRule = (): CollectionRule => {
    const { query, kinds, filters } = get();
    const types = parseQuery(query).types ? [] : kinds.map((k) => `type:${k}`);
    return { query: [query.trim(), ...types].filter(Boolean).join(" "), filters };
  };
  /** Forgets selection, the active asset, duplicate entries and cached slicings for assets that are gone. */
  const keepOnly = (s: State, has: (id: number) => boolean): Partial<State> => {
    const kept = s.activeId === null || has(s.activeId);
    return {
      selected: new Set([...s.selected].filter(has)),
      activeId: kept ? s.activeId : null,
      // Left open with nothing to show, the panel or full screen would pop up on the next click.
      peek: kept && s.peek,
      full: kept && s.full,
      dups: s.dups?.map((g) => ({ ...g, ids: g.ids.filter(has) })).filter((g) => g.ids.length > 1) ?? null,
      // SQLite can reuse a deleted asset's id, so a removed asset's slicing must not stick to a new one.
      sheets: Object.fromEntries(Object.entries(s.sheets).filter(([id]) => has(Number(id)))),
      notes: Object.fromEntries(Object.entries(s.notes).filter(([id]) => has(Number(id)))),
      palettes: s.palettes && new Map([...s.palettes].filter(([id]) => has(id))),
    };
  };
  /**
   * Patches `assets` with the deltas received so far, or reloads everything if one went missing or the first load
   * failed. True if it patched.
   */
  const applyIncoming = () => {
    if (loading) return false;
    if (seq < 0) {
      // Before the first load, deltas wait for it. A failed load clears `incoming`, so it doesn't retry itself forever.
      if (loadFailed && incoming.length) void get().reload();
      return false;
    }
    const next = deltasAfter(seq, incoming);
    if (!next) {
      void get().reload();
      return false;
    }
    incoming = [];
    if (!next.length) return false;
    seq = next[next.length - 1].seq;
    set((s) => {
      const { assets, gone, changed } = applyDeltas(s.assets, next);
      const out: Partial<State> = gone.size ? { assets, ...keepOnly(s, (id) => !gone.has(id)) } : { assets };
      // A file's new version has no colours until it's analysed again, which with "keep analysed" off may be never.
      const palettes = out.palettes ?? s.palettes;
      if (changed.size && palettes) out.palettes = new Map([...palettes].filter(([id]) => !changed.has(id)));
      return out;
    });
    return true;
  };
  // A scan sends a delta per batch: apply the first right away, then at most once a second, or less often when an
  // update takes long to render (big libraries: every update re-sorts the whole list), so the UI stays responsive.
  let last = 0;
  let gap = 1000;
  let queued: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (queued) return;
    const wait = last + gap - Date.now();
    if (wait > 0) {
      queued = setTimeout(() => {
        queued = null;
        flush();
      }, wait);
      return;
    }
    last = Date.now();
    const start = performance.now();
    if (!applyIncoming()) return;
    // Two frames later the update has rendered; wait at least 4x that long before the next one.
    requestAnimationFrame(() => requestAnimationFrame(() => (gap = Math.max(1000, 4 * (performance.now() - start)))));
  };

  return {
    ...prefs,
    roots: [],
    assets: [],
    collections: [],
    scanning: {},
    missing: {},
    view: prefs.startView,
    kinds: [],
    folder: null,
    query: "",
    filters: noFilters,
    selected: new Set(),
    activeId: null,
    peek: false,
    full: false,
    fullscreen: false,
    narrow: !!narrowQuery?.matches,
    narrowOpen: false,
    palette: false,
    modal: null,
    toast: null,
    sheets: {},
    notes: {},
    palettes: null,
    analysis: { done: 0, total: 0, running: false, paused: false, keep: false },
    meaning: { done: 0, total: 0, running: false, paused: false, on: false, installed: false, download: null, error: null, files: [], vcRuntime: true, downloaded: 0, model: "" },
    tagging: { assets: 0, requests: 0, finished: 0, canceling: false, error: null, last: null },
    suggestFor: null,
    similar: null,
    meaningQuery: null,
    looks: new Map(),
    shown: null,
    colSel: null,
    dups: null,
    dupSel: null,
    expanded: new Set(),

    init: async () => {
      await api.onAssetsDelta((d) => {
        incoming.push(d);
        flush();
      });
      await api.onScanProgress((p) =>
        set((s) => {
          const scanning = { ...s.scanning };
          if (!p.done) return { scanning: { ...scanning, [p.rootId]: p.count } };
          delete scanning[p.rootId];
          return { scanning, missing: { ...s.missing, [p.rootId]: p.missing } };
        }),
      );
      await api.onImageFeatures((colors) => {
        // Images analysed since can match the open "Find similar"; its results were a snapshot.
        similarAsk.again(({ id, max }) => void get().findSimilar(id, max));
        if (paletteBacklog) paletteBacklog.push(...colors);
        set((s) => {
          if (!s.palettes || paletteBacklog) return {};
          const palettes = new Map(s.palettes);
          for (const [id, c] of colors) palettes.set(id, toLab(c));
          return { palettes };
        });
      });
      await api.onAnalysisStatus((analysis) => set({ analysis }));
      api.analysisStatus().then((analysis) => set({ analysis }), get().setError);
      await api.onMeaningStatus((meaning) => {
        // Turned off: its results would go stale and every re-ask fail. Images indexed since can match the open search.
        if (!meaning.on && get().meaningQuery) set(noMeaning());
        else if (meaning.on && meaning.done !== get().meaning.done)
          meaningAsk.again((q) => {
            if (meaningOpening === null) void (typeof q === "number" ? get().findRelated(q) : get().findByMeaning(q));
          });
        // `looks:` scores too: dropped when it's turned off, asked again as the index grows (keeping the old ones meanwhile).
        if (!meaning.on) {
          looksAsked = new Map();
          if (get().looks.size) set({ looks: new Map() });
        } else if (meaning.done !== get().meaning.done && !looksAgain)
          looksAgain = setTimeout(() => {
            looksAgain = null;
            looksAsked = new Map();
            if (get().meaning.on) for (const p of wantedLooks()) askLook(p).catch(() => {});
          }, 2000);
        set({ meaning });
      });
      api.meaningStatus().then((meaning) => set({ meaning }), get().setError);
      await api.onMeaningPreview((p) => {
        // The backend's version of the file wins, in case the list here hasn't caught up; the drawing only reads these fields.
        const a = { ...get().assets.find((x) => x.id === p.id), ...p } as Asset;
        void (a.kind === "font" ? saveFontSample(a) : thumbnailFor(a)).finally(() => api.meaningDrawn(a.id).catch(() => {}));
      });
      api.meaningWindow().catch(get().setError);
      await api.onTaggingStatus((tagging) => set({ tagging }));
      api.taggingStatus().then((tagging) => set({ tagging }), get().setError);
      api
        .restoreResult()
        .then((r) => r && get().showToast(t("store.restored")), get().setError);
      let pending: ReturnType<typeof setTimeout> | null = null;
      await api.onAssetsChanged(() => {
        // A scan or a burst of file events ended: catch up once, then refresh collections and re-check duplicates.
        if (pending) clearTimeout(pending);
        pending = setTimeout(async () => {
          applyIncoming();
          try {
            set({ collections: await api.listCollections() });
          } catch (e) {
            get().setError(e);
          }
          await get().findDuplicates();
        }, 150);
      });
      await get().reload();
      // A first run has nothing new to announce: Home's "updated" note starts from this version.
      if (seq >= 0 && !get().roots.length && seenVersion() === null) getVersion().then(markSeen, () => {});
      void get().findDuplicates();
    },

    reload: async () => {
      loading++;
      try {
        const [roots, list, collections, notes] = await Promise.all([api.listRoots(), api.listAssets(), api.listCollections(), api.listNotes()]);
        seq = list.seq;
        const ids = new Set(list.assets.map((a) => a.id));
        set((s) => ({
          roots,
          // A backup restore can bring other folders back.
          recentFolders: s.recentFolders.filter((f) => roots.some((r) => r.id === f.rootId)),
          missing: Object.fromEntries(roots.map((r) => [r.id, r.missing])),
          assets: list.assets,
          collections,
          colSel: collections.some((c) => c.id === s.colSel) ? s.colSel : (collections[0]?.id ?? null),
          ...keepOnly(s, (id) => ids.has(id)),
          notes,
        }));
      } catch (e) {
        // Keeping a gap would retry the failing load at once, forever. The next delta finds the gap (or no load) and retries.
        incoming = [];
        loadFailed = true;
        get().setError(e);
      } finally {
        loading--;
      }
      // Deltas that arrived during the load, minus the ones it already had.
      applyIncoming();
    },

    importFolder: async () => {
      const path = await api.pickFolder();
      if (!path) return;
      try {
        const root = await api.addRoot(path);
        const folder = { rootId: root.id, path: "" };
        set((s) => ({ roots: [...s.roots, root], scanning: { ...s.scanning, [root.id]: 0 }, view: "library", folder, ...noSimilar(), ...folderState(folder) }));
      } catch (e) {
        get().setError(e);
      }
    },
    removeRoot: async (id) => {
      const root = get().roots.find((r) => r.id === id);
      if (!(await write(() => api.removeRoot(id)))) return;
      set((s) => ({ folder: s.folder?.rootId === id ? null : s.folder, recentFolders: s.recentFolders.filter((f) => f.rootId !== id) }));
      await get().reload();
      if (root) get().showToast(t("store.rootRemoved", { path: root.path }));
    },
    rescan: async (id) => {
      set((s) => ({ scanning: { ...s.scanning, [id]: 0 } }));
      await write(() => api.rescan(id));
    },
    relinkRoot: async (id, path) => {
      // Before the call: a small folder's scan can finish (and clear this) before the call returns.
      set((s) => ({ scanning: { ...s.scanning, [id]: 0 } }));
      if (!(await write(() => api.relinkRoot(id, path)))) {
        set((s) => {
          const scanning = { ...s.scanning };
          delete scanning[id];
          return { scanning };
        });
        return;
      }
      // Asset paths come from the root's path, so reload them before the rescan's changes arrive, and retry the
      // thumbnails that failed while the folder was unreachable.
      forgetThumbnails();
      await get().reload();
      get().showToast(t("store.relinked", { path }));
    },

    setError: (e) => {
      set({ toast: { id: ++toastSeq, message: errorText(e), error: true } });
      toastMs = 8000;
      get().holdToast(false);
    },
    showToast: (message, undo, action) => {
      set({ toast: { id: ++toastSeq, message, undo, action } });
      // An undo's own toast offers to redo it, and Ctrl+Z mustn't pick that up.
      // shortcut: a change saved while an undo is still running isn't offered to Ctrl+Z either; fine while undos take milliseconds.
      if (undo && !action && !undoing) lastUndo = undo;
      toastMs = 4500;
      get().holdToast(false);
    },
    dismissToast: () => set({ toast: null }),
    holdToast: (hold) => {
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = hold || !get().toast ? null : setTimeout(() => get().dismissToast(), toastMs);
    },
    undo: (run = lastUndo) => {
      // Once only: undoing a deleted collection twice would bring back two copies.
      if (run === lastUndo) lastUndo = undefined;
      if (!run) return;
      get().dismissToast();
      undoing++;
      Promise.resolve().then(run).catch(get().setError).finally(() => undoing--);
    },

    go: (view, extra = {}) => set({ view, full: false, palette: false, ...noSimilar(), ...extra, ...folderState(extra.folder) }),
    setQuery: (query) => set({ query }),
    toggleKind: (k) =>
      set((s) => ({ kinds: k === "all" ? [] : s.kinds.includes(k) ? s.kinds.filter((x) => x !== k) : [...s.kinds, k] })),
    setFolder: (folder) => set({ folder, ...noSimilar(), ...folderState(folder) }),
    setFilters: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
    clearFilters: () => set({ filters: noFilters, kinds: [], folder: null, query: "", ...noSimilar() }),
    setSort: (key) => {
      set((s) => ({ sort: { key, desc: s.sort.key === key ? !s.sort.desc : key === "mtime" || key === "size" } }));
      persist();
    },
    setLayout: (layout) => {
      set({ layout });
      persist();
    },
    setGrouped: (grouped) => {
      set({ grouped });
      persist();
    },
    setSubfolders: (subfolders) => {
      set({ subfolders });
      persist();
    },
    toggleExpanded: (key) =>
      set((s) => {
        const expanded = new Set(s.expanded);
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        return { expanded };
      }),
    setThumbSize: (thumbSize) => {
      set({ thumbSize });
      persist();
    },
    setTheme: (theme) => {
      applyTheme(theme, get().accent);
      set({ theme });
      persist();
    },
    setAccent: (accent) => {
      applyTheme(get().theme, accent);
      set({ accent });
      persist();
    },
    setLanguage: (language) => {
      set({ language });
      persist();
      location.reload();
    },
    setPixelated: (pixelated) => {
      set({ pixelated });
      persist();
    },
    setKindLabels: (kindLabels) => {
      set({ kindLabels });
      persist();
    },
    setStartView: (startView) => {
      set({ startView });
      persist();
    },
    setCheckUpdates: (checkUpdates) => {
      set({ checkUpdates });
      persist();
    },
    setAudioLoop: (audioLoop) => {
      set({ audioLoop });
      persist();
    },
    setAi: (ai) => {
      set((s) => ({ ai: { ...s.ai, ...ai } }));
      persist();
    },
    toggleSidebar: () => {
      const { narrow, narrowOpen, sidebar } = get();
      if (narrow) return set({ narrowOpen: !narrowOpen });
      set({ sidebar: sidebar === "collapsed" ? "expanded" : "collapsed" });
      persist();
    },
    setFullscreen: (fullscreen) => {
      set({ fullscreen });
      getCurrentWindow()
        .setFullscreen(fullscreen)
        .catch((e) => {
          set({ fullscreen: !fullscreen });
          get().setError(e);
        });
    },

    // On a failed read the entry stays unknown, so a guess never overwrites a saved slicing.
    loadSheet: async (id) => {
      try {
        const sheet = await api.getSpriteSheet(id);
        set((st) => ({ sheets: { ...st.sheets, [id]: sheet } }));
      } catch (e) {
        get().setError(e);
      }
    },
    saveSheet: async (id, sheet) => {
      set((st) => ({ sheets: { ...st.sheets, [id]: sheet } }));
      try {
        await api.setSpriteSheet(id, sheet);
      } catch (e) {
        get().setError(e);
      }
    },

    loadPalettes: async () => {
      if (get().palettes || paletteBacklog) return;
      paletteBacklog = [];
      try {
        const rows = await api.imageColors();
        const palettes = new Map(rows.map(([id, c]) => [id, toLab(c)]));
        for (const [id, c] of paletteBacklog) palettes.set(id, toLab(c));
        set({ palettes });
      } catch (e) {
        get().setError(e);
      } finally {
        paletteBacklog = null;
      }
    },
    findSimilar: async (id, max = 10) => {
      const current = similarAsk.start({ id, max });
      try {
        const ids = await api.findSimilar(id, max);
        if (!current()) return;
        // A new image opens the library on its results; a new slider position or a refresh keeps the view as it is.
        const nav = get().similar?.id === id ? {} : { view: "library" as const, full: false, palette: false, query: "", kinds: [], folder: null };
        set({ ...nav, similar: { id, name: nameOf(id), max, ids }, shown: null, ...noMeaning() });
      } catch (e) {
        if (!current()) return;
        similarAsk.cancel(); // or every analysis batch would ask again and show the same error
        get().setError(e);
      }
    },
    clearSimilar: () => set(noSimilar()),
    findByMeaning: async (text, query) => {
      if (query !== undefined) meaningOpening = query;
      const current = meaningAsk.start(text);
      try {
        const scores = scoresOf(await api.meaningScores(text));
        if (!current()) return;
        const s = get();
        const opening = meaningOpening;
        meaningOpening = null;
        // From the library or favorites, the open folder, type chips and filters narrow the results.
        const nav =
          opening === null
            ? {}
            : { ...(s.view === "library" || s.view === "favorites" ? {} : { view: "library" as const, folder: null, kinds: [] }), full: false, palette: false, query: opening };
        similarAsk.cancel();
        set({ ...nav, meaningQuery: { text, scores }, similar: null, shown: null });
      } catch (e) {
        if (!current()) return;
        meaningOpening = null;
        meaningAsk.cancel(); // or every indexed batch would ask again and show the same error
        get().setError(e);
      }
    },
    findRelated: async (id) => {
      meaningOpening = null;
      const current = meaningAsk.start(id);
      try {
        const scores = scoresOf(await api.meaningRelated(id));
        if (!current()) return;
        // A new image opens its results, keeping the open folder, type chips and filters in the library or favorites; a
        // refresh as the index grows keeps the view as it is.
        const s = get();
        const nav =
          s.meaningQuery?.id === id
            ? {}
            : { ...(s.view === "library" || s.view === "favorites" ? {} : { view: "library" as const, folder: null, kinds: [] }), full: false, palette: false, query: "" };
        similarAsk.cancel();
        set({ ...nav, meaningQuery: { text: nameOf(id), id, scores }, similar: null, shown: null });
      } catch (e) {
        if (!current()) return;
        meaningAsk.cancel(); // or every indexed batch would ask again and show the same error
        get().setError(e);
      }
    },
    dropMeaningOpening: () => {
      if (meaningOpening === null) return false;
      meaningOpening = null;
      // The answer on its way is dropped; results already on screen keep growing with the index.
      const open = get().meaningQuery;
      if (open) meaningAsk.start(open.id ?? open.text);
      else meaningAsk.cancel();
      return true;
    },
    clearMeaning: () => set(noMeaning()),
    resolveLooks: async (by, phrases) => {
      looksWanted.set(by, phrases);
      const { meaning, looks } = get();
      if (!meaning.on || !meaning.installed || !phrases.length) return new Map();
      const scores = await Promise.all(phrases.map((p) => looks.get(p) ?? askLook(p)));
      return new Map(phrases.map((p, i) => [p, scores[i]]));
    },
    showAssets: (ids, by) =>
      set({ ...noSimilar(), view: "library", full: false, palette: false, query: "", kinds: [], folder: null, filters: noFilters, shown: { ids, by } }),

    select: (id, mode = "replace", order = []) =>
      set((s) => {
        if (mode === "toggle") {
          const selected = new Set(s.selected);
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          return { selected, activeId: id };
        }
        if (mode === "range" && s.activeId !== null) {
          const a = order.indexOf(s.activeId);
          const b = order.indexOf(id);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            return { selected: new Set(order.slice(lo, hi + 1)) };
          }
        }
        return { selected: new Set([id]), activeId: id };
      }),
    setSelected: (ids) => set({ selected: new Set(ids) }),
    setPeek: (peek) => set((s) => ({ peek: peek && s.activeId !== null, full: peek && s.full })),
    setFull: (full) => set((s) => ({ full: full && s.activeId !== null, peek: s.peek || full })),
    setPalette: (palette) => set({ palette }),
    setModal: (modal) => set({ modal, palette: false }),

    setFavorite: async (ids, favorite) => {
      patchAssets(ids, (a) => ({ ...a, favorite }));
      if (!(await write(() => api.setFavorite(ids, favorite)))) return;
      get().showToast(
        favorite ? about(ids, "store.favoriteAdded", "store.favoriteAddedCount") : about(ids, "store.favoriteRemoved", "store.favoriteRemovedCount"),
        () => get().setFavorite(ids, !favorite),
      );
    },
    addTag: async (ids, raw) => {
      try {
        const tag = await api.addTag(ids, raw.replace(/^#/, ""));
        // Adding a tag Claude suggested takes the suggestion (the suggestion_taken trigger).
        patchAssets(ids, (a) => (a.tags.includes(tag) ? a : { ...a, tags: [...a.tags, tag].sort(), suggested: a.suggested.filter((x) => x !== tag) }));
      } catch (e) {
        get().setError(e);
      }
    },
    removeTag: async (ids, tag) => {
      patchAssets(ids, (a) => ({ ...a, tags: a.tags.filter((x) => x !== tag) }));
      await write(() => api.removeTag(ids, tag));
    },
    setSuggestFor: (suggestFor) => set({ suggestFor, palette: false }),
    acceptSuggestions: async (ids, tags) => {
      patchAssets(ids, (a) => {
        const picked = tags ? a.suggested.filter((x) => tags.includes(x)) : a.suggested;
        return { ...a, tags: [...new Set([...a.tags, ...picked])].sort(), suggested: a.suggested.filter((x) => !picked.includes(x)) };
      });
      await write(() => api.acceptSuggestions(ids, tags));
    },
    rejectSuggestions: async (ids, tags) => {
      patchAssets(ids, (a) => ({ ...a, suggested: tags ? a.suggested.filter((x) => !tags.includes(x)) : [] }));
      await write(() => api.rejectSuggestions(ids, tags));
    },
    cancelTagging: async () => {
      try {
        await api.cancelTagging();
      } catch (e) {
        get().setError(e);
      }
    },
    setRating: async (ids, rating) => {
      // Previous ratings, grouped, so Undo restores each asset's own.
      const wanted = new Set(ids);
      const before = new Map<number, number[]>();
      for (const a of get().assets) {
        if (!wanted.has(a.id)) continue;
        const group = before.get(a.rating);
        if (group) group.push(a.id);
        else before.set(a.rating, [a.id]);
      }
      patchAssets(ids, (a) => ({ ...a, rating }));
      if (!(await write(() => api.setRating(ids, rating)))) return;
      const message = rating
        ? about(ids, "store.rated", "store.ratedCount", { stars: "★".repeat(rating) })
        : about(ids, "store.ratingCleared", "store.ratingClearedCount");
      get().showToast(message, async () => {
        for (const [r, group] of before) {
          patchAssets(group, (a) => ({ ...a, rating: r }));
          if (!(await write(() => api.setRating(group, r)))) return;
        }
      });
    },
    setNote: async (id, note) => {
      const text = note.trim();
      if ((get().notes[id] ?? "") === text) return;
      // Optimistic, so the next edit is compared with this one and not with a save still in flight; saves run one at a
      // time in the order they were made, so the last edit is the one that sticks.
      set((s) => {
        const notes = { ...s.notes };
        if (text) notes[id] = text;
        else delete notes[id];
        return { notes };
      });
      const run = noteSaves.then(() => api.setNote(id, note));
      noteSaves = run.catch(() => {});
      await write(() => run);
    },

    newCollection: async () => {
      const names = new Set(get().collections.map((c) => c.name));
      let name = t("store.newCollection");
      for (let i = 2; names.has(name); i++) name = t("store.newCollectionNumbered", { number: i });
      try {
        const id = await api.createCollection(name);
        set({ collections: await api.listCollections() });
        get().go("collections", { colSel: id });
      } catch (e) {
        get().setError(e);
      }
    },
    saveSmartCollection: async (name) => {
      try {
        const id = await api.createCollection(name, currentRule());
        set({ collections: await api.listCollections() });
        get().go("collections", { colSel: id });
        return true;
      } catch (e) {
        get().setError(e);
        return false;
      }
    },
    setCollectionRule: async (id, rule = currentRule()) => {
      const c = get().collections.find((x) => x.id === id);
      if (!c?.rule) return;
      const old = c.rule;
      set((s) => ({ collections: s.collections.map((x) => (x.id === id ? { ...x, rule } : x)) }));
      if (!(await write(() => api.setCollectionRule(id, rule)))) return;
      get().showToast(t("store.ruleUpdated", { name: c.name }), () => get().setCollectionRule(id, old));
    },
    renameCollection: async (id, name) => {
      try {
        const clean = await api.renameCollection(id, name);
        set((s) => ({ collections: s.collections.map((c) => (c.id === id ? { ...c, name: clean } : c)) }));
        return true;
      } catch (e) {
        get().setError(e);
        return false;
      }
    },
    deleteCollection: async (id) => {
      const c = get().collections.find((x) => x.id === id);
      if (!c) return;
      set((s) => ({ collections: s.collections.filter((x) => x.id !== id) }));
      if (!(await write(() => api.deleteCollection(id)))) return;
      await get().reload();
      get().showToast(t("store.collectionDeleted", { name: c.name }), async () => {
        const nid = await api.createCollection(c.name, c.rule);
        if (c.assetIds.length) await api.setInCollection(nid, c.assetIds, true);
        await get().reload();
        set({ colSel: nid });
      });
    },
    setInCollection: async (collection, ids, member) => {
      const name = get().collections.find((c) => c.id === collection)?.name ?? t("store.unnamedCollection");
      const rm = new Set(ids);
      set((s) => ({
        collections: s.collections.map((c) =>
          c.id !== collection
            ? c
            : { ...c, assetIds: member ? [...new Set([...c.assetIds, ...ids])] : c.assetIds.filter((id) => !rm.has(id)) },
        ),
      }));
      if (!(await write(() => api.setInCollection(collection, ids, member)))) return;
      get().showToast(
        member
          ? about(ids, "store.addedTo", "store.addedToCount", { collection: name })
          : about(ids, "store.removedFrom", "store.removedFromCount", { collection: name }),
        () => get().setInCollection(collection, ids, !member),
      );
    },
    copyCollection: async (id) => {
      const c = get().collections.find((x) => x.id === id);
      if (!c) return;
      const ids = c.rule ? ruleMembers(c.rule, get().assets, get().notes, undefined, get().palettes, get().looks).map((a) => a.id) : c.assetIds;
      if (!ids.length) return;
      const dest = await api.pickFolder(t("store.copyTo", { name: c.name }));
      if (!dest) return;
      try {
        const r = await api.copyCollection(ids, dest);
        if (r.failed.length)
          get().setError(
            t("store.copyFailed", { copied: t("store.copiedPart", { count: r.copied }), count: r.failed.length, errors: r.failed.slice(0, 3).join("; ") }),
          );
        else get().showToast(t("store.copied", { count: r.copied, folder: dest }));
      } catch (e) {
        get().setError(e);
      }
    },

    findDuplicates: async () => {
      try {
        set({ dups: await api.findDuplicates() });
      } catch (e) {
        get().setError(e);
      }
    },
    ignoreDuplicate: async (hash) => {
      set((s) => ({ dups: s.dups?.filter((g) => g.hash !== hash) ?? null }));
      if (!(await write(() => api.setDuplicateIgnored(hash, true)))) {
        // The reload doesn't fetch duplicates: bring the hidden group back.
        await get().findDuplicates();
        return;
      }
      get().showToast(t("store.notDuplicates"), async () => {
        await api.setDuplicateIgnored(hash, false);
        await get().findDuplicates();
      });
    },
    trashDuplicates: async (keep, remove) => {
      const message = about(remove, "store.trashed", "store.trashedCount");
      try {
        await api.trashDuplicates(keep, remove);
        await get().reload();
        await get().findDuplicates();
        get().showToast(message);
      } catch (e) {
        get().setError(e);
        await get().reload();
      }
    },
  };
});

/** The sidebar shows as a rail of icons. */
export const sidebarRail = (s: Pick<State, "narrow" | "narrowOpen" | "sidebar">) => (s.narrow ? !s.narrowOpen : s.sidebar === "collapsed");
