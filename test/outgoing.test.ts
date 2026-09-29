import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleOutgoing, deriveText, htmlToLines, restoreBlockedImages, sanitizeForEditor, sanitizeOutgoing, splitSignature } from "../src/core/outgoing.ts";

const SIG = '<div data-wilco-signature><p>-- </p><p>Robin</p></div>';

test("sanitizeOutgoing keeps the compose subset and data: images, drops script and handlers", () => {
  const out = sanitizeOutgoing('<p onclick="x()">Hi <strong>there</strong></p><script>1</script><img src="data:image/png;base64,AAAA"><img src="https://x/y.png">');
  assert.match(out, /<strong>there<\/strong>/);
  assert.doesNotMatch(out, /script|onclick/);
  assert.match(out, /src="data:image\/png;base64,AAAA"/, "a data: image survives, unblocked");
  assert.match(out, /src="https:\/\/x\/y.png"/, "a remote image is sent as written -- this is OUTGOING mail");
});

test("splitSignature finds the block by its wrapper and balances nested divs", () => {
  const { body, signature } = splitSignature(`<p>Hello</p>${SIG}<p>after</p>`);
  assert.equal(body, "<p>Hello</p><p>after</p>");
  assert.equal(signature, SIG);
  const nested = '<div data-wilco-signature><div><p>a</p></div><p>b</p></div>';
  assert.equal(splitSignature(`<p>x</p>${nested}`).signature, nested);
  assert.deepEqual(splitSignature("<p>no sig</p>"), { body: "<p>no sig</p>", signature: null });
});

test("assembleOutgoing: above = body (signature where it sits) then quote; below = body, quote, signature", () => {
  const quote = { attribution: "On Mon, Kelly wrote:", html: "<p>orig</p>", text: "orig" };
  const above = assembleOutgoing({ html: `<p>Hi</p>${SIG}`, placement: "above", quote });
  assert.ok(above.indexOf("Robin") < above.indexOf("orig"), "signature before the quote");
  assert.match(above, /<blockquote[^>]*>[\s\S]*<p>orig<\/p>[\s\S]*<\/blockquote>/);
  assert.match(above, /On Mon, Kelly wrote:/);
  const below = assembleOutgoing({ html: `<p>Hi</p>${SIG}`, placement: "below", quote });
  assert.ok(below.indexOf("orig") < below.indexOf("Robin"), "signature after the quote");
  assert.equal(assembleOutgoing({ html: "<p>Hi</p>", placement: "above", quote: null }), "<p>Hi</p>");
});

test("a plaintext source is quoted as pre-wrapped lines, escaped", () => {
  const out = assembleOutgoing({ html: "<p>x</p>", placement: "above", quote: { attribution: "a", html: null, text: "1 < 2\nline 2" } });
  assert.match(out, /1 &lt; 2<br>line 2/);
});

test("htmlToLines keeps line structure and every byte inside a line, including a trailing space", () => {
  // A <p> is one line (the editor makes one per Enter); a blank line is an
  // empty paragraph. The separator's trailing space survives.
  assert.equal(htmlToLines("<p>Hi</p><p>-- </p><p>Robin</p>"), "Hi\n-- \nRobin");
  assert.equal(htmlToLines("<p>Hi</p><p><br></p><p>-- </p><p>Robin</p>"), "Hi\n\n-- \nRobin");
  assert.equal(htmlToLines("<div>a<br>b</div><ul><li>one</li><li>two</li></ul>"), "a\nb\n\n- one\n- two");
  assert.equal(htmlToLines("<p>1 &lt; 2 &amp; &quot;q&quot;</p>"), '1 < 2 & "q"');
  assert.equal(htmlToLines('<table><tr><td>ROBIN</td></tr><tr><td>CEO</td></tr></table>'), "ROBIN\nCEO");
  assert.equal(htmlToLines('<p>a<img src="data:image/png;base64,AA" alt="logo">b</p>'), "ab");
  assert.equal(htmlToLines('<a href="https://x">a link</a><p>Paragraph 0</p>'), "a link\nParagraph 0", "inline text before a block does not run on");
});

test("deriveText says what the HTML says, with the quote as > lines and the separator intact", () => {
  const text = deriveText(`<p>Hi</p><p><br></p><p>-- </p><p>Robin</p>`, { attribution: "On Mon, Kelly wrote:", html: null, text: "orig\nmore" });
  assert.equal(text, "Hi\n\n-- \nRobin\n\nOn Mon, Kelly wrote:\n> orig\n> more");
  assert.equal(deriveText("<p>Hi</p>", null), "Hi");
  // The signature block ends the body when placement is below: the quote
  // goes between. deriveText is told the order by being given the pieces.
  assert.equal(deriveText("<p>Hi</p>", { attribution: "X wrote:", html: "<p>o</p>", text: null }, "<p>-- </p><p>K</p>"), "Hi\n\nX wrote:\n> o\n\n-- \nK");
});

test("a multi-line attribution (a forward's header block) keeps its lines in both halves", () => {
  const q = { attribution: "---------- Forwarded message ----------\nFrom: Dana", html: "<p>o</p>", text: "o" };
  assert.match(assembleOutgoing({ html: "<p>x</p>", placement: "above", quote: q }), /Forwarded message ----------<br>From: Dana/);
  assert.equal(deriveText("<p>x</p>", q), "x\n\n---------- Forwarded message ----------\nFrom: Dana\n> o");
});

test("row 44: the quoted original goes through the editor profile and comes back out whole", () => {
  const q = sanitizeForEditor('<p onclick="x()">hi <img src="https://x/logo.png" alt="Logo"> <img src="cid:abc"></p><script>1</script>');
  assert.doesNotMatch(q, /onclick|script/);
  assert.match(q, /<img[^>]*data-wilco-src="https:\/\/x\/logo\.png"[^>]*data-wilco-blocked="1"/, "the remote image is blocked but its URL kept");
  assert.doesNotMatch(q, / src="https:/, "nothing remote is loadable in the editor");
  const out = sanitizeOutgoing(q);
  assert.match(out, /<img src="https:\/\/x\/logo\.png"/, "restored at send");
  assert.doesNotMatch(out, /data-wilco-src/);
  assert.equal(restoreBlockedImages('<img data-wilco-blocked="1" alt="" data-wilco-src="https://a/b.png" width="10">'), '<img src="https://a/b.png" width="10">');
});

test("row 44: a blockquote in the body becomes > lines in the text half, nested per level", () => {
  assert.equal(htmlToLines('<p>Hi</p><div>On Mon, Dana wrote:</div><blockquote><p>one</p><p>two</p><blockquote><p>deep</p></blockquote></blockquote><p>after</p>'),
    "Hi\nOn Mon, Dana wrote:\n\n> one\n> two\n\n> > deep\n\nafter");
});
