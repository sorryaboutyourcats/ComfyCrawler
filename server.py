"""
ComfyCrawler - Server & Engine
A retro Windows 95 style 3D dungeon escape game powered by ComfyUI, FLUX.1 [schnell], and MiniMax H3.
"""

from PIL import Image, ImageStat
import numpy as np
import sys
import re
import io
# Only a plain console stream: inside ComfyUI, stdout is its LogInterceptor (a TextIOWrapper
# SUBCLASS), and re-encoding that would change ComfyUI's own log output, not just ours.
if sys.platform == "win32" and type(sys.stdout) is io.TextIOWrapper:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import errno
import http.server
import socketserver
import urllib.request
import urllib.error
import urllib.parse
import json
import os
import shutil
import time
import base64
import random
import threading
import subprocess
import uuid
import wave

PORT = int(os.environ.get("COMFYCRAWLER_PORT") or 5555)

# Where ComfyUI is and the folders it reads from / writes to. None of this is hardcoded to one
# machine any more: ensure_comfy() (see COMFYUI CONNECTION below) asks the running ComfyUI and
# fills these in, and every entry point that talks to ComfyUI calls it first. They stay plain
# module globals because dozens of call sites read them at call time and the tests swap them.
COMFY_URL = "http://127.0.0.1:8188"
COMFY_INPUT_DIR = None
COMFY_OUTPUT_DIR = None
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
SESSIONS_DIR = os.path.join(PROJECT_DIR, "dungeon_sessions")

# The two folders /api/open_folder will open by name. A KEY comes in over the wire, never a path,
# so no request can name a directory of its own. "sessions" is what the trash can in the History
# window deletes from; "assets" is where ComfyUI drops the raw renders that every bundle is built
# out of - nothing reads them back once a run is saved, so that folder is also where a cancelled
# run's leftovers pile up. Each maps to a global's NAME, looked up when the request arrives -
# COMFY_OUTPUT_DIR is not known until ensure_comfy() has run. (The About window's model rows send
# a second kind of key, "model:<folder>", whitelisted by MODEL_FOLDER_NAMES further down.)
OPENABLE_FOLDERS = {"sessions": "SESSIONS_DIR", "assets": "COMFY_OUTPUT_DIR"}


def _open_folder_now(folder):
    """Show `folder` in Explorer. Fire and forget: this server takes one request at a time, so
    waiting on Explorer here would stall the progress poll queued behind it."""
    try:
        os.startfile(folder)
    except Exception:
        subprocess.Popen(["explorer", os.path.normpath(folder)])
    print(f"[folder] opened {folder}")

# ---------------------------------------------------------------------------
# COMFYUI CONNECTION
# ComfyCrawler reads and writes ComfyUI's input/output folders directly (reference pictures go
# in, renders come back out), so it has to know where they are. Each of the three values - the
# address, the input folder, the output folder - comes from the first of these that gives one:
#   1. an environment variable (COMFY_SETTING_ENV) - for a launcher script that pins it;
#   2. Options > ComfyUI Connection, saved in comfy_settings.json (load_comfy_settings);
#   3. the running ComfyUI itself: the first of COMFY_URL_CANDIDATES that answers /system_stats,
#      then the --input-directory / --output-directory it was launched with (ComfyUI Desktop
#      passes both), else <base>/input and <base>/output, where <base> is --base-directory or the
#      folder ComfyUI's own custom_nodes sits in - the same way its folder_paths.py derives them.
COMFY_URL_CANDIDATES = ("http://127.0.0.1:8188", "http://127.0.0.1:8000")
COMFY_SETTINGS_PATH = os.path.join(PROJECT_DIR, "comfy_settings.json")
COMFY_SETTING_ENV = {"url": "COMFYUI_URL", "input_dir": "COMFYUI_INPUT_DIR", "output_dir": "COMFYUI_OUTPUT_DIR",
                     "models_dir": "COMFYUI_MODELS_DIR"}
_COMFY_RESOLVED = False
_COMFY_VERSION = None
# Where each resolved value came from - "env", "options", "auto" or "comfyui" - so Options can say.
_COMFY_SOURCES = {"url": None, "input_dir": None, "output_dir": None}
# ComfyUI's own root folder (the one with models/, input/, output/, custom_nodes/) - set by
# _resolve_comfy alongside COMFY_INPUT_DIR/COMFY_OUTPUT_DIR, for comfy_model_dir's fallback when
# neither Options nor ComfyUI's own /internal/folder_paths says where a model folder lives.
_COMFY_BASE_DIR = None
# Set by the custom node (__init__.py) when ComfyCrawler runs INSIDE ComfyUI: {"url": its own
# loopback address, "input_dir" / "output_dir": callables into its folder_paths}. None when this
# file is the standalone server. Embedded, none of the three sources above apply - ComfyUI is
# right here and says exactly where its folders are - and Options' connection section is hidden.
COMFY_EMBEDDED = None


def normalize_comfy_url(text):
    """A typed ComfyUI address as http(s)://host:port, or "" for auto-detect. Forgives a missing
    http:// and a trailing slash; raises ValueError, worded for the player, on anything else."""
    text = (text or "").strip().strip('"').strip()
    if not text:
        return ""
    if "://" not in text:
        text = "http://" + text
    text = text.rstrip("/")
    bad = ValueError(f'"{text}" isn\'t a ComfyUI address - it should look like http://127.0.0.1:8188')
    parts = urllib.parse.urlsplit(text)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.query or parts.fragment:
        raise bad
    try:
        parts.port            # a non-numeric or out-of-range port raises here
    except ValueError:
        raise bad
    return text


def normalize_comfy_dir(text):
    """A typed folder, minus the quotes Explorer's "Copy as path" wraps it in - "" for auto-detect.
    Not checked for existence: comfy_preflight reports a folder that isn't there, right in Options."""
    text = (text or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    return os.path.normpath(text) if text else ""


def load_comfy_settings():
    """What Options > ComfyUI Connection saved: {"url", "input_dir", "output_dir"}, "" meaning
    auto-detect. A missing or unreadable file is all auto-detect, never an error."""
    settings = {key: "" for key in COMFY_SETTING_ENV}
    try:
        with open(COMFY_SETTINGS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for key in settings:
                if isinstance(data.get(key), str):
                    settings[key] = data[key]
    except (OSError, ValueError):
        pass
    return settings


def save_comfy_settings(url="", input_dir="", output_dir="", models_dir=""):
    """Normalise and store Options' ComfyUI overrides; returns what was stored. All four blank
    deletes the file, so auto-detecting everything leaves nothing behind. Raises ValueError for a
    malformed address, before anything is written."""
    settings = {"url": normalize_comfy_url(url), "input_dir": normalize_comfy_dir(input_dir),
                "output_dir": normalize_comfy_dir(output_dir), "models_dir": normalize_comfy_dir(models_dir)}
    if not any(settings.values()):
        try:
            os.remove(COMFY_SETTINGS_PATH)
        except FileNotFoundError:
            pass
        return settings
    tmp = COMFY_SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
    os.replace(tmp, COMFY_SETTINGS_PATH)
    return settings


def _comfy_setting(key, saved):
    """(value, source) for one setting fixed by the environment or by Options; ("", "auto") when
    neither fixes it and it has to be detected."""
    env = (os.environ.get(COMFY_SETTING_ENV[key]) or "").strip()
    if env:
        return env, "env"
    if saved.get(key):
        return saved[key], "options"
    return "", "auto"


# ---------------------------------------------------------------------------
# PAGE SETTINGS
# The page's remembered choices - Options (difficulty, max frame rate, ending video and its look,
# screensaver wait) and the quick-ideas shuffle count - kept here rather than only in the browser.
# A browser keeps localStorage per address, so the standalone page (127.0.0.1:5555) and the one
# served inside ComfyUI (127.0.0.1:8188/comfycrawler/) would each remember their own - a run
# played on one ignored Ending Video being switched on in the other. The page still mirrors them
# to localStorage (game.js `prefs`), and uploads its own the first time it meets a server that
# has none, so choices made before this existed carry over. Values are strings, like
# localStorage's; keys are game.js's own `comfycrawler.*` names. The node points
# PAGE_SETTINGS_PATH beside its saved dungeons (comfy_node.install), so both share one file.
PAGE_SETTINGS_PATH = os.path.join(PROJECT_DIR, "page_settings.json")
PAGE_SETTING_PREFIX = "comfycrawler."
PAGE_SETTINGS_MAX_KEYS = 64
PAGE_SETTING_MAX_CHARS = 1000
# The <script> index.html carries for the settings; the server fills it in as the page is served,
# so every read in game.js stays synchronous. A copy served by anything else keeps the empty {}.
SAVED_SETTINGS_TAG = b'<script id="savedSettings" type="application/json">{}</script>'
# Whether ComfyUI Connection's editable fields start out shown. Left as-is (shown) they used to
# flash tall and then shrink on embedded's very first open: game.js only learns COMFY_EMBEDDED
# once /api/comfy_settings answers, so the fields rendered before hiding themselves a beat later.
# COMFY_EMBEDDED is known synchronously at serve time, so the "hidden" class is written straight
# into the markup here instead - the fields never appear in the first place when embedded.
COMFY_SETTINGS_FIELDS_TAG = b'<div id="comfySettingsFields" class="flex flex-col gap-1.5">'
_PAGE_SETTINGS_LOCK = threading.Lock()


def load_page_settings():
    """The saved page settings as {key: string}. A missing or unreadable file is no settings."""
    try:
        with open(PAGE_SETTINGS_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items()
            if isinstance(k, str) and k.startswith(PAGE_SETTING_PREFIX) and isinstance(v, str)}


def save_page_settings(changes):
    """Merge {key: string, or None to forget it} into the saved settings; returns them all. Raises
    ValueError, before writing anything, for anything that isn't one of the page's own settings.
    Re-read under the lock right before writing, so a change sent by the other address in between
    is kept rather than overwritten."""
    if not isinstance(changes, dict):
        raise ValueError("Settings must be an object of name: value.")
    for key, value in changes.items():
        if not (isinstance(key, str) and key.startswith(PAGE_SETTING_PREFIX) and len(key) <= 100):
            raise ValueError(f"{key!r} isn't a ComfyCrawler setting.")
        if value is not None and not (isinstance(value, str) and len(value) <= PAGE_SETTING_MAX_CHARS):
            raise ValueError(f"The value for {key!r} must be text of at most {PAGE_SETTING_MAX_CHARS} characters.")
    with _PAGE_SETTINGS_LOCK:
        settings = load_page_settings()
        for key, value in changes.items():
            if value is None:
                settings.pop(key, None)
            else:
                settings[key] = value
        if len(settings) > PAGE_SETTINGS_MAX_KEYS:
            raise ValueError("Too many settings.")
        os.makedirs(os.path.dirname(PAGE_SETTINGS_PATH) or ".", exist_ok=True)
        tmp = PAGE_SETTINGS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2, sort_keys=True)
        os.replace(tmp, PAGE_SETTINGS_PATH)
    return settings


def page_with_saved_settings(html_bytes):
    """index.html with the saved settings written into its #savedSettings tag (every "<" escaped,
    so no value can close the script element early) and, when running embedded, the ComfyUI
    Connection fields already marked hidden - see COMFY_SETTINGS_FIELDS_TAG."""
    payload = json.dumps(load_page_settings(), ensure_ascii=True).replace("<", "\\u003c")
    html_bytes = html_bytes.replace(
        SAVED_SETTINGS_TAG,
        b'<script id="savedSettings" type="application/json">' + payload.encode("ascii") + b"</script>", 1)
    if COMFY_EMBEDDED:
        html_bytes = html_bytes.replace(
            COMFY_SETTINGS_FIELDS_TAG,
            b'<div id="comfySettingsFields" class="flex flex-col gap-1.5 hidden">', 1)
    return html_bytes


class ComfyUnavailable(Exception):
    """ComfyUI couldn't be reached, or its folders couldn't be found. The message is written for
    the player, so handlers send it back as-is. `reachable` says whether ComfyUI answered at all;
    `restart` that restarting ComfyUI's server is the fix (see _comfy_system_stats), which is what
    puts the Restart ComfyUI button in front of the player instead of leaving them to find it."""
    def __init__(self, message, reachable=False, restart=False):
        super().__init__(message)
        self.reachable = reachable
        self.restart = restart


def _comfy_get_json(path, timeout=5, base=None):
    """GET <base or COMFY_URL><path> and parse the JSON; raises on any failure. The one door the
    connection and preflight code go through, so the tests can stand a fake ComfyUI behind it."""
    with urllib.request.urlopen(f"{base or COMFY_URL}{path}", timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _comfy_system_stats(url, timeout=3):
    """/system_stats for the connection code, with the two ways it fails told apart.

    Nothing listening is a ComfyUI that isn't up yet - wait, or start it. ComfyUI answering with a
    500 is the one that looks the same from here but isn't: /system_stats asks the graphics card how
    much memory it has, and once the computer has slept, that call raises inside ComfyUI's process
    for good ("CUDA error: unknown error"). Its web server carries on answering everything else, so
    the queue looks healthy, but the CUDA context is gone and every render would fail too. Nothing
    ComfyUI or ComfyCrawler can do in that process brings it back - only starting ComfyUI's server
    again - so the message says that instead of telling the player to keep waiting."""
    try:
        return _comfy_get_json("/system_stats", timeout=timeout, base=url)
    except urllib.error.HTTPError as e:
        raise ComfyUnavailable(
            f"ComfyUI is running at {url}, but it has lost its link to the graphics card - this is "
            "what putting the computer to sleep does to it, and dungeons would fail the same way. "
            "Restarting ComfyUI's server fixes it; nothing else needs restarting.",
            reachable=True, restart=True) from e


def _argv_value(argv, flag):
    """The value given for `flag` in a ComfyUI launch argv, as --flag value or --flag=value."""
    for i, arg in enumerate(argv):
        if arg == flag and i + 1 < len(argv):
            return argv[i + 1]
        if isinstance(arg, str) and arg.startswith(flag + "="):
            return arg[len(flag) + 1:]
    return None


def _comfy_base_dir(argv, base_url):
    """ComfyUI's own root directory (the one with models/, input/, output/, custom_nodes/) - from
    --base-directory, or else asking ComfyUI's own /internal/folder_paths where its custom_nodes
    live. None when neither says."""
    base = _argv_value(argv, "--base-directory")
    if not base:
        try:
            nodes = _comfy_get_json("/internal/folder_paths", base=base_url).get("custom_nodes") or []
            base = os.path.dirname(nodes[0]) if nodes else None
        except Exception:
            base = None
    return base


def _detect_comfy_dirs(argv, base_url, input_dir="", output_dir=""):
    """(input_dir, output_dir) for the ComfyUI answering at base_url, launched with argv. A folder
    passed in (fixed by the environment or Options) is kept; either can come back None when nothing
    says where it is."""
    input_dir = input_dir or _argv_value(argv, "--input-directory")
    output_dir = output_dir or _argv_value(argv, "--output-directory")
    if not (input_dir and output_dir):
        base = _comfy_base_dir(argv, base_url)
        if base:
            input_dir = input_dir or os.path.join(base, "input")
            output_dir = output_dir or os.path.join(base, "output")
    return input_dir, output_dir


def _detect_comfy_model_dirs(base_url, folder_name, base_dir, fixed_root=""):
    """Every directory this machine's ComfyUI searches for `folder_name` models (e.g.
    "diffusion_models", "checkpoints"), in the order it searches them. `fixed_root` (Options'
    Models folder override, or COMFYUI_MODELS_DIR) names the models ROOT directly and skips asking
    ComfyUI - there is only ever one directory then. Otherwise tries ComfyUI's own
    /internal/folder_paths for this folder type - which honours extra_model_paths.yaml and can name
    more than one directory - and falls back to <base_dir>/models/<folder_name>, the standard
    ComfyUI layout (`base_dir` is whatever _comfy_base_dir found). Empty when nothing says."""
    if fixed_root:
        return [os.path.join(fixed_root, folder_name)]
    try:
        paths = _comfy_get_json("/internal/folder_paths", base=base_url).get(folder_name) or []
        if paths:
            return list(paths)
    except Exception:
        pass
    return [os.path.join(base_dir, "models", folder_name)] if base_dir else []


def comfy_model_dirs(folder_name):
    """Every directory this machine's ComfyUI searches for `folder_name` models, in order - not
    just the one a new download lands in (comfy_model_dir). extra_model_paths.yaml and ComfyUI
    Desktop's shared-models base both commonly add a second, and a given file can genuinely live
    in that one rather than the first - see comfy_model_file_dir, which is what the About window
    uses to show the directory a file is ACTUALLY in. Call after ensure_comfy()."""
    if COMFY_EMBEDDED:
        try:
            if "model_dirs" in COMFY_EMBEDDED:
                return list(COMFY_EMBEDDED["model_dirs"](folder_name))
            # An older comfy_node.py's COMFY_EMBEDDED only ever had "model_dir" (one directory) -
            # "Reload server.py" can leave that running against a newer server.py, so fall back to
            # it as a single-item list rather than breaking every model directory lookup.
            single = COMFY_EMBEDDED["model_dir"](folder_name)
            return [single] if single else []
        except Exception:
            return []
    fixed_root, _source = _comfy_setting("models_dir", load_comfy_settings())
    return _detect_comfy_model_dirs(COMFY_URL, folder_name, _COMFY_BASE_DIR, fixed_root)


def comfy_model_dir(folder_name):
    """The one directory a NEW `folder_name` download lands in - always the first ComfyUI
    searches, matching what folder_paths.get_folder_paths()[0] and a plain download destination
    have always meant here. For where an EXISTING file actually sits, use comfy_model_file_dir
    instead: a folder type can have more than one search directory, and the file need not be in
    this one. None when it can't be determined. Call after ensure_comfy()."""
    dirs = comfy_model_dirs(folder_name)
    return dirs[0] if dirs else None


def comfy_model_file_dir(folder_name, filename, dirs=None):
    """The directory among `folder_name`'s search paths that actually holds `filename` on disk,
    or the primary one (comfy_model_dir's answer - where a download would land) when none of them
    do. ComfyCrawler and the ComfyUI it talks to always run on the same machine (see the About
    window's "nothing leaves" line), so this is a plain, cheap os.path.isfile check per candidate
    rather than another round trip to ComfyUI - and it is the only way to tell which directory a
    file is really in when a folder type has more than one, which is ordinary with
    extra_model_paths.yaml or ComfyUI Desktop's shared-models layout. `dirs` reuses an already
    fetched comfy_model_dirs() list when checking several files in the same folder type - pass it
    to skip asking ComfyUI again. Call after ensure_comfy()."""
    if dirs is None:
        dirs = comfy_model_dirs(folder_name)
    for d in dirs:
        try:
            if d and os.path.isfile(os.path.join(d, filename)):
                return d
        except Exception:
            continue
    return dirs[0] if dirs else None


def ensure_comfy(refresh=False):
    """Fill in COMFY_URL / COMFY_INPUT_DIR / COMFY_OUTPUT_DIR (see COMFYUI CONNECTION). Cached
    once it works; `refresh` asks again anyway - the preflight does on every page load, CREATE and
    Options change, so a ComfyUI restarted elsewhere is noticed. Raises ComfyUnavailable. Like
    _sage_attention_available, a failure is never cached: ComfyUI is often started after this
    server, so the next call just retries. A refresh that fails also forgets the last good answer,
    so whatever Options was just set to is what every later call is held to."""
    global _COMFY_RESOLVED
    if _COMFY_RESOLVED and not refresh:
        return
    try:
        _resolve_comfy()
    except ComfyUnavailable:
        _COMFY_RESOLVED = False
        raise


def _resolve_embedded_comfy():
    """_resolve_comfy inside ComfyUI: the address and folders come from ComfyUI itself. It still
    asks /system_stats, both for the version and because the node loads before ComfyUI listens -
    a call that early fails like any unreachable ComfyUI, and the next one retries."""
    global COMFY_URL, COMFY_INPUT_DIR, COMFY_OUTPUT_DIR, _COMFY_RESOLVED, _COMFY_VERSION
    url = COMFY_EMBEDDED["url"]
    try:
        stats = _comfy_system_stats(url)
    except ComfyUnavailable:
        raise                     # it answered, and said something worth passing on unchanged
    except Exception:
        raise ComfyUnavailable(f"ComfyUI isn't answering at {url} yet - it may still be starting up.")
    input_dir, output_dir = COMFY_EMBEDDED["input_dir"](), COMFY_EMBEDDED["output_dir"]()
    system = stats.get("system") or {}
    if not _COMFY_RESOLVED or (url, input_dir, output_dir) != (COMFY_URL, COMFY_INPUT_DIR, COMFY_OUTPUT_DIR):
        print(f"[comfy] running inside ComfyUI {system.get('comfyui_version') or '?'} at {url} - "
              f"input {input_dir}, output {output_dir}")
    COMFY_URL, COMFY_INPUT_DIR, COMFY_OUTPUT_DIR = url, input_dir, output_dir
    _COMFY_VERSION = system.get("comfyui_version")
    _COMFY_SOURCES.update(url="comfyui", input_dir="comfyui", output_dir="comfyui")
    _COMFY_RESOLVED = True


def _resolve_comfy():
    global COMFY_URL, COMFY_INPUT_DIR, COMFY_OUTPUT_DIR, _COMFY_RESOLVED, _COMFY_VERSION, _COMFY_BASE_DIR
    if COMFY_EMBEDDED:
        return _resolve_embedded_comfy()
    saved = load_comfy_settings()
    fixed_url, url_source = _comfy_setting("url", saved)
    fixed_url = fixed_url.rstrip("/")
    stats, url, answered_badly = None, None, None
    for candidate in ((fixed_url,) if fixed_url else COMFY_URL_CANDIDATES):
        try:
            stats = _comfy_system_stats(candidate)
            url = candidate
            break
        except ComfyUnavailable as e:
            answered_badly = answered_badly or e     # a ComfyUI that IS there, with a broken GPU
        except Exception:
            continue
    if stats is None:
        if answered_badly:
            raise answered_badly
        if url_source == "env":
            raise ComfyUnavailable(f"Couldn't reach ComfyUI at {fixed_url} (set by the COMFYUI_URL "
                                   "environment variable) - is it running?")
        if url_source == "options":
            raise ComfyUnavailable(f"Couldn't reach ComfyUI at {fixed_url}, the address set in Options - "
                                   "is it running, and is that where it is?")
        raise ComfyUnavailable("Couldn't reach ComfyUI at %s - is it running? If it uses a different "
                               "address, set it in Options > ComfyUI Connection."
                               % " or ".join(COMFY_URL_CANDIDATES))
    system = stats.get("system") or {}
    _COMFY_BASE_DIR = _comfy_base_dir(system.get("argv") or [], url)
    fixed_in, in_source = _comfy_setting("input_dir", saved)
    fixed_out, out_source = _comfy_setting("output_dir", saved)
    input_dir, output_dir = _detect_comfy_dirs(system.get("argv") or [], url, fixed_in, fixed_out)
    lost = [d or "(unknown)" for d in (input_dir, output_dir) if not d or not os.path.isdir(d)]
    if lost:
        raise ComfyUnavailable(
            "ComfyUI answered at %s, but its folders aren't on this computer: %s. ComfyCrawler "
            "reads and writes them directly, so ComfyUI has to run on this computer - or set the "
            "right folders in Options > ComfyUI Connection." % (url, ", ".join(lost)), reachable=True)
    if not _COMFY_RESOLVED or (url, input_dir, output_dir) != (COMFY_URL, COMFY_INPUT_DIR, COMFY_OUTPUT_DIR):
        print(f"[comfy] ComfyUI {system.get('comfyui_version') or '?'} at {url} ({url_source}) - "
              f"input {input_dir} ({in_source}), output {output_dir} ({out_source})")
    COMFY_URL, COMFY_INPUT_DIR, COMFY_OUTPUT_DIR = url, input_dir, output_dir
    _COMFY_VERSION = system.get("comfyui_version")
    _COMFY_SOURCES.update(url=url_source, input_dir=in_source, output_dir=out_source)
    _COMFY_RESOLVED = True


# The all-in-one FLUX.1 [schnell] checkpoint behind the wall / floor / ceiling / door / lantern /
# switch surfaces, and the BiRefNet model every cutout goes through. Named once here so the
# preflight's list (COMFY_MODEL_GROUPS) can't drift from what the graphs actually load.
FLUX_SCHNELL_CKPT = "flux1-schnell-fp8.safetensors"
BIREFNET_MODEL = "birefnet.safetensors"

# v5 "krea2 turbo" engine. A single Qwen-arch diffusion model (no ControlNet / no
# IPAdapter available for it), so v5 generates ONE clean image per asset instead
# of v4's SDXL-Lightning + IPAdapter + OpenPose rig. Distilled from the workflow
# embedded in ComfyUI-Shared/output/Krea2_turbo_0000*.png. cfg is fixed at 1.0 -
# the model is distilled and the "negative" is a ConditioningZeroOut, so a real
# negative prompt does nothing. Resolution used to be a UI input; it is now driven by
# the "Graphics Quality" dropdown (GFX_QUALITY_PROFILES). Steps was a UI input too,
# never adjusted, so it is fixed at KREA2_STEPS_DEFAULT.
KREA2_UNET = "krea2_turbo_fp8_scaled.safetensors"
KREA2_CLIP = "qwen3vl_4b_fp8_scaled.safetensors"
KREA2_VAE = "qwen_image_vae.safetensors"
KREA2_STEPS_DEFAULT = 8
KREA2_CFG = 1.0

# "Graphics Quality" dropdown on the setup screen -> a per-asset-class target resolution
# (px). Every generated asset is sized from one of these keys; each value is already a
# multiple of 16 (a valid latent) so it feeds EmptyLatentImage directly. Dropdown order
# is normal, optimized, reduced.
#   normal    - full resolution everywhere.
#   optimized - a middle tier: tiling textures, player frames and enemy sprites at 384,
#               the switch / lantern cutouts at 192 and the HUD portraits at 192.
#               Meaningfully faster than normal, well short of reduced's coarseness.
#   reduced   - half resolution across the board; fastest and lightest.
#   texture  = wall / ceiling / floor / door tiling surfaces (FLUX schnell)
#   object   = switch + lantern BiRefNet cutouts (FLUX schnell)
#   player   = krea2 player sprite / v6 pose frames / weapon / shield
#   enemy    = krea2 enemy variant sprites (walker / flyer / boss frames)
#   portrait = FLUX Kontext HUD portrait busts (idle / attack / block / hurt)
GFX_QUALITY_PROFILES = {
    "normal":    {"texture": 512, "object": 384, "player": 512, "enemy": 512, "portrait": 256},
    "optimized": {"texture": 384, "object": 192, "player": 384, "enemy": 384, "portrait": 192},
    "reduced":   {"texture": 256, "object": 192, "player": 256, "enemy": 256, "portrait": 128},
}
GFX_QUALITY_DEFAULT = "normal"

# Player-facing name for each dropdown key - what the History window prints next to a
# saved dungeon so you can see which tier its assets were baked at. "normal" is the
# full-resolution tier, shown as "high quality".
GFX_QUALITY_LABELS = {
    "normal":    "high quality",
    "optimized": "optimized",
    "reduced":   "reduced",
}


def _gfx_profile(quality):
    """Resolve a Graphics Quality name to its resolution profile, falling back to normal."""
    return GFX_QUALITY_PROFILES.get(quality, GFX_QUALITY_PROFILES[GFX_QUALITY_DEFAULT])

# SESSIONS_DIR is NOT created here at import: inside ComfyUI the node first decides where it goes
# (comfy_node.choose_data_dir), and making the default one first would always win that choice.
# run_server() and the node each create it once it's settled.

# ---------------------------------------------------------------------------
# File logging. Until this, server.py only ever wrote to its console - so when the
# process died (terminal closed, machine slept, an unhandled exception) there was
# nothing left to say why. Everything on stdout/stderr - our own print()s,
# BaseHTTPRequestHandler's access log, and any traceback - is now also appended to
# server.log next to this file, with the prior run rolled to server.log.1 on start.
LOG_PATH = os.path.join(PROJECT_DIR, "server.log")


class _Tee:
    """Write-through to the real stream plus the log file; never let the log break output."""
    def __init__(self, stream, fh):
        self._stream = stream
        self._fh = fh

    def write(self, text):
        try:
            self._stream.write(text)
        except Exception:
            pass
        try:
            self._fh.write(text)
            self._fh.flush()
        except Exception:
            pass

    def flush(self):
        for t in (self._stream, self._fh):
            try:
                t.flush()
            except Exception:
                pass

    def isatty(self):
        return getattr(self._stream, "isatty", lambda: False)()


def _init_file_logging():
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 0:
            bak = LOG_PATH + ".1"
            try:
                if os.path.exists(bak):
                    os.remove(bak)
            except Exception:
                pass
            try:
                os.replace(LOG_PATH, bak)
            except Exception:
                pass
        fh = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
    except Exception as e:  # a locked/unwritable log must not stop the server
        print(f"[log] could not open {LOG_PATH}: {e}")
        return
    fh.write("\n===== ComfyCrawler server start %s (pid %d) =====\n"
             % (time.strftime("%Y-%m-%d %H:%M:%S"), os.getpid()))
    fh.flush()
    sys.stdout = _Tee(sys.stdout, fh)
    sys.stderr = _Tee(sys.stderr, fh)

    def _log_uncaught(exc_type, exc, tb):
        import traceback
        sys.stderr.write("[FATAL] uncaught exception - server exiting:\n")
        traceback.print_exception(exc_type, exc, tb)

    sys.excepthook = _log_uncaught


# Only when this file IS the server. The tests import it, and an import that ran this deleted
# the previous run's server.log.1 and - unable to roll a server.log the live server still holds
# open on Windows - appended the test output to the running server's log.
if __name__ == "__main__":
    _init_file_logging()

gen_progress = {
    "is_generating": False,
    "current_step": 0,
    "total_steps": 2,
    "status_message": "Idle",
    "percent": 0,
    # Sub-job detail line ("slash2 - step 5/8"), fed by PROGRESS from ComfyUI's socket.
    "phase": "",
    # {location, hero, foe, boss, crawl:[...]}. Published as soon as the story job returns,
    # minutes before completed_bundle, so the frontend can start the crawl while the rest
    # of the assets are still rendering.
    "story": None,
    "completed_bundle": None,
    "error": None
}

# Identifies this server on ComfyUI's websocket. Every /prompt we submit carries it, which
# is what makes ComfyUI address that job's progress messages back to us.
COMFY_CLIENT_ID = str(uuid.uuid4())

# ---------------------------------------------------------------------------
# Abandoned runs: the browser went away mid-generation
# ---------------------------------------------------------------------------
# A run is a chain of a dozen-odd ComfyUI prompts submitted one after another from a worker
# thread. Nothing about that chain was tied to the page that asked for it, so refreshing the
# browser mid-run used to leave the whole chain going: ComfyUI kept sampling for minutes for
# a bundle nobody would ever collect, and the reloaded page then queued a second chain behind
# the first. The page now warns before a mid-run refresh and, if the user goes ahead anyway,
# beacons /api/cancel_generation on the way out - which drops what we queued and tells the
# worker to stop at its next checkpoint.


class GenerationCancelled(Exception):
    """Raised on a generation worker thread whose page has gone away."""


# The worker Thread objects whose runs were abandoned. Thread objects (not idents, which
# CPython recycles) so a later run can never inherit an earlier one's cancellation.
_CANCELLED_RUNS = set()

# The worker for the most recently started run, so /api/cancel_generation knows which
# thread to mark. None before the first run and after the process restarts.
GEN_THREAD = None

# Every prompt_id this run handed to ComfyUI. Only used to drain the queue on cancel, so it
# is never pruned mid-run - deleting an id that already finished is a no-op on ComfyUI's
# side, and keeping the list append-only means the submit sites stay one line each. NOT
# cleared by the cancel itself: the watchdog below keeps re-reading it, so a prompt the
# still-unwinding worker manages to submit gets chased too. The next run clears it.
_INFLIGHT_LOCK = threading.Lock()
_INFLIGHT_PROMPTS = []

# Bumped by every fresh run. The cancel watchdog captures it and stops the moment it changes,
# so it can never interrupt the prompts of the run that replaced the one it was chasing.
_RUN_EPOCH = 0

# The watchdog thread chasing a cancelled run's prompts out of ComfyUI, or None. Alive means
# ComfyUI may still be executing something of ours - half of what run_is_settling reports.
_CANCEL_WATCHDOG = None


def _bail_if_cancelled():
    """Checkpoint for the generation worker. Called wherever the run would otherwise wait on
    or submit to ComfyUI, so an abandoned run unwinds within a poll tick instead of grinding
    through every remaining asset."""
    if threading.current_thread() in _CANCELLED_RUNS:
        raise GenerationCancelled("the page was closed - run abandoned")


def _track_prompt(prompt_id):
    """Record a submitted prompt_id (and pass it through, so submit sites read as
    `prompt_id = _track_prompt(...)`)."""
    with _INFLIGHT_LOCK:
        _INFLIGHT_PROMPTS.append(prompt_id)
    return prompt_id


def _comfy_post(path, body):
    req = urllib.request.Request(f"{COMFY_URL}{path}", data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp.read()


def _cancelled_workers_alive():
    """True while any abandoned run's worker thread is still going. Such a thread has not hit
    its unwind checkpoint yet, so it can still hand ComfyUI another prompt."""
    return any(th.is_alive() for th in list(_CANCELLED_RUNS))


def _our_prompts_in_queue():
    """Split ComfyUI's live queue into (ours running, ours still pending).

    /queue answers {"queue_running": [...], "queue_pending": [...]}, each entry a list of
    (number, prompt_id, prompt, extra_data, outputs_to_execute) - so [1] is the id."""
    with urllib.request.urlopen(f"{COMFY_URL}/queue", timeout=10) as resp:
        q = json.loads(resp.read().decode("utf-8"))
    with _INFLIGHT_LOCK:
        ours = set(_INFLIGHT_PROMPTS)

    def mine(key):
        return [e[1] for e in q.get(key, []) if len(e) > 1 and e[1] in ours]
    return mine("queue_running"), mine("queue_pending")


def _drain_cancelled_prompts(epoch, deadline=60.0):
    """Body of the cancel watchdog: keep interrupting until ComfyUI is done with every prompt
    of ours.

    ONE fire-and-forget /interrupt is not enough, which is why a cancelled run used to finish
    the job it was on and only stop after it. ComfyUI clears its own interrupt flag at the top
    of every prompt it runs (PromptExecutor.execute_async opens with
    nodes.interrupt_processing(False)), so an interrupt landing in the gap between two prompts
    - or a hair before the running one actually starts executing - is simply forgotten, and
    that job then samples all the way to its SaveImage. Re-posting against the live queue
    closes that window.

    The interrupt is TARGETED (/interrupt {"prompt_id": ..}), which ComfyUI honours only while
    that prompt is the one running. That is what keeps this from killing a job the user
    started from ComfyUI's own UI - the same care the delete-by-id takes with the pending
    queue, and which the old global interrupt did not take.

    Re-reads _INFLIGHT_PROMPTS every pass rather than working from a snapshot, and keeps
    watching until the worker thread is DEAD as well as the queue clear. Both halves matter:
    the worker only unwinds at its next checkpoint, and the submit sites hand ComfyUI a prompt
    a beat before the checkpoint that follows them - so a cancel that lands during the story
    job would otherwise find an empty queue, stop, and let the worker queue the textures a
    tick later with nothing left watching. That orphan then sampled on, exactly as if it had
    never been cancelled."""
    started = time.time()
    while time.time() - started < deadline:
        if epoch != _RUN_EPOCH:
            return          # a new run owns ComfyUI now - its prompts are not ours to kill
        try:
            running, pending = _our_prompts_in_queue()
        except Exception as e:
            print(f"[cancel] queue read failed: {e}")
            return
        if not running and not pending:
            if not _cancelled_workers_alive():
                print(f"[cancel] ComfyUI clear of the abandoned run after {time.time() - started:.1f}s")
                return
        if pending:
            try:
                _comfy_post("/queue", {"delete": pending})
            except Exception as e:
                print(f"[cancel] queue delete failed: {e}")
        for pid in running:
            try:
                _comfy_post("/interrupt", {"prompt_id": pid})
            except Exception as e:
                print(f"[cancel] interrupt of {pid} failed: {e}")
        time.sleep(0.25)
    print("[cancel] gave up waiting for ComfyUI to drop the abandoned run")


def cancel_comfy_jobs():
    """Drop everything this run gave ComfyUI and return how many prompts that was.

    Order matters: delete the still-pending prompts FIRST so that interrupting the running
    one doesn't just promote the next one off the queue. Deletes by id rather than
    {"clear": true} so a queue the user filled from ComfyUI's own UI is left alone.

    The RUNNING job is then chased on a watchdog thread rather than here, for two reasons: it
    takes repeated interrupts to land (see _drain_cancelled_prompts), and this runs inside the
    /api/cancel_generation beacon handler while the browser is already tearing the page down
    and refetching it - and the server takes one request at a time, so blocking here would
    stall the very reload that asked for the cancel."""
    global _CANCEL_WATCHDOG
    with _INFLIGHT_LOCK:
        ids = list(_INFLIGHT_PROMPTS)
    if ids:
        try:
            _comfy_post("/queue", {"delete": ids})
        except Exception as e:
            print(f"[cancel] queue delete failed: {e}")
    # Started even with nothing tracked yet: a run cancelled before its first submit still has
    # a live worker that is about to make one, and the watchdog is what catches it.
    if _CANCEL_WATCHDOG is None or not _CANCEL_WATCHDOG.is_alive():
        _CANCEL_WATCHDOG = threading.Thread(target=_drain_cancelled_prompts,
                                            args=(_RUN_EPOCH,), daemon=True)
        _CANCEL_WATCHDOG.start()
    print(f"[cancel] dropped {len(ids)} ComfyUI prompt(s) from the abandoned run")
    return len(ids)


def run_is_settling():
    """True while a cancelled run is still winding down - either its worker thread has not yet
    reached the checkpoint that unwinds it, or the watchdog is still chasing its prompts out
    of ComfyUI.

    Starting a second run on top of that is the thing the cancel exists to prevent: the new
    chain would queue behind the dying one and the two would trade the card between them. So
    /api/generate_dungeon refuses while this holds, and CREATE stays disabled."""
    if _CANCEL_WATCHDOG is not None and _CANCEL_WATCHDOG.is_alive():
        return True
    return _cancelled_workers_alive()



class ProgressTracker:
    """Drives gen_progress["percent"] from ComfyUI's real per-node progress.

    Per-sampler-step progress is ONLY pushed over the websocket - WebUIProgressHandler in
    comfy_execution/progress.py emits

        {"type": "progress_state", "data": {"prompt_id": .., "nodes": {id: {value, max, state}}}}

    addressed to the client_id that submitted the job. /history and /api/jobs report status
    but carry no progress at all, so a polling-only bar can never move mid-job - which is
    why the old hardcoded bar sat frozen at 50% for the entire krea2 + Kontext stretch, i.e.
    for nearly the whole wait.

    A run declares every job up front via begin_plan([(key, label, weight, units)]):

      weight  rough wall-clock cost, used to pace the phases against each other
      units   that job's expected progress units (total sampler steps, or max tokens for
              the story job), used as the DENOMINATOR for the live fraction

    `units` has to be declared rather than summed from the socket: progress_state only
    reports nodes that have already started, so a running job's observed total grows as it
    goes and self-normalising against it would peg every job at ~100% immediately.

    With no websocket (library missing, ComfyUI restarted) the fraction simply stays 0 and
    the bar advances a step per completed job - coarse, but still honest and still far
    better than the fixed 18/50/92 it replaces.
    """

    CAP = 97  # the last few points belong to packaging, after the final ComfyUI job

    def __init__(self):
        self._lock = threading.Lock()
        self._labels = {}
        self._weights = {}
        self._units = {}
        self._order = []
        self._done = set()
        self._current = None
        self._fraction = 0.0
        self._detail = ""
        self._floor = 0
        self._active = False
        self.connected = False
        self._thread = None

    # ---- plan ----------------------------------------------------------
    def begin_plan(self, jobs):
        with self._lock:
            self._order = [j[0] for j in jobs]
            self._labels = {j[0]: j[1] for j in jobs}
            self._weights = {j[0]: max(1.0, float(j[2])) for j in jobs}
            self._units = {j[0]: max(1.0, float(j[3])) for j in jobs}
            self._done = set()
            self._current = None
            self._fraction = 0.0
            self._detail = ""
            self._floor = 0
            self._active = True
        self._publish()

    def add_job(self, key, label, weight, units):
        """Register a job that only happens sometimes - the portrait regeneration pass
        fires only when Kontext's edit barely moved the face."""
        with self._lock:
            if not self._active or key in self._weights:
                return
            self._order.append(key)
            self._labels[key] = label
            self._weights[key] = max(1.0, float(weight))
            self._units[key] = max(1.0, float(units))
        self._publish()

    def begin_job(self, key):
        if key is None:
            return
        with self._lock:
            if not self._active:
                return
            if self._current is not None and self._current != key:
                self._done.add(self._current)
            self._current = key
            self._fraction = 0.0
            self._detail = ""
        self._publish()

    def finish_job(self, key=None):
        with self._lock:
            if not self._active:
                return
            k = key or self._current
            if k:
                self._done.add(k)
            self._current = None
            self._fraction = 0.0
            self._detail = ""
        self._publish()

    def end_plan(self):
        with self._lock:
            self._active = False
            self._current = None

    # ---- percent -------------------------------------------------------
    def _publish(self):
        with self._lock:
            if not self._active:
                return
            total = sum(self._weights.values())
            if total <= 0:
                return
            acc = sum(self._weights.get(k, 0.0) for k in self._done)
            cur = self._current
            if cur and cur not in self._done:
                acc += self._weights.get(cur, 0.0) * self._fraction
            pct = int(min(self.CAP, round(acc / total * self.CAP)))
            # A lazily added job grows the denominator mid-run; never walk backwards.
            if pct < self._floor:
                pct = self._floor
            self._floor = pct
            label = self._labels.get(cur)
            detail = self._detail
        gen_progress["percent"] = pct
        if label:
            gen_progress["status_message"] = label
        gen_progress["phase"] = detail

    # ---- socket --------------------------------------------------------
    def start(self):
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        try:
            import websocket  # websocket-client
        except ImportError:
            print("[progress] websocket-client not installed - the bar will advance per "
                  "job instead of per step (pip install -r requirements.txt)")
            return
        announced = False
        while True:
            ws = None
            # Rebuilt on every attempt: COMFY_URL is only a guess until ensure_comfy() has asked
            # the running ComfyUI, which may turn out to be on another port.
            url = "%s/ws?clientId=%s" % (COMFY_URL.replace("https://", "wss://").replace("http://", "ws://"),
                                         COMFY_CLIENT_ID)
            try:
                ws = websocket.create_connection(url, timeout=10)
                ws.settimeout(None)
                self.connected = True
                if not announced:
                    print("[progress] attached to ComfyUI progress socket as %s" % COMFY_CLIENT_ID[:8])
                    announced = True
                while True:
                    raw = ws.recv()
                    if raw is None or raw == "":
                        break
                    if isinstance(raw, (bytes, bytearray)):
                        continue  # binary frames are latent previews
                    self._on_message(raw)
            except Exception as e:
                if self.connected:
                    print("[progress] socket dropped (%s) - reconnecting" % e)
            finally:
                self.connected = False
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:
                        pass
            time.sleep(2.0)

    _NODE_SUFFIXES = ("_samp", "_dec", "_save", "_mask", "_maskinv", "_pos", "_neg", "_lat")

    def _node_detail(self, node_id, value, mx):
        if node_id == "story_gen":
            return "writing - %d words so far" % int(value * 0.75)
        name = node_id
        for suffix in self._NODE_SUFFIXES:
            if name.endswith(suffix):
                name = name[: -len(suffix)]
                break
        name = name.replace("enemy_", "").replace("_", " ").strip() or node_id
        return "%s - step %d/%d" % (name, int(value), int(mx))

    def _on_message(self, raw):
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            return
        mtype = msg.get("type")
        data = msg.get("data") or {}

        # A background ending render (see start_ending_video_job) shares this socket but belongs
        # to no run's plan - its steps must not move the bar of a dungeon loading beside it.
        if mtype in ("progress_state", "executing") and _ending_job_progress(data):
            return

        if mtype == "progress_state":
            nodes = data.get("nodes") or {}
            done_units = 0.0
            running = None
            for node_id, st in nodes.items():
                try:
                    mx = float(st.get("max") or 0.0)
                    val = float(st.get("value") or 0.0)
                except (TypeError, ValueError):
                    continue
                # Count ONLY multi-step nodes (samplers, the text generator). Every job's
                # `units` denominator is declared purely in sampler steps, so counting the
                # max=1 utility nodes too (per-branch CLIP encode, mask, VAE decode - ~6 of
                # them for each of the 17 krea2 branches) piled 100+ phantom units onto the
                # 136 real ones and saturated the fraction at 1.0 after ~4 frames, freezing
                # the bar at 54% for the rest of the "frames" phase.
                if mx <= 1:
                    continue
                done_units += min(val, mx)
                # The same set of nodes is what makes a useful detail line - a loader or text
                # encoder flickering past would just churn it to "k vae" / "clip" / "neg".
                if st.get("state") == "running" and val < mx:
                    running = (node_id, val, mx)
            with self._lock:
                cur = self._current
                if not self._active or cur is None:
                    return
                expected = self._units.get(cur, 0.0)
                if expected > 0:
                    # Monotonic within the job: progress_state only lists started nodes, so
                    # the observed total jitters as new ones come online.
                    self._fraction = max(self._fraction, min(1.0, done_units / expected))
                if running:
                    self._detail = self._node_detail(*running)
            self._publish()

        elif mtype == "executing" and data.get("node") is None:
            self.finish_job()


PROGRESS = ProgressTracker()


# A designed surface can be technically perfect and still unusable. "internet" resolves to
# matte black server racks - which is CORRECT, server racks are black - and the render measured
# mean luma 5-11 out of 255. The raycaster then multiplies that by distance shading
# (1/(1+dist*0.38)), so the corridor arrives on screen as an unlit void: the same "the walls
# were blank" complaint, reached by the opposite route.
#
# Prompt wording cannot fix this and was tried first. A brief rule asking for mid-tone surfaces
# lit by lantern light only got "faint blue LED glow along seams" appended to the same black
# panels, because the model is not wrong about what the thing looks like. So the fix belongs
# here, on the pixels, and ONLY on the generic path - the ten hand-tuned buckets are already
# mid-tone by construction and are never touched.
#
# A GAMMA curve rather than a brightness offset: it opens up the shadows where all the detail
# is hiding while leaving the highlights (the LEDs) alone, so the surface keeps its contrast
# instead of turning into grey fog. Measured on the real black-server-rack wall: mean 10.8 ->
# 54.2 at gamma 0.42, at which point the mesh vents, panel seams and blue LEDs are all plainly
# readable. Below about gamma 0.35 (mean ~67) the curve starts amplifying the model's own
# compression noise in the darkest region, which is why the gamma is floored.
SURFACE_MIN_LUMA = 34.0      # below this a tiling surface reads as an unlit void in game
SURFACE_TARGET_LUMA = 55.0   # what a lifted surface is brought up to
SURFACE_MIN_GAMMA = 0.38     # any harder and dark-region compression noise comes up with it

# THE SAME COMPLAINT BY A THIRD ROUTE: a wall with no CONTRAST at all. "supermarket" resolved
# to "glossy white plastic with faint barcode patterns and faded price tags in black ink" -
# true of a real supermarket wall, and unusable: the render measured mean luma 242 with 98.7%
# of its pixels above 235, which is a blank sheet of paper. The gamma lift above cannot help
# here the way it helps a dark surface, because there is no detail hiding in the shadows to
# open up - the model drew nothing to begin with.
#
# So the measurement to gate on is the STANDARD DEVIATION of luma, not the mean: it catches a
# blown-out white wall and a flat mid-grey one alike. Measured over every bundle in
# dungeon_sessions - all eleven hand-tuned bucket walls land at 22.5 or above, while the six
# dead designed walls (supermarket, two mangos, corporate office, classroom) land at 11.1 or
# below. 16.0 sits in that gap with margin at both ends.
#
# WALL ONLY, deliberately. Low contrast is normal and perfectly fine on the other two - bucket
# ceilings measure down to 6.2 and bucket floors to 12.5 - because both are seen at a glancing
# angle and neither fills the view the way the wall ahead of you does.
SURFACE_MIN_CONTRAST = 16.0

# AND THE SAME COMPLAINT BY A FOURTH ROUTE, this time on the DOOR: a grey door in a colourful
# corridor. The door is a full map cell, so its edges ARE the corridor wall either side of the
# opening - and when the model draws a product-shot door instead (one leaf centred on an empty
# ground), those edges arrive as flat black or flat white and the whole cell reads as a hole
# punched in the theme. A "pet store" run shipped a plain white six-panel door on black next to
# neon-pink walls; the archway the prompt asked for never got drawn at all.
#
# MEASURE THE BORDER RING, NOT THE WHOLE IMAGE. The failure lives at the edges by definition:
# whole-image saturation passes a correct-looking wooden door whose surround is blank white
# (measured 95.1 overall, 36.2 on the ring), and it is the surround that has to match the
# corridor. The ring is the outer 12% of the frame - wide enough to sit outside the archway on
# every render in dungeon_sessions, narrow enough not to sample the leaf itself.
#
# Measured over all 49 designed doors in dungeon_sessions: every door that reads as wrong lands
# at ring saturation 15.7 or below (the white pet-store door 2.6, a chrome one 0.4, a matte
# black Dreamcast 0.2), and the lowest door that reads as right is 23.2. 19.0 sits in that gap.
#
# Gated on the WALL actually being colourful, so a deliberately monochrome theme keeps its
# monochrome door - two archived themes rendered near-greyscale walls (saturation 3.5 and 22.0)
# and a grey door is the correct answer in both.
DOOR_MIN_RING_SAT = 19.0     # below this the door's surround is not the corridor's material
DOOR_WALL_MIN_SAT = 40.0     # ...but only judge it against a wall with colour of its own


def _mean_luma(img):
    px = img.convert("RGB").getdata()
    n = len(px)
    return sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in px) / max(1, n)


def _surface_contrast(img):
    """Luma standard deviation - how much the surface actually varies, which is what "blank"
    means here. See SURFACE_MIN_CONTRAST for the measured threshold."""
    return ImageStat.Stat(img.convert("L")).stddev[0]


def _mean_saturation(img):
    """Mean HSV saturation - how much colour the surface carries at all."""
    return ImageStat.Stat(img.convert("HSV").getchannel("S")).mean[0]


def _ring_saturation(img, frac=0.12):
    """Mean saturation of the outer `frac` border of the image - the part of a door cell that
    is corridor wall rather than door leaf. See DOOR_MIN_RING_SAT for why the ring and not the
    whole frame."""
    sat = img.convert("HSV").getchannel("S")
    w, h = sat.size
    r = max(1, int(round(w * frac)))
    px = list(sat.getdata())
    ring = []
    for y in range(h):
        row = px[y * w:(y + 1) * w]
        if y < r or y >= h - r:
            ring.extend(row)                      # full top / bottom bands
        else:
            ring.extend(row[:r]); ring.extend(row[-r:])   # left / right edges only
    return sum(ring) / max(1, len(ring))


def _lift_dark_surface(path, label):
    """Gamma-lift a tiling surface that came back too dark to see. No-op for anything already
    bright enough, so it costs one pass over the image on a healthy texture."""
    try:
        img = Image.open(path)
        mode = img.mode
        mean = _mean_luma(img)
        if mean >= SURFACE_MIN_LUMA:
            return
        # Solve for the gamma that lands on SURFACE_TARGET_LUMA. Bisection rather than a
        # closed form because mean luma after a gamma curve depends on the whole histogram.
        lo, hi = SURFACE_MIN_GAMMA, 1.0
        best = None
        for _ in range(12):
            g = (lo + hi) / 2
            lut = [min(255, round(255 * ((i / 255.0) ** g))) for i in range(256)]
            out = img.convert("RGB").point(lut * 3)
            got = _mean_luma(out)
            best = (g, out, got)
            if got < SURFACE_TARGET_LUMA:
                hi = g
            else:
                lo = g
        g, out, got = best
        if mode == "RGBA":
            out.putalpha(img.getchannel("A"))
        out.save(path, format="PNG")
        print(f"[surface] {label} came back at mean luma {mean:.1f} - lifted to {got:.1f} "
              f"(gamma {g:.2f}) so it is visible in a lantern-lit corridor")
    except Exception as e:
        # A too-dark texture is a bad look; a crashed bundle is worse.
        print(f"[surface] could not lift {label}: {e}")


# The rescue prompt for a wall that came back blank - see SURFACE_MIN_CONTRAST above.
#
# It is deliberately NOT the designed line retried on a fresh seed, and NOT the raw typed word
# dropped back into get_surface_prompts' wall frame. Both were measured across three seeds
# each and both stay blank, because what manufactures the blankness is that frame's own "pure
# flat vertical wall material" tail meeting a subject with no pattern of its own ("beige
# laminate", "vinyl in soft yellow"): the tail is then the only concrete thing left in the
# prompt and the model draws exactly it. Raw "mango" through that frame measured 3.0-8.0.
#
# Asking instead for a WALLPAPER OF THE THEME'S PICTURES drops the tail entirely and hands the
# model something it has to actually draw. On the three themes that had shipped blank walls it
# measured 41.9-50.9 (mango), 74.1-81.9 (corporate office) and 62.7-65.1 (supermarket) against
# the 16.0 floor, and the renders are clean seamless tiles rather than noise. This is the same
# shape the hand-tuned `cat` and `people` buckets have always used, which is exactly why
# neither of those has ever produced this failure.
_WALLPAPER_RESCUE = ("A flat 2D wallpaper texture of dense repeating pictures of {}, bold "
                     "saturated colours, colorful repeating pattern filling the whole frame "
                     "edge to edge, flat straight-on orthographic view, zero perspective, "
                     "no room, no borders.")


def _reroll_flat_wall(wall_style, tile_px):
    """Re-render the wall from _WALLPAPER_RESCUE. Returns the new file path, or None if
    anything goes wrong - the caller already holds a working (if blank) texture, and a blank
    wall is a bad look where a crashed bundle is a lost run."""
    try:
        prefix = f"trio_wr_{int(time.time()*1000)}"
        payload = {
            "1": {"inputs": {"ckpt_name": FLUX_SCHNELL_CKPT}, "class_type": "CheckpointLoaderSimple"},
            "neg": {"inputs": {"text": "cartoon, anime, 2d, low quality, pixelated, 16-bit, clipart, drawing, blurry, watermark", "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
            "lat": {"inputs": {"width": tile_px, "height": tile_px, "batch_size": 1}, "class_type": "EmptyLatentImage"},
            "pos": {"inputs": {"text": _WALLPAPER_RESCUE.format(wall_style), "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
            "samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0,
                                "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                                "model": ["1", 0], "positive": ["pos", 0], "negative": ["neg", 0],
                                "latent_image": ["lat", 0]}, "class_type": "KSampler"},
            "dec": {"inputs": {"samples": ["samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
            "save": {"inputs": {"filename_prefix": prefix, "images": ["dec", 0]}, "class_type": "SaveImage"},
        }
        data = json.dumps({"prompt": payload, "client_id": COMFY_CLIENT_ID}).encode("utf-8")
        req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as resp:
            prompt_id = _track_prompt(json.loads(resp.read().decode("utf-8"))["prompt_id"])
        start = time.time()
        while time.time() - start < 60:
            time.sleep(0.1)
            _bail_if_cancelled()
            with urllib.request.urlopen(f"{COMFY_URL}/history/{prompt_id}") as h_resp:
                hist = json.loads(h_resp.read().decode("utf-8"))
            out = hist.get(prompt_id, {}).get("outputs", {})
            if "save" in out:
                info = out["save"]["images"][0]
                return os.path.join(COMFY_OUTPUT_DIR, info.get("subfolder", ""), info["filename"])
    except GenerationCancelled:
        # An abandoned run must keep unwinding - this is not a re-roll failure.
        raise
    except Exception as e:
        print(f"[surface] wall re-roll failed: {e}")
    return None


def _fix_blank_wall(path, wall_style, tile_px):
    """Swap in a wallpaper re-roll when the designed wall came back with no contrast at all.
    Returns the path to use. A no-op on a readable wall, so it costs one pass over the image
    on a healthy texture."""
    try:
        got = _surface_contrast(Image.open(path))
    except Exception as e:
        print(f"[surface] could not measure the wall: {e}")
        return path
    if got >= SURFACE_MIN_CONTRAST:
        return path
    print(f"[surface] wall came back at contrast {got:.1f} - blank below "
          f"{SURFACE_MIN_CONTRAST:.0f} - re-rolling it as a wallpaper of {wall_style}")
    alt = _reroll_flat_wall(wall_style, tile_px)
    if not alt:
        return path
    try:
        alt_got = _surface_contrast(Image.open(alt))
    except Exception as e:
        print(f"[surface] could not measure the re-rolled wall: {e}")
        return path
    # Keep whichever has more to look at: the rescue prompt is measurably better on every
    # theme tried, but a theme it happens to fail on must not end up worse than it started.
    if alt_got <= got:
        print(f"[surface] re-roll came back at {alt_got:.1f} too - keeping the original")
        return path
    print(f"[surface] re-rolled wall at contrast {alt_got:.1f}")
    return alt


# The rescue prompt for a door whose surround came back blank - see DOOR_MIN_RING_SAT above.
#
# Like _WALLPAPER_RESCUE it is deliberately NOT the designed line retried on a fresh seed.
# Measured across three seeds on six archived failures, the shipped prompt stays wrong on
# almost every one (ring saturation 0.6-52.7, most of them under 10) because what manufactures
# the failure is its SHAPE: the designed DOOR line is the whole subject, and every clause after
# it - "no room around it", "zero horizon" - strips away the surroundings, so the model draws a
# catalogue photo of one door leaf on an empty ground. Its "zero black margins" clause cannot
# undo that; at cfg 1.0 naming black margins is a request for them (same trap as _LANTERN_TAIL).
#
# So the rescue makes the WALL the subject too, quoting the designed wall line verbatim - which
# is rule 1 of the hand-tuned buckets, the reason none of them has ever produced this failure.
# The leaf keeps its designed identity, demoted to an appositive. Same six failures, same three
# seeds: 86.1-234.7, every single render above the 19.0 floor and above its own control.
_DOOR_RESCUE = ("A shut door completely filling the picture, the door leaf {door}, set into a "
                "surrounding wall of {wall} that reaches every edge of the frame, bold "
                "saturated colours, flat straight-on orthographic front view, zero "
                "perspective, zero horizon, no floor, no room, {sign}.")


def _reroll_grey_door(door_line, wall_line, tile_px, wall_named=None):
    """Re-render the door from _DOOR_RESCUE. Returns the new file path, or None if anything
    goes wrong - the caller already holds a working (if off-theme) door, and a door that does
    not match the corridor is a bad look where a crashed bundle is a lost run."""
    try:
        prefix = f"trio_dr_{int(time.time()*1000)}"
        prompt = _DOOR_RESCUE.format(door=_theme_inline(door_line),
                                     wall=_theme_inline(wall_line),
                                     sign=_door_sign(wall_named))
        payload = {
            "1": {"inputs": {"ckpt_name": FLUX_SCHNELL_CKPT}, "class_type": "CheckpointLoaderSimple"},
            "neg": {"inputs": {"text": "cartoon, anime, 2d, low quality, pixelated, 16-bit, clipart, drawing, blurry, watermark", "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
            "lat": {"inputs": {"width": tile_px, "height": tile_px, "batch_size": 1}, "class_type": "EmptyLatentImage"},
            "pos": {"inputs": {"text": prompt, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
            "samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0,
                                "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                                "model": ["1", 0], "positive": ["pos", 0], "negative": ["neg", 0],
                                "latent_image": ["lat", 0]}, "class_type": "KSampler"},
            "dec": {"inputs": {"samples": ["samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
            "save": {"inputs": {"filename_prefix": prefix, "images": ["dec", 0]}, "class_type": "SaveImage"},
        }
        data = json.dumps({"prompt": payload, "client_id": COMFY_CLIENT_ID}).encode("utf-8")
        req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as resp:
            prompt_id = _track_prompt(json.loads(resp.read().decode("utf-8"))["prompt_id"])
        start = time.time()
        while time.time() - start < 60:
            time.sleep(0.1)
            _bail_if_cancelled()
            with urllib.request.urlopen(f"{COMFY_URL}/history/{prompt_id}") as h_resp:
                hist = json.loads(h_resp.read().decode("utf-8"))
            out = hist.get(prompt_id, {}).get("outputs", {})
            if "save" in out:
                info = out["save"]["images"][0]
                return os.path.join(COMFY_OUTPUT_DIR, info.get("subfolder", ""), info["filename"])
    except GenerationCancelled:
        # An abandoned run must keep unwinding - this is not a re-roll failure.
        raise
    except Exception as e:
        print(f"[surface] door re-roll failed: {e}")
    return None


def _fix_offtheme_door(d_path, w_path, door_line, wall_line, tile_px, wall_named=None):
    """Swap in a wall-anchored re-roll when the designed door came back sitting on a blank
    surround instead of on the corridor. Returns the path to use. A no-op on a door that
    already carries the theme, so it costs two passes over an image on a healthy run."""
    try:
        ring = _ring_saturation(Image.open(d_path))
        wall_sat = _mean_saturation(Image.open(w_path))
    except Exception as e:
        print(f"[surface] could not measure the door: {e}")
        return d_path
    if ring >= DOOR_MIN_RING_SAT:
        return d_path
    if wall_sat < DOOR_WALL_MIN_SAT:
        # The corridor has no colour of its own, so neither should the door - see
        # DOOR_WALL_MIN_SAT.
        print(f"[surface] door ring saturation {ring:.1f} matches a near-greyscale wall "
              f"({wall_sat:.1f}) - leaving it alone")
        return d_path
    print(f"[surface] door came back at ring saturation {ring:.1f} - blank surround below "
          f"{DOOR_MIN_RING_SAT:.0f} next to a wall at {wall_sat:.1f} - re-rolling it set into "
          f"the corridor wall")
    alt = _reroll_grey_door(door_line, wall_line, tile_px, wall_named)
    if not alt:
        return d_path
    try:
        alt_ring = _ring_saturation(Image.open(alt))
    except Exception as e:
        print(f"[surface] could not measure the re-rolled door: {e}")
        return d_path
    # Keep whichever surround carries more of the theme: the rescue prompt is measurably
    # better on every failure tried, but one it happens to miss must not end up worse than it
    # started.
    if alt_ring <= ring:
        print(f"[surface] door re-roll came back at {alt_ring:.1f} too - keeping the original")
        return d_path
    print(f"[surface] re-rolled door at ring saturation {alt_ring:.1f}")
    return alt


def make_seamless_4way(img_path, blend_pixels=12):
    """Clean narrow-rim blend for seamless dungeon tiling."""
    try:
        img = Image.open(img_path).convert("RGBA")
        w, h = img.size
        margin = 8
        img_cropped = img.crop((margin, margin, w - margin, h - margin)).resize((w, h), Image.Resampling.LANCZOS)
        arr = np.array(img_cropped).astype(np.float32)
        res = arr.copy()
        
        bw = min(blend_pixels, w // 4)
        bh = min(blend_pixels, h // 4)
        
        for x in range(bw):
            t = x / bw
            alpha = t * t * (3 - 2 * t)
            v_left = arr[:, x, :]
            v_right = arr[:, w - 1 - x, :]
            mid = 0.5 * (v_left + v_right)
            res[:, x, :] = v_left * alpha + mid * (1.0 - alpha)
            res[:, w - 1 - x, :] = v_right * alpha + mid * (1.0 - alpha)
            
        for y in range(bh):
            t = y / bh
            alpha = t * t * (3 - 2 * t)
            v_top = res[y, :, :]
            v_bot = res[h - 1 - y, :, :]
            mid = 0.5 * (v_top + v_bot)
            res[y, :, :] = v_top * alpha + mid * (1.0 - alpha)
            res[h - 1 - y, :, :] = v_bot * alpha + mid * (1.0 - alpha)
            
        res_img = Image.fromarray(np.clip(res, 0, 255).astype(np.uint8))
        res_img.save(img_path, format="PNG")
    except Exception as e:
        print(f"[Seamless Error] {e}")


PLAYER_FRAME_NAMES = ["idle", "block", "windup", "slash", "hurt"]

# Standard 18-point OpenPose body layout: 0 Nose, 1 Neck, 2 RShoulder, 3 RElbow, 4 RWrist,
# 5 LShoulder, 6 LElbow, 7 LWrist, 8 RHip, 9 RKnee, 10 RAnkle, 11 LHip, 12 LKnee, 13 LAnkle,
# 14 REye, 15 LEye, 16 REar, 17 LEar. Limb pairs/colors match the canonical OpenPose ControlNet
# rendering convention exactly (verified against comfyui_controlnet_aux's draw_bodypose).
# Face points (14-17) are omitted on purpose - it reinforces the back-view-only framing, since
# there's no face to draw.
POSE_LIMB_SEQ = [
    (1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10),
    (1, 11), (11, 12), (12, 13), (1, 0), (0, 14), (14, 16), (0, 15), (15, 17),
]
POSE_COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0),
    (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255),
    (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85),
]

# Hand-authored back-view keypoints (normalized 0-1) for each combat frame. "R"/"L" here just
# means "appears on the right/left side of the canvas" - self-consistency across limbs matters,
# not literal anatomical labeling, since ControlNet only cares about the visual/geometric structure.
PLAYER_POSE_KEYPOINTS = {
    # Last 4 entries are REye, LEye, REar, LEar. Eyes stay None (no face - back view), but both
    # ears are given small SYMMETRIC points close together near the top of the neck: a back-of-head
    # is what a real photo would show two visible, near-symmetric ears with no eyes/nose between
    # them - that asymmetry-free signal is what was missing and let orientation drift frame to frame.
    # The sword arm (RShoulder/RElbow/RWrist, indices 2/3/4) traces a real Valbrace-style arc across
    # the frames: upright at rest -> cocked back across the body -> swept through to the right. The
    # RWrist point is doing double duty - it poses the arm here AND anchors the composited blade in
    # PLAYER_SWORD_TRANSFORMS below, so the hand and the weapon can never drift out of sync.
    # The shield-arm wrist sits OUTSIDE the torso silhouette (x around 0.28 rather than 0.40).
    # The shield is centred exactly on this point, so the only way it can be both attached to the
    # hand and not swallowed by the body is for the hand itself to be held clear of the body.
    "idle": [
        None, (0.50, 0.22),
        (0.59, 0.25), (0.65, 0.38), (0.68, 0.48),
        (0.42, 0.25), (0.35, 0.37), (0.28, 0.46),
        (0.56, 0.52), (0.57, 0.72), (0.57, 0.92),
        (0.44, 0.52), (0.43, 0.72), (0.43, 0.92),
        None, None, (0.545, 0.185), (0.455, 0.185),
    ],
    # Identical to idle apart from the shield arm - block should read as the same character lifting
    # their guard, not as a different frame entirely. The hand travels up WITH the shield, since
    # the shield is pinned to this wrist point.
    "block": [
        None, (0.50, 0.22),
        (0.59, 0.25), (0.65, 0.38), (0.68, 0.48),
        (0.42, 0.25), (0.33, 0.34), (0.31, 0.25),
        (0.56, 0.52), (0.57, 0.72), (0.57, 0.92),
        (0.44, 0.52), (0.43, 0.72), (0.43, 0.92),
        None, None, (0.545, 0.185), (0.455, 0.185),
    ],
    # Windup is ONE arm cocked back across the chest, not both arms in the air - the old
    # both-hands-overhead pose is what read as "player just raising two arms" with no weapon.
    # Sword arm raised into a guard beside the shoulder - NOT folded across the chest. The crossed
    # version asked for a forearm reaching past the body's centreline in a back view, which is
    # anatomically ambiguous from behind; the model consistently resolved it by splaying BOTH arms
    # out and stretching them to the frame edges, and it rendered the figure at a different scale
    # from every other frame too. Because the blade is composited separately, its rotation alone
    # carries the "cocked back to strike" read - the arm doesn't have to contort to sell it.
    # Left arm is identical to idle, so only the sword arm changes.
    # The sword hand is held high and wide so the cocked blade sweeps up-left ABOVE the head rather
    # than across the torso - now that gear draws behind the character, a blade crossing the body
    # is completely hidden by it.
    "windup": [
        None, (0.50, 0.22),
        (0.60, 0.25), (0.72, 0.31), (0.78, 0.26),
        (0.42, 0.25), (0.35, 0.37), (0.28, 0.46),
        (0.56, 0.52), (0.57, 0.72), (0.57, 0.92),
        (0.44, 0.52), (0.43, 0.72), (0.43, 0.92),
        None, None, (0.545, 0.185), (0.455, 0.185),
    ],
    "slash": [
        None, (0.48, 0.20),
        (0.60, 0.24), (0.68, 0.28), (0.74, 0.34),
        (0.38, 0.24), (0.32, 0.34), (0.27, 0.44),
        (0.54, 0.52), (0.62, 0.70), (0.68, 0.90),
        (0.42, 0.52), (0.38, 0.76), (0.34, 0.94),
        None, None, (0.525, 0.165), (0.435, 0.165),
    ],
    "hurt": [
        None, (0.52, 0.24),
        (0.60, 0.27), (0.66, 0.34), (0.70, 0.40),
        (0.44, 0.27), (0.36, 0.37), (0.29, 0.47),
        (0.58, 0.54), (0.62, 0.74), (0.66, 0.94),
        (0.46, 0.54), (0.40, 0.70), (0.34, 0.88),
        None, None, (0.565, 0.205), (0.475, 0.205),
    ],
}

# The sword is generated ONCE as its own sprite and composited into every frame, rather than asked
# for inside each character generation. OpenPose has no channel for "and there's a blade in that
# hand" - it can only place joints - so the model kept posing the arms correctly and then drawing
# nothing in them. Compositing also means it is literally the same blade in all five frames instead
# of five separately-hallucinated ones. This still satisfies "weapon is one with the frame": the
# compositing happens here, server-side, so what ships to the browser is a single flat PNG per
# frame with nothing left for the frontend to keep in sync.
#
# The sword sprite is generated blade-up with the grip at the bottom, so `angle` is a plain
# counter-clockwise rotation about the grip: 0 = held upright, positive = cocked left,
# negative = swung right. `scale` is blade length as a fraction of frame height.
# How far up the blade the hand actually closes, as a fraction of sprite height. Pivoting on the
# very bottom edge balanced the weapon on the tip of its pommel, which read as the hand hovering
# next to a floating sword rather than gripping one.
SWORD_GRIP_FRAC = 0.12

# Offsets zero for the same reason as the shield: the grip belongs in the hand, not near it.
PLAYER_SWORD_TRANSFORMS = {
    # Tilted up and out rather than straight vertical, so at rest the weapon reads as raised and
    # ready to strike instead of parked at the side.
    "idle":   {"angle":  -18, "scale": 0.40, "offset": (0.00,  0.00), "streak": None},
    "block":  {"angle":  -25, "scale": 0.34, "offset": (0.00,  0.00), "streak": None},
    # Blade swept up and across to the left from the raised guard hand - this is what actually
    # reads as "cocked back", now that the arm itself stays in a natural position.
    "windup": {"angle":   45, "scale": 0.34, "offset": (0.00,  0.00), "streak": None},
    # Follow-through: blade already swept down-right, with the white arc above tracing where it
    # travelled - the same read as Valbrace's swipe frame.
    "slash":  {"angle": -145, "scale": 0.40, "offset": (0.00,  0.00),
               # Arcs from where the blade was at windup, up over the shoulder and down to where it
               # is now - deliberately clearing the head rather than cutting across it.
               "streak": {"points": [(0.30, 0.22), (0.44, 0.08), (0.66, 0.09), (0.82, 0.26),
                                     (0.88, 0.40)],
                          "width": 0.022}},
    "hurt":   {"angle": -150, "scale": 0.34, "offset": (0.00,  0.00), "streak": None},
}

# Shield placement, anchored to the LEFT wrist (keypoint 7) the same way the sword is anchored to
# the right - so the shield tracks whatever the ControlNet skeleton did with the shield arm. Unlike
# the sword this is centred on the anchor rather than pivoted from one end, since a round shield is
# strapped across the forearm rather than gripped at one tip.
# Offsets are all ZERO: the shield's centre sits exactly on the left-hand keypoint, because that
# is where a hand gripping the back of a shield actually is. Nudging the shield outward to keep it
# clear of the torso (an earlier attempt) visibly detached it from the hand - the shield floated
# and the arm pointed somewhere else. The hand is moved out in PLAYER_POSE_KEYPOINTS instead, so
# the two stay welded together and the shield still clears the body.
PLAYER_SHIELD_TRANSFORMS = {
    "idle":   {"angle":   0, "scale": 0.27, "offset": (0.0, 0.0)},
    # Braced: the biggest it gets, reading as brought up into the incoming hit.
    "block":  {"angle":   0, "scale": 0.34, "offset": (0.0, 0.0)},
    "windup": {"angle": -12, "scale": 0.26, "offset": (0.0, 0.0)},
    "slash":  {"angle": -20, "scale": 0.25, "offset": (0.0, 0.0)},
    "hurt":   {"angle":  18, "scale": 0.26, "offset": (0.0, 0.0)},
}


def render_pose_skeleton(pose_name, size=768, keypoints=None, prefix="pose_skel"):
    """Render a pose as an OpenPose-style skeleton PNG into ComfyUI's input folder, for use as
    ControlNet conditioning. Pure PIL - no opencv dependency needed for this simplified version.
    Pass `keypoints` explicitly to render a set other than the player's (e.g. the enemy's)."""
    from PIL import Image, ImageDraw
    kps = keypoints if keypoints is not None else PLAYER_POSE_KEYPOINTS[pose_name]
    canvas = Image.new("RGB", (size, size), (0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    stick_width = max(4, size // 100)

    for (i1, i2), color in zip(POSE_LIMB_SEQ, POSE_COLORS):
        p1, p2 = kps[i1], kps[i2]
        if p1 is None or p2 is None:
            continue
        dim_color = tuple(int(c * 0.6) for c in color)
        draw.line([(p1[0] * size, p1[1] * size), (p2[0] * size, p2[1] * size)], fill=dim_color, width=stick_width * 2)

    for kp, color in zip(kps, POSE_COLORS):
        if kp is None:
            continue
        x, y = kp[0] * size, kp[1] * size
        draw.ellipse([x - stick_width, y - stick_width, x + stick_width, y + stick_width], fill=color)

    filename = f"{prefix}_{pose_name}.png"
    canvas.save(os.path.join(COMFY_INPUT_DIR, filename), format="PNG")
    return filename




def get_player_sprite_prompts(player_style):
    """Prompts for the IPAdapter-conditioned player sprite pipeline. Structure (orientation, single
    figure, framing) is forced; art style is left entirely to whatever the player typed."""
    p_style = player_style.strip() if (player_style and player_style.strip()) else "armored knight"

    # Pose clause goes FIRST and the shared style/background text is kept short - CLIP truncates
    # at 77 tokens, and a long shared prefix was silently cutting off the pose-differentiating
    # text every time, which is why earlier attempts produced near-identical frames.
    # NOTE: the character is deliberately generated EMPTY-HANDED. Sword and shield are separately
    # generated sprites composited in afterwards (see PLAYER_SWORD_TRANSFORMS / SHIELD), so asking
    # for them here would only produce a second, differently-drawn set fighting the composited one.
    # Dropping them also permanently kills the old "two shields / two swords" confusion: there is
    # now nothing held in the prompt for the model to duplicate or mix up.
    # The orientation clauses carry explicit CLIP weights because back-view was otherwise a coin
    # flip per seed - some references came back facing the camera, and IPAdapter then propagated
    # that to all five frames. Only ORIENTATION words are weighted: an earlier attempt at weighting
    # face/species words ("muzzle", "animal face") to suppress the face also erased what made a cat
    # a cat, and the brief is explicitly that every species has to still work.
    # STRUCTURE IS FORCED, STYLE IS NOT. A/B'd three prompt stacks against the same styles:
    #   - heavy forcing (art style clamped at 1.35, ~40-term negative) produced ragged alpha
    #     fringing and no better orientation than this;
    #   - no forcing at all held the back view fine - ControlNet and IPAdapter carry structure on
    #     their own - but let the art style wander off into pixel-art;
    #   - this middle stack was cleanest and at least as reliable across "pretty lady" and "cat".
    # So orientation keeps its weighting, which demonstrably earns its keep, while the art style is
    # merely named and the negative trimmed to the things that actually recur.
    # No art style is imposed. The look now comes from whatever the player typed - ask for a woman
    # and you get a realistic woman; ask for a pixel-art goblin and you get pixel art. Everything
    # here that isn't orientation or framing was previously clamping the result to flat retro CGI,
    # and the negative was additionally blocking "photorealistic" outright.
    tail = (
        f"Single {p_style} warrior, one figure only, full body game character. "
        f"(Viewed from directly behind:1.4), facing away from the viewer, "
        f"spine straight, centered. Both hands empty, carrying nothing. "
        f"Isolated on a plain white background, no scenery."
    )

    reference_prompt = f"Neutral standing pose, arms relaxed at the sides. {tail}"

    pose_prompts = [
        f"Standing idle stance, weight balanced evenly, right arm hanging relaxed at the side. {tail}",
        f"Shield arm raised up and forward, bracing to block an incoming attack. {tail}",
        f"Sword arm raised high and out to the side, coiled and about to strike. {tail}",
        f"Mid-swing dynamic action pose, torso twisted into the swing, front leg lunging forward. {tail}",
        f"Staggering backward off-balance, recoiling from a hit. {tail}",
    ]

    player_negative = (
        "front view, facing the camera, looking at viewer, "
        "two characters, duplicate character, character sheet, multiple views, "
        # Weapon suppression carries weight (style deliberately does not). The character has to come
        # out EMPTY-HANDED because the real sword and shield are composited on afterwards; left
        # unweighted the model kept strapping extra blades and scabbards to the character's back,
        # which is the old "two swords" problem wearing a different hat.
        "(sword:1.3), (weapon:1.3), (shield:1.3), blade, axe, spear, scabbard, sheath, "
        "weapons on back, armed, holding an object, "
        "room, floor, scenery, landscape, "
        "blurry, watermark, text, signature, bad anatomy"
    )

    return reference_prompt, pose_prompts, player_negative


def get_sword_prompts(player_style, weapon_style=None):
    """Prompt pair for the one-off weapon sprite that gets composited into every frame.
    Generated blade-up with the grip at the bottom so rotation about the grip is trivial.
    `weapon_style` is the player's own words for the weapon; without it, the weapon is just
    described as a sword styled to match the character."""
    p_style = player_style.strip() if (player_style and player_style.strip()) else "armored knight"
    w_style = weapon_style.strip() if (weapon_style and weapon_style.strip()) else ""
    # Only describe a BLADE when nobody asked for something specific. Forcing "one straight blade,
    # hilt crossguard" onto a stated weapon fights the request - an axe came back as a slab.
    if w_style:
        shape = (f"A single {w_style}, held upright with its head at the top and its handle and grip "
                 f"at the bottom, one weapon only, flat side-on view.")
    else:
        shape = ("A single sword weapon held vertically, blade pointing straight up, hilt crossguard "
                 "and grip at the bottom, one straight blade, flat side-on view.")
    sword_positive = (
        f"{shape} Game item sprite, styled to match a {p_style} "
        f"warrior. Isolated alone on a solid plain white background, no character, no person, no hands."
    )
    sword_negative = (
        "person, character, human, warrior, knight, hand, hands, arm, arms, body, face, holding, wielding, "
        # Weapon-agnostic: the stated weapon may be an axe, a mace, a staff - "two swords" alone
        # did nothing to discourage a stacked column of axe heads.
        "two weapons, multiple weapons, pair of weapons, crossed weapons, weapon rack, weapon collection, "
        "row of weapons, stacked weapons, contact sheet, "
        "shield, item icons, ui text, labels, inventory grid, "
        "horizontal, diagonal, tilted, room, floor, scenery, background, landscape, "
        "blurry, watermark, cropped, text, signature, jpeg artifacts"
    )
    return sword_positive, sword_negative


PORTRAIT_FRAME_NAMES = ["idle", "attack", "block", "hurt"]

# Expression per HUD portrait frame. Only this clause changes between them - same seed, same
# IPAdapter reference - so the four read as one character pulling four faces.
# Kept to ONE short clause each. An earlier version piled three or four facial descriptors into the
# attack and hurt frames and those were exactly the ones that collapsed into abstract collages -
# the same over-conditioning this 8-step model has broken under repeatedly.
PORTRAIT_EXPRESSIONS = {
    "idle":   "calm determined expression",
    "attack": "shouting fiercely with mouth open",
    "block":  "jaw clenched and braced",
    "hurt":   "wincing in pain",
}


def get_portrait_prompts(player_style):
    """Prompt pair for the status-panel portrait. Generated inside the player-sprite pipeline (not
    the FLUX texture batch) so it can be IPAdapter-conditioned on the SAME reference the animation
    frames use - a separately generated portrait had no way to resemble the actual character.
    This is the one place a face IS wanted, since it's the HUD mugshot rather than the sprite."""
    p_style = player_style.strip() if (player_style and player_style.strip()) else "armored knight"
    # Weights are kept deliberately LIGHT here. A version of this with half a dozen terms at 1.4-1.5
    # collapsed some seeds into an abstract kaleidoscope with no character in it at all - the same
    # fragility this 8-step distilled model showed when given heavy multi-conditioning elsewhere.
    # One head, facing forward, is carried mostly by plain wording.
    portrait_positives = [
        f"Head and shoulders portrait of one {p_style} warrior, (facing the viewer:1.2), a single "
        f"centered bust filling the frame, {PORTRAIT_EXPRESSIONS[n]}. Game character portrait art. "
        f"Plain solid light background."
        for n in PORTRAIT_FRAME_NAMES
    ]
    portrait_negative = (
        "back view, facing away, back of the head, rear view, "
        "two characters, multiple heads, duplicate, character sheet, multiple views, "
        "grid, tiled, side by side, mirrored, "
        "full body, legs, feet, weapon, sword, shield, "
        "trees, forest, sky, room, floor, scenery, landscape, detailed background, "
        "abstract, kaleidoscope, pattern, collage, "
        "blurry, watermark, cropped, text, signature, jpeg artifacts"
    )
    return portrait_positives, portrait_negative


def get_shield_prompts(player_style):
    """Prompt pair for the one-off shield sprite composited onto the left arm in every frame.
    Like the sword, this is generated separately because the character pass kept declining to
    draw a shield at all - and when it did, it sometimes drew two."""
    p_style = player_style.strip() if (player_style and player_style.strip()) else "armored knight"
    # The style words describe the shield's MATERIALS AND COLOURS, never its subject. Phrased as
    # "styled to match a {style} warrior" the model painted the style noun onto the shield as a
    # crest - a "cat" warrior got a shield with a big cat portrait on it, which is both odd and
    # precisely the face the rest of the pipeline works to keep out of frame.
    shield_positive = (
        f"A single round battle shield seen face-on, one circular shield with a plain raised central boss "
        f"and a decorated rim, bare undecorated surface, no emblem, no crest, no painted figure. Low-poly "
        f"game item sprite, in the colours and materials of a {p_style} "
        f"warrior's gear. Isolated alone and centered on a solid plain white background, no character, "
        f"no person, no hands, no sword."
    )
    shield_negative = (
        "(face:1.6), (animal head:1.6), (portrait:1.5), (emblem:1.4), (crest:1.4), "
        "heraldry, coat of arms, painted animal, mascot, logo, "
        "spiked wheel, chakram, throwing star, cog, gear, saw blade, spikes, blades on the rim, "
        "face on the shield, animal face, cat face, eyes, muzzle, mask, "
        "person, character, human, warrior, knight, hand, hands, arm, arms, body, face, holding, wielding, "
        "sword, blade, weapon, spear, axe, crossed weapons, "
        "two shields, multiple shields, pair of shields, shield rack, collection, row of shields, "
        "item icons, ui text, labels, inventory grid, room, floor, scenery, background, landscape, "
        "blurry, watermark, cropped, text, signature, jpeg artifacts"
    )
    return shield_positive, shield_negative


ENEMY_FRAME_NAMES = ["idle", "attack", "hurt"]

# Enemy skeletons are FRONT-facing (it is looking at the player), which is why these carry a nose
# and eyes where the player's deliberately omit them. Without ControlNet the three enemy frames
# collapsed into the same image - a shared seed plus a strong IPAdapter leaves pose wording alone
# with nothing to push against, so the "attack" and "hurt" frames were indistinguishable from idle.
ENEMY_POSE_KEYPOINTS = {
    "idle": [
        (0.50, 0.16), (0.50, 0.24),
        (0.61, 0.27), (0.66, 0.42), (0.68, 0.56),
        (0.39, 0.27), (0.34, 0.42), (0.32, 0.56),
        (0.57, 0.56), (0.58, 0.74), (0.58, 0.92),
        (0.43, 0.56), (0.42, 0.74), (0.42, 0.92),
        (0.535, 0.145), (0.465, 0.145), (0.575, 0.16), (0.425, 0.16),
    ],
    # Lunging at the player: both arms thrown up and out toward the viewer, legs splayed.
    "attack": [
        (0.50, 0.18), (0.50, 0.26),
        (0.62, 0.28), (0.73, 0.21), (0.82, 0.13),
        (0.38, 0.28), (0.27, 0.21), (0.18, 0.13),
        (0.57, 0.57), (0.63, 0.75), (0.69, 0.93),
        (0.43, 0.57), (0.37, 0.75), (0.31, 0.93),
        (0.535, 0.165), (0.465, 0.165), (0.575, 0.18), (0.425, 0.18),
    ],
    # Recoiling from a hit: head snapped back and down, arms flung backward, off balance.
    "hurt": [
        (0.52, 0.22), (0.51, 0.29),
        (0.61, 0.32), (0.71, 0.39), (0.79, 0.32),
        (0.41, 0.32), (0.31, 0.39), (0.23, 0.32),
        (0.58, 0.59), (0.62, 0.77), (0.66, 0.94),
        (0.44, 0.59), (0.40, 0.77), (0.36, 0.94),
        (0.555, 0.205), (0.485, 0.205), (0.595, 0.22), (0.445, 0.22),
    ],
}


def generate_enemy_sprites(enemy_style):
    """Generate the enemy's idle / attack / hurt frames.

    Deliberately much simpler than the player pipeline: the enemy FACES the camera (it is looking
    at the player), so there is no back-view problem to solve and no ControlNet skeleton needed -
    the three poses are far enough apart to separate on text alone. Identity is held together the
    same way as the player's, by generating one reference and IPAdapter-conditioning the frames on
    it, and all three share a seed so they read as one creature rather than three."""
    e_style = enemy_style.strip() if (enemy_style and enemy_style.strip()) else "shadowy nightstalker demon"
    seed = random.randint(1, 1000000000)

    tail = (
        f"Single {e_style} enemy monster, one figure only, full body game character. Facing the viewer head on, full body, centered. "
        f"Isolated on a plain white background, no scenery."
    )
    negative = (
        "two characters, duplicate, character sheet, multiple views, grid, tiled, "
        "human hero, knight, player character, "
        "room, floor, scenery, landscape, "
        "blurry, watermark, text, signature, bad anatomy"
    )
    pose_prompts = [
        f"Standing menacingly at rest, arms low, breathing. {tail}",
        f"Lunging forward mid-attack, arms swung out toward the viewer, aggressive. {tail}",
        f"Recoiling backward in pain from a hit, head thrown back, staggering. {tail}",
    ]

    payload = {
        "ckpt": {"inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"}, "class_type": "CheckpointLoaderSimple"},
        "lora": {"inputs": {"model": ["ckpt", 0], "clip": ["ckpt", 1], "lora_name": "sdxl_lightning_8step_lora.safetensors", "strength_model": 1.0, "strength_clip": 1.0}, "class_type": "LoraLoader"},
        "neg": {"inputs": {"text": negative, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "ipa_loader": {"inputs": {"model": ["lora", 0], "preset": "PLUS (high strength)"}, "class_type": "IPAdapterUnifiedLoader"},
        "bg_model": {"inputs": {"bg_removal_name": BIREFNET_MODEL}, "class_type": "LoadBackgroundRemovalModel"},
        "cn_loader": {"inputs": {"control_net_name": "SDXL\\OpenPoseXL2.safetensors"}, "class_type": "ControlNetLoader"},

        "ref_lat": {"inputs": {"width": 768, "height": 768, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "ref_pos": {"inputs": {"text": f"Standing still, neutral pose. {tail}", "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "ref_pose_img": {"inputs": {"image": render_pose_skeleton("idle", keypoints=ENEMY_POSE_KEYPOINTS["idle"], prefix="enemy_skel")}, "class_type": "LoadImage"},
        "ref_cn": {"inputs": {"positive": ["ref_pos", 0], "negative": ["neg", 0], "control_net": ["cn_loader", 0], "image": ["ref_pose_img", 0], "strength": 0.85, "start_percent": 0.0, "end_percent": 1.0}, "class_type": "ControlNetApplyAdvanced"},
        "ref_samp": {"inputs": {"seed": seed, "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["lora", 0], "positive": ["ref_cn", 0], "negative": ["ref_cn", 1], "latent_image": ["ref_lat", 0]}, "class_type": "KSampler"},
        "ref_dec": {"inputs": {"samples": ["ref_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"},
    }

    for i, pose_prompt in enumerate(pose_prompts):
        name = ENEMY_FRAME_NAMES[i]
        skeleton = render_pose_skeleton(name, keypoints=ENEMY_POSE_KEYPOINTS[name], prefix="enemy_skel")
        payload[f"ipa_{name}"] = {"inputs": {"model": ["lora", 0], "ipadapter": ["ipa_loader", 1], "image": ["ref_dec", 0], "weight": 0.75, "weight_type": "linear", "combine_embeds": "concat", "start_at": 0.0, "end_at": 1.0, "embeds_scaling": "V only"}, "class_type": "IPAdapterAdvanced"}
        payload[f"{name}_lat"] = {"inputs": {"width": 768, "height": 768, "batch_size": 1}, "class_type": "EmptyLatentImage"}
        payload[f"{name}_pos"] = {"inputs": {"text": pose_prompt, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"}
        payload[f"{name}_pose_img"] = {"inputs": {"image": skeleton}, "class_type": "LoadImage"}
        payload[f"{name}_cn"] = {"inputs": {"positive": [f"{name}_pos", 0], "negative": ["neg", 0], "control_net": ["cn_loader", 0], "image": [f"{name}_pose_img", 0], "strength": 0.85, "start_percent": 0.0, "end_percent": 1.0}, "class_type": "ControlNetApplyAdvanced"}
        payload[f"{name}_samp"] = {"inputs": {"seed": seed, "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": [f"ipa_{name}", 0], "positive": [f"{name}_cn", 0], "negative": [f"{name}_cn", 1], "latent_image": [f"{name}_lat", 0]}, "class_type": "KSampler"}
        payload[f"{name}_dec"] = {"inputs": {"samples": [f"{name}_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"}
        payload[f"{name}_mask"] = {"inputs": {"bg_removal_model": ["bg_model", 0], "image": [f"{name}_dec", 0]}, "class_type": "RemoveBackground"}
        payload[f"{name}_maskinv"] = {"inputs": {"mask": [f"{name}_mask", 0]}, "class_type": "InvertMask"}
        payload[f"{name}_save"] = {"inputs": {"filename_prefix": f"enemy_{name}_{int(time.time()*1000)}", "images": [f"{name}_dec", 0], "mask": [f"{name}_maskinv", 0]}, "class_type": "SaveImageWithAlpha"}

    data = json.dumps({"prompt": payload, "client_id": COMFY_CLIENT_ID}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        prompt_id = _track_prompt(json.loads(resp.read().decode("utf-8"))["prompt_id"])

    expected = [f"{n}_save" for n in ENEMY_FRAME_NAMES]
    start_time = time.time()
    while time.time() - start_time < 300:
        time.sleep(0.2)
        _bail_if_cancelled()
        with urllib.request.urlopen(urllib.request.Request(f"{COMFY_URL}/history/{prompt_id}")) as h:
            hist = json.loads(h.read().decode("utf-8"))
        if prompt_id in hist:
            outputs = hist[prompt_id].get("outputs", {})
            if all(k in outputs for k in expected):
                paths = []
                for k in expected:
                    info = outputs[k]["images"][0]
                    p = os.path.join(COMFY_OUTPUT_DIR, info.get("subfolder", ""), info["filename"])
                    keep_largest_figure(p)
                    paths.append(p)
                crop_frames_to_common_bbox(paths)
                print(f"[Enemy Sprite] 3-frame set complete for '{e_style}'")
                return paths

    raise TimeoutError("Enemy sprite generation timed out.")


def generate_player_sprite_ipadapter(player_style, weapon_style=None):
    """Generate one clean reference character with SDXL-Lightning, then 5 pose frames
    IPAdapter-conditioned on that reference (idle, block, windup, slash, hurt), all sharing
    one locked seed for consistency. Each frame is background-removed independently, then has the
    separately-generated sword and shield composited into its hands.

    Returns (frame_paths, portrait_path)."""
    reference_prompt, pose_prompts, player_negative = get_player_sprite_prompts(player_style)
    sword_positive, sword_negative = get_sword_prompts(player_style, weapon_style)
    shield_positive, shield_negative = get_shield_prompts(player_style)
    portrait_positives, portrait_negative = get_portrait_prompts(player_style)
    seed = random.randint(1, 1000000000)
    prefix_ref = f"player_ref_{int(time.time()*1000)}"

    payload = {
        "ckpt": {"inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"}, "class_type": "CheckpointLoaderSimple"},
        "lora": {"inputs": {"model": ["ckpt", 0], "clip": ["ckpt", 1], "lora_name": "sdxl_lightning_8step_lora.safetensors", "strength_model": 1.0, "strength_clip": 1.0}, "class_type": "LoraLoader"},
        "neg": {"inputs": {"text": player_negative, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "ipa_loader": {"inputs": {"model": ["lora", 0], "preset": "PLUS (high strength)"}, "class_type": "IPAdapterUnifiedLoader"},

        "ref_lat": {"inputs": {"width": 768, "height": 768, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "ref_pos": {"inputs": {"text": reference_prompt, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        # The reference gets the SAME ControlNet skeleton treatment as the frames. Left unposed it
        # very often came back as a character TURNAROUND SHEET - front, side and back view side by
        # side - and IPAdapter then faithfully propagated both the duplicate figures and the
        # contradictory facing into all five frames. Pinning it to the idle skeleton guarantees the
        # reference is exactly one figure at a known back-view orientation.
        "ref_pose_img": {"inputs": {"image": render_pose_skeleton("idle")}, "class_type": "LoadImage"},
        "ref_cn": {"inputs": {"positive": ["ref_pos", 0], "negative": ["neg", 0], "control_net": ["cn_loader", 0], "image": ["ref_pose_img", 0], "strength": 0.9, "start_percent": 0.0, "end_percent": 1.0}, "class_type": "ControlNetApplyAdvanced"},
        "ref_samp": {"inputs": {"seed": seed, "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["lora", 0], "positive": ["ref_cn", 0], "negative": ["ref_cn", 1], "latent_image": ["ref_lat", 0]}, "class_type": "KSampler"},
        "ref_dec": {"inputs": {"samples": ["ref_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"},
        # IPAdapter is fed a wide medium shot of the reference rather than the whole frame: the
        # reference keeps drawing a sword into the character's hand however hard the negative
        # argues, and IPAdapter then copies that blade into all five frames as a second sword
        # fighting the composited one. Trimming the bottom drops most dangling gear.
        # Cut off above the hands (which sit around y=400), since that is where a stray blade hangs.
        # Deliberately FULL WIDTH and still figure-shaped - an earlier 384x384 head-and-torso crop
        # turned this into a portrait reference, and portraits face the camera, which swung every
        # frame round to front-facing.
        "ref_crop": {"inputs": {"image": ["ref_dec", 0], "width": 768, "height": 400, "x": 0, "y": 0}, "class_type": "ImageCrop"},
        "ref_save": {"inputs": {"filename_prefix": prefix_ref, "images": ["ref_dec", 0]}, "class_type": "SaveImage"},

        "bg_model": {"inputs": {"bg_removal_name": BIREFNET_MODEL}, "class_type": "LoadBackgroundRemovalModel"},
        "cn_loader": {"inputs": {"control_net_name": "SDXL\\OpenPoseXL2.safetensors"}, "class_type": "ControlNetLoader"},
    }

    # One-off sword sprite, generated blade-up on its own so it can be rotated about the grip and
    # composited into all five frames. IPAdapter runs in "style transfer" mode here (not linear) so
    # it picks up the reference character's palette/shading without dragging a body into the image.
    payload.update({
        # TWO weapon candidates, different seeds, picked between afterwards. On a square canvas the
        # weapon pass fairly often returns a fan of crossed swords fused into one squat blob, and
        # once that has happened no amount of component analysis can recover a single blade from it.
        # The canvas is also TALL (384x768) - the same trick that fixed the duplicated portrait -
        # because a fan of crossed weapons has nowhere to lay itself out in a narrow frame.
        "sword_neg": {"inputs": {"text": sword_negative, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "sword_pos": {"inputs": {"text": sword_positive, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "ipa_sword": {"inputs": {"model": ["lora", 0], "ipadapter": ["ipa_loader", 1], "image": ["ref_crop", 0], "weight": 0.4, "weight_type": "style transfer", "combine_embeds": "concat", "start_at": 0.0, "end_at": 1.0, "embeds_scaling": "V only"}, "class_type": "IPAdapterAdvanced"},
        "sword_lat": {"inputs": {"width": 384, "height": 768, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "sword_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["ipa_sword", 0], "positive": ["sword_pos", 0], "negative": ["sword_neg", 0], "latent_image": ["sword_lat", 0]}, "class_type": "KSampler"},
        "sword_dec": {"inputs": {"samples": ["sword_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"},
        "sword_mask": {"inputs": {"bg_removal_model": ["bg_model", 0], "image": ["sword_dec", 0]}, "class_type": "RemoveBackground"},
        "sword_maskinv": {"inputs": {"mask": ["sword_mask", 0]}, "class_type": "InvertMask"},
        "sword_save": {"inputs": {"filename_prefix": f"player_sword_{int(time.time()*1000)}", "images": ["sword_dec", 0], "mask": ["sword_maskinv", 0]}, "class_type": "SaveImageWithAlpha"},

        "sword2_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["ipa_sword", 0], "positive": ["sword_pos", 0], "negative": ["sword_neg", 0], "latent_image": ["sword_lat", 0]}, "class_type": "KSampler"},
        "sword2_dec": {"inputs": {"samples": ["sword2_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"},
        "sword2_mask": {"inputs": {"bg_removal_model": ["bg_model", 0], "image": ["sword2_dec", 0]}, "class_type": "RemoveBackground"},
        "sword2_maskinv": {"inputs": {"mask": ["sword2_mask", 0]}, "class_type": "InvertMask"},
        "sword2_save": {"inputs": {"filename_prefix": f"player_sword2_{int(time.time()*1000)}", "images": ["sword2_dec", 0], "mask": ["sword2_maskinv", 0]}, "class_type": "SaveImageWithAlpha"},

        "shield_neg": {"inputs": {"text": shield_negative, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        "shield_pos": {"inputs": {"text": shield_positive, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        # The face-on-the-shield problem is handled in the prompt (which is where it came from -
        # the style noun was being painted on as a crest), so this can stay high enough to actually
        # pick up the character's palette; at 0.25 a neon character got a plain grey disc.
        "ipa_shield": {"inputs": {"model": ["lora", 0], "ipadapter": ["ipa_loader", 1], "image": ["ref_crop", 0], "weight": 0.45, "weight_type": "style transfer", "combine_embeds": "concat", "start_at": 0.0, "end_at": 1.0, "embeds_scaling": "V only"}, "class_type": "IPAdapterAdvanced"},
        "shield_lat": {"inputs": {"width": 768, "height": 768, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "shield_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["ipa_shield", 0], "positive": ["shield_pos", 0], "negative": ["shield_neg", 0], "latent_image": ["shield_lat", 0]}, "class_type": "KSampler"},
        "shield_dec": {"inputs": {"samples": ["shield_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"},
        "shield_mask": {"inputs": {"bg_removal_model": ["bg_model", 0], "image": ["shield_dec", 0]}, "class_type": "RemoveBackground"},
        "shield_maskinv": {"inputs": {"mask": ["shield_mask", 0]}, "class_type": "InvertMask"},
        "shield_save": {"inputs": {"filename_prefix": f"player_shield_{int(time.time()*1000)}", "images": ["shield_dec", 0], "mask": ["shield_maskinv", 0]}, "class_type": "SaveImageWithAlpha"},

        # HUD portrait. "strong style transfer" rather than "linear": at linear the reference's
        # BACK-view composition came through and the portrait rendered the back of the character's
        # head. Strong-style-transfer carries the design - species, palette, armour - while leaving
        # framing to the prompt, which is what lets this one actually face the viewer.
        "portrait_neg": {"inputs": {"text": portrait_negative, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"},
        # Weight kept moderate: "strong style transfer" at 0.9 sometimes overwhelmed the prompt
        # entirely and produced an abstract stained-glass pattern instead of a character.
        # start_at 0.35 is the important part. Layout is decided in the earliest denoising steps, so
        # an IPAdapter running from step 0 was voting on COMPOSITION using a full-body reference
        # while the prompt asked for a single bust - and the model settled that argument by tiling
        # the bust into a 2x2 grid. Letting the prompt own the first third of the schedule fixes the
        # composition; IPAdapter still supplies the character's colours and design after that.
        "ipa_portrait": {"inputs": {"model": ["lora", 0], "ipadapter": ["ipa_loader", 1], "image": ["ref_crop", 0], "weight": 0.7, "weight_type": "style transfer", "combine_embeds": "concat", "start_at": 0.35, "end_at": 1.0, "embeds_scaling": "V only"}, "class_type": "IPAdapterAdvanced"},
        # Deliberately TALL rather than square. On a square canvas the bust framing kept coming back
        # as two portraits side by side; a 3:4 canvas simply has no room to lay two heads out
        # horizontally, which suppresses the duplication structurally instead of by prompt-wrangling.
        # Cropped back to a square below, since the HUD slot is square.
        "portrait_lat": {"inputs": {"width": 384, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
    })

    # Four HUD portrait frames - idle / attack / block / hurt - so the mugshot reacts the way a
    # Doom-style face does. Only the expression clause differs; the seed and IPAdapter reference are
    # shared, so they read as one character rather than four different people.
    # All four share ONE seed and differ only by the expression clause. That is what makes them the
    # same character pulling four faces - IPAdapter carries style but NOT facial identity, so giving
    # each frame its own seed (tried, reverted) returned four different people.
    #
    # Deriving the three expressions from the idle frame by partial-denoise img2img was also tried
    # and reverted: it held identity perfectly but this 8-step distilled model handles partial
    # denoise badly, tearing the results into glitchy colour patches while barely changing the
    # expression at all.
    #
    # The residual risk of a shared seed is that a seed which tiles the bust into a grid tiles all
    # four at once. That is what the validation in crop_portrait_square is for: tiled frames are
    # rejected on coverage or aspect, and a set that fails outright falls back to the FLUX portrait.
    for i, pos_text in enumerate(portrait_positives):
        pn = PORTRAIT_FRAME_NAMES[i]
        payload[f"portrait_{pn}_pos"] = {"inputs": {"text": pos_text, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"}
        payload[f"portrait_{pn}_samp"] = {"inputs": {"seed": seed, "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": ["ipa_portrait", 0], "positive": [f"portrait_{pn}_pos", 0], "negative": ["portrait_neg", 0], "latent_image": ["portrait_lat", 0]}, "class_type": "KSampler"}
        payload[f"portrait_{pn}_dec"] = {"inputs": {"samples": [f"portrait_{pn}_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"}
        # Background-removed like everything else, which gives the single-bust safety net in
        # crop_portrait_square separable components to work with (and looks better in the dark
        # HUD inset regardless).
        payload[f"portrait_{pn}_mask"] = {"inputs": {"bg_removal_model": ["bg_model", 0], "image": [f"portrait_{pn}_dec", 0]}, "class_type": "RemoveBackground"}
        payload[f"portrait_{pn}_maskinv"] = {"inputs": {"mask": [f"portrait_{pn}_mask", 0]}, "class_type": "InvertMask"}
        payload[f"portrait_{pn}_save"] = {"inputs": {"filename_prefix": f"player_portrait_{pn}_{int(time.time()*1000)}", "images": [f"portrait_{pn}_dec", 0], "mask": [f"portrait_{pn}_maskinv", 0]}, "class_type": "SaveImageWithAlpha"}

    # Fresh txt2img per pose, with two separate anchors doing two separate jobs instead of one
    # anchor trying to do both: ControlNet (OpenPose skeleton, hand-authored per pose above) forces
    # the actual limb positions, while IPAdapter carries identity/style from the reference image.
    # Plain img2img-from-reference alone proved to hold onto the reference's silhouette far too
    # stubbornly for the pose text to ever come through, even at denoise 0.95. A regional
    # ConditioningCombine for a head-only "no face" push was tried and made things much worse
    # (destabilized this 8-step Lightning model into "reference sheet" collages) - reverted in
    # favor of weighted emphasis, e.g. (no face visible:1.4), within the single prompt/negative.
    for i, pose_prompt in enumerate(pose_prompts):
        name = PLAYER_FRAME_NAMES[i]
        skeleton_filename = render_pose_skeleton(name)
        # Weight 0.75 rather than 0.6: the lower value let individual frames drift round to a front
        # view (the block pose especially, since a raised arm reads as front-facing), even with the
        # reference itself locked to the back view.
        payload[f"ipa_{name}"] = {"inputs": {"model": ["lora", 0], "ipadapter": ["ipa_loader", 1], "image": ["ref_crop", 0], "weight": 0.75, "weight_type": "linear", "combine_embeds": "concat", "start_at": 0.0, "end_at": 1.0, "embeds_scaling": "V only"}, "class_type": "IPAdapterAdvanced"}
        payload[f"{name}_lat"] = {"inputs": {"width": 768, "height": 768, "batch_size": 1}, "class_type": "EmptyLatentImage"}
        payload[f"{name}_pos"] = {"inputs": {"text": pose_prompt, "clip": ["lora", 1]}, "class_type": "CLIPTextEncode"}
        payload[f"{name}_pose_img"] = {"inputs": {"image": skeleton_filename}, "class_type": "LoadImage"}
        payload[f"{name}_cn"] = {"inputs": {"positive": [f"{name}_pos", 0], "negative": ["neg", 0], "control_net": ["cn_loader", 0], "image": [f"{name}_pose_img", 0], "strength": 0.9, "start_percent": 0.0, "end_percent": 1.0}, "class_type": "ControlNetApplyAdvanced"}
        # ALL five frames share one seed. Rolling a fresh seed per frame meant each pose was an
        # independent render - different build, different framing, different shading - so switching
        # from idle to block looked like cutting to a different character rather than the same one
        # raising a shield. Same seed + same prompt scaffold means the ControlNet skeleton is the
        # only thing that varies between frames, which is exactly what an animation wants.
        payload[f"{name}_samp"] = {"inputs": {"seed": seed, "steps": 8, "cfg": 2.0, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0, "model": [f"ipa_{name}", 0], "positive": [f"{name}_cn", 0], "negative": [f"{name}_cn", 1], "latent_image": [f"{name}_lat", 0]}, "class_type": "KSampler"}
        payload[f"{name}_dec"] = {"inputs": {"samples": [f"{name}_samp", 0], "vae": ["ckpt", 2]}, "class_type": "VAEDecode"}
        payload[f"{name}_mask"] = {"inputs": {"bg_removal_model": ["bg_model", 0], "image": [f"{name}_dec", 0]}, "class_type": "RemoveBackground"}
        payload[f"{name}_maskinv"] = {"inputs": {"mask": [f"{name}_mask", 0]}, "class_type": "InvertMask"}
        payload[f"{name}_save"] = {"inputs": {"filename_prefix": f"player_{name}_{int(time.time()*1000)}", "images": [f"{name}_dec", 0], "mask": [f"{name}_maskinv", 0]}, "class_type": "SaveImageWithAlpha"}

    data = json.dumps({"prompt": payload, "client_id": COMFY_CLIENT_ID}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        prompt_id = _track_prompt(json.loads(resp.read().decode("utf-8"))["prompt_id"])

    expected_saves = ([f"{name}_save" for name in PLAYER_FRAME_NAMES]
                      + ["sword_save", "sword2_save", "shield_save"]
                      + [f"portrait_{n}_save" for n in PORTRAIT_FRAME_NAMES])
    start_time = time.time()
    while time.time() - start_time < 300:
        time.sleep(0.2)
        _bail_if_cancelled()
        hist_req = urllib.request.Request(f"{COMFY_URL}/history/{prompt_id}")
        with urllib.request.urlopen(hist_req) as h_resp:
            hist_data = json.loads(h_resp.read().decode("utf-8"))
            if prompt_id in hist_data:
                outputs = hist_data[prompt_id].get("outputs", {})
                if all(key in outputs for key in expected_saves):
                    def _path_of(key):
                        img_info = outputs[key]["images"][0]
                        return os.path.join(COMFY_OUTPUT_DIR, img_info.get("subfolder", ""), img_info["filename"])

                    sword_path = pick_best_weapon([_path_of("sword_save"), _path_of("sword2_save")])
                    shield_path = extract_single_shield(_path_of("shield_save"))

                    # Composite BEFORE cropping: the anchor points are in the same normalized space
                    # as the pose skeletons, which only lines up on the full uncropped canvas.
                    frame_paths = []
                    for name in PLAYER_FRAME_NAMES:
                        path = _path_of(f"{name}_save")
                        # Drop any stray second figure BEFORE the gear goes on, so the shared
                        # bounding box below is measured against the player alone.
                        keep_largest_figure(path)
                        composite_gear_onto_frame(path, sword_path, shield_path, name)
                        frame_paths.append(path)

                    # One shared bbox for all five, so only the limbs move between frames. Cropping
                    # each frame to its own tight box made the character visibly resize and hop on
                    # every swap, since the frontend derives sprite width from each image's own
                    # aspect ratio against a fixed height.
                    crop_frames_to_common_bbox(frame_paths)

                    # Any portrait frame that came out as an abstract mess falls back to the idle
                    # one, so a bad roll costs an expression rather than the whole mugshot.
                    portrait_paths = []
                    for pn in PORTRAIT_FRAME_NAMES:
                        p = _path_of(f"portrait_{pn}_save")
                        portrait_paths.append(p if crop_portrait_square(p) else None)
                    idle_portrait = portrait_paths[0] or next((p for p in portrait_paths if p), None)
                    portrait_paths = [p or idle_portrait for p in portrait_paths]

                    print(f"[Player Sprite] IPAdapter 5-frame set + composited gear + "
                          f"{sum(1 for p in portrait_paths if p)} portrait frames for '{player_style}'")
                    return frame_paths, portrait_paths

    raise TimeoutError("SDXL-Lightning + IPAdapter player sprite generation timed out.")


def _isolate_component(img_path, elongated):
    """Cut one object out of a generated item image and return it as a tight RGBA crop.

    Asking for "a single sword" reliably comes back as a whole weapon-asset SHEET instead - a grid
    of a dozen swords, sometimes with a shield thrown in - because that is overwhelmingly what item
    art looks like in the training data. Rather than fight the prompt, take it at face value and
    pick one object out of it with connected-component analysis, which works whether the model
    returned 1 item or 20.

    Shape is judged by PCA elongation rather than bounding-box aspect, because the model draws
    items at whatever angle it likes - a sideways sword has a WIDE bbox and would sail straight
    past any "tall and thin" test, which is how a shield once got picked as the sword."""
    import numpy as np
    from scipy import ndimage
    from PIL import Image

    arr = np.array(Image.open(img_path).convert("RGBA"))
    labels, n = ndimage.label(arr[:, :, 3] > 20)
    if n == 0:
        return None, None, 0.0

    all_comps, shaped = [], []
    for idx, (sl_y, sl_x) in enumerate(ndimage.find_objects(labels)):
        label_id = idx + 1
        ys, xs = np.nonzero(labels[sl_y, sl_x] == label_id)
        filled = len(ys)
        if filled < 400:
            continue
        coords = np.stack([xs, ys]).astype(np.float64)
        coords -= coords.mean(axis=1, keepdims=True)
        evals, evecs = np.linalg.eigh(np.cov(coords))
        evals = np.maximum(evals, 1e-6)
        elong = float(np.sqrt(evals[1] / evals[0]))
        major = evecs[:, 1]

        # How many separate horizontal runs does a typical row of this component have? One real
        # sword answers 1. Several parallel swords whose hilts happen to touch answer 2, 3, 4 - and
        # that group can easily be the largest "elongated" component on the sheet, which is how a
        # cluster of blades kept getting picked and composited into the frame as one lumpy weapon.
        sub = labels[sl_y, sl_x] == label_id
        occupied = sub.any(axis=1)
        run_starts = (np.diff(sub.astype(np.int8), axis=1) == 1).sum(axis=1) + sub[:, 0]
        runs = float(np.median(run_starts[occupied])) if occupied.any() else 99.0

        entry = (label_id, sl_y, sl_x, filled, elong, major, runs)
        all_comps.append(entry)
        # A sword is a long thin bar; a shield is a compact ROUND slab. Both reject stray specks and
        # hairline slivers of leftover antialiasing. The shield's solidity is bounded at BOTH ends,
        # because a disc fills about 0.79 of its bounding box and the two failure modes sit either
        # side of that: the decorated rims the model likes to draw come out as hollow rings nearer
        # 0.3 (a hoop on the arm), while a contact sheet of shields packed edge to edge forms one
        # near-solid RECTANGLE approaching 1.0 (a tiled slab on the arm).
        solidity = filled / float(max(1, sub.shape[0] * sub.shape[1]))
        # Running off BOTH the top and bottom edge means this is not one item but a column of them
        # fused end to end - a stack of axe heads, say. That reads as a single run per row and a
        # perfectly sword-like elongation, so nothing else here catches it; only the fact that a
        # real item sprite is generated with margins and does not bleed off both edges at once.
        spans_canvas = (sl_y.start == 0 and sl_y.stop == arr.shape[0])
        # Upper elongation bound is generous: real sheets routinely contain slim blades scoring ~14,
        # and capping at 12 threw those away and left only the fused blobs to choose from.
        shape_ok = (2.2 < elong < 22.0 and not spans_canvas) if elongated else (elong < 1.9 and 0.55 < solidity < 0.90)
        if shape_ok:
            shaped.append(entry)

    # Degrade gracefully rather than bailing out: returning None here would leave the caller
    # compositing the ENTIRE untouched sheet into every frame - that is the "fan of swords" bug.
    pool = shaped or all_comps
    if not pool:
        return None, None, 0.0

    # Sort single-run components ahead of clusters FIRST, then take the beefiest of those - a
    # bulky blade reads best once scaled to sprite size, where a spindly one would vanish. Ranking
    # on size alone let a fused group of parallel blades win whenever it outweighed every clean
    # single sword on the sheet, which is how a fan of swords kept ending up in the player's hand.
    label_id, sl_y, sl_x, _, elong, major, _ = max(pool, key=lambda c: (c[6] <= 1.4, c[3]))
    crop = arr[sl_y, sl_x].copy()
    # Blank out any NEIGHBOURING item overlapping this bounding box.
    crop[:, :, 3] = np.where(labels[sl_y, sl_x] == label_id, crop[:, :, 3], 0)
    # `elong` doubles as a quality score for the caller: a fused bundle of crossed swords comes back
    # as one squat blob scoring under 2, which is how the caller tells a real pick from a failure.
    return Image.fromarray(crop), major, elong


def _tight_crop(img, thresh=20):
    import numpy as np
    a = np.array(img)
    ys, xs = np.nonzero(a[:, :, 3] > thresh)
    if not len(ys):
        return img
    return img.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))


def crop_portrait_square(portrait_path):
    """Reduce the portrait to ONE head-and-shoulders bust and square it off for the HUD slot.

    Safety net for the duplicate-bust failure: when the model returns several busts, they come back
    as separate connected components once the background is removed, so keeping the largest one
    leaves a single face. A well-formed single portrait already IS the largest component, so this
    costs nothing in the normal case. The square crop then keeps the TOP of the frame, since that
    is where the head sits - cropping from the bottom would behead it.

    Returns False when the frame is unusable, which the caller treats as "fall back to idle"."""
    import numpy as np
    from scipy import ndimage
    from PIL import Image
    try:
        img = Image.open(portrait_path).convert("RGBA")
        arr = np.array(img)
        labels, n = ndimage.label(arr[:, :, 3] > 20)
        if n == 0:
            return False

        counts = np.bincount(labels.ravel())
        counts[0] = 0
        keep = int(counts.argmax())

        # A real bust sits on a background the segmenter can cut away, so it covers a middling
        # slice of the canvas. The abstract-collage failures have no background at all - they are
        # edge-to-edge texture, so the "subject" swallows essentially the whole frame. Coverage
        # separates those two cases cleanly, where the symmetry tests tried earlier could not.
        coverage = counts[keep] / float(arr.shape[0] * arr.shape[1])
        if coverage > 0.92 or coverage < 0.10:
            print(f"[Portrait] rejected a frame - subject covers {coverage:.0%} of the canvas")
            return False

        if n > 1:
            ys, xs = np.nonzero(labels == keep)
            arr[:, :, 3] = np.where(labels == keep, arr[:, :, 3], 0)
            arr = arr[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
            img = Image.fromarray(arr)

        # A single head-and-shoulders bust is square or taller. Coming out markedly WIDER than tall
        # means several busts ended up connected to each other and got cropped together - the tiled
        # failure that coverage alone does not catch, because a tiled grid still has background
        # around it.
        if img.width > img.height * 1.3:
            print(f"[Portrait] rejected a frame - {img.width}x{img.height} is too wide for one bust")
            return False

        if img.height > img.width:
            img = img.crop((0, 0, img.width, img.width))
        img.save(portrait_path, format="PNG")
        return True
    except Exception as e:
        print(f"[Portrait Crop Error] {e}")
        return False


def keep_largest_figure(frame_path, thresh=20):
    """Erase everything in a background-removed frame except the biggest connected blob.

    The character pass occasionally renders a SECOND figure - a bystander off to one side - and
    BiRefNet, correctly, cuts them both out. That extra person then rides along in the sprite and
    turns up in the game standing next to the player. The player is always the dominant mass in
    frame, so keeping only the largest component removes the intruder without touching them.

    `thresh` is the alpha cut for "solid". A higher value (used for the enemy) also discards a
    faint BiRefNet halo left on the old pure-white background - that halo would otherwise be the
    largest component and defeat the tight crop that follows, leaving the creature tiny."""
    import numpy as np
    from scipy import ndimage
    from PIL import Image
    try:
        img = Image.open(frame_path).convert("RGBA")
        arr = np.array(img)
        labels, n = ndimage.label(arr[:, :, 3] > thresh)
        if n <= 1:
            return
        counts = np.bincount(labels.ravel())
        counts[0] = 0                     # index 0 is the transparent background
        arr[:, :, 3] = np.where(labels == counts.argmax(), arr[:, :, 3], 0)
        Image.fromarray(arr).save(frame_path, format="PNG")
    except Exception as e:
        print(f"[Keep Largest Figure Error] {e}")


def _pick_path(src):
    """Where an extracted item sprite is written. Deliberately NOT over the source sheet: keeping
    the raw generation lets a bad pick be diagnosed afterwards, and stops a re-run compounding one."""
    base, ext = os.path.splitext(src)
    return f"{base}_pick{ext}"


def extract_single_sword(sword_path):
    """Reduce whatever the sword pass produced to exactly one upright, grip-at-the-bottom blade,
    so PLAYER_SWORD_TRANSFORMS' angles always pivot about the grip with 0 degrees = held upright.
    Returns (path, score) where score rates how weapon-like the pick was - a fused bundle of
    crossed swords scores under 2 - or (None, 0) if nothing usable was found."""
    import math
    from PIL import Image
    try:
        sword, major, score = _isolate_component(sword_path, elongated=True)
        if sword is None:
            return None, 0.0

        # Stand the blade upright along its own principal axis. The axis is a line, so its sign is
        # ambiguous - rotate both ways and keep whichever comes out actually vertical, which sidesteps
        # having to reason about PIL's rotation direction against image-space y-down coordinates.
        r = 90.0 - math.degrees(math.atan2(major[1], major[0]))
        best = None
        for angle in (r, -r):
            cand = _tight_crop(sword.rotate(angle, resample=Image.BICUBIC, expand=True))
            score = cand.height / max(1, cand.width)
            if best is None or score > best[0]:
                best = (score, cand)
        sword = best[1]

        # Find the crossguard and put it in the bottom half, which lands the sword grip-down.
        #
        # Not simply "the widest row": on a sword with a broad blade the widest row IS the blade,
        # which flips the whole thing point-down. What actually distinguishes a crossguard is that
        # it's a narrow SPIKE in the width profile - abruptly wider than the blade above it and the
        # grip below it - whereas a blade is wide but locally uniform. So score each row against a
        # rolling median of its own neighbourhood and take the sharpest outlier.
        import numpy as np
        from scipy.ndimage import median_filter
        widths = (np.array(sword)[:, :, 3] > 20).sum(axis=1).astype(float)
        n = len(widths)
        if n > 8:
            k = max(3, n // 12)
            ratio = widths / np.maximum(median_filter(widths, size=2 * k + 1, mode="nearest"), 1.0)
            # Ignore the extreme ends, where the rolling window is degenerate and a taper to a
            # point can masquerade as a spike.
            interior = np.zeros(n, dtype=bool)
            interior[int(n * 0.08):int(n * 0.92)] = True
            if int(np.argmax(np.where(interior, ratio, 0.0))) < n / 2:
                sword = sword.transpose(Image.ROTATE_180)

        out = _pick_path(sword_path)
        sword.save(out, format="PNG")
        return out, score
    except Exception as e:
        print(f"[Sword Extract Error] {e}")
        return None, 0.0


def pick_best_weapon(candidate_paths):
    """Extract from every weapon candidate and keep the most weapon-like result.

    The weapon pass sometimes returns a fan of crossed swords fused into one squat blob rather than
    separable blades. Nothing downstream can rescue that - the blob IS the only component - so the
    cheapest defence is to roll a second candidate with a different seed and keep the better of the
    two. A real blade scores 3-15 on elongation; a fused bundle scores under 2."""
    best_path, best_score = None, 0.0
    for p in candidate_paths:
        path, score = extract_single_sword(p)
        if path and score > best_score:
            best_path, best_score = path, score
    if best_path and best_score < 2.2:
        print(f"[Weapon] every candidate looked fused (best score {best_score:.2f}); using it anyway")
    return best_path


def extract_single_shield(shield_path):
    """Reduce the shield pass to one compact roundish shield. No rotation normalising needed -
    a shield reads fine at any roll angle, unlike a blade.
    Returns the path of the extracted sprite, or None if nothing usable was found."""
    try:
        shield, _, _ = _isolate_component(shield_path, elongated=False)
        if shield is None:
            return None
        out = _pick_path(shield_path)
        shield.save(out, format="PNG")
        return out
    except Exception as e:
        print(f"[Shield Extract Error] {e}")
        return None


def _paste_pivoted(frame, sprite, cfg, anchor, pivot_bottom, grip_frac=0.0):
    """Scale, rotate and paste one gear sprite onto a frame at a normalized anchor point.
    `pivot_bottom` rotates about a point near the sprite's bottom-centre (a sword swinging from its
    grip); otherwise it rotates about its own centre (a shield strapped flat to the forearm).
    `grip_frac` lifts that pivot up from the very bottom edge as a fraction of sprite height, so
    the hand closes around the HANDLE instead of balancing on the tip of the pommel."""
    from PIL import Image
    fw, fh = frame.size
    target_h = max(8, int(cfg["scale"] * fh))
    target_w = max(1, int(sprite.width * (target_h / sprite.height)))
    sprite = sprite.resize((target_w, target_h), Image.LANCZOS)

    # PIL rotates about the canvas centre, so park the desired pivot at the centre of a square
    # scratch canvas and that point becomes the pivot.
    pad = max(target_h, target_w) * 2
    scratch = Image.new("RGBA", (pad, pad), (0, 0, 0, 0))
    top = (pad // 2 - int(target_h * (1.0 - grip_frac))) if pivot_bottom else (pad // 2 - target_h // 2)
    scratch.paste(sprite, (pad // 2 - target_w // 2, top), sprite)
    scratch = scratch.rotate(cfg["angle"], resample=Image.BICUBIC, center=(pad // 2, pad // 2))

    ox, oy = cfg.get("offset", (0.0, 0.0))
    layer = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    layer.paste(scratch, (int((anchor[0] + ox) * fw) - pad // 2,
                          int((anchor[1] + oy) * fh) - pad // 2), scratch)
    return Image.alpha_composite(frame, layer)


def _draw_swipe_streak(frame, streak):
    """Draw Valbrace's white swipe arc: a tapered crescent tracing where the blade travelled,
    thickest mid-swing and thinning to nothing at both ends."""
    import math
    from PIL import Image, ImageDraw, ImageFilter
    fw, fh = frame.size
    pts = [(x * fw, y * fh) for (x, y) in streak["points"]]
    max_r = max(2.0, streak["width"] * fw / 2.0)

    # Sample a Catmull-Rom spline through the control points and stamp a dot whose radius follows a
    # sine envelope. Both halves matter: a constant-width line read as a solid white bar bolted to
    # the sprite, and straight segments between the control points kinked into a lightning bolt.
    ctrl = [pts[0]] + pts + [pts[-1]]

    def sample(t):
        s = t * (len(ctrl) - 3)
        i = min(int(s), len(ctrl) - 4)
        f = s - i
        p0, p1, p2, p3 = ctrl[i], ctrl[i + 1], ctrl[i + 2], ctrl[i + 3]
        f2, f3 = f * f, f * f * f
        return tuple(
            0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * f
                   + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * f2
                   + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * f3)
            for d in (0, 1)
        )

    glow = Image.new("RGBA", (fw, fh), (255, 255, 255, 0))
    core = Image.new("RGBA", (fw, fh), (255, 255, 255, 0))
    gd, cd = ImageDraw.Draw(glow), ImageDraw.Draw(core)
    for k in range(160):
        t = k / 159.0
        x, y = sample(t)
        r = max_r * (math.sin(math.pi * t) ** 0.55)
        gd.ellipse([x - r * 2.4, y - r * 2.4, x + r * 2.4, y + r * 2.4], fill=(255, 255, 255, 26))
        cd.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 215))

    glow = glow.filter(ImageFilter.GaussianBlur(radius=max_r * 1.6))
    return Image.alpha_composite(Image.alpha_composite(frame, glow), core)


def composite_gear_onto_frame(frame_path, sword_path, shield_path, pose_name):
    """Bake the shared sword and shield sprites (and, on the slash, the motion streak) into one
    pose frame. Both are pinned to the very same wrist keypoints ControlNet used to place the arms,
    so the gear and the hands can never drift out of sync the way separate overlay layers did."""
    from PIL import Image
    try:
        kps = PLAYER_POSE_KEYPOINTS[pose_name]
        frame = Image.open(frame_path).convert("RGBA")

        # ALL gear is assembled on its own layer and slid UNDER the character. The camera sits
        # behind the player and the player faces away into the scene, so anything held out toward
        # the enemy - shield, blade, and the swipe arc the blade traced - is on the player's FAR
        # side. It belongs partly hidden behind their own silhouette, with only what clears the
        # body edge visible. Drawn on top, the sword read as being held behind the player's back.
        gear = Image.new("RGBA", frame.size, (0, 0, 0, 0))

        shield_cfg = PLAYER_SHIELD_TRANSFORMS.get(pose_name)
        if shield_cfg and kps[7] and shield_path and os.path.exists(shield_path):
            gear = _paste_pivoted(gear, Image.open(shield_path).convert("RGBA"),
                                  shield_cfg, kps[7], pivot_bottom=False)

        cfg = PLAYER_SWORD_TRANSFORMS.get(pose_name)
        if cfg and cfg.get("streak"):
            gear = _draw_swipe_streak(gear, cfg["streak"])

        if cfg and kps[4] and sword_path and os.path.exists(sword_path):
            gear = _paste_pivoted(gear, Image.open(sword_path).convert("RGBA"),
                                  cfg, kps[4], pivot_bottom=True, grip_frac=SWORD_GRIP_FRAC)

        Image.alpha_composite(gear, frame).save(frame_path, format="PNG")
    except Exception as e:
        print(f"[Gear Composite Error] {pose_name}: {e}")


def crop_frames_to_common_bbox(frame_paths, pad=6, bbox_indices=None):
    """Crop every frame to a common alpha bounding box, so all frames come out the same size and the
    character holds still between swaps instead of rescaling each time.

    By default the box is the UNION of every frame's bbox. Pass bbox_indices to build the box from
    only those frames - use this when some frames (a wide weapon swing, a stagger with the arms
    flung out) would otherwise balloon the box and shrink the character in every frame. Frames
    outside the set are still cropped to it, so an extended blade tip may clip at the edge."""
    import numpy as np
    from PIL import Image
    try:
        imgs = [Image.open(p).convert("RGBA") for p in frame_paths]
        src = imgs if not bbox_indices else [imgs[i] for i in bbox_indices]
        boxes = []
        for img in src:
            ys, xs = np.where(np.array(img)[:, :, 3] > 20)
            if len(ys):
                boxes.append((xs.min(), ys.min(), xs.max(), ys.max()))
        if not boxes:
            return
        w, h = imgs[0].size
        x1 = max(0, min(b[0] for b in boxes) - pad)
        y1 = max(0, min(b[1] for b in boxes) - pad)
        x2 = min(w, max(b[2] for b in boxes) + pad)
        y2 = min(h, max(b[3] for b in boxes) + pad)
        for img, path in zip(imgs, frame_paths):
            img.crop((x1, y1, x2, y2)).save(path, format="PNG")
    except Exception as e:
        print(f"[Common Bbox Crop Error] {e}")

def make_sprite_transparent(img_path):
    import numpy as np
    from PIL import Image
    try:
        img = Image.open(img_path).convert("RGBA")
        arr = np.array(img).astype(np.float32)
        
        corners = [arr[0:15, 0:15], arr[0:15, -15:], arr[-15:, 0:15], arr[-15:, -15:]]
        bg_color = np.mean([c.mean(axis=(0, 1))[:3] for c in corners], axis=0)
        
        diff = np.sqrt(np.sum((arr[:, :, :3] - bg_color) ** 2, axis=-1))
        alpha = np.clip((diff - 20) / 30, 0, 1) * 255.0
        
        white_mask = np.sum(arr[:, :, :3], axis=-1) > 700
        alpha[white_mask] = 0
        arr[:, :, 3] = alpha
        
        # Crop to tightest bounding box
        non_zero = np.where(arr[:, :, 3] > 20)
        if len(non_zero[0]) > 0:
            y1, y2 = non_zero[0].min(), non_zero[0].max()
            x1, x2 = non_zero[1].min(), non_zero[1].max()
            cropped = arr[y1:y2+1, x1:x2+1]
        else:
            cropped = arr
            
        out_img = Image.fromarray(np.clip(cropped, 0, 255).astype(np.uint8))
        out_img.save(img_path, format="PNG")
        print(f"[Sprite] Made background transparent for {os.path.basename(img_path)}")
        return img_path
    except Exception as e:
        print(f"[Sprite Transparency Error] {e}")
        return [img_path]

def match_word(pattern, text):
    import re
    return bool(re.search(r'\b' + pattern + r'\b', text, re.IGNORECASE))

# Shared tail for every lantern_p below: forces a single isolated object on a clean white
# ground, so the frontend's BiRefNet cutout has an actual plain background to cut around (a
# busy/patterned background doesn't get removed, and the whole square comes back opaque).
#
# NEVER name a light fixture here - not "bulb", not "lamp", not "light source". These prompts
# run on FLUX schnell at cfg 1.0, so the negative conditioning is inert and every exclusion has
# to live in the POSITIVE prompt as a "zero X" phrase. That works for vague scene elements
# ("zero sky") but backfires on a strong concrete noun: a previous version of this tail said
# "zero light bulb, zero incandescent filament bulb" and the model, which cannot negate, drew
# exactly an incandescent filament bulb every single time. The fix is silence - describe the
# THEME OBJECT as the subject and light only as something it emits.
_LANTERN_TAIL = ("Exactly one object, centered, front view, isolated on a plain flat pure white "
                 "background, sharp focus, no room, no scenery, no people, no text.")


# The hand-tuned theme buckets, in priority order (this table plus _STYLE_BUCKETS_NAMED and
# the two word-boundary lists below). get_surface_prompts and get_gate_prompts BOTH dispatch
# on this one function so their keyword chains cannot drift apart - a style whose wall got the
# taco treatment but whose door fell through to the generic branch is exactly how a door ends
# up looking unrelated to the corridor it is set in, which get_gate_prompts' docstring already
# calls out.
#
# Returns None when nothing matched. That is also the signal the caller needs: no bucket means
# the generic branch is about to interpolate the typed word raw, which is what needs an LLM
# set-designer pass (see generate_theme_brief).
#
# Match semantics are preserved EXACTLY as they were when this chain lived twice: buckets 5 and
# 6 use word-boundary matching, the other eight use bare substring. The substring ones do
# over-match ('cat' fires on "cathedral", '95' on any string containing 95, 'rock' on
# "rockstar") - real, but tightening them changes which theme existing inputs resolve to, so it
# is deliberately left alone here.
_STYLE_BUCKETS = [
    ("scifi",  ['sci-fi', 'sci fi', 'spaceship', 'space station', 'alien ship', 'future']),
    ("win95",  ['win95', 'windows 95', 'windows', 'win 95', 'brick', '95', 'retro brick']),
    ("forest", ['forest', 'nature', 'jungle', 'woods', 'woodland', 'trees', 'tree', 'garden', 'swamp']),
    ("taco",   ['taco', 'tacos', 'burrito', 'mexican', 'nacho', 'fajita']),
    ("cyber",  ['cyber', 'neon', 'cyberpunk', 'matrix', 'circuits', 'tech']),
    ("stone",  ['moss', 'stone', 'castle', 'dungeon', 'ancient', 'cave', 'rock']),
    ("candy",  ['candy', 'gingerbread', 'sweet', 'peppermint', 'cake', 'chocolate', 'cookie']),
    ("cat",    ['cat', 'cats', 'kitten', 'kittens', 'feline', 'dog', 'dogs', 'puppy', 'animal']),
]

# These two sit between 'taco' and 'cyber' in the original chain and match on word boundaries
# rather than substrings, so they are kept separate rather than folded into the table above.
_STYLE_LADIES = ['ladies', 'lady', 'women', 'woman', 'girls', 'girl']
_STYLE_PEOPLE = ['people', 'person', 'crowd', 'characters', 'men', 'man', 'guys']

# Pop-culture / aesthetic words the set-designer LLM keeps drawing as something plausible but
# wrong - measured 2026-09-10 on rendered surfaces: "acid" came back as toxic-waste concrete,
# "mario mushrooms" as a cluster of real forest fungus, "glitch" as a near-blank purple wall,
# "LSD" as heavy-metal skull art plus a generic dungeon, "LSD dream emulator" as a generic
# psychedelic screensaver with none of the game's Japanese-PS1 character. Same escape hatch as
# the buckets above: when a typed word has a picture everyone already agrees on and the model
# keeps missing it, answer it in code. Checked BEFORE the substring tables so the exact phrase
# wins - "lsd dream emulator" must reach its own treatment, not the bare "lsd" one - and every
# key here is specific enough not to collide with the fuzzy tables below.
_STYLE_BUCKETS_NAMED = [
    ("lsddream", ['lsd dream emulator', 'lsd dream', 'dream emulator', 'lsd:de', 'lsddem']),
    ("acid",     ['acid']),
    ("glitch",   ['glitch', 'glitched', 'datamosh', 'databend', 'databent']),
    # 'mushroom' too: the shipped "mushrooms" preset pairs the theme with player=Mario,
    # enemy=Bowser (game.js PRESET_IDEAS / index.html), so a bare "mushrooms" here means the
    # Super Mushroom power-up, not forest fungus. Checked ahead of the 'forest' bucket, so
    # "mushroom forest" lands here - an acceptable over-match, same class as 'cat' firing on
    # "cathedral".
    ("mario",    ['mario', 'mushroom', 'mushrooms']),
    ("lsd",      ['lsd']),        # after lsddream, so the game keeps its own look
]


def _style_bucket(wall_style):
    """Which hand-tuned theme bucket `wall_style` resolves to, or None for the generic path."""
    ui = (wall_style or "").lower()
    for name, keys in _STYLE_BUCKETS_NAMED:        # lsddream, acid, glitch, mario, lsd
        if any(k in ui for k in keys):
            return name
    for name, keys in _STYLE_BUCKETS[:4]:          # scifi, win95, forest, taco
        if any(k in ui for k in keys):
            return name
    if any(match_word(w, ui) for w in _STYLE_LADIES):
        return "ladies"
    if any(match_word(w, ui) for w in _STYLE_PEOPLE):
        return "people"
    for name, keys in _STYLE_BUCKETS[4:]:          # cyber, stone, candy, cat
        if any(k in ui for k in keys):
            return name
    return None


def _theme_bucket(wall_style, wall_named=None):
    """The bucket BOTH get_surface_prompts and get_gate_prompts dispatch on - see _style_bucket
    for the keyword table itself. The one extra rule: a quoted proper name ALWAYS takes the
    generic designed path, never a hand-tuned bucket, because the buckets are bare substring
    matches and proper names are exactly the strings that trip them - "rockefeller center"
    hits 'rock', "st patricks cathedral" hits 'cat', "route 95" hits '95'. A matched bucket
    ignores the brief entirely (see get_surface_prompts/get_gate_prompts), so without this the
    named place would not just render oddly - it would vanish.

    `wall_named` is the wall field's resolve_named_styles() entity, or None. It is truthy
    whenever the wall field had ANY quoted span - even one the identity call could not resolve
    a kind for - because at that point _style_bucket would be matching quote-stripped fallback
    text that was never meant to describe a theme in the first place; the generic path (which
    falls back to the raw words when there is no brief) is the right home for it either way.
    Unquoted input leaves `wall_named` as None, so this is byte-identical to _style_bucket
    alone for every string typed before this existed."""
    return None if wall_named else _style_bucket(wall_style)


def get_surface_prompts(wall_style, brief=None, wall_named=None):
    """(wall_p, ceil_p, floor_p, lantern_p) for the dungeon's four environment surfaces.

    `brief` is a generate_theme_brief() dict (or None). It is consulted ONLY on the generic
    branch - a matched bucket's prompts are hand-tuned literals and ignore it entirely, so a
    theme that renders well today cannot regress.

    `wall_named` is the wall field's resolve_named_styles() entity (or None) - it only affects
    which bucket _theme_bucket resolves to. The generic branch's own text is unchanged: a named
    place's landmark framing already lives in the brief (see _theme_brief_surfaces), which this
    function reads back out through `brief` exactly like any other designed theme."""
    ui = wall_style.lower()
    bucket = _theme_bucket(wall_style, wall_named)

    if bucket == "scifi":
        wall_p = "A flat 2D game texture map of a dark sci-fi spaceship hull wall with glowing cyan neon panel lines, flat orthographic front view, zero perspective, purely flat material."
        ceil_p = "A flat 2D game texture map of a dark sci-fi spaceship ceiling with glowing blue and white light panels, directly overhead 90 degree view."
        floor_p = "A flat 2D game texture map of dark metal spaceship deck floor grating with glowing cyan lights, directly 90 degree bird's-eye top-down view, flat terrain texture."
        lantern_p = f"A dark angular metal wall plate with a brilliant glowing cyan energy core set into its centre, blazing cyan light pouring out of the core, sci-fi hardware. {_LANTERN_TAIL}"

    elif bucket == "win95":
        wall_p = "Authentic Windows 95 3D maze screensaver wall texture, bold chunky crimson red bricks with thick stark white mortar lines, flat straight-on orthographic view, seamless repeating 2D pattern, retro 90s low-poly CGI, bright uniform lighting, zero shadows, no borders."
        ceil_p = "Authentic Windows 95 acoustic drop ceiling tile texture, bright white and speckled grey mineral fiber surface with clean metal grid seams, flat straight-on view, seamless repeating 2D pattern, retro 90s computer graphics."
        floor_p = "Authentic Windows 95 parquet wood floor texture, seamless repeating golden honey oak wood tiles with subtle woodgrain, directly 90 degree top-down view, uniform flat lighting, zero shadows, zero perspective, perfectly repeating 2D floor pattern."
        # Keeps its procedural logo-lantern gag instead (see buildLanternWallFromBase in
        # game.js) - that joke doesn't survive being re-prompted through an image model.
        lantern_p = None

    elif bucket == "forest":
        wall_p = "A flat 2D game texture map of rough mossy tree bark and vertical redwood trunk surface, close-up flat orthographic front view, retro 90s video game wall texture, zero horizon, zero sky, zero perspective, pure flat vertical material."
        ceil_p = "A flat 2D game texture map of dense fine-grained green leafy foliage and pine canopy, directly 90 degree overhead view looking straight up, seamless tileable canopy, zero trunks."
        floor_p = "A flat 2D game texture map of dense fine-grained mossy ground cover, uniform rich dark earth covered evenly with seamless small green moss patches and tiny pine needles, fine-grained isotropic texture, directly 90 degree bird's-eye top-down view, uniform repeating ground surface, zero large focal objects, zero trees, zero sky, zero horizon, zero perspective, flat albedo terrain map."
        lantern_p = f"A bundle of wooden sticks bound with twine and wrapped in green moss and vines, a bright orange flame burning fiercely at the top, warm firelight. {_LANTERN_TAIL}"

    elif bucket == "taco":
        wall_p = "A flat 2D wallpaper texture of crispy golden corn taco shells filled with seasoned meat, diced tomatoes, lettuce, and shredded cheese, colorful repeating 90s video game graphic pattern, flat 2D orthographic view, no room, no borders."
        ceil_p = "A flat 2D acoustic drop ceiling texture with warm golden corn tortilla grid panels, directly overhead 90 degree top-down view."
        floor_p = "A flat 2D game texture map of toasted warm corn meal and golden crushed tortilla chip crumbs ground terrain, directly 90 degree bird's-eye top-down view, uniform flat ground material, zero large objects, pure flat terrain."
        lantern_p = f"One crispy golden corn taco shell standing upright and empty, brilliant warm golden light blazing out from inside the shell, the shell edges lit translucent glowing orange, radiant light spilling from its opening. Just the single taco shell, no filling, no meat, no toppings. {_LANTERN_TAIL}"

    elif bucket == "ladies":
        wall_p = "A flat 2D pop-art wallpaper texture filled with dense repeating colorful comic book character portraits and faces of women, colorful 90s video game graphic collage, flat 2D repeating pattern, bright saturated colors, no text, no magazines, no room, no borders, clean repeating wallpaper."
        ceil_p = "A flat 2D drop ceiling tile texture with purple and gold geometric grid lines, directly overhead 90 degree top-down view, clean repeating square tiles."
        floor_p = "A flat 2D game texture map of magenta and purple checkered velvet carpet floor tiles with gold diamond geometric pattern, directly 90 degree bird's-eye top-down view, clean flat floor material, zero people on floor, zero standing figures, zero horizon, pure flat floor texture."
        lantern_p = f"An ornate art deco wall sconce of purple enamel and polished gold, a bright flame burning above it, warm light glowing across the gold. {_LANTERN_TAIL}"

    elif bucket == "people":
        wall_p = "Retro 90s video game wallpaper texture filled with a dense crowd of colorful illustrated comic book character portraits and faces, vibrant pop-art character collage, flat 2D repeating pattern, bright saturated colors, no text, no room, no borders."
        ceil_p = "Retro 90s gaming acoustic drop ceiling tile texture with blue and white grid panels, flat overhead view."
        floor_p = "Retro 90s video game floor texture, rich navy blue and cobalt checkered carpet floor tiles with gold seams, directly 90 degree top-down view, clean flat floor material, zero people on floor."
        lantern_p = f"A wall sconce of navy blue metal with gold trim, a bright flame burning above it, warm light glowing across the metal. {_LANTERN_TAIL}"

    elif bucket == "cyber":
        wall_p = "A flat 2D texture map of dark metal cyber panels with glowing cyan and electric purple neon circuit conduits, flat orthographic front view, zero perspective."
        ceil_p = "A flat 2D texture map of dark steel ceiling plates with illuminated cyan neon grates, directly overhead 90 degree view."
        floor_p = "A flat 2D texture map of dark hexagonal metal floor tiles with pulsing cyan neon seams, directly 90 degree bird's-eye top-down view, zero horizon, zero perspective, pure flat floor material."
        lantern_p = f"A curved glass neon tube blazing electric cyan and magenta, mounted on a small dark metal bracket, vivid neon glow. {_LANTERN_TAIL}"

    elif bucket == "stone":
        wall_p = "A flat 2D texture map of weathered grey dungeon castle stone blocks with green moss in mortar cracks, flat orthographic front view, zero perspective."
        ceil_p = "A flat 2D texture map of ancient dark stone ceiling slabs with green moss patches, directly overhead 90 degree view."
        floor_p = "A flat 2D texture map of weathered grey cobblestone flagstones with dirt seams, directly 90 degree bird's-eye top-down view, zero walls, zero sky, zero horizon, pure flat ground texture."
        lantern_p = f"A wrought iron bracket clutching a jagged amber crystal shard that blazes with warm golden light, magical radiance pouring from the crystal. {_LANTERN_TAIL}"

    elif bucket == "candy":
        wall_p = "A flat 2D wallpaper texture of red and white peppermint candy cane stripes and gingerbread cookie pattern with white icing, bold saturated colors, flat straight-on view, zero perspective."
        ceil_p = "A flat 2D texture of pastel pink cotton candy and marshmallow clouds with rainbow sprinkles, directly overhead 90 degree view."
        floor_p = "A flat 2D texture map of dark chocolate cookie crumb ground tiles with caramel glaze seams, directly 90 degree bird's-eye top-down view, zero horizon, pure flat ground material."
        lantern_p = f"One red and white striped candy cane, brilliant warm light blazing out from inside it, the sugar lit translucent and glowing, radiant candy. {_LANTERN_TAIL}"

    elif bucket == "cat":
        wall_p = f"Retro 90s video game wallpaper texture filled with a dense crowd of colorful illustrated cute {wall_style} faces, vibrant colorful pop-art pattern, flat 2D repeating wallpaper, no text, no room, no borders."
        ceil_p = f"Retro 90s acoustic ceiling tiles with subtle cream and white paw print motifs, directly overhead 90 degree view."
        floor_p = f"Retro 90s warm honey oak wood parquet floor tiles with subtle cute paw prints, directly 90 degree bird's-eye top-down view, uniform flat lighting, zero 3D figures on floor."
        lantern_p = f"A cute rounded cat paw print emblem blazing with warm golden light, the whole paw shape lit up and radiantly glowing. {_LANTERN_TAIL}"

    elif bucket == "lsddream":
        # "LSD dream emulator" - the 1998 PS1 game. Its look is a collage of clashing tiled
        # photo-textures (Japanese woodblock faces, eyes, kanji, torii, tatami) on blocky
        # low-poly geometry with garish shifting colour. The player asked for game textures
        # too; there is no way to pull them off the disc, so the aesthetic is described instead.
        wall_p = ("A flat 2D repeating wall texture in the style of the PlayStation 1 game LSD Dream Emulator: "
                  "a tight grid of clashing low-resolution square tiles - Japanese woodblock-print faces, wide "
                  "staring eyes, red torii gates, black kanji characters, floral kimono fabric and woven tatami - "
                  "jammed edge to edge in violently clashing magenta, orange, turquoise and acid green, blocky and "
                  "slightly warped like an early 32-bit console texture, flat orthographic front view, seamless "
                  "repeating 2D pattern, zero perspective, zero horizon.")
        ceil_p = ("A flat 2D repeating ceiling texture in PlayStation 1 LSD Dream Emulator style: a banded dithered "
                  "gradient dream-sky of purple, pink and orange scattered with flat cartoon clouds, a pale round "
                  "moon and floating disembodied eyes, low-resolution and pixelated, camera pointing straight up at "
                  "90 degrees, seamless repeating 2D pattern, zero perspective.")
        floor_p = ("A flat 2D repeating floor texture in PlayStation 1 LSD Dream Emulator style: warped woven tatami "
                   "matting and Japanese woodblock patterns broken up by squares of coloured static, single staring "
                   "eyes and black kanji, clashing pink, green and blue, low-resolution 32-bit console texture, "
                   "camera pointing straight down at 90 degrees, seamless repeating 2D pattern, zero large objects.")
        lantern_p = (f"A round red Japanese paper chochin lantern painted with one big staring eye and black kanji, "
                     f"its paper shell glowing from within with shifting rainbow light, blocky low-poly PlayStation 1 "
                     f"style. {_LANTERN_TAIL}")

    elif bucket == "lsd":
        # "LSD" alone = trippy surreal. Swirl / spiral / paisley / mandala family (the drip
        # family belongs to "acid" below), bold blacklight-poster colour.
        wall_p = ("A flat 2D vertical wall texture of a swirling psychedelic tie-dye mural - liquid spirals and "
                  "fractal paisley in vivid clashing magenta, orange, lime green, cyan and violet, melting and "
                  "flowing together, bold high-contrast 1960s blacklight-poster colours, flat orthographic front "
                  "view, seamless tileable wall material, zero perspective, zero horizon, zero sky.")
        ceil_p = ("A flat 2D ceiling texture of a kaleidoscopic psychedelic mandala, radiating fractal spirals of "
                  "magenta, gold, turquoise and purple, bold saturated colour, camera pointing straight up at 90 "
                  "degrees, seamless repeating 2D pattern, zero perspective.")
        floor_p = ("A flat 2D floor texture of swirling marbled psychedelic colour, paisley and liquid spirals in "
                   "saturated magenta, green, blue and orange flowing edge to edge, camera pointing straight down at "
                   "90 degrees, seamless flat floor material, zero objects, zero horizon.")
        lantern_p = (f"A glass orb swirling with liquid rainbow colour, glowing brilliantly from within, casting "
                     f"shifting psychedelic light across its surface. {_LANTERN_TAIL}")

    elif bucket == "acid":
        # "acid" = trippy surreal COLORDRIP (the player's word). The LLM reads it as the
        # corrosive chemical - concrete, rust, toxic runoff - every time; this is molten paint
        # running and pooling instead. Drip / melt / pour family, distinct from "lsd"'s swirls.
        wall_p = ("A flat 2D vertical wall texture of thick glossy psychedelic paint dripping and running downward "
                  "in molten rainbow rivulets - magenta, orange, electric green, cyan and violet - marbled and "
                  "swirled together as they melt, wet and saturated, bold high-contrast acid colours, flat "
                  "orthographic front view, seamless tileable wall material, zero perspective, zero horizon.")
        ceil_p = ("A flat 2D ceiling texture of swirled molten rainbow paint pooling and dripping downward, glossy "
                  "wet magenta, orange, green and violet marbled together, camera pointing straight up at 90 "
                  "degrees, seamless repeating 2D pattern, zero perspective.")
        floor_p = ("A flat 2D floor texture of poured psychedelic paint, glossy swirled pools of molten rainbow "
                   "colour - magenta, cyan, lime and violet - blended edge to edge, camera pointing straight down at "
                   "90 degrees, seamless flat floor material, zero objects, zero horizon.")
        lantern_p = (f"A clear glass orb full of swirling molten rainbow liquid, glowing brilliantly from within, "
                     f"wet colour dripping down its outside surface. {_LANTERN_TAIL}")

    elif bucket == "glitch":
        # "glitch" = glitched effects / glitched photos. Datamosh, pixel-sort, RGB channel
        # split, torn scanlines, corrupted JPEG blocks. The generic path drew a near-blank
        # purple wall (luma std 16.5, barely above the blank-wall floor).
        wall_p = ("A flat 2D vertical wall texture of a heavily glitched digital photo - horizontal datamosh "
                  "smearing, torn and repeated scanlines, split red and cyan RGB colour channels, blocky corrupted "
                  "JPEG squares and pixel-sorted vertical streaks over bands of magenta and green digital noise, "
                  "flat orthographic front view, seamless tileable wall material, zero perspective, zero horizon.")
        ceil_p = ("A flat 2D ceiling texture of a corrupted video frame - shifted RGB channels, torn scanlines and "
                  "blocky compression artefacts in cyan, magenta and green, camera pointing straight up at 90 "
                  "degrees, seamless repeating 2D pattern, zero perspective.")
        floor_p = ("A flat 2D floor texture of a databent image - horizontal pixel-sort streaks, displaced blocks "
                   "and split colour channels in magenta, cyan and lime over dark digital noise, camera pointing "
                   "straight down at 90 degrees, seamless flat floor material, zero objects.")
        lantern_p = (f"An old CRT computer monitor switched on and filling with a violently glitched, datamoshed "
                     f"image, the screen bleeding coloured static and torn scanlines and casting flickering "
                     f"red-and-cyan light. {_LANTERN_TAIL}")

    elif bucket == "mario":
        # "mario mushrooms" = the Super Mushroom power-up from Super Mario World / Super Mario
        # Bros. 3: bright red domed cap, big white circular spots, stubby cream stalk. The
        # generic path draws real forest fungus. Wallpaper-of-the-icon shape, like the cat bucket.
        wall_p = ("Retro 16-bit Super Nintendo video game wallpaper texture, a dense repeating grid of bright red "
                  "domed mushroom power-ups with big white circular spots and stubby cream stalks with simple "
                  "cartoon eyes, Super Mario World sprite art, bold flat saturated colours, thick black outlines, "
                  "crisp pixel edges, flat 2D repeating pattern, no text, no room, no borders.")
        ceil_p = ("Retro 16-bit Super Mario World ceiling texture, a seamless repeating row of hard-edged orange "
                  "dirt blocks and glowing yellow question-mark blocks with a bolt in each corner, bold flat "
                  "saturated colours, thick black outlines, camera pointing straight up at 90 degrees, seamless "
                  "repeating 2D pattern.")
        floor_p = ("Retro 16-bit Super Mario World ground texture, a seamless repeating band of hard-edged "
                   "orange-brown earth blocks topped with a bright green grassy crust, bold flat saturated colours, "
                   "thick black outlines, camera pointing straight down at 90 degrees, seamless repeating 2D "
                   "pattern, zero objects.")
        lantern_p = (f"One bright red Super Mario mushroom power-up with big white circular spots and a stubby cream "
                     f"stalk with two simple cartoon eyes, glowing brilliantly from within with warm golden light, "
                     f"radiant, bold 16-bit video game sprite art with thick black outlines. {_LANTERN_TAIL}")

    else:
        # THE ABSTRACT-THEME PATH. Everything below interpolates the typed words, so when those
        # words name no material - "internet", "trippy", "memes" - the surrounding framing
        # clauses are the only concrete thing in the prompt and FLUX schnell draws them on
        # their own: flat, featureless, blank walls. That is the exact bug this branch's
        # `brief` fixes. generate_theme_brief turns the typed theme into real material
        # descriptions first; `_b(slot, default)` picks the designed line when there is one and
        # otherwise falls back to the raw-word wording this branch has always used, so every
        # failure path lands on the old behaviour.
        def _b(slot, default):
            got = (brief or {}).get(slot)
            return got if got else default

        # No era clamp on the generic path: the named presets above are deliberately retro because
        # the player asked for "Windows 95", but an arbitrary typed style should render however
        # that style actually looks. The flat orthographic framing stays - that is a tiling
        # requirement for a wall texture, not an art direction.
        wall_p = f"A flat 2D vertical wall surface texture of {_b('wall', wall_style)}, close-up flat orthographic front view, seamless tileable wall material, zero horizon, zero sky, zero landscape, pure flat vertical wall material."
        # "sky canopy" used to be an option here, which is why arbitrary indoor styles kept coming
        # back as outdoor scenes. An arbitrary style is a PLACE, and the ceiling of a place is a
        # built surface - name the material, and forbid the single hanging light fixture the model
        # otherwise centres in frame (a chandelier is a focal object, and one texture now covers one
        # whole map cell, so a focal object repeats visibly in every square).
        ceil_p = f"A flat 2D seamless tileable ceiling material texture, the ceiling surface of {_b('ceiling', wall_style)}, uniform repeating overhead material such as panelling, plaster, beams or tiles, evenly spread across the whole frame, camera pointing straight up at 90 degrees, orthographic, zero perspective, zero vanishing point, zero walls, zero sky, zero horizon, zero chandelier, zero hanging lamp, zero light fixture, zero single focal object, zero empty blank areas, edge to edge material."
        # "ground terrain" was doing the same damage on the floor: it reads as outdoors, so an
        # interior style came back as dirt and undergrowth. Ask for a FLOOR - a built, walked-on
        # surface - and let the style decide whether that is boards, flagstone or carpet.
        floor_p = f"A flat 2D seamless tileable floor material texture, the floor surface of {_b('floor', wall_style)}, uniform repeating walked-on material such as floorboards, flagstones, tiles or carpet, fine even grain across the whole frame, camera pointing straight down at 90 degrees, orthographic, zero perspective, zero vanishing point, zero walls, zero sky, zero horizon, zero grass, zero soil, zero outdoor landscape, zero furniture, zero people, zero large focal objects, edge to edge material."
        # No keyword bucket to fall back on, so this has to work for anything typed in. The
        # theme is the SUBJECT and light is only something it emits - naming any fixture
        # ("lamp", "lantern", "light source") hands the model a shape prior strong enough to
        # override the theme entirely, which is how this path used to return plain light bulbs.
        # A designed LANTERN line is already a concrete object, so it becomes the subject
        # directly; without one, fall back to "an object made of {wall_style}" as before.
        lantern_subject = _b("lantern", f"A single object made of {wall_style}")
        lantern_p = (f"{lantern_subject}, blazing with brilliant warm golden "
                    f"light from within, lit up and radiantly glowing, the light spilling out "
                    f"across its surface. {_LANTERN_TAIL}")

    return wall_p, ceil_p, floor_p, lantern_p


# Isolation tail for the switch cutout - same job as _LANTERN_TAIL: one object on a clean
# white ground so BiRefNet has a real background to cut. The door is a full-cell OPAQUE
# surface (no cutout) so it does not use this.
_GATE_TAIL = ("Exactly one object, centered, front view, isolated on a plain flat pure white "
              "background, no scene, no floor, no walls, no room, no shadow, no text.")


def _door_sign(wall_named):
    """The trailing clause every generic door prompt ends its sentence on: the plain "no text"
    that has always been there, or - for a named place - a sign bearing its name instead.

    Mutually exclusive, not additive: at cfg 1.0 the negative is inert, so "no text" is itself
    POSITIVE conditioning for text (see _theme_rules' rule 7 and _LANTERN_TAIL's comment on the
    same trap) - it has to come OUT when the sign clause goes in, not sit next to it.

    Names are never painted anywhere else in this file (the brief is explicitly told not to -
    see _theme_brief_surfaces), so this is the one place a typed name reaches the art at all,
    and only when it resolved to a real kind of thing worth a sign over a doorway."""
    if wall_named and wall_named.get("kind") and wall_named.get("name"):
        return (f'a sign above the doorway reading "{wall_named["name"].upper()}" in short '
                f'bold white block capitals with a heavy black outline')
    return "no text"


def get_gate_prompts(wall_style, brief=None, wall_named=None):
    """(door_p, switch_p) themed to the dungeon style. Kept separate from get_surface_prompts
    so that function's 4-tuple signature and call sites stay untouched.

    `brief` is a generate_theme_brief() dict (or None), consulted ONLY on the generic branch -
    same contract as get_surface_prompts. `wall_named` is that same function's named-entity
    param, passed straight through to _theme_bucket and to _door_sign.

    FLUX schnell at cfg 1.0 - the negative is inert, so these are POSITIVE-ONLY. Name the
    object literally, force flat orthographic framing, isolate on white (see _LANTERN_TAIL
    notes above for why naming unwanted things backfires).

    Both the door and the switch are SINGLE-STATE art. The door is only ever generated closed
    (buildOpenDoorTexture derives the open gate from the closed door's own pixels), and the
    switch is only ever generated at rest - buildSwitchWallTextures derives the thrown state
    by inverting this one cutout's colours. Two earlier attempts at generating the ON pose are
    worth not repeating: two independent txt2img renders of "the same plate, handle thrown"
    came back as two visibly different fixtures (FLUX redraws the plate, screws, bevel and
    palette every time), and img2img over the OFF render fixed that but at any denoise low
    enough to preserve the fixture the handle barely moved. A generated pose is either not the
    same switch or not a different pose; a colour inversion is unmistakably both.

    Buckets mirror get_surface_prompts' (same keywords, same relative order, so an ambiguous
    style resolves to the same theme on both sides) - every style get_surface_prompts special-
    cases gets a matching door/switch here now; a
    style whose wall got the taco or forest treatment but fell through to the generic gate
    branch is exactly how a door ends up looking unrelated to the corridor it's set in. Both
    functions now dispatch on the shared _style_bucket(), so that drift is no longer possible
    at all - this branch order just has to mirror get_surface_prompts', which it does."""
    ui = wall_style.lower()
    bucket = _theme_bucket(wall_style, wall_named)

    # Every branch below follows three rules:
    #   1. The archway/frame is described with the SAME material words as get_surface_prompts'
    #      wall_p for that bucket, so the door sits in a frame that visibly belongs to the
    #      corridor instead of reading as a different building dropped into it.
    #   2. The door LEAF is a DIFFERENT but thematically related object, not a copy of the wall
    #      material or a vague "made of {style}" (a real brick wall frames a wooden door, not a
    #      brick door; "made of candy cane" literally asked FLUX for a door built from a thin
    #      curved candy stick, which is why one bucket needs a concrete, door-shaped noun -
    #      "gingerbread door" - rather than the wall's own pattern name).
    #   3. The switch is a DIFFERENT concrete object than that bucket's lantern_p in
    #      get_surface_prompts, but from the same object family/material - a taco lantern gets a
    #      nacho switch, not another taco (that just repeats the one landmark object twice) and
    #      not a bare "themed as X" lever (too abstract for FLUX schnell to draw well - see the
    #      generic branch's own note below for what that failure mode looks like).
    # Every door_p also explicitly forbids empty/black background: this is a full-frame OPAQUE
    # image (no BiRefNet cutout, unlike the switch/lantern), so whatever the model doesn't draw
    # as door or archway shows up as literal black margins on the wall in-game - "fills the
    # frame edge to edge" alone wasn't reliable enough at cfg 1.0 to prevent that.
    NO_MARGINS = "the door and its archway completely fill the frame edge to edge with zero empty background and zero black margins"

    # The one deliberate difference from get_surface_prompts' chain: sci-fi and cyber share a
    # single door/switch treatment there, where they have separate wall treatments.
    if bucket in ("scifi", "cyber"):
        door_p = (f"A sealed dark sci-fi blast door - a heavy round airlock hatch with a glowing "
                  f"cyan viewport ring and warning stripes - set into a surrounding wall of the "
                  f"same dark riveted brushed-metal panels with glowing cyan seams as the "
                  f"corridor, fully closed, flat straight-on orthographic front view, "
                  f"{NO_MARGINS}, zero perspective, zero horizon, zero sky.")
        # Lantern (get_surface_prompts) is a glowing energy-core wall plate - the switch is a
        # separate recessed toggle on its own panel, not another core, so the two fixtures
        # don't read as the same object twice down the corridor.
        switch_p = ("A dark angular metal wall panel with one large recessed toggle lever "
                         "switch, sci-fi hardware, unpowered and unlit, the handle in its "
                         "resting position. " + _GATE_TAIL)

    elif bucket == "win95":
        door_p = (f"Authentic Windows 95 3D maze screensaver style, a heavy closed door set into "
                  f"an archway built from the same bold chunky crimson red bricks and thick stark "
                  f"white mortar lines as the corridor wall, the door itself a dark iron-bound "
                  f"wood door slab with a big round iron ring handle, flat straight-on "
                  f"orthographic front view, {NO_MARGINS}, retro 90s low-poly CGI, bright "
                  f"uniform lighting, zero shadows, zero perspective.")
        switch_p = ("A chunky retro 1990s wall-mounted lever switch on a grey steel plate "
                         "bolted to a red brick wall, a big red handle resting in the down "
                         "position, Windows 95 low-poly CGI look, bright even lighting. " + _GATE_TAIL)

    elif bucket == "forest":
        door_p = (f"A rustic door built from thick bound branches and woven vines, set into a "
                  f"surrounding archway of the same rough mossy tree bark and redwood trunk "
                  f"surface as the corridor wall, flat straight-on orthographic front view, "
                  f"{NO_MARGINS}, zero horizon, zero sky, zero perspective.")
        # Lantern is a bound bundle of sticks used as a torch - the switch is a single forked
        # branch used as a lever, a related but distinctly different piece of the same forest.
        switch_p = ("A small forked wooden branch used as a lever handle, bound with a "
                         "strip of green vine, mounted on a flat slab of bark, the branch "
                         "resting down. " + _GATE_TAIL)

    elif bucket == "taco":
        door_p = (f"A closed door that is one giant folded cheese quesadilla, grill-marked and "
                  f"steaming, set into a surrounding archway of the same crispy golden corn "
                  f"taco shells filled with seasoned meat, tomatoes, lettuce and cheese as the "
                  f"corridor wall, flat straight-on orthographic front view, {NO_MARGINS}, "
                  f"bright saturated colors, zero shadows, zero perspective.")
        # Lantern is a single glowing taco shell - the switch is a nacho: same snack family,
        # a different landmark object, exactly the "related but not identical" pairing asked for.
        switch_p = ("A small wall-mounted lever switch styled as one big golden tortilla "
                         "chip nacho piled with melted cheese, resting down on a small plate. "
                         + _GATE_TAIL)

    elif bucket == "ladies":
        door_p = (f"A closed double door of purple enamel and polished gold with a bold art "
                  f"deco sunburst pattern, set into a surrounding frame styled with the same "
                  f"colorful pop-art collage pattern as the corridor wall, flat straight-on "
                  f"orthographic front view, {NO_MARGINS}, bright saturated colors, zero "
                  f"perspective.")
        # Lantern is a purple-and-gold art deco wall sconce - the switch reuses that palette on
        # a different art deco object (a folding fan) instead of a second sconce.
        switch_p = ("A small polished gold lever switch shaped like a folding hand fan, "
                         "mounted on a purple enamel plate, art deco style, the fan folded "
                         "down. " + _GATE_TAIL)

    elif bucket == "people":
        door_p = (f"A heavy closed double door of navy blue metal with polished gold trim and "
                  f"rivets, set into a surrounding frame styled with the same colorful pop-art "
                  f"character collage pattern as the corridor wall, flat straight-on "
                  f"orthographic front view, {NO_MARGINS}, bright saturated colors, zero "
                  f"perspective.")
        switch_p = ("A small polished gold lever switch on a navy blue enamel plate, "
                         "bright saturated colors, the handle resting down. " + _GATE_TAIL)

    elif bucket == "stone":
        door_p = (f"A massive closed dungeon door of weathered oak planks bound with rusted iron "
                  f"bands and studs, a heavy iron ring handle, set into a surrounding archway of "
                  f"the same grey mossy dungeon stone blocks as the corridor wall, flat "
                  f"straight-on orthographic front view, {NO_MARGINS}, zero perspective, zero "
                  f"horizon.")
        switch_p = ("A wrought iron wall lever on a rusted metal plate bolted to grey stone, "
                         "the handle resting down. " + _GATE_TAIL)

    elif bucket == "candy":
        door_p = (f"A closed door set into a surrounding archway of the same red and white "
                  f"peppermint candy cane stripes and gingerbread cookie pattern with white "
                  f"icing as the corridor wall, the door itself a gingerbread cookie house door "
                  f"with white icing piping trim and a round candy button for a handle, warm "
                  f"bakery colors, flat straight-on orthographic front view, {NO_MARGINS}, "
                  f"bright saturated colors, zero shadows, zero perspective.")
        # Lantern is a glowing candy cane - the switch used to be styled as a candy cane too
        # (the same landmark object as the lantern); a lollipop keeps the candy-shop family
        # without repeating the one thing the corridor is already lit by.
        switch_p = ("A small wall-mounted lever switch styled as a swirled peppermint "
                         "lollipop handle on a white iced gingerbread cookie plate, bright "
                         "bakery colors, the handle resting down. " + _GATE_TAIL)

    elif bucket == "cat":
        door_p = (f"A chunky wooden doghouse-style door with a rounded arched pet-door flap, "
                  f"set into a surrounding frame styled with the same colorful cute cartoon "
                  f"{wall_style} pattern as the corridor wall, flat straight-on orthographic "
                  f"front view, {NO_MARGINS}, bright saturated colors, zero perspective.")
        # Lantern is a glowing paw print - the switch is a bone: same cute-pet icon family,
        # a different specific charm.
        switch_p = ("A small wall-mounted lever switch shaped like a cute cartoon dog "
                         "bone, mounted on a small plate, bright saturated colors, resting "
                         "down. " + _GATE_TAIL)

    elif bucket == "lsddream":
        door_p = (f"A closed sliding Japanese shoji screen door, its paper panels painted with one giant "
                  f"staring eye and swirling clashing psychedelic colour, set into a surrounding archway of the "
                  f"same clashing tiled woodblock-face, eye and kanji textures as the corridor wall, blocky "
                  f"PlayStation 1 low-poly style, flat straight-on orthographic front view, {NO_MARGINS}, zero "
                  f"perspective, zero horizon.")
        # Lantern is a red paper chochin lantern - the switch is a daruma doll, a different
        # Japanese toy, one eye filled in.
        switch_p = ("A small hand-sized round red daruma doll with one eye painted in, used as a lever handle, "
                    "mounted on a paper-screen plate marked with black kanji, blocky low-poly PlayStation 1 "
                    "style, the handle resting down. " + _GATE_TAIL)

    elif bucket == "lsd":
        door_p = (f"A closed door painted with a bold swirling psychedelic tie-dye spiral in clashing magenta, "
                  f"orange and lime green, set into a surrounding archway swirled with the same paisley "
                  f"psychedelic mural as the corridor wall, flat straight-on orthographic front view, "
                  f"{NO_MARGINS}, bold saturated colours, zero perspective, zero horizon.")
        # Lantern is a glass orb of liquid colour - the switch is a swirled lollipop.
        switch_p = ("A small hand-sized lever handle shaped like a swirled rainbow lollipop on a stick, glossy "
                    "and saturated, mounted on a psychedelic paisley plate, the handle resting down. "
                    + _GATE_TAIL)

    elif bucket == "acid":
        door_p = (f"A closed door that is one thick slab of clear casting resin with molten rainbow colour "
                  f"swirled and frozen mid-drip inside it, glossy and saturated, set into a surrounding archway "
                  f"marbled with the same molten psychedelic paint as the corridor wall, flat straight-on "
                  f"orthographic front view, {NO_MARGINS}, wet saturated colours, zero perspective, zero horizon.")
        # Lantern is a glass orb of liquid rainbow - the switch is a melting popsicle.
        switch_p = ("A small hand-sized lever handle shaped like a melting rainbow popsicle on a stick, glossy "
                    "colour running and dripping off it, mounted on a marbled psychedelic plate, the handle "
                    "resting down. " + _GATE_TAIL)

    elif bucket == "glitch":
        door_p = (f"A closed door faced with one large cracked flat-screen monitor showing a frozen glitched, "
                  f"datamoshed image with split red and cyan colour channels and torn scanlines, set into a "
                  f"surrounding archway of the same corrupted JPEG-block and pixel-sorted noise texture as the "
                  f"corridor wall, flat straight-on orthographic front view, {NO_MARGINS}, zero perspective, "
                  f"zero horizon.")
        # Lantern is a glitching CRT monitor - the switch is a shattered smartphone.
        switch_p = ("A small hand-sized lever handle shaped like a shattered smartphone with a glitched, "
                    "colour-split screen, mounted on a plate of corrupted pixel noise, the handle resting "
                    "down. " + _GATE_TAIL)

    elif bucket == "mario":
        door_p = (f"A closed door shaped like one giant glowing yellow question-mark block from Super Mario "
                  f"World, hard-edged with thick black outlines and a bolt in each corner, set into a "
                  f"surrounding archway of the same repeating red-and-white mushroom power-up wallpaper as the "
                  f"corridor wall, flat straight-on orthographic front view, {NO_MARGINS}, bold saturated "
                  f"colours, thick black outlines, zero perspective.")
        # Lantern is a red mushroom power-up - the switch is a gold coin, a different Mario icon.
        switch_p = ("A small wall-mounted lever handle shaped like a shiny gold Super Mario coin stamped with a "
                    "star, on a red brick block plate, bold 16-bit video game art with thick black outlines, "
                    "the handle resting down. " + _GATE_TAIL)

    elif brief and brief.get("door") and brief.get("switch"):
        # A designed gate. Unlike the raw-word branch below, both lines are already concrete
        # objects, so they become the SUBJECT and only the framing is bolted on. The set
        # designer is told to make the door belong to the same world as the wall material and
        # to make the switch a different object family from the lantern, which is what the
        # hand-tuned buckets do by hand (see rules 1-3 in the docstring above).
        door_p = (f"{brief['door']}, fully closed, flat straight-on orthographic front view, "
                  f"{NO_MARGINS}, zero perspective, zero horizon, zero sky, no room around it, "
                  f"{_door_sign(wall_named)}.")
        switch_p = (f"{brief['switch']}, mounted on a small plate as a lever switch handle, "
                    f"the handle resting in its neutral position. " + _GATE_TAIL)

    else:
        # No preset bucket for this style AND no usable brief, so the archway is DESCRIBED as
        # {wall_style} (matching how get_surface_prompts' generic wall_p uses it) while the leaf
        # falls back to a plain iron-bound wood door - a concrete, universally sensible
        # "different but related" object instead of the literal "made of {wall_style}" this used
        # to say, which asked for the door to be built from whatever noun the player typed (a
        # candy-cane door, a taco door) rather than a door that merely belongs in a room styled
        # that way. This is the pre-set-designer behaviour, kept intact as the failure path.
        door_p = (f"A closed door set into a surrounding archway or frame styled as {wall_style}, "
                  f"matching the corridor wall, the door itself a heavy iron-bound wood door "
                  f"slab with a round iron ring handle, sturdy and firmly shut, flat "
                  f"straight-on orthographic front view, {NO_MARGINS}, zero perspective, zero "
                  f"horizon, zero sky, no room around it, {_door_sign(wall_named)}.")
        # No lantern_p text is available here to react to (the generic lantern prompt is built
        # independently, from the same {wall_style} words, and might resolve to anything) - the
        # best this branch can do is ask for a DIFFERENT kind of object than a light fixture,
        # rather than the bare "a mechanical handle themed as {wall_style}" this used to say,
        # which gave FLUX nothing concrete to draw and is the same failure mode "made of
        # {wall_style}" was for the door (see the comment above).
        switch_p = (f"A single small hand-sized object fitting the theme of {wall_style} - "
                         f"not a lamp, torch or light fixture - repurposed as a lever switch "
                         f"handle on a small mounting plate, the handle resting in its neutral "
                         f"position. " + _GATE_TAIL)

    return door_p, switch_p



def generate_flux_all_assets(wall_style, player_style=None, player_image_b64=None, mode="v4_flux",
                             progress_cb=None, weapon_style=None, enemy_style=None):
    """Generate Dungeon Textures (Wall, Ceil, Floor) + AI Face Portrait + Player Character Sprite in FLUX."""
    prefix_w = f"trio_w_{int(time.time()*1000)}"
    prefix_c = f"trio_c_{int(time.time()*1000)}"
    prefix_f = f"trio_f_{int(time.time()*1000)}"
    prefix_p = f"player_{int(time.time()*1000)}"
    prefix_face = f"face_{int(time.time()*1000)}"

    wall_p, ceil_p, floor_p, _lantern_p = get_surface_prompts(wall_style)

    # v4_flux with no attached reference photo uses the separate SDXL-Lightning + IPAdapter
    # pipeline (generate_player_sprite_ipadapter) for consistent multi-frame character sprites
    # instead of the single-image FLUX branch below.
    use_ipadapter_sprites = (mode == "v4_flux") and not (player_image_b64 and "," in player_image_b64)

    # Process Player Character Appearance & Face Portrait (Modular Rig Design)
    if player_image_b64 and "," in player_image_b64:
        portrait_prompt = (
            "Close-up front view video game status portrait of a valiant warrior hero, bald shaved head, stylish wireframe glasses, "
            "determined heroic warrior expression, wearing a yellow tunic shirt and dark leather armor straps, Doom and Valbrace game status portrait style, "
            "atmospheric dark dungeon background, highly detailed character portrait, 8k resolution, crisp lighting."
        )
        player_prompt = (
            "Photorealistic 3D game render of a realistic muscular warrior character seen directly from behind in a strict third-person back view, perfectly centered, spine totally straight, 0 degree angle, "
            "cinematic lighting, highly detailed realistic textures, bald shaved head with dark wireframe glasses visible from the side, "
            "wearing a realistic yellow cloth tunic and weathered leather armor harness, holding a glowing sword in the right hand and a sturdy shield in the left hand, ready for combat, dynamic action pose, "
            "8k resolution, Unreal Engine 5 aesthetic, photorealistic back view character body, pure solid white background."
        )
    elif mode == "v4_flux":
        p_style = player_style.strip() if (player_style and player_style.strip()) else "armored knight"
        portrait_prompt = f"Close-up front view video game portrait of a heroic {p_style} warrior, Doom status portrait style, atmospheric dungeon lighting."
        player_prompt = (
            f"2D game asset sprite sheet, 4 distinct widely spaced animation frames in a single horizontal row on a pure solid white background. "
            f"Character seen strictly directly from behind in third-person back view, 0 degree angle facing away from camera towards the front. "
            f"Frame 1: {p_style} warrior standing idle holding sword. "
            f"Frame 2: {p_style} warrior blocking with shield held forward facing away towards the front to block incoming attacks. "
            f"Frame 3: {p_style} warrior winding up sword high overhead. "
            f"Frame 4: {p_style} warrior executing an upward rising vertical sword slash arc. "
            f"Photorealistic 3D game render, highly detailed textures, Unreal Engine 5 aesthetic."
        )
    elif player_style and player_style.strip():
        ps = player_style.strip().lower()
        if 'cat' in ps:
            portrait_prompt = (
                "Close-up front view video game portrait of a fierce anthropomorphic cat warrior hero, orange feline fur, sharp cat ears and green eyes, "
                "wearing leather armor collar, Doom status portrait style, atmospheric dark dungeon background, 8k resolution."
            )
            player_prompt = (
                "Photorealistic 3D game render of an anthropomorphic humanoid cat warrior standing on two legs, seen directly from behind in a strict third-person back view, perfectly centered, spine totally straight, 0 degree angle, "
                "realistic feline fur texture, cat ears and tail, wearing weathered leather warrior armor, broad shoulders, holding a glowing sword in the right hand and a sturdy shield in the left hand, ready for combat, dynamic action pose, "
                "cinematic lighting, 8k resolution, Unreal Engine 5 aesthetic, pure solid white background."
            )
        else:
            portrait_prompt = (
                f"Close-up front view video game portrait of a valiant {player_style} warrior hero, heroic expression, "
                f"Doom and Valbrace status portrait style, atmospheric dark dungeon background, 8k resolution, crisp lighting."
            )
            player_prompt = (
                f"Photorealistic 3D game render of a realistic {player_style} warrior seen directly from behind in a strict third-person back view, perfectly centered, spine totally straight, 0 degree angle, cinematic lighting, highly detailed realistic textures, 8k resolution, Unreal Engine 5 aesthetic, pure solid white background."
            )
    else:
        portrait_prompt = (
            "Close-up front view video game portrait of an armored warrior knight hero, heroic determined expression, "
            "Doom and Valbrace status portrait style, atmospheric dark dungeon background, 8k resolution, crisp lighting."
        )
        player_prompt = (
            "Photorealistic 3D game render of a realistic armored warrior knight seen directly from behind in a strict third-person back view, perfectly centered, spine totally straight, 0 degree angle, "
            "cinematic lighting, highly detailed steel plate armor and weathered leather, broad shoulders, holding a glowing sword in the right hand and a sturdy shield in the left hand, ready for combat, dynamic action pose, 8k resolution, Unreal Engine 5 aesthetic, pure solid white background."
        )

    print(f"[FLUX Dungeon, Player & Portrait Prompts]\n Wall: {wall_p}\n Portrait: {portrait_prompt}\n Player: {player_prompt}")

    prompt_payload = {
        "1": {"inputs": {"ckpt_name": FLUX_SCHNELL_CKPT}, "class_type": "CheckpointLoaderSimple"},
        "neg": {"inputs": {"text": "cartoon, anime, 2d, low quality, pixelated, 16-bit, clipart, drawing, blurry, watermark", "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        
        # Wall
        "w_lat": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "w_pos": {"inputs": {"text": wall_p, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        "w_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["w_pos", 0], "negative": ["neg", 0], "latent_image": ["w_lat", 0]}, "class_type": "KSampler"},
        "w_dec": {"inputs": {"samples": ["w_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
        "w_save": {"inputs": {"filename_prefix": prefix_w, "images": ["w_dec", 0]}, "class_type": "SaveImage"},
        
        # Ceiling
        "c_lat": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "c_pos": {"inputs": {"text": ceil_p, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        "c_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["c_pos", 0], "negative": ["neg", 0], "latent_image": ["c_lat", 0]}, "class_type": "KSampler"},
        "c_dec": {"inputs": {"samples": ["c_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
        "c_save": {"inputs": {"filename_prefix": prefix_c, "images": ["c_dec", 0]}, "class_type": "SaveImage"},
        
        # Floor
        "f_lat": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "f_pos": {"inputs": {"text": floor_p, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        "f_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["f_pos", 0], "negative": ["neg", 0], "latent_image": ["f_lat", 0]}, "class_type": "KSampler"},
        "f_dec": {"inputs": {"samples": ["f_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
        "f_save": {"inputs": {"filename_prefix": prefix_f, "images": ["f_dec", 0]}, "class_type": "SaveImage"},

        # AI Face Portrait (Front View)
        "face_lat": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
        "face_pos": {"inputs": {"text": portrait_prompt, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
        "face_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["face_pos", 0], "negative": ["neg", 0], "latent_image": ["face_lat", 0]}, "class_type": "KSampler"},
        "face_dec": {"inputs": {"samples": ["face_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
        "face_save": {"inputs": {"filename_prefix": prefix_face, "images": ["face_dec", 0]}, "class_type": "SaveImage"}
    }

    if not use_ipadapter_sprites:
        # Single-image player branch (used only when a reference photo is attached, or for
        # non-v4_flux modes). The v4_flux/no-photo case generates its sprite separately below.
        prompt_payload["p_lat"] = {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"}
        prompt_payload["p_pos"] = {"inputs": {"text": player_prompt, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"}
        prompt_payload["p_samp"] = {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["p_pos", 0], "negative": ["neg", 0], "latent_image": ["p_lat", 0]}, "class_type": "KSampler"}
        prompt_payload["p_dec"] = {"inputs": {"samples": ["p_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"}
        prompt_payload["p_save"] = {"inputs": {"filename_prefix": prefix_p, "images": ["p_dec", 0]}, "class_type": "SaveImage"}

    data = json.dumps({"prompt": prompt_payload, "client_id": COMFY_CLIENT_ID}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        res_json = json.loads(resp.read().decode("utf-8"))
        prompt_id = _track_prompt(res_json["prompt_id"])

    start_time = time.time()
    while time.time() - start_time < 90:
        time.sleep(0.1)
        _bail_if_cancelled()
        hist_req = urllib.request.Request(f"{COMFY_URL}/history/{prompt_id}")
        with urllib.request.urlopen(hist_req) as h_resp:
            hist_data = json.loads(h_resp.read().decode("utf-8"))
            if prompt_id in hist_data:
                outputs = hist_data[prompt_id].get("outputs", {})
                required_saves = ["w_save", "c_save", "f_save", "face_save"] + ([] if use_ipadapter_sprites else ["p_save"])
                if all(key in outputs for key in required_saves):
                    w_img = outputs["w_save"]["images"][0]["filename"]
                    c_img = outputs["c_save"]["images"][0]["filename"]
                    f_img = outputs["f_save"]["images"][0]["filename"]
                    face_img = outputs["face_save"]["images"][0]["filename"]

                    w_sub = outputs["w_save"]["images"][0].get("subfolder", "")
                    c_sub = outputs["c_save"]["images"][0].get("subfolder", "")
                    f_sub = outputs["f_save"]["images"][0].get("subfolder", "")
                    face_sub = outputs["face_save"]["images"][0].get("subfolder", "")

                    w_path = os.path.join(COMFY_OUTPUT_DIR, w_sub, w_img)
                    c_path = os.path.join(COMFY_OUTPUT_DIR, c_sub, c_img)
                    f_path = os.path.join(COMFY_OUTPUT_DIR, f_sub, f_img)
                    face_path = os.path.join(COMFY_OUTPUT_DIR, face_sub, face_img)

                    make_seamless_4way(w_path, blend_pixels=12)
                    make_seamless_4way(c_path, blend_pixels=12)
                    make_seamless_4way(f_path, blend_pixels=12)
                    if use_ipadapter_sprites:
                        if progress_cb:
                            progress_cb("Rigging Character Animation Frames (SDXL-Lightning + IPAdapter)...", 60)
                        # Prefer the sprite pipeline's own portrait - it shares the character's
                        # IPAdapter reference, so it actually looks like the player, unlike the
                        # FLUX portrait generated independently up in the texture batch.
                        p_frames, portrait_paths = generate_player_sprite_ipadapter(player_style, weapon_style)

                        # The enemy is optional: a failure here must not cost the player everything
                        # else that already generated successfully, so the game just falls back to
                        # its built-in procedural enemy.
                        enemy_frames = []
                        try:
                            if progress_cb:
                                progress_cb("Summoning the Enemy (SDXL-Lightning + IPAdapter)...", 78)
                            enemy_frames = generate_enemy_sprites(enemy_style)
                        except Exception as e:
                            print(f"[Enemy Sprite Error] {e}")

                        return (w_path, c_path, f_path, p_frames,
                                ([p for p in portrait_paths if p] or [face_path]), enemy_frames)
                    else:
                        p_img = outputs["p_save"]["images"][0]["filename"]
                        p_sub = outputs["p_save"]["images"][0].get("subfolder", "")
                        p_path = os.path.join(COMFY_OUTPUT_DIR, p_sub, p_img)
                        make_sprite_transparent(p_path)
                        return w_path, c_path, f_path, p_path, [face_path], []

    raise TimeoutError("FLUX.1 Dungeon, Player & Portrait generation timed out.")


def run_batch_v3_flux(wall_style, player_style=None, player_image=None, mode="v4_flux",
                      weapon_style=None, enemy_style=None):
    """v3 FLUX.1 [schnell] mode: Generates 3 Dungeon Surfaces + 1 Player Character Sprite + 1 AI Face Portrait."""
    global gen_progress
    gen_progress["is_generating"] = True
    gen_progress["completed_bundle"] = None
    gen_progress["error"] = None
    gen_progress["current_step"] = 0
    gen_progress["total_steps"] = 2

    def _progress(msg, percent):
        gen_progress["status_message"] = msg
        gen_progress["percent"] = percent

    try:
        gen_progress["current_step"] = 1
        gen_progress["status_message"] = "Synthesizing Dungeon Textures & AI Portrait with FLUX.1 [schnell]..."
        gen_progress["percent"] = 30

        w_path, c_path, f_path, p_res, face_paths, enemy_frames = generate_flux_all_assets(
            wall_style, player_style, player_image, mode=mode, progress_cb=_progress,
            weapon_style=weapon_style, enemy_style=enemy_style)

        gen_progress["current_step"] = 2
        gen_progress["status_message"] = "Assembling 3D World & Valbrace Combat..."
        gen_progress["percent"] = 90

        with open(w_path, "rb") as tf:
            w_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        with open(c_path, "rb") as tf:
            c_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        with open(f_path, "rb") as tf:
            f_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
        p_sprites_b64 = []
        p_b64 = None
        if isinstance(p_res, list):
            for pf in p_res:
                with open(pf, "rb") as tf:
                    p_sprites_b64.append(f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}")
            p_b64 = p_sprites_b64[0]
        else:
            with open(p_res, "rb") as tf:
                p_b64 = f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"
            p_sprites_b64 = [p_b64]
        face_b64_list = []
        for fp in face_paths:
            with open(fp, "rb") as tf:
                face_b64_list.append(f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}")
        face_b64 = face_b64_list[0]

        enemy_b64 = []
        for ef in (enemy_frames or []):
            with open(ef, "rb") as tf:
                enemy_b64.append(f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}")

        gen_progress["percent"] = 100
        gen_progress["status_message"] = "FLUX.1 Dungeon & Character Ready!"
        gen_progress["completed_bundle"] = {
            "mode": "v3_flux",
            "wall_style": wall_style,
            "wall_texture": w_b64,
            "ceiling_texture": c_b64,
            "floor_texture": f_b64,
            "player_sprite": p_b64,
            "player_sprites": p_sprites_b64,
            "player_face": face_b64,
            "player_faces": face_b64_list,
            "enemy_sprites": enemy_b64,
            "enemy_style": (enemy_style or "").strip()
        }
        print("[FLUX.1] Dungeon textures, character sprite, and AI portrait complete and packaged!")

    except GenerationCancelled as c:
        # The page went away mid-run; /api/cancel_generation already drained the queue.
        print(f"[FLUX.1] {c}")
        gen_progress["status_message"] = "Generation cancelled - the page was closed."
        gen_progress["percent"] = 0
        gen_progress["phase"] = ""
    except Exception as e:
        print(f"[FLUX.1 Error] {e}")
        gen_progress["error"] = str(e)
    finally:
        gen_progress["is_generating"] = False


# ==========================================================================
# v5 - krea2 turbo "one-shot character" engine
# ==========================================================================
# krea2 turbo has no ControlNet and no IPAdapter, so v5 drops the v4 pose rig
# entirely: one clean generation per asset (player / weapon / shield / enemy /
# portrait), BiRefNet background removal, done. The JS rig animates the weapon
# and shield sprites as overlays the same way the procedural rig does. The three
# tiling wall/ceiling/floor textures stay on FLUX schnell - they already tile
# cleanly and generate fast.

def krea2_player_prompt(player_style):
    p = player_style.strip() if (player_style and player_style.strip()) else "armored warrior knight"
    return (
        f"A full-body video game character sprite of a {p}, viewed from directly behind in a "
        f"third-person back view, facing away from the camera into the scene. Standing upright and "
        f"centered, weight balanced, arms relaxed at the sides, hands empty - no weapon, no shield. "
        f"Even front lighting, sharp detailed textures, the whole figure from head to feet with a "
        f"little empty space above and below. Plain solid pure white background, nothing else in frame."
    )


def krea2_weapon_prompt(weapon_style, player_style):
    w = weapon_style.strip() if (weapon_style and weapon_style.strip()) else "sword"
    p = player_style.strip() if (player_style and player_style.strip()) else "armored warrior"
    return (
        f"A single {w}, one object only, shown straight on from the side and standing perfectly "
        f"upright and vertical: the head or blade points up at the top of the frame, the handle and "
        f"grip sit at the bottom. Styled to match a {p}'s gear. Clean game item icon, centered with a "
        f"clear margin on every side, even lighting, crisp detail. No hands, no arms, no character. "
        f"Plain solid pure white background."
    )


def krea2_shield_prompt(player_style):
    p = player_style.strip() if (player_style and player_style.strip()) else "armored warrior"
    return (
        f"A single round battle shield seen straight on from the front, one shield only, with a "
        f"plain raised central boss and a simple decorated rim. Bare surface, no emblem, no crest, "
        f"no painted face or animal. Styled in the colours and materials of a {p}'s gear. Clean game "
        f"item icon, centered with a clear margin on every side, even lighting. No hands, no arms, no "
        f"character, no weapon. Plain solid pure white background."
    )


# The three foes built from one typed enemy idea. The frontend (bundle["enemy_variants"])
# sizes and drives each one differently.
ENEMY_VARIANT_NAMES = ["walker", "flyer", "boss"]

# THREE SEPARATE SPECIES, NOT ONE SUBJECT EDITED TWICE.
#
# This used to generate the walker and derive the other two as FLUX Kontext edits of it,
# which held identity perfectly - and that turned out to be the problem. Kontext preserves
# the subject by construction, so on a gargoyle the "flyer" came back as the SAME gargoyle
# with wings bolted on and the boss as the same gargoyle recoloured. Correct, and boring.
#
# So the LLM that writes the intro crawl now also designs three separate foes from the typed
# idea (generate_enemy_species) and krea2 draws each one independently. The variety comes
# from three different subjects rather than from three treatments of one subject.
#
# Doing this ALSO removes the reason the derivation existed. Asking krea2 for a flyer used to
# mean "a flying version of {e}", which returned a plain bird for a RAM stick on 4 of 4 seeds,
# and asking for a boss meant "colossal hulking armoured boss form of {e}", which returned a
# generic armoured demon - because those role clauses are stronger priors than any amount of
# "it is literally a RAM stick". Nothing here asks krea2 to transform anything: it is handed a
# finished physical description and told only to draw it. The role clauses that lost those
# arguments are gone, which is why the direct path works now when it did not before.
#
# The Kontext derivation is KEPT as the fallback for when the LLM naming call fails, along
# with krea2_enemy_prompt's per-variant role clauses that feed it.
KREA2_FALLBACK_DIRECT_VARIANTS = ["walker"]

# Eight short labelled lines. Comfortably over a full reply - the LLM lesson from
# _vlm_wants_rotors applies here too: a truncated answer loses the LAST labels, and a species
# set missing its BOSS_LOOK is thrown away entirely by parse_enemy_species. GUARD costs about
# five more tokens of reply; the +20 keeps the old margin on the three LOOK lines.
ENEMY_SPECIES_MAX_TOKENS = 320
ENEMY_SPECIES_TEMPERATURE = 0.9

# Per-variant animation frames. Every foe gets an attack frame; only the two that fight on
# the ground get a block frame - the flyer never guards (ENEMY_VARIANTS.flyer.canBlock is
# false in game.js, it stays out of reach instead). "idle" must stay first: it is the frame
# the others are registered and scaled against, on both sides.
ENEMY_VARIANT_FRAMES = {
    "walker": ["idle", "attack", "block"],
    "flyer":  ["idle", "attack"],
    "boss":   ["idle", "attack", "block"],
}
ENEMY_FRAME_FALLBACK = ["idle"]          # what a Kontext-derived variant has

# The LAST ATTACK FRAME - the setup screen's "Last Attack Frame" option. A foe's attack frame
# goes up at the START of its telegraph and the blow only lands at the END of it (30 ticks on
# the walker, 46 on the boss, the whole 26-tick dive on the flyer), so the pose the player
# reads as "it hits me" is on screen well before anything does. With the option on, every foe
# also gets this frame and game.js swaps to it on the tick landEnemyStrike resolves the blow:
# the attack frame becomes the wind-up and this one is the hit. It is appended to each foe's
# frames rather than written into ENEMY_VARIANT_FRAMES, so a run made with the option off
# draws exactly the frames it always has.
ENEMY_STRIKE_FRAME = "strike"

# What the History window labels a run by. Frame version 2 was drawn with the strike frame;
# everything saved before this existed has no frame_version on its meta and reads as 1.
FRAME_VERSION_BASE = 1
FRAME_VERSION_STRIKE = 2


def _enemy_variant_frames(variant, last_attack_frame=False):
    """The frames drawn for one LLM-designed foe, with the strike frame on the end when the
    Last Attack Frame option is on."""
    frames = list(ENEMY_VARIANT_FRAMES.get(variant, ENEMY_FRAME_FALLBACK))
    if last_attack_frame:
        frames.append(ENEMY_STRIKE_FRAME)
    return frames


def _enemy_frame_count(last_attack_frame=False):
    """Total enemy sprites in the shared krea2 job - the progress denominator."""
    return sum(len(_enemy_variant_frames(v, last_attack_frame)) for v in ENEMY_VARIANT_FRAMES)

# Pose clauses for krea2_species_prompt. Same positive-only rule as everything else in this
# file - these describe a posture, never what the foe is not doing.
ENEMY_FRAME_POSES = {
    "idle":   "It faces the viewer, ready to fight",
    "attack": ("It surges forward at the viewer in mid-attack, lunging into the camera with "
               "its whole body committed and its leading edge thrust out toward you"),
    # The frame shown on the tick the blow LANDS (ENEMY_STRIKE_FRAME), after "attack" has
    # carried the whole wind-up. It needs something the attack frame does not have, and it
    # cannot be a limb - a RAM stick has none - so it is the impact itself: an explosion where
    # the blow connects. Same survival rules as the FIELD guard below: overlapping the body,
    # so keep_largest_figure keeps it with the foe, and saturated, so the white-background
    # cut-out does not take it away. Measured on the same 6 foes and seeds (RAM stick +
    # gargoyle, walker/flyer/boss), in this order:
    #  * "It lands its blow ... at the instant of impact ... with a bright jagged burst of
    #    sparks flaring from its leading edge ... the whole of it in view from top to bottom"
    #    came back as the IDLE frame on 6 of 6, no sparks at all. The seed is shared, so a
    #    clause too weak to move the picture just hands back the idle.
    #  * The attack clause with the burst appended kept the lunge, and drew the burst tiny or
    #    not at all (0-9% of the sprite) - and grew a stray red limb on a RAM stick.
    #  * THE BURST AS THE SUBJECT IS WHAT GETS DRAWN: 8-33% of the sprite, 6 of 6. So it
    #    leads, and the attack clause's own lunge follows it to keep the pose leaning the way
    #    the wind-up did.
    #  * "Right in front of it, overlapping its BODY" centred the fireball on the foe (it read
    #    as the foe exploding) and once turned a RAM stick into a red robot holding one.
    #    "Against its LEADING EDGE" puts it where the blow lands and kept every subject.
    ENEMY_STRIKE_FRAME: ("A huge bright explosion of orange fire and yellow sparks bursts out "
                         "against its leading edge where its blow connects, overlapping it, as "
                         "it surges forward at the viewer in mid-attack, lunging into the camera "
                         "with its whole body committed and its leading edge thrust out toward "
                         "you"),
}

# The block frame gets one clause per GUARD mode instead of a single shared one.
#
# There WAS a single block clause here, written to work on a subject with no anatomy at all -
# "hunched down and drawn back with everything pulled in tight". It was safe on a RAM stick
# and it was also nearly invisible: hunching is a small change to a silhouette, the block
# frame shares its seed with the idle, and a guarding foe came out looking like an idle foe.
# In the corridor the player could not see that a strike was about to be soaked.
#
# So the guard is chosen per foe (the GUARD label, see parse_enemy_species) and each mode
# changes the SILHOUETTE rather than the posture - that is the entire point of the frame.
# ARMS puts a real guard up. FIELD gives a thing with no limbs something to raise. SHELL is
# the animal in between: no arms, but plenty of body to get in the way.
#
# Three rules these clauses have to keep, all learned the hard way:
#
#  * EVERY clause has to reach the GROUND. This is the one that bit in play. The first ARMS
#    clause described the upper body and nothing else - crossed forearms, tucked elbows,
#    hunched shoulders, a lowered head - and krea2 obliged by FRAMING the upper body: it cut
#    the foe off at the waist and filled the canvas with a chest-up bust. Nothing downstream
#    saves that. The frontend scales every frame by the IDLE frame's content box (see
#    drawEnemyContent), which is correct while the frames share a composition and catastrophic
#    when one of them is a close-up: the guard frame drew as a giant legless torso lunging at
#    the camera, which is what a player reported as "the enemy gets closer and part of it is
#    cut off". So each clause names feet, legs, the ground, or the full height of the subject,
#    and the block frame is also given a wider margin (see krea2_species_prompt).
#  * No LIST of body parts. krea2 draws every word it is given, so "a wing, a shell or a
#    plated back" draws one foe with all three bolted on. SHELL therefore names no part at
#    all and lets the subject supply its own.
#  * The barrier must TOUCH the subject and be strongly coloured. keep_largest_figure keeps
#    only the largest connected blob, so a bubble floating clear of the foe is either erased
#    or - being the bigger shape - erases the foe. And it is cut out of a pure white
#    background, so a white or pale glow is cut away along with it. Overlapping the body and
#    saturated cyan survive both passes.
ENEMY_BLOCK_POSES = {
    "arms":  ("It stands at its full height with its feet planted wide apart on the ground "
              "and throws up a hard defensive guard: both arms are raised in front of its "
              "chest, forearms crossed and turned outward, elbows tucked in tight and "
              "shoulders hunched up behind them, its weight rocked back over its legs to "
              "soak up an incoming blow"),
    "shell": ("It plants itself on the ground and turns side-on, swinging the broadest, "
              "thickest part of its own body across its front as a barrier and setting its "
              "whole weight behind it, braced from top to bottom to soak up an incoming "
              "blow"),
    "field": ("A force field flares up in front of it: a bright curved wall of glowing cyan "
              "energy, dense and solid and patterned with a honeycomb of hexagons, standing "
              "right up against it and spanning it from top to bottom, overlapping the body "
              "it covers, with the whole of the subject planted on the ground close behind "
              "the barrier"),
}

ENEMY_SPECIES_SYSTEM = (
    "You are the bestiary designer for a 1990s first-person dungeon crawler. You invent "
    "three distinct foes that clearly belong to one family, and you describe each one as a "
    "concrete physical thing an artist can draw. "
    "You never explain yourself and you never break format."
)

# Rule 5 is not style advice. krea2 runs at cfg 1.0 with a ConditioningZeroOut negative, so
# there is no negative guidance and every word of a LOOK line gets drawn - a description that
# says "not a bird" draws a bird. Rule 2 is what keeps a non-creature subject alive: left to
# itself the model reaches for anatomy, and anatomy on a RAM stick is just a monster again.
_ENEMY_SPECIES_USER = """A player is about to fight a dungeon full of: {enemy}

Design THREE different foes from that idea. They must read as three DIFFERENT creatures from
the same family - not one creature drawn three times. Someone who sees all three together
should think "those are three kinds of {enemy}", never "that is the same one with wings".

- GRUNT: fights on foot on the ground. The plain, common version.
- FLYER: genuinely airborne. It must look airborne even standing still in a picture.
- BOSS: the champion, far bigger and heavier than the other two - and it gets that way by
  having MORE OF ITSELF. Enlarge and multiply its own parts, stack or fuse several of it
  together, thicken it, raise it up. Bulk it out with its own material, not with a costume.

Rules for the LOOK lines. They are fed straight to an image generator, so:

1. Every LOOK must NAME {enemy} in the sentence and describe THAT thing. Change the build,
   the silhouette, the extra parts and the colours; never rename it to something else and
   never describe only the differences. Asked for three dragons, "heavy scaled armour with
   jagged teeth, standing on two thick legs" is WRONG - it forgot to say dragon.
2. If {enemy} is an object, a machine or a piece of technology rather than a living creature,
   then all three stay that object. Give it machinery, mountings, housings and moving parts.
   Faces, limbs, claws, scales and feathers would replace it with a monster.
3. Say how the FLYER stays up, with something that suits {enemy} specifically: feathered
   wings, membrane wings, insect wings, spinning rotor blades, glowing thrusters, a gasbag.
   Choose ONE and describe it.
4. Give the three clearly different colours, so a player tells them apart instantly in a
   dark corridor.
5. Describe ONLY what is in the picture. NEVER write what a foe is not, or what it lacks, or
   what it should not look like - every single word you write will be drawn.
6. One sentence each, under 30 words. Plain physical description: shape, build, materials,
   colours, parts. No story, no history, no mood words unless they are visibly on the model.
7. Bulk and menace come from the subject's OWN material and its OWN parts, made bigger,
   thicker and more numerous. Calling a foe armoured, plated, helmeted, crowned, spiked, or
   giving it a humanoid torso and shoulders, replaces it with a generic armoured warrior and
   the subject vanishes - this is the single most common way this job goes wrong.

Rules for the NAME lines. A name is what the health bar shows during the fight, so it has to
point straight at the foe it belongs to:

8. Make every NAME out of {enemy} itself - its own word, or a play on that word - plus a word
   for what sets this one apart from the other two. A hard-sounding word that could belong to
   any monster at all says nothing about {enemy}.
9. Three different names, one for each foe. People are named the way you would point one out
   in real life, in plain everyday words.

Reply using EXACTLY these eight labels, each on its own line, in this order. No preamble, no
markdown, no commentary, no asterisks:

KIND: <copy exactly ONE of these two words and nothing else. Write CREATURE if {enemy} is
  alive - an animal, a monster, a person, a plant. Write OBJECT if {enemy} is not alive - a
  thing, a food, a device, a machine, a piece of technology. A food is always OBJECT, however
  much it walks and fights in this game. Do not answer with the name of the thing; the only
  two permitted answers are the word CREATURE and the word OBJECT>
GUARD: <copy exactly ONE of these three words and nothing else. It says how these foes cover
  up when someone swings at them. Write ARMS if they have arms, hands, claws or forelimbs
  they could raise in front of their own body. Write SHELL if they have no arms at all, but
  do have some big broad tough part of themselves they could turn into the blow. Write FIELD
  if they are an object, a machine or a device that would answer a swing by throwing up a
  glowing energy barrier in front of itself>
GRUNT_NAME: <1-3 word name for this ONE foe, made from {enemy}, not a plural>
GRUNT_LOOK: <one sentence>
FLYER_NAME: <1-3 word name, made from {enemy}, not a plural>
FLYER_LOOK: <one sentence>
BOSS_NAME: <1-3 word name, made from {enemy}, not a plural>
BOSS_LOOK: <one sentence>"""


def _enemy_species_prompt(enemy_style):
    """Same hand-built chat template as _story_prompt - see there for why the <|im_start|>
    opener and the empty <think> block are both mandatory."""
    user = _ENEMY_SPECIES_USER.format(
        enemy=(enemy_style or "").strip() or "things that shamble")
    return (
        "<|im_start|>system\n" + ENEMY_SPECIES_SYSTEM + "<|im_end|>\n"
        "<|im_start|>user\n" + user + "<|im_end|>\n"
        "<|im_start|>assistant\n"
        "<think>\n\n</think>\n\n"
    )


_SPECIES_LABELS = {"grunt": "walker", "flyer": "flyer", "boss": "boss"}

# krea2 has no negative guidance, so a LOOK line that says what a foe ISN'T draws exactly
# that. Rule 5 of the brief forbids it and the model mostly complies, but it still wrote
# "hovering midair with no visible ground contact" for a drone - which is a request for
# visible ground contact. Clauses are dropped rather than trusted.
_SPECIES_NEGATION = re.compile(
    r"\b(?:no|not|non|none|never|without|lacking|lacks|missing|absent|instead\s+of|"
    r"rather\s+than|free\s+of|devoid)\b", re.I)


# Words whose own visual prior is an armoured humanoid. Applied ONLY when the subject is an
# OBJECT, because an object has no character prior of its own to survive them: "Massive stick
# of computer RAM ... armored with cracked gold plating" rendered a red-and-black mecha with
# no RAM anywhere in it. A CREATURE subject is left alone - a gargoyle boss "crowned with a
# spiked helmet" stays a gargoyle and looks better for it.
#
# Deliberately NARROW. "Legs" is what makes the walker a walker, "spine" and "gold-plated"
# both appear in descriptions that rendered perfectly, and stripping those would cost more
# than it saves. Only the costume nouns are listed.
_SPECIES_HIJACK = re.compile(
    r"\b(?:armou?red|armou?r|armou?r-plated|pauldrons?|helmets?|helms?|visors?|crowned|"
    r"crowns?|gauntlets?|greaves?|breastplates?|cuirass|spiked|spikes|humanoid|torso|"
    r"knights?|warriors?|demons?|colossus|golems?|juggernauts?|behemoths?|warlords?)\b", re.I)

# The ARMOUR family, stripped from EVERY subject including creatures. The rest of
# _SPECIES_HIJACK above still applies to objects only.
#
# That object-only gate was written when the subject was always a typed noun with a strong
# visual prior, where keeping the costume words costs only "a slightly plainer gargoyle". It
# does not hold for a PERSON. The theme brief now routinely designs people - a dungeon typed
# as "chat" resolves to "chat-bubble twitch viewer" - KIND correctly answers CREATURE, the
# costume words are kept, and "A squat, ARMORED chat-bubble twitch viewer with glowing cyan
# edges" rendered a black-and-cyan armoured MECH with no person and no chat bubble in it at
# all. A person is a weak enough prior that "armoured" simply replaces them.
#
# Proof it is this one word rather than the concept: the BOSS of that same family, "stacked,
# pulsing chat-bubble twitch viewers fused into a towering mass", carried no armour word and
# rendered a perfect golem built out of chat bubbles.
#
# Deliberately NARROW - only words that name a suit of armour. "spiked", "crowned" and
# "helmet" stay creature-only: those genuinely do improve a gargoyle, and none of them has
# been observed eating a subject on its own.
#
# Removed WORD BY WORD, not clause by clause. _strip_clauses drops the whole comma-separated
# clause it matched, which is right for an object wearing a costume description but wrong
# here: in "A squat, armored chat-bubble twitch viewer with glowing cyan edges" the offending
# adjective sits in the same clause as the subject, so dropping the clause deletes the foe and
# leaves "A squat, thick knuckles, and a mouth full of pixelated teeth". Only the adjective
# goes; everything the clause says about the subject stays.
_SPECIES_ARMOUR = re.compile(
    r"\b(?:armou?r-?plated|armou?red|armou?r|plated|plating|pauldrons?|breastplates?|"
    r"cuirass|greaves?|mechs?|mecha)\b", re.I)

# Tidies up after a word removal: doubled spaces, a space before punctuation, an orphaned
# hyphen left by a compound, and a comma or "and" left leading the sentence.
_SPECIES_TIDY = [
    (re.compile(r"\s*-\s*(?=[,.]|$)"), ""),
    (re.compile(r"(?<=\s)-\s+"), ""),
    (re.compile(r"\s{2,}"), " "),
    (re.compile(r"\s+([,.])"), r"\1"),
    (re.compile(r",\s*(?=,)"), ""),
    (re.compile(r"^[\s,]*(?:and\s+)?"), ""),
    # "An armour-plated gargoyle" -> "An gargoyle" once the compound goes; fix the article.
    (re.compile(r"\b([Aa])n(?=\s+[^aeiouAEIOU\s])"), r"\1"),
]


def _strip_words(look, pattern, why, tag="species"):
    """Delete just the matched WORDS, keeping the rest of their clause. Returns the original
    if the result would be too thin to be a description."""
    out = pattern.sub("", look or "")
    for rx, rep in _SPECIES_TIDY:
        out = rx.sub(rep, out)
    out = out.strip().strip(",").strip()
    if len(out.split()) < 3:
        return look
    if out != (look or "").strip():
        dropped = sorted(set(m.group(0) for m in pattern.finditer(look or "")))
        print(f"[{tag}] removed {why} word(s) {dropped}")
    return out


def _strip_clauses(look, pattern, why):
    """Drop any comma-separated clause matching `pattern`. Keeps the original if that would
    gut the description - a flawed sentence still beats no sentence."""
    parts = (look or "").split(",")
    kept = [p for p in parts if not pattern.search(p)]
    if not kept or len(" ".join(kept).split()) < 3:
        return look
    if len(kept) != len(parts):
        dropped = [p.strip() for p in parts if pattern.search(p)]
        print(f"[species] dropped {why} clause(s) {dropped}")
    return ",".join(kept).strip().strip(",").strip()


def _strip_negations(look):
    """krea2 has no negative guidance, so a clause saying what a foe ISN'T draws exactly
    that."""
    return _strip_clauses(look, _SPECIES_NEGATION, "negated")


def _read_guard(guard, is_creature):
    """Turn the GUARD line into one of ENEMY_BLOCK_POSES' keys.

    Read the same way as KIND - match the word ANYWHERE in the line, because the model likes
    to answer in a sentence rather than in the single word it was asked for - with one extra
    pass in front, because these three option words are ordinary English in a way CREATURE and
    OBJECT are not. "It has no arms to raise, so SHELL" contains both options, and taking the
    first match of any case reads it as ARMS: the exact inverted-by-its-own-preamble failure
    _vlm_wants_rotors documents, where the verdict arrives after the model has talked its way
    past the options it rejected.

    So CAPITALS are read first. The brief prints the three options in caps and asks for one to
    be copied, so a verdict is capitalised and the prose around it is not - which sorts that
    sentence out correctly. Only when nothing is capitalised does the case-insensitive pass
    run, and there the earliest match wins.

    An unreadable answer falls back on KIND, the only other thing known about the foe: a
    creature has something of its own to raise, an object gets the barrier. That way round
    because FIELD is the mode that cannot be badly wrong on anything - it adds a barrier
    rather than assuming a body part - and a missing KIND already means OBJECT here."""
    text = (guard or "").strip()
    for hay, needle in ((text, str.upper), (text.lower(), str.lower)):
        hits = [(hay.find(needle(m)), m) for m in ENEMY_BLOCK_POSES if needle(m) in hay]
        if hits:
            return min(hits)[1]
    return "arms" if is_creature else "field"


def parse_enemy_species(text):
    """Pull the labels out of the reply. Returns {variant: {"name", "look", "guard"}} for the
    three variants, or None if any of them is missing - a partial set would silently mix a
    designed foe with a derived one, so it is all three or the fallback path.

    KIND decides whether the costume nouns are stripped (see _SPECIES_HIJACK). A MISSING or
    unreadable KIND is treated as OBJECT, i.e. strip: the two failures are not symmetric.
    Stripping a creature's crown costs a slightly plainer gargoyle; not stripping an object's
    armour costs the subject entirely, which is how a RAM stick became a red mecha.

    GUARD picks the block pose (ENEMY_BLOCK_POSES). It is one decision for the whole family
    rather than one per foe: the two that actually block, the grunt and the boss, are the same
    creature built at two sizes, and every extra required label is another line the reply can
    come back missing."""
    got = {}
    kind = ""
    guard = ""
    for raw_line in (text or "").splitlines():
        line = raw_line.strip().strip(_STORY_STRIP)
        if ":" not in line:
            continue
        label, _, value = line.partition(":")
        key = label.strip().lower()
        value = value.strip().strip(_STORY_STRIP)
        if not value:
            continue
        if key == "kind":
            kind = value.strip().lower()
            continue
        if key == "guard":
            guard = value.strip()          # case is kept - _read_guard reads CAPITALS first
            continue
        for src, variant in _SPECIES_LABELS.items():
            if key == f"{src}_name":
                got.setdefault(variant, {})["name"] = value[:40]
            elif key == f"{src}_look":
                got.setdefault(variant, {})["look"] = value[:300]

    # Match the WORD anywhere in the line, not just at the start - the model likes to answer
    # "The kind is CREATURE." An unrecognised answer (it once replied with the subject noun
    # itself, "gargoyle") is treated as OBJECT, the safe direction.
    is_creature = bool(re.search(r"\bcreature\b", kind)) and not re.search(r"\bobject\b", kind)
    print(f"[species] kind={kind or '(missing)'!r} -> "
          f"{'creature, costume nouns kept' if is_creature else 'object, costume nouns stripped'}")

    mode = _read_guard(guard, is_creature)
    print(f"[species] guard={guard or '(missing)'!r} -> {mode} block pose")

    out = {}
    for v in ENEMY_VARIANT_NAMES:
        entry = got.get(v) or {}
        if not entry.get("look") or not entry.get("name"):
            return None
        look = _strip_negations(entry["look"])
        # Armour goes for everyone; the rest of the costume vocabulary for objects only.
        look = _strip_words(look, _SPECIES_ARMOUR, "armour")
        if not is_creature:
            look = _strip_clauses(look, _SPECIES_HIJACK, "costume-noun")
        out[v] = {"name": entry["name"], "look": look, "guard": mode}
    return out


# The brief's own role labels, copied into the names - "Stonehugger Boss", "Skyroot Flyer", and
# one whole family came back "Grunt Customer", "Flyer Customer" and "Boss Customer". GRUNT is
# left alone: a grunt is a real word for a foot soldier, and "Gummy Grunt" reads as a name.
_SPECIES_LABEL_ECHO = re.compile(r"\b(?:flyer|boss)\b", re.IGNORECASE)

# What a foe's name is rebuilt around when the model's has nothing to do with it, and how long
# that subject may run first: every name is worn under a pack's "RUNT " / "FLEDGLING " too, on
# a 320px health bar (drawEnemyHpBar), so "Chat-bubble Twitch Viewer" goes in as "Twitch Viewer".
_SPECIES_NAME_LEADS = {"walker": "", "flyer": "Flying ", "boss": "Big "}
_SPECIES_WHAT_MAX = 16


def _tidy_species_names(species, enemy_style):
    """Make the three NAME lines belong to their foes, in place - _ENEMY_SPECIES_USER's name
    rules say what the model is asked for, and this is what is enforced:

    1. Label echoes come off: "Skyroot Flyer" -> "Skyroot".
    2. A name with nothing to do with its foe - no five-letter run of the subject's words, or of
       that foe's own LOOK line, anywhere in it (_name_connects) - is rebuilt from the subject.
       Across 95 saved runs "Ironclad Grunt", "Skywhip" and "Golemforge" fought for "maga
       people", "Stone Skull" for a dinosaur and "Squeaky Scribe" for a business cat. The LOOK
       counts because it is what is drawn: "Rusty Knuckle" for a fingercreeper is a name for
       the giant knuckled hand on screen, even without "finger" in it.
    3. The three come out different - "MONEY MAN" was once the answer for all of them."""
    what = _clean_what(enemy_style)
    if what:
        words = what.split(" ")
        while len(words) > 1 and len(" ".join(words)) > _SPECIES_WHAT_MAX:
            words.pop(0)
        what = " ".join(words)
    seen = set()
    for v in ENEMY_VARIANT_NAMES:
        entry = species[v]
        name = re.sub(r"\s{2,}", " ", _SPECIES_LABEL_ECHO.sub("", entry["name"])).strip(" -_")
        name = name or entry["name"]
        lead = _SPECIES_NAME_LEADS[v]
        if what and not _name_connects(name, enemy_style, entry.get("look")):
            print(f"[species] {v} name {name!r} has nothing to do with {enemy_style!r} "
                  f"- renamed {lead + what!r}")
            name = lead + what
        if name.lower() in seen and not name.lower().startswith(lead.lower()):
            name = lead + name
        entry["name"] = name
        seen.add(name.lower())
    return species


def generate_enemy_species(enemy_style):
    """Design the three foes. Never raises: on any failure returns None and the caller falls
    back to the walker-plus-Kontext-derivation path, which still produces three usable
    enemies - just three that look more alike."""
    payload = {
        # Byte-identical to _krea2_loaders()["k_clip"] on purpose - see generate_intro_story.
        "k_clip": {"inputs": {"clip_name": KREA2_CLIP, "type": "krea2", "device": "default"},
                   "class_type": "CLIPLoader"},
        "species_gen": {
            "inputs": {
                "clip": ["k_clip", 0],
                "prompt": _enemy_species_prompt(enemy_style),
                "max_length": ENEMY_SPECIES_MAX_TOKENS,
                "sampling_mode": "on",
                "sampling_mode.temperature": ENEMY_SPECIES_TEMPERATURE,
                "sampling_mode.top_k": 64,
                "sampling_mode.top_p": 0.95,
                "sampling_mode.min_p": 0.05,
                "sampling_mode.repetition_penalty": 1.05,
                "sampling_mode.seed": random.randint(0, 2**32 - 1),
                "thinking": False,
                "use_default_template": False,
            },
            "class_type": "TextGenerate",
        },
        "species_out": {"inputs": {"source": ["species_gen", 0]}, "class_type": "PreviewAny"},
    }
    try:
        t0 = time.time()
        raw = _submit_and_collect_text(payload, "species_out", job_key="enemy_species")
        species = parse_enemy_species(raw)
        if not species:
            print(f"[species] reply did not carry all six foe labels - deriving instead\n{raw[:300]}")
            return None
        species = _tidy_species_names(species, enemy_style)
        species = _enemy_look_lead(species, enemy_style)
        for v in ENEMY_VARIANT_NAMES:
            print(f"[species] {v:6s} {species[v]['name']!r} - {species[v]['look']}")
        print(f"[species] three foes designed in {time.time()-t0:.1f}s")
        return species
    except Exception as e:
        print(f"[species Error] {e} - falling back to the Kontext derivation")
        PROGRESS.finish_job("enemy_species")
        return None


# ============================================================================
# THE SET DESIGNER - turning abstract typed words into drawable material.
# ============================================================================
#
# The enemy path has had an abstraction translator since generate_enemy_species: an abstract
# noun becomes a concrete physical LOOK sentence before krea2 ever sees it. Nothing else did,
# and that asymmetry is a real, reproducible bug. Clicking the shipped "internet" preset
# (wall "internet", weapon "memes", enemy "chat") returned blank walls and a default-looking
# corridor, because get_surface_prompts' generic branch interpolates the typed word raw:
#
#     "A flat 2D vertical wall surface texture of internet, close-up flat orthographic front
#      view, seamless tileable wall material, zero horizon, zero sky, zero landscape, pure
#      flat vertical wall material."
#
# On FLUX schnell at 4 steps / cfg 1.0 the framing clauses are the only concrete thing in that
# string, so the model draws exactly them: flat, featureless material. Same for the weapon,
# which became "holding a memes in the right hand".
#
# So: one LLM pass, up front, that turns whatever was typed into concrete materials and
# objects. Built on exactly the generate_enemy_species plumbing - same TextGenerate node, same
# hand-built chat template, same never-raises contract, same negation stripping.

THEME_BRIEF_MAX_TOKENS = 520      # eight one-line answers; species proves 8 labels at 320
# Measured failure rate on the eight-label shape is roughly one attempt in three, so ONE retry
# still let a whole dungeon through on the typed words (a run of "internet / memes / chat"
# fell back and drew generic scale-monsters). Three attempts takes that to a few percent, and
# costs nothing on the runs that answer first time. See generate_theme_brief for the two
# degenerate modes this is re-rolling past.
THEME_BRIEF_ATTEMPTS = 3
# Well below the bestiary's 0.9. That one is being asked to INVENT three foes; this one is
# being asked to obey a dozen rules, and the two want opposite things from sampling. At 0.8 a
# theme typed as "chat" wandered across "twitch viewer with a chat bubble overhead", "person
# wearing a chat bubble helmet" and "face obscured by a broken monitor" on consecutive runs,
# and roughly one attempt in three ignored the reply format altogether. 0.6 was too far the
# other way: it answered the ENEMY line with bare "person" and "chatbot", dropping the very
# qualifier that made it that idea, so 0.7 is the settled middle.
THEME_BRIEF_TEMPERATURE = 0.7

# The surface slots are only asked for when no keyword bucket matched. Every extra required
# label is another line the reply can come back missing (the lesson _vlm_wants_rotors paid
# for), so a bucketed theme asks for two labels instead of eight.
THEME_SURFACE_SLOTS = ["wall", "floor", "ceiling", "lantern", "door", "switch"]
THEME_SUBJECT_SLOTS = ["weapon", "enemy"]

# Slots that get interpolated INTO the middle of a sentence rather than used as its subject:
# "a flat 2D vertical wall surface texture of {wall}", "holding a {weapon} in the right hand",
# "a dungeon full of: {enemy}". The model answers in full sentences ("A coiled blue ethernet
# cable whip..."), which lands as "holding a A coiled blue ethernet cable whip" - so the
# leading article and capital come off. lantern / door / switch are the other way round: each
# one IS the subject of its prompt, so their article and capital are exactly right.
_THEME_INLINE_SLOTS = {"wall", "floor", "ceiling", "weapon", "enemy"}

# The three slots that become a TILING TEXTURE, as opposed to a single drawn object. Only
# these get the washout strip below - "a faint glow" on a lantern is a description of a lit
# object and perfectly renderable; "faint barcode patterns" on a wall is not.
_THEME_TEXTURE_SLOTS = {"wall", "floor", "ceiling"}

# The washout adjectives, and they are not a matter of taste. FLUX schnell runs these surfaces
# at 4 steps and cfg 1.0, where it cannot resolve low-contrast detail at all - so a line that
# says its own detail is "faint" or "faded" leaves the flat ground colour as the only thing in
# the prompt the model can draw, and the wall arrives as blank paper. That is what shipped a
# white supermarket: "glossy white plastic with faint barcode patterns and faded price tags in
# black ink" measured std dev 2.7 / 3.5 / 17.0 across three seeds (blank on all three) and
# 36.3 / 46.0 / 61.2 on those same three seeds with just these two words deleted.
#
# It has to be WORD removal, like _SPECIES_ARMOUR: the detail lives inside the clause the
# adjective qualifies, so _strip_clauses would delete the barcodes and keep the white plastic -
# precisely backwards. Note that "white" and "glossy" are NOT on this list; stripping them
# instead of the adjectives was measured and still went blank on one seed in three, because
# they describe the ground rather than suppress the pattern.
_SURFACE_WASHOUT = re.compile(
    r"\b(?:faint(?:ly)?|faded|fading|barely[- ]visible|barely[- ]there|subtle|subtly|"
    r"muted|pale|washed[- ]out|soft(?:ly)?|delicate|understated|ghostly|wispy)\b", re.I)
_THEME_ARTICLE = re.compile(r"^(?:an?|the)\s+", re.I)


# ENEMY is the one slot that must stay a SHORT SUBJECT rather than a description, because it
# is not drawn from directly - it becomes the {enemy} that _ENEMY_SPECIES_USER repeats eight
# times and that krea2_species_prompt re-anchors each foe on. Measured replies run 9-11 words
# and bolt a full look onto the noun ("armored tank with chrome plating and glowing red eye
# sockets"), which is a problem twice over: the species designer's whole job is to invent that
# look per variant, and "armored" is exactly the costume noun _SPECIES_HIJACK strips out of an
# object's LOOK lines - except that the subject noun is re-anchored in code, so it would walk
# straight back in unfiltered and turn the foe into the generic mecha that regex exists to
# prevent. Cutting at the first attributive joiner leaves "armored tank" -> "tank"-shaped
# subjects the size of the presets that already work ("rogue security drone", "gummy bear").
#
# " of " is deliberately NOT a joiner: "stick of computer RAM" must survive intact, since the
# whole point of that preset's wording is that bare "ram" renders a male sheep.
_THEME_ENEMY_JOINER = re.compile(
    r"\s+(?:with|wearing|holding|carrying|covered\s+in|made\s+of|featuring|sporting|that|"
    r"which)\s+", re.I)


THEME_ENEMY_MAX_WORDS = 8
THEME_ENEMY_MAX_TAIL = 5     # a qualifier longer than this is a LOOK, not part of the name

# Words a truncated subject must not END on - articles, prepositions and conjunctions
# that promise something the cut threw away.
_THEME_ENEMY_TAIL_WORDS = {"a", "an", "the", "and", "or", "with", "of", "in", "on",
                           "at", "to", "for", "from", "by", "over", "under", "into",
                           "that", "which", "its", "their", "his", "her"}


def _theme_enemy_subject(value):
    """Reduce a designed ENEMY line to the short subject the species designer wants.

    CUT AT A JOINER ONLY WHEN AT LEAST TWO WORDS COME BEFORE IT. That one condition is what
    separates a subject wearing a description from a compound subject:

        "armored tank | with chrome plating and glowing red eye sockets"  -> "armored tank"
        "person | with a chat bubble over their head"                     -> keep going

    In the first the head is already the whole subject and the tail is the look the species
    designer is supposed to invent for itself. In the second the head is a bare "person" and
    the qualifier IS the subject - cutting there throws away the entire idea, which for an
    enemy typed as "chat" is the difference between a Twitch viewer and a generic man.
    Anything that survives all that and is still rambling gets truncated on word count."""
    head = value.split(",")[0].strip()
    for m in _THEME_ENEMY_JOINER.finditer(head):
        before, after = head[:m.start()].strip(), head[m.end():].strip()
        # Two conditions, and both are needed. A one-word head means the qualifier IS the
        # subject ("person | with a chat bubble"). A SHORT tail means the qualifier is part of
        # the name rather than a look ("twitch viewer | with a glowing chat bubble"). Only a
        # real head carrying a real description gets cut.
        if len(before.split()) >= 2 and len(after.split()) > THEME_ENEMY_MAX_TAIL:
            head = before
            break
    words = head.split()
    if len(words) > THEME_ENEMY_MAX_WORDS:
        # Back off to the last clean break rather than stopping mid-phrase - a hard cut leaves
        # a dangling connective ("person with a chat bubble over") that reads as a truncation
        # to the image model as much as it does to a person.
        # Prefer the last PHRASE boundary that fits over a hard cut at the word limit: chopping
        # on the count alone leaves a dangling adjective ("tall filing cabinet with legs and
        # glowing"), which is no better than the dangling preposition it replaced.
        breaks = [i for i, w in enumerate(words)
                  if 2 <= i <= THEME_ENEMY_MAX_WORDS
                  and w.lower().strip(",") in _THEME_ENEMY_TAIL_WORDS]
        words = words[:breaks[-1]] if breaks else words[:THEME_ENEMY_MAX_WORDS]
        while len(words) > 1 and words[-1].lower().strip(",") in _THEME_ENEMY_TAIL_WORDS:
            words.pop()
        head = " ".join(words).rstrip(",")
    return head if head else value


def _theme_inline(value):
    """Make a designed line safe to drop into the middle of an existing sentence."""
    out = _THEME_ARTICLE.sub("", value).strip()
    # Lowercase the opening capital, but only when the rest of that word is lowercase - so
    # "Dense black server blades" relaxes while "RJ45", "LED" and "Windows" keep their case.
    head = out.split(" ", 1)[0]
    if head[1:].islower() or len(head) == 1:
        out = out[:1].lower() + out[1:]
    return out

# ---------------------------------------------------------------------------
# Hand-tuned ENEMY subjects - the words the set designer cannot be trusted with.
# ---------------------------------------------------------------------------
# The same escape hatch _style_bucket() is for the surfaces: when a typed word has a picture
# everyone already agrees on and the model keeps missing it, answer it in code and skip the
# argument. "chat" earned this one, reported from play as "they all look like robots".
#
# Every reading the designer offered was a THING rather than a PERSON - "floating chat
# bubble", "chat terminal", "chatbot". A thing goes into the bestiary as KIND: OBJECT, and
# that brief's rule 2 then asks for "machinery, mountings, housings and moving parts" to stop
# an object growing a face. Correct for a RAM stick, and for chat it produces three robots
# every single run - the failure is upstream of the bestiary, in what it was handed.
#
# What a person actually pictures on hearing "chat" is PEOPLE TALKING, and the emotes they
# talk in. So the subject is a person carrying the bubble, in the shape already proven to
# render both halves: the PERSON is the head noun and the bubble is what they hold. Written
# the other way round - "chat-bubble twitch viewer" - it renders a bubble and nobody (see
# _theme_enemy_subject).
#
# The person is ROLLED PER DUNGEON, so the run's three foes are one family of one kind of
# person and the next run is somebody else - the "random people" half of the request. All
# three variants still differ, because the bestiary designs them separately from this subject.
#
# WHERE THE BUBBLE GOES IS THE WHOLE JOB, and all of this was measured on rendered sprites
# rather than reasoned about - three earlier wordings were drawn and then thrown away by the
# pipeline itself, and a fourth hid the foe behind its own prop:
#
#  * A COLOUR, NEVER WHITE. A white bubble is drawn and then matted away - these sprites are
#    cut out of a pure white background, so white-on-white is invisible to BiRefNet and to
#    the eye. Purple survives the cut, reads as chat, and stays clear of the cyan the block
#    pose paints its barrier in, which a cyan bubble was getting confused with.
#  * IT MUST TOUCH THE FIGURE. keep_largest_figure keeps one connected blob, so a bubble
#    floating clear of the body is either deleted or - being the bigger shape - deletes the
#    foe. Sitting on the head with the tail down into the hair connects it. Same rule the
#    block-pose force field already lives under (see ENEMY_BLOCK_POSES).
#  * OVER THE HEAD, NOT HELD AND NOT BESIDE IT. "holding a speech bubble sign" drew the
#    reference photo faithfully and the placard then covered the foe's face in the corridor,
#    which is what the player reported. "Beside his head" is worse than either: the bubble
#    came back missing altogether on that wording, and an earlier try at it framed a chest-up
#    BUST, which drawEnemyContent scales against the idle frame and blows up into the camera.
#  * A FEW BIG FACES, NOT A CRUST OF SMALL ONES. "covered in emojis" packs eighty tiny faces
#    that collapse into a purple smear at corridor scale; three big ones stay readable.
#  * IT MUST NAME THE FEET, OR THE CHEST-UP BUST FROM THE BLOCK POSE COMES BACK HERE TOO.
#    Reported live on the FLYER of a "chat" theme: glasses, angel wings, bubble - everything
#    from the collarbone up, nothing below it, blown up to fill the combat view exactly like
#    the ENEMY_BLOCK_POSES "arms" clause once did (see the note above it). The cause is the
#    same one: this clause LEADS every LOOK line in the family and is entirely upper-body
#    content (head, hair, bubble), and the flyer's own look has no ground contact to counter
#    it with either. Reproduced 3 of 3 on fixed seeds with an unchanged subject and wings,
#    changing only this clause - and one of the three passed _enemy_frame_problem anyway,
#    because a wide wingspan alone satisfies ENEMY_MIN_FILL on its own; that guard cannot see
#    a bust with its arms (wings) spread. Adding "their whole body in view from head to feet"
#    turned the SAME three seeds into full-body sprites, 3 of 3 - stance-neutral wording on
#    purpose, since whether this family stands or hovers is still the LOOK's job, not this
#    clause's.
#
# The last three live in _CHAT_ENEMY_LOOK rather than in the subject, because the subject is
# repeated eight times inside the bestiary prompt and this is a 4B model that starts dropping
# labels when that prompt grows (see THEME_BRIEF_ATTEMPTS for what that failure looks like).
_CHAT_ENEMY_PEOPLE = [
    "young man", "young woman", "teenage boy", "teenage girl", "bearded man",
    "old man", "old woman", "guy in headphones", "girl in glasses", "hooded teenager",
]

_CHAT_ENEMY_SUBJECT = "{person} with a purple emoji speech bubble over their head"

# Put in FRONT of every LOOK line of this family on its way to krea2 - see _enemy_look_lead.
# It is the placement the image model needs and the bestiary has no reason to invent: bubble
# ABOVE the head, tail DOWN into the hair (contact), few and large faces.
#
# IN FRONT, NOT APPENDED, and that is not a style choice - it was the difference between a
# bubble and no bubble. Appended to the end of the flyer line ("...hovering midair with
# feathered wings spread wide...") the bubble vanished on both seeds tried; moved to the
# front of the same line, on the SAME two seeds, it rendered both times. A late clause is
# competing with everything already drawn, and wings win.
_CHAT_ENEMY_MARK = "purple emoji speech bubble"
_CHAT_ENEMY_LOOK = ("A purple speech bubble sits in the air above their head with three big "
                    "yellow emoji faces in it, its pointed tail reaching down to touch their "
                    "hair, their whole body in view from head to feet")

# Matched on WORD boundaries, not as substrings, so "chatbot" stays a robot for anyone who
# actually typed one - it is only the bare idea of chat that has no picture of its own.
_CHAT_ENEMY_WORDS = ("chat", "chats", "chatroom", "chatrooms", "chatter", "chatters",
                     "chatting", "emote", "emotes", "emoji", "emojis", "emoticon",
                     "emoticons")


def _enemy_literal(enemy_style):
    """The hand-tuned ENEMY subject for a typed word the designer keeps getting wrong, or
    None for everything else, which goes through generate_theme_brief as before."""
    ui = (enemy_style or "").strip().lower()
    if ui and any(match_word(re.escape(w), ui) for w in _CHAT_ENEMY_WORDS):
        return _CHAT_ENEMY_SUBJECT.format(person=random.choice(_CHAT_ENEMY_PEOPLE))
    return None


def _enemy_look_lead(species, enemy_style):
    """Put this family's hand-tuned placement clause in FRONT of each designed LOOK line.

    Kept OUT of the subject and bolted on here instead, for two reasons. The subject is
    repeated eight times inside the bestiary prompt, where every extra word costs reliability
    on a 4B model; and the clause is a drawing instruction, not part of the foe's identity -
    the bestiary has no reason to invent "its tail reaches down to touch their hair" and no
    reason to keep it if it did. Landing it here puts it in every variant and every pose
    frame, since all of them are built from these LOOK lines.

    Returns `species` unchanged for every other theme."""
    if not species or _CHAT_ENEMY_MARK not in (enemy_style or "").lower():
        return species
    for v in species.values():
        look = (v.get("look") or "").strip().rstrip(".").strip()
        if look:
            v["look"] = f"{_CHAT_ENEMY_LOOK}, {_theme_inline(look)}"
    print(f"[species] led all {len(species)} LOOK lines with the hand-tuned bubble placement")
    return species


# ============================================================================
# NAMED ENTITIES - quoted proper names in a typed field ("alley pond park", "manhattan",
# "goodcow", "Billy" the cat).
# ============================================================================
#
# Everything above turns a typed word into a DESCRIPTION - an adjective or common noun made
# drawable. There was no way to say "this is one specific thing that has a name" until now:
# double quotes mark a span as a proper name, and this section works out what KIND of thing it
# is so the rest of the pipeline can render the kind and keep the name in the TEXT layer (the
# crawl, the area title, the boss title) rather than painting it - see _door_sign for the one
# deliberate exception, and _theme_brief_surfaces for the instruction that keeps the rest of
# the art clean of it.
#
# PARSE BEFORE YOU ASK. The only network calls anywhere in this file go to local ComfyUI - there
# is no lookup service, so "look it up" can only mean asking Qwen3-VL 4B from its own weights,
# and a 4B model does not know Alley Pond Park and will not admit it. But most names never need
# that: the type is sitting in the string. "Billy" the cat states it outright. "alley pond
# park" and "roosevelt field mall" carry it as their own head noun. Only "goodcow" and
# "manhattan" - a name with no separating space, and a name genuinely famous enough to be worth
# asking about - fall through to anything resolved by a model.

# Double quotes only, straight or smart - NEVER the apostrophe. One shipped preset is
# "Pharaoh's Tomb", and treating every apostrophe as a name marker would misfire on it.
_NAME_QUOTE_RE = re.compile(r'"([^"]{1,60})"|“([^”]{1,60})”')
_NAME_MAX_SPANS_PER_FIELD = 4   # a hand-typed field is never going to name five different things

# Place/structure and settlement nouns a typed name's HEAD WORD can resolve to with no LLM
# call, plus a smaller creature/object set for the same purpose on the enemy/player/weapon
# fields. "center", "centre", "place", "building", "company" and "group" are DELIBERATELY not
# here: they are grammatical heads but useless art directions ("a center" draws nothing), so a
# name ending on one of them is routed to the identity call instead, which actually knows what
# the thing is.
_NAME_TYPE_NOUNS = frozenset((
    "park", "mall", "plaza", "square", "bridge", "station", "terminal", "beach", "island",
    "pond", "lake", "river", "creek", "stadium", "arena", "school", "college", "library",
    "museum", "theater", "theatre", "church", "cathedral", "temple", "castle", "tower",
    "lighthouse", "factory", "warehouse", "hospital", "prison", "hall", "mansion", "inn",
    "hotel", "motel", "bank", "store", "shop", "market", "deli", "diner", "cafe", "bakery",
    "pharmacy", "arcade", "zoo", "aquarium", "cemetery", "monument", "fountain", "gate",
    "subway", "airport", "harbor", "harbour", "pier", "dock", "farm", "ranch", "vineyard",
    "orchard", "garden", "forest", "canyon", "valley", "mountain", "volcano", "desert",
    "glacier", "reef", "cave", "tunnel", "dam", "mill", "chapel", "shrine", "palace",
    "fortress", "tavern", "pub", "bar", "gym", "rink", "pool", "track", "course", "trail",
    "city", "town", "village", "borough", "county", "state", "country", "nation",
    "neighborhood", "neighbourhood", "district", "province", "kingdom", "empire",
    "cat", "dog", "cow", "pig", "horse", "goat", "sheep", "bird", "fish", "bear", "wolf",
    "fox", "rat", "mouse", "bat", "duck", "goose", "owl", "bee", "ant", "spider", "snake",
    "turtle", "frog", "toad", "lion", "tiger", "elephant", "monkey", "rabbit", "deer", "elk",
    "moose", "camel", "llama", "donkey", "mule", "chicken", "rooster", "hen", "ram", "ewe",
    "robot", "truck", "car", "train", "boat", "ship", "plane", "sword", "hammer", "axe",
    "spear", "shield", "staff", "wand", "doll", "toy", "statue", "mascot",
))

# Two-word heads worth matching as a unit before the single-word pass above runs - "gas" alone
# means nothing, and "high school" wants both words read together even though "school" alone
# is already in the table.
_NAME_TYPE_PHRASES = frozenset((
    "gas station", "fire station", "police station", "train station", "bus station",
    "shopping mall", "high school", "middle school", "elementary school", "coffee shop",
    "book store", "grocery store", "department store", "bowling alley", "amusement park",
    "theme park", "water park", "national park", "state park", "city hall", "town hall",
    "movie theater", "movie theatre", "parking lot", "golf course",
    "country club", "night club", "strip mall", "outlet mall", "food court",
))

# Deliberately SHORT and hand-picked, not the full table above - the compound-suffix tier below
# is a last resort with no context to check itself against, and a 3-letter animal suffix
# collides with ordinary English often enough to be a real risk rather than a theoretical one:
# "ram" is "prog-RAM", "diag-RAM", "tele-RAM"; "bat" is "com-BAT", "acro-BAT"; "hen" is
# "kitc-HEN". All three read as plausible NAMES and clear a 4-letter prefix, so they are left
# out entirely rather than trusted to the prefix-length guard below.
_NAME_COMPOUND_NOUNS = (
    "cow", "dog", "cat", "pig", "fox", "owl", "hawk", "wolf", "bear", "lion",
    "mule", "goat", "deer", "duck", "swan", "toad", "frog", "mouse", "horse",
    "sheep", "snake", "robot", "demon", "ghost", "witch", "dragon",
)
_NAME_SUFFIX_MIN_PREFIX = 4   # "good|cow" clears it; a 3-letter prefix is coincidence too often


def _name_trailer_type(tail):
    """Read the words right after a closing quote - '"Billy" the cat', '"Billy", a cat',
    '"Billy" the enormous cat'. Up to 3 words after the article, the LAST one is the type.

    Trusted WITHOUT the noun table, unlike every other tier: the player stated the type
    outright, so '"Billy" the xenomorph' resolves too, which a table-driven tier never could.
    Highest priority for exactly that reason - it is the one tier that cannot be wrong about
    what the player meant."""
    m = re.match(r'^[\s,\(]*(?:the|an?)\s+((?:[a-zA-Z][a-zA-Z\-]*\s*){1,3})', tail or "", re.I)
    if not m:
        return None, None
    words = m.group(1).split()
    if not words:
        return None, None
    return _singular_creature_name(words[-1]).lower(), "trailer"


def _name_head_type(phrase):
    """Last two words against the phrase table, then the last word against the noun table -
    'alley pond park' -> park, 'roosevelt field mall' -> mall, both with no LLM call."""
    words = re.findall(r"[a-zA-Z]+(?:-[a-zA-Z]+)?", (phrase or "").lower())
    if not words:
        return None, None
    if len(words) >= 2:
        two = " ".join(words[-2:])
        if two in _NAME_TYPE_PHRASES:
            return two, "head"
    last = _singular_creature_name(words[-1])
    if last in _NAME_TYPE_NOUNS:
        return last, "head"
    return None, None


def _name_compound_type(token):
    """Single-token names only - 'goodcow' -> cow. Longest suffix wins; the prefix must clear
    _NAME_SUFFIX_MIN_PREFIX or an ordinary English word reads as somebody's pet (see that
    table's own comment for the 'combat'/'program' collisions this guards against).

    MUST run after the identity call, never before - see resolve_named_styles. Suffix-matching
    a compound first would misname "moscow" a cow before world knowledge gets a chance to say
    city, which is exactly the '"cat" fires on "cathedral"' failure this whole feature exists
    to avoid, one level up."""
    token = (token or "").lower()
    if not token.isalpha():
        return None, None
    best = None
    for noun in _NAME_COMPOUND_NOUNS:
        if token.endswith(noun) and len(token) - len(noun) >= _NAME_SUFFIX_MIN_PREFIX:
            if best is None or len(noun) > len(best):
                best = noun
    return (best, "compound") if best else (None, None)


def _norm_type(s):
    """Head word of a TYPE answer, lowercased and de-pluralized, so 'shopping mall' groups
    with 'mall' and 'boroughs' groups with 'borough' when two sampled replies are compared."""
    words = re.findall(r"[a-zA-Z]+", (s or "").lower())
    return _singular_creature_name(words[-1]) if words else None


def _named_style_text(ent):
    """The phrase that replaces one quoted span in the text handed to the LLM prompts.

    Known place -> its real-world framing, so the set designer can put what it's actually
    known for on the lantern/door/switch. Typed but unresolved-as-a-specific-instance -> a
    plain 'a TYPE called NAME' phrase; the rules already say a specific physical thing is kept
    as typed, so this just spells out what kind of thing it is. No kind resolved AT ALL -> the
    exact text between the quotes, unmodified - today's raw-word behaviour, verbatim."""
    kind = ent.get("kind")
    if not kind:
        return ent["raw"]
    if ent.get("known"):
        return f"{ent['name']}, the real {kind}"
    return f"{_a_or_an(kind)} called {ent['name']}"


def _apply_named_splices(text, entities):
    """Replace every entity's quoted span (span, incl. the quote marks) with _named_style_text's
    rewrite. Applied back-to-front so an earlier span's offsets stay valid after a later one is
    replaced. [] entities (the common, unquoted case) returns `text` completely untouched."""
    out = text or ""
    for ent in sorted(entities, key=lambda e: e["span"][0], reverse=True):
        s, e = ent["span"]
        out = out[:s] + _named_style_text(ent) + out[e:]
    return out


def _apply_named_splices_clean(text, entities):
    """Same shape as _apply_named_splices, but only strips the quote marks - no 'called' /
    'the real' rewrite. Used for the sfx/music prompts, which want the plain typed words, not
    a designed sentence fragment, and never see raw quote characters either way."""
    out = text or ""
    for ent in sorted(entities, key=lambda e: e["span"][0], reverse=True):
        s, e = ent["span"]
        out = out[:s] + ent["raw"] + out[e:]
    return out


def parse_named_styles(text):
    """Every quoted span in one typed field, as entity dicts:

        {"raw": "alley pond park", "name": "Alley Pond Park", "kind": "park",
         "source": "trailer"|"head"|"llm"|"compound"|None,
         "known": False, "landmarks": None, "span": (12, 29)}

    `kind` starts out set only when the trailer or head-noun tier could place it for free;
    resolve_named_styles fills in whatever is left via the identity call and the compound
    tier. [] when there are no quotes at all - the common case, and the one that has to leave
    everything downstream byte-identical to today."""
    text = text or ""
    out = []
    for m in list(_NAME_QUOTE_RE.finditer(text))[:_NAME_MAX_SPANS_PER_FIELD]:
        raw = (m.group(1) or m.group(2) or "").strip()
        if not raw:
            continue
        name = " ".join((w[:1].upper() + w[1:] if w else w) for w in raw.split())
        kind, source = _name_trailer_type(text[m.end():])
        if not kind:
            kind, source = _name_head_type(raw)
        out.append({"raw": raw, "name": name, "kind": kind, "source": source,
                    "known": False, "landmarks": None, "span": m.span()})
    return out


def _strip_proper_name(text, name):
    """Remove a known proper name (and a leftover 'called'/'named'/leading 'the') from a
    designed ENEMY line before it reaches the species designer - see
    generate_krea2_posed_bundle. A designed line for a named enemy reads "Billy the sleek black
    alley cat" (the set designer was handed "a cat called Billy" and kept the name, which the
    rules explicitly tell it to do for a specific physical thing) - repeated eight times inside
    _ENEMY_SPECIES_USER that would design three foes all named Billy, the outcome a named
    individual exists specifically to avoid (the name belongs on the BOSS alone).

    Falls back to the caller's own kind noun when stripping empties the line - a species
    designer needs something to anchor on, and "the cat" beats an empty sentence."""
    if not text or not name:
        return text
    out = re.sub(re.escape(name), "", text, flags=re.IGNORECASE)
    out = re.sub(r"\b(?:called|named)\b", "", out, flags=re.IGNORECASE)
    out = re.sub(r"^\s*the\b", "", out, flags=re.IGNORECASE)
    return re.sub(r"\s{2,}", " ", out).strip(" ,.-")


# ---------------------------------------------------------------------------
# The identity call - world knowledge for a name the free tiers above could not place.
# ---------------------------------------------------------------------------
NAME_ID_MAX_TOKENS = 400      # a handful of 3-line answers; generous for the common 1-2 names
NAME_ID_TEMPERATURE = 0.7     # obeying a reply format, not inventing - same reasoning as
                               # THEME_BRIEF_TEMPERATURE, not ENEMY_SPECIES_TEMPERATURE's 0.9
NAME_ID_SAMPLES = 2           # sampled twice and compared - see _vote_identity
NAME_ID_MAX_ITEMS = 8         # four fields x up to two names each is the realistic ceiling

NAME_ID_SYSTEM = (
    "You are a reference librarian for a 1990s dungeon crawler. You are given proper names "
    "and you say what KIND of thing each one is, in one common noun. You answer only about "
    "names you genuinely recognise. You never explain yourself and you never break format."
)


_NAME_ID_RULES = (
    "Rules:\n"
    "1. TYPE is ONE common noun for the kind of thing it is - \"mall\", \"park\", \"city\",\n"
    "   \"diner\", \"cat\". Never the name again, never an adjective.\n"
    "2. Write KNOWN: YES only if you recognise this particular one. If you are only\n"
    "   guessing from the words, write KNOWN: NO and still give your best TYPE.\n"
    "3. SEEN is two or three concrete things a visitor physically sees there, under twelve\n"
    "   words. Write NONE unless KNOWN is YES.\n\n"
    "Reply using EXACTLY these labels, each on its own line, in this order. No preamble, "
    "no markdown, no commentary, no asterisks:\n\n"
)


def _name_identity_prompt(items):
    """Same hand-built chat template as _theme_brief_prompt and _story_prompt - see either for
    why the <|im_start|> opener and the empty <think> block are both mandatory.

    A SINGLE item is asked for with BARE labels (TYPE/KNOWN/SEEN, no numbering) rather than
    the NAME1_ scheme used for a real list - measured live, a 4B model reliably drops a
    "NAME1_" prefix that has nothing to disambiguate ("rockefeller center" came back plain
    "TYPE: building" every time), which parse_name_identity was failing on ENTIRELY - not a
    partial loss, a silent total miss on the single-name case that is the overwhelming
    majority of real usage. The numbered form stays for an actual list, where the prefix is
    load-bearing and the model does use it."""
    if len(items) == 1:
        user = (f"A player typed this name: {items[0]}\n\n"
               "Say what kind of thing it is.\n\n" + _NAME_ID_RULES +
               "TYPE: <one common noun>\nKNOWN: <YES or NO>\nSEEN: <one line, or NONE>")
    else:
        numbered = "\n".join(f"{i + 1}. {it}" for i, it in enumerate(items))
        labels = "\n".join(
            f"NAME{i + 1}_TYPE: <one common noun>\n"
            f"NAME{i + 1}_KNOWN: <YES or NO>\n"
            f"NAME{i + 1}_SEEN: <one line, or NONE>"
            for i in range(len(items))
        )
        user = ("A player typed these names. Say what kind of thing each one is.\n\n"
               f"{numbered}\n\n" + _NAME_ID_RULES + labels)
    return (
        "<|im_start|>system\n" + NAME_ID_SYSTEM + "<|im_end|>\n"
        "<|im_start|>user\n" + user + "<|im_end|>\n"
        "<|im_start|>assistant\n"
        "<think>\n\n</think>\n\n"
    )


_NAME_ID_LABEL_RE = re.compile(r"^NAME(\d+)_(TYPE|KNOWN|SEEN)\s*:\s*(.*)$", re.IGNORECASE)
_NAME_ID_BARE_LABEL_RE = re.compile(r"^(TYPE|KNOWN|SEEN)\s*:\s*(.*)$", re.IGNORECASE)


def parse_name_identity(text, count):
    """{0-based index: {"type","known","seen"}} for whatever labels came back usable -
    per-item tolerant, the same contract as parse_theme_brief: one item missing a label is
    just that item answered a little less completely, not a reason to throw the reply away.

    Accepts the bare TYPE:/KNOWN:/SEEN: form ONLY when count == 1 - matching the single-item
    prompt shape above, and never risking misattributing a stray bare line to item 0 in an
    actual multi-item reply, where the numbered form is what was asked for and expected."""
    out = {}
    for raw_line in (text or "").splitlines():
        line = raw_line.strip().strip(_STORY_STRIP)
        m = _NAME_ID_LABEL_RE.match(line)
        if m:
            idx = int(m.group(1)) - 1
            field, value = m.group(2).upper(), m.group(3).strip().strip(_STORY_STRIP)
        elif count == 1:
            m2 = _NAME_ID_BARE_LABEL_RE.match(line)
            if not m2:
                continue
            idx, field, value = 0, m2.group(1).upper(), m2.group(2).strip().strip(_STORY_STRIP)
        else:
            continue
        if idx < 0 or idx >= count:
            continue
        item = out.setdefault(idx, {"type": None, "known": False, "seen": None})
        if field == "TYPE":
            value = _strip_negations(value)
            words = value.split()
            if 1 <= len(words) <= 3:
                item["type"] = value.lower()
        elif field == "KNOWN":
            item["known"] = value.upper().startswith("Y")
        elif field == "SEEN":
            if value and value.upper() != "NONE":
                item["seen"] = _strip_negations(value)[:120]
    return out


def _identify_attempt(items):
    payload = {
        # Byte-identical to _krea2_loaders()["k_clip"] on purpose - see generate_intro_story.
        "k_clip": {"inputs": {"clip_name": KREA2_CLIP, "type": "krea2", "device": "default"},
                   "class_type": "CLIPLoader"},
        "name_gen": {
            "inputs": {
                "clip": ["k_clip", 0],
                "prompt": _name_identity_prompt(items),
                "max_length": NAME_ID_MAX_TOKENS,
                "sampling_mode": "on",
                "sampling_mode.temperature": NAME_ID_TEMPERATURE,
                "sampling_mode.top_k": 64,
                "sampling_mode.top_p": 0.95,
                "sampling_mode.min_p": 0.05,
                "sampling_mode.repetition_penalty": 1.05,
                "sampling_mode.seed": random.randint(0, 2**32 - 1),
                "thinking": False,
                "use_default_template": False,
            },
            "class_type": "TextGenerate",
        },
        "name_out": {"inputs": {"source": ["name_gen", 0]}, "class_type": "PreviewAny"},
    }
    raw = _submit_and_collect_text(payload, "name_out", job_key="name_id")
    return parse_name_identity(raw, len(items))


def _vote_identity(items, samples):
    """Best-of-N type consensus, not self-report: a 4B model answers KNOWN: YES for names it
    has never heard of, so KNOWN alone is worthless - agreement ACROSS independently sampled
    replies is what abstention is actually measured on. A three-way split (one vote each for
    three different types) is not agreement, it is three different guesses, and abstains
    (kind stays None) rather than picking one arbitrarily."""
    out = []
    for idx in range(len(items)):
        votes = [s[idx] for s in samples if s.get(idx) and s[idx].get("type")]
        groups = {}
        for v in votes:
            nt = _norm_type(v["type"])
            if nt:
                groups.setdefault(nt, []).append(v)
        if not groups:
            out.append({"type": None, "known": False, "seen": None})
            continue
        kind, winners = max(groups.items(), key=lambda kv: len(kv[1]))
        if len(groups) > 1 and len(winners) * 2 <= len(votes):
            out.append({"type": None, "known": False, "seen": None})
            continue
        known = sum(1 for v in winners if v.get("known")) * 2 > len(winners)
        seen = next((v.get("seen") for v in winners if v.get("known") and v.get("seen")), None)
        out.append({"type": kind, "known": known, "seen": seen if known else None})
    return out


def identify_names(items):
    """World knowledge for names the free parsing tiers could not place. Batched - every
    still-unresolved name across all four typed fields goes in ONE call, so four quoted names
    cost two LLM calls, not eight. Never raises: any failure returns every item unresolved,
    which the caller already treats as 'render it as typed, unstyled'.

    Sampled twice and compared (see _vote_identity); a disagreement earns a third sample rather
    than accepting a coin flip on the one field this whole feature is judged on - two-must-agree
    would abstain the instant the model says "city" then "borough" for Manhattan, which is the
    one example this is most obliged to get right."""
    items = items[:NAME_ID_MAX_ITEMS]
    if not items:
        return []
    PROGRESS.add_job("name_id", "Identifying named places with Qwen3-VL...", 4, NAME_ID_MAX_TOKENS)
    try:
        t0 = time.time()
        samples = [_identify_attempt(items) for _ in range(NAME_ID_SAMPLES)]
        disagree = any(
            len({_norm_type(s[i]["type"]) for s in samples if s.get(i) and s[i].get("type")}) > 1
            for i in range(len(items))
        )
        if disagree:
            samples.append(_identify_attempt(items))
        result = _vote_identity(items, samples)
        for it, r in zip(items, result):
            print(f"[names] identify {it!r} -> {r['type'] or '(unresolved)'}"
                  f"{' known' if r['known'] else ''}")
        print(f"[names] {len(items)} name(s) identified in {time.time()-t0:.1f}s")
        return result
    except Exception as e:
        print(f"[names Error] {e} - names render as typed, unstyled")
        PROGRESS.finish_job("name_id")
        return [{"type": None, "known": False, "seen": None} for _ in items]


def resolve_named_styles(wall_style, player_style, weapon_style, enemy_style):
    """Parse every quoted proper name across the four typed fields and resolve what kind of
    thing each one is. Never raises - a resolution failure just leaves that field's entity
    without a kind, which _named_style_text already treats as 'no name resolved', i.e. today's
    plain pass-through behaviour.

    Returns {"wall": entity|None, "player": entity|None, "weapon": entity|None,
    "enemy": entity|None, "text": {field: rewritten str}, "clean": {field: quotes-stripped
    str}}. The FIRST entity in a field is what every single-value consumer uses (the bucket
    bypass, the landmark slot, the boss name) - a second name in the same field still gets
    spliced into `text`/`clean` correctly, it just isn't what titles the boss."""
    fields = {"wall": wall_style, "player": player_style,
              "weapon": weapon_style, "enemy": enemy_style}
    parsed = {k: parse_named_styles(v) for k, v in fields.items()}

    pending = [(k, i) for k, ents in parsed.items() for i, e in enumerate(ents) if not e["kind"]]
    if pending:
        try:
            results = identify_names([parsed[k][i]["raw"] for k, i in pending])
        except Exception as e:
            print(f"[names] identity lookup failed ({e}) - names render as typed, unstyled")
            results = []
        for (k, i), r in zip(pending, results):
            ent = parsed[k][i]
            if r.get("type"):
                ent["kind"], ent["source"] = r["type"], "llm"
                ent["known"] = bool(r.get("known"))
                ent["landmarks"] = r.get("seen") if ent["known"] else None
            else:
                # Last resort, and only now - see _name_compound_type on why running this
                # before the identity call would misname "moscow" a cow.
                kind, source = _name_compound_type(ent["raw"])
                if kind:
                    ent["kind"], ent["source"] = kind, source

    text, clean = {}, {}
    for k, v in fields.items():
        text[k] = _apply_named_splices(v or "", parsed[k])
        clean[k] = _apply_named_splices_clean(v or "", parsed[k])

    out = {k: (parsed[k][0] if parsed[k] else None) for k in fields}
    out["text"], out["clean"] = text, clean
    for k in fields:
        if out[k]:
            print(f"[names] {k}: \"{out[k]['raw']}\" -> {out[k].get('kind') or '(unresolved)'}"
                  f"{' (known)' if out[k].get('known') else ''} [{out[k].get('source')}]")
    return out


THEME_BRIEF_SYSTEM = (
    "You are the set designer for a 1990s first-person dungeon crawler. You are given the "
    "words a player typed and you turn each one into a concrete physical thing an artist can "
    "paint: real materials, real objects, real colours. "
    "You never explain yourself and you never break format."
)

# Rules 2, 3 and 7 are the ones that fix the reported bug; the rest are transcribed from
# failures already recorded elsewhere in this file. Rule 7 is not style advice - these prompts
# run on FLUX schnell and krea2 at cfg 1.0 with an inert negative, so a line describing what
# something ISN'T is a request to draw it (see _LANTERN_TAIL's comment for the incandescent
# bulb that got drawn every single time).
_THEME_BRIEF_SURFACES = """- WALL: what covers the corridor walls - what you would see facing one.
- FLOOR: the material underfoot.
- CEILING: the material overhead.
- LANTERN: ONE object from this world that could glow and light the corridor.
- DOOR: ONE door, SHUT, filling the opening as a solid slab you cannot see past, plus the
  archway around it. Say what the door leaf itself is made of, not just its frame - a word
  like "doorway", "portal" or "opening" describes a hole and gets you an empty arch.
- SWITCH: ONE small hand-sized object from this world, used as a lever handle.
"""


def _theme_brief_surfaces(wall_named=None):
    """The slot-description block above, plain for an ordinary typed theme, or with one
    appended sentence for a named place. Appended as a SENTENCE describing what the LANTERN,
    DOOR and SWITCH slots should draw FROM, not as a new rule in _theme_rules - that block's
    own comment records what a 6.6KB rules block already cost this model in reliability, and a
    named place is rare enough that it does not earn a permanent tax on every other run.

    Landmarks are deliberately steered at the three single-object slots and away from
    WALL/FLOOR/CEILING: those three have to tile (_THEME_RULES_SURFACE rules 1-2), because one
    texture covers one map square and a landmark would repeat down the whole corridor - the
    Statue of Liberty is not a wall material. The "never write its name" line answers the meme
    rule below, which otherwise actively teaches this model to caption things it draws."""
    body = _THEME_BRIEF_SURFACES
    if wall_named and wall_named.get("kind"):
        name, kind = wall_named["name"], wall_named["kind"]
        body += f"\n{name} is "
        if wall_named.get("known") and wall_named.get("landmarks"):
            body += (f"a real {kind}, known for {wall_named['landmarks']}. Put the things it "
                     f"is actually known for on the LANTERN, the DOOR and the SWITCH - the "
                     f"WALL, FLOOR and CEILING stay plain repeating {kind} material, never a "
                     f"single landmark object. ")
        else:
            body += f"a {kind}. "
        body += "Never write its name into the picture - the name is spoken, not painted.\n"
    return body

# The rules, split by which request shape needs them and numbered at build time.
#
# KEEP THESE SHORT. Every one of them was earned by a real failure, and the temptation is to
# explain each one at length - but this runs on a 4B model, and the rules block grew to 6.6KB
# across one afternoon of doing exactly that. The cost was not subtle: roughly one attempt in
# three stopped answering in the required format at all (empty reply, a bare "user" line, or
# THEME_BRIEF_SYSTEM echoed back), and the ENEMY line started collapsing to bare nouns like
# "person" because it could no longer hold every competing instruction at once. Say each rule
# once, in a sentence or two, and put the reasoning in a comment here instead of in the prompt.
#
# A bucketed theme is only asked for WEAPON and ENEMY, so it must not be shipped the surface
# rules as well - that is the entire point of having a short shape.

# Rule 2 (surfaces are a material OR a WALLPAPER of the theme's imagery) is what broke the
# "internet = server racks" reading: the brief used to demand a MATERIAL, and the only material
# answer for an idea is the hardware behind it. The existing `cat` and `people` keyword buckets
# have always been wallpapers, so this only lets the designed path do what they already do.
#
# ITS THIRD READING - THE VIEW OF A PLACE - is the same lesson reaching real places, and it is
# what shipped the white supermarket. Asked for "the material the corridor walls are made of",
# the model answered "glossy white plastic": correct, and a blank wall. A supermarket is not
# its paint, it is its aisles, and the run the player liked was the one whose line happened to
# start "glossy plastic aisles..." (measured contrast 51.0, against 4.1 for the paint answer).
# Measured on the shape this rule now asks for - "stocked supermarket aisles with bright
# product packaging and hanging price signage" - 56.3 / 61.6 / 65.1 across three seeds.
#
# Rule 3 no longer says "never a room, never a scene": the view down a real place HAS a
# vanishing point, and forbidding one is what pushed the answer back onto the bare wall. The
# hazard that rule actually guards against is a single big focal object repeating in every map
# square, so it now says that and only that.
#
# The examples were dropped from rule 2 at the same time, for the reason recorded further down
# under the enemy rules: a copyable answer gets copied. "cracked red brick with white mortar"
# opened NINE of the 36 designed walls in dungeon_sessions with the word "cracked".
_THEME_RULES_SURFACE = [
    """WALL, FLOOR and CEILING each show what this theme LOOKS like: the material itself named
   by its colours and its markings, or a wallpaper of the theme's own pictures repeated edge
   to edge, or - when the theme is a real place - the view you get standing inside it, its
   fittings and its signage included. Never the bare plaster behind all that.""",
    """Those three fill the frame edge to edge with detail spread evenly and no one big object
   at the centre, because one copy covers one square of the map and anything singular repeats
   down the whole corridor.""",
    """LANTERN, DOOR and SWITCH are one object each, three different objects, each obviously
   from THIS theme - a plain iron dungeon door belongs to no theme and is always wrong. The
   door is SHUT: a solid slab you cannot see past. Say what the leaf is made of.""",
    """Those three surfaces are lit by one lantern and the game darkens them further with
   distance, so give each one bold markings in strongly contrasting colours, readable from
   across a room. One even tone arrives on screen as an empty surface - if the theme's own
   colour is a plain one, say what is boldly printed, stacked or lit across it.""",
]

# The ENEMY rule is the one under the most tension: it has to be short (it becomes the {enemy}
# the bestiary brief repeats eight times), it has to keep whatever qualifier makes it that idea
# ("chat" -> a person WITH A BUBBLE, not a person), and the thing it fundamentally IS has to
# land last because that is the word the picture gets built around ("chat-bubble viewer" drew a
# bubble and no person). Earlier drafts spent a paragraph on each of those and the model
# answered "person".
_THEME_RULES_SUBJECT = [
    """WEAPON is one object held and swung in one hand, with a grip, reading correctly after
   the word "a". If the idea is a picture rather than a tool, mount it - a placard on a stick,
   a framed board with a handle - rather than swapping it for an unrelated novelty.""",
    """ENEMY is a NAME, not a description: the thing typed on the ENEMY line made concrete, in
   at most eight words, never a subject borrowed from the theme instead. End on the word for
   what it fundamentally IS, and keep whatever it must carry or wear to still read as that
   idea. A name so bare it would suit any dungeon has failed.""",
]

_THEME_RULES_ALWAYS_HEAD = [
    """Write physical description only - material, build, parts, and COLOURS. Always name the
   colours.""",
]

# Rule "pictures not plumbing" is the headline fix of this round. The example must stay
# uncopyable: an earlier version named a concrete answer and the model handed that exact string
# back as the enemy of two unrelated themes.
_THEME_RULES_ALWAYS_TAIL = [
    """An idea is drawn as its PICTURES, not its PLUMBING. For a word that is an idea, a
   pastime or a service, draw the things a person actually pictures on hearing it: its icons
   and symbols, the screens, pages, windows and signs it lives on, the links drawn between
   things. Never the equipment that runs it out of sight.""",
    """If the idea is pictures with words on them - a meme, a sign, a screen, a speech bubble -
   name the picture it carries and say the caption is short bold white block capitals with a
   heavy black outline. Without the words on it a meme is just a photo of an animal.""",
    """Describe only what is IN the picture. Never write what something is not, or lacks - every
   word you write gets drawn.""",
    """If the typed word is already a specific physical thing, keep it, adding at most a few
   words of material and colour.""",
    """One line each, under 25 words. No story, no mood, no explanation.""",
]


def _theme_rules(want_surfaces):
    """The numbered rule block for one request shape."""
    rules = list(_THEME_RULES_ALWAYS_HEAD)
    if want_surfaces:
        rules += _THEME_RULES_SURFACE[:3]
    rules += _THEME_RULES_SUBJECT
    rules += _THEME_RULES_ALWAYS_TAIL[:3]
    if want_surfaces:
        rules += _THEME_RULES_SURFACE[3:]
    rules += _THEME_RULES_ALWAYS_TAIL[3:]
    out = []
    for i, body in enumerate(rules, 1):
        lines = body.split("\n")
        pad = " " * (len(str(i)) + 2)
        out.append(f"{i}. " + lines[0].strip()
                   + "".join("\n" + pad + l.strip() for l in lines[1:]))
    return "\n".join(out)


_THEME_BRIEF_USER = """A player typed these words to describe a dungeon they want to explore:

THEME: {wall}
WEAPON: {weapon}
ENEMY: {enemy}

Some of those words may be abstract ideas rather than things - "internet", "memes", "chat",
"trippy". Your job is to decide what those ideas LOOK LIKE as a real physical place and real
physical objects, so an artist can paint them. Everything you write must belong to the same
one world, so a player walking through it sees a single coherent place.

Describe:
{slots}
Rules. Every line is fed straight to an image generator, so:

{rules}

Reply using EXACTLY these labels, each on its own line, in this order. No preamble, no
markdown, no commentary, no asterisks:

{labels}"""


def _theme_brief_prompt(wall_style, weapon_style, enemy_style, want_surfaces, wall_named=None):
    """Same hand-built chat template as _story_prompt and _enemy_species_prompt - see there for
    why the <|im_start|> opener and the empty <think> block are both mandatory.

    `wall_style`/`weapon_style`/`enemy_style` are expected to already be the REWRITTEN text
    (resolve_named_styles' "text" field) when a name was typed - see _named_style_text. This
    function does no name resolution of its own; `wall_named` only decides whether the slot
    block gets the landmark/no-paint sentence from _theme_brief_surfaces."""
    slots = THEME_SURFACE_SLOTS + THEME_SUBJECT_SLOTS if want_surfaces else THEME_SUBJECT_SLOTS
    body = _theme_brief_surfaces(wall_named) if want_surfaces else ""
    body += ("- WEAPON: the weapon the player swings.\n"
             "- ENEMY: the thing the player fights.\n")
    labels = "\n".join(f"{s.upper()}: <one line>" for s in slots)
    user = _THEME_BRIEF_USER.format(
        wall=(wall_style or "").strip() or "a forgotten place",
        weapon=(weapon_style or "").strip() or "a sword",
        enemy=(enemy_style or "").strip() or "something that shambles",
        slots=body, labels=labels, rules=_theme_rules(want_surfaces))
    return (
        "<|im_start|>system\n" + THEME_BRIEF_SYSTEM + "<|im_end|>\n"
        "<|im_start|>user\n" + user + "<|im_end|>\n"
        "<|im_start|>assistant\n"
        "<think>\n\n</think>\n\n"
    )


def parse_theme_brief(text, slots):
    """Pull the labelled lines out of the reply. Returns {slot: line} for whatever came back
    usable, which may be empty.

    PER-SLOT, not all-or-nothing. parse_enemy_species throws the whole reply away if any of
    its six foe labels is missing, because half a designed foe family is incoherent - one foe
    designed and two derived would silently mix two art directions. These slots are
    independent: a good WALL with a missing SWITCH is simply a good wall and the old switch,
    which is strictly better than today. So each slot stands or falls on its own, and anything
    dropped falls back to the raw-word wording that shipped before this existed.

    A line that survives negation-stripping as a fragment is treated as missing - the caller's
    fallback is a working prompt, so a doubtful line is never worth taking."""
    want = {s.upper(): s for s in slots}
    out = {}
    for raw_line in (text or "").splitlines():
        line = raw_line.strip().strip(_STORY_STRIP)
        if ":" not in line:
            continue
        label, _, value = line.partition(":")
        key = want.get(label.strip().upper())
        if not key or key in out:
            continue
        value = value.strip().strip(_STORY_STRIP)
        # krea2 and FLUX schnell both run at cfg 1.0 here, so a clause saying what something
        # ISN'T is a request to draw it. Same treatment the species LOOK lines get.
        value = _strip_negations(value)
        if len(value.split()) < 3:
            continue
        if key == "enemy":
            value = _theme_enemy_subject(value)
        # A tiling surface that describes its own detail as faint is describing a blank wall
        # at 4 steps - see _SURFACE_WASHOUT.
        if key in _THEME_TEXTURE_SLOTS:
            value = _strip_words(value, _SURFACE_WASHOUT, "washout", tag="theme")
        if key in _THEME_INLINE_SLOTS:
            value = _theme_inline(value)
        out[key] = value[:240]
    return out


def generate_theme_brief(wall_style, weapon_style, enemy_style, want_surfaces=True,
                         wall_named=None, enemy_named=None):
    """Turn the typed words into concrete drawable material. Never raises: on any failure
    returns None and every caller falls back to interpolating the typed words raw, which is
    exactly what shipped before this stage existed.

    `wall_named`/`enemy_named` are resolve_named_styles() entities (or None). `wall_named` only
    reaches _theme_brief_prompt's landmark sentence. `enemy_named` guards _enemy_literal below -
    a quoted "chat" the cat must not be hijacked into the hand-tuned Twitch-viewer subject just
    because the word "chat" still appears in its own rewritten name.

    `want_surfaces` is False when _style_bucket() matched a hand-tuned theme, because those
    buckets' surface prompts are literals that ignore the brief anyway - so the reply only has
    to carry WEAPON and ENEMY, and a two-label reply is far harder to come back malformed.

RETRIES ON A FRESH SEED, and they are not optional. Qwen3-VL fails here in two
    degenerate ways, both sampling outcomes rather than prompt faults - the same theme and the
    same prompt succeed on the seeds either side:
      - it echoes THEME_BRIEF_SYSTEM back word for word and answers nothing (two failures on
        two unrelated themes returned a byte-identical 278-character string);
      - it returns an empty string, or a bare "user" line.
    Re-rolling the seed is the entire fix. One retry was not enough: measured roughly one
    attempt in three failing on the eight-label shape, which still let a whole dungeon through
    on the raw typed words. Hence THEME_BRIEF_ATTEMPTS. Same shape as the
    _portrait_frame_diff retry."""
    slots = THEME_SURFACE_SLOTS + THEME_SUBJECT_SLOTS if want_surfaces else THEME_SUBJECT_SLOTS
    # A hand-tuned enemy wins over whatever comes back, and it also has to survive the reply
    # failing altogether - the failure path returns the typed word raw, which for "chat" is
    # the robot bug by another route. ENEMY is still ASKED for: the reply shape is what all
    # the reliability numbers here were measured on, and dropping a label off the short shape
    # to save a line the designer answers well enough is not worth re-measuring.
    literal = None if (enemy_named and enemy_named.get("kind")) else _enemy_literal(enemy_style)

    def _attempt():
        payload = {
            # Byte-identical to _krea2_loaders()["k_clip"] on purpose - see generate_intro_story.
            "k_clip": {"inputs": {"clip_name": KREA2_CLIP, "type": "krea2", "device": "default"},
                       "class_type": "CLIPLoader"},
            "theme_gen": {
                "inputs": {
                    "clip": ["k_clip", 0],
                    "prompt": _theme_brief_prompt(wall_style, weapon_style, enemy_style,
                                                  want_surfaces, wall_named),
                    "max_length": THEME_BRIEF_MAX_TOKENS,
                    "sampling_mode": "on",
                    "sampling_mode.temperature": THEME_BRIEF_TEMPERATURE,
                    "sampling_mode.top_k": 64,
                    "sampling_mode.top_p": 0.95,
                    "sampling_mode.min_p": 0.05,
                    "sampling_mode.repetition_penalty": 1.05,
                    "sampling_mode.seed": random.randint(0, 2**32 - 1),
                    "thinking": False,
                    "use_default_template": False,
                },
                "class_type": "TextGenerate",
            },
            "theme_out": {"inputs": {"source": ["theme_gen", 0]}, "class_type": "PreviewAny"},
        }
        raw = _submit_and_collect_text(payload, "theme_out", job_key="theme_brief")
        return raw, parse_theme_brief(raw, slots)

    try:
        t0 = time.time()
        # Re-roll when the reply lost MOST of its labels, not only when it lost all of them -
        # a badly truncated reply is the same coin flip and just as cheap to redo. A merely
        # partial reply is KEPT: parse_theme_brief already falls back per slot, so a good WALL
        # next to a missing SWITCH is still strictly better than the raw typed word.
        for attempt in range(1, THEME_BRIEF_ATTEMPTS + 1):
            raw, brief = _attempt()
            if len(brief) * 2 >= len(slots):
                break
            if attempt < THEME_BRIEF_ATTEMPTS:
                print(f"[theme] attempt {attempt} carried {len(brief)}/{len(slots)} labels, "
                      f"re-rolling the seed - {raw[:160]!r}")
        if not brief:
            print(f"[theme] reply still carried none of the {len(slots)} labels - "
                  f"using the typed words as they are - {raw[:200]!r}")
            return {"enemy": literal} if literal else None
        if literal:
            brief["enemy"] = literal
        for s in slots:
            got = brief.get(s)
            if s == "enemy" and literal:
                print(f"[theme] {s:8s} {got}  (hand-tuned, the designed line is ignored)")
                continue
            print(f"[theme] {s:8s} {got if got else '(missing - using the typed words)'}")
        print(f"[theme] set designed in {time.time()-t0:.1f}s")
        return brief
    except Exception as e:
        print(f"[theme Error] {e} - using the typed words as they are")
        PROGRESS.finish_job("theme_brief")
        return {"enemy": literal} if literal else None

def _a_or_an(noun):
    return ("an " if noun[:1].lower() in "aeiou" else "a ") + noun


def krea2_enemy_prompt(enemy_style, variant="walker", tighten=0):
    """One enemy idea, three battlefield roles (`variant` = walker / flyer / boss).

    Two things this prompt has to get right, both learned the hard way:

    1. SIZE. It asks the subject to FILL the frame. The previous version asked for the
       creature "small, with a large empty margin" as insurance against a dragon's wingtips
       being clipped - and the model obliged, spending ~4% of a 512x512 canvas on the
       creature. Measured on real output: the saved sprites were 62x89 to 94x114 px, so
       blowing one up to ~140px on screen was an upscale of a thumbnail. Filling the frame
       instead measured 144x511 (RAM), 509x512 (mushroom person) and 508x191 (winged
       dragon) - 4-5x the linear resolution, and the dragon's wingspan came back complete,
       so the margin was never what was protecting it. This is the same fix already applied
       to the v6 player frames for the same reason.

    2. IDENTITY. The subject is named first and repeated, and the "enemy" framing is applied
       CONDITIONALLY. The old wording led with the pose ("menacing combat-ready stance") and
       demanded "head, body, both feet ... horns, tail, claws", which are creature parts - so
       a non-creature noun like "RAM stick" lost the argument and came back as a monster.
       Leading with the literal object and letting the animation clause opt out for things
       that aren't alive renders an actual DDR module, verified.

    3. EVERY CLAUSE IS POSITIVE. krea2 runs at cfg 1.0 with a ConditioningZeroOut negative,
       so there is NO negative guidance - every word in this string is something the model is
       being asked to draw. An earlier flyer clause read "instead of replacing it with a bird,
       a bat or any other winged animal" and reliably produced a bird, because "bird" and
       "bat" were positive conditioning. Nothing here may name a thing we do not want; state
       only what the picture should contain.

    Per-variant `look` clauses exist so the three foes are told apart at a glance in combat -
    on one subject the walker and the boss otherwise came back as near-identical images.

    `tighten` (0..2) is the retry lever for _krea2_regen_enemy and now only widens the margin
    a little - it never goes back to asking for a small subject."""
    e = enemy_style.strip() if (enemy_style and enemy_style.strip()) else "fearsome dragon with wide outstretched wings"
    margin = [
        "only a thin margin around it",
        "a modest even margin around it",
        "a comfortable even margin around it",
    ][min(int(tighten), 2)]

    fill_tb = (f"Drawn LARGE and filling the frame from top to bottom, the top of it near the "
               f"top edge and the base near the bottom edge, with {margin}")

    if variant == "flyer":
        # Purely additive phrasing: the wings are an attachment to the unchanged subject. Any
        # mention of what it must NOT become is conditioning for exactly that (see 3 above).
        role = (f"A pair of huge wings are attached to {e} itself, spread wide and fully "
                f"outstretched to either side, and it hovers in mid-air well clear of the "
                f"ground. {e} keeps its own exact shape, proportions and surface, with the "
                f"broad outstretched wings simply attached to it")
        look = (f"Its colouring is lighter and paler than usual, sun-bleached and airy, "
                f"catching a bright highlight from above")
        fill = (f"Drawn LARGE and filling the frame edge to edge, the wingtips reaching out "
                f"close to the left and right edges and the body filling the height, with "
                f"{margin}")
    elif variant == "boss":
        role = (f"It is the colossal, hulking boss form of {e} - massively built, thickset and "
                f"towering, heavily reinforced with jagged dark metal armour plating bolted "
                f"across it, looming over the viewer")
        look = (f"Its colouring is far darker and heavier than usual - blackened, deeply "
                f"shadowed tones shot through with glowing molten red seams, its surface "
                f"scorched, cracked, pitted and battle-scarred")
        fill = fill_tb
    else:
        role = (f"It faces the camera head-on, squarely on the ground in a menacing, "
                f"combat-ready fighting stance")
        look = (f"Its colouring is its ordinary, natural, everyday one, clean, bright and "
                f"undamaged")
        fill = fill_tb

    # NOTE there is deliberately no "brought to life as a monster opponent ... given eyes and
    # small limbs" clause. It used to sit here and it is the same bug as rule 3: "monster" is a
    # character noun and "eyes and limbs" is creature anatomy, both as positive conditioning.
    # It passed testing and then turned a RAM stick into a scaly beast in a real run - a coin
    # flip, not a fix. The enemy-ness comes from the stance clause and from whatever the player
    # actually typed ("taco monster" still gets a monster); the subject itself is left alone.
    return (
        f"A full-body video game enemy sprite of {e}. The subject is literally {e}, drawn "
        f"exactly as {e} really looks, with the true shape, proportions, colours and details "
        f"of {e}, instantly recognisable as {e} at a glance. {role}. {look}. {fill}, the "
        f"whole thing completely inside the picture with nothing cut off at any edge. "
        f"Dramatic even lighting, sharp detailed textures. Plain solid pure white "
        f"background, nothing else in frame."
    )


def krea2_species_prompt(look, enemy_style="", tighten=0, pose="idle", guard=None):
    """The prompt for an LLM-designed foe (generate_enemy_species). This is the normal path;
    krea2_enemy_prompt above is the fallback.

    Deliberately much thinner than krea2_enemy_prompt. That one has to argue a single typed
    noun into three different roles, which is where every identity failure in this pipeline
    came from - the role clauses ("a pair of huge wings attached to it", "the colossal
    hulking boss form of it, heavily reinforced with jagged dark metal armour plating") are
    strong enough priors to overrule the subject and hand back a bird or an armoured demon.
    Here the differences between the three foes are already baked into `look`, so there is
    nothing left to argue and no role clause at all. All this adds is framing, lighting and
    the fill-the-frame sizing rule that every sprite prompt in this file needs.

    THE TYPED NOUN IS RE-ANCHORED HERE and not left to the description. Asked to design three
    dragons the LLM wrote "Heavy, scaled armor with jagged teeth and spiked limbs, dark
    bronze with rust streaks, standing on two thick legs" - a perfectly good description that
    never says "dragon" once, and would have rendered generic armour. It writes the
    DIFFERENCES between the three foes and drops the thing they have in common, which is
    exactly the word the image model most needs. Naming it here costs nothing when the
    description does mention it; krea2 wants the subject repeated anyway."""
    subject = (look or "").strip().rstrip(".").strip() or "a shadowy nightstalker demon"
    e = (enemy_style or "").strip()
    # The block frame always gets one step more margin than the rest. A guard is a WIDER,
    # taller shape than an idle - arms out to the sides, or a barrier standing across the
    # whole front - and at the thin margin krea2 satisfied "fill the frame" by cropping in to
    # a bust instead of drawing the foe smaller. One step of margin gives it the room to
    # choose the other way. See the framing rule on ENEMY_BLOCK_POSES.
    # The strike frame does NOT take that step, though its burst is wide too. Every frame is
    # drawn at the idle's scale, so a strike drawn smaller in its canvas makes the foe visibly
    # shrink on the very tick its blow lands - and at the idle's thin margin it came back
    # unclipped on 6 of 6 test foes anyway. The re-frame retry still widens it if one clips.
    if pose == "block":
        tighten = max(int(tighten or 0), 1)
    margin = [
        "only a thin margin around it",
        "a modest even margin around it",
        "a comfortable even margin around it",
    ][min(int(tighten), 2)]
    anchor = (f"A full-body video game enemy sprite of {e}. This particular {e} is {subject}. "
              f"The subject is literally {e}, drawn exactly as described above and instantly "
              f"recognisable as {e} at a glance."
              if e else
              f"A full-body video game enemy sprite of {subject}. The subject is exactly "
              f"that, drawn precisely as described and instantly recognisable at a glance.")
    # "It STANDS facing the viewer" was tried and softened: it is a ground cue, and the flyer
    # is meant to be off the ground. Whether it stands or hovers is the LOOK's job. The rest
    # of the pose comes from ENEMY_FRAME_POSES, or from ENEMY_BLOCK_POSES for the block frame,
    # where `guard` says which of the three guards suits this foe. All frames of one foe share
    # a seed, so the pose clause is the only thing that differs between them - which is also
    # why the block clause has to change the silhouette to be seen at all.
    if pose == "block":
        stance = ENEMY_BLOCK_POSES.get(guard) or ENEMY_BLOCK_POSES["field"]
    else:
        stance = ENEMY_FRAME_POSES.get(pose) or ENEMY_FRAME_POSES["idle"]
    return (
        f"{anchor} {stance}. Drawn LARGE and filling the "
        f"frame edge to edge, with {margin}, the whole thing completely inside the picture "
        f"with nothing cut off at any edge. Dramatic even lighting, sharp detailed textures. "
        f"Plain solid pure white background, nothing else in frame."
    )


# ---------------------------------------------------------------------------
# HUD portrait set - krea2 idle bust, then FLUX.1 Kontext expression edits.
# ---------------------------------------------------------------------------
# The four doom-face frames (idle/attack/block/hurt, indexed idle=0/attack=1/block=2/
# hurt=3 by the frontend). Every earlier approach failed on the SAME wall: krea2 turbo
# has no IPAdapter and an img2img resample either doesn't change the expression (low
# denoise) or changes the whole character (high denoise) - proven on cats and faces.
#
# So: krea2 generates ONE idle bust, then FLUX.1 Kontext (a real instruction-edit model)
# is handed that image three times with "change ONLY the expression, keep the face". Krea
# holds the art style for the idle; Kontext holds the identity for the three reactions.
# Tested on cat + bald viking: identity locked, eyes-closed / open-mouth roar / closed-
# mouth glare all render cleanly.
KREA2_PORTRAIT_EXPRESSIONS = {"idle": "a calm, level expression"}

KONTEXT_UNET = "flux1-dev-kontext_fp8_scaled.safetensors"
FLUX_T5      = "t5xxl_fp8_e4m3fn.safetensors"
FLUX_CLIP_L  = "clip_l.safetensors"
FLUX_AE      = "ae.safetensors"
KONTEXT_STEPS = 20            # Kontext-dev; quality/speed knob (~10s/frame at 256px / 20 steps)
KONTEXT_GUIDANCE = 3.5        # default for Kontext edits (enemy variants use this)
KONTEXT_PORTRAIT_GUIDANCE = 4.0   # portraits push harder: at 3.5 the eyes/brow barely moved
                                  # and a "mouth-closed" block frame often came out == idle
KONTEXT_PORTRAIT_MIN_DIFF = 4.0   # a reaction frame this close (grey mean-abs, 0-255) to idle
                                  # is treated as "the edit did nothing" and regenerated once
# Portrait working resolution. The pipeline deliberately does NOT use FluxKontextImageScale
# (which snaps to ~1MP and cost ~50s/frame) - the HUD slot is ~112px so it does not need it.
# 256 is the floor: at 128 Kontext can still do the big change (open-mouth attack) but the
# subtle edits (closed-mouth glare, eyes-shut wince) stop rendering at that latent size.
KONTEXT_PORTRAIT_RES = 256

# One edit instruction per reaction frame. Kontext responds to imperative "change X, keep
# everything else" phrasing - the long "keep the exact same face..." tail is what pins the
# identity, so keep it on every edit. Each edit calls out the EYES / BROW / FOREHEAD and
# the WHOLE face explicitly, not just the mouth - at low guidance Kontext moved mainly the
# mouth and left the eyes near-neutral. `block` also gets visible mouth/jaw TENSION (not
# just "closed") so it doesn't come back identical to idle on a face whose eyes are hidden
# behind glasses.
_KEEP = ("Keep the exact same face, identity, head shape, hair, skin, any glasses, colours, "
         "lighting, pose and framing - change nothing else.")
KONTEXT_EXPRESSION_EDITS = {
    "attack": f"Change the facial expression to berserk fury: mouth wide open roaring, teeth "
              f"bared; the eyes wide and bulging with rage in a wild wide-eyed furious stare "
              f"with the whites showing, eyebrows slammed straight down and jammed hard "
              f"together, deep creases gouged into the forehead and between the brows, nostrils "
              f"flared, the whole face contorted and straining with rage. {_KEEP}",
    "block":  f"Change the facial expression to a furious grim glare with the mouth kept shut: "
              f"jaw clenched hard so the jaw muscles stand out, mouth set in a tense hard "
              f"grimace with the lips pressed thin and the corners pulled down, eyes narrowed "
              f"to angry slits glaring dead ahead, eyebrows wrenched down and inward, deep "
              f"vertical creases between the brows, nostrils flared, chin tucked and head "
              f"lowered slightly - a braced, aggressive, defiant stare. {_KEEP}",
    "hurt":   f"Change the facial expression to anguished pain and grief: both eyes squeezed "
              f"tightly shut, eyebrows pulled upward and together into a pained sorrowful knot, "
              f"the whole face crumpled and grimacing, mouth open and pulled down at the "
              f"corners as if crying out, forehead and cheeks tense with distress. {_KEEP}",
}


def krea2_portrait_prompt(player_style, expression=None):
    p = player_style.strip() if (player_style and player_style.strip()) else "armored warrior knight"
    expr = expression or KREA2_PORTRAIT_EXPRESSIONS["idle"]
    return (
        f"A head and shoulders portrait bust of one {p}, facing the viewer with {expr}, "
        f"the head filling the upper frame and the shoulders squared at the bottom. "
        f"Video game status-screen portrait, Doom and Valbrace style, dramatic lighting. Plain "
        f"uncluttered solid background."
    )


def _kontext_alpha_nodes(payload, name, image_node, prefix):
    """RemoveBackground -> InvertMask -> SaveImageWithAlpha for one image node."""
    payload[f"{name}_mask"] = {"inputs": {"bg_removal_model": ["bg_model", 0], "image": [image_node, 0]}, "class_type": "RemoveBackground"}
    payload[f"{name}_inv"] = {"inputs": {"mask": [f"{name}_mask", 0]}, "class_type": "InvertMask"}
    payload[f"{name}_save"] = {"inputs": {"filename_prefix": f"{prefix}_{name}_{int(time.time()*1000)}",
                                          "images": [image_node, 0], "mask": [f"{name}_inv", 0]},
                               "class_type": "SaveImageWithAlpha"}


def _portrait_frame_diff(idle_path, frame_path):
    """Mean absolute grey difference (0-255) between two RGBA busts, each composited on a
    flat grey. Near 0 means the Kontext edit changed essentially nothing - which happens on
    a 'mouth closed' block frame for a face whose eyes are hidden behind glasses."""
    from PIL import Image
    import numpy as np
    def _grey(p):
        im = Image.open(p).convert("RGBA")
        bg = Image.new("RGBA", im.size, (128, 128, 128, 255))
        return np.asarray(Image.alpha_composite(bg, im).convert("L").resize((128, 128)), dtype=float)
    try:
        return float(np.abs(_grey(idle_path) - _grey(frame_path)).mean())
    except Exception as e:
        print(f"[Portrait Diff Error] {e}")
        return 99.0


def _kontext_expression_job(idle_in, targets, guidance, seed, with_idle=False,
                            job_key="portrait_edits"):
    """One Kontext job: edit the RGB idle image `idle_in` (a filename in COMFY_INPUT_DIR)
    into each expression name in `targets`. `with_idle=True` also emits a background-removed
    copy of the idle itself (matting only, no sampler) so every frame shares the same matte.
    Returns {name: path}, each background-removed."""
    b = {
        "unet": {"inputs": {"unet_name": KONTEXT_UNET, "weight_dtype": "default"}, "class_type": "UNETLoader"},
        "clip": {"inputs": {"clip_name1": FLUX_T5, "clip_name2": FLUX_CLIP_L, "type": "flux"}, "class_type": "DualCLIPLoader"},
        "vae":  {"inputs": {"vae_name": FLUX_AE}, "class_type": "VAELoader"},
        "bg_model": {"inputs": {"bg_removal_name": BIREFNET_MODEL}, "class_type": "LoadBackgroundRemovalModel"},
        "load":  {"inputs": {"image": idle_in}, "class_type": "LoadImage"},
        "enc":   {"inputs": {"pixels": ["load", 0], "vae": ["vae", 0]}, "class_type": "VAEEncode"},
    }
    want = list(targets)
    if with_idle:
        _kontext_alpha_nodes(b, "idle", "load", "kxp")
        want = ["idle"] + want
    for name in targets:
        b[f"{name}_pos"] = {"inputs": {"text": KONTEXT_EXPRESSION_EDITS[name], "clip": ["clip", 0]}, "class_type": "CLIPTextEncode"}
        b[f"{name}_ref"] = {"inputs": {"conditioning": [f"{name}_pos", 0], "latent": ["enc", 0]}, "class_type": "ReferenceLatent"}
        b[f"{name}_g"]   = {"inputs": {"conditioning": [f"{name}_ref", 0], "guidance": guidance}, "class_type": "FluxGuidance"}
        b[f"{name}_neg"] = {"inputs": {"conditioning": [f"{name}_pos", 0]}, "class_type": "ConditioningZeroOut"}
        b[f"{name}_samp"] = {"inputs": {"seed": seed, "steps": KONTEXT_STEPS, "cfg": 1.0,
                                        "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                                        "model": ["unet", 0], "positive": [f"{name}_g", 0],
                                        "negative": [f"{name}_neg", 0], "latent_image": ["enc", 0]},
                             "class_type": "KSampler"}
        b[f"{name}_dec"] = {"inputs": {"samples": [f"{name}_samp", 0], "vae": ["vae", 0]}, "class_type": "VAEDecode"}
        _kontext_alpha_nodes(b, name, f"{name}_dec", "kxp")
    return _krea2_submit_and_collect(b, want, timeout=400, job_key=job_key)


def generate_kontext_portrait_set(player_style, size=KONTEXT_PORTRAIT_RES):
    """Four HUD portrait busts: a krea2 idle, then FLUX.1 Kontext expression edits of it.

    Job A (krea2): one idle bust at `size` px, plain RGB.
    Job B (Kontext, `_kontext_expression_job`): edit the idle into attack/block/hurt (no
    FluxKontextImageScale - see KONTEXT_PORTRAIT_RES). Any reaction frame that comes back
    within KONTEXT_PORTRAIT_MIN_DIFF of the idle (the edit did nothing - common for a
    glasses-wearer's 'mouth closed' block) is regenerated once at a higher guidance + a
    fresh seed. Returns a 4-list in PORTRAIT_FRAME_NAMES order (each background-removed,
    bad frames fall back to idle); None if even idle fails."""
    seed = random.randint(1, 1000000000)

    # --- Job A: krea2 idle bust (no background removal - Kontext needs the full RGB) ---
    a = _krea2_loaders()
    a["idle_pos"] = {"inputs": {"text": krea2_portrait_prompt(player_style), "clip": ["k_clip", 0]}, "class_type": "CLIPTextEncode"}
    a["idle_neg"] = {"inputs": {"conditioning": ["idle_pos", 0]}, "class_type": "ConditioningZeroOut"}
    a["idle_lat"] = {"inputs": {"width": size, "height": size, "batch_size": 1}, "class_type": "EmptyLatentImage"}
    a["idle_samp"] = {"inputs": {"seed": seed, "steps": KREA2_STEPS_DEFAULT, "cfg": KREA2_CFG,
                                 "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                                 "model": ["k_unet", 0], "positive": ["idle_pos", 0],
                                 "negative": ["idle_neg", 0], "latent_image": ["idle_lat", 0]},
                      "class_type": "KSampler"}
    a["idle_dec"] = {"inputs": {"samples": ["idle_samp", 0], "vae": ["k_vae", 0]}, "class_type": "VAEDecode"}
    a["idle_save"] = {"inputs": {"filename_prefix": f"kxp_src_{int(time.time()*1000)}", "images": ["idle_dec", 0]}, "class_type": "SaveImage"}
    idle_src = _krea2_submit_and_collect(a, ["idle"], job_key="portrait_idle")["idle"]

    idle_in = f"kxp_src_{int(time.time()*1000)}.png"
    shutil.copy(idle_src, os.path.join(COMFY_INPUT_DIR, idle_in))

    # --- Job B: Kontext expression edits (+ retry for any frame that barely moved) ---
    reactions = [n for n in PORTRAIT_FRAME_NAMES if n != "idle"]
    paths = _kontext_expression_job(idle_in, reactions, KONTEXT_PORTRAIT_GUIDANCE, seed, with_idle=True)

    stuck = [n for n in reactions
             if _portrait_frame_diff(paths["idle"], paths[n]) < KONTEXT_PORTRAIT_MIN_DIFF]
    if stuck:
        print(f"[Kontext Portrait] {stuck} barely changed - regenerating at higher guidance")
        PROGRESS.add_job("portrait_regen", "Re-rolling the portraits that did not move...",
                         15 * len(stuck), len(stuck) * KONTEXT_STEPS)
        retry = _kontext_expression_job(idle_in, stuck, KONTEXT_PORTRAIT_GUIDANCE + 2.5,
                                        random.randint(1, 1000000000),
                                        job_key="portrait_regen")
        paths.update(retry)

    frames = [paths[n] if crop_portrait_square(paths[n]) else None for n in PORTRAIT_FRAME_NAMES]
    fallback = frames[0] or next((p for p in frames if p), None)
    if not fallback:
        return None
    print(f"[Kontext Portrait] 4-frame doom-face set for '{player_style}'")
    return [p or fallback for p in frames]


def _round16(n, floor=256):
    return max(floor, int(round(float(n) / 16.0)) * 16)


def _save_tight(img_path, thresh=20):
    """Trim an RGBA PNG to its alpha bounding box, in place. BiRefNet already cut the
    background, so this only removes the empty margin the model left around the subject.
    A higher `thresh` (enemy) ignores a faint halo so the crop lands on the real subject."""
    from PIL import Image
    try:
        img = _tight_crop(Image.open(img_path).convert("RGBA"), thresh)
        img.save(img_path, format="PNG")
    except Exception as e:
        print(f"[Tight Crop Error] {os.path.basename(img_path)}: {e}")


def generate_flux_surfaces_only(wall_style, gfx=None, brief=None, wall_named=None):
    """Just the wall / ceiling / floor thirds of generate_flux_all_assets. v5 keeps FLUX
    schnell for the tiling environment textures and generates everything else with krea2.

    `gfx` is a GFX_QUALITY_PROFILES entry - `texture` sizes the tiling surfaces and `object`
    the switch/lantern cutouts (512/384 normal & optimized, 256/192 reduced).

    `brief` is a generate_theme_brief() dict (or None); it only reaches the generic branch of
    the two prompt builders, so a bucketed theme renders exactly as it always has. `wall_named`
    is passed straight through to both - see get_surface_prompts/get_gate_prompts."""
    gfx = gfx or GFX_QUALITY_PROFILES[GFX_QUALITY_DEFAULT]
    PROGRESS.begin_job("surfaces")
    tile_px = gfx["texture"]     # wall / ceiling / floor / door
    obj_px = gfx["object"]       # switch off / switch on / lantern cutouts
    prefixes = {"w": f"trio_w_{int(time.time()*1000)}",
                "c": f"trio_c_{int(time.time()*1000)}",
                "f": f"trio_f_{int(time.time()*1000)}",
                "l": f"trio_l_{int(time.time()*1000)}",
                "d": f"trio_d_{int(time.time()*1000)}",
                "s": f"trio_s_{int(time.time()*1000)}"}
    wall_p, ceil_p, floor_p, lantern_p = get_surface_prompts(wall_style, brief, wall_named)
    door_p, switch_p = get_gate_prompts(wall_style, brief, wall_named)

    def _surface(tag, prompt_text):
        return {
            f"{tag}_lat": {"inputs": {"width": tile_px, "height": tile_px, "batch_size": 1}, "class_type": "EmptyLatentImage"},
            f"{tag}_pos": {"inputs": {"text": prompt_text, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
            f"{tag}_samp": {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0,
                                       "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                                       "model": ["1", 0], "positive": [f"{tag}_pos", 0], "negative": ["neg", 0],
                                       "latent_image": [f"{tag}_lat", 0]}, "class_type": "KSampler"},
            f"{tag}_dec": {"inputs": {"samples": [f"{tag}_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"},
            f"{tag}_save": {"inputs": {"filename_prefix": prefixes[tag], "images": [f"{tag}_dec", 0]}, "class_type": "SaveImage"},
        }

    payload = {
        "1": {"inputs": {"ckpt_name": FLUX_SCHNELL_CKPT}, "class_type": "CheckpointLoaderSimple"},
        "neg": {"inputs": {"text": "cartoon, anime, 2d, low quality, pixelated, 16-bit, clipart, drawing, blurry, watermark", "clip": ["1", 1]}, "class_type": "CLIPTextEncode"},
    }
    payload.update(_surface("w", wall_p))
    payload.update(_surface("c", ceil_p))
    payload.update(_surface("f", floor_p))
    # Door is a single full-cell surface (one door per map cell), so like the three tiling
    # textures it gets a plain opaque SaveImage - but it is NOT run through make_seamless_4way
    # below, because it must not tile.
    payload.update(_surface("d", door_p))

    # BiRefNet loader - shared by the lantern and the switch cutouts below.
    payload["bg_model"] = {"inputs": {"bg_removal_name": BIREFNET_MODEL}, "class_type": "LoadBackgroundRemovalModel"}

    # Switch is an isolated object (a wall lever), matted onto the wall on the client the same
    # way the lantern is - so it gets its own square canvas + BiRefNet cutout. ONE render, of
    # the resting/off pose only: the client derives the thrown pose from this cutout's own
    # pixels by inverting its colours (buildSwitchWallTextures). See get_gate_prompts for the
    # two generated-ON-pose approaches that were tried here first and why neither worked.
    payload["s_lat"] = {"inputs": {"width": obj_px, "height": obj_px, "batch_size": 1}, "class_type": "EmptyLatentImage"}
    payload["s_pos"] = {"inputs": {"text": switch_p, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"}
    payload["s_samp"] = {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0,
                                    "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                                    "model": ["1", 0], "positive": ["s_pos", 0], "negative": ["neg", 0],
                                    "latent_image": ["s_lat", 0]}, "class_type": "KSampler"}
    payload["s_dec"] = {"inputs": {"samples": ["s_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"}
    payload["s_mask"] = {"inputs": {"bg_removal_model": ["bg_model", 0], "image": ["s_dec", 0]}, "class_type": "RemoveBackground"}
    payload["s_maskinv"] = {"inputs": {"mask": ["s_mask", 0]}, "class_type": "InvertMask"}
    payload["s_save"] = {"inputs": {"filename_prefix": prefixes["s"], "images": ["s_dec", 0], "mask": ["s_maskinv", 0]},
                         "class_type": "SaveImageWithAlpha"}

    # Lantern is an isolated object, not a tiling material, so it gets its own square canvas
    # and a BiRefNet cutout (the same node the krea2 weapon/shield/enemy sprites use - see
    # _krea2_add_branch) instead of the plain opaque SaveImage the three surfaces get.
    if lantern_p:
        payload["l_lat"] = {"inputs": {"width": obj_px, "height": obj_px, "batch_size": 1}, "class_type": "EmptyLatentImage"}
        payload["l_pos"] = {"inputs": {"text": lantern_p, "clip": ["1", 1]}, "class_type": "CLIPTextEncode"}
        payload["l_samp"] = {"inputs": {"seed": random.randint(1, 1000000000), "steps": 4, "cfg": 1.0,
                                        "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                                        "model": ["1", 0], "positive": ["l_pos", 0], "negative": ["neg", 0],
                                        "latent_image": ["l_lat", 0]}, "class_type": "KSampler"}
        payload["l_dec"] = {"inputs": {"samples": ["l_samp", 0], "vae": ["1", 2]}, "class_type": "VAEDecode"}
        payload["l_mask"] = {"inputs": {"bg_removal_model": ["bg_model", 0], "image": ["l_dec", 0]}, "class_type": "RemoveBackground"}
        payload["l_maskinv"] = {"inputs": {"mask": ["l_mask", 0]}, "class_type": "InvertMask"}
        payload["l_save"] = {"inputs": {"filename_prefix": prefixes["l"], "images": ["l_dec", 0], "mask": ["l_maskinv", 0]},
                             "class_type": "SaveImageWithAlpha"}

    data = json.dumps({"prompt": payload, "client_id": COMFY_CLIENT_ID}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        prompt_id = _track_prompt(json.loads(resp.read().decode("utf-8"))["prompt_id"])

    expected = ("w_save", "c_save", "f_save", "d_save", "s_save") + (("l_save",) if lantern_p else ())
    start_time = time.time()
    while time.time() - start_time < 120:
        time.sleep(0.1)
        _bail_if_cancelled()
        hist_req = urllib.request.Request(f"{COMFY_URL}/history/{prompt_id}")
        with urllib.request.urlopen(hist_req) as h_resp:
            hist_data = json.loads(h_resp.read().decode("utf-8"))
        if prompt_id not in hist_data:
            continue
        outputs = hist_data[prompt_id].get("outputs", {})
        if not all(k in outputs for k in expected):
            continue

        def _p(key):
            info = outputs[key]["images"][0]
            return os.path.join(COMFY_OUTPUT_DIR, info.get("subfolder", ""), info["filename"])

        w_path, c_path, f_path = _p("w_save"), _p("c_save"), _p("f_save")
        # Blank-wall guard, BEFORE the seam blend so whichever texture survives is the one
        # that gets tiled. Gated on the designed path exactly like _lift_dark_surface below,
        # and for the same reason: every hand-tuned bucket wall measures well clear of the
        # contrast floor (22.5 at worst), so this must never repaint one.
        if (brief or {}).get("wall"):
            w_path = _fix_blank_wall(w_path, wall_style, tile_px)
        make_seamless_4way(w_path, blend_pixels=12)
        make_seamless_4way(c_path, blend_pixels=12)
        make_seamless_4way(f_path, blend_pixels=12)
        # Door: a single full-cell surface - NOT tiled, so no make_seamless_4way.
        d_path = _p("d_save")
        # Off-theme-door guard, and BEFORE the dark lift below so the lift lands on whichever
        # door actually ships. Gated on the designed path exactly like the blank-wall guard
        # above and for the same reason: a hand-tuned bucket's door is written against its own
        # bucket's wall by hand (rule 1 in get_gate_prompts) and never fails this way. It also
        # needs both designed lines to re-roll from at all. Measured against the wall texture
        # AFTER its own rescue, so the comparison is with the corridor the player will see.
        if (brief or {}).get("wall") and (brief or {}).get("door"):
            d_path = _fix_offtheme_door(d_path, w_path, brief["door"], brief["wall"],
                                        tile_px, wall_named)

        # Only the DESIGNED path can hand back an unreadably dark surface, so the lift is
        # gated on these textures actually having been designed. The test is the "wall" slot,
        # not the brief itself: a bucketed theme still gets a truthy brief (it carries weapon
        # + enemy), and gating on that would have let this repaint hand-tuned bucket art - the
        # sci-fi bucket's "dark spaceship hull" is deliberately dark and must stay that way.
        # The door is included because it is a full-cell OPAQUE surface drawn in the corridor
        # just like a wall; the lantern and switch are not, being BiRefNet cutouts on
        # transparency. See _lift_dark_surface for the measurements.
        if (brief or {}).get("wall"):
            for pth, lbl in ((w_path, "wall"), (c_path, "ceiling"), (f_path, "floor"),
                             (d_path, "door")):
                _lift_dark_surface(pth, lbl)
        # Switch: one BiRefNet cutout, trimmed to its own alpha box like the lantern.
        s_path = _p("s_save")
        _save_tight(s_path)

        l_path = None
        if lantern_p:
            l_path = _p("l_save")
            _save_tight(l_path)

        PROGRESS.finish_job("surfaces")
        return w_path, c_path, f_path, l_path, d_path, s_path

    raise TimeoutError("FLUX.1 surface texture generation timed out.")


def _krea2_loaders():
    """Shared loader nodes for any krea2 ComfyUI prompt."""
    return {
        "k_unet": {"inputs": {"unet_name": KREA2_UNET, "weight_dtype": "default"}, "class_type": "UNETLoader"},
        "k_clip": {"inputs": {"clip_name": KREA2_CLIP, "type": "krea2", "device": "default"}, "class_type": "CLIPLoader"},
        "k_vae": {"inputs": {"vae_name": KREA2_VAE}, "class_type": "VAELoader"},
        "bg_model": {"inputs": {"bg_removal_name": BIREFNET_MODEL}, "class_type": "LoadBackgroundRemovalModel"},
    }


def _krea2_add_branch(payload, name, prompt_text, w, h, steps, seed, prefix):
    """Add one krea2 txt2img + BiRefNet-alpha branch to a shared payload.

    A caller that wants several outputs to read as one character (animation frames)
    passes the SAME seed to every branch and varies only a pose clause in the prompt -
    with no ControlNet for this arch that shared seed is the main consistency lever."""
    payload[f"{name}_pos"] = {"inputs": {"text": prompt_text, "clip": ["k_clip", 0]}, "class_type": "CLIPTextEncode"}
    # Distilled model at cfg 1.0 - the negative is a zeroed-out clone of the positive,
    # exactly as the reference workflow wires it. A real negative prompt does nothing here.
    payload[f"{name}_neg"] = {"inputs": {"conditioning": [f"{name}_pos", 0]}, "class_type": "ConditioningZeroOut"}
    payload[f"{name}_lat"] = {"inputs": {"width": w, "height": h, "batch_size": 1}, "class_type": "EmptyLatentImage"}
    payload[f"{name}_samp"] = {"inputs": {"seed": seed, "steps": int(steps), "cfg": KREA2_CFG,
                                          "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                                          "model": ["k_unet", 0], "positive": [f"{name}_pos", 0],
                                          "negative": [f"{name}_neg", 0], "latent_image": [f"{name}_lat", 0]},
                               "class_type": "KSampler"}
    payload[f"{name}_dec"] = {"inputs": {"samples": [f"{name}_samp", 0], "vae": ["k_vae", 0]}, "class_type": "VAEDecode"}
    payload[f"{name}_mask"] = {"inputs": {"bg_removal_model": ["bg_model", 0], "image": [f"{name}_dec", 0]}, "class_type": "RemoveBackground"}
    payload[f"{name}_maskinv"] = {"inputs": {"mask": [f"{name}_mask", 0]}, "class_type": "InvertMask"}
    payload[f"{name}_save"] = {"inputs": {"filename_prefix": f"{prefix}_{name}_{int(time.time()*1000)}",
                                          "images": [f"{name}_dec", 0], "mask": [f"{name}_maskinv", 0]},
                               "class_type": "SaveImageWithAlpha"}


def _krea2_submit_and_collect(payload, save_keys, timeout=300, job_key=None, out_key="images"):
    """Submit a krea2 prompt, wait for every `<name>_save` in save_keys, return {name: path}.

    `job_key` names this submission in the run's progress plan (see ProgressTracker), so the
    bar knows which phase the incoming per-step socket updates belong to.

    `out_key` is the field a save node reports its files under. Image saves use "images";
    audio saves (the SFX pack) use "audio" - see SavedAudios.as_dict in comfy_api."""
    _bail_if_cancelled()   # never hand ComfyUI another job for a run nobody is waiting on
    PROGRESS.begin_job(job_key)
    data = json.dumps({"prompt": payload, "client_id": COMFY_CLIENT_ID}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        prompt_id = _track_prompt(json.loads(resp.read().decode("utf-8"))["prompt_id"])

    expected = [f"{n}_save" for n in save_keys]
    start_time = time.time()
    while time.time() - start_time < timeout:
        time.sleep(0.2)
        _bail_if_cancelled()
        hist_req = urllib.request.Request(f"{COMFY_URL}/history/{prompt_id}")
        with urllib.request.urlopen(hist_req) as h_resp:
            hist_data = json.loads(h_resp.read().decode("utf-8"))
        if prompt_id not in hist_data:
            continue
        outputs = hist_data[prompt_id].get("outputs", {})
        if not all(k in outputs for k in expected):
            continue
        result = {}
        for n in save_keys:
            info = outputs[f"{n}_save"][out_key][0]
            result[n] = os.path.join(COMFY_OUTPUT_DIR, info.get("subfolder", ""), info["filename"])
        PROGRESS.finish_job(job_key)
        return result
    raise TimeoutError("krea2 turbo generation timed out.")


# ---------------------------------------------------------------------------
# Intro story: Qwen3-VL-4B writes the opening crawl and names the cast
# ---------------------------------------------------------------------------
# The text model is the SAME Qwen3-VL-4B already loaded as krea2's text encoder, reached
# through ComfyUI's core TextGenerate node. Because the CLIPLoader node below is byte
# identical to _krea2_loaders()["k_clip"], ComfyUI serves it from cache - the story costs
# no extra VRAM next to the 13GB krea2 UNET. Qwen3VL_4BConfig sets `lm_head = False` ("4B
# ties word embeddings"), so BaseGenerate falls back to embed_tokens, which is the intended
# path for this checkpoint; sd.py calls the krea2 encoder "full Qwen3-VL-4B (12-layer tap
# for conditioning + multimodal generate)".
#
# Measured on the 3090: 8-16s for a full reply, ~13 tok/s.

# Per-job progress weights for the v5/v6 runs. `weight` is a rough relative wall-clock cost
# and only affects how the phases are paced against each other; `units` is that job's
# expected total sampler steps (tokens for the story) and is the denominator the live
# per-step fraction from ComfyUI's socket is measured against.
def _plan_v6(steps, sound_mode="music_and_sound", last_attack_frame=False, ending_video="off"):
    st = int(steps)
    plan = [
        # key,             label,                                                    weight, units
        ("theme_brief",    "Designing the set with Qwen3-VL...",                          6, THEME_BRIEF_MAX_TOKENS),
        ("names",          "Naming the hero and the boss with Qwen3-VL...",                3, NAMING_TYPICAL_TOKENS),
        ("story",          "Writing the chronicle with Qwen3-VL...",                      12, STORY_TYPICAL_TOKENS),
        ("enemy_species",  "Designing three foes with Qwen3-VL...",                        6, ENEMY_SPECIES_MAX_TOKENS),
        ("surfaces",       "Synthesizing dungeon textures with FLUX.1 [schnell]...",      12, 5 * 4),
        # Every player pose + every frame of all three foes, all in the one krea2 job - the
        # strike frames included when the Last Attack Frame option asked for them.
        ("frames",         "Animating the swing and the walk with krea2 turbo...",        80, (len(V6_FRAME_NAMES) + _enemy_frame_count(last_attack_frame)) * st),
        # "enemy_variants" is NOT here on purpose. It only runs when the species naming
        # failed and the flyer/boss have to be derived from the walker instead, so it is
        # registered with PROGRESS.add_job at that point. A planned job that never runs is
        # dead weight in the denominator and would strand the bar short of 100%.
        ("portrait_idle",  "Painting the HUD portrait...",                                 6, st),
        ("portrait_edits", "Editing portrait reactions with Kontext...",                  45, 3 * KONTEXT_STEPS),
    ]
    # Both audio jobs are skippable via sound_mode - a planned-but-skipped step is the same
    # "dead weight in the denominator" problem noted above, so only plan what will actually run.
    if sound_mode != "skip":
        # Cheap next to everything above it - measured ~12s for all eight sounds including the
        # cold model load, against a ~2min bundle - hence the small weight.
        plan.append(("sfx", "Foleying the dungeon with Stable Audio 3...", 8, len(SFX_NAMES) * SFX_STEPS))
    if sound_mode == "music_and_sound":
        # Unmeasured weight - two 30s/40-step generations will run far longer than the sfx
        # pack's eight 2s/8-step ones; correct this once a real run has been timed.
        plan.append(("music", "Composing dungeon music with Stable Audio 3...", 30, len(MUSIC_NAMES) * MUSIC_STEPS))
    # Only when Options films the ending on the loading screen - the background mode renders it
    # after the run is saved, outside this plan.
    if ending_video == "loading":
        plan.append(("ending_video", "Filming the ending cutscene with MiniMax H3...",
                     ENDING_PLAN_WEIGHT, ENDING_STEPS))
    return plan


def _plan_v5(steps):
    st = int(steps)
    return [
        ("theme_brief",    "Designing the set with Qwen3-VL...",                          6, THEME_BRIEF_MAX_TOKENS),
        ("names",          "Naming the hero and the boss with Qwen3-VL...",                3, NAMING_TYPICAL_TOKENS),
        ("story",          "Writing the chronicle with Qwen3-VL...",                      12, STORY_TYPICAL_TOKENS),
        ("enemy_species",  "Designing three foes with Qwen3-VL...",                        6, ENEMY_SPECIES_MAX_TOKENS),
        ("surfaces",       "Synthesizing dungeon textures with FLUX.1 [schnell]...",      12, 5 * 4),
        ("frames",         "Forging the character, weapon and shield...",                 55, (3 + _enemy_frame_count()) * st),
        # See _plan_v6 for why "enemy_variants" is registered lazily instead of planned.
        ("portrait_idle",  "Painting the HUD portrait...",                                 6, st),
        ("portrait_edits", "Editing portrait reactions with Kontext...",                  45, 3 * KONTEXT_STEPS),
    ]


STORY_MAX_TOKENS = 420
STORY_TEMPERATURE = 0.9
# Typical reply length in tokens - used only as the progress denominator for the story job.
# The model stops on its own well before STORY_MAX_TOKENS, so normalising against the cap
# would leave the bar stuck at half.
STORY_TYPICAL_TOKENS = 240

STORY_SYSTEM = (
    "You are the narrator of a 1990s first-person dungeon crawler. "
    "You write in the style of a Star Wars opening crawl: grand, mythic, present tense, "
    "short declarative sentences, rising urgency. Every crawl names a real stake - a person, "
    "a place, or a world the boss is destroying or will destroy - and ends by rallying the "
    "player to go stop it, second person, direct, like a call to arms before a battle. "
    "You never break character and you never explain yourself."
)

# ---------------------------------------------------------------------------
# NAMES - what the crawl calls the hero, the boss and the place.
# ---------------------------------------------------------------------------
# Left to itself the 4B names everything out of one small dark-fantasy word bag, whatever the
# thing actually is. Across 95 saved runs: "Apex The Unmaker" was the boss of "maga people", a
# cashier hero was named "Cashier" twice, "Whisker" and "Paws" were half of every animal hero
# (three of those Whiskers were a Yorkshire Terrier), and "Ashen" crept into the place names
# of every dark theme.
#
# RULES IN THE CRAWL PROMPT DO NOT FIX IT. That was tried first - a "name a person like a
# person, a pet like a pet" block with fresh example names drawn for every story - and run live
# on ten themes. People came out right ("Terry the Cashier", "Biscuit the Dog"); everything
# else copied whichever example was nearest to hand, fitting or not: "Old Mossback", the
# moss-bear example, as the boss of a supermarket's crazy customers, "Ron the Cashier" as the
# boss of office furniture in "Todd's Discount Foods", and "The Great Waffleton" over a dungeon
# of blueberries. It is the same habit that once put one "miners of Ashfen" example into every
# crawl. The cat was still "Whisker", the reporter still "Lady Reporter", and the maga boss
# "The Last Scribe".
#
# So the model is only asked what it is reliably good at - what KIND of thing the hero and the
# boss are, and what that thing is called in plain words - in a small call of its own ahead of
# the crawl (generate_story_names), and the name itself is decided in code (_decide_name): a
# person gets an everyday name, a pet a pet's name, a famous character its own. The crawl is
# then written around names that are already final.
#
# THAT OVERSHOT INTO BLAND, AND INTO REPEATS. Its NAME check only asked whether a name shared
# letters with the thing, and the model's "name" for a thing is mostly the thing itself - so the
# boss came out plain "Taco", "Waifu" or "RAM Stick", and since the model says that the same way
# every time, three Windows 95 runs in a row got the same cast. The old names were loud for a
# reason people liked ("Shattered The Overclocker" - the drama word was random, but the
# overclocker belonged to the computer), so the balance now is:
#   - a TITLE per character, asked for in one randomly drawn SHAPE (_TITLE_SHAPES) described in
#     words, never shown as an example, since an example is a thing to copy;
#   - a name that is only the WHAT is no name (_is_just_the_what);
#   - the boss wears a dramatic prefix a third of the time, and the title the rest
#     (_dress_name);
#   - recent names, titles and first names are remembered on disk (RECENT_CAST_PATH) and not
#     handed out again straight away.

NAMING_MAX_TOKENS = 170     # eight short lines
NAMING_TYPICAL_TOKENS = 50  # progress denominator only - see STORY_TYPICAL_TOKENS
NAMING_TEMPERATURE = 0.7    # sorting into kinds, not inventing - NAME_ID_TEMPERATURE's reasoning

# Everyday first names for an everyday person - the "why isn't it just Bill" names. Plain and
# a little dated on purpose: a neighbour, a coworker, whoever is on the next register over.
_EVERYDAY_NAMES = (
    "Bill", "Ellen", "Sally", "Doug", "Linda", "Gary", "Barb", "Stan", "Brenda", "Carl",
    "Denise", "Earl", "Gail", "Hank", "Irene", "Jerry", "Kathy", "Larry", "Marge", "Ned",
    "Phil", "Rhonda", "Ron", "Sheila", "Ted", "Trudy", "Walt", "Wanda", "Dolores", "Clyde",
    "Norm", "Bev", "Gus", "Tammy", "Dale", "Deb", "Lou", "Patty", "Herb", "Joanne",
    "Duane", "Lorraine", "Gordon", "Mitch", "Todd", "Janet", "Dot", "Myrtle", "Bernie",
    "Ethel", "Harold", "Mildred", "Vern", "Lyle", "Sal", "Rita", "Connie", "Marty", "Darlene",
    "Wendell", "Fran", "Glen", "Hal", "Lois", "Midge", "Pam", "Randy", "Terry", "Vicky",
    "Wes", "Roy", "Peggy", "Frank", "Nancy", "Carol", "Bob", "Judy", "Rick", "Shirley",
)

# What real owners call real pets. Mostly food, a few with titles, and a few plain people
# names, because a cat called Gerald is funnier than a cat called anything cat-shaped.
_PET_NAMES = (
    "Biscuit", "Noodle", "Pickles", "Waffles", "Pudding", "Meatball", "Nugget", "Muffin",
    "Pumpkin", "Peanut", "Mochi", "Tofu", "Pancake", "Marshmallow", "Butterscotch", "Gizmo",
    "Oreo", "Cheddar", "Toast", "Dumpling", "Sprinkles", "Fig", "Olive", "Pepper", "Smokey",
    "Chonk", "Beefcake", "Sir Fluffington", "Captain Floof", "Duchess", "Princess Chunk",
    "Tater Tot", "Cupcake", "Jellybean", "Crouton", "Gnocchi", "Burrito", "Nacho", "Pretzel",
    "Bubbles", "Fuzzy", "Button", "Ziggy", "Rocket", "Bandit", "Taco", "Gerald", "Steve",
    "Brian", "Susan", "Dennis", "Maureen", "Lord Wigglesworth", "Admiral Snuggles",
)

# How a real place ends up with its name - two are offered to each crawl, so no one of them
# becomes every dungeon's. Described rather than exemplified, for the reason in the note above:
# a whole example name is a thing to copy, and "Todd's Discount Foods" landed on an office.
_PLACE_NAME_SHAPES = (
    "with somebody's name on it, the way a shop or a company has one",
    "with a number in it, the way an aisle, a floor or a room has one",
    "as a pun on what is in there",
    "after the one thing it is best known for",
    "after an old family, a founder or a landmark",
    "after the street, the stop or the part of town it is in",
)

# "Ashen" is the one place word the model still reaches for once places are named their own
# way: the last two "hell" dungeons came back "Ashen Womb" and "people of Ashen Maw", and two
# Demon's Souls runs "the Ashen Spire" and "the Ashen Grotto". parse_story_block trades it for a
# backup from the same scorched family, so the place keeps the feel the model was going for -
# just not the same word every time. Only inside a place name: "the Ashen One" is a real Dark
# Souls name.
_STOCK_PLACE_WORDS = ("ashen", "ashfen")
_PLACE_WORD_BACKUPS = (
    "Cinder", "Ember", "Soot", "Brimstone", "Kiln", "Scorch", "Smolder", "Slag", "Coal",
    "Flint", "Furnace", "Sulfur", "Pyre", "Charcoal", "Bonfire", "Tinder",
)

NAMING_SYSTEM = (
    "You are the casting director for a 1990s dungeon crawler. You say what kind of character "
    "each one is. You never explain yourself and you never break format."
)

# Laid out like the bestiary and identity briefs - numbered rules, then labels each carrying a
# <placeholder> - because the first draft was not, and it was unusable: it spelled the options
# out under "KIND:"-style headings and closed on six bare, empty labels, and the model read the
# whole brief as a form to recite, answering every run by echoing it back from the top.
_NAMING_USER = """A player typed this to set up a dungeon crawler:

The player is: {player}
The enemies are: {enemy}
The dungeon looks like: {wall}

Sort out two characters: the PLAYER, and the BOSS - the one biggest enemy, the champion of
those enemies.

Rules:
1. KIND is exactly ONE of five words. PERSON is any sort of human being - someone with a job,
   a type of person, a knight, an elf, or one out of a crowd of people. ANIMAL is a real
   animal or a pet. FAMOUS is one particular famous person, character or mascot - out of real
   life, a game, a film or a cartoon - named in what the player typed, even in lowercase. THING
   is an object, a food, a machine or a plant. MONSTER is a monster, a ghost, a demon or a
   creature out of a legend.
2. WHAT is one or two plain words for what it is, singular - "Cashier", "Night Elf", "Cat",
   "Blueberry", "Devil", "Office Chair".
3. NAME is its real name if it is FAMOUS, a funny name made out of its own word if it is a
   THING or a MONSTER, and NONE if it is a PERSON or an ANIMAL. A NAME is never just the
   WHAT again or the words the player typed.
4. TITLE is a nickname of one to three words that only this character could have, straight
   out of what it is and the world it lives in. Never NONE, never just the WHAT, and never a
   spooky word that has nothing to do with it. The PLAYER's TITLE is {hero_shape}. The BOSS's
   TITLE is {boss_shape}.

Reply using EXACTLY these labels, each on its own line, in this order. No preamble, no
markdown, no commentary, no asterisks:

PLAYER_KIND: <PERSON, ANIMAL, FAMOUS, THING or MONSTER>
PLAYER_WHAT: <one or two words>
PLAYER_NAME: <a name, or NONE>
PLAYER_TITLE: <one to three words>
BOSS_KIND: <PERSON, ANIMAL, FAMOUS, THING or MONSTER>
BOSS_WHAT: <one or two words>
BOSS_NAME: <a name, or NONE>
BOSS_TITLE: <one to three words>"""

# The shapes a TITLE is asked for in, one drawn per character per run. Described, never shown -
# see the NAMES note: "Old Mossback" and "Todd's Discount Foods" were examples that got copied
# onto dungeons they had nothing to do with. The draw is what makes the same theme come out with
# a different cast each time; the model on its own says the same thing for the same words.
_BOSS_TITLE_SHAPES = (
    "a job title for the trouble it causes",
    "the nickname its victims whisper about it",
    "a pro wrestler's ring name built out of what it is",
    "a pun on what it is",
    "a royal title over the place it rules",
    "the worst thing it is known for doing",
    "a heavy metal band name about what it does",
)
_HERO_TITLE_SHAPES = (
    "what they are best at",
    "the nickname their friends or coworkers gave them",
    "a pro wrestler's ring name built out of what they are",
    "a pun on what they are",
    "the one thing they are famous for around here",
    "a superhero name built out of their job or what they are",
)

# Worn in front of the boss's title a third of the time, for the names people liked the old
# random titles for: "Shattered The Overclocker". Only ever beside a title or a WHAT that says
# what the boss is - on their own these were "Apex The Unmaker" over a dungeon of people.
_DRAMATIC_PREFIXES = (
    "Shattered", "Undying", "Corrupted", "Forsaken", "Sovereign", "Ancient", "Dread", "Apex",
)
DRAMATIC_PREFIX_CHANCE = 1 / 3
HERO_TITLE_CHANCE = 0.5

# The 4B's own dark-fantasy word bag - what "Apex The Unmaker", "Ancient The Hollow King",
# "Corrupted Vox Maw" and "Shattered Gargantua" were made of. A TITLE leaning on one of them is
# the model reaching for the bag instead of the thing, unless the player typed the word.
_STOCK_TITLE_WORDS = frozenset((
    "unmaker", "hollow", "maw", "gargantua", "void", "shadow", "shadows", "abyss", "wraith",
    "bane", "gloom", "doom", "eternal", "fang", "scribe", "titan", "ashen", "ashfen", "vox",
    "dread", "forsaken", "corrupted", "shattered", "undying", "sovereign", "ancient", "apex",
))
TITLE_MAX_WORDS = 3     # not counting "of", "the" and the like: "Blue Screen of Death" is three
TITLE_MAX_CHARS = 24

# Names already handed out lately. Kept on disk rather than read back out of dungeon_sessions,
# because a cancelled or unsaved run leaves no session behind and its cast is repeated all the
# same. The first names are held only briefly - the pools are not big enough to rest many.
RECENT_CAST_PATH = os.path.join(PROJECT_DIR, "recent_cast_names.json")
RECENT_CAST_KEEP = {"names": 40, "titles": 12, "firsts": 16}
_RECENT_CAST_LOCK = threading.Lock()

_NAMING_KINDS = ("PERSON", "ANIMAL", "FAMOUS", "THING", "MONSTER")

# WHAT answers that say nothing about the character - "Ellen the Person" is not a joke, it is
# a blank the model failed to fill. Read as no answer at all.
_BLAND_WHATS = frozenset((
    "person", "human", "people", "being", "animal", "pet", "object", "character", "none",
    "n/a", "unknown",
))

# Words a description is full of that never make a name belong to the thing it names - "Big
# Tony" does not connect to "big blueberries" by sharing "big", and a bestiary LOOK line (see
# _tidy_species_names) says "crimson", "glowing" and "legs" about everything it draws.
_CONNECT_SKIP = frozenset((
    "the", "and", "for", "its", "his", "her", "who", "one", "big", "old", "new", "bad", "mad",
    "red", "with", "from", "that", "this", "they", "them", "their", "into", "onto", "over",
    "under", "some", "very", "like", "wearing", "called", "named", "real", "none", "body",
    "legs", "arms", "head", "eyes", "tail", "huge", "tiny", "tall", "long", "wide", "thin",
    "dark", "pale", "made", "each", "atop", "side", "four", "small", "large", "giant",
    "massive", "thick", "bright", "glowing", "black", "white", "green", "blue", "gold",
    "golden", "grey", "gray", "silver", "purple", "orange", "yellow", "pink", "brown",
    "crimson", "several", "covered", "standing", "stands",
))

# Past this many characters "<name> the <what>" stops fitting on the boss's health bar, which
# lives in a 320px view (drawEnemyHpBar in game.js).
_NAME_WITH_WHAT_MAX = 26

# Worn by a thing or a monster instead of an everyday name a third of the time - "King
# Blueberry", "Grandpa Office Chair", "Baby Devil" - so a dungeon full of objects is not always
# "<name> the <thing>". The model almost never offers a name of its own for one: across sixteen
# live replies it wrote NONE for every thing and monster but two, and neither of those two
# ("DDR4" for a RAM stick, "Toothed Toy" for a stuffed animal) had anything to do with the foe.
_THING_TITLES = (
    "Big", "King", "Queen", "Sir", "Lady", "Captain", "Old", "Mister", "Lord", "Auntie",
    "Uncle", "Grandpa", "Baby",
)


# The reply is started for the model: the prompt ends on this label, so the first token it
# writes is the player's KIND. Even laid out like the working briefs, three replies in four
# opened on a line of scene-setting ("You're in a supermarket dungeon.") and one in four recited
# the brief back until the token cap cut it off before a single label. parse_story_names puts
# the label back on the front of what comes out.
_NAMING_REPLY_START = "PLAYER_KIND:"


def _naming_prompt(wall_style, player_style, enemy_style, with_image=False, rng=random):
    """Same hand-built chat template as _story_prompt - see there for why - with the reply
    already begun on _NAMING_REPLY_START, and a fresh title shape drawn for each character."""
    user = _NAMING_USER.format(
        wall=(wall_style or "").strip() or "a forgotten place",
        player=(player_style or "").strip() or "a nameless wanderer",
        enemy=(enemy_style or "").strip() or "things that shamble",
        hero_shape=rng.choice(_HERO_TITLE_SHAPES),
        boss_shape=rng.choice(_BOSS_TITLE_SHAPES),
    )
    vision = ""
    if with_image:
        vision = "<|vision_start|><|image_pad|><|vision_end|>"
        user = "This is what the player looks like.\n\n" + user
    return (
        "<|im_start|>system\n" + NAMING_SYSTEM + "<|im_end|>\n"
        "<|im_start|>user\n" + vision + user + "<|im_end|>\n"
        "<|im_start|>assistant\n"
        "<think>\n\n</think>\n\n" + _NAMING_REPLY_START
    )


def _read_kind(answer):
    """One of _NAMING_KINDS, or None. Read the way _read_guard reads GUARD - capitals first,
    because the brief prints the options in capitals and a copied verdict keeps them while the
    prose around it does not, then any case - except that an answer naming two different kinds
    is not an answer. It is the model reciting the options ("PERSON is any sort of human being.
    ANIMAL is..."), and an unread kind is the safe outcome: _decide_name still names the thing
    after what it is."""
    text = (answer or "").strip()
    for hay, needle in ((text, str.upper), (text.lower(), str.lower)):
        hits = {kind for kind in _NAMING_KINDS if re.search(r"\b" + needle(kind) + r"\b", hay)}
        if hits:
            return hits.pop() if len(hits) == 1 else None
    return None


# Where a description stops saying what the thing IS and starts hanging things off it - "guy
# in a shirt and tie" is a guy, "blueberries with swords" are blueberries, "a cat called
# Billy" is a cat. Only the part before the first of these is kept, and of that only the last
# three words, which in English is where the noun is: "pink and green cat" -> "green cat".
# "of" is deliberately not a cut: "stick of RAM" is a stick of RAM, not a stick.
_WHAT_CUT_RE = re.compile(
    r",|\s+(?:in|with|from|on|wearing|holding|carrying|that|who|which|called|named)\s+",
    re.IGNORECASE)
_WHAT_EDGE_WORDS = frozenset(("a", "an", "the", "and", "or", "of"))
_WHAT_IRREGULAR_PLURALS = {"people": "Person", "men": "Man", "women": "Woman", "mice": "Mouse"}


def _clean_what(answer):
    """WHAT - or a typed description standing in for it - as a short, title-cased, singular
    noun phrase: "cashiers" -> "Cashier", "a night elf" -> "Night Elf", "blueberries with
    swords" -> "Blueberry", "maga people" -> "Maga Person". None when nothing usable is left."""
    text = re.sub(r"^<|>$", "", _ascii_ify(answer or "").strip().strip(_STORY_STRIP)).strip()
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'\-]*", _WHAT_CUT_RE.split(text, maxsplit=1)[0])[-3:]
    while words and words[0].lower() in _WHAT_EDGE_WORDS:
        words.pop(0)
    while words and words[-1].lower() in _WHAT_EDGE_WORDS:
        words.pop()
    phrase = " ".join(words)
    if not phrase or phrase.lower() in _BLAND_WHATS or _is_generic_name(phrase):
        return None
    last = words[-1]
    if "of" in (w.lower() for w in words):
        pass    # "Bag of Chips" is one bag - its last word is not the thing being counted
    elif last.lower() in _WHAT_IRREGULAR_PLURALS:
        words[-1] = _WHAT_IRREGULAR_PLURALS[last.lower()]
    elif len(last) > 4 and last.lower().endswith("ies"):
        words[-1] = last[:-3] + ("Y" if last.isupper() else "y")
    else:
        words[-1] = _singular_creature_name(last)
    return " ".join(w if w.lower() in _WHAT_EDGE_WORDS else w[:1].upper() + w[1:] for w in words)


def _clean_given_name(answer):
    """NAME as a proper name, or None for NONE, a role word or nothing at all."""
    name = _story_name(answer, "", max_words=3)
    if not name or re.match(r"^(?:none|n/?a|unknown)\b", name, re.I) or _is_generic_name(name):
        return None
    return name


def _read_title(answer):
    """TITLE as the model wrote it, minus brackets and quotes, or None for nothing / NONE. Only
    the reading - whether it is any good depends on the WHAT and the typed words, so that is
    _clean_title's job once those are known."""
    text = re.sub(r"^<|>$", "", _ascii_ify(answer or "").strip().strip(_STORY_STRIP)).strip()
    text = re.sub(r"\s+", " ", text.strip("\"'").strip())
    if not text or re.match(r"^(?:none|n/?a|unknown)\b", text, re.I):
        return None
    return text


def parse_story_names(text):
    """{"hero": {"kind", "what", "name", "title"}, "boss": {...}} out of the naming reply.
    Never raises; anything missing or unreadable comes back None, and _decide_name and
    _dress_name cope with every combination of those.

    A label that turns up more than once keeps its first READABLE answer rather than its first
    answer: the reply is begun on _NAMING_REPLY_START for the model, so a reply that opens with
    a sentence anyway files that sentence under the player's KIND, ahead of the real one."""
    fields = {"hero": {}, "boss": {}}
    text = _ascii_ify(text or "")
    if not text.lstrip().upper().startswith(_NAMING_REPLY_START):
        text = _NAMING_REPLY_START + text
    for raw_line in text.splitlines():
        label, sep, value = raw_line.strip().strip(_STORY_STRIP).partition(":")
        m = re.fullmatch(r"(player|hero|boss)[\s_]*(kind|what|name|title)", label.strip().lower())
        if sep and m:
            who = "boss" if m.group(1) == "boss" else "hero"
            fields[who].setdefault(m.group(2), []).append(value.strip())
    readers = {"kind": _read_kind, "what": _clean_what, "name": _clean_given_name,
               "title": _read_title}
    return {who: {field: next((got for got in map(read, answers.get(field, [])) if got), None)
                  for field, read in readers.items()}
            for who, answers in fields.items()}


def _name_connects(name, *sources):
    """True when a name visibly comes from what it names: some five-letter run of a source word
    turns up inside it. "Barry Blueberry" and "Skyberry" connect to Blueberry on "berry", "Sir
    Melonsworth" to Watermelon on "melon"; "The Great Waffleton" over blueberries and
    "Gristleclaw" for a fingercreeper do not - copied from somewhere else, or invented with no
    tie to the thing at all. A four-letter source word ("moss", "chat") only has to appear
    somewhere in the name, a three-letter one ("RAM", "elf") as a whole word of it.

    Five letters, not four: four let "Glitch Wisp" pass as a name for a Twitch viewer on the
    "itch" the two words happen to share. Each source word is tried singular as well, because
    "blueberries" never spells "berry" and "Berrybloom" was thrown out over it."""
    low = (name or "").lower()
    squashed = re.sub(r"[^a-z0-9]", "", low)
    if not squashed:
        return False
    for src in sources:
        for plain in re.findall(r"[a-z0-9]+", (src or "").lower()):
            singular = plain[:-3] + "y" if len(plain) > 4 and plain.endswith("ies") else plain
            for word in {plain, singular}:
                if _word_in_name(word, low, squashed):
                    return True
    return False


def _word_in_name(word, low, squashed):
    """_name_connects for one source word against one name (lowercased, and squashed to its
    letters and digits)."""
    if len(word) < 3 or word in _CONNECT_SKIP:
        return False
    if len(word) == 3:
        return bool(re.search(r"(?<![a-z0-9])" + word + r"(?![a-z0-9])", low))
    return any(word[i:i + 5] in squashed for i in range(max(1, len(word) - 4)))


def _plain_words(text):
    """The words of a name or description, lowercase and roughly singular, articles dropped -
    for asking whether one is only the other again."""
    words = []
    for w in re.findall(r"[a-z0-9]+", _ascii_ify(text or "").lower()):
        if w in ("the", "a", "an"):
            continue
        if len(w) > 4 and w.endswith("ies"):
            w = w[:-3] + "y"
        elif len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        words.append(w)
    return words


def _is_just_the_what(name, *sources):
    """True when a name says nothing but what the thing is: every word of it is already a word
    of the WHAT or of what the player typed. "RAM Stick" for a stick of computer RAM, "Taco" for
    tacos, "Waifu" for a waifu - each passes _name_connects trivially, and the model gives the
    same one every run, so on its own this was the whole cast of three Windows 95 runs in a row.
    "Barry Blueberry" is a name; its "Barry" came from nowhere in the description."""
    words = set(_plain_words(name))
    if not words:
        return False
    return any(words <= set(_plain_words(src)) for src in sources if src)


def _clean_title(answer, what=None, typed="", recent=()):
    """A TITLE worth wearing, title-cased with any leading "The" taken off, or None:

      - more than TITLE_MAX_WORDS words or TITLE_MAX_CHARS characters (the health bar, and a
        long one is usually the drawn shape recited back instead of answered);
      - a role word ("The Boss"), or only the WHAT again ("RAM Stick");
      - leaning on a word out of _STOCK_TITLE_WORDS that the player never typed;
      - one handed out in a recent run (`recent`, lowercase).

    No _name_connects test: "Overclocker" shares no letters with a stick of RAM and is exactly
    the title wanted. What ties a title to the thing is the shape it was asked for in."""
    text = _read_title(answer)
    if not text:
        return None
    # "Doug the Overclocker" as a TITLE is a name the model made up with the title inside it.
    m = re.match(r"^[A-Za-z]+ the (.+)$", text)
    if m and not re.match(r"^(?:king|queen|lord|lady|master|mistress|prince|princess)\b", text, re.I):
        text = m.group(1)
    text = re.sub(r"^the\s+", "", text, flags=re.I).strip(" .,!-")
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'\-]*", text)
    content = [w for w in words if w.lower() not in _STORY_TRAILING_STOPWORDS]
    if not content or len(content) > TITLE_MAX_WORDS or len(" ".join(words)) > TITLE_MAX_CHARS:
        return None
    title = " ".join(w if i and w.lower() in _STORY_TRAILING_STOPWORDS else w[:1].upper() + w[1:]
                     for i, w in enumerate(words))
    if _is_generic_name(title) or _is_just_the_what(title, what, typed):
        return None
    typed_words = set(re.findall(r"[a-z0-9]+", (typed or "").lower()))
    if any(w.lower() in _STOCK_TITLE_WORDS and w.lower() not in typed_words for w in words):
        return None
    if title.lower() in recent:
        return None
    return title


def _decide_name(kind, what, name, typed, rng=random, avoid=()):
    """The name a hero or boss actually goes by, from what the naming call made of it:

      PERSON   an everyday first name - "Ellen" - or, half the time, one that says what they
               are: "Sally the Cashier".
      ANIMAL   the same out of _PET_NAMES - "Meatball", "Gerald the Cat".
      FAMOUS   its own real name, as long as that name has something to do with what was typed
               - otherwise the typed words themselves.
      THING, MONSTER, or a kind that could not be read
               the model's own name when it connects to the thing (_name_connects), otherwise
               an everyday name wearing what it is: "Doug the Desk".

    `typed` is the field as the player wrote it - the fallback for WHAT when the reply gave
    none, and the other thing a name is allowed to connect to. `avoid` is first names already
    taken, lowercase, so the hero and the boss never both come out as Doug."""
    what = what or _clean_what(typed)
    if kind == "FAMOUS":
        if name and _name_connects(name, typed):
            return name
        return (_story_title(_story_name(typed, "", max_words=3), "") or what
                or rng.choice(_EVERYDAY_NAMES))
    person_or_pet = kind in ("PERSON", "ANIMAL")
    if not person_or_pet:
        if name and _name_connects(name, what, typed) and not _is_just_the_what(name, what, typed):
            return name
        if what and rng.random() < 1 / 3:
            titled = f"{rng.choice(_THING_TITLES)} {what}"
            if len(titled) <= _NAME_WITH_WHAT_MAX:
                return titled
    pool = [n for n in (_PET_NAMES if kind == "ANIMAL" else _EVERYDAY_NAMES)
            if n.lower() not in avoid]
    # A person or a pet is funny either way, so they get both; a thing or a monster needs its
    # "the <what>" - without it "Doug" has nothing to do with the desk. A WHAT too long for any
    # name to fit in front of it loses words off its front until one does, since the noun is at
    # the end: "Moss-covered Dire Bear" -> "Kathy the Dire Bear".
    if what and (not person_or_pet or rng.random() < 0.5):
        words = what.split(" ")
        while words:
            short = " ".join(words)
            fits = [n for n in pool if len(n) + len(" the ") + len(short) <= _NAME_WITH_WHAT_MAX]
            if fits:
                return f"{rng.choice(fits)} the {short}"
            words.pop(0)
    return rng.choice(pool)


def _fits(name):
    return bool(name) and len(name) <= _NAME_WITH_WHAT_MAX


def _dress_name(who, kind, what, base, title, rng=random, avoid=()):
    """The name a character is finally called, built on _decide_name's `base` and the TITLE
    (_clean_title, or None). A FAMOUS character keeps `base` untouched - it is their own name.

      boss  a third of the time a dramatic prefix: "Shattered The Overclocker", or with no
            title "Undying RAM Stick"; otherwise, with a title, "Doug the Overclocker" or "The
            Blue Screen"; otherwise `base` ("King Taco", "Rhonda the Taco").
      hero  with a title, half the time "Gary the Spreadsheet Slayer"; otherwise `base`.

    Every shape that would not fit the health bar (_NAME_WITH_WHAT_MAX) falls through to the
    next one, and `base` always fits. `avoid` is lowercase first names not to use."""
    if kind == "FAMOUS" or not base:
        return base
    pool = _PET_NAMES if kind == "ANIMAL" else _EVERYDAY_NAMES
    base_first = base.split(" the ")[0]
    if base_first in pool:
        first = base_first
    else:
        fresh = [n for n in pool if n.lower() not in avoid]
        first = rng.choice(fresh or pool)
    if title:
        titled = [f"{first} the {title}", f"The {title}"]
        if who == "hero":
            titled = titled[:1]
        elif rng.random() < 0.5:
            titled.reverse()
    else:
        titled = []

    shapes = []
    if who == "boss" and rng.random() < DRAMATIC_PREFIX_CHANCE:
        prefix = rng.choice(_DRAMATIC_PREFIXES)
        if title:
            # A title too long for "Sovereign The Memory Muncher" still gets its drama as
            # "Sovereign Memory Muncher", or from a shorter prefix, before giving it up. Live,
            # losing the title here turned good ones into "Dread Old Person".
            shorter = sorted((p for p in _DRAMATIC_PREFIXES if p != prefix), key=len)
            shapes += [f"{prefix} The {title}", f"{prefix} {title}"]
            shapes += [f"{p} The {title}" for p in shorter] + titled
        else:
            # The WHAT loses words off its front until it fits, as in _decide_name.
            words = (what or "").split()
            while words:
                shapes.append(f"{prefix} {' '.join(words)}")
                words.pop(0)
    elif titled and (who == "boss" or rng.random() < HERO_TITLE_CHANCE):
        shapes.extend(titled)
    return next((s for s in shapes if _fits(s)), base)


def _load_recent_cast():
    """{"names", "titles", "firsts"} of lowercase strings handed out lately - empty lists when
    the file is missing or unreadable, which must never stop a run."""
    recent = {key: [] for key in RECENT_CAST_KEEP}
    try:
        with open(RECENT_CAST_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        for key in recent:
            got = data.get(key) if isinstance(data, dict) else None
            if isinstance(got, list):
                recent[key] = [str(v).lower() for v in got if isinstance(v, str)]
    except (OSError, ValueError):
        pass
    return recent


def _remember_cast(names=(), titles=(), firsts=()):
    """Add this run's cast to RECENT_CAST_PATH, newest last, each list cut to RECENT_CAST_KEEP.
    Never raises."""
    with _RECENT_CAST_LOCK:
        recent = _load_recent_cast()
        for key, new in (("names", names), ("titles", titles), ("firsts", firsts)):
            add = [v.lower() for v in new if v]
            recent[key] = ([v for v in recent[key] if v not in add] + add)[-RECENT_CAST_KEEP[key]:]
        try:
            tmp = RECENT_CAST_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(recent, f, indent=1)
            os.replace(tmp, RECENT_CAST_PATH)
        except OSError as e:
            print(f"[cast] could not remember the cast: {e}")


def generate_story_names(wall_style, player_style, enemy_style, image_name=None, named=None):
    """Decide what the crawl calls the hero and the boss, before it is written - see the NAMES
    note above. Never raises: with no usable reply both names are still decided, from the typed
    words alone.

    Returns {"hero", "boss", "foe", "location"}. A quoted field names its character outright
    (same readiness rules as parse_story_block's overrides - a quoted player always, a quoted
    enemy or wall only once resolve_named_styles placed its kind), and with both the player and
    the enemy quoted there is nothing left to ask. "foe" is the boss's WHAT - what one of the
    common enemies is - and None when there was none to read. "location" is only ever a quoted
    wall; otherwise it is None and the crawl call names the place itself."""
    named = named or {}
    player_ent, enemy_ent, wall_ent = named.get("player"), named.get("enemy"), named.get("wall")
    names = {
        "hero": player_ent["name"] if player_ent else None,
        "boss": enemy_ent["name"] if enemy_ent and enemy_ent.get("kind") else None,
        "foe": None,
        "location": wall_ent["name"] if wall_ent and wall_ent.get("kind") else None,
    }
    if names["hero"] and names["boss"]:
        PROGRESS.finish_job("names")
        return names

    payload = {
        # Byte-identical to _krea2_loaders()["k_clip"] on purpose - see generate_intro_story.
        "k_clip": {"inputs": {"clip_name": KREA2_CLIP, "type": "krea2", "device": "default"},
                   "class_type": "CLIPLoader"},
        "names_gen": {
            "inputs": {
                "clip": ["k_clip", 0],
                "prompt": _naming_prompt(wall_style, player_style, enemy_style,
                                         with_image=bool(image_name)),
                "max_length": NAMING_MAX_TOKENS,
                "sampling_mode": "on",
                "sampling_mode.temperature": NAMING_TEMPERATURE,
                "sampling_mode.top_k": 64,
                "sampling_mode.top_p": 0.95,
                "sampling_mode.min_p": 0.05,
                "sampling_mode.repetition_penalty": 1.05,
                "sampling_mode.seed": random.randint(0, 2**32 - 1),
                "thinking": False,
                "use_default_template": False,
            },
            "class_type": "TextGenerate",
        },
        "names_out": {"inputs": {"source": ["names_gen", 0]}, "class_type": "PreviewAny"},
    }
    if image_name:
        payload["names_img"] = {"inputs": {"image": image_name}, "class_type": "LoadImage"}
        payload["names_gen"]["inputs"]["image"] = ["names_img", 0]

    cast = {"hero": {}, "boss": {}}
    try:
        t0 = time.time()
        raw = _submit_and_collect_text(payload, "names_out", timeout=90, job_key="names")
        cast = parse_story_names(raw)
        print(f"[cast] sorted in {time.time()-t0:.1f}s")
    except GenerationCancelled:
        raise
    except Exception as e:
        print(f"[cast Error] {e} - naming from the typed words alone")
        PROGRESS.finish_job("names")

    typed = {"hero": player_style, "boss": enemy_style}
    recent = _load_recent_cast()
    decided = {"names": [], "titles": [], "firsts": []}
    for who in ("hero", "boss"):
        if names[who]:
            continue
        got = cast.get(who) or {}
        typed_text = (typed[who] or "").strip()
        what = got.get("what") or _clean_what(typed_text)
        taken = {n.lower() for other in ("hero", "boss") if names[other]
                 for n in (names[other], names[other].split(" the ")[0])}
        # Recently used first names are rested too, as long as the pool has others to give.
        rested = taken | set(recent["firsts"])
        title = _clean_title(got.get("title"), what, typed_text, set(recent["titles"]))
        # A thing's NAME is often the better title when its TITLE is unusable - live, a RAM
        # stick's "Memory Masher" name failed _name_connects and was lost, though it is exactly
        # a title. Not for a person or a pet, whose NAME is asked to be NONE.
        # Nor for a NAME _decide_name is about to keep as the name itself ("Barry Blueberry").
        model_name = got.get("name")
        if (not title and model_name and got.get("kind") not in ("PERSON", "ANIMAL", "FAMOUS")
                and not _name_connects(model_name, what, typed_text)):
            title = _clean_title(model_name, what, typed_text, set(recent["titles"]))
        # A repeat of a recent name gets a few more draws - the shapes and first names are
        # random, the model's title and base usually are not.
        for _ in range(4):
            base = _decide_name(got.get("kind"), got.get("what"), got.get("name"), typed_text,
                                avoid=rested)
            names[who] = _dress_name(who, got.get("kind"), what, base, title, avoid=rested)
            if names[who].lower() not in recent["names"]:
                break
        decided["names"].append(names[who])
        decided["titles"].append(title)
        first = names[who].split(" the ")[0]
        if first in _EVERYDAY_NAMES or first in _PET_NAMES:
            decided["firsts"].append(first)
        print(f"[cast] {who}: {got.get('kind') or '?'} / {got.get('what')!r} / model said "
              f"{got.get('name')!r}, title {got.get('title')!r} (kept {title!r}) -> {names[who]!r}")
    if decided["names"]:
        _remember_cast(**decided)
    # The crawl used to be asked for a FOE line of its own, and once it had been told the
    # boss's name it simply copied that in: "Stan the Crazy" for a supermarket of crazy
    # customers. What the boss IS already says what its followers are.
    names["foe"] = (cast.get("boss") or {}).get("what")
    return names


# ---------------------------------------------------------------------------
# Fill-in: the setup screen's 🔮 button writes whichever mad-lib fields are still empty
# ---------------------------------------------------------------------------
# Same Qwen3-VL-4B, same cached k_clip loader, same hand-built template as the naming call.
# Every field the player already typed is written into the reply BEFORE the model starts, as
# lines it has apparently already answered, and the reply is left open on the first empty
# label. The model then only ever continues a form that already agrees with the player - it
# never gets the chance to "improve" a kept field, and anything it does echo for one is ignored.
# Called from the request handler, not a run thread, so it reports no PROGRESS.

FILL_IN_FIELDS = ("wall", "player", "weapon", "enemy")
FILL_IN_MAX_TOKENS = 120        # four short lines
FILL_IN_TEMPERATURE = 0.95      # inventing, not sorting - the whole point is a surprise
FILL_IN_MAX_WORDS = 12          # the longest Quick idea ("Clippy" the giant paperclip...) is 11
FILL_IN_MAX_CHARS = 90
FILL_IN_FIELD_MAX_CHARS = 200   # what the request is allowed to send per field

_FILL_IN_LABELS = {"wall": "DUNGEON", "player": "PLAYER", "weapon": "WEAPON", "enemy": "ENEMY"}

FILL_IN_SYSTEM = (
    "You are the idea writer for a silly 1990s dungeon crawler. You fill in a four-line setup "
    "form with short, funny, vivid picks. You never explain yourself and you never break format."
)

# A handful of the Quick ideas (PRESET_IDEAS in game.js), as the model's sense of the tone.
# A random few are shown each call and in a random order, so an all-empty fill-in is not
# anchored to the same example every time.
_FILL_IN_EXAMPLES = (
    ("Doom 2", "Doom guy", "chainsaw", '"Thomas the Tank Engine"'),
    ("supermarket", "cashier", "shopping basket", "old person"),
    ("Sega arcade", '"Goodcow" the cow', "Dreamcast controller", '"Sonic"'),
    ("pizza toppings", "cat chef", "pepperoni", "pasta"),
    ('"Apple Store"', '"Steve Jobs"', "sledgehammer", '"Clippy" the giant paperclip creature'),
    ("NYC subway station", "MTA conductor", "huge MetroCard", "NYC subway train"),
    ("italian restaurant", '"Will Smith"', "huge fork", "spaghetti monster"),
    ("World of Warcraft", "Night Elf", "sentinel glaive", "Elf on a shelf"),
    ("pet store", "Yorkshire Terrier", "whip", "bright stuffed animal"),
    ("corn maze", "pickup truck robot", "pitchfork", "zombie animal"),
    ("motherboard", "anime fluffy cat", "halberd", "anime villainess"),
    ('Colorful town of "Mow Meow"', '"Salescat" the colorful cat', "ryobi lawnmower", "grass"),
)
FILL_IN_EXAMPLE_COUNT = 5

# Only used when the dungeon line is one of the empty ones: a small model left to "invent a
# place" at any temperature keeps landing on the same haunted castle. A nudge toward one kind of
# place is enough to spread it out, and it is only a nudge - the model still picks the place.
_FILL_IN_WALL_SPARKS = (
    "a video game", "a real city or landmark", "a kind of store", "a food",
    "a place in nature", "a website or app", "a holiday", "a workplace", "a toy or a hobby",
    "a famous movie or TV show", "an old computer or console", "a sport", "a school subject",
    "a weather or season", "a room in a house",
)

_FILL_IN_USER = """Fill in the setup form for a dungeon crawler. Every line is one short
phrase of 1 to 8 words, never a sentence:

DUNGEON is the place the dungeon is built out of - its walls, floors and whole look.
PLAYER is the hero the player plays as.
WEAPON is what the hero fights with.
ENEMY is what the dungeon is full of.

Rules:
1. The best picks are an odd, funny crossover that still makes sense together.
2. Put "double quotes" around a real, named person, character, brand or place - "Sonic",
   "Steve Jobs", "Apple Store" - and around nothing else.
3. Lines that are already filled in are the player's own picks. Make every new line go with
   them.
4. Write something new - do not copy the examples.

Examples of finished forms:

{examples}
{spark}
Reply with EXACTLY these four labels, each on its own line, in this order. No preamble, no
markdown, no commentary:

DUNGEON: <a place>
PLAYER: <a hero>
WEAPON: <a weapon>
ENEMY: <an enemy>"""

# Answers that are a blank the model failed to fill rather than a pick.
_FILL_IN_BLANKS = frozenset((
    "none", "n/a", "na", "unknown", "same", "same as above", "keep", "kept", "tbd", "empty",
    "a place", "a hero", "a weapon", "an enemy", "dungeon", "player", "weapon", "enemy",
))

_FILL_IN_LABEL_RE = re.compile(r"^\s*(DUNGEON|WALL|PLAYER|HERO|WEAPON|ENEMY|ENEMIES)\s*:\s*(.*)$",
                               re.IGNORECASE)
_FILL_IN_LABEL_FIELD = {"dungeon": "wall", "wall": "wall", "player": "player", "hero": "player",
                        "weapon": "weapon", "enemy": "enemy", "enemies": "enemy"}


def _fill_in_reply_start(fields):
    """The already-answered part of the reply: every kept line up to the first empty one, then
    that empty line's label, left open for the model to finish."""
    lines = []
    for field in FILL_IN_FIELDS:
        value = (fields.get(field) or "").strip()
        if not value:
            lines.append(_FILL_IN_LABELS[field] + ":")
            break
        lines.append(f"{_FILL_IN_LABELS[field]}: {value}")
    return "\n".join(lines)


def _fill_in_prompt(fields, rng=random):
    """Same hand-built chat template as _story_prompt - see there for why - with the reply
    already begun on _fill_in_reply_start(fields). `fields` maps every FILL_IN_FIELDS key to
    the player's text, "" for a field to fill in."""
    shown = rng.sample(_FILL_IN_EXAMPLES, FILL_IN_EXAMPLE_COUNT)
    examples = "\n\n".join(
        f"DUNGEON: {w}\nPLAYER: {p}\nWEAPON: {we}\nENEMY: {e}" for w, p, we, e in shown)
    later = [f"{_FILL_IN_LABELS[f]}: {fields[f].strip()}" for f in FILL_IN_FIELDS
             if (fields.get(f) or "").strip()]
    spark = ""
    if not (fields.get("wall") or "").strip():
        spark = f"\nFor the DUNGEON this time, pick something like {rng.choice(_FILL_IN_WALL_SPARKS)}.\n"
    user = _FILL_IN_USER.format(examples=examples, spark=spark)
    if later:
        # Kept lines after the first empty one are not in the reply start, so every kept line
        # is also listed up front.
        user += "\n\nThe player already filled in:\n" + "\n".join(later)
    return (
        "<|im_start|>system\n" + FILL_IN_SYSTEM + "<|im_end|>\n"
        "<|im_start|>user\n" + user + "<|im_end|>\n"
        "<|im_start|>assistant\n"
        "<think>\n\n</think>\n\n" + _fill_in_reply_start(fields)
    )


def _fill_in_value(raw):
    """One answer tidied into something a mad-lib field can hold, or None. Quotes are kept -
    they are what sends a name down the named-entity path - so only unbalanced ones go."""
    text = _ascii_ify(raw or "").strip()
    text = re.sub(r"^[<\[(]+|[>\])]+$", "", text).strip()
    text = text.rstrip(".,;:!").strip()
    words = text.split()
    if len(words) > FILL_IN_MAX_WORDS:
        words = words[:FILL_IN_MAX_WORDS]
    while words and words[-1].lower().strip('"') in _STORY_TRAILING_STOPWORDS:
        words.pop()
    text = " ".join(words)
    if len(text) > FILL_IN_MAX_CHARS:
        text = text[:FILL_IN_MAX_CHARS].rsplit(" ", 1)[0]
    if text.count('"') % 2:
        text = text.replace('"', "")
    text = text.strip().rstrip(".,;:!").strip()
    if not text or text.lower().strip('"') in _FILL_IN_BLANKS or "<" in text or ">" in text:
        return None
    return text


def parse_fill_in(raw, fields):
    """Read a fill-in reply. `raw` is everything after the prompt - _fill_in_reply_start is put
    back on the front here, so the first answer has its label. Returns {field: text} for the
    EMPTY fields only; a field that did not come back usable is left out. A kept field is never
    in the result, and an answer that just copies a kept field is not a pick."""
    missing = [f for f in FILL_IN_FIELDS if not (fields.get(f) or "").strip()]
    kept = {(fields.get(f) or "").strip().lower() for f in FILL_IN_FIELDS} - {""}
    text = _fill_in_reply_start(fields) + (raw or "")
    got = {}
    for line in text.splitlines():
        m = _FILL_IN_LABEL_RE.match(_MARKDOWN_SYMBOL_RE.sub("", line))
        if not m:
            continue
        field = _FILL_IN_LABEL_FIELD[m.group(1).lower()]
        if field not in missing or field in got:
            continue
        value = _fill_in_value(m.group(2))
        if value and value.lower() not in kept:
            got[field] = value
    return got


def generate_fill_in(fields):
    """Ask Qwen3-VL for every empty field in `fields`, retrying once on a fresh seed if any of
    them did not come back. Returns what it got ({} if nothing). Raises only when ComfyUI could
    not be reached at all, so the page can say so."""
    fields = {f: (fields.get(f) or "").strip() for f in FILL_IN_FIELDS}
    missing = [f for f in FILL_IN_FIELDS if not fields[f]]
    got = {}
    last_error = None
    for attempt in range(2):
        want = {f: (fields[f] or got.get(f, "")) for f in FILL_IN_FIELDS}
        if all(want.values()):
            break
        payload = {
            # Byte-identical to _krea2_loaders()["k_clip"] on purpose - see generate_intro_story.
            "k_clip": {"inputs": {"clip_name": KREA2_CLIP, "type": "krea2", "device": "default"},
                       "class_type": "CLIPLoader"},
            "fill_gen": {
                "inputs": {
                    "clip": ["k_clip", 0],
                    "prompt": _fill_in_prompt(want),
                    "max_length": FILL_IN_MAX_TOKENS,
                    "sampling_mode": "on",
                    "sampling_mode.temperature": FILL_IN_TEMPERATURE,
                    "sampling_mode.top_k": 64,
                    "sampling_mode.top_p": 0.95,
                    "sampling_mode.min_p": 0.05,
                    "sampling_mode.repetition_penalty": 1.05,
                    "sampling_mode.seed": random.randint(0, 2**32 - 1),
                    "thinking": False,
                    "use_default_template": False,
                },
                "class_type": "TextGenerate",
            },
            "fill_out": {"inputs": {"source": ["fill_gen", 0]}, "class_type": "PreviewAny"},
        }
        try:
            t0 = time.time()
            raw = _submit_and_collect_text(payload, "fill_out", timeout=60)
            # A second attempt is asked with the first attempt's good answers already written
            # in, so parse against that and keep only what was still missing.
            new = parse_fill_in(raw, want)
            got.update({f: v for f, v in new.items() if f in missing})
            print(f"[fill_in] attempt {attempt + 1} in {time.time()-t0:.1f}s: {raw!r} -> {new}")
        except Exception as e:
            last_error = e
            print(f"[fill_in Error] {e}")
            if isinstance(e, urllib.error.URLError):
                break   # ComfyUI is not there; a retry will not find it either
    if not got and last_error is not None:
        raise last_error
    return got


_STORY_USER = """A player is about to descend into a generated dungeon. They described it like this:

The dungeon looks like: {wall}
The player is: {player}
Their weapon is: {weapon}
The enemies are: {enemy}

{cast}

Name the rest, then write the opening crawl. It must build to something worth
fighting for and end feeling like the start of a hero's journey, not a warning label:

- Paragraph 1 sets the scene and the danger. Do not introduce the player by name or
  describe who they are - that line is added separately, before your paragraph.
- Paragraph 2 makes the stakes concrete: what has the BOSS taken, or what will it destroy
  if nobody stops it? Someone, some place, or everyone - name what is actually at risk.
  Not vague dread - a real reason to care.
- Paragraph 3 is a rallying cry. Speak directly to the player ("you"). Make defeating the
  BOSS feel possible and necessary. End on hope and resolve, not doom.

After the three paragraphs, write ONE final line: a short, vivid send-off that puts the
player through the door right now. A single sentence. Atmospheric, propulsive, in the
spirit of these (write an ORIGINAL one that fits THIS dungeon - do not reuse these):
  "Light a torch, draw your blade, and pray whatever took them hasn't finished eating yet."
  "Let the depths claim whoever they want; tonight, they give them back."
  "Every second you stand on the threshold, another heartbeat fades below."
  "The descent begins not with a fall, but with a choice."
  "You strike the match, step past the threshold, and let the labyrinth swallow you whole."
  "The stone doors grind shut behind you, and the darkness exhales."

{place_rule}

Reply using EXACTLY these four labels, each on its own line, in this order. No preamble,
no markdown, no commentary, no asterisks:

LOCATION: <a 2-4 word proper name for the dungeon>
SAVED: <2-6 words naming who or what is safe once the BOSS falls - the same stake paragraph
  two makes concrete. PLURAL, and written to follow the word "The" and take a plural verb.
  Build it out of THIS dungeon: the people, creatures or places that live in or around
  {wall}, named with the names above. Follow a shape like "<the people> of <the LOCATION>"
  or "<the places> along <a landmark of this world>" - do not copy those shapes literally,
  and never invent an unrelated town, village or region to put them in. Never one person,
  never an abstraction like "hope" or "the future">
CRAWL:
<paragraph one - the scene and danger>

<paragraph two - the stakes: what is lost if the boss is not stopped>

<paragraph three - a direct, second-person rallying cry that ends on hope, not doom>
HOOK: <one short, vivid send-off sentence>

The line "CRAWL:" is required and must appear on its own, and so is "HOOK:". Write exactly
three paragraphs after CRAWL:, separated by blank lines, each 2 or 3 sentences. Use the
names above."""


def _story_prompt(wall_style, player_style, weapon_style, enemy_style, with_image=False,
                  names=None):
    """Hand-built chat template - two subtleties, both of which silently ruin the output.

    1. Krea2Tokenizer replaces the default template with KREA2_TEMPLATE, whose system prompt
       is "Describe the image by detailing the color, shape, size, texture...". Useless for
       prose. Opening the string with <|im_start|> makes Qwen3VLTokenizer set skip_template
       and take our text verbatim instead.
    2. skip_template ALSO skips the automatic <think></think> suppressor, which lives inside
       the non-skip branch. Without the empty think block appended here, Qwen3 reasons out
       loud and the monologue lands in the crawl.

    `names` is generate_story_names()'s decision: the crawl is written around that hero and
    boss (and a quoted wall's location) instead of inventing its own - see the NAMES note."""
    names = names or {}
    hero = names.get("hero") or _story_title(player_style, "The Nameless")
    boss = names.get("boss") or "The Warden"
    cast = (f"The player is called {hero}, and the boss - the champion of those enemies - is "
            f"called {boss}. Both names are already decided: use them exactly as written.")
    if names.get("location"):
        place_rule = f"The dungeon is already named too: it is called {names['location']}."
    else:
        shapes = random.sample(_PLACE_NAME_SHAPES, 2)
        place_rule = ("Name the dungeon the way a real place like it gets named, out of what is "
                      f"actually in it - for this one, try naming it {shapes[0]}; or {shapes[1]}.")
    user = _STORY_USER.format(
        wall=(wall_style or "").strip() or "a forgotten place",
        player=(player_style or "").strip() or "a nameless wanderer",
        weapon=(weapon_style or "").strip() or "a rusted blade",
        enemy=(enemy_style or "").strip() or "things that shamble",
        cast=cast,
        place_rule=place_rule,
    )
    vision = ""
    if with_image:
        # The image-pad substitution scans tokenized ids for 151655 regardless of
        # skip_template, so splicing the vision block in by hand works.
        vision = "<|vision_start|><|image_pad|><|vision_end|>"
        user = "This is what the player looks like.\n\n" + user
    return (
        "<|im_start|>system\n" + STORY_SYSTEM + "<|im_end|>\n"
        "<|im_start|>user\n" + vision + user + "<|im_end|>\n"
        "<|im_start|>assistant\n"
        "<think>\n\n</think>\n\n"
    )


def _submit_and_collect_text(payload, out_key, timeout=180, job_key=None):
    """Sibling of _krea2_submit_and_collect for a text output. PreviewAny is an OUTPUT_NODE
    returning {"ui": {"text": (value,)}}, so the string lands in history under
    outputs[out_key]["text"][0] rather than the ["images"][0] shape the image path expects."""
    _bail_if_cancelled()
    PROGRESS.begin_job(job_key)
    data = json.dumps({"prompt": payload, "client_id": COMFY_CLIENT_ID}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        prompt_id = _track_prompt(json.loads(resp.read().decode("utf-8"))["prompt_id"])

    start_time = time.time()
    while time.time() - start_time < timeout:
        time.sleep(0.2)
        _bail_if_cancelled()
        hist_req = urllib.request.Request(f"{COMFY_URL}/history/{prompt_id}")
        with urllib.request.urlopen(hist_req) as h_resp:
            hist_data = json.loads(h_resp.read().decode("utf-8"))
        if prompt_id not in hist_data:
            continue
        entry = hist_data[prompt_id]
        outputs = entry.get("outputs", {})
        if out_key in outputs:
            PROGRESS.finish_job(job_key)
            return outputs[out_key]["text"][0]
        if entry.get("status", {}).get("status_str") == "error":
            raise RuntimeError("ComfyUI rejected the story prompt")
    raise TimeoutError("intro story generation timed out.")


_STORY_SMART = {
    "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
    "\u2013": "-", "\u2014": " - ", "\u2026": "...", "\u00a0": " ",
    "\u2022": "-", "\u2032": "'", "\u2033": '"',
}
_STORY_STRIP = "*_#\"'` \t"
_STORY_LABELS = ("location", "hero", "foe", "boss", "saved")

# Markdown marks the model sometimes drops mid-sentence ("the *cursed* blade", "a #1 threat")
# - _STORY_STRIP only trims these off the ends of a string, so one wrapped around a word in
# the middle of a paragraph survived into the crawl text and, worse, got read by Piper as its
# literal name: "the asterisk cursed asterisk blade". Stripped everywhere, not just the ends.
_MARKDOWN_SYMBOL_RE = re.compile(r"[*_#`]")

# Safety net for when the small model forgets the boss's name and falls back to a generic
# "the boss" / "boss" instead - caught and swapped for the real name by _name_rewriter.
#
# The boss used to fight under a random title prepended to its name as well ("Dread", "Apex",
# "Undying" ...). It is gone: it was half of "Apex The Unmaker" on a dungeon of people, and it
# turned "Doom Tickle" and "Undying Grassy" into names that had nothing to do with a stuffed
# animal or a lawn. The boss is called its name - "just Bill".
_GENERIC_BOSS_PHRASE_RE = re.compile(r"\bthe\s+boss\b", re.IGNORECASE)
_GENERIC_BOSS_WORD_RE = re.compile(r"\bboss\b", re.IGNORECASE)

# Role words the model reaches for when it forgets to invent a name at all. "The Boss" is not
# a name, and taking one at face value is what put "Hollow The Boss" on the health bar.
_GENERIC_NAME_WORDS = frozenset((
    "boss", "champion", "enemy", "foe", "villain", "monster", "creature", "beast",
    "hero", "player", "dungeon", "location", "name", "thing", "one",
))


def _is_generic_name(name):
    """True when a name label came back as the role word instead of an invented name - "The
    Boss", "Enemy", "the champion". Only fires when nothing but articles and role words is
    left, so "Boss Byte" and "The Hollow Champion" both survive as real names."""
    words = [w for w in re.findall(r"[a-zA-Z]+", (name or "").lower())
             if w not in ("the", "a", "an", "of")]
    return bool(words) and all(w in _GENERIC_NAME_WORDS for w in words)


def _name_rewriter(keep=(), renames=None, boss=None):
    """One regex, one pass, for every name the narrated text has to agree on - see the note in
    parse_story_block for why it can never be several passes. Its alternatives, longest first
    so the fullest name wins wherever two could start:

      keep     names that must come through exactly as written. They are listed only so that
               nothing shorter can bite into the middle of one: a foe called "Boss Byte" is not
               the generic word "boss" plus "Byte".
      renames  old name -> new, any case, trailing plural "s" included: a name the reply wrote
               into its own prose that something since replaced - a quoted name, or a place
               with its stock word swapped out.
      boss     the boss's final name: its plural folds back into it, and the generic "the
               boss" / "boss" the model falls back on becomes it too.

    Returns text -> text. Replacements come out of a function, so a name is never reread as a
    regex backreference."""
    entries = []    # (length, pattern, replacement - None hands the match back untouched)
    for name in keep:
        if name:
            entries.append((len(name), "(?i:" + re.escape(name) + ")", None))
    for old, new in (renames or {}).items():
        if old and new and old.lower() != new.lower():
            entries.append((len(old), "(?i:" + re.escape(old) + ")s?", new))
    if boss:
        entries.append((len(boss), "(?i:" + re.escape(boss) + ")s?", boss))
    entries.sort(key=lambda e: e[0], reverse=True)
    patterns = [r"(?<![A-Za-z0-9])" + p + r"(?![A-Za-z0-9])" for _, p, _ in entries]
    replacements = [r for _, _, r in entries]
    if boss:
        for generic in (_GENERIC_BOSS_PHRASE_RE, _GENERIC_BOSS_WORD_RE):
            patterns.append("(?i:" + generic.pattern + ")")
            replacements.append(boss)
    if not patterns:
        return lambda text: text or ""
    rx = re.compile("|".join("(" + p + ")" for p in patterns))

    def _sub(m):
        new = replacements[m.lastindex - 1]
        return m.group(0) if new is None else new
    return lambda text: rx.sub(_sub, text or "")



def _ascii_ify(text):
    """The UI is a Win95 pastiche - smart quotes and em-dashes look wrong in it, and
    /api/progress serialises with ensure_ascii=True so they would travel as \\uXXXX noise.
    Also drops stray markdown symbols anywhere in the text - see _MARKDOWN_SYMBOL_RE."""
    for bad, good in _STORY_SMART.items():
        text = text.replace(bad, good)
    text = _MARKDOWN_SYMBOL_RE.sub("", text)
    return text.encode("ascii", "ignore").decode("ascii")


# Words a name should never end on after truncation - articles, prepositions and
# conjunctions that only make sense with whatever came next (which the word cap ate).
_STORY_TRAILING_STOPWORDS = frozenset((
    "the", "a", "an", "of", "and", "or", "in", "on", "at", "to", "for", "with",
    "from", "by", "as", "into", "that", "this", "these", "those", "'s", "&",
))


def _story_name(raw, fallback, max_words=4):
    name = _ascii_ify(raw or "").strip().strip(_STORY_STRIP)
    name = re.sub(r"^<|>$", "", name).strip()
    name = re.sub(r"\s+", " ", name)
    if not name or len(name) > 48:
        return fallback
    words = name.split(" ")
    if len(words) > max_words:
        words = words[:max_words]
    # Slicing at a fixed word count can land mid-phrase and leave the name ending on a
    # connective - "The Core Of The" instead of "The Core Of The Overclocker". Drop any
    # trailing connectives so a truncated name still reads as a finished phrase.
    while len(words) > 1 and words[-1].lower() in _STORY_TRAILING_STOPWORDS:
        words.pop()
    name = " ".join(words)
    return name or fallback


# Suffixes where the trailing "s" is part of the word, not a plural - Atlas, Nemesis, Chaos,
# Marcus, Achilles, Chess would all get mangled by a naive strip.
_NAME_NONPLURAL_S = ("as", "is", "os", "us", "es", "ss")


def _singular_creature_name(name):
    """Strip a naive trailing plural "s" from an invented enemy name. FOE/BOSS each name one
    creature the player fights face to face, so a model-invented "Overclockers" or "Wraiths"
    reads as a typo once it is standing alone in the arena - trim it to "Overclocker"/"Wraith"."""
    words = name.split(" ")
    last = words[-1]
    if len(last) > 3 and last.lower().endswith("s") and not last.lower().endswith(_NAME_NONPLURAL_S):
        words[-1] = last[:-1]
        return " ".join(words)
    return name


# Generic stakes for when there is no SAVED line to read - a parse failure, a refusal, or
# a bundle built before the label existed. Plural and article-less, the shape the model is
# asked for. SAVED no longer feeds the victory outro (that closes on the way out now), but
# the label still earns its keep: it makes the model commit to a concrete stake for the
# crawl's second paragraph, it marks where the label block ends so the CRAWL body can be
# found without the marker, and the normalised phrase ships in the story bundle.
_STAKE_FALLBACKS = [
    "cats of Mow Meow",
    "Mow Meow cats of Catalina Island",
    "sunning cats of Catalina Island",
    "nine lives of Mow Meow",
]

# "All the miners" / "every last homestead" - the leading determiner is stripped so the
# phrase can drop into a sentence that brings its own article. Repeated so "all of the" goes
# in one pass rather than leaving "the" behind.
_STAKE_DETERMINER_RE = re.compile(r"^(?:(?:all\s+of|the|a|an|all|every|each)\s+)+", re.IGNORECASE)


def _story_stake(raw, fallback):
    """SAVED names who or what the boss was going to take. Normalised to an article-less noun
    phrase so any sentence that uses it can supply its own determiner and punctuation."""
    text = _story_name(raw, "", max_words=6)
    text = _STAKE_DETERMINER_RE.sub("", text).strip().strip(".,;:!")
    return text or fallback


# The run's last words, read over the victory box by the same narrator who read the crawl.
# They live here rather than in game.js because the outro is NARRATED: Piper has to be handed
# the finished sentence at generation time, and a second copy of the list in the client would
# be a copy that drifts. Every line names the hero, the dungeon and the boss, and closes on
# the way out rather than on who was saved. The boss stands on the exit's approach (see
# placeEnemyMarkers in game.js), so each line can take it as read that the way out went
# through it.
_VICTORY_OUTROS = [
    "Congrats {hero}! Good job getting out of {area} - {boss} had it coming, "
    "and you were the one who brought it.",
    "{hero} walks out of {area} alive. {boss} does not, and that was always the deal.",
    "That's {area} behind you, {hero}. {boss} is a story now, and you're the one who tells it.",
    "Well done, {hero}! {boss} held {area} for a long time, and lost it to you in an afternoon.",
    "You did it, {hero}. {area} is quiet stone again, {boss} is bones, "
    "and the door is open behind you.",
    "The stairs at last! {hero} leaves {area} on two feet, the way {boss} never will.",
    "Daylight, {hero}. You took {area} apart, left {boss} in the wreck of it, "
    "and climbed out clean.",
    "Congratulations, {hero}! {boss} ruled {area} right up until you disagreed, "
    "and the argument is settled.",
    "{hero} climbs out of {area} with {boss}'s reign ended in the dark below.",
    "Out of {area} and into the light, {hero}. {boss} had it coming and you saw that it came.",
    "It's over, {hero}. {area} keeps {boss} now, and you keep the way out.",
    "Take the air, {hero} - you earned it. {boss} is finished and {area} is nothing but echoes.",
]


def _story_outro(story):
    """Fill one victory line from the story's own names. Never raises - a bad line only
    costs the outro its text, and the victory box keeps the generic line in index.html."""
    try:
        return random.choice(_VICTORY_OUTROS).format(
            hero=story["hero"], area=story["location"], boss=story["boss"])
    except Exception:
        return ""


def _lead(name, upper=True):
    """Give a name its article unless it brought one. Without this the fallback crawl reads
    "The The Horde wait in the dark"."""
    if re.match(r"^(the|a|an)\s", name, re.IGNORECASE):
        return name
    return ("The " if upper else "the ") + name


# Original send-offs (not copies of the examples given to the model) for when there is no
# LLM reply to draw one from - a parse failure or a refusal. One is picked per fallback so
# repeated failures don't all read identically.
_STORY_HOOK_FALLBACKS = [
    "The door will not wait, and neither should you.",
    "Whatever is down there has had long enough.",
    "Take a breath. This is the last quiet moment you get.",
    "The dark does not knock twice.",
]


def _story_hook(raw, fallback):
    text = _ascii_ify(raw or "").strip().strip(_STORY_STRIP)
    text = re.sub(r"\s+", " ", text)
    if not text or len(text) > 200:
        return fallback
    return text


def _squash(text):
    """Lowercase, letters-and-digits-only - for comparing two sentences that may differ
    only in punctuation or capitalization (e.g. a trailing period, "Slick" vs "The Slick")."""
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


# A typed description that already starts on one of these takes no "a" in front of it.
_DESCRIPTION_DETERMINERS = frozenset((
    "a", "an", "the", "my", "your", "his", "her", "their", "our", "some", "one", "two", "three",
))


def _hero_opener(hero, player_desc):
    """Build the "You are <name>[, <what they are>]." line that opens paragraph 1. The
    invented HERO name is often just a title-cased echo of the player's own description
    ("gingerbread paladin with frosting armor" -> "Gingerbread Paladin"), which would read
    as "You are Gingerbread Paladin, gingerbread paladin with frosting armor." - so the
    description is dropped whenever the name already contains it.

    And the other way round, now that a hero can be named for what they are: "Sally the
    Cashier" for a cashier would read "You are Sally the Cashier, cashier.", and "Biscuit the
    Fluffy Cat" for a fluffy white cat hardly needs the three words after it either. So a
    description is also dropped when the name already carries all of its words, or when it is
    short and the name's "the <what>" is made of its words. Whole words only, so a cat named
    "Catherine" still gets to be a cat.

    A description that is kept gets an article unless it brought one - "You are Ellen, a
    cashier." - since a hero named Ellen now leaves it standing alone after the comma."""
    if _squash(hero) and _squash(hero) in _squash(player_desc):
        return f"You are {hero}."
    desc_words = re.findall(r"[a-z0-9]+", player_desc.lower())
    hero_words = set(re.findall(r"[a-z0-9]+", hero.lower()))
    what_words = set(re.findall(r"[a-z0-9]+", hero.lower().partition(" the ")[2]))
    if desc_words and (set(desc_words) <= hero_words
                       or (what_words and len(desc_words) <= 3 and what_words <= set(desc_words))):
        return f"You are {hero}."
    if desc_words[:1] and desc_words[0] not in _DESCRIPTION_DETERMINERS:
        player_desc = _a_or_an(player_desc)
    return f"You are {hero}, {player_desc}."


def _story_title(text, fallback):
    text = _ascii_ify(text or "").strip()
    if not text:
        return fallback
    return " ".join(w[:1].upper() + w[1:] for w in text.split())[:48]


def parse_story_block(text, wall_style="", player_style="", enemy_style="", named=None,
                      names=None):
    """Pull the names and the crawl paragraphs out of the model's reply. Never raises.

    The 4B emits the label lines reliably but drops the bare "CRAWL:" marker perhaps half the
    time, so the prose is taken as everything after the last label line rather than requiring
    the marker to be there.

    `names` is generate_story_names()'s decision, which the crawl was written around: its hero,
    boss and foe win over any HERO/BOSS/FOE line in the reply. The crawl prompt no longer asks
    for those lines, so they only matter when no decision was passed in.

    `named` is a resolve_named_styles() dict (or None). A quoted wall/player/enemy field
    overrides LOCATION/HERO/BOSS below regardless of what the model invented - a named
    individual, not a description, so the name it was actually given is the one that has to
    show up, and this is the one path that reaches every place it needs to: the HUD, the
    health bar and the screensaver marquee all read dungeonStory.boss (game.js), not the
    species name."""
    text = _ascii_ify(text or "")
    fallbacks = {
        "location": _story_title(wall_style, "The Dungeon"),
        "hero": _story_title(player_style, "The Nameless"),
        "foe": _clean_what(enemy_style) or "The Horde",
        "boss": "The Warden",
        "saved": random.choice(_STAKE_FALLBACKS),
    }
    out = dict(fallbacks)

    max_words = {"location": 6, "hero": 3, "foe": 3, "boss": 3, "saved": 6}
    last_label_end = 0
    found = set()
    for key in _STORY_LABELS:
        m = re.search(r"^\s*" + key + r"\s*:\s*(.+)$", text, re.IGNORECASE | re.MULTILINE)
        if m:
            out[key] = _story_name(m.group(1), fallbacks[key], max_words[key])
            if key in ("foe", "boss"):
                out[key] = _singular_creature_name(out[key])
                # "BOSS: The Boss" is the model answering with the label instead of a name.
                # Downstream everything treats this as a proper noun - the health bar, the
                # crawl rewrite, the outro - so it is caught here, at the only point where
                # the themed fallback is still in reach. The boss's fallback is the foe it
                # champions, made bigger, when the reply did name one: "Big Ring Runner" has
                # something to do with the dungeon, "The Warden" never did.
                if _is_generic_name(out[key]):
                    out[key] = fallbacks[key]
                    if key == "boss" and "foe" in found:
                        out[key] = "Big " + re.sub(r"^the\s+", "", out["foe"], flags=re.I)
            last_label_end = max(last_label_end, m.end())
            found.add(key)

    # What the reply itself called the boss and the dungeon - the prose was written around
    # these, so whatever replaces them below has to be carried back into it.
    model_boss = out["boss"] if "boss" in found else None
    model_location = out["location"] if "location" in found else None

    for key in ("hero", "boss", "foe", "location"):
        if (names or {}).get(key):
            out[key] = names[key]

    # A quoted wall/player field names the location/hero outright - the model's own invented
    # name (or its title-cased fallback) loses to it unconditionally.
    wall_ent = (named or {}).get("wall")
    if wall_ent and wall_ent.get("kind"):
        out["location"] = wall_ent["name"]
    #
    # HERO is the one of the three that does NOT wait on a resolved kind. Quoting is the
    # player saying "this is my name", and the identity call is a coin flip on whether it
    # recognises one - the very same '"Elon Musk" meme' field came back `person (known)` on
    # one run and `(unresolved)` on the next, and on the unresolved run the model's own
    # "Elon Musk Meme" took the HERO line, so the crawl, the status label and the death and
    # victory lines all addressed the player by their entire typed phrase. What KIND of
    # thing the name is only ever matters to the art prompts; what to CALL the player does
    # not need it, so the quoted span wins here whether or not anything was recognised.
    player_ent = (named or {}).get("player")
    if player_ent:
        out["hero"] = player_ent["name"]

    # A quoted enemy field overrides the CHAMPION'S NAME the same unconditional way - the
    # whole point of "Billy" the cat is that the boss is Billy, not whatever the model invented
    # instead. The model was hardly discouraged from using the name it was handed ("a cat
    # called Billy" in its own input), so both the reply's own boss name AND the entity's real
    # name are rewritten to the final one below - whichever the prose actually used, the reader
    # always gets the same name back.
    enemy_ent = (named or {}).get("enemy")
    if enemy_ent and enemy_ent.get("kind"):
        out["boss"] = enemy_ent["name"]

    # "Ashen" out of the model's own place names - see _STOCK_PLACE_WORDS. Swapped as a whole
    # place name read out of the reply's location and stake ("Ashen Womb" -> "Cinder Womb"),
    # never as a bare word, because the prose is full of other uses of it: "the Ashen One" is a
    # name and "Ashen skies" is weather. A decided or quoted location is the player's own word.
    backup = random.choice(_PLACE_WORD_BACKUPS)
    stock_re = re.compile(r"\b(?:" + "|".join(_STOCK_PLACE_WORDS) + r")\b", re.IGNORECASE)
    place_renames = {}
    own_location = model_location if out["location"] == model_location else ""
    for label in (out["saved"], own_location):
        for phrase in re.findall(r"[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)+", label or ""):
            phrase = re.sub(r"^The\s+", "", phrase)
            if " " in phrase and stock_re.search(phrase):
                place_renames[phrase] = stock_re.sub(backup, phrase)
    if own_location:
        out["location"] = _name_rewriter(renames=place_renames)(out["location"])

    # ONE alternation, ONE pass, and that is the entire point. Run as four separate re.sub
    # calls, each pass rescanned the text the previous pass had already rewritten, so a name
    # containing any word a later pattern looks for grew every time it was substituted. With
    # the model answering "BOSS: The Boss" under the old random boss titles, the crawl went
    # "The Boss" -> "Hollow The Boss" -> "Hollow Hollow The Boss" -> "Hollow Hollow The Hollow
    # The Boss". re.sub never rescans its own replacement, so one combined regex fixes it
    # outright - see _name_rewriter.
    #
    # The trailing "s?" on the boss is load-bearing: the label loop already ran the name
    # through _singular_creature_name, so a model that answered "BOSS: Whiskers" leaves
    # "Whisker" here while the prose it wrote still says "Whiskers". Without it the mention is
    # missed entirely; matching bare would swap the stem and strand the "s" as "Billys".
    renames = {}
    if model_boss:
        renames[model_boss] = out["boss"]
    if enemy_ent and enemy_ent.get("kind"):
        renames[enemy_ent["name"]] = out["boss"]
    if model_location:
        renames[model_location] = out["location"]
        # "The Ashen Maw" is just "Ashen Maw" mid-sentence. Only for a name of two words or
        # more: a bare "Vault" would take every ordinary vault in the prose with it.
        bare = re.sub(r"^The\s+", "", model_location, flags=re.IGNORECASE)
        if bare != model_location and " " in bare:
            renames.setdefault(bare, re.sub(r"^The\s+", "", out["location"], flags=re.IGNORECASE))
    for phrase, swapped in place_renames.items():
        renames.setdefault(phrase, swapped)     # a quoted location outranks a swapped word
    rewrite = _name_rewriter(keep=(out["hero"], out["foe"], out["location"]),
                             renames=renames, boss=out["boss"])

    # SAVED is a noun phrase, not a proper name - it goes through the label loop for the
    # CRAWL-marker bookkeeping above, then takes the same renames as the prose (it is where
    # "people of Ashen Maw" lived) and loses its determiner.
    out["saved"] = _story_stake(rewrite(out["saved"]), fallbacks["saved"])

    # HOOK is a single sentence, not a name, so it skips the word-count truncation the
    # other labels get - only pulled out here so it doesn't get swept into the paragraphs.
    hook_match = re.search(r"^\s*HOOK\s*:\s*(.+)$", text, re.IGNORECASE | re.MULTILINE)
    hook_fallback = random.choice(_STORY_HOOK_FALLBACKS)
    out["hook"] = _story_hook(hook_match.group(1), hook_fallback) if hook_match else hook_fallback
    out["hook"] = rewrite(out["hook"])

    m = re.search(r"^\s*CRAWL\s*:\s*$", text, re.IGNORECASE | re.MULTILINE)
    body = text[m.end():] if m else text[last_label_end:]

    paragraphs = []
    # No labels at all means the reply was not in the requested shape - a refusal, a
    # preamble, a wall of markdown. Trusting the body then ships "I'm sorry, I can't help
    # with that." as the opening crawl, so treat the whole reply as unusable instead.
    if found:
        for chunk in re.split(r"\n\s*\n", body):
            lines = [ln.strip().rstrip("\\") for ln in chunk.strip().splitlines()]
            lines = [ln for ln in lines if ln and
                     not re.match(r"^(LOCATION|HERO|FOE|BOSS|SAVED|CRAWL|HOOK)\s*:", ln,
                                  re.IGNORECASE)]
            para = " ".join(lines).strip().strip("*_#")
            if len(para) > 20:
                para = rewrite(para)
                paragraphs.append(re.sub(r"\s+", " ", para))

    # Always used to open paragraph 1 with "You are <name>, <what they are>." - built here,
    # not left to the model, so it can never come out as the literal word "HERO".
    player_desc = (player_style or "").strip() or "a nameless wanderer"

    hero_opener = _hero_opener(out["hero"], player_desc)

    if paragraphs:
        paragraphs[0] = hero_opener + " " + paragraphs[0]

    if not paragraphs:
        # Even the degraded fallback earns a rallying ending, not a warning label - the
        # crawl is meant to send the player in fired up, whether the model wrote it or not.
        # out["boss"] is a proper name ("Sally the Cashier", "The Warden") and takes no extra
        # article - unlike _lead(location) below.
        paragraphs = [
            hero_opener + " You enter "
            + _lead(out["location"], upper=False)
            + ", where the light dies and the old walls remember worse.",
            out["boss"] + " rules here now, and holds everything it has taken.",
            "Whatever " + out["boss"] + " is planning ends today - or nothing does. Go.",
        ]
    # Capped at 3, matching what the prompt actually asks for. A 4th paragraph the model
    # over-generates is usually its own attempt at a send-off, which duplicates HOOK.
    out["crawl"] = paragraphs[:3]

    # The model sometimes reuses its own final paragraph as the HOOK line too, regardless
    # of paragraph count (seen in testing even with exactly 3 paragraphs) - drop the
    # duplicate from the crawl rather than reading the same line twice back to back.
    if out["crawl"] and _squash(out["crawl"][-1]) == _squash(out["hook"]):
        out["crawl"].pop()

    # Built here, not in the client, so the same sentence can be handed to Piper - see
    # _VICTORY_OUTROS. out["boss"] is final by this point.
    out["outro"] = _story_outro(out)

    return out


# ---------------------------------------------------------------------------
# Narration: Piper (local neural TTS, CPU-only) reads the crawl aloud
# ---------------------------------------------------------------------------
# Runs entirely outside ComfyUI - no GPU, no queue contention with image generation. Model
# load is the only slow part (~0.3-0.85s) and is cached per process; synthesis itself is
# ~0.3s per paragraph on CPU, so narrating a whole story costs under two seconds.
PIPER_VOICES_DIR = os.path.join(PROJECT_DIR, "piper_voices")
# One narrator is picked per story (not per paragraph) so the voice stays consistent
# through the whole crawl; alan and kristin were chosen after listening to samples.
PIPER_VOICE_NAMES = ["en_GB-alan-medium", "en_US-kristin-medium"]
_piper_voice_cache = {}


def _get_piper_voice(name):
    """Load and cache a Piper voice by name. Returns None (never raises) if piper-tts is
    not installed or the model files are missing, so narration degrades to silence rather
    than costing the player their story or their assets."""
    if name in _piper_voice_cache:
        return _piper_voice_cache[name]
    try:
        from piper import PiperVoice
        model_path = os.path.join(PIPER_VOICES_DIR, name + ".onnx")
        voice = PiperVoice.load(model_path)
    except Exception as e:
        print(f"[narration] could not load Piper voice '{name}' ({e}) - narration disabled")
        voice = None
    _piper_voice_cache[name] = voice
    return voice


# Piper's phonemizer (espeak-ng) gives a comma only a clipped breath, throws a standalone
# dash away entirely, and butts sentences straight up against each other (it synthesizes one
# chunk per sentence and concatenates them with no gap), which runs dramatic lines together.
# Rather than fight the phonemizer, the text is cut at those marks, each piece is synthesized
# on its own, and real silence is spliced between the pieces. Each piece keeps its own
# terminating mark so the model still reads it with the right intonation.
COMMA_PAUSE_MS = 180
SEMICOLON_PAUSE_MS = 260
DASH_PAUSE_MS = 260
PERIOD_PAUSE_MS = 350
# Only dashes standing alone as punctuation - a hyphen inside "blood-soaked" is part of the
# word and must not become a pause.
_DASH_RE = re.compile(r"\s+[-‐-―]+\s+|\s+[-‐-―]+$")
# A sentence break needs the following whitespace so "3.5" and "..." stay in one piece; a
# comma or semicolon splits either way.
_MARK_SPLIT_RE = re.compile(r"(?<=[,;])\s*|(?<=[.!?…])\s+")
_SENTENCE_END = (".", "!", "?", "…")

# A period after one of these isn't a sentence end - "Dr. Nix" is one name, not "Dr." full
# stop then "Nix". Checked against the last word before a trailing period, case-insensitive
# (invented names get title-cased, e.g. "Dr."), so a beat-of-silence pause never lands
# mid-title.
_TITLE_ABBREVIATIONS = {
    "dr", "mr", "mrs", "ms", "st", "jr", "sr", "prof", "capt", "col", "gen",
    "lt", "sgt", "maj", "cpl", "rev", "fr", "mt", "ft",
}
_TRAILING_ABBREV_RE = re.compile(r"(?:^|\s)([A-Za-z]+)\.$")


def _ends_with_abbreviation(piece):
    m = _TRAILING_ABBREV_RE.search(piece)
    return bool(m) and m.group(1).lower() in _TITLE_ABBREVIATIONS


def _split_for_pauses(text):
    """Cut `text` into (fragment, pause_ms) pairs at commas, standalone dashes and sentence
    ends. The final fragment carries a 0ms pause."""
    parts = []
    # Dashes have no phoneme of their own, so they become commas: the comma supplies the
    # phrasing and the longer dash silence is spliced in after it.
    for chunk in _DASH_RE.split(text):
        chunk = chunk.strip()
        if not chunk:
            continue
        if parts:
            # The dash itself is dropped; a comma in its place keeps the model reading the
            # fragment as an unfinished clause instead of ending it flat.
            lead = parts[-1][0]
            if not lead.endswith((",", ";", ":", ".", "!", "?")):
                lead += ","
            parts[-1] = (lead, DASH_PAUSE_MS)
        pieces = []
        for piece in _MARK_SPLIT_RE.split(chunk):
            piece = piece.strip()
            if not piece:
                continue
            # "Dr." split from "Nix" by the regex above - glue them back into one piece
            # before pause classification so nothing pauses on the abbreviation's period.
            if pieces and _ends_with_abbreviation(pieces[-1]):
                pieces[-1] = pieces[-1] + " " + piece
            else:
                pieces.append(piece)
        for piece in pieces:
            if piece.endswith(","):
                pause = COMMA_PAUSE_MS
            elif piece.endswith(";"):
                pause = SEMICOLON_PAUSE_MS
            elif piece.endswith(_SENTENCE_END):
                pause = PERIOD_PAUSE_MS
            else:
                pause = 0
            parts.append((piece, pause))
    if parts:
        parts[-1] = (parts[-1][0], 0)
    return parts


def _synthesize_with_pauses(voice, text, wf):
    """Write `text` to the open wave file `wf`, read by `voice`, with a beat of silence at
    every comma, standalone dash and sentence end."""
    fmt_set = False
    for fragment, pause_ms in _split_for_pauses(text) or [(text, 0)]:
        sample_rate = 22050
        for audio in voice.synthesize(fragment):
            if not fmt_set:
                wf.setframerate(audio.sample_rate)
                wf.setsampwidth(audio.sample_width)
                wf.setnchannels(audio.sample_channels)
                fmt_set = True
            sample_rate = audio.sample_rate
            wf.writeframes(audio.audio_int16_bytes)
        if pause_ms and fmt_set:
            wf.writeframes(b"\x00" * (int(sample_rate * pause_ms / 1000) * wf.getsampwidth() * wf.getnchannels()))


def synthesize_narration(texts):
    """Turn a list of strings into a list of `data:audio/wav;base64,...` clips read by one
    randomly chosen narrator, in the same order as `texts`. Returns (voice_name, clips) -
    (None, []) on any failure, so a TTS problem only costs narration, never the story text
    or the run itself."""
    texts = [t for t in (texts or []) if t and t.strip()]
    if not texts:
        return None, []
    voice_name = random.choice(PIPER_VOICE_NAMES)
    voice = _get_piper_voice(voice_name)
    if voice is None:
        return None, []
    try:
        clips = []
        for text in texts:
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                _synthesize_with_pauses(voice, text, wf)
            clips.append("data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode("ascii"))
        return voice_name, clips
    except Exception as e:
        print(f"[narration] synthesis failed ({e}) - narration disabled for this story")
        return None, []


def generate_intro_story(wall_style, player_style, weapon_style, enemy_style, player_image=None,
                         named=None):
    """Name the location / hero / foe / boss and write the opening crawl. Never raises - a
    story failure must not cost the player their assets, so it degrades to names derived
    from what they typed.

    The hero and the boss are named first, by generate_story_names, and the crawl is written
    around them. `named` is a resolve_named_styles() dict (or None), forwarded to both so a
    quoted wall/player/enemy field names the location/hero/boss outright - see
    parse_story_block."""
    image_name = None
    if player_image:
        try:
            b64 = player_image.split(",", 1)[-1]
            image_name = f"story_ref_{int(time.time()*1000)}.png"
            with open(os.path.join(COMFY_INPUT_DIR, image_name), "wb") as f:
                f.write(base64.b64decode(b64))
        except Exception as e:
            print(f"[story] could not stage the player image ({e}) - writing text-only")
            image_name = None

    names = generate_story_names(wall_style, player_style, enemy_style, image_name=image_name,
                                 named=named)

    payload = {
        # Byte-identical to _krea2_loaders()["k_clip"] on purpose: any difference in these
        # inputs forks ComfyUI's cache and loads a second 5.2GB copy of the model.
        "k_clip": {"inputs": {"clip_name": KREA2_CLIP, "type": "krea2", "device": "default"},
                   "class_type": "CLIPLoader"},
        "story_gen": {
            "inputs": {
                "clip": ["k_clip", 0],
                "prompt": _story_prompt(wall_style, player_style, weapon_style, enemy_style,
                                        with_image=bool(image_name), names=names),
                "max_length": STORY_MAX_TOKENS,
                # DynamicCombo in API format: the parent widget takes the option KEY and the
                # option's own widgets are dot-prefixed with it. Passing a nested dict makes
                # ComfyUI drop the input and the node then fails on a missing argument
                # (see DynamicCombo._expand_schema_for_dynamic in comfy_api/latest/_io.py).
                "sampling_mode": "on",
                "sampling_mode.temperature": STORY_TEMPERATURE,
                "sampling_mode.top_k": 64,
                "sampling_mode.top_p": 0.95,
                "sampling_mode.min_p": 0.05,
                "sampling_mode.repetition_penalty": 1.05,
                "sampling_mode.seed": random.randint(0, 2**32 - 1),
                "thinking": False,
                "use_default_template": False,
            },
            "class_type": "TextGenerate",
        },
        "story_out": {"inputs": {"source": ["story_gen", 0]}, "class_type": "PreviewAny"},
    }
    if image_name:
        payload["story_img"] = {"inputs": {"image": image_name}, "class_type": "LoadImage"}
        payload["story_gen"]["inputs"]["image"] = ["story_img", 0]

    try:
        t0 = time.time()
        raw = _submit_and_collect_text(payload, "story_out", job_key="story")
        story = parse_story_block(raw, wall_style, player_style, enemy_style, named=named,
                                  names=names)
        print(f"[story] '{story['location']}' - {story['hero']} vs {story['foe']} / "
              f"{story['boss']}, {len(story['crawl'])} paragraphs, {time.time()-t0:.1f}s")
    except Exception as e:
        print(f"[story Error] {e} - falling back to names from the player's own words")
        PROGRESS.finish_job("story")
        story = parse_story_block("", wall_style, player_style, enemy_style, named=named,
                                  names=names)

    # Narrate whichever text the player is actually about to see - including the fallback
    # crawl, which deserves a voice just as much as a model-written one. Order matches the
    # <p> elements startCrawl() builds in game.js: title, each crawl paragraph, then the
    # closing hook line last.
    # The outro rides along in the same call so it is read by the SAME narrator as the crawl
    # - synthesize_narration picks its voice per call, so a second call would hand the victory
    # box the other reader. It is popped straight back off afterwards: it plays over the
    # victory box, a whole run later, and has no <p> on the loading screen to line up with.
    narration = [story["location"]] + story["crawl"] + [story["hook"], story["outro"]]
    voice_name, clips = synthesize_narration(narration)
    story["voice"] = voice_name
    story["outro_audio"] = clips.pop() if len(clips) == len(narration) else None
    story["audio"] = clips
    if voice_name:
        print(f"[narration] {len(clips)} clip(s) read by {voice_name}")
    return story


# ---------------------------------------------------------------------------
# Dungeon foley: Stable Audio 3 Small-SFX writes the game's sound effects
# ---------------------------------------------------------------------------
# The sounds are generated from the SAME typed strings the art comes from, so a "Mossy
# Stone" dungeon squelches underfoot and a "Candy Cane" one crunches. v6 only.
#
# Why this model and not MiniMax H3: H3 *can* make audio - the `va` in minimax_h3_fl2va is
# video+audio, and minimax_h3_audio_vae_fp32 is already downloaded - but every sound would
# cost a full 768-short-edge video render through a 32B text encoder, its trained duration
# floor is ~5s, and its audio head is trained to sync to VISIBLE action, so with no matching
# footage it produces ambience rather than a clean isolated hit. Stable Audio 3 Small-SFX is
# purpose-built for one-shots and is natively supported (comfy/supported_models.py
# StableAudio3), no custom nodes. Measured: 12.3s for all eight sounds INCLUDING the cold
# model load, about 1.5s each.
SFX_CKPT = "stable_audio_3_small_sfx.safetensors"
SFX_CLIP = "t5gemma_b_b_ul2.safetensors"
SFX_STEPS = 8
SFX_CFG = 1.0                  # distilled like krea2 - describe everything positively
SFX_SAMPLER = "lcm"            # what the Comfy-Org SA3 template uses; core has no pingpong
SFX_SCHEDULER = "simple"
SFX_SECONDS = 2.0              # generated length; every clip is trimmed to its transient
SFX_SR = 22050                 # mono 16-bit at this rate keeps the whole pack near 200KB

SFX_NAMES = ["step", "bump", "turn", "attack", "miss_enemy", "block", "miss_player",
             "hit_enemy", "hit_player", "death_enemy", "death_player"]

# Per-sound length cap, applied AFTER trimming to the transient. Without one a footstep
# keeps its reverb tail and runs past a second - measured 1.20s on "wet mossy stone" - which
# sounds wrong under a 160ms move animation and bloats the bundle. A death cry is allowed to
# breathe. The fade-out below makes the truncation clean.
SFX_MAX_SEC = {"step": 0.45, "bump": 0.45, "turn": 0.35, "block": 0.60, "attack": 0.70,
               "miss_enemy": 0.55, "miss_player": 0.55,
               "hit_enemy": 0.70, "hit_player": 0.70,
               "death_enemy": 1.20, "death_player": 1.20,
               "ready": 1.00}

SFX_ONSET_DB = -35.0    # sensitive, so a soft attack transient is not clipped off the front
SFX_OFFSET_DB = -28.0   # tighter, so a long reverb tail is cut rather than kept
SFX_PREROLL = 0.010
SFX_FADE_IN = 0.003     # declick
SFX_FADE_OUT = 0.030

# Every prompt ends with this. cfg is 1.0, so exactly as with krea2 there is no negative
# guidance and every word is something being ASKED for - naming "no music" is a real risk -
# but measured output was clean one-shots on all seven genuine probes, so the isolation
# wording is earning its place. If a theme ever starts dragging music in, cut this tail
# down rather than adding a negative prompt, which would do nothing at this cfg.
_SFX_TAIL = (" One single short isolated sound effect. Close dry recording, silence before "
             "and after, mono, no music, no voices, no reverb tail.")

# Used instead of _SFX_TAIL for the sounds below that are supposed to carry a human
# vocalization (a grunt, cry or gasp) mixed with the foley. At cfg 1.0 there is no negative
# guidance, so "no voices" was fighting the "grunt"/"cry" wording already in these prompts on
# equal footing - the vocal element mostly averaged out to a plain thud instead of coming
# through. Dropping "no voices" for just these names is what makes them sometimes actually
# sound like a person.
_SFX_TAIL_VOICE = (" One single short isolated sound effect. Close dry recording, silence "
                    "before and after, mono, no music, no reverb tail.")
# Enemy vocal sounds (hit_enemy, death_enemy) intentionally keep _SFX_TAIL as-is: the enemy
# can be anything the player typed, including a non-creature (see the ambiguous-enemy-nouns
# case, e.g. "a stick of RAM"), so forcing a human voice onto it would be wrong more often
# than it would be right.
_SFX_VOICE_NAMES = {"bump", "attack", "hit_player", "death_player"}


def sfx_prompts(wall_style, player_style, weapon_style, enemy_style):
    """One prompt per entry in SFX_NAMES, built from what the player typed.

    Same fallback convention as krea2_weapon_prompt / krea2_shield_prompt: an empty field
    becomes a neutral noun rather than an empty hole in the sentence."""
    d = (wall_style or "").strip() or "old stone dungeon"
    p = (player_style or "").strip() or "armored warrior"
    w = (weapon_style or "").strip() or "sword"
    e = (enemy_style or "").strip() or "monster"
    out = {
        # wall_style is the one string describing what the whole dungeon looks like, which
        # is exactly what the floor underfoot should sound like.
        "step": f"A single footstep on {d} ground.",
        "bump": f"{_a_or_an(p)} grunting an 'oof' of surprise as they walk chest-first into "
                f"a solid {d} wall, a dull heavy thud.",
        "turn": f"A quick shuffling footstep as {_a_or_an(p)} pivots in place on {d} ground.",
        "attack": f"{_a_or_an(p)} grunting with effort as {_a_or_an(w)} is swung hard and "
                  f"fast through the air, striking.",
        "miss_enemy": f"{_a_or_an(w)} swung hard through empty air and missing entirely, a "
                      f"whooshing near miss with no impact.",
        "block": f"A heavy blow landing on {_a_or_an(p)}'s raised shield, a solid blocked impact.",
        "miss_player": f"{_a_or_an(e)}'s heavy blow swinging through empty air, missing "
                       f"{_a_or_an(p)} entirely, a whooshing near miss with no impact.",
        "hit_enemy": f"A heavy impact striking {_a_or_an(e)}, a short pained grunt.",
        "hit_player": f"A heavy impact striking {_a_or_an(p)}, a short pained human cry of pain.",
        "death_enemy": f"{_a_or_an(e)}'s final choked cry as it collapses to the ground and dies.",
        "death_player": f"{_a_or_an(p)}'s last dying gasp, a human cry of pain as they fall to "
                        f"the ground.",
    }
    # The _a_or_an ones open mid-sentence ("an oak longbow swung..."); lead each prompt with
    # a capital rather than .capitalize(), which would flatten the rest of the line.
    return {k: v[0].upper() + v[1:] for k, v in out.items()}


def _ffmpeg_exe():
    """Path to the ffmpeg bundled with imageio-ffmpeg (already in requirements.txt).

    Imported lazily so a missing package costs the sound effects and nothing else - the
    server must still boot and still generate a dungeon."""
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def _sfx_decode(path):
    """FLAC -> mono float32 at SFX_SR."""
    out = subprocess.run(
        [_ffmpeg_exe(), "-v", "error", "-i", path,
         "-f", "s16le", "-ac", "1", "-ar", str(SFX_SR), "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype="<i2").astype(np.float32) / 32768.0


def _sfx_env(x, frame_ms=20):
    """RMS envelope -> (env, samples_per_frame). Its shape is what separates a one-shot
    from ambience."""
    n = max(1, int(SFX_SR * frame_ms / 1000))
    if len(x) < n:
        return np.zeros(1, dtype=np.float32), n
    f = x[:len(x) // n * n].reshape(-1, n)
    return np.sqrt((f ** 2).mean(axis=1) + 1e-12), n


def _sfx_problem(x):
    """None | 'empty' | 'continuous' - the audio counterpart of _enemy_frame_problem.

    MUST be given the RAW decoded clip, never a trimmed one. The test asks what fraction of
    the clip is active, and trimming removes exactly the silence that makes that fraction
    small - run on trimmed audio it approaches 1.0 by construction and rejects everything.
    (It did: a perfectly good giant-spider death cry was rejected twice before this moved
    ahead of the trim.)

    Thresholds measured on real Small-SFX output. Genuine one-shots (footstep on stone,
    footstep on candy, sword swing, wet impact, shield block, wall thud, both death cries)
    spanned 5-40% active with a -1 to +16dB head-to-tail decay; a deliberate "continuous
    ambient dungeon drone" control measured 65% active and -5.4dB, i.e. it BUILT instead of
    decaying. Both conditions must fire together, so a sustained death cry (40% active,
    -0.9dB) survives on the length test while the drone does not."""
    if len(x) < int(0.03 * SFX_SR) or float(np.abs(x).max()) < 0.02:
        return "empty"
    env, n = _sfx_env(x)
    edb = 20 * np.log10(env / (env.max() + 1e-12) + 1e-12)
    loud = np.where(edb > -20)[0]
    if not len(loud):
        return "empty"
    active_frac = len(loud) * n / len(x)
    seg = env[loud[0]:loud[-1] + 1]
    third = max(1, len(seg) // 3)
    decay_db = 20 * np.log10((seg[:third].mean() + 1e-12) / (seg[-third:].mean() + 1e-12))
    if active_frac > 0.55 and decay_db < 3.0:
        return "continuous"
    return None


def _finish_sfx(src, name):
    """Raw 2s padded FLAC -> a tight, normalised mono WAV data URL.

    Returns (data_url, problem). The transient starts anywhere in the first ~0.3s of the raw
    clip (measured onsets 0.02-0.28s), so trimming is not optional. Same
    `data:audio/wav;base64,` shape the Piper narration clips already use."""
    x = _sfx_decode(src)
    # Judged BEFORE trimming - see _sfx_problem on why the order is load-bearing.
    problem = _sfx_problem(x)

    env, n = _sfx_env(x)
    edb = 20 * np.log10(env / (env.max() + 1e-12) + 1e-12)

    onset = np.where(edb > SFX_ONSET_DB)[0]
    offset = np.where(edb > SFX_OFFSET_DB)[0]
    if len(onset):
        a = max(0, onset[0] * n - int(SFX_PREROLL * SFX_SR))
        b = min(len(x), ((offset[-1] if len(offset) else onset[-1]) + 1) * n)
        x = x[a:b]
    x = x[:int(SFX_MAX_SEC.get(name, 0.8) * SFX_SR)].copy()

    peak = float(np.abs(x).max())
    if peak > 1e-6:
        x *= (0.92 / peak)
    fi = min(len(x), int(SFX_FADE_IN * SFX_SR))
    fo = min(len(x), int(SFX_FADE_OUT * SFX_SR))
    if fi:
        x[:fi] *= np.linspace(0.0, 1.0, fi, dtype=np.float32)
    if fo:
        x[-fo:] *= np.linspace(1.0, 0.0, fo, dtype=np.float32)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SFX_SR)
        wf.writeframes((np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes())
    return "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode("ascii"), problem


def _sfx_add_branch(payload, name, text, seed):
    """One text -> audio branch on a shared payload; the audio twin of _krea2_add_branch."""
    tail = _SFX_TAIL_VOICE if name in _SFX_VOICE_NAMES else _SFX_TAIL
    payload[f"{name}_pos"] = {"inputs": {"text": text + tail, "clip": ["sfx_clip", 0]},
                              "class_type": "CLIPTextEncode"}
    # SA3 is not a ConditioningZeroOut arch like krea2; the reference template wires a plain
    # empty negative, and at cfg 1.0 it is inert either way.
    payload[f"{name}_neg"] = {"inputs": {"text": "", "clip": ["sfx_clip", 0]},
                              "class_type": "CLIPTextEncode"}
    # EmptyLatentAudio hardcodes Stable Audio 1's 64ch / 2048 ratio, but
    # comfy.sample.fix_empty_latent_channels rescales an EMPTY latent to the loaded model's
    # latent_format, so the stock node is correct for SA3's 256ch / 4096. Do NOT add
    # ConditioningStableAudio - that is an SA1-only node and the SA3 template omits it.
    payload[f"{name}_lat"] = {"inputs": {"seconds": SFX_SECONDS, "batch_size": 1},
                              "class_type": "EmptyLatentAudio"}
    payload[f"{name}_samp"] = {"inputs": {"seed": seed, "steps": SFX_STEPS, "cfg": SFX_CFG,
                                          "sampler_name": SFX_SAMPLER, "scheduler": SFX_SCHEDULER,
                                          "denoise": 1.0, "model": ["sfx_ckpt", 0],
                                          "positive": [f"{name}_pos", 0],
                                          "negative": [f"{name}_neg", 0],
                                          "latent_image": [f"{name}_lat", 0]},
                               "class_type": "KSampler"}
    payload[f"{name}_dec"] = {"inputs": {"samples": [f"{name}_samp", 0], "vae": ["sfx_ckpt", 2]},
                              "class_type": "VAEDecodeAudio"}
    # SaveAudio is deprecated in favour of SaveAudioAdvanced, but the latter's `format` is a
    # DynamicCombo that is awkward to drive from the API and FLAC is all we ever want.
    payload[f"{name}_save"] = {"inputs": {"audio": [f"{name}_dec", 0],
                                          "filename_prefix": f"sfx/{name}"},
                               "class_type": "SaveAudio"}


def generate_sfx_pack(wall_style, player_style, weapon_style, enemy_style):
    """The eight gameplay one-shots, in one ComfyUI job. Never raises.

    Returns {name: data_url} for whatever survived, or None. A bad clip is left OUT of the
    dict rather than faked: the frontend synthesises a procedural stand-in for anything
    absent, so the game is never silent and a foley failure never costs the player their
    dungeon - the same bargain synthesize_narration makes with the story."""
    prompts = sfx_prompts(wall_style, player_style, weapon_style, enemy_style)
    seed0 = random.randint(1, 2**31 - 1)

    payload = {
        "sfx_ckpt": {"inputs": {"ckpt_name": SFX_CKPT}, "class_type": "CheckpointLoaderSimple"},
        # t5gemma is auto-detected as TEModel.T5_GEMMA in comfy/sd.py and routed to
        # sa3.SAT5GemmaModel, so the declared type only has to name the audio family.
        "sfx_clip": {"inputs": {"clip_name": SFX_CLIP, "type": "stable_audio", "device": "default"},
                     "class_type": "CLIPLoader"},
    }
    for i, name in enumerate(SFX_NAMES):
        _sfx_add_branch(payload, name, prompts[name], seed0 + i)

    try:
        paths = _krea2_submit_and_collect(payload, SFX_NAMES, timeout=300,
                                          job_key="sfx", out_key="audio")
    except Exception as e:
        print(f"[sfx] generation failed ({e}) - the dungeon falls back to procedural sounds")
        return None

    clips, retry = {}, {}
    for name in SFX_NAMES:
        try:
            url, problem = _finish_sfx(paths[name], name)
        except Exception as e:
            print(f"[sfx] {name}: could not process ({e})")
            continue
        if problem:
            retry[name] = problem
        else:
            clips[name] = url

    # One re-roll on a fresh seed for the failures only - the same shape as the Kontext
    # portrait safety net, and for the same reason: it fires on a minority of runs, and a
    # second 1.5s attempt is far cheaper than shipping a drone where a footstep belongs.
    if retry:
        print(f"[sfx] re-rolling {', '.join(f'{k} ({v})' for k, v in retry.items())}")
        payload2 = {k: payload[k] for k in ("sfx_ckpt", "sfx_clip")}
        for i, name in enumerate(retry):
            _sfx_add_branch(payload2, name, prompts[name], seed0 + 977 + i)
        try:
            paths2 = _krea2_submit_and_collect(payload2, list(retry), timeout=300, out_key="audio")
            for name in retry:
                url, problem = _finish_sfx(paths2[name], name)
                if problem:
                    print(f"[sfx] {name}: still {problem} after a re-roll - left to the frontend")
                else:
                    clips[name] = url
        except Exception as e:
            print(f"[sfx] re-roll failed ({e})")

    if not clips:
        return None
    kb = sum(len(v) for v in clips.values()) / 1024
    print(f"[sfx] {len(clips)}/{len(SFX_NAMES)} sounds ready ({kb:.0f} KB of data URLs)")
    return clips


# ---------------------------------------------------------------------------
# Dungeon music: Stable Audio 3's base checkpoint writes two looping beds
# ---------------------------------------------------------------------------
# Same wall_style theming as the sfx pack above, but a different checkpoint and a different
# shape of output. stable_audio_3_small_sfx_base.safetensors is the pre-SFX-finetune Stable
# Audio 3 Small checkpoint - downloaded alongside the SFX one but never used until now - and is
# the better bet for sustained melodic content than a checkpoint finetuned toward short
# percussive one-shots. v6 only, same as sfx.
#
# MUSIC_STEPS/MUSIC_CFG/MUSIC_SAMPLER are an unmeasured starting guess, not a tuned setting
# like SFX_STEPS/SFX_CFG/SFX_SAMPLER are: SFX's lcm/cfg=1.0/8-steps is right for a checkpoint
# distilled for one-shots, but this is the checkpoint from BEFORE that distillation, so a real
# sampler at a real cfg is the more reasonable bet for melodic coherence. Listen to real output
# before trusting these numbers.
MUSIC_CKPT = "stable_audio_3_small_sfx_base.safetensors"
MUSIC_CLIP = SFX_CLIP           # same t5gemma text encoder file, independent of the checkpoint
MUSIC_STEPS = 40
MUSIC_CFG = 4.0
MUSIC_SAMPLER = "euler"
MUSIC_SCHEDULER = "simple"
MUSIC_SECONDS = 30.0
MUSIC_SR = 32000
MUSIC_XFADE_SEC = 1.5            # loop-seam crossfade length, tune by ear against real output
MUSIC_NAMES = ["explore", "battle"]

# Opposite framing from _SFX_TAIL above: that one exists to keep music OUT of one-shots, this
# one exists to make sure the loop point is inaudible and nothing fades or ends.
_MUSIC_TAIL = (" Loopable instrumental background music for a video game, seamless continuous "
               "loop, steady consistent tempo throughout, no vocals, no spoken words, no sound "
               "effects, no fade in, no fade out, no silence, no tempo change, no ending.")


def music_prompts(wall_style):
    """One prompt per entry in MUSIC_NAMES, themed off the same wall_style string the sfx and
    art prompts use."""
    d = (wall_style or "").strip() or "old stone dungeon"
    out = {
        "explore": f"Atmospheric ambient exploration music for a {d} dungeon, mysterious and "
                   f"slow, sparse instrumentation.",
        "battle": f"Intense driving battle music for a {d} dungeon, fast aggressive percussion "
                  f"and rising tension.",
    }
    return {k: v + _MUSIC_TAIL for k, v in out.items()}


def _music_decode(path):
    """FLAC -> mono float32 at MUSIC_SR."""
    out = subprocess.run(
        [_ffmpeg_exe(), "-v", "error", "-i", path,
         "-f", "s16le", "-ac", "1", "-ar", str(MUSIC_SR), "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype="<i2").astype(np.float32) / 32768.0


def _music_problem(x):
    """None | 'empty' - unlike _sfx_problem, sustained non-decaying energy is exactly what a
    good loop is, so there is no 'continuous' rejection here."""
    if len(x) < int(1.0 * MUSIC_SR) or float(np.abs(x).max()) < 0.01:
        return "empty"
    return None


def _finish_music(src, name):
    """Raw decoded FLAC -> a looping, normalised mono WAV data URL.

    Returns (data_url, problem). The loop-seam crossfade splices the clip's true tail into its
    own opening (equal-power sin/cos blend) so the sample that plays right after the clip wraps
    is a blend of "true end" and "true start" instead of a hard cut. Same
    data:audio/wav;base64, shape _finish_sfx and the Piper narration clips already use."""
    x = _music_decode(src)
    problem = _music_problem(x)

    xf = int(MUSIC_XFADE_SEC * MUSIC_SR)
    if not problem and len(x) > 2 * xf:
        t = np.linspace(0, np.pi / 2, xf, dtype=np.float32)
        fade_in, fade_out = np.sin(t), np.cos(t)
        head = x[:xf] * fade_in + x[-xf:] * fade_out
        x = np.concatenate([head, x[xf:-xf]])

    peak = float(np.abs(x).max())
    if peak > 1e-6:
        x = x * (0.9 / peak)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(MUSIC_SR)
        wf.writeframes((np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes())
    return "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode("ascii"), problem


def _music_add_branch(payload, name, text, seed, seconds=None, init_audio=None, denoise=1.0):
    """One text -> audio branch on a shared payload; the music twin of _sfx_add_branch.

    `seconds` defaults to MUSIC_SECONDS (the per-dungeon tracks); the static menu music asset
    below passes its own, shorter length instead. `init_audio` (a stereo file in
    COMFY_INPUT_DIR) starts the sampler from that recording instead of from silence, and
    `denoise` says how much of it to rewrite - the static victory variations use this, and the
    length then comes from the recording, so `seconds` is ignored."""
    payload[f"{name}_pos"] = {"inputs": {"text": text, "clip": ["music_clip", 0]},
                              "class_type": "CLIPTextEncode"}
    payload[f"{name}_neg"] = {"inputs": {"text": "", "clip": ["music_clip", 0]},
                              "class_type": "CLIPTextEncode"}
    if init_audio:
        payload[f"{name}_src"] = {"inputs": {"audio": init_audio}, "class_type": "LoadAudio"}
        payload[f"{name}_lat"] = {"inputs": {"audio": [f"{name}_src", 0], "vae": ["music_ckpt", 2]},
                                  "class_type": "VAEEncodeAudio"}
    else:
        payload[f"{name}_lat"] = {"inputs": {"seconds": MUSIC_SECONDS if seconds is None else seconds,
                                             "batch_size": 1},
                                  "class_type": "EmptyLatentAudio"}
    payload[f"{name}_samp"] = {"inputs": {"seed": seed, "steps": MUSIC_STEPS, "cfg": MUSIC_CFG,
                                          "sampler_name": MUSIC_SAMPLER,
                                          "scheduler": MUSIC_SCHEDULER,
                                          "denoise": denoise, "model": ["music_ckpt", 0],
                                          "positive": [f"{name}_pos", 0],
                                          "negative": [f"{name}_neg", 0],
                                          "latent_image": [f"{name}_lat", 0]},
                               "class_type": "KSampler"}
    payload[f"{name}_dec"] = {"inputs": {"samples": [f"{name}_samp", 0], "vae": ["music_ckpt", 2]},
                              "class_type": "VAEDecodeAudio"}
    payload[f"{name}_save"] = {"inputs": {"audio": [f"{name}_dec", 0],
                                          "filename_prefix": f"music/{name}"},
                               "class_type": "SaveAudio"}


def generate_music_pack(wall_style):
    """The two dungeon music beds (explore, battle), in one ComfyUI job. Never raises.

    Returns {name: data_url} for whatever survived, or None. Same never-block-the-dungeon
    bargain as generate_sfx_pack - the frontend just runs without music for anything missing."""
    prompts = music_prompts(wall_style)
    seed0 = random.randint(1, 2**31 - 1)

    payload = {
        "music_ckpt": {"inputs": {"ckpt_name": MUSIC_CKPT}, "class_type": "CheckpointLoaderSimple"},
        "music_clip": {"inputs": {"clip_name": MUSIC_CLIP, "type": "stable_audio", "device": "default"},
                       "class_type": "CLIPLoader"},
    }
    for i, name in enumerate(MUSIC_NAMES):
        _music_add_branch(payload, name, prompts[name], seed0 + i)

    try:
        paths = _krea2_submit_and_collect(payload, MUSIC_NAMES, timeout=300,
                                          job_key="music", out_key="audio")
    except Exception as e:
        print(f"[music] generation failed ({e}) - the dungeon falls back to no music")
        return None

    clips, retry = {}, {}
    for name in MUSIC_NAMES:
        try:
            url, problem = _finish_music(paths[name], name)
        except Exception as e:
            print(f"[music] {name}: could not process ({e})")
            continue
        if problem:
            retry[name] = problem
        else:
            clips[name] = url

    if retry:
        print(f"[music] re-rolling {', '.join(f'{k} ({v})' for k, v in retry.items())}")
        payload2 = {k: payload[k] for k in ("music_ckpt", "music_clip")}
        for i, name in enumerate(retry):
            _music_add_branch(payload2, name, prompts[name], seed0 + 977 + i)
        try:
            paths2 = _krea2_submit_and_collect(payload2, list(retry), timeout=300, out_key="audio")
            for name in retry:
                url, problem = _finish_music(paths2[name], name)
                if problem:
                    print(f"[music] {name}: still {problem} after a re-roll - left to the frontend")
                else:
                    clips[name] = url
        except Exception as e:
            print(f"[music] re-roll failed ({e})")

    if not clips:
        return None
    kb = sum(len(v) for v in clips.values()) / 1024
    print(f"[music] {len(clips)}/{len(MUSIC_NAMES)} tracks ready ({kb:.0f} KB of data URLs)")
    return clips


# ---------------------------------------------------------------------------
# Static one-off audio: the four screen music loops and the loading-complete chime
# ---------------------------------------------------------------------------
# Unlike sfx/music above, these are NOT per-dungeon - the menu, the loading screen and the
# win/death boxes look the same for every player, so there is nothing to theme them off of.
# Generated once with the same models and committed to sounds/, same as the start/button/end
# UI sounds. Not called at server runtime; run `python server.py --gen-static-audio` (see the
# __main__ block) whenever one of them needs to be re-rolled, and commit the result.
#
# name -> (seconds, prompt), rendered to sounds/<name>_music.wav. The menu and loading loops
# are three minutes because a player can sit on either for a long time and a short loop gives
# itself away; the win and death boxes are left in seconds, so ninety is already generous.
STATIC_MUSIC = {
    "menu": (180.0, (
        "Atmospheric heroic fantasy title screen music for a retro 1990s dungeon crawler "
        "video game, mysterious and inviting, moderate steady tempo, orchestral and synth "
        "textures."
    )),
    # Takes over from the menu loop the moment the intro narration finishes and carries the
    # loading screen to the ENTER button. Written to sit UNDER a screen the player is reading
    # and waiting on rather than to be listened to: forward motion, no melody to follow.
    "loading": (180.0, (
        "Slow brooding dark fantasy ambient music for a retro 1990s dungeon crawler video "
        "game, patient and expectant, low sustained strings and soft synth pads over a quiet "
        "steady pulse, restrained and understated, no melody."
    )),
    # Under the death box. Lands after the player's death cry and a beat of silence, so it
    # can be genuinely slow - it is not competing with anything.
    "death": (90.0, (
        "Slow mournful dark fantasy funeral dirge for a retro 1990s dungeon crawler video "
        "game, heavy and defeated, low strings and a distant tolling bell over a deep drone, "
        "sombre and final, very slow tempo."
    )),
    # ---- The victory pool --------------------------------------------------
    # Five loops share the victory box. Which of them plays is decided by the dungeon's own
    # typed style: game.js hashes that string and indexes VICTORY_MUSIC_TRACKS with it (see
    # victoryTrackFor there), so every "forest" run ever played wins to the same song and every
    # "ocean" run wins to a different one - random-feeling across styles, fixed within one.
    # VICTORY_MUSIC_TRACKS is game.js's copy of these keys IN THIS ORDER; the two lists have to
    # be edited together, or a new track either never plays (missing there) or 404s on the loop
    # it asks for (missing here).
    #
    # Past pool members cut: victory_fanfare (regal ceremonial horns), victory_folk (tavern
    # jig) and victory_grim (war drums) were removed outright; victory_serene (harp) was kept
    # but retired, on disk as sounds/unused_victory_serene_music.wav.
    #
    # victory_2/victory_synth_2/victory_synth_3 below are the survivors of a proper six-way
    # audition rather than a guess: generate_victory_candidates() rendered three variations each
    # of victory and victory_synth into sounds/victory_candidates/ (gitignored, not wired in) and
    # these three were the ones picked - a3_strings/b1_pad/b2_chiptune in that batch. The other
    # three (a1_horn, a2_choir, b3_bass) were not picked and are gone.
    #
    # Under the victory box, behind the 'end' sting that fires with it. Triumphant, but a bed
    # rather than a fanfare - a fanfare would fight the sting and then have nowhere to go on
    # the loop seam. The original, and still the one an empty style falls back to.
    "victory": (90.0, (
        "Warm triumphant heroic fantasy victory music for a retro 1990s dungeon crawler video "
        "game, proud and resolved, bright brass and swelling strings over a steady confident "
        "march, celebratory and full."
    )),
    # The pool's non-orchestral voice, and the loudest break from the default - a style that
    # lands here gets an ending that sounds like a different game.
    "victory_synth": (90.0, (
        "Bright retro synthwave victory music for a 1990s video game, neon and electronic, "
        "punchy analog synth arpeggios and a chiptune lead over a crisp drum machine beat, "
        "upbeat and jubilant, fast tempo."
    )),
    # Variation of victory (see STATIC_MUSIC_VARIATIONS): brighter and quicker, the lead moved
    # to soaring strings over a lighter brass march.
    "victory_2": (90.0, (
        "Warm triumphant heroic fantasy victory music for a retro 1990s dungeon crawler "
        "video game, bright and energetic, a soaring string melody over a quicker confident "
        "march with light brass, celebratory and full."
    )),
    # Variation of victory_synth: warm analog pads under a soaring synth lead, more anthem
    # than arcade.
    "victory_synth_2": (90.0, (
        "Bright retro synthwave victory music for a 1990s video game, neon and electronic, "
        "warm analog synth pads and a soaring synth lead melody over a crisp drum machine "
        "beat, anthemic and jubilant, fast tempo."
    )),
    # Variation of victory_synth: bubbly chiptune arpeggios and a square-wave lead, the
    # playful/arcade end of the same synth family.
    "victory_synth_3": (90.0, (
        "Bright retro synthwave victory music for a 1990s video game, neon and electronic, "
        "bubbly chiptune arpeggios and a square wave lead over a punchy drum machine beat, "
        "playful and jubilant, fast tempo."
    )),
    # Under the level-up choice box, which ducks the dungeon bed rather than replacing it and
    # is usually on screen for only a few seconds. Thirty is the shortest loop here on purpose:
    # nobody sits on this screen, so a long take would only ever play its first bars. Kept
    # brighter and lighter than "victory" - that one closes a whole run, this one is a pause
    # inside one, and the two must not read as the same event.
    "levelup": (30.0, (
        "Bright uplifting fantasy level-up music for a retro 1990s dungeon crawler video game, "
        "a triumphant moment of reward and choice, shimmering bells and warm strings over a "
        "gentle rising arpeggio, hopeful and radiant, moderate tempo."
    )),
}

# name -> (source, denoise) for the STATIC_MUSIC entries that are variations rather than fresh
# rolls. A fresh roll on the same prompt is a different song that happens to share a
# description; a variation starts from the source's shipped loop, VAE-encodes it and re-samples
# only the top `denoise` of the noise schedule, so it keeps the source's key, tempo, instruments
# and overall shape and rewrites the playing on top. Lower sticks closer to the source.
# Each source is listed before its variations in STATIC_MUSIC, so --gen-static-audio re-rolls
# a source first and its variations follow the new take.
#
# 0.65 measured well against victory/victory_synth: enough to read as a different take, not so
# much that it drifts to an unrelated song or - past ~0.75 on the orchestral source - opens up
# near-silent patches. See generate_victory_candidates / --gen-victory-candidates for how a
# fresh batch of candidates at this same denoise gets auditioned before a name lands here.
STATIC_MUSIC_VARIATIONS = {
    "victory_2": ("victory", 0.65),
    "victory_synth_2": ("victory_synth", 0.65),
    "victory_synth_3": ("victory_synth", 0.65),
}

READY_CHIME_PROMPT = (
    "A bright cheerful two-note magical chime bell, one clean isolated cue sound announcing "
    "that something is ready and complete."
)


def _static_music_source(name):
    """sounds/<name>_music.wav copied into COMFY_INPUT_DIR as stereo, for LoadAudio. Returns the
    copy's filename. The shipped loops are mono (see _finish_music) and the Stable Audio 3 VAE
    only encodes two channels, so a mono file fails at VAEEncodeAudio."""
    with wave.open(os.path.join(PROJECT_DIR, "sounds", f"{name}_music.wav"), "rb") as wf:
        rate, channels = wf.getframerate(), wf.getnchannels()
        pcm = np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2")
    out_name = f"static_{name}_music_stereo.wav"
    with wave.open(os.path.join(COMFY_INPUT_DIR, out_name), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes((np.repeat(pcm, 2) if channels == 1 else pcm).tobytes())
    return out_name


def generate_static_music_asset(name):
    """Renders sounds/<name>_music.wav for one entry of STATIC_MUSIC. Prints and returns False
    on failure rather than raising, matching the rest of the audio pipeline - a missing file
    just means that screen plays silent, which game.js already handles."""
    seconds, prompt = STATIC_MUSIC[name]
    seed = random.randint(1, 2**31 - 1)
    payload = {
        "music_ckpt": {"inputs": {"ckpt_name": MUSIC_CKPT}, "class_type": "CheckpointLoaderSimple"},
        "music_clip": {"inputs": {"clip_name": MUSIC_CLIP, "type": "stable_audio", "device": "default"},
                       "class_type": "CLIPLoader"},
    }
    init_audio, denoise = None, 1.0
    if name in STATIC_MUSIC_VARIATIONS:
        source, denoise = STATIC_MUSIC_VARIATIONS[name]
        try:
            init_audio = _static_music_source(source)
        except Exception as e:
            print(f"[{name} music] no {source} take to vary ({e}) - generate that one first")
            return False
    _music_add_branch(payload, name, prompt + _MUSIC_TAIL, seed, seconds=seconds,
                      init_audio=init_audio, denoise=denoise)
    try:
        paths = _krea2_submit_and_collect(payload, [name], timeout=1800, out_key="audio")
        url, problem = _finish_music(paths[name], name)
    except Exception as e:
        print(f"[{name} music] generation failed ({e})")
        return False
    if problem:
        print(f"[{name} music] {problem} - try again (a fresh seed each run)")
        return False
    data = base64.b64decode(url.split(",", 1)[1])
    out_path = os.path.join(PROJECT_DIR, "sounds", f"{name}_music.wav")
    with open(out_path, "wb") as f:
        f.write(data)
    print(f"[{name} music] saved {out_path} ({len(data) / 1024:.0f} KB)")
    return True


def generate_victory_candidates():
    """Renders six candidate victory-box variations - three off victory, three off
    victory_synth - into sounds/victory_candidates/ (gitignored) for auditioning, rather than
    guessing and shipping the first attempt (see the STATIC_MUSIC_VARIATIONS note above). None
    of these are wired into STATIC_MUSIC or served by do_GET. Once some are picked, add them to
    STATIC_MUSIC and STATIC_MUSIC_VARIATIONS under real names, move the file out of this folder,
    and delete the rest. Safe to re-run for a fresh batch - it always overwrites the same six
    filenames rather than piling up takes."""
    candidates = {
        "a1_horn": ("victory", 0.65, (
            "Warm triumphant heroic fantasy victory music for a retro 1990s dungeon crawler "
            "video game, proud and soaring, a bold french horn melody and swelling strings over "
            "a steady confident march with rolling timpani, celebratory and full."
        )),
        "a2_choir": ("victory", 0.65, (
            "Warm triumphant heroic fantasy victory music for a retro 1990s dungeon crawler "
            "video game, grand and ceremonial, a rousing choir chorale and ringing brass over a "
            "steady confident march, ceremonial and full."
        )),
        "a3_strings": ("victory", 0.65, (
            "Warm triumphant heroic fantasy victory music for a retro 1990s dungeon crawler "
            "video game, bright and energetic, a soaring string melody over a quicker confident "
            "march with light brass, celebratory and full."
        )),
        "b1_pad": ("victory_synth", 0.65, (
            "Bright retro synthwave victory music for a 1990s video game, neon and electronic, "
            "warm analog synth pads and a soaring synth lead melody over a crisp drum machine "
            "beat, anthemic and jubilant, fast tempo."
        )),
        "b2_chiptune": ("victory_synth", 0.65, (
            "Bright retro synthwave victory music for a 1990s video game, neon and electronic, "
            "bubbly chiptune arpeggios and a square wave lead over a punchy drum machine beat, "
            "playful and jubilant, fast tempo."
        )),
        "b3_bass": ("victory_synth", 0.65, (
            "Bright retro synthwave victory music for a 1990s video game, neon and electronic, "
            "a driving bass synth lead with sharp vocoder-like stabs over a hard drum machine "
            "beat, aggressive and jubilant, fast tempo."
        )),
    }
    payload = {
        "music_ckpt": {"inputs": {"ckpt_name": MUSIC_CKPT}, "class_type": "CheckpointLoaderSimple"},
        "music_clip": {"inputs": {"clip_name": MUSIC_CLIP, "type": "stable_audio", "device": "default"},
                       "class_type": "CLIPLoader"},
    }
    sources = {}
    seed0 = random.randint(1, 2**31 - 1)
    for i, (name, (source, denoise, prompt)) in enumerate(candidates.items()):
        if source not in sources:
            sources[source] = _static_music_source(source)
        _music_add_branch(payload, name, prompt + _MUSIC_TAIL, seed0 + i,
                          init_audio=sources[source], denoise=denoise)
    try:
        paths = _krea2_submit_and_collect(payload, list(candidates), timeout=1800, out_key="audio")
    except Exception as e:
        print(f"[victory candidates] generation failed ({e})")
        return False

    out_dir = os.path.join(PROJECT_DIR, "sounds", "victory_candidates")
    os.makedirs(out_dir, exist_ok=True)
    ok = 0
    for name, (source, denoise, prompt) in candidates.items():
        try:
            url, problem = _finish_music(paths[name], name)
        except Exception as e:
            print(f"[victory candidates] {name}: could not process ({e})")
            continue
        if problem:
            print(f"[victory candidates] {name}: {problem} - skipped, re-run to re-roll it")
            continue
        data = base64.b64decode(url.split(",", 1)[1])
        out_path = os.path.join(out_dir, f"{name}_from_{source}.wav")
        with open(out_path, "wb") as f:
            f.write(data)
        print(f"[victory candidates] saved {out_path} ({len(data) / 1024:.0f} KB)")
        ok += 1
    print(f"[victory candidates] {ok}/{len(candidates)} ready in {out_dir}")
    return ok == len(candidates)


def generate_ready_chime_asset():
    """Renders sounds/ready.wav - the fixed "assets are ready" cue played once loading
    finishes. game.js pitch-varies it per playthrough via playSfx's usual jitter, so the one
    static take still sounds a little different each run."""
    seed = random.randint(1, 2**31 - 1)
    payload = {
        "sfx_ckpt": {"inputs": {"ckpt_name": SFX_CKPT}, "class_type": "CheckpointLoaderSimple"},
        "sfx_clip": {"inputs": {"clip_name": SFX_CLIP, "type": "stable_audio", "device": "default"},
                     "class_type": "CLIPLoader"},
    }
    _sfx_add_branch(payload, "ready", READY_CHIME_PROMPT, seed)
    try:
        paths = _krea2_submit_and_collect(payload, ["ready"], timeout=120, out_key="audio")
        url, problem = _finish_sfx(paths["ready"], "ready")
    except Exception as e:
        print(f"[ready chime] generation failed ({e})")
        return False
    if problem:
        print(f"[ready chime] {problem} - try again (a fresh seed each run)")
        return False
    data = base64.b64decode(url.split(",", 1)[1])
    out_path = os.path.join(PROJECT_DIR, "sounds", "ready.wav")
    with open(out_path, "wb") as f:
        f.write(data)
    print(f"[ready chime] saved {out_path} ({len(data) / 1024:.0f} KB)")
    return True


# Replaced _subject_bleeds_off_edge, which asked "does the subject touch any edge?" with a
# 2% tolerance. That test only made sense while the enemy was deliberately drawn SMALL and
# centred; now that it is asked to FILL the frame, touching an edge is the normal, desired
# result and the old bound fired on 3 of 4 healthy samples.
#
# How much of the canvas a healthy fill-the-frame enemy spans on its longest axis. Measured
# on real output: dragon-with-wingspan 0.98, RAM stick 1.00, dog 1.00, boss dog 1.00, versus
# 0.18-0.26 for the old "draw it small" prompt. 0.55 sits well clear of both clusters.
ENEMY_MIN_FILL = 0.55
# How much of a single border a healthy subject may cover before it reads as sliced off.
# Measured on the same run: 0.000 (dragon, nothing touching), 0.068 (dog's head), 0.178/0.242
# (RAM stick spanning the full height), 0.367 (boss dog's feet planted on the bottom edge).
# 0.60 clears every legitimate case while a genuinely chopped subject leaves a long flat run.
ENEMY_MAX_BORDER = 0.60


def _enemy_frame_problem(img_path, thresh=50):
    """Judge a background-removed enemy frame. Returns None when it is fine, otherwise a
    short reason string ('too small' / 'clipped' / 'empty') for the regen path to log and act
    on. Deliberately two-sided: the failure that actually bites is the subject coming out
    TINY (a ~90px creature upscaled to fill the combat view), which no edge test can see."""
    from PIL import Image
    import numpy as np
    try:
        a = np.array(Image.open(img_path).convert("RGBA"))
        alpha = a[:, :, 3] > thresh
        if not alpha.any():
            return "empty"
        H, W = alpha.shape
        ys, xs = np.nonzero(alpha)
        fill = max((xs.max() - xs.min() + 1) / float(W), (ys.max() - ys.min() + 1) / float(H))
        if fill < ENEMY_MIN_FILL:
            return f"too small (spans {fill:.0%} of the canvas)"
        worst = max(alpha[0, :].mean(), alpha[-1, :].mean(),
                    alpha[:, 0].mean(), alpha[:, -1].mean())
        if worst > ENEMY_MAX_BORDER:
            return f"clipped ({worst:.0%} of one border is solid)"
        return None
    except Exception as e:
        print(f"[Enemy Frame Check Error] {os.path.basename(img_path)}: {e}")
        return None


def _krea2_regen_enemy(enemy_style, size, steps, prefix, attempts=2, variant="walker",
                       clipped=False, look=None):
    """Re-generate one enemy variant on its own with a fresh seed, when the batched one came
    back unusable. A CLIPPED subject is retried with a slightly wider margin; a subject that
    merely came out too small is retried on the unchanged fill-the-frame prompt, since that
    is a bad roll rather than bad wording. Returns the first good frame, else the last try.

    `look` is the LLM-designed description for this foe, when there is one - the retry has to
    ask for the SAME foe it was drawing, not fall back to a generic role prompt."""
    last = None
    for i in range(attempts):
        payload = _krea2_loaders()
        tighten = (i + 1) if clipped else 0
        prompt_text = (krea2_species_prompt(look, enemy_style, tighten=tighten) if look
                       else krea2_enemy_prompt(enemy_style, variant=variant, tighten=tighten))
        _krea2_add_branch(payload, "enemy", prompt_text,
                          size, size, steps, random.randint(1, 1000000000), prefix)
        last = _krea2_submit_and_collect(payload, ["enemy"])["enemy"]
        keep_largest_figure(last, thresh=50)
        problem = _enemy_frame_problem(last)
        if problem is None:
            print(f"[krea2] {variant} enemy regen attempt {i + 1} is clean")
            return last
        print(f"[krea2] {variant} enemy regen attempt {i + 1} still {problem}")
    return last


def _krea2_regen_pose_frame(look, enemy_style, guard, pose, seed, size, steps, prefix,
                            variant="walker"):
    """Re-draw ONE pose frame that came back unusable, at the widest margin the prompt offers.

    Different job from _krea2_regen_enemy above, which re-rolls a broken idle on a FRESH seed
    because a bad idle is a bad roll of the foe itself. Here the foe is already fine - its
    idle passed - and only the framing failed, so the seed is the one the rest of that foe's
    frames were drawn on and the single thing that changes is the margin. Re-rolling the seed
    instead would hand back a different-looking creature for one frame of the fight.

    Returns the path when it comes back clean, or None to leave the frontend on the idle."""
    payload = _krea2_loaders()
    prompt_text = krea2_species_prompt(look, enemy_style, tighten=2, pose=pose, guard=guard)
    _krea2_add_branch(payload, "pose", prompt_text, size, size, steps, seed, prefix)
    fp = _krea2_submit_and_collect(payload, ["pose"])["pose"]
    keep_largest_figure(fp, thresh=50)
    problem = _enemy_frame_problem(fp)
    print(f"[krea2] {variant} {pose} reframe at a wider margin is "
          f"{problem or 'clean'}")
    return None if problem else fp


def _krea2_add_enemy_variants(payload, enemy_style, sq, steps, prefix, species=None,
                              last_attack_frame=False):
    """Add the enemy branches to a shared krea2 payload, keyed `enemy_<variant>`, and return
    the list of variants added.

    With `species` (the normal path) that is all three, each drawn from its own LLM-written
    description. Without it the LLM naming failed, so only the walker is drawn here and the
    other two are derived from it with Kontext - see KREA2_FALLBACK_DIRECT_VARIANTS.

    Each FOE gets its own seed, and all of that foe's frames SHARE it - the same trick the v6
    player frames use. Across foes a shared seed would drag three separate species back
    towards one pose and composition; within a foe it is what holds the design still while
    only the pose clause changes. Branches are keyed `enemy_<variant>_<frame>`.

    `last_attack_frame` adds ENEMY_STRIKE_FRAME to every designed foe. The fallback path has
    no attack frame to follow, so it never gets one.

    Returns ({variant: [frames]}, {variant: seed}) - the frames so the caller knows what to
    collect, and the seeds so a single mis-framed pose frame can be re-drawn on the same one
    (see _krea2_regen_pose_frame)."""
    added, seeds = {}, {}
    for v in (ENEMY_VARIANT_NAMES if species else KREA2_FALLBACK_DIRECT_VARIANTS):
        seed = seeds[v] = random.randint(1, 1000000000)
        frames = (_enemy_variant_frames(v, last_attack_frame) if species
                  else ENEMY_FRAME_FALLBACK)
        for f in frames:
            prompt_text = (krea2_species_prompt(species[v]["look"], enemy_style, pose=f,
                                                guard=species[v].get("guard")) if species
                           else krea2_enemy_prompt(enemy_style, variant=v))
            _krea2_add_branch(payload, f"enemy_{v}_{f}", prompt_text, sq, sq, steps, seed, prefix)
        added[v] = list(frames)
    return added, seeds


# Kontext edits that turn the finished walker into the other two variants.
#
# The hard-won rule for BOTH: an instruction may only describe a NARROW, LOCAL change, and it
# must not contain a noun whose own visual prior is a character. "Armour", "plating", "boss",
# "colossal", "spikes" each summon a humanoid knight, and they do it in krea2 AND in Kontext -
# an early boss edit ("cover it in thick jagged black armour plating, colossal armoured boss
# version") turned a green RAM stick into a generic armoured demon, exactly like the direct
# krea2 boss prompt did. Rewritten to touch only surface and colour, naming no character at
# all, it keeps the RAM stick and just makes it a scorched, lava-cracked RAM stick.
#
# Unlike krea2 (cfg 1.0, no negative guidance, so "don't draw X" draws X), Kontext is a real
# instruction model with guidance, so explicit "keep / do not change" phrasing works here and
# is what pins the identity.
#
# The wing edit is deliberately neutral about the KIND of wing, so it matches the subject, and
# explicit about the already-winged case so a dragon gets its own wings spread rather than a
# second pair.
#
# It says "this OBJECT", never "this creature". An earlier version said "this creature" twice
# and turned a RAM-stick walker into a plain bird in a real run - the noun rule above applies
# to the thing being edited, not just to what is added, and "creature" is itself a character
# noun telling the model what to draw. The boss edit alongside it, which says "object", held
# the same walker's identity in that very same job. Verified after the swap: 3/3 seeds on the
# exact failing RAM walker came back as winged RAM sticks, and a dog and a dragon both keep
# their identity, so "object" costs nothing on real creatures.
KONTEXT_WING_EDIT = (
    "Add a pair of large wings to this object, spread wide and fully outstretched to the "
    "left and right. If it already has wings, simply spread those same wings out wide. "
    "Keep the object completely unchanged - identical shape, colours, markings and "
    "details - with the wings simply attached to its sides. Plain white background."
)
# For a MACHINE, wings are the wrong answer - a legged security drone with feathered wings
# strapped on looks absurd. It gets a real airborne refit instead. Note how CONCRETE this is.
# A vague "make a flying version of this object, adding whatever thrusters, jets, rotors or
# wings suit it" was tried and Kontext did almost nothing - it returned the subject unchanged
# and slightly smaller. Kontext acts on specific physical instructions, not on intent.
# _vlm_wants_rotors picks between this and the wings.
#
# This wording is the survivor of four rounds. What each word is doing:
#  - "ADD ... to this object", never "convert this into ...". The shipped version opened
#    "Convert this into its airborne model: ... spinning rotor blades" and turned a RAM stick
#    into a literal military HELICOPTER, subject gone. A transformation instruction invites
#    replacement; only the additive form of KONTEXT_WING_EDIT holds identity. "Rotor blades"
#    is also a whole-helicopter noun - the same trap as "creature" and "armour", so it is out.
#  - "A PAIR OF LARGE ... attached to its SIDES", mirroring the wing edit, which is the one
#    structure proven to work on a flat PCB. "Thrusters on the underside" added literally
#    nothing to a RAM stick twice - a flat board has no underside to mount to.
#  - "MOUNTED ON SHORT ARMS" holds the hardware OUTBOARD. Flush-mounted thrusters swallowed
#    the robot's legs; on arms, the whole silhouette survives.
#  - The GLOW is what reads at the ~100-180px the flyer is drawn at.
# Verified 6/6 identity-preserving across a RAM stick, a humanoid robot and a drone, 2 seeds
# each, 5/6 with large clearly visible thrusters.
KONTEXT_THRUSTER_EDIT = (
    "Add a pair of large glowing jet thrusters to this object, mounted one on each side on "
    "short arms, angled downward and firing bright blue-white exhaust flames beneath it so "
    "that it hovers in mid-air above the ground. Keep the object completely unchanged - "
    "identical shape, colours, markings and details - with the thrusters simply attached to "
    "its sides. Plain white background."
)

# Boss: scorched and angry. An "evil, cold violet glow" version was tried and reverted - its
# conditional face clause ("if it has a face or eyes, make its expression furious") kept
# hijacking the whole subject, replacing a RAM stick and then a taco outright with a floating
# demon face. There is NO face clause here for that reason; the menace comes purely from
# surface treatment, which cannot run away with the silhouette.
#
# Still load-bearing from that round: the GLOW is what keeps the sprite readable at the ~163px
# the boss is drawn at (a darken-only edit produced near-black silhouettes, mean luma ~10/255),
# and the explicit "still clearly recognisable, every detail visible" is needed on top of it.
# Verified on a taco (charred shell, glowing filling - still obviously a taco), a RAM stick
# (embers glowing between the chips) and a drone (rusted, glowing red eye).
KONTEXT_BOSS_EDIT = (
    "Recolour this object so it looks angry and dangerous: darkened and scorched, its surface "
    "cracked, chipped and battle-damaged, with hot glowing orange-red embers burning in the "
    "cracks. Keep the object completely unchanged in shape and form, still clearly "
    "recognisable, with every detail visible - only its colour and surface texture change. "
    "Plain white background."
)

# Per-variant edit plus how much of the padded square the source should occupy. The flyer is
# given more empty margin because wings/rotors need somewhere to go; the boss edit adds no
# span, so its source is padded larger, keeping more of the walker's real resolution.
# The flyer's edit is chosen per subject at run time - see generate_kontext_enemy_variants.
KONTEXT_ENEMY_EDITS = {
    "flyer": {"edit": KONTEXT_WING_EDIT, "h": 0.62, "w": 0.55},
    "boss":  {"edit": KONTEXT_BOSS_EDIT, "h": 0.78, "w": 0.72},
}


def _vlm_wants_rotors(image_path, timeout=180):
    """Ask qwen3vl what to bolt onto the sprite to make it fly, so a machine gets rotors and
    thrusters instead of wings.

    Uses the TextGenerate node, which takes an optional image - and krea2's own text encoder
    IS qwen3vl-4b, a vision model, so this needs no extra model download and reuses one that
    is already resident.

    ASK FOR THE DECISION, NOT A CLASSIFICATION. The previous version asked "is this a powered
    machine? answer YES or NO" and let a humanoid robot through as not-a-machine in a real
    run, which is what put feathered wings on it. The model was right and the PARSE was wrong:
    it never answers in one word, it writes a paragraph that walks through the question's own
    wording first - "...is a robot. ... It is not a drone, aircraft, vehicle ... Answer: YES" -
    so the verdict is the LAST thing generated, and max_length cut it off before the model got
    there. All that survived was a mid-sentence negation of the question's own words, read as
    a NO. Whether that happened at all came down to where the token limit landed, which is why
    it looked fine in testing and then failed in the game.

    Asking directly for ROTORS or WINGS removes the failure entirely, because the answer word
    now comes FIRST: 12/12 across a humanoid robot, a drone, a RAM stick, a taco, a dog and a
    dragon, identical on repeat runs. A machine replies "assistant: ROTORS" and nothing else;
    a creature is the one that rambles ("Wait, I need to be more precise. The object is a
    dog, which is a living creature..."), and a rambling answer that gets truncated falls
    through to wings - the answer a creature wanted anyway. Every failure path, this one
    included, lands on wings.

    Do NOT phrase it as "if it is a machine it should get ROTORS, otherwise WINGS" - that
    exact wording returned an EMPTY string for all three non-machines, 6/6. The two options
    have to be spelled out as two symmetrical instructions."""
    try:
        question = ("Look at this object and reply with exactly one word. Reply ROTORS if it "
                    "is a machine, robot, vehicle, or electronic device. Reply WINGS if it is "
                    "a living creature, a plant, a food, or any other thing that is not a "
                    "machine.")
        infile = f"vlmcls_{int(time.time()*1000)}.png"
        shutil.copy(image_path, os.path.join(COMFY_INPUT_DIR, infile))
        payload = {
            "k_clip": {"inputs": {"clip_name": KREA2_CLIP, "type": "krea2", "device": "default"},
                       "class_type": "CLIPLoader"},
            "img": {"inputs": {"image": infile}, "class_type": "LoadImage"},
            # Long enough that a rambling answer reaches its verdict rather than being cut
            # off mid-sentence, which is exactly how the old classifier went wrong.
            "gen": {"inputs": {"clip": ["k_clip", 0], "image": ["img", 0], "prompt": question,
                               "max_length": 96, "sampling_mode": "off",
                               "use_default_template": True, "thinking": False},
                    "class_type": "TextGenerate"},
            "prev": {"inputs": {"source": ["gen", 0]}, "class_type": "PreviewAny"},
        }
        data = json.dumps({"prompt": payload}).encode("utf-8")
        req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as resp:
            pid = _track_prompt(json.loads(resp.read().decode("utf-8"))["prompt_id"])

        start = time.time()
        text = ""
        while time.time() - start < timeout:
            time.sleep(0.5)
            _bail_if_cancelled()
            with urllib.request.urlopen(f"{COMFY_URL}/history/{pid}") as h:
                hist = json.loads(h.read().decode("utf-8"))
            if pid in hist and (hist[pid].get("outputs") or
                                hist[pid].get("status", {}).get("completed")):
                text = " ".join(hist[pid].get("outputs", {}).get("prev", {}).get("text", []))
                break
        # Whichever option word it reaches FIRST is the answer; neither means wings.
        up = text.upper()
        i_rot, i_win = up.find("ROTORS"), up.find("WINGS")
        if i_rot < 0:
            verdict = False
        elif i_win < 0:
            verdict = True
        else:
            verdict = i_rot < i_win
        print(f"[VLM] rotors={verdict} <- {text.strip()[:110]!r}")
        return verdict
    except Exception as e:
        print(f"[VLM Error] {e} - defaulting the flyer to wings")
        return False


# The palette-similarity gate that used to live here (keep a direct krea2 flyer when its
# colours still matched the walker, else re-do it as a Kontext edit) is GONE, along with
# FLYER_IDENTITY_MIN. It existed only because krea2 was generating the flyer directly. Both
# the flyer and the boss are Kontext edits of the walker now, which preserves identity by
# construction, so there is nothing left to gate.


def generate_kontext_enemy_variants(walker_path, size=512, variants=None):
    """Derive the requested variants from the finished walker sprite, in ONE Kontext job.

    The walker arrives as a tight RGBA cut-out that is often far taller than it is wide (a
    RAM stick crops to ~127x512), so for each variant it is composited onto white and padded
    into a square - that surrounding space is where wings get drawn. Kontext needs full RGB,
    hence the white composite rather than the alpha PNG.

    The flyer's edit is chosen per subject: a powered machine is refitted with rotors and
    thrusters, anything else gets wings. See _vlm_wants_rotors.

    Returns {variant: path or None}; None means the caller should fall back to a direct krea2
    generation for that variant."""
    from PIL import Image
    wanted = [v for v in (variants or KONTEXT_ENEMY_EDITS) if v in KONTEXT_ENEMY_EDITS]
    out = {v: None for v in wanted}
    if not wanted:
        return out

    # Only reached when the species naming failed, so the stage is registered now rather than
    # planned up front - see _plan_v6.
    PROGRESS.add_job("enemy_variants", "Deriving the flyer and the boss with Kontext...",
                     40, len(wanted) * KONTEXT_STEPS)

    edits = {v: KONTEXT_ENEMY_EDITS[v]["edit"] for v in wanted}
    if "flyer" in wanted and _vlm_wants_rotors(walker_path):
        print("[Kontext Enemy] subject is a machine - the flyer gets rotors and thrusters")
        edits["flyer"] = KONTEXT_THRUSTER_EDIT

    try:
        b = {
            "unet": {"inputs": {"unet_name": KONTEXT_UNET, "weight_dtype": "default"}, "class_type": "UNETLoader"},
            "clip": {"inputs": {"clip_name1": FLUX_T5, "clip_name2": FLUX_CLIP_L, "type": "flux"}, "class_type": "DualCLIPLoader"},
            "vae":  {"inputs": {"vae_name": FLUX_AE}, "class_type": "VAELoader"},
            "bg_model": {"inputs": {"bg_removal_name": BIREFNET_MODEL}, "class_type": "LoadBackgroundRemovalModel"},
        }
        src = Image.open(walker_path).convert("RGBA")
        for v in wanted:
            cfg = KONTEXT_ENEMY_EDITS[v]
            scale = min((size * cfg["h"]) / src.height, (size * cfg["w"]) / src.width)
            sub = src.resize((max(1, round(src.width * scale)), max(1, round(src.height * scale))),
                             Image.LANCZOS)
            canvas = Image.new("RGB", (size, size), (255, 255, 255))
            canvas.paste(sub, ((size - sub.width) // 2, (size - sub.height) // 2), sub)
            infile = f"kxenemy_{v}_{int(time.time()*1000)}.png"
            canvas.save(os.path.join(COMFY_INPUT_DIR, infile), format="PNG")

            b[f"{v}_load"] = {"inputs": {"image": infile}, "class_type": "LoadImage"}
            b[f"{v}_enc"] = {"inputs": {"pixels": [f"{v}_load", 0], "vae": ["vae", 0]}, "class_type": "VAEEncode"}
            b[f"{v}_pos"] = {"inputs": {"text": edits[v], "clip": ["clip", 0]}, "class_type": "CLIPTextEncode"}
            b[f"{v}_ref"] = {"inputs": {"conditioning": [f"{v}_pos", 0], "latent": [f"{v}_enc", 0]}, "class_type": "ReferenceLatent"}
            b[f"{v}_g"] = {"inputs": {"conditioning": [f"{v}_ref", 0], "guidance": KONTEXT_GUIDANCE}, "class_type": "FluxGuidance"}
            b[f"{v}_neg"] = {"inputs": {"conditioning": [f"{v}_pos", 0]}, "class_type": "ConditioningZeroOut"}
            b[f"{v}_samp"] = {"inputs": {"seed": random.randint(1, 1000000000), "steps": KONTEXT_STEPS,
                                         "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
                                         "denoise": 1.0, "model": ["unet", 0], "positive": [f"{v}_g", 0],
                                         "negative": [f"{v}_neg", 0], "latent_image": [f"{v}_enc", 0]},
                              "class_type": "KSampler"}
            b[f"{v}_dec"] = {"inputs": {"samples": [f"{v}_samp", 0], "vae": ["vae", 0]}, "class_type": "VAEDecode"}
            _kontext_alpha_nodes(b, v, f"{v}_dec", "kxenemy")

        paths = _krea2_submit_and_collect(b, wanted, timeout=600,
                                          job_key="enemy_variants")
        for v in wanted:
            p = paths[v]
            keep_largest_figure(p, thresh=50)
            problem = _enemy_frame_problem(p)
            if problem:
                print(f"[Kontext Enemy] {v} edit came back {problem} - falling back to krea2")
                continue
            _save_tight(p, thresh=50)
            out[v] = p
        return out
    except Exception as e:
        print(f"[Kontext Enemy Error] {e}")
        return out


def _krea2_finish_enemy_variants(paths, enemy_style, sq, steps, prefix, species=None,
                                 generated=None, seeds=None):
    """Post-process the generated enemy branches in `paths` (keys `enemy_<variant>`): drop any
    stray blob / BiRefNet halo, regen a variant that came back too small or clipped, then
    tight-crop.

    `generated` is {variant: [frames]} as _krea2_add_enemy_variants actually built it. With
    `species` that is all three foes, each with its own frames, and there is nothing to derive
    - each was drawn from its own description. Without it, only the walker's idle was drawn
    and the other two are Kontext edits of it (flyer mechanism chosen per subject - see
    _vlm_wants_rotors), which yields an idle frame only.

    `seeds` is {variant: seed} from the same call, so a mis-framed pose frame can be re-drawn
    as the same foe rather than as a new one.

    Returns {variant: {frame: path}}.

    Both kinds of frame are quality-gated, but they fail differently. A broken IDLE is a bad
    roll of the foe itself, so it is re-rolled on a FRESH seed. A broken POSE frame is drawn
    from an idle that already passed, so the foe is fine and only the framing went wrong: it
    is re-drawn once on the SAME seed at the widest margin, and dropped only if that fails
    too, leaving the frontend on the idle for that pose.

    CLIPPING counts as broken on a pose frame, and that is not the obvious call - a lunging
    limb running off the edge is the pose doing its job. It is the right call because of how
    the frontend sizes these: every frame is scaled by the IDLE frame's content box, so a
    frame that got clipped because krea2 re-framed it as a close-up is drawn at the idle's
    scale and comes out enormous and cut in half. That is worse than no pose frame at all."""
    generated = generated or {v: ENEMY_FRAME_FALLBACK
                              for v in (ENEMY_VARIANT_NAMES if species
                                        else KREA2_FALLBACK_DIRECT_VARIANTS)}
    enemies = {}
    for v, frames in generated.items():
        got = {}
        for f in frames:
            fp = paths.get(f"enemy_{v}_{f}")
            if not fp:
                continue
            keep_largest_figure(fp, thresh=50)
            problem = _enemy_frame_problem(fp)
            if problem and f == "idle":
                print(f"[krea2] {prefix} {v} idle enemy is {problem} - regenerating it alone")
                look = species[v]["look"] if species else None
                fp = _krea2_regen_enemy(enemy_style, sq, steps, prefix, variant=v,
                                        clipped=problem.startswith("clipped"), look=look)
            elif problem:
                # One retry at the widest margin, on this foe's own seed, before the pose is
                # given up on. Nearly every failure here is the model choosing to crop in
                # rather than to draw the subject smaller, and that is exactly what the extra
                # margin argues it out of - so a retry is worth one image, where dropping the
                # frame costs the pose for the whole dungeon.
                print(f"[krea2] {prefix} {v} {f} frame is {problem} - re-framing it once")
                fp = (_krea2_regen_pose_frame(species[v]["look"], enemy_style,
                                              species[v].get("guard"), f, (seeds or {}).get(v),
                                              sq, steps, prefix, variant=v)
                      if species and (seeds or {}).get(v) else None)
                if not fp:
                    fallback = "the attack frame" if f == ENEMY_STRIKE_FRAME else "idle"
                    print(f"[krea2] {prefix} {v} {f} frame is unusable - dropping it, "
                          f"the frontend will use {fallback} for that pose")
                    continue
            if fp:
                got[f] = fp
        # Register every frame of this foe against ONE box so it holds still when the sprite
        # swaps mid-fight. The box is the UNION, so an attack lunge is not clipped - the
        # frontend then scales all frames by the IDLE frame's content, which keeps the idle at
        # its intended size and lets the lunge genuinely reach further. A regenerated idle can
        # be a different canvas size, so only crop when the frames still agree.
        if len(got) > 1:
            sizes = {Image.open(p).size for p in got.values()}
            if len(sizes) == 1:
                crop_frames_to_common_bbox(list(got.values()))
            else:
                print(f"[krea2] {prefix} {v} frames differ in size {sizes} - cropping separately")
                for p in got.values():
                    _save_tight(p, thresh=50)
        elif got:
            _save_tight(next(iter(got.values())), thresh=50)
        if got.get("idle"):
            enemies[v] = got

    todo = [v for v in ENEMY_VARIANT_NAMES if not enemies.get(v)]
    if todo and enemies.get("walker", {}).get("idle"):
        derived = generate_kontext_enemy_variants(enemies["walker"]["idle"], size=sq,
                                                  variants=todo)
        for v, p in derived.items():
            if p is None:
                # The Kontext edit failed too. A drifted direct generation is still a better
                # enemy than nothing, so keep whatever we already had.
                p = (enemies.get(v) or {}).get("idle") or _krea2_regen_enemy(
                    enemy_style, sq, steps, prefix, variant=v, attempts=1)
            if p:
                enemies[v] = {"idle": p}

    missing = [v for v in ENEMY_VARIANT_NAMES if not enemies.get(v)]
    if missing:
        print(f"[krea2] {prefix} enemy variants missing: {missing} - the frontend will fall "
              f"back to the walker for those")
    for v, fr in enemies.items():
        print(f"[krea2] {prefix} {v}: {sorted(fr)}")
    return {v: enemies[v] for v in ENEMY_VARIANT_NAMES if enemies.get(v)}


def generate_krea2_character_bundle(player_style, weapon_style, enemy_style,
                                    steps=KREA2_STEPS_DEFAULT, gfx=None, brief=None):
    """v5: one krea2-turbo prompt - player, weapon, shield, enemy - then a separate
    krea2-idle + FLUX.1 Kontext job for the four HUD portrait frames (see
    generate_kontext_portrait_set). Returns {player, weapon, shield, enemy, portrait,
    portraits}; portraits is a 4-list (or None) and portrait is portraits[0].
    `gfx` is a GFX_QUALITY_PROFILES entry - `player` sizes the player/weapon/shield,
    `enemy` the enemy sprites, `portrait` the HUD busts.
    `brief` is a generate_theme_brief() dict (or None) - see generate_krea2_posed_bundle."""
    gfx = gfx or GFX_QUALITY_PROFILES[GFX_QUALITY_DEFAULT]
    sq = _round16(gfx["player"])
    esq = _round16(gfx["enemy"])
    ww = _round16(gfx["player"] * 0.5)                    # narrow canvas for the upright weapon

    # See generate_krea2_posed_bundle for why this rebinds rather than being passed through to
    # the species call alone.
    weapon_style = (brief or {}).get("weapon") or weapon_style
    enemy_style = (brief or {}).get("enemy") or enemy_style

    species = generate_enemy_species(enemy_style)

    payload = _krea2_loaders()
    _krea2_add_branch(payload, "player", krea2_player_prompt(player_style), sq, sq, steps, random.randint(1, 1000000000), "v5")
    _krea2_add_branch(payload, "weapon", krea2_weapon_prompt(weapon_style, player_style), ww, sq, steps, random.randint(1, 1000000000), "v5")
    _krea2_add_branch(payload, "shield", krea2_shield_prompt(player_style), sq, sq, steps, random.randint(1, 1000000000), "v5")
    added, seeds = _krea2_add_enemy_variants(payload, enemy_style, esq, steps, "v5", species=species)

    names = ("player", "weapon", "shield") + tuple(f"enemy_{v}_{f}"
                                                   for v, fs in added.items() for f in fs)
    t0 = time.time()
    paths = _krea2_submit_and_collect(payload, names, job_key="frames")
    elapsed = time.time() - t0

    keep_largest_figure(paths["player"])
    _save_tight(paths["player"])

    enemies = _krea2_finish_enemy_variants(paths, enemy_style, esq, steps, "v5",
                                           species=species, generated=added, seeds=seeds)
    paths["enemies"] = enemies
    # Legacy single-sprite field for older frontend paths. Guarded because losing the whole
    # bundle to a KeyError over one missing enemy would be a poor trade.
    paths["enemy"] = (enemies.get("walker") or {}).get("idle")
    paths["enemy_names"] = ({v: species[v]["name"] for v in species} if species else None)

    for n in ("weapon", "shield"):
        _save_tight(paths[n])

    paths["portraits"] = generate_kontext_portrait_set(player_style, size=gfx["portrait"])
    paths["portrait"] = paths["portraits"][0] if paths["portraits"] else None

    print(f"[krea2] v5 bundle complete - player {sq}x{sq}, enemy {esq}x{esq}, "
          f"portrait {gfx['portrait']}px, {int(steps)} steps, krea2 {elapsed:.1f}s")
    return paths


# v6 - krea2 multi-frame player. krea2 turbo has no ControlNet, so the poses are driven
# purely by text with one shared seed holding the character/weapon/framing steady between
# frames (the same lever v4 leaned on alongside its OpenPose skeletons). The frontend's
# existing multi-frame path swaps these during block / attack / hurt.
# APPEND-ONLY. The frontend indexes this list by number (V6_*_FRAME_INDEX below, and the
# matching literals in game.js), so a new pose goes on the END - inserting one in the middle
# silently reassigns every frame after it.
V6_FRAME_NAMES = ["idle", "block", "windup", "slash1", "slash2", "slash3", "hurt",
                  "walk1", "walk2"]

# Attack progress (0..1) -> index into V6_FRAME_NAMES. windup, then the three swing frames.
V6_ATTACK_FRAME_INDICES = [2, 3, 4, 5]
V6_BLOCK_FRAME_INDEX = 1
V6_HURT_FRAME_INDEX = 6
# The two halves of the walk cycle, alternated by the frontend while the player strafes.
# NOT a left-step and a right-step: krea2 will not reliably draw one versus the other (both
# wordings tried came back with the two frames leaning the SAME way, 0/4 seeds - directional
# left/right is a known weak spot for diffusion models). Opposite phases of one stride are
# something it can do, the two frames measure 0.42-0.57 apart by silhouette, and the direction
# of travel is already unambiguous from the character sliding across the screen.
V6_WALK_FRAME_INDICES = [7, 8]


def krea2_frame_prompts(player_style, weapon_style, brief=None):
    """The seven v6 pose prompts. Identical scaffold - same character, same gear, same
    strict back view - so only the action clause varies frame to frame.

    `w` is interpolated nine times as "holding a {w}", so an abstract typed weapon renders the
    whole character wrong: "memes" became "holding a memes in the right hand". A
    generate_theme_brief() weapon line is a concrete one-handed object written to read
    correctly after that article, and is preferred whenever there is one."""
    p = player_style.strip() if (player_style and player_style.strip()) else "armored warrior knight"
    w = (brief or {}).get("weapon") or (
        weapon_style.strip() if (weapon_style and weapon_style.strip()) else "sword")
    base = (
        f"A full-body video game character sprite of a {p}, seen strictly from directly behind in a "
        f"third-person back view, facing away from the camera into the scene, holding a {w} in the "
        f"right hand and a round battle shield on the left arm. The whole figure from head to feet, "
        f"standing large and upright and filling the frame from top to bottom, the head near the top "
        f"edge and the feet near the bottom edge, with only a thin margin above and below and enough "
        f"clear room to the left and right for the weapon to swing without being cut off. Even "
        f"lighting, sharp detailed textures, plain solid pure white background, no shadow on the "
        f"ground, nothing else in frame. "
    )
    actions = {
        "idle":   f"Standing at the ready, the {w} lowered at their side, shield down.",
        # Strict back view (the base wins that), one shield only - so lift THE shield already
        # on the arm rather than adding a raised one: left arm bent and lifted to bring the
        # round shield up beside the head, body dropping into a low braced crouch. Sword hand
        # lowered and back. Planted and still, no motion blur. Shield stays arm-connected for
        # clean matting.
        "block":  (f"Raising the shield into a high guard: the left arm bent and lifted so the round "
                   f"battle shield already on that arm comes up beside the head with its face turned "
                   f"to the side, covering the head and shoulder. The body drops into a low braced "
                   f"crouch, knees bent, weight settled back. The {w} in the right hand is lowered "
                   f"and drawn back. One shield only. A still, planted guard stance, no motion blur."),
        "windup": f"Winding up to strike: the {w} raised high overhead and cocked back behind the shoulder.",
        "slash1": f"Mid-swing: the {w} sweeping down and forward through a fast diagonal arc, motion blur streaking off the blade.",
        "slash2": f"Full follow-through: the {w} swung all the way down and across the body, arms extended, motion blur.",
        "slash3": f"Recovering from the swing: the {w} trailing low across the far side, weight settling back to centre.",
        "hurt":   f"Staggering backward off balance, recoiling from a hit, the {w} and shield flung wide.",
        # The two opposite phases of one stride - see V6_WALK_FRAME_INDICES for why this is a
        # walk CYCLE and not a left-step / right-step pair. Described as a planted mid-stride
        # rather than "walking", which on a back view tends to come back as a figure wandering
        # away from the camera into the distance. Whether the model honours which leg leads
        # does not matter; the cycle only needs the two frames to be opposite each other.
        "walk1": (f"Mid-stride, caught in the middle of a step: one leg swung forward and "
                  f"planted with the weight rolling onto it, the other stretched out long "
                  f"behind, the body leaning into the movement, the {w} swinging with it."),
        "walk2": (f"Mid-stride on the opposite step, legs fully scissored the other way: the "
                  f"leg that was trailing now swung forward and planted, the other stretched "
                  f"out long behind it, the body leaning into the movement, the {w} swinging "
                  f"back the other way."),
    }
    return [base + actions[n] for n in V6_FRAME_NAMES]


def generate_krea2_posed_bundle(player_style, weapon_style, enemy_style,
                                steps=KREA2_STEPS_DEFAULT, gfx=None, brief=None,
                                enemy_named=None, last_attack_frame=False):
    """v6: one krea2 prompt with the 7 shared-seed player pose frames and an enemy, then a
    separate krea2-idle + FLUX.1 Kontext job for the four HUD portrait frames (see
    generate_kontext_portrait_set). Returns {"frames": [7 paths], "enemy": path|None,
    "portrait": path|None, "portraits": [4]|None}. `gfx` is a GFX_QUALITY_PROFILES entry -
    `player` sizes the 7 pose frames, `enemy` the foe sprites, `portrait` the HUD busts.
    `last_attack_frame` gives every foe its ENEMY_STRIKE_FRAME as well.

    `brief` is a generate_theme_brief() dict (or None) supplying a concrete weapon object and
    a concrete enemy subject when the typed words were abstract. `enemy_named` is the enemy
    field's resolve_named_styles() entity (or None) - a quoted individual titles the BOSS
    variant specifically (see parse_story_block for the path that actually reaches the
    screen) and its name is stripped out of the bestiary's own subject below, so three foes
    don't all end up named after the one boss."""
    gfx = gfx or GFX_QUALITY_PROFILES[GFX_QUALITY_DEFAULT]
    sq = _round16(gfx["player"])            # the 7 player pose frames
    esq = _round16(gfx["enemy"])            # every frame of all three foes
    frame_seed = random.randint(1, 1000000000)     # ONE seed across all seven frames

    # The designed subject replaces the typed word for EVERY enemy path, not just the species
    # designer: krea2_species_prompt re-anchors the noun in code and the Kontext fallback
    # rebuilds from krea2_enemy_prompt, so handing only one of them the concrete version would
    # put "chat" back into the picture the moment the species call failed.
    enemy_style = (brief or {}).get("enemy") or enemy_style

    # A quoted name must not leak into the bestiary as the shared subject - the designed line
    # for "a cat called Billy" reads "Billy the sleek black alley cat", and repeated eight
    # times inside _ENEMY_SPECIES_USER that names all three variants Billy, exactly the "forty
    # Billys" outcome a named individual exists to avoid (the name belongs on the boss alone).
    # Falls back to the bare kind noun when stripping empties the line.
    # ...but only for a name the identity call could NOT place in the real world. A known
    # character IS the look: typing "Sonic" asks for a dungeon full of Sonics, and stripping
    # the name leaves the bestiary designing from the bare kind noun it resolved to ("video
    # game character"), which is how "Sonic" came back as three unrelated mascots while the
    # unrecognised "Sanic" - never stripped, because it never resolved - came back right.
    if enemy_named and enemy_named.get("kind") and not enemy_named.get("known"):
        enemy_style = _strip_proper_name(enemy_style, enemy_named["name"]) or enemy_named["kind"]

    species = generate_enemy_species(enemy_style)
    # Keep the species-level fallback name in step with the title parse_story_block actually
    # uses (game.js reads the story's boss title FIRST and only falls back to this one), so the
    # two can never disagree if the story call itself happened to fail.
    if species and enemy_named and enemy_named.get("kind"):
        species["boss"]["name"] = enemy_named["name"]

    payload = _krea2_loaders()
    frame_prompts = krea2_frame_prompts(player_style, weapon_style, brief)
    for name, prompt_text in zip(V6_FRAME_NAMES, frame_prompts):
        _krea2_add_branch(payload, name, prompt_text, sq, sq, steps, frame_seed, "v6")
    added, seeds = _krea2_add_enemy_variants(payload, enemy_style, esq, steps, "v6", species=species,
                                             last_attack_frame=last_attack_frame)

    keys = V6_FRAME_NAMES + [f"enemy_{v}_{f}" for v, fs in added.items() for f in fs]
    t0 = time.time()
    paths = _krea2_submit_and_collect(payload, keys, job_key="frames")
    elapsed = time.time() - t0

    frame_paths = [paths[n] for n in V6_FRAME_NAMES]
    for fp in frame_paths:
        keep_largest_figure(fp)
    # One shared bounding box so the character holds still between frames instead of rescaling on
    # every swap. Build it from the planted stances only - the slash, windup and hurt frames fling
    # the weapon and arms well past the body, and letting those into the union blew the box out
    # sideways and left the character tiny and floating in every frame. The two walk frames ARE
    # planted (a stride reaches much less far than a swing) and they are included, so a leading
    # foot is not cropped off at the edge of the frame.
    _planted = [V6_FRAME_NAMES.index(n) for n in ("idle", "block", "walk1", "walk2")]
    crop_frames_to_common_bbox(frame_paths, bbox_indices=_planted)

    enemies = _krea2_finish_enemy_variants(paths, enemy_style, esq, steps, "v6",
                                           species=species, generated=added, seeds=seeds)
    portraits = generate_kontext_portrait_set(player_style, size=gfx["portrait"])

    print(f"[krea2] v6 {len(frame_paths)}-frame player + {len(enemies)} enemy variants complete - "
          f"player {sq}x{sq}, enemy {esq}x{esq}, portrait {gfx['portrait']}px, "
          f"{int(steps)} steps, krea2 {elapsed:.1f}s")
    return {"frames": frame_paths, "enemy": (enemies.get("walker") or {}).get("idle"),
            "enemies": enemies,
            "enemy_names": ({v: species[v]["name"] for v in species} if species else None),
            "portrait": portraits[0] if portraits else None, "portraits": portraits}


def run_batch_v5_krea(wall_style, player_style=None, weapon_style=None, enemy_style=None,
                      steps=KREA2_STEPS_DEFAULT, player_image=None, gfx=None):
    """v5 krea2 turbo mode: FLUX schnell for the 3 tiling textures, krea2 turbo for the
    player sprite, weapon, shield, enemy and the 4 HUD portrait frames - one pass each.
    `gfx` is a GFX_QUALITY_PROFILES entry (defaults to normal)."""
    global gen_progress
    gfx = gfx or GFX_QUALITY_PROFILES[GFX_QUALITY_DEFAULT]
    gen_progress["is_generating"] = True
    gen_progress["completed_bundle"] = None
    gen_progress["error"] = None
    gen_progress["current_step"] = 0
    gen_progress["total_steps"] = 3
    gen_progress["story"] = None
    gen_progress["phase"] = ""
    PROGRESS.begin_plan(_plan_v5(steps))

    def _b64(path):
        with open(path, "rb") as tf:
            return f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"

    try:
        # THE SET DESIGNER RUNS FIRST - everything downstream wants its output. When the typed
        # theme matches one of the hand-tuned keyword buckets those surface prompts are
        # literals that ignore the brief, so only the weapon and enemy are asked for; a
        # two-label reply is far harder to come back malformed than an eight-label one.
        brief = generate_theme_brief(wall_style, weapon_style, enemy_style,
                                     want_surfaces=(_style_bucket(wall_style) is None))

        gen_progress["current_step"] = 1
        story = generate_intro_story(wall_style, player_style, weapon_style, enemy_style,
                                     player_image)
        gen_progress["story"] = story

        gen_progress["current_step"] = 2
        w_path, c_path, f_path, l_path, d_path, s_path = generate_flux_surfaces_only(wall_style, gfx, brief)

        gen_progress["current_step"] = 3
        assets = generate_krea2_character_bundle(player_style, weapon_style, enemy_style, steps, gfx, brief)

        PROGRESS.end_plan()
        gen_progress["status_message"] = "Assembling 3D world & Valbrace combat..."
        gen_progress["phase"] = ""
        gen_progress["percent"] = 98

        player_b64 = _b64(assets["player"])
        # idle/attack/block/hurt busts; falls back to the player sprite if the whole set failed.
        faces_b64 = [_b64(p) for p in assets["portraits"]] if assets.get("portraits") else [player_b64]

        gen_progress["percent"] = 100
        gen_progress["status_message"] = "krea2 turbo dungeon & character ready!"
        gen_progress["completed_bundle"] = {
            "mode": "v5_krea",
            "story": story,
            "wall_style": wall_style,
            # What the set designer resolved the typed words into, or None if it was
            # skipped or failed. Kept so a bad render can be diagnosed from the saved
            # session alone - the raw typed words are on the meta, but they are not
            # what actually got drawn.
            "theme_brief": brief,
            "wall_texture": _b64(w_path),
            "ceiling_texture": _b64(c_path),
            "floor_texture": _b64(f_path),
            "lantern_texture": _b64(l_path) if l_path else None,
            "door_texture": _b64(d_path) if d_path else None,
            "switch_texture": _b64(s_path) if s_path else None,
            "player_sprite": player_b64,
            "player_sprites": [player_b64],
            "player_face": faces_b64[0],
            "player_faces": faces_b64,
            "weapon_sprite": _b64(assets["weapon"]) if assets.get("weapon") else None,
            "shield_sprite": _b64(assets["shield"]) if assets.get("shield") else None,
            "enemy_sprites": [_b64(assets["enemy"])] if assets.get("enemy") else [],
            # walker / flyer / boss - the frontend picks one at random on each battle entry.
            # {variant: {frame: dataurl}} - idle/attack for every foe, plus block for the two
            # that fight on the ground. Always an object, never a bare string.
            "enemy_variants": ({v: {f: _b64(p) for f, p in fr.items()}
                                for v, fr in assets["enemies"].items()}
                               if assets.get("enemies") else None),
            # Each foe's own invented name, when the LLM designed them (generate_enemy_species).
            "enemy_names": assets.get("enemy_names"),
            "enemy_style": (enemy_style or "").strip(),
        }
        print("[krea2] v5 bundle complete and packaged!")

    except GenerationCancelled as c:
        # Not a failure: the page that asked for this run is gone, and /api/cancel_generation
        # has already drained the ComfyUI queue. Leave progress idle rather than parking an
        # error the next visitor would see on their first poll.
        print(f"[krea2 v5] {c}")
        gen_progress["status_message"] = "Generation cancelled - the page was closed."
        gen_progress["percent"] = 0
        gen_progress["phase"] = ""
    except Exception as e:
        print(f"[krea2 v5 Error] {e}")
        gen_progress["error"] = str(e)
    finally:
        PROGRESS.end_plan()
        gen_progress["is_generating"] = False


def run_batch_v6_krea(wall_style, player_style=None, weapon_style=None, enemy_style=None,
                      steps=KREA2_STEPS_DEFAULT, player_image=None,
                      sound_mode="music_and_sound", gfx=None, gfx_name=GFX_QUALITY_DEFAULT,
                      last_attack_frame=False, ending_video="off"):
    """v6 krea2 turbo mode: like v5 but the player is a 7-frame swing animation (shared
    seed, text-posed) that the frontend swaps through on block / attack / hurt - the way
    v4 did it, on the stronger model.

    sound_mode is one of "music_and_sound" (default), "sound_only" (sfx but no music, the
    original always-on behavior) or "skip" (no audio generation at all, fastest).
    gfx is a GFX_QUALITY_PROFILES entry (normal / optimized / reduced) giving the target
    px for each asset class - textures, player frames, enemy sprites, HUD portraits.
    gfx_name is the plain dropdown key that gfx was resolved from, kept on the bundle so
    the History window can show which quality tier the assets were rendered at.
    last_attack_frame is the Options toggle of that name: every foe also gets the frame
    game.js shows on the tick its blow lands (ENEMY_STRIKE_FRAME), and the run is saved as
    frame version 2.
    ending_video is the Options pair of that name, resolved by the request handler: "off",
    "loading" (the cutscene is filmed here, as the run's last stage) or "background" (the run is
    saved without it and start_ending_video_job films it while the player plays)."""
    global gen_progress
    gfx = gfx or GFX_QUALITY_PROFILES[GFX_QUALITY_DEFAULT]
    gen_progress["is_generating"] = True
    gen_progress["completed_bundle"] = None
    gen_progress["error"] = None
    gen_progress["current_step"] = 0
    gen_progress["total_steps"] = 4
    gen_progress["story"] = None
    gen_progress["phase"] = ""
    PROGRESS.begin_plan(_plan_v6(steps, sound_mode, last_attack_frame, ending_video))

    def _b64(path):
        with open(path, "rb") as tf:
            return f"data:image/png;base64,{base64.b64encode(tf.read()).decode('utf-8')}"

    try:
        # NAMED ENTITIES RESOLVE FIRST - a quoted proper name ("alley pond park", "Billy" the
        # cat) changes what the set designer is asked for (want_surfaces below) and what every
        # LLM call downstream is fed, so nothing else can run ahead of it. See
        # resolve_named_styles; on any failure `named` degrades to all-None and every one of
        # its fields below is just the raw typed word again - today's behaviour.
        named = resolve_named_styles(wall_style, player_style, weapon_style, enemy_style)

        # THE SET DESIGNER RUNS FIRST - everything downstream wants its output. When the typed
        # theme matches one of the hand-tuned keyword buckets those surface prompts are
        # literals that ignore the brief, so only the weapon and enemy are asked for; a
        # two-label reply is far harder to come back malformed than an eight-label one. A
        # quoted wall name always takes this path too - see _theme_bucket.
        brief = generate_theme_brief(named["text"]["wall"], named["text"]["weapon"],
                                     named["text"]["enemy"],
                                     want_surfaces=(_theme_bucket(wall_style, named["wall"]) is None),
                                     wall_named=named["wall"], enemy_named=named["enemy"])

        # The story is published on its own, minutes ahead of the bundle, so the frontend can
        # start the crawl while everything else is still rendering. It keeps the player's OWN
        # words as much as possible - prose generation, where an abstract theme is no handicap
        # - but takes the same named-entity rewrite as everything else, so a literal quote mark
        # never reaches this call either, and a quoted field names the location/hero/boss
        # outright (see parse_story_block).
        gen_progress["current_step"] = 1
        story = generate_intro_story(named["text"]["wall"], named["text"]["player"],
                                     named["text"]["weapon"], named["text"]["enemy"],
                                     player_image, named=named)
        gen_progress["story"] = story

        gen_progress["current_step"] = 2
        w_path, c_path, f_path, l_path, d_path, s_path = generate_flux_surfaces_only(
            named["text"]["wall"], gfx, brief, wall_named=named["wall"])

        gen_progress["current_step"] = 3
        bundle = generate_krea2_posed_bundle(named["text"]["player"], named["text"]["weapon"],
                                             named["text"]["enemy"], steps, gfx, brief,
                                             enemy_named=named["enemy"],
                                             last_attack_frame=last_attack_frame)

        # Last, so the audio weights load after the krea2 UNET and Kontext are done with the
        # card rather than competing with them. Both calls are skippable via sound_mode. Audio
        # prompts get the CLEAN split (quotes stripped only, no "called"/"the real" rewrite
        # clause) - sfx_prompts/music_prompts just interpolate the raw words into a sentence,
        # and a designed rewrite fragment reads as noise there rather than as a name.
        gen_progress["current_step"] = 4
        sfx = (generate_sfx_pack(named["clean"]["wall"], named["clean"]["player"],
                                 named["clean"]["weapon"], named["clean"]["enemy"])
               if sound_mode != "skip" else None)
        music = generate_music_pack(named["clean"]["wall"]) if sound_mode == "music_and_sound" else None

        # The ending cutscene, when Options films it on the loading screen. Dead last: it takes
        # the battle bed above as its reference audio, and H3 is by far the heaviest thing the
        # run loads, so nothing after it has to wait for the card to swap back.
        ending_path = None
        if ending_video == "loading":
            enemies = bundle.get("enemies") or {}
            boss_frames = enemies.get("boss") or enemies.get("walker") or {}
            portraits = bundle.get("portraits") or []
            ending_path = generate_ending_video(
                {"hero": bundle["frames"][0], "face": portraits[0] if portraits else None,
                 "boss": boss_frames.get("idle"),
                 "wall": w_path, "floor": f_path, "ceiling": c_path},
                (music or {}).get("battle"), named["clean"])

        PROGRESS.end_plan()
        gen_progress["status_message"] = "Assembling 3D world & Valbrace combat..."
        gen_progress["phase"] = ""
        gen_progress["percent"] = 98

        frames_b64 = [_b64(p) for p in bundle["frames"]]
        # idle/attack/block/hurt busts; falls back to frame 0 if the whole set failed.
        faces_b64 = [_b64(p) for p in bundle["portraits"]] if bundle.get("portraits") else [frames_b64[0]]

        gen_progress["percent"] = 100
        gen_progress["status_message"] = "krea2 turbo swing animation & dungeon ready!"
        gen_progress["completed_bundle"] = {
            "mode": "v6_krea",
            "story": story,
            # The "Graphics Quality" dropdown key these assets were rendered at
            # (normal / optimized / reduced). Read back by save_dungeon_session.
            "graphics_quality": gfx_name,
            # 2 when the Last Attack Frame option was on for this run, so the foes below carry
            # a "strike" frame; 1 otherwise. Read back by save_dungeon_session for History.
            "frame_version": FRAME_VERSION_STRIKE if last_attack_frame else FRAME_VERSION_BASE,
            "wall_style": wall_style,
            # What the set designer resolved the typed words into, or None if it was
            # skipped or failed. Kept so a bad render can be diagnosed from the saved
            # session alone - the raw typed words are on the meta, but they are not
            # what actually got drawn.
            "theme_brief": brief,
            # What each quoted proper name (resolve_named_styles) resolved to - None-valued
            # entries and all, so a saved session can be diagnosed the same way theme_brief
            # already is. None when nothing in any field was quoted.
            "named_styles": named,
            "wall_texture": _b64(w_path),
            "ceiling_texture": _b64(c_path),
            "floor_texture": _b64(f_path),
            "lantern_texture": _b64(l_path) if l_path else None,
            "door_texture": _b64(d_path) if d_path else None,
            "switch_texture": _b64(s_path) if s_path else None,
            "player_sprite": frames_b64[0],
            "player_sprites": frames_b64,
            "player_face": faces_b64[0],
            "player_faces": faces_b64,
            "weapon_sprite": None,
            "shield_sprite": None,
            "enemy_sprites": [_b64(bundle["enemy"])] if bundle.get("enemy") else [],
            # walker / flyer / boss - the frontend picks one at random on each battle entry.
            # {variant: {frame: dataurl}} - idle/attack for every foe, plus block for the two
            # that fight on the ground, plus strike on a frame version 2 run. Always an object,
            # never a bare string.
            "enemy_variants": ({v: {f: _b64(p) for f, p in fr.items()}
                                for v, fr in bundle["enemies"].items()}
                               if bundle.get("enemies") else None),
            # Each foe's own invented name, when the LLM designed them (generate_enemy_species).
            "enemy_names": bundle.get("enemy_names"),
            "enemy_style": (enemy_style or "").strip(),
            # {name: data:audio/wav;base64,...} for whatever survived, or None. Partial is
            # fine and expected - game.js synthesises anything missing.
            "sfx": sfx,
            # {"explore": data:audio/wav;base64,..., "battle": ...} or None (sound_mode wasn't
            # "music_and_sound", or generation failed) - game.js just runs without music.
            "music": music,
        }
        print("[krea2] v6 bundle complete and packaged!")

        # Keep it, so the History window can replay this dungeon without paying for it
        # again. Never fatal: a save that fails costs the player nothing they can see.
        # The id comes back onto the bundle itself (not just the meta.json already written
        # to disk) so game.js can name this exact run later - e.g. "erase the current run"
        # from the in-game quit menu, which is just a history_delete for this id.
        history_id = save_dungeon_session(gen_progress["completed_bundle"],
                             wall_style, player_style, weapon_style, enemy_style,
                             sound_mode, ending_video_path=ending_path)
        gen_progress["completed_bundle"]["history_id"] = history_id
        # Background mode starts filming the moment the run is on disk - while the player is
        # still reading the crawl, which is free time the render would otherwise not get.
        if ending_video == "background" and history_id:
            start_ending_video_job(history_id, from_run=True)

    except GenerationCancelled as c:
        # Not a failure: the page that asked for this run is gone, and /api/cancel_generation
        # has already drained the ComfyUI queue. Leave progress idle rather than parking an
        # error the next visitor would see on their first poll.
        print(f"[krea2 v6] {c}")
        gen_progress["status_message"] = "Generation cancelled - the page was closed."
        gen_progress["percent"] = 0
        gen_progress["phase"] = ""
    except Exception as e:
        print(f"[krea2 v6 Error] {e}")
        gen_progress["error"] = str(e)
    finally:
        PROGRESS.end_plan()
        gen_progress["is_generating"] = False


# ---------------------------------------------------------------------------
# Dungeon history. Every finished v6 bundle is written to dungeon_sessions/<id>/ so the
# setup screen's History window can replay it later without paying ComfyUI for it a second
# time. Two files per run:
#   bundle.json - the completed_bundle dict verbatim (base64 data URLs and all), served
#                 straight back to the browser, which then takes the ordinary
#                 armEnterDungeon() path as if generation had just finished.
#   meta.json   - the small listing record (names, styles, timestamp, a 96px thumbnail),
#                 so drawing the window never has to open a 40MB bundle.
# The maze itself is generated in the browser and is deliberately NOT stored: replaying a
# saved dungeon gives the same cast and art on a fresh layout at the current difficulty.
# A folder appears here only once a run has FINISHED - save_dungeon_session is the last thing
# run_batch_v6_krea does, so a cancelled run leaves nothing in this directory to clean up. What
# it does leave behind is the raw renders in COMFY_OUTPUT_DIR, which is why the History window
# has a second button onto that folder (see OPENABLE_FOLDERS / /api/open_folder).

_SESSION_ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$")
SESSION_THUMB_PX = 96


def _session_dir(session_id):
    """The folder for a session id, or None if the id isn't one we wrote. Keeps the delete
    and fetch routes from being able to name anything outside dungeon_sessions."""
    if not isinstance(session_id, str) or not _SESSION_ID_RE.match(session_id):
        return None
    return os.path.join(SESSIONS_DIR, session_id)


def _session_thumb(bundle):
    """A small square PNG data URL for the listing - the hero if we have one, else the wall.
    The full-size asset is several hundred KB; twenty of those would make the window's own
    fetch heavier than the dungeon it lists."""
    for key in ("player_face", "player_sprite", "wall_texture"):
        src = bundle.get(key)
        if not src:
            continue
        try:
            raw = base64.b64decode(src.split(",", 1)[-1])
            img = Image.open(io.BytesIO(raw)).convert("RGBA")
            img.thumbnail((SESSION_THUMB_PX, SESSION_THUMB_PX), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")
        except Exception as e:
            print(f"[history] thumbnail from {key} failed ({e})")
    return None


# ---------------------------------------------------------------------------
# Tile cards: one saved run, drawn as the hero standing in their own dungeon
# ---------------------------------------------------------------------------
# History (and the showcase export's landing list) can be shown as a grid of tiles instead of
# rows, and a tile is a picture rather than a line of text - so it needs something better to
# show than the 96px bust _session_thumb crops for a row. A card is that picture: the run's own
# ceiling / wall / floor textures laid out as a lit corridor, with the hero's IDLE frame - the
# default pose, the one the game rests on between swings - planted on the floor at the same
# share of the frame drawOverTheShoulderPlayer gives them in battle. The result is roughly what
# walking into that dungeon looks like.
#
# Deliberately NOT part of meta.json: a 320x240 PNG is ~100KB, and twenty of those inlined into
# the listing would make drawing the window heavier than the thing it lists. It is its own file
# beside the bundle, built once and kept - by save_dungeon_session for a new run, and lazily by
# ensure_session_card for every run saved before tiles existed (building one costs a 16MB
# bundle.json read, which is exactly why the result is written down).
CARD_W, CARD_H = 320, 240
CARD_FILENAME = "card.png"
# Where the corridor's three surfaces meet, as a share of the card's height. The floor line is
# also where the hero's feet go.
CARD_CEILING_SPAN = 0.17
CARD_HORIZON = 0.63
# The hero's opaque height as a share of the card, matching the `height * 0.6` battle sprites
# are drawn at, nudged up because a tile is a fifth the size of the viewport it apes.
CARD_HERO_SPAN = 0.66


def _bundle_image(bundle, key, index=0):
    """One of a bundle's base64 data-URL images as RGBA, or None. `key` may name a list
    (player_sprites), in which case `index` picks the frame."""
    src = bundle.get(key)
    if isinstance(src, list):
        src = src[index] if len(src) > index else None
    if not isinstance(src, str) or not src:
        return None
    try:
        raw = base64.b64decode(src.split(",", 1)[-1])
        return Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception as e:
        print(f"[history] card image from {key} failed ({e})")
        return None


def _cover(img, width, height):
    """Scale-and-crop `img` to exactly width x height, keeping its aspect - CSS object-fit:
    cover. None for an empty box, so a caller can skip that band entirely."""
    if img is None or width <= 0 or height <= 0:
        return None
    scale = max(width / img.width, height / img.height)
    w = max(1, int(round(img.width * scale)))
    h = max(1, int(round(img.height * scale)))
    resized = img.convert("RGB").resize((w, h), Image.LANCZOS)
    left = (w - width) // 2
    top = (h - height) // 2
    return resized.crop((left, top, left + width, top + height))


def _dim_vertical(img, top_mul, bottom_mul):
    """Multiply an image by a brightness ramp running top to bottom. This is what turns three
    flat texture bands into a corridor: the ceiling falls away into the dark, the wall lifts
    toward the floor line, and the floor is brightest right where the hero is standing."""
    if img is None:
        return None
    arr = np.asarray(img, dtype=np.float32)
    ramp = np.linspace(top_mul, bottom_mul, arr.shape[0], dtype=np.float32).reshape(-1, 1, 1)
    return Image.fromarray(np.clip(arr * ramp, 0, 255).astype(np.uint8))


def _vignette(img, strength=0.85):
    """Darken toward the edges, centred a little above the middle of the card - the same
    one-lantern falloff the dungeon view has, and what keeps a tile's hero reading as lit
    rather than pasted onto wallpaper."""
    arr = np.asarray(img, dtype=np.float32)
    h, w = arr.shape[0], arr.shape[1]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = (xx - w * 0.5) / (w * 0.5)
    dy = (yy - h * 0.52) / (h * 0.62)
    dist = np.sqrt(dx * dx + dy * dy)
    # Flat across the lit middle, then falling away - so the light pools around the hero
    # rather than shading the whole picture down evenly.
    mul = np.clip(1.0 - strength * np.clip(dist - 0.42, 0, None) ** 1.5, 0.15, 1.0)
    return Image.fromarray(np.clip(arr * mul[..., None], 0, 255).astype(np.uint8))


def _opaque_box(img, threshold=14):
    """The bounding box of everything solid enough to count as the character. The same alpha>14
    cut drawTrimmedSprite uses in game.js, so a card frames the hero the way the battle canvas
    does instead of including whatever transparent margin the generator baked into the frame."""
    alpha = np.asarray(img.split()[-1])
    rows = np.nonzero(alpha.max(axis=1) > threshold)[0]
    cols = np.nonzero(alpha.max(axis=0) > threshold)[0]
    if not len(rows) or not len(cols):
        return None
    return (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)


def _floor_shadow(card, cx, feet_y, radius_x, radius_y=8.0):
    """A soft dark ellipse where the hero meets the floor. Without it the sprite floats: it was
    cut out of a white background, so nothing else in the picture says its feet are touching
    anything."""
    arr = np.asarray(card, dtype=np.float32)
    h, w = arr.shape[0], arr.shape[1]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = (xx - cx) / max(1.0, radius_x)
    dy = (yy - feet_y) / max(1.0, radius_y)
    dist = np.sqrt(dx * dx + dy * dy)
    mul = np.clip(0.42 + 0.58 * np.clip(dist, 0, 1) ** 0.8, 0, 1)
    return Image.fromarray(np.clip(arr * mul[..., None], 0, 255).astype(np.uint8))


def _session_card(bundle):
    """The tile picture for one saved run as PNG bytes, or None if the bundle has nothing
    drawable in it. Never raises - a card is decoration, and a run without one still lists,
    replays and deletes."""
    if not bundle:
        return None
    try:
        wall = _bundle_image(bundle, "wall_texture")
        ceiling = _bundle_image(bundle, "ceiling_texture") or wall
        floor = _bundle_image(bundle, "floor_texture") or wall
        # Frame 0 of the sheet is the idle stance - what the hero stands in when they are
        # neither swinging, blocking nor hurt. player_sprite is the single-frame fallback for
        # bundles made before the sheet existed.
        hero = _bundle_image(bundle, "player_sprites", 0) or _bundle_image(bundle, "player_sprite")
        if wall is None and hero is None:
            return None

        card = Image.new("RGB", (CARD_W, CARD_H), (14, 14, 18))
        ceil_h = int(round(CARD_H * CARD_CEILING_SPAN))
        horizon = int(round(CARD_H * CARD_HORIZON))

        band = _dim_vertical(_cover(ceiling, CARD_W, ceil_h), 0.18, 0.52)
        if band is not None:
            card.paste(band, (0, 0))
        band = _dim_vertical(_cover(wall, CARD_W, horizon - ceil_h), 0.55, 1.0)
        if band is not None:
            card.paste(band, (0, ceil_h))
        band = _dim_vertical(_cover(floor, CARD_W, CARD_H - horizon), 0.95, 0.42)
        if band is not None:
            card.paste(band, (0, horizon))
        card = _vignette(card)

        if hero is not None:
            box = _opaque_box(hero)
            cropped = hero.crop(box) if box else hero
            target_h = int(round(CARD_H * CARD_HERO_SPAN))
            target_w = max(1, int(round(target_h * cropped.width / cropped.height)))
            # A wide pose - arms out, a long weapon - would otherwise run off both sides of a
            # tile this narrow. Give back height rather than crop the hero.
            max_w = int(round(CARD_W * 0.78))
            if target_w > max_w:
                target_h = max(1, int(round(target_h * max_w / target_w)))
                target_w = max_w
            cropped = cropped.resize((target_w, target_h), Image.LANCZOS)
            # Feet just past the bottom edge, the same plant drawOverTheShoulderPlayer gives
            # them, so a tile reads as a crop of the battle view rather than a portrait
            # floating in one.
            feet_y = CARD_H - 2
            left = (CARD_W - target_w) // 2
            card = _floor_shadow(card, CARD_W / 2, feet_y - 3, target_w * 0.45)
            card.paste(cropped, (left, feet_y - target_h), cropped)

        buf = io.BytesIO()
        card.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        print(f"[history] card render failed ({e})")
        return None


def _write_session_card(folder, bundle):
    """Render a run's card into its folder. Returns the path, or None if there was nothing to
    draw (or the write failed - again, never fatal)."""
    png = _session_card(bundle)
    if not png:
        return None
    path = os.path.join(folder, CARD_FILENAME)
    try:
        with open(path, "wb") as f:
            f.write(png)
        return path
    except Exception as e:
        print(f"[history] card not saved ({e})")
        return None


# Drawing a card for a run that has none means reading its whole 16MB bundle.json back in -
# about 0.7s. This server answers one request at a time (see run_server), so a grid of thirty
# tiles asking for thirty of those in a row would hold the socket for half a minute, and the
# star and the trash can behind them would feel dead while it did. The lock keeps the backfill
# thread and a request from drawing the same run twice.
_card_lock = threading.Lock()
_card_backfill_thread = None


def ensure_session_card(session_id):
    """The path to a run's card, drawing it first if it has none. Every run saved before tiles
    existed comes through here once; the cost is opening its bundle.json, which is why the
    result is written down rather than re-rendered per request. None when the run is gone or
    has nothing drawable in it."""
    folder = _session_dir(session_id)
    if not folder or not os.path.isdir(folder):
        return None
    path = os.path.join(folder, CARD_FILENAME)
    if os.path.exists(path):
        return path
    bundle_path = os.path.join(folder, "bundle.json")
    if not os.path.exists(bundle_path):
        return None
    with _card_lock:
        # The backfill may have drawn it while this request waited for the lock.
        if os.path.exists(path):
            return path
        try:
            with open(bundle_path, encoding="utf-8") as f:
                bundle = json.load(f)
        except Exception as e:
            print(f"[history] card needs {session_id}'s bundle, which would not open ({e})")
            return None
        return _write_session_card(folder, bundle)


def start_card_backfill():
    """Draw the cards for every saved run that has none, off the request thread. Kicked when
    the History listing is fetched - by then the page is about to ask for the pictures anyway,
    and one worker doing them in a row beats thirty requests each waiting out its own render.
    Does nothing if a backfill is already going; returns at once either way."""
    global _card_backfill_thread
    if _card_backfill_thread is not None and _card_backfill_thread.is_alive():
        return

    def work():
        missing = [s["id"] for s in list_dungeon_sessions()
                   if not os.path.exists(os.path.join(SESSIONS_DIR, s["id"], CARD_FILENAME))]
        if not missing:
            return
        print(f"[history] drawing tile cards for {len(missing)} saved run(s)")
        for session_id in missing:
            ensure_session_card(session_id)
            # PIL and numpy drop the GIL for the heavy work, but reading the bundle back in
            # does not - hand the socket a gap between runs so the page stays answerable.
            time.sleep(0.05)
        print("[history] tile cards done")

    _card_backfill_thread = threading.Thread(target=work, name="card-backfill", daemon=True)
    _card_backfill_thread.start()


def save_dungeon_session(bundle, wall_style, player_style, weapon_style, enemy_style,
                         sound_mode="music_and_sound", ending_video_path=None):
    """Persist a finished bundle under dungeon_sessions/. Returns the new id, or None if
    anything went wrong - a history save must never turn a good run into a failed one.
    `ending_video_path` is the cutscene render_ending_video filmed during the run, if any; it
    is copied in beside the bundle as ENDING_FILENAME."""
    if not bundle:
        return None
    session_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    folder = os.path.join(SESSIONS_DIR, session_id)
    try:
        os.makedirs(folder, exist_ok=True)
        bundle_path = os.path.join(folder, "bundle.json")
        with open(bundle_path, "w", encoding="utf-8") as f:
            json.dump(bundle, f, ensure_ascii=True)
        # History's tile view draws this run as its hero standing in its own corridor. Built
        # here while the bundle is already in memory; ensure_session_card is the lazy path
        # every run saved before tiles existed takes instead, at the cost of reading the 16MB
        # file back off disk.
        _write_session_card(folder, bundle)
        has_ending = False
        if ending_video_path:
            try:
                shutil.copyfile(ending_video_path, os.path.join(folder, ENDING_FILENAME))
                has_ending = True
            except Exception as e:
                # The run is still worth keeping - it just ends at the stairs.
                print(f"[history] ending cutscene not saved with the run ({e})")

        story = bundle.get("story") or {}
        meta = {
            "id": session_id,
            "created": time.time(),
            # "Sep 8, 2026 9:05 AM" - strftime zero-pads the day and the hour, and the
            # trailing " 0" -> " " strips both without needing platform-specific %-d/%-I
            # (which Windows does not support).
            "created_text": time.strftime("%b %d, %Y %I:%M %p").replace(" 0", " "),
            "mode": bundle.get("mode", "v6_krea"),
            # Which "Graphics Quality" tier these assets were rendered at. `quality` is the
            # raw dropdown key; `quality_text` is what the History window shows. Older
            # sessions saved before this was recorded have neither.
            "quality": bundle.get("graphics_quality", ""),
            "quality_text": GFX_QUALITY_LABELS.get(bundle.get("graphics_quality", ""), ""),
            # 2 = made with the Last Attack Frame option on. strike_frames names the foes that
            # really came out of generation holding one, since the quality gate can drop a pose
            # frame - so a version 2 run whose boss lost its strike frame says so in History.
            # Sessions saved before this existed have neither key; list_dungeon_sessions reads
            # a missing frame_version as 1.
            "frame_version": bundle.get("frame_version", FRAME_VERSION_BASE),
            "strike_frames": [v for v, fr in (bundle.get("enemy_variants") or {}).items()
                              if isinstance(fr, dict) and fr.get(ENEMY_STRIKE_FRAME)],
            "wall_style": wall_style or "",
            "player_style": (player_style or "").strip(),
            "weapon_style": (weapon_style or "").strip(),
            "enemy_style": (enemy_style or "").strip(),
            # The concrete material/object descriptions the set designer resolved the typed
            # words into (generate_theme_brief), or None when a hand-tuned keyword bucket
            # covered the theme and no design pass was needed. Sessions saved before this
            # existed have neither key.
            "theme_brief": bundle.get("theme_brief"),
            # What each quoted proper name resolved to, or None. Sessions saved before this
            # existed have neither key, same convention as theme_brief above.
            "named_styles": bundle.get("named_styles"),
            "location": story.get("location", ""),
            "hero": story.get("hero", ""),
            "foe": story.get("foe", ""),
            "boss": story.get("boss", ""),
            "hook": story.get("hook", ""),
            "sound_mode": sound_mode,
            "has_music": bool(bundle.get("music")),
            "has_sfx": bool(bundle.get("sfx")),
            "has_narration": bool(story.get("audio")),
            # An ending cutscene sits beside the bundle (Options > Ending Video). A background
            # render finishing later flips this through _store_session_ending, and the listing
            # reads the file itself anyway.
            "has_ending_video": has_ending,
            "size": os.path.getsize(bundle_path),
            "thumb": _session_thumb(bundle),
            # The History star - a favorite cannot be deleted (delete_dungeon_session). Sessions
            # saved before this existed have no key and read as not starred.
            "favorite": False,
        }
        with open(os.path.join(folder, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=True)
        print(f"[history] saved {session_id} ({meta['size'] / 1048576:.1f} MB)")
        return session_id
    except Exception as e:
        print(f"[history] could not save this run ({e})")
        # A half-written folder would show up in the list as a broken row - drop it.
        try:
            shutil.rmtree(folder, ignore_errors=True)
        except Exception:
            pass
        return None


def list_dungeon_sessions():
    """Every saved session's meta record, newest first. A folder whose meta.json is missing
    or unreadable (an interrupted save, a half-finished delete) is skipped rather than
    breaking the whole listing."""
    out = []
    try:
        names = os.listdir(SESSIONS_DIR)
    except Exception:
        return out
    for name in names:
        if not _SESSION_ID_RE.match(name):
            continue
        meta_path = os.path.join(SESSIONS_DIR, name, "meta.json")
        if not os.path.exists(os.path.join(SESSIONS_DIR, name, "bundle.json")):
            continue
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
            meta["id"] = name          # the folder is the truth, whatever the file says
            # Every run saved before the Last Attack Frame option existed is frame version 1.
            meta.setdefault("frame_version", FRAME_VERSION_BASE)
            # Same rule for the cutscene: the file on disk decides, so a meta.json that missed a
            # background render's update (or predates the option) still lists what is there.
            meta["has_ending_video"] = os.path.exists(os.path.join(SESSIONS_DIR, name, ENDING_FILENAME))
            # Runs saved before "beaten" was recorded have never been beaten as far as anyone knows.
            meta["beaten"] = bool(meta.get("beaten"))
            out.append(meta)
        except Exception as e:
            print(f"[history] skipping {name} ({e})")
    out.sort(key=lambda m: m.get("created", 0), reverse=True)
    return out


class SessionLocked(Exception):
    """A delete aimed at a favorited session. The star in the History window is the lock, and
    it is enforced here rather than only by greying out the trash can, so no request - a stale
    page, the quit menu's Erase Current Run - can get round it."""


def _read_session_meta(folder):
    with open(os.path.join(folder, "meta.json"), encoding="utf-8") as f:
        return json.load(f)


# Held around every read-modify-write of a meta.json. The HTTP handler is single-threaded, but a
# background ending render stores its clip (and flips has_ending_video) from its own thread, and
# without this a star or a "beaten" landing in the same instant could be written over.
_META_LOCK = threading.Lock()


def _update_session_meta(folder, changes):
    """Merge `changes` into a session's meta.json and return the result. Written through a temp
    file and os.replace, because a half-written meta.json would make list_dungeon_sessions drop
    the row entirely."""
    with _META_LOCK:
        meta = _read_session_meta(folder)
        meta.update(changes)
        tmp_path = os.path.join(folder, "meta.json.tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=True)
        os.replace(tmp_path, os.path.join(folder, "meta.json"))
        return meta


def set_dungeon_session_favorite(session_id, favorite):
    """Star or unstar one saved dungeon. Returns the flag as written, or None if the session
    is not there."""
    folder = _session_dir(session_id)
    if not folder or not os.path.isdir(folder):
        return None
    meta = _update_session_meta(folder, {"favorite": bool(favorite)})
    print(f"[history] {'favorited' if meta['favorite'] else 'unfavorited'} {session_id}")
    return meta["favorite"]


def mark_dungeon_session_beaten(session_id):
    """Record that the player has beaten this dungeon - its boss is down. It is what unlocks the
    run's ending movie in the History window (a spoiler until then), and it never un-sets: a later
    replay that dies does not un-beat it. Returns True if recorded (or already was), None if the
    session is not there. Sessions saved before this existed have no key and read as not beaten."""
    folder = _session_dir(session_id)
    if not folder or not os.path.isdir(folder):
        return None
    if _read_session_meta(folder).get("beaten"):
        return True
    _update_session_meta(folder, {"beaten": True, "beaten_at": time.time()})
    print(f"[history] beaten {session_id}")
    return True


def delete_dungeon_session(session_id):
    """Erase one saved dungeon - bundle, thumbnail, metadata and folder. True if it was
    there to remove. Raises SessionLocked for a favorite; an unreadable meta.json does not
    count as one, so a broken folder can still be cleared out."""
    folder = _session_dir(session_id)
    if not folder or not os.path.isdir(folder):
        return False
    try:
        locked = bool(_read_session_meta(folder).get("favorite"))
    except Exception:
        locked = False
    if locked:
        raise SessionLocked("That dungeon is a favorite. Unstar it in History before deleting it.")
    # A background render still filming this run would otherwise finish into a folder that no
    # longer exists.
    cancel_ending_video_job("its dungeon was deleted", session_id=session_id)
    shutil.rmtree(folder)
    print(f"[history] deleted {session_id}")
    return True


# ---------------------------------------------------------------------------
# Ending cutscene: MiniMax H3 films the boss going down (Options > Ending Video)
# ---------------------------------------------------------------------------
# One short clip per run. game.js plays it in the viewport the moment the boss's health hits
# zero and raises the victory box over its held last frame. H3's ref2va weights take the run's
# own art as reference pictures - the hero's battle sprite and HUD portrait, the boss, the wall /
# floor / ceiling textures - plus its battle bed as a reference audio, and render picture and
# soundtrack together in one pass (the `va` is video+audio). So the cutscene is scored in the
# dungeon's own theme with no separate audio job - the one thing H3's audio head is actually
# built for, unlike the isolated one-shots in the sfx pack above.
#
# Off by default. With Ending Video on, Options picks one of two ways to pay for it:
#   "loading"    - one more planned stage at the end of run_batch_v6_krea, so ENTER arms with the
#                  clip already on disk. The loading screen gets the whole render added to it.
#   "background" - (experimental) the run is saved without it, and a worker renders it while the
#                  player is already walking the maze. game.js polls for it and plays the plain
#                  stairs ending if the boss falls before it is done.
# Either way the clip lives next to the run as dungeon_sessions/<id>/ending.mp4 - never inside
# bundle.json, which is one base64 JSON blob the page parses whole.
#
# The graph is the user's own "H3 reference sage rtx" ComfyUI workflow (the Comfy-Org r2v
# template plus KJNodes sage attention), minus its RTX 2x upscale: the clip is drawn into the 4:3
# viewport, which is about 1050px wide even in a fullscreen 1080p window.
ENDING_UNET = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
ENDING_CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
ENDING_VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
ENDING_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"
ENDING_STEPS = 20
ENDING_SAMPLER = "res_multistep"
ENDING_SCHEDULER = "simple"
ENDING_FPS = 24
# H3 only renders lengths on its 17k+5 frame grid at 24 fps (see align_frame_count in
# comfy_extras/nodes_minimax_h3.py); 192 frames is exactly 8.0s - room for the three beats the
# prompt asks for: the blow, the fall, the cheer.
ENDING_FRAMES = 192
# 4:3 to match the viewport, every side a multiple of 32 as H3's canvas needs. One size whatever
# the Graphics tier: all three of 768x576 / 640x480 / 512x384 were filmed and compared, and the
# user settled on the smallest (2026-09-15) - it films in about a third of the largest's time and
# still holds up in the viewport.
ENDING_WIDTH, ENDING_HEIGHT = 512, 384
# How much of the 30s battle bed goes in as <Audio 1>. Reference tokens ride along every
# sampling step, and ten seconds already carries the instruments and the tempo.
ENDING_REF_AUDIO_SEC = 10.0
ENDING_FILENAME = "ending.mp4"
# Generous: a cold start has to load a 20GB DiT and a 15GB text encoder before the first step.
ENDING_TIMEOUT = 45 * 60
# _plan_v6 weight for the "loading" mode's stage, on the same rough wall-clock scale as the rest of
# the plan (the krea2 frames job is weight 80 for ~100-170s). Measured on the 3090, sage attention
# on, 8.0s clip with all six pictures + the battle bed: 512x384 took 198s as the last stage of a
# real run. For comparison, 640x480 ran 14.9s a step (354s) and 768x576 24.7s a step (570s cold).
ENDING_PLAN_WEIGHT = 120


def ending_video_prompt(pictures, styles, has_audio):
    """The H3 prompt. `pictures` lists which reference kinds were actually attached, in
    connection order - any of hero / face / boss / wall / floor / ceiling - because ref2va
    numbers them <Picture 1>, <Picture 2>... in exactly that order and the prompt must name
    each by its real tag ("be explicit about which reference drives which part of the shot",
    per the Comfy-Org template notes). `styles` is the run's clean typed words."""
    player = (styles.get("player") or "").strip() or "armored warrior"
    weapon = (styles.get("weapon") or "").strip() or "sword"
    enemy = (styles.get("enemy") or "").strip() or "monster"
    tag = {kind: f"<Picture {i + 1}>" for i, kind in enumerate(pictures)}

    parts = [
        "The ending cutscene of a fantasy role-playing video game, staged and edited like a "
        "late-1990s JRPG pre-rendered cinematic: bold dramatic camera angles, hard cuts between "
        "shots, a slow-motion finishing blow, bright flashes of light on impact, rich saturated "
        "lighting."
    ]
    refs = []
    if "hero" in tag:
        refs.append(f"{tag['hero']} is the hero, {_a_or_an(player)} holding {_a_or_an(weapon)}, "
                    "seen from behind the way the player sees them in battle. Keep this exact "
                    "character - body, clothes, colours and weapon - in every shot and from "
                    "every angle.")
    else:
        refs.append(f"The hero is {_a_or_an(player)} holding {_a_or_an(weapon)}.")
    if "face" in tag:
        refs.append(f"{tag['face']} is the same hero's face. Every shot that shows the hero from "
                    "the front shows exactly this face.")
    if "boss" in tag:
        refs.append(f"{tag['boss']} is the boss, {_a_or_an(enemy)}: the final opponent, towering "
                    "over the hero. Keep its exact shape, colours and details in every shot.")
    else:
        refs.append(f"The boss is a huge {enemy}, the final opponent, towering over the hero.")
    surfaces = [f"{tag[k]} is its {k}" if k != "wall" else f"{tag[k]} is its walls"
                for k in ("wall", "floor", "ceiling") if k in tag]
    if surfaces:
        refs.append("The whole scene takes place in one long dungeon corridor built from exactly "
                    "these surfaces: " + ", ".join(surfaces) + ".")
    if has_audio:
        refs.append("<Audio 1> is this dungeon's battle music. The soundtrack is that same battle "
                    "theme - the same instruments, tempo and sound - swelling into a triumphant "
                    "victory fanfare.")
    parts.append(" ".join(refs))
    parts.append(
        "The hero and the boss face off in the corridor. Far down the corridor behind the boss, "
        "a staircase climbs up and out of the dungeon, glowing with warm daylight: the way out."
    )
    parts.append(
        f"[0s-3s] Shot 1: a low-angle close-up. The hero lunges and lands the final blow on the "
        f"boss with the {weapon}, in slow motion, with a blinding white flash and a burst of "
        f"sparks on impact.\n"
        f"[3s-5s] Shot 2: the boss reels back, glowing cracks of light split across it, and it "
        f"collapses and bursts apart into embers that drift away.\n"
        f"[5s-8s] Shot 3: a wide shot down the now empty corridor, daylight from the staircase in "
        f"the distance pouring down the hallway. The camera pushes in as the hero turns toward it "
        f"and cheers, thrusting the {weapon} high overhead in a joyful victory pose, and holds "
        f"that pose to the end."
    )
    parts.append(
        ("Audio: the battle theme from <Audio 1> rising into a victory fanfare, "
         if has_audio else "Audio: an epic orchestral battle theme rising into a victory fanfare, ")
        + "the heavy impact of the final blow, the boss's last cry as it falls apart, and the "
        "hero's wordless triumphant cheer."
    )
    parts.append("No subtitles, captions, logos, interface or on-screen text.")
    return "\n\n".join(parts)


def _ending_open_image(src):
    """A file path or a data URL -> PIL image."""
    if src.startswith("data:"):
        return Image.open(io.BytesIO(base64.b64decode(src.split(",", 1)[1])))
    return Image.open(src)


def _ending_ref_image(src, name):
    """Write one reference picture into COMFY_INPUT_DIR and return its filename, or None.
    The sprites are RGBA cutouts and LoadImage keeps only RGB - whatever colour the transparent
    pixels happen to hold would come through as a background - so everything is flattened onto
    plain white first, the way a character reference sheet looks."""
    if not src:
        return None
    img = _ending_open_image(src).convert("RGBA")
    flat = Image.new("RGBA", img.size, (255, 255, 255, 255))
    flat.alpha_composite(img)
    flat.convert("RGB").save(os.path.join(COMFY_INPUT_DIR, name), format="PNG")
    return name


def _ending_ref_audio(src, name):
    """The battle bed (a data:audio/wav URL, see _finish_music) cut to ENDING_REF_AUDIO_SEC and
    written into COMFY_INPUT_DIR. Returns its filename, or None when the run has no music."""
    if not src:
        return None
    raw = base64.b64decode(src.split(",", 1)[1])
    with wave.open(io.BytesIO(raw), "rb") as wf:
        rate, channels, width = wf.getframerate(), wf.getnchannels(), wf.getsampwidth()
        frames = wf.readframes(min(wf.getnframes(), int(rate * ENDING_REF_AUDIO_SEC)))
    with wave.open(os.path.join(COMFY_INPUT_DIR, name), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(width)
        out.setframerate(rate)
        out.writeframes(frames)
    return name


def _ending_refs_from_bundle(b):
    """The reference sources a saved bundle carries - the same six render_ending_video takes
    straight from file paths during a run, as data URLs here."""
    ev = b.get("enemy_variants") or {}
    boss = ev.get("boss") or ev.get("walker") or {}
    if isinstance(boss, str):            # a bundle from before foes had pose frames
        boss = {"idle": boss}
    sprites = b.get("player_sprites") or []
    faces = b.get("player_faces") or []
    hero = sprites[0] if sprites else b.get("player_sprite")
    face = faces[0] if faces else b.get("player_face")
    return {"hero": hero,
            # A run whose portraits all failed ships the battle sprite as its "face" - the
            # hero's back - which must not go in labelled as a face.
            "face": face if face != hero else None,
            "boss": boss.get("idle"),
            "wall": b.get("wall_texture"),
            "floor": b.get("floor_texture"),
            "ceiling": b.get("ceiling_texture")}


_SAGE_NODE_PRESENT = None


def _sage_attention_available():
    """Whether ComfyUI has KJNodes' sage attention patch. Asked once per process: the user's H3
    workflows run through it, but a graph naming a node that is not installed fails validation
    outright, so it is only ever wired in when ComfyUI says it is there."""
    global _SAGE_NODE_PRESENT
    if _SAGE_NODE_PRESENT is None:
        try:
            with urllib.request.urlopen(f"{COMFY_URL}/object_info/PathchSageAttentionKJ",
                                        timeout=15) as resp:
                _SAGE_NODE_PRESENT = "PathchSageAttentionKJ" in json.loads(resp.read().decode("utf-8"))
        except Exception:
            return False                  # ask again next time rather than caching a hiccup
    return _SAGE_NODE_PRESENT


def ending_video_payload(image_names, audio_name, prompt, width, height, seed, sage=False):
    """The ComfyUI API graph for one ending clip. Reference inputs are Autogrow slots, so they
    are keyed in the API format by their dotted path (ref_images.ref_image_0 ...), and SaveVideo's
    format/codec pair is a nested DynamicCombo keyed the same way."""
    p = {
        "ending_unet": {"inputs": {"unet_name": ENDING_UNET, "weight_dtype": "default"},
                        "class_type": "UNETLoader"},
        "ending_clip": {"inputs": {"clip_name": ENDING_CLIP, "type": "minimax", "device": "default"},
                        "class_type": "CLIPLoader"},
        "ending_vae": {"inputs": {"vae_name": ENDING_VIDEO_VAE}, "class_type": "VAELoader"},
        "ending_avae": {"inputs": {"vae_name": ENDING_AUDIO_VAE}, "class_type": "VAELoader"},
    }
    model = ["ending_unet", 0]
    if sage:
        p["ending_sage"] = {"inputs": {"model": model, "sage_attention": "auto", "allow_compile": False},
                            "class_type": "PathchSageAttentionKJ"}
        model = ["ending_sage", 0]
    cond = {"clip": ["ending_clip", 0], "vae": ["ending_vae", 0], "audio_vae": ["ending_avae", 0],
            "prompt": prompt, "width": width, "height": height, "length": ENDING_FRAMES,
            "ref_image_size": "match"}
    for i, name in enumerate(image_names):
        p[f"ending_ref{i}"] = {"inputs": {"image": name}, "class_type": "LoadImage"}
        cond[f"ref_images.ref_image_{i}"] = [f"ending_ref{i}", 0]
    if audio_name:
        p["ending_music"] = {"inputs": {"audio": audio_name}, "class_type": "LoadAudio"}
        cond["ref_audios.ref_audio_0"] = ["ending_music", 0]
    p["ending_cond"] = {"inputs": cond, "class_type": "MiniMaxH3ReferenceToVideo"}
    p["ending_noise"] = {"inputs": {"noise_seed": seed}, "class_type": "RandomNoise"}
    p["ending_sampler"] = {"inputs": {"sampler_name": ENDING_SAMPLER}, "class_type": "KSamplerSelect"}
    p["ending_sigmas"] = {"inputs": {"model": ["ending_unet", 0], "scheduler": ENDING_SCHEDULER,
                                     "steps": ENDING_STEPS, "denoise": 1.0},
                          "class_type": "BasicScheduler"}
    p["ending_guider"] = {"inputs": {"model": model, "conditioning": ["ending_cond", 0]},
                          "class_type": "BasicGuider"}
    p["ending_samp"] = {"inputs": {"noise": ["ending_noise", 0], "guider": ["ending_guider", 0],
                                   "sampler": ["ending_sampler", 0], "sigmas": ["ending_sigmas", 0],
                                   "latent_image": ["ending_cond", 1]},
                        "class_type": "SamplerCustomAdvanced"}
    # The sampler's output is the packed video+audio latent; each decoder takes its own half.
    p["ending_dec"] = {"inputs": {"samples": ["ending_samp", 0], "vae": ["ending_vae", 0]},
                       "class_type": "VAEDecode"}
    p["ending_adec"] = {"inputs": {"samples": ["ending_samp", 0], "vae": ["ending_avae", 0]},
                        "class_type": "VAEDecodeAudio"}
    p["ending_mux"] = {"inputs": {"images": ["ending_dec", 0], "audio": ["ending_adec", 0],
                                  "fps": float(ENDING_FPS)},
                       "class_type": "CreateVideo"}
    p["ending_save"] = {"inputs": {"video": ["ending_mux", 0],
                                   "filename_prefix": "video/comfycrawler_ending",
                                   "format": "auto", "format.codec": "auto"},
                        "class_type": "SaveVideo"}
    return p


class EndingVideoCancelled(Exception):
    """A background ending render that something with a better claim on ComfyUI replaced."""


def _interrupt_prompt(prompt_id, deadline=30.0):
    """Get one prompt out of ComfyUI: delete it if it is still queued, interrupt it if it is
    running. Repeated until the queue no longer holds it, for the reason _drain_cancelled_prompts
    gives - an interrupt landing just before the prompt starts executing is forgotten."""
    started = time.time()
    while time.time() - started < deadline:
        try:
            with urllib.request.urlopen(f"{COMFY_URL}/queue", timeout=10) as resp:
                q = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print(f"[ending] queue read failed while interrupting ({e})")
            return
        running = any(len(e) > 1 and e[1] == prompt_id for e in q.get("queue_running", []))
        pending = any(len(e) > 1 and e[1] == prompt_id for e in q.get("queue_pending", []))
        if not running and not pending:
            return
        try:
            if pending:
                _comfy_post("/queue", {"delete": [prompt_id]})
            if running:
                _comfy_post("/interrupt", {"prompt_id": prompt_id})
        except Exception as e:
            print(f"[ending] interrupt failed ({e})")
        time.sleep(0.5)


def _ending_submit_and_wait(payload, job_key=None, job=None):
    """Submit the clip and wait for SaveVideo. Unlike _krea2_submit_and_collect this one reads a
    failure straight out of /history (an H3 out-of-memory would otherwise sit out the whole
    45-minute timeout), and it takes the prompt back out of ComfyUI on any way out that is not
    success.

    In a run (`job` None) the prompt is tracked like every other, so a page refreshed mid-render
    drains it with the rest of the run. A background `job` is deliberately NOT in
    _INFLIGHT_PROMPTS - that list belongs to the dungeon being generated - and is stopped through
    its own `cancelled` flag instead."""
    _bail_if_cancelled()
    PROGRESS.begin_job(job_key)
    data = json.dumps({"prompt": payload, "client_id": COMFY_CLIENT_ID}).encode("utf-8")
    req = urllib.request.Request(f"{COMFY_URL}/prompt", data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            prompt_id = json.loads(resp.read().decode("utf-8"))["prompt_id"]
    except urllib.error.HTTPError as e:
        # 400 = the graph failed validation (a model file missing, a node not installed) - say
        # what ComfyUI said instead of a bare "Bad Request".
        detail = e.read().decode("utf-8", "replace")[:600]
        raise RuntimeError(f"ComfyUI refused the ending graph: {detail}")
    if job is None:
        _track_prompt(prompt_id)
    else:
        job["prompt_id"] = prompt_id

    finished = False
    try:
        started = time.time()
        while time.time() - started < ENDING_TIMEOUT:
            time.sleep(1.0)
            _bail_if_cancelled()
            if job is not None and job.get("cancelled"):
                raise EndingVideoCancelled("stopped or replaced")
            with urllib.request.urlopen(f"{COMFY_URL}/history/{prompt_id}", timeout=30) as h:
                entry = json.loads(h.read().decode("utf-8")).get(prompt_id)
            if not entry:
                continue                  # history only gains the entry once the prompt is done
            finished = True
            saved = (entry.get("outputs") or {}).get("ending_save") or {}
            files = saved.get("images") or []
            if files:
                PROGRESS.finish_job(job_key)
                info = files[0]
                return os.path.join(COMFY_OUTPUT_DIR, info.get("subfolder", ""), info["filename"])
            status = entry.get("status") or {}
            why = status.get("status_str") or "no video came out"
            for kind, msg in status.get("messages") or []:
                if kind == "execution_error":
                    why = f"{msg.get('node_type')}: {msg.get('exception_message', '').strip()}"
                elif kind == "execution_interrupted":
                    # Nothing of ours interrupted it (that path raises before it gets here), so it
                    # was stopped from ComfyUI's own queue - a choice, not a failure.
                    raise EndingVideoCancelled("stopped from ComfyUI")
            raise RuntimeError(f"H3 did not produce the ending ({why})")
        raise TimeoutError(f"the ending took longer than {ENDING_TIMEOUT // 60} minutes")
    finally:
        if not finished:
            _interrupt_prompt(prompt_id)


def render_ending_video(refs, battle_music, styles, job_key=None, job=None, seed=None):
    """Film one ending clip. `refs` maps hero / face / boss / wall / floor / ceiling to a file path
    or a data URL (any may be None - a missing one is simply left out of the prompt and the
    graph), `battle_music` is the run's battle bed as a data URL or None. Returns the MP4's path
    in COMFY_OUTPUT_DIR; raises on failure - callers decide what a failure costs."""
    tag = f"ending_{int(time.time() * 1000)}"
    pictures, names = [], []
    for kind in ("hero", "face", "boss", "wall", "floor", "ceiling"):
        try:
            name = _ending_ref_image(refs.get(kind), f"{tag}_{kind}.png")
        except Exception as e:
            print(f"[ending] {kind} reference unusable ({e}) - leaving it out")
            name = None
        if name:
            pictures.append(kind)
            names.append(name)
    try:
        audio_name = _ending_ref_audio(battle_music, f"{tag}_battle.wav")
    except Exception as e:
        print(f"[ending] battle music unusable as a reference ({e}) - leaving it out")
        audio_name = None
    width, height = ENDING_WIDTH, ENDING_HEIGHT
    prompt = ending_video_prompt(pictures, styles, bool(audio_name))
    payload = ending_video_payload(names, audio_name, prompt, width, height,
                                   seed if seed is not None else random.randint(1, 2**48),
                                   sage=_sage_attention_available())
    t0 = time.time()
    print(f"[ending] filming {width}x{height}, {ENDING_FRAMES / ENDING_FPS:.1f}s, refs "
          f"{'/'.join(pictures) or 'none'}{' + battle music' if audio_name else ''}")
    path = _ending_submit_and_wait(payload, job_key=job_key, job=job)
    print(f"[ending] clip ready in {time.time() - t0:.0f}s: {path}")
    return path


def generate_ending_video(refs, battle_music, styles, job_key="ending_video"):
    """The "loading" mode's stage inside run_batch_v6_krea. Never fails the run: a dungeon with
    no cutscene just ends at the stairs, as every dungeon did before. Only an abandoned run
    unwinds through here."""
    try:
        return render_ending_video(refs, battle_music, styles, job_key=job_key)
    except GenerationCancelled:
        raise
    except Exception as e:
        print(f"[ending] no ending cutscene for this run ({e})")
        PROGRESS.finish_job(job_key)
        return None


# ---- Renders outside a run: background mode, and History's movie button ------------------------
# At most one at a time, of two kinds:
#   background - started for the run being played (Render Ending While Playing, or a History
#                replay with no clip yet). Anything else that needs ComfyUI - a new dungeon, the
#                Fill-in button, a replay of a different run - replaces it: the player has moved
#                on from the run it was for, and nothing should queue behind a multi-minute job.
#   manual     - the player asked for this one by name, with a History row's movie button. It
#                replaces a background render, but nothing replaces it: until it is done the
#                page greys out CREATE, Fill-in and the other rows' movie buttons, and the server
#                refuses those same requests (409) and answers a background request with "busy".
_ENDING_LOCK = threading.Lock()
_ENDING_JOB = None


def _ending_session_file(session_id):
    folder = _session_dir(session_id)
    return os.path.join(folder, ENDING_FILENAME) if folder else None


def _ending_job_view(job):
    return {"state": job["state"], "percent": job["percent"], "error": job.get("error")}


def ending_video_rendering():
    """True while an ending render outside a run holds (or is about to hold) ComfyUI."""
    job = _ENDING_JOB
    return bool(job and job["state"] in ("queued", "rendering"))


def ending_video_manual_rendering():
    """True while a render the player asked for from History is filming - see the note above."""
    job = _ENDING_JOB
    return bool(job and job.get("manual") and job["state"] in ("queued", "rendering"))


def ending_video_job_view():
    """The one render outside a run, for a page that wants to know what ComfyUI is busy with:
    {session, state, percent, error, manual}, or {state: "idle"} when there has not been one. A
    finished job keeps reporting its last state, so a page that polls slowly still sees how it
    ended."""
    job = _ENDING_JOB
    if not job:
        return {"state": "idle", "session": None, "percent": 0, "error": None, "manual": False}
    return dict(_ending_job_view(job), session=job["session"], manual=bool(job.get("manual")))


def ending_video_status(session_id):
    """{state: none | queued | rendering | ready | failed | cancelled | missing, percent, error}.
    A clip on disk is "ready" whatever any job says - the folder is the truth, the same as for
    the listing."""
    path = _ending_session_file(session_id)
    if not path or not os.path.isdir(os.path.dirname(path)):
        return {"state": "missing", "percent": 0, "error": "That saved dungeon is gone."}
    if os.path.exists(path):
        return {"state": "ready", "percent": 100, "error": None}
    with _ENDING_LOCK:
        job = _ENDING_JOB
        if job and job["session"] == session_id:
            return _ending_job_view(job)
    return {"state": "none", "percent": 0, "error": None}


def start_ending_video_job(session_id, from_run=False, manual=False):
    """Start filming a saved run's ending outside a run. Idempotent for the run it is already
    filming - and asking by name (`manual`) for a run whose background render is already going
    just promotes that render to manual. Refused ("busy") while a dungeon is generating unless
    `from_run` - run_batch_v6_krea calls it as its very last step, when nothing of the run's own
    is left to queue behind it - and refused while a manual render for another run is filming."""
    global _ENDING_JOB
    path = _ending_session_file(session_id)
    folder = os.path.dirname(path) if path else None
    if not folder or not os.path.exists(os.path.join(folder, "bundle.json")):
        return {"state": "missing", "percent": 0, "error": "That saved dungeon is gone."}
    if os.path.exists(path):
        return {"state": "ready", "percent": 100, "error": None}
    with _ENDING_LOCK:
        job = _ENDING_JOB
        if job and job["session"] == session_id and job["state"] in ("queued", "rendering"):
            if manual:
                job["manual"] = True
            return _ending_job_view(job)
    if not from_run and (gen_progress.get("is_generating") or run_is_settling()):
        return {"state": "busy", "percent": 0, "error": None}
    if ending_video_manual_rendering():
        return {"state": "busy", "percent": 0, "error": None}
    # Only now, past every answer that needs no ComfyUI (a clip already filmed, a busy card): a
    # History movie button can be the first thing that talks to ComfyUI after a restart.
    try:
        ensure_comfy()
    except ComfyUnavailable as e:
        return {"state": "failed", "percent": 0, "error": str(e)}
    cancel_ending_video_job(f"replaced by {session_id}")
    job = {"session": session_id, "state": "queued", "percent": 0, "error": None,
           "prompt_id": None, "cancelled": False, "manual": bool(manual)}
    with _ENDING_LOCK:
        _ENDING_JOB = job
    threading.Thread(target=_run_ending_video_job, args=(job,), daemon=True).start()
    return _ending_job_view(job)


def cancel_ending_video_job(reason, session_id=None):
    """Stop the background render - only the one for `session_id`, when given. True if there was
    one to stop. Returns straight away; the worker takes its prompt back out of ComfyUI."""
    with _ENDING_LOCK:
        job = _ENDING_JOB
        if not job or job["state"] not in ("queued", "rendering"):
            return False
        if session_id is not None and job["session"] != session_id:
            return False
        job["cancelled"] = True
        # Reported as cancelled from this instant, not once the worker has unwound: ComfyUI only
        # notices an interrupt between sampling steps, and nothing that greyed out for this render
        # should stay grey that long after the player said stop. The worker writes the same state
        # again when it gets there.
        job["state"] = "cancelled"
        pid = job.get("prompt_id")
    print(f"[ending] stopping the {'manual' if job.get('manual') else 'background'} render for "
          f"{job['session']} - {reason}")
    if pid:
        # Not left to the worker alone: it only notices the flag on its next poll, and whatever
        # replaced it wants the card now.
        threading.Thread(target=_interrupt_prompt, args=(pid,), daemon=True).start()
    return True


def _store_session_ending(session_id, src_path):
    """Move a finished clip in beside its run and mark the run as having one. Both writes go
    through a temp file and os.replace, so a crash mid-copy never leaves a truncated ending.mp4
    the page would try to play."""
    dest = _ending_session_file(session_id)
    folder = os.path.dirname(dest) if dest else None
    if not folder or not os.path.isdir(folder):
        raise RuntimeError("its saved dungeon was deleted while the ending was filming")
    shutil.copyfile(src_path, dest + ".tmp")
    os.replace(dest + ".tmp", dest)
    try:
        _update_session_meta(folder, {"has_ending_video": True})
    except Exception as e:
        print(f"[ending] clip stored, but meta.json was not updated ({e})")


def _run_ending_video_job(job):
    sid = job["session"]
    try:
        folder = _session_dir(sid)
        with open(os.path.join(folder, "bundle.json"), encoding="utf-8") as f:
            bundle = json.load(f)
        # The clean typed words the run's own audio prompts used, falling back to the raw ones
        # on the meta for a bundle saved before named styles existed.
        styles = {}
        try:
            meta = _read_session_meta(folder)
            styles = {k: meta.get(f"{k}_style", "") for k in ("wall", "player", "weapon", "enemy")}
        except Exception:
            pass
        clean = (bundle.get("named_styles") or {}).get("clean")
        if isinstance(clean, dict):
            styles.update({k: v for k, v in clean.items() if v})
        if job["cancelled"]:
            raise EndingVideoCancelled("superseded before it started")
        job["state"] = "rendering"
        path = render_ending_video(_ending_refs_from_bundle(bundle),
                                   (bundle.get("music") or {}).get("battle"), styles, job=job)
        # Stopped in the last instant, between the clip landing and here: a stop is a stop, and the
        # page has already been told this render is cancelled.
        if job["cancelled"]:
            raise EndingVideoCancelled("stopped just as it finished")
        _store_session_ending(sid, path)
        job["percent"] = 100
        job["state"] = "ready"
        print(f"[ending] background ending stored for {sid}")
    except EndingVideoCancelled as e:
        job["state"] = "cancelled"
        print(f"[ending] render for {sid} stopped ({e})")
    except Exception as e:
        job["state"] = "cancelled" if job["cancelled"] else "failed"
        job["error"] = str(e)
        print(f"[ending] background render for {sid} {job['state']} ({e})")


def _ending_job_progress(data):
    """ProgressTracker hook: True (and the job's percent updated) when a socket message belongs to
    the background render, which is no part of any run's progress plan. Sampling is the long
    part, so it carries the percent; the last few points are the decode and the save."""
    job = _ENDING_JOB
    pid = data.get("prompt_id")
    if not job or not pid or job.get("prompt_id") != pid:
        return False
    node = (data.get("nodes") or {}).get("ending_samp")
    if node:
        try:
            mx = float(node.get("max") or 0.0)
            val = float(node.get("value") or 0.0)
        except (TypeError, ValueError):
            return True
        if mx > 1:
            job["percent"] = max(job["percent"], int(95 * min(val, mx) / mx))
    return True


# ---------------------------------------------------------------------------
# PREFLIGHT
# What a v6 run needs from this machine's ComfyUI, grouped by what the player loses without it.
# The folders are the ones ComfyUI checks each loader's filename against when a graph is queued
# (GET /models/<folder> is that same list), so "present" here means "will pass validation".
# A required group has no fallback - the sprites, the surfaces and the Kontext portrait job all
# fail the run outright - so CREATE is refused up front instead of dying minutes in on a bare
# "HTTP Error 400: Bad Request". Optional groups already degrade on their own (generate_sfx_pack
# and generate_music_pack never raise; a failed ending never fails the run).
COMFY_MODEL_GROUPS = [
    {"label": "Dungeon art & story", "required": True, "fallback": None,
     "files": [("diffusion_models", KREA2_UNET), ("text_encoders", KREA2_CLIP), ("vae", KREA2_VAE),
               ("checkpoints", FLUX_SCHNELL_CKPT), ("background_removal", BIREFNET_MODEL)]},
    {"label": "HUD portraits", "required": True, "fallback": None,
     "files": [("diffusion_models", KONTEXT_UNET), ("text_encoders", FLUX_T5),
               ("text_encoders", FLUX_CLIP_L), ("vae", FLUX_AE)]},
    {"label": "Sound effects", "required": False, "fallback": "procedural sound effects play instead",
     "files": [("checkpoints", SFX_CKPT), ("text_encoders", SFX_CLIP)]},
    {"label": "Music", "required": False, "fallback": "dungeons have no music",
     "files": [("checkpoints", MUSIC_CKPT), ("text_encoders", SFX_CLIP)]},
    {"label": "Ending video", "required": False, "fallback": "no ending movie can be filmed",
     "files": [("diffusion_models", ENDING_UNET), ("text_encoders", ENDING_CLIP),
               ("vae", ENDING_VIDEO_VAE), ("vae", ENDING_AUDIO_VAE)]},
]
# Where to download each file COMFY_MODEL_GROUPS names, and its size in bytes - copied from the
# README's Requirements table (keep both in sync; the drift guard below checks every
# COMFY_MODEL_GROUPS file has an entry here). Size is advisory only - it feeds the disk-space check
# and the progress bar's fallback total when a server doesn't send Content-Length - never
# load-bearing for correctness.
MODEL_DOWNLOADS = {
    # Dungeon art & story
    KREA2_UNET: {"url": "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors", "size": 12_200_000_000},
    KREA2_CLIP: {"url": "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors", "size": 4_900_000_000},
    KREA2_VAE: {"url": "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors", "size": 200_000_000},
    FLUX_SCHNELL_CKPT: {"url": "https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors", "size": 16_100_000_000},
    BIREFNET_MODEL: {"url": "https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors", "size": 400_000_000},
    # HUD portraits
    KONTEXT_UNET: {"url": "https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/resolve/main/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors", "size": 11_100_000_000},
    FLUX_T5: {"url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors", "size": 4_600_000_000},
    FLUX_CLIP_L: {"url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors", "size": 200_000_000},
    FLUX_AE: {"url": "https://huggingface.co/Comfy-Org/Lumina_Image_2.0_Repackaged/resolve/main/split_files/vae/ae.safetensors", "size": 300_000_000},
    # Sound effects / Music - SFX_CLIP is shared by both groups, one entry covers it
    SFX_CKPT: {"url": "https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/checkpoints/stable_audio_3_small_sfx.safetensors", "size": 2_100_000_000},
    MUSIC_CKPT: {"url": "https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/checkpoints/stable_audio_3_small_sfx_base.safetensors", "size": 2_100_000_000},
    SFX_CLIP: {"url": "https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/text_encoders/t5gemma_b_b_ul2.safetensors", "size": 1_100_000_000},
    # Ending video
    ENDING_UNET: {"url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors", "size": 19_500_000_000},
    ENDING_CLIP: {"url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "size": 14_600_000_000},
    ENDING_VIDEO_VAE: {"url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors", "size": 4_900_000_000},
    ENDING_AUDIO_VAE: {"url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors", "size": 600_000_000},
}
# Every model folder the groups above name, and the only ones an /api/open_folder key may reach.
# Derived from COMFY_MODEL_GROUPS so the two cannot drift: a request sends "model:<folder>" - a
# key out of this set, never a path - and the directory behind it is whichever of that folder's
# search paths actually holds the file named in the request's "file" field (comfy_model_file_dir).
MODEL_FOLDER_NAMES = frozenset(folder for g in COMFY_MODEL_GROUPS for folder, _ in g["files"])
# Which filenames are legitimate for a given folder - so a request's optional "file" field (which
# of that folder's search paths to actually open) is checked against real filenames rather than
# trusted outright. It only ever picks among directories ComfyUI itself already named, never a
# path of its own, but a filename that could contain "../" has no business reaching os.path.join
# unchecked either.
MODEL_FILES_BY_FOLDER = {folder: {n for g in COMFY_MODEL_GROUPS for f, n in g["files"] if f == folder}
                         for folder in MODEL_FOLDER_NAMES}

# Custom nodes the graphs name. SaveImageWithAlpha writes every cutout; the sage attention patch
# only speeds the ending video up and is wired in only when present (_sage_attention_available).
COMFY_NODES = [
    {"name": "SaveImageWithAlpha", "pack": "ComfyUI-KJNodes", "required": True},
    {"name": "PathchSageAttentionKJ", "pack": "ComfyUI-KJNodes", "required": False},
]


def _preflight_group_files(group, listed=None, dirlists=None):
    """One group's files as the About window lists them: [{folder, file, present, dir, bytes}].
    `present` is None when ComfyUI never answered, so the window can say "unknown" instead of
    claiming a file is missing. `dir` is resolved per FILE, not per folder: a folder type commonly
    has more than one search path (extra_model_paths.yaml, ComfyUI Desktop's shared-models base),
    and a file can live in the second one while the first sits empty - showing that first one
    regardless would send the player to open an empty folder for a file that IS installed.
    `dirlists` is a per-call cache of each folder's candidate directories, so comfy_model_dirs() is
    asked once per folder rather than once per file; the per-file disk check itself is cheap and
    always run fresh. `dirlists=None` (the unreachable-ComfyUI path) skips resolving directories
    at all rather than sending 17 requests to a ComfyUI that has already failed to answer once."""
    rows = []
    for folder, name in group["files"]:
        if dirlists is None:
            file_dir = None
        else:
            if folder not in dirlists:
                try:
                    dirlists[folder] = comfy_model_dirs(folder)
                except Exception:
                    dirlists[folder] = []
            file_dir = comfy_model_file_dir(folder, name, dirs=dirlists[folder])
        rows.append({"folder": folder, "file": name,
                     "present": (name in listed.get(folder, set())) if listed is not None else None,
                     "dir": file_dir,
                     "bytes": MODEL_DOWNLOADS.get(name, {}).get("size", 0)})
    return rows


def comfy_preflight():
    """Everything this machine's ComfyUI can and can't do for a v6 run. Always asks live - a model
    downloaded a minute ago counts - and never raises. `ready` means a dungeon can be created:
    ComfyUI answers, its folders are here, and nothing required is missing."""
    report = {"ready": False,
              "comfy": {"reachable": False, "url": COMFY_URL, "version": None, "embedded": bool(COMFY_EMBEDDED),
                        "input_dir": None, "output_dir": None, "sources": None, "error": None,
                        # True when restarting ComfyUI's server is the fix, so the setup screen and
                        # the sidebar panel can offer that rather than describe it.
                        "restart": False},
              "groups": [], "nodes": []}
    try:
        ensure_comfy(refresh=True)
    except ComfyUnavailable as e:
        report["comfy"].update(reachable=e.reachable, error=str(e), restart=e.restart)
        # Nothing can be checked, but the About window still lists what a full install holds -
        # every file with present=None and no folder, i.e. "unknown", never "missing". `missing`
        # stays empty so the setup screen keeps saying only that ComfyUI isn't answering.
        report["groups"] = [{"label": g["label"], "required": g["required"], "fallback": g["fallback"],
                             "missing": [], "missing_bytes": 0, "files": _preflight_group_files(g)}
                            for g in COMFY_MODEL_GROUPS]
        return report
    report["comfy"].update(reachable=True, url=COMFY_URL, version=_COMFY_VERSION,
                           input_dir=COMFY_INPUT_DIR, output_dir=COMFY_OUTPUT_DIR,
                           sources=dict(_COMFY_SOURCES))

    listed, dirs = {}, {}
    for group in COMFY_MODEL_GROUPS:
        for folder, _ in group["files"]:
            if folder not in listed:
                try:
                    listed[folder] = set(_comfy_get_json(f"/models/{folder}"))
                except Exception:
                    listed[folder] = set()     # an older ComfyUI without that folder has none of it
        missing = [{"folder": folder, "file": name} for folder, name in group["files"]
                   if name not in listed[folder]]
        report["groups"].append({
            "label": group["label"], "required": group["required"], "fallback": group["fallback"],
            "missing": missing,
            "missing_bytes": sum(MODEL_DOWNLOADS.get(m["file"], {}).get("size", 0) for m in missing),
            # Every file, installed or not, with the directory it belongs in - the About window's
            # parts list reads this one; the setup screen only ever reads `missing`.
            "files": _preflight_group_files(group, listed, dirs)})

    for node in COMFY_NODES:
        try:
            present = node["name"] in _comfy_get_json(f"/object_info/{node['name']}")
        except Exception:
            present = False
        report["nodes"].append(dict(node, present=present))

    report["ready"] = (not any(g["required"] and g["missing"] for g in report["groups"])
                       and all(n["present"] for n in report["nodes"] if n["required"]))
    return report


# ---------------------------------------------------------------------------
# MODEL DOWNLOADS
# One background download job at a time, app-wide (these are multi-GB files - two at once just
# halves bandwidth to both). Started per COMFY_MODEL_GROUPS group from the setup screen; downloads
# every file that group is still missing, straight into ComfyUI's own models folders. Modeled on
# the ending-video job above: a lock, a singleton job dict, a state machine, a daemon thread, and a
# view function the API polls.
_MODEL_DOWNLOAD_LOCK = threading.Lock()
_MODEL_DOWNLOAD_JOB = None
MODEL_DOWNLOAD_CHUNK = 1 << 20              # 1 MiB
MODEL_DOWNLOAD_FREE_MARGIN = 2_000_000_000  # keep this much free beyond the download itself


class ModelDownloadCancelled(Exception):
    """Raised inside the download loop to unwind out to _run_model_download_job on Cancel."""


def _format_bytes(n):
    """A byte count the way the player would write it - "12.2 GB", "340 MB" - for space errors."""
    n = float(n)
    for unit in ("bytes", "KB", "MB", "GB", "TB"):
        if n < 1000 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1000


def _download_job_view(job):
    return {"group": job["group"], "state": job["state"], "file": job["file"],
            "file_index": job["file_index"], "file_count": job["file_count"],
            "percent": job["percent"], "bytes_done": job["group_bytes_done"] + job["bytes_done"],
            "bytes_total": job["group_bytes_total"], "error": job["error"]}


def model_download_job_view():
    """The one model download running app-wide, for the setup screen to poll: {group, state, file,
    file_index, file_count, percent, bytes_done, bytes_total, error}. {state: "idle", ...} when
    there isn't one. A finished job keeps reporting its last state, like ending_video_job_view, so a
    slow poll still sees how it ended."""
    job = _MODEL_DOWNLOAD_JOB
    if not job:
        return {"group": None, "state": "idle", "file": None, "file_index": 0, "file_count": 0,
                "percent": 0, "bytes_done": 0, "bytes_total": 0, "error": None}
    return _download_job_view(job)


def _check_download_space(missing):
    """None if there's room to download `missing` ([(folder, name), ...]); else an error string for
    the player. Grouped per target directory, since one group's files (diffusion_models,
    text_encoders, vae, ...) can be sent to different drives by extra_model_paths.yaml."""
    needed = {}
    for folder, name in missing:
        target = comfy_model_dir(folder)
        if not target:
            return f"ComfyUI hasn't said where its {folder} models folder is."
        have = 0
        part = os.path.join(target, name + ".part")
        if os.path.exists(part):
            have = os.path.getsize(part)
        size = MODEL_DOWNLOADS.get(name, {}).get("size", 0)
        needed[target] = needed.get(target, 0) + max(size - have, 0)
    for target, bytes_needed in needed.items():
        probe = target if os.path.isdir(target) else (os.path.dirname(target) or target)
        try:
            free = shutil.disk_usage(probe).free
        except OSError:
            continue   # can't check yet (the drive isn't there) - let the download itself fail
        if free < bytes_needed + MODEL_DOWNLOAD_FREE_MARGIN:
            return (f"Not enough free space in {target}: this needs about "
                    f"{_format_bytes(bytes_needed)} more, only {_format_bytes(free)} is free.")
    return None


def start_model_download_job(group_label):
    """Start downloading a COMFY_MODEL_GROUPS group's still-missing files. Idempotent for the group
    already downloading; "busy" for a different one already running. Missing files are recomputed
    fresh here from ComfyUI's own listing - not from a client-held report - so a file the player
    already placed by hand, or that another group's download already fetched (SFX_CLIP is shared by
    Sound effects and Music), is never re-downloaded."""
    global _MODEL_DOWNLOAD_JOB
    group = next((g for g in COMFY_MODEL_GROUPS if g["label"] == group_label), None)
    if group is None:
        return {"group": group_label, "state": "failed", "file": None, "file_index": 0,
                "file_count": 0, "percent": 0, "bytes_done": 0, "bytes_total": 0,
                "error": f"There is no model group called {group_label!r}."}
    with _MODEL_DOWNLOAD_LOCK:
        job = _MODEL_DOWNLOAD_JOB
        if job and job["state"] in ("queued", "downloading"):
            if job["group"] == group_label:
                return _download_job_view(job)
            return {"group": job["group"], "state": "busy", "file": None, "file_index": 0,
                    "file_count": 0, "percent": 0, "bytes_done": 0, "bytes_total": 0,
                    "error": f"Already downloading {job['group']}."}
    try:
        ensure_comfy()
    except ComfyUnavailable as e:
        return {"group": group_label, "state": "failed", "file": None, "file_index": 0,
                "file_count": 0, "percent": 0, "bytes_done": 0, "bytes_total": 0, "error": str(e)}
    listed, missing = {}, []
    for folder, name in group["files"]:
        if folder not in listed:
            try:
                listed[folder] = set(_comfy_get_json(f"/models/{folder}"))
            except Exception:
                listed[folder] = set()
        if name not in listed[folder]:
            missing.append((folder, name))
    if not missing:
        return {"group": group_label, "state": "done", "file": None, "file_index": 0,
                "file_count": 0, "percent": 100, "bytes_done": 0, "bytes_total": 0, "error": None}
    space_error = _check_download_space(missing)
    if space_error:
        return {"group": group_label, "state": "failed", "file": None, "file_index": 0,
                "file_count": len(missing), "percent": 0, "bytes_done": 0, "bytes_total": 0,
                "error": space_error}
    job = {"group": group_label, "state": "queued", "files": missing, "file_index": 0,
           "file": missing[0][1], "file_count": len(missing), "bytes_done": 0,
           "bytes_total": MODEL_DOWNLOADS.get(missing[0][1], {}).get("size", 0),
           "group_bytes_done": 0,
           "group_bytes_total": sum(MODEL_DOWNLOADS.get(n, {}).get("size", 0) for _, n in missing),
           "percent": 0, "error": None, "cancelled": False}
    with _MODEL_DOWNLOAD_LOCK:
        _MODEL_DOWNLOAD_JOB = job
    threading.Thread(target=_run_model_download_job, args=(job,), daemon=True).start()
    return _download_job_view(job)


def cancel_model_download_job(group_label=None):
    """Stop the running download - only the one for `group_label`, when given. True if there was
    one to stop. Returns straight away; the worker notices within one chunk (<=1MiB) and leaves its
    .part file in place for a later resume - cancelling is not deleting."""
    with _MODEL_DOWNLOAD_LOCK:
        job = _MODEL_DOWNLOAD_JOB
        if not job or job["state"] not in ("queued", "downloading"):
            return False
        if group_label is not None and job["group"] != group_label:
            return False
        job["cancelled"] = True
        job["state"] = "cancelled"
    return True


def _run_model_download_job(job):
    try:
        for i, (folder, name) in enumerate(job["files"]):
            if job["cancelled"]:
                raise ModelDownloadCancelled("stopped before this file started")
            job["state"] = "downloading"
            job["file_index"], job["file"] = i, name
            job["bytes_done"] = 0
            job["bytes_total"] = MODEL_DOWNLOADS.get(name, {}).get("size", 0)
            _download_one_model(job, folder, name)
            job["group_bytes_done"] += job["bytes_total"]
            job["percent"] = int(100 * job["group_bytes_done"] / max(job["group_bytes_total"], 1))
        job["state"] = "done"
    except ModelDownloadCancelled as e:
        job["state"] = "cancelled"
        print(f"[download] {job['group']} stopped ({e})")
    except Exception as e:
        job["state"] = "cancelled" if job["cancelled"] else "failed"
        job["error"] = str(e)
        print(f"[download] {job['group']} {job['state']} ({e})")


def _download_one_model(job, folder, name):
    """Stream one file from MODEL_DOWNLOADS into ComfyUI's models folder, resuming a `.part` left
    from an earlier attempt via HTTP Range. Only renamed into place once every byte is down - a
    crash or cancel always leaves either the finished file or a resumable .part, never a half-write
    ComfyUI might try to load."""
    target_dir = comfy_model_dir(folder)
    if not target_dir:
        raise RuntimeError(f"ComfyUI hasn't said where its {folder} models folder is.")
    os.makedirs(target_dir, exist_ok=True)
    final_path = os.path.join(target_dir, name)
    if os.path.exists(final_path):
        job["bytes_done"] = job["bytes_total"]
        return
    part_path = final_path + ".part"
    offset = os.path.getsize(part_path) if os.path.exists(part_path) else 0
    url = MODEL_DOWNLOADS[name]["url"]
    resp = urllib.request.urlopen(
        urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {}), timeout=60)
    try:
        if offset and resp.status != 206:
            # The server ignored Range - a resume would corrupt the file, so start clean instead.
            resp.close()
            offset = 0
            resp = urllib.request.urlopen(urllib.request.Request(url), timeout=60)
        content_range = resp.headers.get("Content-Range")
        content_length = resp.headers.get("Content-Length")
        if resp.status == 206 and content_range and "/" in content_range:
            total = int(content_range.rsplit("/", 1)[1])
        elif content_length:
            total = (offset if resp.status == 206 else 0) + int(content_length)
        else:
            total = job["bytes_total"]
        job["bytes_total"] = total or job["bytes_total"]
        with open(part_path, "r+b" if offset else "wb") as f:
            if offset:
                f.seek(offset)
                f.truncate()
            job["bytes_done"] = offset
            while True:
                if job["cancelled"]:
                    raise ModelDownloadCancelled(f"stopped partway through {name}")
                chunk = resp.read(MODEL_DOWNLOAD_CHUNK)
                if not chunk:
                    break
                f.write(chunk)
                job["bytes_done"] += len(chunk)
                job["percent"] = int(100 * (job["group_bytes_done"] + job["bytes_done"])
                                     / max(job["group_bytes_total"], 1))
    finally:
        resp.close()
    if job["bytes_total"] and job["bytes_done"] != job["bytes_total"]:
        raise RuntimeError(f"{name} downloaded {job['bytes_done']} bytes, expected "
                           f"{job['bytes_total']} - try again.")
    os.replace(part_path, final_path)


def comfy_settings_view():
    """Everything Options > ComfyUI Connection shows: what it saved, which fields an environment
    variable pins (those are greyed out there - the variable wins), and a fresh preflight with the
    values actually in use and where each came from."""
    return {"embedded": bool(COMFY_EMBEDDED),
            "settings": load_comfy_settings(),
            "env": {key: bool((os.environ.get(name) or "").strip()) for key, name in COMFY_SETTING_ENV.items()},
            "env_names": dict(COMFY_SETTING_ENV),
            "candidates": list(COMFY_URL_CANDIDATES),
            "preflight": comfy_preflight()}


def comfy_busy_reason():
    """Why ComfyUI's connection can't be changed right now, or None. A run or an ending movie in
    flight keeps talking to the ComfyUI it started on - moving the globals under it would send its
    later prompts somewhere else, or read its renders out of the wrong folder."""
    if gen_progress.get("is_generating") or run_is_settling():
        return "A dungeon is being made - change ComfyUI's connection once it's done."
    if ending_video_rendering():
        return "An ending movie is being filmed - change ComfyUI's connection once it's done."
    return None


def server_busy_reason():
    """What long-running work is in flight right now, as a phrase, or None. The custom node's
    Reload button asks before re-importing this module: reloading re-runs the module body, and a
    thread still part-way through a job would be left writing to state nothing reads any more."""
    if gen_progress.get("is_generating") or run_is_settling():
        return "a dungeon is being made"
    if ending_video_rendering():
        return "an ending movie is being filmed"
    job = _MODEL_DOWNLOAD_JOB
    if job and job["state"] in ("queued", "downloading"):
        return f"{job['group']} is downloading"
    return None


def preflight_problems(report):
    """What stops a dungeon being created, as plain lines for the player - [] when ready."""
    if report["comfy"]["error"]:
        return [report["comfy"]["error"]]
    lines = [f"{m['file']}  ->  ComfyUI models/{m['folder']}/  ({g['label']})"
             for g in report["groups"] if g["required"] for m in g["missing"]]
    lines += [f"the {n['name']} node  ->  install {n['pack']}"
              for n in report["nodes"] if n["required"] and not n["present"]]
    return lines


def print_preflight():
    """The startup checklist in the console (and server.log)."""
    r = comfy_preflight()
    c = r["comfy"]
    if c["error"]:
        print(f"[preflight] {c['error']}")
        return
    print(f"[preflight] ComfyUI {c['version'] or '?'} at {c['url']}")
    for g in r["groups"]:
        if not g["missing"]:
            status = "ok"
        elif g["required"]:
            status = "MISSING - dungeons can't be created until these are added"
        else:
            status = f"missing - {g['fallback']}"
        print(f"[preflight]   {g['label']}: {status}")
        for m in g["missing"]:
            print(f"[preflight]     {m['file']}  ->  models/{m['folder']}/")
    for n in r["nodes"]:
        if not n["present"]:
            print(f"[preflight]   {n['name']} node ({n['pack']}): "
                  + ("MISSING - dungeons can't be created" if n["required"] else "not installed (optional)"))
    print("[preflight] ready - dungeons can be created" if r["ready"]
          else "[preflight] NOT ready - see above")


class DungeonHTTPRequestHandler(http.server.BaseHTTPRequestHandler):
    def _refuse_cross_site(self):
        """Refuse a request some other website made from inside the player's browser. Without this,
        any page they visited could POST (a text/plain body needs no CORS preflight) to delete
        saved dungeons, start a generation or open folders, or read the History. The same rule as
        ComfyUI's own origin middleware: the browser says cross-site, or the Origin it sends isn't
        this server. Requests with neither header (curl, the tests) aren't from a web page and pass.
        Skipped inside ComfyUI, whose middleware already applied it and whose CORS setting decides.
        True when it answered 403 - the caller just returns."""
        if COMFY_EMBEDDED:
            return False
        site = (self.headers.get("Sec-Fetch-Site") or "").lower()
        origin = self.headers.get("Origin")
        refused = site == "cross-site"
        if not refused and origin:
            refused = origin == "null" or (urllib.parse.urlsplit(origin).netloc.lower()
                                           != (self.headers.get("Host") or "").lower())
        if not refused:
            return False
        print(f"[security] refused a cross-site {self.command} {self.path.split('?')[0]} "
              f"(Origin: {origin or '-'}, Sec-Fetch-Site: {site or '-'})")
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length:
                self.rfile.read(length)
        except Exception:
            pass
        payload = json.dumps({"success": False, "error": "Cross-site request refused."}).encode("utf-8")
        self.send_response(403)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        return True

    def do_GET(self):
        if self._refuse_cross_site():
            return
        if self.path == "/api/progress":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            # `settling` rides along rather than living in gen_progress because it is derived
            # from thread liveness, not written by the run - it is what keeps CREATE disabled
            # on a page that reloaded out of a cancel. See run_is_settling.
            self.wfile.write(json.dumps(dict(gen_progress, settling=run_is_settling()),
                                        ensure_ascii=True).encode("utf-8"))
            return

        # The setup screen's notice: whether ComfyUI answers and which model files it lacks.
        # See comfy_preflight - asked on load and by the notice's Check again button.
        elif self.path == "/api/preflight":
            payload = json.dumps(comfy_preflight(), ensure_ascii=True).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return

        # Options > ComfyUI Connection, when it opens: saved overrides, env-pinned fields and a
        # fresh preflight. See comfy_settings_view; the POST of the same path saves.
        elif self.path == "/api/comfy_settings":
            payload = json.dumps(comfy_settings_view(), ensure_ascii=True).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return

        # The page's saved settings (see PAGE SETTINGS). The page itself gets them written into
        # index.html; this is for anything else that wants to read them.
        elif self.path == "/api/settings":
            payload = json.dumps({"settings": load_page_settings()}, ensure_ascii=True).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return

        # The History window's listing: meta records only (a name, a date, a 96px thumb),
        # never the bundles themselves.
        elif self.path == "/api/history":
            payload = json.dumps({"sessions": list_dungeon_sessions()},
                                 ensure_ascii=True).encode("utf-8")
            # The window this listing draws can be switched to tiles, and every run saved
            # before tiles existed needs its picture drawn from its bundle first. Start that
            # in the background now rather than paying for it one blocked request at a time
            # when the grid asks - see start_card_backfill.
            start_card_backfill()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return

        # One saved dungeon, replayed. bundle.json is already exactly the JSON the poll
        # loop would have handed the page, so it is streamed from disk unparsed.
        elif self.path.startswith("/api/history_bundle"):
            qs = urllib.parse.urlparse(self.path).query
            session_id = urllib.parse.parse_qs(qs).get("id", [""])[0]
            folder = _session_dir(session_id)
            bundle_path = os.path.join(folder, "bundle.json") if folder else None
            if bundle_path and os.path.exists(bundle_path):
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(os.path.getsize(bundle_path)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with open(bundle_path, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                return
            self.send_response(404)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"success": False,
                                         "error": "That saved dungeon is gone."},
                                        ensure_ascii=True).encode("utf-8"))
            return

        # One saved run's tile picture - the hero in their default pose, standing in that
        # dungeon's own corridor (see _session_card). Drawn on the first request and kept beside
        # the bundle, so the hundreds of runs saved before the tile view existed get one without
        # a migration pass. A 404 here is not an error the grid shows: the tile falls back to
        # the listing's own 96px thumbnail.
        elif urllib.parse.urlparse(self.path).path == "/api/history_card":
            qs = urllib.parse.urlparse(self.path).query
            session_id = urllib.parse.parse_qs(qs).get("id", [""])[0]
            card = ensure_session_card(session_id)
            if card and os.path.exists(card):
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(os.path.getsize(card)))
                # Same no-store every other route here sends: the file on disk is the cache that
                # matters, and re-sending 100KB over the loopback costs nothing next to serving a
                # stale card after this renderer changes.
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with open(card, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                return
            self.send_response(404)
            self.end_headers()
            return

        # Where a run's ending cutscene stands - polled by game.js while a background render is
        # filming, and asked once on entry to learn whether a clip is already there.
        elif urllib.parse.urlparse(self.path).path == "/api/ending_video_status":
            qs = urllib.parse.urlparse(self.path).query
            session_id = urllib.parse.parse_qs(qs).get("id", [""])[0]
            payload = json.dumps(ending_video_status(session_id), ensure_ascii=True).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return

        # The one ending render outside a run, whichever run it is for - polled by game.js while
        # one is filming, so the History window can show its progress on the right row and the
        # buttons it greys out come back the moment it is done (see ending_video_job_view).
        elif self.path == "/api/ending_video_job":
            payload = json.dumps(ending_video_job_view(), ensure_ascii=True).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return

        # The one model-file download running app-wide, whichever group it's for - polled by the
        # setup screen's Download buttons while one is going. See model_download_job_view.
        elif self.path == "/api/model_download_job":
            payload = json.dumps(model_download_job_view(), ensure_ascii=True).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return

        # The cutscene itself. game.js fetches it whole into a blob as soon as it exists, so the
        # boss's last hit plays it from memory rather than asking this one-request-at-a-time
        # server to stream it right then.
        elif urllib.parse.urlparse(self.path).path == "/api/ending_video":
            qs = urllib.parse.urlparse(self.path).query
            session_id = urllib.parse.parse_qs(qs).get("id", [""])[0]
            clip = _ending_session_file(session_id)
            if clip and os.path.exists(clip):
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(os.path.getsize(clip)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with open(clip, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                return
            self.send_response(404)
            self.end_headers()
            return

        elif self.path == "/" or self.path == "/index.html":
            html_file = os.path.join(PROJECT_DIR, "index.html")
            if os.path.exists(html_file):
                with open(html_file, "rb") as f:
                    content = page_with_saved_settings(f.read())
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                # The saved settings are written into the page, so a cached copy would carry stale ones.
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return

        elif self.path == "/game.js":
            js_file = os.path.join(PROJECT_DIR, "game.js")
            if os.path.exists(js_file):
                with open(js_file, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return

        # The page's Tailwind utilities, compiled from index.html + game.js (npm run tw:build, or
        # tw:watch while editing the UI). Committed, so playing needs no Node. No Cache-Control,
        # same as game.js, so a refresh picks up a rebuild.
        elif self.path == "/tailwind.css":
            css_file = os.path.join(PROJECT_DIR, "tailwind.css")
            if os.path.exists(css_file):
                with open(css_file, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/css; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return

        # The tab icon: a cat in CC shades (the lenses are ComfyCrawler's two Cs), drawn
        # as 16x16 pixel art - see the grid in the comment at the top of favicon.svg. The
        # .ico is the same art at 16/32/48 for the bare /favicon.ico a browser asks for on
        # its own, and for bookmarks/shortcuts that ignore SVG. icon.png is the same art
        # upscaled to 400x400 (pyproject.toml's Registry icon) - also served here so the
        # ComfyUI sidebar tab can use it at a size favicon.ico's 48px doesn't cover.
        elif self.path in ("/favicon.svg", "/favicon.ico", "/icon.png"):
            name = self.path.lstrip("/")
            icon_file = os.path.join(PROJECT_DIR, name)
            if os.path.exists(icon_file):
                with open(icon_file, "rb") as f:
                    content = f.read()
                self.send_response(200)
                if name.endswith(".svg"):
                    content_type = "image/svg+xml"
                elif name.endswith(".png"):
                    content_type = "image/png"
                else:
                    content_type = "image/x-icon"
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "max-age=86400")
                self.end_headers()
                self.wfile.write(content)
                return

        # The page's typeface (Comic Neue, SIL OFL - see fonts/OFL.txt), shipped with the app
        # so it renders the same on a phone as on this machine and needs no font CDN. Same
        # whitelisted shape as /sounds/ below: basename only, and only these two files.
        elif self.path.startswith("/fonts/"):
            name = os.path.basename(self.path)
            if name in ("ComicNeue-Regular.woff2", "ComicNeue-Bold.woff2"):
                font_file = os.path.join(PROJECT_DIR, "fonts", name)
                if os.path.exists(font_file):
                    with open(font_file, "rb") as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "font/woff2")
                    self.send_header("Content-Length", str(len(content)))
                    self.send_header("Cache-Control", "max-age=604800")
                    self.end_headers()
                    self.wfile.write(content)
                    return

        # The static UI sounds (start / button / end), the four screen music loops, and the
        # loading-complete chime. Unlike the gameplay foley these do not change with the
        # theme, so they were generated once (see generate_static_music_asset /
        # generate_ready_chime_asset) and committed to sounds/ rather than costing time in
        # every run.
        elif self.path.startswith("/sounds/"):
            name = os.path.basename(self.path)
            # Basename alone already defeats "../", but the whitelist keeps this route from
            # ever becoming a general file server.
            if name in (("start.wav", "button.wav", "end.wav", "ready.wav")
                        + tuple(f"{k}_music.wav" for k in STATIC_MUSIC)):
                wav_file = os.path.join(PROJECT_DIR, "sounds", name)
                if os.path.exists(wav_file):
                    with open(wav_file, "rb") as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(content)))
                    self.send_header("Cache-Control", "max-age=86400")
                    self.end_headers()
                    self.wfile.write(content)
                    return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        global GEN_THREAD, _RUN_EPOCH
        if self._refuse_cross_site():
            return

        if self.path == "/api/generate_dungeon":
            # The page disables CREATE while /api/progress reports settling, so this is the
            # backstop for a stale tab or a hand-rolled POST: a second chain started on top of
            # a run that is still being torn out of ComfyUI would queue behind the dying one.
            if run_is_settling():
                try:
                    length = int(self.headers.get("Content-Length", 0) or 0)
                    if length:
                        self.rfile.read(length)
                except Exception:
                    pass
                self.send_response(409)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps(
                    {"success": False, "settling": True,
                     "error": "The cancelled run is still clearing ComfyUI - try again in a moment."},
                    ensure_ascii=True).encode("utf-8"))
                print("[generate_dungeon] refused - previous run still settling")
                return
            # Same backstop for an ending movie the player asked for from History: the page greys
            # CREATE out until it is done, and nothing gets to replace it (see _ENDING_JOB).
            if ending_video_manual_rendering():
                try:
                    length = int(self.headers.get("Content-Length", 0) or 0)
                    if length:
                        self.rfile.read(length)
                except Exception:
                    pass
                self.send_response(409)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps(
                    {"success": False, "busy": True,
                     "error": "An ending movie is being filmed - try again once it is done."},
                    ensure_ascii=True).encode("utf-8"))
                print("[generate_dungeon] refused - an ending movie from History is filming")
                return
            # And the one that saves the most time: a run that can't finish (ComfyUI down, or a
            # required model or node missing) is refused here with the exact files to add,
            # instead of failing minutes in on ComfyUI's bare 400. See comfy_preflight.
            preflight = comfy_preflight()
            if not preflight["ready"]:
                try:
                    length = int(self.headers.get("Content-Length", 0) or 0)
                    if length:
                        self.rfile.read(length)
                except Exception:
                    pass
                problems = preflight_problems(preflight)
                if preflight["comfy"]["error"]:
                    message = problems[0]
                else:
                    message = ("ComfyUI is missing what a dungeon needs:\n\n"
                               + "\n".join("- " + p for p in problems)
                               + "\n\nAdd them, then press CREATE again.")
                self.send_response(409)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps(
                    {"success": False, "preflight": preflight, "error": message},
                    ensure_ascii=True).encode("utf-8"))
                print("[generate_dungeon] refused - preflight: " + "; ".join(problems))
                return
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length).decode("utf-8")
                data = json.loads(body)
                wall_style = data.get("wall_style", "Windows 95")
                player_style = data.get("player_style", "")
                player_image = data.get("player_image", None)
                weapon_style = data.get("weapon_style", "")
                enemy_style = data.get("enemy_style", "")
                mode = data.get("mode", "v3_flux")
                # v6-only; v5/v3/v4 ignore this. Matches the setup screen's default option.
                sound_mode = data.get("sound_mode", "music_and_sound")
                # "Graphics Quality" dropdown: normal / optimized / reduced. Unknown value
                # -> normal. Resolves to a per-asset-class px profile. v5/v6 only.
                graphics_quality = data.get("graphics_quality", GFX_QUALITY_DEFAULT)
                gfx = _gfx_profile(graphics_quality)
                # Options' "Last Attack Frame" toggle: one more frame per foe, shown when its
                # blow lands. v6 only; absent (an older page) means off.
                last_attack_frame = bool(data.get("last_attack_frame", False))
                # Options' Ending Video pair: the cutscene itself, and whether it is filmed on the
                # loading screen or in the background while the run is played. v6 only; absent
                # (an older page) means off.
                ending_video = "off"
                if bool(data.get("ending_video", False)):
                    ending_video = ("background" if bool(data.get("ending_video_background", False))
                                    else "loading")
                # A new dungeon outranks an ending still filming for a run the player has left:
                # every prompt of this run would otherwise queue behind a multi-minute video job.
                cancel_ending_video_job("a new dungeon is being generated")
                # krea2 steps was a UI input once, never touched - run_batch_* just uses
                # KREA2_STEPS_DEFAULT now.

                # A fresh run owes nothing to any earlier one: forget the prompt ids of
                # the last run (already drained, or already collected) and drop finished
                # threads from the cancelled set so it can't grow for the life of the
                # process.
                with _INFLIGHT_LOCK:
                    del _INFLIGHT_PROMPTS[:]
                # Retires any cancel watchdog still running: it stops on an epoch change, so
                # it can never mistake this run's prompts for the ones it was chasing.
                _RUN_EPOCH += 1
                _CANCELLED_RUNS.difference_update(
                    [th for th in list(_CANCELLED_RUNS) if not th.is_alive()])

                # Reset progress synchronously
                gen_progress["is_generating"] = True
                gen_progress["completed_bundle"] = None
                gen_progress["error"] = None
                gen_progress["current_step"] = 1
                gen_progress["total_steps"] = 2
                gen_progress["story"] = None
                gen_progress["phase"] = ""
                gen_progress["status_message"] = (
                    "Writing the chronicle with Qwen3-VL..." if mode in ("v5_krea", "v6_krea")
                    else "Synthesizing 3D Dungeon & Character with FLUX.1 [schnell]...")
                gen_progress["percent"] = 0

                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "message": f"{mode} generation started"}, ensure_ascii=True).encode("utf-8"))

                if mode == "v5_krea":
                    t = threading.Thread(target=run_batch_v5_krea,
                                         args=(wall_style, player_style, weapon_style, enemy_style),
                                         kwargs={"player_image": player_image, "gfx": gfx},
                                         daemon=True)
                elif mode == "v6_krea":
                    t = threading.Thread(target=run_batch_v6_krea,
                                         args=(wall_style, player_style, weapon_style, enemy_style),
                                         kwargs={"player_image": player_image, "sound_mode": sound_mode,
                                                 "gfx": gfx, "gfx_name": graphics_quality,
                                                 "last_attack_frame": last_attack_frame,
                                                 "ending_video": ending_video},
                                         daemon=True)
                else:
                    t = threading.Thread(target=run_batch_v3_flux,
                                         args=(wall_style, player_style, player_image, mode, weapon_style, enemy_style),
                                         daemon=True)
                print(f"[generate_dungeon] mode={mode} graphics_quality={graphics_quality} {gfx} "
                      f"last_attack_frame={last_attack_frame} ending_video={ending_video}")
                t.start()
                GEN_THREAD = t
                return
            except Exception as e:
                print(f"[Request Error] {e}")
                gen_progress["is_generating"] = False
                gen_progress["error"] = str(e)
                try:
                    self.send_response(500)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(json.dumps({"success": False, "error": str(e)},
                                                ensure_ascii=True).encode("utf-8"))
                except Exception:
                    pass  # client already gone, or headers were sent before the throw
                return

        elif self.path == "/api/fill_in":
            # The setup screen's Fill-in button. Blocks this (single-threaded) server for the few
            # seconds the text call takes, which is why the page holds CREATE disabled meanwhile.
            status, reply = 200, None
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                fields = {f: str(data.get(f) or "")[:FILL_IN_FIELD_MAX_CHARS] for f in FILL_IN_FIELDS}
                if gen_progress.get("is_generating") or run_is_settling():
                    # ComfyUI is busy with a dungeon; the fill-in would queue behind all of it.
                    status, reply = 409, {"success": False, "busy": True,
                                          "error": "ComfyUI is busy with a dungeon - try again in a moment."}
                elif ending_video_manual_rendering():
                    # An ending movie the player asked for from History - see _ENDING_JOB.
                    status, reply = 409, {"success": False, "busy": True,
                                          "error": "An ending movie is being filmed - try again once it is done."}
                elif all(v.strip() for v in fields.values()):
                    reply = {"success": True, "fields": {}}
                else:
                    # Same rule as a new dungeon: a background ending still filming for a run
                    # the player has left would hold this call - and this whole server - behind
                    # minutes of video. It gives way.
                    ensure_comfy()
                    cancel_ending_video_job("the Fill-in button needs ComfyUI")
                    reply = {"success": True, "fields": generate_fill_in(fields)}
            except ComfyUnavailable as e:
                status, reply = 502, {"success": False, "error": str(e)}
            except urllib.error.URLError as e:
                status, reply = 502, {"success": False, "error": "Couldn't reach ComfyUI - is it running?"}
            except Exception as e:
                print(f"[fill_in Request Error] {e}")
                status, reply = 500, {"success": False, "error": str(e)}
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps(reply, ensure_ascii=True).encode("utf-8"))
            except Exception:
                pass  # the page went away while the model was writing
            return

        elif self.path == "/api/history_delete":
            # The trash can in the History window, after the player has confirmed. Erases
            # the whole folder - bundle, thumbnail and metadata alike.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                removed = delete_dungeon_session(data.get("id"))
                body = {"success": removed}
                if not removed:
                    body["error"] = "That saved dungeon is already gone."
                code = 200 if removed else 404
            except SessionLocked as e:
                body, code = {"success": False, "locked": True, "error": str(e)}, 409
            except Exception as e:
                print(f"[history] delete failed ({e})")
                body, code = {"success": False, "error": str(e)}, 500
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body, ensure_ascii=True).encode("utf-8"))
            return

        elif self.path == "/api/ending_video_start":
            # Filming a saved run's ending outside a run. Body is {id, manual}: manual is a
            # History row's movie button, anything else is background mode for the run being
            # played. The reply is ending_video_status's shape, plus "busy" when a dungeon
            # generation or a manual render owns ComfyUI (the page asks again later).
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                body, code = start_ending_video_job(data.get("id"), manual=bool(data.get("manual"))), 200
            except Exception as e:
                print(f"[ending] start failed ({e})")
                body, code = {"state": "failed", "percent": 0, "error": str(e)}, 500
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body, ensure_ascii=True).encode("utf-8"))
            return

        elif self.path == "/api/ending_video_cancel":
            # "Stop Filming" in the confirm box a filming History row's movie button opens. Body is
            # {id}; only the render for that run is stopped, and "stopped" says whether there was
            # one - it may have finished while the question was on screen.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                session_id = data.get("id")
                stopped = bool(session_id) and cancel_ending_video_job(
                    "the player stopped it from History", session_id=session_id)
                body, code = {"success": True, "stopped": stopped}, 200
            except Exception as e:
                print(f"[ending] cancel failed ({e})")
                body, code = {"success": False, "error": str(e)}, 500
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body, ensure_ascii=True).encode("utf-8"))
            return

        elif self.path == "/api/model_download_start":
            # A Download button on the setup screen. Body is {group}, one of COMFY_MODEL_GROUPS'
            # labels. The reply is model_download_job_view's shape, plus "busy" when a different
            # group is already downloading (the page asks again once that one finishes).
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                body, code = start_model_download_job(str(data.get("group") or "")), 200
            except Exception as e:
                print(f"[download] start failed ({e})")
                body, code = {"success": False, "error": str(e)}, 500
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body, ensure_ascii=True).encode("utf-8"))
            return

        elif self.path == "/api/model_download_cancel":
            # The Cancel confirm box on a downloading group. Body is {group}; only that group's
            # download is stopped, and "stopped" says whether there was one - it may have finished
            # while the question was on screen.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                group_label = data.get("group")
                stopped = bool(group_label) and cancel_model_download_job(group_label)
                body, code = {"success": True, "stopped": stopped}, 200
            except Exception as e:
                print(f"[download] cancel failed ({e})")
                body, code = {"success": False, "error": str(e)}, 500
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body, ensure_ascii=True).encode("utf-8"))
            return

        elif self.path == "/api/history_beaten":
            # The boss of a saved run just went down. Body is {id}. Recorded once and never
            # cleared - it is what unlocks that run's ending movie in the History window.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                beaten = mark_dungeon_session_beaten(data.get("id"))
                if beaten is None:
                    body, code = {"success": False, "error": "That saved dungeon is gone."}, 404
                else:
                    body, code = {"success": True, "beaten": True}, 200
            except Exception as e:
                print(f"[history] beaten failed ({e})")
                body, code = {"success": False, "error": str(e)}, 500
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body, ensure_ascii=True).encode("utf-8"))
            return

        elif self.path == "/api/history_favorite":
            # The star on a History row. Body is {id, favorite}; the reply carries the flag as
            # it now stands on disk, which is what the page draws the star from.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                favorite = set_dungeon_session_favorite(data.get("id"), data.get("favorite"))
                if favorite is None:
                    body, code = {"success": False, "error": "That saved dungeon is gone."}, 404
                else:
                    body, code = {"success": True, "favorite": favorite}, 200
            except Exception as e:
                print(f"[history] favorite failed ({e})")
                body, code = {"success": False, "error": str(e)}, 500
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body, ensure_ascii=True).encode("utf-8"))
            return

        elif self.path == "/api/comfy_settings":
            # Options > ComfyUI Connection's Apply (and OK with unapplied edits). Body is
            # {url, input_dir, output_dir}, "" meaning auto-detect. Saved, then re-checked at
            # once, so the reply's preflight says whether the new values actually work.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                busy = comfy_busy_reason()
                if COMFY_EMBEDDED:
                    # Nothing to set: inside ComfyUI, ComfyCrawler talks to the ComfyUI it runs in.
                    body, code = {"success": False, "embedded": True,
                                  "error": "ComfyUI's connection is fixed when ComfyCrawler runs inside ComfyUI."}, 409
                elif busy:
                    body, code = {"success": False, "busy": True, "error": busy}, 409
                else:
                    save_comfy_settings(str(data.get("url") or ""), str(data.get("input_dir") or ""),
                                        str(data.get("output_dir") or ""), str(data.get("models_dir") or ""))
                    body, code = dict(comfy_settings_view(), success=True), 200
            except ValueError as e:        # a malformed address (json errors are ValueErrors too)
                body, code = {"success": False, "error": str(e)}, 400
            except Exception as e:
                print(f"[comfy] saving settings failed ({e})")
                body, code = {"success": False, "error": str(e)}, 500
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body, ensure_ascii=True).encode("utf-8"))
            return

        elif self.path == "/api/settings":
            # A changed setting from the page (game.js `prefs`), batched: body is {key: value}, a
            # null value forgetting that key. Also the beacon the page sends as it closes, so an
            # empty or unreadable body is answered, not raised.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                body, code = {"success": True, "settings": save_page_settings(data)}, 200
            except ValueError as e:        # not the page's own settings (json errors are ValueErrors too)
                body, code = {"success": False, "error": str(e)}, 400
            except Exception as e:
                print(f"[settings] saving failed ({e})")
                body, code = {"success": False, "error": str(e)}, 500
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body, ensure_ascii=True).encode("utf-8"))
            return

        elif self.path == "/api/open_folder":
            # The two folder buttons in the History window, and every model row in the About
            # window. The page cannot open a local folder itself, so the server does it with
            # ShellExecute. The body names a KEY, and only a key: either one of OPENABLE_FOLDERS'
            # two, or "model:<folder>" where <folder> is one of the model folders the graphs
            # actually load from (MODEL_FOLDER_NAMES), plus an optional "file" - the specific
            # filename that row is for, checked against MODEL_FILES_BY_FOLDER. No request can name
            # a path: both fields only ever pick among directories ComfyUI itself already named.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                which = data.get("which")
                model_folder = (which[6:] if isinstance(which, str) and which.startswith("model:")
                                else None)
                model_file = data.get("file")
                if not (isinstance(model_file, str)
                        and model_file in MODEL_FILES_BY_FOLDER.get(model_folder, ())):
                    model_file = None      # absent, or not a real file of this folder - ignored
                if model_folder is not None:
                    # A models folder can have more than one search path (extra_model_paths.yaml,
                    # ComfyUI Desktop's shared-models base), and a given file can live in any of
                    # them - comfy_model_file_dir finds the one that actually holds it, rather than
                    # always the first, which can be a different, empty directory. Without a
                    # recognised filename (e.g. the folder itself, or an older page), that's what
                    # comfy_model_dir already meant: the primary search path, where a new download
                    # would land.
                    name = "model" if model_folder in MODEL_FOLDER_NAMES else None
                    folder = None
                    if name:
                        try:
                            ensure_comfy()
                        except ComfyUnavailable:
                            pass          # reported below as a folder that isn't known
                        folder = (comfy_model_file_dir(model_folder, model_file) if model_file
                                 else comfy_model_dir(model_folder))
                else:
                    name = OPENABLE_FOLDERS.get(which) if isinstance(which, str) else None
                    if name == "COMFY_OUTPUT_DIR":
                        try:
                            ensure_comfy()    # the assets folder is ComfyUI's, found by asking it
                        except ComfyUnavailable:
                            pass              # reported below as a folder that isn't known
                    folder = globals().get(name) if name else None
                if name is None:
                    body, code = {"success": False,
                                  "error": "There is no folder called %r to open." % (which,)}, 400
                elif folder is None:
                    body, code = {"success": False,
                                  "error": ("ComfyUI's %s folder isn't known yet - start ComfyUI, "
                                            "then try again." % (model_folder or "output",))}, 503
                elif not os.path.isdir(folder) and name == "model":
                    # ComfyUI only makes a models subfolder once something puts a file there, so
                    # the folder a MISSING model belongs in is often missing too - and that is the
                    # one a player most wants shown. Open the nearest parent that does exist (the
                    # models root, normally) rather than dead-ending on "not there"; `wanted` says
                    # which folder was asked for, since it isn't the one that opened.
                    here = folder
                    while here and not os.path.isdir(here):
                        parent = os.path.dirname(here)
                        here = parent if parent and parent != here else None
                    if not here:
                        body, code = {"success": False, "path": folder,
                                      "error": "That folder is not there: %s" % folder}, 404
                    else:
                        _open_folder_now(here)
                        body, code = {"success": True, "path": here, "wanted": folder}, 200
                elif not os.path.isdir(folder):
                    # The assets folder lives outside the project - a ComfyUI reinstall can move
                    # it out from under us, so say where we looked rather than just failing.
                    body, code = {"success": False, "path": folder,
                                  "error": "That folder is not there: %s" % folder}, 404
                else:
                    _open_folder_now(folder)
                    body, code = {"success": True, "path": folder}, 200
            except Exception as e:
                print(f"[folder] open failed ({e})")
                body, code = {"success": False, "error": str(e)}, 500
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(body, ensure_ascii=True).encode("utf-8"))
            return

        elif self.path == "/api/cancel_generation":
            # Beaconed from the page's pagehide handler once the user has confirmed they
            # want to leave mid-generation. The browser is already tearing the page down, so
            # nothing here may block for long and nobody will read the reply - it exists so
            # a manual POST (or a fetch with keepalive) can still see what happened.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                if length:
                    self.rfile.read(length)
            except Exception:
                pass

            dropped = 0
            if gen_progress.get("is_generating"):
                if GEN_THREAD is not None and GEN_THREAD.is_alive():
                    _CANCELLED_RUNS.add(GEN_THREAD)
                dropped = cancel_comfy_jobs()
                # The worker unwinds on its own at the next checkpoint (and clears
                # is_generating in its finally), but flip it here too so a page reloading
                # right now doesn't briefly see a run it can no longer follow.
                gen_progress["is_generating"] = False
                gen_progress["completed_bundle"] = None
                gen_progress["error"] = None
                gen_progress["story"] = None
                gen_progress["percent"] = 0
                gen_progress["phase"] = ""
                gen_progress["status_message"] = "Generation cancelled - the page was closed."
                PROGRESS.end_plan()
                print(f"[cancel] run abandoned by the browser; {dropped} prompt(s) dropped")

            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "dropped": dropped},
                                            ensure_ascii=True).encode("utf-8"))
            except Exception:
                pass  # the page is gone - expected on the beacon path
            return


    def do_OPTIONS(self):
        # The page is same-origin and never preflights. This no longer grants CORS - it only
        # answers, and a cross-site preflight is refused like everything else.
        if self._refuse_cross_site():
            return
        self.send_response(204)
        self.end_headers()


class DungeonTCPServer(socketserver.TCPServer):
    """socketserver's own listen() backlog is 5, which is fine for a page that asks for one
    thing at a time and wrong for one that asks for a gridful. This server answers a single
    request at a time, so six tile pictures in flight fill the accepted connection plus the
    whole backlog, and the seventh - the star the player just clicked, the ending-job poll -
    is refused by the OS rather than queued, surfacing as "Failed to fetch". game.js fetches
    those pictures one at a time for the same reason (queueHistoryCard); this is the floor
    under that, so a burst from anywhere else waits its turn instead of being dropped."""
    request_queue_size = 64


def run_server():
    try:
        # 127.0.0.1 only: nothing else has ever connected, and a LAN-facing socket is what raises
        # the Windows Firewall prompt on a first run. Every copy binding the SAME address is also
        # what makes a second copy fail cleanly - measured on Windows, a 127.0.0.1 bind and a
        # wildcard ("") bind of one port both succeed side by side, SO_EXCLUSIVEADDRUSE or not.
        httpd = DungeonTCPServer(("127.0.0.1", PORT), DungeonHTTPRequestHandler)
    except OSError as e:
        # 10048 is Windows' "address in use" (a running copy of this server, or another program);
        # 10013 is what it says for a port inside a range Windows has reserved.
        if e.errno == errno.EADDRINUSE or getattr(e, "winerror", None) in (10048, 10013):
            print(f"Port {PORT} can't be used - ComfyCrawler is probably already running at "
                  f"http://127.0.0.1:{PORT} (or another program has that port). To run on a "
                  f"different port, set COMFYCRAWLER_PORT.")
            print("===== server exit %s =====" % time.strftime("%Y-%m-%d %H:%M:%S"))
            sys.exit(1)
        raise
    print(f"Starting ComfyCrawler Trio Server on http://127.0.0.1:{PORT}...")
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    PROGRESS.start()
    # The ComfyUI checklist, off the main thread: when ComfyUI isn't up yet every candidate URL
    # waits out its timeout, and the page should load meanwhile.
    threading.Thread(target=print_preflight, daemon=True).start()
    try:
        with httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("Server stopped (Ctrl+C).")
    except Exception:
        import traceback
        print("[FATAL] server loop crashed:")
        traceback.print_exc()
        raise
    finally:
        print("===== server exit %s =====" % time.strftime("%Y-%m-%d %H:%M:%S"))

if __name__ == "__main__":
    # One-off static audio asset generation - see generate_static_music_asset /
    # generate_ready_chime_asset. Does not touch PORT or start the HTTP server.
    # --gen-static-audio does the lot; --gen-<name>-music re-rolls one loop on a fresh seed,
    # which is the flag you actually want when a single track comes back wrong.
    single = [k for k in STATIC_MUSIC if f"--gen-{k}-music" in sys.argv]
    if any(arg.startswith("--gen-") for arg in sys.argv[1:]):
        ensure_comfy()   # every --gen- flag renders through ComfyUI; says why if it can't be found
    if "--gen-static-audio" in sys.argv:
        for key in STATIC_MUSIC:
            generate_static_music_asset(key)
        generate_ready_chime_asset()
    elif single:
        for key in single:
            generate_static_music_asset(key)
    elif "--gen-ready-chime" in sys.argv:
        generate_ready_chime_asset()
    elif "--gen-victory-candidates" in sys.argv:
        generate_victory_candidates()
    else:
        run_server()
