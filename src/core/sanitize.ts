/**
 * The message-HTML sanitizer (spec 6.4, 6.11).
 *
 * 🚨 **This is NOT the security boundary.** Spec 6.1 is explicit, and it is
 * explicit because Dovetail inverted exactly this assumption after building:
 * declarative settings the browser enforces cannot be subtly wrong the way a
 * hand-written sanitizer can, and mutation XSS exists precisely because
 * sanitizers are hard to write correctly. Script is stopped by `sandbox` in
 * the CSP HEADER and by `default-src 'none'`; network is stopped by the
 * directives in 6.2; reach into Wilco is stopped by a separate origin with
 * no `allow-same-origin`. This file is hygiene layered on top of those.
 *
 * It exists because two things the CSP genuinely cannot stop must still be
 * removed here -- see `DROP_ELEMENT_ONLY` -- and because a document full of
 * dead `onclick` attributes is worse to debug than one without them.
 *
 * Hand-written because the server has zero runtime dependencies and imports
 * nothing outside `node:`. That constraint is only acceptable given the
 * paragraph above; it would not be acceptable for a primary defence.
 */

export interface SanitizeOptions {
  /** Resolves a `cid:` reference to a URL on the body origin under the
   *  message's own capability token, or null if the message has no such
   *  part. */
  resolveCid: (cid: string) => string | null;
  /** Remote images are blocked in pass 1 (spec 6.6: v1 blocks rather than
   *  proxies). The seam is here so the opt-in is a flag, not a rewrite. */
  allowRemoteImages?: boolean;
  /** When a remote image is blocked, keep its URL as `data-wilco-src` so a
   *  document that goes back OUT (the quoted original in a reply, HTML
   *  compose row 44) can be restored to the sender's image at send. Off
   *  for reading: nothing about a blocked image should survive there. */
  keepBlockedSrc?: boolean;
}

export interface SanitizeResult {
  html: string;
  /** How many remote images were stripped, reported to the CHROME outside
   *  the frame (spec 6.8) -- never rendered into the message document. */
  blockedRemoteImages: number;
}

/**
 * Removed with their contents. Script is belt-and-braces over the sandbox;
 * the frame elements are so that a nested browsing context can never be
 * created inside a document we have already decided cannot run code.
 */
const DROP_WITH_CONTENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "noembed",
  "noframes",
  "template",
]);

/**
 * The tag is dropped; any contents stay. These are the two the CSP cannot
 * help with, plus `<base>`, and they are the reason this file is not
 * optional:
 *
 * `<link rel="preconnect">` and `rel="dns-prefetch"` are governed by **no
 * CSP directive at all**. Probed under the full 6.2 policy, a preconnect
 * produced a real TCP+TLS connection with no CSP violation and no HTTP
 * request. A sender writing
 * `<link rel="preconnect" href="https://u-{recipient}.track.example">`
 * therefore gets a handshake from the reader's IP and a per-recipient DNS
 * lookup at their own authoritative server -- a complete open-confirmation
 * channel that bypasses the remote-image block entirely. Dovetail's
 * `webRequest` filter would not have caught it either; neither codebase had
 * a fixture for it.
 *
 * `<meta name="referrer" content="unsafe-url">` is the same class of thing.
 * `<base>` is here because `base-uri 'none'` already covers it and a
 * belt-and-braces strip costs nothing.
 */
const DROP_ELEMENT_ONLY = new Set(["link", "meta", "base"]);

/** Attributes whose value is a URL and must therefore be scheme-checked. */
const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "background",
  "poster",
  "cite",
  "longdesc",
  "data",
  "ping",
  "srcset",
  "xlink:href",
]);

/** Never re-emitted, whatever their value. `srcdoc` would smuggle a whole
 *  document past the element checks above. */
