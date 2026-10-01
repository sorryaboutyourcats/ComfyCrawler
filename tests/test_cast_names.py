"""Offline checks on how the cast gets its names: the naming call's parse, the names decided
from it, the crawl written around them, the "Ashen" swap, and the bestiary's own foe names.
No ComfyUI needed - every model reply is faked."""
import importlib.util, random, re, sys, os, tempfile
spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)
# Never touch the real recent-cast memory from a test.
srv.RECENT_CAST_PATH = os.path.join(tempfile.mkdtemp(), "recent_cast_names.json")

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL:", msg)


def decide(kind, what, name, typed, seeds=60, **kw):
    """Every name _decide_name hands back across a spread of seeds."""
    return [srv._decide_name(kind, what, name, typed, rng=random.Random(s), **kw) for s in range(seeds)]


# ---- the naming reply ---------------------------------------------------------------
# The prompt starts the reply on "PLAYER_KIND:", so what comes back begins mid-line.
reply = " PERSON\nPLAYER_WHAT: Cashier\nPLAYER_NAME: NONE\nBOSS_KIND: MONSTER\nBOSS_WHAT: Crazy Customers\nBOSS_NAME: None"
cast = srv.parse_story_names(reply)
ck(cast["hero"] == {"kind": "PERSON", "what": "Cashier", "name": None, "title": None}, f"hero parse: {cast['hero']}")
ck(cast["boss"] == {"kind": "MONSTER", "what": "Crazy Customer", "name": None, "title": None},
   f"boss parse (WHAT should come back singular): {cast['boss']}")
titled_reply = (" PERSON\nPLAYER_WHAT: Office Guy\nPLAYER_NAME: NONE\nPLAYER_TITLE: <Spreadsheet Slayer>\n"
                "BOSS_KIND: THING\nBOSS_WHAT: RAM Stick\nBOSS_NAME: RAM Stick\nBOSS_TITLE: \"The Overclocker\"")
cast = srv.parse_story_names(titled_reply)
ck(cast["hero"]["title"] == "Spreadsheet Slayer" and cast["boss"]["title"] == "The Overclocker",
   f"titles misread: {cast}")
naming_prompt = srv._naming_prompt("Windows 95", "office guy", "stick of computer RAM", rng=random.Random(1))
ck("{" not in naming_prompt and "PLAYER_TITLE:" in naming_prompt and "BOSS_TITLE:" in naming_prompt,
   "the naming prompt lost its TITLE lines or left a shape placeholder unfilled")
shapes = {srv._naming_prompt("a", "b", "c", rng=random.Random(s)) for s in range(30)}
ck(len(shapes) > 5, "the title shape is not drawn fresh per call")
ck(srv._naming_prompt("supermarket", "cashier", "crazy customer").endswith(srv._NAMING_REPLY_START),
   "the naming prompt no longer starts the reply for the model - it recites the brief without it")

# A sentence ahead of the labels lands under the pre-written PLAYER_KIND label; the real answer
# further down has to win over it.
chatty = " You're in a dungeon.\nPLAYER_KIND: ANIMAL\nPLAYER_WHAT: cats\nPLAYER_NAME: NONE\nBOSS_KIND: FAMOUS\nBOSS_WHAT: Donkey Kong\nBOSS_NAME: Donkey Kong"
cast = srv.parse_story_names(chatty)
ck(cast["hero"]["kind"] == "ANIMAL" and cast["hero"]["what"] == "Cat", f"chatty reply misread: {cast['hero']}")
ck(cast["boss"] == {"kind": "FAMOUS", "what": "Donkey Kong", "name": "Donkey Kong", "title": None}, f"{cast['boss']}")
# A reply that recites the brief instead of answering reads as nothing at all, never as a kind.
echo = " You're the casting director. PERSON is any sort of human being. ANIMAL is a real animal."
ck(srv.parse_story_names(echo)["hero"]["kind"] is None,
   "a reply reciting the options must not read as whichever option it recited first")
ck(srv.parse_story_names("garbage")["boss"] == {"kind": None, "what": None, "name": None, "title": None},
   "an unusable reply must parse to Nones")
ck(srv._read_kind("it is a person, so PERSON") == "PERSON", "capitals must be read ahead of prose")
ck(srv._read_kind("<THING>") == "THING", "a kind copied with its placeholder brackets")

