// Drive v3 calls as the signed-in user (through google.rs, which adds the token). Shows are often in shared drives,
// so every call asks for them.
import { backend, type DriveFile } from "../backend";

export const DRIVE = "https://www.googleapis.com/drive/v3/files";
export const FOLDER = "application/vnd.google-apps.folder";
export const ALL = "supportsAllDrives=true";
const IN_ALL = `${ALL}&includeItemsFromAllDrives=true`;
const enc = encodeURIComponent;

export const api = <T,>(method: string, url: string, body?: unknown) => backend.googleApi<T>(method, url, body);

/** A Drive query string literal: 'it''s' is written 'it\'s'. */
export const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** Every file matching `q`, page by page. `corpora=allDrives` covers My Drive, shared drives and Shared with me. */
export async function search(q: string, fields: string, everywhere = false): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let page: string | undefined;
  do {
    const res = await api<{ files?: DriveFile[]; nextPageToken?: string }>("GET",
      `${DRIVE}?q=${enc(q)}&fields=${enc(`nextPageToken,files(${fields})`)}&pageSize=1000&${IN_ALL}${everywhere ? "&corpora=allDrives" : ""}${page ? `&pageToken=${enc(page)}` : ""}`);
    out.push(...(res.files ?? []));
    page = res.nextPageToken;
  } while (page);
  return out;
}

export const children = (folder: string, fields = "id,name,mimeType,md5Checksum,size,modifiedTime") =>
  search(`${lit(folder)} in parents and trashed = false`, fields);

export async function child(folder: string, name: string, fields = "id,name,mimeType"): Promise<DriveFile | null> {
  return (await search(`${lit(folder)} in parents and name = ${lit(name)} and trashed = false`, fields))[0] ?? null;
}

export const getFile = (id: string, fields: string) => api<DriveFile>("GET", `${DRIVE}/${id}?fields=${enc(fields)}&${ALL}`);

export const patchFile = (id: string, body: object, params = "", fields = "id") =>
  api<DriveFile>("PATCH", `${DRIVE}/${id}?fields=${enc(fields)}&${ALL}${params ? `&${params}` : ""}`, body);

export const trashFile = (id: string) => patchFile(id, { trashed: true });

export const createFolder = (name: string, parent: string, properties?: Record<string, string>) =>
  api<DriveFile>("POST", `${DRIVE}?fields=${enc("id,name")}&${ALL}`, { name, mimeType: FOLDER, parents: [parent], ...(properties ? { properties } : {}) });

/** The folder `name` in `parent`, made if it isn't there. */
export async function ensureFolder(parent: string, name: string): Promise<string> {
  const found = await child(parent, name);
  return found?.id ?? (await createFolder(name, parent)).id;
}

/** A Drive "file not found" (deleted, or no longer shared with this user). */
export const notFound = (e: unknown) => /^(Error: )?Google 404/.test(String(e));

/** Google asking for fewer requests, or failing for a moment: worth trying again shortly. */
export const busy = (e: unknown) => /Google (429|50[0234])\b|Google 403: .*rate limit exceeded/i.test(String(e));

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `fn`, tried again (waiting longer each time, by a random amount so Macs don't retry together) while Google is busy. */
export async function patiently<T>(fn: () => Promise<T>, tries = 4, waitMs = 1000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !busy(e)) throw e;
      await pause(waitMs * 2 ** (i - 1) * (0.5 + Math.random()));
    }
  }
}

/** Values in Drive `properties` are limited to 124 bytes with their key: cut a value to fit. */
export function fitProperty(key: string, value: string): string {
  const room = 124 - new TextEncoder().encode(key).length;
  let out = value;
  while (new TextEncoder().encode(out).length > room) out = out.slice(0, -1);
  return out;
}
