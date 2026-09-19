"""Exports a curated set of already-generated dungeons into a self-contained static folder -
no ComfyUI, no GPU, no Python server needed to play them back. See DISTRIBUTION_PLAN.md
("Option D1") for why this exists.

Usage:
    python tools/export_showcase.py [--out showcase] [--ids tools/showcase_ids.txt]

tools/showcase_ids.txt lists one dungeon_sessions/ id per line (# comments and blank lines
ignored) - curated by hand, since which saved runs are fit to publish (no real names/brands
typed while testing, nothing embarrassing) is a judgment call this script does not attempt.
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

STATIC_SHELL_FILES = ["game.js", "tailwind.css", "favicon.svg", "favicon.ico", "icon.png"]

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


def export_showcase(out_dir, ids_path):
    ids = read_curated_ids(ids_path)
    if not ids:
        print(f"[showcase] {ids_path} lists no ids yet - nothing to export. "
              "Add one dungeon_sessions/ id per line (see the file's own comment) and run again.")
        return

    all_sessions = {s["id"]: s for s in server.list_dungeon_sessions()}
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

    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    dungeons_dir = os.path.join(out_dir, "dungeons")
    os.makedirs(dungeons_dir, exist_ok=True)

    total_bytes = 0
    for meta in kept:
        session_id = meta["id"]
        src = os.path.join(server.SESSIONS_DIR, session_id)
        dest = os.path.join(dungeons_dir, session_id)
        os.makedirs(dest, exist_ok=True)
        for filename in ("bundle.json", server.ENDING_FILENAME):
            src_file = os.path.join(src, filename)
            if os.path.exists(src_file):
                shutil.copy2(src_file, os.path.join(dest, filename))
                total_bytes += os.path.getsize(src_file)

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

    for filename in STATIC_SHELL_FILES:
        src_file = os.path.join(REPO_DIR, filename)
        if os.path.exists(src_file):
            shutil.copy2(src_file, os.path.join(out_dir, filename))

    sounds_src = os.path.join(REPO_DIR, "sounds")
    sounds_dest = os.path.join(out_dir, "sounds")
    os.makedirs(sounds_dest, exist_ok=True)
    for filename in SOUND_WHITELIST:
        src_file = os.path.join(sounds_src, filename)
        if os.path.exists(src_file):
            shutil.copy2(src_file, os.path.join(sounds_dest, filename))

    mb = total_bytes / 1048576
    print(f"[showcase] exported {len(kept)} dungeon(s) ({mb:.1f} MB) to {out_dir}")
    print(f"[showcase] try it: cd {out_dir} && python -m http.server 8000")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=os.path.join(REPO_DIR, "showcase"),
                         help="Output folder (default: showcase/ at repo root)")
    parser.add_argument("--ids", default=os.path.join(TOOLS_DIR, "showcase_ids.txt"),
                         help="Curated id list (default: tools/showcase_ids.txt)")
    args = parser.parse_args()
    export_showcase(args.out, args.ids)
