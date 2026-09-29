import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHtmlBody,
  derivePlainSignature,
  escapeHtml,
  estimateSignatureHeight,
  prepareSignatureImages,
} from "../src/core/signature.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const B64 = PNG.toString("base64");

// -- data:-stored, cid:-sent (spec 11) ------------------------------------

test("🚨 a data: logo becomes a cid: reference and its bytes come back out", () => {
  // Fastmail stores base64 images inside htmlSignature, but a data: image in
  // a SENT message is stripped or blocked by many receiving clients.
  const html = `<p>Robin</p><img src="data:image/png;base64,${B64}" alt="logo">`;
  const out = prepareSignatureImages(html, (i) => `sig${i}@wilco`);

  assert.equal(out.images.length, 1);
  assert.equal(out.images[0]!.type, "image/png");
  assert.deepEqual(out.images[0]!.bytes, PNG, "the exact bytes, ready to upload");
  assert.ok(out.html.includes('src="cid:sig0@wilco"'), out.html);
  assert.ok(!out.html.includes("data:image"), "no data: URL survives");
});

test("several logos each get their own cid", () => {
  const html = `<img src="data:image/png;base64,${B64}"><img src='data:image/gif;base64,${B64}'>`;
  const out = prepareSignatureImages(html, (i) => `sig${i}@wilco`);
  assert.deepEqual(out.images.map((i) => i.cid), ["sig0@wilco", "sig1@wilco"]);
  assert.deepEqual(out.images.map((i) => i.type), ["image/png", "image/gif"]);
  // Single quotes are as valid as double in HTML and the rewrite must
  // preserve whichever was used, or the attribute breaks.
  assert.ok(out.html.includes(`'cid:sig1@wilco'`), out.html);
});

test("whitespace inside base64 is tolerated -- it is legal in a data URL", () => {
  const wrapped = B64.slice(0, 4) + "\n  " + B64.slice(4);
  const out = prepareSignatureImages(`<img src="data:image/png;base64,${wrapped}">`, () => "c@w");
  assert.deepEqual(out.images[0]!.bytes, PNG);
});

test("a signature with no images is returned untouched", () => {
  const html = "<p>Robin</p>";
  const out = prepareSignatureImages(html, () => "c@w");
  assert.equal(out.html, html);
  assert.deepEqual(out.images, []);
});

test("a data: URL that is not really base64 is left alone rather than sent empty", () => {
  // A broken image the recipient can see beats a silently dropped one.
  const out = prepareSignatureImages('<img src="data:image/png;base64,">', () => "c@w");
  assert.deepEqual(out.images, []);
});

test("filenames are derived from the subtype, with jpeg spelled jpg", () => {
  const out = prepareSignatureImages(
    `<img src="data:image/jpeg;base64,${B64}"><img src="data:image/svg+xml;base64,${B64}">`,
    (i) => `c${i}@w`,
  );
  assert.deepEqual(out.images.map((i) => i.name), ["signature-1.jpg", "signature-2.svg"]);
});

// -- The two halves must agree (multipart/alternative) ---------------------

test("🚨 the typed body is ESCAPED into the HTML half, never passed through", () => {
  // Someone typing `<b>` in the plaintext editor means those five
  // characters. Emitting them as markup would silently change the message
  // AND make the two halves say different things.
  const html = buildHtmlBody("5 < 6 & <b>not bold</b>", "");
  assert.ok(html.includes("5 &lt; 6 &amp; &lt;b&gt;not bold&lt;/b&gt;"), html);
  assert.ok(!html.includes("<b>not bold</b>"));
});

test("newlines become <br> so the HTML half reads like the plaintext one", () => {
  assert.ok(buildHtmlBody("one\ntwo", "").includes("one<br>\ntwo"));
});

test("the signature is appended as its own block, after a blank line", () => {
  const html = buildHtmlBody("Body", "<p>Robin</p>");
  assert.match(html, /<div>Body<\/div><div><br><\/div><div><p>Robin<\/p><\/div>/);
});

test("escapeHtml covers the attribute-breaking characters too", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});

// -- The derived plaintext half (spec 11) ---------------------------------

test("a plaintext signature is DERIVED from the HTML one when there is no separate text half", () => {
  // Without this, a recipient whose client prefers text/plain gets a message
  // with no signature while an HTML reader sees one.
  const plain = derivePlainSignature("<p>ROBIN HALDEN</p><p>President &amp; CEO</p>");
  assert.match(plain, /ROBIN HALDEN/);
  assert.match(plain, /President & CEO/, "entities are decoded, not left raw");
  assert.ok(!plain.includes("<p>"));
});

// -- The Settings preview's height estimate (row 38) -----------------------

test("estimateSignatureHeight budgets the frame padding, every line and every image", () => {
  // 3 lines, no image: (56 + 3*19) * 1.08 = 122.04 -> 123.
  assert.equal(estimateSignatureHeight("<p>a</p><p>b</p><p>c</p>"), 123);
  // A declared image height is used as given, even behind a data: URL
  // longer than any sane regex bound.
  const blob = "A".repeat(20000);
  const withLogo = `<table><tr><td><img src="data:image/png;base64,${blob}" height="60"></td></tr><tr><td>Robin</td></tr></table>`;
  assert.equal(estimateSignatureHeight(withLogo), Math.ceil((56 + 60 + 2 * 19) * 1.08));
  // An image with no declared height counts as a typical logo, never as
  // nothing -- nothing would hide content.
  assert.equal(estimateSignatureHeight('<img src="x.png"><br>'), Math.ceil((56 + 120 + 19) * 1.08));
});

test("estimateSignatureHeight is clamped: never below 96, never above 640", () => {
  assert.equal(estimateSignatureHeight(""), 96);
  assert.equal(estimateSignatureHeight("<br>".repeat(200)), 640);
});
