import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type { Swatch } from "./lib/colors";
import type { AssetsDelta } from "./lib/delta";
import { t, translateError } from "./lib/i18n";
import type { AiPrefs } from "./lib/prefs";
import type { TaggingStatus, TagModel } from "./lib/tagging";
import type { AnalysisStatus, Asset, Collection, CollectionRule, DupGroup, MeaningStatus, Notes, Root, ScanProgress, SpriteSheet, TextPreview } from "./types";

export interface AppUpdate {
  version: string;
  currentVersion: string;
  date: string | null;
  notes: string | null;
}

export interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

/** The update found by the last check, kept for installing. */
let pendingUpdate: Update | null = null;

export const api = {
  listRoots: () => invoke<Root[]>("list_roots"),
  addRoot: (path: string) => invoke<Root>("add_root", { path }),
  removeRoot: (id: number) => invoke<void>("remove_root", { id }),
  /** How many of a sample of the folder's files are at `path`. */
  checkRelink: (id: number, path: string) => invoke<{ found: number; checked: number }>("check_relink", { id, path }),
  relinkRoot: (id: number, path: string) => invoke<Root>("relink_root", { id, path }),
  rescan: (id: number) => invoke<void>("rescan", { id }),
  /** Every asset, with the number of the last delta it includes. */
  listAssets: () => invoke<{ seq: number; assets: Asset[] }>("list_assets"),
  thumbnail: (id: number) => invoke<string | null>("thumbnail", { id }),
  /** Saves a thumbnail rendered from `a` as it was when rendering started; refused if the file has changed since. */
  saveThumbnail: (a: Asset, png: Uint8Array) =>
    invoke<string>("save_thumbnail", { id: a.id, size: a.size, mtime: a.mtime, png: Array.from(png) }),
  preview: (id: number) => invoke<string>("preview", { id }),
  /** A WAV copy of a sound the webview can't play (AIFF), converted by the backend on first request. */
  playableAudio: (id: number) => invoke<string>("playable_audio", { id }),
  readText: (id: number) => invoke<TextPreview>("read_text", { id }),
  setFavorite: (ids: number[], favorite: boolean) => invoke<void>("set_favorite", { ids, favorite }),
  setRating: (ids: number[], rating: number) => invoke<void>("set_rating", { ids, rating }),
  listNotes: () => invoke<Notes>("list_notes"),
  /** Returns the note as stored: trimmed, or null when cleared. */
  setNote: (id: number, note: string) => invoke<string | null>("set_note", { id, note }),
  addTag: (ids: number[], tag: string) => invoke<string>("add_tag", { ids, tag }),
  removeTag: (ids: number[], tag: string) => invoke<void>("remove_tag", { ids, tag }),
  getSpriteSheet: (id: number) => invoke<SpriteSheet | null>("get_sprite_sheet", { id }),
  setSpriteSheet: (id: number, sheet: SpriteSheet) => invoke<void>("set_sprite_sheet", { id, sheet }),
  listCollections: () => invoke<Collection[]>("list_collections"),
  createCollection: (name: string, rule: CollectionRule | null = null) => invoke<number>("create_collection", { name, rule }),
  setCollectionRule: (id: number, rule: CollectionRule) => invoke<void>("set_collection_rule", { id, rule }),
  deleteCollection: (id: number) => invoke<void>("delete_collection", { id }),
  setInCollection: (collection: number, ids: number[], member: boolean) =>
    invoke<void>("set_in_collection", { collection, ids, member }),
  renameCollection: (id: number, name: string) => invoke<string>("rename_collection", { id, name }),
  copyCollection: (ids: number[], dest: string) => invoke<{ copied: number; failed: string[] }>("copy_collection", { ids, dest }),
  /** Cuts a sprite sheet's frames into PNGs in `dest`; existing files are never replaced. */
  exportFrames: (id: number, cols: number, rows: number, skipEmpty: boolean, dest: string) =>
    invoke<{ written: number; failed: string[]; first: string | null }>("export_frames", { id, cols, rows, skipEmpty, dest }),
  findDuplicates: () => invoke<DupGroup[]>("find_duplicates"),
  /** Dominant colours of every analysed image; later ones come with onImageFeatures. */
  imageColors: () => invoke<[number, Swatch[]][]>("image_colors"),
  /** Analysed images whose hash is within `maxDistance` bits of `id`'s, closest first. */
  findSimilar: (id: number, maxDistance: number) => invoke<number[]>("find_similar", { id, maxDistance }),
  analysisStatus: () => invoke<AnalysisStatus>("analysis_status"),
  /** Analyses every image that isn't yet (or resumes a paused pass); progress comes with onAnalysisStatus. */
  analyseImages: () => invoke<void>("analyse_images"),
  pauseAnalysis: (paused: boolean) => invoke<void>("pause_analysis", { paused }),
  /** Stops the pass; what it analysed so far is kept. */
  cancelAnalysis: () => invoke<void>("cancel_analysis"),
  setKeepAnalysed: (on: boolean) => invoke<void>("set_keep_analysed", { on }),
  meaningStatus: () => invoke<MeaningStatus>("meaning_status"),
  /** Turns search by meaning on: downloads what's missing, then indexes every asset it can; progress comes with onMeaningStatus. */
  meaningEnable: () => invoke<void>("meaning_enable"),
  pauseMeaning: (paused: boolean) => invoke<void>("meaning_pause", { paused }),
  /** Stops the download or the pass; what's downloaded and indexed so far is kept. */
  cancelMeaning: () => invoke<void>("meaning_cancel"),
  /** Turns it off; `deleteFiles` also deletes the model and the index. */
  meaningDisable: (deleteFiles: boolean) => invoke<void>("meaning_disable", { delete: deleteFiles }),
  /** Every indexed asset's score for `text`: little-endian pairs of an i32 id and an f32 score. */
  meaningScores: (text: string) => invoke<ArrayBuffer>("meaning_scores", { text }),
  /** Find related: every other indexed asset's score for asset `id`, as in meaningScores. */
  meaningRelated: (id: number) => invoke<ArrayBuffer>("meaning_related", { id }),
  /** The window draws the previews search by meaning asks for (onMeaningPreview) from now on. */
  meaningWindow: () => invoke<void>("meaning_window"),
  /** Answers onMeaningPreview: asset `id`'s preview is drawn, or couldn't be. */
  meaningDrawn: (id: number) => invoke<void>("meaning_drawn", { id }),
  setDuplicateIgnored: (hash: string, ignored: boolean) => invoke<void>("set_duplicate_ignored", { hash, ignored }),
  trashDuplicates: (keep: number, remove: number[]) => invoke<number>("trash_duplicates", { keep, remove }),
  reveal: (id: number) => invoke<void>("reveal", { id }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  openDefault: (id: number) => invoke<void>("open_default", { id }),
  dragIcon: () => invoke<string>("drag_icon"),
  /** Folder names skipped while scanning, on top of the built-in ones (hidden folders, node_modules, sidecars). */
  ignoredFolders: () => invoke<string[]>("ignored_folders"),
  /** Saves the list and returns it cleaned; takes effect on the next rescan. */
  setIgnoredFolders: (names: string[]) => invoke<string[]>("set_ignored_folders", { names }),
  /** Bytes used by the app's own thumbnail and preview caches. */
  cacheSize: () => invoke<number>("cache_size"),
  clearThumbnailCache: () => invoke<void>("clear_thumbnail_cache"),
  /** Saves a copy of the library (not the asset files) into `dest`; returns the new file's path. */
  backupLibrary: (dest: string) => invoke<string>("backup_library", { dest }),
  /** Folder of the automatic backups and the copies saved before a restore. */
  backupsFolder: () => invoke<string>("backups_folder"),
  /** Checks the backup, then restarts the app to replace the library with it. The current one is saved first. */
  restoreLibrary: (path: string) => invoke<void>("restore_library", { path }),
  /** True once after a launch that restored a backup; rejects if restoring failed. */
  restoreResult: () => invoke<boolean>("restore_result"),
  pickBackup: async (defaultPath: string) => {
    const picked = await open({
      title: t("api.restoreTitle"),
      defaultPath,
      multiple: false,
      directory: false,
      filters: [{ name: t("api.backupFilter"), extensions: ["db"] }],
    });
    return typeof picked === "string" ? picked : null;
  },
  openLink: (link: "releases" | "source" | "ko-fi" | "anthropic-keys" | "vc-redist") => invoke<void>("open_link", { link }),
  /** Whether an Anthropic API key is stored. The key itself never comes to the window. */
  apiKeyStatus: () => invoke<boolean>("api_key_status"),
  setApiKey: (key: string) => invoke<void>("set_api_key", { key }),
  removeApiKey: () => invoke<void>("remove_api_key"),
  /** Ask: Claude turns `words` into a search, following `prompt` (lib/ask.ts). Check the query before running it. */
  askSearch: (prompt: string, words: string, { model, effort }: AiPrefs) =>
    invoke<{ query: string; inputTokens: number; outputTokens: number }>("ask_search", { prompt, words, model, effort }),
  /** Suggest tags: sends `ids` to Claude in batches, following `prompt` (lib/tagging.ts); returns how many went. */
  suggestTags: (prompt: string, ids: number[], model: TagModel, batch: boolean) =>
    invoke<number>("suggest_tags", { prompt, ids, model, effort: "low", batch }),
  /** Of `ids`, the ones Claude was already asked about (this version of the file) or that wait in a batch. */
  taggingAsked: (ids: number[]) => invoke<number[]>("tagging_asked", { ids }),
  taggingStatus: () => invoke<TaggingStatus>("tagging_status"),
  cancelTagging: () => invoke<void>("cancel_tagging"),
  /** Makes suggestions of `ids` real tags: those named in `tags`, or all of them. */
  acceptSuggestions: (ids: number[], tags?: string[]) => invoke<void>("accept_suggestions", { ids, tags: tags ?? null }),
  rejectSuggestions: (ids: number[], tags?: string[]) => invoke<void>("reject_suggestions", { ids, tags: tags ?? null }),
  aiTagCount: () => invoke<number>("ai_tag_count"),
  /** Removes every tag accepted from a suggestion; returns how many. */
  removeAiTags: () => invoke<number>("remove_ai_tags"),
  /** Saves the line of text `a` (a font) drew, which Suggest tags sends as its preview. */
  saveFontSample: (a: Asset, png: Uint8Array) =>
    invoke<void>("save_font_sample", { id: a.id, size: a.size, mtime: a.mtime, png: Array.from(png) }),
  pickFolder: async (title = t("api.importTitle")) => {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  },
  /** A scan or a batch of file events finished; its changes came before as deltas. */
  onAssetsChanged: (cb: () => void): Promise<UnlistenFn> => listen("assets-changed", () => cb()),
  onAssetsDelta: (cb: (d: AssetsDelta) => void): Promise<UnlistenFn> => listen<AssetsDelta>("assets-delta", (e) => cb(e.payload)),
  /** Images were analysed (by a pass, or as their thumbnails were shown): their colours. */
  onImageFeatures: (cb: (colors: [number, Swatch[]][]) => void): Promise<UnlistenFn> =>
    listen<[number, Swatch[]][]>("image-features", (e) => cb(e.payload)),
  onAnalysisStatus: (cb: (s: AnalysisStatus) => void): Promise<UnlistenFn> => listen<AnalysisStatus>("analysis-status", (e) => cb(e.payload)),
  onMeaningStatus: (cb: (s: MeaningStatus) => void): Promise<UnlistenFn> => listen<MeaningStatus>("meaning-status", (e) => cb(e.payload)),
  /** Search by meaning wants the preview of a model, video or font it's indexing: draw it, then meaningDrawn. */
  onMeaningPreview: (cb: (a: Pick<Asset, "id" | "path" | "ext" | "kind" | "size" | "mtime">) => void): Promise<UnlistenFn> =>
    listen<Pick<Asset, "id" | "path" | "ext" | "kind" | "size" | "mtime">>("meaning-preview", (e) => cb(e.payload)),
  onTaggingStatus: (cb: (s: TaggingStatus) => void): Promise<UnlistenFn> => listen<TaggingStatus>("tagging-status", (e) => cb(e.payload)),
  /** Requests finished so far in a Suggest tags run sent right away. */
  onTaggingDirect: (cb: (done: number) => void): Promise<UnlistenFn> => listen<number>("tagging-direct", (e) => cb(e.payload)),
  onScanProgress: (cb: (p: ScanProgress) => void): Promise<UnlistenFn> =>
    listen<ScanProgress>("scan-progress", (e) => cb(e.payload)),
  /** False on platforms the release feed doesn't cover yet; the app then hides updates entirely. */
  appUpdatesSupported: () => invoke<boolean>("app_updates_supported"),
  /** Asks the release feed for a newer, signed version of Mimikit. null when up to date. */
  checkAppUpdate: async (): Promise<AppUpdate | null> => {
    const update = await check();
    void pendingUpdate?.close().catch(() => {});
    pendingUpdate = update;
    if (!update) return null;
    return { version: update.version, currentVersion: update.currentVersion, date: update.date ?? null, notes: update.body ?? null };
  },
  /** Downloads, verifies and installs the pending update, then restarts. On Windows the installer closes the app itself. */
  installAppUpdate: async (onProgress: (p: DownloadProgress) => void) => {
    if (!pendingUpdate) throw new Error(t("api.noUpdate"));
    const progress: DownloadProgress = { downloaded: 0, total: null };
    await pendingUpdate.downloadAndInstall((e) => {
      if (e.event === "Started") progress.total = e.data.contentLength ?? null;
      else if (e.event === "Progress") progress.downloaded += e.data.chunkLength;
      onProgress({ ...progress });
    });
    await relaunch();
  },
  /** Copy-mode drag, so dropping onto a folder never moves the original. */
  drag: (paths: string[], icon: string) => startDrag({ item: paths, icon, mode: "copy" }),
};

/**
 * Asset-protocol URL for a local file, keeping "/" between path segments so relative references inside the file
 * (glTF buffers, OBJ materials, FBX textures) resolve against its folder.
 */
export function fileUrl(path: string): string {
  const base = convertFileSrc("");
  const norm = path.replaceAll("\\", "/");
  const segments = norm.split("/").map(encodeURIComponent);
  // A leading "/" (macOS/Linux) must survive as %2F: the protocol drops the first "/" of the URL path.
  return norm.startsWith("/") ? base + "%2F" + segments.slice(1).join("/") : base + segments.join("/");
}

/** {@link fileUrl} for this version of an asset, so the webview loads it again after the file changes. */
export const assetUrl = (a: Asset) => `${fileUrl(a.path)}?v=${a.mtime}-${a.size}`;

/** Where a sound plays from: its file, or for AIFF (kind::needs_wav) a WAV copy the webview can play. */
export const audioUrl = async (a: Asset) =>
  a.ext === "aif" || a.ext === "aiff" ? convertFileSrc(await api.playableAudio(a.id)) : fileUrl(a.path);

/** An error as text for the user; backend messages in the UI language when locales/en/errors.json knows them. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return translateError(e);
  if (e instanceof Error) return translateError(e.message);
  return JSON.stringify(e);
}
