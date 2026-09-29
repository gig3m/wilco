// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";
import { ALLOWED_STYLES, ALLOWED_TAGS, serialize } from "./richhtml";

// Hostile DOM is built by the parser, never assigned through innerHTML:
// escape.test.ts bans that assignment in every client file, tests included,
// and this test must not be the exception that teaches otherwise. DOMParser
// is what RichEditor itself uses to adopt a sanitized document.
function root(inner: string): Element {
  return new DOMParser().parseFromString(`<body><div id="r">${inner}</div></body>`, "text/html").getElementById("r")!;
}

test("keeps the subset, unwraps everything else to text, drops script/style bodies", () => {
  assert.equal(
    serialize(root("<p>a <strong>b</strong> <em>c</em> <u>d</u> <s>e</s></p><ul><li>x</li></ul><blockquote>q</blockquote>")),
    "<p>a <strong>b</strong> <em>c</em> <u>d</u> <s>e</s></p><ul><li>x</li></ul><blockquote>q</blockquote>",
  );
  assert.equal(serialize(root("<p><marquee>m</marquee><font size=7>f</font><script>1</script><style>p{}</style></p>")), "<p>mf</p>");
  assert.equal(serialize(root("<b>x</b><i>y</i><strike>z</strike>")), "<strong>x</strong><em>y</em><s>z</s>");
});

test("attributes: href only http/https/mailto; img src only data:image or cid:; no handlers; the signature marker survives bare", () => {
  assert.equal(serialize(root('<a href="javascript:alert(1)" onclick="x()">l</a>')), "<a>l</a>");
  assert.equal(serialize(root('<a href="https://x.y/?a=1&amp;b=2">l</a>')), '<a href="https://x.y/?a=1&amp;b=2">l</a>');
  assert.equal(serialize(root('<a href="mailto:a@b.c">m</a>')), '<a href="mailto:a@b.c">m</a>');
  assert.equal(serialize(root('<img src="https://x/y.png"><img src="data:image/png;base64,AAAA" alt="logo" width="10">')), '<img src="data:image/png;base64,AAAA" alt="logo" width="10">');
  assert.equal(serialize(root('<img src="cid:img0.abc@wilco">')), '<img src="cid:img0.abc@wilco">');
  assert.equal(serialize(root('<div data-wilco-signature data-x="1" id="q"><p>-- </p></div>')), "<div data-wilco-signature><p>-- </p></div>");
});

test("style is re-serialised from a whitelist, never copied", () => {
  assert.equal(serialize(root('<span style="color: red; position: fixed; font-size: 12px">s</span>')), '<span style="color:red;font-size:12px">s</span>');
  assert.equal(serialize(root('<p style="text-align: center">c</p>')), '<p style="text-align:center">c</p>');
  assert.equal(serialize(root('<span style="background-color: url(x)">u</span>')), "<span>u</span>");
  assert.deepEqual([...ALLOWED_STYLES], ["color", "background-color", "font-family", "font-size", "text-align"]);
  assert.ok(!("iframe" in ALLOWED_TAGS) && !("form" in ALLOWED_TAGS) && !("svg" in ALLOWED_TAGS));
});

test("text is escaped; a table survives; comments vanish", () => {
  assert.equal(serialize(root('<p>1 &lt; 2 &amp; "q"</p>')), "<p>1 &lt; 2 &amp; &quot;q&quot;</p>");
  assert.equal(serialize(root("<table><tbody><tr><td>c</td></tr></tbody></table>")), "<table><tbody><tr><td>c</td></tr></tbody></table>");
  assert.equal(serialize(root("<p>a<!-- hidden -->b</p>")), "<p>ab</p>");
});

test("row 44: inside the quoted original the sender's markup survives (tables, headings, styles), the hard exclusions do not", () => {
  const q = '<blockquote type="cite" data-wilco-quote><table cellpadding="4" style="width:100%"><tr><td bgcolor="#eee"><h2 style="color:red">Hi</h2><script>1</script><object data="x">o</object><a href="javascript:x" onclick="y">l</a><img data-wilco-blocked="1" data-wilco-src="https://x/p.png" alt=""><div style="background:url(x)">u</div></td></tr></table></blockquote>';
  const out = serialize(root(q));
  assert.match(out, /^<blockquote type="cite" data-wilco-quote><table cellpadding="4" style="width:100%"><tr><td bgcolor="#eee"><h2 style="color:red">Hi<\/h2>/);
  assert.doesNotMatch(out, /script|object|onclick|javascript/);
  assert.match(out, /<a>l<\/a>/);
  assert.match(out, /<img data-wilco-blocked="1" data-wilco-src="https:\/\/x\/p\.png" alt="">/);
  assert.match(out, /<div>u<\/div>/, "a style with url() is dropped");
  assert.equal(serialize(root('<blockquote data-wilco-quote><p><span style="color: var(--ink); font-family: var(--font-sans);">x</span><span style="color:red; margin: var(--m)">y</span></p></blockquote>')),
    '<blockquote data-wilco-quote><p><span>x</span><span style="color:red">y</span></p></blockquote>', "the editor's var() noise is dropped, real declarations stay");
  // Outside a quote the owner's subset still applies.
  assert.equal(serialize(root("<h2>plain</h2>")), "plain");
});
