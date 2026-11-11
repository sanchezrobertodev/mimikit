// The Suggest tags dialog: what goes to Anthropic, the model and the cost, then the previews Claude needs and the send.
// Opened from Peek (the selection) and the palette (the assets shown). Sent right away, the tags are in when the send
// returns; sent as a batch, they come later (src-tauri/src/tagging.rs).
import { Tags, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../api";
import { topTags } from "../lib/ask";
import { money } from "../lib/fmt";
import { t } from "../lib/i18n";
import { cost, DIRECT_MAX, estimate, PER_REQUEST, tagPrompt } from "../lib/tagging";
import { saveFontSample, thumbnailFor } from "../lib/thumbs";
import { useStore } from "../store";
import type { Asset } from "../types";
import { MODEL_NAMES, openKeySetup } from "./Settings";
import { Button, focusAssets, IconButton, Modal, Segmented } from "./ui";

/** ai.rs NO_KEY: the collector waits for a key. */
const NO_KEY = "No Anthropic API key is set. Add one in Settings.";

/** Makes the previews tagging.rs sends but can't draw itself: model and video thumbnails, and font samples. */
async function preparePreviews(assets: Asset[], onProgress: (done: number, total: number) => void, stopped: () => boolean) {
  const need = assets.filter((a) => a.kind === "model" || a.kind === "video" || a.kind === "font");
  for (let i = 0; i < need.length && !stopped(); i++) {
    onProgress(i, need.length);
    const a = need[i];
    // A preview that can't be made just leaves that asset to be tagged from its name.
    await (a.kind === "font" ? saveFontSample(a) : thumbnailFor(a));
  }
}

export function SuggestTags({ ids }: { ids: number[] }) {
  const { assets, ai, setSuggestFor, setError, showToast } = useStore();
  const close = () => setSuggestFor(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [asked, setAsked] = useState<Set<number> | null>(null);
  const [again, setAgain] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [sending, setSending] = useState(false);
  /** Right away or as a batch: the user's pick, or by the run's size until they make one. */
  const [mode, setMode] = useState<"now" | "batch" | null>(null);
  const [answered, setAnswered] = useState(0);
  const stop = useRef(false);
  const uploading = useRef(false); // set before the dialog re-renders, so a click in between can't close it

  useEffect(() => {
    stop.current = false; // StrictMode runs this twice
    api.apiKeyStatus().then(setHasKey, setError);
    api.taggingAsked(ids).then((a) => setAsked(new Set(a)), setError);
    return () => {
      stop.current = true;
    };
  }, [ids, setError]);

  const all = useMemo(() => {
    const wanted = new Set(ids);
    return assets.filter((a) => wanted.has(a.id));
  }, [assets, ids]);
  const already = asked ? all.filter((a) => asked.has(a.id)).length : 0;
  const chosen = asked && !again ? all.filter((a) => !asked.has(a.id)) : all;

  const prompt = useMemo(() => tagPrompt(topTags(assets)), [assets]);
  const direct = (mode ?? (chosen.length <= DIRECT_MAX ? "now" : "batch")) === "now";
  const price = estimate(chosen, ai.tagModel, prompt, direct);
  const requests = Math.ceil(chosen.length / PER_REQUEST);
  const busy = progress !== null || sending;
  // Previews can stop; once the upload starts it can't, so the dialog stays until it's sent (then the sidebar can cancel).
  const dismiss = () => {
    if (uploading.current) return;
    stop.current = true;
    close();
  };

  const send = async () => {
    try {
      await preparePreviews(chosen, (done, total) => setProgress({ done, total }), () => stop.current);
      if (stop.current) return;
      uploading.current = true;
      setProgress(null);
      setSending(true);
      setAnswered(0);
      const unlisten = await api.onTaggingDirect(setAnswered);
      const n = await api
        .suggestTags(
          prompt,
          chosen.map((a) => a.id),
          ai.tagModel,
          !direct,
        )
        .finally(unlisten);
      if (!direct) showToast(t("tagging.sentToast", { count: n }));
      else if (n < chosen.length) showToast(t("tagging.someToast", { done: n, count: chosen.length }));
      else showToast(t("tagging.doneToast", { count: n }));
      close();
    } catch (e) {
      setError(e);
      uploading.current = false;
      setProgress(null);
      setSending(false);
    }
  };

  const footer =
    hasKey === false ? (
      <>
        <Button onClick={close}>{t("tagging.cancel")}</Button>
        <Button variant="accent" data-autofocus onClick={() => (close(), openKeySetup())}>
          {t("tagging.openSettings")}
        </Button>
      </>
    ) : (
      <>
        <Button data-autofocus={chosen.length ? undefined : true} disabled={sending} onClick={dismiss}>
          {t("tagging.cancel")}
        </Button>
        <Button variant="accent" data-autofocus={chosen.length ? true : undefined} disabled={busy || !chosen.length} onClick={() => void send()}>
          {t("tagging.send")}
        </Button>
      </>
    );

  // Opens once both are known, so the dialog's default button is the right one and can take focus.
  if (hasKey === null || !asked) return null;
  return (
    <Modal title={t("tagging.title")} onClose={dismiss} footer={footer}>
      <div className="flex flex-col gap-3 leading-relaxed">
        <p className="text-base font-medium text-fg">{t("tagging.assets", { count: chosen.length })}</p>
        {already > 0 && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={again} disabled={busy} onChange={(e) => setAgain(e.target.checked)} />
            {t("tagging.askAgain", { count: already })}
          </label>
        )}
        {!chosen.length && <p className="text-muted">{t("tagging.nothingNew")}</p>}
        {hasKey === false && <p className="text-fg">{t("tagging.noKey")}</p>}
        <div>
          <p className="font-medium text-fg">{t("tagging.sentTitle")}</p>
          <p className="text-muted">{t("tagging.sent")}</p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">{t("tagging.model")}</dt>
          <dd className="text-fg">
            {MODEL_NAMES[ai.tagModel]} <span className="text-muted">· {t("tagging.modelHint")}</span>
          </dd>
          <dt className="self-center text-muted">{t("tagging.mode")}</dt>
          <dd>
            <Segmented
              label={t("tagging.mode")}
              value={direct ? "now" : "batch"}
              onChange={(m) => !busy && setMode(m)}
              options={[
                { value: "now", label: t("tagging.modeNow") },
                { value: "batch", label: t("tagging.modeBatch") },
              ]}
            />
          </dd>
          <dt className="text-muted">{t("tagging.cost")}</dt>
          <dd className="text-fg">
            {t("tagging.estimate", { about: money(price.about), high: money(price.high) })}
            <span className="block text-xs text-muted">{t(direct ? "tagging.estimateHintDirect" : "tagging.estimateHint")}</span>
          </dd>
        </dl>
        <p className="text-muted">{t(direct ? "tagging.whenDirect" : "tagging.when")}</p>
        <p role="status" className="min-h-5 font-mono text-xs text-muted">
          {progress ? t("tagging.preparing", { done: progress.done, total: progress.total }) : sending
              ? direct
                ? requests > 1
                  ? t("tagging.askingProgress", { done: answered, total: requests })
                  : t("tagging.asking")
                : t("tagging.sending")
              : ""}
        </p>
      </div>
    </Modal>
  );
}

/**
 * Under the folder list: the batches out with Claude (with Cancel), why results can't be collected, or the assets with
 * suggested tags (with Review) and what the last run cost. Screen readers hear when a run starts and when results arrive.
 */
export function TaggingProgress({ compact }: { compact?: boolean }) {
  const s = useStore();
  const st = s.tagging;
  const waiting = useMemo(() => s.assets.filter((a) => a.suggested.length).length, [s.assets]);
  const was = useRef(st);
  const [said, setSaid] = useState("");
  useEffect(() => {
    const before = was.current;
    was.current = st;
    if (st.assets > before.assets) setSaid(t("tagging.started", { count: st.assets }));
    else if (!st.assets && before.assets) setSaid(t("tagging.arrived"));
  }, [st]);
  const running = st.assets > 0;
  const noKey = st.error === NO_KEY;
  if (!s.ai.on) return null;
  const review = () => {
    s.clearFilters();
    s.go("library");
    s.setFilters({ suggested: true });
  };

  return (
    <>
      <p role="status" className="sr-only">
        {said}
      </p>
      {running && compact && (
        <span title={t("tagging.runningTitle")} className="flex size-9 items-center justify-center text-muted">
          <Tags role="img" aria-label={t("tagging.runningTitle")} className="size-4 animate-pulse" />
        </span>
      )}
      {!compact && running && (
        <div className="flex flex-col rounded-lg bg-hover py-1 pr-0.5 pl-2.5 text-xs">
          <div className="flex items-center">
            <span className="min-w-0 flex-1 truncate text-fg">{t("tagging.running", { count: st.assets })}</span>
            {!st.canceling && (
              <IconButton
                label={t("tagging.cancelRun")}
                onClick={() => {
                  focusAssets();
                  void s.cancelTagging();
                }}
              >
                <X aria-hidden className="size-3.5" />
              </IconButton>
            )}
          </div>
          <span className="font-mono text-[11px] text-muted">
            {st.canceling ? t("tagging.canceling") : t("tagging.progress", { done: st.finished, total: st.requests })}
          </span>
          {st.error && (
            <span className="text-[11px] text-danger">
              {t("tagging.error", { error: errorText(st.error) })}{" "}
              {noKey && (
                <button type="button" onClick={openKeySetup} className="font-semibold text-accent hover:underline">
                  {t("tagging.openSettings")}
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {!compact && !running && waiting > 0 && (
        <div className="flex flex-col rounded-lg bg-hover py-1 pr-1 pl-2.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-fg">{t("tagging.waiting", { count: waiting })}</span>
            <button type="button" onClick={review} className="font-semibold text-accent hover:underline">
              {t("tagging.review")}
            </button>
          </div>
          {st.last && <span className="font-mono text-[11px] text-muted">{t("tagging.lastCost", { cost: money(cost(st.last.usage, st.last.model, st.last.direct)) })}</span>}
        </div>
      )}
    </>
  );
}
