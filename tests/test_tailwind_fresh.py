"""The committed tailwind.css has every class index.html + game.js use today. The page no longer
loads Tailwind from its CDN, so a class added to either file renders only after a rebuild
(npm run tw:build, or the tw:watch start-server.bat runs) - this catches the one that was forgotten.

It checks for MISSING classes, not identical bytes: the watcher only ever adds, so after a class is
deleted from the HTML its rule lingers in tailwind.css until the next tw:build. That leftover is
harmless and reported as a note, not a failure.
Skipped, not failed, on a checkout without Node or `npm install`: playing never needs either."""
import os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "node_modules", "tailwindcss", "lib", "cli.js")
NODE = shutil.which("node")

if not (NODE and os.path.exists(CLI)):
    print("skipped (no node / node_modules - run npm install to check tailwind.css)")
    sys.exit(0)

# A class selector: a dot, then a name that starts with a letter, "-", "_" or an escape (so the
# ".5" in "opacity:.5" or "rgba(0,0,0,.25)" never counts), continuing through escapes like "\[".
CLASS_RE = re.compile(r"\.((?:[A-Za-z_-]|\\.)(?:[\w-]|\\.)*)")


def classes(css):
    # Comments out first: an unminified sheet's preflight comments cite URLs ("developer.mozilla.org",
    # "show_bug.cgi") that would otherwise read as classes.
    return set(CLASS_RE.findall(re.sub(r"/\*.*?\*/", "", css, flags=re.S)))


tmp = tempfile.mkdtemp(prefix="cc_tw_")
try:
    out = os.path.join(tmp, "tailwind.css")
    # Same flags as package.json's tw:build.
    done = subprocess.run([NODE, CLI, "-i", "tailwind.input.css", "-o", out, "--minify"],
                          cwd=ROOT, capture_output=True, text=True, timeout=300)
    if done.returncode != 0 or not os.path.exists(out):
        print("  FAIL: the tailwind build itself failed:\n" + (done.stderr or done.stdout)[-2000:])
        print("FAIL")
        sys.exit(1)
    with open(out, encoding="utf-8") as f:
        fresh = classes(f.read())
    with open(os.path.join(ROOT, "tailwind.css"), encoding="utf-8") as f:
        committed = classes(f.read())
finally:
    shutil.rmtree(tmp, ignore_errors=True)

missing = sorted(fresh - committed)
extra = sorted(committed - fresh)
if not fresh:
    print("  FAIL: a fresh build produced no classes - the check itself is broken")
    print("FAIL")
    sys.exit(1)
if missing:
    print(f"  FAIL: tailwind.css is missing {len(missing)} class(es) the page uses: {', '.join(missing[:12])}"
          + (" ..." if len(missing) > 12 else "") + "  - run: npm run tw:build")
    print("FAIL")
    sys.exit(1)
if extra:
    print(f"  note: {len(extra)} class(es) no longer used are still in tailwind.css (left by the watcher) - "
          "npm run tw:build drops them")
print(f"all tailwind checks passed ({len(fresh)} classes present)")
sys.exit(0)