const DROP_ATTRS = new Set(["srcdoc", "sandbox", "http-equiv", "nonce", "integrity"]);

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export function sanitizeHtml(input: string, opts: SanitizeOptions): SanitizeResult {
  const lower = input.toLowerCase();
  const out: string[] = [];
  let blockedRemoteImages = 0;
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out.push(input.slice(i));
      break;
    }
    // Text runs are emitted VERBATIM. They cannot contain `<` (we split on
    // it), and re-escaping `&` here would double-encode every entity the
    // sender wrote -- turning `&amp;` in a URL into visible text.
    if (lt > i) out.push(input.slice(i, lt));

    // Comments, doctypes and processing instructions: skipped whole. A
    // comment is skipped rather than kept because a malformed one is a
    // classic way to smuggle markup past a naive parser, and no message
    // needs its comments rendered.
    if (lower.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input[lt + 1] === "!" || input[lt + 1] === "?") {
      const end = input.indexOf(">", lt + 1);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const tag = parseTag(input, lt);
    if (tag === null) {
      // A stray `<` that does not begin a tag. Emit it as an entity so it
      // cannot combine with later text into one.
      out.push("&lt;");
      i = lt + 1;
      continue;
    }

    const name = tag.name;

    if (DROP_WITH_CONTENTS.has(name)) {
      i = tag.closing ? tag.end : skipElement(lower, name, tag.end);
      continue;
    }
    if (DROP_ELEMENT_ONLY.has(name)) {
      i = tag.end;
      continue;
    }
    if (tag.closing) {
      out.push(`</${name}>`);
      i = tag.end;
      continue;
    }

    const rendered = renderTag(tag, opts, () => {
      blockedRemoteImages++;
    });
    out.push(rendered);
    i = tag.end;
  }

  return { html: out.join(""), blockedRemoteImages };
}

interface Attr {
  name: string;
  value: string | null;
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Attr[];
  /** Index just past the tag's `>`. */
  end: number;
}

/**
 * Parses one tag starting at `<`. A hand-rolled scanner rather than a
 * regex: spec 6.11's first trap is that `[^>]*` on both sides of a literal
 * inside one long tag backtracks catastrophically, and one real 180KB
 * message held a single 75,645-character whitespace run plus 474 runs of
 * 20+. A backtracking quantifier over it cost 2.4 seconds for ONE render --
 * on a shared server, not one user's desktop. Every scan below advances
 * monotonically and never re-examines a character.
 */
function parseTag(input: string, start: number): Tag | null {
  let p = start + 1;
  const closing = input[p] === "/";
  if (closing) p++;

  const nameStart = p;
  while (p < input.length && isNameChar(input[p]!)) p++;
  if (p === nameStart) return null;
  const name = input.slice(nameStart, p).toLowerCase();

  const attrs: Attr[] = [];
  let selfClosing = false;

  while (p < input.length) {
    while (p < input.length && isSpace(input[p]!)) p++;
    if (p >= input.length) break;

    if (input[p] === ">") {
      p++;
      break;
    }
    if (input[p] === "/" && input[p + 1] === ">") {
      selfClosing = true;
      p += 2;
      break;
    }
    if (input[p] === "/") {
      p++;
      continue;
    }

    const attrStart = p;
    while (p < input.length && !isSpace(input[p]!) && input[p] !== "=" && input[p] !== ">") p++;
    if (p === attrStart) {
      p++;
      continue;
    }
    const attrName = input.slice(attrStart, p).toLowerCase();

    while (p < input.length && isSpace(input[p]!)) p++;
    let value: string | null = null;
    if (input[p] === "=") {
      p++;
      while (p < input.length && isSpace(input[p]!)) p++;
      const quote = input[p];
      if (quote === '"' || quote === "'") {
        p++;
        const close = input.indexOf(quote, p);
        // An unterminated quoted value runs to the end of the input --
        // which is what a browser does too, so there is no truncated
        // remainder left over to be re-parsed as markup.
        value = close === -1 ? input.slice(p) : input.slice(p, close);
        p = close === -1 ? input.length : close + 1;
      } else {
        const vStart = p;
        while (p < input.length && !isSpace(input[p]!) && input[p] !== ">") p++;
        value = input.slice(vStart, p);
      }
    }
    attrs.push({ name: attrName, value });
  }

  return { name, closing, selfClosing, attrs, end: p };
}

