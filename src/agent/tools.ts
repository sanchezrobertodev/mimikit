// The tools an AI agent can call through `mimikit mcp` (src-tauri/src/mcp.rs), described once, here. The relay lists a
// copy, src-tauri/agent-tools.json, so it can answer while Mimikit is closed; tools.test.ts keeps that copy in step.
// The schemas use a small subset of JSON Schema, and run.ts checks every call against them before running it.

export interface Schema {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  default?: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint: boolean; openWorldHint: false };
}

/**
 * Most ids, rows and characters one call takes or returns. `change`: assets one change (or batch) touches; `batch`:
 * changes in one batch; `perMinute`: changes an app makes in a minute; `copy`: files one copy_to_folder copies.
 */
export const LIMITS = { details: 50, sheet: 16, thumbnails: 4, show: 500, page: 100, tags: 500, readChars: 20_000, change: 500, batch: 20, perMinute: 30, copy: 200 };

const read = (title: string) => ({ title, readOnlyHint: true, idempotentHint: true, openWorldHint: false }) as const;
const write = (title: string, idempotentHint: boolean, destructiveHint = true) =>
  ({ title, readOnlyHint: false, destructiveHint, idempotentHint, openWorldHint: false }) as const;

/** Tools that change the library: they need the user's "Allow changes" for the app (run.ts gate). */
export const isChange = (name: string) => TOOLS.find((t) => t.name === name)?.annotations.readOnlyHint === false;

const CHANGES = `Needs the user's "Allow changes" for your app in Mimikit (Settings › AI agents). Each call is one step in Mimikit's activity list, which the user can undo; for a task of several changes, use batch so one Undo takes it all back. At most ${LIMITS.change} assets per call and ${LIMITS.perMinute} changes a minute.`;
const tagList = (what: string): Schema => ({ type: "array", items: { type: "string", maxLength: 65 }, minItems: 1, maxItems: 20, description: `${what} At most 20.` });
const ids = (max: number, what: string): Schema => ({ type: "array", items: { type: "integer" }, minItems: 1, maxItems: max, description: `${what} At most ${max}.` });
const object = (properties: Record<string, Schema> = {}, required: string[] = []): Schema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const int = (description: string, minimum = 0, maximum?: number): Schema => ({ type: "integer", minimum, ...(maximum !== undefined ? { maximum } : {}), description });

const FILTERS = object({
  exts: { type: "array", items: { type: "string", maxLength: 10 }, maxItems: 50, description: 'File extensions, lowercase without the dot: ["png", "ogg"].' },
  minW: int("Least image width in pixels. Only images whose size is known match any of the four pixel filters."),
  maxW: int("Most image width in pixels."),
  minH: int("Least image height in pixels."),
  maxH: int("Most image height in pixels."),
  square: { type: "boolean", description: "Only images as wide as they are tall." },
  minBytes: int("Least file size in bytes."),
  maxBytes: int("Most file size in bytes."),
  days: int("Only files modified within this many days.", 1),
  untagged: { type: "boolean", description: "Only assets without tags." },
  suggested: { type: "boolean", description: "Only assets with tags Claude suggested that the user hasn't reviewed yet." },
  anyTags: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 50, description: "Only assets with at least one of these tags (exact names, see list_tags)." },
  minRating: int("At least this many stars (1 to 5).", 1, 5),
  minMs: int("Least audio length in milliseconds. Only audio whose length is known matches either length filter."),
  maxMs: int("Most audio length in milliseconds."),
  color: { type: "string", maxLength: 20, description: "A main colour of the image: red, orange, yellow, green, teal, blue, purple, pink, brown, white, gray, black, or #rrggbb." },
});

