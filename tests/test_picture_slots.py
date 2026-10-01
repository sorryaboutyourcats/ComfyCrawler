"""Reference pictures on the mad-lib lines: one picture per line is what the thing LOOKS like,
and the words typed beside it are what it is CALLED. Offline - the Qwen3-VL replies are the real
ones captured while tuning the prompt, and dungeon_sessions is pointed at a temp folder.

What must hold: the typed name never reaches an image prompt ("text"), only the crawl ("story")
and the hero / boss / location names; the picture's LOOK names the thing it describes; a
pictured wall never falls into a keyword bucket; and a saved run keeps its pictures for
History's Prompts button, served back by /api/history_picture."""
import atexit, base64, importlib.util, io, json, os, shutil, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)
sys.path.insert(0, ROOT)
import comfy_node
from PIL import Image

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL:", msg)

# ---- reading a reply -------------------------------------------------------------------
# Replies as they came back live, after the "KIND:" the reply is begun on.
got = srv.parse_picture_reply(" fly swatter\nLOOK: blue plastic with grid pattern, long handle", "weapon")
ck(got["kind"] == "fly swatter", got)
ck(got["look"].startswith("fly swatter, blue plastic"),
   f"a LOOK that never names its KIND must get it put back in front: {got['look']!r}")
got = srv.parse_picture_reply(" duck\nLOOK: yellow rubber duck with orange beak and black eye "
                              "sitting on white sink edge", "enemy")
ck(got["look"] == "yellow rubber duck with orange beak and black eye",
   f"where it was photographed must be cut, even with no comma in front: {got['look']!r}")
got = srv.parse_picture_reply(" sword\nLOOK: sword with a red grip, gold crossguard, steel blade "
                              "resting on wood grain surface", "weapon")
ck(got["look"] == "sword with a red grip, gold crossguard, steel blade", got["look"])
# The backdrop with no article in front of it: krea2 drew the dark square behind the lightsaber.
got = srv.parse_picture_reply(" sword\nLOOK: glowing pink lightsaber with metallic hilt and textured grip, "
                              "emitting vibrant magenta energy against dark background", "weapon")
ck(got["look"] == "sword, glowing pink lightsaber with metallic hilt and textured grip, emitting "
   "vibrant magenta energy", f"the photo's backdrop must be cut, article or not: {got['look']!r}")
for backdrop in ("on a plain white background", "against black backdrop", "in the blurry background",
                 "against dark purple smoke", "against a night sky"):
    got = srv.parse_picture_reply(f" sword\nLOOK: sword with a red grip {backdrop}", "weapon")
    ck(got["look"] == "sword with a red grip", f"{backdrop!r} must be cut: {got['look']!r}")
got = srv.parse_picture_reply(" man\nLOOK: A graying bearded man with round glasses.", "player")
ck(got["look"] == "graying bearded man with round glasses",
   f"LOOK follows the word 'a' - no article, no full stop: {got['look']!r}")
ck(srv.parse_picture_reply(" cat\nLOOK: ginger tabby cats curled together", "enemy")["look"]
   == "ginger tabby cats curled together", "a plural of the KIND already names it")
# the wall is the one line where the setting IS the subject
wall = srv.parse_picture_reply(" kitchen\nLOOK: kitchen with pots sitting on shelves", "wall")
ck(wall["look"] == "kitchen with pots sitting on shelves", f"the wall lost its setting: {wall}")
ck(srv.parse_picture_reply("Sure! Here is what I see.", "enemy") == {"kind": None, "look": None},
   "an unlabelled reply should read as nothing")
ck(srv.parse_picture_reply(" **cat**\n**LOOK:** cat with orange fur", "enemy")["kind"] == "cat",
   "markdown around the labels broke the parse")
# a pose on its own body is not where it was photographed - this one used to be cut to
# "wearing a red robe and", losing the feet
got = srv.parse_picture_reply(" cat\nLOOK: white kitten wearing a red robe and standing on its "
                              "hind legs", "enemy")
ck(got["look"].endswith("standing on its hind legs"), f"a body pose was cut as a setting: {got['look']!r}")
got = srv.parse_picture_reply(" kitten\nLOOK: white kitten wearing a red robe and sitting on a sofa", "enemy")
ck(got["look"] == "white kitten wearing a red robe", f"a dangling 'and' was left behind: {got['look']!r}")
# What it was DOING in the picture is cut too - a pose in the LOOK is a pose in every frame.
# Replies as they came back live from a GIF frame of a cat-headed dancer.
got = srv.parse_picture_reply(" cat\nLOOK: white cat with large blue eyes, wearing a red jumpsuit, "
                              "black shoes, and jumping mid-air", "enemy")
ck(got["look"] == "white cat with large blue eyes, wearing a red jumpsuit, black shoes",
   f"the pose was left in the LOOK: {got['look']!r}")
got = srv.parse_picture_reply(" cat\nLOOK: white cat with large eyes, wearing a red jumpsuit and "
                              "black shoes, mid-leap", "enemy")
ck(got["look"] == "white cat with large eyes, wearing a red jumpsuit and black shoes", got["look"])
got = srv.parse_picture_reply(" man\nLOOK: man in a red tracksuit and black shoes while dancing", "player")
ck(got["look"] == "man in a red tracksuit and black shoes", f"a player pose was kept: {got['look']!r}")
got = srv.parse_picture_reply(" man\nLOOK: man in a grey hoodie, black shorts, running shoes", "player")
ck(got["look"].endswith("running shoes"), f"running shoes are clothing, not a pose: {got['look']!r}")
got = srv.parse_picture_reply(" frog\nLOOK: green frog, jumping mid-air", "weapon")
ck(got["look"] == "green frog, jumping mid-air", "only the player and enemy lose their pose")
for slot in ("player", "enemy"):
    ck("nothing about" in srv._PICTURE_WHERE[slot] and "pose" in srv._PICTURE_WHERE[slot],
       f"{slot}: rule 3 must ask for no pose (7 of 8 reads leapt without it)")
# A wave goes with its whole clause, on the weapon too - a waving plush made the HERO wave.
got = srv.parse_picture_reply(" plush\nLOOK: soft white plush with rounded limbs, smiling face, and "
                              "one raised hand waving gently", "weapon")
ck(got["look"] == "soft white plush with rounded limbs, smiling face", f"the wave was kept: {got['look']!r}")
got = srv.parse_picture_reply(" sword\nLOOK: sword with raised lettering on the blade, gold hilt", "weapon")
ck(got["look"] == "sword with raised lettering on the blade, gold hilt",
   f"raised surface detail is not a gesture: {got['look']!r}")
# Someone in a costume is a person in that costume - named as the character, the Muppet is drawn.
ck("costume" in srv._PICTURE_ROLES["player"][1], "the player's LOOK no longer asks about costumes")
got = srv.parse_picture_reply(" person\nLOOK: red furry Elmo costume with large white eyes, orange "
                              "nose, black mouth", "player")
