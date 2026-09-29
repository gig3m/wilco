// @vitest-environment node
//
// This suite reads the repository's own source tree from disk (the
// dangerouslySetInnerHTML grep guard), which a happy-dom environment cannot
// do -- there is no filesystem in that sandbox. The whole file runs under
// the plain node environment instead; none of these tests touch the DOM.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";
import { SNIPPET_CLOSE, SNIPPET_OPEN, highlight, safeExternalHref, splitSnippet, text } from "./escape";

// The `client/` package root, resolved from this file's own location rather
// than from process.cwd(). Review round 1 flagged that walk("src") depended
// on Vitest's cwd being client/ (true only when invoked via
// `npm --prefix client test`) and threw ENOENT -- silently reporting nothing
// rather than a violation -- under any other invocation.
const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Recursively lists every file under `dir`. The brief references this
// helper by name but does not define it -- writing it here per Ruling S4.
function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

test("text() is documented as a non-escaping pass-through, not a sanitiser", () => {
  // text() is deliberately a no-op (`value ?? ""`) -- its safety comes
  // entirely from Preact escaping JSX children, not from anything this
  // function does. The contract chosen in review round 1 is: keep the name
  // (six later tasks are about to import it), make the doc comment say
  // plainly that it escapes nothing and is unsafe outside a child-text
  // position. This test pins that the null/undefined handling that IS its
  // whole job still works, rather than asserting a tautology like "a no-op
  // returns its input unchanged".
  assert.equal(text(null), "");
  assert.equal(text(undefined), "");
  assert.equal(text("<script>not escaped by this function</script>"), "<script>not escaped by this function</script>");
});

test("highlight returns SEGMENTS, never markup", () => {
  const out = highlight("Invoice <script>alert(1)</script> due", ["invoice"]);
  assert.deepEqual(out[0], { text: "Invoice", hit: true });
  // The whole point: no member of the output is HTML. A caller renders
  // segments as children, which Preact escapes; it cannot render a string
  // containing tags as markup by accident.
  assert.ok(out.every((s) => typeof s.text === "string"));
  assert.ok(!JSON.stringify(out).includes("<mark>"));
  assert.ok(JSON.stringify(out).includes("<script>"), "the text is preserved verbatim, just not as markup");
});

test("highlight is case-insensitive but preserves the original casing", () => {
  const out = highlight("Quarterly Report", ["quarterly"]);
  assert.equal(out[0]!.text, "Quarterly");
  assert.equal(out[0]!.hit, true);
});

test("highlight picks the earliest-starting match when two terms both match at a position", () => {
  // "cat" and "catalog" both start at index 0 of "catalogue". The
  // implementation's tie-break prefers the LONGER needle at the same start
  // index, so the hit segment should be "catalog", not "cat".
  const out = highlight("catalogue", ["cat", "catalog"]);
  assert.deepEqual(out, [
    { text: "catalog", hit: true },
    { text: "ue", hit: false },
  ]);
});

test("highlight handles a term that is a prefix of another term, whichever is searched for first", () => {
  const byLongFirst = highlight("preview text", ["preview", "pre"]);
  const byShortFirst = highlight("preview text", ["pre", "preview"]);
  assert.deepEqual(byLongFirst, byShortFirst);
  assert.deepEqual(byLongFirst[0], { text: "preview", hit: true });
});

test("HIGHLIGHT CANNOT BE MADE TO LOOP OR EXPLODE BY A CRAFTED TERM", () => {
  // A term is user input from the search box. A regex built from it without
  // escaping turns "(" into a syntax error and ".*.*.*" into a catastrophic
  // backtrack over a 100KB body (spec 6.11: every regex over message-shaped
  // data must be linear).
  assert.doesNotThrow(() => highlight("a".repeat(100_000), ["(", "[", "*", "a.*a.*a.*b"]));
  const started = Date.now();
  highlight("a".repeat(100_000), ["a.*a.*a.*a.*b"]);
  assert.ok(Date.now() - started < 500, "highlight must be linear in the input");
});

