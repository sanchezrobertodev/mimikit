# Changelog

All notable changes to Mimikit (called Asset Den until 0.4.0) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Search by meaning covers 3D models, videos and fonts** as well as images. Describe one (**Shift+Enter**,
  `looks:`, Ask or an AI agent's `search`) and it's found by its preview: a model's thumbnail, a video's frame about a
  tenth of the way in, a line of sample text in the font. **Find related** works on them too, and across kinds (a
  goblin model finds goblin pictures). While it indexes, Mimikit draws the previews it hasn't drawn yet, one at a
  time, as it does for what's on screen; one it can't draw (a video in a codec the system can't play) counts as done
  and isn't found. The search box's row is now **Assets that show “…”**, and the counts say assets.
- **Find related** in the side panel, next to **Find similar**: the images closest in meaning to the open one (other
  dragons for a dragon, ropes and chains for a rope), from search by meaning's index. They come closest first, at most
  200, narrowed by the open folder, type chips and **More filters**; the chip's × or **Esc** ends it. Find similar
  still finds copies. It needs search by meaning on and the image indexed, and says so otherwise; it downloads
  nothing and loads no model.

### Fixed

- On Intel Macs, where search by meaning isn't available, AI agents no longer ask you to turn it on when they
  try a `looks:` search: they hear it isn't available there.

## [0.12.0] - 2026-11-09

### Added

- **Search by meaning**: find images by describing them ("red potion icon", "dark forest tileset"), in any language,
  whether they have tags or not. Type the description in the search box and press **Shift+Enter**, or pick **Images
  that show “…”**. The closest images come first, narrowed by the open folder, type chips, **More filters** and other
  search words; the chip's × or **Esc** ends it. It runs on your computer: turn it on in **Settings › AI features ›
  Search by meaning (offline)**, which lists the one-time download first (Google's SigLIP 2 model and Microsoft's
  ONNX Runtime, about 810 MB), then indexes your images in the background with Pause and Cancel. After that nothing
  goes online. **Delete model and index** frees the space. See the README for what it covers.
- `looks:red-potion-icon` in the search language searches by meaning too, with hyphens for spaces, so it combines with
  the other search words and works in smart collections, in Ask (which writes it for requests that describe pictures,
  once search by meaning is on) and for AI agents (`search` returns the best matches first, `overview` says whether
  it's on, and the error `not_indexed` says when it isn't).

## [0.11.0] - 2026-11-06

### Added

- **Suggest tags**: Claude suggests tags for many assets at once, from the palette (**Suggest tags for the N assets
  shown…**, so a folder, a search or a filter) or the side panel (the selection). The dialog shows what's sent (a
  small preview, the file and folder names, the first 2 KB of text files; never whole files or full paths), the model
  and the estimated cost first, and a **Send** switch: **Right away** gets the tags back in seconds at the normal
  price, and **As a batch, half price** goes through Anthropic's Message Batches API, where results usually arrive
  within minutes, even if Mimikit was closed meanwhile. Up to 50 assets start on Right away. The sidebar shows a
  batch run with **Cancel**, then the assets with suggestions, **Review** and the real cost.
- Suggested tags wait as dashed chips under the tag field in the side panel: click to add one, × to reject it, or
  **Accept all** / **Reject all**, also for several assets at once. **More filters → Has suggested tags** (and smart
  collections) find what's left to review.
- **Settings › AI features**: **Tagging model** (Haiku 5.5 by default, Sonnet 5.5 or Opus 5.5, always at low effort),
  and **Remove all AI tags**, which takes off every tag you accepted from a suggestion and keeps the ones you added.

### Fixed

- Ask could fail on its first search after Mimikit started: the first request to Anthropic now always sets up its
  secure connection first.

## [0.10.0] - 2026-11-05

### Added

- **Ask** in the search box: describe what you want in plain words ("dark forest ambience longer than a minute") and
  press **Ctrl+Enter** (⌘↵ on macOS), or pick **Ask Claude to turn this into a search**. Claude writes the search
  and puts it in the box, where you can see and change it, and Mimikit runs it on your computer as usual. **Back to my
  words** puts your words back.
- **Settings › AI features** holds your own Anthropic API key for Ask, in the system's credential store (Windows
  Credential Manager, macOS Keychain, Secret Service), never in the library. Ask sends Anthropic only your words, the
  search syntax and your tag names, never file names, paths, contents or thumbnails. **Model** picks Claude Haiku 5.5
  (the default: a search costs your API account a few hundredths of a cent), Sonnet 5.5 or Opus 5.5, and **Effort**
  how much it thinks first (Low, Medium or High).

