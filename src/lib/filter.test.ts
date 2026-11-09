// Run with `node --experimental-strip-types src/lib/filter.test.ts` (part of `make check`).
import assert from "node:assert/strict";
import type { Asset } from "../types";
import { toLab } from "./colors.ts";
import { activeFilterCount, groupByFolder, matchesFilters, matchesQuery, MEANING_TOP, noFilters, parseQuery, ruleLooks, ruleMembers, rulesWantColors, smartMembers, visibleAssets, type Scope } from "./filter.ts";

const now = Date.UTC(2026, 9, 19);
const day = 86_400_000;
const asset = (o: Partial<Asset>): Asset => ({
  id: 1,
  rootId: 1,
  relPath: "a.png",
  path: "/r/a.png",
  name: "a.png",
  ext: "png",
  kind: "image",
  size: 1000,
  mtime: now - day,
  width: 16,
  height: 16,
  favorite: false,
  tags: [],
  suggested: [],
  rating: 0,
  durationMs: null,
  sampleRate: null,
  channels: null,
  bits: null,
  ...o,
});

const sprite = asset({ relPath: "pack/sprites/a.png", favorite: true, tags: ["player"], rating: 5 });
const texture = asset({ id: 2, name: "t.tga", relPath: "tex/t.tga", ext: "tga", width: 2048, height: 1024, size: 8e6, mtime: now - 40 * day, tags: ["env"], suggested: ["stone"], rating: 3 });
const sound = asset({ id: 3, name: "s.ogg", relPath: "audio/s.ogg", ext: "ogg", kind: "audio", width: null, height: null, tags: ["sfx", "ui"], durationMs: 1500 });
const music = asset({ id: 4, name: "m.mp3", relPath: "audio/m.mp3", ext: "mp3", kind: "audio", width: null, height: null, durationMs: 95_000 });
const unread = asset({ id: 5, name: "u.opus", relPath: "audio/u.opus", ext: "opus", kind: "audio", width: null, height: null });
const all = [sprite, texture, sound];

// Filters panel
const f = (o: Partial<typeof noFilters>) => ({ ...noFilters, ...o });
const ids = (o: Partial<typeof noFilters>) => all.filter((a) => matchesFilters(a, f(o), now)).map((a) => a.id);
assert.deepEqual(ids({}), [1, 2, 3]);
assert.deepEqual(ids({ exts: ["tga", "ogg"] }), [2, 3]);
assert.deepEqual(ids({ maxW: 64, maxH: 64 }), [1]);
assert.deepEqual(ids({ square: true }), [1]); // audio has no dimensions, so it's excluded
assert.deepEqual(ids({ minBytes: 5e6 }), [2]);
assert.deepEqual(ids({ days: 7 }), [1, 3]);
assert.deepEqual(ids({ untagged: true }), []);
assert.deepEqual(ids({ suggested: true }), [2]);
assert.deepEqual(ids({ anyTags: ["ui", "env"] }), [2, 3]);
assert.deepEqual(ids({ minRating: 3 }), [1, 2]);
assert.deepEqual(ids({ minRating: 5 }), [1]);
assert.equal(activeFilterCount(f({ minW: 1, maxW: 2, square: true, untagged: true })), 2);
assert.equal(activeFilterCount(f({ minRating: 1 })), 1);
// Audio length: only files with a known length match once a limit is set.
const durIds = (o: Partial<typeof noFilters>) => [...all, music, unread].filter((a) => matchesFilters(a, f(o), now)).map((a) => a.id);
assert.deepEqual(durIds({ maxMs: 2000 }), [3]);
assert.deepEqual(durIds({ minMs: 30_000 }), [4]);
assert.deepEqual(durIds({ minMs: 1500, maxMs: 95_000 }), [3, 4]); // limits are inclusive
assert.deepEqual(durIds({ minMs: 0 }), [3, 4]);
assert.equal(activeFilterCount(f({ minMs: 1000 })), 1);

