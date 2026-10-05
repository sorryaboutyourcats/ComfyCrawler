"""Builds - and with --push, uploads - ComfyCrawler's itch.io page (sorryaboutyourcats/comfycrawler)
with itch's butler (https://itch.io/docs/butler/).

Usage:
    python tools/publish_itch.py [--budget-mb 480] [--push [--dry-run]]

Two channels, each built into its own folder under itch/ (gitignored):

  html5         itch/web - the showcase export (export_showcase.py), trimmed to fit itch's browser
                game limits: of the runs the full showcase at server.SAMPLE_DUNGEONS_URL lists
                right now, the first ones in gallery Default order up to --budget-mb, no
                trailers, and a link to that full showcase, which is also where its 🔗 buttons
                point. Checked against HTML5_LIMITS before anything is pushed.
  comfyui-node  itch/node/comfycrawler - the ComfyUI custom node: the git-tracked files minus
                .comfyignore, the same set `comfy node publish` sends the Registry, in a folder
                that unzips straight into custom_nodes/. A folder rather than a zip so butler's
                diff only sends what changed; itch hands players the zip.

Both are pushed with --userversion set to pyproject.toml's version and --if-changed, so pushing an
unchanged build is a no-op. butler is found on PATH or at %APPDATA%\\itch\\butler\\butler.exe, and
needs a one-time `butler login` first.

What butler cannot set is done once on the itch page's Edit screen: Kind of project = HTML, and
"This file will be played in the browser" on the html5 upload.
"""
import argparse
import fnmatch
import json
import os
import re
import shutil
import subprocess  # noqa: S404 - git and butler, run by hand; never shipped (.comfyignore drops tools/)
import sys
import urllib.request

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.normpath(os.path.join(TOOLS_DIR, os.pardir))
sys.path.insert(0, REPO_DIR)
sys.path.insert(0, TOOLS_DIR)
import server  # noqa: E402
import export_showcase  # noqa: E402

ITCH_GAME = "sorryaboutyourcats/comfycrawler"
ITCH_DIR = os.path.join(REPO_DIR, "itch")
WEB_OUT = os.path.join(ITCH_DIR, "web")
NODE_OUT = os.path.join(ITCH_DIR, "node")
NODE_FOLDER = "comfycrawler"

# https://itch.io/docs/creators/html5 - an upload over any of these won't play in the browser.
# The 500 MB total can be raised by asking itch support; the budget below stays under the default.
HTML5_LIMITS = {"total_bytes": 500 * 1048576, "files": 1000, "file_bytes": 200 * 1048576,
                "path_chars": 240}
DEFAULT_BUDGET_MB = 480


def html5_problems(root, limits=HTML5_LIMITS):
    """Everything about the folder at `root` that breaks itch's HTML5 limits, as sentences.
    Empty when it fits."""
    problems = []
    total = count = 0
    for folder, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(folder, name)
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            size = os.path.getsize(path)
            total += size
            count += 1
            if size > limits["file_bytes"]:
                problems.append(f"{rel} is {size / 1048576:.0f} MB "
                                f"(limit {limits['file_bytes'] // 1048576} MB a file)")
            if len(rel) > limits["path_chars"]:
                problems.append(f"{rel} has a {len(rel)}-character path "
                                f"(limit {limits['path_chars']})")
    if not os.path.exists(os.path.join(root, "index.html")):
        problems.append("no index.html at the top of the folder")
    if total > limits["total_bytes"]:
        problems.append(f"{total / 1048576:.0f} MB in all (limit "
                        f"{limits['total_bytes'] // 1048576} MB)")
    if count > limits["files"]:
        problems.append(f"{count} files (limit {limits['files']})")
    return problems


def read_comfyignore(path=os.path.join(REPO_DIR, ".comfyignore")):
    patterns = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("!"):
                raise SystemExit(f"[itch] .comfyignore negation '{line}' isn't supported here - "
                                 "teach comfyignored() about it")
            patterns.append(line)
    return patterns


def comfyignored(rel, patterns):
    """Whether .comfyignore leaves the repo-relative path `rel` (forward slashes) out of the
    package, read the way .gitignore is: a trailing / matches directories only, a pattern with a
    / in it is anchored at the repo root, one without matches a name at any depth."""
    parts = rel.split("/")
    for pat in patterns:
        dir_only = pat.endswith("/")
        pat = pat.strip("/")
        # A file's own name can't satisfy a directory-only pattern - only its parent folders can.
        last = len(parts) - 1 if dir_only else len(parts)
        if "/" in pat:
            if any(fnmatch.fnmatchcase("/".join(parts[:i]), pat) for i in range(1, last + 1)):
                return True
        elif any(fnmatch.fnmatchcase(part, pat) for part in parts[:last]):
            return True
    return False


def node_files():
    """The repo-relative paths the ComfyUI node ships: git-tracked, not .comfyignored."""
    out = subprocess.run(["git", "ls-files", "-z"], cwd=REPO_DIR, capture_output=True,  # noqa: S603, S607
                         check=True).stdout.decode("utf-8")
    patterns = read_comfyignore()
    return sorted(p for p in out.split("\0") if p and not comfyignored(p, patterns))


