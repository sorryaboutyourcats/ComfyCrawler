"""Last Attack Frame: with the option on, every designed foe gets a "strike" frame and the run is
saved as frame version 2; with it off, nothing about the frames changes and the run is version 1.
Sessions saved before the option existed must list as version 1.

No ComfyUI - the krea2 job is only built, never submitted, the image passes are stubbed, and
dungeon_sessions is pointed at a temp folder, so this measures the plumbing, not the model."""
import atexit, importlib.util, json, shutil, sys, os, tempfile
from PIL import Image

spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

TMP = tempfile.mkdtemp(prefix="last_attack_frame_")
atexit.register(shutil.rmtree, TMP, True)
bad = 0


def fail(msg):
    global bad
    print(f"  {msg}")
    bad += 1


STRIKE = srv.ENEMY_STRIKE_FRAME
SPECIES = {v: {"name": f"{v} thing", "look": f"a {v} made of RAM sticks", "guard": "shell"}
           for v in srv.ENEMY_VARIANT_NAMES}

# --- which frames get drawn ------------------------------------------------------------
for v in srv.ENEMY_VARIANT_NAMES:
    if srv._enemy_variant_frames(v) != srv.ENEMY_VARIANT_FRAMES[v]:
        fail(f"{v}: the option off changed the frames it draws")
    on = srv._enemy_variant_frames(v, last_attack_frame=True)
    if on != srv.ENEMY_VARIANT_FRAMES[v] + [STRIKE]:
        fail(f"{v}: the option on should add exactly one strike frame on the end, got {on}")
# The helper hands out copies - appending the strike frame must never leak into the table.
srv._enemy_variant_frames("walker", True).append("junk")
if "junk" in srv.ENEMY_VARIANT_FRAMES["walker"] or STRIKE in srv.ENEMY_VARIANT_FRAMES["walker"]:
    fail("building a frame list wrote into ENEMY_VARIANT_FRAMES")
n = len(srv.ENEMY_VARIANT_NAMES)
if srv._enemy_frame_count(True) != srv._enemy_frame_count() + n:
    fail("the progress denominator does not count one strike frame per foe")

# --- the krea2 job ---------------------------------------------------------------------
def branches(species, on):
    payload = srv._krea2_loaders()
    added, seeds = srv._krea2_add_enemy_variants(payload, "RAM stick", 512, 8, "t",
                                                 species=species, last_attack_frame=on)
    return payload, added, seeds

payload, added, seeds = branches(SPECIES, True)
for v in srv.ENEMY_VARIANT_NAMES:
    key = f"enemy_{v}_{STRIKE}_pos"
    if key not in payload:
        fail(f"{v}: no strike branch in the job")
        continue
    # Same foe, same seed - otherwise the strike frame comes back as a different creature.
    if payload[f"enemy_{v}_{STRIKE}_samp"]["inputs"]["seed"] != payload[f"enemy_{v}_idle_samp"]["inputs"]["seed"]:
        fail(f"{v}: the strike frame is not on the foe's own seed")
    if STRIKE not in added[v]:
        fail(f"{v}: the strike frame is in the job but not reported for collection")
payload, added, _ = branches(SPECIES, False)
if any(STRIKE in k for k in payload) or any(STRIKE in fs for fs in added.values()):
    fail("the option off still put a strike branch in the job")
# The fallback (no species) has no attack frame to follow, so never a strike frame either.
payload, added, _ = branches(None, True)
if any(STRIKE in k for k in payload):
    fail("the Kontext fallback path was given a strike frame")

# --- the prompt ------------------------------------------------------------------------
p = srv.krea2_species_prompt(SPECIES["walker"]["look"], "RAM stick", pose=STRIKE)
if srv.ENEMY_FRAME_POSES[STRIKE] not in p:
    fail("the strike prompt does not carry the strike pose clause")
# The two rules the renders taught (see ENEMY_FRAME_POSES): the burst has to LEAD the clause or
# krea2 draws it tiny or not at all, and it has to overlap the foe or keep_largest_figure cuts it.
clause = srv.ENEMY_FRAME_POSES[STRIKE].lower()
if not (0 <= clause.find("explosion") < clause.find("lunging")):
    fail("the strike clause no longer opens with the explosion ahead of the lunge")
if "overlapping" not in clause or "orange" not in clause:
    fail("the strike burst is no longer an overlapping, saturated shape")
if "only a thin margin" not in p:
    fail("the strike frame is not at the idle's thin margin - the foe would shrink as its blow lands")
if "a comfortable even margin" not in srv.krea2_species_prompt("x", "RAM stick", tighten=2, pose=STRIKE):
    fail("a re-framed strike frame did not get the widest margin")
# cfg 1.0 - a negation in a pose clause is a request for the thing it negates.
for word in (" no ", " not ", "without", "never"):
    if word in f" {srv.ENEMY_FRAME_POSES[STRIKE].lower()} ":
        fail(f"the strike clause contains a negation ({word.strip()!r})")

# --- the quality gate ------------------------------------------------------------------
def png(name):
    path = os.path.join(TMP, name + ".png")
    Image.new("RGBA", (64, 64), (200, 30, 30, 255)).save(path)
    return path

