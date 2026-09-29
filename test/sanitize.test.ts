import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml, schemeOf } from "../src/core/sanitize.ts";

const opts = { resolveCid: (cid: string) => `https://mailbody.example.com/p/TOKEN/${cid}` };

function clean(html: string, o: Partial<Parameters<typeof sanitizeHtml>[1]> = {}) {
  return sanitizeHtml(html, { ...opts, ...o });
}

// -- The two things the CSP genuinely cannot stop (spec 6.4) ---------------

test("<link> is removed outright -- preconnect is governed by NO CSP directive", () => {
  // Probed under the full 6.2 policy, a preconnect produced a real TCP+TLS
  // connection with no CSP violation and no HTTP request: a per-recipient
  // hostname is a complete open-confirmation channel that bypasses the
  // remote-image block entirely.
  const out = clean('<p>hi</p><link rel="preconnect" href="https://u-robin.track.example">');
  assert.ok(!out.html.includes("link"), out.html);
  assert.ok(!out.html.includes("track.example"), out.html);
  assert.ok(out.html.includes("<p>hi</p>"), "contents around it survive");
});

test("<link rel=dns-prefetch> and <meta name=referrer> go the same way", () => {
  const a = clean('<link rel="dns-prefetch" href="https://u-robin.track.example">');
  const b = clean('<meta name="referrer" content="unsafe-url">');
  assert.equal(a.html.trim(), "");
  assert.equal(b.html.trim(), "");
});

// -- Script and framing ----------------------------------------------------

test("<script> is removed WITH its contents, not just its tags", () => {
  const out = clean('<p>a</p><script>alert(1)</script><p>b</p>');
  assert.ok(!out.html.includes("alert"), out.html);
  assert.equal(out.html, "<p>a</p><p>b</p>");
});

test("an unclosed <script> swallows the rest rather than leaking it", () => {
  const out = clean("<p>a</p><script>alert(1)");
  assert.ok(!out.html.includes("alert"), out.html);
});

test("nested browsing contexts cannot be created", () => {
  for (const tag of ["iframe", "object", "embed", "frame", "frameset", "applet"]) {
    const out = clean(`<${tag} src="https://evil.example"></${tag}>`);
    assert.ok(!out.html.includes("evil.example"), `${tag}: ${out.html}`);
  }
});

test("event handler attributes are removed on every element", () => {
  const out = clean('<div onclick="steal()" ONMOUSEOVER="x()" data-keep="1">t</div>');
  assert.ok(!/onclick|onmouseover/i.test(out.html), out.html);
  assert.ok(out.html.includes('data-keep="1"'), "ordinary attributes survive");
});

test("srcdoc is never re-emitted -- it would smuggle a whole document", () => {
  const out = clean('<div srcdoc="<script>alert(1)</script>">x</div>');
  assert.ok(!out.html.includes("srcdoc"), out.html);
});

// -- Spec 6.11: normalise a URL BEFORE judging its scheme ------------------

test("obfuscated javascript: URLs are refused -- entities, and a tab inside the word", () => {
  // Each of these walked through a check written against the text as
  // authored, because a browser decodes entities and drops control
  // characters BEFORE deciding what scheme it is reading.
  const vectors = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "j&#x61vascript:alert(1)",
    "&#106;avascript:alert(1)",
    "&#0000106;avascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    " javascript:alert(1)",
    "javascript:alert(1)",
    "jav&Tab;ascript:alert(1)",
  ];
  for (const href of vectors) {
    const out = clean(`<a href="${href}">x</a>`);
    assert.ok(!/javascript/i.test(out.html), `${href} -> ${out.html}`);
    assert.ok(!out.html.includes("alert"), `${href} -> ${out.html}`);
  }
});

test("vbscript: and data: text/html are refused too", () => {
  assert.ok(!clean('<a href="vbscript:msgbox(1)">x</a>').html.includes("vbscript"));
  assert.ok(!clean('<a href="data:text/html,<script>alert(1)</script>">x</a>').html.includes("data:"));
});

