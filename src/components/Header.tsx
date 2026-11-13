import clsx from "clsx";
import { Check, ChevronDown, Folder, Grid3x3, LayoutGrid, Maximize, Minimize, Search, Sparkles, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { activeFilterCount, parseQuery } from "../lib/filter";
import { pathTo, treeFor, type FolderNode } from "../lib/folders";
import { rootLabel } from "../lib/format";
import { kindLabel, num } from "../lib/fmt";
import { t } from "../lib/i18n";
import type { SortKey } from "../lib/prefs";
import { shortcut } from "../lib/shortcuts";
import { useStore } from "../store";
import { KINDS, type Asset } from "../types";
import { AnalysisNote, LooksNote } from "./Analysis";
import { FilterButton } from "./FilterPanel";
import { Beta, Button, focusAssets, IconButton, KindDot, KindName, Kbd, Segmented, T } from "./ui";

const titles = {
  home: t("header.titles.home"),
  library: t("header.titles.library"),
  favorites: t("header.titles.favorites"),
  collections: t("header.titles.collections"),
  duplicates: t("header.titles.duplicates"),
  insights: t("header.titles.insights"),
  ai: t("header.titles.ai"),
};

export function Header() {
  const { view, query, folder, roots, setPalette, importFolder, fullscreen, setFullscreen } = useStore();
  return (
    <div className="flex h-[60px] flex-none items-center gap-3.5 border-b border-line-soft px-7">
      {(view === "library" || view === "favorites") && folder ? (
        <div className="flex min-w-0 flex-none items-center gap-1.5">
          {view === "favorites" ? (
            <T k="header.favoritesIn" tags={[<h1 className="text-[17px] font-semibold tracking-[-.01em]" />, <span className="text-muted" />, <Breadcrumbs />]} />
          ) : (
            <Breadcrumbs />
          )}
        </div>
      ) : (
        <h1 className="flex flex-none items-center gap-2 text-[17px] font-semibold tracking-[-.01em]">
          {titles[view]}
          {view === "ai" && <Beta />}
        </h1>
      )}
      {/* Home has its own big search field. */}
      {view !== "home" && (
        <button
          type="button"
          onClick={() => setPalette(true)}
          // A container, so a squeezed field drops to just its icon (the text stays for screen readers).
          className="@container ml-auto flex h-9 max-w-[380px] min-w-0 flex-[1_1_auto] items-center gap-2.5 overflow-hidden rounded-[9px] border border-line-strong bg-field px-3 text-left whitespace-nowrap text-muted hover:border-line-x"
        >
          <Search aria-hidden className="size-3.5 flex-none" />
          <span className={clsx("min-w-0 flex-1 truncate @max-[200px]:sr-only", query && "text-fg")}>
            {query || t("header.searchPlaceholder", { hash: "#", type: "type:audio" })}
          </span>
          <span className="@max-[200px]:hidden">
            <Kbd>{shortcut("search").keys}</Kbd>
          </span>
        </button>
      )}
      {/* Secondary until there's a library: the welcome screen's own Import button is the one to press. */}
      <Button variant={roots.length ? "accent" : "outline"} className={clsx("h-9 px-4", view === "home" && "ml-auto")} onClick={() => void importFolder()}>
        {t("header.import")}
      </Button>
      {/* The app window, not the asset viewer: top right, where people look to leave full screen. */}
      <IconButton
        label={t(fullscreen ? "header.window" : "header.fullscreen", { keys: shortcut("fullscreen").keys })}
        className="-mx-1.5 size-9"
        onClick={() => setFullscreen(!fullscreen)}
      >
        {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
      </IconButton>
    </div>
  );
}

/** The "Find similar" scope: who it's for, how loose a match may be, and a way out. */
function SimilarChip({ chip }: { chip: string }) {
  const { similar, analysis, findSimilar, clearSimilar } = useStore();
  const left = analysis.total - analysis.done;
  const [max, setMax] = useState(similar!.max);
  useEffect(() => setMax(similar!.max), [similar!.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { id, name, ids } = similar!;
  return (
    <>
      <button
        type="button"
        className={clsx(chip, "pr-2")}
        onClick={() => {
          clearSimilar();
          focusAssets();
        }}
        aria-label={t("header.similar.stop", { name })}
      >
        {t("header.similar.label", { name })}
        <X aria-hidden className="size-3.5 opacity-55" />
      </button>
      <label
        className="flex h-[30px] flex-none items-center gap-2 px-1 text-xs text-muted"
        title={left ? t("header.similar.notAnalysed", { count: left }) : undefined}
      >
        {t("header.similar.strict")}
        <input
          type="range"
          aria-label={t("header.similar.slider")}
          aria-valuetext={t("header.similar.sliderValue", { max, count: ids.length })}
          min={1}
          max={24}
          value={max}
          onChange={(e) => {
            setMax(Number(e.target.value));
            void findSimilar(id, Number(e.target.value));
          }}
          className="w-24 accent-[var(--accent)]"
        />
        {t("header.similar.loose")}
      </label>
    </>
  );
}

const sortLabels: Record<SortKey, string> = {
  name: t("header.sort.name"),
  kind: t("header.sort.kind"),
  size: t("header.sort.size"),
  mtime: t("header.sort.mtime"),
  folder: t("header.sort.folder"),
};

const chip = (on: boolean) =>
  clsx(
    "flex h-[30px] flex-none items-center gap-[7px] rounded-[15px] border px-3 text-[12.5px] font-medium whitespace-nowrap",
    on ? "border-invert-bg bg-invert-bg text-invert-fg" : "border-line-strong text-fg-2 hover:border-line-x",
  );

/** What narrows the list: type chips with their counts, the search, "Find similar" and the Filters panel. */
export function ScopeChips({ counts, total, className }: { counts: Map<string, number>; total: number; className: string }) {
  const s = useStore();
  // Only the library and favorites are narrowed by the open folder, and only they save searches.
  const browse = s.view === "library" || s.view === "favorites";
  const iconOnly = s.kindLabels === "icon";
  return (
    <div className={clsx("flex flex-none flex-wrap items-center gap-1.5", className)}>
      <button
        type="button"
        aria-pressed={!s.kinds.length}
        title={iconOnly ? t("header.all") : undefined}
        className={chip(!s.kinds.length)}
        onClick={() => s.toggleKind("all")}
      >
        {s.kindLabels === "name" ? <span aria-hidden className="size-[7px] rounded-full bg-muted" /> : <LayoutGrid aria-hidden className={clsx("size-3.5 flex-none", s.kinds.length > 0 && "text-muted")} />}
        {iconOnly ? <span className="sr-only">{t("header.all")}</span> : t("header.all")}
        <span className="font-mono text-[11px] opacity-80">{num(total)}</span>
      </button>
      {KINDS.filter((k) => counts.get(k)).map((k) => (
        <button
          key={k}
          type="button"
          data-kind={k}
          aria-pressed={s.kinds.includes(k)}
          title={iconOnly ? kindLabel[k] : undefined}
          className={chip(s.kinds.includes(k))}
          onClick={() => s.toggleKind(k)}
        >
          {s.kindLabels === "name" && <KindDot kind={k} />}
          {/* The icon takes the type's colour, except on the inverted chip of a chosen type. */}
          <KindName kind={k} icon={clsx("size-3.5", !s.kinds.includes(k) && "k-text")} />
          <span className="font-mono text-[11px] opacity-80">{num(counts.get(k)!)}</span>
        </button>
      ))}
      {browse && s.folder && (
        <button
          type="button"
          role="switch"
          aria-checked={s.subfolders}
          onClick={() => s.setSubfolders(!s.subfolders)}
          className={clsx(
            "flex h-[30px] flex-none items-center gap-2 rounded-[15px] border px-3 text-[12.5px] font-medium whitespace-nowrap",
            s.subfolders ? "border-accent bg-accent/15 text-fg" : "border-line-strong text-fg-2 hover:border-line-x",
          )}
        >
          <span
            aria-hidden
            className={clsx(
              "flex size-3 items-center justify-center rounded-[3px] text-[10px] font-bold",
              s.subfolders ? "bg-accent text-accent-fg" : "border border-line-x",
            )}
          >
            {s.subfolders ? "✓" : ""}
          </span>
          {t("header.includeSubfolders")}
        </button>
      )}
      {s.query && (
        <button
          type="button"
          className={clsx(chip(true), "pr-2")}
          onClick={() => {
            s.setQuery("");
            focusAssets();
          }}
          aria-label={t("header.clearSearch")}
        >
          {t("header.query", { query: s.query })}
          <X aria-hidden className="size-3.5 opacity-55" />
        </button>
      )}
      {s.similar && <SimilarChip chip={chip(true)} />}
      {s.meaningQuery && (
        <button
          type="button"
          className={clsx(chip(true), "pr-2")}
          onClick={() => {
            s.clearMeaning();
            focusAssets();
          }}
          aria-label={s.meaningQuery.id === undefined ? t("header.meaning.stop", { text: s.meaningQuery.text }) : t("header.related.stop", { name: s.meaningQuery.text })}
        >
          <span className="max-w-[320px] truncate">
            {s.meaningQuery.id === undefined ? t("header.meaning.label", { text: s.meaningQuery.text }) : t("header.related.label", { name: s.meaningQuery.text })}
          </span>
          <X aria-hidden className="size-3.5 opacity-55" />
        </button>
      )}
      {s.shown && (
        <button
          type="button"
          className={clsx(chip(true), "pr-2")}
          onClick={() => {
            s.clearSimilar();
            focusAssets();
          }}
          aria-label={t("agents.shownStop", { name: s.shown.by })}
        >
          {t("agents.shown", { name: s.shown.by })}
          <X aria-hidden className="size-3.5 opacity-55" />
        </button>
      )}
      <FilterButton />
      {/* A smart collection saves only the search, type chips and filters: not Favorites, the open folder or a search by meaning. */}
      {s.view === "library" && !s.folder && !s.meaningQuery && (s.query.trim() || s.kinds.length > 0 || activeFilterCount(s.filters) > 0) && <SaveSmart />}
    </div>
  );
}

/** Type chips, active-scope chips and the view controls above the library grid. */
export function BrowseBar({ count, folders, scopeAssets }: { count: number; folders: number; scopeAssets: Asset[] }) {
  const s = useStore();
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of scopeAssets) m.set(a.kind, (m.get(a.kind) ?? 0) + 1);
    return m;
  }, [scopeAssets]);
  const countText = t("header.assets", { count });
  // `looks:` words in the search or the open smart collection's: what they cover, or why they match nothing.
  const rule = s.view === "collections" ? s.collections.find((c) => c.id === s.colSel)?.rule : null;
  const looks = parseQuery(s.query).looks.length > 0 || (!!rule && parseQuery(rule.query).looks.length > 0);

  // Screen readers hear the count when the search, chips or filters change, not on every batch a scan adds. During a
  // scan the count is still moving, so they wait for its "Scan finished" message instead.
  const scope = JSON.stringify([s.view, s.query, s.kinds, s.folder, s.subfolders, s.filters, s.similar?.id, s.meaningQuery?.id ?? s.meaningQuery?.text, s.shown]);
  const lastScope = useRef(scope);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (lastScope.current === scope) return;
    lastScope.current = scope;
    if (!Object.keys(useStore.getState().scanning).length) setSaid(countText);
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <ScopeChips counts={counts} total={scopeAssets.length} className="px-7 pt-3.5 pb-1" />
      {(s.similar || s.filters.color || parseQuery(s.query).colors.length > 0) && <AnalysisNote className="px-7 pt-2 text-xs" />}
      {s.meaningQuery ? <AnalysisNote ns="meaning" className="px-7 pt-2 text-xs" /> : looks && <LooksNote className="px-7 pt-2 text-xs" />}
      <div className="flex flex-none flex-wrap items-center gap-2 px-7 pt-2.5 pb-3 whitespace-nowrap">
        <span className="mr-auto text-muted">{s.grouped && folders > 1 ? t("header.assetsInFolders", { assets: countText, count: folders }) : countText}</span>
        <span role="status" className="sr-only">
          {said}
        </span>
        <label className="flex items-center gap-1.5 text-muted">
          {t("header.sort.label")}
          <select
            value={s.sort.key}
            onChange={(e) => s.setSort(e.target.value as SortKey)}
            className="h-[30px] rounded-lg border border-line-strong bg-field px-1.5 text-fg"
          >
            {Object.entries(sortLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <IconButton
          label={s.sort.desc ? t("header.sort.descending") : t("header.sort.ascending")}
          className="size-[30px] border border-line-strong"
          onClick={() => s.setSort(s.sort.key)}
        >
          <span aria-hidden className="font-mono text-xs">{s.sort.desc ? "↓" : "↑"}</span>
        </IconButton>
        <Segmented
          label={t("header.grouping")}
          value={s.grouped ? "folder" : "none"}
          onChange={(v) => s.setGrouped(v === "folder")}
          options={[
            { value: "folder", label: t("header.byFolder") },
            { value: "none", label: t("header.allTogether") },
          ]}
        />
        <Segmented
          label={t("header.layout")}
          value={s.layout}
          onChange={s.setLayout}
          options={[
            { value: "grid", label: t("header.grid") },
            { value: "list", label: t("header.list") },
          ]}
        />
        {s.layout === "grid" && (
          <input
            type="range"
            aria-label={t("header.thumbSize")}
            title={t("header.thumbSize")}
            min={110}
            max={320}
            step={10}
            value={s.thumbSize}
            onChange={(e) => s.setThumbSize(Number(e.target.value))}
            className="w-24 accent-[var(--accent)]"
          />
        )}
        <IconButton
          label={s.pixelated ? t("header.pixelatedOn") : t("header.pixelatedOff")}
          aria-pressed={s.pixelated}
          className={clsx("size-[30px] border border-line-strong", s.pixelated && "bg-active text-fg")}
          onClick={() => s.setPixelated(!s.pixelated)}
        >
          <Grid3x3 className="size-4" />
        </IconButton>
      </div>
    </>
  );
}

/** Names the current search and saves it as a smart collection. */
function SaveSmart() {
  const s = useStore();
  const [name, setName] = useState<string | null>(null);
  // Cancelling puts focus back on the button that opened the field.
  const refocus = useRef(false);
  const cancel = () => {
    refocus.current = true;
    setName(null);
  };
  if (name === null)
    return (
      <button
        type="button"
        ref={(el) => {
          if (!el || !refocus.current) return;
          refocus.current = false;
          el.focus();
        }}
        onClick={() => setName(s.query.trim().slice(0, 80))}
        className="flex h-[30px] flex-none items-center gap-[7px] rounded-[15px] border border-dashed border-line-x px-3 text-[12.5px] font-medium whitespace-nowrap text-fg-2 hover:text-fg"
      >
        <Sparkles aria-hidden className="size-3.5" />
        {t("header.saveSmart.button")}
      </button>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // Saving opens the new collection, which unmounts this field: focus the page there instead of losing it.
        void s.saveSmartCollection(name).then((ok) => {
          if (!ok) return;
          setName(null);
          focusAssets();
        });
      }}
      className="focus-ring-within flex h-[30px] flex-none items-center gap-1.5 rounded-[15px] border border-accent pr-1 pl-3"
    >
      <Sparkles aria-hidden className="size-3.5 flex-none text-muted" />
      <input
        aria-label={t("header.saveSmart.name")}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={name}
        maxLength={80}
        placeholder={t("header.saveSmart.placeholder")}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") cancel();
        }}
        className="w-44 border-0 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-muted"
      />
      <button type="submit" className="h-6 rounded-xl bg-accent px-2.5 text-xs font-semibold text-accent-fg">
        {t("header.saveSmart.save")}
      </button>
      <IconButton label={t("header.saveSmart.cancel")} className="size-6" onClick={cancel}>
        <X className="size-3.5" />
      </IconButton>
    </form>
  );
}