# ---- WHAT, cleaned ---------------------------------------------------------------------
for raw, want in (("cashiers", "Cashier"), ("a night elf", "Night Elf"),
                  ("blueberries with swords", "Blueberry"), ("maga people", "Maga Person"),
                  ("guy in a shirt and tie with thick glasses", "Guy"),
                  ("pink and green cat", "Green Cat"), ("stick of computer RAM", "Computer RAM"),
                  ("Stick of RAM", "Stick of RAM"), ("a cat called Billy", "Cat"),
                  ("Sonic, the real video game character", "Sonic"), ("<Office Chair>", "Office Chair"),
                  ("NONE", None), ("person", None), ("monster", None), ("", None)):
    got = srv._clean_what(raw)
    ck(got == want, f"_clean_what({raw!r}) = {got!r}, want {want!r}")

# ---- does a name come from what it names? ----------------------------------------------
for name, sources, want in (("Barry Blueberry", ("Blueberry",), True),
                            ("Sir Melonsworth", ("Watermelon",), True),
                            ("The Great Waffleton", ("Blueberry", "blueberries with swords"), False),
                            ("Gristleclaw", ("Fingercreeper",), False),
                            ("RAM Stick", ("stick of computer RAM",), True),
                            ("Sky-Elf", ("Elf on a shelf",), True),
                            ("Big Tony", ("big blueberries",), False),
                            ("Berrybloom", ("blueberries with swords",), True),
                            ("Glitch Wisp", ("chat-bubble twitch viewer",), False),
                            ("Mossclaw", ("moss-covered dire bear",), True),
                            ("Programmer Pete", ("",), False)):
    ck(srv._name_connects(name, *sources) is want, f"_name_connects({name!r}, {sources}) should be {want}")

# ---- the decided names ------------------------------------------------------------------
people = decide("PERSON", "Cashier", None, "cashier")
ck(all(n.split(" the ")[0] in srv._EVERYDAY_NAMES for n in people), f"a person got a non-everyday name: {people}")
ck(all(n != "Cashier" for n in people), "a cashier was named 'Cashier' again")
ck(any(n.endswith(" the Cashier") for n in people) and any(" the " not in n for n in people),
   "a person should come out both ways - 'Sally the Cashier' and plain 'Ellen'")

pets = decide("ANIMAL", "Cat", None, "fluffy white cat")
ck(all(n.split(" the ")[0] in srv._PET_NAMES for n in pets), f"a pet got a non-pet name: {pets}")
ck(not any(re.search(r"\b(?:whiskers?|paws)\b", n, re.I) for n in pets), "Whisker/Paws is back")
ck(len(set(pets)) > 20, f"pet names are not varied: {sorted(set(pets))}")
ck(not set(srv._PET_NAMES) & set(srv._EVERYDAY_NAMES), "the pet and people pools overlap")

ck(set(decide("FAMOUS", "Donkey Kong", "Donkey Kong", "Donkey Kong")) == {"Donkey Kong"},
   "a famous character must keep its own name")
ck(set(decide("FAMOUS", "Jesus", None, "Jesus")) == {"Jesus"},
   "a famous character with no NAME answer falls back on the typed words")
ck(set(decide("FAMOUS", "Elf", "Buddy", "Elf Will Ferrell")) == {"Elf Will Ferrell"},
   "a FAMOUS name unrelated to the typed words must not be trusted")

things = decide("THING", "Blueberry", "The Great Waffleton", "blueberries with swords")
ck(not any("Waffleton" in n for n in things), "a copied, unrelated THING name was kept")
ck(all("Blueberry" in n for n in things), f"a thing's fallback name lost what it is: {things}")
ck(any(n.split(" ")[0] in srv._THING_TITLES for n in things) and any(" the " in n for n in things),
   "a thing should get both shapes - 'King Blueberry' and 'Rhonda the Blueberry'")
ck(set(decide("THING", "Blueberry", "Barry Blueberry", "blueberries")) == {"Barry Blueberry"},
   "a THING name made out of its own word must be kept")

for n in decide("MONSTER", "Moss-covered Dire Bear", None, "moss-covered dire bear"):
    ck(len(n) <= srv._NAME_WITH_WHAT_MAX, f"name too long for the boss health bar: {n!r}")
    ck("Dire Bear" in n, f"a long WHAT should shrink to its noun, not vanish: {n!r}")
for n in decide("ANIMAL", "Yorkshire Terrier", None, "Yorkshire Terrier"):
    ck(len(n) <= srv._NAME_WITH_WHAT_MAX, f"name too long for the boss health bar: {n!r}")

