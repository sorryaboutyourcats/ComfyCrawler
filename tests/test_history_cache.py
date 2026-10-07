"""The History listing's row cache. Building the listing from disk costs three filesystem
round trips per saved run, which on a mapped network drive is seconds - so list_dungeon_sessions
keeps the rows and every write in server.py drops the one it changed. This checks the cache
cannot hand back something the folder no longer says.

No ComfyUI and no bundles worth the name: dungeon_sessions is pointed at a temp folder and the
"runs" in it are the two files the listing actually reads."""
import atexit, importlib.util, json, os, shutil, sys, tempfile, time

spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

TMP = tempfile.mkdtemp(prefix="history_cache_")
atexit.register(shutil.rmtree, TMP, True)
bad = 0


def fail(msg):
    global bad
    print(f"  FAIL: {msg}")
    bad += 1


def plant(session_id, **meta):
    """A folder the listing will accept: a bundle to prove the run finished, and a meta.json."""
    folder = os.path.join(TMP, session_id)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "bundle.json"), "w") as f:
        f.write("{}")
    record = {"id": session_id, "created": meta.pop("created", 1000.0), "wall_style": "stone"}
    record.update(meta)
    with open(os.path.join(folder, "meta.json"), "w") as f:
        json.dump(record, f)
    return folder


def rows():
    return {m["id"]: m for m in srv.list_dungeon_sessions()}


A, B, C = "20260101-000001-aaaaaa", "20260102-000002-bbbbbb", "20260103-000003-cccccc"

