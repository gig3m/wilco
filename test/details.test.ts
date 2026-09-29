import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.ts";
import {
  undetailedIds, writeDetails, backfillDetails, deriveVia, resetDetails, fetchOwnAddresses,
} from "../src/core/details.ts";
import { JmapClient } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import { tempDbPath } from "./tmpdir.ts";

function freshDb(): DatabaseSync {
  return openDb(tempDbPath());
}

/** Minimal row -- only what the FK from email_recipients/email_attachments
 *  needs, plus the columns details.ts touches. */
function seedEmail(db: DatabaseSync, account: string, id: string): void {
  db.prepare(
    `INSERT INTO emails (account, id, received_at) VALUES (?, ?, ?)`,
  ).run(account, id, "2026-01-01T00:00:00Z");
}

test("details are written for a message with recipients and an attachment", () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  writeDetails(db, "personal", [{
    id: "M1",
    to: [{ name: "Robin", email: "Robin@Halden.EXAMPLE" }],
    cc: [{ name: "", email: "team@society.example" }],
    bcc: [], replyTo: [],
    attachments: [{ partId: "2", name: "budget.pdf", type: "application/pdf", size: 1024, cid: null }],
    via: null, hasHtml: false,
  }]);

  // node:sqlite hands back null-prototype row objects, so spread each row
  // into a plain object first -- otherwise deepEqual fails on the prototype
  // alone even when every field matches (see mutations.test.ts, which never
  // deepEquals a whole row for the same reason).
  const rec = (db.prepare(
    "SELECT kind, name, email FROM email_recipients WHERE account='personal' AND email_id='M1' ORDER BY kind, email",
  ).all() as { kind: string; name: string; email: string }[]).map((r) => ({ ...r }));
  assert.deepEqual(rec, [
    { kind: "cc", name: "", email: "team@society.example" },
    { kind: "to", name: "Robin", email: "robin@halden.example" },
  ], "addresses are lowercased on write so to:/cc: need no COLLATE");

  const att = (db.prepare(
    "SELECT part_id, name, size FROM email_attachments WHERE account='personal' AND email_id='M1'",
  ).all() as { part_id: string; name: string; size: number }[]).map((r) => ({ ...r }));
  assert.deepEqual(att, [{ part_id: "2", name: "budget.pdf", size: 1024 }]);

  const { details_at } = db.prepare(
    "SELECT details_at FROM emails WHERE account='personal' AND id='M1'",
  ).get() as { details_at: string | null };
  assert.notEqual(details_at, null, "details_at is set even though nothing was missing");
});

test("writeDetails stores has_html 1 or 0 in the SAME transaction as details_at, never leaving it unset", () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  seedEmail(db, "personal", "M2");
  writeDetails(db, "personal", [
    { id: "M1", to: [], cc: [], bcc: [], replyTo: [], attachments: [], via: null, hasHtml: true },
    { id: "M2", to: [], cc: [], bcc: [], replyTo: [], attachments: [], via: null, hasHtml: false },
  ]);

  const rows = db.prepare(
    "SELECT id, has_html, details_at FROM emails WHERE account='personal' ORDER BY id",
  ).all() as { id: string; has_html: number | null; details_at: string | null }[];
  assert.equal(rows[0]!.has_html, 1, "a message with an HTML part stores 1");
  assert.notEqual(rows[0]!.details_at, null, "has_html and details_at land together");
  assert.equal(rows[1]!.has_html, 0, "a message with no HTML part stores 0, not NULL");
  assert.notEqual(rows[1]!.details_at, null);
});

test("A MESSAGE WITH NO RECIPIENTS AND NO ATTACHMENTS IS STILL MARKED DETAILED", () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  writeDetails(db, "personal", [{
    id: "M1", to: [], cc: [], bcc: [], replyTo: [], attachments: [], via: null, hasHtml: false,
  }]);
  assert.deepEqual(undetailedIds(db, "personal", 10), [],
    "an empty message is not offered for backfill a second time");
});

