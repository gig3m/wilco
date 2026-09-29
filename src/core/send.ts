/**
 * Sending: `Email/set` to create a draft, then `EmailSubmission/set` to hand
 * it to the MTA, in ONE JMAP request using a back-reference.
 *
 * This is the only code in Wilco that causes an irreversible, outward-facing
 * side effect. Triage moves mail inside an account and undo puts it back; a
 * sent message is gone the moment the MTA accepts it. Everything here is
 * shaped by that:
 *
 *  - **One request, not two.** Creating the draft and submitting it in
 *    separate requests means a crash between them leaves an orphaned draft
 *    that the user never sees and never sent. JMAP's `#creationId`
 *    back-reference makes it atomic from the client's point of view.
 *  - **onSuccessUpdateEmail files the message into Sent and clears $draft
 *    in the same breath.** Doing it in a follow-up call would leave a
 *    successfully-sent message sitting in Drafts if that call failed --
 *    the user would resend it.
 *  - **The envelope is derived from the message, never taken from the
 *    caller.** A client that could set `envelope.rcptTo` independently of
 *    the To/Cc/Bcc it displays could send to an address the user never
 *    saw. rcptTo is computed here from to+cc+bcc and nothing else.
 *  - **Bcc must be in the envelope but NOT visible to other recipients.**
 *    JMAP handles the header stripping, but the address still has to reach
 *    rcptTo or a bcc'd person silently never receives the mail.
 */

import type { JmapClient } from "./client.ts";
import { USING_SUBMISSION } from "./client.ts";

export class SendError extends Error {}

export interface Addr {
  name?: string | null;
  email: string;
}

export interface OutgoingMessage {
  from: Addr;
  to: Addr[];
  cc?: Addr[];
  bcc?: Addr[];
  subject: string;
  /** Plain text only. Wilco does not compose HTML mail -- spec 3.1 keeps
   *  message HTML out of the client entirely, and generating HTML we then
   *  refuse to render would be incoherent. */
  text: string;
  /** Set when this is a reply, so threading works in the recipient's
   *  client. Without these two headers a reply starts a new thread. */
  inReplyTo?: string | null;
  references?: string[] | null;
  /** Blobs already uploaded INTO THE SENDING ACCOUNT. Blob ids are
   *  account-scoped (spec 11), so one uploaded elsewhere is refused. */
  attachments?: OutgoingAttachment[];
  /**
   * The `text/html` half. Set only when the sending identity has an HTML
   * signature -- Wilco does not compose HTML, it GENERATES this half from
   * the plaintext body plus that signature (see core/signature.ts). When
   * present the message goes out as multipart/alternative.
   */
  html?: string | null;
  /**
   * Signature images, uploaded as blobs and referenced from `html` by
   * `cid:`. Sent with `disposition: "inline"` and a `cid`, which is what
   * keeps them out of the recipient's attachment list.
   */
  inlineImages?: OutgoingInlineImage[];
  /**
   * Custom headers on the Email/set create (`header:<Name>:asText`, RFC
   * 8621 4.1.3). A draft carries its quote source and signature placement
   * this way (HTML compose spec 3.5), so resuming it restores both.
   */
  headers?: Record<string, string>;
}

export interface OutgoingInlineImage {
  blobId: string;
  /** Without angle brackets, matching the `cid:` in the HTML. */
  cid: string;
  type: string;
  name: string;
}

export interface OutgoingAttachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

/**
 * 25MB, refused up front and BY NAME (spec 4.6).
 *
 * `maxSizeUpload` advertises 238MB, but most receiving servers refuse over
 * ~25MB [research]. Accepting the larger number means the upload completes,
 * the send appears to work, and the failure arrives at the far end — after
 * the user has moved on. Refusing here, naming the file, is the better
 * failure.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Refuses an oversized attachment set, naming the offender. Total as well
 *  as per-file: ten 3MB files is a 30MB message. */
