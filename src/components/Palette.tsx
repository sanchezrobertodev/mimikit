import clsx from "clsx";
import { CircleAlert, LoaderCircle, ScanSearch, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorText } from "../api";
import { openUpdates, useAppUpdate } from "../appUpdate";
import { askPrompt, badWords, topTags } from "../lib/ask";
import { closeLooks, matchesFilters, matchesQuery, parseQuery, ruleMembers } from "../lib/filter";
import { folderOf, rootLabel } from "../lib/format";
import { bytes } from "../lib/fmt";
import { t } from "../lib/i18n";
import { isMac, shortcut } from "../lib/shortcuts";
import { useStore } from "../store";
import type { Asset } from "../types";
import { openKeySetup } from "./Settings";
import { Thumb } from "./Thumb";
import { focusAssets, KindPill, Kbd, trapTab } from "./ui";

interface Item {
  key: string;
  label: string;
  sub?: string;
  right?: string;
  asset?: Asset;
  icon?: ReactNode;
  /** Runs without closing search. */
  keep?: boolean;
  run: () => void;
}

const TOKENS = ["type:image", "type:audio", "type:3d", "#", "in:", "size:>1mb", "dur:<2s", "rating:>=4", "note:", "color:red"];
const tokenLabel: Record<string, string> = {
  "#": t("palette.tokens.tag", { token: "#" }),
  "in:": t("palette.tokens.folder", { token: "in:" }),
  "note:": t("palette.tokens.word", { token: "note:" }),
};

/** Words typed before Ask sent the user to Settings for a key: search opens with them again, so they can ask once it's set. */
let setupWords: string | null = null;