test("HIGHLIGHT STAYS LINEAR WITH MULTIPLE TERMS, INCLUDING ONE THAT NEVER MATCHES", () => {
  // Round-1 review finding: the original implementation re-ran
  // `haystack.indexOf(needle, pos)` for EVERY needle on EVERY outer-loop
  // iteration. With one needle that matches ~50,000 times ("a" in
  // "ab".repeat(50_000)) and one that never matches ("zzz"), the never-
  // matching needle was rescanned from `pos` to the end of a 100,000-char
  // haystack on each of the ~50,000 iterations -- quadratic, not linear.
  // The brief's own linearity test cannot catch this because all of its
  // terms match zero times, so that loop body runs exactly once.
  // 200,000 repeats was chosen empirically: it measures ~560ms (over budget)
  // against the pre-fix quadratic implementation and ~70ms against the
  // fixed one -- large enough to reliably separate the two, not just large
  // enough to be "slow-ish". A smaller haystack (e.g. 50,000) still passes
  // even against the quadratic code on this hardware, because V8's
  // `indexOf` is a heavily optimized scan and the quadratic blowup only
  // becomes dominant at a larger N.
  const haystack = "ab".repeat(200_000);
  const started = Date.now();
  const out = highlight(haystack, ["a", "zzz-never-matches"]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `highlight with a many-match term plus a never-matching term must be linear, took ${elapsed}ms`);
  // Sanity: every "a" was still found -- the perf fix didn't skip matches.
  const hitCount = out.filter((s) => s.hit).length;
  assert.equal(hitCount, 200_000);
});

test("an empty or whitespace term matches nothing rather than everything", () => {
  const out = highlight("hello", ["", "   "]);
  assert.deepEqual(out, [{ text: "hello", hit: false }]);
});

test("safeExternalHref refuses everything that is not http, https or mailto", () => {
  assert.equal(safeExternalHref("https://example.test/x"), "https://example.test/x");
  assert.equal(safeExternalHref("mailto:robin@halden.example"), "mailto:robin@halden.example");
  for (const evil of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "j&#x61;vascript:alert(1)",
    "\tjavascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ]) {
    assert.equal(safeExternalHref(evil), null, `${evil} must be refused`);
  }
});

test("safeExternalHref returns the VALIDATED string, not the raw one", () => {
  // Round-1 review finding: an earlier version judged `trimmed` (decoded +
  // control-stripped + leading-whitespace-trimmed) but returned `raw`
  // unchanged -- "validate string A, emit string B". Not live-exploitable
  // through Preact's setAttribute (which never entity-decodes attribute
  // values), but a parser-differential trap for any future consumer that
  // parses differently. The returned value must be the one that was judged.
  assert.equal(
    safeExternalHref("mailto:a@b.test\nBcc:c@d.test"),
    "mailto:a@b.test" + "Bcc:c@d.test",
    "the embedded control character (newline) must not survive in the returned string",
  );
  assert.equal(
    safeExternalHref(" https://x.test"),
    "https://x.test",
    "leading whitespace must not survive in the returned string",
  );
});

// Round-2 review: the guard greps exactly one identifier
// ("dangerouslySetInnerHTML"), so `innerHTML`, `insertAdjacentHTML`,
// `srcdoc` and a literal `<iframe>` -- every other way this codebase
// could smuggle raw HTML into the chrome -- would all pass it. Every
// banned string is matched independently and reported by name, so a hit
// says exactly which mechanism showed up, not just "something did."
const BANNED_HTML_MECHANISMS = ["dangerouslySetInnerHTML", "insertAdjacentHTML", "srcdoc"] as const;

/**
 * `<iframe` is banned in every client source file EXCEPT `ui/BodyFrame.tsx`.
 *
 * The ban existed because plan 5 had no body pipeline: any iframe was, by
 * definition, message content arriving in the wrong place. The body
 * pipeline (spec 6) makes exactly one iframe legitimate -- a frame whose
 * `src` is a capability URL on the SEPARATE body origin. That is the whole
 * mechanism, so banning it outright would ban the feature.
 *
 * The exemption is TWO files, not a relaxation: `srcdoc` stays banned
 * everywhere including them (srcdoc would put the HTML in THIS document's
 * origin, which is the thing all of this exists to prevent), and both
 * frames' attributes are pinned by the tests below.
 *
 * SignaturePreview is the second, and it is exempt for the same reason
 * rather than a weaker one: the operator's own signature HTML gets no
 * privileged path into this document that a sender's does not have. It
 * renders in the same sandboxed origin, under the same CSP, through the
 * same sanitizer.
 */
