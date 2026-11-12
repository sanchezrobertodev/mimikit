# Search by meaning

Describe a picture and Mimikit finds the images that show it: "red potion icon", "dark forest tileset", "hooded
ghost", in English or in another language ("poción roja", "Totenkopf", "ドラゴン"). It looks at the pictures
themselves, so it finds images with no tags and unhelpful file names. 3D models, videos and fonts are found by their
previews: a model's thumbnail, a video's frame about a tenth of the way in, and a line of sample text in the font. It
runs on your computer and needs no account, key or connection once the model is downloaded.

- **Turn it on** in **Settings → Library → Search by meaning (offline)**. Before anything downloads, it lists each
  file, its size and where it comes from: Google's SigLIP 2 model (Apache-2.0) from Hugging Face, and Microsoft's ONNX
  Runtime (MIT) from Mimikit's GitHub releases, about 810 MB in all. Then Mimikit indexes every image in the
  background on spare CPU, with **Pause** and **Cancel** in the sidebar (about 2 minutes for 3,400 images on a recent
  desktop CPU), and indexes new and changed assets as they come in. Models, videos and fonts are indexed from the
  previews the window draws of them; those it hasn't drawn yet are drawn then, one at a time, as on screen, which takes
  longer per asset than an image (a model is loaded and rendered, a video decoded for up to 15 seconds). One that
  can't be drawn, such as a video in a codec the system can't play, counts as indexed and isn't found.
- **Search.** Type a description in the search box (<kbd>Ctrl/⌘ K</kbd>) and press <kbd>Shift+Enter</kbd>, or pick
  **Assets that show “…”**, the first result when your words match no file names. The library shows the closest matches
  first, with a chip in the header; its × or <kbd>Esc</kbd> ends the search by meaning and keeps everything else.
- **Narrow it.** The open folder, **Include subfolders**, the type chips, **More filters** (pixel size, square, date,
  rating, colour) and search words such as `rating:>=4` or `#ui` typed with the description all narrow the results,
  and the best matches are picked from what's left. So "dark forest tileset" with a tileset pack open and **Square**
  on gives that pack's best forest tiles first.
- **How many.** The assets that score close to the best match, at most 200. While indexing is still going, a note
  says how many assets the results cover, and the results grow as it goes.
- **Find related.** **Find related** in the side panel, next to **Find similar**, shows the assets closest in meaning
  to the open one, narrowed the same way: other dragons for a dragon, ropes and chains for a rope. It works on models,
  videos and fonts too, and across kinds: a goblin model finds goblin pictures. Find similar finds
  copies of one picture; Find related finds pictures of the same kind of thing. It shows the closest 200 however they
  score, since near-copies score far above the rest and would leave little else, and it reads only the index, so it
  loads no model. An asset that isn't indexed yet says so. AI agents get it as the tool `related`.
- **In the search language.** `looks:` followed by the description, with hyphens for spaces, searches by meaning
  among whatever the rest of the search matches: `type:image looks:dark-forest-tileset rating:>=4`. It ranks the same
  way, best first whatever the sort, and works anywhere a search does:
  - **smart collections**: **Save as smart collection** keeps the `looks:` word, and the collection's members follow
    the index as it grows;
  - **[Ask](ask.md)**: with search by meaning on, Ask writes `looks:` for requests that describe what assets show, so "dark
    forest tileset I rated highly" becomes `type:image looks:dark-forest-tileset rating:>=4`;
  - **[AI agents](ai-agents.md)**: `search` takes `looks:` and returns the best matches first, `related` is Find
    related, and `overview` says whether search by meaning is on and how much is indexed. Agents get the ranked
    assets, never the index, and can't turn search by meaning on or start its download.

  With search by meaning off, `looks:` matches nothing, and a note says so with a link to Settings; an agent gets the
  error `not_indexed`.
- **Speed and memory.** The first search takes about 2 seconds while the text model loads, later ones about 50 ms. The
  text model takes about 800 MB of memory while loaded and is unloaded after 10 minutes without a search.
- **Private.** After the download nothing goes online, and nothing about your files leaves the computer. **Delete
  model and index** in Settings removes both. The index takes about 0.8 KB per asset and isn't in backups.
- **How good.** On 30 test descriptions over a library of 3,400 game-art images, 84% of the top 10 results
  were right. It reads what a picture shows, not text inside it.
