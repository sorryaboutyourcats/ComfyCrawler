"""Ending cutscene (Options > Ending Video): the H3 prompt names every reference by the tag ref2va
will actually give it, the graph wires those references into the right Autogrow slots, the run's
art is prepared the way LoadImage needs it, the loading-screen mode plans a stage for it, a clip
is kept beside its saved run, and the background render starts, reports, stores and gives way the
way game.js expects.

No ComfyUI - render_ending_video and the socket are stubbed, ComfyUI's input folder and
dungeon_sessions are pointed at temp folders, so this measures the plumbing, not the model."""
import atexit, base64, importlib.util, io, json, os, shutil, sys, tempfile, threading, time, wave
from PIL import Image

spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)

TMP = tempfile.mkdtemp(prefix="ending_video_")
atexit.register(shutil.rmtree, TMP, True)
bad = 0


def fail(msg):
    global bad
    print(f"  {msg}")
    bad += 1


def png_url(color=(255, 0, 0, 255), size=(8, 8)):
    buf = io.BytesIO()
    Image.new("RGBA", size, color).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def wav_url(seconds, rate=32000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(rate)
        wf.writeframes(b"\x01\x00" * int(seconds * rate))
    return "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


STYLES = {"wall": "mossy stone", "player": "cat knight", "weapon": "axe", "enemy": "dragon"}

# --- the prompt -----------------------------------------------------------------------------
all_six = ["hero", "face", "boss", "wall", "floor", "ceiling"]
p = srv.ending_video_prompt(all_six, STYLES, True)
for i, kind in enumerate(all_six):
    if f"<Picture {i + 1}>" not in p:
        fail(f"the prompt never names {kind} as <Picture {i + 1}>")
if "<Picture 7>" in p:
    fail("the prompt names a seventh picture that was never attached")
if "<Audio 1>" not in p:
    fail("the battle music is attached but the prompt never says what <Audio 1> is")
for word in ("cat knight", "axe", "dragon", "staircase", "cheers"):
    if word not in p:
        fail(f"the prompt lost '{word}'")
# No portrait and no ceiling: every later tag moves up, and nothing refers to a missing one.
p2 = srv.ending_video_prompt(["hero", "boss", "wall", "floor"], STYLES, False)
if "<Picture 2> is the boss" not in p2 or "<Picture 4> is its floor" not in p2:
    fail(f"tags were not renumbered for the references actually attached:\n{p2}")
if "<Picture 5>" in p2 or "<Audio 1>" in p2 or "hero's face" in p2:
    fail("a prompt with no portrait / no music still refers to them")
p3 = srv.ending_video_prompt([], {}, False)
if "armored warrior" not in p3 or "huge monster" not in p3:
    fail("empty typed styles did not fall back to neutral nouns")

# --- the graph ------------------------------------------------------------------------------
g = srv.ending_video_payload(["a.png", "b.png", "c.png"], "m.wav", "PROMPT", 640, 480, 42, sage=True)
cond = g["ending_cond"]["inputs"]
for i, name in enumerate(["a.png", "b.png", "c.png"]):
    if cond.get(f"ref_images.ref_image_{i}") != [f"ending_ref{i}", 0] or g[f"ending_ref{i}"]["inputs"]["image"] != name:
        fail(f"reference {i} is not wired into ref_images.ref_image_{i}")
if cond.get("ref_audios.ref_audio_0") != ["ending_music", 0]:
    fail("the battle music is not wired into ref_audios.ref_audio_0")
if (cond["length"] - 5) % 17 != 0:
    fail(f"ENDING_FRAMES {cond['length']} is off H3's 17k+5 frame grid")
if g["ending_guider"]["inputs"]["model"] != ["ending_sage", 0]:
    fail("sage attention is available but the guider bypasses it")
g2 = srv.ending_video_payload([], None, "PROMPT", 640, 480, 42, sage=False)
if "ending_sage" in g2 or "ending_music" in g2 or any(k.startswith(("ref_images.", "ref_audios."))
                                                        for k in g2["ending_cond"]["inputs"]):
    fail("a graph with no sage / no references still carries them")
if g["ending_save"]["inputs"].get("format.codec") != "auto":
    fail("SaveVideo's nested codec combo is not keyed by its dotted path")
w, h = srv.ENDING_WIDTH, srv.ENDING_HEIGHT
if (w, h) != (512, 384):
    fail(f"the ending is filmed at {w}x{h}, not the 512x384 the user settled on")
if w % 32 or h % 32 or abs(w / h - 4 / 3) > 0.01:
    fail(f"ending size {w}x{h} is not a 4:3 multiple of 32")

# --- preparing the references ---------------------------------------------------------------
real_input = srv.COMFY_INPUT_DIR
srv.COMFY_INPUT_DIR = TMP
try:
    name = srv._ending_ref_image(png_url((0, 0, 0, 0)), "clear.png")
    px = Image.open(os.path.join(TMP, name)).getpixel((0, 0))
    if Image.open(os.path.join(TMP, name)).mode != "RGB" or px != (255, 255, 255):
        fail(f"a transparent sprite was not flattened onto white (got {px})")
    if srv._ending_ref_image(None, "none.png") is not None:
        fail("a missing reference still wrote a file")
    aname = srv._ending_ref_audio(wav_url(30), "bed.wav")
    with wave.open(os.path.join(TMP, aname), "rb") as wf:
        secs = wf.getnframes() / wf.getframerate()
    if abs(secs - srv.ENDING_REF_AUDIO_SEC) > 0.01:
        fail(f"the 30s battle bed was cut to {secs:.2f}s, not {srv.ENDING_REF_AUDIO_SEC}s")
finally:
    srv.COMFY_INPUT_DIR = real_input

sprite, face = png_url((1, 2, 3, 255)), png_url((4, 5, 6, 255))
refs = srv._ending_refs_from_bundle({"player_sprites": [sprite], "player_faces": [sprite],
                                     "enemy_variants": {"walker": "data:image/png;base64,WALK"}})
if refs["face"] is not None:
    fail("a run whose portraits failed sent the hero's back in as the face")
if refs["boss"] != "data:image/png;base64,WALK":
    fail("a bundle with no boss (and a bare-string walker) did not fall back to the walker")
refs = srv._ending_refs_from_bundle({"player_sprites": [sprite], "player_faces": [face],
                                     "enemy_variants": {"boss": {"idle": "B", "attack": "A"}},
                                     "wall_texture": "W"})
if (refs["face"], refs["boss"], refs["wall"], refs["floor"]) != (face, "B", "W", None):
    fail(f"references read from a bundle came out wrong: {refs}")

# --- the progress plan ----------------------------------------------------------------------
keys = lambda mode: [(k, w) for k, _l, w, _u in srv._plan_v6(8, "skip", False, mode)]
if any(k == "ending_video" for k, _ in keys("off")) or any(k == "ending_video" for k, _ in keys("background")):
    fail("the plan has an ending stage for a run that does not film one on the loading screen")
stage = [w for k, w in keys("loading") if k == "ending_video"]
if stage != [srv.ENDING_PLAN_WEIGHT]:
    fail(f"the loading-screen ending stage is missing or mis-weighted: {stage}")
if keys("loading")[-1][0] != "ending_video":
    fail("the ending is not the last stage - it needs the battle bed the music stage makes")

# --- History and the background render ------------------------------------------------------
real_sessions, real_render, real_interrupt = srv.SESSIONS_DIR, srv.render_ending_video, srv._interrupt_prompt
real_gen = dict(srv.gen_progress)
interrupted = []
try:
    srv.SESSIONS_DIR = TMP
    srv._interrupt_prompt = lambda pid, deadline=30.0: interrupted.append(pid)
    clip = os.path.join(TMP, "rendered.mp4")
    with open(clip, "wb") as f:
        f.write(b"fake mp4 bytes")
    bundle = {"mode": "v6_krea", "story": {}, "graphics_quality": "optimized",
              "player_sprites": [sprite], "player_faces": [face],
              "enemy_variants": {"boss": {"idle": sprite}}, "music": {"battle": wav_url(1)},
              "named_styles": {"clean": STYLES}}

    with_clip = srv.save_dungeon_session(bundle, "w", "p", "x", "e", ending_video_path=clip)
    without = srv.save_dungeon_session(bundle, "mossy stone", "cat knight", "axe", "dragon")
    listed = {m["id"]: m for m in srv.list_dungeon_sessions()}
    if not listed[with_clip].get("has_ending_video") or listed[without].get("has_ending_video"):
        fail("History does not list which runs have an ending cutscene")
    if srv.ending_video_status(with_clip)["state"] != "ready":
        fail("a run saved with its clip does not report ready")
    if srv.ending_video_status(without)["state"] != "none":
        fail("a run with no clip and no render does not report none")
    if srv.ending_video_status("20990101-000000-zzzzzz")["state"] != "missing":
        fail("an unknown run does not report missing")
    if srv.ending_video_status("../../etc")["state"] != "missing":
        fail("a path-shaped id got past _session_dir")

    # Refused while a dungeon owns ComfyUI - except from the run itself, at its very end.
    srv.gen_progress["is_generating"] = True
    if srv.start_ending_video_job(without)["state"] != "busy":
        fail("a background render started on top of a dungeon generation")
    srv.gen_progress["is_generating"] = False

    # A render that takes its time, so the job can be watched and replaced mid-flight.
    release = threading.Event()
    calls = []

    def slow_render(refs, battle_music, styles, job_key=None, job=None, seed=None):
        calls.append({"refs": refs, "music": bool(battle_music), "styles": styles})
        job["prompt_id"] = f"prompt-{len(calls)}"
        # Cancellation is looked at before release, the way _ending_submit_and_wait checks its flag
        # before it reads history - otherwise a release that lands a hair after a cancel races it.
        while True:
            if job.get("cancelled"):
                raise srv.EndingVideoCancelled("test")
            if release.is_set():
                return clip
            time.sleep(0.02)

    srv.render_ending_video = slow_render
    first = srv.start_ending_video_job(without)
    time.sleep(0.2)
    if first["state"] not in ("queued", "rendering"):
        fail(f"starting a background render reported {first}")
    if srv.start_ending_video_job(without)["state"] not in ("queued", "rendering") or len(calls) != 1:
        fail("asking again for the run already filming started a second render")
    if not srv.ending_video_rendering():
        fail("ending_video_rendering() missed the render in flight")
    if calls and (calls[0]["styles"].get("enemy") != "dragon"
                  or not calls[0]["music"] or calls[0]["refs"]["face"] != face):
        fail(f"the background render was not handed the saved run's own art and words: {calls[0]}")

    # The socket: steps of this prompt move the job, and nothing of anyone else's does.
    srv._ENDING_JOB["percent"] = 0
    if not srv._ending_job_progress({"prompt_id": "prompt-1", "nodes": {"ending_samp": {"value": 10, "max": 20}}}):
        fail("a progress message for the background render was not claimed by it")
    if srv._ENDING_JOB["percent"] != 47:
        fail(f"10/20 steps did not read as 47%: {srv._ENDING_JOB['percent']}")
    if srv._ending_job_progress({"prompt_id": "someone-else", "nodes": {}}):
        fail("the background render claimed another prompt's progress")

    # Something else needs ComfyUI: the render gives way, and says so.
    other = srv.save_dungeon_session(bundle, "w2", "p2", "x2", "e2")
    srv.start_ending_video_job(other)
    time.sleep(0.3)
    if srv.ending_video_status(without)["state"] != "none":
        fail("a run whose render was replaced still reports it")
    if srv._ENDING_JOB["session"] != other:
        fail("the replacing render did not take over")
    if len(calls) != 2:
        fail(f"expected the replacement to start its own render, saw {len(calls)} calls")
    if "prompt-1" not in interrupted:
        fail("the replaced render's prompt was never taken back out of ComfyUI")

    # Let it finish: the clip moves in beside the run and the run lists it.
    release.set()
    for _ in range(100):
        if srv.ending_video_status(other)["state"] == "ready":
            break
        time.sleep(0.05)
    if srv.ending_video_status(other)["state"] != "ready":
        fail(f"a finished background render never reported ready: {srv.ending_video_status(other)}")
    if not os.path.exists(os.path.join(TMP, other, srv.ENDING_FILENAME)):
        fail("the finished clip was not stored beside its run")
    with open(os.path.join(TMP, other, "meta.json")) as f:
        if not json.load(f).get("has_ending_video"):
            fail("the finished render did not mark meta.json")
    if os.path.exists(os.path.join(TMP, other, srv.ENDING_FILENAME + ".tmp")):
        fail("the clip's temp copy was left behind")
    if srv.ending_video_rendering():
        fail("ending_video_rendering() still true after the render finished")

    # --- History's movie button: a render asked for by name ----------------------------------
    # It replaces a background render, and then holds: a background request answers busy, another
    # manual request answers busy, and the job view the page polls says it is manual.
    release.clear()
    third = srv.save_dungeon_session(bundle, "w3", "p3", "x3", "e3")
    srv.start_ending_video_job(without)                        # background, for the run being played
    time.sleep(0.2)
    manual = srv.start_ending_video_job(third, manual=True)
    time.sleep(0.2)
    if manual["state"] not in ("queued", "rendering") or srv._ENDING_JOB["session"] != third:
        fail(f"a History movie request did not replace a background render: {manual}")
    view = srv.ending_video_job_view()
    if not view["manual"] or view["session"] != third or view["state"] not in ("queued", "rendering"):
        fail(f"the job view does not report the manual render: {view}")
    if not srv.ending_video_manual_rendering():
        fail("ending_video_manual_rendering() missed the manual render")
    if srv.start_ending_video_job(without)["state"] != "busy":
        fail("a background request replaced a render the player asked for by name")
    if srv.start_ending_video_job(with_clip)["state"] != "ready":
        fail("a run that already has its clip was not simply reported ready during a manual render")
    if srv.start_ending_video_job(other, manual=True)["state"] != "ready":
        fail("a finished run was not reported ready")
    if srv._ENDING_JOB["session"] != third or srv._ENDING_JOB["cancelled"]:
        fail("something replaced the manual render")
    # Asking by name for the run whose background render is already going just promotes it.
    release.set()
    for _ in range(100):
        if not srv.ending_video_rendering():
            break
        time.sleep(0.05)
    release.clear()
    fourth = srv.save_dungeon_session(bundle, "w4", "p4", "x4", "e4")
    srv.start_ending_video_job(fourth)
    time.sleep(0.2)
    before_calls = len(calls)
    srv.start_ending_video_job(fourth, manual=True)
    if not srv._ENDING_JOB.get("manual") or len(calls) != before_calls:
        fail("asking by name for a run already filming in the background did not promote that render")
    release.set()
    for _ in range(100):
        if not srv.ending_video_rendering():
            break
        time.sleep(0.05)
    if srv.ending_video_job_view()["state"] != "ready":
        fail(f"a finished render's last state is not kept for a slow poll: {srv.ending_video_job_view()}")

    # --- "beaten" -----------------------------------------------------------------------------
    if listed[with_clip].get("beaten"):
        fail("a run nobody has beaten lists as beaten")
    if srv.mark_dungeon_session_beaten(with_clip) is not True:
        fail("marking a run beaten did not report it")
    listed = {m["id"]: m for m in srv.list_dungeon_sessions()}
    if not listed[with_clip].get("beaten") or not listed[with_clip].get("beaten_at"):
        fail("a beaten run does not list as beaten")
    if not listed[with_clip].get("has_ending_video"):
        fail("recording beaten wrote over has_ending_video")
    if srv.mark_dungeon_session_beaten("20990101-000000-zzzzzz") is not None:
        fail("marking a missing run beaten did not say it is gone")
    srv.set_dungeon_session_favorite(with_clip, True)
    listed = {m["id"]: m for m in srv.list_dungeon_sessions()}
    if not (listed[with_clip].get("favorite") and listed[with_clip].get("beaten")):
        fail("starring a run lost its beaten flag (or the other way round)")

    # Stopping a manual render by name (the History confirm box): the lock lifts at once, before
    # the worker has even noticed, and only that run's render is touched.
    release.clear()
    fifth = srv.save_dungeon_session(bundle, "w5", "p5", "x5", "e5")
    srv.start_ending_video_job(fifth, manual=True)
    time.sleep(0.2)
    if srv.cancel_ending_video_job("test", session_id=with_clip):
        fail("stopping a different run's render stopped this one")
    if not srv.cancel_ending_video_job("test", session_id=fifth):
        fail("stopping the manual render by its run reported nothing to stop")
    if srv.ending_video_manual_rendering() or srv.ending_video_job_view()["state"] != "cancelled":
        fail(f"a stopped manual render still holds the lock: {srv.ending_video_job_view()}")
    if srv.start_ending_video_job(without)["state"] == "busy":
        fail("a stopped manual render still turns other requests away")
    time.sleep(0.3)
    srv.cancel_ending_video_job("test")
    release.set()
    time.sleep(0.2)

    # Deleting a run that is filming stops its render.
    release.clear()
    srv.start_ending_video_job(without)
    time.sleep(0.2)
    srv.delete_dungeon_session(without)
    time.sleep(0.3)
    if srv._ENDING_JOB["state"] != "cancelled":
        fail(f"deleting a run left its render going: {srv._ENDING_JOB['state']}")
    release.set()
finally:
    srv.SESSIONS_DIR = real_sessions
    srv.render_ending_video = real_render
    srv._interrupt_prompt = real_interrupt
    srv.gen_progress.update(real_gen)

print("FAIL" if bad else "all ending-video checks passed")
sys.exit(1 if bad else 0)
