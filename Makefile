# Local checks. These replace GitHub Actions on every push; the workflow only runs when started by hand.
# Recipes are plain commands so they run under sh (macOS/Linux, Git Bash) and cmd.exe.

CARGO_MANIFEST := --manifest-path src-tauri/Cargo.toml

.PHONY: check install typecheck ui ui-test test lint fmt fmt-check dev icons build release release-dry

## check: run before every push. Frontend typecheck, bundle and tests, rustfmt, clippy, Rust tests
check: ui ui-test fmt-check lint test

install:
	npm ci

typecheck:
	npm run typecheck

## ui: typecheck and production-bundle the frontend (what `tauri build` embeds)
ui:
	npm run build

## ui-test: frontend logic tests (plain Node, no test framework)
ui-test:
	node --experimental-strip-types src/lib/filter.test.ts
	node --experimental-strip-types src/lib/ask.test.ts
	node --experimental-strip-types src/lib/tagging.test.ts
	node --experimental-strip-types src/lib/folders.test.ts
	node --experimental-strip-types src/lib/scheduler.test.ts
	node --experimental-strip-types src/lib/sprites.test.ts
	node --experimental-strip-types src/lib/delta.test.ts
	node --experimental-strip-types src/lib/mtl.test.ts
	node --experimental-strip-types src/lib/ply.test.ts
	node --experimental-strip-types src/lib/latest.test.ts
	node --experimental-strip-types src/lib/fonts.test.ts
	node --experimental-strip-types src/lib/themes.test.ts
	node --experimental-strip-types src/lib/grid.test.ts
	node --experimental-strip-types src/lib/i18n.test.ts
	node --experimental-strip-types src/lib/locales.test.ts
	node --experimental-strip-types src/lib/news.test.ts
	node --experimental-strip-types src/agent/tools.test.ts
	node --experimental-strip-types src/agent/agent.test.ts
	node scripts/feed.test.mjs

test:
	cargo test $(CARGO_MANIFEST)

lint:
	cargo clippy $(CARGO_MANIFEST) --all-targets -- -D warnings

fmt:
	cargo fmt $(CARGO_MANIFEST)

fmt-check:
	cargo fmt $(CARGO_MANIFEST) -- --check

dev:
	npm run tauri dev

## icons: rebuild src-tauri/icons from icon/ (the chest, its macOS tile and the hand-drawn 16 px frame)
icons:
	node scripts/icons.mjs

## build: installers for the current OS, signed for updates when ~/.tauri/asset-den.key exists (see docs/releasing.md)
build:
	node scripts/release.mjs --build-only

## release: build, sign and publish the Windows installer and its update-feed entries to the repo's releases
## (macOS and Linux come from the Release workflow; see docs/releasing.md)
release:
	node scripts/release.mjs

## release-dry: the same build and feed in release/v<version>/, without uploading anything
release-dry:
	node scripts/release.mjs --dry-run
