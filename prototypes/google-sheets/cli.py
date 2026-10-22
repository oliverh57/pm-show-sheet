"""PM Show Sheet — Google Sheets prototype.

    python cli.py dry-run                 build every request offline → out/
    python cli.py publish [--image-mode public|private] [--image-url lh3|thumbnail|uc]
    python cli.py slides [--image-url …]  build/refresh the deck: cover, running order, one slide per song
    python cli.py pull                    bring collaborator edits + new notes into show.json
    python cli.py sync                    pull, then publish
    python cli.py comments                list comments with anchors + inferred cells
    python cli.py comments reply ID TEXT  /  comments resolve ID [TEXT]
    python cli.py share link --role commenter|writer|reader
    python cli.py share invite EMAIL --role commenter|writer|reader [--no-notify]   (also shares media/)
    python cli.py share uninvite EMAIL  /  share revoke-link
    python cli.py status
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import layout
import model

HERE = Path(__file__).parent
SAMPLE = HERE / "sample_show.json"
DEFAULT_SHOW = HERE / "show.json"
OUT = HERE / "out"


def state_path(show: dict) -> Path:
    return HERE / ".state" / f"{show['id']}.json"


def load(args):
    path = Path(args.show)
    if not path.exists() and path == DEFAULT_SHOW:
        shutil.copy(SAMPLE, DEFAULT_SHOW)
        print(f"Created {DEFAULT_SHOW.name} from {SAMPLE.name} (this file plays the part of the app's data).")
    show = model.load_json(path)
    sp = state_path(show)
    state = model.load_json(sp) if sp.exists() else {}
    return path, show, state


def save(path, show, state):
    model.save_json(path, show)
    model.save_json(state_path(show), state)


def print_reports(reports):
    for title, rep in reports:
        if "error" in rep:
            print(f"[{title}] {rep['error']}")
            continue
        counts = {k: len(v) for k, v in rep.items() if v}
        print(f"[{title}] " + (", ".join(f"{k}: {n}" for k, n in counts.items()) or "no changes"))
        for k in ("accepted", "conflicts", "protected_changed", "new_notes", "unknown_rows", "missing_rows"):
            for item in rep.get(k, []):
                print(f"   {k:>17}: {item}")


def cmd_dry_run(args):
    path, show, state = load(args)
    fake = {s["hero"]: f"https://example.invalid/{Path(s['hero']).name}" for s in show["songs"].values() if s.get("hero")}
    grids = [("show", layout.show_tab(show, fake, "https://example.invalid/logo.png"))]
    grids += [(f"session:{s['id']}", layout.notes_tab(show, s)) for s in show["sessions"]]
    requests = []
    for i, (key, g) in enumerate(grids):
        sid = 1001 + i
        requests += layout.structure_requests(g, sid, "owner@example.invalid")
        requests += layout.content_requests(g, sid)
        print(f"{g.title:>20}: {len(g.data_rows)} rows × {len(g.col_ids)} cols, "
              f"{len(g.merges)} merges, editable cols {[g.col_ids[c] for c in g.editable_cols]}")
    OUT.mkdir(exist_ok=True)
    (OUT / "requests.json").write_text(json.dumps({"requests": requests}, indent=1, ensure_ascii=False))
    (OUT / "values.json").write_text(json.dumps({g.title: layout.plain_values(g) for _, g in grids}, indent=1, ensure_ascii=False))
    kinds = {}
    for r in requests:
        k = next(iter(r))
        kinds[k] = kinds.get(k, 0) + 1
    print(f"{len(requests)} requests {kinds} → {OUT / 'requests.json'}")

    import slides_layout
    videos = {sid: "fake-drive-video-id" for sid in show["set_order"] if show["songs"][sid].get("clip")}
    sreqs = slides_layout.build(show, 1, fake, "https://example.invalid/logo.png", videos, {"p": []}, today="21 OCT 2026")
    (OUT / "slides_requests.json").write_text(json.dumps({"requests": sreqs}, indent=1, ensure_ascii=False))
    skinds = {}
    for r in sreqs:
        k = next(iter(r))
        skinds[k] = skinds.get(k, 0) + 1
    print(f"slides: {len(slides_layout.slide_order(show))} slides, {len(sreqs)} requests {skinds} → {OUT / 'slides_requests.json'}")


def cmd_publish(args):
    import gclient, ops
    path, show, state = load(args)
    sheets, drive = gclient.services()
    try:
        ops.publish(sheets, drive, path, show, state, args.image_mode, args.image_url)
    finally:
        save(path, show, state)  # keep ids of anything created before a failure


def cmd_slides(args):
    import gclient, ops
    path, show, state = load(args)
    _, drive = gclient.services()
    try:
        ops.publish_slides(gclient.slides_service(), drive, path, show, state, args.image_url)
    finally:
        save(path, show, state)  # keep ids of anything created before a failure


def cmd_pull(args):
    import gclient, ops
    path, show, state = load(args)
    if not state.get("spreadsheet_id"):
        raise SystemExit("Nothing published yet. Run: python cli.py publish")
    sheets, _ = gclient.services()
    print_reports(ops.pull(sheets, show, state))
    save(path, show, state)


def cmd_sync(args):
    import gclient, ops
    path, show, state = load(args)
    sheets, drive = gclient.services()
    if state.get("spreadsheet_id"):
        print_reports(ops.pull(sheets, show, state))
    ops.publish(sheets, drive, path, show, state, args.image_mode, args.image_url)
    save(path, show, state)


def cmd_comments(args):
    import gclient, ops
    path, show, state = load(args)
    sheets, drive = gclient.services()
    if args.action == "list":
        comments = ops.list_comments(sheets, drive, show, state)
        for c in comments:
            song = show["songs"].get(c["song_id"], {}).get("fields", {}).get("name") if c["song_id"] else None
            print(f"\n{c['id']}  {'[resolved] ' if c['resolved'] else ''}{c['author']}: {c['content']}")
            print(f"   quoted: {c['quoted']!r}")
            print(f"   anchor (raw): {c['anchor_raw']}")
            print(f"   inferred cells: {c['inferred_cells'] or 'none'}")
            print(f"   → song: {song or 'unplaced'}")
            for r in c["replies"]:
                print(f"     ↳ {r['author']}: {r['content']} {('(' + r['action'] + ')') if r['action'] else ''}")
        print(f"\n{len(comments)} comments")
        save(path, show, state)
    else:
        if not args.comment_id:
            raise SystemExit("comment id required")
        text = args.text or ("Resolved in PM Show Sheet" if args.action == "resolve" else "")
        if not text:
            raise SystemExit("reply text required")
        ops.reply_comment(drive, state, args.comment_id, text, resolve=args.action == "resolve")
        print("done")


def cmd_share(args):
    import gclient, ops
    path, show, state = load(args)
    _, drive = gclient.services()
    if args.kind == "link":
        ops.share_link(drive, state, args.role)
        verb = {"reader": "view", "commenter": "comment", "writer": "edit"}[args.role]
        print(f"Anyone with the link can {verb}: {state['sheet_url']}")
    elif args.kind == "revoke-link":
        ops.revoke_link(drive, state)
        print("Link sharing removed. Invited people keep their access.")
    else:
        if not args.email:
            raise SystemExit("email required")
        if args.kind == "invite":
            ops.invite(drive, state, args.email, args.role, notify=not args.no_notify)
            print(f"Invited {args.email} as {args.role} (plus view access to media/ so images load)")
        else:
            removed = ops.uninvite(drive, state, args.email)
            print(f"Removed {args.email} from: {', '.join(removed) or 'nothing (not shared)'}")
    save(path, show, state)


def cmd_status(args):
    path, show, state = load(args)
    print(json.dumps({k: state.get(k) for k in ("sheet_url", "spreadsheet_id", "folder_id", "owner_email", "tabs")}, indent=2))
    if show.get("conflicts"):
        print(f"{len(show['conflicts'])} unresolved conflicts in {path.name} → 'conflicts'")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--show", default=str(DEFAULT_SHOW), help="show JSON file (default: show.json)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("dry-run").set_defaults(fn=cmd_dry_run)
    for name, fn in (("publish", cmd_publish), ("sync", cmd_sync)):
        sp = sub.add_parser(name)
        sp.add_argument("--image-mode", choices=["private", "public"], default="private",
                        help="public = anyone-with-link can view each uploaded image (needed for =IMAGE?)")
        sp.add_argument("--image-url", choices=["lh3", "thumbnail", "uc"], default="lh3")
        sp.set_defaults(fn=fn)
    sp = sub.add_parser("slides")
    sp.add_argument("--image-url", choices=["lh3", "thumbnail", "uc"], default="lh3")
    sp.set_defaults(fn=cmd_slides)
    sub.add_parser("pull").set_defaults(fn=cmd_pull)
    sp = sub.add_parser("comments")
    sp.add_argument("action", nargs="?", choices=["list", "reply", "resolve"], default="list")
    sp.add_argument("comment_id", nargs="?")
    sp.add_argument("text", nargs="?")
    sp.set_defaults(fn=cmd_comments)
    sp = sub.add_parser("share")
    sp.add_argument("kind", choices=["link", "invite", "uninvite", "revoke-link"])
    sp.add_argument("email", nargs="?")
    sp.add_argument("--role", choices=["reader", "commenter", "writer"], default="commenter")
    sp.add_argument("--no-notify", action="store_true")
    sp.set_defaults(fn=cmd_share)
    sub.add_parser("status").set_defaults(fn=cmd_status)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
