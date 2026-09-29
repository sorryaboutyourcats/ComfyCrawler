"""Exports a curated set of already-generated dungeons into a self-contained static folder -
no ComfyUI, no GPU, no Python server needed to play them back. See DISTRIBUTION_PLAN.md
("Option D1") for why this exists.

Usage:
    python tools/export_showcase.py [--out showcase] [--ids tools/showcase_ids.txt] [--clean]
                                    [--favorites | --only-favorites]
                                    [--base-url mowmeow.net/ComfyCrawlerTest/]

Incremental by default: a file already in the export with the same size and modified time as
its source is left alone (copy2 carries the mtime over, so an unchanged bundle always matches),
dungeons no longer listed are removed, and only new or changed files are copied. --clean wipes
the output folder first and copies everything, the way every export used to.

tools/showcase_ids.txt lists one dungeon_sessions/ id per line (# comments and blank lines
ignored) - curated by hand, since which saved runs are fit to publish (no real names/brands
typed while testing, nothing embarrassing) is a judgment call this script does not attempt.
--favorites also pulls in every run starred in History, trusting the star as that judgment.
--only-favorites exports just the starred runs, ignoring showcase_ids.txt entirely.

A starred run with no sort number (History's hidden numbering view) ships unlisted: out of the
gallery, playable only by its ?run=<id> link. The export prints those links, and the exported
page opened with ?unlisted lists just those runs, each with its 🔗. With --base-url (where the
export will be hosted) those printed links come out whole, ready to paste.

The 30-second trailers ship too, at <export>/trailer/, /trailer2/ and /trailer11/ (trailer.js,
each one's cast in trailer.json / trailer2.json / trailer11.json - server.TRAILERS). Every dungeon a trailer names has to be one
this export ships - the curation above is what decides what goes public, and a trailer does not
get to skip it - so a missing one stops the export. Each trailer dungeon also gets a trimmed copy
of its bundle for the trailers to download instead (see trailer_files).
"""
import argparse
import json
import os
import shutil
import sys

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.normpath(os.path.join(TOOLS_DIR, os.pardir))
sys.path.insert(0, REPO_DIR)
import server  # noqa: E402  (import only - run_server() sits behind `if __name__ == "__main__":`)

# The same filename whitelist server.py's own /sounds/ route enforces (do_GET's "/sounds/"
# branch) - not a blind folder copy, so files like the unwired sounds/victory_candidates/
# audition batch (already gitignored, never served) can't leak into a published export.
SOUND_WHITELIST = server.STATIC_SOUND_FILES

# llms.txt is the machine players' manual (what the game is, window.ComfyCrawler, what to report
# back) - the showcase is the edition most of them will actually reach, so it ships there too.
STATIC_SHELL_FILES = ["game.js", "tailwind.css", "favicon.svg", "favicon.ico", "icon.png", "llms.txt",
                      "trailer.js"] + [f"{name}.json" for name in server.TRAILERS]

# The page's typeface, referenced by index.html's own @font-face as fonts/<name>. Shipped with
# the export for the same reason tailwind.css is: a visitor's phone has no Comic Sans, and
# without these the stack falls through to the device's sans instead of a font CDN's.
# OFL.txt travels with them - the SIL license requires the copyright notice be distributed.
FONT_FILES = ["ComicNeue-Regular.woff2", "ComicNeue-Bold.woff2", "OFL.txt"]

# Matches server.py's own SAVED_SETTINGS_TAG byte-for-byte - this script does the same
# insert-before-the-tag trick page_with_saved_settings() does per request, just once, at
# export time, to turn on SHOWCASE_MODE in game.js.
SAVED_SETTINGS_TAG = b'<script id="savedSettings" type="application/json">{}</script>'
SHOWCASE_FLAG_TAG = b'<script>window.COMFYCRAWLER_SHOWCASE = true;</script>\n  '
# A trailer's copy of the page lives in trailer/ (trailer2/), so its relative URLs point one
# folder up.
HTML_CHARSET_TAG = b'<meta charset="UTF-8">'
TRAILER_BASE_TAG = b'\n  <base href="../">'


