import type { IncomingMessage, ServerResponse } from "node:http";
import type { JmapClient } from "../core/client.ts";
import { verifyBodyToken } from "../core/captoken.ts";
import { BlobCache, loadMessageBody, type MessagePart } from "../core/htmlbody.ts";
import { sanitizeHtml } from "../core/sanitize.ts";
import { chooseSurface } from "../core/surface.ts";
import { createHash } from "node:crypto";

/**
 * The ONE script the frame document carries: ours, and only ever these
 * exact bytes, admitted by the CSP through its hash (`RESIZE_SCRIPT_HASH`).
 *
 * 🚨 Why it exists (checklist row 3). Every webmail client sizes its
 * message frame with a resize script of its own; this frame had a fixed
 * 650px window while real messages measure 700-4,900px, so reading one
 * meant scrolling a box inside a scrolling pane. The old reason for
 * not doing this -- "script in the frame is what section 6 exists to
 * prevent" -- conflated our script with the sender's. CSP is built to tell
 * them apart: a sender's inline script or onerror= handler matches no hash,
 * and 'unsafe-inline' is absent, so both stay dead (csp-probe.py's `script`
 * case proves it in a real browser). There is still no allow-same-origin:
 * with allow-scripts alone a frame cannot remove its own sandbox.
 *
 * What it does: report the document's height to the parent. It reads no
 * message content and posts a number; the parent accepts the message only
 * from this frame's own window and clamps the value (BodyFrame.tsx). The
 * target is "*" because an opaque-origin frame has no origin to name and
 * `frame-ancestors` already limits who can embed it.
 *
 * 🚨 Any edit here changes the hash; the test pins that the served CSP's
 * hash is the hash of the served bytes, so drift fails loudly.
 */
export const RESIZE_SCRIPT =
  '(function(){var last=-1;function post(){var h=document.documentElement.scrollHeight;' +
  'if(h!==last){last=h;parent.postMessage({wilcoHeight:h},"*");}}' +
  'post();if(window.ResizeObserver){new ResizeObserver(post).observe(document.documentElement);}' +
  'window.addEventListener("load",post);setTimeout(post,500);setTimeout(post,2000);})();';
export const RESIZE_SCRIPT_HASH = createHash("sha256").update(RESIZE_SCRIPT).digest("base64");

/**
 * The body origin: `https://mailbody.example.com`.
 *
 * 🚨 This host serves EXACTLY TWO ROUTES and 404s everything else. No SPA,
 * no API, not even `/healthz`. Both hostnames reach one Node process, so
 * without this the whole application would be reachable on a second origin
 * -- and the entire point of the second origin (spec 3.2) is that a total
 * failure of the CSP still reaches no cookie, no localStorage and no DOM of
 * Wilco's.
 *
 * Authentication is a capability token and nothing else (spec 3.3): a
 * sandboxed frame with an opaque origin sends no SameSite cookie on any
 * subresource request, so a cookie-authenticated body origin would 401
 * every inline image.
 */

export interface BodyHostDeps {
  bodyTokenKey: Buffer;
  bodyBaseUrl: string;
  appBaseUrl: string;
  blobs: BlobCache;
  /** Live map, read per request -- an account that connects after the
   *  server is built must still be readable. */
  clients: Map<string, JmapClient>;
  /** Resolves one identity's HTML signature, for the signature preview.
   *  Injected rather than imported so this module keeps knowing nothing
   *  about identities beyond "some string of HTML". */
  signatureFor?: (account: string, identityId: string) => Promise<string | null>;
}

