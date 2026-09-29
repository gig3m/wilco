import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.ts";
import {
  ftsQuery,
  searchEmails,
  suggestContacts,
  unreadCount,
  listMailboxes,
  SEARCH_LIMIT,
  SNIPPET_OPEN,
  SNIPPET_CLOSE,
} from "../src/core/queries.ts";
import { tempDbPath } from "./tmpdir.ts";

function db() {
  return openDb(tempDbPath());
}

function insert(
  d: ReturnType<typeof db>,
  o: Partial<{
    account: string;
    id: string;
    receivedAt: string;
    subject: string;
    fromEmail: string;
    body: string;
    unread: number;
    flagged: number;
  }>,
) {
  d.prepare(
    `INSERT INTO emails (account, id, received_at, subject, from_name, from_email, preview, body_text, is_unread, is_flagged)
     VALUES (?, ?, ?, ?, '', ?, '', ?, ?, ?)`,
  ).run(
    o.account ?? "personal",
    o.id ?? "m1",
    o.receivedAt ?? "2026-01-01T00:00:00Z",
    o.subject ?? "",
    o.fromEmail ?? "a@b.com",
    o.body ?? "",
    o.unread ?? 0,
    o.flagged ?? 0,
  );
}

function addRecipient(
  d: ReturnType<typeof db>,
  o: { account: string; emailId: string; kind: string; email: string },
) {
  d.prepare(
    `INSERT INTO email_recipients (account, email_id, kind, email) VALUES (?, ?, ?, ?)`,
  ).run(o.account, o.emailId, o.kind, o.email);
}

function addAttachment(
  d: ReturnType<typeof db>,
  o: { account: string; emailId: string; partId: string; cid: string | null },
) {
  d.prepare(
    `INSERT INTO email_attachments (account, email_id, part_id, cid) VALUES (?, ?, ?, ?)`,
  ).run(o.account, o.emailId, o.partId, o.cid);
}

/**
 * A small fixture covering every operator this task adds. Built fresh per
 * call (each test gets its own db, matching this file's existing
 * convention) rather than as a shared module-level helper.
 */
function seeded() {
  const d = db();
  insert(d, {
    account: "work",
    id: "M-work-unread",
    subject: "Q1 budget",
    body: "budget review",
    unread: 1,
    receivedAt: "2026-03-01T00:00:00Z",
  });
  insert(d, {
    account: "work",
    id: "M-work-read",
    subject: "old budget",
    body: "budget notes",
    unread: 0,
    receivedAt: "2026-02-20T00:00:00Z",
  });
  insert(d, {
    account: "personal",
    id: "M-personal-budget",
    subject: "budget",
    body: "budget for personal",
    unread: 1,
    receivedAt: "2026-02-25T00:00:00Z",
  });
  insert(d, {
    account: "personal",
    id: "M-from-robin",
    fromEmail: "robin@halden.example",
    body: "hello there",
    receivedAt: "2026-02-10T00:00:00Z",
  });
  insert(d, {
    account: "work",
    id: "M-mentions-robin",
    fromEmail: "someone@else.com",
    body: "robin asked about this",
    receivedAt: "2026-02-11T00:00:00Z",
  });
  insert(d, {
    account: "work",
    id: "M-to-team",
    body: "meeting notes",
    receivedAt: "2026-02-12T00:00:00Z",
  });
  addRecipient(d, {
    account: "work",
    emailId: "M-to-team",
    kind: "to",
    email: "team@society.example",
  });
  insert(d, {
    account: "work",
    id: "M-cc-robin",
    body: "looping you in",
    receivedAt: "2026-02-12T13:00:00Z",
  });
  addRecipient(d, {
    account: "work",
    emailId: "M-cc-robin",
    kind: "cc",
    email: "robin@halden.example",
  });
  insert(d, {
    account: "work",
    id: "M-inline-only",
    body: "signature logo",
    receivedAt: "2026-02-13T00:00:00Z",
  });
  addAttachment(d, { account: "work", emailId: "M-inline-only", partId: "2", cid: "logo123" });
  insert(d, {
    account: "work",
    id: "M-with-attachment",
    body: "see attached",
    receivedAt: "2026-02-14T00:00:00Z",
  });
  addAttachment(d, { account: "work", emailId: "M-with-attachment", partId: "2", cid: null });
  insert(d, {
    account: "work",
    id: "M-jan",
    body: "january budget",
    receivedAt: "2026-01-15T00:00:00Z",
  });
  insert(d, {
    account: "work",
    id: "M-feb",
    body: "february budget",
    receivedAt: "2026-02-15T00:00:00Z",
  });
  // Sits EXACTLY on the after:2026-02-01 boundary parseQuery produces
  // ("2026-02-01T00:00:00.000Z"), while this row is stored the way
  // received_at always is -- no milliseconds. Only a normalised comparison
  // gets this right; the earlier double-counting test never touches a
  // boundary and so cannot catch a comparison that's merely lucky.
  insert(d, {
    account: "work",
    id: "M-boundary",
    body: "boundary budget",
    receivedAt: "2026-02-01T00:00:00Z",
  });
  return d;
}

