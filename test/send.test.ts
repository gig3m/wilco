import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDraftCalls,
  buildSendCalls,
  checkAttachmentSizes,
  envelopeFor,
  MAX_ATTACHMENT_BYTES,
  saveDraft,
  SendError,
  type OutgoingMessage,
} from "../src/core/send.ts";
import { JmapClient } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";

/** A client whose single Email/set returns exactly the args given. */
function fakeClient(args: Record<string, unknown>): JmapClient {
  return new JmapClient(resolveSession("personal", personalSession), "t", async () =>
    new Response(JSON.stringify({ methodResponses: [["Email/set", args, "d0"]] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const OPTS = {
  mailAccountId: "u123",
  submissionAccountId: "u123",
  identityId: "ID1",
  draftsId: "DRAFTS",
  sentId: "SENT",
};

function msg(over: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { name: "Robin", email: "robin@halden.example" },
    to: [{ email: "a@example.com" }],
    subject: "Hi",
    text: "body",
    ...over,
  };
}

test("bcc reaches the envelope — a bcc'd person must actually receive the mail", () => {
  const env = envelopeFor(msg({ bcc: [{ email: "hidden@example.com" }] }));
  assert.deepEqual(
    env.rcptTo.map((r) => r.email).sort(),
    ["a@example.com", "hidden@example.com"],
    "bcc dropped from rcptTo would silently not deliver",
  );
});

test("bcc is NOT leaked to other recipients via a visible header", () => {
  const calls = buildSendCalls(msg({ bcc: [{ email: "hidden@example.com" }] }), OPTS);
  const email = (calls[0]![1] as { create: { draft: Record<string, unknown> } }).create.draft;
  // JMAP strips bcc on submission, but it must be set as a real address
  // field (not folded into `to`), or the server cannot strip what it never saw.
  assert.deepEqual(email["bcc"], [{ name: null, email: "hidden@example.com" }]);
  assert.deepEqual(email["to"], [{ name: null, email: "a@example.com" }]);
});

test("a duplicated address receives ONE copy", () => {
  const env = envelopeFor(
    msg({ to: [{ email: "a@example.com" }], cc: [{ email: "A@Example.com" }] }),
  );
  assert.equal(env.rcptTo.length, 1, "same address in To and Cc must not be sent twice");
});

test("a message with no recipients is refused before any JMAP call", () => {
  assert.throws(() => envelopeFor(msg({ to: [] })), SendError);
  assert.throws(() => envelopeFor(msg({ to: [{ email: "   " }] })), SendError);
});

test("the envelope's mailFrom is the message's from — never caller-supplied", () => {
  const env = envelopeFor(msg());
  assert.deepEqual(env.mailFrom, { email: "robin@halden.example" });
});

test("draft is created in Drafts and filed to Sent only ON SUCCESS", () => {
  const calls = buildSendCalls(msg(), OPTS);
  const email = (calls[0]![1] as { create: { draft: Record<string, unknown> } }).create.draft;
  assert.deepEqual(email["mailboxIds"], { DRAFTS: true });
  assert.deepEqual(email["keywords"], { $draft: true, $seen: true });

  const sub = calls[1]![1] as { onSuccessUpdateEmail: Record<string, Record<string, unknown>> };
  const patch = sub.onSuccessUpdateEmail["#sub"]!;
  assert.equal(patch["mailboxIds/DRAFTS"], null, "must leave Drafts");
  assert.equal(patch["mailboxIds/SENT"], true, "must land in Sent");
  assert.equal(patch["keywords/$draft"], null, "must stop being a draft");
});

test("submission back-references the draft, so both happen in one request", () => {
  const calls = buildSendCalls(msg(), OPTS);
  assert.equal(calls.length, 2, "two calls, one request -- never two round trips");
  const sub = (calls[1]![1] as { create: { sub: Record<string, unknown> } }).create.sub;
  assert.equal(sub["emailId"], "#draft", "a literal id here would be a crash-between-calls bug");
  assert.equal(sub["identityId"], "ID1");
});

test("a reply carries threading headers; a new message does not", () => {
  const plain = (buildSendCalls(msg(), OPTS)[0]![1] as { create: { draft: Record<string, unknown> } }).create.draft;
  assert.equal(plain["inReplyTo"], undefined);
  assert.equal(plain["references"], undefined);

  const reply = (
    buildSendCalls(msg({ inReplyTo: "<x@y>", references: ["<w@y>", "<x@y>"] }), OPTS)[0]![1] as {
      create: { draft: Record<string, unknown> };
    }
  ).create.draft;
  assert.deepEqual(reply["inReplyTo"], ["<x@y>"], "without this a reply starts a new thread");
  assert.deepEqual(reply["references"], ["<w@y>", "<x@y>"]);
});

test("the body is plain text only — Wilco never composes HTML it refuses to render", () => {
  const email = (buildSendCalls(msg({ text: "<b>hi</b>" }), OPTS)[0]![1] as {
    create: { draft: Record<string, unknown> };
  }).create.draft;
  assert.deepEqual(email["textBody"], [{ partId: "body", type: "text/plain" }]);
  assert.equal(email["htmlBody"], undefined, "an htmlBody here would contradict spec 3.1");
  // The angle brackets stay literal text -- they are not markup here.
  assert.deepEqual(email["bodyValues"], { body: { value: "<b>hi</b>" } });
});

test("empty cc/bcc are null, not empty arrays", () => {
  // Fastmail rejects `cc: []` on some paths; null is the JMAP way to say
  // "this header is absent".
  const email = (buildSendCalls(msg(), OPTS)[0]![1] as { create: { draft: Record<string, unknown> } }).create.draft;
  assert.equal(email["cc"], null);
  assert.equal(email["bcc"], null);
});

// -- Attachments on send (milestone 7, spec 4.6 / 11) ---------------------

test("attachments become JMAP attachment parts, not a hand-built multipart", () => {
  // JMAP builds the MIME structure from textBody + attachments. Composing
  // the multipart nesting by hand is what spec 11 warns about getting wrong.
  const calls = buildSendCalls(
    {
      from: { email: "me@example.test" },
      to: [{ email: "you@example.test" }],
      subject: "s",
      text: "body",
      attachments: [{ blobId: "B1", name: "Invoice.pdf", type: "application/pdf", size: 10 }],
    },
    { mailAccountId: "m", submissionAccountId: "s", identityId: "i", draftsId: "d", sentId: "sent" },
  );
  const email = (calls[0]![1] as any).create.draft;
  assert.deepEqual(email.attachments, [
    { blobId: "B1", type: "application/pdf", name: "Invoice.pdf", disposition: "attachment" },
  ]);
  assert.ok(email.bodyStructure === undefined, "no hand-built structure");
  assert.deepEqual(email.textBody, [{ partId: "body", type: "text/plain" }], "the text part is untouched");
});

test("a message with no attachments carries no attachments key at all", () => {
  const calls = buildSendCalls(
    { from: { email: "me@example.test" }, to: [{ email: "you@example.test" }], subject: "s", text: "b" },
    { mailAccountId: "m", submissionAccountId: "s", identityId: "i", draftsId: "d", sentId: "sent" },
  );
  assert.equal((calls[0]![1] as any).create.draft.attachments, undefined);
});

test("🚨 the 25MB cap is refused UP FRONT and BY NAME", () => {
  // maxSizeUpload advertises 238MB, but most receiving servers refuse over
  // ~25MB. Accepting the larger number means the upload completes, the send
  // looks fine, and the failure arrives at the far end after the user has
  // moved on.
  const big = { blobId: "B1", name: "video.mov", type: "video/quicktime", size: MAX_ATTACHMENT_BYTES + 1 };
  const err = checkAttachmentSizes([big]);
  assert.match(err!, /video\.mov/, "the offender is named");
  assert.match(err!, /25\.0 MB/);
});

test("the cap is on the TOTAL too -- ten 3MB files is a 30MB message", () => {
  const files = Array.from({ length: 10 }, (_, i) => ({
    blobId: `B${i}`,
    name: `f${i}.bin`,
    type: "application/octet-stream",
    size: 3 * 1024 * 1024,
  }));
  assert.match(checkAttachmentSizes(files)!, /total/);
  assert.equal(checkAttachmentSizes(files.slice(0, 8)), null, "24MB is fine");
});

// -- Drafts (milestone 7) --------------------------------------------------

const draftMsg: OutgoingMessage = {
  from: { email: "me@example.test" },
  to: [{ email: "you@example.test" }],
  subject: "half written",
  text: "so far",
};

test("🚨 EVERY SAVE AFTER THE FIRST CREATES A NEW DRAFT AND DESTROYS THE OLD ONE, IN ONE CALL", () => {
  // 🚨 The defect this pins (checklist row 16, 2026-09-06): the second save
  // used `Email/set update` on the existing draft. A JMAP Email is
  // immutable except for keywords and mailboxIds; Fastmail ACKNOWLEDGES the
  // update and keeps the old body. Measured on the live account: create
  // "first body", update to "second body", HTTP 200 "saved", Fastmail still
  // holds "first body". So every edit after a draft's first autosave was
  // lost while the UI said it was safe -- every draft, not only resumed ones.
  //
  // The original design chose update over create-and-destroy so Drafts
  // would not fill with near-identical copies. Doing BOTH in one Email/set
  // call keeps exactly one draft, which was the actual requirement.
  const create = buildDraftCalls(draftMsg, { mailAccountId: "m", draftsId: "d" });
  assert.equal(create.length, 1);
  assert.ok((create[0]![1] as any).create.draft, "create on the first save");
  assert.equal((create[0]![1] as any).update, undefined);
  assert.equal((create[0]![1] as any).destroy, undefined);

  const again = buildDraftCalls(draftMsg, { mailAccountId: "m", draftsId: "d", existingId: "E1" });
  assert.equal(again.length, 1, "one call, so there is never a moment with zero drafts or two");
  const args = again[0]![1] as any;
  assert.equal(args.update, undefined, "an Email's body cannot be updated in place; Fastmail acknowledges and ignores it");
  assert.ok(args.create.draft, "the edited draft is a NEW Email");
  assert.deepEqual(args.destroy, ["E1"], "and the old one goes in the same call");
});

test("a re-save reports the NEW draft's id, so the next save replaces that one", async () => {
  const client = fakeClient({ created: { draft: { id: "E2" } }, destroyed: ["E1"] });
  const saved = await saveDraft(client, draftMsg, { draftsId: "d", existingId: "E1" });
  assert.equal(saved.emailId, "E2");
});

test("a re-save whose OLD draft was already gone still saves the new one", async () => {
  // Destroyed elsewhere (another client, a previous failed run). The edit
  // must not be lost over a stale id.
  const client = fakeClient({ created: { draft: { id: "E2" } }, notDestroyed: { E1: { type: "notFound" } } });
  const saved = await saveDraft(client, draftMsg, { draftsId: "d", existingId: "E1" });
  assert.equal(saved.emailId, "E2");
});

test("🚨 a draft is built by the SAME builder as a send", () => {
  // A draft that differed from what is eventually sent -- a dropped Bcc, an
  // attachment listed one way here and another there -- is a bug the user
  // cannot see until the mail arrives wrong.
  const rich: OutgoingMessage = {
    ...draftMsg,
    cc: [{ email: "cc@example.test" }],
    bcc: [{ email: "bcc@example.test" }],
    attachments: [{ blobId: "B1", name: "a.pdf", type: "application/pdf", size: 5 }],
    inReplyTo: "<parent@example.test>",
    references: ["<root@example.test>"],
  };
  const draftEmail = (buildDraftCalls(rich, { mailAccountId: "m", draftsId: "d" })[0]![1] as any).create.draft;
  const sendEmail = (
    buildSendCalls(rich, { mailAccountId: "m", submissionAccountId: "s", identityId: "i", draftsId: "d", sentId: "sent" })[0]![1] as any
  ).create.draft;
  assert.deepEqual(draftEmail, sendEmail);
});

test("a draft lands in Drafts and carries $draft", () => {
  const email = (buildDraftCalls(draftMsg, { mailAccountId: "m", draftsId: "DRAFTS" })[0]![1] as any).create.draft;
  assert.deepEqual(email.mailboxIds, { DRAFTS: true });
  assert.equal(email.keywords.$draft, true);
});

test("a draft needs no recipient -- that is the normal state of an unfinished message", () => {
  const email = (
    buildDraftCalls({ from: { email: "me@example.test" }, to: [], subject: "", text: "thinking" }, { mailAccountId: "m", draftsId: "d" })[0]![1] as any
  ).create.draft;
  // addrList maps an empty list to null, which is JMAP's "no recipients"
  // -- an empty ARRAY would be a claim that the field was set to nothing.
  assert.equal(email.to, null);
  // envelopeFor, which DOES require one, is only reached on send.
  assert.throws(() => envelopeFor({ from: { email: "me@example.test" }, to: [], subject: "", text: "" }), SendError);
});

test("a re-save whose create was refused is NOT reported as saved", async () => {
  // The old draft must not have been destroyed either: a refused create
  // with a destroyed old draft would be the one way to lose everything.
  const client = fakeClient({ notCreated: { draft: { description: "over quota" } } });
  await assert.rejects(
    () => saveDraft(client, draftMsg, { draftsId: "d", existingId: "E1" }),
    (err: Error) => err instanceof SendError && /over quota/.test(err.message),
  );
});

test("a refused create surfaces the server's own reason", async () => {
  const client = fakeClient({ notCreated: { draft: { description: "over quota" } } });
  await assert.rejects(
    () => saveDraft(client, draftMsg, { draftsId: "d" }),
    (err: Error) => err instanceof SendError && /over quota/.test(err.message),
  );
});

test("saving with no Drafts mailbox fails loudly rather than writing nowhere", async () => {
  await assert.rejects(() => saveDraft(fakeClient({}), draftMsg, { draftsId: "" }), SendError);
});

// -- HTML signatures (milestone 8, owner ruling 2026-09-05) ---------------

test("🚨 an HTML half makes the message multipart/alternative, with BOTH bodies set", () => {
  const calls = buildSendCalls(
    {
      from: { email: "me@example.test" },
      to: [{ email: "you@example.test" }],
      subject: "s",
      text: "Body\n\n-- \nRobin",
      html: "<div>Body</div><div><p>Robin</p></div>",
    },
    OPTS,
  );
  const email = (calls[0]![1] as any).create.draft;
  assert.deepEqual(email.textBody, [{ partId: "body", type: "text/plain" }]);
  assert.deepEqual(email.htmlBody, [{ partId: "html", type: "text/html" }]);
  assert.equal(email.bodyValues.body.value, "Body\n\n-- \nRobin");
  assert.equal(email.bodyValues.html.value, "<div>Body</div><div><p>Robin</p></div>");
});

test("with no HTML half the message stays plain text/plain only", () => {
  const email = (
    buildSendCalls({ from: { email: "me@example.test" }, to: [{ email: "you@example.test" }], subject: "s", text: "b" }, OPTS)[0]![1] as any
  ).create.draft;
  assert.equal(email.htmlBody, undefined);
  assert.equal(email.bodyValues.html, undefined);
});

test("🚨 a signature image is sent INLINE with a cid, not as an attachment", () => {
  // The cid + disposition:inline pairing is what stops a signature logo
  // showing up in the recipient's attachment list -- the same distinction
  // spec 6.5 makes when READING mail, applied on the way out.
  const email = (
    buildSendCalls(
      {
        from: { email: "me@example.test" },
        to: [{ email: "you@example.test" }],
        subject: "s",
        text: "b",
        html: '<img src="cid:sig0@wilco">',
        inlineImages: [{ blobId: "B1", cid: "sig0@wilco", type: "image/png", name: "signature-1.png" }],
      },
      OPTS,
    )[0]![1] as any
  ).create.draft;
  assert.deepEqual(email.attachments, [
    { blobId: "B1", type: "image/png", name: "signature-1.png", cid: "sig0@wilco", disposition: "inline" },
  ]);
});

test("real attachments and signature images coexist, each with its own disposition", () => {
  const email = (
    buildSendCalls(
      {
        from: { email: "me@example.test" },
        to: [{ email: "you@example.test" }],
        subject: "s",
        text: "b",
        html: "<p>x</p>",
        attachments: [{ blobId: "A1", name: "Invoice.pdf", type: "application/pdf", size: 9 }],
        inlineImages: [{ blobId: "B1", cid: "sig0@wilco", type: "image/png", name: "signature-1.png" }],
      },
      OPTS,
    )[0]![1] as any
  ).create.draft;
  assert.equal(email.attachments.length, 2);
  assert.equal(email.attachments[0].disposition, "attachment");
  assert.equal(email.attachments[0].cid, undefined, "a real attachment carries no cid");
  assert.equal(email.attachments[1].disposition, "inline");
  assert.equal(email.attachments[1].cid, "sig0@wilco");
});

test("a draft's custom X-Wilco headers ride on the create as header:<Name>:asText, nothing else does", () => {
  const email = (
    buildSendCalls(
      { from: { email: "me@example.test" }, to: [{ email: "you@example.test" }], subject: "s", text: "b",
        headers: { "X-Wilco-Quote-Source": "test-a/M1", "X-Wilco-Signature-Placement": "above", "Reply-To": "evil@x" } },
      OPTS,
    )[0]![1] as any
  ).create.draft;
  assert.equal(email["header:X-Wilco-Quote-Source:asText"], "test-a/M1");
  assert.equal(email["header:X-Wilco-Signature-Placement:asText"], "above");
  assert.equal(email["header:Reply-To:asText"], undefined, "only X-Wilco- headers are accepted");
});
