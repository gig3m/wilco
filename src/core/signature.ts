import { htmlToText } from "./corpus.ts";

/**
 * HTML signatures (spec 11, milestone 8).
 *
 * 🚨 This does NOT make Wilco an HTML mail composer. The body a person types
 * is still plain text; what changes is that a message with an HTML signature
 * goes out as `multipart/alternative` — a `text/plain` half (body +
 * `textSignature`) and a `text/html` half (the body escaped, plus
 * `htmlSignature`). §3.1's rule is about message HTML never entering the
 * SPA's document, which is a statement about RENDERING RECEIVED mail; it
 * does not forbid the server from generating an HTML part it never renders.
 * Owner ruling 2026-09-05: HTML signatures are required.
 *
 * The logo rule from spec 11 is the subtle half: signatures are
 * **`data:`-stored and `cid:`-sent**. Fastmail stores base64 `data:` images
 * in `htmlSignature` byte-identically, but a `data:` image in a SENT message
 * is stripped or blocked by many receiving clients. So on the way out, every
 * `data:` image is uploaded as a blob and its `src` rewritten to `cid:`.
 *
 * ⚠️ And the trap that makes it hard to verify: **a `cid:` image in a sent
 * message does not appear in `Email/get`'s `attachments`** (spec 11
 * [research]). Fastmail renders the reference as a placeholder span and the
 * part is reachable only through `allParts`. Scanning `attachments` for the
 * logo finds nothing and looks exactly like proof it was never attached.
 */

export interface DataImage {
  /** `image/png`, etc., as declared in the data URL. */
  type: string;
  bytes: Buffer;
  /** The Content-ID this image will be sent as, without angle brackets. */
  cid: string;
  /** A filename for the part. Recipients' clients show it on download. */
  name: string;
}

export interface PreparedSignature {
  /** The signature HTML with every `data:` image rewritten to `cid:`. */
  html: string;
  images: DataImage[];
}

/** Matches a `data:` URL inside an attribute value. Bounded and anchored on
 *  both quote styles so it cannot run away over a long document (spec
 *  6.11's linear rule applies to anything touching mail-shaped input). */
