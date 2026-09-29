# Reference renders — the acceptance criteria

> The PNGs are not committed: they captured the prototype's placeholder data. Regenerate
> them locally with `shot.py` before using them as a target.

Produced from `../Wilco.dc.html` + `../support.js` by the recipe in `../RENDERING.md`.
**These are the target.** A task in the design-fidelity plan is done when its pane matches
the corresponding reference at the same viewport.

| File | What |
|---|---|
| `ref-1440-light-inbox.png` | Columns layout, light, inbox with a message open — the primary target |
| `ref-1440-dark-inbox.png`  | Same, dark. Captured by flipping the `theme` prop default in a throwaway copy |
| `ref-1440-light-shortcuts.png` | The `?` shortcuts overlay |
| `ref-390-phone.png` | 390×844. ⚠️ The prototype has **no phone treatment** — it renders the desktop layout clipped. Owner ruling 2026-09-04: keep the SPA's existing collapse-below-1024 behaviour and match desktop exactly |

Regenerate with `shot.py` against a served throwaway copy — see `../RENDERING.md`. Assert
the runtime mounted (`document.body.innerText.length` in the thousands) before trusting a
shot; a near-empty body means React never mounted and the image is worthless.

## Recorded deviations from the design (owner rulings, 2026-09-04)

1. **Fonts are self-hosted.** The design links `fonts.googleapis.com`; we serve the same
   IBM Plex Sans/Mono as local woff2 from `client/public/fonts`. Identical rendering; the
   difference is only where the bytes come from, and a mail client should not make an
   outbound request per session.
2. **Phone layout is ours, not the design's** — see the table above.

Everything else matches the design exactly. Where the design and an app convention
conflict, **ask the owner**; do not resolve it in implementation.
