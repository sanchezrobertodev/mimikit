import { ArrowDown, ArrowUp, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { groupWord } from "../lib/filter";
import { t } from "../lib/i18n";
import { groupedTags, likelySame, rulesNaming, type TagCount } from "../lib/tags";
import { useStore } from "../store";
import type { TagGroup } from "../types";
import { Button, IconButton, Label, Modal, Segmented } from "./ui";

type Sort = "count" | "name";

/** A change the view asks about first. */
interface Ask {
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
  run: () => Promise<unknown>;
  /** Runs when it's cancelled, e.g. to put back a typed name. */
  cancel?: () => void;
}

const field = "border-0 border-b border-dashed border-transparent bg-transparent p-0 text-fg focus:border-line-x";
const tag = (name: string) => `#${name}`;

/** A name field that saves on Enter or leaving it, and puts the name back on Esc. `data-name` finds it again after a rename. */
function NameField({ value, onSave, label, className, autoSelect }: { value: string; onSave: (v: string, revert: () => void) => void; label: string; className: string; autoSelect?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const input = useRef<HTMLInputElement>(null);
  // A new group's name is selected, so typing replaces it.
  useEffect(() => {
    if (autoSelect) input.current?.select();
  }, [autoSelect]);
  // Esc reverts: the blur that follows must not save the name it still sees.
  const reverting = useRef(false);
  const commit = () => {
    if (reverting.current) {
      reverting.current = false;
      return setText(value);
    }
    if (!text.trim() || text.trim() === value) return setText(value);
    onSave(text, () => setText(value));
  };
  return (
    <input
      ref={input}
      aria-label={label}
      data-name={value}
      value={text}
      maxLength={64}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          reverting.current = true;
          e.currentTarget.blur();
        }
      }}
      className={`${field} ${className}`}
    />
  );
}

function TagRow({
  t: row,
  group,
  groups,
  checked,
  onCheck,
  onRename,
  onDelete,
}: {
  t: TagCount;
  group: number | null;
  groups: TagGroup[];
  checked: boolean;
  onCheck: (on: boolean) => void;
  onRename: (to: string, revert: () => void) => void;
  onDelete: () => void;
}) {
  const s = useStore();
  // The assets with exactly this tag, which `#tag` in search would widen to every tag starting with it.
  const show = () => {
    s.clearFilters();
    s.setFilters({ anyTags: [row.tag] });
    s.go("library");
  };
  return (
    <li className="flex h-11 items-center gap-3 rounded-[10px] border border-line px-3 hover:bg-field">
      <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={t("tagsView.select", { tag: tag(row.tag) })} className="flex-none" />
      <span className="flex min-w-0 flex-1 items-center font-medium">
        <span aria-hidden className="text-faint">
          #
        </span>
        <NameField value={row.tag} label={t("tagsView.rename", { tag: tag(row.tag) })} onSave={onRename} className="min-w-0 flex-1 font-medium" />
      </span>
      <button type="button" onClick={show} title={t("tagsView.showAssets", { tag: tag(row.tag) })} className="flex-none font-mono text-xs text-muted hover:text-fg">
        {t("tagsView.assets", { count: row.count })}
      </button>
      <select
        value={group ?? ""}
        aria-label={t("tagsView.groupOf", { tag: tag(row.tag) })}
        onChange={(e) => void s.setTagGroup([row.tag], e.target.value ? Number(e.target.value) : null)}
        className="h-[30px] w-40 flex-none rounded-lg border border-line-strong bg-field px-1.5 text-fg"
      >
        <option value="">{t("tagsView.noGroup")}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      <IconButton label={t("tagsView.delete", { tag: tag(row.tag) })} onClick={onDelete}>
        <Trash2 className="size-4" />
      </IconButton>
    </li>
  );
}

