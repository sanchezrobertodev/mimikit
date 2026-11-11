import clsx from "clsx";
import { getVersion } from "@tauri-apps/api/app";
import {
  Bot,
  Check,
  ExternalLink,
  HardDrive,
  Info,
  LibraryBig,
  Palette as PaletteIcon,
  SlidersHorizontal,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useAgents } from "../agent/bridge";
import { agentName } from "../agent/run";
import { api, errorText } from "../api";
import { useAppUpdate } from "../appUpdate";
import { baseName } from "../lib/format";
import { ago, bytes } from "../lib/fmt";
import { locales, t } from "../lib/i18n";
import { AI_EFFORTS, AI_MODELS, type AiPrefs, type Theme } from "../lib/prefs";
import { ACCENTS, THEMES, accentName, themeById, themeName, type ThemeId } from "../lib/themes";
import { forgetThumbnails } from "../lib/thumbs";
import { languageName, systemLanguage } from "../locales";
import { useStore } from "../store";
import { AgentActivity } from "./Agents";
import { analyse, cancelAnalysis, pauseAnalysis } from "./Analysis";
import { Button, Label, Modal, Segmented, T } from "./ui";

const close = () => useStore.getState().setModal(null);

/** A group within a page, under a rule; the title is optional. */
function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col border-t border-line-soft pt-3 pb-2 first:border-t-0 first:pt-0">
      {title && <Label className="pb-1">{title}</Label>}
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-fg">{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** The UI language; System follows the OS languages. Changing it reloads the window. */
function LanguagePicker() {
  const language = useStore((s) => s.language);
  const setLanguage = useStore((s) => s.setLanguage);
  return (
    <select
      aria-label={t("settings.appearance.language")}
      value={locales().includes(language) ? language : "system"}
      onChange={(e) => setLanguage(e.target.value)}
      className="h-[30px] flex-none rounded-lg border border-line-strong bg-field px-1.5 text-fg"
    >
      <option value="system">{t("settings.appearance.languageSystem", { name: languageName(systemLanguage) })}</option>
      {locales().map((code) => (
        <option key={code} value={code} lang={code}>
          {languageName(code)}
        </option>
      ))}
    </select>
  );
}

function Link({ to, children }: { to: Parameters<typeof api.openLink>[0]; children: ReactNode }) {
  const setError = useStore((s) => s.setError);
  return (
    <Button size="sm" onClick={() => void api.openLink(to).catch(setError)}>
      {children} <ExternalLink aria-hidden className="size-3.5" />
    </Button>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={clsx(
        "relative h-5 w-9 flex-none rounded-full border transition-colors duration-150",
        on ? "border-accent bg-accent" : "border-line-x bg-active",
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "absolute top-px left-px size-4 rounded-full transition-transform duration-150",
          on ? "translate-x-4 bg-accent-fg" : "bg-muted",
        )}
      />
    </button>
  );
}

/** Arrow keys move the choice in a radio group (or a tab list), as native radios do; only the chosen item is in the
 * Tab order. */
