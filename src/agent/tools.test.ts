// node --experimental-strip-types src/agent/tools.test.ts (part of `make check`).
// src-tauri/agent-tools.json is the relay's copy of TOOLS, so `mimikit mcp` can list the tools while Mimikit is closed.
// After changing a tool, rewrite it with: UPDATE_TOOLS=1 node --experimental-strip-types src/agent/tools.test.ts
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { isChange, TOOLS } from "./tools.ts";

const file = new URL("../../src-tauri/agent-tools.json", import.meta.url);
const current = `${JSON.stringify(TOOLS, null, 2)}\n`;
if (process.env.UPDATE_TOOLS) writeFileSync(file, current);
assert.equal(
  readFileSync(file, "utf8").replace(/\r\n/g, "\n"),
  current,
  "src-tauri/agent-tools.json is out of date: run UPDATE_TOOLS=1 node --experimental-strip-types src/agent/tools.test.ts",
);

const READS = ["overview", "search", "get_assets", "similar", "related", "view", "list_tags", "list_collections", "read_text", "show"];
const CHANGES = ["tag", "rate", "favorite", "note", "collect", "copy_to_folder", "batch"];
assert.deepEqual(
  TOOLS.map((t) => t.name),
  [...READS, ...CHANGES],
);
for (const t of TOOLS) {
  assert.ok(t.description.length > 40, `${t.name} has a description`);
  assert.equal(t.inputSchema.type, "object", `${t.name} takes an object`);
  assert.equal(t.inputSchema.additionalProperties, false, `${t.name} refuses unknown fields`);
  // A tool that changes the library needs "Allow changes" first (run.ts gate), and says so to the agent app.
  assert.equal(t.annotations.readOnlyHint, READS.includes(t.name), `${t.name} says whether it changes anything`);
  assert.equal(isChange(t.name), CHANGES.includes(t.name));
  if (isChange(t.name)) assert.match(t.description, /Allow changes/, `${t.name} says it needs Allow changes`);
}
// Only copy_to_folder adds without replacing anything; batch takes the changes Undo can take back, so not copies.
assert.deepEqual(
  TOOLS.filter((t) => t.annotations.destructiveHint === false).map((t) => t.name),
  ["copy_to_folder"],
);
assert.deepEqual(TOOLS.find((t) => t.name === "batch")!.inputSchema.properties!.changes.items!.properties!.tool.enum, ["tag", "rate", "favorite", "note", "collect"]);
// search by meaning: search says how to use looks: and the error it gives while that's off; overview says where it stands.
assert.match(TOOLS.find((t) => t.name === "search")!.description, /`looks:red-potion-icon`.*not_indexed/);
assert.match(TOOLS.find((t) => t.name === "overview")!.description, /search by meaning/);
console.log(`tools: ${TOOLS.length} tools, agent-tools.json up to date`);
