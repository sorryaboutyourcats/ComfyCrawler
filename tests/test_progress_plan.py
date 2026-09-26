"""The loading bar: _plan_v6's per-job seconds and ProgressTracker's handling of jobs that turn
out bigger, smaller or not needed at all. Offline - no ComfyUI; ProgressTracker is fed the same
progress_state messages ComfyUI's socket sends.

What must hold: the bar follows the clock on real measured runs (the user reported an
all-pictured run sitting at 40-50% and then jumping to 100 - the old weights put it 22 points
behind the clock); a planned retry that is not needed moves the bar when that is known, not at
the end; and with a picture attached every pictured stage says which Attachments setting is
drawing it."""
import importlib.util, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

EVERY = ("wall", "player", "weapon", "enemy")


def replay(plan, observed):
    """Run `observed` - [(job key, seconds)] in the order they ran, None for time spent outside
    any job, "skip:<key>" for a planned job the run found it did not need, and ("add", key,
    seconds) for one the run registered as it went - through a ProgressTracker, twenty socket
    updates per job. Returns the worst (bar % - elapsed %) seen and the bar at the end of the
    last job."""
    tr = srv.ProgressTracker()
    tr.begin_plan(plan)
    units = {k: u for k, _l, _w, u in plan}
    total = sum(o[1] for o in observed if len(o) == 2 and not (o[0] or "").startswith("skip:"))
    t, worst = 0.0, 0.0
    for o in observed:
        if len(o) == 3:
            tr.add_job(o[1], o[1], o[2], 20)
            units[o[1]] = 20
            continue
        key, secs = o
        if key and key.startswith("skip:"):
            tr.skip_job(key[5:])
            continue
        if key:
            tr.begin_job(key)
        for i in range(1, 21):
            t += secs / 20.0
            if key:
                u = units.get(key, 1.0)
                tr._on_message(json.dumps({"type": "progress_state", "data": {"prompt_id": "p", "nodes": {
                    "x_samp": {"value": u * i / 20.0, "max": u, "state": "running"}}}}))
            gap = srv.gen_progress["percent"] - 100.0 * t / total
            worst = gap if abs(gap) > abs(worst) else worst
        if key:
            tr.finish_job(key)
    return worst, srv.gen_progress["percent"]


# ---- the bar follows the clock on real runs ---------------------------------------------------
# Seconds per job from ComfyUI's log ("got prompt" to "Prompt executed in"), gaps included.
# The user's run of 2026-09-24 21:28, all four lines pictured, "Use the picture itself", music and
# sound: Kontext ran at 1.31 s/step that night - the hero's eight pose edits alone took 212s. The
# walls came back as the photo and fell back to schnell; the enemy's attack and block were re-rolled.
USER_RUN = [("picture_wall", 8.4), ("picture_player", 3.3), ("picture_weapon", 2.9), ("picture_enemy", 3.2),
            ("theme_brief", 12.9), ("names", 5.8), ("story", 8.6), (None, 5.2), ("wall_ref", 55.9),
            ("surfaces", 25.9), ("hero_ref", 35.5), ("skip:hero_turn", 0), ("hero_poses", 212.3),
            ("enemy_ref", 28.9), ("enemy_poses", 55.9),
            ("add", "enemy_pose_regen", 40), ("enemy_pose_regen", 45.7), ("enemy_flight", 14.6), ("enemy_variants", 52.4),
            ("portrait_idle", 11.5), ("portrait_edits", 26.4), ("sfx", 17.4), ("music", 9.3), (None, 0.6)]
# The same pictures at 21:10 the same night with sound off, Kontext at 0.85 s/step (142s of edits).
FAST_RUN = [("picture_wall", 9.6), ("picture_player", 3.3), ("picture_weapon", 3.0), ("picture_enemy", 2.3),
            ("theme_brief", 15.8), ("names", 5.2), ("story", 11.2), (None, 5.0), ("wall_ref", 58.8),
            ("surfaces", 25.4), ("hero_ref", 35.1), ("skip:hero_turn", 0), ("hero_poses", 142.2),
            ("enemy_ref", 16.7), ("enemy_poses", 33.2),
            ("add", "enemy_pose_regen", 40), ("enemy_pose_regen", 32.9), ("enemy_flight", 15.0), ("enemy_variants", 47.3),
            ("portrait_idle", 13.7), ("portrait_edits", 25.8), (None, 7.0)]

