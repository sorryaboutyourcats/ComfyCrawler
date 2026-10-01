"""Offline checks on the setup screen's Fill-in: the reply start, the prompt, and how a reply is
read back into fields. No ComfyUI needed - the LLM reply is faked."""
import importlib.util, random, sys, os
spec = importlib.util.spec_from_file_location(
    "srv", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL:", msg)


def form(wall="", player="", weapon="", enemy=""):
    return {"wall": wall, "player": player, "weapon": weapon, "enemy": enemy}


# ---- the reply is started on the first empty line, after every kept line before it ----
ck(srv._fill_in_reply_start(form()) == "DUNGEON:", "all-empty reply should open on DUNGEON:")
ck(srv._fill_in_reply_start(form(wall="supermarket")) == "DUNGEON: supermarket\nPLAYER:",
   "a kept wall should be written in and the reply left open on PLAYER:")
ck(srv._fill_in_reply_start(form(player="cashier")) == "DUNGEON:",
   "an empty wall comes first even when a later field is kept")

# ---- the prompt: template tricks, examples, kept lines, spark only for an empty wall ----
rng = random.Random(3)
p = srv._fill_in_prompt(form(enemy='"Sonic"'), rng)
ck(p.startswith("<|im_start|>system\n"), "prompt must open on <|im_start|> to skip the krea2 template")
ck("<think>\n\n</think>\n\nDUNGEON:" in p, "empty think block + reply start missing")
ck('ENEMY: "Sonic"' in p.split("<|im_start|>assistant")[0], "a kept later field must be listed in the brief")
ck("pick something like" in p, "an empty wall should get a spark")
ck("{examples}" not in p and "{spark}" not in p, "unformatted placeholder left in the prompt")
p2 = srv._fill_in_prompt(form(wall="corn maze"), random.Random(3))
ck("pick something like" not in p2, "a kept wall must not get a spark")
ck(p2.count("DUNGEON:") >= srv.FILL_IN_EXAMPLE_COUNT, "examples missing from the prompt")

# ---- all empty: a clean reply fills all four ----
got = srv.parse_fill_in(' "Hogwarts"\nPLAYER: janitor\nWEAPON: wet floor sign\nENEMY: angry ghost\n', form())
ck(got == {"wall": '"Hogwarts"', "player": "janitor", "weapon": "wet floor sign", "enemy": "angry ghost"},
   f"clean all-empty reply read wrong: {got}")

# ---- kept fields are never in the result, even when the model rewrites them ----
f = form(wall="supermarket", weapon="shopping basket")
got = srv.parse_fill_in(" cashier\nWEAPON: laser sword\nENEMY: old person\n", f)
ck(got == {"player": "cashier", "enemy": "old person"}, f"kept fields leaked into the result: {got}")

# ---- markdown, smart quotes, trailing punctuation and alias labels are tidied ----
got = srv.parse_fill_in(" **the “Doom guy”.**\n**Weapon:** chainsaw!\nEnemies: tax forms", form(wall="Doom 2"))
ck(got.get("player") == 'the "Doom guy"', f"markdown/smart quotes not tidied: {got}")
ck(got.get("weapon") == "chainsaw", f"bold label or trailing ! not handled: {got}")
ck(got.get("enemy") == "tax forms", f"ENEMIES: alias not read: {got}")

# ---- blanks, placeholders and copies of a kept field are not picks ----
got = srv.parse_fill_in(" <a hero>\nWEAPON: NONE\nENEMY: supermarket\n", form(wall="supermarket"))
ck(got == {}, f"placeholder / NONE / copied kept field should all be rejected: {got}")

# ---- a partial reply keeps what it has ----
got = srv.parse_fill_in(" pizza oven\nPLAYER: cat chef\n", form())
ck(got == {"wall": "pizza oven", "player": "cat chef"}, f"partial reply read wrong: {got}")

# ---- the first answer for a field wins; a later repeat of the label does not overwrite ----
got = srv.parse_fill_in(" mall\nPLAYER: mall cop\nPLAYER: something else\n", form())
ck(got.get("player") == "mall cop", f"a repeated label overwrote the first answer: {got}")

# ---- an over-long answer is capped, never ends on a stopword, and keeps quotes balanced ----
long_val = "a very very very very very very very very very very long sword of the"
v = srv._fill_in_value(long_val)
ck(v and len(v.split()) <= srv.FILL_IN_MAX_WORDS, f"not word-capped: {v!r}")
ck(v and v.split()[-1].lower() not in srv._STORY_TRAILING_STOPWORDS, f"ends on a stopword: {v!r}")
ck(srv._fill_in_value('"Steve Jobs') == "Steve Jobs", "an unbalanced quote should be dropped")
ck(srv._fill_in_value('"Clippy" the giant paperclip creature') == '"Clippy" the giant paperclip creature',
   "balanced quotes must survive - they drive the named-entity path")
ck(len(srv._fill_in_value("x" * 40 + " " + "y" * 40 + " " + "z" * 40) or "") <= srv.FILL_IN_MAX_CHARS,
   "not character-capped")

print("FAIL" if fails else "all fill-in checks passed")
sys.exit(1 if fails else 0)
