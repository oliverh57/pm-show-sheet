import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import * as ops from "./model/ops";
import { useStore } from "./store";
import { initBackend } from "./backend";
import { initTheme } from "./theme";

initTheme();

// Dev-only handle for poking at state from the browser console.
if (import.meta.env.DEV) Object.assign(window, { __pm: { useStore, ops } });

initBackend().finally(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
