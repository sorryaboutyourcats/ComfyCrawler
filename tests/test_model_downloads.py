"""Offline checks on the model-download job (server.py's MODEL DOWNLOADS section): streaming,
resume via Range, cancel, a server that ignores Range, the disk-space guard, the one-at-a-time
lock, an already-satisfied group, and the three HTTP routes end to end.
Runs a small local HTTP server of its own to stand in for Hugging Face - no real download, no
ComfyUI needed (comfy_model_dir is monkeypatched directly, the same way _comfy_get_json is faked
in test_comfy_preflight.py)."""
import atexit, http.server, importlib.util, json, os, shutil, socketserver, sys, tempfile, threading, time
import urllib.error, urllib.request

spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

TMP = tempfile.mkdtemp(prefix="cc_downloads_")
atexit.register(shutil.rmtree, TMP, ignore_errors=True)


def target_dir(folder="checkpoints"):
    return os.path.join(TMP, "models", folder)


# A stand-in for ComfyUI: "embedded" mode is the simpler of the two to fake (no folder-existence
# checks - see _resolve_embedded_comfy), and comfy_model_dir just asks it directly for a folder.
listed = {}   # folder -> set of filenames ComfyUI's own listing would show
def fake_get_json(path, timeout=5, base=None):
    if path == "/system_stats":
        return {"system": {"argv": [], "comfyui_version": "0.34.2"}}
    if path.startswith("/models/"):
        return sorted(listed.get(path[len("/models/"):], ()))
    raise AssertionError("unexpected path " + path)


srv._comfy_get_json = fake_get_json
srv.COMFY_EMBEDDED = {"url": "http://127.0.0.1:1", "input_dir": lambda: TMP, "output_dir": lambda: TMP,
                      "model_dir": lambda folder: target_dir(folder)}
srv.MODEL_DOWNLOAD_CHUNK = 4096   # small files still take several chunks, exercising the loop for real


def wait_until_done(timeout=5.0):
    deadline = time.time() + timeout
    view = srv.model_download_job_view()
    while view["state"] in ("queued", "downloading") and time.time() < deadline:
        time.sleep(0.01)
        view = srv.model_download_job_view()
    return view


def use_group(label, files, required=False):
    """Installs one COMFY_MODEL_GROUPS group (files: [(folder, name, size), ...]) and its
    MODEL_DOWNLOADS entries, resets the singleton job, and clears ComfyUI's fake listing for every
    folder it touches - the group starts fully "missing" unless the caller populates `listed`
    afterward."""
    srv.MODEL_DOWNLOADS = {name: {"url": f"{FIXTURE_URL}/{name}", "size": size} for _, name, size in files}
    srv.COMFY_MODEL_GROUPS = [{"label": label, "required": required, "fallback": "nothing works",
                               "files": [(folder, name) for folder, name, _ in files]}]
    for folder, _, _ in files:
        listed.setdefault(folder, set())
    srv._MODEL_DOWNLOAD_JOB = None


# ---------------------------------------------------------------------------
# The fake file server standing in for Hugging Face.
class FakeFileHandler(http.server.BaseHTTPRequestHandler):
    files = {}          # name -> bytes
    ignore_range = False
    throttle_chunk = 0   # > 0 turns on slow, chunked writes so a test can catch a transfer mid-flight
    throttle_sleep = 0.0
    requests = []        # Range header seen per request (None when absent), for assertions

    def do_GET(self):
        name = self.path.lstrip("/")
        body = FakeFileHandler.files.get(name)
        if body is None:
            self.send_response(404); self.end_headers(); return
        rng = None if FakeFileHandler.ignore_range else self.headers.get("Range")
        FakeFileHandler.requests.append(rng)
        start, status = 0, 200
        if rng and rng.startswith("bytes="):
            start, status = int(rng[len("bytes="):].split("-")[0]), 206
        chunk_body = body[start:]
        self.send_response(status)
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
        self.send_header("Content-Length", str(len(chunk_body)))
        self.end_headers()
        step = FakeFileHandler.throttle_chunk or len(chunk_body) or 1
        for i in range(0, len(chunk_body), step):
            self.wfile.write(chunk_body[i:i + step])
            self.wfile.flush()
            if FakeFileHandler.throttle_sleep:
                time.sleep(FakeFileHandler.throttle_sleep)

    def log_message(self, *a, **k):
        pass


fixture = socketserver.TCPServer(("127.0.0.1", 0), FakeFileHandler)
# A cancelled download closes the connection mid-response on purpose - that's a normal client
# disconnect, not a server bug, so don't let socketserver print a traceback for it.
fixture.handle_error = lambda *a, **k: None
FIXTURE_URL = f"http://127.0.0.1:{fixture.server_address[1]}"
threading.Thread(target=fixture.serve_forever, daemon=True).start()
atexit.register(fixture.shutdown)