function radioKeys<T>(items: T[], value: T, onChange: (v: T) => void, chosen = "aria-checked") {
  return (e: KeyboardEvent<HTMLElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    onChange(items[(items.indexOf(value) + step + items.length) % items.length]);
    const group = e.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[${chosen}="true"]`)?.focus());
  };
}

/** A small picture of a theme: sidebar, two lines of text and an accent button, in that theme's own colours. */
function ThemePreview({ id }: { id: ThemeId }) {
  const theme = themeById(id);
  return (
    <span data-theme={theme.id} data-scheme={theme.scheme} className="flex h-full min-w-0 flex-1 bg-bg">
      <span className="w-1/4 border-r border-line bg-panel" />
      <span className="flex flex-1 flex-col justify-center gap-1 px-2">
        <span className="h-1.5 w-3/4 rounded-full bg-fg" />
        <span className="h-1.5 w-1/2 rounded-full bg-muted" />
        <span className="mt-0.5 h-2 w-6 rounded-sm bg-accent" />
      </span>
    </span>
  );
}

const THEME_CHOICES: Theme[] = ["system", ...THEMES.map((theme) => theme.id)];

function ThemePicker() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  return (
    <div role="radiogroup" aria-label={t("settings.appearance.theme")} onKeyDown={radioKeys(THEME_CHOICES, theme, setTheme)} className="grid grid-cols-4 gap-2.5">
      {THEME_CHOICES.map((id) => {
        const on = id === theme;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => setTheme(id)}
            className={clsx(
              "flex min-w-0 flex-col gap-1.5 rounded-[10px] p-1.5 text-left text-xs transition-colors duration-150",
              on ? "text-fg outline-2 outline-offset-2 outline-accent" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <span className="keep-color flex h-12 overflow-hidden rounded-md border border-line-strong">
              {id === "system" ? (
                <>
                  <ThemePreview id="light" />
                  <ThemePreview id="dark" />
                </>
              ) : (
                <ThemePreview id={id} />
              )}
            </span>
            <span className="line-clamp-2 px-0.5">{themeName(id)}</span>
          </button>
        );
      })}
    </div>
  );
}

function AccentPicker() {
  const accent = useStore((s) => s.accent);
  const setAccent = useStore((s) => s.setAccent);
  return (
    <div
      role="radiogroup"
      aria-label={t("settings.appearance.accent")}
      onKeyDown={radioKeys(
        ACCENTS.map((a) => a.id),
        accent,
        setAccent,
      )}
      className="flex flex-none gap-2"
    >
      {ACCENTS.map((a) => {
        const on = a.id === accent;
        return (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={accentName(a.id)}
            title={accentName(a.id)}
            tabIndex={on ? 0 : -1}
            onClick={() => setAccent(a.id)}
            style={{ "--accent-h": a.h, "--accent-c-light": a.light, "--accent-c-dark": a.dark } as CSSProperties}
            className={clsx(
              "accent-swatch keep-color flex size-6 items-center justify-center rounded-full text-accent-fg",
              on && "outline-2 outline-offset-2 outline-fg",
            )}
          >
            {on && <Check aria-hidden className="size-3.5" />}
          </button>
        );
      })}
    </div>
  );
}

export type SettingsPage = "general" | "appearance" | "library" | "claude" | "agents" | "data" | "about";
const PAGES: [SettingsPage, LucideIcon][] = [
  ["general", SlidersHorizontal],
  ["appearance", PaletteIcon],
  ["library", LibraryBig],
  ["claude", Sparkles],
  ["agents", Bot],
  ["data", HardDrive],
  ["about", Info],
];
/** The pages AI features off hides (Settings › General). */
const AI_PAGES: SettingsPage[] = ["claude", "agents"];

/** The page Settings opens on: the last one shown, or the one a link into Settings asked for. */
let lastPage: SettingsPage = "general";
export function openSettings(page?: SettingsPage) {
  if (page) lastPage = page;
  useStore.getState().setModal("settings");
}

/** App settings, one page at a time, picked from the list on the left. */
export function SettingsDialog() {
  const aiOn = useStore((s) => s.ai.on);
  const pages = aiOn ? PAGES : PAGES.filter(([id]) => !AI_PAGES.includes(id));
  const [chosen, setPage] = useState(lastPage);
  // A page AI features off hides shows General instead.
  const page = pages.some(([id]) => id === chosen) ? chosen : "general";
  const go = (p: SettingsPage) => {
    lastPage = p;
    setPage(p);
  };
  return (
    <Modal title={t("settings.title")} onClose={close} pages>
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label={t("settings.title")}
        onKeyDown={radioKeys(pages.map(([id]) => id), page, go, "aria-selected")}
        className="flex w-[200px] flex-none flex-col gap-0.5 overflow-y-auto border-r border-line-soft px-2.5 pb-3"
      >
        {pages.map(([id, Icon]) => {
          const on = id === page;
          return (
            <button
              key={id}
              id={`settings-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls="settings-page"
              tabIndex={on ? 0 : -1}
              onClick={() => go(id)}
              className={clsx(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors duration-150",
                on ? "bg-active font-medium text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
              )}
            >
              <Icon aria-hidden className={clsx("size-4 flex-none", on ? "text-accent" : "text-muted")} />
              {/* Wraps rather than cuts off: some languages' names are long. */}
              <span className="min-w-0 [overflow-wrap:anywhere]">{t(`settings.pages.${id}`)}</span>
            </button>
          );
        })}
      </div>
      {/* Keyed by page, so a new page starts scrolled to the top. */}
      <div key={page} id="settings-page" role="tabpanel" aria-labelledby={`settings-tab-${page}`} className="min-w-0 flex-1 overflow-y-auto px-6 pb-4 text-fg-2">
        <h3 className="pb-2 text-[15px] font-semibold text-fg">{t(`settings.pages.${page}`)}</h3>
        <AgentQuestions />
        {page === "general" && <General />}
        {page === "appearance" && <Appearance />}
        {page === "library" && (
          <>
            <IgnoredFolders />
            <Section>
              <ImageAnalysis />
            </Section>
            <Section>
              <MeaningSearch />
            </Section>
          </>
        )}
        {page === "claude" && <Claude />}
        {page === "agents" && <Agents />}
        {page === "data" && (
          <>
            <Backups />
            <Section>
              <ThumbnailCache />
            </Section>
          </>
        )}
        {page === "about" && <About />}
      </div>
    </Modal>
  );
}

function General() {
  const s = useStore();
  const updatesSupported = useAppUpdate((u) => u.supported);
  return (
    <>
      <Row label={t("settings.appearance.language")} hint={t("settings.appearance.languageHint")}>
        <LanguagePicker />
      </Row>
      <Row label={t("settings.appearance.startView")} hint={t("settings.appearance.startViewHint")}>
        <Segmented
          label={t("settings.appearance.startView")}
          value={s.startView}
          onChange={s.setStartView}
          options={[
            { value: "home", label: t("settings.appearance.startViewHome") },
            { value: "library", label: t("settings.appearance.startViewLibrary") },
          ]}
        />
      </Row>
      {updatesSupported && (
        <Row label={t("settings.updates.checkOnLaunch")} hint={t("settings.updates.checkOnLaunchHint")}>
          <Switch label={t("settings.updates.checkOnLaunch")} on={s.checkUpdates} onChange={s.setCheckUpdates} />
        </Row>
      )}
      <AiSwitch />
    </>
  );
}

