import { getCurrentWindow } from "@tauri-apps/api/window";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { startAgents } from "./agent/bridge";
import { useAppUpdate } from "./appUpdate";
import { AgentAsk } from "./components/Agents";
import { UpdateDialog } from "./components/AppUpdate";
import { AssetBrowser } from "./components/AssetBrowser";
import { CollectionsView } from "./components/CollectionsView";
import { DuplicatesView } from "./components/DuplicatesView";
import { FullView } from "./components/FullView";
import { BrowseBar, Header } from "./components/Header";
import { HomeView } from "./components/HomeView";
import { InsightsView } from "./components/InsightsView";
import { Palette } from "./components/Palette";
import { SuggestTags } from "./components/SuggestTags";
import { Peek } from "./components/Peek";
import { SettingsDialog } from "./components/Settings";
import { ShortcutsDialog } from "./components/Shortcuts";
import { Sidebar } from "./components/Sidebar";
import { Button, focusAssets, Kbd, modalOpen } from "./components/ui";
import { viewerKey } from "./components/Viewers";
import { Welcome } from "./components/Welcome";
import { activeFilterCount, groupByFolder, parseQuery, ruleLooks, rulesWantColors, visibleAssets } from "./lib/filter";
import { parentOf } from "./lib/folders";
import { list } from "./lib/fmt";
import { baseName, folderOf, rootLabel } from "./lib/format";
import { rowStep } from "./lib/grid";
import { t } from "./lib/i18n";
import { applyTheme, onSystemThemeChange } from "./lib/prefs";
import { isMac, shortcut } from "./lib/shortcuts";
import { sidebarRail, useStore } from "./store";
import type { Asset } from "./types";

/** The library's hint bar, in order. */
const HINTS = ["peek", "full", "move", "favorite", "rate", "unrate", "search"].map(shortcut);

function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** Space and Enter press a focused button, and arrows move inside menus and radio groups, instead of the app shortcuts. */
function ownsKey(target: EventTarget | null, key: string) {
  const el = target instanceof HTMLElement ? target : null;
  if (!el || el === document.body || el.closest("[data-assets]")) return false;
  if (key === " " || key === "Enter")
    return el.matches("button, a[href], summary, [role=button], [role=checkbox], [role=switch], [role=radio], [role=option], [role^=menuitem]");
  return key.startsWith("Arrow") && !!el.closest("[role=radiogroup], [role=menu], [role=listbox], details");
}

/** The letter of a letter key: the typed one on Latin layouts (Dvorak too), the key's place on others (Cyrillic, Greek). */
function letter(e: KeyboardEvent) {
  return /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key;
}

/**
 * 0–5 from the number row or keypad, also where the row types symbols without Shift (French AZERTY). Only the number
 * row falls back to the key's place: with Num Lock off the keypad sends End, Insert and so on, which aren't ratings.
 */
function digit(e: KeyboardEvent) {
  return /^[0-5]$/.test(e.key) ? Number(e.key) : /^Digit[0-5]$/.test(e.code) ? Number(e.code.slice(-1)) : null;
}

