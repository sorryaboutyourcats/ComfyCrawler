"""
ComfyCrawler inside ComfyUI - the adapter between ComfyUI's web server and server.py.

As a custom node, ComfyCrawler is served by ComfyUI itself at /comfycrawler/ (every ComfyUI route is
also mirrored under /api/..., and ComfyUI already has its own /api/history, so the game can't sit at
the root the way the standalone server does). Rather than rewriting server.py's request handler for
aiohttp - 23 routes, shared with the standalone server - each request is handed to that same
DungeonHTTPRequestHandler in memory (forward): path, headers and body in, status, headers and body
back out. That runs on a single worker thread, so requests are still handled one at a time exactly
as the standalone server does it, and nothing blocking (urllib calls back into ComfyUI, PIL, Piper)
ever runs on ComfyUI's event loop. The two responses too big to buffer - a saved dungeon's bundle
(~17 MB) and its ending clip - are served straight off disk instead.

forward, loopback_url and choose_data_dir import nothing from aiohttp or ComfyUI, so the tests run
them on the standalone Python; make_routes and install only run inside ComfyUI.
"""

import http.client
import io
import os
import threading
import time
import traceback
import urllib.parse

PREFIX = "/comfycrawler"

# Response headers never passed on to aiohttp: it writes its own Server/Date/Content-Length/
# Connection, and CORS on ComfyUI's port is ComfyUI's call (--enable-cors-header), not ours.
_DROPPED_HEADERS = {"server", "date", "content-length", "connection", "transfer-encoding"}

_handler_classes = {}


def _handler_class(srv):
    """server.py's handler with its access log silenced - the page polls /api/progress twice a
    second, and every poll would otherwise land in ComfyUI's console."""
    cls = _handler_classes.get(id(srv))
    if cls is None:
        class _InMemoryHandler(srv.DungeonHTTPRequestHandler):
            def log_message(self, format, *args):
                pass
        cls = _handler_classes[id(srv)] = _InMemoryHandler
    return cls


def forward(srv, method, path, headers, body=b""):
    """Run one request through server.py's DungeonHTTPRequestHandler without a socket.
    `path` includes any query string; `headers` is a list of (name, value). Returns
    (status, [(name, value), ...], body_bytes). A handler that raises, or answers nothing,
    comes back as a 500 rather than taking the worker thread down."""
    handler = _handler_class(srv).__new__(_handler_class(srv))
    lines = [f"{k}: {v}" for k, v in headers if k.lower() not in ("content-length", "transfer-encoding")]
    lines.append(f"Content-Length: {len(body)}")
    raw = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1", errors="replace")
    handler.headers = http.client.parse_headers(io.BytesIO(raw))
    handler.command = method
    handler.path = path
    handler.request_version = "HTTP/1.1"
    handler.requestline = f"{method} {path} HTTP/1.1"
    handler.client_address = ("127.0.0.1", 0)
    handler.close_connection = True
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    verb = "GET" if method == "HEAD" else method
    do = getattr(handler, "do_" + verb, None)
    if do is None:
        return 405, [("Content-Type", "text/plain; charset=utf-8")], b"Method not allowed"
    try:
        do()
    except Exception:
        print(f"[ComfyCrawler] {method} {path.split('?')[0]} failed:\n{traceback.format_exc()}")
        return 500, [("Content-Type", "text/plain; charset=utf-8")], b"ComfyCrawler hit an error - see ComfyUI's log."

    out = handler.wfile.getvalue()
    head, sep, payload = out.partition(b"\r\n\r\n")
    if not sep:
        return 500, [("Content-Type", "text/plain; charset=utf-8")], b"ComfyCrawler sent no response."
    status_line, *header_lines = head.decode("latin-1").split("\r\n")
    status = int(status_line.split()[1])
    pairs = []
    for line in header_lines:
        name, _, value = line.partition(":")
        if name.strip():
            pairs.append((name.strip(), value.strip()))
    return status, pairs, (b"" if method == "HEAD" else payload)


