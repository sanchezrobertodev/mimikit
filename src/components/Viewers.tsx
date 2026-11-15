import clsx from "clsx";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Download, Grid3x3, LoaderCircle, Pause, Play, Repeat, StepBack, StepForward } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import { api, assetUrl, errorText, fileUrl } from "../api";
import { holdFont } from "../lib/fonts";
import { bytes } from "../lib/fmt";
import { t } from "../lib/i18n";
import { reducedMotion } from "../lib/prefs";
import { frameSize, gridFor, guessGrid } from "../lib/sprites";
import { useStore } from "../store";
import type { Asset, SpriteSheet } from "../types";
import { isTiny } from "./Thumb";

/** Formats the webview shows natively; the rest get a PNG preview from the backend. */
const NATIVE_IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);
const ASEPRITE = new Set(["ase", "aseprite"]);

export function Note({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-muted">
      {busy && <LoaderCircle aria-hidden className="size-5 animate-spin" />}
      {children}
    </div>
  );
}

/** A viewer's own load failure (decode, codec, unreadable file). PreviewBoundary shows its message. */
export class PreviewFailure extends Error {}

/**
 * Shows the preview fallback from async code (a load that rejects, an element's error event). Error boundaries only
 * catch errors thrown while rendering, so this throws from a state update, on the next render.
 */
export function usePreviewFailure() {
  const [, set] = useState();
  return useCallback(
    (message: string) =>
      set(() => {
        throw new PreviewFailure(message);
      }),
    [],
  );
}

const chipBox = "rounded-md px-2 py-1 font-mono text-[11px] whitespace-nowrap";
export const chip = `${chipBox} bg-active text-fg-2`;
/** A chip that toggles something: inverted while on, like the app's other active chips, so it's not told by colour alone. */
export const toggleChip = (on: boolean) => clsx(chipBox, "font-sans", on ? "bg-invert-bg text-invert-fg" : "bg-active text-fg-2");

type ViewerKeys = (e: globalThis.KeyboardEvent, letter: string) => boolean;
let viewerKeys: ViewerKeys | null = null;
/** Offers a key to the open viewer (zoom, seek); true if it took it. App's key handler asks after its own checks. */
export const viewerKey = (e: globalThis.KeyboardEvent, letter: string) => !!viewerKeys?.(e, letter);
/** The open viewer's own keys. Only one viewer shows at a time: the side panel's goes away under full screen. */
export function useViewerKeys(on: ViewerKeys, enabled = true) {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => {
    if (!enabled) return;
    const keys: ViewerKeys = (e, letter) => latest.current(e, letter);
    viewerKeys = keys;
    return () => {
      if (viewerKeys === keys) viewerKeys = null;
    };
  }, [enabled]);
}

