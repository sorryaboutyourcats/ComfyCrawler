"""Offline checks on the custom node's adapter (comfy_node.py) and the pieces of server.py it leans
on: forwarding a request through DungeonHTTPRequestHandler in memory, the standalone server's
cross-site refusal, embedded mode, and where ComfyUI's address and saved dungeons are taken from.
Needs neither ComfyUI nor aiohttp - tests/test_node_routes.py covers the aiohttp side."""
import atexit, contextlib, importlib.util, io, json, os, shutil, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)
spec = importlib.util.spec_from_file_location("comfy_node", os.path.join(ROOT, "comfy_node.py"))
cn = importlib.util.module_from_spec(spec); spec.loader.exec_module(cn)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

TMP = tempfile.mkdtemp(prefix="cc_node_")
atexit.register(shutil.rmtree, TMP, ignore_errors=True)
srv.SESSIONS_DIR = os.path.join(TMP, "sessions")
srv.COMFY_SETTINGS_PATH = os.path.join(TMP, "comfy_settings.json")
SID = "20260101-120000-abcdef"
os.makedirs(os.path.join(srv.SESSIONS_DIR, SID))
with open(os.path.join(srv.SESSIONS_DIR, SID, "bundle.json"), "w", encoding="utf-8") as f:
    json.dump({"mode": "v6_krea", "wall_style": "fixture"}, f)
with open(os.path.join(srv.SESSIONS_DIR, SID, "meta.json"), "w", encoding="utf-8") as f:
    json.dump({"created": 1, "wall_style": "fixture"}, f)


def call(method, path, headers=(), body=b""):
    """forward() with stderr captured, so an access-log line would show up as output."""
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        status, pairs, payload = cn.forward(srv, method, path, list(headers), body)
    return status, {k.lower(): v for k, v in pairs}, payload, err.getvalue()


# ---- the page and its assets come through intact ----
status, h, body, err = call("GET", "/")
ck(status == 200 and h.get("content-type", "").startswith("text/html") and b"<title>" in body, "GET / serves index.html")
ck(err == "", f"no access-log output on stderr, got {err!r}")
status, h, body, _ = call("GET", "/game.js")
ck(status == 200 and "javascript" in h.get("content-type", "") and b"SERVER_URL" in body, "GET /game.js")
status, h, body, _ = call("GET", "/tailwind.css")
ck(status == 200 and h.get("content-type", "").startswith("text/css"), "GET /tailwind.css")
status, h, body, _ = call("GET", "/sounds/button.wav")
ck(status == 200 and h.get("content-type") == "audio/wav" and body[:4] == b"RIFF", "GET /sounds/button.wav returns the wav bytes")
status, h, body, _ = call("HEAD", "/")
ck(status == 200 and body == b"", "HEAD answers like GET, without a body")
status, *_ = call("PUT", "/")
ck(status == 405, "an unsupported method gets 405")
status, *_ = call("GET", "/api/no_such_route")
ck(status == 404, "an unknown route gets 404")

# ---- the API ----
status, h, body, _ = call("GET", "/api/progress")
ck(status == 200 and "is_generating" in json.loads(body), "GET /api/progress returns the progress JSON")
status, h, body, _ = call("GET", "/api/history")
ck(status == 200 and [s["id"] for s in json.loads(body)["sessions"]] == [SID], "GET /api/history lists the fixture run")
status, h, body, _ = call("GET", f"/api/history_bundle?id={SID}")
ck(status == 200 and json.loads(body)["wall_style"] == "fixture", "a query string reaches the handler")
all_headers = [call("GET", p)[1] for p in ("/", "/api/progress", "/api/history")]
ck(not any(k.startswith("access-control-") for hh in all_headers for k in hh), "no CORS headers on any response")

# ---- a handler that raises is a 500, not a dead worker ----
real = srv.list_dungeon_sessions
srv.list_dungeon_sessions = lambda: 1 / 0
with contextlib.redirect_stdout(io.StringIO()):
    status, h, body, _ = call("GET", "/api/history")
srv.list_dungeon_sessions = real
ck(status == 500 and b"ComfyUI's log" in body, "a raising handler becomes a 500")

# ---- the big files are recognised for serving straight off disk ----
ck(cn._big_file(srv, "api/history_bundle", {"id": SID}) == (os.path.join(srv.SESSIONS_DIR, SID, "bundle.json"),
   "application/json; charset=utf-8"), "a saved bundle is served from disk")
ck(cn._big_file(srv, "api/history_bundle", {"id": "../../etc"}) is None, "a made-up id is never a path")
ck(cn._big_file(srv, "api/ending_video", {"id": SID}) is None, "no clip on disk -> not served from disk")
open(os.path.join(srv.SESSIONS_DIR, SID, srv.ENDING_FILENAME), "wb").close()
ck(cn._big_file(srv, "api/ending_video", {"id": SID})[1] == "video/mp4", "a clip on disk is served from disk")
ck(cn._big_file(srv, "api/progress", {}) is None, "other routes go through the handler")

# ---- standalone: requests from another website are refused ----
HOST = ("Host", "127.0.0.1:5555")
with contextlib.redirect_stdout(io.StringIO()):
    status, _, body, _ = call("POST", "/api/history_delete",
                              [HOST, ("Origin", "https://evil.example"), ("Content-Type", "text/plain")],
                              json.dumps({"id": SID}).encode())
