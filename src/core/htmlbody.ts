import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { JmapClient } from "./client.ts";
import { MAX_BODY_BYTES } from "./corpus.ts";
import { isFilePart } from "./queries.ts";

/**
 * The ceiling for an explicit "Load full message" (v1.1 #2). Still a
 * ceiling, not "unlimited": the point of MAX_BODY_BYTES is that one message
 * cannot cost arbitrary memory on a box that is also a media server, and an
 * explicit request does not change that arithmetic -- it only raises the
 * threshold to something no real mail exceeds.
 */
export const FULL_BODY_BYTES = 25 * 1024 * 1024;

/**
 * On-demand fetch of a message's HTML body and its inline parts (spec 4.6).
 *
 * `emails.body_text` holds the plaintext the search index is built from and
 * is never evicted. This is a different thing: the HTML a reader actually
 * looks at, plus the `cid:` images inside it. It is a LATENCY AND
 * AVAILABILITY device, not the index -- losing all of it costs a round trip
 * per message open and nothing else, which is what makes a bounded cache
 * with eviction the right shape.
 */

export interface MessagePart {
  /** The `cid:` value the HTML may reference, without the scheme. NULL when
   *  the sender gave the part none.
   *
   *  🚨 A cid does NOT by itself mean "decoration the body draws" -- Gmail
   *  puts one on every part it sends. `disposition` decides; see
   *  `isFilePart` in queries.ts, the one definition all three readers of
   *  this question now share. */
  cid: string | null;
  /** The sender's own Content-Disposition: "attachment", "inline", or null. */
  disposition: string | null;
  blobId: string;
  type: string;
  name: string;
  size: number;
}

/** Kept as a name for the cid-bearing subset, which is what the sanitizer
 *  resolves `cid:` references against. */
export type InlinePart = MessagePart;

export interface MessageBody {
  /** Raw, UNSANITIZED sender body. Nothing may render this without going
   *  through `sanitizeHtml` first (or, when `isPlainText`, escaping it),
   *  and only ever inside the body frame. */
  html: string;
  /**
   * 🚨 True when this body is PLAIN TEXT, not HTML -- and it must then be
   * escaped and rendered with whitespace preserved, never fed to the HTML
   * pipeline.
   *
   * JMAP's `htmlBody` is the list of parts to DISPLAY as the body when a
   * client prefers HTML. For a message with only a text/plain part, that
   * list contains the TEXT/PLAIN part. This code used to concatenate
   * whatever was in the list and hand it to `sanitizeHtml`, so every
   * plaintext message rendered as one unbroken wall (newlines are
   * whitespace in HTML) with `<someone@example.com>` and `<https://...>`
   * silently eaten as tags. Measured: 99.9% of the archive was on this
   * path.
   *
   * Same trap as `textBody` ("NOT the text/plain
   * parts"), which put raw markup in body_text for ~15% of the archive.
   * Both are fixed by classifying on the part's own `type`.
   */
  isPlainText: boolean;
  /** True when the server truncated the body. The reader gets a "message
   *  truncated" strip rather than a silently short message (spec 4.6,
   *  handoff v1.1 #2). */
  truncated: boolean;
  /** Bytes of HTML actually fetched, and the part's full declared size --
   *  v1.1 #2's strip reads "showing 64 KB of 412 KB", so both numbers have
   *  to be real. `totalBytes` is 0 when the server declared no size. */
  shownBytes: number;
  totalBytes: number;
  /** Parts the body refers to by `cid:`. Served inline. */
  inlineParts: MessagePart[];
  /** Parts a reader would download. 🚨 Kept SEPARATE because `hasAttachment`
   *  is true for messages whose only attachments are inline `cid:` images
   *  belonging to the body -- most marketing mail. Offering those as
   *  downloads makes every newsletter appear to carry one (spec 6.5). */
  attachments: MessagePart[];
}

/**
 * Fetches one message's HTML body and the metadata for its inline parts.
 *
 * `maxBodyValueBytes` is the server-side cap: neither the plaintext
 * extraction nor this is unbounded, because a single message is not allowed
 * to cost arbitrary memory on a box that is also a media server.
 */
/** A part's declared MIME type, folded and trimmed. An absent type is not
 *  html -- the safe direction, since treating text as markup is the defect
 *  this exists to prevent, and treating markup as text is merely ugly. */