function ImageView({ asset, pixelated, full }: { asset: Asset; pixelated: boolean; full: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const fail = usePreviewFailure();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fit, setFit] = useState<number | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const sheet = useStore((s) => s.sheets[asset.id]);
  const loadSheet = useStore((s) => s.loadSheet);
  const saveSheet = useStore((s) => s.saveSheet);
  // null follows the saved slicing: an asset animated before opens animated.
  const [animate, setAnimate] = useState<boolean | null>(null);
  const animating = animate ?? !!sheet;
  // The toggle moves between the still and the sprite controls; keep keyboard focus on it when it does.
  const refocus = useRef(false);
  // An Aseprite file's own frames, which Animate plays instead of a grid: undefined while they load, null for other
  // images and single frames.
  const ase = ASEPRITE.has(asset.ext);
  const [frames, setFrames] = useState<{ src: string; durations: number[]; sheet: SpriteSheet } | null | undefined>(ase ? undefined : null);

  useEffect(() => {
    if (!ase) return;
    let live = true;
    api.asepriteFrames(asset.id).then(
      (f) => live && setFrames(f.strip ? { src: convertFileSrc(f.strip), durations: f.durations, sheet: { cols: f.durations.length, rows: 1, fps: DEFAULT_FPS } } : null),
      () => live && setFrames(null),
    );
    return () => {
      live = false;
    };
  }, [ase, asset.id, asset.mtime]);

  useEffect(() => {
    if (useStore.getState().sheets[asset.id] === undefined) void loadSheet(asset.id);
  }, [asset.id, loadSheet]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setFit(null);
    if (NATIVE_IMAGE.has(asset.ext)) {
      setSrc(assetUrl(asset));
      return;
    }
    setSrc(null);
    let live = true;
    api
      .preview(asset.id)
      .then((p) => live && setSrc(convertFileSrc(p)))
      .catch((e) => live && fail(errorText(e)));
    return () => {
      live = false;
    };
  }, [asset.id, asset.ext, asset.path, asset.mtime, fail]);

  const measure = () => {
    const el = img.current;
    if (el?.naturalWidth) setFit(el.clientWidth / el.naturalWidth);
  };
  const zoomBy = (f: number) => setZoom((z) => Math.min(32, Math.max(0.1, z * f)));
  const fitBack = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const onWheel = (e: WheelEvent) => zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  // + and − zoom, Ctrl+0 fits it back (plain 0 clears the rating).
  useViewerKeys((e) => {
    if (e.altKey) return false;
    if (e.key === "+" || e.key === "=") zoomBy(1.25);
    else if (e.key === "-") zoomBy(1 / 1.25);
    else if ((e.ctrlKey || e.metaKey) && (e.code === "Digit0" || e.code === "Numpad0")) fitBack();
    else return false;
    return true;
  }, full && !animating);
  const onDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => drag.current && setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y });

  if (!src) return <Note busy>{t("viewers.image.decoding")}</Note>;
  const toggle = (
    <button
      type="button"
      ref={(el) => {
        if (!el || !refocus.current) return;
        refocus.current = false;
        el.focus();
      }}
      aria-pressed={animating}
      disabled={sheet === undefined || frames === undefined}
      onClick={() => {
        refocus.current = true;
        setAnimate(!animating);
      }}
      title={t(frames ? "viewers.image.animateFramesTitle" : "viewers.image.animateTitle")}
      className={clsx(toggleChip(animating), "disabled:opacity-50")}
    >
      {t("viewers.image.animate")}
    </button>
  );
  if (animating && frames)
    return (
      <SpriteView asset={asset} src={frames.src} sheet={frames.sheet} durations={frames.durations} onSheet={() => {}} pixelated={pixelated} full={full} toggle={toggle} />
    );
  if (animating && sheet !== undefined)
    return (
      <SpriteView asset={asset} src={src} sheet={sheet} onSheet={(v) => void saveSheet(asset.id, v)} pixelated={pixelated} full={full} toggle={toggle} />
    );
  const dims = asset.width && asset.height ? `${asset.width}×${asset.height}` : "";
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <div
        className={clsx("relative min-h-0 w-full flex-1 overflow-hidden", full && "cursor-grab active:cursor-grabbing")}
        onWheel={full ? onWheel : undefined}
        onPointerDown={full ? onDown : undefined}
        onPointerMove={full ? onMove : undefined}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={
          full
            ? (e) => {
                e.stopPropagation();
                fitBack();
              }
            : undefined
        }
      >
        <img
          ref={img}
          src={src}
          alt={asset.name}
          draggable={false}
          onLoad={measure}
          onError={() => fail(t("viewers.image.cantDisplay"))}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          className={clsx(
            "absolute inset-0 m-auto max-h-full max-w-full object-contain shadow-[0_8px_30px_rgba(0,0,0,.45)]",
            isTiny(asset) && "h-full w-full",
            (pixelated || isTiny(asset)) && "pixelated",
          )}
        />
      </div>
      <div className="flex items-center gap-1.5" onDoubleClick={(e) => e.stopPropagation()}>
        <span className={chip}>
          {[dims, fit !== null ? t(full ? "viewers.image.zoomShown" : "viewers.image.zoom", { percent: Math.round(fit * zoom * 100) }) : ""]
            .filter(Boolean)
            .join(" · ")}
          {full && ` · ${t("viewers.image.zoomHint")}`}
        </span>
        {toggle}
      </div>
    </div>
  );
}

