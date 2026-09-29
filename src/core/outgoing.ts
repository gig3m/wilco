/**
 * Outgoing HTML (spec 2026-09-07, HTML compose).
 *
 * The SPA's rich editor sends a constrained HTML subset. The server does not
 * trust it: it is sanitized again here (the same scanner as received mail,
 * with the OUTGOING profile), `data:` images become `cid:` parts on the
 * send path, the signature block is placed by the owner's preference, the
 * quoted original is attached, and the text/plain half is derived from the
 * same content -- multipart/alternative must never say two things.
 *
 * The quoted original is assembled HERE and never in the SPA: a sender's
 * HTML does not enter the app's document (spec 3.1). That rule is what this
 * module exists to keep while composing in HTML.
 */
import { sanitizeHtml } from "./sanitize.ts";
import { decodeEntities } from "./corpus.ts";
import { escapeHtml } from "./signature.ts";

export type SignaturePlacement = "above" | "below";

export interface QuoteSource {
  /** "On <date>, <who> wrote:" */
  attribution: string;
  /** The original's HTML, already sanitized with the outgoing profile; null
   *  for a plaintext source. */
  html: string | null;
  /** The original's plain text (the cache's body_text); used for the text
   *  half and for a plaintext source's quote block. */
  text: string | null;
}

/**
 * The outgoing profile: no script, no handlers, no <link>/<meta> (the
 * scanner's job) -- but remote images are SENT as written, since blocking
 * them is a reading-side defence, and a `cid:` reference stays a `cid:`.
 */
export function sanitizeOutgoing(html: string): string {
  // A document that came back from the editor may still carry the editor
  // profile's markers; the scanner re-adds them where they still apply.
  const input = html.replace(/\s*data-wilco-blocked="[^"]*"/gi, "");
  return restoreBlockedImages(sanitizeHtml(input, { resolveCid: (cid) => `cid:${cid}`, allowRemoteImages: true }).html);
}

/**
 * The EDITOR profile for a document the SPA adopts (a signature, a draft,
 * the quoted original -- HTML compose spec 5 and row 44): no script, no
 * handlers, remote images blocked (the SPA's CSP would refuse them anyway)
 * but their URL kept as `data-wilco-src` so the reply goes out with the
 * sender's images intact; `cid:` parts of the original are not carried into
 * a reply (a known limitation) and render as placeholders.
 */
export function sanitizeForEditor(html: string): string {
  return sanitizeHtml(html, { resolveCid: () => null, allowRemoteImages: false, keepBlockedSrc: true }).html;
}

/** `<img data-wilco-blocked="1" data-wilco-src="URL">` back to `<img src="URL">`. */
export function restoreBlockedImages(html: string): string {
  return html.replace(/<img\b([^>]*?)\s*\/?>/gi, (whole, attrs: string) => {
    const m = /\bdata-wilco-src="([^"]*)"/i.exec(attrs);
    if (!m) return whole;
    const rest = attrs
      .replace(/\s*data-wilco-src="[^"]*"/gi, "")
      .replace(/\s*data-wilco-blocked="[^"]*"/gi, "")
      .replace(/\s*alt=""/gi, "")
      .replace(/\s+$/, "");
    return `<img src="${m[1]}"${rest}>`;
  });
}

const SIG_OPEN = /<div\b[^>]*\bdata-wilco-signature\b[^>]*>/i;

/**
 * Finds the signature block by its wrapper (`<div data-wilco-signature>`)
 * and balances its closing tag, so a table-based signature with divs
 * inside comes out whole. Absent -> the body untouched and null.
 */
export function splitSignature(html: string): { body: string; signature: string | null } {
  const m = SIG_OPEN.exec(html);
  if (!m) return { body: html, signature: null };
  const tag = /<\/?div\b[^>]*>/gi;
  tag.lastIndex = m.index;
  let depth = 0;
  let end = -1;
  for (let t = tag.exec(html); t; t = tag.exec(html)) {
    depth += t[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      end = t.index + t[0].length;
      break;
    }
  }
  if (end === -1) return { body: html, signature: null };
  return { body: html.slice(0, m.index) + html.slice(end), signature: html.slice(m.index, end) };
}

