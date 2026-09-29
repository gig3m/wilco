// Runs BEFORE the first paint, as a plain blocking script in <head> (the
// SPA's CSP is script-src 'self', so it is a file, not an inline block).
// The theme preference lives on the server and arrives ~half a second
// after the page has painted; without this, every load flashed the light
// palette first and the owner read that as "dark mode is not persisted"
// (2026-09-08). The app mirrors each applied theme into localStorage
// (lib/theme.ts); this reads the mirror and stamps the document. No mirror
// (a fresh browser) leaves the attribute unset so the OS preference applies
// until the server answers. The server stays the source of truth.
(function () {
  try {
    var t = localStorage.getItem("wilco.theme");
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();