avoided = decide("PERSON", "Clerk", None, "clerk", seeds=200,
                 avoid={n.lower() for n in srv._EVERYDAY_NAMES[:-1]})
ck({n.split(" the ")[0] for n in avoided} == {srv._EVERYDAY_NAMES[-1]}, "`avoid` names were reused")

# No kind at all (an unreadable reply) still names both, and never crashes on empty input.
ck(all(decide(None, None, None, "")), "an empty, unreadable cast must still be named")

# ---- a name that is only the thing again ------------------------------------------------
for name, sources, want in (("RAM Stick", ("Computer RAM", "stick of computer RAM"), True),
                            ("Taco", ("Taco", "tacos"), True),
                            ("Waifu", ("Waifu", "waifu"), True),
                            ("The Tacos", ("Taco",), True),
                            ("Barry Blueberry", ("Blueberry", "blueberries"), False),
                            ("Overclocker", ("Computer RAM", "stick of computer RAM"), False),
                            ("", ("Taco",), False)):
    ck(srv._is_just_the_what(name, *sources) is want, f"_is_just_the_what({name!r}, {sources}) should be {want}")
for kind, what, name, typed in (("THING", "Computer RAM", "RAM Stick", "stick of computer RAM"),
                                ("THING", "Taco", "Taco", "taco"),
                                ("MONSTER", "Waifu", "Waifu", "waifu")):
    got = decide(kind, what, name, typed)
    ck(name not in got, f"{name!r} came out bare again: {sorted(set(got))}")
    ck(len(set(got)) > 10, f"a thing's name does not vary: {sorted(set(got))}")

# ---- titles -------------------------------------------------------------------------------
ram = ("Computer RAM", "stick of computer RAM")
for raw, want in (("The Overclocker", "Overclocker"), ("<blue screen of death>", "Blue Screen of Death"),
                  ("Doug the Overclocker", "Overclocker"), ("King of the Motherboard", "King of the Motherboard"),
                  ("RAM Stick", None), ("NONE", None), ("The Boss", None), ("", None),
                  ("the nickname its victims whisper about it", None), ("Apex The Unmaker", None),
                  ("Hollow Memory", None), ("Supercalifragilistic Memory Hog", None)):
    got = srv._clean_title(raw, *ram)
    ck(got == want, f"_clean_title({raw!r}) = {got!r}, want {want!r}")
ck(srv._clean_title("Doom Slayer", "Doom Guy", "Doom guy") == "Doom Slayer",
   "a stock word the player typed themselves must be allowed")
ck(srv._clean_title("Overclocker", *ram, recent={"overclocker"}) is None, "a recently used title was allowed")

def dress(who, kind, what, base, title, seeds=300, **kw):
    return [srv._dress_name(who, kind, what, base, title, rng=random.Random(s), **kw) for s in range(seeds)]

boss = dress("boss", "THING", "Computer RAM", "King Computer RAM", "Overclocker")
prefixed = [n for n in boss if n.split(" ")[0] in srv._DRAMATIC_PREFIXES]
ck(0.25 < len(prefixed) / len(boss) < 0.42, f"dramatic prefix rate is off: {len(prefixed)}/{len(boss)}")
ck(any(re.fullmatch(r"\w+ The Overclocker", n) for n in prefixed), f"no 'Shattered The Overclocker' shape: {set(prefixed)}")
ck("The Overclocker" in boss and any(re.fullmatch(r"\w+ the Overclocker", n) for n in boss),
   f"the boss title shapes are missing: {sorted(set(boss))[:12]}")
ck(all(len(n) <= srv._NAME_WITH_WHAT_MAX for n in boss), "a dressed boss name is too long for the health bar")
untitled = dress("boss", "THING", "Taco", "Rhonda the Taco", None)
ck(set(untitled) - {"Rhonda the Taco"} <= {f"{p} Taco" for p in srv._DRAMATIC_PREFIXES},
   f"an untitled boss got an unexpected shape: {sorted(set(untitled))}")
muncher = dress("boss", "THING", "RAM Stick", "Marge the RAM Stick", "Memory Muncher")
ck(not any(re.fullmatch(r"\w+ RAM Stick", n) for n in muncher),
   f"a title too long for 'Sovereign The Memory Muncher' was dropped for the bare WHAT: {sorted(set(muncher))}")
ck(any(n.split(" ")[0] in srv._DRAMATIC_PREFIXES and "Memory Muncher" in n for n in muncher),
   "a long title never got its dramatic prefix")
