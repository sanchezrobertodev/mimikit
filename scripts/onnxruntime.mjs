#!/usr/bin/env node
// Puts ONNX Runtime's CPU library on Mimikit's releases, where search by meaning downloads it (meaning.rs `RUNTIME`).
//
//   node scripts/onnxruntime.mjs <new folder>           download Microsoft's archives, check them against GitHub's
//                                                       digests, take out each library, print its size and SHA-256
//   node scripts/onnxruntime.mjs <new folder> --upload  and publish them as the pre-release onnxruntime-<version>
//
// Run again on the same folder, it keeps the archives that still match their digests.
//
// The libraries are Microsoft's, unchanged; only their names change. The release is a pre-release and never "Latest":
// the updater reads releases/latest/download/latest.json. Its files are never replaced, since installed apps pin
// their hashes; a new runtime version gets a new release.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const VERSION = "1.31.1";
const UPSTREAM = "microsoft/onnxruntime";
const RELEASES_REPO = "sanchezrobertodev/mimikit";
const TAG = `onnxruntime-${VERSION}`;
const PLATFORMS = [
  { id: "win-x64", archive: `onnxruntime-win-x64-${VERSION}.zip`, member: /\/lib\/onnxruntime\.dll$/, name: `onnxruntime-${VERSION}-win-x64.dll` },
  // The real files; the archives' libonnxruntime.dylib and .so are links to them.
  { id: "osx-arm64", archive: `onnxruntime-osx-arm64-${VERSION}.tgz`, member: /\/lib\/libonnxruntime\.\d+\.\d+\.\d+\.dylib$/, name: `libonnxruntime-${VERSION}-osx-arm64.dylib` },
  { id: "linux-x64", archive: `onnxruntime-linux-x64-${VERSION}.tgz`, member: /\/lib\/libonnxruntime\.so\.\d+\.\d+\.\d+$/, name: `libonnxruntime-${VERSION}-linux-x64.so` },
];
// The MIT licence and the notices for what ONNX Runtime includes, published next to the libraries.
const NOTICES = [
  { member: /^[^/]+\/LICENSE$/, name: `onnxruntime-${VERSION}-LICENSE.txt` },
  { member: /^[^/]+\/ThirdPartyNotices\.txt$/, name: `onnxruntime-${VERSION}-ThirdPartyNotices.txt` },
];
// Windows' own tar reads .zip as well; the one Git Bash puts first on PATH doesn't. shortcut: elsewhere, `tar` must be
// bsdtar (macOS has it) for the .zip.
const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const args = process.argv.slice(2);
const upload = args.includes("--upload");
const dirArg = args.find((a) => !a.startsWith("--"));
if (!dirArg) fail("Usage: node scripts/onnxruntime.mjs <new folder> [--upload]");
const dir = resolve(dirArg);
// Downloads are untrusted until checked: they go in a folder of their own (or one this script made).
const ours = new Set(["x", ...PLATFORMS.flatMap((p) => [p.archive, p.name]), ...NOTICES.map((n) => n.name)]);
if (existsSync(dir) && readdirSync(dir).some((f) => !ours.has(f))) fail(`${dir} has other files in it. Give a new folder.`);
mkdirSync(dir, { recursive: true });

run("gh", ["auth", "status"], { quiet: true });
const upstream = JSON.parse(run("gh", ["api", `repos/${UPSTREAM}/releases/tags/v${VERSION}`], { quiet: true }));
const out = [];
for (const p of PLATFORMS) {
  const asset = upstream.assets.find((a) => a.name === p.archive);
  if (!asset) fail(`${UPSTREAM} v${VERSION} has no ${p.archive}.`);
  if (!/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? "")) fail(`GitHub lists no SHA-256 for ${p.archive}, so it can't be checked.`);
  const archive = join(dir, p.archive);
  if (!existsSync(archive) || `sha256:${sha256(archive)}` !== asset.digest) {
    console.log(`Downloading ${p.archive} (${(asset.size / 1e6).toFixed(1)} MB)…`);
    run("gh", ["release", "download", `v${VERSION}`, "--repo", UPSTREAM, "--pattern", p.archive, "--dir", dir, "--clobber"]);
  }
  if (`sha256:${sha256(archive)}` !== asset.digest) fail(`${p.archive} doesn't match GitHub's digest ${asset.digest}.`);
  const members = run(TAR, ["-tf", archive], { quiet: true }).split(/\r?\n/);
  out.push({ ...p, file: extract(archive, members, p.member, p.name) });
  // The notices are the same in every archive; taken from the first.
  if (p === PLATFORMS[0]) for (const n of NOTICES) out.push({ name: n.name, file: extract(archive, members, n.member, n.name) });
}

console.log("\nFor src-tauri/src/meaning.rs RUNTIME:");
for (const o of out.filter((o) => o.id)) console.log(`  ${o.id}: sha256: "${sha256(o.file)}", size: ${statSync(o.file).size},`);

if (upload) {
  const exists = spawnSync("gh", ["release", "view", TAG, "--repo", RELEASES_REPO], { encoding: "utf8" });
  if (exists.status === 0) fail(`${TAG} already exists on ${RELEASES_REPO}; its files are pinned by installed apps, so they stay.`);
  const notes = [
    `ONNX Runtime ${VERSION}'s CPU library, unchanged from Microsoft's release (https://github.com/${UPSTREAM}/releases/tag/v${VERSION}); only the file names differ.`,
    "Mimikit's search by meaning downloads it on first use and checks it against the SHA-256 built into the app.",
    `MIT licence: ${NOTICES[0].name}. Not a Mimikit release.`,
  ].join("\n\n");
  run("gh", [
    "release", "create", TAG, "--repo", RELEASES_REPO, "--prerelease", "--latest=false",
    "--title", `ONNX Runtime ${VERSION} for search by meaning`, "--notes", notes,
    ...out.map((o) => o.file),
  ]);
  console.log(`Published https://github.com/${RELEASES_REPO}/releases/tag/${TAG}`);
}

function extract(archive, members, re, name) {
  const found = members.filter((m) => re.test(m));
  if (found.length !== 1) fail(`Expected one ${re} in ${archive}, found ${found.length}.`);
  const into = join(dir, "x");
  mkdirSync(into, { recursive: true });
  run(TAR, ["-xf", archive, "-C", into, found[0]], { quiet: true });
  copyFileSync(join(into, found[0]), join(dir, name));
  return join(dir, name);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(cmd, argv, { quiet = false } = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 << 20, stdio: quiet ? "pipe" : ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) fail(`${cmd} ${argv.join(" ")} failed${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
  return r.stdout ?? "";
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