const IFRAME_ALLOWED = ["/ui/BodyFrame.tsx", "/ui/SignaturePreview.tsx"];
/**
 * `DOMParser` + node adoption is how the rich editor takes a SERVER-SANITIZED
 * document (the owner's own signature or draft) into the editable document
 * without ever assigning an HTML string (HTML compose spec 5). One file may
 * do it. Test files may parse hostile markup to feed the serialiser.
 */
const DOMPARSER_ALLOWED = ["/ui/RichEditor.tsx"];
// `innerHTML` gets its own check: it is also a legitimate READ (e.g.
// asserting on rendered markup in a test), so only an ASSIGNMENT --
// `.innerHTML =`, optionally through `?.` -- counts as a hit. A plain
// `.innerHTML` read must not trip this.
const INNER_HTML_ASSIGNMENT = /\.innerHTML\s*=(?!=)/;

test("NO CLIENT SOURCE FILE USES dangerouslySetInnerHTML OR AN EQUIVALENT RAW-HTML MECHANISM", () => {
  // Plan 5 renders plaintext only; message HTML arrives in plan 6 behind a
  // capability URL on a separate origin (spec 6). This test is the guard that
  // stops it arriving early and in the wrong place.
  //
  // Also walks `harness/` (the design-fidelity screenshot harness, added
  // alongside this dispatch) -- it renders real `ui/` components too, and
  // dev-only tooling that briefly used a raw-HTML shortcut would be exactly
  // as easy to miss as the six-task-long unmounted-entry-point bug this
  // whole plan exists to stop repeating.
  const hits: string[] = [];

  const sourceFiles = [...walk(join(CLIENT_ROOT, "src")), ...walk(join(CLIENT_ROOT, "harness"))];
  // Round-1 review: the guard only scanned .ts/.tsx, missing .js/.jsx and
  // the HTML entry point (where an inline script or an attribute could also
  // carry it). Widen to everything that can hold JS-shaped or HTML-shaped
  // source in this client.
  for (const file of sourceFiles) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
    if (file.endsWith("escape.test.ts")) continue;
    // escape.ts's own module comments name these mechanisms in prose
    // (explaining what `safeExternalHref` is guarding against) -- a
    // mention in a comment is not a use, and this file is the one place
    // in the client that legitimately needs to say the words.
    if (file.endsWith("/lib/escape.ts")) continue;
    const contents = readFileSync(file, "utf8");
    for (const mechanism of BANNED_HTML_MECHANISMS) {
      if (contents.includes(mechanism)) hits.push(`${file}: ${mechanism}`);
    }
    if (contents.includes("<iframe") && !IFRAME_ALLOWED.some((allowed) => file.endsWith(allowed))) {
      hits.push(`${file}: <iframe`);
    }
    if (INNER_HTML_ASSIGNMENT.test(contents)) hits.push(`${file}: innerHTML assignment`);
    if (/\bDOMParser\b|\badoptNode\b|\bimportNode\b/.test(contents) && !/\.test\.tsx?$/.test(file) && !DOMPARSER_ALLOWED.some((allowed) => file.endsWith(allowed))) {
      hits.push(`${file}: DOMParser / node adoption`);
    }
  }

  for (const indexHtml of [join(CLIENT_ROOT, "index.html"), join(CLIENT_ROOT, "harness", "index.html")]) {
    const htmlContents = readFileSync(indexHtml, "utf8");
    for (const mechanism of [...BANNED_HTML_MECHANISMS, "<iframe"]) {
      if (htmlContents.includes(mechanism)) hits.push(`${indexHtml}: ${mechanism}`);
    }
  }

  assert.deepEqual(hits, []);
});

const O = SNIPPET_OPEN;
const C = SNIPPET_CLOSE;

test("splitSnippet returns SEGMENTS, never markup, and never leaks a marker", () => {
  const out = splitSnippet(`most recent ${O}invoice${C} verifying <script>alert(1)</script>`);
  assert.deepEqual(out, [
    { text: "most recent ", hit: false },
    { text: "invoice", hit: true },
    { text: " verifying <script>alert(1)</script>", hit: false },
  ]);
  for (const seg of out) {
    assert.ok(!seg.text.includes(O) && !seg.text.includes(C), "no marker survives into a segment");
  }
});

test("splitSnippet marks every match, not only the first", () => {
  const out = splitSnippet(`${O}a${C} and ${O}b${C}`);
  assert.deepEqual(
    out.filter((s) => s.hit).map((s) => s.text),
    ["a", "b"],
  );
});