test("schemeOf normalises before it judges, and reports null for a relative URL", () => {
  assert.equal(schemeOf("HTTPS://example.com"), "https:");
  assert.equal(schemeOf("j&#x61;vascript:x"), "javascript:");
  assert.equal(schemeOf("/path/to/thing"), null);
  assert.equal(schemeOf("foo/bar:baz"), null, "the colon belongs to the path, not a scheme");
  assert.equal(schemeOf("#anchor"), null);
});

test("ordinary links survive and open in a new tab with noopener", () => {
  const out = clean('<a href="https://example.com/a?x=1&amp;y=2">go</a>');
  assert.ok(out.html.includes('href="https://example.com/a?x=1&amp;y=2"'), out.html);
  assert.ok(out.html.includes('target="_blank"'), "the sandbox blocks _blank without the popup flags");
  assert.ok(out.html.includes('rel="noopener noreferrer"'), out.html);
});

test("a sender's &amp; is not double-encoded", () => {
  const out = clean("<p>Tom &amp; Jerry</p>");
  assert.equal(out.html, "<p>Tom &amp; Jerry</p>");
});

test("an attribute value cannot break out of its attribute or its tag", () => {
  // The `"` inside a single-quoted value is escaped, so what looks like a
  // second attribute stays INERT TEXT inside `title`. Assert on the tag's
  // real attribute set, not on whether the string "onclick" appears --
  // decoding the escape before searching is what makes a passing sanitizer
  // look like a failing one.
  const out = clean('<div title=\'a" onclick="steal()\'>x</div>');
  assert.equal(out.html, '<div title="a&quot; onclick=&quot;steal()">x</div>');
  // The exact equality above IS the assertion. A substring search for
  // "onclick" would FAIL against this correct output, because the inert
  // text inside `title` still contains those characters -- which is the
  // trap: it makes a passing sanitizer look like a failing one. What
  // proves containment is that the only unescaped quotes left are the two
  // delimiting `title`.
  assert.equal(out.html.split('"').length - 1, 2, "exactly one attribute is delimited");
});

// -- Images (spec 6.5, 6.6) ------------------------------------------------

test("cid: images are rewritten onto the body origin under the capability token", () => {
  const out = clean('<img src="cid:logo@example">');
  assert.ok(out.html.includes("https://mailbody.example.com/p/TOKEN/logo@example"), out.html);
  assert.equal(out.blockedRemoteImages, 0, "an inline part makes no request to the sender");
});

test("a cid: with no matching part keeps a placeholder box, not a broken icon", () => {
  // Same rule as a blocked remote image: the element survives without a
  // src so any link around it stays clickable, and the wrapper stylesheet
  // paints it neutrally rather than leaving the browser's broken-image
  // glyph.
  const out = sanitizeHtml('<img src="cid:missing" width="20">', { resolveCid: () => null });
  assert.ok(out.html.includes("<img"));
  assert.ok(!/\bsrc=/.test(out.html));
  assert.ok(out.html.includes('data-wilco-blocked="1"'));
});

test("remote images are blocked and COUNTED, not silently dropped", () => {
  const out = clean('<img src="https://track.example/pixel.gif"><img src="http://x.example/a.png">');
  assert.ok(!out.html.includes("track.example"), out.html);
  assert.equal(out.blockedRemoteImages, 2, "the chrome needs a real count to report");
  // The elements survive as placeholder boxes (see the link test below);
  // what must not survive is the URL.
  assert.ok(!out.html.includes("track.example"));
  assert.ok(!out.html.includes("x.example"));
  assert.ok(!/\bsrc=/.test(out.html), "no src, so nothing is fetched");
});

test("the remote-image opt-in is a flag, not a rewrite", () => {
  const out = clean('<img src="https://example.com/a.png">', { allowRemoteImages: true });
  assert.ok(out.html.includes("https://example.com/a.png"), out.html);
  assert.equal(out.blockedRemoteImages, 0);
});

test("srcset is dropped whole rather than partly parsed", () => {
  const out = clean('<img srcset="https://a.example/1x.png 1x, https://a.example/2x.png 2x">');
  assert.ok(!out.html.includes("a.example"), out.html);
  assert.equal(out.blockedRemoteImages, 1);
});

