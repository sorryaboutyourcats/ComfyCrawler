// ComfyCrawler inside ComfyUI's own interface: a "ComfyCrawler > Open ComfyCrawler" menu entry and
// an action-bar button that open the game in a new tab, plus a sidebar panel showing what this
// machine's ComfyUI still needs and letting the missing models be downloaded from there. ComfyUI
// loads every .js in this folder into its page, so this is the only file that may live here.
import { app } from "../../scripts/app.js";

const url = (path) => new URL(path, window.location.origin).href;
const openComfyCrawler = () => {
  window.open(url("/comfycrawler/"), "_blank", "noopener");
};
const GITHUB_URL = "https://github.com/sorryaboutyourcats/ComfyCrawler";
// Also written in the About box's title bar in index.html and in pyproject.toml (as 0.111.2) - bump all three.
const APP_VERSION = "v0.111.2";

// registerSidebarTab's `icon` becomes an <i class="{icon} side-bar-button-icon">, sized by
// font-size alone - so a plain CSS class with a background-image stands in for a PrimeIcons glyph,
// letting the tab use the upscaled favicon (icon.png) instead of a generic compass icon.
const iconStyle = document.createElement("style");
iconStyle.textContent = `.comfycrawler-sidebar-icon {
  display: inline-block; width: 1em; height: 1em;
  background-image: url("${url("/comfycrawler/icon.png")}");
  background-size: contain; background-position: center; background-repeat: no-repeat;
}`;
document.head.appendChild(iconStyle);

// Whether the top-bar button shows. Kept as a ComfyUI setting (on the server, per ComfyUI user)
// rather than in localStorage, so it holds for every address ComfyUI is opened from. The button is
// hidden with CSS: ComfyUI builds its action-bar buttons once from the extension list, but it does
// put each one's `class` on the rendered button. The menu entry and the sidebar tab stay either
// way, so the game is always one click away.
const SHOW_BUTTON_SETTING = "ComfyCrawler.ShowTopBarButton";
const TOPBAR_BUTTON_CLASS = "comfycrawler-topbar-button";
const topbarStyle = document.createElement("style");
document.head.appendChild(topbarStyle);

function showTopBarButton(show) {
  topbarStyle.textContent = show ? "" : `.${TOPBAR_BUTTON_CLASS} { display: none !important; }`;
  // Keep any open sidebar panel's checkbox in step with a change made from ComfyUI's Settings.
  document.querySelectorAll(".comfycrawler-topbar-toggle").forEach((box) => { box.checked = !!show; });
}

function topBarButtonShown() {
  const value = app.extensionManager?.setting?.get(SHOW_BUTTON_SETTING);
  return value === undefined ? true : !!value;
}

app.registerExtension({
  name: "ComfyCrawler.OpenButton",
  settings: [
    {
      id: SHOW_BUTTON_SETTING,
      category: ["ComfyCrawler", "Top bar", "Show button"],
      name: "Show the ComfyCrawler button in the top bar",
      tooltip: "The game also opens from ComfyUI's menu (ComfyCrawler > Open ComfyCrawler) and the ComfyCrawler sidebar tab.",
      type: "boolean",
      defaultValue: true,
      onChange: (value) => showTopBarButton(value !== false),
    },
  ],
  setup() {
    showTopBarButton(topBarButtonShown());
  },
  commands: [
    {
      id: "ComfyCrawler.Open",
      label: "Open ComfyCrawler",
      icon: "pi pi-external-link",
      function: openComfyCrawler,
    },
  ],
  menuCommands: [{ path: ["ComfyCrawler"], commands: ["ComfyCrawler.Open"] }],
  actionBarButtons: [
    {
      icon: "pi pi-external-link",
      label: "ComfyCrawler",
      tooltip: "Open ComfyCrawler in a new tab",
      class: TOPBAR_BUTTON_CLASS,
      onClick: openComfyCrawler,
    },
  ],
});

// ---------------------------------------------------------------------------
// The sidebar panel. Deliberately not a graph node: a node would live inside saved workflow
// documents (and show as missing for anyone without ComfyCrawler), where this is just a panel.
// It talks to the same endpoints the game's own setup screen uses - server.py's comfy_preflight
// and MODEL DOWNLOADS section - so a download started here and one started there are the same
// one-at-a-time job, and either can see and stop the other.