/**
 * Settings › General › AI features. Off hides Ask, Suggest tags and AI agents everywhere and turns agents off; the key,
 * tags and unreviewed suggestions stay. While Claude is tagging, turning off asks first, since it cancels the run.
 */
function AiSwitch() {
  const { ai, setAi, tagging, cancelTagging, filters, setFilters } = useStore();
  const [confirming, setConfirming] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const refocus = () => requestAnimationFrame(() => row.current?.querySelector<HTMLElement>("[role=switch]")?.focus());
  const off = async () => {
    // A run that couldn't be canceled stays in sight: AI features stay on, and the error says why.
    if (tagging.assets && !(await cancelTagging())) {
      setConfirming(false);
      return refocus();
    }
    if (useAgents.getState().on) await useAgents.getState().setOn(false);
    // The Suggested filter's chip goes, so the filter goes too rather than narrowing the library out of sight.
    if (filters.suggested) setFilters({ suggested: false });
    setAi({ on: false });
    setConfirming(false);
    refocus();
  };
  return (
    <div ref={row}>
      {confirming ? (
        <Row label={t("settings.ai.switch")} hint={t("settings.ai.switchRunning", { count: tagging.assets })}>
          <div className="flex flex-none gap-2">
            <Button size="sm" onClick={() => (setConfirming(false), refocus())}>
              {t("settings.ai.switchKeep")}
            </Button>
            <Button size="sm" variant="danger" autoFocus onClick={() => void off()}>
              {t("settings.ai.switchOff")}
            </Button>
          </div>
        </Row>
      ) : (
        <Row label={t("settings.ai.switch")} hint={t("settings.ai.switchHint")}>
          <Switch
            label={t("settings.ai.switch")}
            on={ai.on}
            onChange={(on) => (on ? setAi({ on }) : tagging.assets ? setConfirming(true) : void off())}
          />
        </Row>
      )}
    </div>
  );
}

function About() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);
  return (
    <>
      <Row label={version ? t("settings.about.version", { version }) : "Mimikit"} hint={t("settings.about.license")}>
        <div className="flex gap-2">
          <Link to="releases">{t("settings.about.releases")}</Link>
          <Link to="source">{t("settings.about.source")}</Link>
        </div>
      </Row>
      <Row label={t("settings.about.support")} hint={t("settings.about.supportHint")}>
        <Link to="ko-fi">Ko-fi</Link>
      </Row>
    </>
  );
}

function Appearance() {
  const s = useStore();
  return (
    <>
      <div className="flex flex-col gap-2.5 py-2">
        <span className="text-fg">{t("settings.appearance.theme")}</span>
        <ThemePicker />
      </div>
      <Row label={t("settings.appearance.accent")} hint={t("settings.appearance.accentHint")}>
        <AccentPicker />
      </Row>
      <Row label={t("settings.appearance.kindLabels")} hint={t("settings.appearance.kindLabelsHint")}>
        <Segmented
          label={t("settings.appearance.kindLabels")}
          value={s.kindLabels}
          onChange={s.setKindLabels}
          options={[
            { value: "both", label: t("settings.appearance.kindLabelsBoth") },
            { value: "icon", label: t("settings.appearance.kindLabelsIcon") },
            { value: "name", label: t("settings.appearance.kindLabelsName") },
          ]}
        />
      </Row>
      <Row label={t("settings.appearance.thumbSize")} hint={t("settings.appearance.thumbSizeHint")}>
        <div className="flex flex-none items-center gap-2.5">
          <input
            type="range"
            aria-label={t("settings.appearance.thumbSize")}
            min={110}
            max={320}
            step={10}
            value={s.thumbSize}
            onChange={(e) => s.setThumbSize(Number(e.target.value))}
            className="w-32 accent-[var(--accent)]"
          />
          <span className="w-11 text-right font-mono text-xs text-muted">{t("settings.appearance.thumbSizeValue", { size: s.thumbSize })}</span>
        </div>
      </Row>
      <Row label={t("settings.appearance.pixelated")} hint={t("settings.appearance.pixelatedHint")}>
        <Switch label={t("settings.appearance.pixelated")} on={s.pixelated} onChange={s.setPixelated} />
      </Row>
    </>
  );
}

