// The window's side of the agent bridge (Settings › AI agents). The backend listens for the `mimikit mcp` relays that
// agent apps start and hands each tool call here (event "agent-call"). The call is checked against the apps the user
// allowed, asking "Allow …?" the first time; run.ts runs it on the library this window holds; `agent_reply` answers.
// Changes need the app's "Allow changes"; each one lands in the activity list (`activity`) with an Undo.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { create } from "zustand";
import { api, assetUrl, fileUrl } from "../api";
import { holdFont } from "../lib/fonts";
import { t } from "../lib/i18n";
import { thumbnailFor } from "../lib/thumbs";
import { useStore } from "../store";
import type { Asset } from "../types";
import { agentName, cleanAgent, errorResult, gate, runTool, undoable, undoSteps, type Agent, type Io, type Made, type Session, type Step, type ToolResult } from "./run.ts";

const KEY = "mimikit.agents.v1";
/** How long a call waits for the user's "Allow?": under the backend's 120 s, so the agent hears why. */
const ASK_MS = 100_000;
/** Changes the activity list keeps. */
const KEEP = 50;
/** How often the connected list checks that its relays still run. */
const PRUNE_MS = 10_000;

interface Saved {
  on: boolean;
  /** Agent apps the user let in, by the name they give (e.g. "claude-code"). */
  allowed: string[];
  /** Allowed apps the user also lets change the library ("Allow changes"). */
  writers: string[];
}

function load(): Saved {
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x: unknown) => typeof x === "string") : []);
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { on: v.on === true, allowed: names(v.allowed), writers: names(v.writers) };
  } catch {
    return { on: false, allowed: [], writers: [] };
  }
}

function save({ on, allowed, writers }: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ on, allowed, writers }));
  } catch {
    // Not saved: the switch is off again on the next launch.
  }
}

/** An "Allow …?" waiting for the user: one per agent app, for every relay of it that asked meanwhile. */
export interface Question {
  name: string;
  version: string;
  pids: number[];
}

/** One call's changes in the activity list ("What agents did"). */
export interface Change extends Made {
  id: number;
  steps: Step[];
  undone: boolean;
  /** Takes it back, once: the activity list's Undo, the toast's and Ctrl+Z all run this. None for copies. */
  undo?: () => Promise<void>;
}

interface AgentsState extends Saved {
  /** This program's path, for the setup commands. */
  exe: string | null;
  /** Relays that made a call, in the order they first did. */
  sessions: Session[];
  /** Relays the user disconnected or didn't allow, until Mimikit restarts. */
  blocked: number[];
  questions: Question[];
  /** The last changes agents made since Mimikit started, newest first. */
  activity: Change[];
  setOn: (on: boolean) => Promise<void>;
  answer: (name: string, allow: boolean) => void;
  /** Lets an allowed app in again only after asking. */
  forget: (name: string) => void;
  /** Pauses a relay's changes; it can still read. */
  pause: (pid: number, paused: boolean) => void;
  disconnect: (pid: number) => void;
  /** "Allow changes" for an allowed app. */
  setWriter: (name: string, on: boolean) => void;
  /** Undoes the newest change that can still be undone. */
  undoLast: () => void;
}

/** Calls waiting on each app's question; each is told when it's answered or the switch goes off. */
const waiting = new Map<string, (() => void)[]>();
function release(name: string) {
  for (const done of waiting.get(name) ?? []) done();
  waiting.delete(name);
}

export const useAgents = create<AgentsState>((set, get) => ({
  ...load(),
  exe: null,
  sessions: [],
  blocked: [],
  questions: [],
  activity: [],
  setOn: async (on) => {
    try {
      const exe = await invoke<string>("set_agent_bridge", { on });
      // Off forgets the apps allowed so far, so on again asks each one anew.
      set(on ? { on, exe } : { on, exe, allowed: [], writers: [], sessions: [], questions: [] });
      save(get());
      if (!on) for (const name of [...waiting.keys()]) release(name);
    } catch (e) {
      useStore.getState().setError(e);
    }
  },
  answer: (name, allow) => {
    const q = get().questions.find((x) => x.name === name);
    set((s) => ({
      questions: s.questions.filter((x) => x.name !== name),
      ...(allow ? { allowed: [...new Set([...s.allowed, name])] } : { blocked: [...s.blocked, ...(q?.pids ?? [])] }),
    }));
    save(get());
    release(name);
  },
  forget: (name) => {
    set((s) => ({ allowed: s.allowed.filter((x) => x !== name), writers: s.writers.filter((x) => x !== name) }));
    save(get());
  },
  pause: (pid, paused) => set((s) => ({ sessions: s.sessions.map((x) => (x.pid === pid ? { ...x, paused } : x)) })),
  disconnect: (pid) => set((s) => ({ sessions: s.sessions.filter((x) => x.pid !== pid), blocked: [...s.blocked, pid] })),
  setWriter: (name, on) => {
    set((s) => ({ writers: on ? [...new Set([...s.writers, name])] : s.writers.filter((x) => x !== name) }));
    save(get());
  },
  undoLast: () => {
    const c = get().activity.find((x) => x.undo && !x.undone);
    if (c) useStore.getState().undo(c.undo);
  },
}));

