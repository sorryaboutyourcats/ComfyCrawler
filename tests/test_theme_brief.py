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
    # a real head carrying a real LOOK: cut, the species designer invents the look itself
    ("armored tank with chrome plating and glowing red eye sockets", "armored tank"),
    ("gummy bear with translucent pink skin and black eyes, standing", "gummy bear"),
    ("mannequin head wearing a gold-trimmed suit with plastic eyes", "mannequin head"),
    ("floating chat bubble with glowing eyes and glitching text inside", "floating chat bubble"),
    # a ONE-WORD head means the qualifier IS the subject - cutting there would turn the
    # enemy typed as "chat" into a generic man
    ("person with a chat bubble over their head", "person with a chat bubble over their head"),
    # a SHORT tail is part of the name, not a look
    ("twitch viewer with a glowing chat bubble", "twitch viewer with a glowing chat bubble"),
    # the person must stay the head noun - "a chat-bubble viewer" draws a bubble and no person
    ("twitch viewer with a chat bubble overhead", "twitch viewer with a chat bubble overhead"),
    ("blob with three eyes", "blob with three eyes"),
    # " of " is not a joiner: this preset's whole point is that bare "ram" renders a sheep
    ("stick of computer RAM", "stick of computer RAM"),
    ("moss-covered dire bear", "moss-covered dire bear"),
    # over the word cap: cut at the last PHRASE boundary that fits, never mid-phrase, so the
    # result never ends on a dangling preposition or adjective
    ("devil with crimson skin and glowing red eyes", "devil with crimson skin and glowing red eyes"),
    ("tall filing cabinet with legs and glowing red eyes", "tall filing cabinet with legs"),
    ("trump figure made of gold foil and plastic eyes", "trump figure made of gold foil"),
    # only a cut down to nothing falls back to the whole line
    ("with nothing before it", "with nothing before it"),
):
    ck(srv._theme_enemy_subject(raw) == want,
       f"_theme_enemy_subject({raw!r}) -> {srv._theme_enemy_subject(raw)!r}, want {want!r}")
ck(srv.parse_theme_brief("ENEMY: A tall filing cabinet with legs and glowing red eyes", ALL)
   ["enemy"] == "tall filing cabinet with legs", "trim + inline did not compose")
# a truncated subject must never end on a connective or a dangling adjective
for raw in ("tall filing cabinet with legs and glowing red eyes",
            "trump figure made of gold foil and plastic eyes",
            "mannequin head wearing a gold-trimmed suit with plastic eyes"):
    tail = srv._theme_enemy_subject(raw).split()[-1].lower()
    ck(tail not in srv._THEME_ENEMY_TAIL_WORDS, f"{raw!r} left a dangling {tail!r}")
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

# ---- the blank-wall guard: the same failure reached by the third route -------------
# "supermarket" resolved to "glossy white plastic with faint barcode patterns" and rendered a
# blank sheet - mean luma 242, so the dark lift above never fires. The measurement that catches
# it is CONTRAST, and it is gated on the designed wall slot for the same reason the lift is.
ck('_fix_blank_wall(w_path, wall_style, tile_px)' in gate_src,
   "the blank-wall guard is no longer wired into the surface pipeline")
ck(gate_src.index('_fix_blank_wall') < gate_src.index('make_seamless_4way(w_path'),
   "the guard must run BEFORE the seam blend, or the blank texture is the one that gets tiled")
# the threshold has to sit in the gap measured over dungeon_sessions: every hand-tuned bucket
# wall came in at 22.5 or above, every dead designed wall at 11.1 or below.
ck(11.1 < srv.SURFACE_MIN_CONTRAST < 22.5,
   f"SURFACE_MIN_CONTRAST {srv.SURFACE_MIN_CONTRAST} left the measured gap")
