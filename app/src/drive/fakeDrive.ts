// An in-memory Google Drive and Mac disk for tests: just enough of the Drive API, and the backend calls the Drive copy
// of a show uses (download, upload, side files, open and save), so syncs can be run against it.
import { backend, type DriveFile } from "../backend";
import type { Show } from "../model/types";

interface FakeFile {
  name: string;
  parent: string;
  folder?: boolean;
  canEdit: boolean;
  properties: Record<string, string>;
  revisions: { id: string; content: string; modifiedTime: string }[];
}

export class FakeDrive {
  files = new Map<string, FakeFile>();
  disk = new Map<string, string>(); // path → JSON text
  uploads = 0;
  /** Runs just before each upload lands: lets a test have someone else save first. */
  beforeUpload: (() => void) | null = null;
  private n = 0;
  private clock = Date.parse("2026-10-26T12:00:00Z");

  private nextId(prefix: string) { return `${prefix}${++this.n}`; }
  private tick() { return new Date((this.clock += 1000)).toISOString(); }

  folder(name: string, parent = "root", properties: Record<string, string> = {}): string {
    const id = this.nextId("F");
    this.files.set(id, { name, parent, folder: true, canEdit: true, properties, revisions: [] });
    return id;
  }

  /** A new file, or (with `id`) someone else saving a new version of it. */
  put(content: unknown, at: { id?: string; name?: string; parent?: string }): string {
    const id = at.id ?? this.nextId("P");
    const f = this.files.get(id) ?? { name: at.name!, parent: at.parent!, canEdit: true, properties: {}, revisions: [] };
    f.revisions.push({ id: this.nextId("R"), content: JSON.stringify(content), modifiedTime: this.tick() });
    this.files.set(id, f);
    return id;
  }

  content<T = Show>(id: string): T { const f = this.files.get(id)!; return JSON.parse(f.revisions[f.revisions.length - 1].content) as T; }

  private meta(id: string): DriveFile {
    const f = this.files.get(id);
    if (!f) throw new Error("Google 404: File not found");
    const head = f.revisions[f.revisions.length - 1];
    return { id, name: f.name, parents: [f.parent], headRevisionId: head?.id, modifiedTime: head?.modifiedTime, properties: f.properties, capabilities: { canEdit: f.canEdit },
      mimeType: f.folder ? "application/vnd.google-apps.folder" : "application/json" };
  }

  /** Point the backend at this fake. */
  install() {
    const b = backend as unknown as Record<string, unknown>;
    b.googleApi = async (method: string, url: string, body?: Record<string, unknown>) => {
      const u = new URL(url);
      const path = u.pathname.replace("/drive/v3/files", "");
      if (method === "GET" && path === "") {
        const q = u.searchParams.get("q") ?? "";
        const parent = q.match(/'([^']+)' in parents/)?.[1];
        const name = q.match(/name = '([^']+)'/)?.[1];
        const files = [...this.files.keys()].filter((id) => {
          const f = this.files.get(id)!;
          return (!parent || f.parent === parent) && (!name || f.name === name);
        }).map((id) => this.meta(id));
        return { files };
      }
      const [, id, sub] = path.split("/");
      if (method === "GET" && sub === "revisions") {
        return { revisions: this.files.get(id)!.revisions.map(({ id: rid, modifiedTime }) => ({ id: rid, modifiedTime })) };
      }
      if (method === "GET") return this.meta(id);
      if (method === "PATCH") {
        const f = this.files.get(id)!;
        if (body?.properties) {
          for (const [k, v] of Object.entries(body.properties as Record<string, string | null>)) {
            if (v === null) delete f.properties[k]; else f.properties[k] = v;
          }
        }
        if (typeof body?.name === "string") f.name = body.name;
        return this.meta(id);
      }
      throw new Error(`fake Drive: ${method} ${url}`);
    };
    b.driveDownload = async (fileId: string, dest: string, revision?: string) => {
      const f = this.files.get(fileId);
      if (!f) throw new Error("Google 404: File not found");
      const rev = revision ? f.revisions.find((r) => r.id === revision)! : f.revisions[f.revisions.length - 1];
      this.disk.set(dest, rev.content);
    };
    b.driveUpload = async (path: string, to: { fileId?: string; parent?: string; name?: string }) => {
      this.uploads++;
      this.beforeUpload?.();
      const text = this.disk.get(path);
      if (text === undefined) throw new Error(`read file: ${path} is missing`);
      const id = this.put(JSON.parse(text), { id: to.fileId, parent: to.parent, name: to.name ?? path.split("/").pop() });
      return this.meta(id);
    };
    b.readJson = async (bundle: string, name: string) => {
      const text = this.disk.get(`${bundle}/${name}`);
      return text === undefined ? null : JSON.parse(text);
    };
    b.writeJson = async (bundle: string, name: string, value: unknown) => { this.disk.set(`${bundle}/${name}`, JSON.stringify(value)); };
    b.open = async (bundle: string) => {
      const text = this.disk.get(`${bundle}/project.json`);
      if (text === undefined) throw new Error("open project.json: missing");
      return JSON.parse(text);
    };
    b.save = async (bundle: string, show: Show) => { this.disk.set(`${bundle}/project.json`, JSON.stringify(show)); };
    b.driveCacheRoot = async () => "/cache";
  }
}