long_title = dress("boss", "MONSTER", "Moss-covered Dire Bear", "Kathy the Dire Bear", "Blue Screen of Death")
ck(all(len(n) <= srv._NAME_WITH_WHAT_MAX for n in long_title), f"too long: {[n for n in long_title if len(n) > 26]}")

hero = dress("hero", "PERSON", "Office Guy", "Gary", "Excel Wizard")
ck("Gary the Excel Wizard" in hero and "Gary" in hero, f"a hero should come out both ways: {set(hero)}")
ck(set(dress("hero", "PERSON", "Office Guy", "Gary", "Spreadsheet Slayer")) == {"Gary"},
   "'Gary the Spreadsheet Slayer' is 27 characters - past the cap it must fall back")
ck(not any(n.split(" ")[0] in srv._DRAMATIC_PREFIXES or n.startswith("The ") for n in hero),
   f"a hero got a boss-only shape: {set(hero)}")
ck(set(dress("boss", "FAMOUS", "Donkey Kong", "Donkey Kong", "Barrel King")) == {"Donkey Kong"},
   "a famous character must keep its own name, untitled")
pet = dress("hero", "ANIMAL", "Cat", "King Cat", "Nap Champion")
ck(all(n == "King Cat" or n.split(" the ")[0] in srv._PET_NAMES for n in pet), f"a titled pet got a people name: {set(pet)}")

# ---- the recent-cast memory --------------------------------------------------------------
with open(srv.RECENT_CAST_PATH, "w") as f:
    f.write("{not json")
ck(srv._load_recent_cast() == {"names": [], "titles": [], "firsts": []}, "a corrupt recent file broke the load")
os.remove(srv.RECENT_CAST_PATH)
ck(srv._load_recent_cast()["names"] == [], "a missing recent file broke the load")
for i in range(60):
    srv._remember_cast(names=[f"Name {i}"], titles=[f"Title {i}", None], firsts=["Doug"])
got = srv._load_recent_cast()
ck(len(got["names"]) == srv.RECENT_CAST_KEEP["names"] and got["names"][-1] == "name 59",
   f"the recent names were not capped newest-last: {got['names'][-3:]}")
ck(got["firsts"] == ["doug"], f"a repeated first name was stored twice: {got['firsts']}")
os.remove(srv.RECENT_CAST_PATH)

# ---- generate_story_names without ComfyUI ----------------------------------------------
calls = []
def fake_submit(reply_text):
    def _submit(payload, out_key, timeout=180, job_key=None):
        calls.append(payload)
        if isinstance(reply_text, Exception):
            raise reply_text
        return reply_text
    return _submit

real_submit = srv._submit_and_collect_text
try:
    srv._submit_and_collect_text = fake_submit(reply)
    random.seed(3)
    names = srv.generate_story_names("supermarket", "cashier", "crazy customer")
    ck(names["hero"].split(" the ")[0] in srv._EVERYDAY_NAMES, f"hero not an everyday name: {names}")
    ck("Crazy Customer" in names["boss"], f"boss lost what it is: {names}")
    ck(names["foe"] == "Crazy Customer", f"the foe should be what the boss is: {names}")
    ck(names["location"] is None, "no quoted wall, so no decided location")
    ck(names["hero"].split(" the ")[0] != names["boss"].split(" the ")[0],
       f"hero and boss share a first name: {names}")

    # Three runs of the same theme, with the model saying the same thing every time: the
    # Windows 95 cast that came out identical three times.
    if os.path.exists(srv.RECENT_CAST_PATH):
        os.remove(srv.RECENT_CAST_PATH)
    srv._submit_and_collect_text = fake_submit(titled_reply)
    runs = [srv.generate_story_names("Windows 95", "office guy", "stick of computer RAM") for _ in range(3)]
    bosses = [r["boss"] for r in runs]
    heroes = [r["hero"] for r in runs]
    ck(len(set(bosses)) == 3 and len(set(heroes)) == 3, f"the same theme repeated its cast: {heroes} / {bosses}")
    ck("RAM Stick" not in bosses, f"the boss came out as just the thing: {bosses}")
    ck(os.path.exists(srv.RECENT_CAST_PATH), "the cast was not remembered")
    os.remove(srv.RECENT_CAST_PATH)
    srv._submit_and_collect_text = fake_submit(reply)

    # Both characters quoted: nothing to ask, so no call at all.
    calls.clear()
    named = {"player": {"name": "Goodcow", "kind": "cow"}, "enemy": {"name": "Sonic", "kind": "hedgehog"},
             "wall": {"name": "Sega Arcade", "kind": "arcade"}}
    names = srv.generate_story_names("x", "y", "z", named=named)
    ck(not calls, "the naming call ran even though both characters were quoted")
    ck((names["hero"], names["boss"], names["location"]) == ("Goodcow", "Sonic", "Sega Arcade"),
       f"quoted names must be the decision: {names}")

    # ComfyUI down: still named, from the typed words alone.
    srv._submit_and_collect_text = fake_submit(RuntimeError("ComfyUI rejected the story prompt"))
    names = srv.generate_story_names("supermarket", "cashier", "crazy customer")
    ck(names["hero"] and names["boss"], f"a failed naming call left a character unnamed: {names}")

    # A cancelled run must unwind, not be swallowed as a naming failure.
    srv._submit_and_collect_text = fake_submit(srv.GenerationCancelled("closed"))
    try:
        srv.generate_story_names("supermarket", "cashier", "crazy customer")
        ck(False, "GenerationCancelled was swallowed by the naming call")
    except srv.GenerationCancelled:
        pass
