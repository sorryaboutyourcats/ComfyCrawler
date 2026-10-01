"""Offline checks on the sample-dungeon download (server.py's SAMPLE DUNGEONS section): which runs
get picked, what their meta.json keeps and drops, a run with no ending clip, a run already on disk,
cancel leaving no half-run behind, a bundle that is not one, and the three HTTP routes end to end.
Runs a small local HTTP server of its own to stand in for the showcase site - no real download."""
import atexit, http.server, importlib.util, json, os, shutil, socketserver, sys, tempfile, threading, time
import urllib.error, urllib.request

spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL:", msg)

TMP = tempfile.mkdtemp(prefix="cc_samples_")
atexit.register(shutil.rmtree, TMP, ignore_errors=True)
srv.SESSIONS_DIR = os.path.join(TMP, "dungeon_sessions")
os.makedirs(srv.SESSIONS_DIR)
srv.MODEL_DOWNLOAD_CHUNK = 4096   # several chunks per file, so cancel has somewhere to land


def row(sid, **kw):
    return dict({"id": sid, "created": 0, "location": "Place " + sid[-6:], "wall_style": "walls",
                 "favorite": True, "beaten": True, "beaten_at": 1, "last_played": 2, "size": 1}, **kw)


A, B, C, D = ("20260910-100337-aaaaaa", "20260920-205950-bbbbbb",
              "20260909-162711-cccccc", "20260912-174402-dddddd")
HIDDEN, BAD = "20260901-000000-eeeeee", "../../evil"
ROWS = [row(D, created=500),                               # un-numbered: after every numbered one
        row(C, sort_number=3),
        row(A, sort_number=1, pictures={"enemy": {"kind": "creature", "saved": True}}),
        row(B, sort_number=2),
        row(HIDDEN, sort_number=0, unlisted=True),          # hidden from the gallery, never a sample
        row(BAD, sort_number=0)]                            # not an id this server would write


def bundle(sid):
    return json.dumps({"id": sid, "pad": "x" * 30_000}).encode("utf-8")


def site_files():
    files = {"dungeons.json": json.dumps({"sessions": ROWS}).encode("utf-8")}
    for sid in (A, B, C, D):
        files[f"dungeons/{sid}/bundle.json"] = bundle(sid)
        for card in (srv.CARD_FILENAME, srv.CARD_BG_FILENAME, srv.CARD_HERO_FILENAME):
            files[f"dungeons/{sid}/{card}"] = b"png" + sid.encode()
        if sid != B:                                        # B was never filmed
            files[f"dungeons/{sid}/{srv.ENDING_FILENAME}"] = os.urandom(20_000)
    return files


class FakeSite(http.server.BaseHTTPRequestHandler):
    files = {}
    throttle_sleep = 0.0
    agents = []

    def _answer(self, with_body):
        FakeSite.agents.append(self.headers.get("User-Agent"))
        body = FakeSite.files.get(self.path.lstrip("/").split("/", 1)[-1])
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not with_body:
            return
        for i in range(0, len(body), 4096):
            self.wfile.write(body[i:i + 4096])
            self.wfile.flush()
            if FakeSite.throttle_sleep:
                time.sleep(FakeSite.throttle_sleep)

    def do_GET(self):
        self._answer(True)

    def do_HEAD(self):
        self._answer(False)

    def log_message(self, *a, **k):
        pass


site = socketserver.ThreadingTCPServer(("127.0.0.1", 0), FakeSite)
site.daemon_threads = True
site.handle_error = lambda *a, **k: None   # a cancel hangs up mid-response on purpose
threading.Thread(target=site.serve_forever, daemon=True).start()
atexit.register(site.shutdown)
# One folder down, like the real site - the base URL always ends in a slash.
srv.SAMPLE_DUNGEONS_URL = f"http://127.0.0.1:{site.server_address[1]}/ComfyCrawlerTest/"


def wait_until_done(timeout=10.0):
    deadline = time.time() + timeout
    view = srv.sample_download_job_view()
    while view["state"] in ("queued", "downloading") and time.time() < deadline:
        time.sleep(0.01)
        view = srv.sample_download_job_view()
    return view


