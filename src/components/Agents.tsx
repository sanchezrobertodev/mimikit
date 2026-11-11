import clsx from "clsx";
import { useId } from "react";
import { describe, useAgents } from "../agent/bridge";
import { agentName } from "../agent/run";
import { formatLocale, t } from "../lib/i18n";
import { useStore } from "../store";
import { Button } from "./ui";

/**
 * Settings › AI agents › What agents did: the changes agents made since Mimikit started, newest first, with the values
 * they replaced, and Undo for the newest one still standing.
 */
export function AgentActivity() {
  const on = useAgents((s) => s.on);
  const activity = useAgents((s) => s.activity);
  const undoLast = useAgents((s) => s.undoLast);
  if (!on && !activity.length) return null;
  const time = (ms: number) => new Date(ms).toLocaleTimeString(formatLocale(), { timeStyle: "short" });
  return (
    <div className="flex flex-col pt-2">
      <div className="flex items-center justify-between gap-6 py-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-fg">{t("agents.activity")}</span>
          <span className="text-xs text-muted">{t("agents.activityHint")}</span>
        </div>
        <Button size="sm" disabled={!activity.some((c) => c.undo && !c.undone)} onClick={undoLast}>
          {t("agents.undoLast")}
        </Button>
      </div>
      {activity.length ? (
        <ol aria-label={t("agents.activity")} className="max-h-72 overflow-y-auto rounded-lg border border-line-soft">
          {activity.map((c) => (
            <li key={c.id} className="border-t border-line-soft px-2.5 py-1.5 text-xs first:border-t-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-fg-2">{agentName(c.by)}</span>
                <span className="flex-none text-faint">
                  {c.undone ? `${t("agents.undone")} · ` : c.undo ? "" : `${t("agents.noUndo")} · `}
                  {time(c.at)}
                </span>
              </div>
              <ul className={clsx("mt-0.5 text-muted", c.undone && "line-through")}>
                {c.steps.map((s, i) => (
                  <li key={i} className="break-words">
                    {describe(s)}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : (
        <p className="py-2 text-xs text-muted">{t("agents.activityNone")}</p>
      )}
    </div>
  );
}

/**
 * "Allow Claude Code to see your library?", for the oldest app waiting, over everything else. It never takes focus,
 * so a key pressed for something else can't answer it; Settings asks the same at the top of whichever page it shows.
 */
export function AgentAsk() {
  const q = useAgents((s) => s.questions[0]);
  const answer = useAgents((s) => s.answer);
  const inSettings = useStore((s) => s.modal === "settings");
  const id = useId();
  if (!q || inSettings) return null;
  return (
    <div
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      className="fixed top-4 right-4 z-[80] w-[340px] max-w-[calc(100vw-2rem)] rounded-2xl border border-line-x bg-field p-4 shadow-[0_24px_60px_-16px_rgba(0,0,0,.6)]"
    >
      <h2 id={`${id}-title`} className="text-[14px] font-semibold text-fg">
        {t("agents.askTitle", { name: agentName(q.name) })}
      </h2>
      {/* What the app calls itself, as it said it. */}
      <p className="mt-0.5 truncate font-mono text-[11px] text-faint">
        {q.name} {q.version}
      </p>
      <p id={`${id}-body`} className="mt-2 text-xs text-muted">
        {t("agents.askBody")}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" onClick={() => answer(q.name, false)}>
          {t("agents.deny")}
        </Button>
        <Button size="sm" variant="accent" onClick={() => answer(q.name, true)}>
          {t("agents.allow")}
        </Button>
      </div>
    </div>
  );
}
