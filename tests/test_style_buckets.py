"""Regression check: the _style_bucket refactor must resolve exactly like the ORIGINAL
if/elif chains, and matched buckets must ignore `brief` entirely."""
import importlib.util, sys, os
spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)
mw = srv.match_word

def original_bucket(wall_style):
    ui = wall_style.lower()
    if any(k in ui for k in ['lsd dream emulator','lsd dream','dream emulator','lsd:de','lsddem']): return "lsddream"
    if any(k in ui for k in ['acid']): return "acid"
    if any(k in ui for k in ['glitch','glitched','datamosh','databend','databent']): return "glitch"
    if any(k in ui for k in ['mario','mushroom','mushrooms']): return "mario"
    if any(k in ui for k in ['lsd']): return "lsd"
    if any(k in ui for k in ['matrix','digital rain','code rain','falling code']): return "matrix"
    if any(k in ui for k in ['sci-fi','sci fi','spaceship','space station','alien ship','future']): return "scifi"
    if any(k in ui for k in ['win95','windows 95','windows','win 95','brick','95','retro brick']): return "win95"
    if any(k in ui for k in ['forest','nature','jungle','woods','woodland','trees','tree','garden','swamp']): return "forest"
    if any(k in ui for k in ['taco','tacos','burrito','mexican','nacho','fajita']): return "taco"
    if mw('ladies',ui) or mw('lady',ui) or mw('women',ui) or mw('woman',ui) or mw('girls',ui) or mw('girl',ui): return "ladies"
    if mw('people',ui) or mw('person',ui) or mw('crowd',ui) or mw('characters',ui) or mw('men',ui) or mw('man',ui) or mw('guys',ui): return "people"
    if any(k in ui for k in ['cyber','neon','cyberpunk','circuits','tech']): return "cyber"
    if any(k in ui for k in ['moss','stone','castle','dungeon','ancient','cave','rock']): return "stone"
    if any(k in ui for k in ['candy','gingerbread','sweet','peppermint','cake','chocolate','cookie']): return "candy"
    if any(k in ui for k in ['cat','cats','kitten','kittens','feline','dog','dogs','puppy','animal']): return "cat"
    return None

# every preset button value, every saved session's wall_style, plus adversarial strings
CASES = ["Windows 95 3D maze","Deep Forest","Cyber Neon","Mossy Stone","Candy Cane","Tacos",
         "Haunted Manor","Volcanic Depths","Sunken Ruins","Pharaoh's Tomb","internet","trippy",
         "classroom","mangos","birds","corporate office","manhattan",
         "ugly things covered in gold","motherboard","cut up fruit","hell","pet store",
         "deep forest","cyber neon","supermarket","windows 95 3d maze","candy cane",
         "cathedral","catacombs","rockstar","biotech","1995","a lady in a garden","the man",
         "", "  ", "SPACESHIP", "Sweet Cave",
         # the 2026-09-10 named-aesthetic buckets, and the collisions they must survive
         "LSD dream emulator","LSD Dream Emulator","lsd","LSD","acid","Acid Bath","glitch",
         "glitched photos","mario mushrooms","Super Mario","mushrooms","datamosh",
         "a psychedelic lsd dream emulator level",
         # 2026-09-23: the Matrix's green code rain left the cyan 'cyber' bucket
         "The Matrix","matrix digital rain","digital rain","cyber matrix","neon code rain"]

FAKE = {"wall":"XX-WALL","floor":"XX-FLOOR","ceiling":"XX-CEIL","lantern":"XX-LANT",
        "door":"XX-DOOR","switch":"XX-SWITCH","weapon":"XX-W","enemy":"XX-E"}

bad = 0
for s in CASES:
    got, want = srv._style_bucket(s), original_bucket(s)
    if got != want:
        print(f"  BUCKET MISMATCH {s!r}: new={got} old={want}")
        bad += 1

# matched buckets must be byte-identical with and without a brief
for s in CASES:
    if srv._style_bucket(s) is None:
        continue
    if srv.get_surface_prompts(s) != srv.get_surface_prompts(s, brief=FAKE):
        print(f"  SURFACE brief leaked into bucket {s!r}")
        bad += 1
    if srv.get_gate_prompts(s) != srv.get_gate_prompts(s, brief=FAKE):
        print(f"  GATE brief leaked into bucket {s!r}")
        bad += 1

# _theme_bucket (the named-entity-aware dispatcher both get_surface_prompts and
# get_gate_prompts now actually call) must be byte-identical to _style_bucket alone for every
# case above - unquoted input must never see any behaviour change from that feature existing.
for s in CASES:
    if srv._theme_bucket(s, None) != srv._style_bucket(s):
        print(f"  THEME_BUCKET DRIFT (unnamed) {s!r}")
        bad += 1

# A quoted proper name must ALWAYS bypass the bucket, even for a string that would otherwise
# collide - see tests/test_named_styles.py for the fuller named-entity coverage; this is just
# the one-line guarantee that belongs next to the bucket-equality checks above.
_FAKE_NAMED = {"kind": "city", "name": "X"}
for s in ("wall street", "rockefeller center", "st patricks cathedral", "route 95"):
    if srv._theme_bucket(s, _FAKE_NAMED) is not None:
        print(f"  a named entity failed to bypass the bucket for {s!r}")
        bad += 1

# ...except a bucket whose key IS the name (_STYLE_BUCKETS_QUOTE_SAFE): a quoted "The Matrix"
# is asking for exactly the green rain, so it must still reach it.
for s in ("The Matrix, the real film digital rain", "The Matrix"):
    if srv._theme_bucket(s, _FAKE_NAMED) != "matrix":
        print(f"  the quote-safe matrix bucket was bypassed for {s!r}")
        bad += 1

# generic path with no brief must be unchanged; with a brief must use every slot
w,c,f,l = srv.get_surface_prompts("internet")
assert "of internet," in w and "of internet," in c and "of internet," in f, "generic no-brief changed"
assert "A single object made of internet, blazing" in l, l
w,c,f,l = srv.get_surface_prompts("internet", brief=FAKE)
for tag, s in (("wall",w),("ceil",c),("floor",f),("lant",l)):
    assert "internet" not in s, f"{tag} still leaks raw word: {s[:90]}"
assert "XX-WALL" in w and "XX-CEIL" in c and "XX-FLOOR" in f and "XX-LANT" in l
d,sw = srv.get_gate_prompts("internet", brief=FAKE)
assert d.startswith("XX-DOOR") and sw.startswith("XX-SWITCH"), (d[:60], sw[:60])
# partial brief -> that slot falls back, others still used
w2,_,_,l2 = srv.get_surface_prompts("internet", brief={"wall":"XX-WALL"})
assert "XX-WALL" in w2 and "A single object made of internet" in l2

print("FAIL" if bad else "all bucket + brief checks passed")
sys.exit(1 if bad else 0)
