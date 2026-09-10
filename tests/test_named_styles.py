"""Offline checks on the named-entity plumbing: quote extraction, the free type-resolution
tiers, the bucket bypass, the identity-vote consensus, and the story/enemy overrides. No
ComfyUI needed - the live identity LLM call (identify_names/_identify_attempt) is not
exercised here, only inspected via source where its wiring matters (same convention
test_theme_brief.py uses for generate_theme_brief)."""
import importlib.util, sys, os, inspect
spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg); print("  FAIL:", msg)

# ---- extraction ----------------------------------------------------------------
ck(srv.parse_named_styles('"Billy" the cat') != [], "a straight-quoted span was not found")
ck(srv.parse_named_styles('“Billy” the cat') != [], "a smart-quoted span was not found")
ck(srv.parse_named_styles("Pharaoh's Tomb") == [], "an apostrophe was read as a name marker")
ck(srv.parse_named_styles('"unbalanced the rest of the field') == [],
   "an unbalanced quote produced a span")
ck(srv.parse_named_styles('""') == [], "an empty quoted span was not ignored")
ck(srv.parse_named_styles("") == [], "empty input produced a span")

two = srv.parse_named_styles('"Billy" the cat and "Suzy" the dog')
ck(len(two) == 2, f"two quoted spans in one field did not both parse: {two}")
if len(two) == 2:
    ck(two[0]["raw"] == "Billy" and two[1]["raw"] == "Suzy",
       f"span order/content wrong: {[e['raw'] for e in two]}")
    # span offsets must point at the ORIGINAL text, quote marks included, so splicing works
    s, e = two[0]["span"]
    ck(srv.parse_named_styles('"Billy" the cat and "Suzy" the dog').__len__() == 2
       and ('"Billy" the cat and "Suzy" the dog')[s:e] == '"Billy"',
       f"span does not cover the quoted text incl. quote marks: {(s, e)!r}")

# ---- resolution tiers -----------------------------------------------------------
# trailer: trusted WITHOUT the noun table, so an off-table word still resolves
ck(srv._name_trailer_type(" the cat")[0] == "cat", "trailer tier missed a simple case")
ck(srv._name_trailer_type(", a cat")[0] == "cat", "trailer tier missed the comma form")
ck(srv._name_trailer_type(" the enormous cat")[0] == "cat", "trailer tier missed a modified noun")
ck(srv._name_trailer_type(" the xenomorph")[0] == "xenomorph",
   "trailer tier requires the noun table - it should not")
ck(srv._name_trailer_type(" is a park") == (None, None), "trailer tier matched with no article")

# head noun: places named by their own head word, no LLM needed
ck(srv._name_head_type("alley pond park")[0] == "park", "head tier missed a 3-word park name")
ck(srv._name_head_type("roosevelt field mall")[0] == "mall", "head tier missed a 3-word mall name")
ck(srv._name_head_type("penn station")[0] == "station", "head tier missed a 2-word station name")
ck(srv._name_head_type("rockefeller center") == (None, None),
   "'center' is a useless art direction and must be excluded from the noun table")
ck(srv._name_head_type("gas station")[0] == "gas station", "two-word phrase table missed a hit")

# compound suffix: last resort, single tokens only, guarded prefix length
ck(srv._name_compound_type("goodcow")[0] == "cow", "compound tier missed 'goodcow'")
ck(srv._name_compound_type("cow") == (None, None),
   "bare 'cow' should fail the minimum-prefix guard")
ck(srv._name_compound_type("two words") == (None, None), "compound tier ran on a multi-word phrase")
# the documented collision cases MUST stay unresolved - both read as real English words
ck(srv._name_compound_type("combat") == (None, None), "'combat' false-matched the 'bat' suffix")
ck(srv._name_compound_type("program") == (None, None), "'program' false-matched a 'ram'-like suffix")
# "moscow" happens to fail the prefix-length guard too (prefix "mos" is only 3 letters), so it
# is not itself a live collision - but the ORDERING rule below is what protects any suffix
# match that DOES clear the guard from outranking a real answer, so it is checked as a policy
# on resolve_named_styles' source rather than re-derived from one word's particular length.
ck(srv._name_compound_type("moscow") == (None, None),
   "moscow should fail the prefix-length guard on its own merits (prefix 'mos' is 3 letters)")

# ---- ordering: the identity call must run BEFORE the compound-suffix fallback -----
rns_src = inspect.getsource(srv.resolve_named_styles)
ck("identify_names(" in rns_src and "_name_compound_type(" in rns_src,
   "resolve_named_styles no longer wires both the identity call and the compound fallback")
