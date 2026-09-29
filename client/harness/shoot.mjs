#!/usr/bin/env node
// Screenshots every state in ./states.tsx into the directory given as this
// script's first argument. See ./README.md for the invocation and why
// this exists at all (three prior tasks each built and threw away their
// own version of this, and a fourth skipped its screenshot gate outright
// reasoning that no recipe existed).
//
// Assumes the harness dev server is already running (`npm --prefix client
// run harness`, port 8140 -- see harness/vite.config.ts). Drives headless
// Chromium via the harness runner image (harness/Dockerfile), the same pattern
// docs/design/RENDERING.md uses against the design prototype itself:
// `docker run --rm --network host -v shot.py:/shot.py:ro -v out:/out
// wilco-harness-runner:local python /shot.py`.
//
// 🚨 Asserts the render actually mounted (`document.body.innerText.length`
// in the hundreds) before saving each PNG, and exits non-zero WITHOUT
// writing the image if it didn't -- a near-empty body means the render
// failed and the screenshot would be worthless. This is the one property
// this script exists to guarantee; see README.md's own warning about the
// six-task-long unmounted-entry-point bug that motivated it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HARNESS_URL = process.env.HARNESS_URL ?? "http://localhost:8140";
const IMAGE = process.env.SHOOT_IMAGE ?? "wilco-harness-runner:local";
// A rendered state's `document.body.innerText` must be at least this long
// for the screenshot to be trusted. Set well below a real pane's typical
// length (hundreds to low thousands of characters) but well above zero --
// a handful of states are legitimately terse (a toast, a context menu)
// and carry their own smaller `minMountedChars` in states.tsx instead of
// weakening this default for everyone; see that field's doc comment.
const DEFAULT_MIN_MOUNTED_CHARS = 120;

const outDirArg = process.argv[2];
if (outDirArg === undefined) {
  console.error("usage: node shoot.mjs <out-dir>");
  process.exit(2);
}
const outDir = path.resolve(outDirArg);
mkdirSync(outDir, { recursive: true });

// Design review fix round 1: `document.fonts.check()` alone is not
// trustworthy -- the reviewer found a failure mode (the CSS *stylesheet*
// itself failing to load, not just a font binary) where `.check()` still
// answered `true` and all 17 states shot silently against a font that
// measurably was not in use (120.58px vs 130px on a known string). The
// registry flag can lie; real rendered geometry cannot. This probe
// renders the same string at each weight tokens.css actually declares
// (Sans 400/500/600/700, Mono 400/500) explicitly in "IBM Plex Sans"/"IBM
// Plex Mono", and again forced into a monospace font at the same
// size/weight, then asserts the two widths differ by a real margin. A
// proportional face and a monospace face cannot coincidentally render a
// pangram-length string at the same width, so a near-equal pair is
// conclusive proof the named font was never actually used, regardless of
// what `.check()` claims.
//
// Round 2 (design review fix round 2): the round-1 probe still measured
// bogus numbers for whichever weight the CURRENT harness state hadn't
// already rendered on screen -- e.g. probing a state with no 500-weight
// text anywhere in it. `document.fonts.ready` only waits for loads
// ALREADY triggered by content the page has rendered; setting
// `fontWeight`/`fontFamily` on the probe element for an unused weight
// triggers a FRESH, asynchronous font load that `getBoundingClientRect()`
// (synchronous) reads before it finishes, silently measuring that one
// weight against the UA fallback for a single frame. Symptom: three
// unrelated specs (Sans 500, Mono 400, Mono 500) all measured an
// identical 313.4px in one run -- not because they're secretly the same
// font, but because all three happened to still be mid-load, landing on
// the same generic UA fallback metrics. Fixed by explicitly
// `await document.fonts.load(...)` for EACH spec, immediately before
// measuring it, rather than relying on one `document.fonts.ready` check
// up front. Confirmed against an independent probe: Sans 500 = 317.84px,
// Mono 400 = Mono 500 = 424px (expected -- true monospace glyphs keep a
// fixed advance width across weights; that pair being equal is correct,
// not a bug, once both are actually loaded).
//
// Built in JS and JSON.stringify'd so it lands in the Python template
// below as a plain, correctly-escaped string literal -- hand-escaping
// nested JS-in-Python-in-JS quoting is exactly what broke this file's
// first version of the check.
const FONT_PROBE_JS = `async () => {
  const PROBE_TEXT = "Inbox Archive Spam Trash — quick brown fox 0123456789";
  const specs = [
    ["IBM Plex Sans", 400],
    ["IBM Plex Sans", 500],
    ["IBM Plex Sans", 600],
    ["IBM Plex Sans", 700],
    ["IBM Plex Mono", 400],
    ["IBM Plex Mono", 500],
  ];
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "nowrap";
  probe.style.fontSize = "13px";
  probe.textContent = PROBE_TEXT;
  document.body.appendChild(probe);

  const results = [];
  for (const [family, weight] of specs) {
    // Force-load (or confirm already-loaded) THIS exact weight before
    // measuring it -- the fix for the stale-fallback race described
    // above. A no-op if it's already loaded.
    await document.fonts.load(weight + ' 13px "' + family + '"');
    probe.style.fontWeight = String(weight);
    probe.style.fontFamily = '"' + family + '"';
    const realWidth = probe.getBoundingClientRect().width;
    probe.style.fontFamily = '"Courier New", monospace';
    const fallbackWidth = probe.getBoundingClientRect().width;
    const registryCheck = document.fonts.check(weight + ' 13px "' + family + '"');
    results.push({ family, weight, realWidth, fallbackWidth, registryCheck });
  }

  document.body.removeChild(probe);
  return results;
}`;

