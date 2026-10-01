"""Offline checks on the machine-play pieces: llms.txt is served beside the page (standalone and,
through the same handler, inside ComfyUI), the page still loads with ?agent on the address, the
showcase export ships llms.txt, and llms.txt documents every method window.ComfyCrawler has - and
nothing it does not - so the manual and the interface cannot drift apart unnoticed.
Needs neither ComfyUI nor a browser; playing a whole run through the interface is a headless-Chrome
job (see the headless-chrome notes), not something a script here can do."""
import importlib.util, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)
spec = importlib.util.spec_from_file_location("comfy_node", os.path.join(ROOT, "comfy_node.py"))
cn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cn)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import export_showcase  # noqa: E402

fails = []
def ck(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL:", msg)

with open(os.path.join(ROOT, "web", "llms.txt"), "rb") as f:
    LLMS = f.read()
with open(os.path.join(ROOT, "web", "game.js"), encoding="utf-8") as f:
    GAME = f.read()
with open(os.path.join(ROOT, "web", "index.html"), encoding="utf-8") as f:
    PAGE = f.read()

# ---- served beside the page ----
status, pairs, body = cn.forward(srv, "GET", "/llms.txt", [])
headers = {k.lower(): v for k, v in pairs}
ck(status == 200, f"GET /llms.txt answers 200 (got {status})")
ck(headers.get("content-type", "").startswith("text/plain"), "llms.txt is served as text/plain")
ck(body == LLMS, "GET /llms.txt serves the file byte for byte")

for path in ("/?agent", "/index.html?agent", "/?agent=1"):
    status, pairs, body = cn.forward(srv, "GET", path, [])
    ck(status == 200 and b"<title>" in body, f"GET {path} still serves the page (got {status})")

ck("llms.txt" in export_showcase.STATIC_SHELL_FILES, "the showcase export ships llms.txt")
ck('rel="help" href="llms.txt"' in PAGE, "index.html links llms.txt for agents reading the page source")

# ---- the manual matches the interface ----
m = re.search(r"\n    const ComfyCrawler = \{\r?\n(.*?)\r?\n    \};", GAME, re.S)
ck(m is not None, "found the window.ComfyCrawler object in game.js")
if m:
    # Only the object's own top-level members: four-space-deeper lines that open a method or key.
    members = set(re.findall(r"^      (?:async )?([A-Za-z]\w*)(?:\(|:)", m.group(1), re.M))
    members.discard("version")
    ck(len(members) >= 15, f"read the interface's methods ({sorted(members)})")
    text = LLMS.decode("utf-8")
    for name in sorted(members):
        ck(re.search(r"\b" + name + r"\(", text), f"llms.txt documents ComfyCrawler.{name}()")
    documented = set(re.findall(r"`(?:cc\.|ComfyCrawler\.)?([a-z]\w*)\(", text))
    for name in sorted(documented - members):
        if name in ("help",):
            continue
        ck(False, f"llms.txt documents {name}(), which window.ComfyCrawler does not have")

# ---- agent mode's two switches exist where llms.txt says they do ----
ck("has('agent')" in GAME, "game.js reads ?agent from the address")
ck("data-agent-report" in PAGE and PAGE.count("data-agent-report") >= 2,
   "the victory and death boxes both carry the agent run report")

if fails:
    print("FAIL")
    sys.exit(1)
print("all agent-play checks passed")
