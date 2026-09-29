import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.ts";
import { listConversations, type ListFilter } from "../src/core/list.ts";
import { tempDbPath } from "./tmpdir.ts";

/**
 * The read path's semantics, pinned directly against `listConversations`
 * rather than through the HTTP surface -- test/read-api.test.ts already
 * covers the route, and these cases (the asymmetry of decision 4, the three
 * orders of decision 5) need hand-built rows that would be unreadable
 * expressed as fixtures for a live server.
 */

function db(): DatabaseSync {
  return openDb(tempDbPath());
}

function mailbox(d: DatabaseSync, account: string, id: string, role: string | null = null): void {
  d.prepare(`INSERT INTO mailboxes (account, id, name, role, sort_order) VALUES (?, ?, ?, ?, 0)`).run(
    account,
    id,
    id,
    role,
  );
}

interface MsgSpec {
  account?: string;
  id: string;
  thread?: string | null;
  at: string;
  unread?: number;
  flagged?: number;
  boxes?: string[];
  subject?: string;
}

/**
 * Writes an email and its membership rows together, carrying `received_at`
 * and `thread_key` onto every membership row -- the invariant Task 2 put on
 * the two real write paths. A test helper that skipped it would be testing
 * a database this application can no longer produce.
 */
function put(d: DatabaseSync, m: MsgSpec): void {
  const account = m.account ?? "personal";
  const thread = m.thread === undefined ? null : m.thread;
  d.prepare(
    `INSERT INTO emails (account, id, thread_id, received_at, subject, from_name, from_email, preview,
                         is_unread, is_flagged, has_attachment)
     VALUES (?, ?, ?, ?, ?, 'Sender', 's@x.test', 'p', ?, ?, 0)`,
  ).run(account, m.id, thread, m.at, m.subject ?? m.id, m.unread ?? 0, m.flagged ?? 0);
  for (const b of m.boxes ?? []) {
    d.prepare(
      `INSERT INTO email_mailboxes (account, email_id, mailbox_id, received_at, thread_key)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(account, m.id, b, m.at, thread ?? m.id);
  }
}

function attach(d: DatabaseSync, id: string, type: string, cid: string | null, account = "personal"): void {
  d.prepare(
    `INSERT INTO email_attachments (account, email_id, part_id, name, type, size, cid)
     VALUES (?, ?, ?, 'f', ?, 10, ?)`,
  ).run(account, id, `p${type}${cid ?? ""}`, type, cid);
}

function filter(over: Partial<ListFilter> = {}): ListFilter {
  return {
    account: "personal",
    mailbox: "BOX",
    role: null,
    unread: null,
    flagged: null,
    cursor: null,
    ...over,
  };
}

test("one row per conversation, represented by the folder's newest message", () => {
  const d = db();
  mailbox(d, "personal", "BOX");
  put(d, { id: "a1", thread: "T", at: "2026-09-01T00:00:00Z", boxes: ["BOX"] });
  put(d, { id: "a2", thread: "T", at: "2026-09-02T00:00:00Z", boxes: ["BOX"] });
  put(d, { id: "a3", thread: "T", at: "2026-09-03T00:00:00Z", boxes: ["BOX"] });

  const res = listConversations(d, filter());
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0]!.id, "a3");
  assert.equal(res.rows[0]!.threadCount, 3);
  assert.equal(res.total, 1);
  d.close();
});

test("🚨 the asymmetry: the count is the WHOLE thread, the flags are THIS FOLDER'S", () => {
  // Decision 4. In the statement this replaces, `thread_count` came from an
  // UNFILTERED grouping while unread/flagged/paperclip came from window
  // functions over the FILTERED set. Both directions of a mix-up must fail
  // here, so the three messages outside the folder are the ones that are
  // unread, flagged and carrying a file.
  const d = db();
  mailbox(d, "personal", "BOX");
  mailbox(d, "personal", "ARCH");
  put(d, { id: "f1", thread: "TA", at: "2026-09-01T00:00:00Z", boxes: ["BOX"] });
  put(d, { id: "f2", thread: "TA", at: "2026-09-02T00:00:00Z", boxes: ["BOX"] });
  for (const [i, id] of ["o1", "o2", "o3"].entries()) {
    put(d, { id, thread: "TA", at: `2026-08-0${i + 1}T00:00:00Z`, unread: 1, flagged: 1, boxes: ["ARCH"] });
    attach(d, id, "application/pdf", null);
  }

  const row = listConversations(d, filter()).rows[0]!;
  assert.equal(row.threadCount, 5, "the count is the whole conversation, wherever its messages live");
  assert.equal(row.isUnread, false, "unread leaked in from a message outside this folder");
  assert.equal(row.isFlagged, false, "flagged leaked in from a message outside this folder");
  assert.equal(row.hasAttachment, false, "the paperclip leaked in from a message outside this folder");

  // And the mirror image, so a mix-up in the other direction cannot pass:
  // seen from ARCH the same thread is unread/flagged/clipped and still 5.
  const fromArchive = listConversations(d, filter({ mailbox: "ARCH" })).rows[0]!;
  assert.equal(fromArchive.threadCount, 5);
  assert.equal(fromArchive.isUnread, true);
  assert.equal(fromArchive.isFlagged, true);
  assert.equal(fromArchive.hasAttachment, true);
  d.close();
});

test("🚨 a thread is unread when ANY of its messages in the folder is", () => {
  const d = db();
  mailbox(d, "personal", "BOX");
  put(d, { id: "u1", thread: "TU", at: "2026-09-01T00:00:00Z", unread: 1, boxes: ["BOX"] });
  put(d, { id: "u2", thread: "TU", at: "2026-09-02T00:00:00Z", unread: 0, boxes: ["BOX"] });
  const row = listConversations(d, filter()).rows[0]!;
  assert.equal(row.id, "u2");
  assert.equal(row.isUnread, true, "the newest is read, but the conversation is not");
  d.close();
});

test("🚨 tiebreak: one thread's two messages at the same instant pick the HIGHER id", () => {
  // Decision 5. Representation is `received_at DESC, email_id DESC` while
  // the page is `received_at DESC, account ASC, id ASC`; a single order
  // serving both is the bug that decision exists to prevent.
  const d = db();
  mailbox(d, "personal", "BOX");
  put(d, { id: "z-lower", thread: "TT", at: "2026-09-05T00:00:00Z", boxes: ["BOX"] });
  put(d, { id: "z-upper", thread: "TT", at: "2026-09-05T00:00:00Z", boxes: ["BOX"] });
  const row = listConversations(d, filter()).rows[0]!;
  assert.equal(row.id, "z-upper", "the representative is the higher id, not the one discovery met first");
  d.close();
});

test("🚨 tiebreak: two threads at the same instant order by account then id ASCENDING", () => {
  const d = db();
  mailbox(d, "personal", "BOX", "inbox");
  mailbox(d, "work", "BOX", "inbox");
  put(d, { account: "work", id: "b", thread: "TW", at: "2026-09-05T00:00:00Z", boxes: ["BOX"] });
  put(d, { account: "personal", id: "c", thread: "TP", at: "2026-09-05T00:00:00Z", boxes: ["BOX"] });
  put(d, { account: "personal", id: "a", thread: "TQ", at: "2026-09-05T00:00:00Z", boxes: ["BOX"] });

  const rows = listConversations(d, filter({ account: null, mailbox: null, role: "inbox" })).rows;
  assert.deepEqual(
    rows.map((r) => `${r.account}/${r.id}`),
    ["personal/a", "personal/c", "work/b"],
    "account ascending, then id ascending",
  );
  d.close();
});

test("an unthreaded message is its own conversation", () => {
  const d = db();
  mailbox(d, "personal", "BOX");
  for (const id of ["n1", "n2", "n3"]) {
    put(d, { id, thread: null, at: "2026-09-03T00:00:00Z", boxes: ["BOX"] });
  }
  const res = listConversations(d, filter());
  assert.deepEqual(res.rows.map((r) => r.id).sort(), ["n1", "n2", "n3"]);
  assert.equal(res.total, 3);
  for (const r of res.rows) assert.equal(r.threadCount, 1);
  d.close();
});

test("🚨 page 2 holds no conversation from page 1, even when an older sibling lies below the cursor", () => {
  const d = db();
  mailbox(d, "personal", "BOX");
  // One thread straddling every page boundary, plus singletons around it.
  for (const [i, id] of ["s1", "s2", "s3", "s4"].entries()) {
    put(d, { id, thread: "TS", at: `2026-09-1${i}T00:00:00Z`, boxes: ["BOX"] });
  }
  for (const [i, id] of ["k1", "k2", "k3"].entries()) {
    put(d, { id, thread: null, at: `2026-09-2${i}T00:00:00Z`, boxes: ["BOX"] });
  }

  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 8; page++) {
    const res: ReturnType<typeof listConversations> = listConversations(
      d,
      filter({ cursor, limit: 2 }),
    );
    for (const r of res.rows) {
      const key = `${r.account}/${r.threadId ?? r.id}`;
      assert.ok(!seen.has(key), `conversation ${key} appeared on two pages`);
      seen.add(key);
    }
    cursor = res.cursor;
    if (cursor === null) break;
  }
  assert.equal(seen.size, 4, "three singletons and the one thread");
  d.close();
});

test("group=false returns one row per message, and still counts the whole conversation", () => {
  const d = db();
  mailbox(d, "personal", "BOX");
  for (const [i, id] of ["g1", "g2", "g3"].entries()) {
    put(d, { id, thread: "TG", at: `2026-09-0${i + 1}T00:00:00Z`, boxes: ["BOX"] });
  }
  const res = listConversations(d, filter({ group: false }));
  assert.deepEqual(res.rows.map((r) => r.id), ["g3", "g2", "g1"]);
  assert.equal(res.total, 3, "messages, not conversations");
  for (const r of res.rows) assert.equal(r.threadCount, 3);
  d.close();
});

test("group=false takes each message's own flags, not the thread's", () => {
  const d = db();
  mailbox(d, "personal", "BOX");
  put(d, { id: "h1", thread: "TH", at: "2026-09-01T00:00:00Z", unread: 1, boxes: ["BOX"] });
  put(d, { id: "h2", thread: "TH", at: "2026-09-02T00:00:00Z", unread: 0, boxes: ["BOX"] });
  const res = listConversations(d, filter({ group: false }));
  assert.equal(res.rows.find((r) => r.id === "h2")!.isUnread, false);
  assert.equal(res.rows.find((r) => r.id === "h1")!.isUnread, true);
  d.close();
});

test("a thread with no message in this folder does not appear", () => {
  const d = db();
  mailbox(d, "personal", "BOX");
  mailbox(d, "personal", "ELSE");
  put(d, { id: "e1", thread: "TE", at: "2026-09-01T00:00:00Z", boxes: ["ELSE"] });
  put(d, { id: "x1", thread: null, at: "2026-09-02T00:00:00Z", boxes: ["BOX"] });
  const res = listConversations(d, filter());
  assert.deepEqual(res.rows.map((r) => r.id), ["x1"]);
  assert.equal(res.total, 1);
  d.close();
});

test("the total is the folder's distinct conversations and agrees with the row count under the limit", () => {
  const d = db();
  mailbox(d, "personal", "BOX");
  for (let t = 0; t < 4; t++) {
    for (let m = 0; m < 3; m++) {
      put(d, { id: `t${t}m${m}`, thread: `T${t}`, at: `2026-09-0${t + 1}T00:0${m}:00Z`, boxes: ["BOX"] });
    }
  }
  const res = listConversations(d, filter());
  assert.equal(res.total, 4);
  assert.equal(res.rows.length, 4);
  assert.equal(res.truncated, false);
  assert.equal(res.cursor, null);
  d.close();
});

test("🚨 the paperclip follows NON_FILE_PART_TYPES and ignores inline cid parts", () => {
  const d = db();
  mailbox(d, "personal", "BOX");
  const msg = (id: string) => put(d, { id, thread: null, at: `2026-07-0${id.slice(-1)}T00:00:00Z`, boxes: ["BOX"] });
  msg("a1");
  attach(d, "a1", "application/pdf", null);
  msg("a2");
  attach(d, "a2", "image/png", "logo@x"); // inline
  msg("a3");
  attach(d, "a3", "text/x-amp-html", null); // an alternative rendering of the body
  msg("a4");
  attach(d, "a4", "text/calendar", null);
  msg("a5"); // nothing at all

  const rows = listConversations(d, filter()).rows;
  const clip = (id: string) => rows.find((r) => r.id === id)!.hasAttachment;
  assert.equal(clip("a1"), true);
  assert.equal(clip("a2"), false);
  assert.equal(clip("a3"), false);
  assert.equal(clip("a4"), true);
  assert.equal(clip("a5"), false);
  d.close();
});

test("unread and flagged filters restrict the set the page, the flags and the total are taken over", () => {
  const d = db();
  mailbox(d, "personal", "BOX");
  put(d, { id: "q1", thread: "TQ", at: "2026-09-01T00:00:00Z", unread: 1, boxes: ["BOX"] });
  put(d, { id: "q2", thread: "TQ", at: "2026-09-02T00:00:00Z", unread: 0, boxes: ["BOX"] });
  put(d, { id: "r1", thread: null, at: "2026-09-03T00:00:00Z", unread: 0, boxes: ["BOX"] });

  const res = listConversations(d, filter({ unread: true }));
  assert.deepEqual(res.rows.map((r) => r.id), ["q1"], "represented by its newest UNREAD message");
  assert.equal(res.total, 1);
  assert.equal(res.rows[0]!.threadCount, 2, "the count is still the whole conversation");
  d.close();
});

test("a walk longer than its first window still finds a full page", () => {
  // The window starts at ceil(limit * 1.3); a folder whose newest messages
  // are all one conversation must make it widen rather than short-page.
  const d = db();
  mailbox(d, "personal", "BOX");
  for (let i = 0; i < 40; i++) {
    put(d, { id: `w${String(i).padStart(3, "0")}`, thread: "TW", at: `2026-09-01T00:${String(i).padStart(2, "0")}:00Z`, boxes: ["BOX"] });
  }
  for (let i = 0; i < 10; i++) {
    put(d, { id: `v${i}`, thread: null, at: `2026-08-01T00:0${i}:00Z`, boxes: ["BOX"] });
  }
  const res = listConversations(d, filter({ limit: 5 }));
  assert.equal(res.rows.length, 5);
  assert.equal(res.total, 11, "one conversation plus ten singletons");
  assert.notEqual(res.cursor, null);
  d.close();
});

test("a role list skips accounts switched out of All inboxes, and their conversations", () => {
  const d = db();
  mailbox(d, "personal", "BOX", "inbox");
  mailbox(d, "work", "BOX", "inbox");
  put(d, { account: "personal", id: "p1", thread: null, at: "2026-09-01T00:00:00Z", boxes: ["BOX"] });
  put(d, { account: "work", id: "w1", thread: null, at: "2026-09-02T00:00:00Z", boxes: ["BOX"] });
  d.prepare(`INSERT INTO settings (account, key, value, updated_at) VALUES ('work', 'showInUnified', 'off', '2026-09-22T00:00:00Z')`).run();

  const res = listConversations(d, filter({ account: null, mailbox: null, role: "inbox" }));
  assert.deepEqual(res.rows.map((r) => r.id), ["p1"]);
  assert.equal(res.total, 1, "and out of the count too");
  d.close();
});

test("with no folder scope at all the list is every account's mail, collapsed", () => {
  const d = db();
  put(d, { account: "personal", id: "m1", thread: "TZ", at: "2026-09-01T00:00:00Z" });
  put(d, { account: "personal", id: "m2", thread: "TZ", at: "2026-09-02T00:00:00Z" });
  put(d, { account: "work", id: "m3", thread: null, at: "2026-09-03T00:00:00Z" });

  const res = listConversations(d, filter({ account: null, mailbox: null }));
  assert.deepEqual(res.rows.map((r) => `${r.account}/${r.id}`), ["work/m3", "personal/m2"]);
  assert.equal(res.total, 2);
  assert.equal(res.rows.find((r) => r.id === "m2")!.threadCount, 2);
  d.close();
});

test("🚨 a conversation whose representative was on page 1 is not re-emitted from below the cursor", () => {
  // The cursor applies to the REPRESENTATIVE, not to the row that
  // rediscovers the thread. Found by the shadow compare against the live
  // 167k archive, not by the cursor test above: page 3 of a 1,000-message
  // folder opened with a message two months NEWER than page 2's last row,
  // because the walk met an old sibling of an already-shown conversation and
  // resolved it back up to its newest message.
  const d = db();
  mailbox(d, "personal", "BOX");
  put(d, { id: "new1", thread: null, at: "2026-09-11T00:00:00Z", boxes: ["BOX"] });
  put(d, { id: "rep", thread: "TR", at: "2026-09-10T00:00:00Z", boxes: ["BOX"] });
  put(d, { id: "mid1", thread: null, at: "2026-09-08T00:00:00Z", boxes: ["BOX"] });
  put(d, { id: "mid2", thread: null, at: "2026-09-07T00:00:00Z", boxes: ["BOX"] });
  put(d, { id: "old1", thread: "TR", at: "2026-09-05T00:00:00Z", boxes: ["BOX"] });
  put(d, { id: "old2", thread: "TR", at: "2026-09-04T00:00:00Z", boxes: ["BOX"] });

  const p1 = listConversations(d, filter({ limit: 2 }));
  assert.deepEqual(p1.rows.map((r) => r.id), ["new1", "rep"]);
  const p2 = listConversations(d, filter({ limit: 2, cursor: p1.cursor }));
  assert.deepEqual(p2.rows.map((r) => r.id), ["mid1", "mid2"], "TR came back up from its old siblings");
  for (const r of p2.rows) {
    assert.ok(r.receivedAt < "2026-09-10T00:00:00Z", `${r.id} is newer than page 1's cursor`);
  }
  assert.equal(p2.cursor, null, "TR's old messages are not a fourth conversation waiting on a third page");
  assert.equal(p1.total, 4, "three singletons plus the conversation, counted once");
  d.close();
});

