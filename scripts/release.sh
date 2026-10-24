#!/bin/bash
# Ship a new version:
#
#   scripts/release.sh 0.2.0 "What changed, in a sentence or two"
#
# Sets the version in package.json, tauri.conf.json and Cargo.toml, commits, tags v0.2.0 with the
# notes as the tag message, and pushes. The Release workflow then builds, signs and publishes it,
# and installed apps update themselves within a few hours (or on next launch).
#
# Add the version's notes to app/src/whatsNew.ts first: the app shows them once after updating.

set -euo pipefail

VERSION="${1:?usage: scripts/release.sh <version> \"notes\"}"
NOTES="${2:?give release notes as the second argument}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Version must look like 1.2.3"; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Commit or stash changes first."; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { echo "Release from main."; exit 1; }
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && { echo "v$VERSION already exists."; exit 1; }

VERSION="$VERSION" python3 - <<'EOF'
import json, os, re
v = os.environ["VERSION"]
for path in ("app/package.json", "app/src-tauri/tauri.conf.json"):
    data = json.load(open(path))
    data["version"] = v
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
toml = open("app/src-tauri/Cargo.toml").read()
toml = re.sub(r'(?m)^version = "[^"]+"', f'version = "{v}"', toml, count=1)
open("app/src-tauri/Cargo.toml", "w").write(toml)
lock = open("app/src-tauri/Cargo.lock").read()
lock = re.sub(r'(\[\[package\]\]\nname = "app"\nversion = )"[^"]+"', rf'\1"{v}"', lock, count=1)
open("app/src-tauri/Cargo.lock", "w").write(lock)
EOF
(cd app && npm install --package-lock-only --silent)

git add app/package.json app/package-lock.json app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -q -m "Release v$VERSION" -m "$NOTES"
git tag -a "v$VERSION" -m "$NOTES"
git push -q origin main "v$VERSION"
echo "Pushed v$VERSION. Watch the build: gh run watch --repo oliverh57/pm-show-sheet"
