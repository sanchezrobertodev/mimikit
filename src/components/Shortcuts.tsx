import { t } from "../lib/i18n";
import { GROUPS, SHORTCUTS, groupName } from "../lib/shortcuts";
import { useStore } from "../store";
import { Kbd, Label, Modal } from "./ui";

const close = () => useStore.getState().setModal(null);

/** Every shortcut, grouped. Opened with ?, from the sidebar footer or from search. */
export function ShortcutsDialog() {
  const aiOn = useStore((s) => s.ai.on);
  return (
    <Modal title={t("shortcuts.title")} onClose={close} wide>
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 pb-2 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <section key={g} aria-label={groupName(g)} className="flex flex-col gap-2">
            <Label>{groupName(g)}</Label>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2">
              {SHORTCUTS.filter((s) => s.group === g && (aiOn || s.id !== "ask")).map((s) => (
                <div key={s.id} className="contents">
                  <dt className="text-fg-2">{s.label}</dt>
                  <dd className="justify-self-end whitespace-nowrap">
                    <Kbd>{s.keys}</Kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