def listed_ids():
    return {m["id"] for m in srv.list_dungeon_sessions(fresh=True)}


# ---- the pick: the gallery's Default order, unlisted and bad ids left out ----
picked = [r["id"] for r in srv.pick_sample_dungeons(ROWS)]
ck(picked == [A, B, C], f"should pick numbered runs lowest first, got {picked}")
ck([r["id"] for r in srv.pick_sample_dungeons(ROWS, count=10)] == [A, B, C, D],
   "un-numbered runs come after the numbered ones")

# ---- happy path: three runs land whole, with the right meta ----
FakeSite.files = site_files()
ck(srv.sample_download_job_view()["state"] == "idle", "nothing has run yet")
resp = srv.start_sample_download_job()
ck(resp["state"] in ("queued", "downloading"), f"starting should go ahead, got {resp}")
view = wait_until_done()
ck(view["state"] == "done" and view["percent"] == 100, f"the download should finish, got {view}")
ck(view["saved"] == [A, B, C] and view["count"] == 3, f"should save A, B, C in order, got {view}")
ck(listed_ids() == {A, B, C}, f"History should list exactly the three samples, got {listed_ids()}")
ck(all(a == "ComfyCrawler" for a in FakeSite.agents), "every request should carry the named User-Agent")
with open(os.path.join(srv.SESSIONS_DIR, A, "bundle.json"), "rb") as f:
    ck(f.read() == bundle(A), "A's bundle bytes should match the site's exactly")
ck(not os.path.exists(os.path.join(srv.SESSIONS_DIR, B, srv.ENDING_FILENAME)),
   "B has no ending on the site, so none on disk")
ck(os.path.exists(os.path.join(srv.SESSIONS_DIR, A, srv.ENDING_FILENAME)), "A's ending should be downloaded")
ck(not any(n.endswith(".part") for n in os.listdir(srv.SESSIONS_DIR)), "no .part folders should remain")
metas = {m["id"]: m for m in srv.list_dungeon_sessions(fresh=True)}
ma = metas[A]
ck(ma["sample"] is True and ma["sample_source"] == srv.SAMPLE_DUNGEONS_URL, f"A should be marked a sample, got {ma}")
ck(ma["favorite"] is False and ma["beaten"] is False, "a sample must arrive unstarred and unbeaten")
ck(not any(k in ma for k in ("beaten_at", "last_played", "unlisted")),
   f"showcase/owner fields should be dropped, got {sorted(ma)}")
ck(ma["sort_number"] == 1 and metas[B]["sort_number"] == 2 and metas[C]["sort_number"] == 3,
   "the showcase's numbering should come along, so Default sorts the samples like the gallery")
ck(ma["pictures"]["enemy"]["saved"] is False, "no picture file travels with a sample")
ck(ma["size"] == len(bundle(A)), "size should be the bundle actually on disk")
ck(metas[A]["has_ending_video"] and not metas[B]["has_ending_video"], "the ending flag follows the files")

# ---- the catalog: what Get ALL would still fetch (D only - HIDDEN is unlisted, BAD is no id) ----
cat = srv.sample_catalog()
ck(cat["ok"] and cat["listed"] == 4 and cat["starter_missing"] == 0 and cat["missing"] == 1,
   f"the catalog should see A-D listed and only D missing, got {cat}")
ck(cat["missing_bytes"] > len(bundle(D)), f"D's estimate should cover its bundle and more, got {cat}")
ck(srv.start_sample_download_job("everything")["state"] == "failed", "an unknown set should be refused")

# ---- Get ALL: the rest of the gallery, never the unlisted one ----
resp = srv.start_sample_download_job("all")
ck(resp["which"] == "all", f"the job should say it is the whole set, got {resp}")
view = wait_until_done()
ck(view["state"] == "done" and view["saved"] == [D], f"ALL should fetch just D, got {view}")
ck(listed_ids() == {A, B, C, D}, f"History should now hold A-D and never the hidden run, got {listed_ids()}")
ck(srv.sample_catalog()["missing"] == 0, "nothing should be left to offer")
resp = srv.start_sample_download_job("all")
view = wait_until_done()
ck(view["state"] == "done" and view["saved"] == [], f"a second ALL should fetch nothing, got {view}")
shutil.rmtree(os.path.join(srv.SESSIONS_DIR, D))

