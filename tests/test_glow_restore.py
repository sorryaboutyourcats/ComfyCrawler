"""Glowing weapons the hero's white-background cut-out drops: restore_dropped_glow gives back what
BiRefNet cut away when it is plainly light, and nothing else. Offline - synthetic frames built the
way SaveImageWithAlpha leaves them, the drawing's RGB still there under alpha 0.

What must hold: a glowing blade reaching out from the hero comes back, its halo in its own color
and its white-hot core solid; fur fringe BiRefNet trimmed, a many-colored pile of bricks beside
the hero, and a motion-blur smear of a painted thing (all measured on real frames - see the note
above restore_dropped_glow) stay cut away."""
import importlib.util, math, os, shutil, sys, tempfile
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL:", msg)

TMP = tempfile.mkdtemp(prefix="glow_test_")
N = 200


def frame():
    """A dark hero on white: RGB white everywhere, the body opaque, the rest alpha 0."""
    arr = np.zeros((N, N, 4), dtype=np.uint8)
    arr[:, :, :3] = 255
    arr[40:190, 60:140, :3] = 60
    arr[40:190, 60:140, 3] = 255
    return arr


def over_white(color, strength):
    """`color` laid over the white background at `strength` - how a glow or a blur is drawn."""
    return [round(255 - strength * (255 - c)) for c in color]


def run(arr, name):
    path = os.path.join(TMP, name + ".png")
    Image.fromarray(arr).save(path)
    n = srv.restore_dropped_glow(path)
    return n, np.array(Image.open(path).convert("RGBA"))


try:
    # A pink lightsaber held out to the right: a white core, pure magenta beside it fading out.
    blade = frame()
    for y in range(80, 121):
        for x in range(140, 196):
            d = abs(y - 100)
            blade[y, x, :3] = (255, 255, 255) if d <= 1 else over_white((255, 0, 255), math.exp(-((d - 1) / 4) ** 2))
    n, out = run(blade, "blade")
    ck(n > 0, "a glowing blade the cut-out dropped must come back")
    ck(out[100, 170, 3] == 255 and tuple(out[100, 170, :3]) == (255, 255, 255),
       f"the white-hot core must come back solid: {out[100, 170]}")
    ck(0 < out[104, 170, 3] < 255 and out[104, 170, 1] < 40 and out[104, 170, 0] > 200,
       f"the halo must come back see-through and in its own color, not whitened: {out[104, 170]}")
    ck(out[150, 170, 3] == 0 and out[100, 170 - 120, 3] == 0,
       "the white background around it must stay cut away")
    ck((out[40:190, 60:140] == blade[40:190, 60:140]).all(), "the body itself must be left as it was")

    # Each case below is one only its own gate turns away - bright, see-through and one color
    # like a glow in every other way - so each gate is pinned by a case of its own.

    # Fur fringe BiRefNet trimmed: a thin band hugging the outline (GLOW_REACH_PX).
    fringe = frame()
    for y in range(37, 193):
        for x in range(57, 143):
            if fringe[y, x, 3] == 0:
                fringe[y, x, :3] = over_white((255, 40, 40), 0.6)
    n, out = run(fringe, "fringe")
    ck(n == 0 and (out[:, :, 3] == fringe[:, :, 3]).all(), f"trimmed fringe must stay trimmed: +{n} px")

    # Something beside the hero in many colors - a pile of toy bricks (GLOW_HUE).
    patchwork = frame()
    colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
    for i, y in enumerate(range(140, 190, 10)):
        for j, x in enumerate(range(10, 60, 10)):
            patchwork[y:y + 10, x:x + 10, :3] = over_white(colors[(i + j) % 4], 0.5)
    n, out = run(patchwork, "patchwork")
    ck(n == 0, f"a many-colored thing beside the hero must stay cut away: +{n} px")

    # A solid thing beside the hero, not see-through against the white (GLOW_INK).
    block = frame()
    block[140:190, 10:60, :3] = (255, 0, 255)
    n, out = run(block, "block")
    ck(n == 0, f"a solid thing beside the hero must stay cut away: +{n} px")

    # A motion-blur smear of a gold coin: one color, see-through, but thinned rather than lit
    # (GLOW_BRIGHT).
    blur = frame()
    blur[90:110, 140:195, :3] = over_white((200, 160, 60), 0.7)
    n, out = run(blur, "blur")
    ck(n == 0, f"a painted thing's motion blur must stay cut away: +{n} px")

    # A frame with nothing dropped is left byte for byte.
    plain = frame()
    n, out = run(plain, "plain")
    ck(n == 0 and (out == plain).all(), "a frame with nothing dropped must be left alone")

    # And it runs on every hero frame, before the largest-blob pass.
    import inspect
    src = inspect.getsource(srv.generate_krea2_posed_bundle)
    ck(0 <= src.find("restore_dropped_glow(fp)") < src.find("keep_largest_figure(fp)"),
       "the hero frames must get their glow back before keep_largest_figure")
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("FAIL" if fails else "all glow-restore checks passed")
sys.exit(1 if fails else 0)
