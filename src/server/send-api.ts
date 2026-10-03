/**
 * GET  /api/identities   -- the addresses each account may send AS
 * POST /api/send         -- send a message
 *
 * The only outward-facing, irreversible action in Wilco. Guarded harder than
 * anything else here:
 *
 *  - "write" scope AND CSRF, like triage.
 *  - The `from` address must be one of the account's OWN JMAP identities.
 *    Fastmail enforces this too, but relying on that alone would mean the
 *    only thing standing between a compromised session and a spoofed sender
 *    is a remote check we do not control. An identity the account does not
 *    own is a 403 here, before any JMAP call is made.
 *  - Recipients come from to/cc/bcc and the envelope is derived from them
 *    (see send.ts) -- a caller cannot address the envelope independently of
 *    what the compose window displayed.
 *
 * There is deliberately NO undo-send. It would have to be a client-side
 * delay before submission, which means a message the user believes is sent
 * is sitting in a browser tab -- close it and the mail never goes. Wilco
 * either submits or it does not.
 */

import type { DatabaseSync } from "node:sqlite";
import type { JmapClient } from "../core/client.ts";
import { USING_SUBMISSION } from "../core/client.ts";
import {
  checkAttachmentSizes,
  destroyDraft,
  MAX_ATTACHMENT_BYTES,
  saveDraft,
  send,
  type OutgoingInlineImage,
  SendError,
  type Addr,
  type OutgoingAttachment,
  type OutgoingMessage,
} from "../core/send.ts";
import { writtenTo } from "../core/queries.ts";
import { AddressBook } from "../core/addressbook.ts";
import { oneClickPost, planUnsubscribe, type FetchLike, type UnsubscribePlan } from "../core/unsubscribe.ts";
import { attributionLine, buildPrefill, forwardHeader, type Addr as ReplyAddr, type ReplyMode, type SourceMessage, type SourceAttachment } from "../core/reply.ts";
import { loadMessageBody, type BlobCache } from "../core/htmlbody.ts";
import { sanitizeHtml } from "../core/sanitize.ts";
import { assembleOutgoing, deriveText, sanitizeForEditor as editorProfile, sanitizeOutgoing, splitSignature, type QuoteSource, type SignaturePlacement } from "../core/outgoing.ts";
import type { Router } from "./router.ts";
import { json } from "./router.ts";
import { authenticate, checkCsrf, hasScope } from "./auth.ts";
import { BODY_TOKEN_TTL_MS, mintBodyToken } from "../core/captoken.ts";
import { buildHtmlBody, derivePlainSignature, estimateSignatureHeight, prepareSignatureImages } from "../core/signature.ts";
import { readJson } from "./body.ts";

export interface SendDeps {
  db: DatabaseSync;
  origin: string;
  clients: Map<string, JmapClient>;
  onChange?: (account: string) => void;
  /** Minting key and base URL for the signature-preview capability. */
  bodyTokenKey?: Buffer;
  bodyBaseUrl?: string;
  /** The one-click unsubscribe POST goes out through this (row 31).
   *  Injectable so a test can watch the request; production uses fetch. */
  fetchFn?: FetchLike;
  /** The address book (core/addressbook.ts), held across requests because
   *  building it is a full aggregate over the archive. Absent -> one is
   *  made here, which is correct but caches nothing between registrations. */
  book?: AddressBook;
  /** The body cache, for the quoted original's HTML on send and a draft's
   *  own HTML on resume (HTML compose spec 3.3-3.5). Absent -> a reply
   *  quotes the text half only, and a draft resumes without HTML. */
  blobs?: BlobCache;
}

export interface IdentityInfo {
  id: string;
  name: string | null;
  email: string;
  /**
   * 🚨 The primary identity is the one with `mayDelete === false` (spec 11
   * [dovetail]). That flag is the ONLY reliable marker: JMAP promises no
   * ordering, and the personal account has five identities, so
   * `identities[0]` is a coin flip.
   */
  primary: boolean;
  /**
   * The signature, byte for byte as stored (spec 11). Trailing whitespace
   * is significant: RFC 3676's separator is `-- ` WITH the trailing space,
   * and Fastmail round-trips the value exactly, so nothing here may trim
   * it.
   */
  textSignature: string;
  /**
   * The HTML signature, byte for byte. Fastmail stores base64 `data:`
   * images in here; they are converted to `cid:` parts on send (spec 11:
   * "`data:`-stored and `cid:`-sent logos").
   */
  htmlSignature: string;
}

/** How many recipient addresses one habits lookup will answer. The
 *  composer asks about the addresses in To/Cc/Bcc; a cap keeps a pasted
 *  distribution list from turning one keystroke into hundreds of queries. */
const HABIT_LOOKUP_LIMIT = 20;

/** Identities change rarely and a JMAP round trip per compose-window open is
 *  wasteful, so they are cached per account for the process lifetime. A new
 *  alias appearing requires a restart, which is the right trade for a list
 *  that changes a few times a year. */
const identityCache = new Map<string, IdentityInfo[]>();

export async function fetchIdentities(client: JmapClient, account: string): Promise<IdentityInfo[]> {
  const cached = identityCache.get(account);
  if (cached) return cached;
  const responses = await client.request(
    [["Identity/get", { accountId: client.session.submissionAccountId, ids: null }, "i0"]],
    USING_SUBMISSION,
  );
  const list = (responses[0]?.[1] as { list?: unknown[] } | undefined)?.list ?? [];
  const out: IdentityInfo[] = [];
  for (const raw of list) {
    const i = raw as {
      id?: unknown;
      name?: unknown;
      email?: unknown;
      mayDelete?: unknown;
      textSignature?: unknown;
      htmlSignature?: unknown;
    };
    if (typeof i.id !== "string" || typeof i.email !== "string") continue;
    out.push({
      id: i.id,
      name: typeof i.name === "string" && i.name !== "" ? i.name : null,
      email: i.email,
      primary: i.mayDelete === false,
      // NOT trimmed, and not defaulted to anything but "". See the field's
      // comment: the trailing space of `-- ` is load-bearing.
      textSignature: typeof i.textSignature === "string" ? i.textSignature : "",
      htmlSignature: typeof i.htmlSignature === "string" ? i.htmlSignature : "",
    });
  }
  identityCache.set(account, out);
  return out;
}

