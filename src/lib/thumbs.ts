// Thumbnails, scheduled so the cards on screen load first (see scheduler.ts) and cached per file version.

import type { WebGLRenderer } from "three";
import { api, fileUrl } from "../api";
import type { Asset } from "../types";
import { holdFont } from "./fonts";
import { createScheduler } from "./scheduler.ts";

const cachedOr = (render: (a: Asset) => Promise<string | null> | null) => (a: Asset) =>
  api
    .thumbnail(a.id)
    .then((path) => path ?? render(a))
    .catch(() => null);

const thumbs = createScheduler(
  cachedOr(() => null),
  8,
);
// Videos and models get their own short queues: decoding a frame or rendering a model is heavy, and slow ones mustn't
// hold up image thumbnails. Models render one at a time, on one shared renderer.
const videoThumbs = createScheduler(cachedOr(renderVideoThumb), 2);
const modelThumbs = createScheduler(cachedOr(renderModelThumb), 1);

/** Asks for a thumbnail; `onReady` gets its path (null when there's none). Returns a function that withdraws the request. */
export function requestThumbnail(a: Asset, onReady: (path: string | null) => void): () => void {
  const queue = a.kind === "video" ? videoThumbs : a.kind === "model" ? modelThumbs : thumbs;
  return queue.request(`${a.id}:${a.mtime}:${a.size}`, a, onReady);
}

/** After the thumbnail cache is cleared: cards that mount from now on ask the backend again, which rebuilds them. */
export function forgetThumbnails() {
  thumbs.clear();
  videoThumbs.clear();
  modelThumbs.clear();
}

/** Promise form, for one-off uses like the drag icon. */
export function thumbnailFor(a: Asset): Promise<string | null> {
  return new Promise((resolve) => {
    requestThumbnail(a, resolve);
  });
}

// One shared offscreen renderer for model thumbnails (modelThumbs runs one at a time).
let renderer: WebGLRenderer | null = null;

async function renderModelThumb(a: Asset): Promise<string | null> {
  // Loaded on the first model thumbnail so three.js stays out of the startup bundle.
  const [THREE, { addLights, dispose, frame, loadModel }] = await Promise.all([import("three"), import("./models")]);
  // A lost context (a GPU reset, or too many 3D views open) draws nothing: start over with a new renderer.
  if (renderer?.getContext().isContextLost()) {
    renderer.dispose();
    renderer = null;
  }
  renderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(256, 256, false);
  const scene = new THREE.Scene();
  addLights(scene);
  const camera = new THREE.PerspectiveCamera(35, 1);
  const { object } = await loadModel(a, renderer);
  scene.add(object);
  frame(camera, object);
  renderer.render(scene, camera);
  // Never save a blank frame as the thumbnail.
  if (renderer.getContext().isContextLost()) throw new Error("WebGL context lost");
  const blob = await new Promise<Blob | null>((r) => renderer!.domElement.toBlob(r, "image/png"));
  dispose(object);
  if (!blob) return null;
  return api.saveThumbnail(a, new Uint8Array(await blob.arrayBuffer()));
}

const VIDEO_TIMEOUT_MS = 15000;

/** Grabs a frame ~10% in (at most 1 s) with a hidden <video>; null on an unsupported codec, an error or a timeout. */
function renderVideoThumb(a: Asset): Promise<string | null> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous"; // the asset protocol is another origin; without this the canvas can't be read
  const next = (event: string) =>
    new Promise<void>((resolve, reject) => {
      v.addEventListener(event, () => resolve(), { once: true });
      v.addEventListener("error", () => reject(v.error), { once: true });
    });
  const grab = (async () => {
    const loaded = next("loadeddata");
    v.src = fileUrl(a.path);
    await loaded;
    if (!v.videoWidth || !v.videoHeight) return null;
    const seeked = next("seeked");
    v.currentTime = Math.min(1, (v.duration || 0) * 0.1);
    await seeked;
    const scale = Math.min(1, 256 / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    return blob && api.saveThumbnail(a, new Uint8Array(await blob.arrayBuffer()));
  })();
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), VIDEO_TIMEOUT_MS));
  return Promise.race([grab, timeout])
    .catch(() => null)
    .finally(() => {
      // Frees the decoder right away instead of at garbage collection.
      v.removeAttribute("src");
      v.load();
    });
}

/** Draws a line of text in font `a` and saves it as the picture Suggest tags sends; false when the font won't load. */
export function saveFontSample(a: Asset): Promise<boolean> {
  return new Promise((resolve) => {
    const release = holdFont(a, fileUrl(a.path), (family) => {
      void (async () => {
        if (!family) return false;
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 96;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, 256, 96);
        ctx.fillStyle = "#111";
        ctx.textBaseline = "middle";
        ctx.font = `28px "${family}"`;
        ctx.fillText("Aa Bb 123", 12, 30);
        ctx.font = `20px "${family}"`;
        ctx.fillText("The quick brown fox", 12, 70);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
        if (!blob) return false;
        await api.saveFontSample(a, new Uint8Array(await blob.arrayBuffer()));
        return true;
      })()
        .catch(() => false)
        .then((ok) => {
          release();
          resolve(ok);
        });
    });
  });
}
