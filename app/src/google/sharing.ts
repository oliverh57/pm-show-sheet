// Sharing the open show from the app (Share & publish → People), with Drive permissions. Two kinds:
// - the Sheet and deck, for people who work in them, with the media they show (the clips the Sheet links to and the
//   images it and the deck use) to view, so those open for them too;
// - the whole show (its .showsheet folder), for a collaborator who'll use it in the app. They're added to the people
//   who use the show in the app (google.app_editors), so their sync can write the Sheet's locked columns.
// Nothing else is stored: who has what is read back from Drive.
import { backend } from "../backend";
import { driveIdOf } from "../drive/media";
import { readManifest } from "../drive/show";
import { useStore } from "../store";
import { emailKey } from "./sheet";

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const ALL = "supportsAllDrives=true";
const api = <T,>(method: string, url: string, body?: unknown) => backend.googleApi<T>(method, url, body);

export type Access = "edit" | "comment" | "view" | "app";

/** What can be given, in the order it's offered. */
export const ACCESS: { id: Access; label: string; hint: string }[] = [
  { id: "edit", label: "Sheet & deck: can edit ✎ columns", hint: "They edit the ✎ columns in the Sheet, and comment on the deck. The clips and images they show open for them." },
  { id: "comment", label: "Sheet & deck: can comment", hint: "They read and comment on the Sheet and deck, and open the clips and images they show." },
  { id: "view", label: "Sheet & deck: can view", hint: "They read the Sheet and deck, and open the clips and images they show." },
  { id: "app", label: "Whole show: use it in the app", hint: "The show's folder in Drive: the show itself, all its media, the Sheet and deck. They can change and delete anything in it." },
];

type Role = "reader" | "commenter" | "writer";
/** Drive roles for each kind of access: on the Sheet, the deck (redrawn by the app, so never edited) and the media folders. */
const ROLES: Record<Exclude<Access, "app">, { sheet: Role; deck: Role; media: Role }> = {
  edit: { sheet: "writer", deck: "commenter", media: "reader" },
  comment: { sheet: "commenter", deck: "commenter", media: "reader" },
  view: { sheet: "reader", deck: "reader", media: "reader" },
};

interface Permission {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: string;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
  photoLink?: string;
  permissionDetails?: { inherited?: boolean }[];
}

export interface Person {
  email: string; // or the domain, for "everyone at …"
  name: string;
  photo?: string;
  /** What they were given from the app (or in Drive, on these files); null when they only have it through the shared drive or a parent folder. */
  access: Access | null;
  /** They can open it through the shared drive or a folder above the show (not removable here). */
  inherited: boolean;
  role: string; // their strongest Drive role on the show ("owner", "organizer", "writer"…)
  /** Their own permissions on the show's files, removed when they're removed. */
  grants: { file: string; permission: string }[];
}

/** The show's Drive files: its folder, the Sheet, the deck and the two media folders the Sheet and deck use. */
async function showFiles() {
  const { show, bundle } = useStore.getState();
  const gs = show?.google ?? {};
  const folder = gs.folder_id ?? (bundle ? (await readManifest(bundle)).folderId : null);
  if (!folder) throw new Error("No show is open");
  const clips = bundle ? await driveIdOf(`${bundle}/media/clips`, bundle).catch(() => null) : null;
  return { folder, sheet: gs.spreadsheet_id, deck: gs.presentation_id, media: [gs.media_folder_id, clips].filter((x): x is string => Boolean(x)) };
}

async function permissions(file: string): Promise<Permission[]> {
  const fields = "permissions(id,type,role,emailAddress,domain,displayName,photoLink,permissionDetails(inherited))";
  const res = await api<{ permissions?: Permission[] }>("GET", `${DRIVE}/${file}/permissions?${ALL}&fields=${encodeURIComponent(fields)}&pageSize=100`);
  return res.permissions ?? [];
}

const RANK = ["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"];
const direct = (p: Permission) => !(p.permissionDetails ?? []).some((d) => d.inherited);
const keyOf = (p: Permission) => (p.emailAddress ? emailKey(p.emailAddress) : (p.type === "domain" ? p.domain : p.type) ?? p.id).toLowerCase();

