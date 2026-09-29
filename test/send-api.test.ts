import { test } from "node:test";
import assert from "node:assert/strict";
import { appendSignature, parseAttachments, safeAttachmentName } from "../src/server/send-api.ts";

// The send route's own validation. The route itself needs a session, a
// database and a live JMAP client to exercise end to end; these two
// functions are where its actual decisions live, and they are pure.

test("an attachment must carry the ACCOUNT it was uploaded into", () => {
  // Blob ids are account-scoped (spec 11). Without the account travelling
  // alongside the blob, a send from the wrong account fails at JMAP with an
  // opaque error instead of naming the file here.
  assert.equal(parseAttachments([{ blobId: "B1", name: "a.pdf", type: "application/pdf", size: 1 }]), null);
  assert.deepEqual(
    parseAttachments([{ blobId: "B1", name: "a.pdf", type: "application/pdf", size: 1, account: "work" }]),
    [{ blobId: "B1", name: "a.pdf", type: "application/pdf", size: 1, account: "work" }],
  );
});

test("a missing or empty attachment list is fine, a malformed one is refused", () => {
  assert.deepEqual(parseAttachments(undefined), []);
  assert.deepEqual(parseAttachments(null), []);
  assert.deepEqual(parseAttachments([]), []);
  assert.equal(parseAttachments("nope"), null);
  assert.equal(parseAttachments([{ blobId: 1, name: "a", type: "t", size: 1, account: "w" }]), null);
  assert.equal(parseAttachments([{ blobId: "B", name: "a", type: "t", size: "1", account: "w" }]), null);
});

test("safeAttachmentName strips paths, control characters and leading dots", () => {
  // It reaches the recipient's mail client as a MIME parameter, and it is
  // echoed into a response header on the way -- where a raw CR/LF would be
  // response splitting.
  assert.equal(safeAttachmentName("../../etc/passwd"), "passwd");
  assert.equal(safeAttachmentName("C:\\Windows\\evil.exe"), "evil.exe");
  assert.equal(safeAttachmentName(".hidden"), "hidden");
  assert.equal(safeAttachmentName(".."), "attachment");
  assert.equal(safeAttachmentName(undefined), "attachment");
  assert.equal(safeAttachmentName("a\r\nSet-Cookie: x=1"), "aSet-Cookie: x=1");
  assert.equal(safeAttachmentName("x".repeat(400)).length, 120);
});

test("the filename is percent-decoded, because a header cannot carry raw UTF-8", () => {
  assert.equal(safeAttachmentName("Rapport%20Q3%20%E2%82%AC.pdf"), "Rapport Q3 €.pdf");
  // Malformed encoding must not throw -- sanitise what was given instead.
  assert.doesNotThrow(() => safeAttachmentName("%E0%A4%A"));
  assert.equal(safeAttachmentName("%E0%A4%A"), "%E0%A4%A");
});

test("a header array (a duplicated header) takes the first value", () => {
  assert.equal(safeAttachmentName(["one.pdf", "two.pdf"]), "one.pdf");
});

// -- Signatures (milestone 8, spec 11) ------------------------------------

test("🚨 the signature is joined BYTE FOR BYTE -- nothing trims '-- '", () => {
  // RFC 3676's separator is `-- ` WITH a trailing space, and Fastmail
  // round-trips the value exactly. Trimming it -- which every instinct says
  // to do -- silently breaks the convention every mail client uses to fold
  // a signature away.
  const sig = "-- \nRobin\nLumber Co";
  const out = appendSignature("Body text.", sig);
  assert.equal(out, "Body text.\n\n-- \nRobin\nLumber Co");
  assert.ok(out.includes("-- \n"), "the trailing space survives");
});

test("appendSignature never INVENTS a separator", () => {
  // Adding `-- ` ourselves would give a doubled separator to everyone who
  // already typed one into their signature.
  assert.equal(appendSignature("Body.", "Robin"), "Body.\n\nRobin");
});

test("an empty signature, or an empty body, joins without a stray blank line", () => {
  assert.equal(appendSignature("Body.", ""), "Body.");
  assert.equal(appendSignature("", "Robin"), "Robin");
  assert.equal(appendSignature("", ""), "");
});

test("a non-string body is treated as empty rather than stringified", () => {
  // The route validates `text` separately; this must not turn `undefined`
  // into the literal "undefined" at the top of someone's mail.
  assert.equal(appendSignature(undefined, "Robin"), "Robin");
  assert.equal(appendSignature(null, "Robin"), "Robin");
});
