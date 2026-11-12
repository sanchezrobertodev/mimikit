# Suggest tags

Claude can suggest tags for many assets at once. Open the assets you want, such as a folder, a search or a filter,
press <kbd>Ctrl+K</kbd> (<kbd>⌘K</kbd> on macOS) and pick **Suggest tags for the N assets shown…**, or select some
and pick **Suggest tags…** in the side panel. The dialog shows how many go, what's sent, the model and the cost before
anything leaves your computer.

- **Right away or as a batch.** The dialog's **Send** switch picks how. **Right away** asks Claude at the normal price,
  four requests of ten assets at a time, and the tags are back in seconds (a minute or two for a big run) while the
  dialog stays open. **As a batch, half price** goes through Anthropic's Message Batches API: results usually arrive
  within minutes (Anthropic allows up to a day), and you can close Mimikit meanwhile: it collects them at the next
  launch. Up to 50 assets start on **Right away**, more on the batch. The sidebar shows a batch run, with **Cancel**,
  and then how many assets have suggestions, with **Review** and what the last run cost.
- **You decide.** Suggestions aren't tags until you accept them. In the side panel they're dashed chips under the tag
  field: click one to add it, or its × to reject it, or **Accept all** / **Reject all**. With several assets
  selected, a chip covers the ones that have it. **More filters → Has suggested tags** finds what's left to review,
  and a smart collection can use it too.
- **What's sent.** For each asset: its name, the name of its folder inside the library folder, its kind and pixel size
  or length, and a small preview: the 256 px thumbnail of an image, a render of a 3D model, a frame of a video, or a
  line of text set in a font. Text files send their first 2 KB; audio sends only its name and details. Also the
  instructions and the names of your 300 most used tags, so suggestions reuse them. Never whole files or full paths.
  Assets Claude was already asked about are left out unless you tick **Also ask again**; a file that changed since
  counts as new.
- **Model.** **Settings → AI → Suggest tags → Model** picks Claude Haiku 5.5 (the default), Sonnet 5.5 or Opus 5.5,
  always at low effort. See the pull request that added it for how the default was chosen.
- **Cost.** Billed to your API account. Measured on 100 mixed assets at batch prices: about $0.02 per 1,000 assets with
  Haiku 5.5, $0.40 with Sonnet 5.5 and $0.80 with Opus 5.5. **Right away** costs twice as much per asset, which for
  50 assets is at most a few cents. The dialog estimates each run, and what it would cost if every reply ran as long
  as allowed. Both are estimates, not limits.
- **Undo.** **Settings → AI → Remove all AI tags** takes off every tag you accepted from a suggestion, after
  showing how many. Tags you added yourself stay, even ones Claude also suggested. Mimikit never changes your files.