test("splitSnippet leaves a marker-free snippet as one unmatched segment", () => {
  assert.deepEqual(splitSnippet("plain preview text"), [{ text: "plain preview text", hit: false }]);
  assert.deepEqual(splitSnippet(null), []);
  assert.deepEqual(splitSnippet(""), []);
});

test("splitSnippet treats an unclosed match as a match rather than showing the marker", () => {
  // FTS5 can truncate a snippet mid-match. Dropping the run would hide text;
  // rendering the marker is the bug this function exists to fix.
  assert.deepEqual(splitSnippet(`see ${O}invoi`), [
    { text: "see ", hit: false },
    { text: "invoi", hit: true },
  ]);
});

test("splitSnippet drops a stray closing marker instead of rendering it", () => {
  assert.deepEqual(splitSnippet(`odd${C} text`), [{ text: "odd text", hit: false }]);
});

test("splitSnippet is linear over a long snippet", () => {
  const started = Date.now();
  splitSnippet("a".repeat(200_000) + O + "hit" + C);
  assert.ok(Date.now() - started < 500, "splitSnippet must be linear in the input");
});

test("THE ONE PERMITTED IFRAME IS SANDBOXED, CROSS-ORIGIN AND UNFOCUSABLE", () => {
  // The exemption above is only defensible if the frame it exempts keeps
  // its properties. These are the attributes the whole spec-6 argument
  // rests on, asserted against the source rather than a rendered DOM so
  // that removing one fails here even if no component test covers it.
  const src = readFileSync(join(CLIENT_ROOT, "src/ui/BodyFrame.tsx"), "utf8");

  // Assert on the ATTRIBUTE's tokens, not on whether the file contains the
  // string anywhere: the file's own comments explain why allow-scripts is
  // absent, and a whole-file substring search reads those explanations as
  // violations -- the same trap escape.ts's exemption exists for.
  const sandbox = /sandbox="([^"]*)"/.exec(src);
  assert.ok(sandbox, "the frame declares a sandbox attribute");
  const tokens = sandbox![1]!.split(/\s+/).filter(Boolean);
  assert.deepEqual(
    tokens.slice().sort(),
    ["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"].sort(),
    "exactly the two popup flags plus allow-scripts for the body origin's OWN hashed resize script (row 3) -- and no allow-same-origin",
  );
  // Both popup flags together, or every link in every email does nothing:
  // the sandbox blocks target="_blank" outright (spec 6.3).
  assert.ok(tokens.includes("allow-popups-to-escape-sandbox"));

  // The frame never takes focus (spec 6.10), or the keyboard dies with a
  // message open.
  assert.match(src, /tabIndex=\{-1\}/);

  // Referer would otherwise hand the sender the capability token itself.
  assert.match(src, /referrerpolicy="no-referrer"/);

  // The src is a URL from the API, never inline content.
  assert.ok(!src.includes("srcdoc"), "srcdoc stays banned even here");
});

test("THE SIGNATURE PREVIEW FRAME HAS THE SAME PROPERTIES AS THE BODY FRAME", () => {
  // The second exemption is only defensible if it keeps the properties that
  // made the first one defensible.
  const src = readFileSync(join(CLIENT_ROOT, "src/ui/SignaturePreview.tsx"), "utf8");
  const sandbox = /sandbox="([^"]*)"/.exec(src);
  assert.ok(sandbox, "the frame declares a sandbox attribute");
  assert.deepEqual(
    sandbox![1]!.split(/\s+/).filter(Boolean).sort(),
    ["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"].sort(),
  );
  assert.match(src, /tabIndex=\{-1\}/);
  assert.match(src, /referrerpolicy="no-referrer"/);
  assert.ok(!src.includes("srcdoc"));
});

test("no client file derives plaintext from HTML any more", () => {
  // The plaintext-rendition preview was replaced by a real one. Leaving a
  // half-working html-to-text path around invites its reuse -- and the one
  // that existed had a 2000-character bound that a base64 data: URL walked
  // straight past, printing the raw <img> tag to the operator.
  const hits: string[] = [];
  for (const file of walk(join(CLIENT_ROOT, "src"))) {
    if (!/\.(ts|tsx)$/.test(file) || file.endsWith("escape.test.ts")) continue;
    if (/htmlToPlain|stripTags|htmlToText/.test(readFileSync(file, "utf8"))) hits.push(file);
  }
  assert.deepEqual(hits, []);
});