function IgnoredFolders() {
  const { roots, scanning, rescan, setError } = useStore();
  const [names, setNames] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    api.ignoredFolders().then(setNames, setError);
  }, [setError]);

  const save = async (next: string[]) => {
    try {
      setNames(await api.setIgnoredFolders(next));
      setChanged(true);
    } catch (e) {
      setError(e);
    }
  };
  const name = draft.trim();
  const invalid = /[\\/]/.test(name);
  const add = () => {
    if (!name || invalid) return;
    setDraft("");
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) void save([...names, name]);
  };
  const busy = Object.keys(scanning).length > 0;

  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex flex-col gap-0.5">
        <span id="ignored-label" className="text-fg">
          {t("settings.ignored.title")}
        </span>
        <span className="text-xs text-muted">{t("settings.ignored.hint")}</span>
      </div>
      <div className="focus-ring-within flex flex-wrap items-center gap-1.5 rounded-[9px] border border-line-strong bg-card p-1.5">
        {names.map((n) => (
          <span key={n} className="flex h-6 items-center gap-1.5 rounded-md bg-active py-0 pr-1 pl-[9px] font-mono text-xs inset-ring-1 inset-ring-line">
            {n}
            <button
              type="button"
              aria-label={t("settings.ignored.remove", { name: n })}
              onClick={(e) => {
                // The name goes away with its button; keep focus in the field.
                e.currentTarget.closest("div")?.querySelector("input")?.focus();
                void save(names.filter((x) => x !== n));
              }}
              className="flex size-4 items-center justify-center rounded text-muted hover:text-fg hover:inset-ring-1 hover:inset-ring-line-x"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        <input
          aria-labelledby="ignored-label"
          aria-invalid={invalid}
          aria-describedby={invalid ? "ignored-error" : undefined}
          value={draft}
          maxLength={255}
          placeholder={names.length ? t("settings.ignored.addAnother") : t("settings.ignored.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
            if (e.key === "Backspace" && !draft && names.length) void save(names.slice(0, -1));
          }}
          className="h-6 min-w-[200px] flex-1 border-0 bg-transparent px-1 text-xs text-fg outline-none"
        />
      </div>
      {invalid && (
        <span id="ignored-error" className="text-xs text-danger">
          {t("settings.ignored.invalid")}
        </span>
      )}
      <div className="flex items-center justify-between gap-4">
        <span className={clsx("text-xs", changed ? "text-fg-2" : "text-muted")}>
          {changed ? t("settings.ignored.saved") : t("settings.ignored.pending")}
        </span>
        <Button size="sm" disabled={!roots.length || busy} onClick={() => roots.forEach((r) => void rescan(r.id))}>
          {busy ? t("settings.ignored.rescanning") : t("settings.ignored.rescan")}
        </Button>
      </div>
    </div>
  );
}

/** Images a pass analyses per second, for the estimate: 320 measured on mixed generated images with 4 workers (16
 * threads); real textures decode slower and smaller CPUs get fewer workers. */
const PER_SECOND = 150;

function duration(images: number, perSecond = PER_SECOND) {
  const min = Math.round(images / perSecond / 60);
  if (min < 1) return t("settings.analysis.underMinute");
  if (min < 90) return t("settings.analysis.minutes", { count: min });
  return t("settings.analysis.hours", { count: Math.round(min / 60) });
}

function ImageAnalysis() {
  const a = useStore((s) => s.analysis);
  const left = a.total - a.done;
  return (
    <>
      <Row
        label={t("settings.analysis.title")}
        hint={
          <>
            <T k="settings.analysis.progress" vars={{ done: a.done, count: a.total }} tags={[<span className="font-mono" />]} />{" "}
            {left > 0 && !a.running
              ? t("settings.analysis.remaining", { count: left, time: duration(left) })
              : t("settings.analysis.asYouGo")}
          </>
        }
      >
        <div className="flex flex-none gap-2">
          {/* The same first button throughout, so focus stays on it when it changes. */}
          <Button size="sm" disabled={!a.running && left <= 0} onClick={() => (a.running ? pauseAnalysis(!a.paused) : analyse())}>
            {a.running ? (a.paused ? t("settings.analysis.resume") : t("settings.analysis.pause")) : t("settings.analysis.analyse")}
          </Button>
          {a.running && (
            <Button
              size="sm"
              onClick={(e) => {
                // Cancel goes away; keep focus on the button next to it.
                (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                cancelAnalysis();
              }}
            >
              {t("settings.cancel")}
            </Button>
          )}
        </div>
      </Row>
      <Row label={t("settings.analysis.keep")} hint={t("settings.analysis.keepHint")}>
        <Switch label={t("settings.analysis.keep")} on={a.keep} onChange={(on) => void api.setKeepAnalysed(on).catch(useStore.getState().setError)} />
      </Row>
    </>
  );
}

function Backups() {
  const { setError, showToast } = useStore();
  const [busy, setBusy] = useState(false);
  // A backup picked to restore, waiting for confirmation.
  const [restoring, setRestoring] = useState<string | null>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!restoring) return;
    const focus = () => confirm.current?.focus();
    focus();
    // The file dialog can still hold focus here; when the window gets it back, the webview would refocus elsewhere.
    window.addEventListener("focus", focus, { once: true });
    return () => window.removeEventListener("focus", focus);
  }, [restoring]);

  const backUp = async () => {
    const dest = await api.pickFolder(t("settings.backups.pickTitle"));
    if (!dest) return;
    setBusy(true);
    try {
      showToast(t("settings.backups.saved", { name: baseName(await api.backupLibrary(dest)), folder: dest }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    try {
      setRestoring(await api.pickBackup(await api.backupsFolder()));
    } catch (e) {
      setError(e);
    }
  };
  const restore = async (path: string) => {
    setBusy(true);
    try {
      await api.restoreLibrary(path); // Restarts the app when it works.
    } catch (e) {
      setError(e);
      setBusy(false);
      setRestoring(null);
    }
  };

  return (
    <>
      {restoring ? (
        <Row label={t("settings.backups.restoreTitle", { name: baseName(restoring) })} hint={t("settings.backups.restoreHint")}>
          <div className="flex flex-none gap-2">
            <Button size="sm" disabled={busy} onClick={() => setRestoring(null)}>
              {t("settings.cancel")}
            </Button>
            <Button size="sm" ref={confirm} variant="invert" disabled={busy} onClick={() => void restore(restoring)}>
              {busy ? t("settings.backups.restoring") : t("settings.backups.restoreRestart")}
            </Button>
          </div>
        </Row>
      ) : (
        <Row label={t("settings.backups.library")} hint={t("settings.backups.libraryHint")}>
          <div className="flex flex-none gap-2">
            <Button size="sm" disabled={busy} onClick={() => void backUp()}>
              {busy ? t("settings.backups.backingUp") : t("settings.backups.backUp")}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void pick()}>
              {t("settings.backups.restore")}
            </Button>
          </div>
        </Row>
      )}
      <Row label={t("settings.backups.auto")} hint={t("settings.backups.autoHint")}>
        <Button size="sm" onClick={() => void api.backupsFolder().then(api.revealPath).catch(setError)}>
          {t("settings.backups.showFolder")}
        </Button>
      </Row>
    </>
  );
}

function ThumbnailCache() {
  const { setError, showToast } = useStore();
  const [size, setSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    api.cacheSize().then(setSize, setError);
  }, [setError]);

  const clear = async () => {
    setClearing(true);
    try {
      const before = size;
      await api.clearThumbnailCache();
      forgetThumbnails();
      setSize(await api.cacheSize());
      showToast(before === null ? t("settings.cache.clearedCache") : t("settings.cache.cleared", { size: bytes(before) }));
    } catch (e) {
      setError(e);
    } finally {
      setClearing(false);
    }
  };

  return (
    <Row
      label={t("settings.cache.title")}
      hint={<T k="settings.cache.hint" vars={{ size: size === null ? "…" : bytes(size) }} tags={[<span className="font-mono" />]} />}
    >
      <Button size="sm" disabled={clearing || !size} onClick={() => void clear()}>
        {clearing ? t("settings.cache.clearing") : t("settings.cache.clear")}
      </Button>
    </Row>
  );
}

