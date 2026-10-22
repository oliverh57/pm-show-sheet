#!/bin/bash
# Sign a built PM Show Sheet.app and package it as an update, ready for a GitHub Release.
#
#   scripts/package-release.sh <version> [notes]
#
# Expects the universal build at app/src-tauri/target/universal-apple-darwin/release/bundle/macos/.
# Writes to dist/release/:  PM-Show-Sheet.app.tar.gz, its .sig, and latest.json (what the
# in-app updater reads). Run by .github/workflows/release.yml; works locally too.
#
# Secrets come from the environment (GitHub secrets in CI) or from ~/.tauri on this Mac:
#   PMSS_CODESIGN_P12 / PMSS_CODESIGN_P12_PASSWORD     base64 .p12 and its password (macOS code signing)
#   TAURI_SIGNING_PRIVATE_KEY / ..._PASSWORD           updater key and its password
#
# Code signing uses a fixed self-signed certificate, so every release has the same identity and
# macOS keeps the app's folder-access permissions across updates. rcodesign signs straight from
# the .p12 (codesign would need the certificate trusted in a keychain).

set -euo pipefail

VERSION="${1:?usage: package-release.sh <version> [notes]}"
NOTES="${2:-}"
REPO="${PMSS_REPO:-oliverh57/pm-show-sheet}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/app/src-tauri/target/universal-apple-darwin/release/bundle/macos"
APP="$APP_DIR/PM Show Sheet.app"
OUT="$ROOT/dist/release"
ASSET="PM-Show-Sheet.app.tar.gz"
KEYS="$HOME/.tauri"

[ -d "$APP" ] || { echo "No build at $APP. Run: npm run tauri build -- --target universal-apple-darwin --bundles app"; exit 1; }
BUILT="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[ "$BUILT" = "$VERSION" ] || { echo "The build is $BUILT but this release is $VERSION. Bump with scripts/release.sh."; exit 1; }

RCODESIGN="$(command -v rcodesign || echo "$HOME/.cargo/bin/rcodesign")"
[ -x "$RCODESIGN" ] || { echo "rcodesign not found: cargo install apple-codesign --locked"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- code signing --------------------------------------------------------------
if [ -n "${PMSS_CODESIGN_P12:-}" ]; then
  printf '%s' "$PMSS_CODESIGN_P12" | base64 --decode > "$WORK/codesign.p12"
  printf '%s' "${PMSS_CODESIGN_P12_PASSWORD:?}" > "$WORK/codesign.pass"
else
  cp "$KEYS/codesign.p12" "$WORK/codesign.p12"
  cp "$KEYS/codesign.p12.password" "$WORK/codesign.pass"
fi
"$RCODESIGN" sign --p12-file "$WORK/codesign.p12" --p12-password-file "$WORK/codesign.pass" "$APP" >/dev/null
codesign --verify --deep --strict "$APP"
echo "Signed: $(codesign -d -r- "$APP" 2>&1 | grep designated)"

# --- update archive + updater signature ----------------------------------------
rm -rf "$OUT" && mkdir -p "$OUT"
COPYFILE_DISABLE=1 tar -czf "$OUT/$ASSET" -C "$APP_DIR" "PM Show Sheet.app"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEYS/pm-show-sheet.key")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$KEYS/pm-show-sheet.key.password")"
fi
(cd "$ROOT/app" && npx --no-install tauri signer sign "$OUT/$ASSET" >/dev/null)
SIG="$(cat "$OUT/$ASSET.sig")"

# --- latest.json: what installed apps check ------------------------------------
URL="https://github.com/$REPO/releases/download/v$VERSION/$ASSET"
VERSION="$VERSION" NOTES="$NOTES" SIG="$SIG" URL="$URL" python3 - > "$OUT/latest.json" <<'EOF'
import json, os, datetime
entry = {"signature": os.environ["SIG"], "url": os.environ["URL"]}
print(json.dumps({
    "version": os.environ["VERSION"],
    "notes": os.environ["NOTES"],
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {"darwin-aarch64": entry, "darwin-x86_64": entry},  # one universal build for both
}, indent=2))
EOF
ls -lh "$OUT"
