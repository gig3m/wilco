import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.ts";
import { AddressBook, loadBook, rankContacts } from "../src/core/addressbook.ts";
import { tempDbPath } from "./tmpdir.ts";

function db() {
  return openDb(tempDbPath());
}

function insert(
  d: ReturnType<typeof db>,
  o: { account?: string; id?: string; receivedAt?: string; fromEmail?: string; fromName?: string },
) {
  d.prepare(
    `INSERT INTO emails (account, id, received_at, subject, from_name, from_email, preview, body_text, is_unread, is_flagged)
     VALUES (?, ?, ?, '', ?, ?, '', '', 0, 0)`,
  ).run(o.account ?? "personal", o.id ?? "m1", o.receivedAt ?? "2026-01-01T00:00:00Z", o.fromName ?? "", o.fromEmail ?? "a@b.com");
}

function addRecipient(d: ReturnType<typeof db>, o: { account: string; emailId: string; kind: string; email: string; name?: string }) {
  d.prepare(`INSERT INTO email_recipients (account, email_id, kind, email, name) VALUES (?, ?, ?, ?, ?)`).run(
    o.account,
    o.emailId,
    o.kind,
    o.email,
    o.name ?? "",
  );
}

function mailbox(d: ReturnType<typeof db>, o: { account: string; id: string; role: string | null }) {
  d.prepare(`INSERT INTO mailboxes (account, id, name, role, sort_order) VALUES (?, ?, ?, ?, 0)`).run(o.account, o.id, o.id, o.role);
}

function addToMailbox(d: ReturnType<typeof db>, o: { account: string; emailId: string; mailboxId: string }) {
  d.prepare(`INSERT INTO email_mailboxes (account, email_id, mailbox_id) VALUES (?, ?, ?)`).run(o.account, o.emailId, o.mailboxId);
}

/** Counts `db.prepare(...)` calls, the pattern list.test.ts uses to pin a
 *  query shape deterministically rather than by wall clock. Here it is what
 *  proves the cache is a cache: a served lookup must touch the database
 *  ZERO times. */