function seededWith(n: number) {
  const d = db();
  for (let i = 0; i < n; i += 1) {
    // The last two rows deliberately TIE on receivedAt (both use i's
    // timestamp for i = n - 2), so a full cursor walk actually exercises
    // the (account, id) tiebreak instead of only ever comparing distinct
    // timestamps.
    const tsIndex = i === n - 1 ? n - 2 : i;
    const minute = String(Math.floor(tsIndex / 60) % 60).padStart(2, "0");
    const second = String(tsIndex % 60).padStart(2, "0");
    insert(d, {
      id: `m${i}`,
      body: "budget report",
      receivedAt: `2026-01-01T00:${minute}:${second}Z`,
    });
  }
  return d;
}

test("an empty query is null, not a query matching everything", () => {
  assert.equal(ftsQuery(""), null);
  assert.equal(ftsQuery("   "), null);
});

test("every term is quoted, and the last gets a prefix match", () => {
  assert.equal(ftsQuery("quick brown"), '"quick" "brown"*');
});

test("punctuation in a term cannot become FTS5 syntax", () => {
  // An email address is the obvious case, and the one that breaks naive code.
  const q = ftsQuery("robin@halden.example");
  assert.equal(q, '"robin@halden.example"*');
});

test("an embedded double quote is escaped, not passed through", () => {
  assert.equal(ftsQuery('say "hi"'), '"say" """hi"""*');
});

test("a term with no letters or digits is dropped rather than sent to FTS5", () => {
  assert.equal(ftsQuery("--"), null);
  assert.equal(ftsQuery("hello --"), '"hello"*');
});

test("search matches on body text, not only subject", () => {
  const d = db();
  insert(d, { id: "m1", subject: "Lunch", body: "the quick brown fox jumps" });
  const r = searchEmails(d, "brown");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.id, "m1");
  d.close();
});

test("results are newest first", () => {
  const d = db();
  insert(d, { id: "old", receivedAt: "2020-01-01T00:00:00Z", body: "invoice" });
  insert(d, { id: "new", receivedAt: "2026-01-01T00:00:00Z", body: "invoice" });
  const r = searchEmails(d, "invoice");
  assert.deepEqual(r.rows.map((x) => x.id), ["new", "old"]);
  d.close();
});

test("results are capped, and the TRUE total is reported separately", () => {
  const d = db();
  for (let i = 0; i < SEARCH_LIMIT + 25; i += 1) {
    insert(d, { id: `m${i}`, receivedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, body: "invoice" });
  }
  const r = searchEmails(d, "invoice");
  assert.equal(r.rows.length, SEARCH_LIMIT);
  assert.equal(r.total, SEARCH_LIMIT + 25, '"200 matches" for 225 is a different fact, not a rounding error');
  d.close();
});

test("search spans accounts and keeps (account, id) distinct", () => {
  const d = db();
  insert(d, { account: "personal", id: "shared", body: "invoice" });
  insert(d, { account: "work", id: "shared", body: "invoice" });
  const r = searchEmails(d, "invoice");
  assert.equal(r.rows.length, 2);
  assert.deepEqual(new Set(r.rows.map((x) => x.account)), new Set(["personal", "work"]));
  d.close();
});