/**
 * Spec 6.2, in full. Every directive earns its place:
 *
 * - **`sandbox` is HERE, in the header, not only on the iframe attribute.**
 *   As first drafted the no-script guarantee existed only because the
 *   EMBEDDER set an attribute -- navigate to a body URL directly and there
 *   is no sandbox, leaving script stopped solely by `default-src 'none'`,
 *   one header typo from full script execution on a real origin. Dovetail's
 *   `javascript: false` was unconditional; this restores that property.
 * - **`form-action` and `base-uri` do NOT fall back to `default-src`.**
 *   Without them a form is blocked only by the sandbox -- one attribute
 *   away from an exfil POST.
 * - **`frame-ancestors`** stops any other origin framing this document.
 * - `style-src 'unsafe-inline'` because there is no hash or nonce form for
 *   the `style` ATTRIBUTE, and `'self'` silently disables it while leaving
 *   it in the DOM -- indistinguishable from an over-eager sanitizer.
 */
function csp(bodyBaseUrl: string, appBaseUrl: string, allowRemoteImages: boolean): string {
  const img = allowRemoteImages ? `${bodyBaseUrl} data: https:` : `${bodyBaseUrl} data:`;
  return [
    // 🚨 The sandbox directive must carry the SAME popup flags as the iframe
    // attribute. The effective sandbox is the INTERSECTION of the two, so a
    // bare `sandbox` here (equivalent to sandbox="") silently subtracts the
    // `allow-popups` the embedder granted -- and every link in every email
    // does nothing when clicked. Reported from real use; reproduced with a
    // click that opened no tab.
    //
    // Spec 6.2 lists `sandbox;` bare while 6.3 requires
    // `allow-popups allow-popups-to-escape-sandbox` for links to work at
    // all. Those two cannot both hold: the header is the stricter of the
    // pair, so it decides. Neither flag weakens the guarantee that matters
    // -- no allow-scripts, no allow-same-origin, no allow-forms -- they only
    // let a click leave the frame instead of dying in it.
    // `allow-scripts` for OUR resize script (RESIZE_SCRIPT), and only ours:
    // the script-src below admits its exact bytes by hash. Still no
    // allow-same-origin -- that pair is the known hazard, and one alone is
    // not.
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
    "default-src 'none'",
    `script-src 'sha256-${RESIZE_SCRIPT_HASH}'`,
    `img-src ${img}`,
    "style-src 'unsafe-inline'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${appBaseUrl}`,
  ].join("; ");
}

function secureHeaders(bodyBaseUrl: string, appBaseUrl: string, allowRemoteImages: boolean): Record<string, string> {
  return {
    "content-security-policy": csp(bodyBaseUrl, appBaseUrl, allowRemoteImages),
    // Mandatory, not hardening: with remote images opted in, `Referer`
    // would hand the sender the capability token itself.
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // The response varies by the remote-image opt-in. A cached copy means
    // clicking "load images" returns the blocking CSP and appears to do
    // nothing -- and it means NPM writing message bodies to disk. NPM host
    // 48 also carries caching_enabled: false for the same reason.
    "cache-control": "no-store",
  };
}

/**
 * Handles a request on the body origin. Returns false only if the request
 * is not for this host at all; every request that IS for this host is
 * answered here, including the 404s.
 */
export async function handleBodyHost(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: BodyHostDeps,
): Promise<void> {
  // The blocking policy is the default for anything that is not a verified
  // opted-in document: a refusal, a 404, an unparseable token. Only
  // serveDocument widens it, and only from what the TOKEN says.
  const headers = secureHeaders(deps.bodyBaseUrl, deps.appBaseUrl, false);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  if (req.method !== "GET" && req.method !== "HEAD") return refuse(res, 405, headers);

  // /m/{token}
  if (segments.length === 2 && segments[0] === "m") {
    return serveDocument(res, decodeSafely(segments[1]!), headers, deps);
  }
  // /p/{token}/{cid}
  if (segments.length === 3 && segments[0] === "p") {
    return servePart(res, decodeSafely(segments[1]!), decodeSafely(segments[2]!), headers, deps);
  }
  // /a/{token}/{blobId}            -- a download (Content-Disposition: attachment)
  // /a/{token}/{blobId}?view=1     -- the same bytes INLINE, for the in-app
  //                                   image viewer; honoured only for
  //                                   VIEWABLE_TYPES, anything else stays a
  //                                   download whatever the query says.
  if (segments.length === 3 && segments[0] === "a") {
    return serveAttachment(res, decodeSafely(segments[1]!), decodeSafely(segments[2]!), headers, deps, url.searchParams.get("view") === "1");
  }
  // /s/{token} -- a signature preview
  if (segments.length === 2 && segments[0] === "s") {
    return serveSignature(res, decodeSafely(segments[1]!), headers, deps);
  }

  return refuse(res, 404, headers);
}