def loopback_url(listen, port, tls=False):
    """The address ComfyCrawler uses to reach the ComfyUI it runs inside, from ComfyUI's own
    --listen (a comma list; bare --listen means "0.0.0.0,::") and --port."""
    hosts = [h.strip() for h in (listen or "127.0.0.1").split(",") if h.strip()]
    if not hosts or any(h in ("0.0.0.0", "127.0.0.1", "localhost") for h in hosts):
        host = "127.0.0.1"
    elif any(h in ("::", "::1") for h in hosts):
        host = "[::1]"
    else:
        host = f"[{hosts[0]}]" if ":" in hosts[0] else hosts[0]
    return f"{'https' if tls else 'http'}://{host}:{port}"


def choose_data_dir(repo_dir, user_dir):
    """Where saved dungeons, the page's saved settings and the recent-cast-name memory live. A dungeon_sessions folder that
    already sits beside server.py is kept - a development checkout loaded into ComfyUI keeps its
    History. Otherwise ComfyUI's user folder, which a node update or uninstall never touches."""
    if os.path.isdir(os.path.join(repo_dir, "dungeon_sessions")):
        return repo_dir
    return os.path.join(user_dir, "comfycrawler")


def _big_file(srv, tail, query):
    """(path, content type) for the two responses served straight off disk, or None."""
    session_id = query.get("id", "")
    if tail == "api/history_bundle":
        folder = srv._session_dir(session_id)
        path = os.path.join(folder, "bundle.json") if folder else None
        kind = "application/json; charset=utf-8"
    elif tail == "api/ending_video":
        path = srv._ending_session_file(session_id)
        kind = "video/mp4"
    else:
        return None
    return (path, kind) if path and os.path.isfile(path) else None


def make_routes(web, srv, executor, routes=None, prefix=PREFIX):
    """ComfyCrawler's routes on `routes` (ComfyUI's PromptServer.instance.routes, or a fresh
    RouteTableDef in the tests): the bare prefix redirects to prefix/ so the page's relative URLs
    resolve, and everything under it goes to forward on `executor`."""
    import asyncio

    routes = routes if routes is not None else web.RouteTableDef()

    @routes.get(prefix)
    async def comfycrawler_redirect(request):
        raise web.HTTPFound(prefix + "/" + (f"?{request.query_string}" if request.query_string else ""))

    # Ahead of the catch-all below, and deliberately NOT forwarded into server.py: this is the one
    # request that re-imports that module, so it can't be served by it. aiohttp matches in
    # registration order, so being first is what keeps it out of the catch-all.
    @routes.post(prefix + "/node/reload")
    async def comfycrawler_reload(request):
        result = await asyncio.get_running_loop().run_in_executor(executor, reload_server, srv)
        return web.json_response(result, status=200 if result.get("success") else 409)

    # Same reason as reload: this one answers, THEN takes the server it is running on down.
    @routes.post(prefix + "/node/restart_comfyui")
    async def comfycrawler_restart_comfyui(request):
        body = await request.json() if request.can_read_body else {}
        result = await asyncio.get_running_loop().run_in_executor(
            executor, restart_comfyui, srv, bool(body.get("confirmed")))
        return web.json_response(result, status=200 if result.get("success") else 409)

    @routes.route("*", prefix + "/{tail:.*}")
    async def comfycrawler_request(request):
        tail = request.match_info.get("tail", "")
        if request.method in ("GET", "HEAD"):
            big = _big_file(srv, tail, request.query)
            if big:
                return web.FileResponse(big[0], headers={"Content-Type": big[1], "Cache-Control": "no-store"})
        body = await request.read()
        path = "/" + tail + (f"?{request.query_string}" if request.query_string else "")
        status, pairs, payload = await asyncio.get_running_loop().run_in_executor(
            executor, forward, srv, request.method, path, list(request.headers.items()), body)
        headers = [(k, v) for k, v in pairs
                   if k.lower() not in _DROPPED_HEADERS and not k.lower().startswith("access-control-")]
        return web.Response(status=status, body=payload, headers=headers)

    return routes


def _announce(srv, url):
    """Once ComfyUI is actually listening (the node loads before it starts), say where to play
    and print the model checklist into ComfyUI's log."""
    for _ in range(120):
        try:
            srv._comfy_get_json("/system_stats", timeout=2, base=url)
            break
        except Exception:
            time.sleep(1)
    else:
        print(f"[ComfyCrawler] ComfyUI never answered at {url} - is it listening somewhere else?")
        return
    print(f"[ComfyCrawler] Play at {url}{PREFIX}/  (or ComfyUI's menu > ComfyCrawler)")
    srv.print_preflight()


