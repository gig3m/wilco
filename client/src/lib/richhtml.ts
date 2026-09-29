// The rich-HTML serialiser (HTML compose spec 3.1).
//
// The ONLY path from the editable document to the network. It walks the
// DOM the browser built under contenteditable and emits a constrained
// subset; anything outside it is unwrapped to its text. It never reads
// `innerHTML`/`outerHTML` -- that would hand the browser's own serialisation
// straight through, which is the thing this file exists not to do. The
// server sanitizes the result again; this is the client's half of the
// defence, and the half that decides what the OWNER can express.

/** Tags that survive, with the attributes each may carry. */
export const ALLOWED_TAGS: Readonly<Record<string, readonly string[]>> = {
  p: ["style"],
  div: ["style", "data-wilco-signature", "data-wilco-quote", "data-wilco-attribution"],
  br: [],
  strong: [],
  em: [],
  u: [],
  s: [],
  a: ["href"],
  ul: [],
  ol: [],
  li: [],
  blockquote: ["type", "data-wilco-quote", "style"],
  table: [],
  tbody: [],
  tr: [],
  td: ["style"],
  img: ["src", "alt", "width", "height", "data-wilco-blocked", "data-wilco-src"],
  span: ["style"],
};

/** Normalised to the canonical tag before the table above is consulted. */
const ALIASES: Readonly<Record<string, string>> = { b: "strong", i: "em", strike: "s", del: "s", thead: "tbody", th: "td" };

/** CSS declarations re-emitted from `el.style`, by name. Values are
 *  re-serialised from the parsed declaration, never copied from the
 *  attribute, and a value carrying `url(`/`expression(` is dropped. */
export const ALLOWED_STYLES: readonly string[] = ["color", "background-color", "font-family", "font-size", "text-align"];

const VOID = new Set(["br", "img", "hr"]);

/** Inside the quoted original (row 44) the SENDER's markup is kept far more
 *  generously -- it is their layout, not the owner's expression -- with the
 *  same hard exclusions. The server re-sanitizes it on the way out. */
