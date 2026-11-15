import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { api, audioUrl, errorText } from "../api";
import type { Group } from "../lib/filter";
import { folderOf } from "../lib/format";
import { ago, bytes, duration } from "../lib/fmt";
import { t } from "../lib/i18n";
import { reducedMotion, type SortKey } from "../lib/prefs";
import { thumbnailFor } from "../lib/thumbs";
import { useStore } from "../store";
import type { Asset } from "../types";
import { Heart, Star } from "lucide-react";
import { Thumb } from "./Thumb";
import { KindPill, ThumbBadges } from "./ui";

const GAP = 16;
const PAD = 28;
const GROUP_GAP = 26;
const HEAD = 30;
const CAPTION = 46;
const ROW = 46;

let dragIcon: Promise<string> | null = null;

/** Native drag of the file(s) out to Explorer/Finder or an engine; copies, never moves. */
async function dragOut(e: DragEvent, asset: Asset, all: Asset[]) {
  e.preventDefault();
  const { selected } = useStore.getState();
  const items = selected.has(asset.id) ? all.filter((a) => selected.has(a.id)) : [asset];
  dragIcon ??= api.dragIcon();
  const icon = (await thumbnailFor(asset)) ?? (await dragIcon);
  try {
    await api.drag(
      items.map((a) => a.path),
      icon,
    );
  } catch (err) {
    useStore.getState().setError(t("assetBrowser.dragFailed", { error: errorText(err) }));
  }
}

// One shared player for hover previews of audio.
const hoverAudio = typeof Audio !== "undefined" ? new Audio() : null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let hovered: Asset | null = null;
function hoverPlay(a: Asset | null) {
  if (hoverTimer) clearTimeout(hoverTimer);
  hovered = a;
  if (!hoverAudio) return;
  hoverAudio.pause();
  // Reduced motion also means no media that starts by itself.
  if (!a || reducedMotion() || !useStore.getState().hoverSound) return;
  hoverTimer = setTimeout(() => {
    audioUrl(a)
      .then((url) => {
        // An AIFF is converted first: only play if the pointer is still on its card.
        if (hovered !== a) return;
        hoverAudio.src = url;
        hoverAudio.volume = 0.6;
        return hoverAudio.play();
      })
      .catch(() => {});
  }, 350);
}

function useHandlers(assets: Asset[]) {
  const { select, setPeek, setFull } = useStore();
  return (a: Asset) => ({
    onClick: (e: MouseEvent) => {
      const mode = e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "replace";
      select(a.id, mode, assets.map((x) => x.id));
      if (mode === "replace") setPeek(true);
    },
    onDoubleClick: () => {
      select(a.id);
      setFull(true);
    },
    onDragStart: (e: DragEvent) => void dragOut(e, a, assets),
    onMouseEnter: a.kind === "audio" ? () => hoverPlay(a) : undefined,
    onMouseLeave: a.kind === "audio" ? () => hoverPlay(null) : undefined,
  });
}

type Line = { type: "head"; group: Group; first: boolean } | { type: "items"; items: Asset[] };