test("rewriting details replaces rather than duplicates", () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  const once = { id: "M1", to: [{ name: "K", email: "k@x.test" }], cc: [], bcc: [], replyTo: [], attachments: [], via: null, hasHtml: false };
  writeDetails(db, "personal", [once]);
  writeDetails(db, "personal", [once]);
  const { c } = db.prepare(
    "SELECT count(*) AS c FROM email_recipients WHERE account='personal' AND email_id='M1'",
  ).get() as { c: number };
  assert.equal(c, 1, "a re-run must not double the recipient rows");
});

test("undetailedIds is scoped per account", () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  seedEmail(db, "work", "M1");           // same id, different account (spec 4.2)
  writeDetails(db, "personal", [{ id: "M1", to: [], cc: [], bcc: [], replyTo: [], attachments: [], via: null, hasHtml: false }]);
  assert.deepEqual(undetailedIds(db, "personal", 10), []);
  assert.deepEqual(undetailedIds(db, "work", 10), ["M1"],
    "the same id in another account is a different message");
});

test("via is set only when none of your own addresses is in to or cc", () => {
  assert.equal(
    deriveVia({ to: [{ name: "", email: "robin@halden.example" }], cc: [] },
              { "delivered-to": "list@example.test" },
              new Set(["robin@halden.example"])),
    null, "your address is right there in To -- Via would be noise");
  assert.equal(
    deriveVia({ to: [{ name: "", email: "list@example.test" }], cc: [] },
              { "delivered-to": "robin+news@halden.example" },
              new Set(["robin@halden.example"])),
    "robin+news@halden.example", "nothing of yours in To/Cc -- this is the only clue");
});

test("A BATCH THAT MAKES NO PROGRESS STOPS INSTEAD OF LOOPING", async () => {
  // The same guard walkArchive carries. A server that keeps returning the
  // same page, or returns fewer rows than asked for without advancing, must
  // end the run with a diagnostic -- not spin against Fastmail forever.
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  const client = { request: async () => [["Email/get", { list: [] }, "c0"]] };
  await assert.rejects(
    () => backfillDetails(db, client as never, "personal"),
    /made no progress/,
  );
});

test("backfillDetails returns 0 and does nothing when there is nothing to detail", async () => {
  const db = freshDb();
  let calls = 0;
  const client = { request: async () => { calls += 1; return []; } };
  const n = await backfillDetails(db, client as never, "personal");
  assert.equal(n, 0);
  assert.equal(calls, 0, "no request is made when undetailedIds is already empty");
});

test("backfillDetails writes details for a real batch and returns the count", async () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  seedEmail(db, "personal", "M2");
  const client = {
    request: async () => [["Email/get", {
      list: [
        { id: "M1", to: [{ name: "A", email: "a@x.test" }], cc: [], bcc: [], replyTo: [], attachments: [] },
        { id: "M2", to: [], cc: [], bcc: [], replyTo: [], attachments: [] },
      ],
    }, "c0"]],
  };
  const n = await backfillDetails(db, client as never, "personal");
  assert.equal(n, 2);
  assert.deepEqual(undetailedIds(db, "personal", 10), []);
});

test("backfillDetails calls onProgress at least once when it stores a batch", async () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  seedEmail(db, "personal", "M2");
  const client = {
    request: async () => [["Email/get", {
      list: [
        { id: "M1", to: [{ name: "A", email: "a@x.test" }], cc: [], bcc: [], replyTo: [], attachments: [] },
        { id: "M2", to: [], cc: [], bcc: [], replyTo: [], attachments: [] },
      ],
    }, "c0"]],
  };
  let ticks = 0;
  const n = await backfillDetails(db, client as never, "personal", {
    onProgress: (...args: unknown[]) => {
      ticks += 1;
      assert.equal(args.length, 0, "onProgress is () => void -- it must be called with no arguments");
    },
  });
  assert.equal(n, 2);
  assert.ok(ticks >= 1, `expected at least one onProgress tick, got ${ticks}`);
});