test("🚨 a conversation is never dropped when discovery order and representative order disagree", () => {
  // Review finding, Task 3. The cut is taken in REPRESENTATIVE order, but
  // discovery stopped at the `wanted`-th conversation FOUND. A thread is
  // discovered at its lowest-id member and represented by its highest-id
  // one, so inside a run of equal `received_at` a tied thread takes a page
  // slot ahead of a conversation whose representative sorts above it -- and
  // that conversation, never discovered, is excluded from the next page by
  // the cursor. Five rows at one instant used to give pages ['w'] and ['z']
  // with a header of 3, and `m` appeared on no page at all.
  const d = db();
  mailbox(d, "personal", "BOX");
  const at = "2026-09-05T00:00:00Z";
  put(d, { id: "a", thread: "Z", at, boxes: ["BOX"] });
  put(d, { id: "z", thread: "Z", at, boxes: ["BOX"] });
  put(d, { id: "b", thread: "W", at, boxes: ["BOX"] });
  put(d, { id: "w", thread: "W", at, boxes: ["BOX"] });
  put(d, { id: "m", thread: null, at, boxes: ["BOX"] });

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 6; page++) {
    const res: ReturnType<typeof listConversations> = listConversations(d, filter({ limit: 1, cursor }));
    assert.equal(res.total, 3, "two conversations and a singleton");
    for (const r of res.rows) seen.push(r.id);
    cursor = res.cursor;
    if (cursor === null) break;
  }
  assert.deepEqual(seen, ["m", "w", "z"], "every conversation, in page order (account then id ASCENDING)");
  d.close();
});