# ---- again with all three already here: done at once, nothing re-downloaded ----
resp = srv.start_sample_download_job()
view = wait_until_done()
ck(view["state"] == "done" and view["saved"] == [], f"nothing new should be fetched, got {view}")

# ---- one deleted: only it comes back ----
shutil.rmtree(os.path.join(srv.SESSIONS_DIR, B))
srv.start_sample_download_job()
view = wait_until_done()
ck(view["state"] == "done" and view["saved"] == [B], f"only B should be fetched again, got {view}")

# ---- cancel mid-transfer: the run in flight is thrown away, not half-listed ----
for sid in (A, B, C):
    shutil.rmtree(os.path.join(srv.SESSIONS_DIR, sid))
FakeSite.throttle_sleep = 0.01
srv.start_sample_download_job()
deadline = time.time() + 5
while srv.sample_download_job_view()["bytes_done"] == 0 and time.time() < deadline:
    time.sleep(0.005)
ck(srv.cancel_sample_download_job(), "cancel should report there was something to stop")
view = wait_until_done()
ck(view["state"] == "cancelled", f"the job should settle to cancelled, got {view}")
time.sleep(0.1)
ck(listed_ids() == set(view["saved"]), f"only finished runs may list after a cancel, got {listed_ids()}")
ck(not any(n.endswith(".part") for n in os.listdir(srv.SESSIONS_DIR)), "a cancel should remove its .part folder")
ck(srv.cancel_sample_download_job() is False, "nothing left to cancel")
FakeSite.throttle_sleep = 0.0

# ---- a bundle that is not one (an error page served with a 200) fails, and lists nothing ----
for n in os.listdir(srv.SESSIONS_DIR):
    shutil.rmtree(os.path.join(srv.SESSIONS_DIR, n))
FakeSite.files[f"dungeons/{A}/bundle.json"] = b"<html>oops</html>"
srv.start_sample_download_job()
view = wait_until_done()
ck(view["state"] == "failed" and view["error"], f"a broken bundle should fail the job, got {view}")
ck(A not in listed_ids(), "the broken run must not list")
FakeSite.files = site_files()

# ---- the site is down: a clear failure ----
real_url = srv.SAMPLE_DUNGEONS_URL
srv.SAMPLE_DUNGEONS_URL = "http://127.0.0.1:1/"
srv.start_sample_download_job()
view = wait_until_done()
ck(view["state"] == "failed" and "sample dungeons" in (view["error"] or ""), f"no site should fail, got {view}")
srv.SAMPLE_DUNGEONS_URL = real_url

# ---- the three HTTP routes, end to end ----
for n in os.listdir(srv.SESSIONS_DIR):
    shutil.rmtree(os.path.join(srv.SESSIONS_DIR, n))
httpd = srv.socketserver.TCPServer(("127.0.0.1", 0), srv.DungeonHTTPRequestHandler)
httpd.RequestHandlerClass.log_message = lambda *a, **k: None
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
try:
    def post(path):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="POST", data=b"")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    code, body = post("/api/sample_download_start")
    ck(code == 200 and body["state"] in ("queued", "downloading", "done"), f"POST start should succeed, got {code} {body}")
    job, deadline = None, time.time() + 10
    while time.time() < deadline:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/sample_download_job", timeout=10) as resp:
            job = json.loads(resp.read().decode("utf-8"))
        if job["state"] not in ("queued", "downloading"):
            break
        time.sleep(0.02)
    ck(job and job["state"] == "done" and job["saved"] == [A, B, C], f"GET job should reach done, got {job}")
    code, body = post("/api/sample_download_cancel")
    ck(code == 200 and body.get("success") and body.get("stopped") is False,
       f"cancelling a finished download should report nothing stopped, got {code} {body}")
finally:
    httpd.shutdown()
    httpd.server_close()

site.shutdown()
site.server_close()

print("FAIL" if fails else "all sample-dungeon checks passed")
sys.exit(1 if fails else 0)
