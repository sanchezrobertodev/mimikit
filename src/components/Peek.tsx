import clsx from "clsx";
import { ArrowLeft, ArrowRight, Heart, TriangleAlert, X } from "lucide-react";
import { Component, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, errorText } from "../api";
import { folderOf, rootLabel } from "../lib/format";
import { ago, audioDetails, bytes } from "../lib/fmt";
import { t } from "../lib/i18n";
import { shortcut } from "../lib/shortcuts";
import { useStore } from "../store";
import type { Asset } from "../types";
import { Button, focusAssets, IconButton, KindPill, Label } from "./ui";
import { PreviewFailure, Viewer } from "./Viewers";

export async function openAsset(a: Asset) {
  try {
    await api.openDefault(a.id);
  } catch (e) {
    useStore.getState().setError(errorText(e));
  }
}

export async function revealAsset(a: Asset) {
  try {
    await api.reveal(a.id);
  } catch (e) {
    useStore.getState().setError(errorText(e));
  }
}

/**
 * Shows "Couldn't preview this file" when a viewer fails, whether while rendering (a lazy chunk that fails to load, a
 * bug) or while loading the file, which viewers report through usePreviewFailure. The rest of the panel keeps working.
 * Resets when another asset, or a new version of the file, is shown.
 */
export class PreviewBoundary extends Component<{ asset: Asset; children: ReactNode }, { failed: boolean; message: string | null }> {
  state = { failed: false, message: null as string | null };

  static getDerivedStateFromError(e: unknown) {
    return { failed: true, message: e instanceof PreviewFailure ? e.message : null };
  }

  componentDidUpdate(prev: { asset: Asset }) {
    const a = this.props.asset;
    if (this.state.failed && (prev.asset.id !== a.id || prev.asset.mtime !== a.mtime)) this.setState({ failed: false, message: null });
  }

  render() {
    const a = this.props.asset;
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
        <TriangleAlert aria-hidden className="size-5 text-muted" />
        <div className="flex max-w-[440px] flex-col gap-1">
          <span className="font-medium text-fg">{t("peek.previewFailed.title")}</span>
          <span className="text-xs text-muted">{t("peek.previewFailed.body")}</span>
          {/* The viewer's own message is for a bug report, not the explanation. */}
          {this.state.message && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer hover:text-fg">{t("peek.previewFailed.details")}</summary>
              <p className="mt-1 max-h-16 overflow-auto font-mono text-[11px] select-text [overflow-wrap:anywhere]">{this.state.message}</p>
            </details>
          )}
        </div>
        <div className="flex gap-2">
          {a.kind !== "other" && (
            <Button size="sm" onClick={() => void openAsset(a)}>
              {t("peek.open")}
            </Button>
          )}
          <Button size="sm" onClick={() => void revealAsset(a)}>
            {t("peek.showInFolder")}
          </Button>
        </div>
      </div>
    );
  }
}

export function copyPath(a: Asset) {
  navigator.clipboard.writeText(a.path).then(
    () => useStore.getState().showToast(t("peek.pathCopied")),
    () => useStore.getState().setError(t("peek.copyFailed")),
  );
}

/** "lib/sprites/" the way the design shows a file's location. */
export function useLocation(a: Asset) {
  const roots = useStore((s) => s.roots);
  return [rootLabel(roots, a.rootId), folderOf(a.relPath)].filter(Boolean).join("/") + "/";
}

/** The other copies of `a`, if it's part of a duplicate group, plus that group's position. */
export function useDuplicateOf(a: Asset) {
  const { dups, assets } = useStore();
  return useMemo(() => {
    const i = dups?.findIndex((g) => g.ids.includes(a.id)) ?? -1;
    if (i < 0) return null;
    const others = dups![i].ids.filter((id) => id !== a.id).map((id) => assets.find((x) => x.id === id)?.name ?? "");
    return { hash: dups![i].hash, names: others.filter(Boolean) };
  }, [dups, assets, a.id]);
}

export function DuplicateBanner({ a }: { a: Asset }) {
  const dup = useDuplicateOf(a);
  const go = useStore((s) => s.go);
  if (!dup) return null;
  return (
    <button
      type="button"
      onClick={() => go("duplicates", { dupSel: dup.hash })}
      className="flex items-center justify-between gap-2.5 rounded-[10px] bg-warn-bg px-3 py-2.5 text-left text-warn-fg"
    >
      <span className="min-w-0">{t("peek.identicalTo", { names: dup.names.join(", ") })}</span>
      <span className="font-semibold whitespace-nowrap">{t("peek.review")}</span>
    </button>
  );
}