export function checkAttachmentSizes(attachments: OutgoingAttachment[]): string | null {
  let total = 0;
  for (const a of attachments) {
    if (a.size > MAX_ATTACHMENT_BYTES) {
      return `${a.name} is ${mb(a.size)} — the limit is ${mb(MAX_ATTACHMENT_BYTES)} per attachment`;
    }
    total += a.size;
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    return `the attachments total ${mb(total)} — the limit is ${mb(MAX_ATTACHMENT_BYTES)}`;
  }
  return null;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface SendResult {
  emailId: string;
  submissionId: string;
}

/** RFC 5322 requires at least one recipient; JMAP will reject an empty
 *  rcptTo with an opaque error, so catch it here with a useful message. */
export function envelopeFor(msg: OutgoingMessage): { mailFrom: { email: string }; rcptTo: { email: string }[] } {
  const seen = new Set<string>();
  const rcptTo: { email: string }[] = [];
  for (const list of [msg.to, msg.cc ?? [], msg.bcc ?? []]) {
    for (const a of list) {
      const email = a.email.trim();
      if (email === "") continue;
      // De-duplicated: the same address in To and Cc must not receive two
      // copies, and some MTAs reject a duplicated rcptTo outright.
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rcptTo.push({ email });
    }
  }
  if (rcptTo.length === 0) throw new SendError("a message needs at least one recipient");
  if (msg.from.email.trim() === "") throw new SendError("a message needs a from address");
  return { mailFrom: { email: msg.from.email }, rcptTo };
}

function addrList(list: Addr[] | undefined): { name: string | null; email: string }[] | null {
  if (!list || list.length === 0) return null;
  return list
    .filter((a) => a.email.trim() !== "")
    .map((a) => ({ name: a.name ?? null, email: a.email.trim() }));
}

/**
 * Build the two-call JMAP body. Extracted from `send` so the exact shape can
 * be asserted in a test without a live account -- this is the payload that,
 * if wrong, mails the wrong people.
 */
/**
 * The Email object a draft or an outgoing message is built from.
 *
 * Shared by `buildSendCalls` and `buildDraftCalls` deliberately: a draft
 * that differed from what is eventually sent -- a dropped Bcc, an
 * attachment listed one way here and another there -- is a bug the user
 * cannot see until the mail arrives wrong.
 */
export function buildEmail(msg: OutgoingMessage, draftsId: string): Record<string, unknown> {
  const email: Record<string, unknown> = {
    // Drafts is where a message legitimately lives between creation and
    // submission; onSuccessUpdateEmail moves it to Sent below.
    mailboxIds: { [draftsId]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: msg.from.name ?? null, email: msg.from.email }],
    to: addrList(msg.to),
    cc: addrList(msg.cc),
    bcc: addrList(msg.bcc),
    subject: msg.subject,
    bodyValues: { body: { value: msg.text } },
    textBody: [{ partId: "body", type: "text/plain" }],
  };
  // JMAP builds the MIME structure from textBody + attachments; there is
  // no need to hand it a bodyStructure, and doing so would mean composing
  // multipart nesting by hand (spec 11's warning about getting it wrong).
  // 🚨 An HTML half makes this multipart/alternative. Both halves are set
  // from the SAME body text (see core/signature.ts) -- the one thing
  // multipart/alternative must never do is say different things in its two
  // parts.
  for (const [name, value] of Object.entries(msg.headers ?? {})) {
    if (/^X-Wilco-[A-Za-z-]+$/.test(name)) email[`header:${name}:asText`] = value;
  }
  if (typeof msg.html === "string" && msg.html !== "") {
    email["bodyValues"] = {
      body: { value: msg.text },
      html: { value: msg.html },
    };
    email["htmlBody"] = [{ partId: "html", type: "text/html" }];
  }

  const parts: Record<string, unknown>[] = [];
  for (const a of msg.attachments ?? []) {
    parts.push({ blobId: a.blobId, type: a.type, name: a.name, disposition: "attachment" });
  }
  // Inline images carry a `cid` and `disposition: "inline"`. That pairing is
  // what stops a signature logo showing up as an attachment in the
  // recipient's client -- and it is the same distinction spec 6.5 makes when
  // reading mail, applied on the way out.
  for (const img of msg.inlineImages ?? []) {
    parts.push({
      blobId: img.blobId,
      type: img.type,
      name: img.name,
      cid: img.cid,
      disposition: "inline",
    });
  }
  if (parts.length > 0) email["attachments"] = parts;
  if (msg.inReplyTo) email["inReplyTo"] = [msg.inReplyTo];
  if (msg.references && msg.references.length > 0) email["references"] = msg.references;
  return email;
}

export function buildSendCalls(
  msg: OutgoingMessage,
  opts: { mailAccountId: string; submissionAccountId: string; identityId: string; draftsId: string; sentId: string },
): [string, Record<string, unknown>, string][] {
  const envelope = envelopeFor(msg);
  const email = buildEmail(msg, opts.draftsId);

  return [
    ["Email/set", { accountId: opts.mailAccountId, create: { draft: email } }, "s0"],
    [
      "EmailSubmission/set",
      {
        accountId: opts.submissionAccountId,
        create: {
          sub: {
            emailId: "#draft", // back-reference to the Email/set creation above
            identityId: opts.identityId,
            envelope,
          },
        },
        // Applied only if the submission SUCCEEDS: file into Sent and drop
        // the draft flag. If this were a separate request and it failed, a
        // sent message would still look like an unsent draft.
        onSuccessUpdateEmail: {
          "#sub": {
            [`mailboxIds/${opts.draftsId}`]: null,
            [`mailboxIds/${opts.sentId}`]: true,
            "keywords/$draft": null,
          },
        },
      },
      "s1",
    ],
  ];
}

