"""Offline checks on the itch.io build (tools/publish_itch.py):

- the size-capped showcase keeps the gallery's runs in its Default order (numbered first, lowest
  number first, then newest first), leaves unlisted runs out, and stops at the first run that
  would go over the budget;
- the HTML5 limit check catches each of itch's limits;
- the ComfyUI node folder honours .comfyignore the way the Registry package does;
- game.js points the trimmed build's 🔗 links and "play all" link at the full showcase, and only
  there.

Needs neither ComfyUI, butler nor a browser."""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import export_showcase  # noqa: E402
import publish_itch  # noqa: E402

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL:", msg)

# ---- budget pick ----
metas = [
    {"id": "20260901-000000-aaaaaa", "created": 1},                      # unnumbered, oldest
    {"id": "20260902-000000-bbbbbb", "created": 2, "sort_number": 2},
    {"id": "20260903-000000-cccccc", "created": 3},                      # unnumbered, newest
    {"id": "20260904-000000-dddddd", "created": 4, "sort_number": 1},
    {"id": "20260905-000000-eeeeee", "created": 5, "unlisted": True, "favorite": True},
]
sizes = {m["id"]: 10 for m in metas}
kept, used = export_showcase.pick_within_budget(metas, sizes, 1000)
ck([m["id"][-6:] for m in kept] == ["dddddd", "bbbbbb", "cccccc", "aaaaaa"],
   f"Default order with the unlisted run left out (got {[m['id'][-6:] for m in kept]})")
ck(used == 40, "bytes used adds up the kept runs")
kept, used = export_showcase.pick_within_budget(metas, sizes, 25)
ck([m["id"][-6:] for m in kept] == ["dddddd", "bbbbbb"] and used == 20,
   "stops at the first run over the budget")
sizes["20260902-000000-bbbbbb"] = 100
kept, _ = export_showcase.pick_within_budget(metas, sizes, 50)
ck([m["id"][-6:] for m in kept] == ["dddddd"],
   "a run too big for what's left ends the list - no skipping ahead to a smaller one")

# ---- HTML5 limits ----
small = {"total_bytes": 100, "files": 3, "file_bytes": 60, "path_chars": 20}
with tempfile.TemporaryDirectory() as tmp:
    def put(rel, size):
        path = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"x" * size)
    ck(any("index.html" in p for p in publish_itch.html5_problems(tmp, small)),
       "an empty folder is missing index.html")
    put("index.html", 10)
    ck(publish_itch.html5_problems(tmp, small) == [], "a small build passes")
    put("big.json", 70)
    probs = publish_itch.html5_problems(tmp, small)
    ck(any("big.json" in p and "a file" in p for p in probs), "a file over the per-file limit")
    put("more.json", 30)
    ck(any("in all" in p for p in publish_itch.html5_problems(tmp, small)), "over the total size")
    put("a.json", 1)
    ck(any("files" in p for p in publish_itch.html5_problems(tmp, small)), "over the file count")
    put("dungeons/very-long-folder-name/x.json", 1)
    ck(any("character path" in p for p in publish_itch.html5_problems(tmp, small)),
       "a path over the length limit")

# ---- .comfyignore ----
pats = publish_itch.read_comfyignore()
ign = publish_itch.comfyignored
ck(ign("tests/test_trailer.py", pats) and ign("tools/publish_itch.py", pats), "tests/ and tools/ left out")
ck(ign("web/trailers/trailer.json", pats), "web/trailers/ left out")
ck(ign("web/sounds/unused_victory.wav", pats), "unused_* audio left out")
ck(ign("package.json", pats) and ign(".comfyignore", pats), "dev root files left out")
ck(not ign("server.py", pats) and not ign("comfyui_web/comfycrawler.js", pats)
   and not ign("web/game.js", pats) and not ign("README.md", pats), "the node itself ships")
ck(ign("web/tests/", ["tests/"]) and not ign("tests", ["tests/"]),
   "a directory-only pattern matches folders, not a file of that name")
files = publish_itch.node_files()
ck("server.py" in files and "__init__.py" in files and "pyproject.toml" in files,
   "node_files() has the package's own files")
ck(not any(f.startswith(("tests/", "tools/", "web/trailers/")) for f in files),
   "node_files() honours .comfyignore")

# ---- game.js ----
with open(os.path.join(ROOT, "web", "game.js"), encoding="utf-8") as f:
    GAME = f.read()
ck("const FULL_SHOWCASE_URL = SHOWCASE_MODE && typeof window.COMFYCRAWLER_FULL_SHOWCASE === 'string'"
   in GAME, "FULL_SHOWCASE_URL is read from the export's flag, showcase only")
ck("(FULL_SHOWCASE_URL || window.location.origin + window.location.pathname)" in GAME,
   "🔗 links go to the full showcase when there is one")
ck(b"COMFYCRAWLER_FULL_SHOWCASE" in export_showcase.FULL_SHOWCASE_TAG, "the exporter splices the flag game.js reads")

if fails:
    print("FAIL")
    sys.exit(1)
print("all itch build checks passed")
