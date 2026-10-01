"""The off-theme-door guard: a door whose surround came back blank must be re-rolled set
into the corridor wall, and a door that already carries the theme must be left alone.

No ComfyUI and no dungeon_sessions - the re-roll is stubbed out and the images are painted
here, so this measures the decision, not the model."""
import atexit, importlib.util, shutil, sys, os, tempfile
from PIL import Image

spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

TMP = tempfile.mkdtemp(prefix="door_guard_")
atexit.register(shutil.rmtree, TMP, True)
bad = 0


def fail(msg):
    global bad
    print(f"  {msg}")
    bad += 1


def paint(name, border, centre, size=256, frac=0.12):
    """A door-cell stand-in: `border` out at the rim, `centre` in the middle."""
    img = Image.new("RGB", (size, size), border)
    r = int(round(size * frac))
    img.paste(Image.new("RGB", (size - 2 * r, size - 2 * r), centre), (r, r))
    path = os.path.join(TMP, name + ".png")
    img.save(path)
    return path


GREY, HOT = (128, 128, 128), (255, 0, 160)

# --- the measurements themselves -------------------------------------------------------
# The ring must read the SURROUND and ignore the leaf: a saturated door on a grey wall is
# exactly the failure being caught, and whole-image saturation is what misses it.
grey_ring = paint("grey_ring", GREY, HOT)
hot_ring = paint("hot_ring", HOT, GREY)
if srv._ring_saturation(Image.open(grey_ring)) > 1.0:
    fail("ring saturation is picking up the door leaf, not the surround")
if srv._ring_saturation(Image.open(hot_ring)) < 200.0:
    fail("ring saturation misses a fully saturated surround")
# ...and the whole-image measure must NOT be able to tell those two apart, which is the
# reason the ring exists at all.
if abs(srv._mean_saturation(Image.open(grey_ring)) - srv._mean_saturation(Image.open(hot_ring))) > 40:
    fail("the synthetic pair no longer isolates the ring from the frame")

# The thresholds must stay inside the gap measured over dungeon_sessions (worst good door
# 23.2, worst bad door 15.7; greyscale-wall themes 3.5 and 22.0).
if not 15.7 < srv.DOOR_MIN_RING_SAT < 23.2:
    fail(f"DOOR_MIN_RING_SAT {srv.DOOR_MIN_RING_SAT} left the measured gap")
if not 22.0 < srv.DOOR_WALL_MIN_SAT < 52.5:
    fail(f"DOOR_WALL_MIN_SAT {srv.DOOR_WALL_MIN_SAT} left the measured gap")

# --- the decision ----------------------------------------------------------------------
calls = []


def stub(result):
    def _r(door_line, wall_line, tile_px, wall_named=None):
        calls.append((door_line, wall_line, tile_px, wall_named))
        return result
    return _r


real_reroll = srv._reroll_grey_door
DOOR, WALL = "solid vinyl door leaf with paw prints", "glossy pink plastic with animal decals"
hot_wall = paint("hot_wall", HOT, HOT)
grey_wall = paint("grey_wall", GREY, GREY)
good_door = paint("good_door", HOT, HOT)
blank_door = paint("blank_door", GREY, GREY)

try:
    # A door already wearing the theme is never re-rolled.
    srv._reroll_grey_door = stub(None)
    calls.clear()
    if srv._fix_offtheme_door(good_door, hot_wall, DOOR, WALL, 512) != good_door or calls:
        fail("a door that already matches the corridor was re-rolled")

    # A grey door in a grey corridor is the correct answer, so it is left alone too.
    calls.clear()
    if srv._fix_offtheme_door(blank_door, grey_wall, DOOR, WALL, 512) != blank_door or calls:
        fail("a monochrome theme had its monochrome door repainted")

    # A grey door in a colourful corridor IS the bug - re-roll, and hand the rescue both
    # designed lines so it can set the leaf into the wall.
    fixed = paint("fixed", HOT, HOT)
    srv._reroll_grey_door = stub(fixed)
    calls.clear()
    if srv._fix_offtheme_door(blank_door, hot_wall, DOOR, WALL, 512, {"x": 1}) != fixed:
        fail("a blank-surround door was not swapped for the re-roll")
    if calls != [(DOOR, WALL, 512, {"x": 1})]:
        fail(f"the re-roll was called with {calls}")

    # A re-roll that comes back no better must not make things worse.
    srv._reroll_grey_door = stub(paint("worse", GREY, GREY))
    if srv._fix_offtheme_door(blank_door, hot_wall, DOOR, WALL, 512) != blank_door:
        fail("a re-roll that measured no better was shipped anyway")

    # A re-roll that failed outright leaves the original in place rather than crashing.
    srv._reroll_grey_door = stub(None)
    if srv._fix_offtheme_door(blank_door, hot_wall, DOOR, WALL, 512) != blank_door:
        fail("a failed re-roll lost the original door")

    # An unreadable file must not take the run down with it.
    if srv._fix_offtheme_door(os.path.join(TMP, "nope.png"), hot_wall, DOOR, WALL, 512) \
            != os.path.join(TMP, "nope.png"):
        fail("an unmeasurable door did not fall through to the original")
finally:
    srv._reroll_grey_door = real_reroll

# --- the rescue prompt -----------------------------------------------------------------
# Both designed lines have to survive into it, de-articled the way every other interpolated
# slot is, and a named place keeps the sign _door_sign hands out.
p = srv._DOOR_RESCUE.format(door=srv._theme_inline("A solid vinyl leaf"),
                            wall=srv._theme_inline("Glossy pink plastic"),
                            sign=srv._door_sign(None))
if "solid vinyl leaf" not in p or "glossy pink plastic" not in p:
    fail(f"the rescue prompt dropped a designed line: {p}")
if "A solid vinyl leaf" in p or "Glossy pink plastic" in p:
    fail("the rescue prompt kept a leading article mid-sentence")
if "no text" not in p:
    fail("the rescue prompt lost the plain no-text tail")
named = {"kind": "city", "name": "manhattan"}
if '"MANHATTAN"' not in srv._DOOR_RESCUE.format(door="d", wall="w", sign=srv._door_sign(named)):
    fail("a named place lost its doorway sign in the rescue prompt")
# "no text" is positive conditioning at cfg 1.0, so the two are mutually exclusive.
if "no text" in srv._DOOR_RESCUE.format(door="d", wall="w", sign=srv._door_sign(named)):
    fail("the rescue prompt asks for a sign AND for no text")

print("FAIL" if bad else "all door-guard checks passed")
sys.exit(1 if bad else 0)