test("a data: image survives -- img-src allows data:", () => {
  const src = "data:image/png;base64,iVBORw0KGgo=";
  assert.ok(clean(`<img src="${src}">`).html.includes(src));
});

// -- Style (spec 6.1/6.2) --------------------------------------------------

test("<style> and the style attribute both survive", () => {
  // style-src 'unsafe-inline' is required for the style ATTRIBUTE and there
  // is no hash or nonce form; 'self' silently disables it while leaving it
  // in the DOM, which looks exactly like an over-eager sanitizer. @import,
  // background-image: url(), image-set() and @font-face are all refused by
  // the policy, so a stylesheet cannot fetch.
  const out = clean('<style>p { color: red }</style><p style="color: blue">x</p>');
  assert.ok(out.html.includes("color: red"), out.html);
  assert.ok(out.html.includes('style="color: blue"'), out.html);
});

// -- Spec 6.11: every regex must be linear ---------------------------------

test("a 75,645-character whitespace run inside a tag does not stall the render", () => {
  // The measured shape from one real 180KB message. A backtracking
  // quantifier over it cost 2.4 seconds for a SINGLE render, on a shared
  // server rather than one user's desktop.
  const run = " ".repeat(75_645);
  const html = `<div class="a"${run}title="t">text</div>` + `<p>${" ".repeat(20)}</p>`.repeat(474);
  const started = Date.now();
  const out = clean(html);
  const elapsed = Date.now() - started;
  assert.ok(out.html.includes("text"), "it still parses");
  assert.ok(elapsed < 500, `sanitize must be linear: took ${elapsed}ms`);
});

test("a long unterminated attribute value does not stall or leak markup", () => {
  const started = Date.now();
  const out = clean('<div title="' + "a".repeat(200_000) + "<script>alert(1)</script>");
  assert.ok(Date.now() - started < 500);
  // An unterminated value runs to the end of the input, exactly as a
  // browser does, so the `<script>` is swallowed INTO the attribute rather
  // than left as a truncated remainder to be re-parsed as markup. What
  // matters is that no script element survives, not that the word is absent.
  assert.ok(!out.html.includes("<script"), out.html.slice(0, 120));
  assert.ok(!/<\/script/.test(out.html), "no script element survives");
});

// -- Shape ------------------------------------------------------------------

test("a stray < is emitted as an entity, never as the start of a tag", () => {
  const out = clean("5 < 6 and 7 > 4");
  assert.ok(out.html.startsWith("5 &lt; 6"), out.html);
});

test("comments are dropped whole", () => {
  assert.equal(clean("<p>a</p><!-- <script>alert(1)</script> --><p>b</p>").html, "<p>a</p><p>b</p>");
});

test("real-shaped marketing HTML survives recognisably", () => {
  const out = clean(`
    <html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdn.example/a.css"></head>
    <body style="background:#f2f2f2">
      <table><tr><td><img src="cid:hdr@x" width="600"></td></tr>
      <tr><td><a href="https://shop.example/sale">Shop the sale</a></td></tr>
      <tr><td><img src="https://track.example/o.gif" width="1" height="1"></td></tr></table>
    </body></html>`);
  assert.ok(out.html.includes("Shop the sale"));
  assert.ok(out.html.includes("/p/TOKEN/hdr@x"), "the header image renders");
  assert.equal(out.blockedRemoteImages, 1, "the tracking pixel is blocked and counted");
  assert.ok(!out.html.includes("cdn.example"));
  assert.ok(out.html.includes('style="background:#f2f2f2"'), "the body background survives for chooseSurface");
});

test("🚨 a blocked image KEEPS ITS BOX, so the link around it stays clickable", () => {
  // Dropping the element collapses it to nothing, and in marketing mail the
  // primary call to action is an image wrapped in a link -- the anchor
  // collapses with it. Measured on a real USPS message: 11 of its 21 links
  // were zero-sized for exactly this reason, which reads as "links don't
  // work".
  const out = clean('<a href="https://example.com/x"><img src="https://track.example/cta.png" width="320" height="80"></a>');
  assert.ok(out.html.includes("<img"), "the element survives");
  assert.ok(!out.html.includes("track.example"), "but fetches nothing");
  assert.ok(!/\bsrc=/.test(out.html), "no src at all");
  assert.ok(out.html.includes('width="320"'), "its declared box is preserved");
  assert.ok(out.html.includes('height="80"'));
  assert.ok(out.html.includes('data-wilco-blocked="1"'), "marked so the wrapper can style it");
  assert.equal(out.blockedRemoteImages, 1, "still counted");
});