TRAILER_FULL = "trailer_bundle.json"   # a dungeon a trailer fights in
TRAILER_WALK = "trailer_walk.json"     # a dungeon a trailer's rush only walks through
# What the trailer never plays: the narration, the outro read, and the dungeon's own music (the
# trailer has one track of its own). A walk-through also never draws a fighter.
_TRAILER_DROP_STORY = ("audio", "outro_audio")
_TRAILER_DROP_ALWAYS = ("music",)
_TRAILER_DROP_WALK = ("enemy_variants", "enemy_sprites", "player_sprites", "player_sprite",
                      "weapon_sprite", "shield_sprite")


def _cast_ids(node, under=""):
    """(id, key it was listed under) for every {"id": ...} anywhere in a trailer's json."""
    if isinstance(node, dict):
        if isinstance(node.get("id"), str):
            yield node["id"], under
        for key, value in node.items():
            yield from _cast_ids(value, key if isinstance(value, list) else under)
    elif isinstance(node, list):
        for item in node:
            yield from _cast_ids(item, under)


def trailer_files(cfgs):
    """{session id: set of trimmed bundle filenames} for every dungeon any trailer names - the
    same rule trailer.js loads by: a dungeon a trailer lists only under "rush" (walked through,
    never fought in) is fetched as the walk-through copy, every other one as the fight copy. One
    trailer walking a dungeon another fights in gets both. `cfgs` is one trailer json or a list."""
    files = {}
    for cfg in (cfgs if isinstance(cfgs, list) else [cfgs]):
        where = {}
        for sid, under in _cast_ids(cfg):
            where.setdefault(sid, set()).add(under)
        for sid, keys in where.items():
            files.setdefault(sid, set()).add(TRAILER_WALK if keys == {"rush"} else TRAILER_FULL)
    return files


