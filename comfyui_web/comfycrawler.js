// ComfyCrawler inside ComfyUI's own interface: a "ComfyCrawler > Open ComfyCrawler" menu entry and
// an action-bar button that open the game in a new tab, plus a sidebar panel showing what this
// machine's ComfyUI still needs and letting the missing models be downloaded from there. ComfyUI
// loads every .js in this folder into its page, so this is the only file that may live here.
import { app } from "../../scripts/app.js";

const url = (path) => new URL(path, window.location.origin).href;
const openComfyCrawler = () => {
  window.open(url("/comfycrawler/"), "_blank", "noopener");
};

app.registerExtension({
  name: "ComfyCrawler.OpenButton",
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
  // null, or how far the Restart ComfyUI button has got: "ask" (are you sure?), "force" (no
  // ComfyUI-Manager - shall ComfyCrawler do it itself?), "going" (waiting for it to come back).
  let restart = null;
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
  root.append(statusBox, groupBox, actionBox, noteBox);

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
      job.group, job.state, confirmingCancel, restart,
    ]);
  }

  // ---- Restart ComfyUI ----
  // The fix for the state server.py's _comfy_system_stats describes: after the computer sleeps,
  // ComfyUI keeps answering but has lost the graphics card, and only starting its server again
  // brings it back. ComfyUI's own top-bar circular arrow doesn't do that - it refreshes node
  // definitions - which is exactly why this button is here, next to the error that asks for it.
  async function doRestart(confirmed) {
    setNote("Asking ComfyUI to restart…");
    render(true);
    const { status, data } = await postJSON("/comfycrawler/node/restart_comfyui", { confirmed });
    if (status === 404) {
      restart = null;
      setNote("This ComfyUI is running an older ComfyCrawler, which has no restart. Stop and start "
              + "ComfyUI's server yourself.");
    } else if (data && data.needs_confirm) {
      restart = "force";
      setNote(data.error);
    } else if (!data || !data.success) {
      restart = null;
      setNote((data && data.error) || "ComfyUI wouldn't restart - see its log.");
    } else {
      restart = "going";
      setNote("ComfyUI is restarting. This panel picks up again on its own; if it hasn't in a "
              + "minute or two, start ComfyUI yourself.");
      waitForComfyUI();
    }
    render(true);
  }

  // It goes away before it comes back, so a failed fetch is the expected middle - only an answer
  // ends the wait. Two minutes is longer than a cold ComfyUI start with every custom node loading.
  async function waitForComfyUI() {
    const deadline = Date.now() + 120000;
    let wasDown = false;
    while (!stopped && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (stopped) return;
      try {
        const res = await fetch(url("/api/system_stats"), { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));   // up again, but still no graphics card
        if (wasDown) {
          restart = null;
          setNote("ComfyUI is back. Reload this browser tab if anything looks stale.");
          await refresh();
          return;
        }
      } catch (err) {
        wasDown = true;     // it has gone down: from here, the next good answer is the new one
      }
    }
    if (stopped) return;
    restart = null;
    setNote("ComfyUI hasn't come back on its own - start it again, then reload this tab.");
    render(true);
  }

  function restartButtons() {
    if (restart === "going") {
      return [el("span", "font-size:11px;opacity:0.8;align-self:center;", "⟲ Restarting ComfyUI…")];
    }
    if (restart) {
      const go = button(restart === "force" ? "Restart anyway" : "Yes, restart ComfyUI",
        "Start ComfyUI's server again", () => doRestart(restart === "force"), true);
      go.dataset.autofocus = "1";
      return [button("Not now", "Leave ComfyUI running", () => { restart = null; setNote(""); render(true); }), go];
    }
    return [button("⟲ Restart ComfyUI", "Start ComfyUI's server again - the fix when it has lost "
      + "the graphics card, which is what sleeping the computer does to it", () => {
        restart = "ask";
        setNote("Restarting ComfyUI stops ComfyCrawler with it and both come back together. "
                + "Saved dungeons are files on disk and aren't touched.");
        render(true);
      })];
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
        statusBox.append(el("div", "font-size:11px;opacity:0.8;margin-top:4px;",
          "Use ⟲ Restart ComfyUI below. ComfyUI's own ↻ button only refreshes node definitions, "
          + "which won't clear this."));
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
      ...restartButtons(),
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
      icon: "pi pi-compass",
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