CONTENT_A = os.urandom(15_000)
CONTENT_B = os.urandom(9_000)
CONTENT_BIG = os.urandom(200_000)

# ---- happy path: two files in one group, progress monotonic, final bytes correct ----
FakeFileHandler.files = {"a.bin": CONTENT_A, "b.bin": CONTENT_B}
use_group("Group AB", [("checkpoints", "a.bin", len(CONTENT_A)), ("checkpoints", "b.bin", len(CONTENT_B))])
resp = srv.start_model_download_job("Group AB")
ck(resp["state"] in ("queued", "downloading"), f"starting should go ahead, got {resp}")
seen_percents = []
deadline = time.time() + 5
view = srv.model_download_job_view()
while view["state"] in ("queued", "downloading") and time.time() < deadline:
    seen_percents.append(view["percent"])
    time.sleep(0.005)
    view = srv.model_download_job_view()
seen_percents.append(view["percent"])
ck(view["state"] == "done", f"the group should finish, got {view}")
ck(all(a <= b for a, b in zip(seen_percents, seen_percents[1:])), "percent should never go backwards")
ck(seen_percents[-1] == 100, "percent should reach 100 when done")
with open(os.path.join(target_dir(), "a.bin"), "rb") as f:
    ck(f.read() == CONTENT_A, "a.bin's downloaded bytes should match exactly")
with open(os.path.join(target_dir(), "b.bin"), "rb") as f:
    ck(f.read() == CONTENT_B, "b.bin's downloaded bytes should match exactly")
ck(not os.path.exists(os.path.join(target_dir(), "a.bin.part"))
   and not os.path.exists(os.path.join(target_dir(), "b.bin.part")), "no .part files should remain once done")

# ---- cancel mid-transfer: leaves a smaller, resumable .part, no finished file ----
FakeFileHandler.files = {"big.bin": CONTENT_BIG}
FakeFileHandler.throttle_chunk, FakeFileHandler.throttle_sleep = 4096, 0.004
use_group("Group Big", [("checkpoints", "big.bin", len(CONTENT_BIG))])
resp = srv.start_model_download_job("Group Big")
ck(resp["state"] in ("queued", "downloading"), f"starting the big file should go ahead, got {resp}")
time.sleep(0.08)
mid = srv.model_download_job_view()
ck(mid["state"] == "downloading" and 0 < mid["bytes_done"] < len(CONTENT_BIG),
   f"should be caught partway through, got {mid}")
ck(srv.cancel_model_download_job("Group Big"), "cancel should report there was something to stop")
final = wait_until_done()
ck(final["state"] == "cancelled", f"job should settle to cancelled, got {final}")
big_path = os.path.join(target_dir(), "big.bin")
part_path = big_path + ".part"
ck(not os.path.exists(big_path), "no finished file after a cancel")
part_size = os.path.getsize(part_path) if os.path.exists(part_path) else -1
ck(0 < part_size < len(CONTENT_BIG), f".part should be a nonzero, incomplete size, got {part_size}")

# ---- resuming: sends the right Range offset, finishes correctly ----
FakeFileHandler.requests = []
srv._MODEL_DOWNLOAD_JOB = None
resp = srv.start_model_download_job("Group Big")
final = wait_until_done()
ck(final["state"] == "done", f"resuming should finish the download, got {final}")
ck(FakeFileHandler.requests[:1] == [f"bytes={part_size}-"],
   f"the resume request should ask for exactly what the .part was missing, got {FakeFileHandler.requests[:1]}")
with open(big_path, "rb") as f:
    ck(f.read() == CONTENT_BIG, "the resumed file's final bytes should be correct, not corrupted")
FakeFileHandler.throttle_chunk, FakeFileHandler.throttle_sleep = 0, 0.0

# ---- a server that ignores Range forces a clean restart instead of a corrupt file ----
FakeFileHandler.files = {"a.bin": CONTENT_A}
FakeFileHandler.ignore_range = True
os.makedirs(target_dir(), exist_ok=True)
with open(os.path.join(target_dir(), "a.bin.part"), "wb") as f:
    f.write(b"\x00" * 1000)   # a stale/garbage partial from some earlier attempt
use_group("Group Restart", [("checkpoints", "a.bin", len(CONTENT_A))])
resp = srv.start_model_download_job("Group Restart")
final = wait_until_done()
ck(final["state"] == "done", f"should still finish even though the server won't honour Range, got {final}")
with open(os.path.join(target_dir(), "a.bin"), "rb") as f:
    ck(f.read() == CONTENT_A, "content must be the real file, not the discarded garbage .part plus a partial fetch")