def stage_node(out_dir=NODE_OUT):
    """Mirrors node_files() into out_dir/comfycrawler, copying only what changed (size/mtime)
    and deleting what no longer ships. Returns (files, bytes, copied)."""
    dest_root = os.path.join(out_dir, NODE_FOLDER)
    files = node_files()
    wanted = set()
    total = copied = 0
    for rel in files:
        src = os.path.join(REPO_DIR, rel)
        if not os.path.isfile(src):
            continue  # tracked but deleted in the working tree
        dest = os.path.join(dest_root, rel)
        wanted.add(os.path.normcase(os.path.normpath(dest)))
        st = os.stat(src)
        total += st.st_size
        try:
            dst = os.stat(dest)
        except FileNotFoundError:
            dst = None
        if dst is not None and dst.st_size == st.st_size and abs(dst.st_mtime - st.st_mtime) < 2:
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(src, dest)
        copied += 1
    for folder, _dirs, names in os.walk(dest_root, topdown=False):
        for name in names:
            path = os.path.join(folder, name)
            if os.path.normcase(os.path.normpath(path)) not in wanted:
                os.remove(path)
        if folder != dest_root and not os.listdir(folder):
            os.rmdir(folder)
    return len(wanted), total, copied


def full_showcase_ids(url=server.SAMPLE_DUNGEONS_URL):
    """The ids the full showcase's gallery lists right now (its live dungeons.json, unlisted runs
    left out). The itch build is cut from exactly these, so every 🔗 link it hands out opens and
    its "N of M" is the M a visitor finds there - even when runs starred here since that site was
    last uploaded would otherwise sneak in. Raises SystemExit when the site can't be read."""
    try:
        with urllib.request.urlopen(url + "dungeons.json", timeout=30) as res:  # noqa: S310 - fixed https URL
            rows = json.load(res).get("sessions") or []
    except (OSError, ValueError) as err:
        raise SystemExit(f"[itch] couldn't read {url}dungeons.json ({err}) - the itch build is cut "
                         "from that gallery, so it needs the site reachable.") from err
    return [r["id"] for r in rows
            if isinstance(r, dict) and isinstance(r.get("id"), str) and not r.get("unlisted")]


def project_version():
    with open(os.path.join(REPO_DIR, "pyproject.toml"), encoding="utf-8") as f:
        m = re.search(r'^version\s*=\s*"([^"]+)"', f.read(), re.M)
    if not m:
        raise SystemExit("[itch] no version = \"...\" in pyproject.toml")
    return m.group(1)


def find_butler():
    found = shutil.which("butler")
    if found:
        return found
    local = os.path.join(os.environ.get("APPDATA", ""), "itch", "butler", "butler.exe")
    if os.path.isfile(local):
        return local
    raise SystemExit("[itch] butler not found - install it (https://itch.io/docs/butler/installing.html) "
                     "into %APPDATA%\\itch\\butler\\ or onto PATH, then run `butler login` once.")


def dirty_tracked_files():
    out = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=REPO_DIR,  # noqa: S603, S607
                         capture_output=True, check=True, text=True).stdout
    return [line[3:] for line in out.splitlines() if line.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--budget-mb", type=float, default=DEFAULT_BUDGET_MB,
                        help=f"Size cap for the whole html5 build (default {DEFAULT_BUDGET_MB}; "
                             "itch's limit is 500)")
    parser.add_argument("--push", action="store_true", help="Upload both channels with butler")
    parser.add_argument("--dry-run", action="store_true",
                        help="With --push: have butler list what it would send, sending nothing")
    args = parser.parse_args()

    version = project_version()
    dirty = dirty_tracked_files()
    if dirty:
        print(f"[itch] note: {len(dirty)} tracked file(s) have uncommitted changes and ship as they "
              "are on disk: " + ", ".join(dirty[:8]) + (" ..." if len(dirty) > 8 else ""))

    print(f"[itch] html5 -> {WEB_OUT}")
    ids = full_showcase_ids()
    os.makedirs(ITCH_DIR, exist_ok=True)
    ids_path = os.path.join(ITCH_DIR, "full_showcase_ids.txt")
    with open(ids_path, "w", encoding="utf-8") as f:
        f.write(f"# {server.SAMPLE_DUNGEONS_URL}dungeons.json's gallery, read by publish_itch.py\n")
        f.write("\n".join(ids) + "\n")
    print(f"[itch] cutting from the {len(ids)} run(s) {server.SAMPLE_DUNGEONS_URL} lists")
    export_showcase.export_showcase(WEB_OUT, ids_path, budget_mb=args.budget_mb, trailers=False,
                                    full_url=server.SAMPLE_DUNGEONS_URL, full_count=len(ids))
    problems = html5_problems(WEB_OUT)
    if problems:
        raise SystemExit("[itch] the html5 build won't fit itch's limits:\n  " + "\n  ".join(problems))
    count = sum(len(files) for _d, _s, files in os.walk(WEB_OUT))
    size = sum(os.path.getsize(os.path.join(d, n)) for d, _s, files in os.walk(WEB_OUT) for n in files)
    print(f"[itch] html5 fits: {count} files, {size / 1048576:.1f} MB")

    files, size, copied = stage_node()
    print(f"[itch] comfyui-node -> {os.path.join(NODE_OUT, NODE_FOLDER)}: {files} files, "
          f"{size / 1048576:.1f} MB ({copied} copied)")

    if not args.push:
        print(f"[itch] built v{version}. Upload with: python tools/publish_itch.py --push")
        return
    butler = find_butler()
    for folder, channel in ((WEB_OUT, "html5"), (NODE_OUT, "comfyui-node")):
        cmd = [butler, "push", folder, f"{ITCH_GAME}:{channel}", "--userversion", version,
               "--if-changed"]
        if args.dry_run:
            cmd.append("--dry-run")
        print("[itch] " + " ".join(cmd[1:]), flush=True)
        subprocess.run(cmd, check=True)  # noqa: S603
    if not args.dry_run:
        subprocess.run([butler, "status", ITCH_GAME], check=False)  # noqa: S603


if __name__ == "__main__":
    main()
