"""Offline checks on finding ComfyUI and the preflight: argv/env/base-directory folder detection,
the 8188 -> 8000 URL fallback, what counts as ready, the CREATE refusal, and a second server's
refused bind.
No ComfyUI needed - _comfy_get_json is replaced by a fake one."""
import atexit, errno, importlib.util, json, os, shutil, sys, tempfile, threading, urllib.error, urllib.request
spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

TMP = tempfile.mkdtemp(prefix="cc_preflight_")
atexit.register(shutil.rmtree, TMP, ignore_errors=True)
# Never the real comfy_settings.json: everything below saves and deletes settings freely.
srv.COMFY_SETTINGS_PATH = os.path.join(TMP, "comfy_settings.json")
def mkdirs(*parts):
    p = os.path.join(TMP, *parts)
    os.makedirs(p, exist_ok=True)
    return p

DESKTOP_IN, DESKTOP_OUT = mkdirs("shared", "input"), mkdirs("shared", "output")
BASE = os.path.join(TMP, "base")
BASE_IN, BASE_OUT = mkdirs("base", "input"), mkdirs("base", "output")
mkdirs("base", "custom_nodes")

# Every file the preflight asks for, by folder - a ComfyUI that has the lot.
ALL_MODELS = {}
for g in srv.COMFY_MODEL_GROUPS:
    for folder, name in g["files"]:
        ALL_MODELS.setdefault(folder, set()).add(name)
ALL_NODES = {"SaveImageWithAlpha", "PathchSageAttentionKJ"}


def fake_comfy(up=("http://127.0.0.1:8188",), argv=(), custom_nodes=(), models=None,
               nodes=ALL_NODES, broken_folders=()):
    """A stand-in for _comfy_get_json: answers only at the URLs in `up`."""
    models = ALL_MODELS if models is None else models
    calls = []
    def get(path, timeout=5, base=None):
        base = base or srv.COMFY_URL
        calls.append((base, path))
        if base not in up:
            raise urllib.error.URLError("connection refused")
        if path == "/system_stats":
            return {"system": {"argv": list(argv), "comfyui_version": "0.34.2"}}
        if path == "/internal/folder_paths":
            return {"custom_nodes": list(custom_nodes)}
        if path.startswith("/models/"):
            folder = path[len("/models/"):]
            if folder in broken_folders:
                raise urllib.error.HTTPError(path, 404, "not found", {}, None)
            return sorted(models.get(folder, ()))
        if path.startswith("/object_info/"):
            name = path[len("/object_info/"):]
            return {name: {}} if name in nodes else {}
        raise AssertionError("unexpected ComfyUI path " + path)
    get.calls = calls
    return get


def reset(**kw):
    for k in ("COMFYUI_URL", "COMFYUI_INPUT_DIR", "COMFYUI_OUTPUT_DIR"):
        os.environ.pop(k, None)
    if os.path.exists(srv.COMFY_SETTINGS_PATH):
        os.remove(srv.COMFY_SETTINGS_PATH)
    srv._COMFY_RESOLVED = False
    srv.COMFY_URL = "http://127.0.0.1:8188"
    srv.COMFY_INPUT_DIR = srv.COMFY_OUTPUT_DIR = None
    srv._comfy_get_json = fake_comfy(**kw)
    return srv._comfy_get_json


DESKTOP_ARGV = ["ComfyUI\\main.py", "--listen", "--input-directory", DESKTOP_IN,
                "--output-directory", DESKTOP_OUT]

# ---- argv parsing ----
ck(srv._argv_value(["main.py", "--input-directory", "X"], "--input-directory") == "X", "--flag value form")
ck(srv._argv_value(["main.py", "--input-directory=X"], "--input-directory") == "X", "--flag=value form")
ck(srv._argv_value(["main.py", "--input-directory"], "--input-directory") is None, "a flag with no value after it")
ck(srv._argv_value(["main.py", "--input-directory-extra", "X"], "--input-directory") is None,
   "a longer flag that merely starts with the name must not match")

