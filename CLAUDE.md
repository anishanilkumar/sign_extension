# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

There is no compile/transpile step — the extension runs directly from source. The only "build" is zipping the runtime files for distribution (see Packaging).

**Load in Firefox:**
1. Open `about:debugging` → "This Firefox" → "Load Temporary Add-on"
2. Select `manifest.json`

**Reload after changes:** click the "Reload" button on `about:debugging`. Background script changes require a reload; content script changes take effect on the next page load. Popup changes take effect immediately on next popup open.

**Inspect the background page:** on `about:debugging`, click "Inspect" next to the extension — this opens DevTools for the background page, where you can see console logs from `background.js` and `phash.js` and inspect `browser.storage.local`.

**Inspect the popup:** right-click the toolbar icon → "Inspect Element".

**Manual test harness:** `eras_demo/index.html` is a local gallery page serving the same image three ways — original (`taylor-swift-eras-tour.jpg`), a re-encode (`.png`), and a tampered copy (`...altered.jpeg`) — so you can eyeball the verified / authentic / possibly_modified badge tiers against a registered original. Open it via `file://` (the manifest grants `file:///*`).

## Packaging

A release is just a zip of the **runtime files only** (everything the manifest references), named after the `version` in `manifest.json`. `*.zip` / `*.xpi` are gitignored, so build artifacts are never committed.

**Always bump `version` in `manifest.json` before building** — every new build gets a new version (AMO rejects a re-upload of an existing version, and the filename is derived from it). Use semver: patch for fixes, minor for new features.

Use the tracked **`build.sh`** (runtime files only, named after the manifest version) from the repo root:

```bash
./build.sh --bump patch    # bump version (patch|minor|major) in manifest.json, then build
./build.sh                 # build the current manifest version as-is
```

`build.sh` reads the version, verifies every runtime file exists, removes stale zips, and zips the manifest-referenced files only. It **refuses to overwrite an existing version's zip** — so a forgotten bump fails loudly instead of producing an unuploadable artifact; recover with `./build.sh --bump patch`. Deliberately **excluded** from the zip: `CLAUDE.md`, `CLAUDE_SIGN.md`, `eras_demo/`, `build.sh`, and any dotfiles. `CLAUDE_SIGN.md` documents the separate FastAPI signing **server** (the source of `/api/db/export`); it is not part of this extension.

## Architecture

The extension has three isolated execution contexts that communicate only via message passing:

### 1. Background page (`lib/openpgp.min.js` + `phash.js` + `background.js`)
Loaded once, non-persistent (event-driven). Owns all privileged operations:
- Fetches the hash DB from `GET /api/db/export` on the server and stores it in `browser.storage.local`
- Handles DB refresh on the `authenticity-db-refresh` alarm (every 60 min) and on `manualRefresh` messages
- Receives `scanImages` messages from content scripts; for each image URL it cross-origin `fetch()`es the bytes, computes SHA-256 (`crypto.subtle`) of the raw bytes plus 64-bit and 256-bit pHashes from pixels drawn to a native-resolution `document.createElement('canvas')`, then runs tiered `findBestMatch()` and OpenPGP `verifyEntrySignature()` (see "Tiered matching" below)
- Caches per-tab scan results in `tabResultsCache` (in-memory Map, lost on background restart)
- Updates the toolbar badge colour/count

The background page has a real DOM (MV2), which is why `document.createElement` works for canvas-based pixel extraction.

### 2. Content script (`content.js`)
Runs in every http/https/file page. Does no hashing itself — it only:
- Collects `<img>` src URLs and sends them to the background via `scanImages`
- Draws a corner **badge** (✓ green for `verified`/`authentic`, ✗ red for `possibly_modified`/`signature_invalid`) into a single fixed-position layer anchored to each image's viewport rect — survives clipped/`object-fit` feed containers (e.g. Facebook) where an `outline` failed. `data-auth-status` / `data-auth-url` attributes track overlaid elements; badges re-anchor on scroll/resize. The `signature_invalid` badge is enlarged, ringed, and CSS-pulsed so it can't be mistaken for a plain `possibly_modified` cross
- On badge hover, shows a **tooltip** built from the full per-image scan result (creator, match %, signature status, key fingerprint, registered date) — the result object, not just the status string, is kept in `applyResults`/`applyOverlay` for this
- Debounces re-scans via `MutationObserver` (1.5 s) to handle SPAs and lazy loading; re-scans on `triggerScan` after a background-cache loss
- Listens for `scrollToImage` to animate a yellow flash and scroll to a specific image

Badge/tooltip appearance lives in a single injected `<style>` element (`ensureBadgeStyles`), not inline styles — a stylesheet is CSP-safe and can express the keyframe pulse. All tooltip/popup DOM that interpolates DB or page values is built with `textContent` only (never `innerHTML`), so untrusted strings can't inject markup.

### 3. Popup (`popup.html` + `popup.js`)
Queries the background for DB info (`getDbInfo`) and cached tab results (`getCachedResults`). Each result row is a collapsible **accordion** (one open at a time; a lone result auto-opens) whose body holds a thumbnail plus signature details; clicking the thumbnail sends `scrollToImage` to the content script via `browser.tabs.sendMessage` (not through the background). Receives live DB status pushes via `browser.runtime.onMessage` while open.

## Critical constraint: pHash compatibility

