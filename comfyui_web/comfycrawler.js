// ComfyCrawler's button in ComfyUI's own interface: a "ComfyCrawler > Open ComfyCrawler" menu
// entry and an action-bar button, both opening the game in a new tab. ComfyUI loads every .js in
// this folder into its page, so this is the only file that may live here.
import { app } from "../../scripts/app.js";

const openComfyCrawler = () => {
  window.open(new URL("/comfycrawler/", window.location.origin).href, "_blank", "noopener");
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