ck(rns_src.index("identify_names(") < rns_src.index("_name_compound_type("),
   "the compound-suffix tier must run AFTER the identity call, not before - "
   "see _name_compound_type's own docstring for why (moscow -> cow otherwise)")

# ---- bucket bypass ---------------------------------------------------------------
FAKE_ENT = {"raw": "x", "name": "X", "kind": "city", "source": "llm", "known": True,
           "landmarks": "a river", "span": (0, 1)}
for s in ("wall street", "madison square garden", "rockefeller center",
         "st patricks cathedral", "route 95"):
    ck(srv._style_bucket(s) is not None, f"sanity: {s!r} should collide with a bucket unquoted")
    ck(srv._theme_bucket(s, FAKE_ENT) is None,
       f"a named entity must bypass the bucket collision for {s!r}")
ck(srv._theme_bucket("mossy stone", None) == srv._style_bucket("mossy stone"),
   "an unnamed field must resolve identically to _style_bucket alone")

# ---- preset safety: every existing preset must be untouched by this feature -------
html_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "index.html")
with open(html_path, encoding="utf-8") as f:
    html = f.read()
import re as _re
preset_vals = _re.findall(r'data-val="([^"]*)"', html)
ck(len(preset_vals) >= 15, f"suspiciously few preset buttons found ({len(preset_vals)}) - check the regex")
for v in preset_vals:
    ck('"' not in v, f"preset {v!r} contains a double quote - it would trigger named-entity parsing")
    ck(srv.parse_named_styles(v) == [], f"preset {v!r} was parsed as carrying a name")

# ---- _named_style_text / splicing -------------------------------------------------
unresolved = {"raw": "spooky", "name": "Spooky", "kind": None, "known": False}
ck(srv._named_style_text(unresolved) == "spooky",
   "no kind resolved must fall back to the exact typed text")
typed_unknown = {"raw": "billy", "name": "Billy", "kind": "cat", "known": False}
ck(srv._named_style_text(typed_unknown) == "a cat called Billy",
   f"typed-but-unresolved phrasing wrong: {srv._named_style_text(typed_unknown)!r}")
known = {"raw": "manhattan", "name": "Manhattan", "kind": "city", "known": True}
ck(srv._named_style_text(known) == "Manhattan, the real city",
   f"known-place phrasing wrong: {srv._named_style_text(known)!r}")

spooky_ents = srv.parse_named_styles('"spooky" castle')
ck(spooky_ents and spooky_ents[0]["kind"] is None,
   "'spooky' should not resolve via any free tier - it is not a real name, just emphasis")
spooky_spliced = srv._apply_named_splices('"spooky" castle', spooky_ents)
ck(spooky_spliced == "spooky castle",
   f"unresolved emphasis-quotes should just lose the quote marks: {spooky_spliced!r}")

billy_ents = srv.parse_named_styles('"Billy" the cat')
billy_spliced = srv._apply_named_splices('"Billy" the cat', billy_ents)
ck(billy_spliced == "a cat called Billy the cat",
   f"splice did not rewrite the quoted span in place: {billy_spliced!r}")
ck(srv._apply_named_splices_clean('"Billy" the cat', billy_ents) == "Billy the cat",
   "the clean split (for sfx/music) must only strip quotes, no rewrite clause")
ck(srv._apply_named_splices("plain text, no quotes", []) == "plain text, no quotes",
   "no entities must leave the text completely untouched")

# ---- _strip_proper_name -----------------------------------------------------------
ck(srv._strip_proper_name("Billy the black cat with a red collar", "Billy")
   == "black cat with a red collar",
   f"name strip result: {srv._strip_proper_name('Billy the black cat with a red collar', 'Billy')!r}")
ck(srv._strip_proper_name("Billy", "Billy") == "",
   "stripping a name down to nothing should return empty (caller falls back to `kind`)")
ck(srv._strip_proper_name("", "Billy") == "", "empty text must not raise")
ck(srv._strip_proper_name("a cat called Billy", "Billy") == "a cat",
   f"'called' leftover not cleaned up: {srv._strip_proper_name('a cat called Billy', 'Billy')!r}")

# ---- _door_sign --------------------------------------------------------------------
ck(srv._door_sign(None) == "no text", "an unnamed door must keep the plain 'no text' clause")
ck(srv._door_sign({"kind": None}) == "no text", "an entity with no kind must not get a sign")
sign = srv._door_sign({"kind": "mall", "name": "Roosevelt Field Mall"})
ck("ROOSEVELT FIELD MALL" in sign and "sign" in sign,
   f"named door sign missing the uppercased name: {sign!r}")
ck("no text" not in srv._door_sign({"kind": "mall", "name": "X"}),
   "'no text' is itself positive conditioning at cfg 1.0 - it must never sit next to the sign")