real = {k: getattr(srv, k) for k in ("keep_largest_figure", "_enemy_frame_problem",
                                     "_krea2_regen_pose_frame", "crop_frames_to_common_bbox",
                                     "_save_tight", "generate_kontext_enemy_variants")}
try:
    srv.keep_largest_figure = lambda *a, **k: None
    srv.crop_frames_to_common_bbox = lambda *a, **k: None
    srv._save_tight = lambda *a, **k: None
    srv.generate_kontext_enemy_variants = lambda *a, **k: {}
    regen_calls = []
    srv._krea2_regen_pose_frame = lambda look, style, guard, pose, seed, *a, **k: (
        regen_calls.append((pose, seed)) or None)

    _, added, seeds = branches(SPECIES, True)
    paths = {f"enemy_{v}_{f}": png(f"{v}_{f}") for v, fs in added.items() for f in fs}

    # Everything clean: every foe keeps its strike frame.
    srv._enemy_frame_problem = lambda path, **k: None
    enemies = srv._krea2_finish_enemy_variants(paths, "RAM stick", 512, 8, "t",
                                               species=SPECIES, generated=added, seeds=seeds)
    for v in srv.ENEMY_VARIANT_NAMES:
        if STRIKE not in enemies.get(v, {}):
            fail(f"{v}: a clean strike frame did not survive finishing")

    # The boss's strike frame comes back clipped and its one re-frame fails too: that frame is
    # dropped, re-drawn on the boss's OWN seed first, and nothing else about the boss is lost.
    srv._enemy_frame_problem = lambda path, **k: ("clipped" if path.endswith(f"boss_{STRIKE}.png")
                                                  else None)
    enemies = srv._krea2_finish_enemy_variants(paths, "RAM stick", 512, 8, "t",
                                               species=SPECIES, generated=added, seeds=seeds)
    if STRIKE in enemies.get("boss", {}):
        fail("an unusable boss strike frame was shipped")
    if set(enemies.get("boss", {})) != {"idle", "attack", "block"}:
        fail(f"dropping the boss strike frame cost it other frames: {sorted(enemies.get('boss', {}))}")
    if regen_calls != [(STRIKE, seeds["boss"])]:
        fail(f"the strike frame was not re-framed once on the boss's seed: {regen_calls}")
    if STRIKE not in enemies.get("walker", {}) or STRIKE not in enemies.get("flyer", {}):
        fail("one foe's bad strike frame took the others' with it")
finally:
    for k, fn in real.items():
        setattr(srv, k, fn)

# --- the progress plan -----------------------------------------------------------------
def frames_units(on):
    return next(u for key, _l, _w, u in srv._plan_v6(8, "skip", on) if key == "frames")
if frames_units(True) - frames_units(False) != n * 8:
    fail("the planned frames job does not grow by one frame per foe at 8 steps")

# --- History ---------------------------------------------------------------------------
real_sessions = srv.SESSIONS_DIR
try:
    srv.SESSIONS_DIR = TMP

    def bundle(version, strike_on):
        variants = {v: {"idle": "data:image/png;base64,AA==", "attack": "data:image/png;base64,AA=="}
                    for v in srv.ENEMY_VARIANT_NAMES}
        for v in strike_on:
            variants[v][STRIKE] = "data:image/png;base64,AA=="
        return {"mode": "v6_krea", "story": {}, "graphics_quality": "normal",
                "frame_version": version, "enemy_variants": variants}

    id2 = srv.save_dungeon_session(bundle(2, ["walker", "flyer"]), "RAM", "cat", "sword", "RAM stick")
    id1 = srv.save_dungeon_session(bundle(1, []), "RAM", "cat", "sword", "RAM stick")
    # A session saved before the option existed: no frame_version, no strike_frames, anywhere.
    legacy = "20260101-000000-abcdef"
    os.makedirs(os.path.join(TMP, legacy))
    with open(os.path.join(TMP, legacy, "bundle.json"), "w") as f:
        json.dump({"mode": "v6_krea"}, f)
    with open(os.path.join(TMP, legacy, "meta.json"), "w") as f:
        json.dump({"id": legacy, "created": 1, "wall_style": "old"}, f)

    listed = {m["id"]: m for m in srv.list_dungeon_sessions()}
    if listed.get(id2, {}).get("frame_version") != 2:
        fail(f"a run made with the option on did not list as frame version 2: {listed.get(id2)}")
    if listed.get(id2, {}).get("strike_frames") != ["walker", "flyer"]:
        fail(f"strike_frames did not record which foes really have one: {listed.get(id2, {}).get('strike_frames')}")
    if listed.get(id1, {}).get("frame_version") != 1:
        fail("a run made with the option off did not list as frame version 1")
    if listed.get(legacy, {}).get("frame_version") != 1:
        fail("a session saved before the option existed did not list as frame version 1")
    with open(os.path.join(TMP, legacy, "meta.json")) as f:
        if "frame_version" in json.load(f):
            fail("listing History rewrote an old session's meta.json")
finally:
    srv.SESSIONS_DIR = real_sessions

print("FAIL" if bad else "all last-attack-frame checks passed")
sys.exit(1 if bad else 0)