real_sessions = srv.SESSIONS_DIR
try:
    srv.SESSIONS_DIR = TMP
    srv.forget_session_rows()

    # --- what a row says -------------------------------------------------------------------
    plant(A, created=100.0)
    plant(B, created=200.0)
    listed = rows()
    if set(listed) != {A, B}:
        fail(f"a first listing did not find both runs: {sorted(listed)}")
    if [m["id"] for m in srv.list_dungeon_sessions()] != [B, A]:
        fail("the listing is not newest first")
    if listed[A]["frame_version"] != srv.FRAME_VERSION_BASE:
        fail("a run saved before Last Attack Frame does not read as frame version 1")
    if listed[A]["beaten"] is not False or listed[A]["has_ending_video"] is not False:
        fail("a plain run should list as not beaten and with no cutscene")

    # A folder with no bundle.json is a half-finished save, not a run.
    os.makedirs(os.path.join(TMP, C), exist_ok=True)
    with open(os.path.join(TMP, C, "meta.json"), "w") as f:
        json.dump({"id": C, "created": 300.0}, f)
    if C in rows():
        fail("a folder with no bundle.json listed as a saved run")

    # --- the cache is not allowed to outlive a write ------------------------------------------
    if srv.set_dungeon_session_favorite(A, True) is not True:
        fail("starring a run did not report it")
    if not rows()[A].get("favorite"):
        fail("the listing still says a just-starred run is not a favorite")
    if srv.mark_dungeon_session_beaten(A) is not True:
        fail("marking a run beaten did not report it")
    if not rows()[A].get("beaten"):
        fail("the listing still says a just-beaten run has not been beaten")
    if not srv.mark_dungeon_session_played(A):
        fail("stamping a run as played did not report it")
    if not rows()[A].get("last_played"):
        fail("the listing has no last_played for a run that was just played")
    if rows()[A].get("favorite") is not True or rows()[A].get("beaten") is not True:
        fail("a later write dropped an earlier flag from the listing")

    # The hidden numbering view's sort number: typed text in, a whole number (or nothing) out.
    if srv.set_dungeon_session_sort_number(A, "7") != (True, 7) or rows()[A].get("sort_number") != 7:
        fail("a typed sort number was not saved and listed as a whole number")
    if srv.set_dungeon_session_sort_number(A, "") != (True, None) or rows()[A].get("sort_number") is not None:
        fail("a blanked sort number still lists against its run")
    for junk in ("abc", -1, True, "1.5"):
        try:
            srv.set_dungeon_session_sort_number(A, junk)
            fail(f"sort number {junk!r} was accepted")
        except ValueError:
            pass
    if srv.set_dungeon_session_sort_number("20260101-000009-zzzzzz", 3) is not None:
        fail("numbering a run that is not there did not say so")
    if rows()[A].get("favorite") is not True:
        fail("saving a sort number dropped the star")

    # Run Options (History's ⚙ button): which of the hero and the three foes are mirrored. Stored
    # sparse in meta.json, so the listing - and the showcase export, which is the listing - has it.
    saved = srv.set_dungeon_session_options(A, {"mirror": {"player": True, "boss": True, "flyer": False}})
    if saved != {"mirror": {"player": True, "boss": True}} or rows()[A].get("run_options") != saved:
        fail(f"run options were not saved and listed sparse: {saved} / {rows()[A].get('run_options')}")
    if srv.set_dungeon_session_options(A, {"mirror": {"player": False}}) != {} or rows()[A].get("run_options") != {}:
        fail("switching every mirror off should leave no options against the run")
    for junk in ("yes", {"mirror": "all"}, {"mirror": {"wizard": True}}):
        try:
            srv.set_dungeon_session_options(A, junk)
            fail(f"run options {junk!r} were accepted")
        except ValueError:
            pass
    if srv.clean_run_options({"mirror": {"walker": 1, "player": "true"}}) != {}:
        fail("only a real true switches a mirror on")
    if tuple(srv.RUN_MIRROR_SLOTS) != ("player", "walker", "flyer", "boss"):
        fail(f"the mirror slots changed - game.js RUN_MIRROR_SLOTS has to match: {srv.RUN_MIRROR_SLOTS}")
    # ...and the page has to name the same four: a box in the Run Options window for each, and the
    # list game.js reads a run's saved options through.
    import re
    with open(os.path.join(srv.WEB_DIR, "game.js"), encoding="utf-8") as f:
        page = f.read()
    with open(os.path.join(srv.WEB_DIR, "index.html"), encoding="utf-8") as f:
        html = f.read()
    listed = re.search(r"const RUN_MIRROR_SLOTS = \[([^\]]*)\]", page)
    if not listed or tuple(re.findall(r"'(\w+)'", listed.group(1))) != tuple(srv.RUN_MIRROR_SLOTS):
        fail("game.js RUN_MIRROR_SLOTS does not match server.py's")
    for slot in srv.RUN_MIRROR_SLOTS:
        if f'data-mirror="{slot}"' not in html:
            fail(f"the Run Options window has no box for {slot}")
    if "applyRunOptions(entry.run_options)" not in page or "/api/history_options" not in page:
        fail("a replayed run no longer takes its saved Run Options, or the window cannot save them")
    if srv.set_dungeon_session_options("20260101-000009-zzzzzz", {}) is not None:
        fail("saving options for a run that is not there did not say so")
    if rows()[A].get("favorite") is not True:
        fail("saving run options dropped the star")

    # A clip landing beside the bundle shows up even though meta.json was not rewritten for it.
    with open(os.path.join(TMP, B, srv.ENDING_FILENAME), "wb") as f:
        f.write(b"not really an mp4")
    srv.forget_session_rows(B)          # what _store_session_ending's own meta write does
    if not rows()[B].get("has_ending_video"):
        fail("a stored cutscene does not list against its run")

    # --- folders appearing and vanishing behind the server -------------------------------------
    plant(C, created=300.0)             # C now has its bundle too
    if C not in rows():
        fail("a run that appeared on disk was never picked up")
    shutil.rmtree(os.path.join(TMP, B))
    if B in rows():
        fail("a run deleted from disk is still listed")

    srv.set_dungeon_session_favorite(A, False)
    if not srv.delete_dungeon_session(A):
        fail("deleting a run did not report it")
    if A in rows():
        fail("a deleted run is still listed")

    # --- fresh=True is the way back to disk ----------------------------------------------------
    # The one change nothing in server.py can announce: a meta.json edited from outside.
    folder = os.path.join(TMP, C)
    time.sleep(0.01)                    # so the rewrite lands on a different mtime
    with open(os.path.join(folder, "meta.json"), "w") as f:
        json.dump({"id": C, "created": 300.0, "wall_style": "edited by hand"}, f)
    if srv.list_dungeon_sessions(fresh=True)[0]["wall_style"] != "edited by hand":
        fail("a fresh listing did not re-read a meta.json changed from outside")

    # --- the rows handed out are the caller's, not the cache's ---------------------------------
    srv.list_dungeon_sessions()[0]["wall_style"] = "scribbled on"
    if rows()[C]["wall_style"] != "edited by hand":
        fail("editing a returned row wrote into the cache")

    # --- a listing from another SESSIONS_DIR never leaks into this one --------------------------
    other = tempfile.mkdtemp(prefix="history_cache_other_")
    atexit.register(shutil.rmtree, other, True)
    srv.SESSIONS_DIR = other
    if srv.list_dungeon_sessions():
        fail("an empty sessions folder listed the previous folder's runs")
    srv.SESSIONS_DIR = TMP
    if set(rows()) != {C}:
        fail("pointing SESSIONS_DIR back lost the runs that are in it")
finally:
    srv.SESSIONS_DIR = real_sessions
    srv.forget_session_rows()

print("FAIL" if bad else "all history-cache checks passed")
sys.exit(1 if bad else 0)