const DOWNLOAD_POLL_MS = 1000;   // while one is running, so the bar moves
const IDLE_POLL_MS = 5000;       // otherwise, so a download started from the game page shows up here too

async function getJSON(path) {
  const res = await fetch(url(path), { cache: "no-store" });
  return res.json();
}

async function postJSON(path, body) {
  const res = await fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function sizeText(bytes) {
  if (!bytes) return "";
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, title, onClick, primary) {
  const b = el("button", `padding:3px 8px;font-size:11px;cursor:pointer;border-radius:4px;
    border:1px solid var(--border-color,#4e4e4e);
    background:${primary ? "var(--comfy-input-bg,#222)" : "transparent"};
    color:var(--input-text,#ddd);`, label);
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function jobActive(job) {
  return !!job && (job.state === "queued" || job.state === "downloading");
}

function createPanel(root) {
  let report = null;
  let job = { group: null, state: "idle" };
  let note = "";            // the last thing that happened, shown under the buttons
  let confirmingCancel = null;   // a group label, while its Cancel is asking "sure?"
  let timer = null;
  let stopped = false;
  let lastShape = "";       // rebuild only when the rows actually change, so focus survives a poll
  let liveText = null;
  let liveBar = null;

  root.style.cssText = "display:flex;flex-direction:column;gap:10px;padding:10px;height:100%;" +
    "overflow-y:auto;font-size:12px;color:var(--fg-color,#ddd);box-sizing:border-box;";

  const statusBox = el("div", "line-height:1.5;");
  const groupBox = el("div", "display:flex;flex-direction:column;gap:8px;");
  const actionBox = el("div", "display:flex;flex-wrap:wrap;gap:6px;");
  const noteBox = el("div", "font-size:11px;opacity:0.75;line-height:1.4;white-space:pre-wrap;");
  const footer = el("div", "margin-top:auto;padding-top:8px;border-top:1px solid var(--border-color,#4e4e4e);" +
    "display:flex;justify-content:space-between;align-items:baseline;gap:8px;");
  const githubLink = document.createElement("a");
  githubLink.href = GITHUB_URL;
  githubLink.target = "_blank";
  githubLink.rel = "noopener";
  githubLink.textContent = "ComfyCrawler on GitHub";
  githubLink.style.cssText = "color:var(--fg-color,#ddd);opacity:0.75;font-size:11px;text-decoration:none;";
  githubLink.addEventListener("mouseenter", () => { githubLink.style.textDecoration = "underline"; });
  githubLink.addEventListener("mouseleave", () => { githubLink.style.textDecoration = "none"; });
  const versionTag = el("span", "opacity:0.6;font-size:11px;", APP_VERSION);
  footer.append(githubLink, versionTag);

  // Built once, outside render(), so a poll never rebuilds it out from under the keyboard.
  const toggleRow = el("label", "display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "comfycrawler-topbar-toggle";
  toggle.checked = topBarButtonShown();
  toggle.addEventListener("change", async () => {
    showTopBarButton(toggle.checked);
    try {
      await app.extensionManager.setting.set(SHOW_BUTTON_SETTING, toggle.checked);
    } catch (err) {
      setNote("Couldn't save that setting - it lasts until this page is reloaded.");
    }
  });
  toggleRow.append(toggle, document.createTextNode("Show the ComfyCrawler button in the top bar"));

  root.append(statusBox, groupBox, actionBox, toggleRow, noteBox, footer);

  const setNote = (text) => { note = text; noteBox.textContent = text; };

  // A group's own download, when it still has something to say. A *finished* one deliberately
  // doesn't: model_download_job_view keeps reporting the last job for ever, so counting "done" here
  // would pin the row open after its files are in - a Download button with no size and nothing left
  // to download, that no amount of Check again could clear.
  function jobToShow(label) {
    const mine = job.group === label ? job : null;
    if (!mine) return null;
    return jobActive(mine) || mine.state === "failed" || mine.state === "cancelled" ? mine : null;
  }

  function groupRow(g) {
    const mine = jobToShow(g.label);
    const active = jobActive(mine);
    const row = el("div", `border:1px solid var(--border-color,#4e4e4e);border-radius:4px;
      padding:6px 8px;display:flex;flex-direction:column;gap:5px;`);

    const head = el("div", "display:flex;align-items:center;justify-content:space-between;gap:8px;");
    head.append(el("span", "font-weight:600;", g.label));

    if (active) {
      if (confirmingCancel === g.label) {
        const keep = button("Keep", "Carry on downloading", () => { confirmingCancel = null; render(true); });
        const stop = button("Stop", "Stop this download", async () => {
          confirmingCancel = null;
          const { data } = await postJSON("/comfycrawler/api/model_download_cancel", { group: g.label });
          setNote(data && data.stopped ? `Stopped ${g.label}. What downloaded so far is kept.`
                                       : `${g.label} had already finished.`);
          poll();
        });
        head.append(el("span", "display:flex;gap:4px;", ""), keep, stop);
      } else {
        head.append(button("Cancel", "Stop this download", () => { confirmingCancel = g.label; render(true); }));
      }
    } else {
      const size = sizeText(g.missing_bytes);
      const label = (mine && mine.state === "failed" ? "Try again" : "Download") + (size ? ` — ${size}` : "");
      const b = button(label, `Download into ComfyUI's own models folders`, async () => {
        const { ok, status, data } = await postJSON("/comfycrawler/api/model_download_start", { group: g.label });
        if (status === 404) {
          setNote("This ComfyUI is running an older ComfyCrawler. Press Reload server.py, or restart ComfyUI.");
        } else if (data && data.state === "busy") {
          setNote(data.error || "Something else is already downloading.");
        } else if (data && data.state === "failed") {
          setNote(data.error || "Could not start that download.");
        } else if (!ok) {
          setNote("The server refused that download.");
        } else {
          setNote("");
        }
        poll();
      }, true);
      b.disabled = jobActive(job) && job.group !== g.label;
      if (b.disabled) {
        b.style.opacity = "0.5";
        b.style.cursor = "default";
        b.title = `Already downloading ${job.group}.`;
      }
      head.append(b);
    }
    row.append(head);

    if (!g.required) {
      row.append(el("div", "font-size:11px;opacity:0.7;", `Optional — without it, ${g.fallback}`));
    }

    if (active) {
      const line = el("div", "font-size:11px;opacity:0.8;",
        `${mine.file || ""} (${(mine.file_index || 0) + 1}/${mine.file_count || 1}) — ${mine.percent || 0}%`);
      const trough = el("div", `height:6px;border-radius:3px;overflow:hidden;
        background:var(--comfy-input-bg,#222);border:1px solid var(--border-color,#4e4e4e);`);
      const fill = el("div", `height:100%;width:${Math.max(0, Math.min(100, mine.percent || 0))}%;
        background:#3b7dd8;`);
      trough.append(fill);
      row.append(line, trough);
      liveText = line;
      liveBar = fill;
    } else if (mine && mine.state === "failed") {
      row.append(el("div", "font-size:11px;color:var(--error-text,#f77);", mine.error || "The download failed."));
    } else if (mine && mine.state === "cancelled") {
      row.append(el("div", "font-size:11px;opacity:0.7;", "Stopped — Download picks up where it left off."));
    } else {
      row.append(el("div", "font-size:11px;opacity:0.7;",
        g.missing.map((m) => `${m.file} → models/${m.folder}/`).join("\n")));
    }
    return row;
  }

  // Which rows exist and in what state - a poll that doesn't change this only nudges the live
  // progress line, so the Cancel button doesn't lose focus every second.
  function shapeOf() {
    const groups = (report && report.groups) || [];
    return JSON.stringify([
      report && report.comfy && report.comfy.error,
      report && report.ready,
      groups.map((g) => [g.label, g.missing.length, g.missing_bytes]),
      job.group, job.state, confirmingCancel,
    ]);
  }

  function render(force) {
    const shape = shapeOf();
    if (!force && shape === lastShape) {
      if (liveText && jobActive(job)) {
        liveText.textContent = `${job.file || ""} (${(job.file_index || 0) + 1}/${job.file_count || 1}) — ${job.percent || 0}%`;
        liveBar.style.width = `${Math.max(0, Math.min(100, job.percent || 0))}%`;
      }
      return;
    }
    lastShape = shape;
    liveText = liveBar = null;

    statusBox.replaceChildren();
    if (!report) {
      statusBox.append(el("div", "opacity:0.7;", "Asking ComfyCrawler…"));
    } else if (report.comfy && report.comfy.error) {
      statusBox.append(el("div", "color:var(--error-text,#f77);", `⛔ ${report.comfy.error}`));
      if (report.comfy.restart) {
        // ComfyCrawler used to offer a button that tried this itself - unreliable enough
        // (ComfyUI-Manager's security level, an unusual launcher, ComfyUI Desktop's own process
        // wrapper) that it now just says what fixes it and leaves the doing to the player.
        statusBox.append(el("div", "font-size:11px;opacity:0.8;margin-top:4px;",
          "Stop ComfyUI and start it again yourself. Its own ↻ button only refreshes node "
          + "definitions and won't clear this."));
      }
    } else {
      statusBox.append(el("div", "", `ComfyUI ${report.comfy.version || "?"} — ${report.ready ? "✔ ready to make dungeons" : "⛔ missing something a dungeon needs"}`));
      const badNode = (report.nodes || []).filter((n) => n.required && !n.present);
      for (const n of badNode) {
        statusBox.append(el("div", "color:var(--error-text,#f77);", `Missing node ${n.name} — install ${n.pack}`));
      }
    }

    groupBox.replaceChildren();
    const groups = ((report && report.groups) || []).filter((g) => g.missing.length || jobToShow(g.label));
    const required = groups.filter((g) => g.required);
    const optional = groups.filter((g) => !g.required);
    if (required.length) {
      groupBox.append(el("div", "font-weight:700;font-size:11px;letter-spacing:0.04em;opacity:0.8;", "REQUIRED"));
      required.forEach((g) => groupBox.append(groupRow(g)));
    }
    if (optional.length) {
      groupBox.append(el("div", "font-weight:700;font-size:11px;letter-spacing:0.04em;opacity:0.8;", "OPTIONAL EXTRAS"));
      optional.forEach((g) => groupBox.append(groupRow(g)));
    }
    if (!groups.length && report && !(report.comfy && report.comfy.error)) {
      groupBox.append(el("div", "opacity:0.7;", "Every model ComfyCrawler uses is installed."));
    }

    actionBox.replaceChildren(
      button("▶ Open ComfyCrawler", "Open the game in a new tab", openComfyCrawler, true),
      button("↻ Check again", "Ask ComfyUI what it has now", async () => {
        setNote("");
        await refresh();
      }),
      button("⟳ Reload server.py", "Pick up an updated ComfyCrawler without restarting ComfyUI", async () => {
        setNote("Reloading…");
        const { data } = await postJSON("/comfycrawler/node/reload", {});
        setNote(data && data.success
          ? "server.py reloaded. Refresh any open ComfyCrawler tab to match."
          : (data && data.error) || "Reload failed - see ComfyUI's log.");
        await refresh();
      }),
    );
    noteBox.textContent = note;
    // The confirm replaces the button that was just pressed, so move focus onto it - otherwise a
    // keyboard press lands on nothing and the question can't be answered without the mouse.
    const focusMe = actionBox.querySelector("[data-autofocus]");
    if (focusMe) focusMe.focus();
  }

  async function refresh() {
    try {
      report = await getJSON("/comfycrawler/api/preflight");
    } catch (err) {
      report = null;
    }
    render(true);
  }

  async function poll() {
    if (stopped) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const was = jobActive(job);
    try {
      job = await getJSON("/comfycrawler/api/model_download_job");
    } catch (err) { /* server away for a moment */ }
    if (stopped) return;
    render();
    if (was && !jobActive(job)) {
      if (job.state === "done") setNote(`${job.group} finished downloading.`);
      await refresh();
    }
    timer = setTimeout(poll, jobActive(job) ? DOWNLOAD_POLL_MS : IDLE_POLL_MS);
  }

  refresh().then(poll);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

app.registerExtension({
  name: "ComfyCrawler.Sidebar",
  async setup() {
    let teardown = null;
    app.extensionManager.registerSidebarTab({
      id: "comfycrawler",
      icon: "comfycrawler-sidebar-icon",
      title: "ComfyCrawler",
      tooltip: "ComfyCrawler: models, downloads and the game",
      type: "custom",
      render: (element) => {
        if (teardown) teardown();
        teardown = createPanel(element);
      },
      destroy: () => {
        if (teardown) teardown();
        teardown = null;
      },
    });
  },
});