test("🚨 A PLAINTEXT-ONLY MESSAGE IS NOT AN HTML MESSAGE, however htmlBody is spelled", async () => {
  // 🚨 The defect this pins, measured on the live archive: has_html was 1
  // for 37,740 of 37,784 messages (99.9%), because it was derived from
  // `htmlBody.length > 0`. JMAP's `htmlBody` is the list of parts to
  // DISPLAY as the body when a client prefers HTML -- for a message with
  // only a text/plain part, that list contains THE TEXT/PLAIN PART. So
  // nearly every message claimed HTML, and every plaintext one was then
  // rendered through the HTML pipeline: newlines collapsed into a single
  // wall of text, and `<someone@example.com>` / `<https://...>` eaten as
  // tags by the sanitizer. Found on a real sent reply that arrived
  // unreadable.
  //
  // The same trap in the other direction ("textBody is NOT the
  // text/plain parts") put raw markup in body_text for ~15% of the
  // archive. Both are fixed the same way: classify on the part's own
  // `type`, never on which list it arrived in.
  //
  // The pre-existing test below could not catch this: its fixture happened
  // to spell `type: "text/html"`, so it passed identically with the type
  // ignored.
  const db = freshDb();
  seedEmail(db, "personal", "P1");
  seedEmail(db, "personal", "P2");
  const client = {
    request: async () => [["Email/get", {
      list: [
        // The shape Fastmail returns for a plaintext-only message.
        { id: "P1", to: [], cc: [], bcc: [], replyTo: [], attachments: [], htmlBody: [{ partId: "1", type: "text/plain" }] },
        // A real multipart/alternative: both lists are non-empty, and the
        // htmlBody entry is genuinely text/html.
        { id: "P2", to: [], cc: [], bcc: [], replyTo: [], attachments: [], htmlBody: [{ partId: "2", type: "text/html" }] },
      ],
    }, "c0"]],
  };
  await backfillDetails(db, client as never, "personal");
  const rows = db.prepare("SELECT id, has_html FROM emails WHERE account='personal' ORDER BY id").all();
  assert.deepEqual(
    rows.map((r: any) => ({ id: r.id, has_html: r.has_html })),
    [{ id: "P1", has_html: 0 }, { id: "P2", has_html: 1 }],
    "a text/plain part listed under htmlBody was counted as HTML",
  );
});

test("backfillDetails derives has_html from a non-empty htmlBody, and 0 when htmlBody is empty or absent", async () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1"); // has an htmlBody entry
  seedEmail(db, "personal", "M2"); // htmlBody: []
  seedEmail(db, "personal", "M3"); // htmlBody omitted entirely
  const client = {
    request: async () => [["Email/get", {
      list: [
        { id: "M1", to: [], cc: [], bcc: [], replyTo: [], attachments: [], htmlBody: [{ partId: "1", type: "text/html" }] },
        { id: "M2", to: [], cc: [], bcc: [], replyTo: [], attachments: [], htmlBody: [] },
        { id: "M3", to: [], cc: [], bcc: [], replyTo: [], attachments: [] },
      ],
    }, "c0"]],
  };
  await backfillDetails(db, client as never, "personal");

  const rows = (db.prepare(
    "SELECT id, has_html FROM emails WHERE account='personal' ORDER BY id",
  ).all() as { id: string; has_html: number | null }[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { id: "M1", has_html: 1 },
    { id: "M2", has_html: 0 },
    { id: "M3", has_html: 0 },
  ]);
});

test("maxBatches bounds the run to one batch even with more work remaining", async () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  seedEmail(db, "personal", "M2");
  let calls = 0;
  const client = {
    request: async () => {
      calls += 1;
      return [["Email/get", { list: [{ id: "M1", to: [], cc: [], bcc: [], replyTo: [], attachments: [] }] }, "c0"]];
    },
  };
  const n = await backfillDetails(db, client as never, "personal", { batchSize: 1, maxBatches: 1 });
  assert.equal(n, 1);
  assert.equal(calls, 1);
  assert.deepEqual(undetailedIds(db, "personal", 10), ["M2"], "M2 is left for the next pass");
});

// -- Review fix round 1 --------------------------------------------------

test("Critical 1: deriveVia never stores Via when ownAddresses is empty, even with a candidate header present", () => {
  assert.equal(
    deriveVia(
      { to: [{ name: "", email: "list@example.test" }], cc: [] },
      { "delivered-to": "robin+news@halden.example" },
      new Set(),
    ),
    null,
    "an empty set means 'we don't know who you are yet', not 'you're nowhere in this message' -- " +
      "writing a guess to nearly every message is worse than writing nothing",
  );
});