test("unread counts come from the junction table, not mailboxes.unread_emails", () => {
  const d = db();
  insert(d, { id: "m1", unread: 1 });
  insert(d, { id: "m2", unread: 0 });
  d.prepare(`INSERT INTO email_mailboxes (account, email_id, mailbox_id) VALUES ('personal','m1','P-F')`).run();
  d.prepare(`INSERT INTO email_mailboxes (account, email_id, mailbox_id) VALUES ('personal','m2','P-F')`).run();
  d.prepare(
    `INSERT INTO mailboxes (account,id,name,unread_emails) VALUES ('personal','P-F','Inbox',99)`,
  ).run();

  // The stale 99 is exactly what made dovetail's sidebar badge wrong until a
  // restart. The live answer is 1.
  assert.equal(unreadCount(d, "personal", "P-F"), 1);
  d.close();
});

test("AN OPERATOR-ONLY QUERY RETURNS ROWS, NOT NOTHING", () => {
  // The trap: ftsQuery("") is null and the old searchEmails read that as
  // "no results". 'is:unread acct:work' has no text terms and is a real search.
  const d = seeded();
  const r = searchEmails(d, "is:unread acct:work");
  assert.ok(r.rows.length > 0, "operator-only queries must not go through FTS at all");
  assert.ok(r.rows.every((x) => x.account === "work" && x.isUnread));
  d.close();
});

test("from: matches the sender, not the body", () => {
  const d = seeded();
  // A message whose BODY says 'robin' but whose sender is someone else.
  const r = searchEmails(d, "from:robin@halden.example");
  assert.ok(
    r.rows.every((x) => x.fromEmail === "robin@halden.example"),
    "a body mentioning robin must not match from:",
  );
  assert.ok(r.rows.length > 0);
  d.close();
});

test("to: matches the recipients junction", () => {
  const d = seeded();
  const r = searchEmails(d, "to:team@society.example");
  assert.ok(r.rows.some((x) => x.id === "M-to-team"), "the actual recipient must be returned");
  assert.ok(
    !r.rows.some((x) => x.id === "M-work-unread"),
    "a message with no matching recipient must be excluded, not just 'some rows came back'",
  );
  d.close();
});

test("cc: matches only the cc recipients, not to:", () => {
  const d = seeded();
  const r = searchEmails(d, "cc:robin@halden.example");
  assert.ok(r.rows.some((x) => x.id === "M-cc-robin"), "the actual cc recipient must be returned");
  assert.ok(
    !r.rows.some((x) => x.id === "M-to-team"),
    "cc: must not match a message where the address is only in the to: field",
  );
  d.close();
});

test("operators and text combine as AND", () => {
  const d = seeded();
  const all = searchEmails(d, "budget");
  const scoped = searchEmails(d, "budget acct:work");
  assert.ok(scoped.rows.length < all.rows.length);
  assert.ok(scoped.rows.every((x) => x.account === "work"));
  d.close();
});

test("has:attachment does not count inline images", () => {
  // An inline logo in a signature is not an attachment. Counting it makes
  // has:attachment match nearly every message with an HTML signature.
  const d = seeded();
  const r = searchEmails(d, "has:attachment");
  assert.ok(
    r.rows.some((x) => x.id === "M-with-attachment"),
    "a message with a REAL attachment must still be returned -- an implementation " +
      "that returns zero rows must not pass this test just for omitting the inline one",
  );
  assert.ok(!r.rows.some((x) => x.id === "M-inline-only"));
  d.close();
});

test("date bounds are half-open, so adjacent ranges do not double-count", () => {
  const d = seeded();
  const jan = searchEmails(d, "after:2026-01-01 before:2026-02-01");
  const feb = searchEmails(d, "after:2026-02-01 before:2026-03-01");
  const ids = new Set(jan.rows.map((r) => `${r.account}/${r.id}`));
  assert.ok(
    !feb.rows.some((r) => ids.has(`${r.account}/${r.id}`)),
    "after: is inclusive and before: exclusive, or a message lands in both months",
  );
  d.close();
});

