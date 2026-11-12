# Ask

Type what you want in the search box in plain words, such as "dark forest ambience longer than a minute" or "red
potion icons I rated highly", and press <kbd>Ctrl+Enter</kbd> (<kbd>⌘↵</kbd> on macOS), or pick **Ask Claude to turn
this into a search** (the first result when your words match nothing). Claude Haiku turns the words into the search
syntax, here `type:audio forest dur:>1m`. The search goes into the box, where you can see and change it, and Mimikit
runs it on your computer like one you typed. **Back to my words** puts your words back.

- **Your own key.** Turn on **Settings → General → AI features**, then add an Anthropic API key in **Settings → AI**
  ([get one](https://platform.claude.com/settings/keys)). Mimikit keeps it in the system's credential store (Windows
  Credential Manager, macOS Keychain, Secret Service on Linux), never in the library, its settings or its logs. The
  window never sees it: Mimikit's backend calls `api.anthropic.com` itself. **Remove** deletes it.
- **What's sent.** The words you typed, a description of the search syntax with examples, and the names of your 300
  most used tags, so `#tag` searches only use tags you have. Never file names, folder paths, file contents or
  thumbnails.
- **Model and effort.** **Settings → AI** picks the model, Claude Haiku 5.5 (the default), Sonnet 5.5 or Opus
  5.5, and the effort: how much it thinks before answering, Low (the default), Medium or High. A bigger model or more
  effort is slower and costs more, and Low on Haiku is enough for most searches.
- **Cost.** Billed to your API account: about $0.00015 a search with Haiku 5.5 at Low (measured: about 1,500 tokens in
  and under 25 out, answered in about a second). A few hundred tags add up to about 1,000 tokens more. Sonnet and Opus
  cost about 20 and 40 times as much per token.
- **Limits.** The search syntax has no pixel size, square or date terms, so those parts of a request are left out: use
  **More filters** for them. A search Mimikit can't read in full is shown, not run.
