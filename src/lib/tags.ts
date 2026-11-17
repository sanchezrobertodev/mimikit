// The tag manager's and Filters panel's helpers. No Tauri imports, so the Node tests load it.
import type { Collection, TagGroup } from "../types";

export interface TagCount {
  tag: string;
  /** Assets with the tag; 0 for a grouped tag whose last asset lost it. */
  count: number;
}

/** What `likelySame` compares: lowercase, without `-`, `_` and spaces, with one plural ending trimmed. */
export function tagStem(tag: string): string {
  const s = tag.toLowerCase().replace(/[-_\s]+/g, "");
  if (s.length > 4 && s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (/(s|x|ch|sh)es$/.test(s)) return s.slice(0, -2);
  // "glass" keeps its s, so it still meets "glasses".
  if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  return s;
}

/** Sets of tags that are probably one tag written differently (coin / coins), each to merge into its most-used tag. */
export function likelySame(tags: TagCount[]): { into: string; tags: TagCount[] }[] {
  const sets = new Map<string, TagCount[]>();
  for (const t of tags) {
    const k = tagStem(t.tag);
    sets.set(k, [...(sets.get(k) ?? []), t]);
  }
  return [...sets.values()]
    .filter((set) => set.length > 1)
    .map((set) => set.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)))
    .map((set) => ({ into: set[0].tag, tags: set }))
    .sort((a, b) => a.into.localeCompare(b.into));
}

/** `tags` (in their order) split by group, in the groups' order, with the ungrouped ones last (`group` null). */
export function groupedTags(tags: string[], groups: TagGroup[]): { group: TagGroup | null; tags: string[] }[] {
  const of = new Map(groups.flatMap((g) => g.tags.map((t) => [t, g.id] as const)));
  return [...groups.map((g) => ({ group: g, tags: tags.filter((t) => of.get(t) === g.id) })), { group: null, tags: tags.filter((t) => !of.has(t)) }];
}

/** How many smart collections name `tag` exactly, as a `#tag` word or a Filters-panel tag (what delete_tags leaves). */
export const rulesNaming = (collections: Collection[], tags: string[]) =>
  collections.filter(
    (c) =>
      c.rule &&
      (c.rule.query.split(/\s+/).some((w) => /^[#＃]/.test(w) && tags.includes(w.slice(1).toLowerCase())) ||
        c.rule.filters.anyTags?.some((t) => tags.includes(t))),
  ).length;