/** `shown`: the assets on screen, which Suggest tags can take. */
export function Palette({ shown }: { shown?: Asset[] }) {
  const s = useStore();
  const [q, setQ] = useState(() => setupWords ?? s.query);
  useEffect(() => {
    setupWords = null;
  }, []);
  const [pi, setPi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const ran = useRef(false);
  // Ask: whether a key is stored, a call in flight, its error, and the words the current search was written from.
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<{ text: string; settings: boolean } | null>(null);
  const [asked, setAsked] = useState<{ words: string; query: string } | null>(null);
  // Search by meaning: a search in flight (the first one loads the model, about 2 s).
  const [seeking, setSeeking] = useState(false);
  const seek = async (text: string, query: string) => {
    setSeeking(true);
    ran.current = true;
    try {
      await s.findByMeaning(text, query);
    } finally {
      setSeeking(false);
    }
  };
  const meaningReady = s.meaning.on && s.meaning.installed && s.meaning.done > 0;
  useEffect(() => {
    api.apiKeyStatus().then(setHasKey, () => setHasKey(null));
  }, []);
  const openSetup = () => {
    setupWords = q;
    useStore.setState({ palette: false });
    openKeySetup();
  };
  const ask = useRef(async () => {});
  ask.current = async () => {
    const words = q.trim();
    if (!words || asking) return;
    if (hasKey === false) return openSetup();
    setAsking(true);
    setAskError(null);
    try {
      const { query } = await api.askSearch(askPrompt(topTags(s.assets), meaningReady), words, s.ai);
      const bad = badWords(query);
      // A search the parser would read differently from what Claude meant is shown, never run.
      if (!query) setAskError({ text: t("palette.ask.empty"), settings: false });
      else if (bad.length) setAskError({ text: t("palette.ask.invalid", { query, words: bad.join(" ") }), settings: false });
      else {
        setQ(query);
        setAsked({ words, query });
      }
    } catch (e) {
      const text = errorText(e);
      setAskError({ text, settings: text === t("errors.aiNoKey") || text === t("errors.aiBadKey") });
    } finally {
      setAsking(false);
    }
  };

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const box = dialog.current;
    input.current?.focus();
    input.current?.select();
    // Running a result lands on the assets it shows (the chosen one active); closing search goes back to where it opened.
    return () => {
      const at = document.activeElement;
      // Closed while a search by meaning ran: it's dropped, as if it never started.
      if (useStore.getState().dropMeaningOpening()) ran.current = false;
      if (ran.current) focusAssets();
      else if (!at || at === document.body || box?.contains(at)) prev?.focus();
    };
  }, []);
  const wantsColors = parseQuery(q).colors.length > 0;
  useEffect(() => {
    if (wantsColors) void useStore.getState().loadPalettes();
  }, [wantsColors]);
  // `looks:` words are scored once typing pauses, so the counts are right; closing search lets them go.
  const looksKey = JSON.stringify(parseQuery(q).looks);
  useEffect(() => {
    const id = setTimeout(() => useStore.getState().resolveLooks("search", JSON.parse(looksKey)).catch(() => {}), 300);
    return () => clearTimeout(id);
  }, [looksKey]);
  useEffect(() => () => void useStore.getState().resolveLooks("search", []), []);

  const sections = useMemo(() => {
    const out: { title: string; items: Item[] }[] = [];
    const parsed = parseQuery(q);
    const hasQuery = q.trim().length > 0;
    const close = { palette: false };
    if (hasQuery) {
      // The library keeps the Filters panel, so the counts and results do too.
      const now = Date.now();
      const scoring = meaningReady && parsed.looks.some((p) => !s.looks.has(p));
      const matches = closeLooks(
        s.assets.filter((a) => matchesQuery(a, parsed, s.notes, s.palettes, s.looks) && matchesFilters(a, s.filters, now, s.palettes)),
        parsed.looks,
        s.looks,
      );
      // With a collection open, the first result searches inside it.
      const col = s.view === "collections" ? (s.collections.find((c) => c.id === s.colSel) ?? null) : null;
      const members = new Set(col?.rule ? ruleMembers(col.rule, s.assets, s.notes, now, s.palettes, s.looks).map((a) => a.id) : col?.assetIds);
      const inCol = col ? matches.filter((a) => members.has(a.id)) : [];
      // In Duplicates, it keeps the groups that have a matching copy.
      const hits = s.view === "duplicates" && s.dups ? new Set(matches.map((a) => a.id)) : null;
      const inDups = hits ? s.dups!.filter((g) => g.ids.some((id) => hits.has(id))).length : 0;
      const items: Item[] = [
        ...(col
          ? [
              {
                key: "collection",
                label: t("palette.inCollection", { count: inCol.length, name: col.name }),
                sub: q.trim(),
                run: () => useStore.setState({ query: q.trim(), ...close }),
              },
            ]
          : []),
        ...(hits
          ? [
              {
                key: "duplicates",
                label: t("palette.duplicates", { count: inDups }),
                sub: q.trim(),
                run: () => useStore.setState({ query: q.trim(), ...close }),
              },
            ]
          : []),
        {
          key: "all",
          // Until its looks: words are scored, nothing matches yet; say so rather than "No assets match".
          ...(scoring ? { label: t("palette.meaning.seeking"), icon: <LoaderCircle aria-hidden className="size-4 animate-spin text-muted" /> } : { label: matches.length === 1 ? t("palette.showMatch") : t("palette.showAll", { count: matches.length }) }),
          sub: q.trim(),
          run: () => {
            s.go("library", { query: q.trim(), kinds: [], folder: null });
            useStore.setState(close);
          },
        },
        ...matches.slice(0, 8).map((a) => ({
          key: `a${a.id}`,
          label: a.name,
          sub: folderOf(a.relPath) || "/",
          right: bytes(a.size),
          asset: a,
          run: () => {
            s.go("library", { query: "", kinds: [], folder: null });
            s.select(a.id);
            s.setPeek(true);
          },
        })),
      ];
      out.push({ title: t("palette.assets", { count: matches.length }), items });
      // Plain words can be searched by meaning and asked as a search; first when they match nothing, so Enter runs them.
      const extra: { title: string; items: Item[] }[] = [];
      if (parsed.text.length && meaningReady) {
        // The plain words are what the images should show; the search words (type:, #tag, rating:…) still narrow them.
        const typed = q.trim().split(/\s+/);
        const plain = (w: string) => parseQuery(w).text.length > 0;
        const text = typed.filter(plain).join(" ");
        const rest = typed.filter((w) => !plain(w)).join(" ");
        extra.push({
          title: t("palette.meaning.title"),
          items: [
            {
              key: "meaning",
              label: seeking ? t("palette.meaning.seeking") : t("palette.meaning.label", { text }),
              sub: rest || undefined,
              right: shortcut("meaning").keys,
              icon: seeking ? <LoaderCircle aria-hidden className="size-4 animate-spin text-muted" /> : <ScanSearch aria-hidden className="size-4 text-accent" />,
              keep: true,
              run: () => void seek(text, rest),
            },
          ],
        });
      }
      if (parsed.text.length && q.trim() !== asked?.query) {
        const askItem: Item = {
          key: "ask",
          label: hasKey === false ? t("palette.ask.setup") : asking ? t("palette.ask.asking") : t("palette.ask.label"),
          sub: q.trim(),
          right: shortcut("ask").keys,
          icon: asking ? <LoaderCircle aria-hidden className="size-4 animate-spin text-muted" /> : <Sparkles aria-hidden className="size-4 text-accent" />,
          keep: true,
          run: () => void ask.current(),
        };
        extra.push({ title: t("palette.ask.title"), items: [askItem] });
      }
      if (matches.length) out.push(...extra);
      else out.unshift(...extra);
    }
    if (parsed.text.length) {
      const seen = new Map<string, { rootId: number; path: string; n: number }>();
      for (const a of s.assets) {
        const f = folderOf(a.relPath);
        if (!f || !parsed.text.every((w) => f.toLowerCase().includes(w))) continue;
        const k = `${a.rootId}:${f}`;
        const e = seen.get(k) ?? { rootId: a.rootId, path: f, n: 0 };
        e.n++;
        seen.set(k, e);
      }
      const rootName = (id: number) => rootLabel(s.roots, id);
      const folders = [...seen.values()].slice(0, 6);
      if (folders.length)
        out.push({
          title: t("palette.folders"),
          items: folders.map((f) => ({
            key: `f${f.rootId}:${f.path}`,
            label: `${rootName(f.rootId)}/${f.path}`,
            right: t("palette.files", { count: f.n }),
            run: () => s.go("library", { folder: { rootId: f.rootId, path: f.path }, query: "", kinds: [] }),
          })),
        });
    }
    const actions: [string, () => void][] = [
      [t("palette.actions.home"), () => s.go("home")],
      [t("palette.actions.duplicates"), () => s.go("duplicates")],
      [t("palette.actions.insights"), () => s.go("insights")],
      [t("palette.actions.newCollection"), () => void s.newCollection()],
      [t("palette.actions.favorites"), () => s.go("favorites", { kinds: [] })],
      [t("palette.actions.import"), () => {
        useStore.setState(close);
        void s.importFolder();
      }],
      [t("palette.actions.listView"), () => {
        s.setLayout("list");
        s.go("library");
      }],
      [t("palette.actions.gridView"), () => {
        s.setLayout("grid");
        s.go("library");
      }],
      [t("palette.actions.clearFilters"), () => {
        s.clearFilters();
        s.go("library");
      }],
      [t("palette.actions.settings"), () => s.setModal("settings")],
      [t("palette.actions.shortcuts"), () => s.setModal("shortcuts")],
    ];
    if (shown?.length) actions.splice(4, 0, [t("tagging.paletteAction", { count: shown.length }), () => s.setSuggestFor(shown.map((a) => a.id))]);
    if (useAppUpdate.getState().supported) actions.splice(actions.length - 1, 0, [t("palette.actions.updates"), openUpdates]);
    const words = parsed.text;
    const onlyText =
      hasQuery &&
      !parsed.types &&
      !parsed.folder &&
      !parsed.tags.length &&
      !parsed.notes.length &&
      !parsed.colors.length &&
      !parsed.looks.length &&
      parsed.minRating === 0 &&
      parsed.maxRating === 5 &&
      parsed.minMs === null &&
      parsed.maxMs === null;
    const acts = !hasQuery ? actions : onlyText ? actions.filter(([l]) => words.every((w) => l.toLowerCase().includes(w))) : [];
    if (acts.length) out.push({ title: t("palette.actions.title"), items: acts.map(([label, run]) => ({ key: `x${label}`, label, run })) });
    return out;
    // Only what it reads: the whole store changes on every scan tick, and this searches every asset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, s.assets, s.notes, s.palettes, s.looks, s.filters, s.view, s.collections, s.colSel, s.dups, s.roots, hasKey, asking, asked, shown, meaningReady, seeking]);

  const flat = sections.flatMap((sec) => sec.items);
  const run = (item?: Item) => {
    if (!item) return;
    if (item.keep) return item.run();
    ran.current = true;
    item.run();
    useStore.setState({ palette: false });
  };

  useEffect(() => {
    setPi(0);
    setAskError(null);
  }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${pi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [pi]);

  let idx = 0;
  return (
    <div className="absolute inset-0 z-[60] flex justify-center bg-scrim pt-[10vh]" onMouseDown={() => s.setPalette(false)}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.dialog")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDownCapture={(e) => trapTab(e, dialog.current)}
        className="flex h-max max-h-[76vh] w-[min(700px,90%)] flex-col overflow-hidden rounded-2xl border border-line-x bg-field shadow-[0_40px_100px_-20px_rgba(0,0,0,.7)]"
      >
        <div className="flex h-[58px] flex-none items-center gap-3 border-b border-line-strong px-[18px]">
          <Search aria-hidden className="size-4 flex-none text-muted" />
          <input
            ref={input}
            value={q}
            readOnly={asking || seeking}
            aria-busy={asking || seeking}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (isMac ? e.metaKey : e.ctrlKey)) {
                e.preventDefault();
                void ask.current();
              } else if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                run(flat.find((i) => i.key === "meaning"));
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setPi((p) => Math.min(flat.length - 1, p + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setPi((p) => Math.max(0, p - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(flat[pi]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                s.setPalette(false);
              }
              e.stopPropagation();
            }}
            role="combobox"
            aria-label={t("palette.input")}
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={flat[pi] ? `pal-${pi}` : undefined}
            placeholder={t("palette.placeholder")}
            className="flex-1 border-0 bg-transparent text-base text-fg outline-none"
          />
          <Kbd>{shortcut("close").keys}</Kbd>
        </div>
        <div role="status" className="flex items-center gap-2 border-b border-line px-[18px] py-2 text-xs empty:hidden">
          {asking || seeking ? (
            <>
              <LoaderCircle aria-hidden className="size-3.5 flex-none animate-spin text-muted" />
              <span className="text-muted">{asking ? t("palette.ask.asking") : t("palette.meaning.seeking")}</span>
            </>
          ) : askError ? (
            <>
              <CircleAlert aria-hidden className="size-3.5 flex-none text-danger" />
              <span className="min-w-0 flex-1 text-fg">{askError.text}</span>
              {askError.settings && (
                <button type="button" onClick={openSetup} className="flex-none rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-active">
                  {t("palette.ask.openSettings")}
                </button>
              )}
            </>
          ) : asked && q === asked.query ? (
            <>
              <Sparkles aria-hidden className="size-3.5 flex-none text-accent" />
              <span className="min-w-0 flex-1 truncate text-muted" title={asked.words}>
                {t("palette.ask.from", { words: asked.words })}
              </span>
              <button
                type="button"
                onClick={() => {
                  setQ(asked.words);
                  input.current?.focus();
                }}
                className="flex-none rounded-md px-1.5 py-0.5 font-medium text-fg-2 hover:bg-active hover:text-fg"
              >
                {t("palette.ask.back")}
              </button>
            </>
          ) : null}
        </div>
        <div role="group" aria-labelledby="palette-tokens" className="flex flex-wrap items-center gap-1.5 border-b border-line px-[18px] py-2.5 text-xs text-faint">
          <span id="palette-tokens" className="mr-1">
            {t("palette.filters")}
          </span>
          {TOKENS.map((token) => (
            <button
              key={token}
              type="button"
              onClick={() => {
                setQ((cur) => (cur.trim() ? `${cur.trim()} ${token}` : token) + (token.endsWith(":") || token === "#" ? "" : " "));
                input.current?.focus();
              }}
              className="rounded-md bg-active px-2 py-[3px] font-mono text-fg-2 hover:inset-ring-1 hover:inset-ring-line-x"
            >
              {tokenLabel[token] ?? token}
            </button>
          ))}
        </div>
        <div ref={listRef} id="palette-results" role="listbox" aria-label={t("palette.results")} className="overflow-auto p-2">
          {sections.map((sec, si) => (
            <div key={sec.title} role="group" aria-labelledby={`pal-sec-${si}`}>
              <div id={`pal-sec-${si}`} className="px-2.5 pt-2.5 pb-1.5 text-[11px] font-medium tracking-[.06em] text-faint uppercase">
                {sec.title}
              </div>
              {sec.items.map((r) => {
                const my = idx++;
                return (
                  <div
                    key={r.key}
                    id={`pal-${my}`}
                    data-i={my}
                    role="option"
                    aria-selected={my === pi}
                    onMouseEnter={() => setPi(my)}
                    onClick={() => run(r)}
                    className={clsx("flex min-h-11 cursor-pointer items-center gap-3 rounded-[9px] px-2.5", my === pi && "bg-active inset-ring-1 inset-ring-line-x")}
                  >
                    {r.asset && <Thumb asset={r.asset} size="row" className="size-8 flex-none rounded-[7px]" />}
                    {r.icon && <span className="flex size-8 flex-none items-center justify-center rounded-[7px] bg-active">{r.icon}</span>}
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="truncate font-medium">{r.label}</span>
                      {r.sub && <span className="truncate text-xs text-faint">{r.sub}</span>}
                    </span>
                    {r.asset && <KindPill kind={r.asset.kind} className="px-[7px] py-0.5 text-[11px]" />}
                    {r.right && <span className="min-w-[52px] text-right font-mono text-[11px] text-muted">{r.right}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {!sections.length && (
            <div className="px-2.5 py-9 text-center text-muted">
              {t("palette.noResults", { type: "type:image", tag: "#player", rating: "rating:>=4", folder: "in:audio", color: "color:blue" })}
            </div>
          )}
        </div>
        <div className="flex gap-4 border-t border-line px-[18px] py-2.5 text-xs text-faint">
          <span>{t("palette.keys.move", { keys: "↑↓" })}</span>
          <span>{t("palette.keys.select", { keys: shortcut("run").keys })}</span>
          <span className="ml-auto">{t("palette.keys.close", { keys: shortcut("close").keys })}</span>
        </div>
      </div>
    </div>
  );
}