/** What a screen reader says for a card or row: the name first, then what the card shows. */
export function assetLabel(a: Asset) {
  return [
    a.name,
    a.width && a.height ? `${a.width}×${a.height}` : null,
    a.durationMs !== null ? duration(a.durationMs) : null,
    bytes(a.size),
    a.favorite ? t("assetBrowser.favorite") : null,
    a.rating ? t("assetBrowser.stars", { count: a.rating }) : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The asset listbox takes focus itself and points at the active asset (aria-activedescendant); the app's arrow keys
 * move it. Only an asset that is rendered (virtualized lists skip the rest) can be pointed at.
 */
function listboxProps(lines: Line[], rendered: number[], activeId: number | null, cols = 1) {
  const shown = activeId !== null && rendered.some((i) => lines[i].type === "items" && lines[i].items.some((a) => a.id === activeId));
  return {
    role: "listbox",
    "aria-multiselectable": true,
    "aria-label": t("assetBrowser.assets"),
    "data-assets": "",
    // The app's ↑ ↓ keys move by this many cards.
    "data-cols": cols,
    tabIndex: 0,
    "aria-activedescendant": shown ? `asset-${activeId}` : undefined,
    // The ring goes on the active asset; with none, around the whole list.
    className: clsx("group/list", shown ? "focus-visible:outline-none" : "-outline-offset-2"),
  };
}

/** Focus ring on the active asset while the list has keyboard focus. */
const activeRing = "group-focus-visible/list:ring-2 group-focus-visible/list:ring-fg";

/** Flattens groups into virtualizer lines: an optional heading, then rows of `perRow` assets. */
function lines(assets: Asset[], groups: Group[] | null, perRow: number): Line[] {
  const out: Line[] = [];
  const push = (items: Asset[]) => {
    for (let i = 0; i < items.length; i += perRow) out.push({ type: "items", items: items.slice(i, i + perRow) });
  };
  if (!groups) push(assets);
  else
    groups.forEach((g, i) => {
      out.push({ type: "head", group: g, first: i === 0 });
      push(g.items);
    });
  return out;
}

/** `assets` is the display order (already grouped); `groups` is null when not grouping by folder. */
export function AssetBrowser({ assets, groups }: { assets: Asset[]; groups: Group[] | null }) {
  const layout = useStore((s) => s.layout);
  useEffect(() => () => hoverPlay(null), []);
  return layout === "grid" ? <Grid assets={assets} groups={groups} /> : <List assets={assets} groups={groups} />;
}


function GroupHead({ group }: { group: Group }) {
  return (
    <div className="flex h-[30px] items-baseline gap-2.5 pt-1">
      <span className="text-sm font-semibold">{group.label}</span>
      <span className="font-mono text-[11px] text-faint">{t("assetBrowser.groupInfo", { count: group.items.length, size: bytes(group.bytes) })}</span>
    </div>
  );
}

/**
 * Scrolls the active asset into view when it changes, and once `ready` (the grid knows its width, so its lines). A new
 * search by meaning or Find related starts at its closest match instead: the list's scroll position would otherwise
 * land on its weakest ones, and Find related leaves out the active image.
 */
function useActiveScroll(order: Asset[], lineOf: (index: number) => number, scrollTo: (line: number) => void, ready = true) {
  const activeId = useStore((s) => s.activeId);
  const ranked = useStore((s) => s.meaningQuery?.id ?? s.meaningQuery?.text);
  useEffect(() => {
    if (!ready) return;
    const i = order.findIndex((a) => a.id === activeId);
    if (i >= 0) scrollTo(lineOf(i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, ready]);
  useEffect(() => {
    if (ready && ranked !== undefined) scrollTo(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked, ready]);
}

function Grid({ assets, groups }: { assets: Asset[]; groups: Group[] | null }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { thumbSize, selected, activeId, peek, pixelated } = useStore();
  const handlers = useHandlers(assets);
  // Where the active asset sat on screen before a reflow (the side panel opening, the size slider), so it stays there.
  const anchor = useRef<{ id: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Runs before React re-renders, so the cards still sit where the old layout put them.
    const capture = () => {
      const id = useStore.getState().activeId;
      const card = id === null ? null : document.getElementById(`asset-${id}`);
      const box = card?.getBoundingClientRect();
      const top = box ? box.top - el.getBoundingClientRect().top : 0;
      anchor.current = box && top < el.clientHeight && top + box.height > 0 ? { id: id!, top } : null;
    };
    const ro = new ResizeObserver(() => {
      capture();
      setWidth(el.clientWidth);
    });
    ro.observe(el);
    const unsub = useStore.subscribe((s, prev) => s.thumbSize !== prev.thumbSize && capture());
    return () => {
      ro.disconnect();
      unsub();
    };
  }, []);

  const inner = Math.max(0, width - PAD * 2);
  const cols = Math.max(1, Math.floor((inner + GAP) / (thumbSize + GAP)));
  const cardW = (inner - GAP * (cols - 1)) / cols;
  const rowH = cardW + CAPTION + GAP;
  const items = useMemo(() => lines(assets, groups, cols), [assets, groups, cols]);
  const order = assets;

  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const l = items[i];
      return l.type === "head" ? HEAD + 12 + (l.first ? 0 : GROUP_GAP) : rowH;
    },
    overscan: 3,
    paddingStart: 4,
    paddingEnd: 60,
    // Keeps the active card clear of the shortcut hint bar along the bottom.
    scrollPaddingEnd: 56,
  });
  useEffect(() => v.measure(), [rowH, items, v]);
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    const line = a ? items.findIndex((l) => l.type === "items" && l.items.some((x) => x.id === a.id)) : -1;
    if (line < 0) return;
    v.measure();
    v.getTotalSize(); // recomputes measurementsCache for the new column count
    v.scrollToOffset(v.measurementsCache[line].start - a!.top);
  }, [width, thumbSize]); // eslint-disable-line react-hooks/exhaustive-deps
  useActiveScroll(
    order,
    (i) => {
      const id = order[i].id;
      return items.findIndex((l) => l.type === "items" && l.items.some((a) => a.id === id));
    },
    (line) => line >= 0 && v.scrollToIndex(line, { align: "auto" }),
    // Until the first measure the grid has one column of zero width, so a line number would land elsewhere.
    width > 0,
  );
  const lb = listboxProps(items, v.getVirtualItems().map((r) => r.index), activeId, cols);

  return (
    <div ref={scrollRef} {...lb} className={clsx("h-full overflow-y-auto", lb.className)}>
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((row) => {
          const l = items[row.index];
          return (
            <div key={row.key} className="absolute left-0 w-full" style={{ top: row.start, paddingLeft: PAD, paddingRight: PAD }}>
              {l.type === "head" ? (
                <div style={{ paddingTop: l.first ? 0 : GROUP_GAP }}>
                  <GroupHead group={l.group} />
                </div>
              ) : (
                <div className="flex" style={{ gap: GAP }}>
                  {l.items.map((a) => {
                    const isSel = selected.has(a.id) || (a.id === activeId && peek);
                    return (
                      <div
                        key={a.id}
                        id={`asset-${a.id}`}
                        role="option"
                        aria-selected={isSel}
                        aria-label={assetLabel(a)}
                        draggable
                        title={a.relPath}
                        {...handlers(a)}
                        style={{ width: cardW }}
                        className="flex min-w-0 cursor-pointer flex-col gap-[7px] select-none"
                      >
                        <div
                          className={clsx(
                            "relative aspect-square overflow-hidden rounded-xl outline-offset-2",
                            isSel ? "outline-2 outline-accent" : "outline-0",
                            a.id === activeId && activeRing,
                          )}
                        >
                          <Thumb asset={a} pixelated={pixelated} className="h-full w-full rounded-xl" />
                          <ThumbBadges asset={a} className="top-2 right-2" />
                          <KindPill kind={a.kind} className="absolute bottom-2 left-2 px-[7px] py-0.5 text-[11px]" />
                        </div>
                        <span className="truncate font-medium">{a.name}</span>
                        <span className="-mt-[3px] truncate font-mono text-[11px] text-muted">
                          {a.width && a.height ? `${a.width}×${a.height} · ` : ""}
                          {a.durationMs !== null ? `${duration(a.durationMs)} · ` : ""}
                          {bytes(a.size)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const COLS = "48px minmax(0,1.6fr) 120px 90px 80px minmax(0,1fr) 96px";

/** A list column header that sorts by its column; clicking the sorted one flips the direction, like the Sort menu. */
function SortHead({ col, by }: { col: "name" | "type" | "size" | "folder" | "modified"; by: SortKey }) {
  const sort = useStore((s) => s.sort);
  const setSort = useStore((s) => s.setSort);
  const on = sort.key === by;
  return (
    <span role="columnheader" aria-sort={on ? (sort.desc ? "descending" : "ascending") : undefined} className="min-w-0">
      <button type="button" onClick={() => setSort(by)} className={clsx("flex max-w-full items-center gap-1 hover:text-fg", on && "text-fg")}>
        <span className="truncate">{t(`assetBrowser.columns.${col}`)}</span>
        {on && (
          <span aria-hidden className="font-mono">
            {sort.desc ? "↓" : "↑"}
          </span>
        )}
      </button>
    </span>
  );
}

function List({ assets, groups }: { assets: Asset[]; groups: Group[] | null }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { selected, activeId, peek, pixelated } = useStore();
  const handlers = useHandlers(assets);
  const items = useMemo(() => lines(assets, groups, 1), [assets, groups]);
  const order = assets;
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const l = items[i];
      return l.type === "head" ? HEAD + 10 + (l.first ? 0 : GROUP_GAP) : ROW;
    },
    overscan: 12,
    paddingEnd: 60,
    scrollPaddingEnd: 56,
  });
  useEffect(() => v.measure(), [items, v]);
  useActiveScroll(
    order,
    (i) => items.findIndex((l) => l.type === "items" && l.items[0].id === order[i].id),
    (line) => line >= 0 && v.scrollToIndex(line, { align: "auto" }),
  );
  const lb = listboxProps(items, v.getVirtualItems().map((r) => r.index), activeId);

  return (
    <div className="flex h-full flex-col px-7">
      {/* A one-row table, so the column headers can say how the list is sorted (aria-sort needs a columnheader). */}
      <div role="table" aria-label={t("header.sort.label")} className="flex-none">
        <div
          role="row"
          className="grid h-[34px] flex-none items-center rounded-t-xl border border-line bg-panel px-2.5 text-[11.5px] font-medium text-faint"
          style={{ gridTemplateColumns: COLS }}
        >
          <span aria-hidden />
          <SortHead col="name" by="name" />
          <SortHead col="type" by="kind" />
          <span role="columnheader">{t("assetBrowser.columns.dims")}</span>
          <SortHead col="size" by="size" />
          <SortHead col="folder" by="folder" />
          <SortHead col="modified" by="mtime" />
        </div>
      </div>
      <div ref={scrollRef} {...lb} className={clsx("min-h-0 flex-1 overflow-y-auto", lb.className)}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((row) => {
            const l = items[row.index];
            if (l.type === "head")
              return (
                <div key={row.key} className="absolute left-0 w-full px-1" style={{ top: row.start, paddingTop: l.first ? 10 : GROUP_GAP + 10 }}>
                  <GroupHead group={l.group} />
                </div>
              );
            const a = l.items[0];
            const isSel = selected.has(a.id) || (a.id === activeId && peek);
            return (
              <div
                key={row.key}
                id={`asset-${a.id}`}
                role="option"
                aria-selected={isSel}
                aria-label={assetLabel(a)}
                draggable
                {...handlers(a)}
                style={{ top: row.start, height: ROW, gridTemplateColumns: COLS }}
                className={clsx(
                  "absolute left-0 grid w-full cursor-pointer items-center border-b border-line-soft px-2.5 select-none",
                  isSel ? "bg-sel-row inset-ring-2 inset-ring-accent" : "hover:bg-hover",
                  a.id === activeId && "group-focus-visible/list:inset-ring-2 group-focus-visible/list:inset-ring-fg",
                )}
              >
                <Thumb asset={a} size="row" pixelated={pixelated} className="size-8 rounded-[7px]" />
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{a.name}</span>
                  {a.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="rounded-[5px] bg-active px-[7px] py-px text-[11px] whitespace-nowrap text-fg-2">
                      #{tag}
                    </span>
                  ))}
                  {a.rating > 0 && (
                    <span aria-hidden className="flex flex-none items-center gap-0.5 font-mono text-[11px] text-muted">
                      <Star className="size-3 fill-current text-star" />
                      {a.rating}
                    </span>
                  )}
                  {a.favorite && <Heart aria-hidden className="size-3.5 flex-none fill-current text-fav" />}
                </span>
                <span>
                  <KindPill kind={a.kind} />
                </span>
                <span className="font-mono text-xs text-muted">
                  {a.width && a.height ? `${a.width}×${a.height}` : a.durationMs !== null ? duration(a.durationMs) : "—"}
                </span>
                <span className="font-mono text-xs">{bytes(a.size)}</span>
                <span className="truncate text-muted" title={folderOf(a.relPath)}>
                  {folderOf(a.relPath) || "/"}
                </span>
                <span className="text-muted">{ago(a.mtime)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