const DEFAULT_FPS = 12;
const MAX_CELLS = 1024;

/** A number field that only reports values in range, so typing "1" on the way to "12" doesn't fight the user. */
function NumField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      type="number"
      aria-label={label}
      title={label}
      min={min}
      max={max}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (Number.isInteger(n) && n >= min && n <= max) onChange(n);
      }}
      onBlur={() => setDraft(String(value))}
      className="h-[26px] w-[52px] rounded-md border border-line-strong bg-bg px-1.5 font-mono text-[11px] text-fg"
    />
  );
}

/** Saves each frame of the sheet as a PNG in a folder the user picks, cut from the original file. */
function ExportFrames({ asset, sheet }: { asset: Asset; sheet: SpriteSheet }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [skipEmpty, setSkipEmpty] = useState(false);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !menu.current?.open) return;
    // Close just this menu, not the full screen view behind it.
    e.stopPropagation();
    menu.current.open = false;
    menu.current.querySelector("summary")?.focus();
  };
  const run = async () => {
    if (menu.current) menu.current.open = false;
    // The menu (and the focused button in it) closes; keep focus on its summary.
    menu.current?.querySelector("summary")?.focus();
    const { showToast, setError } = useStore.getState();
    const dest = await api.pickFolder(t("viewers.export.pickFolder", { name: asset.name }));
    if (!dest) return;
    try {
      const r = await api.exportFrames(asset.id, sheet.cols, sheet.rows, skipEmpty, dest);
      if (r.failed.length) setError(t("viewers.export.failed", { count: r.written, failed: r.failed.length, errors: r.failed.slice(0, 3).join("; ") }));
      else if (!r.first) showToast(t("viewers.export.allEmpty"));
      else showToast(t("viewers.export.done", { count: r.written, folder: dest }), () => api.revealPath(r.first!).catch(setError), t("viewers.export.showInFolder"));
    } catch (e) {
      setError(e);
    }
  };
  return (
    <details ref={menu} onKeyDown={onKeyDown} className="relative">
      <summary className={clsx(toggleChip(false), "flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden")}>
        <Download aria-hidden className="size-3" /> {t("viewers.export.button")}
      </summary>
      <div className="absolute right-0 bottom-full z-30 mb-1.5 flex w-56 flex-col gap-2.5 rounded-xl border border-line-strong bg-field p-3 text-xs text-fg shadow-2xl">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={skipEmpty} onChange={(e) => setSkipEmpty(e.target.checked)} />
          {t("viewers.export.skipEmpty")}
        </label>
        <button type="button" onClick={() => void run()} className="h-7 rounded-md bg-accent px-2.5 font-semibold text-accent-fg">
          {t("viewers.export.chooseFolder")}
        </button>
      </div>
    </details>
  );
}

/**
 * Plays an image as a grid of frames drawn on a canvas. The slicing is saved per asset through `onSheet`. With
 * `durations` it's a file's own frames in one row, each shown that many ms, and there's no slicing to set.
 */