function mailboxIdForRole(db: DatabaseSync, account: string, role: string): string {
  const row = db
    .prepare(`SELECT id FROM mailboxes WHERE account = ? AND role = ? LIMIT 1`)
    .get(account, role) as { id?: string } | undefined;
  if (!row?.id) throw new SendError(`${account}: no mailbox with role "${role}"`);
  return row.id;
}

export function registerSendRoutes(router: Router, deps: SendDeps): void {
  const book = deps.book ?? new AddressBook(deps.db);

  router.add("GET", "/api/identities", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    const out: Record<string, IdentityInfo[]> = {};
    for (const [account, client] of deps.clients) {
      try {
        out[account] = await fetchIdentities(client, account);
      } catch {
        // One account's identities failing must not blank the compose
        // window's From list for the other three.
        out[account] = [];
      }
    }
    json(c.res, 200, { identities: out });
  });


  /**
   * GET /api/messages/:account/:id/draft?mode=reply|reply-all|forward
   *
   * Message-ID and References are NOT stored locally -- adding two columns
   * and backfilling 37k rows to serve an occasional interactive action is
   * the wrong trade, so they are fetched on demand here. One JMAP round trip
   * per reply is imperceptible; a migration over the whole archive is not.
   */
  router.add("GET", "/api/messages/:account/:id/draft", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });

    const account = c.params["account"] ?? "";
    const id = c.params["id"] ?? "";
    const mode = (c.url.searchParams.get("mode") ?? "reply") as ReplyMode;
    if (mode !== "reply" && mode !== "reply-all" && mode !== "forward") {
      return json(c.res, 400, { error: "mode must be reply, reply-all or forward" });
    }
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });

    let raw: Record<string, unknown> | undefined;
    try {
      const responses = await client.request([
        [
          "Email/get",
          {
            accountId: client.session.mailAccountId,
            ids: [id],
            properties: ["subject", "from", "to", "cc", "replyTo", "messageId", "references", "sentAt", "attachments"],
          },
          "d0",
        ],
      ]);
      raw = ((responses[0]?.[1] as { list?: Record<string, unknown>[] } | undefined)?.list ?? [])[0];
    } catch (err) {
      return json(c.res, 502, { error: `could not read the message: ${(err as Error).message}` });
    }
    if (!raw) return json(c.res, 404, { error: "no such message" });

    // The body comes from the local archive, which already has it indexed --
    // no reason to re-download what was synced.
    const local = deps.db
      .prepare(`SELECT body_text, has_html FROM emails WHERE account = ? AND id = ?`)
      .get(account, id) as { body_text?: string | null; has_html?: number | null } | undefined;

    const source: SourceMessage = {
      subject: str(raw["subject"]),
      from: addrs(raw["from"]),
      to: addrs(raw["to"]),
      cc: addrs(raw["cc"]),
      replyTo: addrs(raw["replyTo"]),
      messageId: strList(raw["messageId"]),
      references: strList(raw["references"]),
      sentAt: typeof raw["sentAt"] === "string" ? raw["sentAt"] : null,
      bodyText: local?.body_text ?? null,
      hasHtml: local?.has_html === 1,
      attachments: sourceAttachments(raw["attachments"]),
    };

    // Every address this account can send as -- what stops reply-all from
    // CCing the user. Fetched, not guessed: an alias missing from this set
    // reappears in the Cc line of every reply.
    let own = new Set<string>();
    try {
      own = new Set((await fetchIdentities(client, account)).map((i) => i.email.toLowerCase()));
    } catch {
      // Degrade loudly rather than silently: without identities the reply
      // may include the user, so say so instead of pretending it is right.
    }

    const prefill = buildPrefill(source, mode, own);
    // Row 44 (owner ruling 2026-09-07, parity with every other client): the
    // quoted original goes INTO the editor, editable. Its HTML arrives
    // through the editor profile -- the same sanitizer as the frame, remote
    // images blocked with their URL kept for the send -- and the SPA adopts
    // it as nodes. A plaintext source is quoted as text.
    let quoteHtml: string | null = null;
    if (source.hasHtml && deps.blobs) {
      try {
        const body = await loadMessageBody(client, account, id, deps.blobs, true);
        if (body && !body.isPlainText) quoteHtml = editorProfile(body.html);
      } catch {
        quoteHtml = null;
      }
    }
    json(c.res, 200, {
      ...prefill,
      account,
      ownAddressesKnown: own.size > 0,
      quoteSource: { account, id, mode: mode === "forward" ? "forward" : "reply" },
      quoteHtml,
      quoteText: source.bodyText,
    });
  });

  /**
   * GET /api/messages/:account/:id/draft-html — a $draft message's own HTML,
   * sanitized for the editor to adopt, with the quote source and signature
   * placement it was saved with (HTML compose spec 3.5).
   */
  router.add("GET", "/api/messages/:account/:id/draft-html", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    const account = c.params["account"] ?? "";
    const id = c.params["id"] ?? "";
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });
    let raw: Record<string, unknown> | undefined;
    try {
      const responses = await client.request([
        ["Email/get", {
          accountId: client.session.mailAccountId,
          ids: [id],
          properties: ["keywords", "header:X-Wilco-Quote-Source:asText", "header:X-Wilco-Quote-Mode:asText", "header:X-Wilco-Signature-Placement:asText"],
        }, "dh0"],
      ]);
      raw = ((responses[0]?.[1] as { list?: Record<string, unknown>[] } | undefined)?.list ?? [])[0];
    } catch (err) {
      return json(c.res, 502, { error: `could not read the draft: ${(err as Error).message}` });
    }
    if (!raw) return json(c.res, 404, { error: "no such message" });
    const keywords = (raw["keywords"] ?? {}) as Record<string, unknown>;
    if (keywords["$draft"] !== true) return json(c.res, 409, { error: "not a draft" });
    let html: string | null = null;
    if (deps.blobs) {
      try {
        const body = await loadMessageBody(client, account, id, deps.blobs, true);
        if (body && !body.isPlainText) html = sanitizeForEditor(body.html);
      } catch {
        html = null;
      }
    }
    const qs = str(raw["header:X-Wilco-Quote-Source:asText"]).trim();
    const slash = qs.indexOf("/");
    const placementRaw = str(raw["header:X-Wilco-Signature-Placement:asText"]).trim();
    const modeRaw = str(raw["header:X-Wilco-Quote-Mode:asText"]).trim();
    json(c.res, 200, {
      html,
      quoteSource: slash > 0 ? { account: qs.slice(0, slash), id: qs.slice(slash + 1), mode: modeRaw === "forward" ? "forward" : "reply" } : null,
      signaturePlacement: placementRaw === "above" || placementRaw === "below" ? placementRaw : null,
    });
  });

  /**
   * POST /api/attachments/:account — uploads one file into that account and
   * returns the blob to attach.
   *
   * A RAW body, not multipart: the filename and content type ride in
   * headers, so there is no multipart parser to write (the server has zero
   * runtime dependencies) and no boundary-parsing bugs to have. The SPA
   * sends one request per file.
   *
   * 🚨 The response carries `account` alongside the blob, and the SPA keeps
   * it: blob ids are ACCOUNT-SCOPED (spec 11), so changing the sending
   * account invalidates every attachment already uploaded.
   */
  /**
   * POST /api/drafts — saves the compose window's current contents as a
   * JMAP draft, creating on the first call and UPDATING thereafter.
   *
   * Deliberately shares the send route's validation and its `OutgoingMessage`
   * shape: a draft that differed from what is eventually sent is a bug the
   * user cannot see until the mail arrives wrong. It is laxer in exactly one
   * respect — a draft needs no recipient, because "I have not decided who to
   * send this to yet" is the normal state of an unfinished message.
   */
  /**
   * GET /api/identities/:account/:id/signature-url — a capability URL for
   * previewing that identity's HTML signature in the body frame.
   *
   * The preview goes through the body origin rather than being rendered in
   * the SPA, for the reason bodyhost.ts's `serveSignature` gives: our own
   * HTML gets no privileged path the sender's does not have.
   */
  router.add("GET", "/api/identities/:account/:id/signature-url", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!deps.bodyTokenKey || !deps.bodyBaseUrl) {
      return json(c.res, 503, { error: "no body origin configured" });
    }

    const account = c.params["account"] ?? "";
    const id = c.params["id"] ?? "";
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });

    let identities: IdentityInfo[];
    try {
      identities = await fetchIdentities(client, account);
    } catch (err) {
      return json(c.res, 502, { error: `could not read identities: ${(err as Error).message}` });
    }
    const identity = identities.find((i) => i.id === id);
    if (!identity) return json(c.res, 404, { error: `no identity ${id} on ${account}` });

    const token = mintBodyToken(deps.bodyTokenKey, { account, id, kind: "signature" });
    json(c.res, 200, {
      url: `${deps.bodyBaseUrl}/s/${encodeURIComponent(token)}`,
      expiresInMs: BODY_TOKEN_TTL_MS,
      hasHtml: identity.htmlSignature !== "",
      // The Settings preview shows the whole signature at its natural
      // height (row 38). A cross-origin frame cannot be measured, so the
      // server estimates, erring tall. null when there is nothing to show.
      height: identity.htmlSignature === "" ? null : estimateSignatureHeight(identity.htmlSignature),
    });
  });

  /**
   * GET /api/identities/:account/:id/signature-html — the signature as a
   * document the SPA's editor may ADOPT (HTML compose spec 3.2 / 5): the
   * owner's own markup, after the same sanitizer as a stranger's mail, with
   * remote images blocked and `cid:` unresolvable. `data:` images stay --
   * the SPA's CSP allows them and the send path turns them into `cid:`.
   */
  router.add("GET", "/api/identities/:account/:id/signature-html", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    const account = c.params["account"] ?? "";
    const id = c.params["id"] ?? "";
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });
    let identities: IdentityInfo[];
    try {
      identities = await fetchIdentities(client, account);
    } catch (err) {
      return json(c.res, 502, { error: `could not read identities: ${(err as Error).message}` });
    }
    const identity = identities.find((i) => i.id === id);
    if (!identity) return json(c.res, 404, { error: `no identity ${id} on ${account}` });
    json(c.res, 200, {
      html: identity.htmlSignature === "" ? "" : sanitizeForEditor(identity.htmlSignature),
      text: identity.textSignature,
    });
  });

  /**
   * PUT /api/identities/:account/:id/signature — writes the signature back
   * to the JMAP Identity.
   *
   * 🚨 The body is taken BYTE FOR BYTE (spec 11). RFC 3676's separator is
   * `-- ` with a trailing space, and Fastmail round-trips the value exactly
   * -- so trimming here, however tidy it looks, corrupts every signature
   * that uses the convention.
   */
  router.add("PUT", "/api/identities/:account/:id/signature", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    if (!hasScope(principal, "write")) return json(c.res, 403, { error: "write scope required" });

    const account = c.params["account"] ?? "";
    const id = c.params["id"] ?? "";
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });

    const b = (await readJson(c.req)) as Record<string, unknown>;
    if (typeof b["textSignature"] !== "string") {
      return json(c.res, 400, { error: "textSignature must be a string" });
    }
    const textSignature = b["textSignature"];
    // Optional: a caller updating only the plaintext half must not be made
    // to send the HTML one back, and vice versa.
    const htmlSignature = typeof b["htmlSignature"] === "string" ? b["htmlSignature"] : undefined;

    // Only an identity this account actually owns -- the id comes from the
    // client, and Identity/set would otherwise be handed an arbitrary one.
    let identities: IdentityInfo[];
    try {
      identities = await fetchIdentities(client, account);
    } catch (err) {
      return json(c.res, 502, { error: `could not read identities: ${(err as Error).message}` });
    }
    if (!identities.some((i) => i.id === id)) {
      return json(c.res, 404, { error: `no identity ${id} on ${account}` });
    }

    try {
      const responses = await client.request(
        [
          [
            "Identity/set",
            {
              accountId: client.session.submissionAccountId,
              update: { [id]: htmlSignature === undefined ? { textSignature } : { textSignature, htmlSignature } },
            },
            "is0",
          ],
        ],
        USING_SUBMISSION,
      );
      const args = (responses[0]?.[1] ?? {}) as {
        updated?: Record<string, unknown>;
        notUpdated?: Record<string, { description?: string; type?: string }>;
      };
      const failed = args.notUpdated?.[id];
      if (failed) return json(c.res, 502, { error: failed.description ?? failed.type ?? "identity not updated" });
      if (!(id in (args.updated ?? {}))) {
        return json(c.res, 502, { error: "the server neither updated nor refused the identity" });
      }
    } catch (err) {
      return json(c.res, 502, { error: `could not save the signature (${(err as Error).name})` });
    }

    // The cache is per-process and long-lived by design; a write must not
    // leave every compose window showing the old signature until restart.
    identityCache.delete(account);
    json(c.res, 200, { saved: true, textSignature, htmlSignature });
  });

  router.add("POST", "/api/drafts", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    if (!hasScope(principal, "write")) return json(c.res, 403, { error: "write scope required" });

    const b = (await readJson(c.req)) as Record<string, unknown>;
    const account = typeof b["account"] === "string" ? b["account"] : "";
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });

    const to = parseAddrs(b["to"]);
    const cc = parseAddrs(b["cc"]);
    const bcc = parseAddrs(b["bcc"]);
    if (to === null || cc === null || bcc === null) {
      return json(c.res, 400, { error: "to/cc/bcc must be [{email, name?}]" });
    }
    const attachments = parseAttachments(b["attachments"]);
    if (attachments === null) return json(c.res, 400, { error: "attachments malformed" });
    const foreign = attachments.find((a) => a.account !== account);
    if (foreign) {
      return json(c.res, 400, { error: `${foreign.name} belongs to ${foreign.account}, not ${account}` });
    }

    let identities: IdentityInfo[];
    try {
      identities = await fetchIdentities(client, account);
    } catch (err) {
      return json(c.res, 502, { error: `could not read identities: ${(err as Error).message}` });
    }
    const from = typeof b["from"] === "string" ? b["from"] : "";
    const identity = identities.find((i) => i.email.toLowerCase() === from.toLowerCase()) ?? identities[0];
    if (!identity) return json(c.res, 503, { error: `no identity available for ${account}` });

    const draftsId = mailboxIdForRole(deps.db, account, "drafts");
    if (!draftsId) return json(c.res, 503, { error: `${account} has no Drafts mailbox` });

    const draftHtml = typeof b["html"] === "string" ? sanitizeOutgoing(b["html"]) : null;
    const draftHeaders: Record<string, string> = {};
    const qs = quoteSourceOf(b["quoteSource"]);
    if (qs) {
      draftHeaders["X-Wilco-Quote-Source"] = `${qs.account}/${qs.id}`;
      draftHeaders["X-Wilco-Quote-Mode"] = qs.mode;
    }
    if (b["signaturePlacement"] === "above" || b["signaturePlacement"] === "below") {
      draftHeaders["X-Wilco-Signature-Placement"] = b["signaturePlacement"];
    }

    const msg: OutgoingMessage = {
      from: { name: identity.name, email: identity.email },
      to,
      cc,
      bcc,
      subject: typeof b["subject"] === "string" ? b["subject"] : "",
      // The editor's HTML is saved as-is (sanitized), signature block
      // included, quote NOT included -- the quote is attached at send from
      // the source the headers below name (HTML compose spec 3.5).
      text: draftHtml !== null ? deriveText(draftHtml, null) : typeof b["text"] === "string" ? b["text"] : "",
      html: draftHtml,
      headers: draftHeaders,
      inReplyTo: typeof b["inReplyTo"] === "string" ? b["inReplyTo"] : null,
      references: Array.isArray(b["references"]) ? b["references"].filter((r): r is string => typeof r === "string") : null,
      attachments: attachments.map(({ account: _a, ...rest }) => rest),
    };

    const existingId = typeof b["draftId"] === "string" && b["draftId"] !== "" ? b["draftId"] : null;
    try {
      const saved = await saveDraft(client, msg, { draftsId, existingId });
      deps.onChange?.(account);
      json(c.res, 200, { draftId: saved.emailId, account });
    } catch (err) {
      if (err instanceof SendError) {
        // A draft the server would not update is usually one destroyed
        // elsewhere. Say so with a distinct code so the SPA can drop its id
        // and create a fresh draft rather than retrying the same update
        // forever.
        return json(c.res, 409, { error: err.message, retryAsNew: existingId !== null });
      }
      throw err;
    }
  });

  /** DELETE /api/drafts/:account/:id — discard. */
  router.add("DELETE", "/api/drafts/:account/:id", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    if (!hasScope(principal, "write")) return json(c.res, 403, { error: "write scope required" });

    const account = c.params["account"] ?? "";
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });

    try {
      await destroyDraft(client, c.params["id"] ?? "");
    } catch (err) {
      return json(c.res, 502, { error: `could not discard the draft: ${(err as Error).name}` });
    }
    deps.onChange?.(account);
    json(c.res, 200, { discarded: true });
  });

  router.add("POST", "/api/attachments/:account", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    if (!hasScope(principal, "write")) return json(c.res, 403, { error: "write scope required" });

    const account = c.params["account"] ?? "";
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });

    const name = safeAttachmentName(c.req.headers["x-wilco-filename"]);
    const type = typeof c.req.headers["content-type"] === "string" ? c.req.headers["content-type"] : "";

    // Read with a hard cap rather than buffering whatever arrives: the cap
    // is the same 25MB the send refuses at (spec 4.6), enforced BEFORE the
    // bytes go anywhere, so an oversized file never reaches Fastmail.
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of c.req) {
        size += (chunk as Buffer).length;
        if (size > MAX_ATTACHMENT_BYTES) {
          return json(c.res, 413, {
            error: `${name} is larger than the ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB limit`,
          });
        }
        chunks.push(chunk as Buffer);
      }
    } catch {
      return json(c.res, 400, { error: "could not read the upload" });
    }
    if (size === 0) return json(c.res, 400, { error: "the file is empty" });

    try {
      const blob = await client.uploadBlob(client.session.mailAccountId, Buffer.concat(chunks), type);
      json(c.res, 200, { account, blobId: blob.blobId, name, type: blob.type, size: blob.size });
    } catch (err) {
      // Never pass the upstream message through unaltered: an upload URL
      // carries the bearer token.
      return json(c.res, 502, { error: `upload failed (${(err as Error).name})` });
    }
  });

  /**
   * POST /api/contacts { q, from? } -- suggestions for the To field (spec
   * 7.5, row 23). POST, never GET: the typed fragment is a search term and
   * must not land in the proxy's access log on a URL.
   *
   * The BOOK is unified (owner ruling 2026-10-03): `from` never narrows who
   * can be found -- that per-account scoping was the defect. `from` only
   * names the account doing the sending, so ITS addresses are left out:
   * nobody writes to the address they are writing from.
   *
   * 🚨 ONLY the sending account's addresses, never every account's. That
   * was tried first and board row 23 went red on it: composing from work
   * could no longer suggest the owner's personal address, and writing from
   * one of your accounts to another is an ordinary thing to do. Your other
   * selves rank high only when the fragment matches them, which is exactly
   * when you are typing your own name.
   *
   * An account whose identities cannot be fetched excludes nothing rather
   * than failing the lookup: one address too many beats no suggestions.
   */
  router.add("POST", "/api/contacts", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    let payload: unknown;
    try {
      payload = await readJson(c.req);
    } catch {
      return json(c.res, 400, { error: "invalid json" });
    }
    const b = payload as { q?: unknown; from?: unknown };
    const q = typeof b.q === "string" ? b.q : "";
    const exclude = new Set<string>();
    const client = typeof b.from === "string" ? deps.clients.get(b.from) : undefined;
    if (client !== undefined) {
      try {
        for (const i of await fetchIdentities(client, b.from as string)) exclude.add(i.email);
      } catch {
        // Offer suggestions without the exclusion rather than none at all.
      }
    }
    json(c.res, 200, { contacts: book.suggest(q, { exclude }) });
  });

  /**
   * POST /api/contacts/habits { emails } -> { habits: { [email]: accounts } }
   * -- which accounts have ever written to each address, most recently used
   * first, for the composer's mismatch note ("you usually write to Jordan
   * from Personal").
   *
   * POST, never GET, for the same reason as search and /api/contacts: a
   * recipient's address on a URL is a permanent record in the proxy log of
   * who the owner writes to.
   *
   * Every requested address gets a key, so the client can tell "no habit"
   * (an empty list -- the note stays silent) from "not asked".
   */
  router.add("POST", "/api/contacts/habits", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    let payload: unknown;
    try {
      payload = await readJson(c.req);
    } catch {
      return json(c.res, 400, { error: "invalid json" });
    }
    const b = payload as { emails?: unknown };
    if (!Array.isArray(b.emails)) return json(c.res, 400, { error: "emails required" });
    const habits: Record<string, string[]> = {};
    for (const raw of b.emails.slice(0, HABIT_LOOKUP_LIMIT)) {
      if (typeof raw !== "string" || raw === "") continue;
      const email = raw.toLowerCase();
      if (email in habits) continue;
      habits[email] = book.habits(email);
    }
    json(c.res, 200, { habits });
  });

  /**
   * Unsubscribe (row 31; core/unsubscribe.ts). GET says which method the
   * message offers, so the reading pane shows the control only when it
   * would do something; POST performs it -- a one-click POST from THIS
   * server, or an email sent from the account -- and reports the outcome.
   * Server-side by owner ruling: the SPA's CSP stays `connect-src 'self'`.
   */
  router.add("GET", "/api/messages/:account/:id/unsubscribe", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    const account = c.params["account"] ?? "";
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });
    const plan = await unsubscribePlanFor(client, c.params["id"] ?? "");
    if (plan === "notfound") return json(c.res, 404, { error: "no such message" });
    json(c.res, 200, { method: plan === null ? null : plan.kind });
  });

  router.add("POST", "/api/messages/:account/:id/unsubscribe", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    if (!hasScope(principal, "write")) return json(c.res, 403, { error: "write scope required" });
    const account = c.params["account"] ?? "";
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });
    const plan = await unsubscribePlanFor(client, c.params["id"] ?? "");
    if (plan === "notfound") return json(c.res, 404, { error: "no such message" });
    if (plan === null) return json(c.res, 404, { error: "this message offers no way to unsubscribe" });

    if (plan.kind === "post") {
      const result = await oneClickPost(plan.url, deps.fetchFn ?? ((u, i) => fetch(u, i)));
      return json(c.res, 200, { method: "post", ok: result.ok, status: result.status });
    }

    // mailto: an email from the account's primary identity. No signature
    // -- a list processor reads the subject and the address, not a person.
    let identities: IdentityInfo[];
    try {
      identities = await fetchIdentities(client, account);
    } catch (err) {
      return json(c.res, 502, { error: `could not read identities: ${(err as Error).message}` });
    }
    const identity = identities.find((i) => i.primary) ?? identities[0];
    if (!identity) return json(c.res, 503, { error: `${account} has no sending identity` });
    try {
      const result = await send(
        client,
        {
          from: { name: identity.name, email: identity.email },
          to: [{ email: plan.to }],
          subject: plan.subject,
          text: plan.body !== "" ? plan.body : "Unsubscribe",
        },
        {
          identityId: identity.id,
          draftsId: mailboxIdForRole(deps.db, account, "drafts"),
          sentId: mailboxIdForRole(deps.db, account, "sent"),
        },
      );
      deps.onChange?.(account);
      return json(c.res, 200, { method: "mailto", ok: true, to: plan.to, emailId: result.emailId });
    } catch (err) {
      return json(c.res, 502, { error: err instanceof Error ? err.message : "could not send the unsubscribe email" });
    }
  });

  /** POST /api/contacts/written { account, email } -> { written } -- has
   *  this account ever written to that address? (row 37, "people only"). */
  router.add("POST", "/api/contacts/written", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    let payload: unknown;
    try {
      payload = await readJson(c.req);
    } catch {
      return json(c.res, 400, { error: "invalid json" });
    }
    const b = payload as { account?: unknown; email?: unknown };
    if (typeof b.account !== "string" || b.account === "") return json(c.res, 400, { error: "account required" });
    if (typeof b.email !== "string" || b.email === "") return json(c.res, 400, { error: "email required" });
    json(c.res, 200, { written: writtenTo(deps.db, b.account, b.email) });
  });

  router.add("POST", "/api/send", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    if (!hasScope(principal, "write")) return json(c.res, 403, { error: "write scope required" });

    let payload: unknown;
    try {
      payload = await readJson(c.req);
    } catch {
      return json(c.res, 400, { error: "invalid json" });
    }
    const b = payload as {
      account?: unknown;
      from?: unknown;
      to?: unknown;
      cc?: unknown;
      bcc?: unknown;
      subject?: unknown;
      text?: unknown;
      html?: unknown;
      inReplyTo?: unknown;
      references?: unknown;
      attachments?: unknown;
      signature?: unknown;
      quoteSource?: unknown;
      signaturePlacement?: unknown;
    };

    if (typeof b.account !== "string" || b.account === "") {
      return json(c.res, 400, { error: "account required" });
    }
    const client = deps.clients.get(b.account);
    if (!client) return json(c.res, 503, { error: "account not connected" });

    const to = parseAddrs(b.to);
    const cc = parseAddrs(b.cc);
    const bcc = parseAddrs(b.bcc);
    if (to === null || cc === null || bcc === null) {
      return json(c.res, 400, { error: "to/cc/bcc must be [{email, name?}]" });
    }
    if (typeof b.from !== "string" || b.from === "") return json(c.res, 400, { error: "from required" });
    if (typeof b.subject !== "string") return json(c.res, 400, { error: "subject required" });
    if (typeof b.text !== "string" && typeof b.html !== "string") return json(c.res, 400, { error: "text or html required" });

    let identities: IdentityInfo[];
    try {
      identities = await fetchIdentities(client, b.account);
    } catch (err) {
      return json(c.res, 502, { error: `could not read identities: ${(err as Error).message}` });
    }
    // The sender must be an address this account actually owns.
    const identity = identities.find((i) => i.email.toLowerCase() === b.from!.toString().toLowerCase());
    if (!identity) {
      return json(c.res, 403, { error: `${b.from} is not an identity of ${b.account}` });
    }

    const attachments = parseAttachments(b.attachments);
    if (attachments === null) {
      return json(c.res, 400, { error: "attachments must be [{blobId, name, type, size, account}]" });
    }
    // 🚨 Blob ids are ACCOUNT-SCOPED (spec 11). A blob uploaded into one
    // account cannot be attached to a message sent from another -- JMAP
    // refuses the send with an opaque error, so catch it here where the
    // message can name the actual problem.
    const foreign = attachments.find((a) => a.account !== b.account);
    if (foreign) {
      return json(c.res, 400, {
        error: `${foreign.name} was uploaded to ${foreign.account} and cannot be sent from ${b.account} — re-attach it`,
      });
    }
    const oversized = checkAttachmentSizes(attachments);
    if (oversized !== null) return json(c.res, 413, { error: oversized });

    const richHtml = typeof b.html === "string" ? b.html : null;
    let text: string;
    let html: string | null = null;
    const inlineImages: OutgoingInlineImage[] = [];
    const stamp = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
    if (richHtml !== null) {
      // The SPA's path (HTML compose spec 3.4). What is on screen is what
      // goes out: no append, the signature wherever the owner left it. The
      // editor's HTML is not trusted -- sanitized again here with the
      // outgoing profile -- and every data: image becomes a cid: part.
      const placement: SignaturePlacement = b.signaturePlacement === "below" ? "below" : "above";
      const quote = await resolveQuote(deps, b.quoteSource);
      const clean = sanitizeOutgoing(richHtml);
      const prepared = prepareSignatureImages(clean, (i) => `img${i}.${stamp}@wilco`);
      let bodyHtml = prepared.html;
      for (const image of prepared.images) {
        try {
          const blob = await client.uploadBlob(client.session.mailAccountId, image.bytes, image.type);
          inlineImages.push({ blobId: blob.blobId, cid: image.cid, type: image.type, name: image.name });
        } catch {
          // An image that will not upload must not block the message: fall
          // back to the data: URLs as written. A broken image beats an
          // unsent email.
          bodyHtml = clean;
          inlineImages.length = 0;
          break;
        }
      }
      html = assembleOutgoing({ html: bodyHtml, placement, quote });
      if (placement === "below") {
        const split = splitSignature(bodyHtml);
        text = deriveText(split.body, quote, split.signature ?? "");
      } else {
        text = deriveText(bodyHtml, quote);
      }
    } else {
      // 🚨 The signature is appended HERE, on send, and is deliberately NOT
      // stored in the draft. Storing it would append a second copy every time
      // a draft was resumed and sent. The cost is that a draft opened in
      // Fastmail's own client shows no signature until it is sent from Wilco
      // -- the better of the two failures.
      //
      // Server-side rather than in the SPA so an agent authenticating with a
      // bearer token gets the same signature a person does; the API is a
      // first-class consumer, not an afterthought. `signature: false` opts
      // out for a caller that has already composed one in.
      const wantsSignature = b.signature !== false;
      const htmlSig = wantsSignature ? identity.htmlSignature : "";

      // The plaintext half. When the identity has an HTML signature but no
      // separate text one, DERIVE it (spec 11) rather than leaving it empty:
      // a recipient whose client prefers text/plain would otherwise see a
      // message with no signature at all while an HTML reader sees one.
      const textSig = wantsSignature
        ? identity.textSignature !== ""
          ? identity.textSignature
          : htmlSig !== ""
            ? derivePlainSignature(htmlSig)
            : ""
        : "";
      text = appendSignature(b.text as string, textSig);

      // 🚨 `data:`-stored, `cid:`-sent (spec 11). Fastmail keeps base64
      // images inside htmlSignature, but a `data:` image in a SENT message is
      // stripped or blocked by many receiving clients -- so each one is
      // uploaded as a blob and its src rewritten before the message is built.
      if (htmlSig !== "") {
        const prepared = prepareSignatureImages(htmlSig, (i) => `sig${i}.${stamp}@wilco`);
        for (const image of prepared.images) {
          try {
            const blob = await client.uploadBlob(client.session.mailAccountId, image.bytes, image.type);
            inlineImages.push({ blobId: blob.blobId, cid: image.cid, type: image.type, name: image.name });
          } catch {
            // A logo that will not upload must not block the message. The
            // reference is left as the original `data:` URL by falling back
            // to the unrewritten signature -- some clients render it, and a
            // broken image beats an unsent email.
            html = buildHtmlBody(b.text as string, htmlSig);
          }
        }
        if (html === null) html = buildHtmlBody(b.text as string, prepared.html);
      }
      // 🚨 A reply to an HTML message goes out as HTML (CHECKLIST row 12).
      // `html: true` asks for the text/html half even with no HTML
      // signature; it is generated from the SAME signed text as the
      // text/plain half (escaped, line-broken), so the two say one thing.
      if (html === null && b.html === true) html = buildHtmlBody(text, "");
    }

    const msg: OutgoingMessage = {
      from: { name: identity.name, email: identity.email },
      attachments: attachments.map(({ account: _account, ...a }) => a),
      to,
      cc,
      bcc,
      subject: b.subject,
      text,
      html,
      inlineImages,
      inReplyTo: typeof b.inReplyTo === "string" ? b.inReplyTo : null,
      references: Array.isArray(b.references) ? b.references.filter((r): r is string => typeof r === "string") : null,
    };

    try {
      const result = await send(client, msg, {
        identityId: identity.id,
        draftsId: mailboxIdForRole(deps.db, b.account, "drafts"),
        sentId: mailboxIdForRole(deps.db, b.account, "sent"),
      });
      deps.onChange?.(b.account);
      json(c.res, 200, { sent: true, ...result });
    } catch (err) {
      if (err instanceof SendError) return json(c.res, 502, { error: err.message });
      throw err;
    }
  });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The SPA profile: what the editor may adopt (HTML compose spec 5). */