/** Set by Ask in the search box when no key is stored: Settings then opens on the key field. */
let wantKey = false;
export function openKeySetup() {
  wantKey = true;
  openSettings("claude");
}

/** Product names, the same in every language. */
export const MODEL_NAMES: Record<AiPrefs["model"], string> = {
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5-5": "Opus 5.5",
};

/** Settings › Claude: Ask's and Suggest tags' models, the API key, and Remove all AI tags at the bottom. */
function Claude() {
  const { ai, setAi } = useStore();
  return (
    <>
      <p className="pb-1 text-xs text-muted">{t("settings.ai.intro")}</p>
      <ApiKey />
      <Section title={t("palette.ask.title")}>
        <Row label={t("settings.ai.model")} hint={t("settings.ai.modelHint")}>
          <Segmented
            label={t("settings.ai.model")}
            value={ai.model}
            onChange={(model) => setAi({ model })}
            options={AI_MODELS.map((m) => ({ value: m, label: MODEL_NAMES[m] }))}
          />
        </Row>
        <Row label={t("settings.ai.effort")} hint={t("settings.ai.effortHint")}>
          <Segmented
            label={t("settings.ai.effort")}
            value={ai.effort}
            onChange={(effort) => setAi({ effort })}
            options={AI_EFFORTS.map((e) => ({ value: e, label: t(`settings.ai.effortLevel.${e}`) }))}
          />
        </Row>
      </Section>
      <Section title={t("tagging.title")}>
        <Row label={t("settings.ai.model")} hint={t("tagging.settings.tagModelHint")}>
          <Segmented
            label={t("tagging.settings.tagModel")}
            value={ai.tagModel}
            onChange={(tagModel) => setAi({ tagModel })}
            options={AI_MODELS.map((m) => ({ value: m, label: MODEL_NAMES[m] }))}
          />
        </Row>
      </Section>
      <Section>
        <RemoveAiTags />
      </Section>
      <p id="api-key-sent" className="flex gap-1.5 border-t border-line-soft pt-3 text-xs text-muted">
        <Info aria-hidden className="mt-px size-3.5 flex-none" />
        {t("settings.ai.sent")}
      </p>
    </>
  );
}