# ---- ComfyUI Desktop: both folders come from its launch argv ----
reset(argv=DESKTOP_ARGV)
srv.ensure_comfy()
ck((srv.COMFY_URL, srv.COMFY_INPUT_DIR, srv.COMFY_OUTPUT_DIR) == ("http://127.0.0.1:8188", DESKTOP_IN, DESKTOP_OUT),
   "Desktop argv should give the URL and both folders")

# ---- cached once found; refresh asks again ----
get = srv._comfy_get_json
n = len(get.calls)
srv.ensure_comfy()
ck(len(get.calls) == n, "a resolved ComfyUI must not be asked again without refresh")
srv.ensure_comfy(refresh=True)
ck(len(get.calls) > n, "refresh=True must ask ComfyUI again")

# ---- 8188 silent, 8000 answering (ComfyUI Desktop's other usual port) ----
reset(up=("http://127.0.0.1:8000",), argv=DESKTOP_ARGV)
srv.ensure_comfy()
ck(srv.COMFY_URL == "http://127.0.0.1:8000", "should fall through to :8000 when :8188 doesn't answer")

# ---- --base-directory, and no flags at all (custom_nodes' parent is the base) ----
reset(argv=["main.py", "--base-directory", BASE])
srv.ensure_comfy()
ck((srv.COMFY_INPUT_DIR, srv.COMFY_OUTPUT_DIR) == (BASE_IN, BASE_OUT), "--base-directory -> <base>/input, <base>/output")
reset(argv=["main.py"], custom_nodes=[os.path.join(BASE, "custom_nodes")])
srv.ensure_comfy()
ck((srv.COMFY_INPUT_DIR, srv.COMFY_OUTPUT_DIR) == (BASE_IN, BASE_OUT),
   "no folder flags -> derived from where custom_nodes lives")
reset(argv=["main.py", "--input-directory", DESKTOP_IN], custom_nodes=[os.path.join(BASE, "custom_nodes")])
srv.ensure_comfy()
ck((srv.COMFY_INPUT_DIR, srv.COMFY_OUTPUT_DIR) == (DESKTOP_IN, BASE_OUT),
   "an explicit input folder is kept while only the output falls back to the base")

# ---- env vars beat detection; COMFYUI_URL is the only URL tried ----
reset(up=("http://127.0.0.1:9999",), argv=DESKTOP_ARGV)
os.environ["COMFYUI_URL"] = "http://127.0.0.1:9999/"
os.environ["COMFYUI_INPUT_DIR"], os.environ["COMFYUI_OUTPUT_DIR"] = BASE_IN, BASE_OUT
srv.ensure_comfy()
ck(srv.COMFY_URL == "http://127.0.0.1:9999", "COMFYUI_URL (trailing slash trimmed) should be used")
ck((srv.COMFY_INPUT_DIR, srv.COMFY_OUTPUT_DIR) == (BASE_IN, BASE_OUT), "COMFYUI_*_DIR should beat argv")
ck(not any(b in srv.COMFY_URL_CANDIDATES for b, _ in srv._comfy_get_json.calls),
   "with COMFYUI_URL set, the default candidates must not be tried")

# ---- nothing answering: unreachable, not cached, preflight not ready ----
reset(up=())
try:
    srv.ensure_comfy()
    ck(False, "ensure_comfy should raise when no ComfyUI answers")
except srv.ComfyUnavailable as e:
    ck(not e.reachable, "an unanswered ComfyUI is not reachable")
    ck("is it running" in str(e) and "Options" in str(e), "the message should say to start it or set it in Options")
ck(not srv._COMFY_RESOLVED and srv.COMFY_INPUT_DIR is None, "a failure must not be cached or fill the folders")
r = srv.comfy_preflight()
ck(not r["ready"] and not r["comfy"]["reachable"] and r["comfy"]["error"], "unreachable preflight: not ready, with the error")
ck(srv.preflight_problems(r) == [r["comfy"]["error"]], "unreachable: the one problem is the connection")

# ---- ComfyUI answers but its folders aren't on this machine ----
reset(argv=["main.py", "--input-directory", os.path.join(TMP, "nope", "in"),
            "--output-directory", os.path.join(TMP, "nope", "out")])