function quoteBlock(q: QuoteSource): string {
  const inner =
    q.html !== null
      ? q.html
      : `<div style="white-space:pre-wrap">${escapeHtml(q.text ?? "").replace(/\r?\n/g, "<br>")}</div>`;
  return (
    `<div>${escapeHtml(q.attribution).replace(/\r?\n/g, "<br>")}</div>` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`
  );
}

/**
 * The HTML that goes out. `above`: the editor's HTML as it stands (the
 * signature wherever the owner left it), then the quote. `below`: the body
 * without the block, the quote, the block.
 */
export function assembleOutgoing(input: { html: string; placement: SignaturePlacement; quote: QuoteSource | null }): string {
  if (input.quote === null) return input.html;
  if (input.placement === "above") return input.html + quoteBlock(input.quote);
  const { body, signature } = splitSignature(input.html);
  return body + quoteBlock(input.quote) + (signature ?? "");
}

const BLOCK_END = new Set(["p", "div", "li", "tr", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "table", "ul", "ol"]);
/** Set apart by a blank line on both sides. A <p> is ONE line: the editor
 *  makes a paragraph per Enter, and a blank line is an empty paragraph
 *  (`<p><br></p>`), so paragraph = line keeps the owner's spacing as typed. */
const SET_APART = new Set(["ul", "ol", "table", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * HTML -> lines. Unlike corpus.ts's htmlToText (built for the search index,
 * it collapses ALL whitespace), this keeps line structure and every byte
 * inside a line: RFC 3676's `-- ` separator has a trailing space that must
 * reach the text/plain half intact. Block elements end a line, paragraph-
 * level ones add a blank line, <br> breaks, <li> gets a `- `, a cell ends a
 * line. Tags never contribute text; entities are decoded.
 */
export function htmlToLines(html: string): string {
  const lower = html.toLowerCase();
  const lines: string[] = [];
  let cur = "";
  let i = 0;
  // Quote depth: every line inside a <blockquote> is prefixed `> ` per level
  // (row 44: the quoted original lives in the body now).
  let quote = 0;
  const prefix = () => (quote > 0 ? "> ".repeat(quote) : "");
  const endLine = () => {
    lines.push(cur === "" && quote > 0 ? prefix().trimEnd() : prefix() + cur);
    cur = "";
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      cur += html.slice(i);
      break;
    }
    cur += html.slice(i, lt);
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const raw = lower.slice(lt + 1, gt).trim();
    const closing = raw.startsWith("/");
    const name = (closing ? raw.slice(1) : raw).split(/[\s/]/, 1)[0] ?? "";
    if (!closing && (name === "script" || name === "style")) {
      const close = lower.indexOf(`</${name}`, gt + 1);
      if (close === -1) break;
      const closeEnd = html.indexOf(">", close);
      i = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }
    if (name === "br") {
      endLine();
    } else if (!closing && name === "blockquote") {
      if (cur !== "") endLine();
      lines.push("");
      quote += 1;
    } else if (closing && name === "blockquote") {
      if (cur !== "") endLine();
      quote = Math.max(0, quote - 1);
      lines.push("");
    } else if (!closing && SET_APART.has(name)) {
      if (cur !== "") endLine();
      lines.push("");
    } else if (!closing && (name === "p" || name === "div" || name === "tr") && cur !== "") {
      // Inline text followed by a block opening (`a link<p>…`): the block
      // starts its own line rather than running on.
      endLine();
    } else if (!closing && name === "li") {
      cur += "- ";
    } else if (closing && BLOCK_END.has(name)) {
      if (cur !== "" || lines.length === 0 || lines[lines.length - 1] !== "") endLine();
      if (SET_APART.has(name)) lines.push("");
    }
    i = gt + 1;
  }
  if (cur !== "") lines.push(prefix() + cur);
  // Collapse runs of blank lines to one, trim leading/trailing blanks.
  const out: string[] = [];
  for (const line of lines.map((l) => decodeEntities(l).replace(/ /g, " "))) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * The text/plain half: the body's own words, then the quote as `> ` lines
 * under its attribution, then (placement below) the signature block's
 * lines. Callers pass the pieces in the order the HTML has them.
 */
export function deriveText(bodyHtml: string, quote: QuoteSource | null, trailingSignatureHtml?: string): string {
  const parts: string[] = [htmlToLines(bodyHtml)];
  if (quote !== null) {
    const qtext = quote.text ?? (quote.html !== null ? htmlToLines(quote.html) : "");
    const quoted = qtext
      .split(/\r?\n/)
      .map((l) => (l === "" ? ">" : `> ${l}`))
      .join("\n");
    parts.push(`${quote.attribution}\n${quoted}`);
  }
  if (trailingSignatureHtml !== undefined && trailingSignatureHtml !== "") parts.push(htmlToLines(trailingSignatureHtml));
  return parts.filter((p) => p !== "").join("\n\n");
}