function SpriteView({
  asset,
  src,
  sheet,
  durations,
  onSheet,
  pixelated,
  full,
  toggle,
}: {
  asset: Asset;
  src: string;
  sheet: SpriteSheet | null;
  durations?: number[];
  onSheet: (s: SpriteSheet) => void;
  pixelated: boolean;
  full: boolean;
  toggle: ReactNode;
}) {
  const setPixelated = useStore((s) => s.setPixelated);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const fail = usePreviewFailure();
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const [loop, setLoop] = useState(true);

  useEffect(() => {
    setImg(null);
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => fail(t("viewers.image.cantDisplay"));
    i.src = src;
    return () => {
      i.onload = i.onerror = null;
    };
  }, [src, fail]);

  const w = img?.naturalWidth ?? 0;
  const h = img?.naturalHeight ?? 0;
  const update = (patch: Partial<SpriteSheet>) => {
    const next = { cols: 1, rows: 1, fps: DEFAULT_FPS, ...sheet, ...patch };
    const clamp = (n: number) => Math.min(MAX_CELLS, Math.max(1, n));
    onSheet({ ...next, cols: clamp(next.cols), rows: clamp(next.rows) });
  };

  // Entering Animate on an image without a saved slicing saves the guess, so it opens animated next time.
  const guessed = useRef(false);
  useEffect(() => {
    if (!img || sheet !== null || guessed.current) return;
    guessed.current = true;
    onSheet({ ...guessGrid(img.naturalWidth, img.naturalHeight), fps: DEFAULT_FPS });
  }, [img, sheet, onSheet]);

  const count = sheet ? sheet.cols * sheet.rows : 1;
  const at = frame % count;
  const fps = sheet?.fps ?? DEFAULT_FPS;
  const size = sheet ? frameSize(w, h, sheet) : { w: 1, h: 1 };

  useEffect(() => {
    if (!playing || count < 2) return;
    const timer = setTimeout(() => setFrame((f) => (loop ? (f % count) + 1 : Math.min((f % count) + 1, count - 1))), durations?.[at] ?? 1000 / fps);
    return () => clearTimeout(timer);
  }, [playing, loop, count, fps, at, durations]);
  useEffect(() => {
    if (!loop && at === count - 1) setPlaying(false);
  }, [loop, at, count]);

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !img || !sheet) return;
    if (c.width !== size.w || c.height !== size.h) [c.width, c.height] = [size.w, size.h];
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.drawImage(img, (at % sheet.cols) * size.w, Math.floor(at / sheet.cols) * size.h, size.w, size.h, 0, 0, size.w, size.h);
  }, [img, sheet, at, size.w, size.h]);

  if (!img || !sheet) return <Note busy>{t("viewers.sprite.slicing")}</Note>;
  const stepBy = (d: number) => {
    setPlaying(false);
    setFrame((f) => ((f % count) + d + count) % count);
  };
  const play = () => {
    if (!playing && !loop && at === count - 1) setFrame(0);
    setPlaying(!playing);
  };
  const square = "flex size-[26px] items-center justify-center rounded-md bg-active text-fg-2 hover:text-fg";
  const pill = (on: boolean) => clsx(toggleChip(on), "flex items-center gap-1");
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <div className="relative min-h-0 w-full flex-1">
        <canvas
          ref={canvas}
          role="img"
          aria-label={t("viewers.sprite.frameLabel", { name: asset.name, frame: at + 1, total: count })}
          className={clsx("absolute inset-0 h-full w-full object-contain", pixelated && "pixelated")}
        />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5 text-[11px] text-muted" onDoubleClick={(e) => e.stopPropagation()}>
        {toggle}
        <button type="button" aria-label={t("viewers.sprite.previousFrame")} title={t("viewers.sprite.previousFrame")} onClick={() => stepBy(-1)} className={square}>
          <StepBack aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={playing ? t("viewers.sprite.pause") : t("viewers.sprite.play")}
          title={playing ? t("viewers.sprite.pause") : t("viewers.sprite.play")}
          onClick={play}
          className="flex size-[26px] items-center justify-center rounded-full bg-accent text-accent-fg"
        >
          {playing ? <Pause aria-hidden className="size-3 fill-current" /> : <Play aria-hidden className="size-3 fill-current" />}
        </button>
        <button type="button" aria-label={t("viewers.sprite.nextFrame")} title={t("viewers.sprite.nextFrame")} onClick={() => stepBy(1)} className={square}>
          <StepForward aria-hidden className="size-3.5" />
        </button>
        <span className={clsx(chip, "tabular-nums")}>
          {at + 1} / {count}
        </span>
        {!durations && (
          <>
            <NumField label={t("viewers.sprite.columns")} value={sheet.cols} min={1} max={MAX_CELLS} onChange={(cols) => update({ cols })} />
            <span aria-hidden>×</span>
            <NumField label={t("viewers.sprite.rows")} value={sheet.rows} min={1} max={MAX_CELLS} onChange={(rows) => update({ rows })} />
          </>
        )}
        {full && !durations && (
          <>
            <span className="ml-2">{t("viewers.sprite.frame")}</span>
            <NumField label={t("viewers.sprite.frameWidth")} value={size.w} min={1} max={w} onChange={(fw) => update(gridFor(w, h, fw, size.h))} />
            <span aria-hidden>×</span>
            <NumField label={t("viewers.sprite.frameHeight")} value={size.h} min={1} max={h} onChange={(fh) => update(gridFor(w, h, size.w, fh))} />
            <span className="ml-2">{t("viewers.sprite.fps")}</span>
            <NumField label={t("viewers.sprite.framesPerSecond")} value={fps} min={1} max={60} onChange={(v) => update({ fps: v })} />
          </>
        )}
        {full && (
          <>
            <button type="button" aria-pressed={loop} onClick={() => setLoop(!loop)} className={clsx(pill(loop), "ml-2")}>
              <Repeat aria-hidden className="size-3" /> {t("viewers.sprite.loop")}
            </button>
            <button type="button" aria-pressed={pixelated} title={t("viewers.sprite.pixelTitle")} onClick={() => setPixelated(!pixelated)} className={pill(pixelated)}>
              <Grid3x3 aria-hidden className="size-3" /> {t("viewers.sprite.pixel")}
            </button>
            {!durations && <ExportFrames asset={asset} sheet={sheet} />}
          </>
        )}
      </div>
    </div>
  );
}