def _point_at_comfyui(srv):
    """Point server.py's globals at the ComfyUI this is running inside, and return (url, tls).
    Split out of install() because reload_server has to apply it again: reloading re-runs
    server.py's module body, which resets every one of these to its standalone default."""
    import folder_paths
    from comfy.cli_args import args

    tls = bool(getattr(args, "tls_keyfile", None) and getattr(args, "tls_certfile", None))
    url = loopback_url(args.listen, args.port, tls)
    srv.COMFY_EMBEDDED = {"url": url,
                          "input_dir": folder_paths.get_input_directory,
                          "output_dir": folder_paths.get_output_directory,
                          # A model download's target directory: ComfyUI's own resolver, so it
                          # already honours the user's extra_model_paths.yaml.
                          "model_dir": lambda folder: (folder_paths.get_folder_paths(folder) or [None])[0]}
    srv.COMFY_URL = url
    data_dir = choose_data_dir(srv.PROJECT_DIR, folder_paths.get_user_directory())
    srv.SESSIONS_DIR = os.path.join(data_dir, "dungeon_sessions")
    srv.RECENT_CAST_PATH = os.path.join(data_dir, "recent_cast_names.json")
    # Beside the saved dungeons, so a checkout run both ways shares one set of Options.
    srv.PAGE_SETTINGS_PATH = os.path.join(data_dir, "page_settings.json")
    os.makedirs(srv.SESSIONS_DIR, exist_ok=True)
    return url, tls


def reload_server(srv):
    """Re-import server.py in place, so an edited checkout reaches a running ComfyUI without
    restarting it (the Reload button in ComfyCrawler's sidebar panel). Works because the route
    registered below forwards into whatever srv holds *now*: importlib.reload re-executes the
    module body into that same module object, so the closure needs no rewiring and ComfyUI's own
    route table never changes.

    Only server.py. Edits to this file or __init__.py still need a real ComfyUI restart, and so do
    edits to ProgressTracker - its socket thread is carried across rather than started twice."""
    import importlib

    busy = srv.server_busy_reason()
    if busy:
        return {"success": False, "busy": True, "error": f"Not while {busy} - wait for it to finish."}
    progress = srv.PROGRESS      # one socket thread, already running; the new module body makes a fresh one
    try:
        importlib.reload(srv)
    except Exception as e:
        print(f"[ComfyCrawler] reload failed:\n{traceback.format_exc()}")
        return {"success": False, "error": f"{type(e).__name__}: {e}"}
    # Cached against id(srv), which reload doesn't change - so without this, forwarded requests
    # would keep using a handler subclass built from the OLD routes.
    _handler_classes.clear()
    # reload() re-executes into the same module __dict__, so the carried-over tracker's globals
    # are the new ones; keeping it avoids a second websocket writing the same progress.
    srv.PROGRESS = progress
    _point_at_comfyui(srv)
    print("[ComfyCrawler] server.py reloaded")
    return {"success": True}


# ---------------------------------------------------------------------------
# RESTARTING COMFYUI
# Sleep leaves ComfyUI's process with a dead CUDA context (see server.py's _comfy_system_stats):
# it keeps answering, but nothing can render again until its server is started afresh. That is not
# ComfyCrawler's own state to fix, and the button people reach for - ComfyUI's top-bar circular
# arrow - only refreshes node definitions, so the sidebar panel offers a real restart here.
#
# ComfyUI-Manager's reboot is the one that is meant to be used and knows how this install was
# launched (Desktop included), so it is always tried first. Without it there is nothing to ask, and
# ComfyCrawler restarts the process itself the way Manager does - re-running ComfyUI's own command
# line in place. That one can leave a ComfyUI started by an unusual launcher shut rather than
# restarted, so it never happens on the first press: the panel says so and asks again.

# How ComfyUI-Manager's own Restart is pressed, newest spelling first. The current one is a POST
# that refuses form content types (its CSRF gate), which is why the request always says JSON; the
# two GETs are what older Managers still answer.
MANAGER_REBOOTS = (("POST", "/api/v2/manager/reboot"),
                   ("GET", "/api/manager/reboot"),
                   ("GET", "/manager/reboot"))


