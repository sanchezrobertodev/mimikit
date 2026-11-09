// Run with `node --experimental-strip-types src/lib/ask.test.ts` (part of `make check`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Asset } from "../types";
import { askPrompt, badWords, EXAMPLES, LOOKS_EXAMPLES, topTags } from "./ask.ts";
import { KIND_NAMES, parseQuery } from "./filter.ts";

const prompt = askPrompt(["ui", "player"]);
// With search by meaning on, the prompt also has looks:.
const meaningPrompt = askPrompt(["ui", "player"], true);
const backticked = (p: string) => [...p.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
// Every search the prompt shows the model, in backticks, is one the parser reads in full.
const shown = backticked(prompt);
assert.ok(shown.length > 20);
for (const s of [...shown, ...backticked(meaningPrompt)]) assert.deepEqual(badWords(s), [], `the prompt shows "${s}", which doesn't parse`);

// Every operator parseQuery knows is in the prompt, so a new one can't be left out of it; looks: only when it can search.
const ops = [...readFileSync(new URL("./filter.ts", import.meta.url), "utf8").matchAll(/t\.startsWith\("([^"]+)"\)/g)].map((m) => m[1]);
assert.deepEqual(ops, ["type:", "in:", "#", "size:", "dur:", "rating:", "note:", "color:", "looks:"]);
for (const op of ops) assert.ok(backticked(meaningPrompt).some((s) => s.startsWith(op)), `the prompt has no example of ${op}`);
for (const op of ops.slice(0, -1)) assert.ok(shown.some((s) => s.startsWith(op)), `the prompt without search by meaning has no example of ${op}`);
assert.ok(!prompt.includes("looks:"), "without search by meaning, the prompt doesn't mention looks:");
for (const k of Object.keys(KIND_NAMES)) assert.ok(shown.includes(`type:${k}`), `the prompt doesn't list type:${k}`);

// What the prompt says about defaults is what the parser does.
assert.ok(prompt.includes("a number alone is kb") && parseQuery("size:1").minBytes === 1024);
assert.ok(prompt.includes("a number alone is seconds") && parseQuery("dur:1").minMs === 1000);
assert.ok(prompt.includes("m is minutes") && parseQuery("dur:>1m").minMs === 60_000);
assert.ok(prompt.includes("0 is unrated") && parseQuery("rating:0").maxRating === 0);

// The examples mean what their words say.
const ex = Object.fromEntries(EXAMPLES.map(([w, q]) => [w.split(" (")[0], parseQuery(q)]));
assert.deepEqual(ex["short laser sounds"].types, ["audio"]);
assert.equal(ex["short laser sounds"].maxMs, 2000);
assert.equal(ex["music tracks longer than 3 minutes"].minMs, 180_000);
assert.equal(ex["low poly tree models under 1 MB"].maxBytes, 1024 * 1024);
assert.deepEqual(ex["red potion icons I rated highly"].colors, ["red"]);
assert.equal(ex["red potion icons I rated highly"].minRating, 4);
assert.deepEqual(ex["everything in my kenney folder tagged ui"].tags, ["ui"]);
assert.deepEqual(ex["sprites I noted to redo"].notes, ["redo"]);
assert.deepEqual(ex["ui buttons"].tags, []); // a tag's name as a plain word, since the request isn't about tags

// With search by meaning on, requests that describe pictures become looks: searches, replacing the plain-word examples.
const lx = Object.fromEntries(LOOKS_EXAMPLES.map(([w, q]) => [w, parseQuery(q)]));
assert.deepEqual(lx["red potion icons I rated highly"].looks, ["red potion icon"]);
assert.deepEqual(lx["red potion icons I rated highly"].text, []);
assert.equal(lx["red potion icons I rated highly"].minRating, 4);
assert.deepEqual(lx["poción roja"].looks, ["poción roja"]);
assert.equal(lx["dark forest tileset in my kenney folder"].folder, "kenney");
for (const [w, q] of LOOKS_EXAMPLES) assert.ok(meaningPrompt.includes(`- "${w}" → \`${q}\``) && !prompt.includes(`\`${q}\``), w);
assert.ok(!meaningPrompt.includes("`type:image potion color:red rating:>=4`"), "the plain-word example with the same words is left out");
assert.ok(meaningPrompt.includes("`type:audio laser dur:<2s`"), "the others stay");

// Tags go in as data, JSON-quoted; without tags the prompt says not to use #.
assert.ok(askPrompt(['say "hi"']).includes(String.raw`["say \"hi\""]`));
assert.ok(askPrompt([]).includes("no tags yet"));

// A reply with words the parser would drop, or that can't match, isn't run.
assert.deepEqual(badWords("type:audio forest dur:>1m"), []);
assert.deepEqual(badWords(" #ui  color:#ff8800 "), []);
assert.deepEqual(badWords("rating:9 type:sound width:<64 color:nope size:big # in: note: icon"), ["rating:9", "type:sound", "width:<64", "color:nope", "size:big", "#", "in:", "note:"]);
assert.deepEqual(badWords("type：audio"), []); // full-width colon, as parseQuery reads it
assert.deepEqual(badWords("type:image looks:dark-forest-tileset looks: looks:--"), ["looks:", "looks:--"]);

// The most used tags first, ties by name.
const a = (tags: string[]) => ({ tags }) as Asset;
assert.deepEqual(topTags([a(["sfx", "ui"]), a(["ui"]), a(["env", "sfx"])]), ["sfx", "ui", "env"]);
assert.deepEqual(topTags([a(["b"]), a(["a"])], 1), ["a"]);
console.log("ask tests passed");
