/**
 * Entity decoding in the plaintext rendition (audit pass 4).
 *
 * `body_text` is what the reading pane shows and what the FTS index is built
 * from, so an entity left undecoded there is both visible clutter and a
 * search miss. Measured on the live archive before the fix: 1,119 messages
 * carried a literal `&#nn;`, 427 carried `&zwnj;`, 272 smart quotes, 271
 * `&quot;`, 267 dashes. A body storing `don&#39;t` tokenizes as
 * `don`/`39`/`t` under unicode61, so the phrase a person types cannot match.
 *
 * These cases are the ones that were actually failing, plus the two that
 * must NOT change (double-decoding, and an undecodable reference).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../src/core/corpus.ts";

test("numeric and named references are decoded, not left verbatim", () => {
  assert.equal(htmlToText("<p>don&#39;t</p>"), "don't");
  assert.equal(htmlToText("<p>caf&eacute;</p>"), "café");
  assert.equal(htmlToText("<p>&#x2014;</p>"), "—");
  assert.equal(htmlToText("<p>&mdash;</p>"), "—");
  assert.equal(htmlToText("<p>&rsquo;</p>"), "’");
  assert.equal(htmlToText("<p>say &quot;hi&quot;</p>"), 'say "hi"');
});

test("zero-width padding is REMOVED, not turned into a space", () => {
  // Marketing mail pads its preheader with hundreds of `&zwnj;` so the
  // preview line looks empty. Decoding them to a space would replace one
  // kind of clutter with another; they carry no text.
  assert.equal(htmlToText("<p>&zwnj;&zwnj;&zwnj;Sale ends today</p>"), "Sale ends today");
  assert.equal(htmlToText("<p>a&nbsp;b</p>"), "a b");
});

test("🚨 `&amp;` is decoded LAST, so nothing double-decodes", () => {
  // A message that literally wrote out an escaped tag -- mail about HTML,
  // which this codebase receives -- must not silently gain markup it never
  // contained. Decoding `&amp;` first turns `&amp;lt;` into `&lt;` and then
  // into `<`.
  assert.equal(htmlToText("<p>&amp;lt;b&amp;gt;</p>"), "&lt;b&gt;");
  assert.equal(htmlToText("<p>a &amp; b</p>"), "a & b");
});

test("🚨 tab, LF and CR decode; every other control does not", () => {
  // The three whitespace characters HTML actually writes numerically. An
  // earlier version of the fix rejected the whole `< 0x20` range and left
  // 1,023 literal `&#10;` and 921 `&#9;` in the archive. htmlToText
  // collapses whitespace right after decoding, so these become a space.
  assert.equal(htmlToText("<p>a&#10;b</p>"), "a b");
  assert.equal(htmlToText("<p>a&#9;b</p>"), "a b");
  assert.equal(htmlToText("<p>a&#13;b</p>"), "a b");
  // A bell or a NUL is invisible, cannot help a reader, and would go into
  // the FTS index. Left as written.
  assert.equal(htmlToText("<p>&#7;</p>"), "&#7;");
  assert.equal(htmlToText("<p>&#0;</p>"), "&#0;");
});

test("an undecodable reference is left exactly as written", () => {
  // Data, not damage: a replacement character would destroy the only
  // evidence of what the sender wrote.
  assert.equal(htmlToText("<p>&#99999999;</p>"), "&#99999999;");
  assert.equal(htmlToText("<p>&#xD800;</p>"), "&#xD800;"); // lone surrogate
  assert.equal(htmlToText("<p>&unknownref;</p>"), "&unknownref;");
});

test("decoding stays linear on adversarial input", () => {
  // Same rule as the rest of htmlToText (spec 6.11). The digit counts are
  // bounded in the pattern precisely so a runaway `&#000...` cannot make
  // the engine do super-linear work.
  const evil = "&#" + "0".repeat(200_000) + ";" + "&#".repeat(50_000);
  const started = Date.now();
  htmlToText(evil);
  assert.ok(Date.now() - started < 250, "entity decoding went super-linear");
});
