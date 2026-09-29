// Pinned to 3.4.17, the version cdn.tailwindcss.com was serving when the page moved off it, so
// the compiled sheet matches what the play CDN generated class-for-class.
// Every Tailwind class the page uses is a string literal in one of these two files (game.js
// assigns whole className strings, never builds them from pieces) - keep it that way, or the
// scanner will miss a class and it will silently not render.
// tw:watch polls (--poll) because this repo lives on a mapped network drive, where Node's native
// file watcher crashes on its first event ("UNKNOWN: unknown error, watch"). --watch=always keeps
// it alive when it's launched in the background with no stdin (Start ComfyCrawler.bat). --minify keeps
// its output in the same form tw:build commits. Watch mode only ever ADDS classes: one deleted
// from the HTML stays in tailwind.css until the next tw:build, which is harmless for rendering and
// is why tests/test_tailwind_fresh.py checks for missing classes rather than identical bytes.
module.exports = {
  // relative: resolved from this file (tailwind/), not from wherever the build is run.
  content: { relative: true, files: ["../web/index.html", "../web/game.js"] },
};
