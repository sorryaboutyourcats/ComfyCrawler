"""Offline checks on the set-designer plumbing: prompt shape, parser, and the weapon/enemy
substitution. No ComfyUI needed - the LLM reply is faked."""
import importlib.util, sys, os
spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

# ---- prompt shape -------------------------------------------------------------
full = srv._theme_brief_prompt("internet", "memes", "chat", True)
short = srv._theme_brief_prompt("candy cane", "candy cane staff", "gummy bear", False)
for name, p in (("full", full), ("short", short)):
    ck(p.startswith("<|im_start|>system\n"), f"{name}: missing chat template opener")
    ck(p.endswith("<think>\n\n</think>\n\n"), f"{name}: missing empty think block")
    ck("<|im_start|>assistant\n" in p, f"{name}: missing assistant turn")
for s in srv.THEME_SURFACE_SLOTS:
    ck(f"{s.upper()}: <one line>" in full, f"full prompt missing {s.upper()} label")
    ck(f"{s.upper()}: <one line>" not in short, f"short prompt should not ask for {s.upper()}")
for s in srv.THEME_SUBJECT_SLOTS:
    ck(f"{s.upper()}: <one line>" in full and f"{s.upper()}: <one line>" in short,
       f"{s.upper()} label missing")
ck("internet" in full and "memes" in full and "chat" in full, "typed words not in prompt")
ck(len(short) < len(full), "short shape is not shorter")
# empty input must not produce an empty subject
blank = srv._theme_brief_prompt("", "", "", True)
ck("a forgotten place" in blank and "a sword" in blank, "blank input lost its defaults")

# ---- parser -------------------------------------------------------------------
ALL = srv.THEME_SURFACE_SLOTS + srv.THEME_SUBJECT_SLOTS
reply = """WALL: Dense black server blades with blue status LEDs and grey cable bundles
FLOOR: Perforated grey steel raised-floor panels with dark seams
CEILING: Suspended aluminium cable trays and white light diffuser panels
LANTERN: A splayed fibre-optic bundle with glowing white glass strands
DOOR: A grey steel server cabinet door with a black mesh vent panel
SWITCH: A red emergency cutoff button on a small steel plate
WEAPON: A coiled blue ethernet cable whip with an RJ45 plug grip
ENEMY: A swarming green chat-bubble spirit
"""
b = srv.parse_theme_brief(reply, ALL)
ck(set(b) == set(ALL), f"parser lost slots: {sorted(set(ALL) - set(b))}")

# inline slots lose their leading article + capital; subject slots keep both
ck(b["enemy"] == "swarming green chat-bubble spirit", b.get("enemy"))

# ENEMY is cut back to a short SUBJECT - it becomes the {enemy} the species brief repeats
# eight times, so a bolted-on look (especially a costume noun like "armored") must not ride in
for raw, want in (
    ("armored tank with chrome plating and glowing red eye sockets", "armored tank"),
    ("gummy bear with translucent pink skin, standing on two legs", "gummy bear"),
    ("mannequin head wearing a gold-trimmed suit, mouth open", "mannequin head"),
    ("bagel-shaped creature which lunges forward", "bagel-shaped creature"),
    # " of " is not a joiner: this preset's whole point is that bare "ram" renders a sheep
    ("stick of computer RAM", "stick of computer RAM"),
    ("moss-covered dire bear", "moss-covered dire bear"),
    # a ONE-WORD subject is the good case, not a degenerate one - it is the shape of the
    # presets that already work ("taco"), so it is kept rather than rejected
    ("blob with three eyes", "blob"),
    ("trump figure made of gold foil and plastic eyes", "trump figure"),
    # only a cut down to nothing falls back to the whole line
    ("with nothing before it", "with nothing before it"),
):
    ck(srv._theme_enemy_subject(raw) == want,
       f"_theme_enemy_subject({raw!r}) -> {srv._theme_enemy_subject(raw)!r}, want {want!r}")
ck(srv.parse_theme_brief("ENEMY: A tall filing cabinet with legs and glowing red eyes", ALL)
   ["enemy"] == "tall filing cabinet", "trim + inline did not compose")
ck(b["weapon"].startswith("coiled blue ethernet"), b.get("weapon"))
ck(b["wall"].startswith("dense black server blades"), b.get("wall"))
ck(b["lantern"].startswith("A splayed fibre-optic"), b.get("lantern"))
ck(b["door"].startswith("A grey steel"), b.get("door"))
# acronyms and proper nouns keep their case
for src_s, want in (("RJ45 plug on a grey cable", "RJ45 plug on a grey cable"),
                    ("The Windows 95 teal desktop", "windows 95 teal desktop"),
                    ("An orange traffic cone", "orange traffic cone"),
                    ("A LED-lit panel", "LED-lit panel")):
    ck(srv._theme_inline(src_s) == want,
       f"_theme_inline({src_s!r}) -> {srv._theme_inline(src_s)!r}, want {want!r}")

# preamble, markdown, wrong-case labels, duplicates, a too-short line
messy = """Sure! Here is the set design:

**WALL:** Woven magenta and cyan light cables over black rubber
wall: SHOULD BE IGNORED, first one wins
floor: Soft violet foam tiles with swirling orange spirals
CEILING: dark
ENEMY: A grinning purple lava-lamp blob
"""
m = srv.parse_theme_brief(messy, ALL)
ck(m.get("wall", "").startswith("woven magenta"), f"markdown/preamble broke wall: {m.get('wall')!r}")
ck("floor" in m, "lowercase label not matched")
ck("ceiling" not in m, "one-word CEILING should have been dropped")
ck("door" not in m and "weapon" not in m, "invented a slot that was not in the reply")