// Search syntax shared by the search bar and the palette
const q = (s: string) => all.filter((a) => matchesQuery(a, parseQuery(s))).map((a) => a.id);
assert.deepEqual(q("type:audio"), [3]);
assert.deepEqual(q("type:3d"), []); // a type that matches no asset kind present
assert.deepEqual(parseQuery("type:3d").types, ["model"]);
assert.deepEqual(q("in:sprites"), [1]);
assert.deepEqual(q("#pla"), [1]);
assert.deepEqual(q("size:>1mb"), [2]);
assert.deepEqual(q("size:<2kb"), [1, 3]);
assert.deepEqual(q("tex t.tga"), [2]);
assert.deepEqual(q("sfx"), [3]); // an exact tag also matches as plain text
assert.deepEqual(q("rating:3"), [2]);
assert.deepEqual(q("rating:>=3"), [1, 2]);
assert.deepEqual(q("rating:>3"), [1]);
assert.deepEqual(q("rating:<3"), [3]);
assert.deepEqual(q("type：audio"), [3]); // full-width operators, as Japanese and Chinese input methods type them
assert.deepEqual(q("＃pla size：＞1mb"), []);
assert.deepEqual(q("size：＞1mb"), [2]);
assert.deepEqual(q("rating:<=3 type:image"), [2]);
assert.deepEqual(q("rating:0"), [3]); // unrated
assert.deepEqual(q("rating:9"), [1, 2, 3]); // not a rating: ignored, like a bad size:
const notes = { 2: "Needs a 2x version", 3: "Too loud, REDO" };
const qn = (s: string) => all.filter((a) => matchesQuery(a, parseQuery(s), notes)).map((a) => a.id);
assert.deepEqual(qn("note:redo"), [3]);
assert.deepEqual(qn("note:2x note:version"), [2]);
assert.deepEqual(qn("note:missing"), []);
assert.deepEqual(qn("note:"), [1, 2, 3]); // an empty note: is ignored, like in:
assert.deepEqual(q("note:redo"), []); // no notes given
const qa = (s: string) => [...all, music, unread].filter((a) => matchesQuery(a, parseQuery(s))).map((a) => a.id);
assert.deepEqual(qa("dur:<2s"), [3]);
assert.deepEqual(qa("dur:>30s"), [4]);
assert.deepEqual(qa("dur:90"), [4]); // seconds by default, no operator = at least
assert.deepEqual(qa("dur:>1m dur:<2m"), [4]);
assert.deepEqual(qa("dur:<1500ms"), [3]);
assert.deepEqual(qa("dur:>0s type:audio"), [3, 4]); // unknown lengths never match a dur: limit
assert.deepEqual(parseQuery("dur:abc").text, []); // malformed tokens are ignored, as with size:
assert.deepEqual([parseQuery("dur:<2.5s").maxMs, parseQuery("dur:2.5s").minMs], [2500, 2500]);

// Colour: the sprite is mostly red with a dark outline; the texture is blue with a speck of red; the sound has none.
const palettes = new Map([
  [1, toLab([[230, 30, 30, 80], [20, 20, 20, 20]])],
  [2, toLab([[30, 90, 220, 95], [255, 0, 0, 5]])],
]);
const qc = (s: string) => all.filter((a) => matchesQuery(a, parseQuery(s), {}, palettes)).map((a) => a.id);
assert.deepEqual(qc("color:red"), [1]);
assert.deepEqual(qc("color:re"), [1]); // the start of a name
assert.deepEqual(qc("color:blue"), [2]); // 5% red doesn't count as a main colour
assert.deepEqual(qc("color:black color:red"), [1]);
assert.deepEqual(qc("color:#2060e0"), [2]); // close to its blue
assert.deepEqual(qc("color:#00ff00"), []);
assert.deepEqual(qc("color:nope"), []); // not a colour: matches nothing
assert.deepEqual(q("color:red"), []); // colours not loaded
assert.deepEqual(parseQuery("color:grey color:#F80 color:").colors, ["gray", "#ff8800"]);
assert.deepEqual(all.filter((a) => matchesFilters(a, f({ color: "blue" }), now, palettes)).map((a) => a.id), [2]);
assert.equal(activeFilterCount(f({ color: "#ff8800" })), 1);