/** The user's own Anthropic API key, which the backend keeps in the OS credential store (ai.rs). */
function ApiKey() {
  const { setError, showToast } = useStore();
  const [stored, setStored] = useState<boolean | null>(null);
  // The key being typed, or null when not editing. The stored key never comes back to the window.
  const [draft, setDraft] = useState<string | null>(() => (wantKey ? "" : null));
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set when the form or the confirmation closes, so focus goes back to the row's button instead of the page.
  const refocus = useRef(false);
  const focusBack = (b: HTMLButtonElement | null) => {
    if (b && refocus.current) {
      refocus.current = false;
      b.focus();
    }
  };
  const closeForm = () => {
    refocus.current = true;
    setDraft(null);
  };
  const closeConfirm = () => {
    refocus.current = true;
    setRemoving(false);
  };
  useEffect(() => {
    wantKey = false;
    api.apiKeyStatus().then(setStored, setError);
  }, [setError]);

  const act = async (run: () => Promise<void>, toast: string) => {
    setBusy(true);
    try {
      await run();
      showToast(toast);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      await api.setApiKey(draft ?? "");
      setStored(true);
      closeForm();
    }, t("settings.ai.saved"));
  const remove = () =>
    act(async () => {
      await api.removeApiKey();
      setStored(false);
      closeConfirm();
    }, t("settings.ai.removed"));

  return (
    <>
      {draft !== null ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void save();
          }}
          className="flex flex-col gap-1.5 py-2"
        >
          <label htmlFor="api-key" className="text-fg">
            {t("settings.ai.key")}
          </label>
          <div className="flex gap-2">
            <input
              id="api-key"
              type="password"
              data-autofocus
              autoFocus
              autoComplete="off"
              spellCheck={false}
              maxLength={256}
              value={draft}
              placeholder="sk-ant-…"
              aria-describedby="api-key-sent"
              onChange={(e) => setDraft(e.target.value)}
              className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-field px-2.5 font-mono text-xs text-fg"
            />
            <Button size="sm" disabled={busy} onClick={closeForm}>
              {t("settings.cancel")}
            </Button>
            <Button size="sm" type="submit" variant="accent" disabled={busy || !draft.trim()}>
              {t("settings.ai.save")}
            </Button>
          </div>
        </form>
      ) : removing ? (
        <Row label={t("settings.ai.removeTitle")} hint={t("settings.ai.removeHint")}>
          <div className="flex flex-none gap-2">
            <Button size="sm" disabled={busy} onClick={closeConfirm}>
              {t("settings.cancel")}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} autoFocus onClick={() => void remove()}>
              {t("settings.ai.remove")}
            </Button>
          </div>
        </Row>
      ) : (
        <Row label={t("settings.ai.key")} hint={stored === null ? "…" : t(stored ? "settings.ai.keySet" : "settings.ai.keyNotSet")}>
          <div className="flex flex-none gap-2">
            {stored ? (
              <>
                <Button size="sm" ref={focusBack} onClick={() => setDraft("")}>
                  {t("settings.ai.change")}
                </Button>
                <Button size="sm" onClick={() => setRemoving(true)}>
                  {t("settings.ai.remove")}
                </Button>
              </>
            ) : (
              <>
                <Link to="anthropic-keys">{t("settings.ai.getKey")}</Link>
                <Button size="sm" variant="accent" ref={focusBack} disabled={stored === null} onClick={() => setDraft("")}>
                  {t("settings.ai.add")}
                </Button>
              </>
            )}
          </div>
        </Row>
      )}
    </>
  );
}

