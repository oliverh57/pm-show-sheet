// The whole page of the pop-out player window (see popout.ts): the video, filling the window, and a pin that
// keeps it above other windows (on by default). Space plays and pauses.
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { POPOUT_EVENT, popOutTitle, type PopOut } from "../popout";
import "../App.css";
import { Icon } from "./icons";
import { MediaPlayer } from "./Player";

export function PopOutPlayer({ first }: { first: PopOut }) {
  const [p, setP] = useState(first);
  const [onTop, setOnTop] = useState(true);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const stop = listen<PopOut>(POPOUT_EVENT, (e) => setP(e.payload));
    return () => { stop.then((f) => f()); };
  }, []);

  useEffect(() => { getCurrentWindow().setTitle(popOutTitle(p)).catch(() => {}); }, [p]);

  // Carry on from where the main window left off.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = () => {
      el.currentTime = p.at;
      if (p.play) el.play().catch(() => {});
    };
    if (el.readyState >= 1) start();
    else el.addEventListener("loadedmetadata", start, { once: true });
    return () => el.removeEventListener("loadedmetadata", start);
  }, [p]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key !== " " || !el || e.target instanceof HTMLMediaElement || e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      if (el.paused) el.play().catch(() => {}); else el.pause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pin = () => {
    getCurrentWindow().setAlwaysOnTop(!onTop).catch(() => {});
    setOnTop(!onTop);
  };

  return (
    <div className="popout">
      <MediaPlayer path={p.path} video ltc={p.ltc} channels={p.channels} mediaRef={ref} popOut={false} />
      <button className={`icon popout-pin ${onTop ? "on" : ""}`} title={onTop ? "Stop keeping on top" : "Keep on top of other windows"} onClick={pin}>
        <Icon name="pin" size="sm" />
      </button>
    </div>
  );
}