const PANGRAM = t("viewers.font.pangram");

function FontView({ asset, full }: { asset: Asset; full: boolean }) {
  const [family, setFamily] = useState<string | undefined>(undefined);
  const [sample, setSample] = useState(PANGRAM);
  const fail = usePreviewFailure();
  useEffect(() => {
    setFamily(undefined);
    return holdFont(asset, fileUrl(asset.path), (f) => (f ? setFamily(f) : fail(t("viewers.font.loadFailed"))));
  }, [asset, fail]);
  if (family === undefined) return <Note busy>{t("viewers.font.loading")}</Note>;
  return (
    <div className={clsx("flex w-full flex-col", full ? "max-w-[820px] gap-4" : "gap-2")} style={{ fontFamily: family }}>
      <span className={clsx("leading-none", full ? "text-[140px]" : "text-[64px]")}>Aa</span>
      {full ? (
        <input
          aria-label={t("viewers.font.sample")}
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          className="border-0 bg-transparent p-0 text-[36px] text-fg"
          style={{ fontFamily: family }}
        />
      ) : (
        <span className="text-[19px] leading-snug">{PANGRAM}</span>
      )}
      <span className={clsx("text-fg-2", full ? "text-xl" : "text-[13px]")}>ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789</span>
    </div>
  );
}

function TextView({ asset, full }: { asset: Asset; full: boolean }) {
  const [text, setText] = useState<{ text: string; truncated: boolean } | null>(null);
  const fail = usePreviewFailure();
  useEffect(() => {
    setText(null);
    let live = true;
    api
      .readText(asset.id)
      .then((res) => {
        if (!live) return;
        if (asset.ext === "json" && !res.truncated) {
          try {
            res = { ...res, text: JSON.stringify(JSON.parse(res.text), null, 2) };
          } catch {
            /* not valid JSON: show as-is */
          }
        }
        setText(res);
      })
      .catch((e) => live && fail(errorText(e)));
    return () => {
      live = false;
    };
  }, [asset.id, asset.ext, asset.mtime, fail]);
  if (!text) return <Note busy>{t("viewers.text.reading")}</Note>;
  const lines = text.text.split("\n");
  const shown = full ? lines.slice(0, 5000) : lines.slice(0, 9);
  const pad = String(shown.length).length;
  return (
    <div
      className={clsx(
        "w-full overflow-auto rounded-xl border border-line bg-card font-mono select-text",
        full ? "max-h-full max-w-[760px] px-6 py-5 text-sm leading-[1.8]" : "px-3.5 py-3 text-xs leading-[1.7]",
      )}
    >
      {shown.map((line, i) => (
        <div key={i} className="flex gap-3.5 whitespace-pre">
          <span className="shrink-0 text-right text-faint" style={{ width: `${pad}ch` }}>
            {i + 1}
          </span>
          <span>{line}</span>
        </div>
      ))}
      {(text.truncated || shown.length < lines.length) && (
        <div className="pt-1 text-faint">
          {full ? t("viewers.text.truncated", { size: bytes(asset.size) }) : t("viewers.text.moreLines", { count: lines.length - shown.length })}
        </div>
      )}
    </div>
  );
}

