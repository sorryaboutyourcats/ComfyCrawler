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
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)
sys.path.insert(0, ROOT)
import comfy_node
from PIL import Image

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

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

print("FAIL" if fails else "all picture-slot checks passed")