flat = Image.new("RGB", (64, 64), (243, 243, 243))
ck(srv._surface_contrast(flat) < srv.SURFACE_MIN_CONTRAST, "a blank sheet read as textured")
checks = Image.new("RGB", (64, 64))
checks.putdata([(255, 255, 255) if (x // 8 + y // 8) % 2 else (20, 20, 20)
                for y in range(64) for x in range(64)])
ck(srv._surface_contrast(checks) > srv.SURFACE_MIN_CONTRAST, "a checkerboard read as blank")
# a readable wall must be returned untouched, without reaching ComfyUI at all
ok_wall = os.path.join(tmpd, "ok.png"); checks.save(ok_wall)
ck(srv._fix_blank_wall(ok_wall, "supermarket", 512) == ok_wall,
   "a readable wall was needlessly re-rolled")
# an unreadable file must not raise, and must hand its path straight back
ck(srv._fix_blank_wall(os.path.join(tmpd, "nope.png"), "supermarket", 512).endswith("nope.png"),
   "a missing wall should fall through, not raise")
# the rescue prompt must not carry the frame that manufactures the blankness in the first place
ck("flat vertical wall material" not in srv._WALLPAPER_RESCUE,
   "the rescue prompt kept the 'pure flat wall material' tail it exists to escape")
ck("{}" in srv._WALLPAPER_RESCUE, "the rescue prompt lost its theme slot")

# ---- washout adjectives are stripped from the three TILING slots ------------------
# FLUX schnell at 4 steps cannot resolve detail a line calls "faint" - it draws the ground
# colour and nothing else. Measured on the line that shipped a white supermarket: std dev
# 2.7/3.5/17.0 across three seeds, and 36.3/46.0/61.2 on those same seeds without these words.
import re
washed = srv.parse_theme_brief(
    "WALL: glossy white plastic with faint barcode patterns and faded price tags\n"
    "CEILING: fluorescent tubes casting a pale yellow glow over shelf silhouettes\n"
    "FLOOR: linoleum tiles with subtle grocery aisle lines\n"
    "LANTERN: A faintly flickering pale LED bulb on a chrome cart handle\n", ALL)
for slot in ("wall", "ceiling", "floor"):
    ck(not re.search(r"\b(faint|faintly|faded|pale|subtle)\b", washed[slot], re.I),
       f"{slot} kept a washout word: {washed[slot]!r}")
# the DETAIL the adjective qualified has to survive - stripping the clause instead would
# delete the barcodes and keep the white plastic, which is precisely backwards
ck("barcode patterns" in washed["wall"] and "price tags" in washed["wall"],
   f"the wall's detail went with its adjective: {washed['wall']!r}")
ck("yellow glow" in washed["ceiling"] and "grocery aisle lines" in washed["floor"],
   "ceiling/floor detail was lost with the adjective")
# LANTERN, DOOR and SWITCH are single drawn objects, not tiling surfaces: a faintly flickering
# pale bulb is a perfectly renderable description of a lit thing and must be left alone
ck("faintly" in washed["lantern"] and "pale" in washed["lantern"],
   f"a single-object slot was stripped: {washed['lantern']!r}")
# and a line that is nothing BUT washout words falls back rather than becoming a fragment
ck(srv._strip_words("pale faded muted", srv._SURFACE_WASHOUT, "washout") == "pale faded muted",
   "the strip gutted a line instead of keeping the original")

# ---- the surface rules must not steer the walls blank themselves -------------------
# Rule 4 used to say "keep them mid-tone or PALE", warning only about the dark end, and rule 2
# used to forbid a scene outright - which is what pushed a real place back onto its bare paint.
surf_rules = "\n".join(srv._THEME_RULES_SURFACE)
ck("pale" not in surf_rules.lower(), "the surface rules still tell the model to go pale")
ck("never a scene" not in surf_rules.lower() and "never a room" not in surf_rules.lower(),
   "the scene ban is back - the view down a real place has a vanishing point")
ck("standing inside it" in surf_rules, "the place reading is missing from rule 2")
ck("no one big object" in surf_rules,
   "rule 3 lost the focal-object ban, which is the hazard it actually guards against")
# a copyable answer gets copied: "cracked red brick with white mortar" opened NINE of the 36
# designed walls in dungeon_sessions with the word "cracked".
ck("cracked red brick" not in surf_rules, "the copyable wall example is back")

# ---- armour is stripped from EVERY subject, by WORD not by clause ----------------
# A person is a weak enough prior that "armoured" replaces them outright: "A squat, armored
# chat-bubble twitch viewer" rendered a mech with no person and no bubble in it.
for raw, must_keep, must_drop in (
    ("A squat, armored chat-bubble twitch viewer with glowing cyan edges, thick knuckles",
     "chat-bubble twitch viewer", "armored"),
    ("Massive stick of computer RAM, armored with cracked gold plating, towering",
     "stick of computer RAM", "armored"),
    ("An armour-plated gargoyle with mossy stone wings", "gargoyle", "armour-plated"),
):
    out = srv._strip_words(raw, srv._SPECIES_ARMOUR, "armour")
    ck(must_keep in out, f"armour strip ate the subject: {raw!r} -> {out!r}")
    ck(must_drop not in out.lower(), f"armour survived: {out!r}")
ck(srv._strip_words("An armour-plated gargoyle with wings", srv._SPECIES_ARMOUR, "a")
   .startswith("A gargoyle"), "article not repaired after a compound was removed")
# creature ornament that is NOT armour stays - it makes a gargoyle better
kept = "A crowned gargoyle with spiked helmet and mossy wings"
ck(srv._strip_words(kept, srv._SPECIES_ARMOUR, "armour") == kept, "ornament was stripped")

# and end to end through the parser: CREATURE keeps its crown but loses its armour
reply = ("KIND: CREATURE" + chr(10) + "GUARD: ARMS" + chr(10) +
         "GRUNT_NAME: Bubble Grunt" + chr(10) +
         "GRUNT_LOOK: A squat, armored chat-bubble twitch viewer with glowing cyan edges" + chr(10) +
         "FLYER_NAME: Airbubble" + chr(10) +
         "FLYER_LOOK: Chat-bubble twitch viewer with translucent membrane wings" + chr(10) +
         "BOSS_NAME: MegaChat" + chr(10) +
         "BOSS_LOOK: Stacked chat-bubble twitch viewers fused into a towering mass" + chr(10))
sp = srv.parse_enemy_species(reply)
ck(sp is not None, "species reply did not parse")
if sp:
    ck("armored" not in sp["walker"]["look"].lower(), f"armour survived: {sp['walker']['look']!r}")
    ck("chat-bubble twitch viewer" in sp["walker"]["look"],
       f"strip ate the subject: {sp['walker']['look']!r}")

# ---- the hand-tuned ENEMY subject ----------------------------------------------
# "chat" has no picture of its own, and every reading the designer offered was a THING - a
# floating bubble, a terminal, a bot. A thing is KIND: OBJECT in the bestiary, whose rule 2
# then asks for machinery and housings, which is why every run came back as three robots.
for typed in ("chat", "Chat", "twitch chat", "stream chat", "chatters", "emotes", "emoji"):
    lit = srv._enemy_literal(typed)
    ck(lit is not None, f"{typed!r} should get the hand-tuned subject")
    if lit:
        # a COLOURED bubble ABOVE the head. White is matted away with the background, and a
        # held placard covers the foe's face - both were rendered and both were reported.
        ck(srv._CHAT_ENEMY_MARK in lit and "over their head" in lit,
           f"{typed!r} lost the bubble or its placement: {lit!r}")
        ck("white" not in lit, f"a white bubble is cut away with the background: {lit!r}")
        ck("holding" not in lit, f"a held bubble covers the foe's face: {lit!r}")
        # the PERSON has to be the head noun: "chat-bubble viewer" draws a bubble and nobody
        ck(any(lit.startswith(p + " with ") for p in srv._CHAT_ENEMY_PEOPLE),
           f"person is not the head noun: {lit!r}")
        ck(len(lit.split()) <= 12, f"subject too long to be repeated eight times: {lit!r}")
# word boundaries, so somebody who typed an actual robot still gets one
for typed in ("chatbot", "chatbots", "gummy bear", "stick of computer RAM", "", None):
    ck(srv._enemy_literal(typed) is None, f"{typed!r} should not be overridden")
# it really is rolled per dungeon rather than fixed
ck(len({srv._enemy_literal("chat") for _ in range(60)}) > 1, "the person never varies")

# The placement clause rides on the LOOK lines, not on the subject the bestiary repeats eight
# times, and it must reach EVERY variant - the bubble has to touch the figure
# (keep_largest_figure keeps one connected blob) and sit above the face rather than over it.
# It goes in FRONT: appended after the flyer wings the bubble did not render at all, on two
# seeds; the same two seeds drew it with the clause moved to the front.
sp_chat = {"walker": {"look": "Young man in a green shirt, squatting low.", "name": "A"},
           "flyer":  {"look": "A young man with insect wings", "name": "B"},
           "boss":   {"look": "", "name": "C"}}
out = srv._enemy_look_lead(sp_chat, srv._enemy_literal("chat"))
for v in ("walker", "flyer"):
    ck(out[v]["look"].startswith(srv._CHAT_ENEMY_LOOK + ", "),
       f"{v} did not LEAD with the placement: {out[v]['look']!r}")
    ck(", ," not in out[v]["look"] and ".," not in out[v]["look"],
       f"{v} punctuation: {out[v]['look']!r}")
ck(out["walker"]["look"].endswith("young man in a green shirt, squatting low"),
   f"the designed look was damaged: {out['walker']['look']!r}")
ck(out["boss"]["look"] == "", "an empty look should be left alone, not turned into a bare clause")
# every other theme is untouched
sp_other = {"walker": {"look": "A moss-covered dire bear with heavy claws", "name": "A"}}
ck(srv._enemy_look_lead(sp_other, "gummy bear")["walker"]["look"]
   == "A moss-covered dire bear with heavy claws", "a non-chat theme was given the clause")
ck(srv._enemy_look_lead(None, srv._enemy_literal("chat")) is None, "None species must pass through")
# and it is actually wired into the designer
ck("_enemy_look_lead(species, enemy_style)" in inspect.getsource(srv.generate_enemy_species),
   "generate_enemy_species does not apply the placement clause")

# the override is applied AFTER the reply is parsed (so _theme_enemy_subject cannot trim the
# bubble off it - "young woman | with a speech bubble..." is a two-word head with a long tail,
# exactly the shape that trimmer cuts), and it also survives the reply failing entirely
brief_src = inspect.getsource(srv.generate_theme_brief)
ck('brief["enemy"] = literal' in brief_src, "the literal must overwrite the designed enemy")
ck(brief_src.count('return {"enemy": literal} if literal else None') == 2,
   "a failed reply must still carry the hand-tuned enemy - the raw typed word is the bug")

# ---- progress plan ------------------------------------------------------------
for nm, plan in (("v6", srv._plan_v6(8)), ("v5", srv._plan_v5(8))):
    ck(plan[0][0] == "theme_brief", f"{nm}: theme_brief is not the first planned job")
    ck(len({k for k, *_ in plan}) == len(plan), f"{nm}: duplicate job key in plan")

# ---- named entities: prompt-shape side only (full coverage lives in test_named_styles.py) ----
# _theme_brief_prompt with a named wall must carry the REWRITTEN theme line, never the raw
# quote characters - no LLM call anywhere in this pipeline is ever handed a literal quote mark.
named_prompt = srv._theme_brief_prompt(
    "Manhattan, the real city", "memes", "chat", True,
    {"kind": "city", "name": "Manhattan", "known": True, "landmarks": "a park, a bridge"})
theme_line = named_prompt.split("Reply using")[0].split("THEME:")[1].split("\n")[0]
ck('"' not in theme_line, f"a raw quote character reached the brief prompt's THEME line: {theme_line!r}")
ck("Manhattan, the real city" in named_prompt, "the rewritten theme line did not reach the prompt")

# the short (bucketed) shape is unreachable when a wall name is present - _theme_bucket always
# returns None for a named entity, and run_batch_v6_krea's want_surfaces is derived from it.
v6_src = inspect.getsource(srv.run_batch_v6_krea)
# named["text"]["wall"], not the raw wall_style: identical for typed words (quotes aside, which
# bypass the bucket anyway), but on a pictured wall the raw field is only the dungeon's NAME.
ck('want_surfaces=(_theme_bucket(named["text"]["wall"], named["wall"]) is None)' in v6_src,
   "run_batch_v6_krea no longer derives want_surfaces from the named-aware bucket dispatcher")

print("FAIL" if fails else "all set-designer checks passed")
sys.exit(1 if fails else 0)
