/**
 * Spec 3.7's single-writer discipline, and the race it exists to close.
 *
 * > "archive a message, push fires mid-flight, `Email/get` returns the
 * > pre-action state, and **the row reappears in the inbox** before
 * > vanishing again on the next round."
 *
 * Audit pass 2 (F1) found this unbuilt — the only one of the spec's 54
 * sections marked absent, and the one the spec itself flags in bold:
 * "an implementation that does not is wrong even if it passes tests."
 *
 * 🚨 The headline test below reproduces the RACE, not the bookkeeping. It
 * interleaves a sync upsert into the exact window between the optimistic
 * local write and `Email/set` resolving, and asserts the row still reads as
 * archived. A test of `isPending()` alone would pass against an
 * implementation that never consulted it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  beginWrite,
  endWrite,
  isPending,
  pendingWriteCount,
  resetPendingWrites,
  withPendingWrites,
} from "../src/core/pending.ts";
import { storeEmails } from "../src/core/mutations.ts";
import { openDb } from "../src/core/db.ts";
import { tempDbPath } from "./tmpdir.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildRouter } from "../src/server/main.ts";
import { hashPassword } from "../src/server/auth.ts";

const ORIGIN = "https://mail.example.com";

function db(): DatabaseSync {
  const d = openDb(tempDbPath());
  d.prepare(`INSERT INTO accounts (key,label,accent,provider,endpoint,created_at) VALUES (?,?,?,?,?,?)`).run(
    "personal",
    "Personal",
    "#888",
    "jmap",
    "https://e",
    "2026-01-01T00:00:00Z",
  );
  return d;
}

/** The shape `Email/get` returns: the SERVER's view of a message. */
function serverView(id: string, opts: { seen?: boolean } = {}): Record<string, unknown> {
  return {
    id,
    threadId: "T1",
    receivedAt: "2026-01-01T00:00:00Z",
    subject: "Hello",
    keywords: opts.seen === true ? { $seen: true } : {},
    mailboxIds: { "P-INBOX": true },
  };
}

function unreadOf(d: DatabaseSync, id: string): number {
  return (d.prepare(`SELECT is_unread FROM emails WHERE account='personal' AND id=?`).get(id) as { is_unread: number })
    .is_unread;
}

test("🚨 A PUSH ROUND MID-WRITE CANNOT UNDO THE OPTIMISTIC WRITE (spec 3.7)", async () => {
  resetPendingWrites();
  const d = db();

  // The message starts UNREAD on the server and locally.
  storeEmails(d, "personal", [serverView("M1")] as never);
  assert.equal(unreadOf(d, "M1"), 1, "fixture did not land unread");

  let sawDuringWrite = -1;
  await withPendingWrites([{ account: "personal", id: "M1" }], async () => {
    // The optimistic local write: the user marked it read.
    d.prepare(`UPDATE emails SET is_unread = 0 WHERE account='personal' AND id='M1'`).run();

    // 🚨 THE RACE. A push round lands here, mid-`Email/set`, carrying the
    // server's PRE-ACTION view — still unread. Before 3.7 this overwrote the
    // optimistic value and the message visibly reverted.
    storeEmails(d, "personal", [serverView("M1")] as never);
    sawDuringWrite = unreadOf(d, "M1");
  });

  assert.equal(sawDuringWrite, 0, "a push round mid-write reverted the optimistic value — spec 3.7's race");

  // And once the write completes the row rejoins sync normally: the server's
  // view now agrees, and nothing is frozen out.
  storeEmails(d, "personal", [serverView("M1", { seen: true })] as never);
  assert.equal(unreadOf(d, "M1"), 0);
  storeEmails(d, "personal", [serverView("M1")] as never);
  assert.equal(unreadOf(d, "M1"), 1, "the row never rejoined sync after the write finished");
  d.close();
});

test("only the rows being written are skipped — sync is otherwise untouched", async () => {
  // A discipline that froze out neighbouring mail would be worse than the
  // race: the inbox would stop updating whenever anything was archived.
  resetPendingWrites();
  const d = db();
  storeEmails(d, "personal", [serverView("M1"), serverView("M2")] as never);
  d.prepare(`UPDATE emails SET is_unread = 0 WHERE account='personal'`).run();

  await withPendingWrites([{ account: "personal", id: "M1" }], async () => {
    storeEmails(d, "personal", [serverView("M1"), serverView("M2")] as never);
  });

  assert.equal(unreadOf(d, "M1"), 0, "the row under write was overwritten");
  assert.equal(unreadOf(d, "M2"), 1, "an unrelated row was frozen out of sync");
  d.close();
});