const DATA_IMAGE = /(["'])(data:image\/([a-z0-9.+-]{1,20});base64,([A-Za-z0-9+/=\s]{1,10000000}?))\1/gi;

/**
 * Rewrites `data:` images in a signature to `cid:` references and returns
 * the bytes to upload.
 *
 * `cidFor` generates each Content-ID so the caller controls uniqueness
 * across a whole message (a reply's quoted history may already carry cids).
 */
export function prepareSignatureImages(html: string, cidFor: (index: number) => string): PreparedSignature {
  const images: DataImage[] = [];
  const out = html.replace(DATA_IMAGE, (whole, quote: string, _url: string, subtype: string, b64: string) => {
    // Whitespace inside base64 is legal in a data URL and fatal to
    // Buffer.from if left in.
    const cleaned = b64.replace(/\s+/g, "");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(cleaned, "base64");
    } catch {
      return whole;
    }
    // A zero-length decode means the payload was not really base64. Leave
    // it alone rather than sending an empty part: a broken image the
    // recipient can see beats a silently dropped one.
    if (bytes.length === 0) return whole;

    const index = images.length;
    const cid = cidFor(index);
    images.push({
      type: `image/${subtype.toLowerCase()}`,
      bytes,
      cid,
      name: `signature-${index + 1}.${extensionFor(subtype)}`,
    });
    return `${quote}cid:${cid}${quote}`;
  });
  return { html: out, images };
}

function extensionFor(subtype: string): string {
  const s = subtype.toLowerCase();
  if (s === "jpeg") return "jpg";
  if (s === "svg+xml") return "svg";
  return s.replace(/[^a-z0-9]/g, "") || "img";
}

/**
 * The `text/html` half of an outgoing message: the plaintext body the user
 * typed, escaped and line-broken, followed by the HTML signature.
 *
 * 🚨 The body is ESCAPED, not passed through. A person typing `<b>` into the
 * plaintext editor means those five characters, and emitting them as markup
 * would silently change their message — and would make the plaintext and
 * HTML halves say different things, which is the one thing
 * multipart/alternative must never do.
 */
export function buildHtmlBody(text: string, signatureHtml: string): string {
  const body = escapeHtml(text).replace(/\r?\n/g, "<br>\n");
  if (signatureHtml === "") return `<div>${body}</div>`;
  // A blank line between body and signature, matching what the plaintext
  // half does with "\n\n".
  return `<div>${body}</div><div><br></div><div>${signatureHtml}</div>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The plaintext rendition of an HTML signature, for the `text/plain` half
 * when the identity has no separate `textSignature`.
 *
 * Spec 11 calls this "derive the plaintext half". Deriving beats leaving it
 * empty: a recipient whose client prefers text/plain would otherwise get a
 * message with no signature at all while the HTML reader sees one.
 */
export function derivePlainSignature(signatureHtml: string): string {
  return htmlToText(signatureHtml);
}

/**
 * A GENEROUS estimate of how tall an HTML signature renders in the body
 * frame, in CSS pixels, for the Settings preview.
 *
 * 🚨 This existed before, was deleted when handoff v1.1 gave the compose
 * frame a fixed 110px ceiling (which needs no measurement), and is BACK by
 * owner ruling (2026-09-06, "the signature interface is poor"): the
 * Settings preview shows the WHOLE signature at its natural height, and the
 * HTML half is edited in Fastmail, not here. Compose keeps the fixed frame.
 *
 * A cross-origin frame cannot be measured, and script inside it is the one
 * thing the frame exists to forbid, so an estimate is all there is. The two
 * failure modes are not symmetric -- blank space below a preview costs
 * nothing, a clipped signature is the bug -- so every constant errs tall.
 * Row 38 measures the real rendered height against the frame.
 */
export function estimateSignatureHeight(html: string): number {
  // 🚨 PAD is 56 because the served document (bodyhost's renderDocument)
  // puts `padding: 12px` on BOTH html and body -- 48px vertically, not the
  // 24 it looks like. The first version budgeted 28 and came out 13px short
  // on the real signature it was written for: the last line was sliced in
  // half. Measured: frame 344px against a content scrollHeight of 357px.
  const PAD = 56;
  const LINE = 19;
  const CUSHION = 1.08;
  const MIN = 96;
  const MAX = 640;

  // 🚨 Each <img> tag is isolated by a plain scan BEFORE its height is read.
  // A regex reaching from `<img` to `height=` needs a bound, and any bound
  // small enough to be safe is smaller than a base64 `data:` URL -- which
  // sits between them, and is exactly where a real signature logo puts its
  // dimensions. The first version bounded at 600 characters and silently
  // matched nothing on the one signature that mattered.
  const lower = html.toLowerCase();
  let images = 0;
  let imgCount = 0;
  let declared = 0;
  let cursor = 0;
  for (;;) {
    const start = lower.indexOf("<img", cursor);
    if (start === -1) break;
    const end = html.indexOf(">", start);
    const tag = end === -1 ? html.slice(start) : html.slice(start, end + 1);
    cursor = end === -1 ? html.length : end + 1;
    imgCount += 1;

    const attr = /\bheight\s*=\s*["']?(\d{1,4})/i.exec(tag);
    const styled = /height:\s*(\d{1,4})px/i.exec(tag);
    const h = attr ? Number(attr[1]) : styled ? Number(styled[1]) : null;
    if (h !== null) {
      images += h;
      declared += 1;
    }
  }
  // An image with no declared height counts as a typical logo rather than
  // as nothing -- nothing would under-estimate, which is the failure that
  // hides content.
  images += (imgCount - declared) * 120;

  // Text lines: every block close or explicit break starts one.
  const breaks = (html.match(/<br\b|<\/p>|<\/div>|<\/tr>|<\/h[1-6]>|<\/li>/gi) ?? []).length;

  return Math.min(MAX, Math.max(MIN, Math.ceil((PAD + images + breaks * LINE) * CUSHION)));
}