ck(got["look"] == "person in a red furry Elmo costume with large white eyes, orange nose, black mouth",
   f"a costume must be worn by the person: {got['look']!r}")

# ---- the waist-up follow-up ------------------------------------------------------------
# Only a legged KIND whose LOOK names nothing below the waist gets it.
waist_up = "man with curly brown hair, wearing a black t-shirt and a silver chain"
ck(srv._picture_needs_lower("enemy", "man", waist_up), "a waist-up man must get the follow-up")
ck(srv._picture_needs_lower("player", "kittens", "white kitten wearing a red robe"), "plural animal kind")
ck(not srv._picture_needs_lower("enemy", "man", waist_up + ", dark pants and shoes"),
   "a LOOK that already has legwear must be left alone")
ck(not srv._picture_needs_lower("enemy", "pendant", "gold pendant with a blue M"),
   "an object must never be given legs (the model gave a pendant trousers 3 of 3)")
ck(not srv._picture_needs_lower("weapon", "man", waist_up), "the weapon line never gets legs")
ck(not srv._picture_needs_lower("enemy", None, waist_up), "an unread KIND is left as it is")
# Replies as they came back live, after the "LOWER:" the reply is begun on.
ck(srv.parse_picture_lower(" black trousers and brown boots") == "black trousers and brown boots",
   "a clean lower half was not kept")
ck(srv.parse_picture_lower(" black pants, brown shoes, slight smile") == "black pants, brown shoes",
   "parts that are not about the lower half must be dropped")
ck(srv.parse_picture_lower(" none") is None, "NONE must add nothing")
ck(srv.parse_picture_lower(" a cheerful expression") is None, "an off-topic reply must add nothing")

# ---- the prompt ------------------------------------------------------------------------
for slot in srv.PICTURE_SLOTS:
    p = srv._picture_prompt(slot)
    ck(p.startswith("<|im_start|>system\n"), f"{slot}: missing chat template opener")
    ck("<|vision_start|><|image_pad|><|vision_end|>" in p, f"{slot}: the picture is not spliced in")
    ck(p.endswith("<think>\n\n</think>\n\n" + srv._PICTURE_REPLY_START),
       f"{slot}: the reply must be begun on KIND:")

# ---- name vs look ----------------------------------------------------------------------
looks = {
    "wall": {"kind": "forest", "look": "misty forest with towering redwood trees and ferns"},
    "player": {"kind": "man", "look": "graying bearded man with round glasses"},
    "weapon": {"kind": "sword", "look": "sword with a red grip and gold crossguard"},
    "enemy": {"kind": "cat", "look": "cat with orange tabby fur and white paws"},
}
named = srv.resolve_named_styles("", "Joe", "the beast", '"Billy"', pictures=looks)
for k in srv.PICTURE_SLOTS:
    ck(named["text"][k] == looks[k]["look"] and named["clean"][k] == looks[k]["look"],
       f"{k}: the picture's LOOK must be what gets drawn: {named['text'][k]!r}")
for k, name in (("player", "Joe"), ("weapon", "The Beast"), ("enemy", "Billy")):
    ck(name not in named["text"][k] and name not in named["clean"][k],
       f"{k}: the name leaked into an image/sound prompt - at cfg 1.0 it would be drawn")
    ck(named["story"][k].endswith(f"called {name}"), f"{k}: the crawl never hears the name")
    ck(named[k] and named[k]["name"] == name and named[k]["source"] == "picture",
       f"{k}: no picture entity carrying the name: {named[k]}")
ck(named["enemy"]["kind"] == "cat" and named["weapon"]["kind"] == "sword", "entity kind != KIND")
# an unnamed wall still gets its nameless entity, for the bucket bypass alone
ck(named["wall"] and named["wall"]["name"] is None and named["wall"]["kind"] is None,
   f"an unnamed pictured wall should carry a nameless, kindless entity: {named['wall']}")
ck(srv._style_bucket(named["text"]["wall"]) == "forest", "sanity: this LOOK does hit a bucket")
ck(srv._theme_bucket(named["text"]["wall"], named["wall"]) is None,
   "a pictured wall fell into a keyword bucket instead of being drawn like its picture")
ck(srv._door_sign(named["wall"]) == srv._door_sign(None), "an unnamed wall grew a door sign")
# A pictured wall tells the set designer it is a real place: the view on the wall, the ground
# underfoot, the sky or roof overhead, nothing borrowed from the weapon or the enemy.
photo = "read from a photograph of a place"
ck(photo in srv._theme_brief_surfaces(named["wall"]), "a pictured wall lost its photo sentence")
ck(photo in srv._theme_brief_surfaces(dict(named["wall"], name="Mirkwood", kind="forest")),
   "a NAMED pictured wall lost its photo sentence")
ck(photo not in srv._theme_brief_surfaces(None), "a typed theme was told it is a photograph")
ck(photo not in srv._theme_brief_surfaces({"source": "quote", "name": "Alley Pond Park",
                                           "kind": "park", "known": False}),
   "a quoted (not pictured) place was told it is a photograph")

# A pictured wall's door is a cut-out set into the wall itself, never a cell of its own
# (a brick door cell stood in the middle of the Windows XP hill).
gate_brief = {"door": "solid red plastic door in a brick archway", "switch": "small brass lever"}
door_p = srv.get_gate_prompts(named["text"]["wall"], gate_brief, named["wall"])[0]
ck(srv._DOOR_CUTOUT_TAIL in door_p and "zero horizon" not in door_p and door_p.startswith("A single closed door"),
   f"a pictured wall's door must be asked for as a cut-out: {door_p!r}")
typed_p = srv.get_gate_prompts("haunted library", gate_brief, None)[0]
ck(srv._DOOR_CUTOUT_TAIL not in typed_p, "a typed theme's door must stay a full cell")
tmp_door = tempfile.mkdtemp()
atexit.register(shutil.rmtree, tmp_door, True)
wall_img = Image.new("RGB", (100, 100), (0, 0, 255))
wall_img.paste((0, 255, 0), (0, 0, 50, 100))                 # green left half, blue right half
wall_img.save(os.path.join(tmp_door, "wall.png"))
cut = Image.new("RGBA", (60, 60), (0, 0, 0, 0))
cut.paste((255, 0, 0, 255), (20, 10, 40, 50))                 # a 20x40 red door in empty space
cut.save(os.path.join(tmp_door, "cut.png"))
onwall = srv._door_onto_wall(os.path.join(tmp_door, "cut.png"), os.path.join(tmp_door, "wall.png"))
got_img = Image.open(onwall).convert("RGB")
ck(got_img.getpixel((5, 5)) == (0, 0, 255) and got_img.getpixel((95, 5)) == (0, 255, 0),
   "the wall behind the door must be mirrored, to line up once game.js flips the door")
