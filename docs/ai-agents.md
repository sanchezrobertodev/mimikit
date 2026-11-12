# AI agents (MCP)

Mimikit can let an AI agent app on your computer search your library and look at your assets: any app that runs
[MCP](https://modelcontextprotocol.io) servers, such as Claude Code, Claude Desktop, Cursor or VS Code. Ask it things
like "find a coin sprite and tell me its path" or "which of my packs has a pixel font?". Agents only read until you
turn on **Allow changes** for an app. Then it can also tag and rate assets, mark favorites, write notes, make
collections and copy files into a folder, and each change can be undone. Agents can never move, rename or delete your
files.

Nothing goes online through Mimikit. The agent app starts `mimikit mcp`, the same program with no window, which talks
to the Mimikit you have open on the same computer. What the tools return goes to your agent app and from there to its
model: that part is up to the agent app.

## Set it up

1. In Mimikit, turn on **Settings → General → AI features**, then **Settings → AI → Let AI agents see your
   library**. Settings then shows the commands below with the path of your copy of Mimikit filled in, each with
   **Copy**.
2. Connect your agent app, once:

   **Claude Code**

   ```bash
   claude mcp add --scope user mimikit -- "C:\Users\<you>\AppData\Local\Mimikit\mimikit.exe" mcp
   ```

   `--scope user` makes Mimikit available in every project; leave it out to add it to the current project only. On
   macOS the program is `/Applications/Mimikit.app/Contents/MacOS/mimikit`; on Linux, the AppImage or
   `/usr/bin/mimikit`.

   **Claude Desktop, Cursor and other apps with an `mcpServers` file**: add this to it, then restart the app. Claude
   Desktop's is `claude_desktop_config.json` (Settings › Developer › Edit Config); Cursor's is `~/.cursor/mcp.json`
   for every project, or `.cursor/mcp.json` for one:

   ```json
   {
     "mcpServers": {
       "mimikit": {
         "command": "C:\\Users\\<you>\\AppData\\Local\\Mimikit\\mimikit.exe",
         "args": ["mcp"]
       }
     }
   }
   ```

   **VS Code**: its `mcp.json` (in your user profile, or `.vscode/mcp.json` for one workspace) has `servers` instead,
   and each one says its type:

   ```json
   {
     "servers": {
       "mimikit": {
         "type": "stdio",
         "command": "C:\\Users\\<you>\\AppData\\Local\\Mimikit\\mimikit.exe",
         "args": ["mcp"]
       }
     }
   }
   ```

   **Other apps**: add a stdio MCP server whose command is the Mimikit program with the argument `mcp`.
3. Ask the agent about your assets. The first time an app calls, Mimikit asks **Allow Claude Code to see your
   library?** in the corner of its window (and in Settings → AI). Until you answer, or when Mimikit is closed or
   AI agents are off, the agent is told so and can say it to you; it still sees the list of tools.
4. To let it organize too, turn on **Let Claude Code change your library** under the app in Settings → AI.
   Until then a change fails with `read_only`, and the agent can ask you to turn it on.

## Things to try

- "Find a coin sprite in Mimikit and tell me its path." The agent calls `search`, then `get_assets` for the path.
- "Show me the pixel-art buttons I have." `search`, `view` to look at them on a numbered contact sheet, then `show`
  puts its picks in Mimikit's window, with a **Shown by Claude Code** chip to go back.
- "Which sounds would work for a jump? Under a second." `search` with `type:audio dur:<1s`.
- "What's the license of the Kenney pack?" `read_text` on its LICENSE or readme.
- "Find more tiles like this one." `similar`, Mimikit's Find similar.
- "I like this dragon; what else do I have like it?" With [search by meaning](search-by-meaning.md) on, `related`,
  Mimikit's Find related: other dragons and creatures, whatever their names.
- "Find a red potion icon and give me its path." With [search by meaning](search-by-meaning.md) on, `search` with
  `type:image looks:red-potion-icon` finds it even when its name and tags don't say so, then `get_assets`.
- "Copy the five best explosion sprites into my Godot project." The agent picks them with Mimikit, then copies them with
  `copy_to_folder` (Claude Code can also copy by path with its own tools).

With **Allow changes** on:

- "Tag the pack I just added, and make a collection of the UI parts." The agent looks at the pack with `view`, then
  makes one `batch` of `tag` and `collect` changes: one entry in **What agents did**, taken back by one **Undo**.
- "Merge the tags `tree` and `trees`." `search` for `#trees`, then `tag` to add `tree` and remove `trees`.
- "Note the license on every asset of the Kenney pack." `read_text` on its LICENSE, then `note`.
- "Make a smart collection of short UI sounds." `collect` with a name and a search such as `type:audio dur:<1s ui`.

## Tools

| Tool | What it does |
|---|---|
| `overview` | The library in brief: assets of each type, the folders, the most used tags, the collections, how much of the image analysis is done, and whether search by meaning is on. Start here. |
| `search` | The search language (`type:`, `in:`, `#tag`, `size:`, `dur:`, `rating:`, `note:`, `color:`, `looks:`), the Filters panel, a collection, a library folder, favorites, a sort and pages. Short rows; with `looks:`, best first. |
| `get_assets` | Full details of up to 50 assets: file path, size, date, pixel size or audio format, tags, rating, note, collections, main colours, sprite-sheet grid. |
| `similar` | Images that look like one image, closest first. |
| `related` | Assets closest in meaning to one image, model, video or font (other dragons for a dragon), closest first, from search by meaning's index. |
| `view` | Pictures: one numbered contact sheet of up to 16 assets, or up to 4 larger ones. Images, models and videos show their thumbnail, fonts sample letters. |
| `list_tags` | Every tag and how many assets have it. |
| `list_collections` | The collections and their sizes; a smart collection's saved search. |
| `read_text` | The text of a text or data file, or of a LICENSE or README without an extension: the first 20,000 characters. |
| `show` | Switches Mimikit's window to exactly these assets, so you see what the agent means. |

These need **Allow changes** for the app. Each call changes at most 500 assets, and an app makes at most 30 changes a
minute.

| Tool | What it does |
|---|---|
| `tag` | Adds and removes tags on up to 500 assets. |
| `rate` | Sets the rating, 1 to 5 stars, or clears it. |
| `favorite` | Adds assets to Favorites or takes them out. |
| `note` | Sets or clears one asset's note. |
| `collect` | Makes a collection (or a smart one from a search), or adds assets to one and takes them out. |
| `copy_to_folder` | Copies up to 200 files into a folder: it never replaces a file, and a name that's taken gets a number. Programs and scripts that run when opened (`.exe`, `.bat`, `.ps1`, `.js`…) aren't copied. |
| `batch` | Up to 20 `tag`, `rate`, `favorite`, `note` and `collect` changes as one step, all checked before any is made. |

An error says what happened and what to do, with a code: `not_running`, `not_allowed`, `no_answer`, `paused`,
`read_only`, `rate_limited`, `not_found`, `not_an_image`, `no_picture`, `not_text`, `unreadable`, `not_indexed`,
`name_taken`, `smart_collection`, `not_copied`, `not_a_folder`, `too_many`, `too_large`, `invalid_input`,
`unknown_tool`, `refused`, `busy`, `timeout`, `lost`, `internal`.

## What you control

- **The switch**, off at first. Off stops listening and forgets the apps you allowed, so each one asks again.
- **The first call of each app** asks you. **Don't allow** refuses that agent session; a new session asks again.
- **Allow changes**, off at first for each allowed app, and kept until you turn it off or **Forget** the app.
- **Connected agents** in Settings → AI lists each agent session with its calls. **Pause** refuses its changes
  until you press **Resume**, while it can still search and look; **Disconnect** refuses that session from then on.
  **Allowed apps** has **Forget**.
- **What agents did**, in the AI view, lists the last 50 changes since Mimikit started, newest first, with the values they replaced.
  **Undo last agent change** takes back the newest one still standing, all of a `batch` at once. Each change also shows
  a message with **Undo**, and **Ctrl+Z** (⌘Z) undoes it like your own changes. Undo leaves a value you changed
  yourself since as you left it, and removes a collection the agent made. Copied files stay: Mimikit never deletes
  files.

## Security

- **On this computer only.** Mimikit listens on `127.0.0.1`, on a new random port each time AI agents are turned on,
  and writes the port and a new random 128-bit token to `agent-bridge.json` in its data folder (readable by you only:
  mode 600 on macOS and Linux, the profile folder's own permissions on Windows). `mimikit mcp` reads it for each call.
- **Not from web pages.** A request has to carry the token, name `127.0.0.1:<port>` as its `Host` (a page that points
  its own name at 127.0.0.1 sends that name) and have no `Origin` (browsers send one). Anything else is refused.
- **An app's name is the one it gives.** Any program running as you could read the token file and claim any name, so
  the Allow question guards against surprises, not against software that already runs on your computer.
- **Your files stay as they are.** The tools run in Mimikit's window on the library it already shows. Changes touch
  only Mimikit's own records (tags, ratings, favorites, notes, collections), through the same actions as your own
  edits. No tool moves, renames or deletes a file, removes a library folder, or changes settings or backups.
  `copy_to_folder` only reads the originals and never replaces a file in the folder it copies to.
- **Library text is data.** Names, folders, tags, notes and file contents can come from packs you downloaded, and can
  be written to steer a model. Everything a tool returns from your library sits inside `<mimikit-data>` tags with a
  sentence saying it is content to read, never instructions to follow, and the JSON inside can't close the tags
  early. Error messages never quote your library. An asset named "Ignore previous instructions…" is read, never
  obeyed. `view` labels its pictures with numbers only, and the names stay in the wrapped text; words drawn inside an
  image are part of the picture, though, and can't be wrapped.
- **Limits.** Each call is checked against its schema first. At most 50 assets' details, 16 assets on a contact sheet
  (4 larger pictures), 500 to show, 100 rows a page and 20,000 characters of a text file; an answer over 60,000
  characters or 4 MB of pictures isn't handed over, and the agent is told to ask for less. 16 calls at a time.
- Keep your agent app's own confirmation prompts on.
- On Windows, an update closes every running copy of `mimikit.exe`, the agent apps' `mimikit mcp` included. Reconnect
  them afterwards (in Claude Code, `/mcp`).
