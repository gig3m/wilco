// Harness entry point (see ./README.md). Renders the state named by the
// `?state=` query param into #app -- nothing else. `shoot.mjs` drives this
// by first loading the harness with no `?state=` to read `__HARNESS_STATES__`
// (the id + viewport for every catalogued state, so the Node-side driver
// never needs to parse states.tsx itself -- states.tsx stays the one
// source of truth), then loading `?state=<id>` once per state.
import { render } from "preact";
import { STATES } from "./states";

// Exposed for shoot.mjs's `page.evaluate` -- id/viewport only, never the
// vnode (that isn't structured-cloneable and isn't needed outside the
// browser that's actually rendering it).
(
  window as unknown as {
    __HARNESS_STATES__: Array<{ id: string; viewport: { width: number; height: number }; minMountedChars?: number }>;
  }
).__HARNESS_STATES__ = STATES.map((s) => ({ id: s.id, viewport: s.viewport, minMountedChars: s.minMountedChars }));

const params = new URLSearchParams(window.location.search);
const stateId = params.get("state");
const root = document.getElementById("app");

if (root && stateId !== null) {
  const state = STATES.find((s) => s.id === stateId);
  if (state === undefined) {
    root.textContent = `harness: no state named "${stateId}". Known states: ${STATES.map((s) => s.id).join(", ")}`;
  } else {
    render(state.node, root);
  }
} else if (root) {
  root.textContent = `Wilco design-fidelity harness. ${STATES.length} states. Append ?state=<id> to render one, e.g. ?state=${STATES[0]?.id ?? ""}`;
}