# negation stripping (cfg 1.0 -> a negated clause is a request to draw it)
neg = srv.parse_theme_brief(
    "WALL: Blue glowing circuit board, no cables anywhere, with gold solder traces\n", ALL)
ck("no cables" not in neg.get("wall", ""), f"negation survived: {neg.get('wall')!r}")
ck("gold solder traces" in neg.get("wall", ""), "negation strip ate the good clauses")

# garbage -> empty dict, so the caller falls back
ck(srv.parse_theme_brief("", ALL) == {}, "empty reply should give {}")
ck(srv.parse_theme_brief("I cannot help with that.", ALL) == {}, "refusal should give {}")

# ---- consumption --------------------------------------------------------------
w, c, f, l = srv.get_surface_prompts("internet", brief=b)
ck("server blades" in w and "raised-floor panels" in f, "surface prompts ignored the brief")
ck(l.startswith("A splayed fibre-optic bundle") and "blazing with brilliant" in l,
   f"lantern subject wrong: {l[:80]!r}")
d, sw = srv.get_gate_prompts("internet", brief=b)
ck(d.startswith("A grey steel server cabinet door") and "fully closed" in d, d[:80])
ck(sw.startswith("A red emergency cutoff button") and sw.endswith(srv._GATE_TAIL), sw[:80])
ck("not a lamp" not in sw, "brief gate path kept the old negated clause")

# a brief missing door/switch must fall back to the raw-word gate, not half-build one
partial = {k: v for k, v in b.items() if k != "switch"}
d2, sw2 = srv.get_gate_prompts("internet", brief=partial)
ck("styled as internet" in d2 and "theme of internet" in sw2,
   "partial gate brief did not fall back cleanly")

# weapon reaches all nine player frames
frames = srv.krea2_frame_prompts("cat", "memes", brief=b)
ck(len(frames) == len(srv.V6_FRAME_NAMES), "frame count changed")
ck(all("memes" not in fr for fr in frames), "raw 'memes' still in a frame prompt")
ck(all("ethernet cable whip" in fr for fr in frames), "brief weapon missing from a frame")
ck("holding a coiled blue ethernet cable whip with an RJ45 plug grip in the right hand"
   in frames[0],
   f"weapon does not read after the article: {frames[0][:170]!r}")
ck("holding a A " not in frames[0] and "holding a a " not in frames[0], "double article")
# no brief -> unchanged behaviour
ck(all("holding a memes" in fr for fr in srv.krea2_frame_prompts("cat", "memes")),
   "no-brief frame prompts changed")

# ---- the dark-surface lift is gated on DESIGNED surfaces, not on a truthy brief ----
# A bucketed theme still returns a brief (weapon + enemy), so gating on the brief itself would
# repaint hand-tuned bucket art - the sci-fi bucket's "dark spaceship hull" is meant to be dark.
import inspect
gate_src = inspect.getsource(srv.generate_flux_surfaces_only)
ck('if (brief or {}).get("wall")' in gate_src,
   "the lift must be gated on the designed wall slot, not on `brief` being truthy")
bucket_brief = srv.parse_theme_brief("WEAPON: a red plastic mallet with a grip" + chr(10) +
                                     "ENEMY: a gummy bear" + chr(10), srv.THEME_SUBJECT_SLOTS)
ck(set(bucket_brief) == {"weapon", "enemy"} and not bucket_brief.get("wall"),
   f"a two-label brief must carry no surface slot: {bucket_brief}")

# the lift itself: dark -> lifted, bright -> untouched, alpha preserved
from PIL import Image
import tempfile, os
tmpd = tempfile.mkdtemp()
dark = os.path.join(tmpd, "dark.png")
Image.new("RGB", (64, 64), (6, 6, 10)).save(dark)
srv._lift_dark_surface(dark, "unit-dark")
ck(srv._mean_luma(Image.open(dark)) > srv.SURFACE_MIN_LUMA, "dark surface was not lifted")
bright = os.path.join(tmpd, "bright.png")
Image.new("RGB", (64, 64), (200, 200, 200)).save(bright)
before = srv._mean_luma(Image.open(bright))
srv._lift_dark_surface(bright, "unit-bright")
ck(abs(srv._mean_luma(Image.open(bright)) - before) < 0.01, "bright surface was altered")
rgba = os.path.join(tmpd, "rgba.png")
im = Image.new("RGBA", (64, 64), (5, 5, 8, 255)); im.putalpha(Image.new("L", (64, 64), 128))
im.save(rgba)
srv._lift_dark_surface(rgba, "unit-alpha")
out = Image.open(rgba)
ck(out.mode == "RGBA" and out.getchannel("A").getextrema() == (128, 128),
   f"alpha not preserved: {out.mode} {out.getchannel('A').getextrema() if out.mode=='RGBA' else ''}")
# a missing file must not raise - a bad texture beats a crashed bundle
srv._lift_dark_surface(os.path.join(tmpd, "nope.png"), "unit-missing")

# ---- progress plan ------------------------------------------------------------
for nm, plan in (("v6", srv._plan_v6(8)), ("v5", srv._plan_v5(8))):
    ck(plan[0][0] == "theme_brief", f"{nm}: theme_brief is not the first planned job")
    ck(len({k for k, *_ in plan}) == len(plan), f"{nm}: duplicate job key in plan")

print("FAIL" if fails else "all set-designer checks passed")
sys.exit(1 if fails else 0)
