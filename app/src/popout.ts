// The pop-out player: a video in its own small window that floats over the app, so notes can be written in the
// show while it plays. There's one such window; popping out another video swaps what it plays.
// The window loads this same app with ?popout=… and main.tsx shows only the player (components/PopOutPlayer.tsx).
import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { message } from "@tauri-apps/plugin-dialog";

export interface PopOut {
  path: string; // absolute path on disk
  label?: string; // the window's title (else the file's name)
  ltc?: number | null;
  channels?: number | null;
  at: number; // seconds: carry on from here
  play: boolean;
}

export const POPOUT_WINDOW = "player"; // also in src-tauri/capabilities/popout.json and lib.rs
export const POPOUT_EVENT = "popout:load";

export const popOutTitle = (p: PopOut) => p.label || p.path.split("/").pop() || "Video";

/** Play `p` in the pop-out window, opening it if it isn't open. Says so if it can't. */
export async function popOut(p: PopOut) {
  try {
    await show(p);
  } catch (e) {
    message(`Couldn't pop the video out: ${e}`, { title: "PM Show Sheet", kind: "error" }).catch(() => {});
  }
}

async function show(p: PopOut) {
  const open = await WebviewWindow.getByLabel(POPOUT_WINDOW);
  if (open) {
    await emitTo(POPOUT_WINDOW, POPOUT_EVENT, p);
    await open.setFocus();
    return;
  }
  const w = new WebviewWindow(POPOUT_WINDOW, {
    url: `index.html?popout=${encodeURIComponent(JSON.stringify(p))}`,
    title: popOutTitle(p),
    width: 720,
    height: 440,
    minWidth: 320,
    minHeight: 200,
    alwaysOnTop: true,
  });
  await new Promise<void>((resolve, reject) => {
    w.once("tauri://created", () => resolve());
    w.once<string>("tauri://error", (e) => reject(e.payload));
  });
}

/** In the pop-out window, what it opened with; null in the main window. */
export function popOutParams(): PopOut | null {
  const raw = new URLSearchParams(window.location.search).get("popout");
  if (!raw) return null;
  try { return JSON.parse(raw) as PopOut; } catch { return null; }
}
