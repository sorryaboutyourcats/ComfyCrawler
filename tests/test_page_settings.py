"""Offline checks on the page's saved settings (server.py PAGE SETTINGS): loading and filtering, merging
and forgetting, refusals that write nothing, a change written by the other address in between being
kept, the settings written safely into index.html, and the /api/settings routes. The two addresses
(standalone and inside ComfyUI) sharing one set is covered live, in a browser."""
import atexit, importlib.util, json, os, re, shutil, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)
spec = importlib.util.spec_from_file_location("comfy_node", os.path.join(ROOT, "comfy_node.py"))
cn = importlib.util.module_from_spec(spec); spec.loader.exec_module(cn)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

TMP = tempfile.mkdtemp(prefix="cc_settings_")
atexit.register(shutil.rmtree, TMP, ignore_errors=True)
srv.PAGE_SETTINGS_PATH = os.path.join(TMP, "page_settings.json")   # never the real one
def on_disk():
    with open(srv.PAGE_SETTINGS_PATH, encoding="utf-8") as f:
        return json.load(f)
def write_raw(text):
    with open(srv.PAGE_SETTINGS_PATH, "w", encoding="utf-8") as f:
        f.write(text)

# ---- loading ----
ck(srv.load_page_settings() == {}, "no file = no settings")
write_raw("{not json")
ck(srv.load_page_settings() == {}, "a corrupt file = no settings")
write_raw("[1, 2]")
ck(srv.load_page_settings() == {}, "a file that isn't an object = no settings")
write_raw(json.dumps({"comfycrawler.maxFps": "144", "other.key": "x", "comfycrawler.bad": 5}))
ck(srv.load_page_settings() == {"comfycrawler.maxFps": "144"}, "only the page's own string settings are loaded")
os.remove(srv.PAGE_SETTINGS_PATH)

# ---- saving: merge, forget, refuse ----
ck(srv.save_page_settings({"comfycrawler.endingVideo": "on", "comfycrawler.maxFps": "144"})
   == {"comfycrawler.endingVideo": "on", "comfycrawler.maxFps": "144"}, "first save returns everything")
srv.save_page_settings({"comfycrawler.difficulty": "hard"})
ck(on_disk() == {"comfycrawler.endingVideo": "on", "comfycrawler.maxFps": "144", "comfycrawler.difficulty": "hard"},
   "a later save merges into what's there")
srv.save_page_settings({"comfycrawler.maxFps": None})
ck("comfycrawler.maxFps" not in on_disk(), "null forgets a setting")
before = on_disk()
for bad, why in (({"notours": "x"}, "a key without the comfycrawler. prefix"),
                 ({"comfycrawler.x": 3}, "a value that isn't text"),
                 ({"comfycrawler.x": "y" * (srv.PAGE_SETTING_MAX_CHARS + 1)}, "an over-long value"),
                 (["comfycrawler.x"], "a body that isn't an object"),
                 ({f"comfycrawler.k{i}": "v" for i in range(srv.PAGE_SETTINGS_MAX_KEYS + 1)}, "too many settings")):
    try:
        srv.save_page_settings(bad)
        ck(False, f"{why} should be refused")
    except ValueError:
        ck(on_disk() == before, f"{why} is refused without writing anything")

# ---- the other address wrote meanwhile: its change is kept ----
external = on_disk(); external["comfycrawler.screensaverStop"] = "5"
write_raw(json.dumps(external))
merged = srv.save_page_settings({"comfycrawler.endingVideoLook": "pixel"})
ck(merged.get("comfycrawler.screensaverStop") == "5" and merged.get("comfycrawler.endingVideoLook") == "pixel",
   "a save re-reads the file, so a change the other address wrote in between survives")

# ---- written into the page, safely ----
TAG = srv.SAVED_SETTINGS_TAG
with open(os.path.join(ROOT, "index.html"), "rb") as f:
    html = f.read()
ck(html.count(TAG) == 1, "index.html carries the empty #savedSettings tag exactly once (server.py replaces it byte-for-byte)")
ck(html.index(TAG) < html.index(b'<script src="game.js">'), "the settings tag comes before game.js")
hostile = '</script><script>alert(1)</script><!--'
srv.save_page_settings({"comfycrawler.difficulty": hostile})
page = srv.page_with_saved_settings(html)
m = re.search(rb'<script id="savedSettings" type="application/json">(.*?)</script>', page, re.S)
ck(m is not None and json.loads(m.group(1))["comfycrawler.difficulty"] == hostile,
   "a value survives the round trip into the page and back out of JSON")
ck(b"<" not in m.group(1), "no raw '<' inside the tag, so no value can close it or open a comment")
ck(page.count(b"<script>alert(1)") == 0, "the hostile value never becomes markup")
ck(srv.page_with_saved_settings(b"<html>no tag</html>") == b"<html>no tag</html>", "a page without the tag is untouched")
srv.save_page_settings({"comfycrawler.difficulty": "hard"})

# ---- through the request handler ----
def call(method, path, headers=(), body=b""):
    return cn.forward(srv, method, path, list(headers), body)

status, pairs, body = call("GET", "/")
h = {k.lower(): v for k, v in pairs}
ck(status == 200 and h.get("cache-control") == "no-store", "the page isn't cached, since it carries settings")
m = re.search(rb'<script id="savedSettings" type="application/json">(.*?)</script>', body, re.S)
ck(m is not None and json.loads(m.group(1)).get("comfycrawler.difficulty") == "hard", "GET / carries the saved settings")
status, _, body = call("GET", "/api/settings")
ck(status == 200 and json.loads(body)["settings"].get("comfycrawler.difficulty") == "hard", "GET /api/settings")
status, _, body = call("POST", "/api/settings", [("Content-Type", "application/json")],
                       json.dumps({"comfycrawler.difficulty": "easy"}).encode())
ck(status == 200 and on_disk().get("comfycrawler.difficulty") == "easy", "POST /api/settings saves")
status, _, body = call("POST", "/api/settings", [("Content-Type", "application/json")], json.dumps({"x": "1"}).encode())
ck(status == 400 and "isn't a ComfyCrawler setting" in json.loads(body)["error"], "a foreign key gets a 400")
status, _, body = call("POST", "/api/settings")
ck(status == 200 and json.loads(body)["success"], "an empty body (a beacon with nothing left to send) is answered, not an error")
import contextlib, io
with contextlib.redirect_stdout(io.StringIO()):
    status, _, _ = call("POST", "/api/settings", [("Host", "127.0.0.1:5555"), ("Origin", "https://evil.example")],
                        json.dumps({"comfycrawler.difficulty": "hard"}).encode())
ck(status == 403 and on_disk().get("comfycrawler.difficulty") == "easy", "another website can't change the settings")

print("FAIL" if fails else "all page-settings checks passed")
sys.exit(1 if fails else 0)