function typeOf(part: { type?: string }): string {
  return typeof part?.type === "string" ? part.type.toLowerCase().trim() : "";
}

export async function fetchMessageBody(
  client: JmapClient,
  accountId: string,
  id: string,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<MessageBody | null> {
  const [res] = await client.request([
    [
      "Email/get",
      {
        accountId,
        ids: [id],
        properties: ["id", "htmlBody", "textBody", "bodyValues", "attachments"],
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: maxBytes,
      },
      "b0",
    ],
  ]);

  const list = ((res?.[1] as { list?: unknown[] }).list ?? []) as Record<string, any>[];
  const msg = list[0];
  if (!msg) return null;

  const values = (msg["bodyValues"] ?? {}) as Record<string, { value?: string; isTruncated?: boolean }>;
  const listed = (msg["htmlBody"] ?? []) as { partId?: string; type?: string; size?: number }[];

  // 🚨 The part's DECLARED TYPE decides, not the list it arrived in. See
  // `MessageBody.isPlainText`. A message whose htmlBody holds only
  // text/plain parts is a plaintext message, and rendering it as HTML is
  // what made a real reply arrive as one unreadable wall of text.
  const htmlParts = listed.filter((p) => typeOf(p) === "text/html");
  const isPlainText = htmlParts.length === 0;
  const parts = isPlainText ? listed : htmlParts;

  let html = "";
  let truncated = false;
  let totalBytes = 0;
  for (const part of parts as { partId?: string; size?: number }[]) {
    // The part reference carries the FULL size even when the value that
    // came back was truncated -- which is the only place the "of 412 KB"
    // half of the strip can come from.
    if (typeof part.size === "number") totalBytes += part.size;
    if (!part.partId) continue;
    const v = values[part.partId];
    if (!v) continue;
    html += v.value ?? "";
    if (v.isTruncated === true) truncated = true;
  }
  const shownBytes = Buffer.byteLength(html, "utf8");

  const messageParts = collectParts(msg["attachments"]);
  return {
    html,
    isPlainText,
    truncated,
    shownBytes,
    // A server that declared no size leaves this 0; the strip then omits
    // the total rather than inventing one.
    totalBytes: totalBytes > 0 ? totalBytes : shownBytes,
    // 🚨 These OVERLAP deliberately. A part with a cid stays in
    // `inlineParts` so `cid:` references in the body still resolve (the
    // frame's `byCid`), and a part the sender declared an attachment is
    // ALSO offered as a file -- otherwise it has no download URL, which is
    // exactly what left eight invoice PDFs as inert chips (row 65).
    inlineParts: messageParts.filter((p) => p.cid !== null),
    attachments: messageParts.filter(isFilePart),
  };
}

/**
 * Fetches a message body, memoised in the blob cache.
 *
 * Two callers need the SAME body for one message open: the body origin
 * (which renders it) and the mint route on the app origin (which must
 * report how many remote images were blocked, and whether the body was
 * truncated -- neither of which the SPA can read off a cross-origin frame's
 * response headers). Without a memo that is two `Email/get` calls per
 * message opened, against Fastmail, for one screen.
 *
 * The cache is keyed on `(account, id)` and holds the PARSED body as JSON.
 * It is the same bounded, evicting store the inline parts use (spec 4.6):
 * losing it costs a round trip and nothing else.
 */
export async function loadMessageBody(
  client: JmapClient,
  account: string,
  id: string,
  blobs: BlobCache,
  /** v1.1 #2's "Load full message": refetch without the usual cap. Cached
   *  under its own key so the truncated copy is not served afterwards. */
  full: boolean = false,
): Promise<MessageBody | null> {
  // 🚨 The version is part of the key, and it MUST be bumped whenever the
  // shape or the meaning of a cached `MessageBody` changes. The cache holds
  // PARSED bodies as JSON; an entry written by older code deserialises
  // cleanly and is then read under the new rules. When `isPlainText` was
  // added, every cached entry lacked it, `undefined` is falsy, and so every
  // already-open message kept rendering down the HTML path -- the fix
  // deployed and changed nothing until the key moved. A silent wrong answer
  // from a cache is worse than a miss; a miss costs one round trip.
  // 🚨 v3: `MessagePart` gained `disposition` and `attachments` changed
  // meaning with it. The cache stores PARSED bodies as JSON, so entries
  // written by older code deserialise cleanly and would then be read under
  // the new rules with the field missing -- every cached message would keep
  // classifying its own files as decoration. Bumping the key is what makes
  // the fix take effect, and it has been missed before.
  const key = full ? `bodyfull:v3:${account}:${id}` : `body:v3:${account}:${id}`;
  const cached = blobs.get(key);
  if (cached !== null) {
    try {
      return JSON.parse(cached.toString("utf8")) as MessageBody;
    } catch {
      // A corrupt cache entry must degrade to a re-fetch, never to an error
      // the reader sees.
    }
  }

  const body = await fetchMessageBody(
    client,
    client.session.mailAccountId,
    id,
    full ? FULL_BODY_BYTES : MAX_BODY_BYTES,
  );
  if (body === null) return null;
  blobs.put(key, Buffer.from(JSON.stringify(body), "utf8"));
  return body;
}

/**
 * Inline parts are the attachments that carry a `cid` -- the ones the HTML
 * refers to rather than the ones a reader would download.
 *
 * 🚨 The same distinction matters one level up: `hasAttachment` is true for
 * messages whose ONLY attachments are inline `cid:` images belonging to the
 * body, which is most marketing mail. Filter on disposition and cid before
 * offering a download, or every newsletter appears to carry one (spec 6.5).
 */
export function collectParts(attachments: unknown): MessagePart[] {
  if (!Array.isArray(attachments)) return [];
  const out: MessagePart[] = [];
  for (const a of attachments as Record<string, any>[]) {
    const cid = typeof a["cid"] === "string" && a["cid"] !== "" ? a["cid"] : null;
    const disposition = typeof a["disposition"] === "string" ? a["disposition"] : null;
    const blobId = typeof a["blobId"] === "string" ? a["blobId"] : null;
    // No blobId means nothing can be served for it, inline or otherwise.
    if (!blobId) continue;
    out.push({
      cid,
      disposition,
      blobId,
      type: typeof a["type"] === "string" ? a["type"] : "application/octet-stream",
      name: typeof a["name"] === "string" ? a["name"] : "part",
      size: typeof a["size"] === "number" ? a["size"] : 0,
    });
  }
  return out;
}

/**
 * A bounded on-disk cache in `blobDir`, evicting least-recently-used first.
 *
 * `blobDir` has been a REQUIRED config variable since milestone 0 that
 * nothing ever read. This is its first consumer.
 *
 * Keys are hashed rather than used as filenames: a key is `(account, id)`
 * or `(account, id, blobId)`, and JMAP ids are opaque strings that may
 * contain characters a filesystem treats specially. Hashing sidesteps
 * escaping entirely and gives a fixed-length name.
 */
export class BlobCache {
  private readonly dir: string;
  private readonly maxBytes: number;

  constructor(dir: string, maxBytes: number = 256 * 1024 * 1024) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    mkdirSync(dir, { recursive: true });
  }

  get(key: string): Buffer | null {
    const file = this.pathFor(key);
    try {
      const buf = readFileSync(file);
      // Touch on read so eviction is least-recently-USED, not
      // least-recently-written -- a message reopened daily should not be
      // evicted ahead of one fetched once and never looked at again.
      const now = new Date();
      try {
        utimesSync(file, now, now);
      } catch {
        // A failed touch degrades the eviction order, never the read.
      }
      return buf;
    } catch {
      return null;
    }
  }

  put(key: string, value: Buffer): void {
    try {
      writeFileSync(this.pathFor(key), value);
      this.evictIfOver();
    } catch {
      // The cache is an optimisation. A full or unwritable disk must
      // degrade to "fetch it again next time", never to a failed read.
    }
  }

  private pathFor(key: string): string {
    return path.join(this.dir, createHash("sha256").update(key).digest("hex"));
  }

  private evictIfOver(): void {
    let entries: { file: string; size: number; atime: number }[];
    try {
      entries = readdirSync(this.dir).map((name) => {
        const file = path.join(this.dir, name);
        const st = statSync(file);
        return { file, size: st.size, atime: st.mtimeMs };
      });
    } catch {
      return;
    }

    let total = entries.reduce((n, e) => n + e.size, 0);
    if (total <= this.maxBytes) return;

    entries.sort((a, b) => a.atime - b.atime);
    for (const entry of entries) {
      if (total <= this.maxBytes) break;
      try {
        unlinkSync(entry.file);
        total -= entry.size;
      } catch {
        // Someone else removed it, or it is locked. Either way, move on.
      }
    }
  }
}
