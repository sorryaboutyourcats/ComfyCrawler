"""Offline checks on the 30-second trailers (<site>/trailer, /trailer2 and /trailer11 - one
trailer.js, a <name>.json cast each; trailer11.json "extends" trailer.json):

- each page, trailer.js, each json and each track are served (standalone and, through the same
  handler, inside ComfyUI), and /trailer/ and /trailer2/ are sent back without the slash;
- every game.js name trailer.js leans on (its TRAILER_NEEDS list) still exists, so a rename in
  game.js fails here instead of breaking a trailer silently;
- trailer.json (script v1) and trailer2.json (script v2) have the cast their shot lists expect, and
  each beat grid covers the 64 beats a shot list uses at about 30 seconds;
- the showcase export ships both (pages, files, trimmed bundles) and trims them the way
  trailer.js loads them;
- game.js keeps a trailer from writing anything a player's own game remembers.

Needs neither ComfyUI nor a browser - playing them is a headless-Chrome job (see the
headless-chrome notes)."""
import importlib.util, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)
spec = importlib.util.spec_from_file_location("comfy_node", os.path.join(ROOT, "comfy_node.py"))
cn = importlib.util.module_from_spec(spec); spec.loader.exec_module(cn)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import export_showcase  # noqa: E402

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()

GAME, TRAILER, PAGE = read("game.js"), read("trailer.js"), read("index.html")
RAW = {name: json.loads(read(f"{name}.json")) for name in srv.TRAILERS}
# A json that "extends" another is read merged over it - as trailer.js and the export read it.
CFGS = {name: ({**RAW[cfg["extends"]], **cfg} if cfg.get("extends") else cfg) for name, cfg in RAW.items()}
ID = re.compile(r"\d{8}-\d{6}-[0-9a-f]{6}")

ck(srv.TRAILERS == ("trailer", "trailer2", "trailer11", "trailer12", "trailer12m"),
   f"server.TRAILERS lists all four trailers (got {srv.TRAILERS})")
ck(export_showcase.read_trailers() == CFGS, "the export reads the trailers (extends and all) as this test does")

# ---- served ----
for path in ("/trailer", "/trailer2", "/trailer11", "/trailer12", "/trailer12m", "/?trailer", "/?trailer=2", "/?trailer=11", "/trailer?x=1"):
    status, pairs, body = cn.forward(srv, "GET", path, [])
    ck(status == 200 and b"<title>" in body and b'src="game.js"' in body,
       f"GET {path} serves the page (got {status})")
for name in srv.TRAILERS:
    for path in (f"/{name}/", f"/{name}/index.html"):
        status, pairs, body = cn.forward(srv, "GET", path, [])
        loc = {k.lower(): v for k, v in pairs}.get("location")
        ck(status == 301 and loc == f"../{name}", f"GET {path} redirects to ../{name} (got {status} {loc})")
    status, pairs, body = cn.forward(srv, "GET", f"/{name}.json", [])
    ctype = {k.lower(): v for k, v in pairs}.get("content-type", "")
    ck(status == 200 and "json" in ctype and json.loads(body) == RAW[name], f"GET /{name}.json serves the cast (got {status})")
    if "phone" in CFGS[name]:
        continue   # a phone frame round another trailer - no cast, no track of its own
    music = CFGS[name]["music"]["file"].split("/")[-1]
    if not RAW[name].get("extends"):
        ck(music == f"{name}_music.wav", f"{name}.json plays sounds/{name}_music.wav (names {music})")
    ck(music in srv.STATIC_SOUND_FILES, f"{music} is on the /sounds/ whitelist")
    if os.path.exists(os.path.join(ROOT, "sounds", music)):
        status, _, body = cn.forward(srv, "GET", "/sounds/" + music, [])
        ck(status == 200 and body[:4] == b"RIFF", f"GET /sounds/{music} serves the track")
    else:
        print(f"  (sounds/{music} not on disk yet - pick one from sounds/trailer_candidates/)")
status, pairs, body = cn.forward(srv, "GET", "/trailer.js", [])
ck(status == 200 and b"TRAILER_NEEDS" in body, f"GET /trailer.js serves the director (got {status})")
status, _, _ = cn.forward(srv, "GET", "/trailer3", [])
ck(status == 404, f"a trailer that doesn't exist is a 404 (got {status})")

# ---- the page finds its way back from /trailer/ and /trailer2/ ----
head = PAGE.split("<link", 1)[0]
ck("trailer\\d*" in head and "<base" in head,
   "index.html sets <base> for /trailerN/ before its first relative URL")
ck(r"trailer\d*" in GAME.split("const TRAILER_MODE", 1)[1][:200], "game.js's TRAILER_MODE matches /trailer2 too")