red = [y for y in range(100) if got_img.getpixel((50, y)) == (255, 0, 0)]
floor_y = round((100 - 100 * srv.DOOR_WALL_VSPAN) / 2 + 100 * srv.DOOR_WALL_VSPAN)
ck(red and red[-1] == floor_y - 1, f"the door must stand on the band's floor line {floor_y}: {red[-1:]}")
# A white leaf matted away with the white ground: what the arch walls in is door again.
arch = Image.new("RGBA", (40, 40), (250, 250, 250, 0))
for x0, x1 in ((0, 6), (34, 40)):
    arch.paste((120, 120, 120, 255), (x0, 0, x1, 40))           # the two jambs
arch.paste((120, 120, 120, 255), (0, 0, 40, 6))                # the lintel
filled = srv._door_fill_leaf(arch)
ck(filled.getpixel((20, 20))[3] == 255 and filled.getpixel((20, 20))[:3] == (250, 250, 250),
   "the leaf inside the arch must come back, in its own colour")
open_side = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
open_side.paste((120, 120, 120, 255), (0, 0, 6, 40))
ck(srv._door_fill_leaf(open_side).getpixel((20, 20))[3] == 0, "nothing walled in, nothing filled")
ck(srv._door_onto_wall(os.path.join(tmp_door, "wall.png").replace("wall", "nope"),
                       os.path.join(tmp_door, "wall.png")) is None, "an unreadable cut-out must fall back")

# A pictured enemy's LOOK survives the set designer whole - its eight-word ENEMY line dropped
# the red jumpsuit ("white cat mid-leap") and every foe came back a plain white cat.
_saved_submit = srv._submit_and_collect_text
srv._submit_and_collect_text = lambda *a, **k: (
    "WEAPON: pile of colourful plastic bricks held in hand\nENEMY: white cat mid-leap")
try:
    cat = "cat with white fur, large round eyes, wearing a red jumpsuit with black shoes"
    got = srv.generate_theme_brief("", "bricks", cat, want_surfaces=False, enemy_pictured=True)
    ck(got["enemy"] == cat, f"a pictured enemy's LOOK was rewritten: {got['enemy']!r}")
    got = srv.generate_theme_brief("", "bricks", "cat", want_surfaces=False)
    ck(got["enemy"] == "white cat mid-leap", f"a typed enemy should still be designed: {got['enemy']!r}")
    ck(got["weapon"] == "pile of colourful plastic bricks held in hand",
       f"a typed weapon should still be designed: {got['weapon']!r}")
    plush = "soft white plush with rounded limbs, smiling face"
    got = srv.generate_theme_brief("", plush, "cat", want_surfaces=False, weapon_pictured=True)
    ck(got["weapon"] == plush, f"a pictured weapon's LOOK was rewritten: {got['weapon']!r}")
finally:
    srv._submit_and_collect_text = _saved_submit

# unnamed player / weapon / enemy: no entity, so the story names them itself
bare = srv.resolve_named_styles("", "", "", "", pictures=looks)
ck(all(bare[k] is None for k in ("player", "weapon", "enemy")), "an unnamed picture made an entity")
ck(bare["story"]["weapon"] == looks["weapon"]["look"], "an unnamed story line should be the LOOK")
# a picture that could not be read: still named, drawn from the fallback, never from the name
unread = srv.resolve_named_styles("Mirkwood", "", "The Beast", "",
                                  pictures={"wall": {"kind": None, "look": None},
                                            "weapon": {"kind": None, "look": None}})
ck(unread["text"]["weapon"] == "" and unread["text"]["wall"] == "Windows 95",
   f"an unread picture must fall back, not draw its name: {unread['text']}")
ck(unread["weapon"]["kind"] == "weapon" and unread["wall"]["kind"] == "place",
   "an unread KIND needs its fallback, or the boss/location will not take the name")
# lines without a picture are untouched - quotes still work exactly as before
mixed =srv.resolve_named_styles("mossy stone", "Joe", "staff", "slime", pictures={"player": looks["player"]})
ck(mixed["text"]["wall"] == "mossy stone" and mixed["wall"] is None, "an unpictured wall changed")
ck(mixed["story"]["wall"] == mixed["text"]["wall"], "story must equal text on an unpictured line")

# ---- the names reach the cast -----------------------------------------------------------
named_wall = srv.resolve_named_styles("Mirkwood", "Joe", "", "Billy", pictures=looks)
names = srv.generate_story_names(named_wall["story"]["wall"], named_wall["story"]["player"],
                                 named_wall["story"]["enemy"], named=named_wall)
ck(names["hero"] == "Joe" and names["boss"] == "Billy" and names["location"] == "Mirkwood",
   f"the typed names did not name the hero / boss / location: {names}")
story = srv.parse_story_block("", named_wall["story"]["wall"], named_wall["story"]["player"],
                              named_wall["story"]["enemy"], named=named_wall, names=names)
ck(story["hero"] == "Joe" and story["location"] == "Mirkwood", f"parse_story_block: {story}")
ck("MIRKWOOD" in srv._door_sign(named_wall["wall"]), "a named pictured wall should get its sign")

# ---- History keeps the pictures ---------------------------------------------------------
TMP = tempfile.mkdtemp(prefix="picture_slots_")
atexit.register(shutil.rmtree, TMP, True)


def jpeg_url(color):
    buf = io.BytesIO()
    Image.new("RGB", (32, 24), color).save(buf, "PNG")   # a PNG on purpose: saved as a JPEG
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


real_sessions = srv.SESSIONS_DIR
try:
    srv.SESSIONS_DIR = TMP
    srv.forget_session_rows()
    bundle = {"mode": "v6_krea", "story": {"hero": "Joe"}, "picture_looks": looks,
              "named_styles": named}
    sid = srv.save_dungeon_session(bundle, "", "Joe", "the beast", "Billy",
                                   pictures={"weapon": jpeg_url("red"), "enemy": jpeg_url("blue")})
    ck(sid, "the run was not saved")
    folder = os.path.join(TMP, sid or "missing")
    for slot in ("weapon", "enemy"):
        path = os.path.join(folder, srv.PICTURE_FILENAME.format(slot))
        ck(os.path.exists(path), f"the {slot} picture was not kept beside the run")
        if os.path.exists(path):
            ck(Image.open(path).format == "JPEG", f"the {slot} picture should be re-encoded as JPEG")
    ck(not os.path.exists(os.path.join(folder, srv.PICTURE_FILENAME.format("wall"))),
       "a picture nobody attached was written")
    meta = json.load(open(os.path.join(folder, "meta.json"), encoding="utf-8"))
    pics = meta.get("pictures") or {}
    ck(pics.get("weapon", {}).get("saved") is True and pics["weapon"].get("look") == looks["weapon"]["look"],
       f"meta.pictures should say what the weapon picture was read as and that it is on disk: {pics}")
    ck(pics.get("wall", {}).get("saved") is False, "the wall was read but its picture is not on disk")
    ck(meta["weapon_style"] == "the beast", "meta must keep the TYPED name, for Prompts to restore")
    ck(srv.PICTURE_FILENAME.format("weapon") not in
       open(os.path.join(ROOT, "tools", "export_showcase.py"), encoding="utf-8").read()
       and "PICTURE_FILENAME" not in open(os.path.join(ROOT, "tools", "export_showcase.py"),
                                          encoding="utf-8").read(),
       "the showcase export must never ship a player's reference photos")

    status, headers, body = comfy_node.forward(srv, "GET", f"/api/history_picture?id={sid}&slot=weapon", [])
    ck(status == 200 and dict(headers).get("Content-Type") == "image/jpeg" and body[:2] == b"\xff\xd8",
       f"/api/history_picture did not serve the weapon picture: {status}")
    for bad_path in (f"/api/history_picture?id={sid}&slot=wall",
                     f"/api/history_picture?id={sid}&slot=../meta.json",
                     "/api/history_picture?id=../../etc&slot=weapon"):
        status, _, _ = comfy_node.forward(srv, "GET", bad_path, [])
        ck(status == 404, f"{bad_path} should be a 404, got {status}")