## [0.9.0] - 2026-11-05

### Added

- The sidebar collapses to a narrow rail of section icons with the button at its top or **Ctrl+B** (⌘B on macOS),
  and stays that way after a restart. In a window narrower than 1100 px it starts as the rail; the button opens it
  until the window is wide again, without changing the saved choice.
- **Fill the screen**: Mimikit can take over the whole screen with **F11** (⌃⌘F on macOS) or the button at the
  top right, next to Import. **Esc** goes back to a window once nothing else is open.

### Fixed

- Settings › AI agents no longer lists agent apps that have closed. They leave the connected list within about
  10 seconds.

## [0.8.0] - 2026-11-05

### Added

- Keyboard multi-select: **Shift+arrows** select a range, **Ctrl+arrows** (⌘ on macOS) move without changing the
  selection, and **Ctrl+Space** adds the current asset to the selection or takes it out.
- In full screen, **+** and **−** zoom an image and **Ctrl+0** fits it back. **J** and **L** go back and forward
  5 seconds in a sound. 3D models in full screen have an **Auto-rotate** button, so you can look around one without
  dragging.
- Deleting a collection that holds assets asks first, with Cancel focused. The assets themselves are never touched.
- AI agents can organize your library once you allow it: turn on **Let Claude Code change your library** under the
  app in **Settings → AI agents**. The agent can then tag and rate assets, mark favorites, write notes, make
  collections (smart ones too) and copy files into a folder, so you can ask it to "tag this pack and make a collection
  of the UI parts". It still can't move, rename or delete files, and copies never replace a file or include programs
  and scripts.
- **What agents did** in Settings → AI agents lists the last 50 changes agents made, with the values they replaced,
  and **Undo last agent change** takes back the newest one. Each change also shows a message with Undo, and Ctrl+Z
  undoes it. An agent can make at most 30 changes a minute, of up to 500 assets each.

### Changed

- In the grid, **↑** and **↓** go up and down a row instead of to the previous and next card. Grouped by folder, they
  keep to the same column in the next row.
- The Loop, Pixel, Animate, Wireframe and Auto-rotate buttons are filled while on, so they no longer differ by text
  colour alone.
- The waveform's unplayed part has more contrast.
- When a preview fails, it says why in plain words; the viewer's own message is under **Technical details**.
- Two library folders with the same name are told apart by their parent folder, for example "files · assets" and
  "files · audio", in the sidebar, folder groups, search, Insights, Home and the side panel.
- The Delete collection button is red.
- Insights and Duplicates show the welcome screen until you import a folder, instead of empty numbers and "All
  clear".
- Pausing an agent now holds back only its changes: it can still search your library and look at assets.

### Fixed

- The shortcut bar along the bottom of the library no longer covers the card or row you're on.
- In a narrow window, the shortcut bar drops the hints that don't fit instead of running off the window, and "? all
  shortcuts" always stays. The search field shrinks to its icon, and in the side panel the rating and favorite drop
  under the file name instead of squeezing it.
- The file-type labels on placeholder tiles (OGG, TXT, …) are readable in the light, sepia and high-contrast light
  themes.

## [0.7.0] - 2026-11-05

### Added