try:
    srv.ensure_comfy()
    ck(False, "ensure_comfy should raise when the folders don't exist here")
except srv.ComfyUnavailable as e:
    ck(e.reachable, "folders missing is still a reachable ComfyUI")
    ck("Options" in str(e), "the message should point at Options, where the folders can be set")
r = srv.comfy_preflight()
ck(r["comfy"]["reachable"] and not r["ready"], "missing folders: reachable but not ready")

# ---- everything present ----
reset(argv=DESKTOP_ARGV)
r = srv.comfy_preflight()
ck(r["ready"], "a ComfyUI with every file and node should be ready")
ck(all(not g["missing"] for g in r["groups"]) and all(nd["present"] for nd in r["nodes"]), "nothing reported missing")
ck(r["comfy"]["input_dir"] == DESKTOP_IN and r["comfy"]["version"] == "0.34.2", "report carries folders and version")
ck(srv.preflight_problems(r) == [], "ready -> no problems")

# ---- a required model missing ----
models = {f: set(v) for f, v in ALL_MODELS.items()}
models["diffusion_models"].discard(srv.KONTEXT_UNET)
reset(argv=DESKTOP_ARGV, models=models)
r = srv.comfy_preflight()
ck(not r["ready"], "a missing Kontext model must make the run not ready")
portraits = next(g for g in r["groups"] if g["label"] == "HUD portraits")
ck(portraits["missing"] == [{"folder": "diffusion_models", "file": srv.KONTEXT_UNET}],
   "the missing file should be listed with its folder")
probs = srv.preflight_problems(r)
ck(len(probs) == 1 and srv.KONTEXT_UNET in probs[0] and "models/diffusion_models/" in probs[0],
   "the problem line names the file and where it goes")

# ---- only optional things missing: still ready, with the fallback said ----
models = {f: set(v) for f, v in ALL_MODELS.items()}
models["checkpoints"].discard(srv.SFX_CKPT)
models["diffusion_models"].discard(srv.ENDING_UNET)
reset(argv=DESKTOP_ARGV, models=models, nodes={"SaveImageWithAlpha"})
r = srv.comfy_preflight()
ck(r["ready"], "missing sound effects / ending video / sage attention must not block a run")
sfx = next(g for g in r["groups"] if g["label"] == "Sound effects")
ck(sfx["missing"] and not sfx["required"] and "procedural" in sfx["fallback"], "sound effects missing, with its fallback")
ck(srv.preflight_problems(r) == [], "optional gaps are not problems")

# ---- the required node missing ----
reset(argv=DESKTOP_ARGV, nodes={"PathchSageAttentionKJ"})
r = srv.comfy_preflight()
ck(not r["ready"], "no SaveImageWithAlpha -> not ready")
ck(any("KJNodes" in p for p in srv.preflight_problems(r)), "the problem line says which pack to install")

# ---- a /models folder the ComfyUI doesn't know counts as empty ----
reset(argv=DESKTOP_ARGV, broken_folders={"background_removal"})
r = srv.comfy_preflight()
art = next(g for g in r["groups"] if g["label"] == "Dungeon art & story")
ck(not r["ready"] and {"folder": "background_removal", "file": srv.BIREFNET_MODEL} in art["missing"],
   "a folder listing that fails should report its files missing")

# ---- Options > ComfyUI Connection: normalising what was typed ----
ck(srv.normalize_comfy_url("") == "" and srv.normalize_comfy_url("   ") == "", "blank address = auto-detect")
ck(srv.normalize_comfy_url("127.0.0.1:8189") == "http://127.0.0.1:8189", "a bare host:port gets http://")
ck(srv.normalize_comfy_url(" http://localhost:8188/ ") == "http://localhost:8188", "spaces and a trailing slash go")
ck(srv.normalize_comfy_url("https://box.lan:8443") == "https://box.lan:8443", "https is kept")
for bad in ("ftp://127.0.0.1:8188", "http://127.0.0.1:notaport", "http://:8188", "http://127.0.0.1:8188/?x=1"):
    try:
        srv.normalize_comfy_url(bad)
        ck(False, f"{bad!r} should be refused as an address")
    except ValueError as e:
        ck("should look like" in str(e), f"refusal for {bad!r} should show what an address looks like")
