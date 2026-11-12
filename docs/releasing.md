# Publishing a release

Every release carries all three OSes in one GitHub release and one `latest.json`. Windows is built and signed on a
Windows PC with `make release`; macOS and Linux are built by the **Release** workflow on GitHub Actions. Each merges its
entries into the release's `latest.json` instead of replacing it, so they can run in either order.

1. Bump the version in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`.
2. Move the Unreleased notes in `CHANGELOG.md` under `## [x.y.z] - date`. That section becomes the release notes and
   the in-app "What's new". Push the commit.
3. Run the **Release** workflow from the Actions tab on that branch, with the version (`x.y.z`), or
   `gh workflow run Release --ref master -f version=x.y.z`. It builds the universal macOS `.app` and `.dmg` and the
   Linux AppImage and `.deb`, signs the update bundles, and adds them to release `vx.y.z`,
   creating it as a draft if it doesn't exist yet.
4. Run `make release-dry` to build, sign and write `release/vx.y.z/` (installer, `latest.json`, notes) without
   uploading, then `make release` to upload the Windows installer, merge its feed entries and publish the release as
   latest.

Running the workflow first is the smooth order: the draft stays invisible to installed copies until `make release`
publishes it with every platform in the feed. If `make release` goes first, macOS and Linux copies get a "platform not
found" error from **Check for updates** (the launch check stays quiet) until the workflow finishes. Re-running either
replaces only its own files and feed entries. Don't run both at the same moment: the second could overwrite the
first's feed entries.

Before a release that changes how the macOS app is signed or which ONNX Runtime search by meaning downloads, run the
**macOS search by meaning** workflow (`gh workflow run macos-meaning.yml --ref <branch>`, about 25 minutes). It runs
the signed app and checks that it loads the runtime. A Developer ID signature would make macOS refuse Microsoft's
library: that change also needs `com.apple.security.cs.disable-library-validation` in an entitlements file.

Updates are signed with `~/.tauri/asset-den.key`, created with `npx tauri signer generate`, whose public half is in
`tauri.conf.json`. **Back it up somewhere safe and never commit it:** installed copies only accept updates signed with
it, so losing it means users must reinstall by hand. `make build` signs too when the key is present, and otherwise
builds plain installers with a warning.

The workflow needs two repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The contents of `~/.tauri/asset-den.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password. Skip it if the key has none: GitHub doesn't store empty secrets, and an unset one reads as empty. |