export async function send(
  client: JmapClient,
  msg: OutgoingMessage,
  opts: { identityId: string; draftsId: string; sentId: string },
): Promise<SendResult> {
  const calls = buildSendCalls(msg, {
    mailAccountId: client.session.mailAccountId,
    submissionAccountId: client.session.submissionAccountId,
    identityId: opts.identityId,
    draftsId: opts.draftsId,
    sentId: opts.sentId,
  });

  const responses = await client.request(calls, USING_SUBMISSION);
  const emailSet = responses[0]?.[1] as
    | { created?: Record<string, { id?: string }>; notCreated?: Record<string, unknown> }
    | undefined;
  const subSet = responses[1]?.[1] as
    | { created?: Record<string, { id?: string }>; notCreated?: Record<string, { type?: string; description?: string }> }
    | undefined;

  const emailId = emailSet?.created?.["draft"]?.id;
  if (!emailId) {
    throw new SendError(`draft was not created: ${describe(emailSet?.notCreated?.["draft"])}`);
  }
  const submissionId = subSet?.created?.["sub"]?.id;
  if (!submissionId) {
    // The draft exists but was never submitted. Say so precisely: the user
    // needs to know the message is sitting in Drafts, not silently lost.
    throw new SendError(
      `message was not sent (a draft remains in Drafts): ${describe(subSet?.notCreated?.["sub"])}`,
    );
  }
  return { emailId, submissionId };
}

function describe(problem: unknown): string {
  if (!problem || typeof problem !== "object") return "unknown error";
  const p = problem as { type?: string; description?: string };
  return p.description ?? p.type ?? "unknown error";
}

/**
 * Saving a draft: `Email/set` create on the first save, `update` after.
 *
 * 🚨 Create-and-destroy IN ONE CALL, never update. A JMAP Email is
 * immutable except for `keywords` and `mailboxIds` (RFC 8621 §4.6). The
 * first version of this issued `Email/set update` on the existing draft to
 * keep Drafts from filling with near-identical copies -- and Fastmail
 * ACKNOWLEDGED the update while keeping the old body. Measured on the live
 * account (checklist row 16, 2026-09-06): create "first body", re-save as
 * "second body", HTTP 200 "saved", Fastmail still holding "first body". Every
 * edit after a draft's first autosave was lost while the UI called it safe.
 *
 * Creating the edited draft and destroying the old one in the SAME
 * `Email/set` keeps exactly one draft, which was the requirement the update
 * was standing in for. The whole Email is rebuilt each time by `buildEmail`,
 * so the saved draft always matches what a send would produce.
 */
export function buildDraftCalls(
  msg: OutgoingMessage,
  opts: { mailAccountId: string; draftsId: string; existingId?: string | null },
): [string, Record<string, unknown>, string][] {
  const email = buildEmail(msg, opts.draftsId);
  if (opts.existingId) {
    return [["Email/set", { accountId: opts.mailAccountId, create: { draft: email }, destroy: [opts.existingId] }, "d0"]];
  }
  return [["Email/set", { accountId: opts.mailAccountId, create: { draft: email } }, "d0"]];
}

export async function saveDraft(
  client: JmapClient,
  msg: OutgoingMessage,
  opts: { draftsId: string; existingId?: string | null },
): Promise<{ emailId: string }> {
  if (!opts.draftsId) throw new SendError("this account has no Drafts mailbox");

  const [res] = await client.request(
    buildDraftCalls(msg, { mailAccountId: client.session.mailAccountId, draftsId: opts.draftsId, existingId: opts.existingId }),
  );
  const args = (res?.[1] ?? {}) as {
    created?: Record<string, { id?: string }>;
    updated?: Record<string, unknown>;
    notCreated?: Record<string, { description?: string; type?: string }>;
    notUpdated?: Record<string, { description?: string; type?: string }>;
  };

  // Only a refused CREATE is a failed save. A refused destroy of the old
  // draft (already gone: another client, an earlier failed run) is not --
  // the edit is safe in the new one, and a stale id must never cost it.
  const failed = Object.values(args.notCreated ?? {})[0];
  if (failed) throw new SendError(`draft not saved: ${failed.description ?? failed.type ?? "unknown"}`);

  const created = args.created?.["draft"]?.id;
  if (!created) throw new SendError("draft not saved: no id came back");
  return { emailId: created };
}

/**
 * Destroys a draft. Used when the message is discarded, when it has been
 * SENT (the send creates its own message, so the saved draft would
 * otherwise linger as a duplicate of mail that already went out), and when
 * the sending account changes -- a draft belongs to the account it was
 * created in, and spec 11 requires discarding the server draft rather than
 * trying to move it.
 */
export async function destroyDraft(client: JmapClient, emailId: string): Promise<void> {
  await client.request([
    ["Email/set", { accountId: client.session.mailAccountId, destroy: [emailId] }, "d0"],
  ]);
}