/** Takes off every tag accepted from Claude's suggestions, after a confirmation with the count (tagging.rs). */
function RemoveAiTags() {
  const { setError, showToast } = useStore();
  // How many to remove while confirming; null otherwise.
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const back = () => {
    setCount(null);
    requestAnimationFrame(() => button.current?.focus());
  };
  const ask = () => api.aiTagCount().then(setCount, setError);
  const remove = async () => {
    setBusy(true);
    try {
      const n = await api.removeAiTags();
      showToast(t("tagging.settings.removed", { count: n }));
      back();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (count === null)
    return (
      <Row label={t("tagging.settings.removeAll")} hint={t("tagging.settings.removeAllHint")}>
        <Button size="sm" variant="danger" ref={button} onClick={() => void ask()}>
          {t("tagging.settings.remove")}
        </Button>
      </Row>
    );
  return (
    <Row label={t("tagging.settings.removeAll")} hint={count ? t("tagging.settings.removeConfirm", { count }) : t("tagging.settings.noAiTags")}>
      <div className="flex flex-none gap-2">
        <Button size="sm" disabled={busy} autoFocus={!count} onClick={back}>
          {t("settings.cancel")}
        </Button>
        {count > 0 && (
          <Button size="sm" variant="danger" disabled={busy} autoFocus onClick={() => void remove()}>
            {t("tagging.settings.remove")}
          </Button>
        )}
      </div>
    </Row>
  );
}

// Images a second while indexing for search by meaning: a guess between this machine's 2- and 4-thread speeds
// (21 to 30 a second) and a slower laptop. shortcut: a fixed estimate; time the first batch if it's often far off.
const MEANING_PER_SECOND = 20;
// Index bytes per image: 768 int8 values, a scale and the row.
const INDEX_BYTES = 800;

/** Settings › Library › Search by meaning: the switch, the download's consent panel, progress, and Delete. */
function MeaningSearch() {
  const m = useStore((s) => s.meaning);
  const [ask, setAsk] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const focusSwitch = () => requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>("[role=switch]")?.focus());
  const run = (p: Promise<unknown>) => void p.catch(useStore.getState().setError);
  const label = t("meaning.settings.title");
  if (!m.files.length) return <Row label={label} hint={t("meaning.settings.unavailable")} />;

  const download = m.files.reduce((n, f) => n + f.size, 0);
  // Also a cancelled download's files, which can be hundreds of MB.
  const freed = m.downloaded + m.done * INDEX_BYTES;
  const left = m.total - m.done;
  const mono = [<span className="font-mono" />];
  const toggle = (on: boolean) => {
    if (!on) run(api.meaningDisable(false));
    else if (m.installed) run(api.meaningEnable());
    else setAsk(true);
  };
  const closeAsk = () => {
    setAsk(false);
    focusSwitch();
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.meaningDisable(true);
      useStore.getState().showToast(t("meaning.settings.deleted"));
      setConfirmDelete(false);
      focusSwitch();
    } catch (e) {
      useStore.getState().setError(e);
    } finally {
      setBusy(false);
    }
  };

  const needsVc = !m.vcRuntime && !m.on;
  let hint: ReactNode = t("meaning.settings.hint");
  if (needsVc) hint = t("meaning.settings.needsVc");
  else if (!m.on && m.installed) hint = `${t("meaning.settings.hint")} ${t("meaning.settings.offInstalled")}`;
  else if (m.on && m.download)
    hint = <T k="meaning.settings.downloading" vars={{ done: bytes(m.download.done), total: bytes(m.download.total) }} tags={mono} />;
  else if (m.on && m.error) hint = <span className="text-danger">{errorText(m.error)}</span>;
  else if (m.on && !m.installed) hint = t("meaning.settings.notDownloaded");
  else if (m.on)
    hint = (
      <>
        <T k="meaning.settings.progress" vars={{ done: m.done, count: m.total }} tags={mono} />{" "}
        {left > 0 && !m.running
          ? t("meaning.settings.remaining", { count: left, time: duration(left, MEANING_PER_SECOND) })
          : t("meaning.settings.asYouGo")}
      </>
    );
  // Starts the pass again: after an error, a cancelled download or a cancelled pass.
  const again = m.on && !m.running && (m.error || !m.installed || left > 0);

  return (
    <div ref={wrap} className="flex flex-col">
      <Row label={label} hint={hint}>
        <div className="flex flex-none items-center gap-2">
          {/* A download can't pause; Cancel keeps what came, and the next one goes on from there. */}
          {m.running && !m.download && (
            <Button size="sm" onClick={() => run(api.pauseMeaning(!m.paused))}>
              {m.paused ? t("meaning.settings.resume") : t("meaning.settings.pause")}
            </Button>
          )}
          {m.running && (
            <Button
              size="sm"
              onClick={() => {
                // Cancel goes away; keep focus nearby.
                focusSwitch();
                run(api.cancelMeaning());
              }}
            >
              {t("settings.cancel")}
            </Button>
          )}
          {again && (
            <Button size="sm" onClick={() => run(api.meaningEnable())}>
              {m.error ? t("meaning.settings.retry") : m.installed ? t("meaning.settings.index") : t("meaning.settings.download")}
            </Button>
          )}
          {needsVc ? <Link to="vc-redist">{t("meaning.settings.vcLink")}</Link> : <Switch label={label} on={m.on || ask} onChange={toggle} />}
        </div>
      </Row>
      {ask && !m.on && (
        <div role="group" aria-labelledby="meaning-consent" className="mb-2 flex flex-col gap-2 rounded-lg border border-line-soft p-3 text-xs text-muted">
          <p id="meaning-consent" className="text-fg">
            {t("meaning.settings.consent", { size: bytes(download) })}
          </p>
          <div id="meaning-consent-details" className="flex flex-col gap-2">
            <ul className="flex flex-col gap-0.5">
              {m.files.map((f) => (
                <li key={f.name} className="flex gap-3">
                  <span className="min-w-0 flex-1 truncate font-mono">{f.name}</span>
                  <span>{t(`meaning.settings.${f.source}`)}</span>
                  <span className="w-16 text-right font-mono">{bytes(f.size)}</span>
                </li>
              ))}
              <li className="flex gap-3 border-t border-line-soft pt-0.5 text-fg">
                <span className="flex-1">{t("meaning.settings.total")}</span>
                <span className="w-16 text-right font-mono">{bytes(download)}</span>
              </li>
            </ul>
            <p>{t("meaning.settings.licences")}</p>
            <p>{t("meaning.settings.disk", { size: bytes(m.total * INDEX_BYTES) })}</p>
            {m.total > 0 && <p>{t("meaning.settings.time", { count: m.total, time: duration(m.total, MEANING_PER_SECOND) })}</p>}
            <p className="text-fg">{t("meaning.settings.promise")}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={closeAsk}>
              {t("settings.cancel")}
            </Button>
            <Button
              size="sm"
              variant="accent"
              autoFocus
              aria-describedby="meaning-consent-details"
              onClick={() => {
                closeAsk();
                run(api.meaningEnable());
              }}
            >
              {t("meaning.settings.download")}
            </Button>
          </div>
        </div>
      )}
      {/* Not while downloading: the download would write on. */}
      {freed > 0 && !ask && !m.download && (
        <Row
          label={t("meaning.settings.delete")}
          hint={confirmDelete ? t("meaning.settings.deleteConfirm", { size: bytes(freed) }) : t("meaning.settings.deleteHint", { size: bytes(freed) })}
        >
          {confirmDelete ? (
            <div className="flex flex-none gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setConfirmDelete(false);
                  requestAnimationFrame(() => deleteButton.current?.focus());
                }}
              >
                {t("settings.cancel")}
              </Button>
              <Button size="sm" variant="danger" disabled={busy} autoFocus onClick={() => void remove()}>
                {t("meaning.settings.deleteButton")}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="danger" ref={deleteButton} onClick={() => setConfirmDelete(true)}>
              {t("meaning.settings.deleteButton")}
            </Button>
          )}
        </Row>
      )}
    </div>
  );
}

