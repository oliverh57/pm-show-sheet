// Who has a show open: each app writes "<name>|<time>" under its own key in the show folder's Drive properties every
// half minute (a PATCH only touches that key, so two people never overwrite each other), and anyone whose time is
// fresher than FRESH_MS has it open. The time can carry when they last edited it, as "<time>.<seconds before>", so
// older apps (which read the time as a number) still see when.
import { fitProperty, getFile, patchFile } from "./api";

const FRESH_MS = 3 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000; // well past FRESH_MS, so a key isn't cleared just as its owner writes it again
const PREFIX = "p_";

export interface Presence { email: string; name: string; at: number; editedAt?: number }

/** A short key per person: properties keys and values share 124 bytes, so the email itself is too long to use. */
export function presenceKey(email: string): string {
  let h = 2166136261;
  for (const c of email.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return `${PREFIX}${h.toString(36)}`;
}

/** Everyone but `email` whose presence is fresh, from a folder's properties. */
export function othersIn(properties: Record<string, string> | undefined, email: string, now = Date.now()): Presence[] {
  const mine = presenceKey(email);
  return Object.entries(properties ?? {})
    .filter(([k]) => k.startsWith(PREFIX) && k !== mine)
    .map(([, v]): Presence => {
      const [time, mail, ...name] = v.split("|");
      const [at, ago] = time.split(".").map(Number);
      return { at, email: mail, name: name.join("|") || mail, ...(ago >= 0 ? { editedAt: at - ago * 1000 } : {}) };
    })
    .filter((p) => now - p.at < FRESH_MS)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The presence keys no one has written for a while: apps that quit or slept without saying they'd left. They're cleared,
 * because a folder holds only 30 properties, and every person who ever left one that way would otherwise keep theirs.
 */
export function staleIn(properties: Record<string, string> | undefined, now = Date.now()): string[] {
  return Object.entries(properties ?? {})
    .filter(([k, v]) => k.startsWith(PREFIX) && !(now - Number(v.split("|")[0].split(".")[0]) < STALE_MS))
    .map(([k]) => k);
}

/** What `beat` writes: the time, when this Mac last edited the show (if it has since opening it), and who. */
export function presenceValue(email: string, name: string, editedAt: number | null, now = Date.now()): string {
  const ago = editedAt === null ? "" : `.${Math.max(0, Math.round((now - editedAt) / 1000))}`;
  return `${now}${ago}|${email}|${name}`;
}

/** "Edited just now", "Edited 5 mins ago", "Edited an hour ago", "Edited 3 hours ago". */
export function editedAgo(editedAt: number, now = Date.now()): string {
  const mins = Math.floor((now - editedAt) / 60_000);
  if (mins < 1) return "Edited just now";
  if (mins < 60) return `Edited ${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  return hours === 1 ? "Edited an hour ago" : `Edited ${hours} hours ago`;
}

/** Say "I have this show open" (and when I last edited it); returns everyone else who does. */
export async function beat(folderId: string, email: string, name: string, canEdit: boolean, editedAt: number | null): Promise<Presence[]> {
  const key = presenceKey(email);
  const folder = canEdit
    ? await patchFile(folderId, { properties: { [key]: fitProperty(key, presenceValue(email, name, editedAt)) } }, "", "properties")
    : await getFile(folderId, "properties");
  const stale = canEdit ? staleIn(folder.properties) : [];
  if (stale.length) patchFile(folderId, { properties: Object.fromEntries(stale.map((k) => [k, null])) }).catch(() => {});
  return othersIn(folder.properties, email);
}

/** Closing the show. */
export async function leave(folderId: string, email: string): Promise<void> {
  await patchFile(folderId, { properties: { [presenceKey(email)]: null } });
}
