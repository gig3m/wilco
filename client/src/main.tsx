import { render } from "preact";
import { api } from "./lib/api";
import { App } from "./ui/App";

/**
 * The real entry point. Task 1's placeholder (a bare `<div>Wilco</div>`)
 * proved out the build pipeline end to end -- `vite build` ->
 * `client/dist/index.html` -> the hashed JS asset -> this file -> a
 * rendered DOM node -- but never actually mounted `ui/App.tsx`. Every task
 * since (5 through 10) built and wired real screens into `App`, and every
 * one of them was fully covered by its own component/App-level tests, so
 * nothing caught that the PRODUCTION build never rendered any of it --
 * exactly the class of bug this plan's standing ruling (Task 6: "the shell
 * rendered a placeholder while the real component sat unreferenced, and no
 * test caught it") warns about, just one level up, at the entry point
 * instead of inside the shell. Found and fixed as part of Task 10 while
 * verifying the keyboard layer against a real browser (Step 5) -- headless
 * Chromium against the built `dist/` showed the Task 1 placeholder, not the
 * app, which is what surfaced this.
 *
 * `api` is `lib/api.ts`'s production instance, bound to `globalThis.fetch`
 * with the session cookie (`credentials: "same-origin"`) -- the SPA holds
 * no credential of its own (spec 3.1). No `history` prop is passed, so
 * `App` falls back to its own `createBrowserHistory()`, the real
 * `window.history`/`popstate` wiring.
 */
const root = document.getElementById("app");
if (root) render(<App api={api} />, root);