function sanitizeForEditor(html: string): string {
  return editorProfile(html);
}

function quoteSourceOf(v: unknown): { account: string; id: string; mode: "reply" | "forward" } | null {
  if (!v || typeof v !== "object") return null;
  const { account, id, mode } = v as { account?: unknown; id?: unknown; mode?: unknown };
  if (typeof account !== "string" || account === "" || typeof id !== "string" || id === "") return null;
  return { account, id, mode: mode === "forward" ? "forward" : "reply" };
}

/**
 * The quoted original for a send (HTML compose spec 3.4): attribution from
 * the message's own from/sentAt, its HTML through the body cache sanitized
 * with the OUTGOING profile, its text from the archive. Assembled here so
 * a sender's HTML never enters the SPA's document. Anything unreadable
 * degrades to less quote, never to no send.
 */
async function resolveQuote(deps: SendDeps, v: unknown): Promise<QuoteSource | null> {
  const qs = quoteSourceOf(v);
  if (!qs) return null;
  const client = deps.clients.get(qs.account);
  if (!client) return null;
  const row = deps.db
    .prepare("SELECT body_text, has_html FROM emails WHERE account = ? AND id = ?")
    .get(qs.account, qs.id) as { body_text?: string | null; has_html?: number | null } | undefined;
  if (!row) return null;
  let from: ReplyAddr[] = [];
  let to: ReplyAddr[] = [];
  let cc: ReplyAddr[] = [];
  let subject = "";
  let sentAt: string | null = null;
  try {
    const responses = await client.request([
      ["Email/get", { accountId: client.session.mailAccountId, ids: [qs.id], properties: ["from", "to", "cc", "subject", "sentAt"] }, "q0"],
    ]);
    const m = ((responses[0]?.[1] as { list?: Record<string, unknown>[] } | undefined)?.list ?? [])[0];
    if (m) {
      from = addrs(m["from"]);
      to = addrs(m["to"]);
      cc = addrs(m["cc"]);
      subject = str(m["subject"]);
      sentAt = typeof m["sentAt"] === "string" ? m["sentAt"] : null;
    }
  } catch {
    // The attribution line then names nobody; the quote itself is unaffected.
  }
  // A forward is headed by the forwarded-message block, a reply by
  // "On …, X wrote:" -- the same lines the plain-text prefill uses.
  const attribution =
    qs.mode === "forward"
      ? forwardHeader({ subject, from, to, cc, replyTo: [], messageId: null, references: null, sentAt, bodyText: null, hasHtml: false, attachments: [] })
      : attributionLine({ from, sentAt });
  let html: string | null = null;
  if (row.has_html === 1 && deps.blobs) {
    try {
      const body = await loadMessageBody(client, qs.account, qs.id, deps.blobs, true);
      if (body && !body.isPlainText) html = sanitizeOutgoing(body.html);
    } catch {
      html = null;
    }
  }
  return { attribution, html, text: row.body_text ?? null };
}