ck(srv.normalize_comfy_dir(f'"{DESKTOP_IN}"') == os.path.normpath(DESKTOP_IN),
   "the quotes Explorer's Copy as path adds are taken off")
ck(srv.normalize_comfy_dir("") == "", "blank folder = auto-detect")

# ---- saving and loading; all blank removes the file; a corrupt file is all auto ----
reset()
saved = srv.save_comfy_settings(url="127.0.0.1:8189", input_dir=f'"{BASE_IN}"')
ck(saved == {"url": "http://127.0.0.1:8189", "input_dir": os.path.normpath(BASE_IN), "output_dir": ""},
   "save returns the normalised values")
ck(srv.load_comfy_settings() == saved, "load returns what was saved")
srv.save_comfy_settings()
ck(not os.path.exists(srv.COMFY_SETTINGS_PATH), "saving all-blank deletes the settings file")
try:
    srv.save_comfy_settings(url="ftp://nope")
    ck(False, "a bad address should not save")
except ValueError:
    ck(not os.path.exists(srv.COMFY_SETTINGS_PATH), "a refused address writes nothing")
with open(srv.COMFY_SETTINGS_PATH, "w", encoding="utf-8") as f:
    f.write("{not json")
ck(srv.load_comfy_settings() == {"url": "", "input_dir": "", "output_dir": ""}, "a corrupt file reads as auto-detect")

# ---- precedence: env > Options > auto-detect, per value, with the source reported ----
reset(up=("http://127.0.0.1:8189",), argv=DESKTOP_ARGV)
srv.save_comfy_settings(url="127.0.0.1:8189")
srv.ensure_comfy()
ck(srv.COMFY_URL == "http://127.0.0.1:8189", "the address from Options is used")
ck(not any(b in srv.COMFY_URL_CANDIDATES for b, _ in srv._comfy_get_json.calls),
   "with an address in Options, the default candidates are not tried")
ck(srv._COMFY_SOURCES == {"url": "options", "input_dir": "auto", "output_dir": "auto"},
   f"sources should read options/auto/auto, got {srv._COMFY_SOURCES}")

reset(up=("http://127.0.0.1:9999",), argv=DESKTOP_ARGV)
srv.save_comfy_settings(url="127.0.0.1:8189", output_dir=BASE_OUT)
os.environ["COMFYUI_URL"] = "http://127.0.0.1:9999"
srv.ensure_comfy()
ck(srv.COMFY_URL == "http://127.0.0.1:9999" and srv._COMFY_SOURCES["url"] == "env",
   "the environment variable beats the address in Options")
ck(srv.COMFY_OUTPUT_DIR == os.path.normpath(BASE_OUT) and srv._COMFY_SOURCES["output_dir"] == "options",
   "a folder from Options beats the one ComfyUI was launched with")
ck(srv.COMFY_INPUT_DIR == DESKTOP_IN and srv._COMFY_SOURCES["input_dir"] == "auto",
   "a folder Options leaves blank is still detected")

# ---- a bad address in Options: named in the message, and it drops the last good answer ----
reset(argv=DESKTOP_ARGV)
srv.ensure_comfy()
ck(srv._COMFY_RESOLVED, "resolved before the change")
srv.save_comfy_settings(url="127.0.0.1:8199")        # nothing answers there
r = srv.comfy_preflight()
ck(not r["ready"] and "8199" in (r["comfy"]["error"] or "") and "Options" in r["comfy"]["error"],
   "the preflight error names the address from Options")
ck(not srv._COMFY_RESOLVED, "a refresh that fails must forget the last good connection")
try:
    srv.ensure_comfy()
    ck(False, "later calls should be held to the new (unreachable) address, not the cached one")
except srv.ComfyUnavailable:
    pass
ck(r["comfy"]["sources"] is None, "no sources are reported while unreachable")

# ---- drift guards ----
src = open(spec.origin, encoding="utf-8").read()
for name in (srv.FLUX_SCHNELL_CKPT, srv.BIREFNET_MODEL):
    ck(src.count(f'"{name}"') == 1, f"{name} should be spelled out once (its constant), not inline in a graph")
