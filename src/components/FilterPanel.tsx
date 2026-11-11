import clsx from "clsx";
import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NAMED_COLORS, colorName } from "../lib/colors";
import { activeFilterCount, noFilters, type Filters } from "../lib/filter";
import { t } from "../lib/i18n";
import { useStore } from "../store";
import { AnalysisNote } from "./Analysis";
import { IconButton } from "./ui";

const MB = 1024 * 1024;

const dimPresets: { label: string; f: Partial<Filters> }[] = [
  { label: t("filterPanel.presets.tiny"), f: { minW: null, minH: null, maxW: 64, maxH: 64 } },
  { label: t("filterPanel.presets.small"), f: { minW: null, minH: null, maxW: 256, maxH: 256 } },
  { label: t("filterPanel.presets.textures"), f: { minW: 1024, minH: 1024, maxW: null, maxH: null } },
];

const datePresets: { label: string; days: number | null }[] = [
  { label: t("filterPanel.dates.any"), days: null },
  { label: t("filterPanel.dates.hours", { count: 24 }), days: 1 },
  { label: t("filterPanel.dates.days", { count: 7 }), days: 7 },
  { label: t("filterPanel.dates.days", { count: 30 }), days: 30 },
  { label: t("filterPanel.dates.years", { count: 1 }), days: 365 },
];

function Group({ title, onClear, active, children }: { title: string; onClear: () => void; active: boolean; children: ReactNode }) {
  const box = useRef<HTMLFieldSetElement>(null);
  return (
    <fieldset ref={box} className="border-t border-line px-4 py-3 first:border-t-0">
      <legend className="sr-only">{title}</legend>
      <div className="mb-2 flex h-5 items-center justify-between">
        <span aria-hidden className="text-[11px] font-semibold tracking-wider text-muted uppercase">
          {title}
        </span>
        {active && (
          <button
            type="button"
            data-clear
            aria-label={t("filterPanel.clearGroup", { group: title })}
            onClick={() => {
              // Clear goes away once the group is empty; move focus to the group's first control.
              box.current?.querySelector<HTMLElement>("button:not([data-clear]), input")?.focus();
              onClear();
            }}
            className="text-xs text-muted hover:text-fg"
          >
            {t("filterPanel.clear")}
          </button>
        )}
      </div>
      {children}
    </fieldset>
  );
}