test("a message stored exactly on the boundary lands in the inclusive side, not the exclusive one", () => {
  // M-boundary sits at 2026-02-01T00:00:00Z. after:2026-02-01 must include
  // it (inclusive lower bound); before:2026-02-01 must exclude it
  // (exclusive upper bound). The stored value has no milliseconds while
  // parseQuery's bound does -- this only comes out right if the comparison
  // normalises the shapes rather than relying on '.' < 'Z' by luck.
  const d = seeded();
  const feb = searchEmails(d, "after:2026-02-01 before:2026-03-01");
  const jan = searchEmails(d, "after:2026-01-01 before:2026-02-01");
  assert.ok(feb.rows.some((r) => r.id === "M-boundary"), "after: is inclusive of the exact instant");
  assert.ok(!jan.rows.some((r) => r.id === "M-boundary"), "before: is exclusive of the exact instant");
  d.close();
});

test("the true total is reported separately from the page", () => {
  const d = seededWith(250);
  const r = searchEmails(d, "budget", { limit: 200 });
  assert.equal(r.rows.length, 200);
  assert.equal(r.total, 250, "'200 of 250' is a different fact from '200 matches'");
  assert.equal(r.truncated, true);
  d.close();
});

test("a snippet comes back for a text query and is null for an operator-only one", () => {
  const d = seeded();
  assert.ok(searchEmails(d, "budget").rows[0]!.snippet !== null);
  assert.equal(
    searchEmails(d, "is:unread").rows[0]!.snippet,
    null,
    "there is no matched term to highlight, so there is nothing honest to show",
  );
  d.close();
});

test("a snippet marks its matches with the PUA markers the client splits on", () => {
  const d = seeded();
  const snippet = searchEmails(d, "budget").rows[0]!.snippet!;

  // The client (client/src/lib/escape.ts `splitSnippet`) turns these back
  // into `<mark>` runs. They must be the PUA codepoints, not the guillemets
  // this once used: guillemets occur in real mail, so a client that failed
  // to split them could not tell ours from a sender's -- and did in fact
  // render them as literal text in the deployed search results.
  assert.ok(snippet.includes(SNIPPET_OPEN), "the match is opened with U+E000");
  assert.ok(snippet.includes(SNIPPET_CLOSE), "the match is closed with U+E001");
  assert.equal(
    snippet.split(SNIPPET_OPEN).length,
    snippet.split(SNIPPET_CLOSE).length,
    "every marker is paired",
  );
  assert.ok(!snippet.includes("\u2039") && !snippet.includes("\u203a"), "no guillemet markers survive");
  d.close();
});

test("the cursor pages without an OFFSET, and a full walk visits every row once", () => {
  // seededWith ties the last two rows on receivedAt, so this walk also
  // exercises the (account, id) tiebreak the cursor's ORDER BY depends on
  // -- not just distinct-timestamp paging.
  const d = seededWith(250);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i += 1) {
    const page = searchEmails(d, "budget", { limit: 100, cursor });
    seen.push(...page.rows.map((r) => `${r.account}/${r.id}`));
    cursor = page.cursor;
    if (cursor === null) break;
  }
  assert.equal(seen.length, 250);
  assert.equal(new Set(seen).size, 250, "no row should be seen twice across pages");
  d.close();
});

test("truncated stays true on the LAST page, not just while more pages remain", () => {
  // truncated means "the whole match set is bigger than one page", not
  // "there happens to be a next page" -- so it must still be true on the
  // final page, where cursor is null.
  const d = seededWith(250);
  const first = searchEmails(d, "budget", { limit: 200 });
  assert.equal(first.truncated, true);
  assert.ok(first.cursor !== null);

  const last = searchEmails(d, "budget", { limit: 200, cursor: first.cursor });
  assert.equal(last.rows.length, 50);
  assert.equal(last.cursor, null, "no further page exists");
  assert.equal(last.truncated, true, "250 total still exceeds what ONE page (200) can show");
  d.close();
});

test("limit is clamped to [1, SEARCH_LIMIT], including a negative or absurdly large value", () => {
  const d = seededWith(250);

  // SQLite treats a negative LIMIT as "no limit" -- unclamped, this would
  // fetch the entire archive.
  const negative = searchEmails(d, "budget", { limit: -5 });
  assert.equal(negative.rows.length, 1, "a negative limit clamps to the floor of 1, not 'no limit'");

  const huge = searchEmails(d, "budget", { limit: 1_000_000_000 });
  assert.equal(huge.rows.length, SEARCH_LIMIT);

  const zero = searchEmails(d, "budget", { limit: 0 });
  assert.equal(zero.rows.length, 1, "a limit of 0 clamps to the floor of 1, not zero rows");

  d.close();
});

