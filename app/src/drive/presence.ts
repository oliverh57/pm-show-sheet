// Who has a show open: each app writes "<name>|<time>" under its own key in the show folder's Drive properties every
// half minute (a PATCH only touches that key, so two people never overwrite each other), and anyone whose time is
// fresher than FRESH_MS has it open.
import { fitProperty, getFile, patchFile } from "./api";

const FRESH_MS = 3 * 60 * 1000;
const PREFIX = "p_";

export interface Presence { email: string; name: string; at: number }

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
    .map(([, v]) => {
      const [at, mail, ...name] = v.split("|");
      return { at: Number(at), email: mail, name: name.join("|") || mail };
    })
    .filter((p) => now - p.at < FRESH_MS)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Say "I have this show open"; returns everyone else who does. */
export async function beat(folderId: string, email: string, name: string, canEdit: boolean): Promise<Presence[]> {
  const key = presenceKey(email);
  const folder = canEdit
    ? await patchFile(folderId, { properties: { [key]: fitProperty(key, `${Date.now()}|${email}|${name}`) } }, "", "properties")
    : await getFile(folderId, "properties");
  return othersIn(folder.properties, email);
}

/** Closing the show. */
export async function leave(folderId: string, email: string): Promise<void> {
  await patchFile(folderId, { properties: { [presenceKey(email)]: null } });
}
