"""The custom node's aiohttp routes (comfy_node.make_routes) on a real aiohttp server, without ComfyUI:
the /comfycrawler redirect, requests forwarded into server.py, POST bodies, the two big files served
straight off disk, one-at-a-time handling that never blocks the event loop, and no CORS headers.
Needs aiohttp, which ComfyUI's Python has and the standalone Python doesn't - so run it with
ComfyUI's python.exe. Anywhere without aiohttp it prints "skipped" and passes."""
import asyncio, atexit, importlib.util, json, os, shutil, sys, tempfile, threading, time

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:
    print("skipped (no aiohttp - run with ComfyUI's python.exe)")
    sys.exit(0)
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)
spec = importlib.util.spec_from_file_location("comfy_node", os.path.join(ROOT, "comfy_node.py"))
cn = importlib.util.module_from_spec(spec); spec.loader.exec_module(cn)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

TMP = tempfile.mkdtemp(prefix="cc_routes_")
atexit.register(shutil.rmtree, TMP, ignore_errors=True)
srv.SESSIONS_DIR = os.path.join(TMP, "sessions")
SID = "20260101-120000-abcdef"
FOLDER = os.path.join(srv.SESSIONS_DIR, SID)
os.makedirs(FOLDER)
BUNDLE = {"mode": "v6_krea", "wall_style": "fixture", "pad": "x" * 200000}
with open(os.path.join(FOLDER, "bundle.json"), "w", encoding="utf-8") as f:
    json.dump(BUNDLE, f)
with open(os.path.join(FOLDER, "meta.json"), "w", encoding="utf-8") as f:
    json.dump({"created": 1, "wall_style": "fixture"}, f)
CLIP = bytes(range(256)) * 400
with open(os.path.join(FOLDER, srv.ENDING_FILENAME), "wb") as f:
    f.write(CLIP)


async def main():
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ComfyCrawler")
    app = web.Application()
    app.add_routes(cn.make_routes(web, srv, executor))
    async with TestClient(TestServer(app)) as client:
        r = await client.get("/comfycrawler", allow_redirects=False)
        ck(r.status == 302 and r.headers.get("Location") == "/comfycrawler/", "the bare prefix redirects to prefix/")

        r = await client.get("/comfycrawler/")
        ck(r.status == 200 and "<title>" in await r.text(), "GET /comfycrawler/ serves the page")
        r = await client.get("/comfycrawler/tailwind.css")
        ck(r.status == 200 and r.content_type == "text/css", "relative assets resolve under the prefix")

        r = await client.get("/comfycrawler/api/progress")
        ck(r.status == 200 and "is_generating" in await r.json(), "JSON comes back through the handler")
        ck(not any(k.lower().startswith("access-control-") for k in r.headers), "no CORS headers")

        r = await client.post("/comfycrawler/api/history_beaten", data=json.dumps({"id": SID}),
                              headers={"Content-Type": "application/json"})
        with open(os.path.join(FOLDER, "meta.json"), encoding="utf-8") as f:
            ck(r.status == 200 and json.load(f).get("beaten") is True, "a POST body reaches the handler")

        r = await client.get(f"/comfycrawler/api/history_bundle?id={SID}")
        ck(r.status == 200 and (await r.json())["wall_style"] == "fixture", "the bundle is served from disk")
        ck(r.headers.get("Cache-Control") == "no-store", "the bundle isn't cached")
        r = await client.get(f"/comfycrawler/api/ending_video?id={SID}")
        ck(r.status == 200 and r.content_type == "video/mp4" and await r.read() == CLIP, "the clip is served from disk, byte for byte")
        r = await client.get("/comfycrawler/api/history_bundle?id=nope")
        ck(r.status == 404, "an unknown bundle falls through to the handler's 404")

        # One at a time, and never on the event loop: three slow requests run back to back while a
        # route that doesn't touch the worker still answers at once.
        active, peak, lock = [0], [0], threading.Lock()
        real = srv.list_dungeon_sessions
        def slow_listing():
            with lock:
                active[0] += 1; peak[0] = max(peak[0], active[0])
            time.sleep(0.6)
            with lock:
                active[0] -= 1
            return real()
        srv.list_dungeon_sessions = slow_listing
        t0 = time.monotonic()
        slow = [asyncio.create_task(client.get("/comfycrawler/api/history")) for _ in range(3)]
        await asyncio.sleep(0.1)
        t_fast = time.monotonic()
        r = await client.get("/comfycrawler", allow_redirects=False)
        fast = time.monotonic() - t_fast
        results = await asyncio.gather(*slow)
        took = time.monotonic() - t0
        srv.list_dungeon_sessions = real
        ck(all(x.status == 200 for x in results), "the queued requests all succeed")
        ck(peak[0] == 1, f"requests must run one at a time (peak {peak[0]})")
        ck(took >= 1.7, f"three 0.6s requests should take ~1.8s back to back, took {took:.2f}s")
        ck(fast < 0.3, f"the event loop stayed free while the worker was busy ({fast:.2f}s)")
    executor.shutdown(wait=True)


asyncio.run(main())
print("FAIL" if fails else "all node-route checks passed")
sys.exit(1 if fails else 0)
