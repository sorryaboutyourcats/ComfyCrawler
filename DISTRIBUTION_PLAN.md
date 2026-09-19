# ComfyCrawler Distribution Plan

How to get ComfyCrawler in front of other people, and what each option actually
costs. Written after auditing the current codebase (server.py, game.js,
index.html, the dungeon_sessions bundle format, and the installed ComfyUI
0.34.2) rather than guessing at feasibility.

## The fact that decides everything

There are **two products** in this repo, and they have opposite distribution
problems:

| | **The player** | **The studio** |
|---|---|---|
| Files | `index.html` + `game.js` + a `bundle.json` | all of the above + `server.py` (10,000+ lines) |
| Needs | a browser | ComfyUI, an RTX GPU, ~96 GB of models |
| Startup | instant | minutes, per dungeon |

`dungeon_sessions/<id>/bundle.json` is **fully self-contained** — every wall
texture, sprite, portrait, sfx one-shot, music track and narration line is a
base64 data URI inside one ~15 MB file (median across 55 saved runs; range
13.5–18.4 MB, plus a ~1 MB ending clip when present). `server.py`'s
`/api/history_bundle` route streams it from disk *unparsed*. Replaying a saved
dungeon touches neither ComfyUI nor the GPU nor any generation code at all.

That means a zero-setup, zero-GPU, fully playable experience already exists
inside the project — it just needs separating from the generation half.

For scale, here's what the *studio* half actually asks of a stranger
(measured on disk):

- **Core, non-negotiable:** flux1-schnell-fp8 17 GB, krea2_turbo 13 GB, flux
  kontext 12 GB, qwen3vl_4b 4.9 GB, t5xxl 4.6 GB, birefnet 424 MB, ae/clip_l/
  qwen_vae ~800 MB → **~53 GB**
- **+ sound (v6):** SA3 sfx 2.2 GB + t5gemma 1.2 GB → **~3.4 GB**
- **+ ending video:** minimax_h3 20 GB + qwen3vl_32b 15 GB + 2 VAEs 5.5 GB →
  **~40 GB**

**~96 GB total**, plus ComfyUI itself, plus KJNodes/SageAttention, plus 19
hardcoded model filenames that have to match exactly.

Reference: a real v6 run (started 22:30:02, saved 22:34:45) took ~4¾ minutes
on one RTX 3090; the background ending-video job took another ~217s. That's
roughly 7–12 dungeons/hour on one card, one at a time.

---

## Option A — GitHub repo (source + local run)

**Pros**

- Already mostly written for this: clone → `pip install -r requirements.txt`
  → `python server.py`. MIT license in place.
- Audience matches the dependency — anyone who can run ComfyUI with 96 GB of
  checkpoints already owns git and a terminal.
- Zero packaging tax on the dev loop: edit `game.js`, refresh. Stays true
  forever.
- No signing, no installer, no auto-update, no release infra.
- Discoverable by the ComfyUI/workflow crowd, the only people who can
  actually run the generator anyway.

**Cons**

- **Broken for every machine but yours today.** `server.py:36-37` hardcodes
  `C:\Users\sorryaboutyourcats\AppData\Local\Comfy-Desktop\ComfyUI-Shared\...`.
  First run, guaranteed failure, for everyone else.
- Effectively Windows-only: `py -3.10` pin in `start-server.bat`,
  `os.startfile`/`explorer` calls in `server.py`.
- README is stale: it still advertises "Triple Engine Modes (v3/v2/v1)" but
  the picker was removed — `game.js` hardcodes `activeMode = 'v6_krea'`.
  Will generate confused bug reports about a dropdown that no longer exists.
- No screenshots or sample bundle in the repo — visitors see a 3-hour setup
  before the first frame of the actual game.
- You'll get install-support issues, not gameplay feedback — the wrong
  feedback for the thing you're actually iterating on.

---

## Option B — Electron/Tauri app shell

**Pros**

- The Win95 aesthetic wants a real window — own titlebar, taskbar icon, the
  existing favicon. Strongest argument, and it's purely aesthetic.
- Could ship a playable demo with zero setup (bundle + player, no Python) —
  available today because of the self-contained bundle format.
- Kills the CDN dependency honestly: `index.html` currently pulls
  `https://cdn.tailwindcss.com`, the dev build that recompiles CSS in-browser
  on every load — an internet requirement for a game that's otherwise
  offline-capable.
- Can bundle piper_voices/ (121 MB), the ffmpeg binary, an embeddable Python.
- Native local file access instead of the `explorer` subprocess hack.

**Cons**

- **Doesn't remove the real dependency.** An .exe that launches and then
  says "now install ComfyUI and download 96 GB" is worse than a README
  saying it up front, because the .exe implied otherwise.
- Bundling Python is the tedious part — PyInstaller `--onedir` on server.py,
  or embeddable Python 3.10 + wheels (onnxruntime for piper alone ≈200 MB).
