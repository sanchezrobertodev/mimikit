// Run with `node --experimental-strip-types src/lib/folders.test.ts` (part of `make check`).
import assert from "node:assert/strict";
import type { Asset } from "../types";
import { groupByFolder, noFilters, visibleAssets, type Scope } from "./filter.ts";
import { ancestorKeys, buildTree, parentOf, pathTo } from "./folders.ts";
import { differingParts, rootLabel } from "./format.ts";

const asset = (id: number, relPath: string, size = 10, rootId = 1): Asset => ({
  id,
  rootId,
  relPath,
  path: `/r/${relPath}`,
  name: relPath.split("/").pop()!,
  ext: "png",
  kind: "image",
  size,
  mtime: 0,
  width: null,
  height: null,
  favorite: false,
  tags: [],
  rating: 0,
  durationMs: null,
  sampleRate: null,
  channels: null,
  bits: null,
});
const roots = [
  { id: 1, path: "C:\\games\\game-assets", missing: false },
  { id: 2, path: "/home/me/sample-lib", missing: false },
];
const all = [
  asset(1, "characters/hero/idle/a.png"),
  asset(2, "characters/hero/idle/b.png"),
  asset(3, "characters/hero/run/c.png"),
  asset(4, "characters/hero/palette.png"),
  asset(5, "characters/enemies/slime.png"),
  asset(6, "readme.png"),
  asset(7, "x.png", 10, 2),
];

const tree = buildTree(all, roots);
assert.deepEqual(tree.map((t) => [t.name, t.count]), [["game-assets", 6], ["sample-lib", 1]]);
const hero = pathTo(tree, { rootId: 1, path: "characters/hero" }).at(-1)!;
assert.equal(hero.count, 4);
assert.equal(hero.bytes, 40);
assert.deepEqual(hero.children.map((c) => [c.name, c.count]), [["idle", 2], ["run", 1]]);
assert.deepEqual(tree[0].children.map((c) => c.name), ["characters"]);
assert.deepEqual(pathTo(tree, { rootId: 1, path: "nope" }).map((n) => n.name), ["game-assets"]);
assert.deepEqual(pathTo(tree, { rootId: 1, path: "characters/hero/run" }).map((n) => n.name), ["game-assets", "characters", "hero", "run"]);
assert.deepEqual(ancestorKeys({ rootId: 1, path: "characters/hero" }), ["1:", "1:characters", "1:characters/hero"]);
assert.deepEqual(parentOf({ rootId: 1, path: "characters/hero" }), { rootId: 1, path: "characters" });
assert.deepEqual(parentOf({ rootId: 1, path: "characters" }), { rootId: 1, path: "" });

// Include subfolders on and off
const scope = (o: Partial<Scope>): Scope => ({ view: "library", kinds: [], folder: null, subfolders: true, query: "", filters: noFilters, collection: null, ...o });
const ids = (o: Partial<Scope>) => visibleAssets(all, scope(o), { key: "name", desc: false }).map((a) => a.id);
assert.deepEqual(ids({ folder: { rootId: 1, path: "characters/hero" } }), [1, 2, 3, 4]);
assert.deepEqual(ids({ folder: { rootId: 1, path: "characters/hero" }, subfolders: false }), [4]);
assert.deepEqual(ids({ folder: { rootId: 1, path: "" }, subfolders: false }), [6]);
assert.deepEqual(ids({ folder: { rootId: 2, path: "" } }), [7]);

// Group labels start at the open folder's name
const base = { rootId: 1, path: "characters/hero" };
const groups = groupByFolder(visibleAssets(all, scope({ folder: base }), { key: "name", desc: false }), roots, base);
assert.deepEqual(groups.map((g) => g.label), ["hero", "hero/idle", "hero/run"]);

// Two library folders with the same name get the parent that tells them apart
const twins = [
  { id: 1, path: "C:\\D&D\\packages\\assets\\files" },
  { id: 2, path: "C:/D&D/apps/web/src/audio/files" },
  { id: 3, path: "/home/me/x/files" },
  { id: 4, path: "/home/you/x/files/" },
  { id: 5, path: "D:\\sprites" },
];
assert.deepEqual(twins.map((r) => rootLabel(twins, r.id)), ["files · assets", "files · audio", "files · me", "files · you", "sprites"]);
assert.equal(rootLabel(twins, 99), "");
// Duplicate groups show where copies differ: shared leading folders go, each keeps at least its last part.
assert.deepEqual(differingParts(["library/models/3ds/", "library/models/collada/tex maps/crate.png"]), ["3ds/", "collada/tex maps/crate.png"]);
assert.deepEqual(differingParts(["lib/sprites/", "lib/sprites/b.png", "lib/sprites/"]), ["sprites/", "sprites/b.png", "sprites/"]);
assert.deepEqual(differingParts(["audio/", "art/x/"]), ["audio/", "art/x/"]);
const twinGroups = groupByFolder([asset(1, "a.png", 1, 1), asset(2, "art/b.png", 1, 1), asset(3, "c.png", 1, 2)], twins.slice(0, 2));
assert.deepEqual(twinGroups.map((g) => g.label), ["files · assets", "files · assets/art", "files · audio"]);
console.log("folder tests passed");