finally:
    srv.SESSIONS_DIR = real_sessions
    srv.forget_session_rows()

# ---- "reference": the picture goes to FLUX Kontext itself ------------------------------
# Options' hidden Attachments row. The default is the picture as a real reference; "describe"
# is everything above on its own.
ck(srv.PICTURE_MODE_DEFAULT == "reference" and set(srv.PICTURE_MODES) == {"reference", "describe"},
   f"reference must be the default attachment mode: {srv.PICTURE_MODE_DEFAULT} {srv.PICTURE_MODES}")

# Staged flattened onto white (Kontext wants RGB) at KONTEXT_REF_PX on the long side, in 16s.
real_input = srv.COMFY_INPUT_DIR
srv.COMFY_INPUT_DIR = TMP
try:
    buf = io.BytesIO()
    see_through = Image.new("RGBA", (1000, 700), (255, 0, 0, 255))
    see_through.paste((0, 0, 0, 0), (0, 0, 100, 100))
    see_through.save(buf, "PNG")
    name = srv._stage_reference("data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
                                "picture_enemy")
    staged = Image.open(os.path.join(TMP, name))
    ck(staged.mode == "RGB" and max(staged.size) == srv.KONTEXT_REF_PX
       and all(n % 16 == 0 for n in staged.size), f"staged reference is {staged.mode} {staged.size}")
    ck(staged.getpixel((2, 2)) == (255, 255, 255), "a transparent corner must stage as white, not black")
    ck(srv._stage_reference("data:image/png;base64,bm90IGFuIGltYWdl", "picture_wall") is None,
       "an unreadable picture should stage as None and be described instead")
finally:
    srv.COMFY_INPUT_DIR = real_input

# The instructions. The hero's picture order is what "first"/"second" point at.
both = srv.kontext_hero_prompt("man in a white cap", "plastic toy brick", True, True)
ck("from the first picture" in both
   and "grip their weapon, clearly visible and held out from the body: the object from the "
       "second picture, plastic toy brick." in both, both)
ck("back view" in both and "white background" in both, "the hero is still drawn from behind on white")
# The line that came back empty-handed on the first real run: it has to stay its own sentence.
pile = srv.kontext_hero_prompt("man", "pile of colorful plastic bricks held in hand, each with "
                               "visible stud tops", True, True)
ck("second picture, pile of colorful plastic bricks held in hand, each with visible stud tops. "
   "Keep their" in pile, pile)
alone = srv.kontext_hero_prompt("man in a white cap", "sword", True, False)
ck("from this picture" in alone and "from the body: a sword." in alone and "second" not in alone, alone)
wonly = srv.kontext_hero_prompt("", "plastic toy brick", False, True)
ck(wonly.startswith("Draw an armored warrior knight")
   and "the object from this picture, plastic toy brick." in wonly, wonly)
# A landscape photo's brief line keeps its landscape, which beat "remove any horizon".
ck(srv._surface_line("blue sky painted overhead with white cloud decals and thin black horizon line")
   == "blue sky painted overhead with white cloud decals", "the horizon must leave the ceiling line")
ck(srv._surface_line("grey flagstones, rolling hills beyond, moss in the cracks")
   == "grey flagstones, moss in the cracks", srv._surface_line("grey flagstones, rolling hills beyond, moss in the cracks"))
ck(srv._surface_line("green grass wallpaper with scattered white cloud motifs")
   == "green grass wallpaper with scattered white cloud motifs", "a line with no scenery is untouched")
ck(srv._hero_weapon_keep("pile of plastic bricks.") ==
   "The weapon stays exactly as it is - the same pile of plastic bricks - only its position changes.",
   srv._hero_weapon_keep("pile of plastic bricks."))
ck(set(srv.KONTEXT_HERO_POSES) == set(srv.V6_FRAME_NAMES) - {"idle"},
   "every hero frame but the idle needs a Kontext pose edit")
ck(set(srv.KONTEXT_FOE_POSES) >= set(srv._enemy_variant_frames("walker", True)) - {"idle"},
   "every walker frame, the strike included, needs a Kontext pose edit")
ck("Remove any horizon" in srv.kontext_surface_prompt("bright blue sky."), "surfaces must drop the scene")
ck(srv.kontext_surface_prompt("bright blue sky.").endswith("bright blue sky."), "one full stop")