function counting(d: DatabaseSync): { db: DatabaseSync; calls: () => number } {
  let calls = 0;
  const real = d.prepare.bind(d);
  const proxy = new Proxy(d, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          calls++;
          return real(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxy as DatabaseSync, calls: () => calls };
}

const NOW = () => Date.parse("2026-09-01T00:00:00Z");

/** dana x3 in personal (recent, named), oldtimer x1 two years ago, sam as a
 *  recipient, the owner's own address as a cc, and danielle in `work`. */
function fixture() {
  const d = db();
  insert(d, { id: "c1", fromEmail: "dana@example.com", receivedAt: "2026-08-01T00:00:00Z" });
  insert(d, { id: "c2", fromEmail: "dana@example.com", receivedAt: "2026-08-02T00:00:00Z" });
  insert(d, { id: "c3", fromEmail: "dana@example.com", fromName: "Dana Ruiz", receivedAt: "2026-08-03T00:00:00Z" });
  insert(d, { id: "c4", fromEmail: "oldtimer@example.com", receivedAt: "2024-01-01T00:00:00Z" });
  insert(d, { id: "c5", fromEmail: "robin@example.com", receivedAt: "2026-08-20T00:00:00Z" });
  addRecipient(d, { account: "personal", emailId: "c5", kind: "to", email: "sam@example.com" });
  addRecipient(d, { account: "personal", emailId: "c5", kind: "cc", email: "robin@example.com" });
  insert(d, { account: "work", id: "c6", fromEmail: "danielle@work.example", receivedAt: "2026-08-25T00:00:00Z" });
  return d;
}

// ---------------------------------------------------------------------------
// The ranking. One implementation, in JS: the book is held in memory, so a
// second copy of these rules in SQL is a second place for them to drift.
// ---------------------------------------------------------------------------

test("suggestions match email OR name by substring, ranked recent-first then by frequency", () => {
  const d = fixture();
  const book = loadBook(d);
  assert.deepEqual(
    rankContacts(book, "dana", { exclude: new Set(), now: NOW }).map((c) => [c.name, c.email]),
    [["Dana Ruiz", "dana@example.com"]],
  );
  assert.equal(rankContacts(book, "ruiz", { exclude: new Set(), now: NOW })[0]?.email, "dana@example.com", "people search by surname");
  d.close();
});

test("a recent once-only correspondent outranks a frequent one not seen in a year; recipients count too", () => {
  const d = fixture();
  for (const [i, when] of ["2024-02-01", "2024-03-01", "2024-04-01"].entries()) {
    insert(d, { id: `c7${i}`, fromEmail: "oldtimer@example.com", receivedAt: `${when}T00:00:00Z` });
  }
  const got = rankContacts(loadBook(d), "example.com", { exclude: new Set(["robin@example.com"]), now: NOW });
  assert.deepEqual(
    got.map((c) => c.email),
    ["dana@example.com", "sam@example.com", "oldtimer@example.com"],
    "recent (dana x3, sam x1) before stale (oldtimer x4); the owner's own address excluded",
  );
  d.close();
});

test("fewer than two characters yields nothing, LIKE wildcards are literal, and the list is capped at 8", () => {
  const d = fixture();
  assert.deepEqual(rankContacts(loadBook(d), "d", { exclude: new Set(), now: NOW }), []);
  assert.deepEqual(rankContacts(loadBook(d), "%%", { exclude: new Set(), now: NOW }), [], "a wildcard is a character, not a match-all");
  for (let i = 0; i < 12; i++) insert(d, { id: `bulk${i}`, fromEmail: `person${i}@bulk.example`, receivedAt: "2026-08-10T00:00:00Z" });
  assert.equal(rankContacts(loadBook(d), "bulk.example", { exclude: new Set(), now: NOW }).length, 8);
  d.close();
});

test("the book is unified: a contact only another account knows is offered, and counts POOL across accounts", () => {
  const d = fixture();
  insert(d, { account: "work", id: "dx", fromEmail: "dana@example.com", receivedAt: "2026-08-27T00:00:00Z" });
  const got = rankContacts(loadBook(d), "da", { exclude: new Set(), now: NOW });
  assert.deepEqual(
    got.map((c) => [c.email, c.n]),
    [
      ["dana@example.com", 4],
      ["danielle@work.example", 1],
    ],
    "dana is 3 in personal + 1 in work; a per-account count would have said 3, and danielle would not be here at all",
  );
  assert.deepEqual(got[0]?.accounts, ["work", "personal"], "the accounts that know the address, most recent first");
  d.close();
});

// ---------------------------------------------------------------------------
// Habits: which accounts have WRITTEN to an address.
// ---------------------------------------------------------------------------

function sentFixture() {
  const d = db();
  mailbox(d, { account: "personal", id: "psent", role: "sent" });
  mailbox(d, { account: "work", id: "wsent", role: "sent" });
  mailbox(d, { account: "work", id: "winbox", role: "inbox" });
  insert(d, { account: "personal", id: "p1", receivedAt: "2024-01-01T00:00:00Z" });
  addToMailbox(d, { account: "personal", emailId: "p1", mailboxId: "psent" });
  addRecipient(d, { account: "personal", emailId: "p1", kind: "to", email: "Jordan@Example.com" });
  insert(d, { account: "work", id: "w1", receivedAt: "2026-08-01T00:00:00Z" });
  addToMailbox(d, { account: "work", emailId: "w1", mailboxId: "wsent" });
  addRecipient(d, { account: "work", emailId: "w1", kind: "cc", email: "jordan@example.com" });
  // Received, not written: work holds this one in its Inbox.
  insert(d, { account: "work", id: "w2", receivedAt: "2026-08-05T00:00:00Z" });
  addToMailbox(d, { account: "work", emailId: "w2", mailboxId: "winbox" });
  addRecipient(d, { account: "work", emailId: "w2", kind: "to", email: "colleague@example.com" });
  return d;
}

test("a habit is a to/cc of a message in an account's SENT folder, most recently used first", () => {
  const d = sentFixture();
  const b = new AddressBook(d, { now: NOW });
  assert.deepEqual(b.habits("jordan@example.com"), ["work", "personal"], "work's is the more recent");
  assert.deepEqual(b.habits("JORDAN@EXAMPLE.COM"), ["work", "personal"], "an address is matched case-insensitively");
  assert.deepEqual(b.habits("colleague@example.com"), [], "a recipient of RECEIVED mail is not someone you wrote to");
  assert.deepEqual(b.habits("nobody@example.com"), [], "an address never written to has no habit");
  d.close();
});

// ---------------------------------------------------------------------------
// The cache. 🚨 This is the whole reason the book exists: aggregating the
// correspondence graph live cost 175ms per keystroke on the owner's archive
// (39,856 messages / 116,656 recipient rows), measured 2026-10-03.
// ---------------------------------------------------------------------------

test("🚨 a served lookup touches the database ZERO times", () => {
  const d = fixture();
  const c = counting(d);
  const b = new AddressBook(c.db, { now: NOW });
  b.suggest("da", { exclude: new Set() });
  const afterBuild = c.calls();
  assert.ok(afterBuild > 0, "the first lookup builds the book");
  b.suggest("dana", { exclude: new Set() });
  b.suggest("sam", { exclude: new Set() });
  b.habits("sam@example.com");
  assert.equal(c.calls(), afterBuild, "every later lookup is served from memory");
  d.close();
});

test("markStale rebuilds on the next lookup, so a new correspondent appears", () => {
  const d = fixture();
  const b = new AddressBook(d, { now: NOW });
  assert.deepEqual(b.suggest("newcomer", { exclude: new Set() }), []);
  insert(d, { id: "n1", fromEmail: "newcomer@example.com", receivedAt: "2026-08-28T00:00:00Z" });
  assert.deepEqual(b.suggest("newcomer", { exclude: new Set() }), [], "a built book does not see the write on its own");
  b.markStale();
  assert.deepEqual(
    b.suggest("newcomer", { exclude: new Set() }).map((c) => c.email),
    ["newcomer@example.com"],
  );
  d.close();
});

test("the book goes stale on its own after the TTL, so a missed invalidation cannot strand it forever", () => {
  const d = fixture();
  let clock = Date.parse("2026-09-01T00:00:00Z");
  const c = counting(d);
  const b = new AddressBook(c.db, { ttlMs: 60_000, now: () => clock });
  b.suggest("da", { exclude: new Set() });
  const afterBuild = c.calls();
  clock += 59_000;
  b.suggest("da", { exclude: new Set() });
  assert.equal(c.calls(), afterBuild, "inside the TTL it is still served from memory");
  clock += 2_000;
  b.suggest("da", { exclude: new Set() });
  assert.ok(c.calls() > afterBuild, "past the TTL it rebuilds");
  d.close();
});