test("an opted-in image is untouched and carries no placeholder marker", () => {
  const out = clean('<img src="https://example.com/a.png" width="10">', { allowRemoteImages: true });
  assert.ok(out.html.includes("https://example.com/a.png"));
  assert.ok(!out.html.includes("data-wilco-blocked"));
});

test("a cid: image that resolves is untouched too", () => {
  const out = clean('<img src="cid:logo@x" height="40">');
  assert.ok(out.html.includes("/p/TOKEN/logo@x"));
  assert.ok(!out.html.includes("data-wilco-blocked"));
});

test("🚨 <base> is removed outright -- `base-uri 'none'` does NOT cover subresources", () => {
  // Measured in a real browser (audit pass 5, harness/csp-probe.py). With
  // `base-uri 'none'` in force Chromium logs "Refused to set the document's
  // base URI" and `document.baseURI` correctly stays the document's own --
  // and an `<img src="relative">` STILL loads from the refused base, because
  // the preload scanner resolved it against <base> at parse time.
  //
  // So the CSP directive protects `document.baseURI` and nothing else. For
  // subresource URLs the SANITIZER is the control, not the policy. Spec 6.2
  // has this backwards: it calls the regex "deliberately demoted to hygiene"
  // and treats the directive as the real mitigation. For the half that
  // matters to a reader -- where a relative URL points -- it is the reverse.
  //
  // Harmless in Wilco today only because `img-src` confines images to the
  // body origin regardless. This test is what keeps that from being luck.
  const out = clean('<p>hi</p><base href="https://evil.example/"><img src="rel.png">').html;
  assert.ok(!/<base/i.test(out), `<base> survived: ${out}`);
  assert.ok(!out.includes("evil.example"), `the base href survived: ${out}`);
});

test("🚨 a blocked image keeps its BOX but not the sender's alt text", () => {
  // Two things at once, both measured on real mail (audit pass 6):
  //
  // 1. The element survives with its declared width/height, so an anchor
  //    wrapped around it keeps a clickable box. Dropping it collapsed the
  //    link -- 11 of one message's 21 links were unclickable for that
  //    reason, and in marketing mail the primary call to action IS an image
  //    inside a link.
  // 2. The sender's `alt` is REPLACED, not appended to. The old code pushed
  //    `alt=""` alongside the original, producing a duplicate attribute;
  //    parsers keep the first, so the blanking silently did nothing and the
  //    placeholder rendered the sender's text inside it.
  const out = clean(
    '<a href="https://x.test"><img src="https://cdn.test/a.png" alt="Amazon.com" width="86" height="43"></a>',
  ).html;

  assert.match(out, /width="86"/, "a blocked image lost its declared width");
  assert.match(out, /height="43"/, "a blocked image lost its declared height");
  assert.match(out, /data-wilco-blocked="1"/);
  assert.equal(
    (out.match(/\balt=/g) ?? []).length,
    1,
    `the sender's alt survived alongside the blank one: ${out}`,
  );
  assert.ok(!out.includes("Amazon.com"), `the sender's alt text survived: ${out}`);
});

test("keepBlockedSrc keeps a blocked remote image's URL as data-wilco-src, and only for http(s)", () => {
  const r = sanitizeHtml('<img src="https://x/a.png"><img src="javascript:alert(1)"><img src="cid:c1">', { resolveCid: () => null, allowRemoteImages: false, keepBlockedSrc: true });
  assert.match(r.html, /data-wilco-src="https:\/\/x\/a\.png"/);
  assert.doesNotMatch(r.html, /javascript|cid:/);
  const plain = sanitizeHtml('<img src="https://x/a.png">', { resolveCid: () => null, allowRemoteImages: false });
  assert.doesNotMatch(plain.html, /data-wilco-src/, "off by default: reading keeps nothing of a blocked image");
});
