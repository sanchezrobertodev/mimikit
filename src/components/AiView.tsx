import { Bot, LoaderCircle, ScanSearch, Sparkles, Tags, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useAgents } from "../agent/bridge";
import { agentName } from "../agent/run";
import { api, errorText } from "../api";
import { ago, money } from "../lib/fmt";
import { t } from "../lib/i18n";
import { cost } from "../lib/tagging";
import { useStore } from "../store";
import { AgentActivity } from "./Agents";
import { AnalysisNote } from "./Analysis";
import { askInSearch } from "./Palette";
import { openKeySetup, openSettings } from "./Settings";
import { Button } from "./ui";

/** One AI feature: what it does, how it stands, and a way to use it. */
function Card({ icon: Icon, title, hint, children }: { icon: LucideIcon; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-card px-5 py-[18px]">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Icon aria-hidden className="size-4 flex-none text-accent" />
          {title}
        </h2>
        <p className="text-muted">{hint}</p>
      </div>
      {children}
    </section>
  );
}

/** A status line with its action on the right. */
function Line({ text, sub, children }: { text: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col">
        <span className="text-fg">{text}</span>
        {sub && <span className="text-xs text-muted">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

/** A box and its button: Enter or the button runs `onRun` with the words typed, with a spinner until it's done. */
function Describe({ label, placeholder, button, onRun }: { label: string; placeholder: string; button: string; onRun: (words: string) => void | Promise<void> }) {
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!words.trim() || busy) return;
    setBusy(true);
    try {
      await onRun(words.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex gap-2">
      <input
        aria-label={label}
        value={words}
        placeholder={placeholder}
        readOnly={busy}
        aria-busy={busy}
        onChange={(e) => setWords(e.target.value)}
        className="h-[34px] min-w-0 flex-1 rounded-lg border border-line-strong bg-field px-3 text-fg placeholder:text-faint"
      />
      <Button type="submit" disabled={busy}>
        {busy && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
        {button}
      </Button>
    </form>
  );
}

/**
 * The AI view: every AI feature in one place, with how it stands and a way to use it. Each one still works where it
 * belongs (search, Peek, Settings); this is the way in. Gone with AI features off (Settings › General).
 */
export function AiView() {
  const s = useStore();
  const st = s.tagging;
  const m = s.meaning;
  const agents = useAgents();
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  // Settings opens over this view, so read the key again when it closes: Add key leads there.
  const inSettings = s.modal === "settings";
  useEffect(() => {
    if (!inSettings) api.apiKeyStatus().then(setHasKey, () => setHasKey(null));
  }, [inSettings]);
  const untagged = useMemo(() => s.assets.filter((a) => !a.tags.length).map((a) => a.id), [s.assets]);
  const waiting = useMemo(() => s.assets.filter((a) => a.suggested.length).length, [s.assets]);
  const meaningReady = m.on && m.installed && m.done > 0;
  const review = () => {
    s.clearFilters();
    s.go("library");
    s.setFilters({ suggested: true });
  };
  const now = Date.now();

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-auto px-7 pt-6 pb-10">
      <p className="max-w-[720px] text-muted">{t("aiView.intro")}</p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-3.5">
        <Card icon={Sparkles} title={t("palette.ask.title")} hint={t("aiView.ask.hint")}>
          {hasKey === false ? (
            <Line text={t("aiView.ask.noKey")}>
              <Button size="sm" onClick={openKeySetup}>
                {t("settings.ai.add")}
              </Button>
            </Line>
          ) : (
            <Describe label={t("palette.ask.title")} placeholder={t("aiView.ask.placeholder")} button={t("aiView.ask.button")} onRun={askInSearch} />
          )}
        </Card>

        <Card icon={Tags} title={t("tagging.title")} hint={t("aiView.tags.hint")}>
          {st.assets > 0 ? (
            <Line text={t("tagging.running", { count: st.assets })} sub={st.canceling ? t("tagging.canceling") : t("tagging.progress", { done: st.finished, total: st.requests })}>
              {!st.canceling && (
                <Button size="sm" onClick={() => void s.cancelTagging()}>
                  {t("tagging.cancel")}
                </Button>
              )}
            </Line>
          ) : (
            <Line text={untagged.length ? t("aiView.tags.untagged", { count: untagged.length }) : t("aiView.tags.allTagged")}>
              {untagged.length > 0 && (
                <Button size="sm" onClick={() => s.setSuggestFor(untagged)}>
                  {t("aiView.tags.suggest")}
                </Button>
              )}
            </Line>
          )}
          {waiting > 0 && (
            <Line text={t("tagging.waiting", { count: waiting })}>
              <Button size="sm" onClick={review}>
                {t("tagging.review")}
              </Button>
            </Line>
          )}
          {st.error && <p className="text-xs text-danger">{t("tagging.error", { error: errorText(st.error) })}</p>}
          {st.last && <p className="font-mono text-xs text-muted">{t("tagging.lastCost", { cost: money(cost(st.last.usage, st.last.model, st.last.direct)) })}</p>}
        </Card>

        <Card icon={ScanSearch} title={t("aiView.meaning.title")} hint={t("aiView.meaning.hint")}>
          {meaningReady ? (
            <Describe label={t("aiView.meaning.title")} placeholder={t("aiView.meaning.placeholder")} button={t("aiView.meaning.button")} onRun={(words) => s.findByMeaning(words, "")} />
          ) : (
            <div>
              <Button size="sm" onClick={() => openSettings("library")}>
                {m.on ? t("palette.ask.openSettings") : t("aiView.setUp")}
              </Button>
            </div>
          )}
          <AnalysisNote ns="meaning" className="text-xs" />
        </Card>

        <Card icon={Bot} title={t("settings.pages.agents")} hint={t("aiView.agents.hint")}>
          {agents.on &&
            (agents.sessions.length ? (
              agents.sessions.map((x) => (
                <Line
                  key={x.pid}
                  text={`${agentName(x.name)} ${x.version}`}
                  sub={x.paused ? t("agents.paused") : t("agents.calls", { count: x.calls, ago: ago(x.last, now) })}
                >
                  <Button size="sm" onClick={() => agents.pause(x.pid, !x.paused)}>
                    {x.paused ? t("agents.resume") : t("agents.pause")}
                  </Button>
                </Line>
              ))
            ) : (
              <p className="text-xs text-muted">{t("agents.none")}</p>
            ))}
          <AgentActivity />
          <div>
            <Button size="sm" onClick={() => openSettings("agents")}>
              {agents.on ? t("aiView.agents.manage") : t("aiView.setUp")}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