test("deriveVia's header priority: Delivered-To beats X-Delivered-To beats X-Original-To beats Envelope-To", () => {
  const to = { to: [], cc: [] };
  const own = new Set(["robin@halden.example"]);
  assert.equal(
    deriveVia(to, {
      "delivered-to": "a@example.test",
      "x-delivered-to": "b@example.test",
      "x-original-to": "c@example.test",
      "envelope-to": "d@example.test",
    }, own),
    "a@example.test",
  );
  assert.equal(
    deriveVia(to, {
      "delivered-to": "",
      "x-delivered-to": "b@example.test",
      "x-original-to": "c@example.test",
      "envelope-to": "d@example.test",
    }, own),
    "b@example.test",
    "a blank Delivered-To (fetched but empty) is skipped, not treated as present",
  );
  assert.equal(
    deriveVia(to, { "x-original-to": "c@example.test", "envelope-to": "d@example.test" }, own),
    "c@example.test",
  );
  assert.equal(
    deriveVia(to, { "envelope-to": "d@example.test" }, own),
    "d@example.test",
    "Envelope-To is the last resort",
  );
});

test("writeDetails persists `via` on the emails row, not just in the MessageDetails it was given", () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  writeDetails(db, "personal", [{
    id: "M1", to: [], cc: [], bcc: [], replyTo: [], attachments: [],
    via: "robin+news@halden.example", hasHtml: false,
  }]);
  const row = db.prepare("SELECT via FROM emails WHERE account='personal' AND id='M1'").get() as { via: string | null };
  assert.equal(row.via, "robin+news@halden.example");
});

test("cid distinguishes an inline image from a real attachment, and round-trips exactly", () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  writeDetails(db, "personal", [{
    id: "M1", to: [], cc: [], bcc: [], replyTo: [],
    attachments: [
      { partId: "2", name: "budget.pdf", type: "application/pdf", size: 1024, cid: null },
      { partId: "3", name: "logo.png", type: "image/png", size: 512, cid: "logo123@wilco" },
    ],
    via: null, hasHtml: false,
  }]);

  const rows = (db.prepare(
    "SELECT part_id, cid FROM email_attachments WHERE account='personal' AND email_id='M1' ORDER BY part_id",
  ).all() as { part_id: string; cid: string | null }[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { part_id: "2", cid: null },
    { part_id: "3", cid: "logo123@wilco" },
  ]);

  // The rule Task 4's has:attachment is built on: a real attachment has
  // cid IS NULL, an inline part does not -- and this must be an indexed,
  // queryable distinction, not something the reader infers.
  const { real } = db.prepare(
    "SELECT count(*) AS real FROM email_attachments WHERE account='personal' AND email_id='M1' AND cid IS NULL",
  ).get() as { real: number };
  assert.equal(real, 1, "only the non-inline part counts as a real attachment");
});

test("Important 2: a duplicate/empty partId is skipped, not a batch-aborting constraint error", () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  // Two attachment parts that both resolve to an empty partId (a malformed
  // or unusual upstream message) collide on the (account, email_id,
  // part_id) primary key. This must not throw -- one insert is silently
  // dropped, the rest of the message (and batch) still gets written.
  const errors: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    writeDetails(db, "personal", [{
      id: "M1", to: [{ name: "K", email: "k@x.test" }], cc: [], bcc: [], replyTo: [],
      attachments: [
        { partId: "", name: "first.bin", type: "application/octet-stream", size: 1, cid: null },
        { partId: "", name: "second.bin", type: "application/octet-stream", size: 2, cid: null },
      ],
      via: null, hasHtml: false,
    }]);
  } finally {
    console.error = origError;
  }

  const { details_at } = db.prepare(
    "SELECT details_at FROM emails WHERE account='personal' AND id='M1'",
  ).get() as { details_at: string | null };
  assert.notEqual(details_at, null, "the message is still marked detailed despite the colliding part");

  const { c } = db.prepare(
    "SELECT count(*) AS c FROM email_recipients WHERE account='personal' AND email_id='M1'",
  ).get() as { c: number };
  assert.equal(c, 1, "the recipient row -- unrelated to the attachment collision -- still made it in");

  // Fix wave, finding 8: the drop must not be invisible.
  assert.equal(errors.length, 1, "the dropped duplicate must produce exactly one trace line");
  assert.match(String(errors[0]?.[0]), /dropped duplicate attachment/);
  assert.match(String(errors[0]?.[0]), /email=M1/);
});

