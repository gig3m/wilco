import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import {
  storeEmails,
  syncMailboxes,
  setSyncState,
  getSyncState,
  writeBodyText,
  unfetchedIds,
  resetWalk,
  resetBodies,
  removeEmails,
  recordSync,
  lastSyncAt,
  recordDetailsFailure,
  detailsFailureCount,
  clearDetailsFailure,
} from "../src/core/mutations.ts";
import { searchEmails } from "../src/core/queries.ts";
import { tempDbPath } from "./tmpdir.ts";
import { assertNoMembershipDrift } from "./db-assertions.ts";

function db() {
  return openDb(tempDbPath());
}

const base = {
  id: "m1",
  threadId: "t1",
  receivedAt: "2026-01-01T00:00:00Z",
  subject: "Quarterly report",
  preview: "here it is",
  hasAttachment: false,
  keywords: { $seen: true },
  mailboxIds: { "P-F": true },
  from: [{ name: "Ada", email: "ada@example.com" }],
};

test("stores a message with its sender split out", () => {
  const d = db();
  storeEmails(d, "personal", [base]);
  const row = d.prepare("SELECT * FROM emails").get() as any;
  assert.equal(row.from_name, "Ada");
  assert.equal(row.from_email, "ada@example.com");
  assert.equal(row.is_unread, 0, "$seen present means read");
  d.close();
});

test("a first store sets email_mailboxes.received_at/thread_key from the email", () => {
  const d = db();
  storeEmails(d, "personal", [base]);
  const row = d.prepare(
    "SELECT received_at, thread_key FROM email_mailboxes WHERE account = 'personal' AND email_id = 'm1'",
  ).get() as { received_at: string; thread_key: string };
  assert.equal(row.received_at, "2026-01-01T00:00:00Z");
  assert.equal(row.thread_key, "t1");
  assertNoMembershipDrift(d);
  d.close();
});

test("a re-store with changed mailboxes (delete-then-insert) keeps the denormalized columns true", () => {
  const d = db();
  storeEmails(d, "personal", [base]);
  storeEmails(d, "personal", [
    { ...base, receivedAt: "2026-02-01T00:00:00Z", mailboxIds: { Archive: true } },
  ]);
  const row = d.prepare(
    "SELECT mailbox_id, received_at, thread_key FROM email_mailboxes WHERE account = 'personal' AND email_id = 'm1'",
  ).get() as { mailbox_id: string; received_at: string; thread_key: string };
  assert.equal(row.mailbox_id, "Archive");
  assert.equal(row.received_at, "2026-02-01T00:00:00Z");
  assert.equal(row.thread_key, "t1");
  assertNoMembershipDrift(d);
  d.close();
});

test("a message whose thread_id was NULL and is later set keeps thread_key in sync", () => {
  const d = db();
  storeEmails(d, "personal", [{ ...base, threadId: undefined }]);
  let row = d.prepare(
    "SELECT thread_key FROM email_mailboxes WHERE account = 'personal' AND email_id = 'm1'",
  ).get() as { thread_key: string };
  assert.equal(row.thread_key, "m1", "no thread_id means the message is its own thread");
  assertNoMembershipDrift(d);

  storeEmails(d, "personal", [{ ...base, threadId: "t1" }]);
  row = d.prepare(
    "SELECT thread_key FROM email_mailboxes WHERE account = 'personal' AND email_id = 'm1'",
  ).get() as { thread_key: string };
  assert.equal(row.thread_key, "t1");
  assertNoMembershipDrift(d);
  d.close();
});

test("a message with no $seen keyword is unread", () => {
  const d = db();
  storeEmails(d, "personal", [{ ...base, keywords: {} }]);
  const row = d.prepare("SELECT is_unread FROM emails").get() as any;
  assert.equal(row.is_unread, 1);
  d.close();
});

test("keywords are stored whole, so annotations survive", () => {
  const d = db();
  storeEmails(d, "personal", [
    { ...base, keywords: { $seen: true, $notjunk: true, "$x-me-annot-2": true } },
  ]);
  const row = d.prepare("SELECT keywords FROM emails").get() as any;
  const kw = JSON.parse(row.keywords);
  assert.ok(kw["$notjunk"], "Fastmail's own annotations must not be discarded");
  assert.ok(kw["$x-me-annot-2"]);
  d.close();
});