finally:
    srv._submit_and_collect_text = real_submit

for plan in (srv._plan_v6(4), srv._plan_v5(4)):
    keys = [j[0] for j in plan]
    ck("names" in keys and keys.index("names") < keys.index("story"),
       f"the naming job must be planned ahead of the story: {keys}")

# ---- the crawl written around decided names ---------------------------------------------
prompt = srv._story_prompt("supermarket", "cashier", "mop", "crazy customers",
                           names={"hero": "Sally the Cashier", "boss": "Gus", "foe": "Crazy Customer"})
ck("Sally the Cashier" in prompt and "called Gus" in prompt, "the decided names never reached the crawl prompt")
reply_labels = prompt.split("Reply using EXACTLY")[1]
ck(not re.search(r"^(?:HERO|BOSS|FOE):", reply_labels, re.M),
   "the crawl is still asked to invent HERO/BOSS/FOE lines of its own")
ck("Name the dungeon the way a real place" in prompt, "the place-naming rule is missing")
quoted_prompt = srv._story_prompt("hell", "a", "b", "c", names={"hero": "A", "boss": "B", "location": "Hell"})
ck("called Hell" in quoted_prompt and "Name the dungeon the way" not in quoted_prompt,
   "a quoted location must be handed to the crawl instead of a naming rule")
for word in ("Whisker", "Ashen", "Ashfen", "Mossback", "Waffleton"):
    ck(word not in srv._STORY_USER and word not in srv._NAMING_USER,
       f"{word!r} is written into a brief - the model copies what it is shown")

crawl = """LOCATION: The Ashen Womb
SAVED: the souls of the Ashen Womb
CRAWL:
Ashen skies hang over the Ashen Womb, and the Unmaker waits below.

The boss has taken the Ashen One's last light, and the Unmakers mean to keep it.

Go, and take it back from the boss.
HOOK: The Ashen Womb opens its mouth."""
random.seed(7)
out = srv.parse_story_block(crawl, "hell", "lady reporter", "devil",
                            names={"hero": "Ellen", "boss": "Walt the Devil", "foe": "Devil"})
text = " ".join(out["crawl"]) + " " + out["hook"] + " " + out["saved"] + " " + out["location"]
ck((out["hero"], out["boss"], out["foe"]) == ("Ellen", "Walt the Devil", "Devil"),
   f"decided names did not win: {out['hero']!r} / {out['boss']!r} / {out['foe']!r}")
ck(not re.search(r"\bAshen\s+Womb\b", text), f"'Ashen' survived in the place names: {text!r}")
ck(out["location"].endswith(" Womb") and out["location"].split()[-2] in srv._PLACE_WORD_BACKUPS,
   f"the location's stock word was not swapped for a backup: {out['location']!r}")
place = re.sub(r"^The\s+", "", out["location"])
ck(place in out["saved"] and place in out["hook"] and place in out["crawl"][0],
   f"the swapped place name disagrees between labels and prose: {out['location']!r} / {out['saved']!r}")
ck("Ashen skies" in out["crawl"][0], f"'Ashen skies' is weather, not a place name: {out['crawl'][0]!r}")
ck("Ashen One" in out["crawl"][1], f"'the Ashen One' is a name, not a place word: {out['crawl'][1]!r}")
ck("boss" not in text.lower().replace("walt the devil", ""), f"a generic 'the boss' survived: {text!r}")
ck(out["crawl"][0].startswith("You are Ellen, a lady reporter."), f"hero opener: {out['crawl'][0]!r}")