/** Finds the end of `<name>…</name>`, so the element's contents are dropped
 *  with it. An unclosed one swallows the rest of the document, which is the
 *  safe direction. */
function skipElement(lower: string, name: string, from: number): number {
  const close = lower.indexOf(`</${name}`, from);
  if (close === -1) return lower.length;
  const gt = lower.indexOf(">", close);
  return gt === -1 ? lower.length : gt + 1;
}

function renderTag(tag: Tag, opts: SanitizeOptions, onBlockedImage: () => void): string {
  const parts: string[] = [tag.name];
  let sawImgSrc = false;

  for (const attr of tag.attrs) {
    // `on*` covers every event handler without an allowlist that would go
    // stale as the platform adds them.
    if (attr.name.startsWith("on")) continue;
    if (DROP_ATTRS.has(attr.name)) continue;
    if (attr.value === null) {
      parts.push(attr.name);
      continue;
    }

    if (URL_ATTRS.has(attr.name)) {
      // `srcset` and `ping` carry lists of URLs; rather than parse each
      // list, drop them. Neither is load-bearing for reading mail, and a
      // partial parse is how one URL slips through.
      if (attr.name === "srcset" || attr.name === "ping") {
        if (tag.name === "img") onBlockedImage();
        continue;
      }
      const resolved = resolveUrl(attr.value, tag.name, opts, onBlockedImage);
      if (resolved === null) {
        if (opts.keepBlockedSrc === true && tag.name === "img" && attr.name === "src") {
          const scheme = schemeOf(attr.value);
          if (scheme === "http:" || scheme === "https:") parts.push(`data-wilco-src="${escapeAttr(attr.value.trim())}"`);
        }
        continue;
      }
      if (tag.name === "img" && attr.name === "src") sawImgSrc = true;
      parts.push(`${attr.name}="${escapeAttr(resolved)}"`);
      continue;
    }

    parts.push(`${attr.name}="${escapeAttr(attr.value)}"`);
  }

  // Anchors open in a new tab. The iframe carries
  // `allow-popups allow-popups-to-escape-sandbox` precisely so this works:
  // without those flags the sandbox blocks `target="_blank"` outright and
  // every link in every email silently does nothing (spec 6.3). `noopener`
  // and `noreferrer` because the opened tab must learn neither the opener
  // nor the capability URL.
  if (tag.name === "a" && !tag.closing) {
    parts.push('target="_blank"', 'rel="noopener noreferrer"');
  }

  // 🚨 An <img> whose src was blocked KEEPS ITS BOX. Dropping the element
  // collapses it to nothing -- and in marketing mail the primary call to
  // action is usually an image wrapped in a link, so the anchor collapses
  // with it and the link becomes unclickable. Measured on a real message:
  // 11 of its 21 links were zero-sized for exactly this reason.
  //
  // So the element survives without a `src` (nothing is fetched), carrying
  // its declared width/height, and the wrapper stylesheet paints it as a
  // neutral placeholder rather than leaving the browser's broken-image
  // icon.
  if (tag.name === "img" && !sawImgSrc) {
    // 🚨 The sender's own `alt` is REPLACED, not appended to. Emitting
    // `alt="Amazon.com" ... alt=""` produced a duplicate attribute: parsers
    // keep the first, so the blanking silently did nothing and the
    // placeholder box rendered the sender's alt text inside it, changing
    // the layout of a message whose images are blocked. Found while
    // measuring a real one (audit pass 6).
    const kept = parts.filter((p) => !/^alt=/.test(p));
    kept.push('data-wilco-blocked="1"', 'alt=""');
    return `<${kept.join(" ")} />`;
  }

  const close = tag.selfClosing || VOID_ELEMENTS.has(tag.name) ? " />" : ">";
  return `<${parts.join(" ")}${close}`;
}

