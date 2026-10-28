# PM Show Sheet

Tauri 2 app (React + TypeScript in `app/src`, Rust in `app/src-tauri`). See `README.md` and `app/README.md`.

## Publishing a new version

Installed apps update themselves from GitHub Releases: they check
`https://github.com/oliverh57/pm-show-sheet/releases/latest/download/latest.json` on launch and every few
hours, then offer **Restart to update**. A release is what auto-update picks up; a local `npm run tauri build`
is not.

1. **Sync first.** Other sessions (often in `.claude/worktrees/`) may have released already. Run
   `git fetch --tags origin` and check `git status -sb` and `git tag --sort=-v:refname | head -3`.
   Bring `main` up to date with `origin/main` (rebase unpushed commits) before going on.
2. **Pick the version.** It must be higher than the latest `v*` tag (semver: patch for fixes, minor for
   features), or installed apps won't update to it. If the user asks for a number at or below the latest
   tag, say so and suggest the next one.
3. **Write the What's new entry.** Add it to the top of `WHATS_NEW` in `app/src/whatsNew.ts`: a one-line
   `summary` and short user-facing `items`, in plain words. The app shows it once after updating. Commit it.
4. **Check.** In `app/`: `npx tsc --noEmit -p .`, `npx vitest run`, and in `app/src-tauri`: `cargo test --lib`.
5. **Release** from the repo root, on `main` with a clean tree (untracked files are ignored):
   ```bash
   scripts/release.sh 0.5.3 "One or two sentences on what changed"
   ```
   It sets the version in `app/package.json`, `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, commits
   "Release vX.Y.Z", tags it with the notes as an annotated tag message, and pushes `main` and the tag.
   The notes become the GitHub release notes.
6. **Watch the build.** `.github/workflows/release.yml` builds a universal app, signs it and publishes the
   release with `latest.json` (about 16 minutes): `gh run list --repo oliverh57/pm-show-sheet --limit 3`
   or `gh run watch --repo oliverh57/pm-show-sheet`. Once it's green, installed apps pick it up.

Don't re-release with no changes, and never move or delete a published tag. If a build fails, fix it and
release the next patch version. Signing secrets live in GitHub secrets and `~/.tauri/`, never in the repo.