/** A .blend has no 3D view here: the preview picture Blender saved in it, if it has one. */
function BlendView({ asset, full }: { asset: Asset; full: boolean }) {
  // undefined while it loads, null when the file has none.
  const [src, setSrc] = useState<string | null>();
  useEffect(() => {
    let live = true;
    api.preview(asset.id).then(
      (p) => live && setSrc(convertFileSrc(p)),
      () => live && setSrc(null),
    );
    return () => {
      live = false;
    };
  }, [asset.id, asset.mtime]);

  if (src === undefined) return <Note busy>{t("viewers.image.decoding")}</Note>;
  if (src === null)
    return (
      <Note>
        <span className={clsx("font-mono text-fg", full ? "text-[28px]" : "text-xl")}>.blend</span>
        {t("viewers.blendNoPreview")}
      </Note>
    );
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <img src={src} alt={asset.name} draggable={false} className="min-h-0 w-64 max-w-full flex-1 object-contain" />
      <span className={chip}>{t("viewers.blendPreview")}</span>
    </div>
  );
}

// three.js and wavesurfer are most of the bundle, so these load on first use.
const AudioView = lazy(() => import("./AudioView"));
const ModelView = lazy(() => import("./ModelView"));

/** The preview for one asset. `full` is the full-screen stage; otherwise the compact side-panel stage. */
export function Viewer({ asset, pixelated, full = false }: { asset: Asset; pixelated: boolean; full?: boolean }) {
  const fail = usePreviewFailure();
  switch (asset.kind) {
    case "image":
      // Keyed so per-asset state (zoom, Animate) never leaks into the next asset.
      return <ImageView key={asset.id} asset={asset} pixelated={pixelated} full={full} />;
    case "audio":
      return (
        <Suspense fallback={<Note busy>{t("viewers.loadingAudio")}</Note>}>
          <AudioView asset={asset} full={full} />
        </Suspense>
      );
    case "model":
      if (asset.ext === "blend") return <BlendView key={asset.id} asset={asset} full={full} />;
      return (
        <Suspense
          fallback={
            <div className={clsx("stripes w-full rounded-xl", full ? "h-full" : "h-[200px]")}>
              <Note busy>{t("viewers.loadingModel")}</Note>
            </div>
          }
        >
          <ModelView asset={asset} full={full} />
        </Suspense>
      );
    case "font":
      return <FontView asset={asset} full={full} />;
    case "video":
      return (
        <video
          key={asset.id}
          src={assetUrl(asset)}
          controls
          autoPlay={full && !reducedMotion()}
          onError={() => fail(t("viewers.videoUnsupported"))}
          className={clsx("w-full rounded-xl bg-black object-contain", full ? "h-full" : "max-h-[200px]")}
        >
          {t("viewers.videoUnsupported")}
        </video>
      );
    case "text":
      return <TextView asset={asset} full={full} />;
    default:
      return (
        <Note>
          <span className={clsx("font-mono text-fg", full ? "text-[28px]" : "text-xl")}>.{asset.ext}</span>
          {t("viewers.noPreview")}
        </Note>
      );
  }
}