# The first timed run with the turn-around step (2026-09-24 22:21, the same pictures and settings
# as USER_RUN, driven through the page): the drawing faced front, the first turn did not take and
# the second did, three FRONT/BACK checks outside any job; no pose was re-rolled; a Kontext boss
# edit failed its check and was redrawn by krea2 (outside any job); one portrait was re-rolled.
TURN_RUN = [(None, 0.7), ("picture_wall", 9.0), ("picture_player", 3.7), ("picture_weapon", 2.9),
            ("picture_enemy", 2.7), ("theme_brief", 13.4), ("names", 5.9), ("story", 20.8), (None, 5.5),
            ("wall_ref", 59.6), ("surfaces", 27.5), ("hero_ref", 34.9), (None, 7.6), ("hero_turn", 29.9),
            (None, 7.2), ("add", "hero_turn_retry1", 36), ("hero_turn_retry1", 29.7), (None, 7.6),
            ("hero_poses", 156.8), ("enemy_ref", 20.5), ("enemy_poses", 36.8),
            ("skip:enemy_pose_regen", 0), ("enemy_flight", 15.6), ("enemy_variants", 49.5), (None, 21.2),
            ("portrait_idle", 25.2), ("portrait_edits", 24.4), ("add", "portrait_regen", 9),
            ("portrait_regen", 7.7), ("sfx", 16.7), ("music", 8.8), (None, 3.3)]

# The three reference runs above predate the flyer's and the boss's own pose edits
# (_kontext_pose_foe), so those are spliced in after enemy_variants, where they run, at the seconds
# measured on the first run that had them (2026-09-25 15:05, costume-Elmo pictures, music and
# sound, every ProgressTracker call timestamped): 15.1s for the flyer's one, 27.3s for the boss's two.
for _run in (USER_RUN, FAST_RUN, TURN_RUN):
    _at = next(i for i, o in enumerate(_run) if o[0] == "enemy_variants") + 1
    _run[_at:_at] = [("flyer_poses", 15.1), ("boss_poses", 27.3)]
# ...and the one-word Qwen3-VL checks every pictured hero now gets, outside any job: FRONT/BACK
# after the drawing (TURN_RUN already has it) and HAND/BACK/NONE before the poses, ~8s each on
# that same run. Here the drawing already faced away and already held its weapon.
for _run in (USER_RUN, FAST_RUN):
    _at = next(i for i, o in enumerate(_run) if o[0] == "hero_ref") + 1
    _run[_at:_at] = [(None, 8.0), (None, 8.0)]
_at = next(i for i, o in enumerate(TURN_RUN) if o[0] == "hero_poses")
TURN_RUN[_at:_at] = [(None, 8.0)]

# That 15:05 run itself: the drawing faced front and one turn took; the weapon was not in a hand
# and took two hold edits (_kontext_hold_weapon) to get there; nothing was re-rolled, and Kontext
# ran fast (the enemy's two pose edits in 27s against 36-56s on the earlier runs).
HOLD_RUN = [(None, 0.3), ("picture_wall", 9.3), ("picture_player", 3.6), ("picture_weapon", 2.9),
            ("picture_enemy", 3.7), ("theme_brief", 12.8), ("names", 4.5), (None, 0.1), ("story", 9.2),
            (None, 2.8), ("wall_ref", 59.8), ("surfaces", 26.2), ("hero_ref", 35.6), (None, 8.0),
            ("hero_turn", 29.3), (None, 8.5), ("add", "hero_hold0", 44), ("hero_hold0", 35.5), (None, 7.3),
            ("add", "hero_hold1", 44), ("hero_hold1", 35.7), (None, 7.6), ("hero_poses", 168.1),
            (None, 0.2), ("enemy_ref", 14.3), (None, 1.5), ("enemy_poses", 26.9),
            ("skip:enemy_pose_regen", 0), (None, 0.4), ("enemy_flight", 14.5), ("enemy_variants", 42.5),
            (None, 0.1), ("flyer_poses", 15.1), (None, 0.1), ("boss_poses", 27.3), (None, 0.8),
            ("portrait_idle", 9.6), ("portrait_edits", 18.8), (None, 0.2), ("sfx", 15.2), (None, 0.9),
            ("music", 8.5), (None, 1.5)]

