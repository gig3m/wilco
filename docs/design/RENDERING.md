# Rendering the design prototype

`Wilco.dc.html` is the design. It is a component document: an `<x-dc>`
template plus a `script[data-dc-script]` state block, rendered by `support.js`.

🚨 **`support.js` was missing from the original handoff zip.** Without it the prototype
cannot run, and opening the file directly shows stacked overlays full of `{{ template }}`
placeholders. It has since been
added beside it here.

## One host dependency

`support.js` expects `window.React` and `window.ReactDOM` to already exist — the original design
host provided them, and the document does not load them itself. To render locally,
inject React and ReactDOM UMD **before** the `support.js` tag. **Do this in a throwaway
copy, never in `Wilco.dc.html`** — the design file stays exactly as delivered.

## Rendering it

```bash
# 1. throwaway copy with React injected before support.js
mkdir -p /tmp/render && cp Wilco.dc.html support.js /tmp/render/
#    (insert the two react@18 / react-dom@18 UMD script tags before ./support.js)

# 2. serve it — file:// will not do, the runtime needs an origin
python3 -m http.server 8137 --bind 127.0.0.1 --directory /tmp/render &

# 3. shoot it
docker run --rm --network host -v /tmp/render/shot.py:/shot.py:ro -v /tmp/out:/out \
  wilco-harness-runner:local python /shot.py
```

`shot.py` is a short `playwright.sync_api` script: `goto` the served URL, wait ~7s for the
runtime to mount, `page.screenshot`. Assert `typeof window.React === "object"` and that
`document.body.innerText.length` is in the thousands — a near-empty body means the runtime
did not mount and the screenshot is worthless.

## How to use it

The visual specification is **528 inline `style=` attributes** on the rendered markup,
referencing the same tokens as `client/src/styles/tokens.css`. Read them for the component
you are building; they are literal. Screenshot your render at the same viewport and compare.

**Match it exactly.** The design was done deliberately so that implementation makes no
visual decisions. Where the design conflicts with an app convention, raise it with the
owner rather than resolving it yourself.
