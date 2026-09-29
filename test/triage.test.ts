import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  expandConversations,
  scopedTargets,
  applyLocal,
  destinationFor,
  mailboxIdForRole,
  planAction,
  planRestore,
  snapshot,
  TriageError,
} from "../src/core/triage.ts";
import { readFileSync } from "node:fs";
import { assertNoMembershipDrift } from "./db-assertions.ts";

function db(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE emails (
      account TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT,
      received_at TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '', from_email TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '', body_text TEXT,
      is_unread INTEGER NOT NULL DEFAULT 0, is_flagged INTEGER NOT NULL DEFAULT 0,
      has_attachment INTEGER NOT NULL DEFAULT 0,
      keywords TEXT NOT NULL DEFAULT '{}', via TEXT, details_at TEXT, has_html INTEGER,
      PRIMARY KEY (account, id));
    CREATE TABLE mailboxes (
      account TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, role TEXT,
      parent_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      total_emails INTEGER NOT NULL DEFAULT 0, unread_emails INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, id));
    CREATE TABLE email_mailboxes (
      account TEXT NOT NULL, email_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
      received_at TEXT, thread_key TEXT,
      PRIMARY KEY (account, email_id, mailbox_id));
    CREATE TABLE settings (
      account TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (account, key));
  `);
  // Two accounts that SHARE mailbox ids -- Fastmail really does reuse "P-F"
  // as every account's inbox, which is what makes unscoped lookups dangerous.
  for (const acct of ["personal", "work"]) {
    d.prepare(`INSERT INTO mailboxes (account,id,name,role) VALUES (?,?,?,?)`).run(acct, "P-F", "Inbox", "inbox");
    d.prepare(`INSERT INTO mailboxes (account,id,name,role) VALUES (?,?,?,?)`).run(acct, "P2F", "Archive", "archive");
    d.prepare(`INSERT INTO mailboxes (account,id,name,role) VALUES (?,?,?,?)`).run(acct, "P6F", "Trash", "trash");
  }
  d.prepare(`INSERT INTO mailboxes (account,id,name,role) VALUES (?,?,?,?)`).run("personal", "LBL", "Receipts", null);
  d.prepare(`INSERT INTO mailboxes (account,id,name,role) VALUES (?,?,?,?)`).run("personal", "SPAM", "Identified Spam", null);
  d.prepare(
    `INSERT INTO settings (account,key,value,updated_at) VALUES ('personal','spamMailboxId','SPAM','2026-01-01T00:00:00Z')`,
  ).run();
  return d;
}

function addMessage(d: DatabaseSync, account: string, id: string, boxes: string[], kw: object): void {
  const receivedAt = "2026-01-01T00:00:00Z";
  d.prepare(
    `INSERT INTO emails (account,id,received_at,keywords,is_unread,is_flagged) VALUES (?,?,?,?,?,?)`,
  ).run(account, id, receivedAt, JSON.stringify(kw), "$seen" in kw ? 0 : 1, "$flagged" in kw ? 1 : 0);
  for (const b of boxes) {
    // Seeded to already match the email (thread_id is NULL here, so its own
    // id is the thread key) -- these rows are the pre-action state, and
    // assertNoMembershipDrift is checked AFTER an action, not before.
    d.prepare(
      `INSERT INTO email_mailboxes (account,email_id,mailbox_id,received_at,thread_key) VALUES (?,?,?,?,?)`,
    ).run(account, id, b, receivedAt, id);
  }
}

test("THIS MODULE NEVER DESTROYS MAIL — no `destroy` anywhere in the write path", () => {
  for (const f of ["src/core/triage.ts", "src/server/triage-api.ts"]) {
    const src = readFileSync(f, "utf8");
    // Strip comments, which discuss `destroy` deliberately.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/\bdestroy\b/.test(code), `${f} references destroy in code — trash must be a MOVE`);
  }
});

test("archive replaces every mailbox, not just the inbox", () => {
  const d = db();
  // A message in the inbox AND under a label: patching only the inbox away
  // would leave it visible under Receipts and archive would look broken.
  addMessage(d, "personal", "m1", ["P-F", "LBL"], {});
  const before = snapshot(d, "personal", "m1");
  assert.deepEqual(before.mailboxIds.sort(), ["LBL", "P-F"]);
  const dest = destinationFor(d, "personal", { kind: "move", role: "archive" });
  const plan = planAction(before, { kind: "move", role: "archive" }, dest);
  assert.deepEqual(plan.patch, { mailboxIds: { P2F: true } });
  assert.deepEqual(plan.mailboxIds, ["P2F"]);
});

test("undo restores every prior mailbox, not just one", () => {
  const d = db();
  addMessage(d, "personal", "m1", ["P-F", "LBL"], { $seen: true });
  const before = snapshot(d, "personal", "m1");
  const dest = destinationFor(d, "personal", { kind: "move", role: "trash" });
  applyLocal(d, "personal", "m1", planAction(before, { kind: "move", role: "trash" }, dest));
  assert.deepEqual(snapshot(d, "personal", "m1").mailboxIds, ["P6F"]);
  assertNoMembershipDrift(d);

  applyLocal(d, "personal", "m1", planRestore(before));
  const after = snapshot(d, "personal", "m1");
  assert.deepEqual(after.mailboxIds.sort(), ["LBL", "P-F"]);
  assert.deepEqual(after.keywords, { $seen: true });
  assertNoMembershipDrift(d);
});

test("archive keeps received_at/thread_key true on the rewritten membership row", () => {
  const d = db();
  addMessage(d, "personal", "m1", ["P-F", "LBL"], {});
  const before = snapshot(d, "personal", "m1");
  const dest = destinationFor(d, "personal", { kind: "move", role: "archive" });
  applyLocal(d, "personal", "m1", planAction(before, { kind: "move", role: "archive" }, dest));
  assert.deepEqual(snapshot(d, "personal", "m1").mailboxIds, ["P2F"]);
  assertNoMembershipDrift(d);
});

test("moveTo (a custom folder) keeps received_at/thread_key true", () => {
  const d = db();
  addMessage(d, "personal", "m1", ["P-F"], {});
  const before = snapshot(d, "personal", "m1");
  const dest = destinationFor(d, "personal", { kind: "moveTo", mailboxId: "LBL" });
  applyLocal(d, "personal", "m1", planAction(before, { kind: "moveTo", mailboxId: "LBL" }, dest));
  assert.deepEqual(snapshot(d, "personal", "m1").mailboxIds, ["LBL"]);
  assertNoMembershipDrift(d);
});

test("spam keeps received_at/thread_key true", () => {
  const d = db();
  addMessage(d, "personal", "m1", ["P-F"], {});
  const before = snapshot(d, "personal", "m1");
  const dest = destinationFor(d, "personal", { kind: "spam" });
  applyLocal(d, "personal", "m1", planAction(before, { kind: "spam" }, dest));
  assert.deepEqual(snapshot(d, "personal", "m1").mailboxIds, ["SPAM"]);
  assertNoMembershipDrift(d);
});

test("delete (move to trash) keeps received_at/thread_key true", () => {
  const d = db();
  addMessage(d, "personal", "m1", ["P-F"], {});
  const before = snapshot(d, "personal", "m1");
  const dest = destinationFor(d, "personal", { kind: "move", role: "trash" });
  applyLocal(d, "personal", "m1", planAction(before, { kind: "move", role: "trash" }, dest));
  assert.deepEqual(snapshot(d, "personal", "m1").mailboxIds, ["P6F"]);
  assertNoMembershipDrift(d);
});

test("a mailbox id from ANOTHER account is refused", () => {
  const d = db();
  // "LBL" exists, but only under personal. Work must not reach it.
  assert.throws(
    () => destinationFor(d, "work", { kind: "moveTo", mailboxId: "LBL" }),
    TriageError,
  );
  // ...and the same id resolves fine for the account that owns it.
  assert.equal(destinationFor(d, "personal", { kind: "moveTo", mailboxId: "LBL" }), "LBL");
});

test("flag and read keep the derived columns consistent with keywords", () => {
  const d = db();
  addMessage(d, "personal", "m1", ["P-F"], {});
  const row = () =>
    d.prepare(`SELECT keywords, is_unread, is_flagged FROM emails WHERE id='m1'`).get() as {
      keywords: string;
      is_unread: number;
      is_flagged: number;
    };
  assert.equal(row().is_unread, 1);

  applyLocal(d, "personal", "m1", planAction(snapshot(d, "personal", "m1"), { kind: "read", value: true }));
  assert.equal(row().is_unread, 0, "marking read must clear is_unread, not just keywords");
  assert.deepEqual(JSON.parse(row().keywords), { $seen: true });

  applyLocal(d, "personal", "m1", planAction(snapshot(d, "personal", "m1"), { kind: "flag", value: true }));
  assert.equal(row().is_flagged, 1);
  assert.deepEqual(JSON.parse(row().keywords), { $seen: true, $flagged: true }, "flag must not drop $seen");

  applyLocal(d, "personal", "m1", planAction(snapshot(d, "personal", "m1"), { kind: "flag", value: false }));
  assert.equal(row().is_flagged, 0);
  assert.deepEqual(JSON.parse(row().keywords), { $seen: true }, "unflag must keep $seen");
});

test("unflagging sends null, which is how JMAP removes a keyword", () => {
  const d = db();
  addMessage(d, "personal", "m1", ["P-F"], { $flagged: true });
  const plan = planAction(snapshot(d, "personal", "m1"), { kind: "flag", value: false });
  assert.deepEqual(plan.patch, { "keywords/$flagged": null });
});

test("a malformed keywords blob degrades to empty rather than throwing", () => {
  const d = db();
  addMessage(d, "personal", "m1", ["P-F"], {});
  d.prepare(`UPDATE emails SET keywords='{not json' WHERE id='m1'`).run();
  assert.deepEqual(snapshot(d, "personal", "m1").keywords, {});
});

test("an unknown role is refused rather than guessed", () => {
  const d = db();
  assert.throws(() => mailboxIdForRole(d, "personal", "nope"), TriageError);
});

test("snapshot of a message that does not exist is an error, not an empty state", () => {
  const d = db();
  assert.throws(() => snapshot(d, "personal", "ghost"), TriageError);
});

// -- Row 58: archive and move act on the CONVERSATION; delete and spam on the
// message (owner ruling 2026-09-15). The list shows one row per conversation
// (read-api collapses on COALESCE(thread_id, id)); a triage that moved only
// the representative left the row standing on its siblings, and "I archived
// it twice and it came back" was the report. --

function addThreaded(d: DatabaseSync, account: string, id: string, thread: string | null, boxes: string[]): void {
  const receivedAt = "2026-01-01T00:00:00Z";
  d.prepare(`INSERT INTO emails (account,id,thread_id,received_at) VALUES (?,?,?,?)`).run(account, id, thread, receivedAt);
  const threadKey = thread ?? id;
  for (const b of boxes) {
    d.prepare(
      `INSERT INTO email_mailboxes (account,email_id,mailbox_id,received_at,thread_key) VALUES (?,?,?,?,?)`,
    ).run(account, id, b, receivedAt, threadKey);
  }
}

test("🚨 conversation scope expands a target to every sibling IN THE VIEWED FOLDER", () => {
  const d = db();
  addThreaded(d, "personal", "t1", "T", ["P-F"]); // inbox
  addThreaded(d, "personal", "t2", "T", ["P-F", "LBL"]); // inbox + label
  addThreaded(d, "personal", "t3", "T", ["P2F"]); // already archived: NOT in the view
  addThreaded(d, "personal", "t4", "T", ["P6F"]); // in trash: not in the view
  addThreaded(d, "personal", "u1", "U", ["P-F"]); // another conversation
  const out = expandConversations(d, [{ account: "personal", id: "t1" }], { kind: "conversation", role: "inbox" });
  assert.deepEqual(
    out.map((t) => t.id).sort(),
    ["t1", "t2"],
    "the inbox siblings of t1, and only those, must be in the batch",
  );
});

test("conversation scope by mailbox id (a custom folder), scoped to the target's account", () => {
  const d = db();
  addThreaded(d, "personal", "t1", "T", ["LBL"]);
  addThreaded(d, "personal", "t2", "T", ["LBL"]);
  addThreaded(d, "work", "t1", "T", ["P-F"]); // same ids, other account: never touched
  const out = expandConversations(d, [{ account: "personal", id: "t1" }], { kind: "conversation", mailboxId: "LBL" });
  assert.deepEqual(out, [{ account: "personal", id: "t1" }, { account: "personal", id: "t2" }]);
});

test("an unthreaded message, or one whose thread has no other member in view, expands to itself; duplicates collapse", () => {
  const d = db();
  addThreaded(d, "personal", "solo", null, ["P-F"]);
  addThreaded(d, "personal", "t1", "T", ["P-F"]);
  addThreaded(d, "personal", "t2", "T", ["P-F"]);
  const out = expandConversations(
    d,
    [{ account: "personal", id: "solo" }, { account: "personal", id: "t1" }, { account: "personal", id: "t2" }],
    { kind: "conversation", role: "inbox" },
  );
  assert.deepEqual(out.map((t) => t.id), ["solo", "t1", "t2"], "every member once, in first-seen order");
});

test("🚨 the route expands a MOVE with conversation scope, and NEVER a trash move or spam (the ruling)", () => {
  // The client is told not to send a scope for delete and spam; the server
  // holds the ruling on its own so a client that did could not delete a
  // whole conversation with one `#`.
  const d = db();
  addThreaded(d, "personal", "t1", "T", ["P-F"]);
  addThreaded(d, "personal", "t2", "T", ["P-F"]);
  const scope = { kind: "conversation" as const, role: "inbox" };
  const one = [{ account: "personal", id: "t1" }];
  assert.equal(scopedTargets(d, { kind: "move", role: "archive" }, one, scope).length, 2);
  assert.equal(scopedTargets(d, { kind: "moveTo", mailboxId: "LBL" }, one, scope).length, 2);
  assert.equal(scopedTargets(d, { kind: "move", role: "trash" }, one, scope).length, 1, "delete acts on the message only");
  assert.equal(scopedTargets(d, { kind: "spam" }, one, scope).length, 1, "spam acts on the message only");
  assert.equal(scopedTargets(d, { kind: "read", value: true }, one, scope).length, 1);
  assert.equal(scopedTargets(d, { kind: "move", role: "archive" }, one, undefined).length, 1, "no scope, no expansion");
});