export function TagsView() {
  const s = useStore();
  const [find, setFind] = useState("");
  const [sort, setSort] = useState<Sort>("count");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<Ask | null>(null);
  const [naming, setNaming] = useState<number | null>(null);
  // A renamed tag's row, to focus once its assets' new tags arrive.
  const [refocus, setRefocus] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Every tag with its asset count, and grouped tags no asset has any more (count 0).
  const counts = useMemo(() => {
    const n = new Map<string, number>();
    for (const a of s.assets) for (const g of a.tags) n.set(g, (n.get(g) ?? 0) + 1);
    for (const g of s.tagGroups) for (const x of g.tags) if (!n.has(x)) n.set(x, 0);
    return n;
  }, [s.assets, s.tagGroups]);
  const all = useMemo(
    () => [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => (sort === "count" && b.count - a.count) || a.tag.localeCompare(b.tag)),
    [counts, sort],
  );
  const same = useMemo(() => likelySame(all.filter((x) => x.count > 0)), [all]);
  const needle = find.trim().toLowerCase().replace(/^#/, "");
  const shown = needle ? all.filter((x) => x.tag.includes(needle)) : all;
  const sections = groupedTags(
    shown.map((x) => x.tag),
    s.tagGroups,
  ).filter((sec) => !needle || sec.tags.length);
  const groupOf = useMemo(() => new Map(s.tagGroups.flatMap((g) => g.tags.map((x) => [x, g.id] as const))), [s.tagGroups]);
  useEffect(() => {
    const el = refocus ? document.querySelector<HTMLElement>(`li input[data-name="${CSS.escape(refocus)}"]`) : null;
    if (!el) return;
    el.focus();
    setRefocus(null);
  }, [refocus, counts]);
  // Selected tags that still exist, most used first.
  const selected = all.filter((x) => picked.has(x.tag)).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  // Assets that have one of `tags`.
  const reach = (tags: string[]) => s.assets.filter((a) => a.tags.some((x) => tags.includes(x))).length;

  // A row or button that goes away with the change leaves focus nowhere: put it on the search field.
  const run = async (change: () => Promise<unknown>) => {
    await change();
    setPicked(new Set());
    if (!document.activeElement || document.activeElement === document.body) searchRef.current?.focus();
  };
  const mergeTitle = (from: string[], into: string) =>
    from.length === 1 ? t("tagsView.ask.merge", { from: tag(from[0]), tag: tag(into) }) : t("tagsView.ask.mergeMany", { count: from.length, tag: tag(into) });
  const askMerge = (from: string[], into: string, cancel?: () => void) =>
    setAsk({
      title: mergeTitle(from, into),
      body: <p>{t("tagsView.ask.mergeBody", { count: reach([...from, into]), tag: tag(into) })}</p>,
      confirm: t("tagsView.ask.mergeConfirm"),
      run: () => s.renameTags(from, into),
      cancel,
    });
  /** Merge into…: the selected tags into the one picked in the dialog, at first the most used. */
  const askMergeMany = (list: TagCount[]) => {
    const merge = (into: string) => {
      const from = list.map((x) => x.tag).filter((x) => x !== into);
      return { title: mergeTitle(from, into), run: () => s.renameTags(from, into) };
    };
    setAsk({
      ...merge(list[0].tag),
      body: <MergeInto list={list} reach={reach} onPick={(into) => setAsk((a) => a && { ...a, ...merge(into) })} />,
      confirm: t("tagsView.ask.mergeConfirm"),
    });
  };
  const askDelete = (tags: string[]) => {
    const rules = rulesNaming(s.collections, tags);
    setAsk({
      title: tags.length === 1 ? t("tagsView.ask.delete", { tag: tag(tags[0]) }) : t("tagsView.ask.deleteMany", { count: tags.length }),
      body: (
        <>
          <p>{t("tagsView.ask.deleteBody", { count: reach(tags) })}</p>
          {rules > 0 && <p className="mt-2">{t("tagsView.ask.deleteRules", { count: rules })}</p>}
        </>
      ),
      confirm: t("tagsView.ask.deleteConfirm"),
      danger: true,
      run: () => s.deleteTags(tags),
    });
  };
  const rename = (from: string, raw: string, revert: () => void) => {
    const to = raw.trim().toLowerCase();
    if (to === from) return revert();
    // A name that's taken merges the two, so it asks first.
    if (counts.has(to)) askMerge([from], to, revert);
    else void s.renameTags([from], to).then((ok) => (ok ? setRefocus(to) : revert()));
  };
  const move = async (g: TagGroup, dir: "up" | "down") => {
    await s.moveTagGroup(g.id, s.tagGroups.indexOf(g) + (dir === "up" ? -1 : 1));
    // The header moved: keep focus on the button, or the other one once it's at the end.
    const btn = (d: string) => document.querySelector<HTMLButtonElement>(`[data-move="${g.id}-${d}"]`);
    const here = btn(dir);
    (here && !here.disabled ? here : btn(dir === "up" ? "down" : "up"))?.focus();
  };
  const newGroup = async () => {
    const id = await s.newTagGroup();
    if (id !== null) setNaming(id);
  };
  const stop = (e: KeyboardEvent) => e.stopPropagation();

  if (!counts.size && !s.tagGroups.length)
    return (
      <div className="m-auto flex max-w-sm flex-col items-center gap-2 text-center text-muted">
        <span className="text-base font-medium text-fg">{t("tagsView.empty.title")}</span>
        <span>{t(s.ai.on ? "tagsView.empty.bodyAi" : "tagsView.empty.body")}</span>
        <div className="mt-2 flex gap-2">
          {s.ai.on && s.assets.length > 0 && (
            <Button variant="accent" onClick={() => s.setSuggestFor(s.assets.map((a) => a.id))}>
              {t("tagsView.empty.suggest")}
            </Button>
          )}
          <Button onClick={() => void newGroup()}>{t("tagsView.newGroup")}</Button>
        </div>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-7 pt-5 pb-10">
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="flex h-[34px] w-64 items-center gap-2 rounded-[9px] border border-line-strong bg-field px-3 text-muted focus-within:border-line-x">
          <Search aria-hidden className="size-3.5 flex-none" />
          <input
            ref={searchRef}
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={stop}
            placeholder={t("tagsView.find")}
            aria-label={t("tagsView.find")}
            className="min-w-0 flex-1 bg-transparent text-fg placeholder:text-muted focus:outline-none"
          />
        </label>
        <Segmented
          label={t("tagsView.sort")}
          value={sort}
          onChange={setSort}
          options={[
            { value: "count", label: t("tagsView.sorts.count") },
            { value: "name", label: t("tagsView.sorts.name") },
          ]}
        />
        <span className="text-xs text-muted">{t("tagsView.groupHint", { example: "#style:" })}</span>
        <Button className="ml-auto" onClick={() => void newGroup()}>
          {t("tagsView.newGroup")}
        </Button>
      </div>

      {selected.length > 0 && (
        <div role="group" aria-label={t("tagsView.selection")} className="flex flex-wrap items-center gap-2.5 rounded-xl border border-line-strong bg-card px-4 py-2.5">
          <span className="font-medium">{t("tagsView.selected", { count: selected.length })}</span>
          {selected.length > 1 && (
            <Button size="sm" onClick={() => askMergeMany(selected)}>
              {t("tagsView.mergeSelected")}
            </Button>
          )}
          <select
            value=""
            aria-label={t("tagsView.moveSelected")}
            onChange={(e) => {
              const to = e.target.value;
              if (to) void run(() => s.setTagGroup(selected.map((x) => x.tag), to === "none" ? null : Number(to)));
            }}
            className="h-8 rounded-lg border border-line-strong bg-field px-1.5 text-fg"
          >
            <option value="">{t("tagsView.moveSelected")}</option>
            {s.tagGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
            <option value="none">{t("tagsView.noGroup")}</option>
          </select>
          <Button size="sm" variant="danger" onClick={() => askDelete(selected.map((x) => x.tag))}>
            {t("tagsView.deleteSelected")}
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPicked(new Set())}>
            {t("tagsView.clearSelection")}
          </Button>
        </div>
      )}

      {same.length > 0 && !needle && (
        <section aria-labelledby="tags-same" className="flex flex-col gap-1 rounded-xl border border-line bg-card px-4 py-3">
          <h2 id="tags-same" className="mb-1 text-[15px] font-semibold">
            {t("tagsView.same.title")}
          </h2>
          {same.map((set) => (
            <div key={set.into} className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex min-w-0 flex-1 flex-wrap gap-x-3">
                {set.tags.map((x) => (
                  <span key={x.tag}>
                    {tag(x.tag)} <span className="font-mono text-xs text-faint">{x.count}</span>
                  </span>
                ))}
              </span>
              <Button
                size="sm"
                onClick={() =>
                  askMerge(
                    set.tags.filter((x) => x.tag !== set.into).map((x) => x.tag),
                    set.into,
                  )
                }
              >
                {t("tagsView.same.merge", { tag: tag(set.into) })}
              </Button>
            </div>
          ))}
        </section>
      )}

      {needle && !shown.length && <p className="text-muted">{t("tagsView.noMatch", { query: find.trim() })}</p>}

      {sections.map(({ group: g, tags }) => (
        <section key={g?.id ?? "none"} aria-label={g?.name ?? t("tagsView.ungrouped")} className="flex flex-col gap-1.5">
          <div className="flex min-h-9 items-center gap-2">
            {g ? (
              <>
                <NameField
                  value={g.name}
                  label={t("tagsView.groupName")}
                  autoSelect={naming === g.id}
                  onSave={(name, revert) => void s.renameTagGroup(g.id, name).then((ok) => ok || revert())}
                  className="w-56 min-w-0 text-[15px] font-semibold"
                />
                <span className="font-mono text-xs text-muted">{t("tagsView.tagCount", { count: g.tags.length })}</span>
                <button
                  type="button"
                  onClick={() => {
                    s.clearFilters();
                    s.go("library", { query: `#${groupWord(g.name)}:` });
                  }}
                  title={t("tagsView.showGroup", { name: g.name })}
                  className="font-mono text-xs text-muted hover:text-fg"
                >
                  #{groupWord(g.name)}:
                </button>
                <span className="ml-auto flex gap-0.5">
                  <IconButton data-move={`${g.id}-up`} label={t("tagsView.moveUp", { name: g.name })} disabled={g === s.tagGroups[0]} onClick={() => void move(g, "up")}>
                    <ArrowUp className="size-4" />
                  </IconButton>
                  <IconButton
                    data-move={`${g.id}-down`}
                    label={t("tagsView.moveDown", { name: g.name })}
                    disabled={g === s.tagGroups[s.tagGroups.length - 1]}
                    onClick={() => void move(g, "down")}
                  >
                    <ArrowDown className="size-4" />
                  </IconButton>
                  <IconButton label={t("tagsView.deleteGroup", { name: g.name })} onClick={() => void run(() => s.deleteTagGroup(g.id))}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </span>
              </>
            ) : (
              <>
                <Label>{s.tagGroups.length ? t("tagsView.ungrouped") : t("tagsView.allTags")}</Label>
                <span className="font-mono text-xs text-muted">{t("tagsView.tagCount", { count: tags.length })}</span>
              </>
            )}
          </div>
          {tags.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {tags.map((name) => (
                <TagRow
                  key={name}
                  t={{ tag: name, count: counts.get(name) ?? 0 }}
                  group={groupOf.get(name) ?? null}
                  groups={s.tagGroups}
                  checked={picked.has(name)}
                  onCheck={(on) =>
                    setPicked((p) => {
                      const next = new Set(p);
                      if (on) next.add(name);
                      else next.delete(name);
                      return next;
                    })
                  }
                  onRename={(to, revert) => rename(name, to, revert)}
                  onDelete={() => askDelete([name])}
                />
              ))}
            </ul>
          ) : (
            g && <p className="text-muted">{t("tagsView.emptyGroup")}</p>
          )}
        </section>
      ))}

      {ask && (
        <Modal
          title={ask.title}
          onClose={() => {
            ask.cancel?.();
            setAsk(null);
          }}
          footer={
            <>
              <Button
                data-autofocus
                onClick={() => {
                  ask.cancel?.();
                  setAsk(null);
                }}
              >
                {t("tagsView.ask.cancel")}
              </Button>
              <Button
                variant={ask.danger ? "danger" : "invert"}
                onClick={() => {
                  setAsk(null);
                  void run(ask.run);
                }}
              >
                {ask.confirm}
              </Button>
            </>
          }
        >
          <div className="leading-relaxed">{ask.body}</div>
        </Modal>
      )}
    </div>
  );
}

/** The pick of the tag the selected ones merge into, and how many assets will have it. */
function MergeInto({ list, onPick, reach }: { list: TagCount[]; onPick: (into: string) => void; reach: (tags: string[]) => number }) {
  const [into, setInto] = useState(list[0].tag);
  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2">
        {t("tagsView.ask.into")}
        <select
          value={into}
          onChange={(e) => {
            setInto(e.target.value);
            onPick(e.target.value);
          }}
          className="h-[30px] rounded-lg border border-line-strong bg-field px-1.5 text-fg"
        >
          {list.map((x) => (
            <option key={x.tag} value={x.tag}>
              {tag(x.tag)} ({x.count})
            </option>
          ))}
        </select>
      </label>
      <p>{t("tagsView.ask.mergeBody", { count: reach(list.map((x) => x.tag)), tag: tag(into) })}</p>
    </div>
  );
}