- Unsigned build = SmartScreen warning wall. A cert is $200–400/yr.
- Auto-update needs real infrastructure (electron-updater + release feed) or
  manual zip posting forever.
- Puts a build step between every code change and testing it — worth
  defending against.
- Electron is heavy for what's a localhost page (~180 MB runtime) with zero
  Node dependencies in the frontend. **Tauri** (~3 MB, rides Windows'
  existing WebView2) fits much better if this route is taken at all.

**Verdict: dropped.** Superseded by Option D below, which gets the "real
window, zero setup" benefit via a website instead.

---

## Option C — Hosted/rented generation (cloud GPUs)

Considered and rejected — kept here so the reasoning doesn't get re-litigated
later.

- `server.py` runs a plain single-threaded `socketserver.TCPServer` — one
  request at a time, shared global progress state. Would need a real rewrite
  (job queue, per-user state, auth, rate limits) before it could serve
  multiple strangers at once.
- Renting 24GB+ GPU capacity runs roughly $0.30–$1/hr; keeping one warm to
  avoid reloading ~53 GB of core models on every cold start means a few
  hundred dollars/month for a hobby project.
- Public text input that draws real people/brands (a real run named its hero
  "Will Smith" and setting "Pizza Hut") is a moderation liability the moment
  it's not just you typing it.
- Licensing needs a real look before any paid/ad-supported hosting: FLUX.1
  Kontext [dev] is non-commercial-licensed; krea2, MiniMax H3, and Stable
  Audio 3 need the same check before serving them to the public.

**Not part of the plan.** Forgotten per instruction — generation stays local
to whoever runs it, on their own hardware.

---

## Option D — Website + visitor's own local ComfyUI (chosen direction)

This is the one that's actually worth building. Splits into two halves with
different levels of effort.

### D1 — Play saved dungeons on a website (easy, ~1 day)

**Done.** A `SHOWCASE_MODE` flag (`window.COMFYCRAWLER_SHOWCASE`, read once
near the top of `game.js`) gates the differences; `tools/export_showcase.py`
produces the static folder from a curated `tools/showcase_ids.txt`. See that
script and the flag's call sites in `game.js` for the mechanism. Original
scope, for reference:

A static site (e.g. GitHub Pages) that plays back saved `bundle.json` files.
No server, no Python, no GPU — just files.

Why it works: `game.js` already renders a bundle by reading one JSON blob
with embedded data URIs. The site only needs to serve files.

Work:
1. ~~Make `SERVER_URL` relative instead of hardcoded to
   `http://127.0.0.1:5555`.~~ Already was, going in.
2. Replace `/api/history` with a static manifest file, and
   `/api/history_bundle` with the bundle files themselves served as static
   assets — same format the page already reads.