/** "game-assets / characters / hero": each name opens that folder, each caret lists the folders inside it. */
function Breadcrumbs() {
  const s = useStore();
  const chain = pathTo(treeFor(s.assets, s.roots), s.folder!);
  const [menu, setMenu] = useState<string | null>(null);
  const close = useCallback(() => setMenu(null), []);
  useEffect(close, [s.folder, close]);

  return (
    <nav aria-label={t("header.folderPath")} className="flex min-w-0 flex-none items-center gap-0.5 text-[17px] tracking-[-.01em]">
      {chain.map((n, i) => {
        const last = i === chain.length - 1;
        return (
          <Fragment key={n.key}>
            {i > 0 && (
              <span aria-hidden className="px-0.5 text-line-x">
                /
              </span>
            )}
            <div className="relative flex items-center">
              <button
                type="button"
                aria-current={last ? "location" : undefined}
                onClick={() => s.setFolder({ rootId: n.rootId, path: n.path })}
                className={clsx("max-w-[180px] truncate rounded-[7px] px-1.5 py-1 hover:bg-active", last ? "font-semibold text-fg" : "text-muted hover:text-fg")}
              >
                {n.name}
              </button>
              {n.children.length > 0 && (
                <button
                  type="button"
                  aria-label={t("header.foldersIn", { name: n.name })}
                  aria-haspopup="menu"
                  aria-expanded={menu === n.key}
                  onClick={() => setMenu(menu === n.key ? null : n.key)}
                  className={clsx("flex size-6 items-center justify-center rounded-md text-muted hover:bg-active hover:text-fg", menu === n.key && "bg-active text-fg")}
                >
                  <ChevronDown aria-hidden className="size-3.5" />
                </button>
              )}
              {menu === n.key && <JumpMenu node={n} current={chain[i + 1]?.key} onClose={close} />}
            </div>
          </Fragment>
        );
      })}
      <IconButton
        label={t("header.wholeLibrary")}
        className="ml-1 size-7"
        onClick={() => {
          s.setFolder(null);
          focusAssets();
        }}
      >
        <X className="size-4" />
      </IconButton>
    </nav>
  );
}