// ---------------------------------------------------------------------------
// Row 23: contact suggestions for compose (spec 7.5).
// ---------------------------------------------------------------------------

function contactsDb() {
  const d = db();
  // Senders: dana wrote three times (recent), oldtimer once, two years ago.
  insert(d, { account: "personal", id: "c1", fromEmail: "dana@example.com", receivedAt: "2026-08-01T00:00:00Z" });
  insert(d, { account: "personal", id: "c2", fromEmail: "dana@example.com", receivedAt: "2026-08-02T00:00:00Z" });
  insert(d, { account: "personal", id: "c3", fromEmail: "dana@example.com", receivedAt: "2026-08-03T00:00:00Z" });
  d.prepare(`UPDATE emails SET from_name = 'Dana Ruiz' WHERE id = 'c3'`).run();
  insert(d, { account: "personal", id: "c4", fromEmail: "oldtimer@example.com", receivedAt: "2024-01-01T00:00:00Z" });
  // Recipients of a sent message: sam (once, recent) and the owner's own address.
  insert(d, { account: "personal", id: "c5", fromEmail: "robin@example.com", receivedAt: "2026-08-20T00:00:00Z" });
  addRecipient(d, { account: "personal", emailId: "c5", kind: "to", email: "sam@example.com" });
  addRecipient(d, { account: "personal", emailId: "c5", kind: "cc", email: "robin@example.com" });
  // Another account's correspondent must not leak across.
  insert(d, { account: "work", id: "c6", fromEmail: "danielle@work.example", receivedAt: "2026-08-25T00:00:00Z" });
  return d;
}
const NOW = () => Date.parse("2026-09-01T00:00:00Z");

test("row 23: suggestions match email OR name by substring, ranked recent-first then by frequency", () => {
  const d = contactsDb();
  const got = suggestContacts(d, "personal", "da", { exclude: new Set(), now: NOW });
  assert.deepEqual(got, [{ name: "Dana Ruiz", email: "dana@example.com" }], "dana by email; danielle is another account's");
  const byName = suggestContacts(d, "personal", "ruiz", { exclude: new Set(), now: NOW });
  assert.equal(byName[0]?.email, "dana@example.com", "people search by surname");
  d.close();
});

test("row 23: a recent once-only correspondent outranks a frequent one not seen in a year; recipients count too", () => {
  const d = contactsDb();
  insert(d, { account: "personal", id: "c7", fromEmail: "oldtimer@example.com", receivedAt: "2024-02-01T00:00:00Z" });
  insert(d, { account: "personal", id: "c8", fromEmail: "oldtimer@example.com", receivedAt: "2024-03-01T00:00:00Z" });
  insert(d, { account: "personal", id: "c9", fromEmail: "oldtimer@example.com", receivedAt: "2024-04-01T00:00:00Z" });
  const got = suggestContacts(d, "personal", "example.com", { exclude: new Set(["robin@example.com"]), now: NOW });
  assert.deepEqual(
    got.map((c) => c.email),
    ["dana@example.com", "sam@example.com", "oldtimer@example.com"],
    "recent (dana x3, sam x1) before stale (oldtimer x4); the owner's own address excluded",
  );
  d.close();
});

test("row 23: fewer than two characters yields nothing, LIKE wildcards are literal, and the list is capped at 8", () => {
  const d = contactsDb();
  assert.deepEqual(suggestContacts(d, "personal", "d", { exclude: new Set(), now: NOW }), []);
  assert.deepEqual(suggestContacts(d, "personal", "%%", { exclude: new Set(), now: NOW }), [], "a wildcard is a character, not a match-all");
  for (let i = 0; i < 12; i++) {
    insert(d, { account: "personal", id: `bulk${i}`, fromEmail: `person${i}@bulk.example`, receivedAt: "2026-08-10T00:00:00Z" });
  }
  assert.equal(suggestContacts(d, "personal", "bulk.example", { exclude: new Set(), now: NOW }).length, 8);
  d.close();
});