def _comfy_idle(srv):
    """Nothing queued or running in ComfyUI itself, as far as it will say. A ComfyUI too broken to
    answer counts as idle - being unable to ask is not a reason to refuse the fix."""
    try:
        return not (srv._comfy_get_json("/prompt", timeout=3).get("exec_info") or {}).get("queue_remaining")
    except Exception:
        return True


def _manager_reboot(srv):
    """Press ComfyUI-Manager's reboot, if it is installed and will do it. True when it has been
    pressed - the reply never arrives, because the process goes down mid-request, so a dropped
    connection or a timeout IS the success case. False when no Manager answers any of the spellings.
    A string when Manager is there but said no (its security level), for the panel to pass on."""
    import urllib.error
    import urllib.request

    for method, path in MANAGER_REBOOTS:
        req = urllib.request.Request(srv.COMFY_URL + path, method=method,
                                     data=b"" if method == "POST" else None,
                                     headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=5)
            return True
        except urllib.error.HTTPError as e:
            if e.code in (404, 405):
                continue            # not this spelling - try an older one
            if e.code == 403:
                return ("ComfyUI-Manager is installed but won't restart ComfyUI at this security "
                        "level. ComfyCrawler can restart the server itself instead, by re-running "
                        "ComfyUI's command line - an unusual launcher may need starting by hand "
                        "afterwards.")
            return True             # it answered as its own process was being taken down
        except Exception:
            return True             # connection dropped mid-reply: it is going down
    return False


def _exec_restart():
    """Start ComfyUI's own command line again in place of this process - what ComfyUI-Manager does
    when its Restart is pressed. Runs a moment after the reply has been written, so the panel is
    told what is about to happen before the server that would tell it stops existing."""
    import sys

    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    try:
        if sys.platform.startswith("win"):
            # Windows rebuilds one command line out of these, so anything with a space in it (every
            # ComfyUI Desktop path) has to carry its own quotes.
            os.execv(sys.executable, [f'"{sys.executable}"'] + [f'"{a}"' for a in sys.argv])
        os.execv(sys.executable, [sys.executable] + sys.argv)
    except Exception:
        print("[ComfyCrawler] couldn't restart ComfyUI - start it again by hand:")
        traceback.print_exc()


def restart_comfyui(srv, confirmed=False):
    """Restart the ComfyUI this is running inside (the sidebar's Restart ComfyUI button).
    ComfyCrawler goes down with it and comes back with it; saved dungeons are files on disk and are
    untouched. Refused while either side is part-way through something, because both would be lost:
    a restart during a run leaves half a dungeon and half a download."""
    busy = srv.server_busy_reason()
    if busy:
        return {"success": False, "busy": True, "error": f"Not while {busy} - wait for it to finish."}
    if not _comfy_idle(srv):
        return {"success": False, "busy": True,
                "error": "ComfyUI is working on something of its own - let its queue finish first."}
    pressed = _manager_reboot(srv)
    if pressed is True:
        return {"success": True, "how": "manager"}
    if not confirmed:
        return {"success": False, "needs_confirm": True,
                "error": pressed if isinstance(pressed, str) else
                         "ComfyUI-Manager isn't installed here, so ComfyCrawler would restart "
                         "ComfyUI's server itself by re-running its command line. That works for a "
                         "normally launched ComfyUI, but an unusual launcher may need starting by "
                         "hand afterwards."}
    threading.Timer(0.6, _exec_restart).start()
    return {"success": True, "how": "self"}


def install(srv, prompt_server):
    """Wire server.py into the running ComfyUI. Called once from __init__.py at node load."""
    from concurrent.futures import ThreadPoolExecutor

    from aiohttp import web

    url, tls = _point_at_comfyui(srv)

    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ComfyCrawler")
    make_routes(web, srv, executor, routes=prompt_server.routes)
    srv.PROGRESS.start()
    if tls:
        print("[ComfyCrawler] ComfyUI is running with TLS (--tls-keyfile), which ComfyCrawler can't talk "
              "to yet - dungeons can't be created.")
    print(f"[ComfyCrawler] loaded - saved dungeons in {srv.SESSIONS_DIR}")
    threading.Thread(target=_announce, args=(srv, url), daemon=True, name="ComfyCrawler-announce").start()
