/**
 * After a resync, local rows the server no longer has are REMOVED.
 *
 * 🚨 The defect this pins, found by the harness on 2026-09-06 (checklist
 * row 28): Fastmail refuses `Email/changes` from a state only ~270 changes
 * old with `cannotCalculateChanges`. Wilco then resets the cursor and
 * re-walks the archive -- and a walk only ADDS rows. `removeEmails` had
 * exactly one caller, the `destroyed` list of a changes round, so every
 * message destroyed inside the gap stayed in the cache forever. Measured:
 * 18 phantom rows in one inbox after an evening of runs, unread counts
 * 3 on Fastmail vs 9 on screen.
 *
 * The reconcile source is an UNFILTERED Email/query: the walk excludes
 * Trash and Spam, so using its id set would delete every trashed message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { setSyncState, getSyncState, storeEmails } from "../src/core/mutations.ts";
import { refreshAccount } from "../src/core/refresh.ts";
import { JmapClient } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import { tempDbPath } from "./tmpdir.ts";

const session = resolveSession("personal", personalSession);
function json(b: unknown) { return new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }); }

function meta(id: string, mailbox = "INBOX") {
  return { id, threadId: `T${id}`, receivedAt: "2026-09-06T00:00:00Z", subject: id, preview: "", hasAttachment: false,
           keywords: { $seen: true }, mailboxIds: { [mailbox]: true }, from: [{ email: "a@x.test", name: "A" }] };
}

/**
 * A server whose changes window is exhausted: Email/changes from the
 * stored state answers cannotCalculateChanges; from the walk's fresh state
 * it answers "nothing". Email/query (the walk, filtered) and the unfiltered
 * reconcile query both answer from `serverIds`.
 */
function server(serverIds: string[], opts: { failQueryAfter?: number } = {}) {
  let queries = 0;
  return async (_url: string, init: { body?: string }) => {
    const calls = JSON.parse(init.body ?? "{}").methodCalls as [string, Record<string, any>, string][];
    const [name, args] = calls[0]!;
    if (name === "Mailbox/get") {
      return json({ methodResponses: [["Mailbox/get", { state: "M1", list: [
        { id: "INBOX", name: "Inbox", role: "inbox", totalEmails: 1, unreadEmails: 0 },
        { id: "TRASH", name: "Trash", role: "trash", totalEmails: 1, unreadEmails: 0 },
      ] }, "c0"]] });
    }
    if (name === "Email/changes") {
      if (args.sinceState === "J5") return json({ methodResponses: [["Email/changes", { oldState: "J5", newState: "J5", hasMoreChanges: false, created: [], updated: [], destroyed: [] }, "c0"]] });
      return json({ methodResponses: [["error", { type: "cannotCalculateChanges" }, "c0"]] });
    }
    if (name === "Email/query") {
      queries += 1;
      if (opts.failQueryAfter !== undefined && queries > opts.failQueryAfter) {
        return json({ methodResponses: [["error", { type: "serverUnavailable" }, "c0"]] });
      }
      const filtered = args.filter ? serverIds.filter((i) => !i.startsWith("T")) : serverIds;  // the walk excludes trash
      // The walk pages by anchor (+anchorOffset); the reconcile pages by position.
      let pos = args.position ?? 0;
      if (typeof args.anchor === "string") {
        const at = filtered.indexOf(args.anchor);
        if (at === -1) return json({ methodResponses: [["error", { type: "anchorNotFound" }, "c0"]] });
        pos = at + (args.anchorOffset ?? 0);
      }
      return json({ methodResponses: [["Email/query", { queryState: "J5", ids: filtered.slice(pos, pos + (args.limit ?? 50)), position: pos, canCalculateChanges: true }, "c0"]] });
    }
    if (name === "Email/get") {
      const ids: string[] = args.ids ?? [];
      return json({ methodResponses: [["Email/get", { state: "J5", list: ids.filter((i) => serverIds.includes(i)).map((i) => meta(i, i.startsWith("T") ? "TRASH" : "INBOX")), notFound: [] }, "c0"]] });
    }
    throw new Error(`unexpected ${name}`);
  };
}

function seeded() {
  const db = openDb(tempDbPath());
  // Three rows the cache holds: A (still on the server), B (destroyed on the
  // server while the changes window lapsed), T1 (in Trash on the server --
  // must survive, the walk never sees it).
  storeEmails(db, "personal", [meta("A"), meta("B"), meta("T1", "TRASH")] as never);
  setSyncState(db, "personal", "email", "J1");
  setSyncState(db, "personal", "walk", "done");
  return db;
}

async function twoRefreshes(db: ReturnType<typeof openDb>, fetchImpl: (u: string, i: { body?: string }) => Promise<Response>) {
  const client = new JmapClient(session, "t", fetchImpl as never);
  const first = await refreshAccount(db, client, "personal", { paceMs: 0, sleep: async () => {} });
  const second = await refreshAccount(db, client, "personal", { paceMs: 0, sleep: async () => {} });
  return { first, second };
}

const ids = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT id FROM emails WHERE account = 'personal' ORDER BY id").all() as { id: string }[]).map((r) => r.id);

test("🚨 A RESYNC REMOVES ROWS THE SERVER NO LONGER HAS -- and keeps the ones it does, Trash included", async () => {
  const db = seeded();
  const { first, second } = await twoRefreshes(db, server(["A", "T1"]));
  assert.equal(first.resynced, true, "the first pass should have hit cannotCalculateChanges and resynced");
  assert.deepEqual(ids(db), ["A", "T1"], "B was destroyed on the server during the gap and must be gone; A and the trashed T1 must stay");
  assert.equal(second.reconciled, 1, "the pass line must say how many rows the reconcile removed");
  assert.equal(getSyncState(db, "personal", "reconcile"), null, "the pending flag must clear once reconciled");
  db.close();
});

test("a reconcile whose id listing FAILS partway deletes nothing", async () => {
  // All or nothing: a partial id set would look like a mass deletion.
  const db = seeded();
  // The walk's own query (filtered) succeeds; the unfiltered reconcile paging fails.
  await twoRefreshes(db, server(["A", "T1"], { failQueryAfter: 1 })).catch(() => {});
  assert.deepEqual(ids(db), ["A", "B", "T1"], "a failed reconcile must not delete anything");
  assert.equal(getSyncState(db, "personal", "reconcile"), "pending", "the flag stays pending so the next pass retries");
  db.close();
});

test("no resync, no reconcile: an ordinary pass never lists the whole server", async () => {
  const db = seeded();
  setSyncState(db, "personal", "email", "J5");  // a live cursor
  let unfiltered = 0;
  const base = server(["A", "T1"]);
  const client = new JmapClient(session, "t", (async (u: string, i: { body?: string }) => {
    const calls = JSON.parse(i.body ?? "{}").methodCalls;
    if (calls[0][0] === "Email/query" && !calls[0][1].filter) unfiltered += 1;
    return base(u, i);
  }) as never);
  const r = await refreshAccount(db, client, "personal", { paceMs: 0, sleep: async () => {} });
  assert.equal(r.reconciled, 0);
  assert.equal(unfiltered, 0, "an ordinary pass paged the entire account for no reason");
  assert.deepEqual(ids(db), ["A", "B", "T1"]);
  db.close();
});
