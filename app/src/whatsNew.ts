// What's new in each version, shown once the first time the app opens after an update (see WhatsNew.tsx).
// Add an entry here before running scripts/release.sh; the newest entry goes first.

export interface ReleaseNotes {
  summary: string;
  items: string[];
}

export const WHATS_NEW: Record<string, ReleaseNotes> = {
  "0.3.0": {
    summary: "Comments on videos and images, synced with a REVIEW tab in the Google Sheet, and a way to free up space on this Mac.",
    items: [
      "Comment on clips, records and images, Frame.io style: timecoded markers under the video, ranges (I then O), drawings on the frame, replies and resolve. Press C to write one.",
      "Clips and records play full screen in a viewer, with their comments beside it.",
      "A Comments page lists every comment by song, each song has a Comments tab, and song cards show how many are open.",
      "The Google Sheet has a REVIEW tab: collaborators can reply, resolve, edit or add comments there, and they come back into the app.",
      "Resolved comments are deleted after 3 days; change that, or keep them, in Show settings.",
      "Present has a Comments tab for the image or clip on screen.",
      "Storage in App settings: make records, audio and clips you haven't opened for a while online only, or every show's files at once.",
      "Tidier Show and App settings, with a Check for updates button.",
    ],
  },
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