# A surface Kontext handed back as the picture itself (sky over ground) goes to FLUX schnell.
hill = Image.new("RGB", (64, 64), (60, 120, 230))
hill.paste((70, 160, 40), (0, 32, 64, 64))
hill_path = os.path.join(TMP, "hill.png")
hill.save(hill_path)
grass = Image.effect_noise((64, 64), 40).convert("RGB")
grass = Image.merge("RGB", (grass.getchannel(0).point(lambda v: v // 3),
                            grass.getchannel(0), grass.getchannel(0).point(lambda v: v // 4)))
grass_path = os.path.join(TMP, "grass.png")
grass.save(grass_path)
ck(srv._surface_scene_split(hill_path) > srv.KONTEXT_SURFACE_MAX_SPLIT,
   f"a sky-over-ground picture must read as a scene: {srv._surface_scene_split(hill_path):.0f}")
ck(srv._surface_scene_split(grass_path) < srv.KONTEXT_SURFACE_MAX_SPLIT,
   f"an even texture must not: {srv._surface_scene_split(grass_path):.0f}")
real_job = srv._kontext_ref_job
srv._kontext_ref_job = lambda *a, **kw: {"wall": hill_path, "ceiling": grass_path, "floor": grass_path}
try:
    got = srv.generate_kontext_surfaces("bliss.png", {"wall": "fields under a sky"}, "field", 512)
    ck(got == {"ceiling": grass_path, "floor": grass_path},
       f"only the surface that came back as the picture should be dropped: {got}")
    srv._kontext_ref_job = lambda *a, **kw: {"wall": hill_path}
    ck(srv.generate_kontext_surfaces("bliss.png", None, "field", 512) is None,
       "nothing usable should read as no Kontext surfaces at all")
finally:
    srv._kontext_ref_job = real_job

# The graphs: stage 1 draws on an empty latent with every picture chained on in order; stage 2
# edits the drawing on its own latent; keep_rgb also saves it unmatted.
real_submit = srv._krea2_submit_and_collect
sent = []
srv._krea2_submit_and_collect = lambda b, keys, **kw: (sent.append((b, keys, kw))
                                                       or {k: f"{k}.png" for k in keys})
try:
    srv._kontext_ref_job(["me.png", "brick.png"], {"hero": "x"}, 7, size=512, alpha=False)
    b, keys, _ = sent[-1]
    ck(b["hero_samp"]["inputs"]["latent_image"] == ["draw_lat", 0]
       and b["draw_lat"]["inputs"]["width"] == 512, "stage 1 must draw on a fresh 512 latent")
    ck(b["hero_ref0"]["inputs"]["conditioning"] == ["hero_pos", 0]
       and b["hero_ref1"]["inputs"]["conditioning"] == ["hero_ref0", 0]
       and b["hero_ref1"]["inputs"]["latent"] == ["ref1_enc", 0]
       and b["hero_g"]["inputs"]["conditioning"] == ["hero_ref1", 0],
       "both pictures must be chained on as ReferenceLatent, in order")
    ck(keys == ["hero"] and b["hero_save"]["class_type"] == "SaveImage", f"plain RGB save: {keys}")
    srv._kontext_ref_job(["drawn.png"], {"block": "x", "hurt": "y"}, 7, with_source=True,
                         seeds={"hurt": 9}, guidances={"block": 6.0})
    b, keys, _ = sent[-1]
    ck(b["block_g"]["inputs"]["guidance"] == 6.0
       and b["hurt_g"]["inputs"]["guidance"] == srv.KONTEXT_REF_GUIDANCE, "per-pose guidance")
    ck(b["block_samp"]["inputs"]["latent_image"] == ["ref0_enc", 0] and "draw_lat" not in b,
       "stage 2 must edit the drawing on its own latent")
    ck(keys == ["source", "block", "hurt"] and b["hurt_samp"]["inputs"]["seed"] == 9
       and b["block_samp"]["inputs"]["seed"] == 7, f"source matte + per-pose seeds: {keys}")
    srv._kontext_ref_job(["enemy.png"], {"foe": "x"}, 7, size=512, keep_rgb=True)
    ck(sent[-1][1] == ["foe", "foe_rgb"], f"keep_rgb should save the drawing twice: {sent[-1][1]}")
finally:
    srv._krea2_submit_and_collect = real_submit

# The bundle: a pictured part skips its krea2 share, and a Kontext failure falls back to it.
real = {k: getattr(srv, k) for k in (
    "generate_kontext_hero_frames", "generate_kontext_reference_enemy", "generate_enemy_species",
    "_krea2_submit_and_collect", "keep_largest_figure", "crop_frames_to_common_bbox",
    "_krea2_finish_enemy_variants", "generate_kontext_portrait_set")}
krea2_keys, portrait_refs = [], []
srv.generate_enemy_species = lambda style, **kw: None
srv._krea2_submit_and_collect = lambda b, keys, **kw: (krea2_keys.append(list(keys))
                                                       or {k: f"{k}.png" for k in keys})
srv.keep_largest_figure = lambda *a, **kw: None
srv.crop_frames_to_common_bbox = lambda *a, **kw: None
srv._krea2_finish_enemy_variants = lambda *a, **kw: {"walker": {"idle": "krea2_walker.png"}}
srv.generate_kontext_portrait_set = lambda style, size=256, ref=None, form=None: (portrait_refs.append(ref)
                                                                      or ["p.png"] * 4)
try:
    srv.generate_kontext_hero_frames = lambda refs, p, w, size, form=None, steps=None: [f"kx_{n}.png" for n in srv.V6_FRAME_NAMES]
    srv.generate_kontext_reference_enemy = lambda ref, look, size, last_attack_frame=False, form=None: {
        "walker": {"idle": "kx_walker.png"}}
    out = srv.generate_krea2_posed_bundle("man", "brick", "cat", refs={
        "player": "me.png", "weapon": "brick.png", "enemy": "cat.png"})
    ck(krea2_keys == [], f"with every line pictured krea2 should draw nothing: {krea2_keys}")
    ck(out["frames"][0] == "kx_idle.png" and out["enemies"]["walker"]["idle"] == "kx_walker.png",
       "the Kontext drawings must be what ships")
    ck(out["ref_drawn"] == ["player", "weapon", "enemy"] and portrait_refs[-1] == "me.png",
       f"ref_drawn / portrait ref: {out['ref_drawn']} {portrait_refs}")

    krea2_keys.clear()
    srv.generate_kontext_hero_frames = lambda refs, p, w, size, form=None, steps=None: None      # Kontext fell over
    out = srv.generate_krea2_posed_bundle("man", "brick", "cat", refs={"weapon": "brick.png",
                                                                       "enemy": "cat.png"})
    ck(krea2_keys and krea2_keys[0] == srv.V6_FRAME_NAMES,
       f"a failed Kontext hero must be drawn by krea2, and only the hero: {krea2_keys}")
    ck(out["ref_drawn"] == ["enemy"] and portrait_refs[-1] is None,
       f"a fallen-back hero is not reference-drawn: {out['ref_drawn']}")

    krea2_keys.clear()
    out = srv.generate_krea2_posed_bundle("man", "brick", "cat")
    ck(krea2_keys and krea2_keys[0][:len(srv.V6_FRAME_NAMES)] == srv.V6_FRAME_NAMES
       and any(k.startswith("enemy_") for k in krea2_keys[0]) and out["ref_drawn"] == [],
       f"no pictures must be exactly the krea2 bundle it always was: {krea2_keys}")
finally:
    for k, v in real.items():
        setattr(srv, k, v)

# The progress plan swaps each pictured part's krea2 share for its Kontext stages.
plain = [j[0] for j in srv._plan_v6(8)]
ck("frames" in plain and "hero_poses" not in plain and "wall_ref" not in plain, plain)
every = [j[0] for j in srv._plan_v6(8, refs={"wall", "player", "weapon", "enemy"})]
ck("frames" not in every and "enemy_species" not in every
   and {"wall_ref", "hero_ref", "hero_poses", "enemy_ref", "enemy_poses", "enemy_variants"} <= set(every),
   f"plan with every line pictured: {every}")
half = srv._plan_v6(8, refs={"weapon"})
frames = next(j for j in half if j[0] == "frames")
ck(frames[3] == srv._enemy_frame_count(False) * 8 and "hero_poses" in [j[0] for j in half],
   f"a pictured weapon leaves krea2 only the foes: {frames}")

# A pictured hero carries no shield until the block raises one - named anywhere else, Kontext
# slung it across the hero's back like a bookbag in every frame.
hero_p = srv.kontext_hero_prompt("man in a white cap", "sword", True, False)
ck("shield" not in hero_p.lower(), f"the hero drawing names a shield: {hero_p!r}")
ck("shield" not in srv.KONTEXT_HERO_KEEP.lower(), "the pose edits' keep tail names a shield")
ck([n for n, t in srv.KONTEXT_HERO_POSES.items() if "shield" in t.lower()] == ["block"],
   "only the block edit may raise a shield")
# ...and is turned to face away before it is posed. Naming the face turned the hero round.
ck("back is to the camera" in srv.KONTEXT_HERO_TURN and "face" not in srv.KONTEXT_HERO_TURN.lower(),
   "the turn-around edit must ask for the back and never name the face")
import inspect
ck("_kontext_turn_hero" in inspect.getsource(srv.generate_kontext_hero_frames),
   "the hero is posed without being turned around first")
# The turn runs only on a drawing that faces front, and again until it doesn't.
_saved = (srv._vlm_hero_view, srv._kontext_ref_job, srv._to_input)
try:
    srv._to_input = lambda p, tag: p
    calls = []
    def fake_job(refs, branches, seed, **kw):
        calls.append(seed)
        return {"turn": f"turned{len(calls)}.png"}
    srv._kontext_ref_job = fake_job
    srv._vlm_hero_view = lambda p: "back"
    ck(srv._kontext_turn_hero("drawn.png", 1) == "drawn.png" and not calls,
       "a drawing already facing away must be left alone")
    views = iter(["front", "front", "back"])
    srv._vlm_hero_view = lambda p: next(views)
    ck(srv._kontext_turn_hero("drawn.png", 1) == "turned2.png" and len(calls) == 2,
       f"a front-facing drawing must be turned until it faces away: {calls}")
    calls.clear()
    srv._vlm_hero_view = lambda p: "front"
    ck(srv._kontext_turn_hero("drawn.png", 1) == f"turned{srv.KONTEXT_HERO_TURN_ATTEMPTS}.png"
       and len(calls) == srv.KONTEXT_HERO_TURN_ATTEMPTS, "the turn must give up after its attempts")
finally:
    srv._vlm_hero_view, srv._kontext_ref_job, srv._to_input = _saved

# The weapon is named inside every pose, by its name alone - "the weapon" drew a curved sword.
for desc, want in (("soft white plush with rounded limbs, smiling face", "soft white plush"),
                   ("pile of colorful plastic bricks in red, blue, green, yellow", "pile of colorful plastic bricks"),
                   ("rusty iron sword", "rusty iron sword"), ("", "sword")):
    ck(srv._weapon_short(desc) == want, f"weapon short name of {desc!r}: {srv._weapon_short(desc)!r}")
src_hero = inspect.getsource(srv.generate_kontext_hero_frames)
ck("_kontext_hold_weapon" in src_hero and "replace('the weapon', wname)" in src_hero,
   "the hero is posed without its weapon in hand, or with 'the weapon' left unnamed")
ck(all("the weapon" in srv.KONTEXT_HERO_POSES[n] for n in ("windup", "slash1", "slash2", "slash3")),
   "a swing pose no longer says 'the weapon', so the weapon's name never replaces it")
# The weapon goes into a hand only when it is not in one, and again until it is.
_saved = (srv._vlm_weapon_where, srv._kontext_ref_job, srv._to_input)
try:
    srv._to_input = lambda p, tag: p
    calls = []
    def fake_job(refs, branches, seed, **kw):
        calls.append((list(refs), branches["hold"]))
        return {"hold": f"held{len(calls)}.png"}
    srv._kontext_ref_job = fake_job
    srv._vlm_weapon_where = lambda p, w: "hand"
    ck(srv._kontext_hold_weapon("drawn.png", "plush", "plush_ref.png", 1) == "drawn.png" and not calls,
       "a weapon already in hand must be left alone")
    answers = iter(["back", "none", "hand"])
    srv._vlm_weapon_where = lambda p, w: next(answers)
    got_hold = srv._kontext_hold_weapon("drawn.png", "plush", "plush_ref.png", 1)
    ck(got_hold == "held2.png" and len(calls) == 2, f"a weapon on the back must be moved into a hand: {calls}")
    ck(calls[0][0] == ["drawn.png", "plush_ref.png"] and "the plush from the second picture" in calls[0][1],
       "the hold edit must see the weapon's own picture and name it")
    calls.clear()
    srv._vlm_weapon_where = lambda p, w: "back"
    ck(srv._kontext_hold_weapon("drawn.png", "plush", None, 1) == "drawn.png"
       and len(calls) == srv.KONTEXT_HERO_HOLD_ATTEMPTS and calls[0][0] == ["drawn.png"],
       "after its attempts the hold must keep the drawing (a weapon on the back beats none)")
finally:
    srv._vlm_weapon_where, srv._kontext_ref_job, srv._to_input = _saved
ck("hero_turn" in [j[0] for j in srv._plan_v6(8, refs={"player"})], "the turn step is not on the progress bar")

# Only the weapon pictured: krea2 draws the hero from the words and Kontext only swaps the weapon
# in. Kontext drawing the whole hero turned "Jar Jar Binks" with a lightsaber picture into a Sith.
_names = ("_krea2_submit_and_collect", "_kontext_ref_job", "_to_input", "_kontext_turn_hero",
          "_kontext_hold_weapon", "_kontext_unstick")
_saved = {k: getattr(srv, k) for k in _names}
try:
    krea2_sent, kx_calls = [], []
    def fake_krea2(b, keys, **kw):
        krea2_sent.append((b, list(keys), kw.get("job_key")))
        return {k: f"krea2_{k}.png" for k in keys}
    def fake_kx(refs, branches, seed, **kw):
        kx_calls.append((list(refs), dict(branches), kw))
        return {n: f"kx_{n}.png" for n in list(branches) + (["source"] if kw.get("with_source") else [])}
    srv._krea2_submit_and_collect, srv._kontext_ref_job = fake_krea2, fake_kx
    srv._to_input = lambda p, tag: f"in_{p}"
    srv._kontext_turn_hero = lambda drawn, seed: drawn
    srv._kontext_hold_weapon = lambda drawn, name, pic, seed: drawn
    srv._kontext_unstick = lambda *a, **kw: []
    frames = srv.generate_kontext_hero_frames({"weapon": "saber.png"}, "Jar Jar Binks, the real character",
                                              "glowing pink lightsaber.", 512, steps=6)
    ck(frames is not None and len(krea2_sent) == 1, f"a weapon-only hero must be drawn by krea2: {krea2_sent}")
    b, keys, job = krea2_sent[0]
    ck(keys == ["shield", "hero"] and job == "hero_draw" and b["hero_samp"]["inputs"]["steps"] == 6
       and "Jar Jar Binks" in b["hero_pos"]["inputs"]["text"]
       and "picture" not in b["hero_pos"]["inputs"]["text"],
       f"krea2 draws the hero from the words, no picture named: {b['hero_pos']['inputs']['text']!r}")
    ck(all(b[f"{n}_save"]["class_type"] == "SaveImage" and f"{n}_mask" not in b for n in keys),
       "the krea2 hero and shield go into Kontext on their white background, so they must be saved unmatted")
    ck("The back of a round battle shield painted in Jar Jar Binks" in b["shield_pos"]["inputs"]["text"],
       f"the shield must be this hero's own, from behind: {b['shield_pos']['inputs']['text']!r}")
    refs0, br0, kw0 = kx_calls[0]
    ck(refs0 == ["in_krea2_hero.png", "saber.png"] and list(br0) == ["swap"] and "size" not in kw0
       and "second picture, glowing pink lightsaber, gripped" in br0["swap"] and kw0["job_key"] == "hero_ref",
       f"the swap edits the krea2 drawing with the weapon's picture second: {kx_calls[0]}")
    # The block raises the shield from its own picture, in a job of its own - every edit in a job
    # sees the same pictures, and any other pose given it would grow a shield.
    block_jobs = [c for c in kx_calls if "block" in c[1]]
    pose_jobs = [c for c in kx_calls if "windup" in c[1]]
    ck(len(block_jobs) == 1 and list(block_jobs[0][1]) == ["block"]
       and block_jobs[0][0] == ["in_kx_swap.png", "in_krea2_shield.png"]
       and "from the second picture" in block_jobs[0][1]["block"],
       f"the block must be its own edit, with the shield's back as its second picture: {block_jobs}")
    ck(len(pose_jobs) == 1 and pose_jobs[0][0] == ["in_kx_swap.png"] and "block" not in pose_jobs[0][1],
       f"no other pose may see the shield's picture: {pose_jobs}")
    ck(os.path.isfile(srv.KONTEXT_SHIELD_BACK), f"the shield's picture is missing: {srv.KONTEXT_SHIELD_BACK}")
    krea2_sent.clear()
    kx_calls.clear()
    srv.generate_kontext_hero_frames({"player": "me.png", "weapon": "saber.png"}, "man", "sword", 512)
    ck(kx_calls[0][0] == ["me.png", "saber.png"] and kx_calls[0][2].get("size") == 512,
       "a pictured player is still drawn by Kontext from the pictures")
    ck([k for _b, k, _j in krea2_sent] == [["shield"]] and krea2_sent[0][2] == "hero_shield",
       f"a pictured player's krea2 job draws only the shield: {[(k, j) for _b, k, j in krea2_sent]}")
    # A shield krea2 could not draw costs the block only its colours, never the hero.
    def broken_krea2(b, keys, **kw):
        raise RuntimeError("krea2 fell over")
    srv._krea2_submit_and_collect = broken_krea2
    kx_calls.clear()
    frames = srv.generate_kontext_hero_frames({"player": "me.png"}, "man", "sword", 512)
    block_jobs = [c for c in kx_calls if "block" in c[1]]
    ck(frames is not None and block_jobs and block_jobs[0][0][1] == f"in_{srv.KONTEXT_SHIELD_BACK}",
       f"a failed shield drawing must fall back on the plain wooden one: {block_jobs}")
finally:
    for k, v in _saved.items():
        setattr(srv, k, v)
wplan = [j[0] for j in srv._plan_v6(8, refs={"weapon"})]
ck(wplan.index("hero_draw") < wplan.index("hero_ref") and "hero_turn" not in wplan,
   f"a weapon-only plan draws with krea2 first and plans no turn (krea2's back view held 7 of 7): {wplan}")
_pplan = [j[0] for j in srv._plan_v6(8, refs={"player", "weapon"})]
ck("hero_draw" not in _pplan and _pplan.index("hero_shield") < _pplan.index("hero_ref"),
   f"a pictured player has no krea2 hero drawing, only its shield, before Kontext: {_pplan}")

# A derived flyer/boss is posed like the walker, and its idle is REDRAWN on white in that job - a
# boss edit that painted fire behind it lost its head when the cut-out was cut out again.
pose_src = inspect.getsource(srv._kontext_pose_foe)
ck('job["idle"]' in pose_src and "KONTEXT_FOE_IDLE" in pose_src and "white background" in srv.KONTEXT_FOE_IDLE,
   "a derived foe's idle is no longer redrawn on white")
ck("_kontext_pose_foe" in inspect.getsource(srv.generate_kontext_reference_enemy)
   and 'f"{v}_poses"' in inspect.getsource(srv.generate_kontext_reference_enemy),
   "the flyer and the boss are no longer posed")
plan_ref = {k: w for k, _l, w, _u in srv._plan_v6(8, refs={"enemy"})}
ck("flyer_poses" in plan_ref and "boss_poses" in plan_ref, f"the flyer/boss poses are not on the bar: {sorted(plan_ref)}")
# The portrait retry: a photo bust retries with the looser keep and keeps whichever moved more;
# a bust from typed words keeps its old retry exactly.
port_src = inspect.getsource(srv.generate_kontext_portrait_set)
ck("edits=KONTEXT_EXPRESSION_RETRY if ref else None" in port_src and "if d > diffs[n]" in port_src
   and "if not ref:" in port_src, "the portrait retry lost its photo-only keep-the-better rule")
ck(all("glasses" in t and "exact same face" not in t for t in srv.KONTEXT_EXPRESSION_RETRY.values())
   and set(srv.KONTEXT_EXPRESSION_RETRY) == set(srv.KONTEXT_EXPRESSION_EDITS),
   "the retry wording must keep the person (and glasses) but not pin the exact face")

# A photo bust pushed off to one side (half a face at the frame's edge) is redrawn.
tmp_bust = tempfile.mkdtemp()
atexit.register(shutil.rmtree, tmp_bust, True)
for name, box in (("centred", (30, 10, 70, 100)), ("edge", (70, 10, 100, 100))):
    im = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    im.paste((200, 150, 120, 255), box)
    im.save(os.path.join(tmp_bust, name + ".png"))
ck(srv._bust_offset(os.path.join(tmp_bust, "centred.png")) <= srv.KONTEXT_BUST_MAX_OFFSET
   < srv._bust_offset(os.path.join(tmp_bust, "edge.png")), "the off-centre bust check no longer separates them")
ck("centred in the middle of the frame" in srv.kontext_bust_prompt("man"), "the photo bust no longer asks to be centred")

# A pictured foe's boss keeps the picture (bigger, glowing eyes) instead of the scorched recolour,
# which repainted a person charred red-black; typed runs keep the recolour.
ref_src = inspect.getsource(srv.generate_kontext_reference_enemy)
ck("_kontext_pictured_boss(" in ref_src and 'variants=["flyer"]' in ref_src,
   "a pictured foe's boss is no longer drawn from its picture")
ck("second picture" in srv.KONTEXT_PICTURED_BOSS_EDIT and "scorched" not in srv.KONTEXT_PICTURED_BOSS_EDIT
   and srv.KONTEXT_ENEMY_EDITS["boss"]["edit"] == srv.KONTEXT_BOSS_EDIT,
   "the pictured boss edit must keep the picture, and typed runs the old recolour")

# A pictured OBJECT player or enemy is made a character built from it, not a man in its colours
# (a blue sports car came back a man in a blue sweater, a silver one's block frame a man in
# black); people, animals, plush toys and unread pictures are drawn as they always were.
for kind, want in (("car", True), ("sports car", True), ("brick", True), ("fish", True),
                   ("man", False), ("cat", False), ("robot", False), ("plush", False),
                   ("teddy bear", False), (None, False), ("", False)):
    ck(srv._picture_is_object(kind) == want, f"_picture_is_object({kind!r}) should be {want}")
car = {"kind": "car", "look": "blue sports car with black rims", "form": "robot"}
ck(srv._picture_form_look(car) == "robot built out of a blue sports car with black rims, the whole car forming its upper body",
   srv._picture_form_look(car))
bricks = {"kind": "brick", "look": "pile of plastic bricks", "form": "living"}
ck(srv._picture_form_look(bricks) == "living brick character with arms and legs, pile of plastic bricks",
   srv._picture_form_look(bricks))
ck(srv._picture_form_look({"kind": "man", "look": "man in a cap"}) == "man in a cap",
   "a person's LOOK must be left alone")
formed = srv.resolve_named_styles("", "Skyline", "", "", pictures={"player": car})
ck(formed["text"]["player"] == formed["clean"]["player"] == srv._picture_form_look(car)
   and formed["story"]["player"].endswith("called Skyline"),
   f"the character, not the bare car, is what every reader gets: {formed['text']['player']!r}")
# describe_pictures asks the machine question of an object player's or enemy's photo only.
_saved = (srv._stage_picture, srv._describe_attempt, srv._vlm_wants_rotors, srv.COMFY_INPUT_DIR)
try:
    asked = []
    srv.COMFY_INPUT_DIR = "in"
    srv._stage_picture = lambda url, tag: tag + ".png"
    reads = {"picture_player": {"kind": "car", "look": "blue sports car"},
             "picture_enemy": {"kind": "car", "look": "silver sports car"}}
    srv._describe_attempt = lambda slot, name, prompt=None: "NONE" if prompt else dict(reads[name[:-4]])
    srv._vlm_wants_rotors = lambda path: asked.append(os.path.basename(path)) or True
    got = srv.describe_pictures({"player": "x", "enemy": "y"})
    ck(got["player"].get("form") == got["enemy"].get("form") == "robot"
       and asked == ["picture_player.png", "picture_enemy.png"], f"form: {got} asked {asked}")
    reads["picture_weapon"] = {"kind": "sword", "look": "steel sword"}
    asked.clear()
    ck("form" not in srv.describe_pictures({"weapon": "z"})["weapon"] and not asked,
       "a weapon is never made a character")
    srv._vlm_wants_rotors = lambda path: False
    ck(srv.describe_pictures({"player": "x"})["player"]["form"] == "living", "a non-machine is living")
    reads["picture_player"] = {"kind": "man", "look": "man in a cap"}
    asked.clear()
    srv._vlm_wants_rotors = lambda path: asked.append(path) or True
    ck("form" not in srv.describe_pictures({"player": "x"})["player"] and not asked,
       "a person must not be asked the machine question")
finally:
    srv._stage_picture, srv._describe_attempt, srv._vlm_wants_rotors, srv.COMFY_INPUT_DIR = _saved
hero_car = srv.kontext_hero_prompt(srv._picture_form_look(car), "sword", True, True, form=car)
ck(hero_car.startswith("Turn the car from the first picture into") and "robot" in hero_car
   and "blue sports car with black rims" in hero_car and "face" not in hero_car.lower()
   and "hair" not in hero_car.lower(), f"object hero prompt: {hero_car!r}")
ck(srv.kontext_hero_prompt("man in a cap", "sword", True, False, form=None)
   == srv.kontext_hero_prompt("man in a cap", "sword", True, False),
   "a person's hero prompt must not change")
ck(srv.kontext_hero_prompt("sword", "sword", False, True, form=car).startswith("Draw a sword"),
   "a form without a player picture must not reach the prompt")
bust_bricks = srv.kontext_bust_prompt("x", bricks)
ck("living character built out of the brick" in bust_bricks and "centred in the middle" in bust_bricks,
   bust_bricks)
ck(srv.kontext_bust_prompt("man") == srv.kontext_bust_prompt("man", None), "a person's bust changed")
src_bundle = inspect.getsource(srv.generate_krea2_posed_bundle)
ck("form=hero_form" in src_bundle and "form=enemy_form" in src_bundle,
   "the player's / enemy's form no longer reach the Kontext drawers")
ecar = {"kind": "car", "look": "silver sports car with black stripes", "form": "robot"}
foe_car = srv.kontext_foe_prompt(srv._picture_form_look(ecar), ecar)
ck(foe_car.startswith("Turn the car from this picture into") and "whole car" in foe_car
   and "upper body" in foe_car and "silver sports car with black stripes" in foe_car
   and "face" not in foe_car.lower(), f"object foe prompt: {foe_car!r}")
ck(srv.kontext_foe_prompt("man in a tee") == srv.kontext_foe_prompt("man in a tee", None),
   "a person's foe prompt must not change")
ck("_kontext_pictured_boss(got[\"idle\"], ref, size, form)" in ref_src
   and "kontext_foe_prompt(look, form)" in ref_src, "the enemy's form no longer reaches its drawings")
# ...and a pictured object's boss stays that object (a car's boss came back an ogre with red eyes).
_saved = (srv._kontext_ref_job, srv._foe_pose_canvas, srv.keep_largest_figure, srv._save_tight)
try:
    edits = []
    srv._foe_pose_canvas = lambda *a: "canvas.png"
    srv.keep_largest_figure = srv._save_tight = lambda *a, **kw: None
    srv._kontext_ref_job = lambda refs, br, seed, **kw: edits.append(br["boss"]) or {"boss": "b.png"}
    srv._kontext_pictured_boss("w.png", "ref.png", 512, ecar)
    srv._kontext_pictured_boss("w.png", "ref.png", 512, {"kind": "fish", "look": "fish", "form": "living"})
    srv._kontext_pictured_boss("w.png", "ref.png", 512, None)
    srv._kontext_pictured_boss("w.png", "ref.png", 512)
    ck(edits[0].startswith("Make this robot the boss version of itself")
       and "the car in the second picture" in edits[0] and "face" not in edits[0],
       f"a robot boss must stay the robot built out of that car: {edits[0]!r}")
    ck("same fish character" in edits[1], f"a living boss: {edits[1]!r}")
    ck(edits[2] == edits[3] == srv.KONTEXT_PICTURED_BOSS_EDIT, "a person's boss edit changed")
finally:
    srv._kontext_ref_job, srv._foe_pose_canvas, srv.keep_largest_figure, srv._save_tight = _saved

# Every pose says how the weapon is held, and no longer hands Kontext the weapon's picture (it
# copied a diagonally-photographed sword as a loose object, held by the blade).
ck("KONTEXT_HERO_GRIP.format" in src_hero and "_kontext_ref_job([src], edits" in src_hero
   and "handle" in srv.KONTEXT_HERO_GRIP and "Only one" in srv.KONTEXT_HERO_GRIP,
   "the hero's poses no longer say how the weapon is gripped")

print("FAIL" if fails else "all picture-slot checks passed")