// Views, sorting, grouping
const scope = (o: Partial<Scope>): Scope => ({ view: "library", kinds: [], folder: null, subfolders: true, query: "", filters: noFilters, collection: null, notes: {}, ...o });
assert.deepEqual(visibleAssets(all, scope({ view: "favorites" }), { key: "name", desc: false }).map((a) => a.id), [1]);
assert.deepEqual(visibleAssets(all, scope({ folder: { rootId: 1, path: "pack" } }), { key: "name", desc: false }).map((a) => a.id), [1]);
assert.deepEqual(visibleAssets(all, scope({ view: "collections", collection: { id: 1, name: "c", assetIds: [3, 2], rule: null } }), { key: "name", desc: false }).map((a) => a.id), [3, 2]);
// Inside a collection, the type chips, search and Filters panel narrow its members; the library's folder doesn't.
const manual = { id: 1, name: "c", assetIds: [1, 2, 3], rule: null };
const inCol = (o: Partial<Scope>) => visibleAssets(all, scope({ view: "collections", collection: manual, ...o }), null).map((a) => a.id);
assert.deepEqual(inCol({ folder: { rootId: 1, path: "pack" } }), [1, 2, 3]);
assert.deepEqual(visibleAssets(all, scope({ view: "duplicates", folder: { rootId: 1, path: "pack" } }), null).length, 3); // nor Duplicates
assert.deepEqual(inCol({ kinds: ["audio"] }), [3]);
assert.deepEqual(inCol({ query: "type:image" }), [1, 2]);
assert.deepEqual(inCol({ filters: f({ minRating: 5 }) }), [1]);
// Smart collections: members are whatever matches the saved search now; the current search narrows them further.
const smart = (query: string, filters = {}) => ({ id: 2, name: "s", assetIds: [], rule: { query, filters } });
const members = (c: ReturnType<typeof smart>, o: Partial<Scope> = {}) =>
  visibleAssets(all, scope({ view: "collections", collection: c, ...o }), null).map((a) => a.id);
assert.deepEqual(members(smart("rating:>=3"), { kinds: ["audio"] }), []);
assert.deepEqual(members(smart("rating:>=3"), { query: "type:image" }), [1, 2]);
assert.deepEqual(members(smart("rating:>=3")), [1, 2]);
assert.deepEqual(members(smart("", { minRating: 5 })), [1]);
assert.deepEqual(members(smart("type:image", { exts: ["tga"] })), [2]);
assert.deepEqual(members(smart("note:loud"), { notes }), [3]);
assert.deepEqual(members(smart("", {})), [1, 2, 3]); // missing filter fields mean "any"
assert.deepEqual(ruleMembers(smart("#env").rule, all, {}, now).map((a) => a.id), [2]);
// Smart collections can save a colour, as a color: word or the Filters panel's colour.
assert.deepEqual(members(smart("color:red"), { palettes }), [1]);
assert.deepEqual(members(smart("", { color: "blue" }), { palettes }), [2]);
assert.deepEqual(ruleMembers(smart("color:blu").rule, all, {}, now, palettes).map((a) => a.id), [2]);
// Only colour rules make the members depend on the colour data.
assert.equal(rulesWantColors([smart("rating:>=3"), { ...smart(""), rule: null }]), false);
assert.equal(rulesWantColors([smart("color:red")]), true);
assert.equal(rulesWantColors([smart("", { color: "blue" })]), true);
// "Find similar" shows only its results, closest first, whatever the sort.
assert.deepEqual(visibleAssets(all, scope({ similar: [3, 1] }), { key: "name", desc: false }).map((a) => a.id), [3, 1]);
assert.deepEqual(visibleAssets(all, scope({ similar: [3, 1], kinds: ["image"] }), { key: "name", desc: false }).map((a) => a.id), [1]);
// Search by meaning: only scored images, best first whatever the sort, cut to MEANING_SPREAD below the best in the set.
const byName = { key: "name", desc: false } as const;
const seen = (list: { id: number }[]) => list.map((a) => a.id);
assert.deepEqual(seen(visibleAssets(all, scope({ meaning: new Map([[1, 0.12], [2, 0.15]]) }), byName)), [2, 1]);
const apart = new Map([[1, 0.12], [2, 0.2]]);
assert.deepEqual(seen(visibleAssets(all, scope({ meaning: apart }), byName)), [2]);
assert.deepEqual(seen(visibleAssets(all, scope({ meaning: apart }), null)), [2], "the type chips' counts are cut the same way");
// The best is taken after the other filters, so a folder or filter gets its own best matches.
assert.deepEqual(seen(visibleAssets(all, scope({ meaning: apart, folder: { rootId: 1, path: "pack" } }), byName)), [1]);
assert.deepEqual(seen(visibleAssets(all, scope({ meaning: apart, filters: f({ minRating: 4 }) }), byName)), [1]);
assert.deepEqual(seen(visibleAssets(all, scope({ meaning: apart, query: "tex" }), byName)), [2]);
assert.deepEqual(seen(visibleAssets(all, scope({ meaning: apart, kinds: ["audio"] }), byName)), []);
assert.deepEqual(seen(visibleAssets(all, scope({ meaning: new Map() }), byName)), [], "nothing indexed shows nothing");
const many = Array.from({ length: MEANING_TOP + 50 }, (_, i) => asset({ id: 100 + i }));
const close = new Map(many.map((a, i) => [a.id, 0.1 + i * 1e-5]));
const top = visibleAssets(many, scope({ meaning: close }), byName);
assert.equal(top.length, MEANING_TOP);
assert.equal(top[0].id, 100 + MEANING_TOP + 49);

