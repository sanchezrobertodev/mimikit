// Run with `node --experimental-strip-types src/lib/ply.test.ts` (part of `make check`).
import assert from "node:assert/strict";
import { plyHasFaces } from "./ply.ts";

const ply = (header: string, body = "") =>
  new TextEncoder().encode(`ply\r\nformat ascii 1.0\r\n${header}end_header\r\n${body}`).buffer;

// A mesh has faces, also one PLYLoader un-indexes (a colour per face).
assert.equal(plyHasFaces(ply("element vertex 3\nproperty float x\nelement face 1\nproperty uchar red\n")), true);
// A scan has no face element, or an empty one.
assert.equal(plyHasFaces(ply("element vertex 3\nproperty float x\n")), false);
assert.equal(plyHasFaces(ply("element vertex 3\nelement face 0\n")), false);
// Only the header counts, not data after it that reads like one.
assert.equal(plyHasFaces(ply("element vertex 1\n", "element face 5\n")), false);

console.log("ply tests passed");
