import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { Maximize2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { compare } from "../lib/filter";
import { differingParts } from "../lib/format";
import { ago, bytes } from "../lib/fmt";
import { t } from "../lib/i18n";
import { useStore } from "../store";
import type { Asset, Collection } from "../types";
import { ScopeChips } from "./Header";
import { locationOf, useLocation } from "./Peek";
import { Thumb } from "./Thumb";
import { Button, IconButton, Modal, T } from "./ui";

interface Group {
  hash: string;
  items: Asset[];
}

/** Height of one row in the group list, gap included. */
const ROW = 64;

const wasted = (g: Group) => g.items[0].size * (g.items.length - 1);
const newest = (g: Group) => Math.max(...g.items.map((a) => a.mtime));
type DupSort = "space" | "copies" | "newest" | "name";
const sorts: Record<DupSort, { label: string; by: (a: Group, b: Group) => number }> = {
  space: { label: t("duplicatesView.sorts.space"), by: (a, b) => wasted(b) - wasted(a) },
  copies: { label: t("duplicatesView.sorts.copies"), by: (a, b) => b.items.length - a.items.length || wasted(b) - wasted(a) },
  newest: { label: t("duplicatesView.sorts.newest"), by: (a, b) => newest(b) - newest(a) },
  name: { label: t("duplicatesView.sorts.name"), by: (a, b) => compare.name(a.items[0], b.items[0]) },
};

function openFull(a: Asset) {
  useStore.setState({ activeId: a.id, selected: new Set([a.id]), full: true });
}

function CopyCard({ a, keep, collections, onKeep }: { a: Asset; keep: boolean; collections: Collection[]; onKeep: () => void }) {
  const where = useLocation(a);
  const colls = collections.filter((c) => c.assetIds.includes(a.id)).map((c) => c.name);
  return (
    // The radio is the "Keep" button; a click anywhere on the card picks it too.
    <div
      onClick={onKeep}
      className={clsx("flex min-w-0 cursor-pointer flex-col gap-3.5 rounded-[14px] border-[1.5px] bg-card p-3.5", keep ? "border-invert-bg" : "border-line-strong")}
    >
      <div
        onDoubleClick={() => openFull(a)}
        className="checker relative flex h-[min(260px,30vh)] items-center justify-center overflow-hidden rounded-[10px]"
      >
        <Thumb asset={a} className="aspect-square h-[86%] max-w-[92%] rounded-md" />
        <IconButton
          label={t("duplicatesView.fullScreen", { name: a.name })}
          bordered
          className="absolute top-2 right-2 bg-card"
          onClick={(e) => {
            e.stopPropagation();
            openFull(a);
          }}
        >
          <Maximize2 className="size-4" />
        </IconButton>
      </div>
      <div className="flex items-center justify-between gap-2.5">
        <span className="text-[15px] font-semibold [overflow-wrap:anywhere]">{a.name}</span>
        <button
          type="button"
          role="radio"
          aria-checked={keep}
          aria-label={t("duplicatesView.keepLabel", { name: a.name, folder: where })}
          tabIndex={keep ? 0 : -1}
          onClick={(e) => {
            e.stopPropagation();
            onKeep();
          }}
          className={clsx(
            "rounded-lg border px-3 py-1.5 font-medium whitespace-nowrap",
            keep ? "border-invert-bg bg-invert-bg text-invert-fg" : "border-line-strong text-fg",
          )}
        >
          {keep ? t("duplicatesView.keeping") : t("duplicatesView.keepThis")}
        </button>
      </div>
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-y-2">
        <dt className="text-muted">{t("duplicatesView.details.folder")}</dt>
        <dd className="font-mono text-xs [overflow-wrap:anywhere]">{where}</dd>
        <dt className="text-muted">{t("duplicatesView.details.size")}</dt>
        <dd>
          {bytes(a.size)}
          {a.width && a.height ? ` · ${a.width} × ${a.height}` : ""}
        </dd>
        <dt className="text-muted">{t("duplicatesView.details.modified")}</dt>
        <dd>{ago(a.mtime)}</dd>
        <dt className="text-muted">{t("duplicatesView.details.tags")}</dt>
        <dd>{a.tags.map((tag) => `#${tag}`).join(" ") || t("duplicatesView.details.none")}</dd>
        <dt className="text-muted">{t("duplicatesView.details.collections")}</dt>
        <dd>{colls.join(", ") || t("duplicatesView.details.none")}</dd>
      </dl>
    </div>
  );
}

const GroupRow = memo(function GroupRow({ g, i, current }: { g: Group; i: number; current: boolean }) {
  const roots = useStore((s) => s.roots);
  const first = g.items[0];
  const where = g.items.map((a) => locationOf(roots, a) + (a.name === first.name ? "" : a.name));
  return (
    <div
      id={`dup-${i}`}
      role="option"
      aria-selected={current}
      onClick={() => useStore.setState({ dupSel: g.hash })}
      className={clsx(
        "flex h-[58px] cursor-pointer items-center gap-3 rounded-[10px] border px-3 hover:bg-field",
        current ? "border-line-strong bg-field group-focus-visible/list:ring-2 group-focus-visible/list:ring-fg" : "border-transparent",
      )}
    >
      <div className="flex flex-none">
        <Thumb asset={g.items[0]} size="row" className="size-[34px] rounded-[7px] border-2 border-bg" />
        <Thumb asset={g.items[1]} size="row" className="-ml-3 size-[34px] rounded-[7px] border-2 border-bg" />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">{first.name}</span>
        {/* Where each copy is, so the name isn't repeated; a copy named differently adds its name. */}
        <span className="truncate text-muted" title={where.join("\n")}>
          {differingParts(where).join(", ")}
        </span>
      </div>
      <span className="ml-auto flex flex-none flex-col items-end gap-0.5 font-mono text-[11px] text-faint">
        <span>{bytes(g.items[0].size)}</span>
        {g.items.length > 2 && <span>×{g.items.length}</span>}
      </span>
    </div>
  );
});

/** The groups as one focusable listbox: arrows, Page Up/Down, Home and End move through them. Only visible rows render. */
function GroupList({ groups, sel }: { groups: Group[]; sel: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: groups.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 6 });
  useEffect(() => {
    if (groups.length) v.scrollToIndex(sel, { align: "auto" });
  }, [sel, groups.length, v]);
  const rows = v.getVirtualItems();
  const shown = rows.some((r) => r.index === sel);
  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label={t("duplicatesView.groupsLabel")}
      tabIndex={0}
      aria-activedescendant={shown ? `dup-${sel}` : undefined}
      onKeyDown={(e) => {
        const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW) / ROW) - 1);
        const to = { ArrowDown: sel + 1, ArrowUp: sel - 1, PageDown: sel + page, PageUp: sel - page, Home: 0, End: groups.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        useStore.setState({ dupSel: groups[Math.max(0, Math.min(groups.length - 1, to))].hash });
      }}
      className={clsx("group/list min-h-0 flex-1 overflow-y-auto px-3.5 pb-5", shown ? "focus-visible:outline-none" : "-outline-offset-2")}
    >
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {rows.map((r) => (
          <div key={groups[r.index].hash} className="absolute left-0 w-full" style={{ top: r.start }}>
            <GroupRow g={groups[r.index]} i={r.index} current={r.index === sel} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Memoized: the app re-renders on every store change, and this view only needs its own slices.
/** `visible` and `scopeAssets` are the assets in the type chips, search and filters, and the same without the chips. */
export const DuplicatesView = memo(function DuplicatesView({ visible, scopeAssets }: { visible: Asset[]; scopeAssets: Asset[] }) {
  const assets = useStore((s) => s.assets);
  const dups = useStore((s) => s.dups);
  const dupSel = useStore((s) => s.dupSel);
  const collections = useStore((s) => s.collections);
  const ignoreDuplicate = useStore((s) => s.ignoreDuplicate);
  const trashDuplicates = useStore((s) => s.trashDuplicates);
  const clearFilters = useStore((s) => s.clearFilters);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const groups = useMemo(
    () => (dups ?? []).map((g) => ({ hash: g.hash, items: g.ids.map((id) => byId.get(id)).filter((a): a is Asset => !!a) })).filter((g) => g.items.length > 1),
    [dups, byId],
  );
  const [sort, setSort] = useState<DupSort>("space");
  // A group shows when any of its copies passes the type chips, search and filters. The chips count groups, under
  // each kind among their matching copies (identical files can differ in extension).
  const shown = useMemo(() => {
    const ids = new Set(visible.map((a) => a.id));
    return groups.filter((g) => g.items.some((a) => ids.has(a.id))).sort(sorts[sort].by);
  }, [groups, visible, sort]);
  const chips = useMemo(() => {
    const ids = new Set(scopeAssets.map((a) => a.id));
    const counts = new Map<string, number>();
    let total = 0;
    for (const g of groups) {
      const kinds = new Set(g.items.filter((a) => ids.has(a.id)).map((a) => a.kind));
      if (kinds.size) total++;
      for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return { counts, total };
  }, [groups, scopeAssets]);
  const reclaim = useMemo(() => shown.reduce((n, g) => n + wasted(g), 0), [shown]);
  const [keepBy, setKeepBy] = useState<Record<string, number>>({});
  // What the Trash dialog was opened for: a check that finishes meanwhile can put another group on screen.
  const [confirming, setConfirming] = useState<{ keep: Asset; remove: Asset[] } | null>(null);
  // The open group stays open through sorting and filtering. Filtered out, the first group opens instead; resolved, the
  // group that took its place in the list does.
  const lastAt = useRef(0);
  const found = shown.findIndex((g) => g.hash === dupSel);
  const resolved = !groups.some((g) => g.hash === dupSel);
  const sel = found >= 0 ? found : resolved ? Math.min(lastAt.current, Math.max(0, shown.length - 1)) : 0;
  lastAt.current = sel;
  const group = shown[sel];
  // The group on screen is the selection, so full screen opens it and a later sort or filter keeps it.
  useEffect(() => {
    if (group && group.hash !== dupSel) useStore.setState({ dupSel: group.hash });
  }, [group, dupSel]);
  // Default to keeping the copy you've organized most (tags, favorite, collections); ties keep the first.
  const score = (a: Asset) => a.tags.length + (a.favorite ? 1 : 0) + collections.filter((c) => c.assetIds.includes(a.id)).length;
  // A remembered pick whose copy is gone falls back to the default.
  const keepId = group ? (group.items.find((a) => a.id === keepBy[group.hash]) ?? group.items.reduce((best, a) => (score(a) > score(best) ? a : best))).id : null;
  const remove = group ? group.items.filter((a) => a.id !== keepId) : [];
  const kept = group?.items.find((a) => a.id === keepId);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-3.5 border-r border-line-soft pt-5">
        <div className="flex flex-col gap-1.5 px-5">
          <span role="status" className="text-[15px] font-semibold">
            {!groups.length
              ? t("duplicatesView.title")
              : shown.length === groups.length
                ? t("duplicatesView.groups", { count: groups.length })
                : t("duplicatesView.shownGroups", { shown: shown.length, count: groups.length })}
          </span>
          <span className="leading-[1.45] text-muted">
            {dups === null
              ? t("duplicatesView.checking")
              : shown.length
                ? t("duplicatesView.identicalFrees", { size: bytes(reclaim) })
                : groups.length
                  ? t("duplicatesView.identical")
                  : t("duplicatesView.nothing")}
          </span>
        </div>
        {groups.length > 0 && (
          <>
            <ScopeChips counts={chips.counts} total={chips.total} className="px-5" />
            <label className="flex items-center gap-1.5 px-5 text-muted">
              {t("duplicatesView.sort")}
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as DupSort)}
                className="h-[30px] rounded-lg border border-line-strong bg-field px-1.5 text-fg"
              >
                {Object.entries(sorts).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {shown.length > 0 && <GroupList groups={shown} sel={sel} />}
      </div>

      <div className="flex min-h-0 flex-col gap-5 overflow-auto px-[30px] py-6">
        {group && kept ? (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xl font-semibold tracking-[-.01em]">{t("duplicatesView.whichKeep")}</span>
              <span className="text-muted">
                {group.items.length === 2
                  ? t("duplicatesView.bothIdentical", { size: bytes(group.items[0].size) })
                  : t("duplicatesView.allIdentical", { count: group.items.length, size: bytes(group.items[0].size) })}{" "}
                {t("duplicatesView.movesTo", { count: remove.length })}
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label={t("duplicatesView.copyToKeep")}
              onKeyDown={(e) => {
                const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!d) return;
                e.preventDefault();
                const at = group.items.findIndex((a) => a.id === keepId);
                const next = (at + d + group.items.length) % group.items.length;
                setKeepBy((k) => ({ ...k, [group.hash]: group.items[next].id }));
                e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
              }}
              className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[18px]"
            >
              {group.items.map((a) => (
                <CopyCard
                  key={a.id}
                  a={a}
                  keep={a.id === keepId}
                  collections={collections}
                  onKeep={() => setKeepBy((k) => ({ ...k, [group.hash]: a.id }))}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2.5 border-t border-line-soft pt-4">
              <span className="text-muted">{t("duplicatesView.groupOf", { index: sel + 1, count: shown.length })}</span>
              <Button variant="ghost" size="lg" className="ml-auto" onClick={() => void ignoreDuplicate(group.hash)}>
                {t("duplicatesView.notDuplicates")}
              </Button>
              <Button size="lg" onClick={() => void ignoreDuplicate(group.hash)}>
                {group.items.length === 2 ? t("duplicatesView.keepBoth") : t("duplicatesView.keepAll")}
              </Button>
              <Button variant="invert" size="lg" onClick={() => setConfirming({ keep: kept, remove })}>
                {remove.length === 1
                  ? t("duplicatesView.trash.move", { name: remove[0].name })
                  : t("duplicatesView.trash.moveCopies", { count: remove.length })}
              </Button>
            </div>
          </>
        ) : groups.length > 0 ? (
          <div className="m-auto flex flex-col items-center gap-2 text-muted">
            <span className="text-base font-medium text-fg">{t("duplicatesView.noMatchTitle")}</span>
            <span>{t("duplicatesView.noMatchHint")}</span>
            <Button className="mt-2" onClick={clearFilters}>
              {t("duplicatesView.clearFilters")}
            </Button>
          </div>
        ) : (
          dups !== null && (
            <div className="m-auto flex flex-col items-center gap-2 text-muted">
              <span className="text-base font-medium text-fg">{t("duplicatesView.emptyTitle")}</span>
              <span>{t("duplicatesView.emptyHint")}</span>
            </div>
          )
        )}
      </div>

      {confirming && (
        <Modal
          title={
            confirming.remove.length === 1
              ? t("duplicatesView.trash.ask", { name: confirming.remove[0].name })
              : t("duplicatesView.trash.askCopies", { count: confirming.remove.length })
          }
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button data-autofocus onClick={() => setConfirming(null)}>
                {t("duplicatesView.trash.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirming(null);
                  void trashDuplicates(confirming.keep.id, confirming.remove.map((a) => a.id));
                }}
              >
                {t("duplicatesView.trash.confirm")}
              </Button>
            </>
          }
        >
          <p className="leading-relaxed">
            <T
              k="duplicatesView.trash.body"
              vars={{ count: confirming.remove.length, names: confirming.remove.map((a) => a.name).join(", "), keep: confirming.keep.name }}
              tags={[<span className="text-fg" />]}
            />
          </p>
        </Modal>
      )}
    </div>
  );
});