async function serveDocument(
  res: ServerResponse,
  token: string,
  headers: Record<string, string>,
  deps: BodyHostDeps,
): Promise<void> {
  const grant = verifyBodyToken(deps.bodyTokenKey, token);
  // 🚨 The kind must match the route. The id means different things in the
  // two cases -- a message id here, a JMAP Identity id on /s -- so a
  // signature capability must not address a message, or the reverse.
  if (grant === null || grant.kind !== "message") return refuse(res, 401, headers);

  let body;
  try {
    body = await loadBody(grant.account, grant.id, deps, grant.full === true);
  } catch {
    // Never surface the upstream error: it can carry a URL that carries a
    // JMAP token.
    return refuse(res, 502, headers);
  }
  if (body === null) return refuse(res, 404, headers);

  // 🚨 A PLAINTEXT BODY IS ESCAPED, NOT SANITIZED. The sanitizer's job is
  // to make hostile MARKUP safe; run over plain text it does something
  // different and wrong -- it PARSES the text as markup. Measured on a
  // real message: `<jdoe1989@example.com>` became a tag and vanished,
  // `<https://...>` likewise, and every newline collapsed (newlines are
  // whitespace in HTML), so a 50-line reply rendered as one unbroken wall.
  //
  // It reached here because `MessageBody.html` was filled from JMAP's
  // `htmlBody` list without checking the part's type, and that list holds
  // the TEXT/PLAIN part for a plaintext message -- 99.9% of this archive.
  // See `MessageBody.isPlainText`.
  //
  // Escaping is also strictly the safer of the two: there is no parser to
  // outwit, so nothing here depends on the sanitizer being right.
  let html: string;
  let blockedRemoteImages: number;
  if (body.isPlainText) {
    html = `<div style="white-space:pre-wrap;word-wrap:break-word">${escapeText(body.html)}</div>`;
    // Plain text cannot reference an image, so nothing was blocked. Zero
    // is the true count here, not a guess.
    blockedRemoteImages = 0;
  } else {
    const byCid = new Map(body.inlineParts.map((p) => [normaliseCid(p.cid), p]));
    const sanitized = sanitizeHtml(body.html, {
      resolveCid: (cid) =>
        byCid.has(normaliseCid(cid)) ? `${deps.bodyBaseUrl}/p/${encodeURIComponent(token)}/${encodeURIComponent(cid)}` : null,
      allowRemoteImages: grant.remoteImages === true,
    });
    html = sanitized.html;
    blockedRemoteImages = sanitized.blockedRemoteImages;
  }

  // A plaintext message carries no sender CSS, so it has no surface of its
  // own to honour -- `chooseSurface` over escaped text would be reading a
  // colour out of the message's WORDS.
  const surface = body.isPlainText ? chooseSurface("") : chooseSurface(body.html);
  const doc = renderDocument(html, surface);

  res.writeHead(200, {
    // The policy is derived from THIS token, so the opted-in and blocking
    // variants are different URLs carrying different CSPs. `no-store` (in
    // secureHeaders) is what stops a cached blocking response being served
    // for an opted-in request -- clicking "Load images" would otherwise
    // appear to do nothing.
    ...secureHeaders(deps.bodyBaseUrl, deps.appBaseUrl, grant.remoteImages === true),
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(doc),
    // The chrome reads these OFF THE RESPONSE rather than out of the
    // document, because nothing of ours renders inside the message
    // (spec 6.8) -- a message whose stylesheet says
    // `body { background: #f2f2f2 }` would restyle our own banner into
    // invisibility.
    "x-wilco-blocked-images": String(blockedRemoteImages),
    "x-wilco-truncated": body.truncated ? "1" : "0",
  });
  res.end(doc);
}

