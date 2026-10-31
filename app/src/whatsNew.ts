// What's new in each version, shown once the first time the app opens after an update (see WhatsNew.tsx).
// Add an entry here before running scripts/release.sh; the newest entry goes first.

export interface ReleaseNotes {
  summary: string;
  items: string[];
}

export const WHATS_NEW: Record<string, ReleaseNotes> = {
  "0.8.1": {
    summary: "Open a show's Slides deck straight from its Google Sheet.",
    items: [
      "Once a show has a Slides deck, the banner at the top of the SHOW SHEET and REVIEW tabs has a ▶ SLIDES DECK link to it.",
    ],
  },
  "0.8.0": {
    summary: "Make a REAPER project of the running order, with its audio, LTC and clips.",
    items: [
      "A REAPER project… button on the Running order makes a project of the songs in the set, with a marker and the tempo at the start of each.",
      "Each song's audio is on one track and its LTC on another, so the LTC can go straight out to the desk without being heard.",
      "Clips go on their own tracks, grouped and colour coded by category, and lined up by their LTC so they play in time with the audio.",
      "Choose which categories and recordings to put in before saving.",
      "Clips that aren't on this Mac download from Google Drive first, with a progress bar, so REAPER never opens with media missing.",
    ],
  },
  "0.7.0": {
    summary: "Pop a video out to write notes while it plays, and quieter syncing with lots of people in a show.",
    items: [
      "Pop out a video into a small window that stays on top of the app, so you can write notes in the show while it plays.",
      "Only one Mac keeps the Google Sheet and deck up to date at a time. The others say whose Mac it is, and take over if they close the show.",
      "Clips show as cards with their thumbnail, length and category. Change a clip's category and its thumbnail moves with it.",
      "When Google is busy, saves wait a moment and try again, and saves from several people at once all make it in.",
      "A new still or clip never takes the name of one that's in the show but not on this Mac yet.",
      "Once AUDIO VERSION is deleted, it stays gone.",
    ],
  },
  "0.6.3": {
    summary: "Smoother syncing when several Macs have a show open.",
    items: [
      "When two Macs push the same change to the Google Sheet or deck at once, the app tries again instead of showing an error.",
      "A clash between the app and the Google Sheet is only asked about on the Mac that made the edit, not on everyone's.",
      "Deleting a clip on another Mac no longer leaves the thumbnail picker coming back to it.",
      "Recordings left with no clips or stills are removed, unless their file is on this Mac.",
      "Hovering over who else has the show open says when they last edited, even if they're on an older version.",
    ],
  },
  "0.6.2": {
    summary: "Changes no longer get stuck on this Mac when the connection drops.",
    items: [
      "If the connection to Google drops in the middle of a save, the app no longer waits for ever. Your changes were stuck on this Mac until you reopened the show; now they're saved as offline changes, for you to review and upload when Google Drive can be reached.",
    ],
  },
  "0.6.1": {
    summary: "Fixes for comments when several people have a show open, and progress for uploads.",
    items: [
      "Resolving or editing a comment in the Google Sheet while someone else has the show open no longer mixes up comments, or says you edited them all.",
      "Resolving a comment no longer asks you to pick between two versions that look the same.",
      "A card in the bottom-right corner shows media uploading to Google Drive or downloading from it.",
      "Hover over who else has the show open to see when they last edited it.",
      "While an update is downloading, shows stay shut until you restart to install it.",
    ],
  },
  "0.6.0": {
    summary: "Keep working when Google Drive can't be reached, and see who edited what.",
    items: [
      "Without a connection, your changes are saved on this Mac. When you're back online, look over each change and keep it or throw it away before it goes to Drive.",
      "When someone else edits the show, in the app or the Google Sheet, a notice says who changed which songs. Show edits highlights them in that person's colour.",
      "Importing asks fewer questions: a video is either split into songs or linked to one song, and the app finds the timecode itself.",
      "Several recordings can be added at once under one name. The Media page groups them and says which are on another Mac.",
      "The sidebar says what a sync is doing, and it copes better when Google is busy.",
      "Comments can be edited after they're posted.",
      "A new app icon.",
    ],
  },
  "0.5.4": {
    summary: "Control how much show media this Mac keeps, and change a song's thumbnail from the song.",
    items: [
      "Settings shows how much space show media takes up on this Mac. You can set a maximum: when it's full, the media used longest ago is deleted to make room. It stays in Google Drive.",
      "Each show in All shows can download all its media to this Mac, or make it online only.",
      "Change a song's thumbnail from its Media tab: pick another frame from the video, or choose an image file instead.",
      "Picking another frame works on a Mac without the show record too: the frames come from the song's clip.",
      "In the import timeline, a song can be dragged out past where the timecode starts or stops, to keep more of the record.",
      "Stills that no song uses any more can be deleted from the Media page.",
    ],
  },
  "0.5.3": {
    summary: "Clips play inside the show deck, and rehearsal stops are cut out of clips.",
    items: [
      "Song slides in the show deck play their clips right on the slide, next to the pictures, instead of linking to Drive.",
      "Long notes on a slide no longer run off the bottom: colours sit side by side, and the notes get smaller to fit.",
      "When a rehearsal stops and carries on, or rewinds to go again, it's still one take. Pauses over 15 seconds are cut out of the clip, which shows GAP CUT where it jumps.",
      "Each picture column has its own clip column in the Sheet and on the slide, like SONG CLIP and LX CLIP.",
      "Click a picture in a song to see it full screen.",
    ],
  },
  "0.5.2": {
    summary: "ffmpeg installs from inside the app, and macOS asks for your keychain password only once.",
    items: [
      "Installing ffmpeg takes one click: the app downloads it with a progress bar. No Terminal, Homebrew or Mac password.",
      "macOS no longer asks for your keychain password several times in a row after the app opens.",
    ],
  },
  "0.5.1": {
    summary: "Fixes for shows shared with someone on another Google account.",
    items: [
      "Google sync no longer stops for someone a show was just shared with. Until the Sheet's locked columns open to them, it waits, and the Sheet is kept up to date by whoever made the show.",
      "Their app adds them to the Sheet's lock by themselves the next time the show's owner has it open.",
      "@gmail.com and @googlemail.com addresses are known to be the same person, so nobody is listed twice or marked Outside.",
      "A show in a shared drive you aren't a member of says Shared with you, rather than \"a shared drive\".",
    ],
  },
  "0.5.0": {
    summary: "Google Drive for desktop isn't needed any more, and shows shared with you appear in All shows.",
    items: [
      "The app opens and saves shows in Google Drive itself. You can uninstall Google Drive for desktop if you don't use it for anything else.",
      "All shows lists shows shared with you as well as My Drive and shared drives, with where each one is. A show you can only view opens read only.",
      "Two people editing a show at once no longer overwrite each other: edits to different things both stay, and if you both changed the same thing, yours is kept and you're told.",
      "Other people's changes appear within about 10 seconds while you have a show open.",
      "New show and Move choose a folder in Google Drive, including shared drives and folders shared with you.",
      "Clips and images made on another Mac download the first time they're shown. Settings › Storage removes downloads to free up space; they come back when needed.",
      "A record or audio file that isn't on this Mac shows Locate… on the Media page.",
    ],
  },
  "0.4.0": {
    summary: "Burned-in timecode on clips, share links for the Sheet, and colour dropdowns in the Sheet.",
    items: [
      "Burn the timecode into clips: a card in the bottom-right corner with the song, the record's TC and its frame rate. Choose it when you add a show record.",
      "Share: generate a link for viewing or editing the Sheet, and copy it to send to anyone.",
      "Colour cells in the Google Sheet have a dropdown of gels and the show's colours, and fill with the colour you pick.",
      "Typed colour names forgive small slips: \"babypink\" or \"Babby Pink\" finds Baby Pink.",
      "Edits made in the Sheet while the app is syncing are no longer overwritten.",
      "Clip links in the Sheet open the right file after a show is moved or copied, and several clips in one cell are spaced apart.",
      "25 fps records with a stray garbled frame are no longer read as 29.97.",
      "Images show their name in a song's media, and each record shows only its own clip progress.",
    ],
  },
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