// `looks:` words: the same cut, from the scores the store has for each phrase (hyphens are spaces).
assert.deepEqual(parseQuery("looks:Red-Potion--icon looks: looks:- type:image").looks, ["red potion icon"]);
const looks = new Map([
  ["red potion", new Map([[1, 0.15], [2, 0.08], [3, 0.12]])],
  ["stone", new Map([[1, 0.12], [2, 0.14]])],
]);
const ql = (query: string, o: Partial<Scope> = {}) => seen(visibleAssets(all, scope({ query, looks, ...o }), byName));
assert.deepEqual(ql("looks:red-potion"), [1, 3], "best first, cut 0.05 below the best");
assert.deepEqual(ql("looks:red-potion type:image"), [1], "the other words narrow it first");
assert.deepEqual(ql("looks:red-potion", { filters: f({ exts: ["tga", "ogg"] }) }), [3, 2], "so do the Filters panel, and the best is taken after them");
assert.deepEqual(ql("looks:red-potion tex"), [2], "a folder or name gets its own best match");
assert.deepEqual(ql("looks:red-potion looks:stone"), [1], "every phrase must keep it");
assert.deepEqual(ql("looks:dragon"), [], "a phrase not scored yet, or with search by meaning off, matches nothing");
assert.deepEqual(ql("looks:red-potion", { looks: null }), []);
assert.deepEqual(seen(visibleAssets(all, scope({ query: "looks:red-potion", looks }), null)), [1, 3], "the type chips' counts are cut the same way");
assert.deepEqual(all.filter((a) => matchesQuery(a, parseQuery("looks:stone"), {}, null, looks)).map((a) => a.id), [1, 2], "matchesQuery only needs a score");
// In smart collections: members are the rule's best matches among everything, whatever the view's search narrows.
const potions = smart("looks:red-potion");
assert.deepEqual(ruleMembers(potions.rule, all, {}, now, null, looks).map((a) => a.id), [1, 3]);
assert.deepEqual(members(potions, { looks }), [1, 3], "best first in the collection too");
assert.deepEqual(members(potions, { looks, query: "type:audio" }), [3]);
assert.deepEqual(members(potions), [], "not scored: no members");
assert.deepEqual([...smartMembers([potions, { ...smart("looks:stone type:image"), id: 3 }], all, {}, null, looks).values()].map((l) => l.map((a) => a.id)), [[1, 3], [2, 1]]);
assert.deepEqual(ruleLooks([potions, smart("color:red"), { ...smart(""), rule: null }, smart("looks:a looks:b-c")]), ["red potion", "a", "b c"]);
const sorted = visibleAssets([sound, texture, sprite], scope({}), { key: "size", desc: true });
assert.deepEqual(sorted.map((a) => a.id), [2, 3, 1]); // ties keep input order
assert.deepEqual(groupByFolder(sorted, [{ id: 1, path: "/games/lib" }]).map((g) => [g.label, g.items.length]), [["audio", 1], ["pack/sprites", 1], ["tex", 1]]);
console.log("filter tests passed");