function JumpMenu({ node, current, onClose }: { node: FolderNode; current?: string; onClose: () => void }) {
  const s = useStore();
  const box = useRef<HTMLDivElement>(null);
  const rootName = (id: number) => rootLabel(s.roots, id);
  const recent = s.recentFolders.filter((f) => !(f.rootId === s.folder?.rootId && f.path === s.folder?.path)).slice(0, 4);

  useEffect(() => {
    const el = box.current;
    (el?.querySelector<HTMLElement>('[aria-checked="true"]') ?? el?.querySelector<HTMLElement>("[role^=menuitem]"))?.focus();
    const onDown = (e: MouseEvent) => {
      if (!el?.parentElement?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const onKey = (e: KeyboardEvent) => {
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === "Escape") {
      onClose();
    } else if (e.key !== "Enter" && e.key !== " ") return;
    // Keep the app's own shortcuts (Space, Enter, arrows, Esc) from also firing.
    e.stopPropagation();
  };

  const open = (rootId: number, path: string) => {
    s.setFolder({ rootId, path });
    onClose();
  };

  return (
    <div
      ref={box}
      role="menu"
      aria-label={t("header.foldersIn", { name: node.name })}
      onKeyDown={onKey}
      className="absolute top-full left-0 z-50 mt-1.5 flex w-[300px] flex-col overflow-hidden rounded-[14px] border border-line-x bg-field text-[13px] tracking-normal shadow-[0_30px_80px_-20px_rgba(0,0,0,.7)]"
    >
      <div className="px-3.5 pt-2.5 pb-1.5 text-[11px] font-medium tracking-[.06em] text-faint uppercase">{t("header.inFolder", { name: node.name })}</div>
      <div className="flex max-h-[45vh] flex-col overflow-auto px-1.5 pb-1.5">
        {node.children.map((c) => (
          <button
            key={c.key}
            type="button"
            role="menuitemradio"
            aria-checked={c.key === current}
            onClick={() => open(c.rootId, c.path)}
            className="flex h-[38px] flex-none items-center gap-2.5 rounded-[9px] px-2.5 text-left text-fg -outline-offset-2 hover:bg-active focus:bg-active"
          >
            <Folder aria-hidden className={clsx("size-[15px] flex-none", c.key === current ? "text-accent" : "text-muted")} />
            <span className={clsx("min-w-0 flex-1 truncate", c.key === current && "font-semibold")}>{c.name}</span>
            <span className="font-mono text-[11px] text-muted">{num(c.count)}</span>
            <span className="w-3.5 text-accent">{c.key === current && <Check aria-hidden className="size-3.5" />}</span>
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <div className="border-t border-line px-3.5 pt-2.5 pb-1.5 text-[11px] font-medium tracking-[.06em] text-faint uppercase">{t("header.recentFolders")}</div>
          <div className="flex flex-col px-1.5 pb-2">
            {recent.map((f) => (
              <button
                key={`${f.rootId}:${f.path}`}
                type="button"
                role="menuitem"
                onClick={() => open(f.rootId, f.path)}
                className="flex h-[34px] items-center rounded-[9px] px-2.5 text-left text-fg-2 -outline-offset-2 hover:bg-active focus:bg-active"
              >
                <span className="truncate">{[s.roots.length > 1 || !f.path ? rootName(f.rootId) : "", f.path].filter(Boolean).join("/")}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="flex gap-3.5 border-t border-line px-3.5 py-2 text-xs text-faint">
        <span>{t("header.keys.move", { keys: "↑↓" })}</span>
        <span>{t("header.keys.open", { keys: "↵" })}</span>
        <span className="ml-auto">{t("header.keys.parent", { keys: shortcut("parent").keys })}</span>
      </div>
    </div>
  );
}