ck(all(hasattr(srv, v) for v in srv.OPENABLE_FOLDERS.values()), "every OPENABLE_FOLDERS entry must name a real global")

# ---- the handler: /api/preflight, and CREATE refused before any run starts ----
models = {f: set(v) for f, v in ALL_MODELS.items()}
models["checkpoints"].discard(srv.FLUX_SCHNELL_CKPT)
reset(argv=DESKTOP_ARGV, models=models)
httpd = srv.socketserver.TCPServer(("127.0.0.1", 0), srv.DungeonHTTPRequestHandler)
httpd.RequestHandlerClass.log_message = lambda *a, **k: None   # keep the test output readable
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/preflight", timeout=10) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    ck(body["ready"] is False and body["groups"], "GET /api/preflight returns the report")

    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/generate_dungeon", method="POST",
                                 data=json.dumps({"mode": "v6_krea", "wall_style": "moss"}).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10)
        ck(False, "CREATE should be refused while a required model is missing")
    except urllib.error.HTTPError as e:
        refusal = json.loads(e.read().decode("utf-8"))
        ck(e.code == 409, f"refusal status should be 409, got {e.code}")
        ck(srv.FLUX_SCHNELL_CKPT in refusal.get("error", "") and "models/checkpoints/" in refusal["error"],
           "the refusal text names the missing file and its folder")
        ck(refusal.get("preflight", {}).get("ready") is False, "the refusal carries the report for the page")
    ck(not srv.gen_progress["is_generating"], "a refused CREATE must not start a run")

    # ---- /api/comfy_settings: view, save, bad address, refused mid-run ----
    def post_settings(payload):
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/comfy_settings", method="POST",
                                     data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/comfy_settings", timeout=15) as resp:
        view = json.loads(resp.read().decode("utf-8"))
    ck(set(view) >= {"settings", "env", "env_names", "candidates", "preflight"}, "GET returns the full view")
    ck(view["env"] == {"url": False, "input_dir": False, "output_dir": False}, "no env pins in the test")

    code, body = post_settings({"url": "127.0.0.1:8000", "input_dir": "", "output_dir": ""})
    ck(code == 200 and body.get("success"), f"saving an address should succeed, got {code}")
    ck(body.get("settings", {}).get("url") == "http://127.0.0.1:8000", "the reply shows the saved, normalised address")
    ck(body["preflight"]["comfy"]["error"] and "Options" in body["preflight"]["comfy"]["error"],
       "the reply's preflight already reflects the new address (nothing answers at :8000 here)")

    code, body = post_settings({"url": "ftp://nope"})
    ck(code == 400 and "should look like" in body.get("error", ""), "a bad address gets a 400 with the reason")
    ck(srv.load_comfy_settings()["url"] == "http://127.0.0.1:8000", "a refused save leaves the old settings")

    srv.gen_progress["is_generating"] = True
    try:
        code, body = post_settings({"url": ""})
    finally:
        srv.gen_progress["is_generating"] = False
    ck(code == 409 and body.get("busy"), "changing the connection mid-run is refused")
    ck(srv.load_comfy_settings()["url"] == "http://127.0.0.1:8000", "a refused mid-run save changes nothing")

    code, body = post_settings({"url": "", "input_dir": "", "output_dir": ""})
    ck(code == 200 and not os.path.exists(srv.COMFY_SETTINGS_PATH), "all blank = back to auto-detect, file gone")

    # ---- a second server can't share the port (what makes the "already running" message fire) ----
    try:
        srv.socketserver.TCPServer(("127.0.0.1", port), srv.DungeonHTTPRequestHandler).server_close()
        ck(False, "a second server bound the same port")
    except OSError as e:
        ck(e.errno == errno.EADDRINUSE or getattr(e, "winerror", None) in (10048, 10013),
           f"the bind failure should be one run_server recognises (got errno={e.errno}, "
           f"winerror={getattr(e, 'winerror', None)})")
finally:
    httpd.shutdown()
    httpd.server_close()

print("FAIL" if fails else "all preflight checks passed")
sys.exit(1 if fails else 0)