/** The two headers, straight from the server: they are not in the archive,
 *  and one Email/get on open is cheaper than a column and a backfill. */
async function unsubscribePlanFor(client: JmapClient, id: string): Promise<UnsubscribePlan | null | "notfound"> {
  const responses = await client.request([
    [
      "Email/get",
      {
        accountId: client.session.mailAccountId,
        ids: [id],
        properties: ["header:List-Unsubscribe:asURLs", "header:List-Unsubscribe-Post:asText"],
      },
      "u0",
    ],
  ]);
  const raw = ((responses[0]?.[1] as { list?: Record<string, unknown>[] } | undefined)?.list ?? [])[0];
  if (!raw) return "notfound";
  const urls = raw["header:List-Unsubscribe:asURLs"];
  const post = raw["header:List-Unsubscribe-Post:asText"];
  return planUnsubscribe(Array.isArray(urls) ? (urls as string[]) : null, typeof post === "string" ? post : null);
}

/** The source's real attachments from `Email/get`'s `attachments` list: a
 *  part with a `cid` is an inline image (a signature logo), not something
 *  a forward should re-send as a file -- the same inline/attachment split
 *  spec 6.5 makes when reading mail. */
export function sourceAttachments(v: unknown): SourceAttachment[] {
  if (!Array.isArray(v)) return [];
  const out: SourceAttachment[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const p = item as { blobId?: unknown; name?: unknown; type?: unknown; size?: unknown; cid?: unknown };
    if (typeof p.blobId !== "string" || p.blobId === "") continue;
    if (typeof p.cid === "string" && p.cid !== "") continue;
    out.push({
      blobId: p.blobId,
      name: typeof p.name === "string" && p.name !== "" ? p.name : "attachment",
      type: typeof p.type === "string" && p.type !== "" ? p.type : "application/octet-stream",
      size: typeof p.size === "number" ? p.size : 0,
    });
  }
  return out;
}

