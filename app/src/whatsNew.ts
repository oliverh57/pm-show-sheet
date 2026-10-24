// What's new in each version, shown once the first time the app opens after an update (see WhatsNew.tsx).
// Add an entry here before running scripts/release.sh; the newest entry goes first.

export interface ReleaseNotes {
  summary: string;
  items: string[];
}

export const WHATS_NEW: Record<string, ReleaseNotes> = {
  "0.2.0": {
    summary: "A redesigned app, with shows kept in Google Drive and synced to a live Google Sheet and Slides deck.",
    items: [
      "New look: a light, macOS-style design with a sidebar (Songs ⌘1, Media ⌘2, Share ⌘3, Sheet ⌘4) and a dark mode.",
      "Sign in with Google. Shows live in a Pixelmappers Show Sheets folder in Google Drive, and All shows lists every show in your Drive and shared drives.",
      "See who else has a show open, right in the sidebar.",
      "Songs as cards in running order: drag to reorder, add songs by typing or pasting a set list, and keep note fields like Lighting and Camera direction on each card.",
      "Media: drop files in and say what they are. Show records and audio are read for LTC and split into songs automatically, or mark songs by hand with M.",
      "Per-song clips and stills are cut in the background with ffmpeg; the app helps you install ffmpeg if it's missing.",
      "Share & publish: a Google Sheet and Slides deck that stay in sync with the show while it's open.",
      "Categories and fields: reorder, recolour and add your own in Columns.",
    ],
  },
};

const SEEN_KEY = "pm.lastSeenVersion";

export function lastSeenVersion(): string | null {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}

export function markVersionSeen(version: string) {
  try { localStorage.setItem(SEEN_KEY, version); } catch { /* storage unavailable */ }
}
