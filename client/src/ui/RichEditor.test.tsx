// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";
import { byTestId, render, tick } from "../test-utils";
import { RichEditor, SWATCHES, normaliseLink, type RichEditorHandle } from "./RichEditor";

function mount(opts: { onInput?: () => void } = {}) {
  const handle = { current: null as RichEditorHandle | null };
  render(<RichEditor testId="compose-body" handle={handle} signatureTestId="compose-signature" onInput={opts.onInput} />);
  return handle;
}

test("opens as one empty paragraph and reports itself empty", async () => {
  const h = mount();
  await tick();
  assert.equal(h.current!.html(), "<p><br></p>");
  assert.equal(h.current!.isEmpty(), true);
});

test("adopts a sanitized document as nodes; a signature is wrapped in the marker block and does not count as content", async () => {
  let inputs = 0;
  const h = mount({ onInput: () => inputs++ });
  await tick();
  h.current!.adopt('<table><tbody><tr><td><img src="data:image/png;base64,AAAA" height="60"></td></tr></tbody></table><p>-- </p><p>Robin</p>', { asSignature: true });
  assert.equal(h.current!.isEmpty(), true, "a signature alone is not a message");
  h.current!.adopt('<div data-wilco-attribution>X wrote:</div><blockquote data-wilco-quote><p>orig</p></blockquote>');
  assert.equal(h.current!.isEmpty(), true, "a quoted original is not a message either (row 44)");
  assert.equal(byTestId("compose-signature").getAttribute("data-wilco-signature"), "");
  const sig = h.current!.signatureHtml();
  assert.ok(sig!.startsWith("<div data-wilco-signature><table>"), sig!);
  assert.ok(sig!.endsWith("<p>-- </p><p>Robin</p></div>"), "the separator's trailing space survives the round trip");
  h.current!.adopt("<p>Hello <strong>there</strong></p>", { at: "start" });
  assert.equal(h.current!.isEmpty(), false);
  assert.ok(h.current!.html().startsWith("<p>Hello <strong>there</strong></p>"));
  assert.equal(inputs, 0, "adoption is silent -- it is not the owner writing");
  assert.equal(h.current!.removeSignature(), true);
  assert.equal(h.current!.signatureHtml(), null);
  assert.equal(h.current!.removeSignature(), false);
});

test("a resumed draft REPLACES the empty first line; a signature is added after it", async () => {
  const h = mount();
  await tick();
  h.current!.adopt("<p>draft</p>", { replace: true });
  assert.equal(h.current!.html(), "<p>draft</p>", "no stray empty paragraph above the draft");
  const g = mount();
  await tick();
  g.current!.adopt("<p>-- </p>", { asSignature: true });
  assert.equal(g.current!.html(), "<p><br></p><div data-wilco-signature><p>-- </p></div>");
});

function paste(root: HTMLElement, data: Record<string, string>, files: File[] = []): Event {
  const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
  Object.defineProperty(ev, "clipboardData", { value: { getData: (t: string) => data[t] ?? "", files } });
  root.dispatchEvent(ev);
  return ev;
}

test("ROW 45: a paste keeps lists, links, bold and italic; drops headings, block wrappers, inline CSS, scripts and Wilco markers", async () => {
  const h = mount();
  await tick();
  const ev = paste(byTestId("compose-body"), {
    "text/html": '<h2 style="color:red;font-family:x">Heading</h2><ul><li><strong>one</strong></li><li><em>two</em> <a href="https://x.y/p" onclick="z()">link</a></li></ul><p style="background-color:#ff0">hl</p><script>evil()</script><div data-wilco-signature><p>fake sig</p></div>',
    "text/plain": "Heading\none\ntwo link\nhl",
  });
  assert.equal(ev.defaultPrevented, true);
  const html = h.current!.html();
  assert.ok(html.includes("<ul><li><strong>one</strong></li><li><em>two</em> <a href=\"https://x.y/p\">link</a></li></ul>"), html);
  assert.ok(html.includes("Heading") && !html.includes("<h2"), "the heading's text stays, the element goes");
  assert.ok(!html.includes("style=") && !html.includes("evil") && !html.includes("onclick"), html);
  assert.ok(!html.includes("data-wilco-signature"), "a paste cannot declare a signature block");
});

test("a paste with only text/plain inserts lines", async () => {
  const h = mount();
  await tick();
  paste(byTestId("compose-body"), { "text/plain": "line one\nline two" });
  assert.ok(h.current!.html().includes("line one<br>line two"), h.current!.html());
});

test("Fastmail's bar: seventeen commands, a font picker, a size picker, and the image input", async () => {
  mount();
  await tick();
  for (const id of ["bold", "italic", "underline", "strike", "clear", "color", "highlight", "image", "link", "ul", "ol", "quote-in", "quote-out", "align-left", "align-center", "align-right", "align-justify"]) {
    assert.ok(byTestId(`rt-${id}`), `rt-${id}`);
  }
  assert.equal(byTestId("rt-font").querySelectorAll("option").length, 9, "Default + Fastmail's eight faces");
  assert.deepEqual(Array.from(byTestId("rt-size").querySelectorAll("option")).map((o) => o.textContent), ["Size", "Small", "Medium", "Large", "Huge"]);
  assert.equal(byTestId("rt-image-file").getAttribute("accept"), "image/*");
  // The below-the-quote region has no bar.
  render(<RichEditor testId="compose-signature-below" toolbar={false} />);
  await tick();
  assert.equal(byTestId("compose-signature-below-toolbar", { optional: true }), null);
});

test("ROW 46: the colour and highlight buttons open Fastmail's 40-swatch grid; Escape closes it", async () => {
  mount();
  await tick();
  assert.equal(SWATCHES.length, 40);
  byTestId("rt-color").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await tick();
  const grid = byTestId("rt-color-grid");
  assert.equal(grid.querySelectorAll('[data-testid^="rt-swatch-"]').length, 40);
  assert.ok(byTestId("rt-swatch-ff0000"));
  byTestId("compose-body").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick();
  assert.equal(byTestId("rt-color-grid", { optional: true }), null);
});

test("ROW 46: Ctrl-K opens the link popover; Add link closes it; a bare host gets https, an address gets mailto", async () => {
  mount();
  await tick();
  const body = byTestId("compose-body");
  const ev = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
  body.dispatchEvent(ev);
  await tick();
  assert.equal(ev.defaultPrevented, true, "the browser's Ctrl-K is taken over");
  const input = byTestId("rt-link-url") as HTMLInputElement;
  assert.equal(input.getAttribute("placeholder"), "e.g. www.example.com");
  input.value = "www.example.com";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  byTestId("rt-link-add").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(byTestId("rt-link-popover", { optional: true }), null, "closed after Add");
  assert.equal(normaliseLink("www.example.com"), "https://www.example.com");
  assert.equal(normaliseLink("robin@halden.example"), "mailto:robin@halden.example");
  assert.equal(normaliseLink("https://x.y/z"), "https://x.y/z");
  assert.equal(normaliseLink("not a url"), null);
});
