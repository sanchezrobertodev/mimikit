import clsx from "clsx";
import { Bot, ScanSearch, Sparkles, Tags, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAgents } from "../agent/bridge";
import { agentName } from "../agent/run";
import { api, errorText } from "../api";
import { money, num } from "../lib/fmt";
import { t } from "../lib/i18n";
import { shortcut } from "../lib/shortcuts";
import { cost } from "../lib/tagging";
import { useStore } from "../store";
import { AgentActivity } from "./Agents";
import { AnalysisNote } from "./Analysis";
import { openKeySetup, openSettings } from "./Settings";
import { Button } from "./ui";

/** How a feature stands, at a glance. */
function Pill({ tone, children }: { tone: "ok" | "warn" | "off"; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap",
        tone === "ok" && "bg-accent/15 text-accent",
        tone === "warn" && "bg-warn-bg text-warn-fg",
        tone === "off" && "border border-line text-muted",
      )}
    >
      {children}
    </span>
  );
}

/** One AI feature: its name and state on the left, a pill and the next useful thing to do on the right. */
function Feature({ icon: Icon, title, sub, pill, children }: { icon: LucideIcon; title: string; sub: ReactNode; pill?: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-6 border-t border-line-soft py-3 first:border-t-0">
      <div className="flex min-w-0 gap-2.5">
        <Icon aria-hidden className="mt-0.5 size-4 flex-none text-accent" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-fg">{title}</span>
          <div className="text-xs text-muted">{sub}</div>
        </div>
      </div>
      <div className="flex flex-none items-center gap-2">
        {pill}
        {children}
      </div>
    </li>
  );
}

/**
 * The AI view: every AI feature in one list, with how it stands and the next thing to do. Each one still works where it
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
  const search = () => s.setPalette(true);
  const review = () => {
    s.clearFilters();
    s.go("library");
    s.setFilters({ suggested: true });
  };
  const running = st.assets > 0;
  const tagsSub = [
    running ? t("tagging.progress", { done: st.finished, total: st.requests }) : untagged.length ? t("aiView.tags.untagged", { count: untagged.length }) : t("aiView.tags.allTagged"),
    st.last && t("tagging.lastCost", { cost: money(cost(st.last.usage, st.last.model, st.last.direct)) }),
  ];

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-auto px-7 pt-6 pb-10">
      <ul className="max-w-[820px] rounded-xl border border-line bg-card px-4">
        <Feature
          icon={Sparkles}
          title={t("palette.ask.title")}
          sub={t("aiView.ask.hint", { keys: shortcut("ask").keys })}
          pill={hasKey === null ? null : hasKey ? <Pill tone="ok">{t("aiView.status.ready")}</Pill> : <Pill tone="warn">{t("aiView.status.needsKey")}</Pill>}
        >
          {hasKey === false ? (
            <Button size="sm" onClick={openKeySetup}>
              {t("settings.ai.add")}
            </Button>
          ) : (
            <Button size="sm" onClick={search}>
              {t("aiView.ask.button")}
            </Button>
          )}
        </Feature>

        <Feature
          icon={Tags}
          title={t("tagging.title")}
          sub={
            <>
              {tagsSub.filter(Boolean).join(" · ")}
              {st.error && <p className="text-danger">{t("tagging.error", { error: errorText(st.error) })}</p>}
            </>
          }
          pill={running ? <Pill tone="ok">{t("aiView.status.running")}</Pill> : waiting > 0 && <Pill tone="warn">{t("aiView.tags.review", { count: waiting })}</Pill>}
        >
          {running ? (
            !st.canceling && (
              <Button size="sm" onClick={() => void s.cancelTagging()}>
                {t("tagging.cancel")}
              </Button>
            )
          ) : (
            <>
              {waiting > 0 && (
                <Button size="sm" onClick={review}>
                  {t("tagging.review")}
                </Button>
              )}
              {untagged.length > 0 && (
                <Button size="sm" onClick={() => s.setSuggestFor(untagged)}>
                  {t("aiView.tags.suggest")}
                </Button>
              )}
            </>
          )}
        </Feature>

        <Feature
          icon={ScanSearch}
          title={t("aiView.meaning.title")}
          sub={
            <>
              {meaningReady ? t("aiView.meaning.indexed", { done: num(m.done), total: num(m.total), keys: shortcut("meaning").keys }) : t("aiView.meaning.hint")}
              <AnalysisNote ns="meaning" />
            </>
          }
          pill={<Pill tone={m.on ? "ok" : "off"}>{m.on ? t("aiView.status.on") : t("aiView.status.off")}</Pill>}
        >
          {meaningReady ? (
            <Button size="sm" onClick={search}>
              {t("aiView.meaning.button")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => openSettings("library")}>
              {m.on ? t("palette.ask.openSettings") : t("aiView.setUp")}
            </Button>
          )}
        </Feature>

        <Feature
          icon={Bot}
          title={t("agents.title")}
          sub={agents.on && agents.sessions.length ? t("aiView.agents.connected", { names: agents.sessions.map((x) => agentName(x.name)).join(", ") }) : t("aiView.agents.hint")}
          pill={<Pill tone={agents.on ? "ok" : "off"}>{agents.on ? t("aiView.status.on") : t("aiView.status.off")}</Pill>}
        >
          <Button size="sm" onClick={() => openSettings("ai", "settings-agents")}>
            {agents.on ? t("aiView.agents.manage") : t("aiView.setUp")}
          </Button>
        </Feature>
      </ul>
      <div className="max-w-[820px]">
        <AgentActivity />
      </div>
    </div>
  );
}
