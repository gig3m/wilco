// @vitest-environment happy-dom
//
// A regression guard for the bug Task 10 found and fixed: `main.tsx` --
// the actual production entry point -- had been mounting Task 1's
// placeholder (`<div>Wilco</div>`) instead of the real `ui/App`, for every
// task from 5 through 10, with zero red tests, because every other test in
// this suite renders `ui/App` directly rather than going through the real
// entry point. This file is what would have failed for all five of those
// tasks: it imports `main.tsx` itself (not `ui/App`) against a real `#app`
// mount node, exactly like `client/index.html` does, and asserts on
// something ONLY the real `App` component produces -- `app-shell` -- which
// the old placeholder never rendered.
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { tick } from "./test-utils";

// `main.tsx` imports `lib/api.ts`'s production `api` singleton, which is
// bound to `globalThis.fetch` and issues real, relative-path requests
// (`/api/accounts`, etc.) -- exactly what a real page origin resolves and
// what a bare `fetch` in this test process cannot (there is no page to
// resolve a relative URL against). Rather than fight `globalThis.fetch`
// (which does not reliably reach a dynamically-imported module graph in
// this setup), this replaces the WHOLE `lib/api` module with one whose
// `api` is built from the REAL `makeApi` (so it still behaves like the
// genuine client) bound to a local, in-process stub instead of a real
// network fetch -- so the real component tree renders exactly as it would
// against a real, empty backend, with no network call ever attempted.
vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  function bodyFor(url: string): string {
    if (url.includes("/api/accounts")) return "[]";
    if (url.includes("/api/mailboxes")) return JSON.stringify({ accounts: [] });
    if (url.includes("/api/messages")) return JSON.stringify({ rows: [], total: 0, cursor: null, truncated: false });
    if (url.includes("/api/saved-searches")) return JSON.stringify({ savedSearches: [] });
    if (url.includes("/api/preferences")) return JSON.stringify({ preferences: actual.DEFAULT_PREFERENCES });
    return "[]";
  }
  const stubFetch = async (url: string) =>
    new Response(bodyFor(url), { status: 200, statusText: "OK", headers: { "content-type": "application/json" } });
  return { ...actual, api: actual.makeApi(stubFetch) };
});

test("the real entry point mounts the real App, not a placeholder", async () => {
  const root = document.createElement("div");
  root.id = "app";
  document.body.appendChild(root);

  try {
    // Dynamic import so the module's mount-on-load side effect runs AFTER
    // `#app` exists in the document, matching `client/index.html`'s actual
    // load order (the script tag runs after `<div id="app">` is parsed).
    await import("./main");
    await tick();

    const shell = root.querySelector('[data-testid="app-shell"]');
    assert.ok(shell, 'main.tsx must render the real App (data-testid="app-shell"), not a placeholder');
  } finally {
    root.remove();
  }
});