# ---- every game.js name trailer.js uses is still there ----
m = re.search(r"const TRAILER_NEEDS = \[(.*?)\];", TRAILER, re.S)
ck(m is not None, "found TRAILER_NEEDS in trailer.js")
needs = re.findall(r"'([A-Za-z_$][\w$]*)'", m.group(1)) if m else []
ck(len(needs) >= 50, f"read TRAILER_NEEDS ({len(needs)} names)")
for name in needs:
    defined = re.search(r"^\s*(?:async\s+)?function\s+" + re.escape(name) + r"\s*\(", GAME, re.M) \
        or re.search(r"^\s*(?:let|const|var)\s+" + re.escape(name) + r"\b", GAME, re.M)
    ck(defined, f"game.js still defines {name} (trailer.js uses it)")

# ---- each cast is what its shot list expects ----
scripts = set(re.findall(r"^\s{8}(v\d+): \{", TRAILER, re.M))
ck({"v1", "v2"} <= scripts, f"trailer.js has shot lists v1 and v2 (found {sorted(scripts)})")

def ck_caption(x, where):
    ck(len(x.get("caption", [])) == 2 and all(x["caption"]), f"{where} {x.get('id')} has a two-part caption")

def ck_clip(clip, where):
    ck(len(clip) == 2 and all(0 <= a < b <= 8.0 for a, b in clip), f"{where}'s ending clip has two 0-8s segments")

v1 = CFGS["trailer"]
ck(v1.get("script", "v1") == "v1", "trailer.json plays script v1")
hook = v1.get("hook", {})
ck(ID.fullmatch(hook.get("id", "")), "trailer.json has a hook dungeon id")
ck(set(hook.get("words", {})) == {"wall", "player", "weapon", "enemy"} and all(hook["words"].values()),
   "the hook fills all four of the wizard's blanks")
ck_clip(hook.get("clip", []), "the hook")
shots = [x.get("shot") for x in v1.get("montage", [])]
ck(sorted(shots) == ["block", "kill", "strike", "walk"], f"v1's montage is one walk/strike/block/kill each (got {shots})")
ck(len(v1.get("rush", [])) == 8, "v1's rush has eight cuts (trailer.js RUSH_CUTS)")
m = re.search(r"const RUSH_CUTS = \[([^\]]*)\]", TRAILER)
ck(m and len(m.group(1).split(",")) == len(v1.get("rush", [])), "RUSH_CUTS has one beat per rush dungeon")
for x in v1.get("montage", []) + v1.get("rush", []):
    ck_caption(x, "trailer.json")

v12m = RAW["trailer12m"]
ck(v12m.get("phone") == "trailer12" and v12m["phone"] in srv.TRAILERS, "trailer12m.json frames trailer 1.2")
ck(export_showcase.trailer_files(v12m) == {}, "the phone frame casts no dungeons of its own")
ck("forceTouchMedia" in TRAILER and "function buildPhone" in TRAILER and "?phone" in TRAILER,
   "trailer.js builds the phone frame and forces the touch layout inside it")
ck(r"trailer\d*m?" in GAME and r"trailer\d*m?" in PAGE, "game.js and index.html recognise /trailer12m")

v12 = RAW["trailer12"]
ck(v12.get("extends") == "trailer" and "mowmeow.net" in v12.get("outro", ""), "trailer12.json is trailer 1 ending on its outro line")
ck("cfg.outro" in TRAILER and "te-outro" in TRAILER, "the end card swaps its buttons for the outro line")

# trailer11: trailer 1, beat for beat, with the hero side-stepping in its fights.
v11 = RAW["trailer11"]
ck(v11.get("extends") == "trailer" and v11.get("strafe") is True, "trailer11.json extends trailer.json with strafe on")
ck(set(v11) <= {"about", "extends", "label", "strafe", "outro", "endHeight"}, f"trailer11.json only overrides what differs ({sorted(v11)})")
ck("if (cfg.strafe) strafeV1();" in TRAILER and "function strafeV1()" in TRAILER, "v1's shot list adds the side-steps when strafe is on")
sways = re.findall(r"sway\((\d+(?:\.\d+)?), (\d+(?:\.\d+)?), '(left|right)'\)", TRAILER)
ck(len(sways) >= 6 and all(float(a) < float(b) for a, b, _ in sways), f"strafeV1 has its side-steps ({len(sways)})")
ck({w for _, _, w in sways} == {"left", "right"}, "the side-steps go both ways")

v2 = CFGS["trailer2"]
ck(v2.get("script") == "v2", "trailer2.json plays script v2")
ck(ID.fullmatch(v2.get("death", {}).get("id", "")), "trailer2.json has a dungeon to die in")
words = v2.get("pitch", {}).get("words", {})
ck(set(words) == {"wall", "player", "weapon", "enemy"} and all(words.values()),
   "v2's Fill-in pitch has all four blanks")