# A quoted wall: the model's own invented place must not linger in the stake or the prose.
crawl = """LOCATION: Ashen Maw
SAVED: people of Ashen Maw
CRAWL:
Ashen Maw burns, and nobody leaves.

Everyone in Ashen Maw is waiting for you.

Go.
HOOK: The gate of Ashen Maw groans."""
out = srv.parse_story_block(crawl, "a hell called Hell", "reporter", "devil",
                            named={"wall": {"name": "Hell", "kind": "hell"}},
                            names={"hero": "Rachel", "boss": "Donald Trump", "location": "Hell"})
text = " ".join(out["crawl"]) + " " + out["hook"] + " " + out["saved"]
ck(out["location"] == "Hell", f"quoted location lost: {out['location']!r}")
ck("Ashen" not in text and out["saved"] == "people of Hell",
   f"the model's invented place leaked past the quoted one: {out['saved']!r} / {text!r}")

# ---- the hero opener ----------------------------------------------------------------------
for hero, desc, want in (("Sally the Cashier", "cashier", "You are Sally the Cashier."),
                         ("Ellen", "cashier", "You are Ellen, a cashier."),
                         ("Catherine", "cat", "You are Catherine, a cat."),
                         ("Biscuit the Fluffy Cat", "fluffy white cat", "You are Biscuit the Fluffy Cat."),
                         ("Vern the Druid", "druid in leaf armor", "You are Vern the Druid, a druid in leaf armor."),
                         ("Goodcow", "a cow called Goodcow", "You are Goodcow."),
                         ("Ted", "an old man", "You are Ted, an old man."),
                         ("Uncle Watermelon", "watermelon", "You are Uncle Watermelon.")):
    got = srv._hero_opener(hero, desc)
    ck(got == want, f"_hero_opener({hero!r}, {desc!r}) = {got!r}, want {want!r}")

# ---- the bestiary's own names -----------------------------------------------------------
def family(names, looks=("a stocky figure in a red cap",) * 3):
    return {v: {"name": n, "look": l, "guard": "arms"}
            for v, n, l in zip(srv.ENEMY_VARIANT_NAMES, names, looks)}

sp = srv._tidy_species_names(family(("Ironclad Grunt", "Skywhip", "Golemforge")), "maga people")
ck([sp[v]["name"] for v in srv.ENEMY_VARIANT_NAMES] == ["Maga Person", "Flying Maga Person", "Big Maga Person"],
   f"unconnected foe names were not rebuilt: {[sp[v]['name'] for v in srv.ENEMY_VARIANT_NAMES]}")
sp = srv._tidy_species_names(family(("Grunt Customer", "Flyer Customer", "Boss Customer")), "crazy customer")
got = [sp[v]["name"] for v in srv.ENEMY_VARIANT_NAMES]
ck(got == ["Grunt Customer", "Customer", "Big Customer"], f"label echoes / duplicates: {got}")
sp = srv._tidy_species_names(family(("MONEY MAN",) * 3), "money")
got = [sp[v]["name"].lower() for v in srv.ENEMY_VARIANT_NAMES]
ck(len(set(got)) == 3, f"three identical foe names survived: {got}")
sp = srv._tidy_species_names(family(("Rusty Knuckle", "Winged Glove", "Iron Mass"),
                                    ("a pale hand walking on rusty knuckles",
                                     "a severed glove-like hand on bat wings",
                                     "a heap of fused fingers")), "fingercreeper")
got = [sp[v]["name"] for v in srv.ENEMY_VARIANT_NAMES]
ck(got[:2] == ["Rusty Knuckle", "Winged Glove"], f"a name built from its own LOOK was thrown away: {got}")
ck(got[2] == "Big Fingercreeper", f"'Iron Mass' has nothing to do with its foe: {got}")
sp = srv._tidy_species_names(family(("Twitch Grunt", "Glitch Wisp", "Echo Mass")),
                             "chat-bubble twitch viewer")
got = [sp[v]["name"] for v in srv.ENEMY_VARIANT_NAMES]
ck(got[1] == "Flying Twitch Viewer" and all(len(n) <= 24 for n in got),
   f"a long subject should shrink to fit the health bar: {got}")

print("FAIL" if fails else "all cast-name checks passed")
sys.exit(1 if fails else 0)
