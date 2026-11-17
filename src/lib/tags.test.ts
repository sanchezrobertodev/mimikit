// Run with `node --experimental-strip-types src/lib/tags.test.ts` (part of `make check`).
import assert from "node:assert/strict";
import { groupedTags, likelySame, rulesNaming } from "./tags.ts";

const counts = (o: Record<string, number>) => Object.entries(o).map(([tag, count]) => ({ tag, count }));
const sets = (o: Record<string, number>) => likelySame(counts(o)).map((s) => [s.into, s.tags.map((t) => t.tag)]);

assert.deepEqual(sets({ coin: 3, coins: 12 }), [["coins", ["coins", "coin"]]], "into the most used");
assert.deepEqual(sets({ "sound-effect": 3, sound_effect: 2, "sound effect": 1 }), [["sound-effect", ["sound-effect", "sound_effect", "sound effect"]]]);
assert.deepEqual(sets({ enemy: 1, enemies: 4, box: 1, boxes: 1, glass: 1, glasses: 1, bush: 2, bushes: 1 }), [
  ["box", ["box", "boxes"]],
  ["bush", ["bush", "bushes"]],
  ["enemies", ["enemies", "enemy"]],
  ["glass", ["glass", "glasses"]],
]);
// Three letters or fewer keep their s, so "bus" meets "buses" and not "bu".
assert.deepEqual(sets({ player: 9, players: 0, bus: 1, buses: 2, bu: 1, gas: 1, ga: 1 }), [["buses", ["buses", "bus"]], ["player", ["player", "players"]]]);
assert.deepEqual(sets({ tree: 1, rock: 2, water: 3, rocket: 1 }), [], "unrelated tags");

const groups = [
  { id: 2, name: "Style", tags: ["low-poly", "pixel-art"] },
  { id: 1, name: "Biome", tags: ["forest"] },
  { id: 3, name: "Empty", tags: [] },
];
const sections = groupedTags(["pixel-art", "tree", "forest", "low-poly", "rock"], groups);
assert.deepEqual(
  sections.map((s) => [s.group?.name ?? null, s.tags]),
  [
    ["Style", ["pixel-art", "low-poly"]],
    ["Biome", ["forest"]],
    ["Empty", []],
    [null, ["tree", "rock"]],
  ],
  "the groups' order, each in the order given, ungrouped last",
);

const rule = (query: string, anyTags?: string[]) => ({ id: 1, name: "c", assetIds: [], rule: { query, filters: anyTags ? { anyTags } : {} } });
const collections = [rule("#coin type:image"), rule("#coins"), rule("", ["coin"]), rule("\uff03Coin"), { id: 9, name: "plain", assetIds: [1], rule: null }];
assert.equal(rulesNaming(collections, ["coin"]), 3);
assert.equal(rulesNaming(collections, ["coin", "coins"]), 4);
assert.equal(rulesNaming(collections, ["gold"]), 0);
console.log("tags tests passed");