/**
 * Renders one identity's HTML signature for preview.
 *
 * 🚨 Served from the SAME sandboxed origin, under the same CSP, and through
 * the same sanitizer as a stranger's mail. The signature is the operator's
 * own HTML, so this is not spec 6's threat model -- but giving our own HTML
 * a privileged path into the SPA's document is exactly the exception that
 * makes the next one arguable. It costs nothing to treat it like any other
 * markup, so it is treated like any other markup.
 *
 * `data:` images survive: `img-src` already allows them (6.2), which is
 * what lets a `data:`-stored logo show in the preview without the upload
 * the SEND path performs.
 */
async function serveSignature(
  res: ServerResponse,
  token: string,
  headers: Record<string, string>,
  deps: BodyHostDeps,
): Promise<void> {
  const grant = verifyBodyToken(deps.bodyTokenKey, token);
  // A message token must not be usable to read a signature, or the other
  // way round: the id means different things in the two cases.
  if (grant === null || grant.kind !== "signature") return refuse(res, 401, headers);
  if (!deps.signatureFor) return refuse(res, 404, headers);

  let signature: string | null;
  try {
    signature = await deps.signatureFor(grant.account, grant.id);
  } catch {
    return refuse(res, 502, headers);
  }
  if (signature === null) return refuse(res, 404, headers);

  const { html } = sanitizeHtml(signature, {
    // A signature has no message to resolve cids against; a `cid:` here
    // would be a reference to nothing.
    resolveCid: () => null,
    // Remote images in a signature preview stay blocked, like anywhere
    // else -- previewing your own signature should not call out to a host.
    allowRemoteImages: false,
  });

  const doc = renderDocument(html, chooseSurface(signature));
  res.writeHead(200, {
    ...headers,
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(doc),
  });
  res.end(doc);
}

async function servePart(
  res: ServerResponse,
  token: string,
  cid: string,
  headers: Record<string, string>,
  deps: BodyHostDeps,
): Promise<void> {
  const grant = verifyBodyToken(deps.bodyTokenKey, token);
  // 🚨 The kind must match the route. The id means different things in the
  // two cases -- a message id here, a JMAP Identity id on /s -- so a
  // signature capability must not address a message, or the reverse.
  if (grant === null || grant.kind !== "message") return refuse(res, 401, headers);

  let body;
  try {
    body = await loadBody(grant.account, grant.id, deps);
  } catch {
    return refuse(res, 502, headers);
  }
  if (body === null) return refuse(res, 404, headers);

  const part = body.inlineParts.find((p) => normaliseCid(p.cid) === normaliseCid(cid));
  if (!part) return refuse(res, 404, headers);

  const client = deps.clients.get(grant.account);
  if (!client) return refuse(res, 503, headers);
  const accountId = client.session.mailAccountId;

  const key = `part:${grant.account}:${grant.id}:${part.blobId}`;
  let bytes = deps.blobs.get(key);
  if (bytes === null) {
    try {
      bytes = await client.downloadBlob({
        accountId,
        blobId: part.blobId,
        name: part.name,
        type: part.type,
      });
    } catch {
      return refuse(res, 502, headers);
    }
    deps.blobs.put(key, bytes);
  }

  res.writeHead(200, {
    ...headers,
    // Only images are ever served here in pass 1. Anything else is forced
    // to octet-stream rather than trusted: an `.html` or `.svg` part served
    // with its own type would be script on this origin, and while the
    // sandbox header stops it running, nothing should depend on that alone.
    "content-type": renderableImageType(part),
    "content-length": String(bytes.length),
  });
  res.end(bytes);
}