# ---- _theme_brief_surfaces: landmarks steered at the object slots, never the tiling ones ----
plain = srv._theme_brief_surfaces(None)
ck(plain == srv._THEME_BRIEF_SURFACES, "an unnamed wall must leave the slot block byte-identical")
known_place = srv._theme_brief_surfaces(
    {"kind": "city", "name": "Manhattan", "known": True, "landmarks": "a river, a bridge"})
ck("LANTERN" in known_place.split("Manhattan is")[-1]
   and "DOOR" in known_place.split("Manhattan is")[-1]
   and "SWITCH" in known_place.split("Manhattan is")[-1],
   "landmark sentence must steer the model at LANTERN/DOOR/SWITCH")
ck("never write its name" in known_place.lower(),
   "the no-paint counter-instruction is missing for a known place")
unknown_place = srv._theme_brief_surfaces({"kind": "park", "name": "X", "known": False})
ck("never write its name" in unknown_place.lower(),
   "the no-paint counter-instruction is missing for an unresolved-instance place too")
ck("WALL, FLOOR and CEILING stay plain" in known_place,
   "the tiling surfaces must be explicitly told to stay plain material, not a landmark")

# ---- _theme_brief_prompt: wiring only, no behaviour change with no name -----------
no_name = srv._theme_brief_prompt("internet", "memes", "chat", True, None)
ck(no_name == srv._theme_brief_prompt("internet", "memes", "chat", True),
   "adding wall_named as an optional arg must not change unquoted-input output")
with_name = srv._theme_brief_prompt("Manhattan, the real city", "memes", "chat", True,
                                    {"kind": "city", "name": "Manhattan", "known": True,
                                     "landmarks": "a river"})
ck("never write its name" in with_name.lower(), "the landmark sentence did not reach the prompt")

# ---- parse_story_block: LOCATION/HERO/BOSS overrides ------------------------------
reply = """LOCATION: The Sunken Vault
HERO: The Wanderer
FOE: Housecat
BOSS: Whiskers
SAVED: keepers of the vault
CRAWL:
You step into the dark, and the walls seem to remember something worse than you.

Whiskers has taken everything from this place, and means to keep it.

Go. There is nothing left to wait for.
HOOK: The door will not open twice."""

named_all = {"wall": {"raw": "alley pond park", "name": "Alley Pond Park", "kind": "park", "known": False},
            "player": {"raw": "frodo", "name": "Frodo", "kind": "hobbit", "known": False},
            "enemy": {"raw": "billy", "name": "Billy", "kind": "cat", "known": False}}
out = srv.parse_story_block(reply, "alley pond park", "frodo", "billy the cat", named=named_all)
ck(out["location"] == "Alley Pond Park", f"LOCATION override failed: {out['location']!r}")
ck(out["hero"] == "Frodo", f"HERO override failed: {out['hero']!r}")
ck(out["boss"].endswith("Billy"), f"BOSS override failed: {out['boss']!r}")
ck("Whiskers" not in " ".join(out["crawl"]) and "Whiskers" not in out["hook"],
   f"the model's own invented boss name leaked into the prose: {out['crawl']} / {out['hook']!r}")
ck(out["boss"] in " ".join(out["crawl"]) or out["boss"] in out["hook"],
   "the overridden boss title never actually appears in the narrated text")

# no named entities -> unchanged behaviour. out["boss"] (and any prose mentioning it, via
# _use_real_boss_name) carries a RANDOM title prefix picked fresh on every call
# (random.choice(_BOSS_TITLE_PREFIXES)), so `random` is reseeded identically before each call
# to make the two comparable at all.
import random as _random
_random.seed(4242)
plain_out = srv.parse_story_block(reply, "some dungeon", "a wanderer", "a horde")
_random.seed(4242)
plain_out2 = srv.parse_story_block(reply, "some dungeon", "a wanderer", "a horde", named=None)
ck(plain_out == plain_out2, "adding `named` as an optional arg changed unnamed-input behaviour")
ck(plain_out["location"] == "The Sunken Vault" and plain_out["hero"] == "The Wanderer",
   "the model's own LOCATION/HERO should survive when nothing was named")

# ---- _vote_identity: consensus, not self-report -----------------------------------
items = ["x"]
agree = [{0: {"type": "mall", "known": True, "seen": "a food court"}},
        {0: {"type": "shopping mall", "known": True, "seen": None}}]
v = srv._vote_identity(items, agree)
ck(v[0]["type"] == "mall", f"normalised-type agreement should win: {v}")
ck(v[0]["known"] is True, "both samples said KNOWN: YES - the result must say known too")

split3 = [{0: {"type": "mall", "known": True}}, {0: {"type": "diner", "known": True}},
         {0: {"type": "park", "known": True}}]