`phash.js` reimplements Python's `imagehash.phash()` in JavaScript and must stay **byte-for-byte** identical to the server. To achieve this the extension decodes each image at native resolution and runs PIL's exact pipeline in JS — it does **not** rely on canvas scaling:
- **Grayscale:** PIL `convert("L")` integer formula `(R*19595 + G*38470 + B*7471 + 0x8000) >> 16` (`_toGrayPIL`)
- **Resize:** a port of PIL's Lanczos (a=3) separable resampler with uint8 clipping between passes (`_lanczosResizeGray`), matching `Image.resize(..., LANCZOS)`
- **DCT:** unnormalized DCT-II matching `scipy.fft.dct(type=2, norm=None)`
- **Hash:** `_hashFromGray(gray, size, hashSize)` — top-left `hashSize²` DCT block vs `median`, packed MSB-first → `(hashSize²/4)`-char lowercase hex

Two hash sizes are computed per image via `computePHashFromRGBA(rgba, w, h, {size, hashSize})`:
- 64-bit: `{size:32, hashSize:8}` → 16 hex chars (`imagehash.phash`)
- 256-bit: `{size:64, hashSize:16}` → 64 hex chars (`imagehash.phash(img, hash_size=16)`)

These are verified byte-for-byte against PIL in CI-style parity harnesses. If the server changes pHash parameters, `phash.js` must change in sync.

## Tiered matching + signature verification

`findBestMatch(target, db)` where `target = { sha256, phash64, phash256 }` returns the **strongest** tier (`background.js` computes the hashes from the fetched bytes/pixels: `crypto.subtle` SHA-256 + both pHashes):
1. **`verified`** — exact `sha256` of the raw bytes matches (`matchType:'exact'`). Byte-for-byte identical original; catches any change incl. 1px, but only on the unmodified file (re-encoding breaks it).
2. **256-bit perceptual** — Hamming ≤ 24/256 (`MATCH_MAX_DISTANCE_256`) over entries carrying `phash256`. `authentic` at 0, else `possibly_modified`.
3. **64-bit perceptual** — Hamming ≤ 9/64 (`MATCH_MAX_DISTANCE_64`) for legacy entries without `phash256`.

After a hash match, `verifyEntrySignature` (in `background.js`, using vendored `lib/openpgp.min.js`) verifies the entry's OpenPGP clearsigned `signed_assertion` against `creator_public_key` **and** confirms the matched hash is the value inside the signed JSON. Failure forces status `signature_invalid`. `signatureValid` is `true` / `false` / `null` (no signature material). Thresholds mirror the server's `fingerprint.py`.

Each scanned image returns `{ url, status, matchType, distance, bits, entry, signatureValid, signatureReason, hashes }` (or a bare `{ url, status }` for `hash_failed` / `not_found`). The content-script tooltip and popup both consume this shape.

**Signature display invariant** (content tooltip and popup agree): a signature reads **Valid** only when `signatureValid === true` **and** the match is `verified`/`authentic` — any modified image reports **Invalid**, because the signature covers the registered original and a changed image is not that original. `null` shows as "Not checked". Keep both renderers in sync if this rule changes.

## Server dependency

The extension polls `GET /api/db/export` on the configured server (default `https://sign.authentiverse.net`). Expected response shape (schema 2):

```json
{
  "generated_at": "<ISO timestamp>",
  "schema_version": "2",
  "count": 42,
  "entries": [
    {
      "id": "<uuid>",
      "phash": "<16-char hex>",
      "phash256": "<64-char hex>|null",
      "sha256": "<64-char hex>|null",
      "creator_name": "string",
      "creator_handle": "string|null",
      "creator_fingerprint": "<40-char hex>",
      "creator_public_key": "<armored PGP public key>",
      "signed_assertion": "<OpenPGP clearsign block>",
      "registered_at": "<ISO timestamp>",
      "title": "string|null"
    }
  ]
}
```

`phash256`/`sha256` are null for legacy rows registered before schema 2 (originals no longer on disk) — those degrade to 64-bit perceptual matching only. `creator_public_key` + `signed_assertion` let the extension verify signatures fully offline.

The lighter `GET /api/db/version` endpoint (returns `{ count, latest_at }`) exists for future use to avoid re-downloading unchanged data.

## Storage layout (`browser.storage.local`)

| Key | Type | Description |
|-----|------|-------------|
| `db` | object | Full response from `/api/db/export` |
| `dbStatus` | string | `'updating'` / `'ready'` / `'error'` |
| `dbFetchedAt` | ISO string | Timestamp of last successful fetch |
| `dbError` | string\|null | Last error message |
| `serverUrl` | string | Overrides `DEFAULT_SERVER_URL` |

## Message protocol

All messages use `{ type: '...' }`. Messages from content → background use `browser.runtime.sendMessage`; background → popup uses the same (popup listens). Popup → content uses `browser.tabs.sendMessage` directly.

| `type` | Direction | Purpose |
|--------|-----------|---------|
| `scanImages` | content → bg | `{ urls: string[] }` → `{ ok, results }` |
| `getCachedResults` | popup → bg | `{ tabId }` → `{ results }` |
| `manualRefresh` | popup → bg | Triggers immediate DB fetch |
| `getDbInfo` | popup → bg | Returns status/count/timestamps |
| `getSettings` / `saveSettings` | popup → bg | Server URL CRUD |
| `dbStatus` | bg → popup | Live push: `{ status, count?, error? }` |
| `scanResults` | bg → popup | Live push: `{ tabId, results }` after a scan |
| `scrollToImage` | popup → content | `{ url }` — scroll + flash animation |
| `triggerScan` | bg → content | Force a re-scan when the bg cache was lost |