/**
 * Serves one real attachment for download (spec 6.7).
 *
 * 🚨 The rules here are not hardening. Spec 6.7 was absent from the design's
 * first draft, and the omission is dangerous: an `.html` or `.svg`
 * attachment served inline from `mail.example.com` is **stored XSS on the
 * origin holding the session cookie, delivered by anyone who can email
 * you.** Hence: body origin only, never the SPA origin; always
 * `Content-Disposition: attachment`; `nosniff`; the type forced to
 * octet-stream outside a small render allowlist; and the full sandbox CSP
 * on the response as well.
 *
 * The bytes are STREAMED (spec 4.6) rather than buffered -- a 25MB
 * attachment must not become 25MB of resident heap on a box that is also a
 * media server -- and are deliberately NOT put in the blob cache, which
 * exists for the small, repeatedly-rendered inline parts.
 */
async function serveAttachment(
  res: ServerResponse,
  token: string,
  blobId: string,
  headers: Record<string, string>,
  deps: BodyHostDeps,
  view: boolean = false,
): Promise<void> {
  const grant = verifyBodyToken(deps.bodyTokenKey, token);
  // 🚨 The kind must match the route. The id means different things in the
  // two cases -- a message id here, a JMAP Identity id on /s -- so a
  // signature capability must not address a message, or the reverse.
  if (grant === null || grant.kind !== "message") return refuse(res, 401, headers);

  let body;
  try {
    body = await loadBody(grant.account, grant.id, deps);
  } catch {
    return refuse(res, 502, headers);
  }
  if (body === null) return refuse(res, 404, headers);

  // Only parts of THIS message, and only ones the reader would download --
  // an inline `cid:` part is served by /p, not offered as a file.
  const part = body.attachments.find((p) => p.blobId === blobId);
  if (!part) return refuse(res, 404, headers);

  const client = deps.clients.get(grant.account);
  if (!client) return refuse(res, 503, headers);

  let upstream: Response;
  try {
    upstream = await client.openBlob({
      accountId: client.session.mailAccountId,
      blobId: part.blobId,
      name: part.name,
      type: part.type,
    });
  } catch {
    return refuse(res, 502, headers);
  }

  const filename = safeFilename(part.name);
  // Inline ONLY for a raster image the viewer asked for (2026-09-08: "I
  // have an email with a jpg attachment, I seem to have no way of opening
  // it"). Everything else keeps `attachment`: a PDF's viewer is a plugin
  // the sandbox CSP on this response forbids anyway, and text/html and
  // image/svg+xml never reach VIEWABLE_TYPES -- served inline on any
  // origin they are a document that can carry script.
  const disposition = view && isViewableImage(part) ? "inline" : "attachment";
  res.writeHead(200, {
    ...headers,
    // Forced for anything outside the allowlist. A browser that would
    // otherwise render the part as a document gets a download instead.
    "content-type": downloadType(part),
    // RFC 5987: the plain `filename` stays ASCII for old clients while
    // `filename*` carries the real, percent-encoded UTF-8 name.
    "content-disposition": `${disposition}; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    ...(part.size > 0 ? { "content-length": String(part.size) } : {}),
  });

  if (upstream.body === null) return void res.end();
  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      // Respect backpressure: without this a fast upstream and a slow
      // client buffer the whole attachment in the socket's write queue,
      // which is the very thing streaming is supposed to avoid.
      if (!res.write(Buffer.from(chunk))) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } catch {
    // The head is already sent, so there is no status left to change --
    // destroy the response so the client sees a truncated transfer rather
    // than a silently short file that looks complete.
    res.destroy();
    return;
  }
  res.end();
}

/**
 * The only types allowed to keep their own Content-Type on a download.
 * Everything else becomes octet-stream. `text/html` and `image/svg+xml` are
 * the two that matter and neither is here: both are documents that can
 * carry script.
 */
const DOWNLOADABLE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
]);

/** Raster images the in-app viewer may show inline. A strict subset of
 *  DOWNLOADABLE_TYPES; never a document type. */
export const VIEWABLE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isViewableImage(part: { type: string }): boolean {
  return VIEWABLE_TYPES.has(part.type.toLowerCase().split(";")[0]!.trim());
}

function downloadType(part: MessagePart): string {
  const type = part.type.toLowerCase().split(";")[0]!.trim();
  return DOWNLOADABLE_TYPES.has(type) ? type : "application/octet-stream";
}

/**
 * Filenames are attacker-authored. Basename only, control characters
 * stripped, `.`/`..` and a leading dot rejected, length capped
 * [dovetail]. The result is only ever used in a Content-Disposition
 * header, never as a path -- but a header is exactly where a raw CR/LF
 * would be a response-splitting bug.
 */
export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "attachment" : cleaned;
}

/** The ASCII fallback half of RFC 5987. A quote or a backslash here would
 *  break out of the quoted-string, so both are dropped rather than escaped. */
function asciiFilename(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return ascii.trim() === "" ? "attachment" : ascii;
}

const RENDERABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
]);

/** 🚨 `image/svg+xml` is deliberately NOT in the allowlist: an SVG is a
 *  document that can carry script, and serving one inline is how an inline
 *  image becomes stored XSS. It falls through to octet-stream. */
function renderableImageType(part: MessagePart): string {
  const type = part.type.toLowerCase().split(";")[0]!.trim();
  return RENDERABLE_IMAGE_TYPES.has(type) ? type : "application/octet-stream";
}

async function loadBody(account: string, id: string, deps: BodyHostDeps, full = false) {
  const client = deps.clients.get(account);
  if (!client) return null;
  return await loadMessageBody(client, account, id, deps.blobs, full);
}

/**
 * Wraps the sanitized message in a minimal document whose only styling is
 * the chosen surface (spec 6.9) and a sane default ink for text the sender
 * did not colour. Nothing else of ours goes in here -- headers, the
 * blocked-image banner and attachment chips all live in the app chrome
 * outside the frame (spec 6.8).
 */
function renderDocument(html: string, surface: { background: string; dark: boolean }): string {
  const ink = surface.dark ? "#f2f2f2" : "#111111";
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<style>html,body{margin:0;padding:12px;background:${escapeCss(surface.background)};color:${ink};`,
    "font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;}",
    "img{max-width:100%;height:auto}",
    // A blocked remote image keeps its box so the link around it stays
    // clickable (see sanitize.ts). Painted as a neutral placeholder rather
    // than left as the browser's broken-image icon -- and given a minimum
    // size so an image that declared none is still a click target.
    "img[data-wilco-blocked]{min-width:16px;min-height:16px;background:rgba(127,127,127,.10);",
    "border:1px dashed rgba(127,127,127,.35);border-radius:2px;box-sizing:border-box}",
    "</style></head><body>",
    html,
    `<script>${RESIZE_SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}

/** The surface colour came out of sender CSS, so it cannot go into a style
 *  block unchecked -- a `;` or `<` would break out of the declaration. */
function escapeCss(value: string): string {
  return /^[#a-zA-Z0-9(),.%\s]{1,64}$/.test(value) ? value : "#ffffff";
}


/** Escapes text for insertion into HTML. Only the five characters that can
 *  change the parse -- this is the whole reason a plaintext body never has
 *  to be parsed at all. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normaliseCid(cid: string | null): string {
  return (cid ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
}

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Every refusal carries the full security headers. A 401 or a 404 is still
 * a response on this origin, and a body-origin response without the CSP is
 * a body-origin response that can run script.
 */
function refuse(res: ServerResponse, status: number, headers: Record<string, string>): void {
  res.writeHead(status, { ...headers, "content-type": "text/plain; charset=utf-8", "content-length": "0" });
  res.end();
}