test("🚨 a THROWN write releases its rows — a leak is worse than the race", async () => {
  // `Email/set` rejecting is the normal failure path (an expired token, a
  // dropped connection). A row left pending is invisible to sync forever,
  // which looks like mail that never updates again.
  resetPendingWrites();
  await assert.rejects(
    withPendingWrites([{ account: "personal", id: "M1" }], async () => {
      throw new Error("Email/set failed");
    }),
  );
  assert.equal(pendingWriteCount(), 0, "a failed write leaked its pending entry");
  assert.equal(isPending("personal", "M1"), false);
});

test("overlapping writes to one row are reference-counted", () => {
  // Archive a selection, then flag one of them: the first release must not
  // cancel the second's protection.
  resetPendingWrites();
  beginWrite("personal", "M1");
  beginWrite("personal", "M1");
  endWrite("personal", "M1");
  assert.equal(isPending("personal", "M1"), true, "an inner release cancelled the outer write's protection");
  endWrite("personal", "M1");
  assert.equal(isPending("personal", "M1"), false);
});

test("a stale entry stops being honoured, so a leak elsewhere cannot freeze a row", () => {
  // The safety valve. Letting sync win is the recoverable direction; a row
  // held out of sync indefinitely is not.
  resetPendingWrites();
  const t0 = 1_000_000;
  beginWrite("personal", "M1", t0);
  assert.equal(isPending("personal", "M1", t0 + 59_000), true);
  assert.equal(isPending("personal", "M1", t0 + 61_000), false, "a stale entry still froze the row out of sync");
});

test("the set is keyed by (account, id) — ids collide across accounts", () => {
  // Fastmail reuses ids across accounts; a set keyed on the id alone would
  // freeze a stranger's message every time one was written.
  resetPendingWrites();
  beginWrite("personal", "SAME");
  assert.equal(isPending("personal", "SAME"), true);
  assert.equal(isPending("work", "SAME"), false, "writing one account's message protected another's");
});

/**
 * 🚨 THROUGH THE ROUTE, not the helper.
 *
 * Every test above exercises `withPendingWrites` directly, and all six of
 * them PASS with `beginWrite` deleted from `triage-api.ts` — they prove the
 * mechanism works and say nothing about whether the write path uses it.
 * That is the precise defect audit pass 8 found twice elsewhere, so this
 * test drives `POST /api/triage` with a JMAP client that blocks mid-call
 * and lands a sync round in the window.
 */
test("🚨 POST /api/triage HOLDS the window across Email/set", async () => {
  resetPendingWrites();
  const d = db();
  d.prepare(`INSERT INTO mailboxes (account,id,name,role) VALUES ('personal','P-INBOX','Inbox','inbox')`).run();
  storeEmails(d, "personal", [serverView("M1")] as never);
  assert.equal(unreadOf(d, "M1"), 1);

  // A client whose Email/set hangs until we release it -- the window.
  let releaseSet = (): void => {};
  const inFlight = new Promise<void>((r) => {
    releaseSet = r;
  });
  let entered = (): void => {};
  const reachedSet = new Promise<void>((r) => {
    entered = r;
  });
  const client = {
    session: { mailAccountId: "acc" },
    request: async () => {
      entered();
      await inFlight;
      return [["Email/set", { updated: { M1: null } }, "t0"]];
    },
  };

  const router = buildRouter({
    db: d,
    passwordHash: await hashPassword("letmein"),
    origin: ORIGIN,
    accountStates: new Map(),
    accounts: [],
    clients: new Map([["personal", client]]) as never,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ password: "letmein" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const triaging = fetch(`${base}/api/triage`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({
        action: { kind: "read", value: true },
        targets: [{ account: "personal", id: "M1" }],
      }),
    });

    await reachedSet;
    // The optimistic write has landed and Email/set is in flight. THE RACE:
    // a push round arrives carrying the server's pre-action view.
    assert.equal(unreadOf(d, "M1"), 0, "the optimistic write did not land");
    storeEmails(d, "personal", [serverView("M1")] as never);
    assert.equal(unreadOf(d, "M1"), 0, "a push round mid-Email/set reverted the row — the route is not holding 3.7");

    releaseSet();
    await triaging;

    // Window closed: the row rejoins sync.
    storeEmails(d, "personal", [serverView("M1")] as never);
    assert.equal(unreadOf(d, "M1"), 1, "the row never rejoined sync after the route finished");
    assert.equal(pendingWriteCount(), 0, "the route leaked its pending entries");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    d.close();
  }
});