ck(status == 403 and os.path.isdir(os.path.join(srv.SESSIONS_DIR, SID)), "a cross-origin delete is refused and deletes nothing")
with contextlib.redirect_stdout(io.StringIO()):
    status, *_ = call("GET", "/api/history", [HOST, ("Sec-Fetch-Site", "cross-site")])
ck(status == 403, "Sec-Fetch-Site: cross-site is refused, even for a read")
with contextlib.redirect_stdout(io.StringIO()):
    status, *_ = call("POST", "/api/cancel_generation", [HOST, ("Origin", "null")], b"{}")
ck(status == 403, "Origin: null (a sandboxed page or data: URL) is refused")
status, *_ = call("GET", "/api/history", [HOST, ("Origin", "http://127.0.0.1:5555"), ("Sec-Fetch-Site", "same-origin")])
ck(status == 200, "the page's own same-origin request passes")
status, *_ = call("GET", "/api/history")
ck(status == 200, "a request with no Origin / Sec-Fetch-Site (curl, scripts) passes")

# ---- embedded mode (inside ComfyUI) ----
IN_DIR, OUT_DIR = os.path.join(TMP, "in"), os.path.join(TMP, "out")
os.makedirs(IN_DIR); os.makedirs(OUT_DIR)
srv.save_comfy_settings(url="127.0.0.1:9999")          # must be ignored when embedded
srv.COMFY_EMBEDDED = {"url": "http://127.0.0.1:8188", "input_dir": lambda: IN_DIR, "output_dir": lambda: OUT_DIR}
asked = []
def fake_get(path, timeout=5, base=None):
    asked.append((base or srv.COMFY_URL, path))
    if path == "/system_stats":
        return {"system": {"comfyui_version": "0.34.2", "argv": []}}
    if path.startswith("/models/"):
        return sorted({n for g in srv.COMFY_MODEL_GROUPS for f, n in g["files"] if f == path[len("/models/"):]})
    if path.startswith("/object_info/"):
        return {path[len("/object_info/"):]: {}}
    raise AssertionError(path)
srv._comfy_get_json = fake_get
srv._COMFY_RESOLVED = False
with contextlib.redirect_stdout(io.StringIO()):
    srv.ensure_comfy()
ck((srv.COMFY_URL, srv.COMFY_INPUT_DIR, srv.COMFY_OUTPUT_DIR) == ("http://127.0.0.1:8188", IN_DIR, OUT_DIR),
   "embedded: the address and folders come from ComfyUI")
ck(srv._COMFY_SOURCES == {"url": "comfyui", "input_dir": "comfyui", "output_dir": "comfyui"}, "embedded sources")
ck(all(base == "http://127.0.0.1:8188" for base, _ in asked), "embedded: the address saved in Options is never tried")
with contextlib.redirect_stdout(io.StringIO()):
    report = srv.comfy_preflight()
ck(report["ready"] and report["comfy"]["embedded"], "the preflight report says embedded")
status, h, body, _ = call("POST", "/api/comfy_settings", [HOST], json.dumps({"url": ""}).encode())
ck(status == 409 and json.loads(body).get("embedded"), "embedded: saving a connection is refused")
ck(srv.load_comfy_settings()["url"] == "http://127.0.0.1:9999", "embedded: the refused save changed nothing")
with contextlib.redirect_stdout(io.StringIO()):
    status, h, body, _ = call("GET", "/api/comfy_settings")
ck(status == 200 and json.loads(body)["embedded"] is True, "the settings view says embedded")
with contextlib.redirect_stdout(io.StringIO()):
    status, *_ = call("GET", "/api/history", [HOST, ("Sec-Fetch-Site", "cross-site")])
ck(status == 200, "embedded: the cross-site check is left to ComfyUI's own middleware")
def down(path, timeout=5, base=None):
    raise OSError("refused")
srv._comfy_get_json = down
try:
    srv.ensure_comfy(refresh=True)
    ck(False, "embedded: an unanswering ComfyUI should raise")
except srv.ComfyUnavailable as e:
    ck("starting up" in str(e), "embedded: not answering yet reads as still starting")
srv.COMFY_EMBEDDED = None

# ---- where ComfyUI is reached, and where saved dungeons go ----
ck(cn.loopback_url(None, 8188) == "http://127.0.0.1:8188", "default listen")
ck(cn.loopback_url("0.0.0.0,::", 8188) == "http://127.0.0.1:8188", "bare --listen (ComfyUI Desktop)")
ck(cn.loopback_url("::", 8000) == "http://[::1]:8000", "IPv6-only listen")
ck(cn.loopback_url("192.168.1.5", 8188) == "http://192.168.1.5:8188", "a specific LAN address")
ck(cn.loopback_url("fe80::1", 8188) == "http://[fe80::1]:8188", "a specific IPv6 address is bracketed")
ck(cn.loopback_url("127.0.0.1", 8443, tls=True) == "https://127.0.0.1:8443", "TLS")
repo, user = os.path.join(TMP, "repo"), os.path.join(TMP, "user")
os.makedirs(repo)
ck(cn.choose_data_dir(repo, user) == os.path.join(user, "comfycrawler"), "a fresh install keeps runs in ComfyUI's user folder")
os.makedirs(os.path.join(repo, "dungeon_sessions"))
ck(cn.choose_data_dir(repo, user) == repo, "a checkout that already has dungeon_sessions keeps using it")

print("FAIL" if fails else "all node-shim checks passed")
sys.exit(1 if fails else 0)
