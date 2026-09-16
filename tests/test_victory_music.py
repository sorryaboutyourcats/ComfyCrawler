"""The victory song pool: loops share the victory box, and which one plays is decided by the
dungeon's typed style rather than by chance. Down to two tracks while a batch of six candidates
is auditioned outside the game (see generate_victory_candidates in server.py) - this test does
not pin the pool at any particular size, just that game.js and server.py agree on whatever it
currently is.

Two halves. The first guards the one thing that can break SILENTLY - server.py's STATIC_MUSIC
and game.js's VICTORY_MUSIC_TRACKS are two hand-maintained copies of the same ordered list,
and if they drift the victory box either 404s (silent win) or quietly re-assigns every style
that has ever been played to a different song. The second re-implements game.js's hash in
Python and checks the promise the feature actually makes: one style is one song, forever.

No ComfyUI and no browser - this reads the shipped source and the shipped .wav files."""
import importlib.util, os, re, sys, wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)

GAME_JS = open(os.path.join(ROOT, "game.js"), encoding="utf-8").read()
bad = 0


def fail(msg):
    global bad
    print("  FAIL:", msg)
    bad += 1


# ---- the two lists are one list ------------------------------------------------
m = re.search(r"const VICTORY_MUSIC_TRACKS = \[(.*?)\];", GAME_JS, re.S)
front = re.findall(r"'([a-z_0-9]+)'", m.group(1)) if m else []
if not front:
    fail("game.js has no VICTORY_MUSIC_TRACKS array to read")

back = [k for k in srv.STATIC_MUSIC if k == "victory" or k.startswith("victory_")]

if front != back:
    fail(f"game.js and server.py disagree about the pool:\n"
         f"    game.js  : {front}\n    server.py: {back}\n"
         f"    (order matters - the hash indexes into it)")

if len(front) < 2:
    fail(f"expected at least two victory loops (one to fall back to, one to prove the hash "
         f"can pick a different one), found {len(front)}: {front}")

if front and front[0] != "victory":
    fail(f"slot 0 is {front[0]!r}, but victoryTrackFor falls back to slot 0 for an empty "
         f"style and 'victory' is the track that has always played there")

# ---- every track in the pool is actually shipped --------------------------------
for name in front:
    path = os.path.join(ROOT, "sounds", f"{name}_music.wav")
    if not os.path.exists(path):
        fail(f"{name}: no sounds/{name}_music.wav - that style's win would play in silence "
             f"(generate it with: python server.py --gen-{name}-music)")
        continue
    with wave.open(path) as w:
        secs = w.getnframes() / float(w.getframerate())
    # The box is sat on for a while; a short loop gives itself away. server.py asks for 90s.
    if secs < 60:
        fail(f"{name}: only {secs:.1f}s long - too short to sit under the victory box")

# ---- variations re-sample a shipped take, so their source has to come first ------
# --gen-static-audio walks STATIC_MUSIC in order; a variation listed before its source would be
# re-sampled from the OLD take of a source that is re-rolled a moment later.
order = list(srv.STATIC_MUSIC)
for name, (source, denoise) in srv.STATIC_MUSIC_VARIATIONS.items():
    if name not in front:
        fail(f"{name} is a variation but not in the victory pool")
    if source not in order or name not in order or order.index(source) > order.index(name):
        fail(f"{name}'s source {source!r} is not listed before it in STATIC_MUSIC")
    if not 0.0 < denoise < 1.0:
        fail(f"{name}: denoise {denoise} - 1.0 ignores the source entirely, 0 copies it")

# ---- the served whitelist covers them ------------------------------------------
# do_GET builds its allowed set from STATIC_MUSIC, so this is really a check that nobody has
# replaced that comprehension with a hardcoded tuple.
route = GAME_JS and open(os.path.join(ROOT, "server.py"), encoding="utf-8").read()
if 'tuple(f"{k}_music.wav" for k in STATIC_MUSIC)' not in route:
    fail("the /sounds/ route no longer whitelists every STATIC_MUSIC key, so a new victory "
         "loop would 404")


# ---- the promise: one style is one song, forever --------------------------------
def theme_music_key(style):
    """game.js themeMusicKey, in Python."""
    return re.sub(r"[^a-z0-9]+", "", (style or "").lower())


def victory_track_for(style):
    """game.js victoryTrackFor, in Python. FNV-1a over the normalised style."""
    key = theme_music_key(style)
    if not key:
        return front[0]
    h = 0x811c9dc5
    for ch in key:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return front[h % len(front)]


# Typing the same dungeon a different way must not change the song - a player coming back to
# their favourite style will not reproduce their own capitalisation or punctuation.
for variants in (["forest", "Forest", "FOREST", "  forest  ", '"forest"', "forest!", "forest."],
                 ["ice cave", "Ice Cave", "ice  cave", "ICE-CAVE"],
                 ["windows 95", "Windows 95", "Windows95"]):
    got = {victory_track_for(v) for v in variants}
    if len(got) != 1:
        fail(f"{variants[0]!r} does not always win to one song: "
             f"{ {v: victory_track_for(v) for v in variants} }")

# ...and a DIFFERENT style should be able to get a different one, or the pool is decorative.
if victory_track_for("forest") == victory_track_for("ocean") == victory_track_for("volcano"):
    fail("forest, ocean and volcano all share a song - the hash is not spreading")

# Nothing typed at all, or nothing typeable, falls back rather than throwing or landing
# somewhere undefined.
for empty in ("", "   ", "!!!", "...", None):
    if victory_track_for(empty) != front[0]:
        fail(f"an empty style ({empty!r}) did not fall back to {front[0]!r}")

# The spread should be roughly flat over a real vocabulary - a pool where one track takes half
# the styles is a pool the player mostly never hears.
words = sorted(set(re.findall(r"[a-z]{4,12}", GAME_JS)))
counts = {t: 0 for t in front}
for w in words:
    counts[victory_track_for(w)] += 1
lo, hi = min(counts.values()), max(counts.values())
ideal = len(words) / float(len(front))
if lo < ideal * 0.6 or hi > ideal * 1.5:
    fail(f"the hash is lumpy over {len(words)} words: {counts} (ideal ~{ideal:.0f} each)")

# The hash is a PROMISE about saved dungeons, so pin a few known answers. If one of these ever
# changes for a reason other than the pool shrinking or growing, some player's dungeon has
# quietly changed its victory song - which is allowed, but only on purpose.
#
# With the pool down to two tracks, most styles collapse onto victory_synth - that is expected
# (2 buckets, not a bug) and will spread back out as slots are added back. forest and
# windows95 are kept here specifically because they land on the OTHER bucket, so a change to
# either value still means something even at this pool size.
for style, expect in (("forest", "victory"),
                      ("windows 95", "victory"),
                      ("ocean", "victory_synth"),
                      ("ice cave", "victory_synth"),
                      ("haunted mansion", "victory_synth"),
                      ("candy land", "victory_synth")):
    if victory_track_for(style) != expect:
        fail(f"{style!r} now wins to {victory_track_for(style)!r}, not {expect!r} - every run "
             f"of that style ever played just changed its ending music")

print("FAIL" if bad else f"all victory-music checks passed ({len(front)} tracks)")
sys.exit(1 if bad else 0)
