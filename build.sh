#!/usr/bin/env bash
#
# Build a distributable zip of the extension (runtime files only), named after
# the `version` in manifest.json. See CLAUDE.md → Packaging.
#
# Usage:
#   ./build.sh                  Build a zip for the current manifest version
#   ./build.sh --bump patch     Bump version (patch|minor|major) in manifest.json, then build
#   ./build.sh --bump minor
#
# AMO rejects re-uploading an existing version, so by default this refuses to
# overwrite a zip that already exists — bump the version (manually or via
# --bump) before rebuilding.

set -euo pipefail
cd "$(dirname "$0")"

NAME="content-authenticity-checker"
MANIFEST="manifest.json"

# Runtime files the manifest references — everything the packaged extension needs,
# and nothing else (no CLAUDE*.md, eras_demo/, dotfiles).
FILES=(
  manifest.json
  background.js
  content.js
  phash.js
  popup.html
  popup.css
  popup.js
  icons
  lib
)

read_version() {
  grep -m1 '"version"' "$MANIFEST" | cut -d'"' -f4
}

# ── Optional version bump ───────────────────────────────────────────────────────
if [[ "${1:-}" == "--bump" ]]; then
  part="${2:-patch}"
  cur="$(read_version)"
  IFS='.' read -r major minor patch <<< "$cur"
  case "$part" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *) echo "error: --bump expects patch|minor|major, got '$part'" >&2; exit 1 ;;
  esac
  new="${major}.${minor}.${patch}"
  # Replace only the version line; -i.bak for BSD/GNU sed portability, then drop the backup.
  sed -i.bak "s/\"version\": \"${cur}\"/\"version\": \"${new}\"/" "$MANIFEST"
  rm -f "${MANIFEST}.bak"
  echo "Bumped version: ${cur} → ${new}"
elif [[ -n "${1:-}" ]]; then
  echo "error: unknown argument '$1' (expected --bump patch|minor|major)" >&2
  exit 1
fi

VERSION="$(read_version)"
if [[ -z "$VERSION" ]]; then
  echo "error: could not read version from $MANIFEST" >&2
  exit 1
fi
ZIP="${NAME}-${VERSION}.zip"

# ── Sanity checks ───────────────────────────────────────────────────────────────
missing=()
for f in "${FILES[@]}"; do
  [[ -e "$f" ]] || missing+=("$f")
done
if (( ${#missing[@]} )); then
  echo "error: missing runtime files: ${missing[*]}" >&2
  exit 1
fi

if [[ -e "$ZIP" ]]; then
  echo "error: $ZIP already exists — bump the version before rebuilding" >&2
  echo "       (try: ./build.sh --bump patch)" >&2
  exit 1
fi

# Remove stale zips from previous versions so only the current build remains.
shopt -s nullglob
for old in "${NAME}"-*.zip; do
  [[ "$old" == "$ZIP" ]] && continue
  echo "Removing stale build: $old"
  rm -f "$old"
done
shopt -u nullglob

# ── Build ───────────────────────────────────────────────────────────────────────
zip -r -X "$ZIP" "${FILES[@]}" -x '*.DS_Store' >/dev/null

echo "Built $ZIP ($(du -h "$ZIP" | cut -f1))"