/**
 * Counts statement EXECUTIONS, and the rows they hand back, for one call.
 * A wall-clock budget would flake on a loaded box; these two numbers are
 * deterministic and are what actually distinguishes O(page) from O(folder).
 */
function counting(d: DatabaseSync): { db: DatabaseSync; stats: { calls: number; rows: number } } {
  const stats = { calls: 0, rows: 0 };
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
            if (m === "all") {
              return (...p: unknown[]) => {
                stats.calls++;
                const out = (v as (...a: unknown[]) => unknown[]).apply(s, p);
                stats.rows += out.length;
                return out;
              };
            }
            if (m === "get") {
              return (...p: unknown[]) => {
                stats.calls++;
                stats.rows++;
                return (v as (...a: unknown[]) => unknown).apply(s, p);
              };
            }
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
          },
        }) as unknown as ReturnType<DatabaseSync["prepare"]>;
      };
    },
  });
  return { db: proxy, stats };
}

test("🚨 a page costs the same whether the folder shares one instant or 4,000 of them", () => {
  // The tie-block stop rule compares PAGE ORDER, not `received_at`. Comparing
  // `received_at` alone made a same-instant block cost the whole block and
  // then made the widening loop re-walk it -- 8,012 statements and 985ms on
  // a folder of 8,000 messages at one instant, against 56 and 9.6ms for the
  // same folder at distinct instants. A bulk `Email/import` produces exactly
  // that shape. This pins the counts, not the clock.
  const rows = 4000;
  const build = (sameInstant: boolean) => {
    const d = db();
    mailbox(d, "personal", "BOX");
    for (let i = 0; i < rows; i++) {
      const at = sameInstant
        ? "2026-09-05T00:00:00Z"
        : `2026-09-05T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
      put(d, {
        id: `c${String(i).padStart(5, "0")}`,
        thread: `T${Math.floor(i / 2)}`, // threads of two, so discovery and representation differ
        at,
        boxes: ["BOX"],
      });
    }
    return d;
  };

  const spread = build(false);
  const spreadRun = counting(spread);
  const a = listConversations(spreadRun.db, filter({ limit: 50 }));
  spread.close();

  const tied = build(true);
  const tiedRun = counting(tied);
  const b = listConversations(tiedRun.db, filter({ limit: 50 }));
  tied.close();

  assert.equal(a.rows.length, 50);
  assert.equal(b.rows.length, 50);
  assert.ok(
    tiedRun.stats.calls <= spreadRun.stats.calls * 2,
    `one instant cost ${tiedRun.stats.calls} statements against ${spreadRun.stats.calls} for distinct instants -- ` +
      `the walk is proportional to the tie block again`,
  );
  assert.ok(
    tiedRun.stats.rows <= spreadRun.stats.rows * 2,
    `one instant read ${tiedRun.stats.rows} rows against ${spreadRun.stats.rows} for distinct instants`,
  );
  // And an absolute ceiling, so both regressing together cannot pass.
  assert.ok(tiedRun.stats.calls < 400, `${tiedRun.stats.calls} statements for one 50-row page`);
});

// ---------------------------------------------------------------------------
// The unified list across accounts. There was NO multi-account coverage here
// until review found the merge dropping a whole account's conversations, so
// these walk the merge deliberately: dense ties, one account able to fill the
// window on its own, three accounts, and a seeded fuzz against brute force.
// ---------------------------------------------------------------------------

/** Every conversation the folder holds, and its representative, computed the
 *  slow obvious way: no walk, no window, no cursor. */
function bruteForce(d: DatabaseSync, accounts: string[]): { account: string; id: string }[] {
  const out: { account: string; id: string; at: string }[] = [];
  for (const account of accounts) {
    const rows = d
      .prepare(
        `SELECT m.email_id AS id, m.received_at AS at, m.thread_key AS k
           FROM email_mailboxes m
           JOIN mailboxes b ON b.account = m.account AND b.id = m.mailbox_id
          WHERE m.account = ? AND b.role = 'inbox'`,
      )
      .all(account) as unknown as { id: string; at: string; k: string }[];
    const best = new Map<string, { id: string; at: string }>();
    for (const r of rows) {
      const cur = best.get(r.k);
      // The representative: received_at DESC, id DESC.
      if (cur === undefined || r.at > cur.at || (r.at === cur.at && r.id > cur.id)) {
        best.set(r.k, { id: r.id, at: r.at });
      }
    }
    for (const b of best.values()) out.push({ account, id: b.id, at: b.at });
  }
  // Page order: received_at DESC, account ASC, id ASC.
  out.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.account !== b.account ? (a.account < b.account ? -1 : 1) : a.id < b.id ? -1 : 1));
  return out.map((r) => ({ account: r.account, id: r.id }));
}

/** Pages the unified inbox to the end and returns every row it emitted. */
function pageAll(d: DatabaseSync, limit: number): { account: string; id: string }[] {
  const seen: { account: string; id: string }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const res: ReturnType<typeof listConversations> = listConversations(
      d,
      filter({ account: null, mailbox: null, role: "inbox", limit, cursor }),
    );
    for (const r of res.rows) seen.push({ account: r.account, id: r.id });
    cursor = res.cursor;
    if (cursor === null) return seen;
  }
  throw new Error("paging did not terminate");
}

test("🚨 the unified list loses no conversation to the cross-account merge", () => {
  // The merge used to trim the COMBINED sorted result back to a single
  // `window` while computing `exhausted` PER SCOPE, so rows discarded by that
  // trim were never accounted for: the discovery loop stopped believing it
  // had seen everything, and the conversations that fell off the end appeared
  // on NO page while `total` went on counting them. Two accounts, eight
  // messages against two, all at one instant, threads of three plus
  // singletons: at limit 3 the old merge returned five of the six
  // conversations, and the missing one was on no page at any limit.
  const d = db();
  mailbox(d, "alpha", "BOX", "inbox");
  mailbox(d, "beta", "BOX", "inbox");
  const at = "2026-09-05T00:00:00Z";
  for (const [account, count] of [["alpha", 8], ["beta", 2]] as [string, number][]) {
    for (let i = 0; i < count; i++) {
      const thread = i % 4 === 0 ? null : `T${account}${Math.floor(i / 4)}`;
      put(d, { account, id: `${account}-${String(i).padStart(2, "0")}`, thread, at, boxes: ["BOX"] });
    }
  }

  const expected = bruteForce(d, ["alpha", "beta"]);
  assert.equal(expected.length, 6);
  for (const limit of [1, 2, 3, 5, 10]) {
    assert.deepEqual(pageAll(d, limit), expected, `limit ${limit}: the unified page sequence is wrong`);
  }
  assert.equal(
    listConversations(d, filter({ account: null, mailbox: null, role: "inbox" })).total,
    expected.length,
    "the header counts conversations the pages never show",
  );
  d.close();
});

test("three accounts page in order with no conversation missing or repeated", () => {
  // Three, so a two-scope special case cannot pass by accident.
  const d = db();
  for (const a of ["one", "three", "two"]) mailbox(d, a, "BOX", "inbox");
  let n = 0;
  for (const a of ["one", "two", "three"]) {
    for (let i = 0; i < 12; i++) {
      // Deliberately coarse timestamps so accounts interleave and tie.
      const at = `2026-09-0${(i % 4) + 1}T00:00:00Z`;
      const thread = i % 3 === 0 ? null : `T${a}${Math.floor(i / 3)}`;
      put(d, { account: a, id: `${a}-${String(i).padStart(2, "0")}`, thread, at, boxes: ["BOX"] });
      n++;
    }
  }
  assert.equal(n, 36);
  const expected = bruteForce(d, ["one", "three", "two"]);
  for (const limit of [1, 2, 3, 7, 50]) {
    const got = pageAll(d, limit);
    assert.deepEqual(got, expected, `limit ${limit}`);
    assert.equal(new Set(got.map((r) => `${r.account}/${r.id}`)).size, got.length, `limit ${limit}: a row repeated`);
  }
  assert.equal(
    listConversations(d, filter({ account: null, mailbox: null, role: "inbox" })).total,
    expected.length,
    "the header agrees with what paging produces",
  );
  d.close();
});

test("🚨 fuzz: the unified page sequence equals brute force across random multi-account folders", () => {
  // Seeded and small, so it is deterministic and adds well under a second.
  // Review's equivalent found the merge bug in 11 of 20 trials; nothing in
  // this file would have, because nothing here used more than one account.
  let seed = 0x5eed;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let trial = 0; trial < 30; trial++) {
    const d = db();
    const accounts = ["a", "b", "c"].slice(0, 2 + rnd(2));
    for (const a of accounts) mailbox(d, a, "BOX", "inbox");
    // Few distinct instants, so ties are dense -- the shape the merge and the
    // tie block both have to survive.
    const instants = 1 + rnd(4);
    for (const a of accounts) {
      const count = 4 + rnd(18);
      const groupSize = 1 + rnd(3);
      for (let i = 0; i < count; i++) {
        // Instants CYCLE rather than being drawn at random, so a thread's
        // members land at different instants and a tie block holds rows from
        // several accounts and several threads at once -- the shape that
        // exercises the merge and the tie block together.
        const at = `2026-09-0${(i % instants) + 1}T00:00:00Z`;
        const thread = i % (groupSize + 1) === 0 ? null : `T${a}${Math.floor(i / (groupSize + 1))}`;
        put(d, { account: a, id: `${a}-${String(i).padStart(2, "0")}`, thread, at, boxes: ["BOX"] });
      }
    }
    const expected = bruteForce(d, accounts);
    for (const limit of [1, 2, 3, 5]) {
      const got = pageAll(d, limit);
      assert.deepEqual(
        got,
        expected,
        `trial ${trial} (accounts ${accounts.join(",")}, ${instants} instants), limit ${limit}`,
      );
    }
    assert.equal(
      listConversations(d, filter({ account: null, mailbox: null, role: "inbox" })).total,
      expected.length,
      `trial ${trial}: the header disagrees with the conversations that exist`,
    );
    d.close();
  }
});

test("the merged path stays O(page) too: three tied accounts cost a page's worth of work", () => {
  // The cost assertion of the previous round, for the merge. Each scope gets
  // its OWN window; what must not come back is a walk proportional to the
  // folders.
  const accounts = ["one", "three", "two"];
  const build = (sameInstant: boolean) => {
    const d = db();
    for (const a of accounts) mailbox(d, a, "BOX", "inbox");
    for (const a of accounts) {
      for (let i = 0; i < 1000; i++) {
        const at = sameInstant
          ? "2026-09-05T00:00:00Z"
          : `2026-09-05T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
        put(d, { account: a, id: `${a}-${String(i).padStart(4, "0")}`, thread: `T${a}${Math.floor(i / 2)}`, at, boxes: ["BOX"] });
      }
    }
    return d;
  };
  const f = { account: null, mailbox: null, role: "inbox", limit: 50 };

  const spread = build(false);
  const spreadRun = counting(spread);
  const a = listConversations(spreadRun.db, filter(f));
  spread.close();

  const tied = build(true);
  const tiedRun = counting(tied);
  const b = listConversations(tiedRun.db, filter(f));
  tied.close();

  assert.equal(a.rows.length, 50);
  assert.equal(b.rows.length, 50);
  assert.ok(
    tiedRun.stats.calls <= spreadRun.stats.calls * 2,
    `one instant cost ${tiedRun.stats.calls} statements against ${spreadRun.stats.calls} for distinct instants`,
  );
  assert.ok(tiedRun.stats.calls < 400, `${tiedRun.stats.calls} statements for one merged 50-row page`);
});