test("A METADATA REFRESH MUST NOT CLOBBER body_text", () => {
  const d = db();
  storeEmails(d, "personal", [base]);
  writeBodyText(d, "personal", "m1", "the quick brown fox");

  // Exactly what an Email/changes update does.
  storeEmails(d, "personal", [{ ...base, subject: "Quarterly report (revised)" }]);

  const row = d.prepare("SELECT subject, body_text FROM emails").get() as any;
  assert.equal(row.subject, "Quarterly report (revised)", "metadata should update");
  assert.equal(row.body_text, "the quick brown fox", "the indexed body must survive");
  assert.equal(searchEmails(d, "brown").rows.length, 1, "and the index with it");
  d.close();
});

test("mailbox membership is replaced, not accumulated", () => {
  const d = db();
  storeEmails(d, "personal", [base]);
  storeEmails(d, "personal", [{ ...base, mailboxIds: { "P-Archive": true } }]);
  const rows = d.prepare("SELECT mailbox_id FROM email_mailboxes").all() as any[];
  assert.deepEqual(rows.map((r) => r.mailbox_id), ["P-Archive"]);
  d.close();
});

test("the same id in two accounts is two messages", () => {
  const d = db();
  storeEmails(d, "personal", [base]);
  storeEmails(d, "work", [base]);
  const { c } = d.prepare("SELECT count(*) AS c FROM emails").get() as any;
  assert.equal(c, 2);
  d.close();
});

test("storing more than 500 messages works", () => {
  const d = db();
  const many = Array.from({ length: 1007 }, (_, i) => ({ ...base, id: `m${i}` }));
  storeEmails(d, "personal", many);
  const { c } = d.prepare("SELECT count(*) AS c FROM emails").get() as any;
  assert.equal(c, many.length);
  d.close();
});

test("mailbox sync is wholesale: absence from the server list deletes", () => {
  const d = db();
  syncMailboxes(d, "personal", [
    { id: "P-F", name: "Inbox", role: "inbox" },
    { id: "P-Old", name: "Retired", role: null },
  ]);
  syncMailboxes(d, "personal", [{ id: "P-F", name: "Inbox", role: "inbox" }]);
  const rows = d.prepare("SELECT id FROM mailboxes WHERE account = 'personal'").all() as any[];
  assert.deepEqual(rows.map((r) => r.id), ["P-F"]);
  d.close();
});

test("mailbox sync does not touch another account's boxes", () => {
  const d = db();
  syncMailboxes(d, "personal", [{ id: "P-F", name: "Inbox", role: "inbox" }]);
  syncMailboxes(d, "work", [{ id: "P-F", name: "Inbox", role: "inbox" }]);
  syncMailboxes(d, "personal", []);
  const { c } = d.prepare("SELECT count(*) AS c FROM mailboxes WHERE account='work'").get() as any;
  assert.equal(c, 1);
  d.close();
});

test("sync state round-trips and is scoped by kind", () => {
  const d = db();
  setSyncState(d, "personal", "email", "J360477");
  setSyncState(d, "personal", "mailbox", "M12");
  assert.equal(getSyncState(d, "personal", "email"), "J360477");
  assert.equal(getSyncState(d, "personal", "mailbox"), "M12");
  assert.equal(getSyncState(d, "work", "email"), null);
  d.close();
});

test("unfetchedIds returns only rows whose body_text is NULL", () => {
  const d = db();
  storeEmails(d, "personal", [
    { ...base, id: "a" },
    { ...base, id: "b" },
    { ...base, id: "c" },
  ]);
  writeBodyText(d, "personal", "a", "text");
  writeBodyText(d, "personal", "b", ""); // fetched, nothing there -- NOT retried
  assert.deepEqual(unfetchedIds(d, "personal", 10), ["c"]);
  d.close();
});

test("resetWalk clears sync_state('walk') so the next walk starts over (finding 3)", () => {
  const d = db();
  setSyncState(d, "personal", "walk", "done");
  setSyncState(d, "work", "walk", "done");
  resetWalk(d, "personal");
  assert.equal(getSyncState(d, "personal", "walk"), null, "the one-way door must actually open");
  assert.equal(getSyncState(d, "work", "walk"), "done", "another account must be untouched");
  d.close();
});

test("resetWalk on an account with no walk state is a harmless no-op", () => {
  const d = db();
  resetWalk(d, "personal"); // never walked at all
  assert.equal(getSyncState(d, "personal", "walk"), null);
  d.close();
});

