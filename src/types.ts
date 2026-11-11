import type { Filters } from "./lib/filter";

export type Kind = "image" | "audio" | "model" | "font" | "video" | "text" | "other";

export const KINDS: Kind[] = ["image", "audio", "model", "font", "video", "text", "other"];

export interface Asset {
  id: number;
  rootId: number;
  relPath: string;
  /** Absolute path with the OS separator. */
  path: string;
  name: string;
  ext: string;
  kind: Kind;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
  width: number | null;
  height: number | null;
  favorite: boolean;
  tags: string[];
  /** Tags Claude suggested that wait for the user to accept or reject them. */
  suggested: string[];
  /** 0 (unrated) to 5 stars. */
  rating: number;
  /** Audio details from the file header; null when unknown or not audio. */
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** Bit depth; lossy formats have none. */
  bits: number | null;
}

/** How an image is sliced into animation frames, remembered per asset. */
export interface SpriteSheet {
  cols: number;
  rows: number;
  fps: number;
}

export interface Root {
  id: number;
  path: string;
  /** The folder couldn't be reached when the roots were listed. */
  missing: boolean;
}

/** A smart collection's saved search. Missing filter fields mean "any", so older rules keep working. */
export interface CollectionRule {
  query: string;
  filters: Partial<Filters>;
}

export interface Collection {
  id: number;
  name: string;
  /** Empty for a smart collection, whose members are whatever matches `rule` now. */
  assetIds: number[];
  rule: CollectionRule | null;
}

/** Asset notes by asset id; only assets that have one. */
export type Notes = Record<number, string>;

export interface DupGroup {
  hash: string;
  ids: number[];
}

/** Image analysis (Find similar, search by colour): how far it got, and the pass the user started. */
export interface AnalysisStatus {
  /** Images analysed, including ones that couldn't be read. */
  done: number;
  /** Images that can be analysed. */
  total: number;
  /** A pass with a progress line is running. */
  running: boolean;
  paused: boolean;
  /** "Keep new and changed images analysed". */
  keep: boolean;
}

/** Search by meaning: the offline model's download and the index of assets it can search. */
export interface MeaningStatus {
  /** Assets indexed, including ones that couldn't be read or drawn. */
  done: number;
  /** Assets that can be indexed: decodable images, models, videos and fonts. */
  total: number;
  /** A pass with a progress line is running (downloading or indexing). */
  running: boolean;
  paused: boolean;
  on: boolean;
  /** The model and runtime are downloaded and checked. */
  installed: boolean;
  /** Bytes downloaded so far, while downloading. */
  download: { done: number; total: number } | null;
  /** Why the last pass stopped, if it failed. */
  error: string | null;
  /** What turning it on downloads; empty where search by meaning isn't available. */
  files: { name: string; size: number; source: "huggingface" | "github" }[];
  /** False on Windows without the Visual C++ runtime ONNX Runtime needs. */
  vcRuntime: boolean;
  /** Bytes downloaded so far, finished files or not. */
  downloaded: number;
  /** The model's id, e.g. "siglip2-b32-256". */
  model: string;
}

export interface ScanProgress {
  rootId: number;
  count: number;
  done: boolean;
  /** The root folder couldn't be read (an unplugged drive, a renamed folder), so its assets were kept as they were. */
  missing: boolean;
}

export interface TextPreview {
  text: string;
  truncated: boolean;
}

export type ViewName = "home" | "library" | "favorites" | "collections" | "duplicates" | "insights" | "ai";

/** Limits the library to one folder: a whole root (path "") or a folder inside it. */
export interface FolderFilter {
  rootId: number;
  path: string;
}
