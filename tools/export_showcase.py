"""Exports a curated set of already-generated dungeons into a self-contained static folder -
no ComfyUI, no GPU, no Python server needed to play them back. See DISTRIBUTION_PLAN.md
("Option D1") for why this exists.

Usage:
    python tools/export_showcase.py [--out showcase] [--ids tools/showcase_ids.txt] [--clean]
                                    [--favorites]

Incremental by default: a file already in the export with the same size and modified time as
its source is left alone (copy2 carries the mtime over, so an unchanged bundle always matches),
dungeons no longer listed are removed, and only new or changed files are copied. --clean wipes
the output folder first and copies everything, the way every export used to.

tools/showcase_ids.txt lists one dungeon_sessions/ id per line (# comments and blank lines
ignored) - curated by hand, since which saved runs are fit to publish (no real names/brands
typed while testing, nothing embarrassing) is a judgment call this script does not attempt.
--favorites also pulls in every run starred in History, trusting the star as that judgment.
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
SOUND_WHITELIST = ("start.wav", "button.wav", "end.wav", "ready.wav") \
    + tuple(f"{k}_music.wav" for k in server.STATIC_MUSIC)

# llms.txt is the machine players' manual (what the game is, window.ComfyCrawler, what to report
# back) - the showcase is the edition most of them will actually reach, so it ships there too.
STATIC_SHELL_FILES = ["game.js", "tailwind.css", "favicon.svg", "favicon.ico", "icon.png", "llms.txt"]

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


def read_curated_ids(path):
    ids = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if line:
                ids.append(line)
    return ids


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


def export_showcase(out_dir, ids_path, clean=False, favorites=False):
    ids = read_curated_ids(ids_path) if os.path.exists(ids_path) or not favorites else []
    all_sessions = {s["id"]: s for s in server.list_dungeon_sessions()}
    if favorites:
        # Starred History runs join the hand-curated list. The star skips the publish-safety
        # review showcase_ids.txt stands for, so this is opt-in and says what it added.
        starred = [sid for sid, meta in all_sessions.items()
                   if meta.get("favorite") and sid not in ids]
        ids += starred
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
        kept.append(meta)

    if not kept:
        print("[showcase] none of the curated ids were found - nothing to export.")
        return

    # --clean only: the old wipe-and-copy-everything. Beware it on a folder something holds open
    # (a `python -m http.server` running inside it, an Explorer window) - rmtree empties it and
    # then dies on the final rmdir with WinError 32, leaving it gutted.
    if clean and os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    dungeons_dir = os.path.join(out_dir, "dungeons")
    os.makedirs(dungeons_dir, exist_ok=True)

    # Dungeons that were exported before but are no longer listed.
    kept_ids = {meta["id"] for meta in kept}
    with os.scandir(dungeons_dir) as it:
        stale = [e.path for e in it if e.is_dir() and e.name not in kept_ids]
    for path in stale:
        shutil.rmtree(path)
        print(f"[showcase] removed {os.path.basename(path)} - no longer listed")

    sync = _Sync()
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
        total_bytes += sync.folder(os.path.join(server.SESSIONS_DIR, session_id),
                                   os.path.join(dungeons_dir, session_id),
                                   session_files, prune=True)

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
    print(f"[showcase] try it: cd {out_dir} && python -m http.server 8000")


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
    args = parser.parse_args()
    export_showcase(args.out, args.ids, clean=args.clean, favorites=args.favorites)
