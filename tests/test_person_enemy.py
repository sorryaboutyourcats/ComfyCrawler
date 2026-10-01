"""A PERSON typed as the enemy ("Lady in the red dress") is kept as typed by the set designer
and gets person-shaped bestiary rules - while every other enemy's bestiary prompt stays
byte-identical to what it was before that existed. No ComfyUI needed."""
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

bad = 0
def check(cond, msg):
    global bad
    if not cond:
        print("  FAIL:", msg)
        bad += 1

# Head-noun detection: the last word before the first joiner.
for text, want in [("Lady in the red dress", True), ("lady in the red dress", True),
                   ("red-dress lady with black heels", True), ("zombie girl", True),
                   ("a cat lady", True), ("business men", True),
                   ("man-eating plant", False), ("ladybug", False), ("stick of computer RAM", False),
                   ("Ryuk from Death Note", False), ("gargoyle", False), ("", False),
                   # the chat family keeps its own hand-tuned look
                   ("young woman with a purple emoji speech bubble over their head", False)]:
    check(srv._enemy_is_person(text) is want, f"_enemy_is_person({text!r}) != {want}")

# The person prompt: no placeholder left behind, the person rules in, the fuse/stack BOSS
# rule and the wing-mechanism FLYER rule out, and the typed colour kept.
p = srv._enemy_species_prompt("lady in the red dress")
check("{" not in p.split("<|im_start|>user", 1)[1].split("KIND:", 1)[0], "unfilled {placeholder} in the person prompt")
check("ONE whole person" in p, "person rule 2 missing")
check("stack or fuse" not in p, "the fuse/stack boss rule reached a person")
check("rotor blades" not in p, "the wing-mechanism flyer rule reached a person")
check('Keep every colour the words "lady in the red dress" name' in p, "person colour rule missing")

# Every non-person prompt is exactly the template with the default parts - i.e. what it was.
for e in ("stick of computer RAM", "gargoyle", "taco", "",
          "young woman with a purple emoji speech bubble over their head"):
    q = srv._enemy_species_prompt(e)
    check("stack or fuse" in q and "rotor blades" in q and "{roles}" not in q,
          f"default bestiary parts missing for {e!r}")

# The look lead puts the head-to-feet framing FIRST, and only for people.
sp = {v: {"look": "Lady in red dress hovers midair.", "name": v} for v in srv.ENEMY_VARIANT_NAMES}
srv._enemy_look_lead(sp, "lady in the red dress")
check(all(v["look"].startswith(srv._PERSON_ENEMY_LOOK + ": lady in red dress") for v in sp.values()),
      f"person look lead wrong: {sp['walker']['look']!r}")
sp = {v: {"look": "A RAM stick.", "name": v} for v in srv.ENEMY_VARIANT_NAMES}
srv._enemy_look_lead(sp, "stick of computer RAM")
check(sp["walker"]["look"] == "A RAM stick.", "an object got the person look lead")

# The person bottom-edge bound: a lady cut off at mid-thigh covers ~56% of the bottom row -
# under the general 60% clip bound, over the person one - and only people get the bound.
import tempfile
from PIL import Image
img = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
for y in range(10, 100):
    for x in range(22, 78):          # 56 px wide, running off the bottom
        img.putpixel((x, y), (200, 0, 0, 255))
tmp = os.path.join(tempfile.gettempdir(), "person_feet_check.png")
img.save(tmp)
check(srv._enemy_frame_problem(tmp) is None, "the general guard should pass a 56% bottom edge")
check((srv._enemy_frame_problem(tmp, feet_max=srv._person_feet_max("lady in the red dress", "walker"))
       or "").startswith("clipped"), "a person walker cut off at the legs was not flagged")
check(srv._person_feet_max("stick of computer RAM", "walker") is None, "an object got the person bound")
os.remove(tmp)

print("FAIL" if bad else "all person-enemy checks passed")
sys.exit(1 if bad else 0)