/** A setup command or config snippet, with Copy. */
function Setup({ label, text }: { label: string; text: string }) {
  const { setError, showToast } = useStore();
  const copy = () => navigator.clipboard.writeText(text).then(() => showToast(t("agents.copied")), () => setError(t("agents.copyFailed")));
  return (
    <div className="flex flex-col gap-1.5 py-2">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line-soft bg-active px-2.5 py-1.5 font-mono text-[11.5px] text-fg-2 select-all">
          {text}
        </pre>
        <Button size="sm" onClick={() => void copy()}>
          {t("agents.copy")}
        </Button>
      </div>
    </div>
  );
}

/** Apps waiting to be let in, at the top of every Settings page: the corner prompt (AgentAsk) hides while Settings is open. */
function AgentQuestions() {
  const questions = useAgents((s) => s.questions);
  const answer = useAgents((s) => s.answer);
  return questions.map((q) => (
    <div key={q.name} className="mb-2 rounded-lg border border-line-x bg-field px-3">
      <Row label={t("agents.askTitle", { name: agentName(q.name) })} hint={t("agents.askBody")}>
        <div className="flex flex-none gap-2">
          <Button size="sm" onClick={() => answer(q.name, false)}>
            {t("agents.deny")}
          </Button>
          <Button size="sm" variant="accent" onClick={() => answer(q.name, true)}>
            {t("agents.allow")}
          </Button>
        </div>
      </Row>
    </div>
  ));
}

/** Settings › AI agents: the switch, how to connect an agent app, and who's connected (src/agent/bridge.ts). */
function Agents() {
  const a = useAgents();
  const exe = a.exe ?? "mimikit";
  const now = Date.now();
  return (
    <>
      <Row label={t("agents.switch")} hint={a.on ? `${t("agents.switchHint")} ${t("agents.offNote")}` : t("agents.switchHint")}>
        <Switch label={t("agents.switch")} on={a.on} onChange={(on) => void a.setOn(on)} />
      </Row>
      {a.on && (
        <>
          <Setup label={t("agents.claudeCode")} text={`claude mcp add --scope user mimikit -- "${exe}" mcp`} />
          <Setup label={t("agents.claudeDesktop")} text={JSON.stringify({ mcpServers: { mimikit: { command: exe, args: ["mcp"] } } }, null, 2)} />
          <p className="pb-2 text-xs text-muted">{t("agents.other")}</p>
          <span className="pt-2 text-fg">{t("agents.connected")}</span>
          {a.sessions.length ? (
            a.sessions.map((x) => (
              <Row
                key={x.pid}
                label={`${agentName(x.name)} ${x.version}`}
                hint={x.paused ? t("agents.paused") : t("agents.calls", { count: x.calls, ago: ago(x.last, now) })}
              >
                <div className="flex flex-none gap-2">
                  <Button size="sm" onClick={() => a.pause(x.pid, !x.paused)}>
                    {x.paused ? t("agents.resume") : t("agents.pause")}
                  </Button>
                  <Button size="sm" onClick={() => a.disconnect(x.pid)}>
                    {t("agents.disconnect")}
                  </Button>
                </div>
              </Row>
            ))
          ) : (
            <p className="py-2 text-xs text-muted">{t("agents.none")}</p>
          )}
          {a.allowed.map((name) => (
            <div key={name}>
              <Row label={`${t("agents.allowed")}: ${agentName(name)}`} hint={t("agents.allowedHint")}>
                <Button size="sm" onClick={() => a.forget(name)}>
                  {t("agents.forget")}
                </Button>
              </Row>
              <Row label={t("agents.allowChanges", { name: agentName(name) })} hint={t("agents.allowChangesHint")}>
                <Switch label={t("agents.allowChanges", { name: agentName(name) })} on={a.writers.includes(name)} onChange={(on) => a.setWriter(name, on)} />
              </Row>
            </div>
          ))}
        </>
      )}
      <AgentActivity />
    </>
  );
}