shots = [x.get("shot") for x in v2.get("montage", [])]
ck(sorted(shots) == ["block", "dodge", "pack"], f"v2's fights are one dodge/pack/block each (got {shots})")
m = re.search(r"const PARADE_CUTS = \[([^\]]*)\]", TRAILER)
ck(m and len(m.group(1).split(",")) == len(v2.get("parade", [])), "PARADE_CUTS has one beat per parade foe")
for x in v2.get("montage", []) + v2.get("parade", []):
    ck_caption(x, "trailer2.json")
    ck(x.get("foe") in ("walker", "flyer", "boss", "swarmer", "circler"), f"{x.get('id')} names a foe the game has")
boss = v2.get("boss", {})
ck(ID.fullmatch(boss.get("id", "")), "trailer2.json has a boss dungeon")
ck_clip(boss.get("clip", []), "v2's boss")
ck(v2.get("tagline"), "trailer2.json has its own tagline")

for name, cfg in CFGS.items():
    if "phone" in cfg:
        continue
    beats = cfg.get("music", {}).get("beats", [])
    ck(len(beats) >= 65, f"{name}'s beat grid covers 64 beats and the last downbeat (has {len(beats)})")
    ck(all(b2 > b1 for b1, b2 in zip(beats, beats[1:])), f"{name}'s beats only ever go forward")
    if len(beats) >= 65:
        ck(abs((beats[64] - beats[0]) - 30.0) <= 0.5, f"{name}: 64 beats run about 30s (got {beats[64] - beats[0]:.2f}s)")
        gaps = [b - a for a, b in zip(beats, beats[1:65])]
        ck(max(gaps) < 1.25 * min(gaps), f"{name}: no beat is missing or doubled in the first 64")
ck(CFGS["trailer"]["music"]["file"] != CFGS["trailer2"]["music"]["file"], "the two trailers have different tracks")

# ---- the export ships them ----
for name in ["trailer.js"] + [f"{t}.json" for t in srv.TRAILERS]:
    ck(name in export_showcase.STATIC_SHELL_FILES, f"the showcase export ships {name}")
files = export_showcase.trailer_files(list(CFGS.values()))
fights = {hook.get("id")} | {x["id"] for x in v1.get("montage", [])}
for x in v1.get("rush", []):
    if x["id"] not in fights and x["id"] not in export_showcase.trailer_files(v2):
        ck(files.get(x["id"]) == {export_showcase.TRAILER_WALK}, f"rush-only dungeon {x['id']} ships just the walk copy")
for sid in export_showcase.trailer_files(v2):
    ck(export_showcase.TRAILER_FULL in files.get(sid, ()), f"v2 dungeon {sid} ships the fight copy")
both = set(export_showcase.trailer_files(v1)) & set(export_showcase.trailer_files(v2))
ck(any(files[sid] == {export_showcase.TRAILER_FULL, export_showcase.TRAILER_WALK} for sid in both),
   "a dungeon v1 walks through and v2 fights in ships both copies")
ck("trailer_walk.json" in TRAILER and "trailer_bundle.json" in TRAILER,
   "trailer.js asks for the same two trimmed copies the export writes")
sample = {"music": {"explore": "x"}, "story": {"hook": "h", "audio": ["a"], "outro_audio": "o"},
          "wall_texture": "w", "player_faces": ["f"], "player_sprites": ["p"], "enemy_variants": {"walker": {}}}
full, walk = export_showcase.trim_bundle(sample, False), export_showcase.trim_bundle(sample, True)
ck("music" not in full and full["story"] == {"hook": "h"} and "enemy_variants" in full,
   "the fight copy drops only narration and music")
ck("enemy_variants" not in walk and "player_sprites" not in walk and "player_faces" in walk
   and "wall_texture" in walk, "the walk copy drops the fighters but keeps the walls and the face")
ck(export_showcase.TRAILER_BASE_TAG.strip() == b'<base href="../">'
   and export_showcase.HTML_CHARSET_TAG.decode() in PAGE,
   "the export's trailer pages get their <base> right after the charset tag")

# ---- a trailer writes nothing ----
ck("const TRAILER_MODE" in GAME, "game.js defines TRAILER_MODE")
for fn in ("markRunPlayed", "markRunBeaten", "grantXp", "showVictoryBox", "screensaverBlocked",
           "prepareEndingCutscene", "playScreenMusic"):
    body = re.search(r"function " + fn + r"\([^)]*\) \{(.{0,600})", GAME, re.S)
    ck(body and "TRAILER_MODE" in body.group(1), f"{fn} stands down in TRAILER_MODE")
prefs = re.search(r"const prefs = \(\(\) => \{(.*?)\n    \}\)\(\);", GAME, re.S)
ck(prefs and prefs.group(1).count("TRAILER_MODE") >= 3, "prefs never write localStorage or the server in TRAILER_MODE")
ck("trailerScript.src = 'trailer.js'" in GAME, "the boot block loads trailer.js only in TRAILER_MODE")
ck("trailer.js" not in PAGE, "the ordinary page never loads trailer.js itself")

if fails:
    print("FAIL")
    sys.exit(1)
print("all trailer checks passed")