let changeSeq = 0;
/** Every app's changes of the last minute, for the per-minute limit: the activity list keeps only the last KEEP. */
let made: Made[] = [];

/** Undoes change `id`, once: marked undone first so a second Undo meanwhile does nothing, and unmarked if it fails. */
async function undoChange(id: number) {
  const c = useAgents.getState().activity.find((x) => x.id === id);
  if (!c || c.undone) return;
  const mark = (undone: boolean) => useAgents.setState((s) => ({ activity: s.activity.map((x) => (x.id === id ? { ...x, undone } : x)) }));
  mark(true);
  try {
    await undoSteps(c.steps, { library, write });
  } catch (e) {
    mark(false);
    throw e;
  }
}

/** Keeps `agent`'s change in the activity list and shows it, with Undo (Ctrl+Z too) when it can be undone. */
function record(agent: Agent, steps: Step[]) {
  const id = ++changeSeq;
  const undo = undoable(steps) ? () => undoChange(id) : undefined;
  const at = Date.now();
  made = [...made.filter((c) => at - c.at < 60_000), { by: agent.name, at }];
  useAgents.setState((s) => ({ activity: [{ id, by: agent.name, at, steps, undone: false, undo }, ...s.activity].slice(0, KEEP) }));
  const name = agentName(agent.name);
  useStore
    .getState()
    .showToast(steps.length === 1 ? t("agents.toast", { name, what: describe(steps[0]) }) : t("agents.toastMany", { name, count: steps.length }), undo);
}

const stars = (n: number) => (n ? "★".repeat(n) : t("agents.did.unrated"));
const quote = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);

/** A step as one line of the activity list, with the values it replaced. */
export function describe(s: Step): string {
  switch (s.do) {
    case "tag":
      return t(s.add ? "agents.did.tagged" : "agents.did.untagged", { count: s.ids.length, tag: s.tag });
    case "rate": {
      const before = new Map<number, number>();
      for (const [, r] of s.before) before.set(r, (before.get(r) ?? 0) + 1);
      const was = [...before].map(([r, n]) => `${stars(r)} ×${n}`).join(", ");
      return t(s.rating ? "agents.did.rated" : "agents.did.ratingCleared", { count: s.before.length, stars: stars(s.rating), before: was });
    }
    case "favorite":
      return t(s.favorite ? "agents.did.favorited" : "agents.did.unfavorited", { count: s.ids.length });
    case "note": {
      const name = useStore.getState().assets.find((a) => a.id === s.id)?.name ?? t("store.unnamedAsset");
      const vars = { name, after: quote(s.after), before: quote(s.before) };
      return t(!s.after ? "agents.did.noteCleared" : s.before ? "agents.did.noteChanged" : "agents.did.noteAdded", vars);
    }
    case "create":
      return t(s.smart ? "agents.did.madeSmart" : "agents.did.made", { name: s.name });
    case "member":
      return t(s.add ? "agents.did.added" : "agents.did.removed", { count: s.ids.length, collection: s.name });
    case "copy":
      return [t("agents.did.copied", { count: s.copied, folder: s.folder }), s.failed ? t("agents.did.copyFailed", { count: s.failed }) : ""].filter(Boolean).join("; ");
  }
}

/** Waits until the user answers `agent`'s app's question: false if they haven't in time. */
function ask(agent: Agent): Promise<boolean> {
  return new Promise((resolve) => {
    const list = waiting.get(agent.name) ?? [];
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiting.set(agent.name, (waiting.get(agent.name) ?? []).filter((x) => x !== done));
      resolve(false);
    }, ASK_MS);
    waiting.set(agent.name, [...list, done]);
    const { questions } = useAgents.getState();
    const q = questions.find((x) => x.name === agent.name);
    useAgents.setState({
      questions: q
        ? questions.map((x) => (x === q ? { ...x, pids: [...new Set([...x.pids, agent.pid])] } : x))
        : [...questions, { name: agent.name, version: agent.version, pids: [agent.pid] }],
    });
    if (!q) void getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {});
  });
}