- AI agents: Claude Code, Claude Desktop and other MCP apps can search your library and look at your assets, so you
  can ask one to "find a coin sprite and tell me its path". Turn it on in **Settings → AI agents**, which shows the
  command or config to connect each app. Agents only read: nothing in the library or your files changes. Each app asks
  you first, and Settings lists the connected ones with Pause and Disconnect. An agent can also show you assets in the
  library. See [AI agents](README.md#ai-agents-mcp).
- The sidebar's sections have icons.
- Thumbnails show their rating (★ 4) next to the favorite heart: in the grid, the list and on Home. On Home this
  explains why an asset is under "Favorites and top rated".
- **Ctrl+Z** (⌘Z on macOS) undoes the last change that offered Undo (favorites, ratings, collections, "Not
  duplicates"), even after its message has gone. It's listed with the other keyboard shortcuts (**?**).

### Changed

- Favorites are hearts, in a colour of their own, so they no longer look like the rating stars beside them.
- A message with an Undo button stays on screen while the pointer or the keyboard focus is on it.
- In Duplicates, the Move to Trash confirmation puts the focus on Cancel and shows Move to Trash in red, so pressing
  Enter or Space right after it opens no longer moves files to the Trash.

### Fixed

- 3D models compressed with meshopt (`EXT_meshopt_compression`, as written by gltfpack and glTF-Transform) preview
  and get thumbnails, instead of showing "Couldn't preview this file".
- Selected rows in the list view have an accent outline. A faint tint was all that marked them.
- In the high-contrast themes, the highlighted result in search (Ctrl+K) and the highlighted folder in the folder
  path's menu are readable, and the folder line under a highlighted search result has enough contrast in every theme.
- In the high-contrast themes, the tags in the side panel and the ignored folder names in Settings are readable, and
  so is their remove button (×). A filter button in search (Ctrl+K) stays readable under the pointer too.

## [0.6.0] - 2026-11-05

### Added

- A Home page that Mimikit opens on: a big search field with example searches, your recent folders and collections,
  a tile per asset type, recently changed files, favorites and top-rated assets, and what needs attention (duplicates,
  folders that can't be reached, images not analysed yet, untagged assets). After an update it says what's new, once.
  **Settings → Appearance → Start on** goes back to opening on the library.
- Each asset type has an icon, on the type filters and on every type label: thumbnails, the list, the side panel,
  full screen and search. **Settings → Appearance → Type labels** shows the icon and name, the icon only or the name
  only.

### Changed

- The row of subfolder chips under the type filters is gone. The folder path's menus and the sidebar still list
  subfolders.
- Recent folders are remembered when Mimikit restarts, on Home and in the folder path's menu.

### Fixed

- Clicking an asset while the side panel is closed no longer scrolls it out of view when the panel opens, which was
  worst with large thumbnails. Closing the panel keeps it in place too.
- Coming back to the grid with an asset selected (from Home, Insights or another view) scrolls that asset fully into
  view, instead of leaving it cut off at the bottom edge.
- Changing the thumbnail size keeps the selected asset where it was on screen, instead of the grid jumping to other
  assets.

## [0.5.0] - 2026-11-03

### Added

- Mimikit in Spanish, Brazilian Portuguese, French, German, Japanese and Simplified Chinese. It follows the system
  language, or pick one in **Settings → Appearance → Language**. The translations are machine-written; corrections
  are welcome (see Translations in the README).
- On Windows the installer follows the system language too: English, Spanish, Brazilian Portuguese, French, German,
  Japanese or Simplified Chinese.
- Five more themes in **Settings → Appearance**: Black (pure black for OLED screens), Midnight, Sepia, High contrast
  dark and High contrast light. Each theme shows a small preview. The theme button in the sidebar still switches
  between System, Dark and Light.
- An accent colour for buttons, selection and focus rings: green (as before), teal, blue, violet, pink, red, orange
  or amber. Every theme and accent pair is checked for readable contrast.

### Changed

- All interface text now comes from translation files, ready for more languages. English reads as before, apart
  from the fixes below.

### Fixed

- Counts of one read correctly ("1 file", "1 image", "1 more line"), and large counts get thousands separators
  everywhere.
- Ctrl+K, Ctrl+A, F and the 0–5 rating keys work on non-Latin keyboard layouts, and the rating keys work from the
  number row of a French AZERTY keyboard.
- Search operators typed in full width by a Japanese or Chinese input method (`：`, `＃`, `＞`, `＜`, `＝`) work like
  the usual ones.
- The update download shows sizes in the same units as the rest of the app, and "Starting download…" no longer ends
  in four dots.
- On Windows the title bar follows the theme you pick, not just the system's light or dark setting.
- An open waveform or 3D preview changes colour with the theme, instead of keeping the old theme's colours.
- Kind dots and collection colours stay visible when a Windows contrast theme is on.

## [0.4.0] - 2026-11-03

### Changed

- Asset Den is now **Mimikit**, with a new icon: a treasure-chest mimic full of game assets. Your library, tags,
  settings and backups carry over. On Windows, installing Mimikit removes the old Asset Den app (never its data) and
  moves its Start menu and desktop shortcuts to Mimikit. A taskbar or Start pin doesn't carry over: pin Mimikit
  again. On macOS an updated copy stays in Applications as Asset Den: rename it to Mimikit, or move it to the Trash
  and drag Mimikit in from the dmg. A Linux `.deb` installs next to the old one: remove it with
  `sudo apt remove asset-den`.
- **Save as smart collection** shows only in Library with no folder open. A smart collection saves the search, type
  chips and filters, so saving from Favorites or a folder made one with different assets.
- Thumbnails start loading a little before cards scroll into view, and 3D models no longer hold up image thumbnails.
- Search keeps up better while a folder scans, and **Analyse images** no longer makes the sidebar recount smart
  collections that don't search by colour.
- An already-made preview of a TGA, PSD or TIFF opens without waiting for the thumbnails on screen.
- Font packs no longer keep every font you scrolled past loaded.

### Fixed

- **Move to Trash** on the Duplicates page moves the copies the dialog named, even if a duplicate check finishes
  while it's open and puts another group on screen.
- A library folder that is there but empty (a drive not mounted at its mount point) keeps its assets, tags and
  collections and shows as missing, instead of losing them all at the next rescan.
- Rating, favorite, arrow and select-all keys no longer act on the library behind a confirm dialog.
- The side panel shows an image, SVG or video's new contents after the file is edited.
- An Undo that fails (say, a deleted collection whose name was taken meanwhile) says so instead of looking done.
- Search counts and results follow the Filters panel, so "Show all N matches" opens N assets.
- The links on Insights clear the search and filters first, so "Show untagged" no longer shows nothing when a tag
  filter is on.
- On Linux and macOS, a folder whose change events the system dropped (unzipping a big pack) is rescanned, instead
  of missing files until the next launch.
- Duplicate checks that overlap (at launch, one per folder) no longer read the same files several times.
- An image whose header crashes the decoder can no longer break the app until it restarts.

## [0.3.9] - 2026-11-02

### Changed

- Removing a folder from the library asks first, and says how many assets it forgets.
- Folders named `$RECYCLE.BIN` and `System Volume Information` are skipped, and so is Asset Den's own data folder.
  Adding a folder that holds it, or sits inside it, is refused.
- Tagging, favoriting or collecting a big selection is faster.

### Fixed

- **Move to Trash** on the Duplicates page no longer trashes a "copy" that is really the same file reached another
  way (a hard link, or the same folder through a mapped drive), which could have left no copy at all.
- A file saved while Asset Den was checking it for duplicates could keep the old file's fingerprint and show as a
  duplicate of something it no longer matched.
- Files added while a folder was rescanning could disappear from the library until the next rescan.
- An image the decoder chokes on (some damaged PSD files) shows "couldn't read this image" instead of closing the app.
  The same goes for damaged audio files.
- Images on a drive that's unplugged during **Analyse images** wait until it's back, instead of being marked
  unreadable.
- Full screen no longer plays a sound or video twice, and closes when its file is deleted.
- If the library failed to load at startup, changes from the folder watcher now load it once it can, instead of
  waiting for a restart.
- A folder removal or a duplicate ignore that fails to save no longer looks done.
- The Duplicates page keeps the default copy selected when the copy you picked earlier is gone.
- A font file edited while the app is open shows its new glyphs.

## [0.3.8] - 2026-11-01

### Added

- Library backups: **Settings → Backups** saves your folders, tags, ratings, notes, collections and sprite grids to a
  file wherever you like, and restores one (Asset Den restarts to finish). Asset Den also makes a backup each day it
  opens and keeps the last 5. Restoring saves the current library first, so you can switch back. Your asset files are
  never part of a backup.

## [0.3.7] - 2026-11-01

### Added

- Asset Den is open source: the code is at [github.com/sanchezrobertodev/asset-den](https://github.com/sanchezrobertodev/asset-den),
  under the MIT License. **Settings → About** links to it, and to Ko-fi if you'd like to support it.
- macOS and Linux builds are published with each release: a universal macOS `.dmg` (Apple Silicon and Intel), a Linux
  AppImage and a `.deb`. The macOS app and the AppImage update themselves like the Windows app; a `.deb` install
  updates by installing the next `.deb`. The macOS app isn't notarized, so macOS asks for confirmation the first time
  it opens.

### Changed

- Releases and updates now come from the main repo. This version still arrives through the old feed, and checks the
  new one from then on.

## [0.3.6] - 2026-11-01

### Added

- **Locate** a library folder that moved. A folder Asset Den can't reach shows a locate button in the sidebar: pick
  where it is now, and its assets keep their tags, ratings, notes, favorites and collections. If some of its files
  aren't in the new place, Asset Den says how many it found and asks before the rescan drops the rest.

## [0.3.5] - 2026-10-31

### Fixed

- A library folder that can't be reached when Asset Den scans it (an unplugged drive, a renamed or moved folder) no
  longer loses its assets. Before, the scan treated every file as deleted, and their tags, ratings, notes, favorites,
  collections and sprite sheet settings went with them. Now the assets stay as they were, the folder shows a warning
  icon in the sidebar, and a rescan once it's back picks up where it left off. A subfolder that can't be read keeps its
  assets the same way.

## [0.3.4] - 2026-10-24

### Added

- **Duplicates** can be sorted and filtered. Sort the groups by space freed, most copies, newest or name. The type
  chips, the search and **More filters** narrow the list to groups with a matching copy, and in Duplicates the search's
  first result does the same. The open group stays open when the sort or filters change.

### Fixed

- Some 3D model thumbnails were blank, though the model showed in the side panel and full screen. After about 20
  model previews, WebView2 shut down the renderer that draws thumbnails, and every thumbnail drawn after that was saved
  empty. Closed previews now free their renderer right away, the thumbnail renderer restarts if it's shut down anyway,
  and it never saves a frame it couldn't draw. Model thumbnails saved by earlier versions are drawn again once.

## [0.3.3] - 2026-10-24

### Added

- **Collections** browse like the library. An open collection has the type chips, search, **More filters**, sort,
  grouping by folder, grid or list and the thumbnail size, applied to its own assets. The library's open folder
  doesn't narrow it. With a collection open, the first search result is "Show N matches in <collection>".
- **Remove N assets** in a collection's header removes the selected assets you can see (with **Undo**). It replaces
  the Remove button on each card.

### Changed

- **Collections** stay quick when they're big. They use the library's grid and list, which draw only the cards on
  screen, so opening and scrolling a collection of thousands of assets no longer stalls.

## [0.3.2] - 2026-10-23

### Added

- **Duplicates**: each copy has a full-screen button (or double-click its preview). Full screen steps through the
  copies of that group with the arrow keys, and <kbd>Esc</kbd> comes back to the review.
- **Duplicates**: each copy shows its size and, for images, its dimensions. Groups with more than two copies show the
  count in the list.

### Changed

- **Duplicates** stays quick with thousands of groups. Only the groups on screen are drawn, and the view no longer
  redraws on unrelated changes; stepping through 3,700 groups went from about 300 ms per step (up to 770 ms) to about
  10 ms. The group list is one keyboard stop: <kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Page Up</kbd>/<kbd>Page Down</kbd>,
  <kbd>Home</kbd> and <kbd>End</kbd> move through it.

### Fixed

- In **Duplicates** on a wide window, the preview of a copy could grow out of its card and cover the heading.

## [0.3.1] - 2026-10-23

### Changed

- **Image analysis** (for Find similar and search by colour) no longer runs by itself after every scan, which on a big
  library kept several cores busy for minutes after launch. Images are now analysed:
  - as you browse, from the thumbnails on screen (cheap: they're small);
  - when you ask: **Analyse images** in **Settings → Library**, or **Analyse now** where results depend on it (Find
    similar, the Colour filter, `color:` searches), which also say how many images they cover. While it runs, the
    sidebar shows "Analysing images · 12,340 of 51,200" with **Pause** and **Cancel**; what's done is kept;
  - when files change, once **Keep new and changed images analysed** is on (Settings → Library). It turns on by itself
    after the first full analysis, and then only reads the files that were added or changed.
- Image analysis, duplicate hashing and audio header reading run at low OS priority, so the app and other programs
  stay responsive while they work.

## [0.3.0] - 2026-10-23

### Added

- A welcome screen on first run says what Asset Den does, imports your first folder and shows three tips (drag cards
  into your engine, Space to preview, Ctrl/⌘ K to search). It repeats that your files are only read, never changed.
- **Keyboard shortcuts**: press `?` (or the keyboard button in the sidebar footer, or search for "Keyboard shortcuts")
  for every shortcut, grouped into Navigate, Preview, Organize and Search. The hint bar and the full-screen legend now
  come from the same list.
- **Settings** (the gear in the sidebar footer, or "Settings" in search):
  - Appearance: theme (System, Dark, Light), thumbnail size and pixel-art scaling.
  - Library: folder names to ignore in every library folder, such as `Backup` or `_old`, on top of the built-in ones
    (hidden folders, `node_modules`, `.meta` files). Only folders match; a file with the same name stays. The list is
    saved with the library, file changes in those folders are ignored at once, and **Rescan now** drops what's already
    indexed under them. Files stay on disk.
  - Storage: the size of the thumbnail and preview cache, and **Clear thumbnail cache**. Only the app's own cache is
    deleted; thumbnails are rebuilt as you browse.
  - Updates: turn off the update check on launch (shown where the app updates itself).
  - About: version, license, and a link to the releases page.
- A preview that fails shows "Couldn't preview this file" with the reason, **Open** and **Show in folder**, in the side
  panel and in full screen. That covers files that can't be decoded or played (images, video, audio, fonts, models,
  text) and viewers that crash or can't load, which used to leave a blank player or break the panel. The next asset
  previews normally.
- **Ratings**: give assets 1 to 5 stars from the side panel, full screen, a multi-selection, or the keys
  <kbd>1</kbd>–<kbd>5</kbd> (<kbd>0</kbd> clears). Filter by rating in **More filters** or search with `rating:>=4`,
  `rating:3` or `rating:<2`.
- **Notes**: a free-text note per asset in the side panel (saved as you type), shown in full screen. Search them with
  `note:word`.
- **Smart collections**: **Save as smart collection** next to the filters keeps the current search, type chips and
  filters as a collection whose assets update as the library changes. Open one as a search, replace its search with
  the current one, rename, copy or delete it like any collection.
- Removing duplicates also keeps the higher rating and both notes on the kept file.
- Audio files show their length, sample rate, channels and bit depth ("0:03.2 · 44.1 kHz · stereo · 16-bit") in the
  side panel and full screen, and their length in the list view and on grid cards. They're read from the file headers
  of WAV, OGG, MP3, FLAC, M4A, AAC and Opus files in the background after a scan (MP3s are counted frame by frame, so
  VBR files without a Xing header get the right length); bit depth is only known for WAV and FLAC.
- Filter audio by length: **Audio length** (min and max seconds) in the Filters panel, or `dur:<2s` / `dur:>30s` in
  search (`ms`, `s` or `m`; seconds by default). Files whose length isn't known never match a length limit.
- **Loop** in the audio player plays the file again from the start when it ends. The setting is remembered.
- **Export frames…** in the full-screen sprite view saves each frame of the sheet as its own PNG (`walk_000.png`,
  `walk_001.png`…) in a folder you pick, cut from the original image at the saved grid. Fully transparent frames can be
  skipped. Existing files are never replaced: a taken name gets " (2)", and the sheet itself is only read.
- **Find similar** in the side panel shows the images that look like the open one, closest first: resized, recoloured
  (hue-shifted) and lightly cropped copies included. A "Similar to …" chip above the grid has a Strict–Loose slider and
  clears the search. Works for PNG, JPEG, GIF, WebP, BMP, TGA, PSD, TIFF and ICO.
- **Search by colour**: a Colour group in the Filters panel (twelve named swatches and a custom colour), and
  `color:red` or `color:#ff8800` in search. An image matches when one of its main colours is that colour; smart collections
  can save a colour too.
- Both use a background pass after each scan that reads every image once (from its cached thumbnail when there is
  one) and keeps a small fingerprint and its five main colours until the file changes. It uses at most half the
  thumbnail workers and waits while folders are scanned. Files are only read.
- **Accessibility**: everything works from the keyboard and with a screen reader.
  - The asset grid and list take focus as one list (arrows move, the focused asset has a ring); <kbd>Tab</kbd> from
    the top of the window offers **Skip to the assets**.
  - Every control shows a focus ring, including cards, chips, colour swatches and stars. Dialogs, search, the
    shortcuts overlay and full screen keep <kbd>Tab</kbd> inside and give focus back to where it was when they close;
    so do the Filters panel, the export menu and the smart-collection name field.
  - The star rating is a radio group: <kbd>←</kbd> <kbd>→</kbd> change it while it has focus. Duplicates pick the copy
    to keep the same way.
  - Icon buttons, stars, swatches, cards and the filmstrip have names; toggles say whether they're on; the current
    view, folder and breadcrumb are marked; thumbnails next to a name are skipped.
  - Toasts (with their Undo) and the start and end of a scan are announced.
  - With the system's "reduce motion" setting, sprite sheets and animated models start paused, audio and video don't
    start by themselves, hover previews of audio stay silent, and transitions are instant. Full screen gets an
    **Animate** toggle for animated models.
  - <kbd>Esc</kbd> in a text field goes back to the asset list. The `?` overlay and the hint bar list the rating keys
    (<kbd>1</kbd>–<kbd>5</kbd>, <kbd>0</kbd>), the star arrows and the tag field keys.

### Changed

- The app starts with a third of the code it loaded before: the 3D viewer, model thumbnails and the audio waveform
  load their libraries (three.js, wavesurfer.js) the first time they're needed.
- New app icon: a fanned stack of cards (an image card in front of blue and amber ones) on a warm dark tile, also
  shown next to the name in the sidebar.
- Small text (counts, labels, hints) is a little stronger in both themes, and the light theme's green and star are a
  little darker, so text reaches a 4.5:1 contrast and the stars 3:1.

### Fixed

- In the library, <kbd>Enter</kbd> or <kbd>Space</kbd> on a focused button (in the sidebar, the side panel or the bar
  above the grid) opened full screen or the side panel instead of pressing the button.
- <kbd>Esc</kbd> while renaming a collection saved the typed name instead of keeping the old one.
- Search said "Show all 1 matches" for a single match.

## [0.2.3] - 2026-10-21

### Added

- Video cards show a frame from the video (about 10% in, at most 1 second) instead of an icon. Frames are grabbed by
  the window two at a time, only for cards on screen, and cached like other thumbnails; a video the webview can't play
  keeps the icon.

### Fixed

- OBJ models show their materials and textures in the 3D viewer and in thumbnails, from the .mtl files their `mtllib`
  lines name or the .mtl with the same name next to them. A missing or broken .mtl falls back to the neutral grey material.
  Existing OBJ thumbnails are rendered again once, automatically.

## [0.2.2] - 2026-10-20

### Added

- **Animate** plays an image as a sprite sheet, in the side panel and in full screen. It guesses the grid from the
  image size (a 256×64 strip becomes 4 frames of 64×64) and lets you set columns and rows or the frame size, fps
  (12 by default), play and pause, step frame by frame, loop, and pixel-art scaling. The slicing is saved per asset in
  the app's database, so it survives rescans and renames, and an image you have animated opens animated next time.
  The image file itself is never changed.

### Changed

- Big libraries stay responsive while files change. Scans and file events now send only the files that changed
  instead of the whole library, so a rescan where nothing changed costs the UI nothing, a new file appears in about half
  a second, and importing a large folder no longer freezes the window.

### Fixed

- The first duplicate check after a big import no longer freezes scans and the window for minutes. Hashes are now
  saved in batches of 500, so on an 80,000-file library the check takes about 7 seconds instead of 3.5 minutes.

## [0.2.1] - 2026-10-20

### Fixed

- Thumbnails at the bottom of a big library load right away after a fast scroll. Only cards on screen ask for a
  thumbnail, the newest first, and cards that leave the screen withdraw their request. This also covers long lists
  that show every item at once (collections, duplicates, the filmstrip). Thumbnails use every CPU core.
- Tall images (portraits, character art) no longer stretch their grid card past its square.
- The full-screen 3D viewport and video fill the screen on large monitors instead of stopping at 820 px.
- Theme and **Check for updates** moved to their own bar at the bottom of the sidebar, next to the app version, so long
  library names have room.

## [0.2.0] - 2026-10-19

### Changed

- New look and layout from the Claude Design redesign: warm dark palette with a matching light theme, Geist fonts,
  navigation for Library, Favorites, Collections, Duplicates and Insights, type chips, folder grouping, and colored
  type labels on every card.
- <kbd>Space</kbd> now opens a side panel and <kbd>Enter</kbd> a full-screen view with a filmstrip. Open in the
  default app moved to the **Open** button.
- Stats became **Insights**, with totals, untagged and duplicate counts, and clickable breakdowns.

### Added

- In-app updates (Windows): **Check for updates** in the sidebar (and the search palette) looks for a new version, shows what's new
  and installs it with **Install & restart**. Asset Den also checks quietly on launch. Updates are signed and verified
  before they install.
- Folder navigation: an expandable folder tree in the sidebar, a header breadcrumb with jump menus (subfolders and
  recent folders), subfolder chips, an **Include subfolders** toggle, and <kbd>Alt+↑</kbd> for the parent folder.
- Search palette (<kbd>Ctrl/⌘ K</kbd>, <kbd>/</kbd>) for assets, folders and actions, with `type:`, `in:`, `#tag` and `size:` filters.
- Duplicates review: pick the copy to keep, mark groups as not duplicates, or move the copies to the Trash. Their tags,
  favorite and collections move to the kept file, and the files are re-checked for identical content first.
- Collections page with in-place rename and **Copy to folder…** (never overwrites existing files).
- Toasts with **Undo** for favorites, collection changes, deleting a collection and ignoring duplicates.
- **Filters** panel in the toolbar: extension, image size (presets, min/max width and height, square only), file size,
  modified date, untagged only, and any of several tags.

### Changed

- Assets appear while a folder is being scanned instead of after the whole scan. Scans commit in batches, image
  dimensions are read in a second, parallel pass, and the file watcher starts in the background. A 20,000-file folder
  now indexes in about 1 s instead of 13 s, and adding a folder no longer blocks the window.

## [0.1.0] - 2026-10-18

### Added

- Library of one or more asset folders, with a full scan on start and live watching for added, renamed and deleted
  files. Renames keep tags. Engine sidecars, hidden folders and `node_modules` are skipped.
- Virtualized grid and sortable list, search by name, folder or `#tag`, and type filters.
- Thumbnails for images (including TGA, PSD and TIFF), 3D models (rendered in the app) and fonts.
- Quick view for images (zoom, pan, pixel-art scaling), audio (waveform), 3D models (orbit, wireframe, stats, first
  animation), fonts (specimen), video and text.
- Tags, favorites and collections, for single assets or a whole selection.
- Copy-mode drag-out of one or more assets into engines, editors or folders.
- Duplicate finder and disk-usage stats by type, extension and folder.
- Dark and light themes, keyboard navigation.