v = srv._vote_identity(items, split3)
ck(v[0]["type"] is None, f"a genuine three-way split must abstain, got {v}")

majority = [{0: {"type": "city", "known": True}}, {0: {"type": "borough", "known": False}},
           {0: {"type": "city", "known": True}}]
v = srv._vote_identity(items, majority)
ck(v[0]["type"] == "city", f"2-of-3 agreement should win over a lone dissent: {v}")

one_no = [{0: {"type": "mall", "known": True}}, {0: {"type": "mall", "known": False}}]
v = srv._vote_identity(items, one_no)
ck(v[0]["known"] is False,
   "KNOWN must require a real majority among the winning votes, not just any YES")

nothing = [{0: {}}, {0: {}}]
v = srv._vote_identity(items, nothing)
ck(v[0]["type"] is None, "no usable votes at all must abstain, not raise")

# ---- parse_name_identity: per-item tolerant, same contract as parse_theme_brief ----
reply2 = """NAME1_TYPE: park
NAME1_KNOWN: NO
NAME1_SEEN: NONE
NAME2_TYPE: city
NAME2_KNOWN: YES
NAME2_SEEN: a river, a famous bridge, a large park
"""
p = srv.parse_name_identity(reply2, 2)
ck(p.get(0, {}).get("type") == "park" and p.get(0, {}).get("known") is False,
   f"item 1 parsed wrong: {p.get(0)}")
ck(p.get(1, {}).get("type") == "city" and p.get(1, {}).get("known") is True
   and p.get(1, {}).get("seen"), f"item 2 parsed wrong: {p.get(1)}")
ck(srv.parse_name_identity("", 2) == {}, "empty reply should give {}")
ck(srv.parse_name_identity("NAME9_TYPE: park", 2) == {},
   "an out-of-range index must be ignored, not raise")

# the bare (unnumbered) form: what a 4B model actually sends back for a single-item request -
# measured live, "rockefeller center" alone came back plain "TYPE: building" with no "NAME1_"
# prefix, and the numbered-only parser silently dropped the whole reply. Must work at count=1...
bare_reply = "rockefeller center\nTYPE: building\nKNOWN: YES\nSEEN: glass spires, ice rink"
p_bare = srv.parse_name_identity(bare_reply, 1)
ck(p_bare.get(0, {}).get("type") == "building" and p_bare.get(0, {}).get("known") is True,
   f"bare-label single-item reply was not parsed: {p_bare}")
# ...and must NOT be read at count > 1, where a stray bare line could misattribute to item 0
# instead of the numbered item it was actually meant to answer for.
ck(srv.parse_name_identity(bare_reply, 2) == {},
   "a bare label must be ignored (not silently mapped to item 0) when more than one item was asked for")

# the prompt itself must match this shape: bare labels for exactly one item, numbered for more.
one_item_prompt = srv._name_identity_prompt(["rockefeller center"])
ck("TYPE: <one common noun>" in one_item_prompt and "NAME1_TYPE" not in one_item_prompt,
   "a single-item identity prompt must ask for bare labels, not NAME1_-prefixed ones")
two_item_prompt = srv._name_identity_prompt(["rockefeller center", "manhattan"])
ck("NAME1_TYPE" in two_item_prompt and "NAME2_TYPE" in two_item_prompt,
   "a multi-item identity prompt must keep the numbered label scheme")

# ---- generate_theme_brief: the enemy-literal guard, and the exact substrings the -------
# ---- existing test_theme_brief.py greps for must both survive this change -------------
gtb_src = inspect.getsource(srv.generate_theme_brief)
ck('brief["enemy"] = literal' in gtb_src, "the literal-overwrite line must still be present")
ck(gtb_src.count('return {"enemy": literal} if literal else None') == 2,
   "both failure-path returns for the hand-tuned enemy must still be present")
ck("enemy_named" in gtb_src and "_enemy_literal(enemy_style)" in gtb_src,
   "the enemy_named guard around _enemy_literal is missing")
ck(gtb_src.index("enemy_named") < gtb_src.index("_enemy_literal(enemy_style)"),
   "the enemy_named guard must be checked BEFORE falling back to _enemy_literal")

# ---- generate_krea2_posed_bundle: the name-strip and boss-name wiring -------------
gkb_src = inspect.getsource(srv.generate_krea2_posed_bundle)
ck("_strip_proper_name(enemy_style, enemy_named" in gkb_src,
   "the designed enemy line is no longer stripped of a quoted proper name before the bestiary")
ck('species["boss"]["name"] = enemy_named["name"]' in gkb_src,
   "the species-level boss name fallback is no longer kept in step with the entity's name")

print("FAIL" if fails else "all named-entity checks passed")
sys.exit(1 if fails else 0)
