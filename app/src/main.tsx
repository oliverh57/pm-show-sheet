import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import * as ops from "./model/ops";
import { useStore } from "./store";
import { initBackend } from "./backend";
import { PopOutPlayer } from "./components/PopOutPlayer";
import { popOutParams } from "./popout";
import { initTheme } from "./theme";

initTheme();

// Dev-only handle for poking at state from the browser console.
if (import.meta.env.DEV) Object.assign(window, { __pm: { useStore, ops } });

// The pop-out player window (popout.ts) loads this same page, and shows only the player.
const popout = popOutParams();

initBackend().finally(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {popout ? <PopOutPlayer first={popout} /> : <App />}
    </React.StrictMode>,
  ),
);
