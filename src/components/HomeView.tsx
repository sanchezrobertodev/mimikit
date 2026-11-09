import { getVersion } from "@tauri-apps/api/app";
import clsx from "clsx";
import { ArrowRight, Copy, Folder, ImageOff, LayoutGrid, Search, Sparkles, Tag, Unplug, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import changelog from "../../CHANGELOG.md?raw";
import { ruleLooks, rulesWantColors, smartMembers } from "../lib/filter";
import { baseName, rootLabel } from "../lib/format";
import { ago, bytes, kindLabel, num } from "../lib/fmt";
import { t } from "../lib/i18n";
import { markSeen, notesSince, seenVersion } from "../lib/news";
import { shortcut } from "../lib/shortcuts";
import { useStore } from "../store";
import { KINDS, type Asset } from "../types";
import { analyse } from "./Analysis";
import { ReleaseNotes } from "./AppUpdate";
import { assetLabel } from "./AssetBrowser";
import { Thumb } from "./Thumb";
import { IconButton, KIND_ICONS, KindPill, Kbd, Modal, T, ThumbBadges } from "./ui";

const card = "rounded-xl border border-line bg-card";
const cardButton = clsx(card, "text-left hover:border-line-x");

function Section({ title, note, more, onMore, children }: { title: string; note?: string; more?: string; onMore?: () => void; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {note && <span className="font-mono text-xs text-muted">{note}</span>}
        {more && (
          <button type="button" onClick={onMore} className="ml-auto flex flex-none items-center gap-1 text-xs text-accent hover:underline">
            {more}
            <ArrowRight aria-hidden className="size-3" />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

/** Three small previews side by side, for a folder or collection card. */
function Strip({ assets }: { assets: Asset[] }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {[0, 1, 2].map((i) =>
        assets[i] ? (
          <Thumb key={assets[i].id} asset={assets[i]} size="strip" className="aspect-square w-full rounded-lg" />
        ) : (
          <div key={i} className="aspect-square rounded-lg bg-active" />
        ),
      )}
    </div>
  );
}

/** After an update: the changelog since the version last seen, until dismissed. */
function News() {
  const [version, setVersion] = useState<string | null>(null);
  const [seen, setSeen] = useState(seenVersion);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);
  const notes = useMemo(() => (version && seen !== version ? notesSince(changelog, seen, version) : ""), [version, seen]);
  if (!notes || !version) return null;
  const done = () => {
    markSeen(version);
    setSeen(version);
  };

  return (
    <div className={clsx(card, "flex items-center gap-3 px-4 py-2.5")}>
      <Sparkles aria-hidden className="size-4 flex-none text-accent" />
      <span className="min-w-0 flex-1 truncate">
        <T k="homeView.news.updated" vars={{ version }} tags={[<span className="font-medium" />]} />
      </span>
      <button type="button" onClick={() => setOpen(true)} className="flex-none text-xs text-accent hover:underline">
        {t("homeView.news.show")}
      </button>
      <IconButton label={t("homeView.news.dismiss")} onClick={done} className="size-6">
        <X className="size-3.5" />
      </IconButton>
      {open && (
        <Modal title={t("homeView.news.title", { version })} onClose={() => (setOpen(false), done())} wide>
          <div className="pb-2">
            <ReleaseNotes notes={notes} />
          </div>
        </Modal>
      )}
    </div>
  );
}

/** The start page: search, where you were, what the library holds, what changed and what needs a look. */
export function HomeView() {
  const s = useStore();
  const rootName = (id: number) => rootLabel(s.roots, id);

  const d = useMemo(() => {
    const total = s.assets.reduce((n, a) => n + a.size, 0);
    const kinds = KINDS.map((k) => {
      const list = s.assets.filter((a) => a.kind === k);
      return { k, count: list.length, b: list.reduce((n, a) => n + a.size, 0) };
    }).filter((x) => x.count);
    const recent = [...s.assets].sort((x, y) => y.mtime - x.mtime).slice(0, 8);
    const favorites = s.assets
      .filter((a) => a.favorite || a.rating >= 4)
      .sort((x, y) => y.rating - x.rating || +y.favorite - +x.favorite)
      .slice(0, 6);
    const tags = new Map<string, number>();
    for (const a of s.assets) for (const tag of a.tags) if (!/\s/.test(tag)) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    const topTags = [...tags].sort((x, y) => y[1] - x[1]).slice(0, 3);
    const untagged = s.assets.filter((a) => !a.tags.length).length;
    return { total, kinds, recent, favorites, topTags, untagged };
  }, [s.assets]);

  // Only the four collections shown; colours only when a rule needs them, as in the sidebar.
  const shown = useMemo(() => s.collections.slice(0, 4), [s.collections]);
  const palettes = rulesWantColors(shown) ? s.palettes : null;
  const looks = ruleLooks(shown).length ? s.looks : null;
  const smart = useMemo(() => smartMembers(shown, s.assets, s.notes, palettes, looks), [shown, s.assets, s.notes, palettes, looks]);
  const byId = useMemo(() => new Map(s.assets.map((a) => [a.id, a])), [s.assets]);
  // A folder emptied or deleted since it was opened isn't worth going back to.
  const folders = s.recentFolders
    .map((f) => {
      const inside = s.assets.filter((a) => a.rootId === f.rootId && (!f.path || a.relPath.startsWith(`${f.path}/`)));
      // Pictures make the best preview; folders of sounds or fonts show those instead.
      const preview = [...inside.filter((a) => a.kind === "image" || a.kind === "model"), ...inside].slice(0, 3);
      return { f, name: baseName(f.path) || rootName(f.rootId), where: f.path ? `${rootName(f.rootId)}/${f.path}` : (s.roots.find((r) => r.id === f.rootId)?.path ?? ""), count: inside.length, preview };
    })
    .filter((x) => x.count)
    .slice(0, 3);
  const collections = shown.map((c) => ({ c, members: c.rule ? (smart.get(c.id) ?? []) : c.assetIds.flatMap((id) => byId.get(id) ?? []) }));

  // A link shows what it names, so it starts from a clear search and Filters panel.
  const show = (extra?: Parameters<typeof s.go>[1]) => {
    s.clearFilters();
    s.go("library", extra);
  };
  const open = (a: Asset) => {
    show();
    s.select(a.id);
    s.setPeek(true);
  };

  const left = s.analysis.total - s.analysis.done;
  const attention = [
    s.dups?.length ? { icon: Copy, text: t("homeView.attention.duplicates", { count: s.dups.length }), action: t("homeView.attention.review"), run: () => s.go("duplicates") } : null,
    ...s.roots
      .filter((r) => s.missing[r.id])
      .map((r) => ({
        icon: Unplug,
        text: t("homeView.attention.offline", { name: rootName(r.id) }),
        action: t("homeView.attention.show"),
        run: () => show({ folder: { rootId: r.id, path: "" } }),
      })),
    left > 0 && !s.analysis.running ? { icon: ImageOff, text: t("homeView.attention.unanalysed", { count: left }), action: t("homeView.attention.analyse"), run: analyse } : null,
    d.untagged
      ? { icon: Tag, text: t("homeView.attention.untagged", { count: d.untagged }), action: t("homeView.attention.show"), run: () => (show(), s.setFilters({ untagged: true })) }
      : null,
  ].filter((x) => x !== null);

  return (
    <div className="flex flex-1 flex-col gap-7 overflow-auto px-7 pt-6 pb-12">
      <News />

      <div className="flex flex-col items-center gap-3 pt-3 pb-1">
        <button
          type="button"
          onClick={() => s.setPalette(true)}
          className="flex h-12 w-full max-w-[640px] items-center gap-3 rounded-xl border border-line-strong bg-field px-4 text-left text-[15px] text-muted hover:border-line-x"
        >
          <Search aria-hidden className="size-[18px] flex-none" />
          <span className="flex-1 truncate">{t("homeView.search", { count: s.assets.length, hash: "#", type: "type:audio" })}</span>
          <Kbd>{shortcut("search").keys}</Kbd>
        </button>
        <div role="group" aria-label={t("homeView.examples")} className="flex flex-wrap justify-center gap-1.5">
          {[...d.topTags.map(([tag]) => `#${tag}`), "type:audio", "type:model", "rating:4"].map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => show({ query: q })}
              className="h-7 rounded-[14px] border border-line-strong px-3 font-mono text-xs text-fg-2 hover:border-line-x hover:text-fg"
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {(folders.length > 0 || collections.length > 0) && (
        <Section title={t("homeView.jumpBack")} more={collections.length ? t("homeView.allCollections") : undefined} onMore={() => s.go("collections")}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {folders.map(({ f, name, where, count, preview }) => (
              <button key={`${f.rootId}:${f.path}`} type="button" onClick={() => show({ folder: f })} className={clsx(cardButton, "flex flex-col gap-2.5 p-3")}>
                <Strip assets={preview} />
                <span className="flex min-w-0 items-center gap-2">
                  <Folder aria-hidden className="size-4 flex-none text-muted" />
                  <span className="truncate font-medium">{name}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted">{num(count)}</span>
                </span>
                <span title={where} className="-mt-1.5 truncate text-xs text-faint">{where}</span>
              </button>
            ))}
            {collections.map(({ c, members }) => (
              <button key={c.id} type="button" onClick={() => s.go("collections", { colSel: c.id })} className={clsx(cardButton, "flex flex-col gap-2.5 p-3")}>
                <Strip assets={members} />
                <span className="flex min-w-0 items-center gap-2">
                  {c.rule ? <Sparkles aria-hidden className="size-4 flex-none text-muted" /> : <LayoutGrid aria-hidden className="size-4 flex-none text-muted" />}
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted">{num(members.length)}</span>
                </span>
                <span className="-mt-1.5 truncate text-xs text-faint">{c.rule ? t("homeView.smartCollection") : t("homeView.collection")}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section
        title={t("homeView.library")}
        note={t("homeView.total", { count: s.assets.length, size: bytes(d.total) })}
        more={t("homeView.insights")}
        onMore={() => s.go("insights")}
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
          {d.kinds.map(({ k, count, b }) => {
            const Icon = KIND_ICONS[k];
            return (
              <button key={k} type="button" data-kind={k} onClick={() => show({ kinds: [k] })} className={clsx(cardButton, "flex flex-col gap-1 px-4 py-3.5")}>
                <span className="flex items-center gap-2">
                  <Icon aria-hidden className="k-text size-4" />
                  <span className="text-muted">{kindLabel[k]}</span>
                </span>
                <span className="text-[22px] font-semibold tracking-[-.02em]">{num(count)}</span>
                <span className="font-mono text-[11px] text-faint">{bytes(b)}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title={t("homeView.recent")}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
          {d.recent.map((a) => (
            <button key={a.id} type="button" onClick={() => open(a)} className="flex min-w-0 flex-col gap-1.5 text-left">
              <span className="relative block">
                <Thumb asset={a} size="strip" className="aspect-square w-full rounded-xl" />
                <ThumbBadges asset={a} className="top-1.5 right-1.5" />
                <KindPill kind={a.kind} className="absolute bottom-1.5 left-1.5 px-[6px] py-px text-[10.5px]" />
              </span>
              <span className="truncate text-[12.5px] font-medium">{a.name}</span>
              <span className="-mt-1 font-mono text-[11px] text-muted">{ago(a.mtime)}</span>
            </button>
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-x-6 gap-y-7">
        <Section title={t("homeView.favorites")} more={t("homeView.allFavorites")} onMore={() => s.go("favorites", { kinds: [] })}>
          {d.favorites.length ? (
            <div className="grid grid-cols-6 gap-2">
              {d.favorites.map((a) => (
                <button key={a.id} type="button" onClick={() => open(a)} title={a.name} aria-label={assetLabel(a)} className="relative">
                  <Thumb asset={a} size="strip" className="aspect-square w-full rounded-lg" />
                  <ThumbBadges asset={a} small className="top-1 right-1" />
                </button>
              ))}
            </div>
          ) : (
            <p className="text-muted">
              <T k="homeView.noFavorites" vars={{ keys: shortcut("favorite").keys }} tags={[<Kbd>{null}</Kbd>]} />
            </p>
          )}
        </Section>
        <Section title={t("homeView.attention.title")}>
          <div className={clsx(card, "flex flex-col px-1.5 py-1")}>
            {attention.map((x) => (
              <div key={x.text} className="flex min-h-10 items-center gap-2.5 border-b border-line-soft px-2.5 py-1 last:border-b-0">
                <x.icon aria-hidden className="size-4 flex-none text-warn-fg" />
                <span className="min-w-0 flex-1">{x.text}</span>
                <button type="button" onClick={x.run} className="flex-none text-xs text-accent hover:underline">
                  {x.action}
                </button>
              </div>
            ))}
            {!attention.length && <span className="px-2.5 py-2.5 text-muted">{t("homeView.attention.allClear")}</span>}
          </div>
        </Section>
      </div>
    </div>
  );
}
