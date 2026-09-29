import { test } from "node:test";
import assert from "node:assert/strict";
import { attributionLine, buildPrefill, forwardSubject, replySubject, quoteBody, type SourceMessage } from "../src/core/reply.ts";

const MINE = new Set(["robin@halden.example", "k@halden.example"]);

function src(over: Partial<SourceMessage> = {}): SourceMessage {
  return {
    subject: "Lunch",
    from: [{ name: "Dana", email: "dana@example.com" }],
    to: [{ email: "robin@halden.example" }, { name: "Sam", email: "sam@example.com" }],
    cc: [{ email: "pat@example.com" }],
    replyTo: [],
    hasHtml: false,
    messageId: ["<abc@example.com>"],
    references: ["<root@example.com>"],
    sentAt: "2026-09-01T10:00:00Z",
    bodyText: "hello\n\nthere",
    ...over,
  } as SourceMessage;
}

test("REPLY-ALL DOES NOT CC YOU — the classic self-duplication bug", () => {
  const p = buildPrefill(src(), "reply-all", MINE);
  const all = [...p.to, ...p.cc].map((a) => a.email.toLowerCase());
  assert.ok(!all.includes("robin@halden.example"), "must not reply to yourself");
  assert.ok(!all.includes("k@halden.example"), "must exclude every alias, not just the primary");
});

test("reply-all keeps the other original recipients — that is the whole point", () => {
  const p = buildPrefill(src(), "reply-all", MINE);
  assert.deepEqual(p.to.map((a) => a.email), ["dana@example.com"]);
  assert.deepEqual(p.cc.map((a) => a.email).sort(), ["pat@example.com", "sam@example.com"]);
});

test("plain reply goes ONLY to the sender", () => {
  const p = buildPrefill(src(), "reply", MINE);
  assert.deepEqual(p.to.map((a) => a.email), ["dana@example.com"]);
  assert.deepEqual(p.cc, [], "a plain reply must not CC the thread");
});

test("Reply-To beats From — mailing lists and no-reply senders depend on it", () => {
  const p = buildPrefill(src({ replyTo: [{ email: "list@example.com" }] }), "reply", MINE);
  assert.deepEqual(p.to.map((a) => a.email), ["list@example.com"]);
});

test("an address in both To and Cc is not duplicated", () => {
  const p = buildPrefill(
    src({ to: [{ email: "Sam@Example.com" }], cc: [{ email: "sam@example.com" }] }),
    "reply-all",
    MINE,
  );
  assert.equal(p.cc.filter((a) => a.email.toLowerCase() === "sam@example.com").length, 1);
});

test("a FORWARD prefills no recipients at all", () => {
  const p = buildPrefill(src(), "forward", MINE);
  assert.deepEqual(p.to, [], "forwarding must never inherit a recipient");
  assert.deepEqual(p.cc, []);
});

test("a forward starts a NEW thread; a reply continues the old one", () => {
  const fwd = buildPrefill(src(), "forward", MINE);
  assert.equal(fwd.inReplyTo, null, "a forward buried in the old thread is wrong");
  assert.equal(fwd.references, null);

  const rep = buildPrefill(src(), "reply", MINE);
  assert.equal(rep.inReplyTo, "<abc@example.com>");
  assert.deepEqual(rep.references, ["<root@example.com>", "<abc@example.com>"], "references must APPEND, not replace");
});

test("subjects collapse rather than stacking prefixes", () => {
  assert.equal(replySubject("Lunch"), "Re: Lunch");
  assert.equal(replySubject("Re: Lunch"), "Re: Lunch");
  assert.equal(replySubject("RE: Lunch"), "Re: Lunch");
  assert.equal(replySubject("Re[2]: Lunch"), "Re: Lunch");
  assert.equal(forwardSubject("Lunch"), "Fwd: Lunch");
  assert.equal(forwardSubject("Fwd: Lunch"), "Fwd: Lunch");
  assert.equal(forwardSubject("Fw: Lunch"), "Fwd: Lunch");
});

test("the quote is attributed and prefixed the way every client expects", () => {
  const q = quoteBody(src());
  assert.match(q, /Dana <dana@example\.com> wrote:/);
  assert.match(q, /^> hello$/m);
  assert.match(q, /^>$/m, "blank lines stay quoted, or the quote breaks apart");
});

test("a message with no body still quotes without throwing", () => {
  const q = quoteBody(src({ bodyText: null }));
  assert.match(q, /wrote:/);
});

test("a reply to a message with no Message-ID has no threading headers, not a broken one", () => {
  const p = buildPrefill(src({ messageId: null, references: null }), "reply", MINE);
  assert.equal(p.inReplyTo, null);
  assert.equal(p.references, null);
});

test("row 12: the prefill says whether the source was HTML, so the reply can go out as HTML", () => {
  assert.equal(buildPrefill(src({ hasHtml: true }), "reply", new Set()).sourceHasHtml, true);
  assert.equal(buildPrefill(src({ hasHtml: false }), "reply-all", new Set()).sourceHasHtml, false);
  assert.equal(buildPrefill(src({ hasHtml: true }), "forward", new Set()).sourceHasHtml, true);
});

test("row 14: a forward carries the original's attachments; a reply does not", () => {
  const atts = [{ blobId: "B1", name: "report.pdf", type: "application/pdf", size: 2048 }];
  assert.deepEqual(buildPrefill(src({ attachments: atts }), "forward", MINE).attachments, atts);
  assert.deepEqual(buildPrefill(src({ attachments: atts }), "reply", MINE).attachments, []);
  assert.deepEqual(buildPrefill(src({ attachments: atts }), "reply-all", MINE).attachments, []);
});

test("the prefill carries the attribution line the server will put above the quote", () => {
  assert.equal(attributionLine(src()), "On 2026-09-01T10:00:00Z, Dana <dana@example.com> wrote:");
  assert.equal(buildPrefill(src(), "reply", MINE).attribution, "On 2026-09-01T10:00:00Z, Dana <dana@example.com> wrote:");
  assert.equal(attributionLine({ from: [], sentAt: null }), "someone wrote:");
});

test("a forward's attribution is the forwarded-message header block, not 'wrote:'", () => {
  const p = buildPrefill(src(), "forward", MINE);
  assert.match(p.attribution, /^---------- Forwarded message ----------\nFrom: Dana <dana@example.com>\nDate: 2026-09-01T10:00:00Z\nSubject: Lunch\nTo: /);
  assert.ok(p.quoted.includes(p.attribution), "the plain-text forward body carries the same header");
});