export function MetaRows({ a }: { a: Asset }) {
  const rows = [
    a.width && a.height ? [t("peek.meta.dimensions"), `${a.width}×${a.height}`] : null,
    audioDetails(a) ? [t("peek.meta.audio"), audioDetails(a)] : null,
    [t("peek.meta.size"), bytes(a.size)],
    [t("peek.meta.format"), `.${a.ext}`],
    [t("peek.meta.modified"), ago(a.mtime)],
  ].filter(Boolean) as [string, string][];
  return (
    <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-y-[9px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="font-mono text-xs [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TagEditor({ items }: { items: Asset[] }) {
  const { addTag, removeTag } = useStore();
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ids = items.map((a) => a.id);
  // On a multi-selection, show the tags all of them share.
  const shared = items.reduce<string[]>((acc, a, i) => (i === 0 ? a.tags : acc.filter((tag) => a.tags.includes(tag))), []);
  const submit = () => {
    const tag = draft.trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-");
    setDraft("");
    if (tag) void addTag(ids, tag);
  };
  return (
    <div className="flex flex-col gap-2">
      <Label>{t("peek.tags.label")}</Label>
      <div className="focus-ring-within flex flex-wrap items-center gap-1.5 rounded-[9px] border border-line-strong bg-card p-1.5">
        {shared.map((tag) => (
          <span key={tag} className="flex h-6 items-center gap-1.5 rounded-md bg-active py-0 pr-1 pl-[9px] text-xs inset-ring-1 inset-ring-line">
            #{tag}
            <button
              type="button"
              aria-label={t("peek.tags.remove", { tag })}
              onClick={() => {
                // The chip goes away with its button; keep focus in the tag field.
                input.current?.focus();
                void removeTag(ids, tag);
              }}
              className="flex size-4 items-center justify-center rounded text-muted hover:text-fg hover:inset-ring-1 hover:inset-ring-line-x"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={input}
          aria-label={t("peek.tags.add")}
          value={draft}
          maxLength={64}
          placeholder={t("peek.tags.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") submit();
            if (e.key === "Escape") focusAssets();
            if (e.key === "Backspace" && !draft && shared.length) void removeTag(ids, shared[shared.length - 1]);
          }}
          className="h-6 min-w-[110px] flex-1 border-0 bg-transparent px-1 text-xs text-fg outline-none"
        />
      </div>
    </div>
  );
}

/**
 * Claude's suggested tags for `items`, under the tag field: dashed chips that add the tag on click, with × to reject it.
 * With several assets selected, each chip covers the ones that have it and shows how many. Focus stays in the row as
 * chips go, then moves to Suggest tags.
 */
export function SuggestedTags({ items }: { items: Asset[] }) {
  const { ai, acceptSuggestions, rejectSuggestions, setSuggestFor } = useStore();
  const row = useRef<HTMLDivElement>(null);
  const suggest = useRef<HTMLButtonElement>(null);
  if (!ai.on) return null;
  const ids = items.map((a) => a.id);
  const having = new Map<string, number[]>();
  for (const a of items) for (const tag of a.suggested) having.set(tag, [...(having.get(tag) ?? []), a.id]);
  const tags = [...having.keys()].sort();
  const many = items.length > 1;
  /** After chip `i` goes: the chip now in its place, or the last one, or Suggest tags. */
  const refocus = (i: number) =>
    requestAnimationFrame(() => {
      const chips = row.current?.querySelectorAll<HTMLElement>("[data-chip]");
      (chips?.length ? chips[Math.min(i, chips.length - 1)] : suggest.current)?.focus();
    });
  const textButton = "text-xs font-semibold text-accent hover:underline";
  return (
    <div className="flex flex-col gap-2">
      {tags.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-2">
            <Label>{t("tagging.suggested")}</Label>
            <span className="flex gap-3">
              <button type="button" className={textButton} onClick={() => (refocus(0), void acceptSuggestions(ids))}>
                {t("tagging.acceptAll")}
              </button>
              <button type="button" className={textButton} onClick={() => (refocus(0), void rejectSuggestions(ids))}>
                {t("tagging.rejectAll")}
              </button>
            </span>
          </div>
          <div ref={row} className="flex flex-wrap gap-1.5">
            {tags.map((tag, i) => {
              const have = having.get(tag)!;
              return (
                <span key={tag} className="flex h-6 items-center rounded-md border border-dashed border-line-strong text-xs text-fg-2">
                  <button
                    type="button"
                    data-chip
                    aria-label={many ? t("tagging.acceptMany", { tag, count: have.length }) : t("tagging.accept", { tag })}
                    onClick={() => (refocus(i), void acceptSuggestions(have, [tag]))}
                    className="flex h-full items-center gap-1 rounded-l-md pr-1 pl-[9px] hover:bg-hover hover:text-fg"
                  >
                    #{tag}
                    {many && <span className="font-mono text-[11px] text-faint">{have.length}</span>}
                  </button>
                  <button
                    type="button"
                    aria-label={t("tagging.reject", { tag })}
                    onClick={() => (refocus(i), void rejectSuggestions(have, [tag]))}
                    className="mr-0.5 flex size-5 items-center justify-center rounded text-muted hover:text-fg hover:inset-ring-1 hover:inset-ring-line-x"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
        </>
      )}
      <button ref={suggest} type="button" className={clsx(textButton, "self-start")} onClick={() => setSuggestFor(ids)}>
        {t("tagging.peekAction")}
      </button>
    </div>
  );
}

/** Five stars as a radio group: click or use the arrow keys. Picking the current rating again clears it. */
export function Stars({ value, onChange, className }: { value: number; onChange: (n: number) => void; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    const to = ({ ArrowRight: value + 1, ArrowUp: value + 1, ArrowLeft: value - 1, ArrowDown: value - 1, Home: 1, End: 5 } as Record<string, number>)[e.key];
    if (to === undefined) return;
    // Keep the arrows from also moving to another asset.
    e.preventDefault();
    e.stopPropagation();
    const n = Math.min(5, Math.max(0, to));
    if (n !== value) onChange(n);
    box.current?.querySelectorAll<HTMLElement>("[role=radio]")[Math.max(n, 1) - 1]?.focus();
  };
  return (
    <div ref={box} role="radiogroup" aria-label={t("peek.rating.label")} onKeyDown={onKeyDown} className={clsx("flex items-center", className)}>
      {[1, 2, 3, 4, 5].map((n) => {
        const hint = value === n ? t("peek.rating.clear", { key: shortcut("unrate").keys }) : t("peek.rating.rate", { count: n, key: String(n) });
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={t("peek.rating.stars", { count: n })}
            title={hint}
            // One tab stop for the group: the current rating, or the first star.
            tabIndex={n === Math.max(value, 1) ? 0 : -1}
            onClick={() => onChange(value === n ? 0 : n)}
            className={clsx(
              "flex size-6 items-center justify-center rounded text-[15px] leading-none hover:bg-active",
              n <= value ? "text-star" : "text-faint hover:text-muted",
            )}
          >
            {n <= value ? "★" : "☆"}
          </button>
        );
      })}
    </div>
  );
}

/** Free-text note for one asset; render it with `key={asset.id}`. Saves after a pause in typing and on blur. */
export function NoteEditor({ a }: { a: Asset }) {
  const { notes, setNote } = useStore();
  const [draft, setDraft] = useState(notes[a.id] ?? "");
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flush = () => {
    clearTimeout(timer.current);
    if (pending.current !== null) void setNote(a.id, pending.current);
    pending.current = null;
  };
  // Switching assets or closing the panel unmounts this: save what's typed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => flush, []);
  return (
    <div className="flex flex-col gap-2">
      <Label>{t("peek.note.label")}</Label>
      <textarea
        aria-label={t("peek.note.label")}
        value={draft}
        maxLength={5000}
        rows={3}
        placeholder={t("peek.note.placeholder")}
        onChange={(e) => {
          setDraft(e.target.value);
          pending.current = e.target.value;
          clearTimeout(timer.current);
          timer.current = setTimeout(flush, 800);
        }}
        onBlur={flush}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") focusAssets();
        }}
        className="min-h-[68px] resize-y rounded-[9px] border border-line-strong bg-card px-2.5 py-2 text-[13px] text-fg placeholder:text-muted"
      />
    </div>
  );
}

export function CollectionChecks({ items }: { items: Asset[] }) {
  const { collections: all, setInCollection, newCollection } = useStore();
  // Smart collections pick their own members. Sets, so checking a big selection stays fast on every render.
  const collections = useMemo(() => all.filter((c) => !c.rule).map((c) => ({ ...c, members: new Set(c.assetIds) })), [all]);
  const ids = items.map((a) => a.id);
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t("peek.collections.label")}</Label>
      {collections.map((c) => {
        const on = ids.every((id) => c.members.has(id));
        return (
          <button key={c.id} type="button" role="checkbox" aria-checked={on} onClick={() => void setInCollection(c.id, ids, !on)} className="flex items-center gap-2.5 py-1 text-left">
            <span
              aria-hidden
              className={clsx(
                "flex size-4 items-center justify-center rounded border text-[11px] font-bold",
                on ? "border-accent bg-accent text-accent-fg" : "border-line-x",
              )}
            >
              {on ? "✓" : ""}
            </span>
            <span className="text-fg-2">{c.name}</span>
          </button>
        );
      })}
      {!collections.length && (
        <button type="button" onClick={() => void newCollection()} className="py-1 text-left text-muted hover:text-fg">
          {t("peek.collections.new")}
        </button>
      )}
    </div>
  );
}

export function Peek({ list }: { list: Asset[] }) {
  const s = useStore();
  const selectedAssets = useMemo(() => s.assets.filter((a) => s.selected.has(a.id)), [s.assets, s.selected]);
  const a = s.assets.find((x) => x.id === s.activeId);
  // Closing the panel (Esc) while focus is in it hands focus back to the asset list instead of dropping it.
  useEffect(
    () => () => {
      if (document.activeElement === document.body) focusAssets();
    },
    [],
  );
  if (!a) return null;
  const multi = selectedAssets.length > 1;
  const mixedRating = selectedAssets.some((x) => x.rating !== selectedAssets[0].rating);
  const sharedRating = multi && !mixedRating ? selectedAssets[0].rating : 0;
  const i = list.findIndex((x) => x.id === a.id);
  const step = (d: number) => list.length && s.select(list[(Math.max(i, 0) + d + list.length) % list.length].id);

  return (
    <aside aria-label={t("peek.details")} className="flex min-h-0 min-w-0 flex-col border-l border-line bg-panel">
      <div className="flex h-[60px] flex-none items-center gap-1.5 border-b border-line-soft px-3.5">
        <IconButton label={t("peek.previous", { key: "←" })} bordered onClick={() => step(-1)}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <IconButton label={t("peek.next", { key: "→" })} bordered onClick={() => step(1)}>
          <ArrowRight className="size-4" />
        </IconButton>
        <span className="ml-1 font-mono text-xs text-faint">{i >= 0 ? t("peek.position", { index: i + 1, total: list.length }) : ""}</span>
        <Button size="sm" className="ml-auto" onClick={() => s.setFull(true)}>
          {t("peek.fullScreen")} <span className="font-mono text-[11px] text-muted">↵</span>
        </Button>
        <IconButton label={t("peek.close", { key: shortcut("back").keys })} onClick={() => s.setPeek(false)}>
          <X className="size-4" />
        </IconButton>
      </div>

      {multi ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto p-[18px]">
          <div className="flex flex-col gap-1">
            <span className="text-lg font-semibold tracking-[-.01em]">{t("peek.selected", { count: selectedAssets.length })}</span>
            <span className="font-mono text-xs text-muted">{t("peek.selectionSize", { size: bytes(selectedAssets.reduce((n, x) => n + x.size, 0)) })}</span>
          </div>
          <Button
            onClick={() => void s.setFavorite(selectedAssets.map((x) => x.id), !selectedAssets.every((x) => x.favorite))}
            className="self-start"
          >
            <Heart aria-hidden className={clsx("size-4", selectedAssets.every((x) => x.favorite) && "fill-current text-fav")} />
            {selectedAssets.every((x) => x.favorite) ? t("peek.unfavoriteAll") : t("peek.favoriteAll")}
          </Button>
          <div className="flex flex-col gap-2">
            <Label>{t("peek.rating.label")}</Label>
            <span className="flex items-center gap-2.5">
              <Stars value={sharedRating} onChange={(n) => void s.setRating(selectedAssets.map((x) => x.id), n)} />
              {mixedRating && <span className="text-xs text-muted">{t("peek.rating.mixed")}</span>}
            </span>
          </div>
          <TagEditor items={selectedAssets} />
          <SuggestedTags items={selectedAssets} />
          <CollectionChecks items={selectedAssets} />
        </div>
      ) : (
        <>
          <div
            onDoubleClick={() => s.setFull(true)}
            className={clsx("flex h-[250px] flex-none items-center justify-center border-b border-line-soft px-[22px] py-4", a.kind === "image" ? "checker" : "bg-bg")}
          >
            {/* Full screen covers the panel and has its own player: two would play the sound twice. */}
            {!s.full && (
              <PreviewBoundary asset={a}>
                <Viewer asset={a} pixelated={s.pixelated} />
              </PreviewBoundary>
            )}
          </div>
          <PeekBody a={a} />
        </>
      )}

      {!multi && (
        <div className="flex flex-none gap-2 border-t border-line-soft px-3.5 py-3">
          {a.kind !== "other" && (
            <Button variant="invert" className="flex-1" onClick={() => void openAsset(a)}>
              {t("peek.open")}
            </Button>
          )}
          <Button className="flex-1" onClick={() => void revealAsset(a)}>
            {t("peek.showInFolder")}
          </Button>
          <Button onClick={() => copyPath(a)}>{t("peek.copyPath")}</Button>
        </div>
      )}
    </aside>
  );
}

/** Image formats the backend can analyse; the same list as kind::DECODABLE. */
const ANALYSABLE = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tga", "psd", "tif", "tiff", "ico", "dds", "exr", "hdr", "qoi", "ase", "aseprite"];

function PeekBody({ a }: { a: Asset }) {
  const setFavorite = useStore((s) => s.setFavorite);
  const setRating = useStore((s) => s.setRating);
  const findSimilar = useStore((s) => s.findSimilar);
  const findRelated = useStore((s) => s.findRelated);
  // Where search by meaning can run; while it's off, Find related says so.
  const meaningHere = useStore((s) => s.meaning.files.length > 0);
  const similar = a.kind === "image" && ANALYSABLE.includes(a.ext);
  // Search by meaning indexes those images, and models, videos and fonts by their previews (meaning.rs).
  const related = meaningHere && (similar || a.kind === "model" || a.kind === "video" || a.kind === "font");
  const where = useLocation(a);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-[18px] pt-[18px] pb-5">
      {/* In a narrow panel the rating and favourite drop under the name instead of squeezing it. */}
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="flex min-w-0 grow basis-40 flex-col gap-2">
          <span className="text-lg font-semibold tracking-[-.01em] [overflow-wrap:anywhere]">{a.name}</span>
          <span className="flex min-w-0 items-center gap-2">
            <KindPill kind={a.kind} className="flex-none" />
            <span className="min-w-0 truncate font-mono text-xs text-muted" title={a.path}>
              {where}
            </span>
          </span>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <Stars value={a.rating} onChange={(n) => void setRating([a.id], n)} />
          <IconButton
            label={t("peek.favorite", { key: shortcut("favorite").keys })}
            aria-pressed={a.favorite}
            bordered
            className="size-[34px] rounded-[9px] text-muted"
            onClick={() => void setFavorite([a.id], !a.favorite)}
          >
            <Heart className={clsx("size-4", a.favorite && "fill-current text-fav")} />
          </IconButton>
        </div>
      </div>
      <DuplicateBanner a={a} />
      {(similar || related) && (
        <div className="flex flex-wrap gap-2">
          {similar && (
            <Button size="sm" onClick={() => void findSimilar(a.id)}>
              {t("peek.findSimilar")}
            </Button>
          )}
          {related && (
            <Button size="sm" onClick={() => void findRelated(a.id)}>
              {t("peek.findRelated")}
            </Button>
          )}
        </div>
      )}
      <MetaRows a={a} />
      <TagEditor items={[a]} />
      <SuggestedTags items={[a]} />
      <CollectionChecks items={[a]} />
      <NoteEditor key={a.id} a={a} />
    </div>
  );
}