const SHOT_PY = `
import json
import sys
from playwright.sync_api import sync_playwright

BASE = ${JSON.stringify(HARNESS_URL)}
OUT = "/out"
DEFAULT_MIN_CHARS = ${DEFAULT_MIN_MOUNTED_CHARS}
FONT_PROBE_JS = ${JSON.stringify(FONT_PROBE_JS)}
# A proportional IBM Plex Sans/Mono render and a monospace render of the
# same string at the same size/weight are never within a couple of px of
# each other in practice (measured gap on PROBE_TEXT is tens of px) -- 8px
# is a comfortable floor well above noise, well below "these are secretly
# the same font".
MIN_WIDTH_DELTA_PX = 8

def main():
    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()

        # Load with no ?state= to read the manifest main.tsx publishes --
        # states.tsx stays the one source of truth; this script never
        # parses it itself.
        page.goto(BASE + "/", wait_until="networkidle")
        states = page.evaluate("window.__HARNESS_STATES__")
        if not states:
            print("FATAL: window.__HARNESS_STATES__ was empty or missing -- is main.tsx serving?", file=sys.stderr)
            sys.exit(1)
        print(f"{len(states)} states to shoot", file=sys.stderr)

        # Every prior measurement taken through this harness was against
        # fallback metrics (Helvetica/Arial) because /fonts/*.woff2 404'd
        # into the SPA fallback -- see vite.config.ts's publicDir comment.
        # A harness that silently renders in the wrong font is worse than
        # no harness, so refuse to shoot anything until IBM Plex Sans/Mono
        # are ACTUALLY rendering, at every weight tokens.css declares --
        # not merely registered per document.fonts.check(), which the
        # design review found can answer 'true' even when the stylesheet
        # that declares the @font-face rules failed entirely. See
        # FONT_PROBE_JS's own comment above for the real-geometry method.
        page.evaluate("document.fonts.ready")
        font_results = page.evaluate(FONT_PROBE_JS)
        font_failures = []
        for r in font_results:
            delta = abs(r["realWidth"] - r["fallbackWidth"])
            label = f"{r['family']} {r['weight']}"
            if delta < MIN_WIDTH_DELTA_PX:
                font_failures.append(
                    f"{label}: rendered width ({r['realWidth']:.2f}px) is within "
                    f"{delta:.2f}px of a forced-monospace fallback ({r['fallbackWidth']:.2f}px) -- "
                    f"the real font is not actually in use, even though "
                    f"document.fonts.check() said {r['registryCheck']}"
                )
        if font_failures:
            print("FATAL: one or more declared fonts are not actually rendering:", file=sys.stderr)
            for f in font_failures:
                print(f"  - {f}", file=sys.stderr)
            print(
                "The harness would be rendering with fallback metrics, making every "
                "screenshot untrustworthy. Check publicDir in harness/vite.config.ts, "
                "that /fonts/*.woff2 serve with content-type font/woff2, and that "
                "client/src/styles/tokens.css itself is reachable (a stylesheet that "
                "fails to load can leave document.fonts.check() answering true anyway).",
                file=sys.stderr,
            )
            sys.exit(1)
        widths = ", ".join(f"{r['family']} {r['weight']}={r['realWidth']:.1f}px" for r in font_results)
        print(f"fonts rendering for real (measured, not just registered): {widths}", file=sys.stderr)

        for state in states:
            state_id = state["id"]
            viewport = state["viewport"]
            min_chars = state.get("minMountedChars") or DEFAULT_MIN_CHARS
            page.set_viewport_size({"width": viewport["width"], "height": viewport["height"]})
            page.goto(f"{BASE}/?state={state_id}", wait_until="networkidle")
            # Real network-driven fetches (Sidebar/AddAccount's fakeApi calls
            # resolve on a microtask, not a real network) plus the Drive
            # wrapper's rAF-spaced steps for the multi-step states -- 1s
            # comfortably outlasts both.
            page.wait_for_timeout(1000)
            mounted_len = page.evaluate("document.body.innerText.length")
            if mounted_len < min_chars:
                failures.append(f"{state_id}: mounted body has only {mounted_len} chars (need >= {min_chars}) -- render did not mount, refusing to save a misleading screenshot")
                continue
            page.screenshot(path=f"{OUT}/{state_id}.png")
            print(f"ok  {state_id}  ({mounted_len} chars)", file=sys.stderr)

        browser.close()

    if failures:
        print("FAILURES:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
`;

const scratch = mkdtempSync(path.join(tmpdir(), "wilco-harness-shoot-"));
const shotPyPath = path.join(scratch, "shot.py");
writeFileSync(shotPyPath, SHOT_PY, "utf8");

try {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "host",
      "-v",
      `${shotPyPath}:/shot.py:ro`,
      "-v",
      `${outDir}:/out`,
      IMAGE,
      "python",
      "/shot.py",
    ],
    { stdio: "inherit" },
  );

  if (result.error) {
    console.error(`shoot.mjs: failed to run docker: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
