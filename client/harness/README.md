# Fidelity harness

Renders real client components against fixture props and screenshots them, so a
**design reviewer that did not write the code** can compare a pane against
`docs/design/Wilco.dc.html` and `docs/design/reference/` without inventing a setup.

Tasks 5, 6 and 8 each built and threw away their own version of this. Task 8 then
skipped its screenshot gate outright, reasoning that "no established recipe exists" —
which was false, but only because the recipe lived in three deleted files. This is that
recipe, committed.

## Why fixtures and not the live app

The deployed client needs a session, four Fastmail accounts and a 37.6k-message
database. Fidelity does not: these components are props-driven, so a fixture render is
both sufficient and reproducible. Screenshot the **deployed** app for end-to-end states
(Task 9); screenshot **here** for per-pane fidelity.

## Use

```bash
npm --prefix client run harness            # serves the harness on :8140
node client/harness/shoot.mjs out/         # screenshots every state into out/
```

`shoot.mjs` drives the harness runner image (`harness/Dockerfile`) (see `docs/design/RENDERING.md` for the
same pattern against the design itself) and 🚨 **asserts the app mounted** —
`document.body.innerText.length` in the hundreds — before saving. A near-empty body means
the render failed and the image is worthless; the script exits non-zero rather than
writing a misleading PNG.

## Adding a state

Add an entry to `states.tsx`. Each is `{ id, viewport, node }`. Keep fixture data
obviously fake (`Priya Raman`, `HAL`) so a screenshot is never mistaken for real mail —
and never point a fixture at the live database.
