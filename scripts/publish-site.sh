#!/bin/sh
# Builds the static demo and pushes it to the public site repo (GitHub Pages serves its root).
# The source repo stays private; only the built files and site/ (README, screenshots) are published.
#   scripts/publish-site.sh ["commit message"]
set -eu
SITE_REPO="${SITE_REPO:-knijesh/lionsgate-sme-credit-desk-site}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/scripts/build-static.js"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
gh repo clone "$SITE_REPO" "$TMP" -- -q
find "$TMP" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$ROOT/dist/." "$TMP/"
cp -R "$ROOT/site/." "$TMP/"
cd "$TMP"
git config user.name "$(git -C "$ROOT" config user.name)"
git config user.email "$(git -C "$ROOT" config user.email)"
git add -A
if git diff --cached --quiet; then echo "site unchanged"; exit 0; fi
git commit -q -m "${1:-Publish site from $(git -C "$ROOT" rev-parse --short HEAD)}"
git push -q origin HEAD
echo "published to https://github.com/$SITE_REPO"