3. Move favorites/"beaten" state into each visitor's own browser storage
   (today it's server-side; each visitor needs their own "beaten" state so
   the movie button's spoiler lock still means something).
4. Hide CREATE, delete, and open-folder — none of those make sense without a
   server. (Also dropped: the History row's Prompts button, and the
   quit-confirm box's own separate "Erase Current Run" — both are either a
   doorway back into generation or a second delete path.)
5. Nice to have: ~~build Tailwind once instead of loading the CDN's dev
   build~~ (done separately, before this); shrink the 62 MB of WAVs in
   `sounds/` (not done — the export script's sound whitelist keeps the
   footprint to what `/sounds/` actually serves, but the WAVs themselves are
   still uncompressed).

Free hosting (e.g. GitHub Pages) comfortably covers this: ~60 dungeons fits
in a 1 GB site cap, and a 100 GB/month traffic cap covers roughly 6,000
dungeon loads.

### D2 — Generate dungeons via the visitor's own ComfyUI (harder, few days)

**A plain website cannot do this alone.** Two blockers:

1. **ComfyUI actively blocks it.** The installed ComfyUI 0.34.2 has an
   origin-check middleware that 403s any request whose `Origin` doesn't
   match `Host` when the target is loopback — explicitly written to stop "a
   random website" from queuing jobs on someone's GPU via a POST to
   `127.0.0.1`.
2. **`server.py` does more than call ComfyUI.** It reads/writes ComfyUI's
   folders directly on disk (28 call sites), does substantial local work
   around the ComfyUI calls (41 Pillow ops, 75 numpy calls, 4 ffmpeg
   invocations, Piper TTS), and holds ~10,000 lines of tuned logic. None of
   that can be reimplemented in browser JavaScript without weeks of
   rewriting.

**The fix: ship `server.py`'s logic as a ComfyUI custom node instead of a
standalone Python server.** A custom node runs on ComfyUI's own Python
process, so the "separate Python install" problem disappears, and it's
installed the way this audience already installs things (ComfyUI-Manager).

Why ComfyUI already provides what's needed:
- A way to register your own web routes on ComfyUI's own aiohttp server —
  your API lives inside ComfyUI, same-origin, no CORS prompt needed for the
  page ComfyUI itself would serve.
- Folder helpers (`get_input_directory`, `get_output_directory`,
  `get_user_directory`) that resolve correctly on any machine — replacing
  the hardcoded paths at `server.py:36-37`, which is currently the #1 reason
  the repo is unrunnable by anyone else.
- A way to list installed model files, for a setup/preflight screen showing
  exactly which of the 19 required `.safetensors` files are present.
- Pillow and numpy, already installed alongside ComfyUI.
- Every node type v6 needs is core to 0.34.2 (TextGenerate,
  MiniMaxH3ReferenceToVideo, RemoveBackground, LoadBackgroundRemovalModel,
  ReferenceLatent) **except** `SaveImageWithAlpha` and
  `PathchSageAttentionKJ`, which come from the KJNodes custom-node pack —
  that becomes a hard dependency, not optional.

The node can serve the game itself at `http://127.0.0.1:8188/comfycrawler/`
— same origin as ComfyUI, so no CORS setting is even needed for that page.
The externally-hosted gallery site is what needs the visitor to explicitly
allow cross-origin access.

**Catches to design around:**

1. **CORS must be opt-in and the visitor must understand what they're
   opting into.** They set ComfyUI's "Enable CORS header" (visible in
   Desktop's Settings → Network) to the gallery site's exact origin, or pass
   `--enable-cors-header <origin>` on launch for non-Desktop installs. Warn
   clearly: the flag with no origin defaults to `*`, which lets *any*
   website on the internet queue jobs on their GPU.
2. **Every request handler must run off the main thread.** ComfyUI's server
   is single-process; a handler that blocks (like today's `/api/fill_in`,
   which deliberately holds the connection while a text-generation call
   runs) would freeze ComfyUI's own UI for that duration, not just the
   ComfyCrawler tab. This has to become "queue work, return immediately,
   poll for status" everywhere it isn't already.
3. **KJNodes becomes a hard requirement**, not "used automatically when
   present" as noted in the current README — because `SaveImageWithAlpha`
   is used unconditionally.
4. **Piper/onnxruntime can collide with other custom nodes'** GPU-bound
   onnxruntime versions. Keep it an optional install; it already
   fails-soft today (`_get_piper_voice` returns `None` rather than raising).
5. **Don't mutate ComfyUI's global state on import** (e.g. stdout/stderr
   reconfiguration at the top of `server.py`) — that's fine for a
   standalone process, not fine inside someone else's running server.
6. **Browser permission prompts.** Chrome may prompt the visitor the first
   time a public page reaches into their own machine's `localhost`; Safari
   behavior needs testing. The same-origin `/comfycrawler/` page served
   directly by ComfyUI avoids this entirely — always offer it as the
   default, no-setup path, with the gallery-site "Connect to your ComfyUI"
   button as an enhancement.

---

## The plan

1. **Phase 0 — fixes both remaining routes need.**
   Mostly subsumed into the custom-node rewrite: paths, port, and model
   presence all come from ComfyUI's own APIs instead of hardcoded values.
   - Un-hardcode `COMFY_INPUT_DIR`/`COMFY_OUTPUT_DIR`.
   - Vendor Tailwind's compiled CSS instead of the CDN dev build.
   - Startup preflight: check ComfyUI is reachable, list which of the 19
     required model files are present, explain what's missing and what it
     costs (no sfx / no ending video / nothing works).
   - Make `SERVER_URL` relative.

2. **Phase 1 — the GitHub repo becomes the custom node.**
   - Rewrite the engine section of the README: v6 is the only mode, delete
     the stale triple-engine copy.
   - Real model checklist with sizes and what's optional (53 / +3.4 / +40 GB).
   - Screenshots and a short gif — highest-value single item, currently
     completely missing.
   - List on the Comfy Registry so ComfyUI-Manager can find/install it.
   - Tag a release.

3. **Phase 2 — the gallery site.**
   - D1 (play saved bundles, static hosting) first — cheap, immediate,
     shippable this week.
   - D2 ("Connect to your ComfyUI" button: address field defaulting to
     `http://127.0.0.1:8188`, a test call, plain-language errors for the
     three likely failure modes — ComfyUI not running, node not installed,
     CORS not set) layered on once the custom node exists.
   - A "publish to gallery" action from the History window is the natural
     bridge between local generation and the public site, once both exist.

4. **Dropped:** renting cloud GPUs (Option C) and the Electron/Tauri app
   shell (Option B) — both superseded by Option D.

One thing doesn't change under any option: generating a dungeon still needs
~53 GB of core models on the machine doing the generating. Nothing in this
plan makes that requirement smaller — it only removes the *packaging and
install-friction* on top of it.