FakeFileHandler.ignore_range = False

# ---- disk-space guard: refuses before writing anything ----
real_disk_usage = shutil.disk_usage
srv.shutil.disk_usage = lambda path: real_disk_usage(path)._replace(free=0)
use_group("Group Space", [("checkpoints", "huge.bin", 999_999_999_999)])
resp = srv.start_model_download_job("Group Space")
ck(resp["state"] == "failed" and "space" in (resp.get("error") or "").lower(),
   f"should refuse for lack of disk space, got {resp}")
ck(not os.path.exists(os.path.join(target_dir(), "huge.bin.part")), "nothing should be written when the space check fails")
srv.shutil.disk_usage = real_disk_usage

# ---- singleton lock: busy for a different group, idempotent for the same one ----
FakeFileHandler.files = {"x1.bin": CONTENT_BIG, "x2.bin": CONTENT_BIG}
FakeFileHandler.throttle_chunk, FakeFileHandler.throttle_sleep = 4096, 0.004
srv.MODEL_DOWNLOADS = {"x1.bin": {"url": f"{FIXTURE_URL}/x1.bin", "size": len(CONTENT_BIG)},
                       "x2.bin": {"url": f"{FIXTURE_URL}/x2.bin", "size": len(CONTENT_BIG)}}
srv.COMFY_MODEL_GROUPS = [{"label": "Busy1", "required": False, "fallback": "x", "files": [("checkpoints", "x1.bin")]},
                          {"label": "Busy2", "required": False, "fallback": "x", "files": [("checkpoints", "x2.bin")]}]
listed["checkpoints"] = set()
srv._MODEL_DOWNLOAD_JOB = None
r1 = srv.start_model_download_job("Busy1")
ck(r1["state"] in ("queued", "downloading"), f"the first start should go ahead, got {r1}")
r2 = srv.start_model_download_job("Busy2")
ck(r2["state"] == "busy", f"a different group should be refused while one is running, got {r2}")
time.sleep(0.02)
before_again = srv.model_download_job_view()["bytes_done"]
r1_again = srv.start_model_download_job("Busy1")
ck(r1_again["group"] == "Busy1" and r1_again["state"] in ("queued", "downloading"),
   f"re-starting the SAME running group should be idempotent, got {r1_again}")
ck(srv.model_download_job_view()["bytes_done"] >= before_again,
   "an idempotent re-start must not restart progress from zero")
ck(srv.cancel_model_download_job("Busy1"), "cleanup: stop Busy1")
wait_until_done()
FakeFileHandler.throttle_chunk, FakeFileHandler.throttle_sleep = 0, 0.0

# ---- already satisfied: "done" immediately, with no request made to the fixture at all ----
FakeFileHandler.requests = []
os.makedirs(target_dir(), exist_ok=True)
with open(os.path.join(target_dir(), "sat.bin"), "wb") as f:
    f.write(b"already here")
use_group("Group Sat", [("checkpoints", "sat.bin", 12)])
listed["checkpoints"] = {"sat.bin"}   # ComfyUI's own listing already shows it present
resp = srv.start_model_download_job("Group Sat")
ck(resp["state"] == "done", f"an already-satisfied group should report done immediately, got {resp}")
ck(FakeFileHandler.requests == [], "no network request should be made for files already present")

# ---- the three HTTP routes, end to end ----
FakeFileHandler.files = {"route.bin": CONTENT_A}
use_group("Route Group", [("checkpoints", "route.bin", len(CONTENT_A))])
httpd = srv.socketserver.TCPServer(("127.0.0.1", 0), srv.DungeonHTTPRequestHandler)
httpd.RequestHandlerClass.log_message = lambda *a, **k: None
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
try:
    def post(path, payload):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="POST",
                                     data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    code, body = post("/api/model_download_start", {"group": "Route Group"})
    ck(code == 200 and body["state"] in ("queued", "downloading", "done"), f"POST start should succeed, got {code} {body}")

    job, deadline = None, time.time() + 5
    while time.time() < deadline:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/model_download_job", timeout=10) as resp:
            job = json.loads(resp.read().decode("utf-8"))
        if job["state"] not in ("queued", "downloading"):
            break
        time.sleep(0.02)
    ck(job and job["state"] == "done", f"GET job status should reach done, got {job}")

    code, body = post("/api/model_download_cancel", {"group": "Route Group"})
    ck(code == 200 and body.get("success") and body.get("stopped") is False,
       f"cancelling a finished download should succeed but report nothing was stopped, got {code} {body}")
finally:
    httpd.shutdown()
    httpd.server_close()

fixture.shutdown()
fixture.server_close()

print("FAIL" if fails else "all model-download checks passed")
sys.exit(1 if fails else 0)