function Chip({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      onClick={onClick}
      className={clsx(
        "h-7 rounded-[14px] border px-2.5 text-xs transition-colors duration-150",
        on ? "border-accent bg-accent/15 text-fg" : "border-line-strong text-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** Number input that maps empty to null. `scale` converts the shown unit to the stored one (MB to bytes). */
function NumField({ label, value, onChange, scale = 1 }: { label: string; value: number | null; onChange: (v: number | null) => void; scale?: number }) {
  return (
    <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
      {label}
      <input
        type="number"
        min={0}
        step="any"
        value={value === null ? "" : +(value / scale).toFixed(3)}
        onChange={(e) => onChange(e.target.value === "" ? null : Math.max(0, Number(e.target.value)) * scale)}
        onKeyDown={(e) => e.stopPropagation()}
        placeholder={t("filterPanel.any")}
        className="h-8 w-full rounded-md border border-line-strong bg-bg px-2 text-[13px] text-fg placeholder:text-muted"
      />
    </label>
  );
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export function FilterButton() {
  const { assets, filters: f, setFilters, ai } = useStore();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const count = activeFilterCount(f);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[role=dialog] button")?.focus();
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Close only the panel (not the side panel too), and put focus back on its button.
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const { exts, tags } = useMemo(() => {
    const e = new Map<string, number>();
    const tagSet = new Set<string>();
    for (const a of assets) {
      if (a.ext) e.set(a.ext, (e.get(a.ext) ?? 0) + 1);
      for (const g of a.tags) tagSet.add(g);
    }
    return { exts: [...e.entries()].sort((a, b) => b[1] - a[1]), tags: [...tagSet].sort() };
  }, [assets]);

  const dimsActive = f.minW !== null || f.maxW !== null || f.minH !== null || f.maxH !== null || f.square;
  const isPreset = (p: Partial<Filters>) => Object.entries(p).every(([k, v]) => f[k as keyof Filters] === v);

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "flex h-[30px] flex-none items-center gap-[7px] rounded-[15px] border px-3 text-[12.5px] font-medium whitespace-nowrap",
          count ? "border-accent bg-accent text-accent-fg" : "border-dashed border-line-x text-fg-2 hover:text-fg",
        )}
      >
        <SlidersHorizontal aria-hidden className="size-3.5" />
        {t("filterPanel.button", { count })}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("filterPanel.title")}
          className="absolute top-10 left-0 z-30 flex max-h-[70vh] w-96 flex-col rounded-2xl border border-line-strong bg-field shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <h2 className="text-sm font-semibold">{t("filterPanel.title")}</h2>
            <div className="flex items-center gap-1">
              {count > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    // The button goes away with the filters; focus the close button next to it.
                    (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                    setFilters(noFilters);
                  }}
                  className="px-1 text-xs text-muted hover:text-fg"
                >
                  {t("filterPanel.clearAll")}
                </button>
              )}
              <IconButton
                label={t("filterPanel.close")}
                className="size-7"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <X className="size-4" />
              </IconButton>
            </div>
          </div>
          <div className="overflow-y-auto">
            <Group title={t("filterPanel.groups.extension")} active={f.exts.length > 0} onClear={() => setFilters({ exts: [] })}>
              <div className="flex flex-wrap gap-1.5">
                {exts.map(([e, n]) => (
                  <Chip key={e} on={f.exts.includes(e)} onClick={() => setFilters({ exts: toggle(f.exts, e) })} label={t("filterPanel.extFiles", { ext: e, count: n })}>
                    <span className="font-mono">.{e}</span> <span className="text-muted">{n}</span>
                  </Chip>
                ))}
              </div>
            </Group>

            <Group
              title={t("filterPanel.groups.imageSize")}
              active={dimsActive}
              onClear={() => setFilters({ minW: null, maxW: null, minH: null, maxH: null, square: false })}
            >
              <div className="mb-2 flex flex-wrap gap-1.5">
                {dimPresets.map((p) => (
                  <Chip key={p.label} on={isPreset(p.f)} onClick={() => setFilters(p.f)}>
                    {p.label}
                  </Chip>
                ))}
                <Chip on={f.square} onClick={() => setFilters({ square: !f.square })}>
                  {t("filterPanel.squareOnly")}
                </Chip>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumField label={t("filterPanel.minWidth")} value={f.minW} onChange={(v) => setFilters({ minW: v })} />
                <NumField label={t("filterPanel.maxWidth")} value={f.maxW} onChange={(v) => setFilters({ maxW: v })} />
                <NumField label={t("filterPanel.minHeight")} value={f.minH} onChange={(v) => setFilters({ minH: v })} />
                <NumField label={t("filterPanel.maxHeight")} value={f.maxH} onChange={(v) => setFilters({ maxH: v })} />
              </div>
              <p className="mt-1.5 text-[11px] text-muted">{t("filterPanel.dimsNote")}</p>
            </Group>

            <Group title={t("filterPanel.groups.audioLength")} active={f.minMs !== null || f.maxMs !== null} onClear={() => setFilters({ minMs: null, maxMs: null })}>
              <div className="flex gap-2">
                <NumField label={t("filterPanel.minSeconds")} value={f.minMs} scale={1000} onChange={(v) => setFilters({ minMs: v })} />
                <NumField label={t("filterPanel.maxSeconds")} value={f.maxMs} scale={1000} onChange={(v) => setFilters({ maxMs: v })} />
              </div>
              <p className="mt-1.5 text-[11px] text-muted">{t("filterPanel.lengthNote")}</p>
            </Group>

            <Group
              title={t("filterPanel.groups.sizeDate")}
              active={f.minBytes !== null || f.maxBytes !== null || f.days !== null}
              onClear={() => setFilters({ minBytes: null, maxBytes: null, days: null })}
            >
              <div className="flex gap-2">
                <NumField label={t("filterPanel.minSize")} value={f.minBytes} scale={MB} onChange={(v) => setFilters({ minBytes: v })} />
                <NumField label={t("filterPanel.maxSize")} value={f.maxBytes} scale={MB} onChange={(v) => setFilters({ maxBytes: v })} />
              </div>
              <div className="mt-3 mb-1.5 text-xs text-muted">{t("filterPanel.modifiedIn")}</div>
              <div className="flex flex-wrap gap-1.5">
                {datePresets.map((p) => (
                  <Chip key={p.label} on={f.days === p.days} onClick={() => setFilters({ days: p.days })}>
                    {p.label}
                  </Chip>
                ))}
              </div>
            </Group>

            <Group
              title={t("filterPanel.groups.tags")}
              active={f.untagged || f.suggested || f.anyTags.length > 0}
              onClear={() => setFilters({ untagged: false, suggested: false, anyTags: [] })}
            >
              <div className="flex flex-wrap gap-1.5">
                <Chip on={f.untagged} onClick={() => setFilters({ untagged: !f.untagged, anyTags: [] })}>
                  {t("filterPanel.untaggedOnly")}
                </Chip>
                {ai.on && (
                  <Chip on={f.suggested} onClick={() => setFilters({ suggested: !f.suggested })}>
                    {t("tagging.filterChip")}
                  </Chip>
                )}
                {tags.map((tag) => (
                  <Chip key={tag} on={f.anyTags.includes(tag)} onClick={() => setFilters({ anyTags: toggle(f.anyTags, tag), untagged: false })}>
                    #{tag}
                  </Chip>
                ))}
              </div>
              {tags.length > 0 && <p className="mt-1.5 text-[11px] text-muted">{t("filterPanel.tagsNote")}</p>}
            </Group>

            <Group title={t("filterPanel.groups.rating")} active={f.minRating !== null} onClear={() => setFilters({ minRating: null })}>
              <div className="flex flex-wrap gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Chip
                    key={n}
                    on={f.minRating === n}
                    onClick={() => setFilters({ minRating: f.minRating === n ? null : n })}
                    label={t(n === 5 ? "filterPanel.stars" : "filterPanel.starsAtLeast", { count: n })}
                  >
                    <span className="text-star">★</span> {n === 5 ? "5" : `${n}+`}
                  </Chip>
                ))}
              </div>
            </Group>

            <Group title={t("filterPanel.groups.colour")} active={f.color !== null} onClear={() => setFilters({ color: null })}>
              <div className="flex flex-wrap items-center gap-1.5">
                {Object.entries(NAMED_COLORS).map(([name, hex]) => (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={f.color === name}
                    aria-label={colorName(name)}
                    title={colorName(name)}
                    onClick={() => setFilters({ color: f.color === name ? null : name })}
                    style={{ background: hex }}
                    className={clsx(
                      "size-7 rounded-full border border-line-strong",
                      f.color === name && "ring-2 ring-accent ring-offset-2 ring-offset-field",
                    )}
                  />
                ))}
                <label
                  title={t("filterPanel.customColour")}
                  className={clsx(
                    "focus-ring-within relative flex h-7 items-center gap-1.5 rounded-[14px] border px-2.5 text-xs",
                    f.color?.startsWith("#") ? "border-accent bg-accent/15 text-fg" : "border-line-strong text-muted hover:text-fg",
                  )}
                >
                  <span aria-hidden className="size-3.5 rounded-full border border-line-strong" style={{ background: f.color?.startsWith("#") ? f.color : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }} />
                  {f.color?.startsWith("#") ? <span className="font-mono">{f.color}</span> : t("filterPanel.custom")}
                  <input
                    type="color"
                    aria-label={t("filterPanel.customColour")}
                    value={f.color?.startsWith("#") ? f.color : "#ff8800"}
                    onChange={(e) => setFilters({ color: e.target.value })}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </label>
              </div>
              <p className="mt-1.5 text-[11px] text-muted">
                {t("filterPanel.colourNote", { nameExample: "color:red", hexExample: "color:#ff8800" })}
              </p>
              <AnalysisNote className="mt-1.5 text-[11px]" />
            </Group>
          </div>
        </div>
      )}
    </div>
  );
}