def read_trailers():
    """{name: parsed json} for every trailer in server.TRAILERS whose json is in the repo. A json
    that "extends" another is merged over it, key by key - the same way trailer.js reads it."""
    raw = {}
    for name in server.TRAILERS:
        path = os.path.join(REPO_DIR, f"{name}.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                raw[name] = json.load(f)
    return {name: ({**raw[cfg["extends"]], **cfg} if cfg.get("extends") in raw else cfg)
            for name, cfg in raw.items()}


def trim_bundle(bundle, walk):
    """A bundle with what the trailer never uses taken out."""
    out = {k: v for k, v in bundle.items()
           if k not in _TRAILER_DROP_ALWAYS and not (walk and k in _TRAILER_DROP_WALK)}
    if isinstance(out.get("story"), dict):
        out["story"] = {k: v for k, v in out["story"].items() if k not in _TRAILER_DROP_STORY}
    return out


def write_trimmed_bundle(src_dir, dest_dir, name):
    """Writes dest_dir/name from src_dir's bundle.json unless a copy made from this same bundle is
    already there (mtimes are carried over, as copy2 does for everything else). Returns
    (bytes, written)."""
    src = os.path.join(src_dir, "bundle.json")
    dest = os.path.join(dest_dir, name)
    st = os.stat(src)
    dest_st = _stats_in(dest_dir).get(name)
    if dest_st is not None and abs(dest_st.st_mtime - st.st_mtime) < 2:
        return dest_st.st_size, False
    with open(src, encoding="utf-8") as f:
        bundle = json.load(f)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(trim_bundle(bundle, name == TRAILER_WALK), f, separators=(",", ":"))
    os.utime(dest, (st.st_atime, st.st_mtime))
    return os.path.getsize(dest), True


def read_curated_ids(path):
    ids = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if line:
                ids.append(line)
    return ids


def is_unlisted(meta):
    """A starred run with no sort number is exported but kept out of the gallery - reachable
    only through its ?run=<id> link. A star alone says "worth keeping and sharing"; the number
    is what says "put it on the shelf, and where"."""
    return bool(meta.get("favorite")) and not isinstance(meta.get("sort_number"), (int, float))


def normalize_base_url(base_url):
    """'mowmeow.net/ComfyCrawlerTest' -> 'https://mowmeow.net/ComfyCrawlerTest/': https:// when
    no scheme was typed, and a trailing slash so ?run= lands on the folder's index.html rather
    than a sibling path."""
    base_url = base_url.strip()
    if not base_url:
        return ""
    if "://" not in base_url:
        base_url = "https://" + base_url
    return base_url if base_url.endswith("/") else base_url + "/"


def _stats_in(folder):
    """{filename: stat} for every file directly in `folder`, or {} when it does not exist. One
    os.scandir per folder rather than an os.stat per file: on Windows the directory listing
    already carries each entry's size and mtime, and S: is a network drive where every separate
    filesystem call costs ~8ms."""
    try:
        with os.scandir(folder) as it:
            return {e.name: e.stat() for e in it if e.is_file()}
    except FileNotFoundError:
        return {}


def _same_file(src_stat, dest_stat):
    # A 2s window rather than equality: FAT/exFAT and some SMB servers round mtimes to 2s.
    return (dest_stat is not None and dest_stat.st_size == src_stat.st_size
            and abs(dest_stat.st_mtime - src_stat.st_mtime) < 2)


class _Sync:
    """Counts what an export actually copied versus skipped, for the closing summary."""

    def __init__(self):
        self.copied = self.skipped = self.removed = 0
        self.copied_bytes = 0

    def folder(self, src_dir, dest_dir, names, prune=False):
        """Brings `names` from src_dir into dest_dir, copying only the ones that differ. With
        prune, files in dest_dir outside `names` are deleted - a dungeon whose ending movie was
        thrown away since the last export should not keep shipping it. Returns the bytes those
        files take up in the export, copied or not."""
        os.makedirs(dest_dir, exist_ok=True)
        src_stats = _stats_in(src_dir)
        dest_stats = _stats_in(dest_dir)
        total = 0
        for name in names:
            st = src_stats.get(name)
            if st is None:
                continue
            total += st.st_size
            if _same_file(st, dest_stats.get(name)):
                self.skipped += 1
                continue
            shutil.copy2(os.path.join(src_dir, name), os.path.join(dest_dir, name))
            self.copied += 1
            self.copied_bytes += st.st_size
        if prune:
            for name in dest_stats.keys() - set(names):
                os.remove(os.path.join(dest_dir, name))
                self.removed += 1
        return total


def export_showcase(out_dir, ids_path, clean=False, favorites=False, base_url="",
                    only_favorites=False):
    favorites = favorites or only_favorites
    ids = [] if only_favorites else (
        read_curated_ids(ids_path) if os.path.exists(ids_path) or not favorites else [])
    all_sessions = {s["id"]: s for s in server.list_dungeon_sessions()}
    if favorites:
        # Starred History runs join the hand-curated list. The star skips the publish-safety
        # review showcase_ids.txt stands for, so this is opt-in and says what it added.
        starred = [sid for sid, meta in all_sessions.items()
                   if meta.get("favorite") and sid not in ids]
        ids += starred
        if only_favorites:
            print(f"[showcase] --only-favorites: exporting the {len(starred)} starred run(s), "
                  f"ignoring {os.path.basename(ids_path)}")
        else:
            print(f"[showcase] --favorites added {len(starred)} starred run(s) to the list")
    if not ids:
        print(f"[showcase] {ids_path} lists no ids yet - nothing to export. "
              "Add one dungeon_sessions/ id per line (see the file's own comment) and run again.")
        return

    kept = []
    for session_id in ids:
        meta = all_sessions.get(session_id)
        if not meta:
            print(f"[showcase] skipping {session_id} - not found in {server.SESSIONS_DIR} "
                  "(deleted since curation?)")
            continue
        # A copy: the listing may be server.py's own cached dicts, and `unlisted` is the
        # export's business only.
        meta = dict(meta)
        # Starred but never given a sort number (History's hidden numbering view): shipped, and
        # playable from its ?run= link, but left out of the gallery - see is_unlisted.
        if is_unlisted(meta):
            meta["unlisted"] = True
        kept.append(meta)

    if not kept:
        print("[showcase] none of the curated ids were found - nothing to export.")
        return

    # The trailers' casts have to be public already - see the module docstring.
    trailers = read_trailers()
    kept_ids = {meta["id"] for meta in kept}
    for name, cfg in trailers.items():
        missing = sorted(set(trailer_files(cfg)) - kept_ids)
        if missing:
            raise SystemExit(f"[showcase] {name}.json uses dungeon(s) this export doesn't ship: "
                             + ", ".join(missing) + " - add them to "
                             + os.path.basename(ids_path) + f" or pick others in {name}.json.")
    trailer = trailer_files(list(trailers.values()))

    # --clean only: the old wipe-and-copy-everything. Beware it on a folder something holds open
    # (a `python -m http.server` running inside it, an Explorer window) - rmtree empties it and
    # then dies on the final rmdir with WinError 32, leaving it gutted.
    if clean and os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    dungeons_dir = os.path.join(out_dir, "dungeons")
    os.makedirs(dungeons_dir, exist_ok=True)

    # Dungeons that were exported before but are no longer listed.
    with os.scandir(dungeons_dir) as it:
        stale = [e.path for e in it if e.is_dir() and e.name not in kept_ids]
    for path in stale:
        shutil.rmtree(path)
        print(f"[showcase] removed {os.path.basename(path)} - no longer listed")

    sync = _Sync()
    trailer_bytes = 0
    session_files = ("bundle.json", server.ENDING_FILENAME, server.CARD_FILENAME,
                     server.CARD_BG_FILENAME, server.CARD_HERO_FILENAME)
    total_bytes = 0
    for meta in kept:
        session_id = meta["id"]
        # The gallery's tile view reads dungeons/<id>/card.png - and card_bg.png / card_hero.png
        # for the hover parallax - the same way the live page reads /api/history_card. Nothing
        # in a static export can render one, so draw any that are missing here, while server.py
        # is still importable and the bundle is still on disk. One call covers all three: see
        # _card_files_missing.
        server.ensure_session_card(session_id)
        # Listed with the rest so the prune keeps it; nothing in the session folder has that
        # name, so folder() leaves the writing of it to write_trimmed_bundle below.
        trimmed = sorted(trailer.get(session_id, ()))
        total_bytes += sync.folder(os.path.join(server.SESSIONS_DIR, session_id),
                                   os.path.join(dungeons_dir, session_id),
                                   session_files + tuple(trimmed), prune=True)
        for name in trimmed:
            size, written = write_trimmed_bundle(os.path.join(server.SESSIONS_DIR, session_id),
                                                 os.path.join(dungeons_dir, session_id), name)
            total_bytes += size
            trailer_bytes += size
            if written:
                sync.copied += 1
                sync.copied_bytes += size
            else:
                sync.skipped += 1

    with open(os.path.join(out_dir, "dungeons.json"), "w", encoding="utf-8") as f:
        json.dump({"sessions": kept}, f)

    # ---- Static shell: the same page and engine the live server serves, byte-identical except
    # for the one flag line spliced into index.html ahead of game.js. ----
    with open(os.path.join(REPO_DIR, "index.html"), "rb") as f:
        html = f.read()
    if SAVED_SETTINGS_TAG not in html:
        raise SystemExit("index.html's #savedSettings tag has changed shape - "
                          "update SAVED_SETTINGS_TAG/SHOWCASE_FLAG_TAG in this script to match.")
    html = html.replace(SAVED_SETTINGS_TAG, SHOWCASE_FLAG_TAG + SAVED_SETTINGS_TAG, 1)
    with open(os.path.join(out_dir, "index.html"), "wb") as f:
        f.write(html)
    # <export>/trailer/ (and trailer2/) is the same page, one folder down - so it says so in
    # markup, where the browser's preload scanner reads it before any script runs (a <base> only
    # written by index.html's script came too late for it: three stray 404s on every load).
    # game.js sees /trailer in the address and plays the trailer.
    if HTML_CHARSET_TAG not in html:
        raise SystemExit("index.html's charset tag has changed shape - update HTML_CHARSET_TAG "
                         "in this script to match.")
    for name in trailers:
        os.makedirs(os.path.join(out_dir, name), exist_ok=True)
        with open(os.path.join(out_dir, name, "index.html"), "wb") as f:
            f.write(html.replace(HTML_CHARSET_TAG, HTML_CHARSET_TAG + TRAILER_BASE_TAG, 1))

    sync.folder(REPO_DIR, out_dir, STATIC_SHELL_FILES)
    sync.folder(os.path.join(REPO_DIR, "fonts"), os.path.join(out_dir, "fonts"), FONT_FILES)
    # prune: a track dropped from STATIC_MUSIC stops shipping instead of lingering in the export.
    sync.folder(os.path.join(REPO_DIR, "sounds"), os.path.join(out_dir, "sounds"),
                SOUND_WHITELIST, prune=True)

    mb = total_bytes / 1048576
    copied_mb = sync.copied_bytes / 1048576
    print(f"[showcase] exported {len(kept)} dungeon(s) ({mb:.1f} MB) to {out_dir}")
    print(f"[showcase] copied {sync.copied} file(s) ({copied_mb:.1f} MB), "
          f"{sync.skipped} already up to date, {sync.removed} removed")
    where = normalize_base_url(base_url) or "<address>/"
    print(f"[showcase] trailers: {len(trailer)} dungeon(s), {trailer_bytes / 1048576:.1f} MB of "
          f"trimmed bundles, at " + ", ".join(f"{where}{name}/" for name in trailers))
    print(f"[showcase] try it: cd {out_dir} && python -m http.server 8000")
    unlisted = [meta for meta in kept if meta.get("unlisted")]
    if unlisted:
        # The gallery has no row to copy these links from, so they are handed out here - and
        # the export's own ?unlisted page lists just these, each with its 🔗 giving the full
        # link at whatever address the export ends up hosted on.
        base_url = normalize_base_url(base_url)
        where = "" if base_url else " (after the showcase's address)"
        print(f"[showcase] {len(unlisted)} unlisted run(s) - starred with no sort number, so "
              f"hidden from the gallery but playable by link. Links{where}, "
              f"or open {base_url or '<address>/'}?unlisted to copy them:")
        for meta in unlisted:
            title = (meta.get("location") or meta.get("wall_style") or "Unnamed Dungeon").strip()
            print(f"    {base_url}?run={meta['id']}   {title}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=os.path.join(REPO_DIR, "showcase"),
                         help="Output folder (default: showcase/ at repo root)")
    parser.add_argument("--ids", default=os.path.join(TOOLS_DIR, "showcase_ids.txt"),
                         help="Curated id list (default: tools/showcase_ids.txt)")
    parser.add_argument("--clean", action="store_true",
                         help="Wipe the output folder and copy everything, instead of only "
                              "what changed since the last export")
    parser.add_argument("--favorites", action="store_true",
                         help="Also export every run starred in History, on top of the curated "
                              "id list")
    parser.add_argument("--only-favorites", action="store_true",
                         help="Export only the runs starred in History, ignoring the curated "
                              "id list")
    parser.add_argument("--base-url", default="",
                         help="Where the export will be hosted (e.g. mowmeow.net/ComfyCrawlerTest/) "
                              "- unlisted runs' links are then printed in full; https:// is "
                              "assumed when no scheme is given")
    args = parser.parse_args()
    export_showcase(args.out, args.ids, clean=args.clean, favorites=args.favorites,
                    base_url=args.base_url, only_favorites=args.only_favorites)