# The same four pictures a minute later on "Describe the picture in words": no Kontext until the
# portrait edits, so the one krea2 job draws all 17 frames; one portrait was re-rolled.
DESCRIBE_RUN = [(None, 0.4), ("picture_wall", 8.9), ("picture_player", 3.6), ("picture_weapon", 2.5),
                ("picture_enemy", 2.5), ("theme_brief", 13.0), ("names", 5.9), ("story", 13.6), (None, 3.1),
                ("surfaces", 31.0), ("enemy_species", 18.3), ("frames", 138.3), ("portrait_idle", 3.8),
                ("portrait_edits", 37.1), ("add", "portrait_regen", 9), ("portrait_regen", 7.8),
                ("sfx", 14.3), ("music", 8.4), (None, 2.9)]

for name, observed, sound, mode in (("user's run", USER_RUN, "music_and_sound", "reference"),
                                    ("fast run", FAST_RUN, "skip", "reference"),
                                    ("turn run", TURN_RUN, "music_and_sound", "reference"),
                                    ("hold run", HOLD_RUN, "music_and_sound", "reference"),
                                    ("describe run", DESCRIBE_RUN, "music_and_sound", "describe")):
    plan = srv._plan_v6(8, sound, False, "off", refs=EVERY if mode == "reference" else (),
                        pictured=EVERY, picture_mode=mode)
    ran = {o[0] for o in observed if len(o) == 2 and o[0] and not o[0].startswith("skip:")}
    added = {o[1] for o in observed if len(o) == 3}
    skipped = {o[0][5:] for o in observed if len(o) == 2 and o[0] and o[0].startswith("skip:")}
    planned = {k for k, *_ in plan}
    ck(planned <= ran | skipped and (ran | skipped) - planned <= added,
       f"{name}: the fixture and the plan list different jobs: {sorted((ran | skipped) ^ planned)}")
    worst, end = replay(plan, observed)
    ck(abs(worst) <= 10, f"{name}: the bar strays {worst:+.1f} points from the clock")
    ck(end == srv.ProgressTracker.CAP, f"{name}: the bar ends at {end}%, not {srv.ProgressTracker.CAP}%")

# ---- jobs that turn out different from the plan ------------------------------------------------
tr = srv.ProgressTracker()
tr.begin_plan([("a", "A", 10, 1), ("retry", "Retry", 10, 1), ("b", "B", 80, 1)])
tr.begin_job("a"); tr.finish_job("a")
ck(srv.gen_progress["percent"] == round(10 / 100 * tr.CAP), srv.gen_progress["percent"])
tr.skip_job("retry")
ck(srv.gen_progress["percent"] == round(20 / 100 * tr.CAP),
   f"a planned retry that is not needed must move the bar when that is known: {srv.gen_progress['percent']}")
tr.begin_job("b"); tr.finish_job("b")
ck(srv.gen_progress["percent"] == tr.CAP, f"skipping must not strand the bar short: {srv.gen_progress['percent']}")

tr.begin_plan([("a", "A", 50, 1), ("retry", "Retry", 10, 1), ("b", "B", 40, 1)])
tr.begin_job("a"); tr.finish_job("a")
before = srv.gen_progress["percent"]
tr.add_job("retry", "Retry x3", 30, 3)
ck(tr._weights["retry"] == 30 and tr._labels["retry"] == "Retry x3",
   "a planned job that has not started must take its real size")
ck(srv.gen_progress["percent"] == before, "resizing a job must never walk the bar back")
tr.begin_job("retry")
tr.add_job("retry", "Retry x9", 90, 9)
ck(tr._weights["retry"] == 30, "a job already running must not be resized")
tr.finish_job("retry")
tr.add_job("retry", "Retry again", 99, 9)
ck(tr._weights["retry"] == 30 and "retry" in tr._done, "a finished job must not be resized")
tr.add_job("late", "Late", 5, 1)
ck("late" in tr._weights, "a job the plan never had must still be registered")
tr.end_plan()

# ---- the detail beside the status ("slash2 - step 5/8") -----------------------------------------
def detail(job, node, value, mx):
    tr = srv.ProgressTracker()
    tr.begin_plan([(job, job, 10, 100)])
    tr.begin_job(job)
    tr._on_message(json.dumps({"type": "progress_state", "data": {"prompt_id": "p", "nodes": {
        node: {"value": value, "max": mx, "state": "running"}}}}))
    tr.end_plan()
    return srv.gen_progress["phase"]

ck(detail("theme_brief", "theme_gen", 142, 520) == "106 words so far",
   f"a text job must count words, not steps against its token cap: {detail('theme_brief', 'theme_gen', 142, 520)!r}")
