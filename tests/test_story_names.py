"""Offline checks on the crawl's naming: the boss title, the generic-name guard, and the
stake line. No ComfyUI needed - the LLM reply is faked."""
import importlib.util, inspect, random, re, sys, os
spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)


def stutter(text):
    """The same word twice in a row, ignoring case - "Hollow Hollow The Hollow The Boss"."""
    words = re.findall(r"[A-Za-z']+", text)
    return next((a for a, b in zip(words, words[1:]) if a.lower() == b.lower()), None)


def story(boss_line, **kw):
    return srv.parse_story_block("""LOCATION: Sega Arcade
HERO: Goodcow
FOE: Ring Runner
%s
SAVED: the cabinets of the upper floor
CRAWL:
The neon glow bleeds through cracked tiles.

The Boss has swallowed the last heartbeat, and the boss means to keep it.

Go and take it back.
HOOK: Let the arcade scream your name.""" % boss_line, "sega arcade", "a cow", "sanic", **kw)


# ---- the reported bug: "Hollow Hollow The Hollow The Boss" -------------------------
# The model answered BOSS with the label instead of a name. Four chained re.sub calls then
# each rescanned the previous call's replacement, growing the title on every pass.
for seed in range(40):
    random.seed(seed)
    out = story("BOSS: The Boss")
    body = " ".join(out["crawl"]) + " " + out["hook"]
    ck(stutter(out["boss"]) is None, f"seed {seed}: stuttered boss title {out['boss']!r}")
    ck(stutter(body) is None, f"seed {seed}: stuttered title in the prose: {stutter(body)!r}")
    ck(not re.search(r"\bthe boss\b", body, re.IGNORECASE),
       f"seed {seed}: a generic 'the boss' survived into the prose")
    # Two mentions in the source paragraph, so exactly two after the rewrite - a title that
    # substitutes into its own output shows up here as three or more.
    ck(out["crawl"][1].count(out["boss"]) == 2,
       f"seed {seed}: expected 2 rewritten mentions, got "
       f"{out['crawl'][1].count(out['boss'])} in {out['crawl'][1]!r}")

# "The Boss" is not a name - it must lose to the fallback rather than reach the health bar.
random.seed(0)
ck("Boss" not in story("BOSS: The Boss")["boss"],
   "the generic BOSS answer was taken at face value as a proper name")
random.seed(0)
ck(story("BOSS: The Overclocked")["boss"].endswith("The Overclocked"),
   "a real invented BOSS name must survive the generic guard")

# ---- the title must not repeat a word already inside the name ---------------------
for prefix in srv._BOSS_TITLE_PREFIXES:
    for seed in range(20):
        random.seed(seed)
        got = story(f"BOSS: The {prefix}")["boss"]
        ck(stutter(got) is None, f"title collided with the name: {got!r}")
ck(srv._boss_title("Hollow") != "Hollow", "_boss_title handed back the name's own word")
# Every prefix colliding at once still has to return something rather than raise.
ck(srv._boss_title(" ".join(srv._BOSS_TITLE_PREFIXES)) in srv._BOSS_TITLE_PREFIXES,
   "_boss_title must still pick a title when every prefix collides")

# ---- the generic-name guard itself ------------------------------------------------
for name in ("The Boss", "boss", "the champion", "Enemy", "THE FOE"):
    ck(srv._is_generic_name(name), f"{name!r} should read as generic")
for name in ("Boss Byte", "The Hollow Champion", "Whiskers", "The Warden", "Sanic", ""):
    ck(not srv._is_generic_name(name), f"{name!r} is a real name and must survive")

# ---- a plural mention is rewritten whole, not left stranded ------------------------
# The label loop de-pluralises the name (_singular_creature_name), so the parsed "Whisker"
# has to still match the "Whiskers" the model wrote in its own prose.
random.seed(1)
whisk = srv.parse_story_block("""LOCATION: The Vault
HERO: The Wanderer
FOE: Housecat
BOSS: Whiskers
SAVED: keepers of the vault
CRAWL:
You step into the dark.

Whiskers has taken everything from this place.

Go.
HOOK: The door will not open twice.""", "vault", "a wanderer", "a horde")
p2 = whisk["crawl"][1]
ck(whisk["boss"] in p2, f"the boss title never reached the prose: {p2!r}")
ck(not re.search(r"\bWhiskers\b", p2), f"the plural the model wrote survived: {p2!r}")
ck("s has taken" not in p2, f"the plural's trailing 's' was stranded: {p2!r}")

# ---- the stake line: no leaked place name, themed fallback ------------------------
ck("Ashfen" not in srv._STORY_USER,
   "the SAVED example still names Ashfen - the model copies it into every crawl verbatim")
ck("{wall}" in srv._STORY_USER.split("SAVED:")[1].split("CRAWL:")[0],
   "the SAVED instruction no longer ties the stake to the typed dungeon theme")
ck(any("Mow Meow" in s for s in srv._STAKE_FALLBACKS),
   "the stake fallback is no longer the Mow Meow cats")
for s in srv._STAKE_FALLBACKS:
    ck(not re.match(r"^(the|a|an)\b", s, re.IGNORECASE),
       f"stake fallback {s!r} brings its own article - it is written to follow 'The'")
    ck(srv._story_stake(s, "x") == s, f"stake fallback {s!r} does not survive normalisation")

# ---- a known character keeps its name in the bestiary -----------------------------
# Typing "Sonic" asks for a dungeon full of Sonics; stripping the name left the species
# designer working from the bare kind noun and it drew three unrelated mascots.
gkb = inspect.getsource(srv.generate_krea2_posed_bundle)
ck('not enemy_named.get("known")' in gkb,
   "the name-strip no longer spares a known character - Sonic will lose its look again")
ck("_strip_proper_name(enemy_style, enemy_named" in gkb,
   "an unresolved quoted name must still be stripped before the bestiary")

print("FAIL" if fails else "all story-name checks passed")
sys.exit(1 if fails else 0)
