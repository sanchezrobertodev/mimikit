import clsx from "clsx";
import { LoaderCircle, Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { bytes } from "../lib/fmt";
import { t } from "../lib/i18n";
import { useStore } from "../store";
import { openSettings } from "./Settings";
import { focusAssets, IconButton } from "./ui";

const run = (p: Promise<unknown>) => void p.catch(useStore.getState().setError);

export const analyse = () => run(api.analyseImages());
export const pauseAnalysis = (paused: boolean) => run(api.pauseAnalysis(paused));
export const cancelAnalysis = () => run(api.cancelAnalysis());

export const pauseMeaning = (paused: boolean) => run(api.pauseMeaning(paused));
export const cancelMeaning = () => run(api.cancelMeaning());

/** The running analysis pass under the folder list, with Pause and Cancel. `compact`: a spinner, for the sidebar's rail. */
export function AnalysisProgress({ compact }: { compact?: boolean }) {
  const a = useStore((s) => s.analysis);
  return <PassProgress ns="analysis" status={a} onPause={pauseAnalysis} onCancel={cancelAnalysis} compact={compact} />;
}

/** Search by meaning's download, then its indexing pass, the same way. */
export function MeaningProgress({ compact }: { compact?: boolean }) {
  const m = useStore((s) => s.meaning);
  const d = m.download;
  return (
    <PassProgress
      ns="meaning"
      status={m}
      // A download can't pause; Cancel keeps what came, and the next one resumes from there.
      onPause={d ? undefined : pauseMeaning}
      onCancel={cancelMeaning}
      compact={compact}
      title={d ? t("meaning.downloadingTitle") : undefined}
      progress={d ? t("meaning.progress", { done: bytes(d.done), total: bytes(d.total) }) : undefined}
      fraction={d ? (d.total ? d.done / d.total : 0) : undefined}
    />
  );
}

/** Screen readers hear when a pass starts, pauses and ends, not every count. */
function PassProgress({
  ns,
  status: a,
  onPause,
  onCancel,
  compact,
  title,
  progress = t(`${ns}.progress`, { done: a.done, total: a.total }),
  fraction = a.total ? a.done / a.total : 0,
}: {
  ns: "analysis" | "meaning";
  status: { done: number; total: number; running: boolean; paused: boolean };
  onPause?: (paused: boolean) => void;
  onCancel: () => void;
  compact?: boolean;
  title?: string;
  progress?: string;
  fraction?: number;
}) {
  const was = useRef(a);
  const [said, setSaid] = useState("");
  useEffect(() => {
    const before = was.current;
    was.current = a;
    if (a.running && !before.running) setSaid(t(`${ns}.started`));
    else if (a.running && a.paused !== before.paused) setSaid(a.paused ? t(`${ns}.paused`) : t(`${ns}.resumed`));
    else if (!a.running && before.running)
      setSaid(a.done >= a.total ? t(`${ns}.finished`, { count: a.total }) : t(`${ns}.stopped`, { count: a.total, done: a.done }));
  }, [a, ns]);
  title ??= a.paused ? t(`${ns}.pausedTitle`) : t(`${ns}.runningTitle`);

  return (
    <>
      <p role="status" className="sr-only">
        {said}
      </p>
      {a.running && compact && (
        <span title={title} className="flex size-9 items-center justify-center text-muted">
          <LoaderCircle role="img" aria-label={title} className={clsx("size-4", !a.paused && "animate-spin")} />
        </span>
      )}
      {a.running && !compact && (
        <div className="flex flex-col rounded-lg bg-hover py-1 pr-0.5 pl-2.5 text-xs">
          <div className="flex items-center">
            <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
            {onPause && (
              <IconButton label={a.paused ? t(`${ns}.resume`) : t(`${ns}.pause`)} onClick={() => onPause(!a.paused)}>
                {a.paused ? <Play aria-hidden className="size-3.5" /> : <Pause aria-hidden className="size-3.5" />}
              </IconButton>
            )}
            <IconButton
              label={t(`${ns}.cancel`)}
              onClick={() => {
                // This line goes away with its buttons.
                focusAssets();
                onCancel();
              }}
            >
              <X aria-hidden className="size-3.5" />
            </IconButton>
          </div>
          <span className="font-mono text-[11px] text-muted">{progress}</span>
          <div aria-hidden className="mt-1.5 mr-2 mb-1.5 h-[3px] overflow-hidden rounded-full bg-line-soft">
            <div className="h-full bg-accent" style={{ width: `${100 * fraction}%` }} />
          </div>
        </div>
      )}
    </>
  );
}

/** Where `looks:` words search: what the results cover, or that search by meaning is off, so they match nothing. */
export function LooksNote({ className }: { className?: string }) {
  const m = useStore((s) => s.meaning);
  if (m.on) return <AnalysisNote ns="meaning" className={className} />;
  return (
    <div className={clsx("flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-muted", className)}>
      <span>{t("meaning.looksOff", { word: "looks:" })}</span>
      <button type="button" onClick={() => openSettings("library")} className="font-semibold text-accent hover:underline">
        {t("palette.ask.openSettings")}
      </button>
    </div>
  );
}

const NOTE = {
  analysis: { now: "analysis.analysingNow", resume: "analysis.resumeAnalysis", start: "analysis.analyseNow", pause: pauseAnalysis, run: analyse },
  meaning: { now: "meaning.indexingNow", resume: "meaning.resumeIndexing", start: "meaning.indexNow", pause: pauseMeaning, run: () => run(api.meaningEnable()) },
} as const;

/**
 * Where results depend on analysis (Find similar, colour search) or on the index for search by meaning: what they
 * cover, and a way to do the rest.
 */
export function AnalysisNote({ className, ns = "analysis" }: { className?: string; ns?: "analysis" | "meaning" }) {
  const a = useStore((s) => s[ns]);
  const left = a.total - a.done;
  if (left <= 0) return null;
  const n = NOTE[ns];
  return (
    <div className={clsx("flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-muted", className)}>
      <span>{t(`${ns}.pending`, { count: left, covered: t(`${ns}.covered`, { count: a.done }) })}</span>
      {a.running && !a.paused ? (
        <span>{t(n.now)}</span>
      ) : (
        <button type="button" onClick={() => (a.running ? n.pause(false) : n.run())} className="font-semibold text-accent hover:underline">
          {a.running ? t(n.resume) : t(n.start)}
        </button>
      )}
    </div>
  );
}