function Toast() {
  const { toast, dismissToast, holdToast, undo } = useStore();
  // Always mounted, so screen readers announce each message as it appears.
  return (
    <div aria-live={toast?.error ? "assertive" : "polite"} className="pointer-events-none absolute inset-x-0 bottom-6 z-[80] flex justify-center">
      {toast && (
        <div
          key={toast.id}
          // The timer waits while the pointer or focus is on the toast, so there's time to reach its button.
          onMouseEnter={() => holdToast(true)}
          onMouseLeave={(e) => holdToast(e.currentTarget.contains(document.activeElement))}
          onFocus={() => holdToast(true)}
          onBlur={(e) => holdToast(e.currentTarget.matches(":hover") || e.currentTarget.contains(e.relatedTarget))}
          className={clsx(
            "pointer-events-auto flex max-w-[min(720px,90%)] items-center gap-3.5 rounded-[11px] bg-invert-bg py-2.5 pr-3 pl-4 text-invert-fg shadow-[0_16px_40px_-12px_rgba(0,0,0,.6)]",
            toast.error && "border-l-4 border-danger",
          )}
        >
          <span className="font-medium">{toast.message}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={() => undo(toast.undo)}
              className="h-7 rounded-[7px] bg-bg px-2.5 font-semibold whitespace-nowrap text-fg"
            >
              {toast.action ?? t("app.undo")}
            </button>
          )}
          {toast.error && (
            <button type="button" onClick={dismissToast} className="h-7 rounded-[7px] px-2 font-semibold opacity-70 hover:opacity-100">
              {t("app.dismiss")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Tells screen readers when a scan starts and ends, without reading every count update. */
function ScanStatus() {
  const { scanning, roots } = useStore();
  const names = list(Object.keys(scanning).map((id) => rootLabel(roots, Number(id))));
  const [message, setMessage] = useState("");
  useEffect(
    () =>
      setMessage((prev) =>
        names ? t("app.scanning", { names }) : prev ? t("app.scanFinished", { count: useStore.getState().assets.length }) : "",
      ),
    [names],
  );
  return (
    <p role="status" className="sr-only">
      {message}
    </p>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-20 text-center text-muted">
      <span className="text-[15px] font-medium text-fg">{title}</span>
      <span>{body}</span>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export default function App() {
  const s = useStore();

  useEffect(() => {
    // Agent calls read the library, so the bridge starts once it's loaded.
    void useStore.getState().init().then(startAgents);
    void useAppUpdate.getState().init();
    const off = onSystemThemeChange(() => applyTheme(useStore.getState().theme, useStore.getState().accent));
    // The OS can leave or enter full screen too (macOS's green button), so the window says which it is.
    const win = getCurrentWindow();
    const sync = () => void win.isFullscreen().then((fullscreen) => useStore.setState({ fullscreen }), () => {});
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      off();
      void unlisten.then((f) => f());
    };
  }, []);

  const collection = s.collections.find((c) => c.id === s.colSel) ?? null;
  // "Find similar" results, or the assets an agent showed: only these, in their order.
  const similar = s.similar?.ids ?? s.shown?.ids ?? null;
  // Search by meaning: only scored images, best first.
  const meaning = s.meaningQuery?.scores ?? null;
  const wantsColors = !!s.filters.color || parseQuery(s.query).colors.length > 0 || rulesWantColors(s.collections);
  // Colours only matter to a colour filter; otherwise their updates during an analysis pass mustn't re-sort the list.
  const palettes = wantsColors ? s.palettes : null;
  // `looks:` words in the search and in smart collections (the sidebar counts them all), scored once each.
  const looksKey = JSON.stringify([...parseQuery(s.query).looks, ...ruleLooks(s.collections)]);
  const meaningOn = s.meaning.on && s.meaning.installed;
  useEffect(() => {
    const st = useStore.getState();
    st.resolveLooks("window", JSON.parse(looksKey)).catch(st.setError);
  }, [looksKey, meaningOn]);
  const looks = looksKey !== "[]" ? s.looks : null;
  const scope = { view: s.view, kinds: s.kinds, folder: s.folder, subfolders: s.subfolders, query: s.query, filters: s.filters, collection, notes: s.notes, similar, meaning, palettes, looks };
  const visible = useMemo(
    () => visibleAssets(s.assets, scope, s.sort),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.assets, s.view, s.kinds, s.folder, s.subfolders, s.query, s.filters, collection, s.notes, s.sort, similar, meaning, palettes, looks],
  );
  // Same scope without the type chips, so each chip can show its count. Only counted, so not sorted.
  const scopeAssets = useMemo(
    () => visibleAssets(s.assets, { ...scope, kinds: [] }, null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.assets, s.view, s.folder, s.subfolders, s.query, s.filters, collection, s.notes, similar, meaning, palettes, looks],
  );
  useEffect(() => {
    if (wantsColors) void useStore.getState().loadPalettes();
  }, [wantsColors]);
  const browse = s.view === "library" || s.view === "favorites";
  const navigable = browse || s.view === "collections";
  // `looks:` words in the search, or in the open smart collection's, rank like search by meaning.
  const ranked = !!similar || !!meaning || parseQuery(s.query).looks.length > 0 || (s.view === "collections" && !!collection?.rule && parseQuery(collection.rule.query).looks.length > 0);
  const groups = useMemo(
    // "Find similar" and search by meaning results stay in one list, closest first.
    () => ((browse || s.view === "collections") && s.grouped && !ranked ? groupByFolder(visible, s.roots, browse ? s.folder : null) : null),
    [browse, s.view, s.grouped, ranked, visible, s.roots, s.folder],
  );
  // In Duplicates, full screen steps through the copies of the open group.
  const copies = useMemo(() => {
    const g = s.view === "duplicates" ? s.dups?.find((d) => d.hash === s.dupSel) : null;
    return g ? g.ids.map((id) => s.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a) : null;
  }, [s.view, s.dups, s.dupSel, s.assets]);
  const order = useMemo(() => copies ?? (groups ? groups.flatMap((g) => g.items) : visible), [copies, groups, visible]);
  const active = s.assets.find((a) => a.id === s.activeId) ?? null;
  // Where a Shift+arrow selection started, so each press extends the same range.
  const anchor = useRef<number | null>(null);
  const peekOn = s.peek && !!active && (navigable || s.full);

  // A link to another view (Insights rows, the duplicate banner, search actions) goes away with the old view: land on the new one.
  const lastView = useRef(s.view);
  useEffect(() => {
    if (lastView.current !== s.view && document.activeElement === document.body) focusAssets();
    lastView.current = s.view;
  }, [s.view]);

  // The window fills the screen from anywhere: F11, or ⌃⌘F on macOS. Capture phase, so fields that keep their keys
  // to themselves (search, tags, notes) and dialogs still let it through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F11" && !(isMac && e.ctrlKey && e.metaKey && letter(e) === "f")) return;
      e.preventDefault();
      e.stopPropagation();
      const st = useStore.getState();
      if (!e.repeat) st.setFullscreen(!st.fullscreen);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      // A dialog handles its own keys (Escape closes it).
      if (st.modal || modalOpen()) return;
      if ((e.metaKey || e.ctrlKey) && letter(e) === "k") {
        e.preventDefault();
        st.setPalette(!st.palette);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && letter(e) === "b") {
        e.preventDefault();
        if (!e.repeat) st.toggleSidebar();
        return;
      }
      if (st.palette) return;
      if (typing(e.target)) {
        // Esc leaves the field for the asset list, where the shortcuts work again.
        if (e.key === "Escape") focusAssets();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && letter(e) === "z") {
        e.preventDefault();
        st.undo();
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        st.setModal("shortcuts");
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        st.setPalette(true);
        return;
      }
      if (e.altKey && e.key === "ArrowUp" && st.folder?.path && (st.view === "library" || st.view === "favorites")) {
        e.preventDefault();
        st.setFolder(parentOf(st.folder));
        return;
      }
      if (e.key === "Escape") {
        if (st.full) st.setFull(false);
        else if (st.peek) st.setPeek(false);
        else if (st.selected.size) st.setSelected([]);
        else if (st.meaningQuery) st.clearMeaning();
        else if (st.fullscreen) st.setFullscreen(false);
        return;
      }
      if (viewerKey(e, letter(e))) {
        e.preventDefault();
        return;
      }
      if ((!navigable && !st.full) || ownsKey(e.target, e.key)) return;
      const i = order.findIndex((a) => a.id === st.activeId);
      const ensureActive = () => {
        if (st.activeId === null && order.length) st.select(order[0].id);
        return st.activeId !== null || order.length > 0;
      };
      if (e.key === " " && (e.ctrlKey || e.metaKey) && !st.full) {
        e.preventDefault();
        if (st.activeId === null) ensureActive();
        else st.select(st.activeId, "toggle");
      } else if (e.key === " ") {
        e.preventDefault();
        if (st.full) st.setFull(false);
        else if (ensureActive()) st.setPeek(!st.peek);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (ensureActive()) st.setFull(true);
      } else if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key) && order.length) {
        e.preventDefault();
        const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
        // ↑ ↓ go a row in the grid (the list has one column); full screen steps through one at a time.
        const cols = Number(document.querySelector<HTMLElement>("[data-assets]")?.dataset.cols ?? 1);
        const sizes = groups ? groups.map((g) => g.items.length) : [order.length];
        const to = i < 0 ? 0 : (e.key === "ArrowDown" || e.key === "ArrowUp") && !st.full ? rowStep(sizes, cols, i, d) : (i + d + order.length) % order.length;
        const next = order[to].id;
        if (e.shiftKey && !st.full) {
          // Shift selects everything from where it started to here; the active asset moves along.
          if (anchor.current === null || !st.selected.has(anchor.current)) anchor.current = st.activeId ?? next;
          const from = order.findIndex((a) => a.id === anchor.current);
          const [lo, hi] = from < 0 ? [to, to] : from < to ? [from, to] : [to, from];
          useStore.setState({ selected: new Set(order.slice(lo, hi + 1).map((a) => a.id)), activeId: next });
        } else if ((e.ctrlKey || e.metaKey) && !st.full) {
          // Moves without changing the selection, to pick assets one by one with Ctrl+Space.
          useStore.setState({ activeId: next });
        } else {
          anchor.current = null;
          st.select(next);
        }
      } else if (letter(e) === "f" && !e.ctrlKey && !e.metaKey) {
        const ids = st.selected.size ? [...st.selected] : st.activeId !== null ? [st.activeId] : [];
        const want = new Set(ids);
        const items = st.assets.filter((a) => want.has(a.id));
        if (items.length) void st.setFavorite(ids, !items.every((a) => a.favorite));
      } else if (digit(e) !== null && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ids = st.selected.size ? [...st.selected] : st.activeId !== null ? [st.activeId] : [];
        if (ids.length) void st.setRating(ids, digit(e)!);
      } else if (letter(e) === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        st.setSelected(order.map((a) => a.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, groups, navigable]);

  const scanning = Object.keys(s.scanning).length > 0;
  const filtered = s.query || s.kinds.length > 0 || s.folder !== null || activeFilterCount(s.filters) > 0 || !!similar || !!meaning;
  // Whether the open folder holds any files itself, before any filter; decides which empty state fits.
  const hasDirectFiles = useMemo(
    () => !!s.folder && s.assets.some((a) => a.rootId === s.folder!.rootId && folderOf(a.relPath) === s.folder!.path),
    [s.assets, s.folder],
  );

  return (
    <div
      className="relative grid h-full grid-cols-[var(--sidebar-w)_minmax(0,1fr)] overflow-hidden bg-bg text-fg"
      style={{ "--sidebar-w": sidebarRail(s) ? "56px" : "220px" } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={focusAssets}
        className="absolute top-2 left-2 z-[90] -translate-y-[200%] rounded-[9px] bg-invert-bg px-3 py-2 font-semibold text-invert-fg focus:translate-y-0"
      >
        {t("app.skipToAssets")}
      </button>
      <Sidebar />
      <div className="grid min-h-0 min-w-0" style={{ gridTemplateColumns: `minmax(0,1fr) ${peekOn ? "clamp(300px,30vw,400px)" : "0px"}` }}>
        <main tabIndex={-1} className="flex min-h-0 min-w-0 flex-col focus-visible:outline-none">
          <Header />
          {(browse || s.view === "home" || s.view === "insights" || s.view === "duplicates") && !s.roots.length && (
            <div className="min-h-0 flex-1">
              <Welcome />
            </div>
          )}
          {browse && s.roots.length > 0 && (
            <>
              <BrowseBar count={visible.length} folders={groups?.length ?? 0} scopeAssets={scopeAssets} />
              <div className="min-h-0 flex-1">
                {visible.length ? (
                  <AssetBrowser assets={order} groups={groups} />
                ) : scanning && !s.assets.length ? (
                  <Empty title={t("app.empty.scanningTitle")} body={t("app.empty.scanningBody")} />
                ) : s.folder && !s.subfolders && !hasDirectFiles ? (
                  <Empty
                    title={s.folder.path ? t("app.empty.noDirectFilesIn", { name: baseName(s.folder.path) }) : t("app.empty.noDirectFilesHere")}
                    body={t("app.empty.inSubfolders")}
                    action={<Button onClick={() => s.setSubfolders(true)}>{t("app.empty.includeSubfolders")}</Button>}
                  />
                ) : s.similar && s.view === "library" ? (
                  <Empty
                    title={t("app.empty.noSimilarTitle", { name: s.similar.name })}
                    body={t("app.empty.noSimilarBody", { count: s.similar.max })}
                    action={<Button onClick={s.clearSimilar}>{t("app.empty.backToLibrary")}</Button>}
                  />
                ) : s.view === "favorites" && !filtered ? (
                  <Empty title={t("app.empty.noFavoritesTitle")} body={t("app.empty.noFavoritesBody", { key: shortcut("favorite").keys })} />
                ) : (
                  <Empty
                    title={t("app.empty.noMatchesTitle")}
                    body={t("app.empty.noMatchesBody")}
                    action={<Button onClick={s.clearFilters}>{t("app.empty.clearFilters")}</Button>}
                  />
                )}
              </div>
            </>
          )}
          {s.view === "collections" && <CollectionsView items={order} groups={groups} scopeAssets={scopeAssets} />}
          {s.view === "duplicates" && s.roots.length > 0 && <DuplicatesView visible={visible} scopeAssets={scopeAssets} />}
          {s.view === "home" && s.roots.length > 0 && <HomeView />}
          {s.view === "insights" && s.roots.length > 0 && <InsightsView />}
          {navigable && !peekOn && !s.palette && !s.full && order.length > 0 && (
            // One line: hints that don't fit drop out whole, and the way to the full list comes first so it never does.
            <div className="pointer-events-none absolute bottom-3.5 left-[calc(var(--sidebar-w)+16px)] z-[5] flex h-[30px] max-w-[calc(100%-var(--sidebar-w)-32px)] flex-wrap content-start items-center gap-x-3.5 gap-y-4 overflow-hidden rounded-[9px] border border-line-soft bg-bg/90 px-3 py-1.5 text-xs whitespace-nowrap text-faint">
              <span>
                <Kbd>{shortcut("help").keys}</Kbd> {t("app.allShortcuts")}
              </span>
              {HINTS.map((h) => (
                <span key={h.id}>
                  <Kbd>{h.keys}</Kbd> {h.hint}
                </span>
              ))}
            </div>
          )}
          <ScanStatus />
        </main>
        {peekOn && <Peek list={order} />}
      </div>

      {s.full && active && <FullView list={order} />}
      {s.palette && <Palette shown={browse || s.view === "collections" ? visible : undefined} />}
      {s.suggestFor && <SuggestTags ids={s.suggestFor} />}
      {s.modal === "shortcuts" && <ShortcutsDialog />}
      {s.modal === "settings" && <SettingsDialog />}
      <UpdateDialog />
      <AgentAsk />
      <Toast />
    </div>
  );
}