test("Critical 2: an id the server reports in notFound is marked detailed, not left to wedge the tail forever", async () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");   // will come back in `list`
  seedEmail(db, "personal", "GONE"); // destroyed server-side between the walk and this backfill

  const client = {
    request: async () => [["Email/get", {
      list: [{ id: "M1", to: [], cc: [], bcc: [], replyTo: [], attachments: [] }],
      notFound: ["GONE"],
    }, "c0"]],
  };

  const n = await backfillDetails(db, client as never, "personal");
  assert.equal(n, 2, "both the real message and the reported-gone one count as detailed");
  assert.deepEqual(undetailedIds(db, "personal", 10), [],
    "GONE does not shrink into its own batch and wedge every future pass");

  const gone = db.prepare(
    "SELECT via, details_at FROM emails WHERE account='personal' AND id='GONE'",
  ).get() as { via: string | null; details_at: string | null };
  assert.equal(gone.via, null);
  assert.notEqual(gone.details_at, null);
});

test("Critical 2: a whole-batch-empty response with NO notFound still throws (the guard is not weakened)", async () => {
  // Same shape as the brief's own progress-guard test -- confirms the
  // notFound fallback did not quietly swallow the case a server that is
  // genuinely broken or unreachable must still be loud about.
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  const client = { request: async () => [["Email/get", { list: [], notFound: [] }, "c0"]] };
  await assert.rejects(
    () => backfillDetails(db, client as never, "personal"),
    /made no progress/,
  );
});

test("resetDetails clears via/details_at so the next backfill pass re-fetches, and reports the count", () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  seedEmail(db, "personal", "M2");
  writeDetails(db, "personal", [
    { id: "M1", to: [], cc: [], bcc: [], replyTo: [], attachments: [], via: "wrong@guess.test", hasHtml: true },
    { id: "M2", to: [], cc: [], bcc: [], replyTo: [], attachments: [], via: null, hasHtml: false },
  ]);
  assert.deepEqual(undetailedIds(db, "personal", 10), [], "both are detailed before the reset");

  const changed = resetDetails(db, "personal");
  assert.equal(changed, 2);

  const row = db.prepare("SELECT via, details_at, has_html FROM emails WHERE account='personal' AND id='M1'").get() as
    { via: string | null; details_at: string | null; has_html: number | null };
  assert.equal(row.via, null, "the wrong Via is cleared immediately, not left to wait for the next backfill");
  assert.equal(row.details_at, null);
  assert.equal(row.has_html, null, "a reset leaves no stale has_html behind either -- it goes back to 'never looked'");
  assert.deepEqual(new Set(undetailedIds(db, "personal", 10)), new Set(["M1", "M2"]),
    "both rows are back in front of the backfill");
});

test("resetDetails on an account with nothing detailed yet is a harmless no-op", () => {
  const db = freshDb();
  seedEmail(db, "personal", "M1");
  assert.equal(resetDetails(db, "personal"), 0);
});

test("fetchOwnAddresses reads Identity/get, lowercases, and drops blank emails", async () => {
  const session = resolveSession("personal", personalSession);
  const client = new JmapClient(session, "t", async () => new Response(
    JSON.stringify({
      methodResponses: [["Identity/get", {
        list: [
          { id: "i1", email: "Robin@Halden.EXAMPLE" },
          { id: "i2", email: "robin+news@halden.example" },
          { id: "i3", email: "" },
          { id: "i4" },
        ],
      }, "c0"]],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));

  const addrs = await fetchOwnAddresses(client);
  assert.deepEqual(addrs, new Set(["robin@halden.example", "robin+news@halden.example"]));
});

test("fetchOwnAddresses never throws on a malformed/empty response -- it yields an empty set", async () => {
  const session = resolveSession("personal", personalSession);
  const client = new JmapClient(session, "t", async () => new Response(
    JSON.stringify({ methodResponses: [["Identity/get", {}, "c0"]] }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  const addrs = await fetchOwnAddresses(client);
  assert.deepEqual(addrs, new Set());
});
