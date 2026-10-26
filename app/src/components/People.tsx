// Share & publish → People: who can open the show, the Sheet and the deck, and sharing them from here
// (see google/sharing.ts). Also the shows shared with you, on All shows, to add to your Drive.
import { useEffect, useState } from "react";
import { backend } from "../backend";
import { ACCESS, type Access, addToMyDrive, isOutside, LINK, listPeople, type Person, share, shareLink, type SharedShow, sharedWithMe, unshare, validEmail } from "../google/sharing";
import { syncNow } from "../google/sync";
import { useStore } from "../store";
import { Avatar, Icon } from "./icons";

const ROLE_NAMES: Record<string, string> = { owner: "Owner", organizer: "Manager", fileOrganizer: "Content manager", writer: "Can edit", commenter: "Can comment", reader: "Can view" };
const err = (e: unknown) => String(e).replace(/^Error: /, "");

export function PeoplePanel() {
  const user = useStore((s) => s.user);
  const readOnly = useStore((s) => s.readOnly);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // the email being changed, or "add"
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<Access>("edit");
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState("");
  const [showTeam, setShowTeam] = useState(false);
  const [link, setLink] = useState<string | null>(null); // the Sheet's address, once a link's been made
  const toast = useStore((s) => s.toast);

  async function load() {
    try {
      setPeople(await listPeople());
      setError(null);
    } catch (e) {
      setError(err(e));
    }
  }
  useEffect(() => { if (backend.isDesktop) load(); }, []);

  async function change(label: string, run: () => Promise<void>, done: string) {
    setBusy(label);
    try {
      await run();
      toast(done);
      syncNow(true); // the Sheet's lock follows who uses the show in the app
    } catch (e) {
      toast(err(e));
    }
    setBusy(null);
    await load();
  }

  const to = email.trim();
  const existing = people?.find((p) => p.email.toLowerCase() === to.toLowerCase());
  const outside = validEmail(to) && isOutside(to);
  const hint = ACCESS.find((a) => a.id === access)!.hint;
  const add = () => change("add", async () => { await share(to, access, notify, message, existing); setEmail(""); setMessage(""); },
    `Shared with ${to}${access === "app" ? ": they'll find it under Shared with you in the app" : ""}`);

  const linkPerson = people?.find((p) => p.email === LINK && p.access !== null);
  const makeLink = (a: "view" | "edit") => change(`link-${a}`, async () => {
    const url = await shareLink(a, linkPerson);
    setLink(url);
    await navigator.clipboard.writeText(url).catch(() => {});
  }, `Link copied: anyone with it can ${a === "edit" ? "edit the Sheet's ✎ columns" : "view the Sheet and deck"}`);
  const copyLink = () => link && navigator.clipboard.writeText(link).then(() => toast("Link copied"), () => toast("Couldn't copy the link"));

  const others = people?.filter((p) => p.email.toLowerCase() !== user?.email.toLowerCase()) ?? []; // you're shown first
  const mine = others.filter((p) => p.access !== null);
  const team = others.filter((p) => p.access === null);

  return (
    <div className="panel people">
      <div className="label">People</div>
      {user && (
        <div className="person">
          <Avatar name={user.name} picture={user.picture} />
          <div className="who"><div className="nm">{user.name} (you)</div><div className="muted small">{user.email}</div></div>
        </div>
      )}
      {!backend.isDesktop && <p className="muted small" style={{ marginBottom: 0 }}>Sharing works in the desktop app.</p>}
      {error && <p className="error small">{error}</p>}
      {backend.isDesktop && !people && !error && <p className="muted small"><span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> Looking up who has access…</p>}

      {mine.map((p) => (
        <div key={p.email} className="person">
          <Avatar name={p.name} picture={p.photo} />
          <div className="who">
            <div className="nm">{p.name}{isOutside(p.email) && <span className="chip warn">Outside</span>}</div>
            {p.name !== p.email && <div className="muted small">{p.email}</div>}
          </div>
          <select value={p.access!} disabled={Boolean(busy) || Boolean(readOnly)} aria-label={`What ${p.name} can do`}
                  onChange={(e) => { const a = e.target.value as Access; change(p.email, () => share(p.email, a, false, "", p), `Changed what ${p.name} can do`); }}>
            {ACCESS.filter((a) => p.email !== LINK || a.id !== "app").map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          <button className="icon" title={`Stop sharing with ${p.name}`} disabled={Boolean(busy) || Boolean(readOnly)}
                  onClick={() => change(p.email, () => unshare(p), `Stopped sharing with ${p.name}`)}>
            {busy === p.email ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} /> : <Icon name="x" size="sm" />}
          </button>
        </div>
      ))}

      {team.length > 0 && (
        <>
          <button className="link small team-toggle" onClick={() => setShowTeam(!showTeam)}>
            <Icon name={showTeam ? "chevDown" : "chevR"} size="sm" /> {team.length} more through the shared drive or a folder above the show
          </button>
          {showTeam && team.map((p) => (
            <div key={p.email} className="person faint">
              <Avatar name={p.name} picture={p.photo} />
              <div className="who"><div className="nm">{p.name}</div>{p.name !== p.email && <div className="muted small">{p.email}</div>}</div>
              <span className="muted small">{ROLE_NAMES[p.role] ?? p.role}</span>
            </div>
          ))}
        </>
      )}

      {backend.isDesktop && (
        <div className="share-form">
          <div className="share-row">
            <input type="email" value={email} placeholder="Add someone by email" aria-label="Email to share with" disabled={Boolean(readOnly)}
                   onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && validEmail(to) && !busy && add()} />
            <select value={access} onChange={(e) => setAccess(e.target.value as Access)} aria-label="What they can do">
              {ACCESS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <button className="primary" disabled={!validEmail(to) || Boolean(busy) || Boolean(readOnly)} onClick={add}>
              {busy === "add" ? "Sharing…" : existing ? "Change" : "Share"}
            </button>
          </div>
          <p className="muted small">{hint}</p>
          {outside && (
            <div className="outside-note">
              <Icon name="alert" size="sm" />
              <div>
                <strong>{to.split("@")[1]}</strong> is outside your organisation.
                {access === "app"
                  ? " They get the whole show, and can only use the app if its Google sign-in lets in accounts from outside it."
                  : " They'll see only the Sheet, the deck and the media they show."}
              </div>
            </div>
          )}
          {validEmail(to) && (
            <>
              <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email them a link</label>
              {notify && <input value={message} placeholder="Message (optional)" aria-label="Message" onChange={(e) => setMessage(e.target.value)} />}
            </>
          )}
          <div className="share-link">
            <div className="share-row">
              <button disabled={Boolean(busy) || Boolean(readOnly)} onClick={() => makeLink("view")}>
                <Icon name="link" size="sm" /> {busy === "link-view" ? "Making link…" : "Generate link for viewing"}
              </button>
              <button disabled={Boolean(busy) || Boolean(readOnly)} onClick={() => makeLink("edit")}>
                <Icon name="link" size="sm" /> {busy === "link-edit" ? "Making link…" : "Generate link for editing"}
              </button>
            </div>
            {link && (
              <div className="share-row">
                <input readOnly value={link} aria-label="Link to the Sheet" onFocus={(e) => e.target.select()} />
                <button className="icon" title="Copy link" onClick={copyLink}><Icon name="copy" size="sm" /></button>
              </div>
            )}
            <p className="muted small">
              {linkPerson
                ? `The link is on: anyone with it can ${linkPerson.access === "edit" ? "edit the Sheet's ✎ columns" : linkPerson.access === "comment" ? "comment on the Sheet and deck" : "view the Sheet and deck"}, and open the clips and images they show. Remove “Anyone with the link” above to turn it off.`
                : "Anyone you send the link to can open the Sheet, the deck, and the clips and images they show; a link for editing lets them edit the Sheet's ✎ columns too."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** On All shows: shows shared straight with you, which need adding to your Drive before they're on this Mac. */
export function SharedWithYou({ onAdded }: { onAdded: () => void }) {
  const [shows, setShows] = useState<SharedShow[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  useEffect(() => { if (backend.isDesktop) sharedWithMe().then(setShows).catch(() => {}); }, []);
  if (!shows.length) return null;

  async function add(s: SharedShow) {
    setAdding(s.id);
    try {
      await addToMyDrive(s);
      setShows((cur) => cur.filter((x) => x.id !== s.id));
      toast(`Added “${s.name}” to your Drive. It shows here once Google Drive has brought it to this Mac.`);
      window.setTimeout(onAdded, 8000);
    } catch (e) {
      toast(err(e));
    }
    setAdding(null);
  }

  return (
    <div className="shared-with-you">
      <div className="label">Shared with you</div>
      {shows.map((s) => (
        <div key={s.id} className="shared-row">
          <Icon name="users" size="sm" />
          <div className="who"><div className="nm">{s.name}</div>{s.by && <div className="muted small">Shared by {s.by}</div>}</div>
          <button className="sm" disabled={adding !== null} onClick={() => add(s)}>{adding === s.id ? "Adding…" : "Add to my Drive"}</button>
        </div>
      ))}
      <p className="muted small">Shows shared straight with you open here once they're in your Drive.</p>
    </div>
  );
}