function resolveUrl(
  raw: string,
  tagName: string,
  opts: SanitizeOptions,
  onBlockedImage: () => void,
): string | null {
  const scheme = schemeOf(raw);

  if (scheme === "cid:") {
    // `cid:` parts are served from the message's own blobs under the
    // capability token, so displaying one makes NO request to the sender
    // (spec 6.5) -- which is why inline images are shown while remote ones
    // are blocked.
    const cid = raw.replace(/^\s*cid:/i, "").trim();
    const url = opts.resolveCid(decodeURIComponent(safeDecode(cid)));
    return url;
  }

  if (scheme === null) {
    // Relative. There is no base (base-uri 'none') and no meaningful
    // origin to resolve against inside an opaque-origin document, so a
    // relative URL cannot load anything. Anchors keep theirs so in-message
    // jump links still read correctly; everything else drops it.
    if (tagName === "a") return raw;
    if (tagName === "img") onBlockedImage();
    return null;
  }

  if (scheme === "data:") {
    // `img-src` allows `data:`, and only images have a reason to use it.
    return tagName === "img" && /^\s*data:image\//i.test(raw) ? raw : null;
  }

  if (!SAFE_SCHEMES.has(scheme)) return null;

  if (tagName === "img" && !opts.allowRemoteImages) {
    onBlockedImage();
    return null;
  }

  return raw;
}

/**
 * Returns a URL's scheme, normalised, or null if it has none.
 *
 * 🚨 Spec 6.11's second trap: normalise BEFORE judging. `j&#x61vascript:`,
 * `&#106;avascript:` and a tab inside the word all walked through a check
 * written against the text as authored, because a browser decodes entities
 * and drops control characters *before* deciding what scheme it is reading.
 * So this decodes entities, strips control characters and whitespace, and
 * only then looks for the colon.
 */
export function schemeOf(raw: string): string | null {
  const decoded = safeDecode(raw)
    // Control characters and whitespace anywhere inside a scheme are
    // dropped by the browser, so drop them here before comparing.
    .replace(/[\u0000-\u0020\u007f-\u00a0]/g, "")
    .toLowerCase();
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  const candidate = decoded.slice(0, colon + 1);
  // A `/` or `?` before the colon means the colon belongs to a path or
  // query, not a scheme: `foo/bar:baz` is relative.
  if (/[/?#]/.test(candidate)) return null;
  return candidate;
}

/**
 * Decodes HTML character references. Deliberately linear: each match is
 * bounded in length and the scan never revisits a character. Named
 * references are limited to the handful that can appear inside a scheme --
 * a full named-entity table is not needed to decide whether something says
 * `javascript`.
 */
function safeDecode(value: string): string {
  return value
    .replace(/&#[xX]([0-9a-fA-F]{1,6});?/g, (_m, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]{1,7});?/g, (_m, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(/&(Tab|NewLine|colon|sol|lpar|rpar|amp|AMP);?/g, (_m, name: string) => NAMED[name] ?? _m);
}

const NAMED: Record<string, string> = {
  Tab: "\t",
  NewLine: "\n",
  colon: ":",
  sol: "/",
  lpar: "(",
  rpar: ")",
  amp: "&",
  AMP: "&",
};

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

function escapeAttr(value: string): string {
  // `&` is deliberately NOT escaped: the value has not been decoded, so
  // escaping it would turn a sender's `&amp;` into a visible `&amp;amp;`.
  // Escaping `"` and `<` is what stops a value breaking out of the
  // attribute or the tag.
  return value.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

function isNameChar(c: string): boolean {
  return /[a-zA-Z0-9:_-]/.test(c);
}