function mailbox(
  d: ReturnType<typeof db>,
  o: { account: string; id: string; name: string; role?: string | null; sortOrder?: number },
) {
  d.prepare(
    `INSERT INTO mailboxes (account, id, name, role, sort_order) VALUES (?, ?, ?, ?, ?)`,
  ).run(o.account, o.id, o.name, o.role ?? null, o.sortOrder ?? 0);
}

function addToMailbox(
  d: ReturnType<typeof db>,
  o: { account: string; emailId: string; mailboxId: string },
) {
  d.prepare(
    `INSERT INTO email_mailboxes (account, email_id, mailbox_id) VALUES (?, ?, ?)`,
  ).run(o.account, o.emailId, o.mailboxId);
}

/**
 * Counts `db.prepare(...).all()/.get()` CALLS -- the same pattern
 * test/list.test.ts uses (see `counting` there) to pin O(1) vs O(N) query
 * shapes deterministically instead of by wall clock.
 */
function counting(d: DatabaseSync): { db: DatabaseSync; calls: () => number } {
  let calls = 0;
  const real = d.prepare.bind(d);
  const proxy = new Proxy(d, {
    get(t: DatabaseSync, k: string | symbol): unknown {
      if (k !== "prepare") {
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      }
      return (sql: string) => {
        const st = real(sql);
        return new Proxy(st, {
          get(s: object, m: string | symbol): unknown {
            const v = (s as unknown as Record<string | symbol, unknown>)[m];
            if (m === "all" || m === "get") {
              return (...p: unknown[]) => {
                calls++;
                return (v as (...a: unknown[]) => unknown).apply(s, p);
              };
            }
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
          },
        }) as unknown as ReturnType<DatabaseSync["prepare"]>;
      };
    },
  });
  return { db: proxy, calls: () => calls };
}

function mailboxesFixture(mailboxCount: number, messagesPerMailbox: number) {
  const d = db();
  for (let m = 0; m < mailboxCount; m++) {
    mailbox(d, { account: "personal", id: `box${m}`, name: `Box ${m}`, sortOrder: m });
    for (let i = 0; i < messagesPerMailbox; i++) {
      const id = `m${m}-${i}`;
      insert(d, { account: "personal", id, unread: i % 2 === 0 ? 1 : 0 });
      addToMailbox(d, { account: "personal", emailId: id, mailboxId: `box${m}` });
    }
  }
  // A mailbox with no messages at all should report 0/0, not be dropped.
  mailbox(d, { account: "personal", id: "empty", name: "Empty", sortOrder: mailboxCount });
  return d;
}

test("listMailboxes: per-mailbox unread/total match the per-mailbox unreadCount/mailboxTotal", () => {
  const d = mailboxesFixture(3, 5);
  const got = listMailboxes(d, "personal");
  assert.equal(got.length, 4, "3 seeded mailboxes + the empty one");
  const byId = new Map(got.map((m) => [m.id, m]));
  for (let m = 0; m < 3; m++) {
    const expectedTotal = 5;
    const expectedUnread = 3; // i = 0,2,4 of 0..4
    assert.equal(byId.get(`box${m}`)?.total, expectedTotal, `box${m} total`);
    assert.equal(byId.get(`box${m}`)?.unread, expectedUnread, `box${m} unread`);
  }
  assert.deepEqual(byId.get("empty"), { id: "empty", name: "Empty", role: null, parent: null, unread: 0, total: 0 });
  d.close();
});

test("🚨 listMailboxes runs a fixed number of statements regardless of mailbox count", () => {
  const few = mailboxesFixture(2, 4);
  const { db: fewDb, calls: fewCalls } = counting(few);
  listMailboxes(fewDb, "personal");
  const fewCount = fewCalls();
  few.close();

  const many = mailboxesFixture(40, 4);
  const { db: manyDb, calls: manyCalls } = counting(many);
  listMailboxes(manyDb, "personal");
  const manyCount = manyCalls();
  many.close();

  assert.equal(fewCount, manyCount, "same statement count at 2 mailboxes and 40 -- O(1), not O(folder)");
  // Three since schema 12: the mailbox rows, the totals (membership only),
  // and the unread count (driven by the partial `emails_unread` index).
  // The count that matters is that it does not GROW with the folder list,
  // asserted above; this bound just keeps it from creeping.
  assert.ok(fewCount <= 3, `expected the mailbox rows plus two count queries, got ${fewCount}`);
});