async function decide(agent: Agent, tool: string, args: unknown): Promise<ToolResult> {
  let g = gate(agent, { ...useAgents.getState(), made }, tool);
  if (g === "ask") {
    if (!(await ask(agent)))
      return errorResult("no_answer", "The user hasn't answered Mimikit's question yet: whether to let your app see their library.", "Ask the user to answer it in Mimikit's window, then try again.");
    g = gate(agent, { ...useAgents.getState(), made }, tool);
    if (g === "ask") return errorResult("not_running", "The user turned AI agents off in Mimikit.", "Don't retry unless the user turns them on again.");
  }
  if (g !== "run") return g;
  useAgents.setState((s) => {
    const old = s.sessions.find((x) => x.pid === agent.pid);
    // A paused relay still reads, and stays paused.
    const now = { ...agent, calls: (old?.calls ?? 0) + 1, last: Date.now(), paused: old?.paused ?? false };
    return { sessions: old ? s.sessions.map((x) => (x === old ? now : x)) : [...s.sessions, now] };
  });
  return runTool(tool, args, io(agent));
}

let started = false;

/** Forgets relays that have exited: their place in the connected list, and a block that a new relay could inherit with a reused pid. */
async function prune() {
  const { sessions, blocked } = useAgents.getState();
  const pids = [...new Set([...sessions.map((x) => x.pid), ...blocked])].filter((p) => p > 0 && p < 2 ** 32);
  if (!pids.length) return;
  const alive = new Set(await invoke<number[]>("relays_alive", { pids }));
  // Only the pids checked: a relay that called meanwhile stays.
  const gone = new Set(pids.filter((p) => !alive.has(p)));
  if (gone.size) useAgents.setState((s) => ({ sessions: s.sessions.filter((x) => !gone.has(x.pid)), blocked: s.blocked.filter((p) => !gone.has(p)) }));
}

/** Listens for agent calls and turns the bridge on if it was on. Off also removes an endpoint file left by a crash. */
export async function startAgents() {
  if (started) return;
  started = true;
  setInterval(() => void prune().catch(() => {}), PRUNE_MS);
  await listen<{ id: number; call: { tool?: unknown; args?: unknown; agent?: unknown } }>("agent-call", ({ payload: { id, call } }) => {
    void decide(cleanAgent(call.agent), String(call.tool), call.args)
      .catch(() => errorResult("internal", "Mimikit couldn't finish this call.", "Try again. If it keeps failing, tell the user."))
      .then((result) => invoke("agent_reply", { id, result }))
      .catch(() => {});
  });
  const { on } = useAgents.getState();
  try {
    useAgents.setState({ exe: await invoke<string>("set_agent_bridge", { on }) });
  } catch (e) {
    useAgents.setState({ on: false });
    useStore.getState().setError(e);
  }
}

const library = () => {
  const { assets, roots, collections, notes, analysis, meaning } = useStore.getState();
  return { assets, roots, collections, notes, analysis, meaning };
};

/** Patches the window's copy of the assets after a backend write, as the store's own actions do. */
const patch = (ids: number[], f: (a: Asset) => Asset) => {
  const s = new Set(ids);
  useStore.setState((st) => ({ assets: st.assets.map((a) => (s.has(a.id) ? f(a) : a)) }));
};
const reloadCollections = async () => {
  const collections = await api.listCollections();
  useStore.setState((s) => ({ collections, colSel: collections.some((c) => c.id === s.colSel) ? s.colSel : (collections[0]?.id ?? null) }));
};

// The backend calls the store's actions make, without their toasts (a change shows one of its own) and throwing on
// failure, so the agent hears it.
const write: Io["write"] = {
  tag: async (ids, tag, add) => {
    if (!add) {
      await api.removeTag(ids, tag);
      patch(ids, (a) => ({ ...a, tags: a.tags.filter((x) => x !== tag) }));
      return tag;
    }
    const saved = await api.addTag(ids, tag);
    patch(ids, (a) => (a.tags.includes(saved) ? a : { ...a, tags: [...a.tags, saved].sort() }));
    return saved;
  },
  rate: async (ids, rating) => {
    await api.setRating(ids, rating);
    patch(ids, (a) => ({ ...a, rating }));
  },
  favorite: async (ids, favorite) => {
    await api.setFavorite(ids, favorite);
    patch(ids, (a) => ({ ...a, favorite }));
  },
  note: async (id, note) => {
    const saved = (await api.setNote(id, note)) ?? "";
    useStore.setState((s) => {
      const notes = { ...s.notes };
      if (saved) notes[id] = saved;
      else delete notes[id];
      return { notes };
    });
    return saved;
  },
  create: async (name, rule) => {
    const id = await api.createCollection(name, rule);
    await reloadCollections();
    return id;
  },
  member: async (collection, ids, member) => {
    await api.setInCollection(collection, ids, member);
    await reloadCollections();
  },
  remove: async (collection) => {
    await api.deleteCollection(collection);
    await reloadCollections();
  },
  copy: async (ids, folder) => {
    const r = await api.copyCollection(ids, folder);
    return { copied: r.copied, failed: r.failed.length };
  },
};

