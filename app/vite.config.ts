import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;
// The browser preview (npm run dev without Tauri) may read files inside the project folder only.
const PROJECT_ROOT = path.resolve(__dirname, "..");

function insideProject(p: string | null): p is string {
  return !!p && path.resolve(p).startsWith(PROJECT_ROOT + path.sep);
}

/** Dev-only stand-ins for the Rust list_folder / probe_media commands, so the UI can be worked on in a browser. */
function devFiles(): Plugin {
  return {
    name: "pm-dev-files",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__pm/list", (req, res) => {
        const url = new URL(req.url ?? "", "http://x");
        const folder = url.searchParams.get("folder");
        const exts = (url.searchParams.get("ext") ?? "").split(",");
        if (!insideProject(folder)) return void res.writeHead(403).end();
        const files = fs.readdirSync(folder)
          .filter((n) => !n.startsWith(".") && exts.includes(path.extname(n).slice(1).toLowerCase()))
          .map((name) => {
            const st = fs.statSync(path.join(folder, name));
            return { path: path.join(folder, name), name, size: st.size, modified_ms: Math.round(st.mtimeMs) };
          })
          .sort((a, b) => a.modified_ms - b.modified_ms);
        res.setHeader("content-type", "application/json").end(JSON.stringify(files));
      });
      server.middlewares.use("/__pm/probe", (req, res) => {
        const file = new URL(req.url ?? "", "http://x").searchParams.get("path");
        if (!insideProject(file)) return void res.writeHead(403).end();
        execFile("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], (err, out) => {
          if (err) return void res.setHeader("content-type", "application/json").end(JSON.stringify({ available: false }));
          const raw = JSON.parse(out);
          const v = raw.streams.find((s: { codec_type: string }) => s.codec_type === "video");
          const a = raw.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
          const [n, d] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
          res.setHeader("content-type", "application/json").end(JSON.stringify({
            available: true, duration: Number(raw.format.duration), width: v?.width, height: v?.height,
            fps: d ? Math.round((n / d) * 1000) / 1000 : null, video_codec: v?.codec_name,
            audio_channels: a?.channels, sample_rate: a ? Number(a.sample_rate) : null,
          }));
        });
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), devFiles()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Lets the browser preview show images and video from the example content via /@fs/.
    fs: { allow: [PROJECT_ROOT] },
  },
}));