function strList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : null;
}

function addrs(v: unknown): Addr[] {
  if (!Array.isArray(v)) return [];
  const out: Addr[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const a = item as { email?: unknown; name?: unknown };
    if (typeof a.email !== "string" || a.email.trim() === "") continue;
    out.push({ email: a.email.trim(), name: typeof a.name === "string" ? a.name : null });
  }
  return out;
}

function parseAddrs(raw: unknown): Addr[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: Addr[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const a = item as { email?: unknown; name?: unknown };
    if (typeof a.email !== "string" || a.email.trim() === "") return null;
    out.push({ email: a.email.trim(), name: typeof a.name === "string" ? a.name : null });
  }
  return out;
}

/**
 * Attachments as the SPA sends them: a blob it already uploaded, plus the
 * account it was uploaded INTO. That last field is not redundant -- blob ids
 * are account-scoped, and carrying the account is what lets the send route
 * refuse a stale blob by name instead of letting JMAP fail opaquely.
 */
interface IncomingAttachment extends OutgoingAttachment {
  account: string;
}

export function parseAttachments(raw: unknown): IncomingAttachment[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: IncomingAttachment[] = [];
  for (const item of raw) {
    const a = item as Record<string, unknown>;
    if (
      typeof a["blobId"] !== "string" ||
      typeof a["name"] !== "string" ||
      typeof a["type"] !== "string" ||
      typeof a["size"] !== "number" ||
      typeof a["account"] !== "string"
    ) {
      return null;
    }
    out.push({
      blobId: a["blobId"],
      name: a["name"],
      type: a["type"],
      size: a["size"],
      account: a["account"],
    });
  }
  return out;
}