export const TOOLS: ToolDef[] = [
  {
    name: "overview",
    description:
      "Start here. A summary of the user's Mimikit library of game assets: how many assets of each type, the library folders, the most used tags, the collections, how much of the image analysis (colour search, similar) is done, and whether search by meaning (search's looks:) is on and how many assets it has indexed.",
    inputSchema: object(),
    annotations: read("Library overview"),
  },
  {
    name: "search",
    description: [
      "Find assets with Mimikit's search language, the Filters panel, a sort and pages. Returns short rows (id, name, type, folder, bytes, pixel size or length in seconds); get_assets gives full details and file paths, view shows them.",
      "Query words, all of which must match (case doesn't matter):",
      "- plain words match the folder path and file name, or a whole tag: `coin`, `ui button`",
      "- `type:image` (or audio, model, font, video, text, other)",
      "- `in:sprites` a subfolder's name starts with this (for one library folder, pass folder instead)",
      "- `#player` a tag starts with this",
      "- `size:>1mb`, `size:<200kb` (b, kb, mb, gb)",
      "- `dur:<2s`, `dur:>1m` audio length (ms, s, m)",
      "- `rating:>=4`, `rating:3`",
      "- `note:redo` the user's note on the asset contains this",
      "- `color:red`, `color:#ff8800` a main colour of the image (analysed images only)",
      "- `looks:red-potion-icon` assets that show this, judged from their pictures (an image itself; a 3D model, video or font by its preview), so untagged assets with unhelpful names are found too (Mimikit's search by meaning, indexed assets only): a description with its words joined by hyphens, in any language. Only the closest matches are kept, and rows come best first whatever the sort. Needs search by meaning on (overview's meaningSearch); otherwise the error is not_indexed.",
    ].join("\n"),
    inputSchema: object({
      query: { type: "string", maxLength: 500, description: "Words in the search language above. Empty or left out: everything." },
      filters: { ...FILTERS, description: "The Filters panel. A smart collection's rule.filters from list_collections can be passed as it is." },
      favorites: { type: "boolean", description: "Only the user's favorites." },
      collection: int("Only the assets of this collection (an id from list_collections); for a smart collection, what matches its search now."),
      folder: int("Only the assets in this library folder and its subfolders (an id from overview's folders)."),
      sort: { type: "string", enum: ["name", "kind", "size", "mtime", "folder"], default: "name", description: "Order: name, kind (type), size, mtime (modified) or folder." },
      desc: { type: "boolean", default: false, description: "Largest, newest or last first." },
      limit: { type: "integer", minimum: 1, maximum: LIMITS.page, default: 30, description: `Rows per page, at most ${LIMITS.page}.` },
      offset: { type: "integer", minimum: 0, default: 0, description: "Rows to skip: nextOffset from the previous page." },
    }),
    annotations: read("Search assets"),
  },
  {
    name: "get_assets",
    description:
      "Full details of some assets: the absolute file path (to copy the file or load it in code), size, modified date, pixel size or audio length and format, tags, rating, favorite, the user's note, collections, main colours and sprite-sheet grid.",
    inputSchema: object({ ids: ids(LIMITS.details, "Asset ids from search, similar or view.") }, ["ids"]),
    annotations: read("Asset details"),
  },
  {
    name: "similar",
    description:
      "Images that look like one image, closest first (Mimikit's Find similar): the same picture at another size or with small edits, frames of one animation, tiles of one set. Only analysed images take part; overview says how many are.",
    inputSchema: object(
      {
        id: int("The image to compare with."),
        maxDistance: { type: "integer", minimum: 1, maximum: 24, default: 10, description: "How different they may be: 1 nearly identical, 10 the app's default, 24 loose." },
        limit: { type: "integer", minimum: 1, maximum: LIMITS.page, default: 30, description: `Rows, at most ${LIMITS.page}.` },
      },
      ["id"],
    ),
    annotations: read("Similar images"),
  },
  {
    name: "view",
    description: `Look at assets. layout "sheet" (the default): one contact sheet of up to ${LIMITS.sheet} assets in 160 px cells, numbered in the order of ids, about 40 image tokens per asset: good for comparing and picking. layout "thumbnails": up to ${LIMITS.thumbnails} separate pictures of 512 px, for a closer look. Images, 3D models and videos show their thumbnail, fonts a line of sample text, other types their type.`,
    inputSchema: object(
      {
        ids: ids(LIMITS.sheet, "Assets to look at, in the order to number them."),
        layout: { type: "string", enum: ["sheet", "thumbnails"], default: "sheet", description: "One numbered contact sheet, or one picture per asset." },
      },
      ["ids"],
    ),
    annotations: read("View assets"),
  },
  {
    name: "list_tags",
    description: `Every tag in the library with how many assets have it, most used first (at most ${LIMITS.tags}).`,
    inputSchema: object(),
    annotations: read("List tags"),
  },
  {
    name: "list_collections",
    description:
      "The user's collections: id, name and how many assets each has. A smart collection also gives its saved search (query and filters), which search takes as it is. To list a collection's assets, use search with its id.",
    inputSchema: object(),
    annotations: read("List collections"),
  },
  {
    name: "read_text",
    description: `The text of a text or data file in the library (JSON, TXT, Markdown, XML, CSV, YAML, shaders, scripts…) or of a file without an extension such as LICENSE or README: licences, credits and notes that come with a pack. At most ${LIMITS.readChars.toLocaleString("en")} characters; a longer text is cut, and the answer says so.`,
    inputSchema: object({ id: int("The text file's asset id.") }, ["id"]),
    annotations: read("Read a text file"),
  },
  {
    name: "show",
    description:
      "Show assets to the user: Mimikit's library switches to exactly these assets, in this order, so the user sees what you mean. It replaces the user's current search and filters in the window, and changes nothing in the library.",
    inputSchema: object({ ids: ids(LIMITS.show, "Assets to show.") }, ["ids"]),
    annotations: read("Show in Mimikit"),
  },
  {
    name: "tag",
    description: `Add and remove tags on assets. Use the user's own tags (list_tags) where they fit rather than new spellings. Tags are saved lowercase, 1 to 64 characters, without #. ${CHANGES}`,
    inputSchema: object(
      { ids: ids(LIMITS.change, "Assets to tag."), add: tagList("Tags to add."), remove: tagList("Tags to remove.") },
      ["ids"],
    ),
    annotations: write("Tag assets", true),
  },
  {
    name: "rate",
    description: `Set the star rating of assets, 1 to 5, or 0 to clear it. ${CHANGES}`,
    inputSchema: object({ ids: ids(LIMITS.change, "Assets to rate."), rating: int("Stars: 1 to 5, or 0 for none.", 0, 5) }, ["ids", "rating"]),
    annotations: write("Rate assets", true),
  },
  {
    name: "favorite",
    description: `Mark assets as the user's favorites, or unmark them. ${CHANGES}`,
    inputSchema: object(
      { ids: ids(LIMITS.change, "Assets to change."), favorite: { type: "boolean", description: "true to add to favorites, false to take out." } },
      ["ids", "favorite"],
    ),
    annotations: write("Favorite assets", true),
  },
  {
    name: "note",
    description: `Set the note on one asset (what search's note: finds and the user reads in the side panel). It replaces the asset's note; an empty note clears it. ${CHANGES}`,
    inputSchema: object(
      { id: int("The asset."), note: { type: "string", maxLength: 5000, description: "The new note, at most 5,000 characters." } },
      ["id", "note"],
    ),
    annotations: write("Note on an asset", true),
  },
  {
    name: "collect",
    description: [
      "Make a collection, or add assets to one or take them out.",
      "- New collection: name, and ids in add to put in it.",
      "- New smart collection: name and search. Its assets are whatever matches the search, now and later.",
      "- Change one: collection (an id from list_collections) with add, remove or both. A smart collection's assets follow its search, so they can't be added or removed.",
      "The library's files stay where they are; collections only group them.",
      CHANGES,
    ].join("\n"),
    inputSchema: object({
      name: { type: "string", maxLength: 80, description: "A new collection's name, 1 to 80 characters, not used by another collection." },
      collection: int("An existing collection to change."),
      add: ids(LIMITS.change, "Assets to put in the collection."),
      remove: ids(LIMITS.change, "Assets to take out of the collection."),
      search: {
        ...object({
          query: { type: "string", maxLength: 500, description: "Words in search's language." },
          filters: { ...FILTERS, description: "The Filters panel, as search takes it." },
        }),
        description: "Makes the new collection smart: its saved search, as search takes query and filters.",
      },
    }),
    annotations: write("Make or change a collection", false),
  },
  {
    name: "copy_to_folder",
    description: `Copy asset files into a folder on the user's computer, such as a game project's assets folder. It only copies: the library's files stay as they are, no file is ever replaced, and a name that's taken gets a number (coin (2).png). Programs and scripts that run when opened (.exe, .bat, .ps1, .js…) aren't copied. Needs the user's "Allow changes" for your app; copies can't be undone in Mimikit. At most ${LIMITS.copy} files per call.`,
    inputSchema: object(
      {
        ids: ids(LIMITS.copy, "Assets to copy."),
        folder: { type: "string", maxLength: 1000, description: "The absolute path of an existing folder." },
      },
      ["ids", "folder"],
    ),
    annotations: write("Copy files to a folder", false, false),
  },
  {
    name: "batch",
    description: `Several changes as one step: the user sees one entry in Mimikit's activity list, and one Undo takes all of it back. Each change is { tool, args }, with tool one of tag, rate, favorite, note or collect, and args as that tool takes them. All are checked before any is made, then made in order. At most ${LIMITS.batch} changes and ${LIMITS.change} assets in all. ${CHANGES}`,
    inputSchema: object(
      {
        changes: {
          type: "array",
          minItems: 1,
          maxItems: LIMITS.batch,
          description: `The changes, in order. At most ${LIMITS.batch}.`,
          items: object(
            {
              tool: { type: "string", enum: ["tag", "rate", "favorite", "note", "collect"], description: "The tool to call." },
              args: { type: "object", description: "Its arguments." },
            },
            ["tool", "args"],
          ),
        },
      },
      ["changes"],
    ),
    annotations: write("Several changes as one step", false),
  },
];