function io(agent: Agent): Io {
  return {
    library,
    write,
    record: (steps) => record(agent, steps),
    // shortcut: a load the window started a moment ago answers without colours, until it lands.
    palettes: async () => {
      await useStore.getState().loadPalettes();
      return useStore.getState().palettes;
    },
    looks: (phrases) => useStore.getState().resolveLooks("agent", phrases),
    sheet: api.getSpriteSheet,
    similar: api.findSimilar,
    text: api.readText,
    pictures,
    show: (ids) => {
      useStore.getState().showAssets(ids, agentName(agent.name));
      void getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {});
    },
  };
}

// ---------- pictures for `view` ----------

/** Formats the webview shows natively, as in Viewers.tsx; the rest get a PNG preview from the backend. */
const NATIVE_IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);
const CELL = 160;
const GAP = 6;
const BIG = 512;

function image(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // the asset protocol is another origin; without this the canvas can't be read
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = url;
  });
}

/** What to draw for `a`: the image itself for a big picture, else its thumbnail; null for kinds without one. */
async function source(a: Asset, big: boolean): Promise<HTMLImageElement | null> {
  try {
    if (a.kind === "image" && big) return await image(NATIVE_IMAGE.has(a.ext) ? assetUrl(a) : convertFileSrc(await api.preview(a.id)));
    if (a.kind !== "image" && a.kind !== "video" && a.kind !== "model") return null;
    const path = await thumbnailFor(a);
    return path ? await image(convertFileSrc(path)) : null;
  } catch {
    return null;
  }
}

/** A font's family name once it's loaded, and the function that lets it go. */
function font(a: Asset): Promise<{ family: string | null; release: () => void }> {
  return new Promise((resolve) => {
    const release = holdFont(a, fileUrl(a.path), (family) => resolve({ family, release: () => release() }));
  });
}

/** Draws `a` into the `size` square at x, y: on a checkerboard, so transparency shows. */
async function drawAsset(ctx: CanvasRenderingContext2D, a: Asset, x: number, y: number, size: number, big: boolean) {
  for (let i = 0; i < size; i += 10)
    for (let j = 0; j < size; j += 10) {
      ctx.fillStyle = (i + j) % 20 ? "#d6d6d6" : "#f2f2f2";
      ctx.fillRect(x + i, y + j, Math.min(10, size - i), Math.min(10, size - j));
    }
  const img = await source(a, big);
  if (img) {
    const w = img.naturalWidth || size;
    const h = img.naturalHeight || size;
    const scale = Math.min(size / w, size / h);
    ctx.imageSmoothingEnabled = scale < 1; // pixel art scales up crisp
    ctx.drawImage(img, x + (size - w * scale) / 2, y + (size - h * scale) / 2, w * scale, h * scale);
    return;
  }
  // No picture: the font's own letters, or the type in this file's words (never the file's name).
  const f = a.kind === "font" ? await font(a) : null;
  ctx.fillStyle = "#555";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = f?.family ? `${Math.round(size * 0.32)}px "${f.family}"` : `600 ${Math.round(size * 0.12)}px system-ui, sans-serif`;
  ctx.fillText(f?.family ? "Aa" : a.kind, x + size / 2, y + size / 2);
  f?.release();
}

function png(canvas: HTMLCanvasElement) {
  return canvas.toDataURL("image/png").split(",")[1];
}

/** Base64 PNGs for `view`: one contact sheet numbered like its legend, or one picture per asset. */
async function pictures(assets: Asset[], layout: "sheet" | "thumbnails"): Promise<string[]> {
  if (layout === "thumbnails") {
    return Promise.all(
      assets.map(async (a) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = BIG;
        await drawAsset(canvas.getContext("2d")!, a, 0, 0, BIG, true);
        return png(canvas);
      }),
    );
  }
  const cols = Math.min(4, assets.length);
  const rows = Math.ceil(assets.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = cols * CELL + (cols + 1) * GAP;
  canvas.height = rows * CELL + (rows + 1) * GAP;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [i, a] of assets.entries()) {
    const x = GAP + (i % cols) * (CELL + GAP);
    const y = GAP + Math.floor(i / cols) * (CELL + GAP);
    await drawAsset(ctx, a, x, y, CELL, false);
    ctx.fillStyle = "rgba(0,0,0,.78)";
    ctx.beginPath();
    ctx.roundRect(x + 4, y + 4, 28, 20, 5);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), x + 18, y + 14.5);
  }
  return [png(canvas)];
}
