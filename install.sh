#!/bin/bash
# Install PM Show Sheet on a Mac. Paste this into Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/oliverh57/pm-show-sheet/main/install.sh | bash
#
# Downloads the latest release into Applications and opens it. After that the app keeps itself
# up to date. Running it again reinstalls the latest version; shows and settings are untouched
# (they live in your .showsheet files, not in the app).
#
# Downloaded with curl, the app never gets macOS's "downloaded from the internet" flag, so there's
# no "unidentified developer" warning to click through.
#
# PMSS_DEST=… installs somewhere other than /Applications. PMSS_URL=… installs a different
# archive (a URL; file:// works) and PMSS_NO_OPEN=1 skips opening it, for testing this script.

set -euo pipefail

REPO="oliverh57/pm-show-sheet"
APP="PM Show Sheet.app"
URL="${PMSS_URL:-https://github.com/$REPO/releases/latest/download/PM-Show-Sheet.app.tar.gz}"
DEST="${PMSS_DEST:-/Applications}"

say() { printf '%s\n' "$*"; }
stop() { say ""; say "PM Show Sheet wasn't installed: $*"; exit 1; }

[ "$(uname -s)" = "Darwin" ] || stop "it's a Mac app, and this isn't a Mac."

say "PM Show Sheet"
say ""

if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  say "Can't write to /Applications, so installing to $DEST instead."
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading the latest version…"
curl -fsSL "$URL" | tar -xz -C "$TMP" || stop "couldn't download it. Check the internet connection and try again."
[ -d "$TMP/$APP" ] || stop "the download didn't contain $APP."

if pgrep -xq "PM Show Sheet"; then
  say "Closing the running copy…"
  osascript -e 'quit app "PM Show Sheet"' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq "PM Show Sheet" || break; sleep 0.5; done
fi

rm -rf "${DEST:?}/$APP"
mv "$TMP/$APP" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/$APP/Contents/Info.plist" 2>/dev/null || echo "?")"
say "Installed PM Show Sheet $VERSION in $DEST."
[ -n "${PMSS_NO_OPEN:-}" ] || { say "Opening it…"; open "$DEST/$APP"; }