/** Everyone who can open the show, the Sheet or the deck, and what they have. */
export async function listPeople(): Promise<Person[]> {
  const f = await showFiles();
  const [folder, sheet, deck] = await Promise.all([permissions(f.folder), f.sheet ? permissions(f.sheet) : [], f.deck ? permissions(f.deck) : []]);
  const people = new Map<string, Person>();
  const person = (p: Permission): Person => {
    const key = keyOf(p);
    let it = people.get(key);
    if (!it) {
      const name = p.type === "domain" ? `Everyone at ${p.domain}` : p.type === "anyone" ? "Anyone with the link" : p.displayName || p.emailAddress || "Someone";
      it = { email: p.emailAddress ?? p.domain ?? p.type, name, photo: p.photoLink, access: null, inherited: false, role: "reader", grants: [] };
      people.set(key, it);
    }
    if (RANK.indexOf(p.role) > RANK.indexOf(it.role)) it.role = p.role;
    return it;
  };
  for (const p of folder) {
    const it = person(p);
    if (!direct(p) || p.role === "owner") it.inherited = true;
    else { it.grants.push({ file: f.folder, permission: p.id }); if (RANK.indexOf(p.role) >= RANK.indexOf("writer")) it.access = "app"; }
  }
  for (const [file, list, kind] of [[f.sheet, sheet, "sheet"], [f.deck, deck, "deck"]] as const) {
    for (const p of list) {
      if (!direct(p) || p.role === "owner") continue; // the folder's people, and the owner, are covered above
      const it = person(p);
      it.grants.push({ file: file!, permission: p.id });
      if (kind === "sheet" && it.access !== "app") it.access = p.role === "writer" ? "edit" : p.role === "commenter" ? "comment" : "view";
    }
  }
  // Their view of the media folders goes with the Sheet: removing them removes it too.
  const media = await Promise.all(f.media.map(async (file) => ({ file, list: await permissions(file).catch(() => []) })));
  for (const { file, list } of media) {
    for (const p of list) {
      const it = people.get(keyOf(p));
      if (it && direct(p) && p.role !== "owner") it.grants.push({ file, permission: p.id });
    }
  }
  return [...people.values()].sort((a, b) => Number(b.inherited) - Number(a.inherited) || a.name.localeCompare(b.name));
}

/** Whether an email is outside the signed-in account's organisation (another domain). */
export function isOutside(email: string): boolean {
  const mine = emailKey(useStore.getState().user?.email ?? "").split("@")[1];
  const theirs = emailKey(email).split("@")[1];
  return Boolean(mine && theirs && mine !== theirs);
}

export const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

/** "Anyone with the link": shared like a person, under this in place of an email (it's how listPeople lists it). */
export const LINK = "anyone";

/**
 * Give someone access (replacing what they had from the app). Google emails them a link when `notify`, with `message`.
 * Sharing the whole show makes them one of the people who use it in the app; the next sync opens the Sheet's locked
 * columns to them. `LINK` shares with anyone who has the link, never the whole show.
 */
export async function share(email: string, access: Access, notify: boolean, message: string, had?: Person) {
  const f = await showFiles();
  const to = email.trim();
  const anyone = to === LINK;
  if (anyone && access === "app") throw new Error("A link can't share the whole show: share it with someone by email");
  const grantee = anyone ? { type: "anyone", allowFileDiscovery: false } : { type: "user", emailAddress: to };
  const grant = (file: string, role: Role, mail: boolean) =>
    api("POST", `${DRIVE}/${file}/permissions?${ALL}&sendNotificationEmail=${mail && !anyone}${mail && message.trim() ? `&emailMessage=${encodeURIComponent(message.trim())}` : ""}`,
      { ...grantee, role });
  if (had) await revoke(had.grants);
  if (access === "app") {
    await grant(f.folder, "writer", notify);
  } else {
    if (!f.sheet) throw new Error("The Sheet hasn't been made yet: it's made on the first sync");
    const roles = ROLES[access];
    await grant(f.sheet, roles.sheet, notify); // one email: for the Sheet
    if (f.deck) await grant(f.deck, roles.deck, false);
    for (const m of f.media) await grant(m, roles.media, false);
  }
  if (!anyone) setAppEditor(to, access === "app");
}

/**
 * Make (or change) the Sheet's link: anyone who has it can view the Sheet and deck, or edit the Sheet's ✎ columns, and
 * open the clips and images they show. Returns the Sheet's address to send them.
 */
export async function shareLink(access: "view" | "edit", had?: Person): Promise<string> {
  await share(LINK, access, false, "", had);
  const gs = useStore.getState().show?.google ?? {};
  return gs.sheet_url ?? `https://docs.google.com/spreadsheets/d/${gs.spreadsheet_id}/edit`;
}

/** Take away everything someone was given on the show's files. */
export async function unshare(person: Person) {
  await revoke(person.grants);
  setAppEditor(person.email, false);
}

async function revoke(grants: Person["grants"]) {
  for (const g of grants) await api("DELETE", `${DRIVE}/${g.file}/permissions/${g.permission}?${ALL}`).catch((e) => {
    if (!String(e).includes("404")) throw e; // already gone
  });
}

function setAppEditor(email: string, on: boolean) {
  const key = emailKey(email);
  useStore.getState().updateQuiet((s) => {
    const list = (s.google ??= {}).app_editors ?? [];
    const rest = list.filter((e) => emailKey(e) !== key);
    s.google.app_editors = on ? [...rest, email] : rest;
  });
}