test("resetBodies puts poisoned ('') rows back in front of the backfill, and reports the count", () => {
  const d = db();
  storeEmails(d, "personal", [
    { ...base, id: "a" },
    { ...base, id: "b" },
    { ...base, id: "c" },
  ]);
  writeBodyText(d, "personal", "a", "a real body"); // fetched for real -- must NOT be touched
  writeBodyText(d, "personal", "b", ""); // poisoned
  writeBodyText(d, "personal", "c", ""); // poisoned
  // "c" belongs to another account with the same id -- scoping must hold.
  storeEmails(d, "work", [{ ...base, id: "c" }]);
  writeBodyText(d, "work", "c", "");

  const changed = resetBodies(d, "personal");
  assert.equal(changed, 2, "must report exactly the rows it changed");

  assert.deepEqual(new Set(unfetchedIds(d, "personal", 10)), new Set(["b", "c"]));
  const a = d.prepare("SELECT body_text FROM emails WHERE account='personal' AND id='a'").get() as any;
  assert.equal(a.body_text, "a real body", "a genuinely fetched body must never be reset");
  const workC = d.prepare("SELECT body_text FROM emails WHERE account='work' AND id='c'").get() as any;
  assert.equal(workC.body_text, "", "another account's poisoned row must be untouched by this scoped call");
  d.close();
});

test("removeEmails deletes the row, its mailbox rows, and its search index entry", () => {
  const d = db();
  storeEmails(d, "personal", [base]);
  writeBodyText(d, "personal", "m1", "the quick brown fox");
  assert.equal(searchEmails(d, "brown").rows.length, 1);

  const n = removeEmails(d, "personal", ["m1"]);
  assert.equal(n, 1);
  assert.equal((d.prepare("SELECT count(*) c FROM emails").get() as any).c, 0);
  assert.equal((d.prepare("SELECT count(*) c FROM email_mailboxes").get() as any).c, 0,
    "junction rows must go too, or they accumulate forever");
  assert.equal(searchEmails(d, "brown").rows.length, 0,
    "a deleted message must leave the search index");

  // The external-content FTS5 index does not fail loudly when it diverges.
  d.exec("INSERT INTO emails_fts(emails_fts) VALUES('integrity-check')");
  d.close();
});

test("removeEmails is account-scoped", () => {
  const d = db();
  storeEmails(d, "personal", [base]);
  storeEmails(d, "work", [base]);          // same id, different account
  removeEmails(d, "personal", ["m1"]);
  const rows = d.prepare("SELECT account FROM emails").all() as any[];
  assert.deepEqual(rows.map((r) => r.account), ["work"],
    "every Fastmail inbox shares the id P-F; an unscoped delete destroys another account's mail");
  d.close();
});

test("removeEmails handles more ids than the SQL variable limit", () => {
  const d = db();
  // Comfortably past any plausible SQLITE_MAX_VARIABLE_NUMBER, which
  // removeEmails never approaches: it runs one statement per id.
  const many = Array.from({ length: 1007 }, (_, i) => ({ ...base, id: `m${i}` }));
  storeEmails(d, "personal", many);
  assert.equal(removeEmails(d, "personal", many.map((m) => m.id)), many.length);
  assert.equal((d.prepare("SELECT count(*) c FROM emails").get() as any).c, 0);
  d.close();
});

test("removing an id that is not present is not an error", () => {
  const d = db();
  assert.equal(removeEmails(d, "personal", ["ghost"]), 0);
  d.close();
});

test("recordSync round-trips per account", () => {
  const d = db();
  assert.equal(lastSyncAt(d, "personal"), null);
  recordSync(d, "personal", 1_700_000_000_000);
  assert.equal(lastSyncAt(d, "personal"), 1_700_000_000_000);
  assert.equal(lastSyncAt(d, "work"), null, "must be per account");
  d.close();
});

test("recordDetailsFailure increments per account and starts at zero", () => {
  const d = db();
  assert.equal(detailsFailureCount(d, "personal"), 0);
  assert.equal(recordDetailsFailure(d, "personal"), 1);
  assert.equal(recordDetailsFailure(d, "personal"), 2);
  assert.equal(detailsFailureCount(d, "personal"), 2);
  assert.equal(detailsFailureCount(d, "work"), 0, "must be per account");
  d.close();
});

test("clearDetailsFailure resets the streak after a successful pass", () => {
  // The bug this guards: one transient failure used to leave a permanent
  // non-zero counter forever, indistinguishable from an account failing
  // every single pass. A successful backfillDetails pass must be able to
  // clear it back to zero.
  const d = db();
  recordDetailsFailure(d, "personal");
  recordDetailsFailure(d, "personal");
  assert.equal(detailsFailureCount(d, "personal"), 2);
  clearDetailsFailure(d, "personal");
  assert.equal(detailsFailureCount(d, "personal"), 0);
  // Clearing an account with no recorded failures is a no-op, not an error.
  clearDetailsFailure(d, "work");
  assert.equal(detailsFailureCount(d, "work"), 0);
  d.close();
});
