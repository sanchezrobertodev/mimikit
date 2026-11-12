import clsx from "clsx";
import { AudioLines, Box, Clapperboard, FileIcon, FileText, Heart, ImageIcon, Star, Type, X, type LucideIcon } from "lucide-react";
import { cloneElement, useEffect, useId, useRef, type ButtonHTMLAttributes, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { kindLabel } from "../lib/fmt";
import { t, tNodes, type TagNode, type TKey, type Vars } from "../lib/i18n";
import { useStore } from "../store";
import type { Asset, Kind } from "../types";

type Variant = "accent" | "invert" | "outline" | "ghost" | "danger";

export function Button({
  variant = "outline",
  size = "md",
  className,
  children,
  ...rest
}: ComponentProps<"button"> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      type="button"
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-[9px] whitespace-nowrap transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" && "h-8 px-2.5",
        size === "md" && "h-[34px] px-3.5",
        size === "lg" && "h-[38px] px-4",
        variant === "accent" && "bg-accent font-semibold text-accent-fg hover:enabled:brightness-105",
        variant === "invert" && "bg-invert-bg font-semibold text-invert-fg hover:enabled:opacity-90",
        variant === "outline" && "border border-line-strong text-fg hover:enabled:bg-active",
        variant === "ghost" && "text-muted hover:enabled:text-fg",
        variant === "danger" && "border border-danger/50 text-danger hover:enabled:bg-danger/10",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  bordered,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; bordered?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-active hover:text-fg disabled:opacity-40",
        bordered && "border border-line-strong text-fg",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export const KIND_ICONS: Record<Kind, LucideIcon> = {
  image: ImageIcon,
  audio: AudioLines,
  model: Box,
  font: Type,
  video: Clapperboard,
  text: FileText,
  other: FileIcon,
};

/** A type's name, icon or both, as Settings → Appearance → Type labels says. Icon only keeps the name for screen readers. */
export function KindName({ kind, icon }: { kind: Kind; icon: string }) {
  const show = useStore((s) => s.kindLabels);
  const Icon = KIND_ICONS[kind];
  return (
    <>
      {show !== "name" && <Icon aria-hidden className={clsx("flex-none", icon)} />}
      {show === "icon" ? <span className="sr-only">{kindLabel[kind]}</span> : kindLabel[kind]}
    </>
  );
}

/** The design's colored type label ("Images", "Audio"…). */
export function KindPill({ kind, className }: { kind: Kind; className?: string }) {
  const iconOnly = useStore((s) => s.kindLabels === "icon");
  return (
    <span
      data-kind={kind}
      title={iconOnly ? kindLabel[kind] : undefined}
      className={clsx("k-pill inline-flex items-center gap-1 rounded-md px-2 py-[3px] text-[11.5px] font-medium whitespace-nowrap", className)}
    >
      <KindName kind={kind} icon="size-3" />
    </span>
  );
}

/**
 * The rating (★ 4) and the favorite heart in a thumbnail's corner, on card-coloured chips so they read over any
 * image. Screen readers get them as text, for tiles that have no label of their own (one with a label skips it).
 */
export function ThumbBadges({ asset, small, className }: { asset: Pick<Asset, "favorite" | "rating">; small?: boolean; className?: string }) {
  if (!asset.favorite && !asset.rating) return null;
  const chip = clsx("flex items-center rounded-md bg-card leading-none", small ? "h-4 px-1" : "h-5 px-1.5");
  const icon = clsx("fill-current", small ? "size-2.5" : "size-3");
  const said = [asset.favorite ? t("assetBrowser.favorite") : null, asset.rating ? t("assetBrowser.stars", { count: asset.rating }) : null];
  return (
    <span className={clsx("pointer-events-none absolute flex gap-1", className)}>
      <span className="sr-only">{said.filter(Boolean).join(", ")}</span>
      {asset.rating > 0 && (
        <span aria-hidden className={clsx(chip, "gap-0.5 font-mono font-medium text-fg", small ? "text-[10px]" : "text-[11px]")}>
          <Star className={clsx(icon, "text-star")} />
          {asset.rating}
        </span>
      )}
      {asset.favorite && (
        <span aria-hidden className={chip}>
          <Heart className={clsx(icon, "text-fav")} />
        </span>
      )}
    </span>
  );
}

export function KindDot({ kind, className }: { kind: Kind; className?: string }) {
  return <span aria-hidden data-kind={kind} className={clsx("k-dot inline-block shrink-0 rounded-full", className ?? "size-[7px]")} />;
}

/**
 * A translated sentence with markup inside: `<0>Space</0>` in the string wraps "Space" in tags[0], and `<0/>` puts
 * tags[0] in as it is. Values in `vars` stay text.
 */
export function T({ k, vars, tags = [] }: { k: TKey; vars?: Vars; tags?: ReactElement[] }) {
  const render = (nodes: TagNode[]): ReactNode[] =>
    nodes.map((n, i) =>
      typeof n === "string" ? n : tags[n.tag] ? cloneElement(tags[n.tag], { key: i }, ...(n.children ? render(n.children) : [])) : null,
    );
  return <>{render(tNodes(k, vars))}</>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-x px-1.5 font-mono text-[11px] text-fg-2">{children}</kbd>;
}

/** Marks a feature that works but is still being worked on. */
export function Beta() {
  return (
    <span title={t("aiView.betaHint")} className="flex-none rounded-full border border-line px-1.5 text-[10px] leading-4 font-medium tracking-[.06em] text-muted uppercase">
      {t("aiView.beta")}
    </span>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx("text-[11px] font-medium tracking-[.06em] text-faint uppercase", className)}>{children}</span>;
}

/** Two-or-more option toggle in a bordered pill, like the design's Grid / List switch. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex h-[30px] shrink-0 overflow-hidden rounded-lg border border-line-strong">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx("px-2.5 whitespace-nowrap -outline-offset-2", value === o.value ? "bg-active text-fg" : "text-muted hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Puts keyboard focus on the asset list (or the page, in views without one), e.g. after the focused control goes away. */
export function focusAssets() {
  (document.querySelector<HTMLElement>("[data-assets]") ?? document.querySelector<HTMLElement>("main"))?.focus();
}

/** Keeps Tab and Shift+Tab inside a modal `box`, wrapping at either end. */
export function trapTab(e: { key: string; shiftKey: boolean; preventDefault: () => void }, box: HTMLElement | null) {
  if (e.key !== "Tab" || !box) return;
  const items = [...box.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, summary, [tabindex]")].filter(
    (el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0,
  );
  const at = document.activeElement;
  // Focus on the dialog itself (full screen) counts as outside its controls.
  const inside = at !== box && box.contains(at);
  const [first, last] = [items[0], items[items.length - 1]];
  if (!first) e.preventDefault();
  else if (e.shiftKey && (at === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

let openModals = 0;
/** Whether a Modal is open. The app's shortcuts are off meanwhile, also for Modals the store doesn't know about. */
export const modalOpen = () => openModals > 0;

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  pages,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** A fixed-size body that lays out and scrolls its own parts, like Settings' page list and page. */
  pages?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Callers pass inline closures; reading the latest through a ref keeps focus from being reset on every render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // The marked default action wins over the first button in the page (the close ×).
    (panel.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panel.current?.querySelector<HTMLElement>("button"))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      }
      trapTab(e, panel.current);
    };
    window.addEventListener("keydown", onKey, true);
    openModals++;
    return () => {
      openModals--;
      window.removeEventListener("keydown", onKey, true);
      prev?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-scrim p-4 pt-[14vh]" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        className={clsx(
          "flex max-h-[calc(86vh-2rem)] w-full flex-col overflow-hidden rounded-2xl border border-line-x bg-field shadow-[0_40px_100px_-20px_rgba(0,0,0,.7)]",
          pages ? "h-[min(720px,calc(86vh-2rem))] max-w-[880px]" : wide ? "max-w-[640px]" : "max-w-md",
        )}
      >
        <div className="flex flex-none items-center justify-between gap-3 px-5 pt-4">
          <h2 id={titleId} className="text-[15px] font-semibold">
            {title}
          </h2>
          <IconButton label={t("ui.close")} onClick={onClose} className="-mr-2">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className={pages ? "flex min-h-0 flex-1 pt-3" : "min-h-0 overflow-y-auto px-5 py-3 text-fg-2"}>{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 pt-1 pb-4">{footer}</div>}
      </div>
    </div>
  );
}