ck(detail("picture_wall", "pic_gen", 1, 120) == "0 words so far", detail("picture_wall", "pic_gen", 1, 120))
ck(detail("story", "story_gen", 40, 420) == "writing - 30 words so far", detail("story", "story_gen", 40, 420))
ck(detail("surfaces", "w_samp", 1, 4) == "wall - step 1/4", detail("surfaces", "w_samp", 1, 4))
ck(detail("surfaces", "l_samp", 2, 4) == "lantern - step 2/4", detail("surfaces", "l_samp", 2, 4))
ck(detail("sfx", "step_samp", 5, 8) == "footstep - step 5/8", detail("sfx", "step_samp", 5, 8))
ck(detail("frames", "idle_samp", 3, 8) == "hero idle - step 3/8",
   f"the hero's krea2 frames must not read like the foes': {detail('frames', 'idle_samp', 3, 8)!r}")
ck(detail("frames", "enemy_walker_idle_samp", 3, 8) == "walker idle - step 3/8",
   detail("frames", "enemy_walker_idle_samp", 3, 8))
ck(detail("hero_poses", "slash1_samp", 3, 20) == "slash1 - step 3/20", detail("hero_poses", "slash1_samp", 3, 20))

# ---- the plan with pictures -------------------------------------------------------------------
for mode, refs in (("reference", EVERY), ("describe", ())):
    plan = srv._plan_v6(8, "skip", False, "off", refs=refs, pictured=EVERY, picture_mode=mode)
    keys = [k for k, *_ in plan]
    ck(keys[:4] == [f"picture_{s}" for s in srv.PICTURE_SLOTS],
       f"{mode}: every picture must be its own first stage: {keys[:5]}")
    labels = dict((k, l) for k, l, *_ in plan)
    word = "Describing your" if mode == "describe" else "Studying your"
    ck(all(labels[f"picture_{s}"].startswith(word) for s in srv.PICTURE_SLOTS),
       f"{mode}: the picture stages must say how the pictures are being read: "
       f"{[labels[f'picture_{s}'] for s in srv.PICTURE_SLOTS]}")
    drawing = [k for k in ("wall_ref", "surfaces", "hero_ref", "enemy_ref", "frames", "portrait_idle") if k in labels]
    for k in drawing:
        if k == "surfaces" and mode == "reference":
            continue   # schnell paints only the door, switch and lantern there
        says = "Kontext" if mode == "reference" else "description"
        ck(says in labels[k], f"{mode}: {k} does not say how its picture is used: {labels[k]!r}")
ck(srv._plan_v6(8, "skip")[0][0] == "theme_brief", "no pictures: the set designer must still come first")
one = dict((k, l) for k, l, *_ in srv._plan_v6(8, "skip", pictured=("enemy",), picture_mode="describe"))
ck("from your picture's description" in one["frames"] and "description" not in one["surfaces"]
   and "description" not in one["portrait_idle"],
   f"only the pictured line's stages may say description: {one['frames']!r} / {one['surfaces']!r}")
ck(all(k != "picture_player" for k in one), "a line with no picture must have no picture stage")

# The unstick pass skips its planned retry when every frame moved, and sizes it when not.
real = (srv._portrait_frame_diff, srv._kontext_ref_job)
try:
    srv.PROGRESS.begin_plan(srv._plan_v6(8, "skip", refs=EVERY, pictured=EVERY, picture_mode="reference"))
    srv._portrait_frame_diff = lambda a, b: 50.0
    srv._kontext_unstick("src", {"idle": "i", "attack": "a"}, {"attack": "x"}, "enemy_pose_regen", "L", "kx")
    ck("enemy_pose_regen" in srv.PROGRESS._done, "an unneeded planned retry must count as done at once")
    srv._portrait_frame_diff = lambda a, b: 1.0
    srv._kontext_ref_job = lambda *a, **k: {"attack": "a2", "block": "b2"}
    srv._kontext_unstick("src", {"idle": "i", "attack": "a", "block": "b"}, {"attack": "x", "block": "y"},
                         "hero_pose_regen", "L", "kxhero")
    ck(srv.PROGRESS._weights.get("hero_pose_regen") == 40,
       f"an unplanned retry must be registered at its real size: {srv.PROGRESS._weights.get('hero_pose_regen')}")
finally:
    srv._portrait_frame_diff, srv._kontext_ref_job = real
    srv.PROGRESS.end_plan()

print("FAIL" if fails else "all progress-plan checks passed")
sys.exit(1 if fails else 0)