/**
 * The filename the SPA declared, made safe to store and to echo back.
 * Basename only, control characters stripped, length capped. It reaches a
 * recipient's mail client as a MIME parameter, so it is not merely
 * cosmetic.
 */
export function safeAttachmentName(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  let decoded = value;
  try {
    // The SPA percent-encodes it: a header cannot carry a raw UTF-8
    // filename, and a raw CR/LF in one would be response splitting.
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed encoding: fall through and sanitise what we were given.
  }
  const base = decoded.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim().slice(0, 120);
  return cleaned === "" ? "attachment" : cleaned;
}

/**
 * Joins a body and a signature.
 *
 * 🚨 The signature is used BYTE FOR BYTE (spec 11): RFC 3676's separator is
 * `-- ` WITH a trailing space, and trimming it -- which every instinct says
 * to do -- silently breaks the convention every mail client uses to fold a
 * signature away. Nothing here trims, and nothing here INVENTS a separator
 * either: if the operator wants `-- `, it is part of the signature they
 * stored, and adding one ourselves would give a doubled separator to
 * everyone who already typed it.
 */
export function appendSignature(body: unknown, signature: string): string {
  const text = typeof body === "string" ? body : "";
  if (signature === "") return text;
  if (text === "") return signature;
  return `${text}\n\n${signature}`;
}

/**
 * One identity's HTML signature, for the body origin's preview route.
 * Returns null when the account is not connected or the identity is
 * unknown -- both of which the caller answers as 404, not as an error.
 */
export async function htmlSignatureFor(
  clients: Map<string, JmapClient>,
  account: string,
  identityId: string,
): Promise<string | null> {
  const client = clients.get(account);
  if (!client) return null;
  const identities = await fetchIdentities(client, account);
  return identities.find((i) => i.id === identityId)?.htmlSignature ?? null;
}