const QUOTE_DROP = new Set(["script", "style", "template", "noscript", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "link", "meta", "svg", "math", "base", "frame", "frameset", "applet"]);
const QUOTE_ATTRS = new Set(["style", "href", "src", "alt", "width", "height", "align", "valign", "bgcolor", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "dir", "type", "data-wilco-blocked", "data-wilco-src", "data-wilco-quote", "data-wilco-attribution"]);
const UNSAFE_STYLE = /url\(|expression\(|javascript:|@import|behavior:|-moz-binding|position\s*:\s*fixed/i;
const SAFE_HREF = /^(https?:|mailto:)/i;
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;
const CID = /^cid:[^"'\s<>]+$/;

export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function isSignatureBlock(el: Element): boolean {
  return el.tagName.toLowerCase() === "div" && el.hasAttribute("data-wilco-signature");
}

function styleOf(el: Element): string | null {
  const style = (el as HTMLElement).style;
  if (!style) return null;
  const out: string[] = [];
  for (const name of ALLOWED_STYLES) {
    const value = style.getPropertyValue(name).trim();
    if (value === "" || /url\(|expression\(|javascript:/i.test(value) || /[<>"]/.test(value)) continue;
    out.push(`${name}:${value}`);
  }
  return out.length ? out.join(";") : null;
}

function attributesOf(tag: string, el: Element, paste = false): string {
  const parts: string[] = [];
  for (const name of ALLOWED_TAGS[tag] ?? []) {
    let value: string | null;
    // A paste keeps structure and emphasis, never the source page's CSS or
    // Wilco's own markers (row 45, Fastmail's rule measured 2026-09-07).
    if (paste && (name === "style" || name.startsWith("data-wilco-"))) continue;
    if (name === "style") {
      value = styleOf(el);
    } else if (name === "data-wilco-signature") {
      value = el.hasAttribute(name) ? "" : null;
    } else {
      value = el.getAttribute(name);
    }
    if (value === null) continue;
    if (name === "href" && !SAFE_HREF.test(value)) continue;
    if (name === "src" && !(DATA_IMAGE.test(value) || CID.test(value))) continue;
    if (name === "data-wilco-src" && !/^https?:\/\//i.test(value)) continue;
    if (name === "data-wilco-blocked" && value !== "1") continue;
    if ((name === "width" || name === "height") && !/^\d{1,4}$/.test(value)) continue;
    parts.push(name === "data-wilco-signature" ? ` ${name}` : ` ${name}="${escapeText(value)}"`);
  }
  return parts.join("");
}

function quoteAttributesOf(el: Element): string {
  const parts: string[] = [];
  for (const a of Array.from(el.attributes)) {
    const name = a.name.toLowerCase();
    if (!QUOTE_ATTRS.has(name)) continue;
    let value = a.value;
    if (name === "style") {
      if (UNSAFE_STYLE.test(value)) continue;
      // Chrome copies the editor's own computed styles (`color: var(--ink)`)
      // onto text it merges while the owner edits inside the quote; a
      // recipient has no such variables. Those declarations are noise.
      value = value.split(";").filter((d) => d.trim() !== "" && !/var\(/.test(d)).join(";").replace(/[<>"]/g, "");
      if (value === "") continue;
    } else if (name === "href" && !SAFE_HREF.test(value)) continue;
    else if (name === "src" && !(DATA_IMAGE.test(value) || CID.test(value))) continue;
    else if (name === "data-wilco-src" && !/^https?:\/\//i.test(value)) continue;
    else if (name === "data-wilco-quote" || name === "data-wilco-attribution") { parts.push(` ${name}`); continue; }
    parts.push(` ${name}="${escapeText(value)}"`);
  }
  return parts.join("");
}

function walkQuoted(node: Node, out: string[]): void {
  if (node.nodeType === 3) {
    out.push(escapeText(node.nodeValue ?? ""));
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (QUOTE_DROP.has(tag)) return;
  if (!/^[a-z][a-z0-9]*$/.test(tag)) return; // custom elements and namespaced tags: dropped whole
  const attrs = quoteAttributesOf(el);
  if (tag === "img" && !/ (src|data-wilco-src)=/.test(attrs)) return;
  if (VOID.has(tag) || ["col", "area", "wbr"].includes(tag)) {
    out.push(`<${tag}${attrs}>`);
    return;
  }
  out.push(`<${tag}${attrs}>`);
  for (const child of Array.from(el.childNodes)) walkQuoted(child, out);
  out.push(`</${tag}>`);
}

function walk(node: Node, out: string[], paste: boolean): void {
  if (node.nodeType === 3) {
    out.push(escapeText(node.nodeValue ?? ""));
    return;
  }
  if (node.nodeType !== 1) return; // comments, processing instructions: dropped
  const el = node as Element;
  const raw = el.tagName.toLowerCase();
  const tag = ALIASES[raw] ?? raw;
  // The quoted original keeps its own markup (row 44) -- but a PASTE never
  // gets to declare a quote.
  if (!paste && el.hasAttribute("data-wilco-quote")) {
    walkQuoted(el, out);
    return;
  }
  if (!(tag in ALLOWED_TAGS)) {
    // script/style/template contents are not text a person typed.
    if (raw === "script" || raw === "style" || raw === "template" || raw === "noscript") return;
    for (const child of Array.from(el.childNodes)) walk(child, out, paste);
    return;
  }
  if (VOID.has(tag)) {
    // An <img> whose src was refused is dropped whole: a bare <img> is a
    // broken-image icon, not content.
    const attrs = attributesOf(tag, el, paste);
    if (tag === "img" && !/ (src|data-wilco-src)=/.test(attrs)) return;
    out.push(`<${tag}${attrs}>`);
    return;
  }
  out.push(`<${tag}${attributesOf(tag, el, paste)}>`);
  for (const child of Array.from(el.childNodes)) walk(child, out, paste);
  out.push(`</${tag}>`);
}

/** The constrained HTML of everything under `root` (root itself excluded). */
export function serialize(root: Element): string {
  const out: string[] = [];
  for (const child of Array.from(root.childNodes)) walk(child, out, false);
  return out.join("");
}

/** A paste's HTML reduced to what survives (row 45): the subset's structure
 *  and emphasis, links, data: images; no styles, no headings (their text
 *  stays), no Wilco markers. What comes out is what the editor inserts. */
export function serializePaste(root: Element): string {
  const out: string[] = [];
  for (const child of Array.from(root.childNodes)) walk(child, out, true);
  return out.join("");
}
