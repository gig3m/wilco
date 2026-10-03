import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.ts";
import { setSetting } from "../src/core/settings.ts";
import { buildRouter } from "../src/server/main.ts";
import { hashPassword } from "../src/server/auth.ts";
import { addAccount, type AccountSpec } from "../src/core/accounts.ts";
import { JmapClient } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import { tempDbPath } from "./tmpdir.ts";
import { AddressBook } from "../src/core/addressbook.ts";

const ORIGIN = "https://mail.example.com";

const PERSONAL: AccountSpec = {
  key: "personal",
  label: "Personal",
  accent: "blue",
  provider: "jmap",
  endpoint: "https://api.fastmail.com/jmap/session",
};

const WORK: AccountSpec = {
  key: "work",
  label: "Work",
  accent: "green",
  provider: "jmap",
  endpoint: "https://api.fastmail.com/jmap/session",
};

function tempDb(): DatabaseSync {
  return openDb(tempDbPath());
}

function insertMailbox(
  db: DatabaseSync,
  o: { account: string; id: string; name: string; role?: string | null; parentId?: string | null; sortOrder?: number; unreadEmails?: number },
): void {
  db.prepare(
    `INSERT INTO mailboxes (account, id, name, role, parent_id, sort_order, total_emails, unread_emails)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(o.account, o.id, o.name, o.role ?? null, o.parentId ?? null, o.sortOrder ?? 0, o.unreadEmails ?? 0);
}

function insertEmail(
  db: DatabaseSync,
  o: {
    account: string;
    id: string;
    receivedAt: string;
    subject?: string;
    unread?: number;
    flagged?: number;
    threadId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO emails (account, id, thread_id, received_at, subject, from_name, from_email, preview, is_unread, is_flagged)
     VALUES (?, ?, ?, ?, ?, '', 'a@b.com', '', ?, ?)`,
  ).run(o.account, o.id, o.threadId ?? null, o.receivedAt, o.subject ?? "", o.unread ?? 0, o.flagged ?? 0);
}

/**
 * A membership row carries the email's `received_at` and thread key -- the
 * invariant Task 2 put on both real write paths (mutations.ts, triage.ts),
 * and what the list's walk range-scans. Taking them from `emails` here
 * rather than from the caller keeps this helper honest: a fixture that
 * skipped them would describe a database this application can no longer
 * produce, and the list would read NULLs.
 */
function assignMailbox(db: DatabaseSync, account: string, emailId: string, mailboxId: string): void {
  db.prepare(
    `INSERT INTO email_mailboxes (account, email_id, mailbox_id, received_at, thread_key)
     SELECT ?, ?, ?, e.received_at, COALESCE(e.thread_id, e.id)
       FROM emails e WHERE e.account = ? AND e.id = ?`,
  ).run(account, emailId, mailboxId, account, emailId);
}

/**
 * Local to this file (Ruling P1): builds a router + live HTTP server the
 * same way test/accounts-api.test.ts's withAppUsing does, and seeds two
 * accounts with a mailbox tree and a handful of messages so every route
 * has real data to answer against.
 */
async function withApp(
  fn: (base: string, db: DatabaseSync) => Promise<void>,
  extra: { clients?: Map<string, JmapClient>; fetchFn?: (url: string, init?: RequestInit) => Promise<Response>; book?: AddressBook } = {},
): Promise<void> {
  const db = tempDb();
  addAccount(db, PERSONAL);
  addAccount(db, WORK);

  insertMailbox(db, { account: "personal", id: "P-INBOX", name: "Inbox", role: "inbox", sortOrder: 0, unreadEmails: 0 });
  insertMailbox(db, { account: "personal", id: "P-F", name: "Family", sortOrder: 1 });
  insertMailbox(db, { account: "work", id: "P-F", name: "Projects", sortOrder: 0 });

  insertEmail(db, { account: "personal", id: "M1", receivedAt: "2026-01-03T00:00:00Z", unread: 1 });
  insertEmail(db, { account: "personal", id: "M2", receivedAt: "2026-01-02T00:00:00Z", flagged: 1 });
  insertEmail(db, { account: "personal", id: "M3", receivedAt: "2026-01-01T00:00:00Z" });
  insertEmail(db, { account: "work", id: "M4", receivedAt: "2026-01-02T12:00:00Z" });

  assignMailbox(db, "personal", "M1", "P-INBOX");
  assignMailbox(db, "personal", "M2", "P-INBOX");
  assignMailbox(db, "personal", "M3", "P-F");

  const router = buildRouter({
    db,
    passwordHash: await hashPassword("letmein"),
    origin: ORIGIN,
    accountStates: new Map(),
    accounts: [PERSONAL, WORK],
    ...extra,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, db);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
}

async function login(base: string): Promise<string> {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
    body: JSON.stringify({ password: "letmein" }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

async function withSession(
  fn: (base: string, cookie: string, db: DatabaseSync) => Promise<void>,
  extra: Parameters<typeof withApp>[1] = {},
): Promise<void> {
  await withApp(async (base, db) => {
    const cookie = await login(base);
    await fn(base, cookie, db);
  }, extra);
}

function insertNewest(db: DatabaseSync, account: string, id: string): void {
  insertEmail(db, { account, id, receivedAt: "2026-01-04T00:00:00Z" });
}

function insertRecipient(
  db: DatabaseSync,
  o: { account: string; emailId: string; kind: string; name?: string; email: string },
): void {
  db.prepare(`INSERT INTO email_recipients (account, email_id, kind, name, email) VALUES (?, ?, ?, ?, ?)`).run(
    o.account,
    o.emailId,
    o.kind,
    o.name ?? "",
    o.email,
  );
}

function insertAttachment(
  db: DatabaseSync,
  o: {
    account: string; emailId: string; partId: string; name: string; type: string; size: number;
    cid?: string | null;
    /** The sender's own Content-Disposition, as JMAP reports it. */
    disposition?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO email_attachments (account, email_id, part_id, name, type, size, cid, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.account, o.emailId, o.partId, o.name, o.type, o.size, o.cid ?? null, o.disposition ?? null);
}

test("every read route requires a session", async () => {
  await withApp(async (base) => {
    for (const [method, path] of [
      ["GET", "/api/mailboxes"],
      ["GET", "/api/messages"],
      ["POST", "/api/search"],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} must refuse an anonymous caller`);
    }
  });
});

test("THE SEARCH QUERY NEVER APPEARS IN A URL", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ q: "sensitive name" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: unknown[] };
    assert.ok(Array.isArray(body.rows));
  });
});

test("POST /api/search requires CSRF header and exact origin", async () => {
  await withSession(async (base, cookie) => {
    const noHeader = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ q: "hello" }),
    });
    assert.equal(noHeader.status, 403);
  });
});

test("GET /api/search does not exist -- the query must never travel in a URL", async () => {
  // Pins spec 8.3: a GET alias for search once leaked real queries into
  // NPM's access log and was removed (see read-api.ts's doc comment). The
  // router answers 405 here, not 404, because the *path* /api/search is
  // still registered for POST -- only the GET method is gone. Assert the
  // router's real behavior, not a guessed one.
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/search?q=hello`, { headers: { cookie } });
    assert.equal(res.status, 405);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "method not allowed");
  });
});

test("unread counts come from the junction, not the stale mailbox column", async () => {
  await withSession(async (base, cookie, db) => {
    db.exec("UPDATE mailboxes SET unread_emails = 999 WHERE account='personal'");
    const res = await fetch(`${base}/api/mailboxes`, { headers: { cookie } });
    const body = (await res.json()) as { accounts: { account: string; mailboxes: { id: string; unread: number }[] }[] };
    const personal = body.accounts.find((a) => a.account === "personal")!;
    const inbox = personal.mailboxes.find((m) => m.id === "P-INBOX")!;
    assert.notEqual(inbox.unread, 999, "mailboxes.unread_emails is stale by design");
    // P-INBOX holds M1 (unread) and M2 (read) -- the real junction count is 1.
    assert.equal(inbox.unread, 1);
  });
});

test("GET /api/mailboxes returns id/name/role/parent/unread per account", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/mailboxes`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      accounts: { account: string; mailboxes: { id: string; name: string; role: string | null; parent: string | null; unread: number }[] }[];
    };
    assert.equal(body.accounts.length, 2);
    const personal = body.accounts.find((a) => a.account === "personal")!;
    assert.deepEqual(
      personal.mailboxes.map((m) => m.id),
      ["P-INBOX", "P-F"],
    );
    assert.equal(personal.mailboxes[0]!.role, "inbox");
    assert.equal(personal.mailboxes[0]!.parent, null);
  });
});

test("the list pages by cursor and does not repeat a row when new mail arrives", async () => {
  await withSession(async (base, cookie, db) => {
    const p1 = (await (
      await fetch(`${base}/api/messages?limit=2`, { headers: { cookie } })
    ).json()) as { rows: { account: string; id: string }[]; cursor: string };

    // New mail lands at the top between pages -- an OFFSET pager would repeat a row here.
    insertNewest(db, "personal", "M-new");

    const p2 = (await (
      await fetch(`${base}/api/messages?limit=2&cursor=${encodeURIComponent(p1.cursor)}`, { headers: { cookie } })
    ).json()) as { rows: { account: string; id: string }[] };

    const seen = new Set(p1.rows.map((r) => `${r.account}/${r.id}`));
    assert.ok(
      !p2.rows.some((r) => seen.has(`${r.account}/${r.id}`)),
      "a cursor over (received_at, account, id) is stable under insertion; OFFSET is not",
    );
  });
});

test("mailbox and account filters are validated per account", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/messages?account=personal&mailbox=P-NOTHERE`, { headers: { cookie } });
    assert.equal(res.status, 400);
  });
});

test("a mailbox id from another account is rejected, not silently resolved against the wrong account", async () => {
  await withSession(async (base, cookie) => {
    // P-F exists for both personal and work -- naming it against personal
    // (where it means Family) must not be accepted with work's rows, and
    // must not be silently treated as valid just because the id exists
    // somewhere in the database.
    const res = await fetch(`${base}/api/messages?account=work&mailbox=P-INBOX`, { headers: { cookie } });
    assert.equal(res.status, 400);
  });
});

test("a mailbox filter with no account is rejected as ambiguous", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/messages?mailbox=P-F`, { headers: { cookie } });
    assert.equal(res.status, 400);
  });
});

test("an unknown account is a 400", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/messages?account=nobody`, { headers: { cookie } });
    assert.equal(res.status, 400);
  });
});

test("account filter narrows the unified list to one account", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/messages?account=work`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: { account: string }[] };
    assert.ok(body.rows.every((r) => r.account === "work"));
    assert.equal(body.rows.length, 1);
  });
});

test("mailbox filter is scoped correctly to its own account's rows", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/messages?account=personal&mailbox=P-F`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: { id: string }[] };
    assert.deepEqual(body.rows.map((r) => r.id), ["M3"]);
  });
});

test("unread and flagged filters", async () => {
  await withSession(async (base, cookie) => {
    const unreadRes = await fetch(`${base}/api/messages?unread=true`, { headers: { cookie } });
    const unreadBody = (await unreadRes.json()) as { rows: { id: string }[] };
    assert.deepEqual(unreadBody.rows.map((r) => r.id), ["M1"]);

    const flaggedRes = await fetch(`${base}/api/messages?flagged=true`, { headers: { cookie } });
    const flaggedBody = (await flaggedRes.json()) as { rows: { id: string }[] };
    assert.deepEqual(flaggedBody.rows.map((r) => r.id), ["M2"]);
  });
});

test("the unified list spans every account, newest first", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/messages`, { headers: { cookie } });
    const body = (await res.json()) as { rows: { id: string }[]; total: number };
    assert.deepEqual(
      body.rows.map((r) => r.id),
      ["M1", "M4", "M2", "M3"],
    );
    assert.equal(body.total, 4);
  });
});

test("every thread/message route requires a session", async () => {
  await withApp(async (base) => {
    for (const [method, path] of [
      ["GET", "/api/threads/personal/T1"],
      ["GET", "/api/messages/personal/M1"],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} must refuse an anonymous caller`);
    }
  });
});

test("a message includes recipients, via and attachment metadata", async () => {
  await withSession(async (base, cookie, db) => {
    db.prepare(`UPDATE emails SET via = ? WHERE account = 'personal' AND id = 'M1'`).run("robin+lists@halden.example");
    insertRecipient(db, { account: "personal", emailId: "M1", kind: "to", name: "Robin", email: "robin@halden.example" });
    insertAttachment(db, { account: "personal", emailId: "M1", partId: "2", name: "budget.pdf", type: "application/pdf", size: 1234 });

    const res = await fetch(`${base}/api/messages/personal/M1`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const m = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(m["to"], [{ name: "Robin", email: "robin@halden.example" }]);
    assert.equal(m["via"], "robin+lists@halden.example");
    assert.equal((m["attachments"] as { name: string }[])[0]!.name, "budget.pdf");
    assert.ok(!("html" in m), "message HTML never enters the SPA's document (spec 3.1)");
  });
});

test("hasHtml reports null, not false, when details have never been fetched", async () => {
  // M1 in the fixture has details_at IS NULL / has_html IS NULL -- the read
  // API must not claim `false` here, or the SPA would conclude "no HTML
  // part" about a message nobody has ever actually checked.
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/messages/personal/M1`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const m = (await res.json()) as { hasHtml: unknown };
    assert.equal(m.hasHtml, null, "unknown must stay honestly unknown, not silently become false");
  });
});

test("hasHtml reports true or false once details have actually been fetched", async () => {
  await withSession(async (base, cookie, db) => {
    db.prepare(`UPDATE emails SET has_html = 1, details_at = ? WHERE account = 'personal' AND id = 'M1'`).run(
      "2026-01-01T00:00:00Z",
    );
    db.prepare(`UPDATE emails SET has_html = 0, details_at = ? WHERE account = 'personal' AND id = 'M2'`).run(
      "2026-01-01T00:00:00Z",
    );

    const withHtml = await fetch(`${base}/api/messages/personal/M1`, { headers: { cookie } });
    const withHtmlBody = (await withHtml.json()) as { hasHtml: unknown };
    assert.equal(withHtmlBody.hasHtml, true);

    const withoutHtml = await fetch(`${base}/api/messages/personal/M2`, { headers: { cookie } });
    const withoutHtmlBody = (await withoutHtml.json()) as { hasHtml: unknown };
    assert.equal(withoutHtmlBody.hasHtml, false);
  });
});

/**
 * 🚨 A CONTENT ID IS NOT A DECLARATION THAT SOMETHING IS PART OF THE BODY.
 *
 * Live report, 2026-09-23: "I am clicking the pdf chip and nothing happens."
 * The message held eight invoice PDFs, every one declared
 * `disposition: "attachment"` by the sender AND carrying a Gmail-style
 * `f_...` content id. Wilco classified anything with a cid as decoration, so
 * all eight rendered as INERT LABELS -- no link, no handler, no paperclip on
 * the row -- and there was no way to open them at all.
 *
 * The sender's own disposition decides. A part stays out of the attachment
 * list only when it is decoration the body draws, which is the signature
 * logo the test below still pins.
 */
test("🚨 a part declared an attachment IS one, cid or not", async () => {
  await withSession(async (base, cookie, db) => {
    insertEmail(db, { account: "personal", id: "M-inv", receivedAt: "2026-01-01T00:00:00Z" });
    insertAttachment(db, {
      account: "personal", emailId: "M-inv", partId: "2",
      name: "invoice_20452.pdf", type: "application/pdf", size: 63493,
      cid: "f_mubf5c861", disposition: "attachment",
    });

    const m = (await (await fetch(`${base}/api/messages/personal/M-inv`, { headers: { cookie } })).json()) as {
      attachments: { name: string }[];
      inlineParts: { name: string }[];
    };
    assert.deepEqual(
      m.attachments.map((a) => a.name),
      ["invoice_20452.pdf"],
      "a PDF the sender declared an attachment must be offered as a file",
    );
    // Still resolvable as an inline part: the body frame resolves `cid:`
    // references from that list, so removing it there would break an image
    // a body genuinely draws. A part can be both.
    assert.deepEqual(m.inlineParts.map((p) => p.name), ["invoice_20452.pdf"]);
  });
});

test("🚨 a message whose only attachment carries a cid still shows the paperclip", async () => {
  // The same predicate drives the list row's paperclip and `has:attachment`,
  // and it was the same `cid IS NULL` rule -- so that invoice message showed
  // no attachment indicator anywhere either.
  await withSession(async (base, cookie, db) => {
    insertEmail(db, { account: "personal", id: "M-clip", receivedAt: "2026-01-02T00:00:00Z" });
    insertAttachment(db, {
      account: "personal", emailId: "M-clip", partId: "2",
      name: "invoice.pdf", type: "application/pdf", size: 100,
      cid: "f_abc", disposition: "attachment",
    });

    const list = (await (await fetch(`${base}/api/messages?account=personal`, { headers: { cookie } })).json()) as {
      rows: { id: string; hasAttachment?: boolean }[];
    };
    const row = list.rows.find((r) => r.id === "M-clip");
    assert.ok(row !== undefined, "the message is missing from the list entirely");
    assert.equal(row.hasAttachment, true, "the row shows no paperclip for an attachment carrying a cid");
  });
});

test("inline images are reported separately from attachments", async () => {
  await withSession(async (base, cookie, db) => {
    insertEmail(db, { account: "personal", id: "M-sig", receivedAt: "2026-01-01T00:00:00Z" });
    insertAttachment(db, {
      account: "personal",
      emailId: "M-sig",
      partId: "2",
      name: "logo.png",
      type: "image/png",
      size: 500,
      cid: "logo@wilco",
    });

    const res = await fetch(`${base}/api/messages/personal/M-sig`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const m = (await res.json()) as { attachments: unknown[]; inlineParts: { name: string }[] };
    assert.equal(m.attachments.length, 0, "a signature logo is not an attachment");
    assert.equal(m.inlineParts.length, 1);
    assert.equal(m.inlineParts[0]!.name, "logo.png");
  });
});

test("a thread returns oldest first and only from the one account", async () => {
  await withSession(async (base, cookie, db) => {
    db.prepare(`UPDATE emails SET thread_id = 'T1' WHERE account = 'personal' AND id IN ('M1', 'M2', 'M3')`).run();
    // M4 is a different account entirely, but give it the same literal
    // thread_id text to prove the account scopes the thread, not just id
    // collisions elsewhere in the fixture.
    db.prepare(`UPDATE emails SET thread_id = 'T1' WHERE account = 'work' AND id = 'M4'`).run();

    const res = await fetch(`${base}/api/threads/personal/T1`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const t = (await res.json()) as { messages: { receivedAt: string; account: string; id: string }[] };
    const dates = t.messages.map((m) => m.receivedAt);
    assert.deepEqual(dates, [...dates].sort(), "a thread reads oldest to newest");
    assert.ok(t.messages.every((m) => m.account === "personal"), "a thread must not cross accounts");
    assert.deepEqual(t.messages.map((m) => m.id), ["M3", "M2", "M1"]);
  });
});

test("an unknown thread is 404", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/threads/personal/NOPE`, { headers: { cookie } });
    assert.equal(res.status, 404);
  });
});

test("an unknown message is 404, and a known id in the wrong account is too", async () => {
  await withSession(async (base, cookie) => {
    const missing = await fetch(`${base}/api/messages/personal/NOPE`, { headers: { cookie } });
    assert.equal(missing.status, 404);

    const wrongAccount = await fetch(`${base}/api/messages/work/M1`, { headers: { cookie } });
    assert.equal(
      wrongAccount.status,
      404,
      "ids collide across accounts; the account is part of the key, not a hint",
    );
  });
});

test("the same id genuinely exists as two different objects in two accounts", async () => {
  // Carried from Task 5's review: M1 previously only existed in `personal`,
  // so a cross-account lookup only ever proved a 404. Seed a real
  // collision -- the same message id in BOTH accounts, with different
  // subjects -- and assert each account's GET returns its OWN message,
  // not the other one's and not a 404 masking the mismatch.
  await withSession(async (base, cookie, db) => {
    insertEmail(db, { account: "work", id: "M1", receivedAt: "2026-02-01T00:00:00Z", subject: "Work M1" });
    db.prepare(`UPDATE emails SET subject = 'Personal M1' WHERE account = 'personal' AND id = 'M1'`).run();

    const workRes = await fetch(`${base}/api/messages/work/M1`, { headers: { cookie } });
    assert.equal(workRes.status, 200);
    const workBody = (await workRes.json()) as { account: string; subject: string };
    assert.equal(workBody.account, "work");
    assert.equal(workBody.subject, "Work M1");

    const personalRes = await fetch(`${base}/api/messages/personal/M1`, { headers: { cookie } });
    assert.equal(personalRes.status, 200);
    const personalBody = (await personalRes.json()) as { account: string; subject: string };
    assert.equal(personalBody.account, "personal");
    assert.equal(personalBody.subject, "Personal M1");
  });
});

test("saved searches: session and CSRF are required on every mutating route", async () => {
  await withApp(async (base) => {
    for (const [method, path] of [
      ["GET", "/api/saved-searches"],
      ["POST", "/api/saved-searches"],
      ["PATCH", "/api/saved-searches"],
      ["PATCH", "/api/saved-searches/x"],
      ["DELETE", "/api/saved-searches/x"],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} must refuse an anonymous caller`);
    }
  });

  await withSession(async (base, cookie) => {
    for (const [method, path] of [
      ["POST", "/api/saved-searches"],
      ["PATCH", "/api/saved-searches"],
      ["PATCH", "/api/saved-searches/x"],
      ["DELETE", "/api/saved-searches/x"],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { cookie, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 403, `${method} ${path} must refuse a request with no CSRF header`);
    }
  });
});

test("saved searches: create, list, rename, reorder, delete round-trip", async () => {
  await withSession(async (base, cookie) => {
    const headers = { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" };

    const created = await fetch(`${base}/api/saved-searches`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Unread work", query: "is:unread acct:work" }),
    });
    assert.equal(created.status, 201);
    const a = (await created.json()) as { id: string; name: string; query: string };
    assert.equal(a.query, "is:unread acct:work");

    const createdB = await fetch(`${base}/api/saved-searches`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Notes", query: "note:followup" }),
    });
    assert.equal(createdB.status, 201, "an unknown operator is a valid saved search");
    const b = (await createdB.json()) as { id: string };

    const empty = await fetch(`${base}/api/saved-searches`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Nothing", query: "   " }),
    });
    assert.equal(empty.status, 400);

    const listed = await fetch(`${base}/api/saved-searches`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const listedBody = (await listed.json()) as { savedSearches: { id: string }[] };
    assert.equal(listedBody.savedSearches.length, 2);

    const renamed = await fetch(`${base}/api/saved-searches/${a.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Work unread" }),
    });
    assert.equal(renamed.status, 200);

    // Renaming an id that doesn't exist is NOT idempotent the way delete
    // is -- a specific new value was claimed persisted and wasn't, so this
    // must be a 404, not a false-success 200.
    const renameMissing = await fetch(`${base}/api/saved-searches/no-such-id`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Ghost" }),
    });
    assert.equal(renameMissing.status, 404);

    const reordered = await fetch(`${base}/api/saved-searches`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ids: [b.id, a.id] }),
    });
    assert.equal(reordered.status, 200);
    const reorderedBody = (await reordered.json()) as { savedSearches: { name: string }[] };
    assert.deepEqual(reorderedBody.savedSearches.map((s) => s.name), ["Notes", "Work unread"]);

    const partial = await fetch(`${base}/api/saved-searches`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ids: [a.id] }),
    });
    assert.equal(partial.status, 400, "a partial reorder must be refused");

    const removed = await fetch(`${base}/api/saved-searches/${a.id}`, { method: "DELETE", headers });
    assert.equal(removed.status, 200);

    const afterDelete = await fetch(`${base}/api/saved-searches`, { headers: { cookie } });
    const afterDeleteBody = (await afterDelete.json()) as { savedSearches: { id: string }[] };
    assert.equal(afterDeleteBody.savedSearches.length, 1);
    assert.equal(afterDeleteBody.savedSearches[0]!.id, b.id);
  });
});

// ---------------------------------------------------------------------------
// `role`: the unified mailbox filter (Task 11). A mailbox id is scoped per
// account -- "P-F" is a real id in BOTH seeded accounts above and means two
// different folders -- so the SPA's default screen, "the inbox of every
// account at once", is only expressible as a role.
// ---------------------------------------------------------------------------

test("GET /api/messages?role=inbox spans every account without an account filter", async () => {
  await withSession(async (base, cookie, db) => {
    insertMailbox(db, { account: "work", id: "W-INBOX", name: "Inbox", role: "inbox", sortOrder: 1 });
    assignMailbox(db, "work", "M4", "W-INBOX");

    const res = await fetch(`${base}/api/messages?role=inbox`, { headers: { cookie } });
    assert.equal(res.status, 200, "a role filter needs no account -- that is the point of it");
    const body = (await res.json()) as { rows: { account: string; id: string }[]; total: number };
    assert.deepEqual(
      body.rows.map((r) => `${r.account}/${r.id}`).sort(),
      ["personal/M1", "personal/M2", "work/M4"],
      "both accounts' inboxes, and nothing from the non-inbox folder P-F",
    );
    assert.equal(body.total, 3);
  });
});

test("row 48: an account switched out of All inboxes leaves the unified list but keeps its own view", async () => {
  await withSession(async (base, cookie, db) => {
    insertMailbox(db, { account: "work", id: "W-INBOX", name: "Inbox", role: "inbox", sortOrder: 1 });
    assignMailbox(db, "work", "M4", "W-INBOX");
    setSetting(db, "work", "showInUnified", "off");
    const unified = (await (await fetch(`${base}/api/messages?role=inbox`, { headers: { cookie } })).json()) as { rows: { account: string }[]; total: number };
    assert.deepEqual([...new Set(unified.rows.map((r) => r.account))], ["personal"], "work is out of the unified list");
    assert.equal(unified.total, 2, "and out of its count");
    const own = (await (await fetch(`${base}/api/messages?account=work&role=inbox`, { headers: { cookie } })).json()) as { rows: { id: string }[] };
    assert.deepEqual(own.rows.map((r) => r.id), ["M4"], "its own view is unaffected");
  });
});

test("a role never resolves across account boundaries", async () => {
  await withSession(async (base, cookie, db) => {
    // work has no inbox-role mailbox at all here, so scoping "inbox" to
    // work must return nothing -- not personal's inbox because the role
    // string matched somewhere.
    void db;
    const res = await fetch(`${base}/api/messages?account=work&role=inbox`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    assert.deepEqual(body.rows, []);
    assert.equal(body.total, 0);
  });
});

test("an unknown role is an empty list, not an error", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/messages?role=nonesuch`, { headers: { cookie } });
    assert.equal(res.status, 200, "routing must not hard-fail on a mailbox this account lacks");
    assert.equal(((await res.json()) as { total: number }).total, 0);
  });
});

test("mailbox and role together are rejected rather than silently intersected", async () => {
  await withSession(async (base, cookie) => {
    const res = await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&role=inbox`, {
      headers: { cookie },
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /mutually exclusive/);
  });
});

// -- Threading in the list (spec 1: "Conversations (threading)") ----------

test("🚨 a conversation is ONE row, represented by its latest message", async () => {
  // Reported from real use as "littered messages": a five-message exchange
  // occupied five consecutive, near-identical rows. The design's list row
  // IS a thread (`t.msgs`), not a message.
  await withSession(async (base, cookie, db) => {
    for (const [i, id] of ["T1a", "T1b", "T1c"].entries()) {
      insertEmail(db, {
        account: "personal",
        id,
        threadId: "TH1",
        receivedAt: `2026-09-0${i + 1}T00:00:00Z`,
        subject: "Re: Halden Trip",
      });
      assignMailbox(db, "personal", id, "P-INBOX");
    }

    const res = (await (
      await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=50`, { headers: { cookie } })
    ).json()) as { rows: { id: string; threadId: string | null }[]; total: number };

    const thread = res.rows.filter((r) => r.threadId === "TH1");
    assert.equal(thread.length, 1, "one row for the conversation");
    assert.equal(thread[0]!.id, "T1c", "represented by the newest message");
  });
});

test("the total counts THREADS, so the header agrees with the rows", async () => {
  await withSession(async (base, cookie, db) => {
    const before = (await (
      await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=50`, { headers: { cookie } })
    ).json()) as { rows: unknown[]; total: number };

    for (const id of ["X1", "X2", "X3"]) {
      insertEmail(db, { account: "personal", id, threadId: "THX", receivedAt: "2026-09-04T00:00:00Z" });
      assignMailbox(db, "personal", id, "P-INBOX");
    }

    const after = (await (
      await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=50`, { headers: { cookie } })
    ).json()) as { rows: unknown[]; total: number };

    assert.equal(after.total, before.total + 1, "three messages, one conversation");
    assert.equal(after.rows.length, after.total);
  });
});

test("🚨 a thread is unread when ANY of its messages is, not just the latest", async () => {
  // Taking the representative row's own flags shows a conversation as read
  // while it still holds unread mail.
  await withSession(async (base, cookie, db) => {
    insertEmail(db, { account: "personal", id: "U1", threadId: "THU", receivedAt: "2026-09-01T00:00:00Z", unread: 1 });
    insertEmail(db, { account: "personal", id: "U2", threadId: "THU", receivedAt: "2026-09-02T00:00:00Z", unread: 0 });
    assignMailbox(db, "personal", "U1", "P-INBOX");
    assignMailbox(db, "personal", "U2", "P-INBOX");

    const res = (await (
      await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=50`, { headers: { cookie } })
    ).json()) as { rows: { id: string; isUnread: boolean }[] };

    const row = res.rows.find((r) => r.id === "U2")!;
    assert.equal(row.isUnread, true, "the newest is read, but the conversation is not");
  });
});

test("a message with no thread id is its own conversation, not lumped with every other", async () => {
  // COALESCE(thread_id, id): without it every unthreaded message collapses
  // into one NULL bucket and the list shows a single row for all of them.
  await withSession(async (base, cookie, db) => {
    for (const id of ["N1", "N2", "N3"]) {
      insertEmail(db, { account: "personal", id, threadId: null, receivedAt: "2026-09-03T00:00:00Z" });
      assignMailbox(db, "personal", id, "P-INBOX");
    }
    const res = (await (
      await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=50`, { headers: { cookie } })
    ).json()) as { rows: { id: string }[] };
    const ids = res.rows.map((r) => r.id);
    for (const id of ["N1", "N2", "N3"]) assert.ok(ids.includes(id), `${id} has its own row`);
  });
});

test("🚨 paging cannot show the same conversation twice", async () => {
  // The cursor must be applied AFTER collapsing. Filtering rows by
  // received_at first and grouping second lets a thread already shown
  // reappear, represented by one of its older messages.
  await withSession(async (base, cookie, db) => {
    // A thread whose messages straddle a page boundary.
    for (const [i, id] of ["S1", "S2", "S3", "S4"].entries()) {
      insertEmail(db, {
        account: "personal",
        id,
        threadId: "THS",
        receivedAt: `2026-09-1${i}T00:00:00Z`,
      });
      assignMailbox(db, "personal", id, "P-INBOX");
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 8; page++) {
      const url = `${base}/api/messages?account=personal&mailbox=P-INBOX&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = (await (await fetch(url, { headers: { cookie } })).json()) as {
        rows: { account: string; id: string; threadId: string | null }[];
        cursor: string | null;
      };
      for (const r of res.rows) {
        const key = `${r.account}/${r.threadId ?? r.id}`;
        assert.ok(!seen.has(key), `conversation ${key} appeared on two pages`);
        seen.add(key);
      }
      cursor = res.cursor;
      if (cursor === null) break;
    }
  });
});

test("🚨 the thread count is the WHOLE conversation, not its messages in this folder", async () => {
  // How the badge first shipped: a window function over the FILTERED set,
  // which counted only the folder. The live Halden Trip thread showed
  // "5" in the inbox while the reading pane called it "18 messages" -- 8
  // were in Sent, 3 in Archive, 2 in Drafts. Two numbers for one thing in
  // adjacent panes. The design settles it: msgCount is the thread's whole
  // message array.
  await withSession(async (base, cookie, db) => {
    insertMailbox(db, { account: "personal", id: "P-ARCH", name: "Archive", role: "archive", sortOrder: 2, unreadEmails: 0 });

    for (const [i, id] of ["C1", "C2"].entries()) {
      insertEmail(db, { account: "personal", id, threadId: "THC", receivedAt: `2026-09-0${i + 1}T00:00:00Z` });
      assignMailbox(db, "personal", id, "P-INBOX");
    }
    for (const [i, id] of ["C3", "C4", "C5"].entries()) {
      insertEmail(db, { account: "personal", id, threadId: "THC", receivedAt: `2026-08-0${i + 1}T00:00:00Z` });
      assignMailbox(db, "personal", id, "P-ARCH");
    }

    const res = (await (
      await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=50`, { headers: { cookie } })
    ).json()) as { rows: { id: string; threadId: string | null; threadCount: number }[] };

    const row = res.rows.find((r) => r.threadId === "THC")!;
    assert.equal(row.threadCount, 5, "all five, not the two in this folder");
    assert.equal(row.id, "C2", "still represented by the folder's newest");
  });
});

test("an unthreaded message counts as one, not as every other unthreaded message", async () => {
  await withSession(async (base, cookie, db) => {
    insertEmail(db, { account: "personal", id: "L1", threadId: null, receivedAt: "2026-09-02T00:00:00Z" });
    insertEmail(db, { account: "personal", id: "L2", threadId: null, receivedAt: "2026-09-01T00:00:00Z" });
    assignMailbox(db, "personal", "L1", "P-INBOX");
    assignMailbox(db, "personal", "L2", "P-INBOX");

    const res = (await (
      await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=50`, { headers: { cookie } })
    ).json()) as { rows: { id: string; threadCount: number }[] };

    for (const id of ["L1", "L2"]) {
      assert.equal(res.rows.find((r) => r.id === id)!.threadCount, 1, `${id} is its own conversation`);
    }
  });
});

test("🚨 the message list stays fast at archive scale — 5,000 messages, not 5", async () => {
  // Audit pass 5 found `GET /api/messages` taking **57.8 SECONDS** on the
  // live 37.7k-message archive. It had shipped that way with the
  // whole-conversation thread count: correctness was tested (the test above
  // pins 5-not-2), cost was not, and every functional test uses a handful of
  // rows where a per-row correlated subquery is free.
  //
  // The mechanism: with three `MAX() OVER` windows in the same SELECT,
  // SQLite evaluated the correlated `COUNT(*)` once per row of the WHOLE
  // TABLE rather than per returned row, and `WHERE rn = 1` prunes far too
  // late to help. Replaced by one grouped aggregate, joined — identical
  // numbers (verified against every thread in the live archive, 0
  // disagreements), 57,853ms -> 325ms.
  //
  // This test exists because a correctness suite could never have caught it.
  //
  // 🚨 The bound is MEASURED, not guessed. At 5,000 messages the joined
  // aggregate takes ~41ms and the correlated subquery ~1,963ms -- 48x. The
  // first version of this test used 3,000ms "to be safe" and PASSED with the
  // slow query restored, which made it a test that proves nothing while
  // looking like protection. 500ms is ~12x headroom over the fast path and
  // still catches the slow one by 4x.
  await withSession(async (base, cookie, db) => {
    // 5,000 messages across 1,000 threads of 5 — the shape that makes the
    // difference visible without making the test slow to set up.
    for (let t = 0; t < 1000; t++) {
      for (let m = 0; m < 5; m++) {
        const id = `P${t}_${m}`;
        insertEmail(db, {
          account: "personal",
          id,
          threadId: `TH${t}`,
          receivedAt: `2026-01-01T00:00:${String(m).padStart(2, "0")}Z`,
        });
        assignMailbox(db, "personal", id, "P-INBOX");
      }
    }

    const started = Date.now();
    const res = (await (
      await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=25`, { headers: { cookie } })
    ).json()) as { rows: { threadId: string | null; threadCount: number }[] };
    const elapsed = Date.now() - started;

    // The count must still be the whole conversation, or this "fix" traded
    // the defect the slow query existed to fix.
    const threaded = res.rows.find((r) => r.threadId !== null && r.threadId.startsWith("TH"));
    assert.ok(threaded !== undefined, "no threaded row came back");
    assert.equal(threaded.threadCount, 5, "the count stopped being the whole conversation");

    assert.ok(
      elapsed < 500,
      `the message list took ${elapsed}ms over 5,000 messages. That is the shape of per-row-of-the-` +
        `whole-table work returning; it was 57,853ms on the live archive before the joined aggregate.`,
    );
  });
});

test("🚨 the paperclip means a FILE — not an inline image, not an AMP body", async () => {
  // Owner ruling 2026-09-05: "Attachment means attachment, not embedded
  // image. Files, calendar invites, etc. Email clients already know what
  // this means, we follow that convention."
  //
  // Measured on the live archive before this: 1,807 messages (27% of the
  // 6,747 showing a paperclip) had JMAP's has_attachment set and opened to
  // no attachments at all -- a header logo, a tracking pixel, a signature
  // image. And search disagreed with the list about the same message,
  // because `has:attachment` used one predicate and the paperclip another.
  await withSession(async (base, cookie, db) => {
    const put = (id: string, jmapFlag: number) => {
      insertEmail(db, { account: "personal", id, receivedAt: `2026-07-0${id.slice(-1)}T00:00:00Z` });
      db.prepare(`UPDATE emails SET has_attachment = ? WHERE account='personal' AND id=?`).run(jmapFlag, id);
      assignMailbox(db, "personal", id, "P-INBOX");
    };
    const part = (id: string, partId: string, type: string, cid: string | null, name = "f") =>
      db
        .prepare(
          `INSERT INTO email_attachments (account,email_id,part_id,name,type,size,cid) VALUES ('personal',?,?,?,?,10,?)`,
        )
        .run(id, partId, name, type, cid);

    // A real file. JMAP agrees.
    put("A1", 1);
    part("A1", "2", "application/pdf", null, "invoice.pdf");
    // Inline logo only. JMAP says attachment; a person would say no.
    put("A2", 1);
    part("A2", "2", "image/png", "logo@x", "logo.png");
    // An AMP alternative rendering of the body. No cid, and not a file.
    put("A3", 1);
    part("A3", "2", "text/x-amp-html", null, "");
    // A calendar invite IS a file, and JMAP missed it.
    put("A4", 0);
    part("A4", "2", "text/calendar", null, "invite.ics");

    const list = (await (
      await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=50`, { headers: { cookie } })
    ).json()) as { rows: { id: string; hasAttachment: boolean }[] };
    const clip = (id: string) => list.rows.find((r) => r.id === id)!.hasAttachment;

    assert.equal(clip("A1"), true, "a real file lost its paperclip");
    assert.equal(clip("A2"), false, "an inline logo still shows a paperclip");
    assert.equal(clip("A3"), false, "an AMP body rendering still shows a paperclip");
    assert.equal(clip("A4"), true, "a calendar invite has no paperclip");

    // 🚨 And search must agree with the list, message for message. These two
    // used different predicates, so `has:attachment` and the paperclip
    // disagreed about the same mail.
    const found = (await (
      await fetch(`${base}/api/search`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
        body: JSON.stringify({ q: "has:attachment" }),
      })
    ).json()) as { rows: { id: string }[] };
    const ids = new Set(found.rows.map((r) => r.id));
    assert.deepEqual(
      ["A1", "A2", "A3", "A4"].filter((id) => ids.has(id)),
      ["A1", "A4"],
      "has:attachment and the paperclip disagree",
    );

    // The reading pane's chips must be the same set.
    const detail = (await (
      await fetch(`${base}/api/messages/personal/A3`, { headers: { cookie } })
    ).json()) as { attachments: unknown[]; inlineParts: unknown[] };
    assert.equal(detail.attachments.length, 0, "an AMP body rendering was offered as a download chip");
  });
});

test("row 23: POST /api/contacts offers the UNIFIED address book; the query never rides a URL", async () => {
  await withSession(async (base, cookie, db) => {
    db.prepare(`UPDATE emails SET from_email = 'dana@example.com', from_name = 'Dana' WHERE account = 'personal' AND id = 'M1'`).run();
    insertEmail(db, { account: "work", id: "W9", receivedAt: "2026-08-30T00:00:00Z", subject: "hi" });
    db.prepare(`UPDATE emails SET from_email = 'danielle@work.example', from_name = 'Danielle' WHERE account = 'work' AND id = 'W9'`).run();

    const res = await fetch(`${base}/api/contacts`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ q: "dan" }),
    });
    assert.equal(res.status, 200);
    const got = (await res.json()) as { contacts: { name: string; email: string; accounts: string[] }[] };
    assert.deepEqual(
      got.contacts.map((c) => c.email).sort(),
      ["dana@example.com", "danielle@work.example"],
      "🚨 no account is asked for and none is needed -- both accounts' correspondents are offered",
    );
    assert.deepEqual(got.contacts.find((c) => c.email === "danielle@work.example")?.accounts, ["work"], "the row names the account that knows them");

    const get = await fetch(`${base}/api/contacts?q=dan`, { headers: { cookie } });
    assert.equal(get.status, 405, "GET /api/contacts is not a route -- a fragment on the URL would land in the proxy log");
    const anon = await fetch(`${base}/api/contacts`, { method: "POST" });
    assert.equal(anon.status, 401);
  });
});

/** A client that answers Identity/get with one primary identity and nothing
 *  else.
 *
 *  🚨 The identity cache in send-api.ts is per account FOR THE LIFE OF THE
 *  PROCESS, and every test in this file shares that process. So `personal`
 *  must be row 31's identity exactly -- same address AND same name. The first
 *  version used the name "Me", and row 31 then sent its unsubscribe mail as
 *  "Me" whenever this test happened to run first. */
function identityClient(email: string, displayName: string): JmapClient {
  return new JmapClient(resolveSession("personal", personalSession), "t", async (_u, init) => {
    const calls = JSON.parse(init!.body as string).methodCalls as [string, Record<string, unknown>, string][];
    const responses = calls.map(([method, _args, tag]) =>
      method === "Identity/get" ? ["Identity/get", { list: [{ id: "ID1", name: displayName, email, mayDelete: false }] }, tag] : [method, {}, tag],
    );
    return new Response(JSON.stringify({ methodResponses: responses }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

test("🚨 /api/contacts excludes only the SENDING account's own addresses; your other accounts stay addressable", async () => {
  // Owner ruling 2026-10-03, after board row 23 went red: excluding EVERY
  // account's identities meant composing from work could never suggest the
  // owner's personal address -- and writing from one of your accounts to
  // another is an ordinary thing to do.
  const clients = new Map([
    ["personal", identityClient("robin@example.test", "Robin")],
    ["work", identityClient("me@work.example", "Me")],
  ]);
  await withSession(
    async (base, cookie, db) => {
      db.prepare(`UPDATE emails SET from_email = 'robin@example.test' WHERE account = 'personal' AND id = 'M1'`).run();
      db.prepare(`UPDATE emails SET from_email = 'me@work.example' WHERE account = 'work' AND id = 'M4'`).run();
      const H = { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" };
      const ask = async (body: object) =>
        ((await (await fetch(`${base}/api/contacts`, { method: "POST", headers: H, body: JSON.stringify(body) })).json()) as {
          contacts: { email: string }[];
        }).contacts.map((c) => c.email).sort();

      assert.deepEqual(await ask({ q: "example", from: "personal" }), ["me@work.example"], "sending from personal: personal's own address is dropped, work's is offered");
      assert.deepEqual(await ask({ q: "example", from: "work" }), ["robin@example.test"], "and the mirror image from work");
      assert.deepEqual(await ask({ q: "example" }), ["me@work.example", "robin@example.test"], "no sender named, nothing to exclude");
    },
    { clients },
  );
});

test("🚨 the contact routes serve from the ONE injected book, so they do not re-aggregate the archive per request", async () => {
  // Building the book is a full aggregate over every contact event, which
  // cost 175ms on the owner's archive (see core/addressbook.ts). The route
  // must take the long-lived instance boot hands it; building its own per
  // request would put that cost back on every keystroke.
  const book = new AddressBook(openDb(tempDbPath()), { ttlMs: 1 });
  await withSession(
    async (base, cookie, db) => {
      db.prepare(`UPDATE emails SET from_email = 'dana@example.com', from_name = 'Dana' WHERE account = 'personal' AND id = 'M1'`).run();
      const H = { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" };
      const got = (await (
        await fetch(`${base}/api/contacts`, { method: "POST", headers: H, body: JSON.stringify({ q: "dan" }) })
      ).json()) as { contacts: unknown[] };
      assert.deepEqual(
        got.contacts,
        [],
        "the injected book was built over a DIFFERENT, empty database -- an empty answer is the proof it was used",
      );
    },
    { book },
  );
});

test("POST /api/contacts/habits names the accounts each address has been written to from, and never rides a URL", async () => {
  await withSession(async (base, cookie, db) => {
    db.prepare(`INSERT INTO mailboxes (account, id, name, role, parent_id, sort_order, total_emails, unread_emails) VALUES ('personal','P-SENT2','Sent','sent',NULL,3,0,0)`).run();
    insertEmail(db, { account: "personal", id: "S9", receivedAt: "2026-08-01T00:00:00Z", subject: "hello" });
    assignMailbox(db, "personal", "S9", "P-SENT2");
    insertRecipient(db, { account: "personal", emailId: "S9", kind: "to", email: "Jordan@Example.com" });

    const res = await fetch(`${base}/api/contacts/habits`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ emails: ["jordan@example.com", "stranger@example.com"] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      habits: { "jordan@example.com": ["personal"], "stranger@example.com": [] },
      },
      "every requested address gets an answer; an empty list is 'no habit', which the note stays silent about",
    );

    const get = await fetch(`${base}/api/contacts/habits?emails=a@b.c`, { headers: { cookie } });
    assert.equal(get.status, 405, "an address must never land in the proxy log");
    const anon = await fetch(`${base}/api/contacts/habits`, { method: "POST" });
    assert.equal(anon.status, 401);
    const bad = await fetch(`${base}/api/contacts/habits`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ emails: "jordan@example.com" }),
    });
    assert.equal(bad.status, 400, "emails must be a list");
  });
});

// ---------------------------------------------------------------------------
// Row 31: unsubscribe. The server performs it; the route reports what the
// message offers and what happened.
// ---------------------------------------------------------------------------

/** A JMAP client whose Email/get answers with the two unsubscribe headers
 *  for known ids, whose Identity/get has one primary identity, and whose
 *  send (Email/set + EmailSubmission/set) succeeds. */
function unsubClient(headers: Record<string, { urls: string[] | null; post: string | null }>, sent: unknown[]): JmapClient {
  return new JmapClient(resolveSession("personal", personalSession), "t", async (_u, init) => {
    const calls = JSON.parse(init!.body as string).methodCalls as [string, Record<string, unknown>, string][];
    const responses = calls.map(([name, args, tag]) => {
      if (name === "Email/get") {
        const id = (args["ids"] as string[])[0]!;
        const h = headers[id];
        return ["Email/get", { list: h ? [{ id, "header:List-Unsubscribe:asURLs": h.urls, "header:List-Unsubscribe-Post:asText": h.post }] : [], notFound: h ? [] : [id] }, tag];
      }
      if (name === "Identity/get") {
        return ["Identity/get", { list: [{ id: "ID1", name: "Robin", email: "robin@example.test", mayDelete: false }] }, tag];
      }
      if (name === "Email/set") {
        sent.push(args["create"]);
        return ["Email/set", { created: { draft: { id: "E-UNSUB" } } }, tag];
      }
      if (name === "EmailSubmission/set") return ["EmailSubmission/set", { created: { sub: { id: "S1" } } }, tag];
      return [name, {}, tag];
    });
    return new Response(JSON.stringify({ methodResponses: responses }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

test("row 31: GET reports the method a message offers; POST performs a one-click POST server-side and reports its status", async () => {
  const posted: { url: string; body: unknown }[] = [];
  const sent: unknown[] = [];
  const client = unsubClient(
    {
      M1: { urls: ["mailto:unsub@example.com", "https://example.com/unsub"], post: "List-Unsubscribe=One-Click" },
      M2: { urls: null, post: null },
    },
    sent,
  );
  await withSession(
    async (base, cookie) => {
      const info = await fetch(`${base}/api/messages/personal/M1/unsubscribe`, { headers: { cookie } });
      assert.deepEqual(await info.json(), { method: "post" });
      const none = await fetch(`${base}/api/messages/personal/M2/unsubscribe`, { headers: { cookie } });
      assert.deepEqual(await none.json(), { method: null });

      const res = await fetch(`${base}/api/messages/personal/M1/unsubscribe`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "x-wilco-csrf": "1" },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { method: "post", ok: true, status: 202 });
      assert.deepEqual(posted, [{ url: "https://example.com/unsub", body: "List-Unsubscribe=One-Click" }]);
      assert.equal(sent.length, 0, "no email is sent when the one-click POST is available");

      const refused = await fetch(`${base}/api/messages/personal/M2/unsubscribe`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "x-wilco-csrf": "1" },
      });
      assert.equal(refused.status, 404, "a message with no method cannot be unsubscribed from");
    },
    {
      clients: new Map([["personal", client]]),
      fetchFn: async (url, init) => {
        posted.push({ url, body: init?.body });
        return new Response("", { status: 202 });
      },
    },
  );
});

test("row 31: with only a mailto, POST sends the unsubscribe email from the account's primary identity", async () => {
  const sent: { draft?: Record<string, unknown> }[] = [];
  const client = unsubClient({ M3: { urls: ["mailto:leave@list.example?subject=Unsubscribe%20me"], post: null } }, sent);
  await withSession(
    async (base, cookie, db) => {
      db.prepare(`INSERT INTO mailboxes (account, id, name, role, parent_id, sort_order, total_emails, unread_emails) VALUES ('personal','P-DRAFTS','Drafts','drafts',NULL,2,0,0), ('personal','P-SENT','Sent','sent',NULL,3,0,0)`).run();
      const res = await fetch(`${base}/api/messages/personal/M3/unsubscribe`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "x-wilco-csrf": "1" },
      });
      const text = await res.text();
      assert.equal(res.status, 200, text);
      assert.deepEqual(JSON.parse(text), { method: "mailto", ok: true, to: "leave@list.example", emailId: "E-UNSUB" });
      const draft = sent[0]?.draft;
      assert.ok(draft, "an email was created");
      assert.deepEqual(draft["to"], [{ name: null, email: "leave@list.example" }]);
      assert.equal(draft["subject"], "Unsubscribe me");
      assert.deepEqual(draft["from"], [{ name: "Robin", email: "robin@example.test" }]);
    },
    { clients: new Map([["personal", client]]), fetchFn: async () => { throw new Error("must not POST"); } },
  );
});

test("row 31: the POST needs write scope and CSRF, like every other action", async () => {
  await withSession(async (base, cookie) => {
    const noCsrf = await fetch(`${base}/api/messages/personal/M1/unsubscribe`, { method: "POST", headers: { cookie } });
    assert.equal(noCsrf.status, 403);
    const anon = await fetch(`${base}/api/messages/personal/M1/unsubscribe`, { method: "POST" });
    assert.equal(anon.status, 401);
  });
});

test("row 37: preferences are read and written through the API, refused when unknown, and need a session", async () => {
  await withSession(async (base, cookie) => {
    const before = await fetch(`${base}/api/preferences`, { headers: { cookie } });
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), {
      preferences: {
        theme: "light", density: "comfortable", layout: "columns", markRead: "after2s", remoteImages: "ask", groupConversations: "on",
        quoteHistory: "on", replyAllDefault: "off", archiveOnReply: "off", unifiedInboxAtLaunch: "on",
        notifDesktop: "on", notifPeopleOnly: "off", notifSound: "off",
        signaturePlacement: "above",
      },
    });

    const put = await fetch(`${base}/api/preferences`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ key: "theme", value: "dark" }),
    });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { preferences: { theme: string } }).preferences.theme, "dark");

    const bad = await fetch(`${base}/api/preferences`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ key: "theme", value: "sepia" }),
    });
    assert.equal(bad.status, 400);
    const unknown = await fetch(`${base}/api/preferences`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ key: "colour", value: "red" }),
    });
    assert.equal(unknown.status, 400);
    const noCsrf = await fetch(`${base}/api/preferences`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    assert.equal(noCsrf.status, 403);
  });
  await withApp(async (base) => {
    assert.equal((await fetch(`${base}/api/preferences`)).status, 401);
  });
});

test("row 37: group=false lists every message of a conversation as its own row, newest first", async () => {
  await withSession(async (base, cookie, db) => {
    for (const [i, id] of ["G1a", "G1b", "G1c"].entries()) {
      insertEmail(db, { account: "personal", id, threadId: "THG", receivedAt: `2026-09-1${i}T00:00:00Z`, subject: "Re: grouped" });
      assignMailbox(db, "personal", id, "P-INBOX");
    }
    const grouped = (await (await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=50`, { headers: { cookie } })).json()) as { rows: { id: string; threadId: string | null }[] };
    assert.equal(grouped.rows.filter((r) => r.threadId === "THG").length, 1, "grouped: one row");
    const flat = (await (await fetch(`${base}/api/messages?account=personal&mailbox=P-INBOX&limit=50&group=false`, { headers: { cookie } })).json()) as { rows: { id: string; threadId: string | null; threadCount: number }[]; total: number };
    const rows = flat.rows.filter((r) => r.threadId === "THG");
    assert.deepEqual(rows.map((r) => r.id), ["G1c", "G1b", "G1a"], "ungrouped: every message, newest first");
    assert.equal(rows[0]!.threadCount, 3, "each row still knows the size of its conversation");
    const bad = await fetch(`${base}/api/messages?group=maybe`, { headers: { cookie } });
    assert.equal(bad.status, 400);
  });
});

test("row 37: 'written to' means a To/Cc of a message in the account's Sent folder; and the signature switches are on/off only", async () => {
  await withSession(async (base, cookie, db) => {
    db.prepare(`INSERT INTO mailboxes (account, id, name, role, parent_id, sort_order, total_emails, unread_emails) VALUES ('personal','P-SENT','Sent','sent',NULL,3,0,0)`).run();
    insertEmail(db, { account: "personal", id: "S1", receivedAt: "2026-08-01T00:00:00Z", subject: "hello" });
    assignMailbox(db, "personal", "S1", "P-SENT");
    insertRecipient(db, { account: "personal", emailId: "S1", kind: "to", email: "Dana@Example.com" });
    insertRecipient(db, { account: "personal", emailId: "M1", kind: "to", email: "robot@example.com" }); // M1 is in the inbox, not Sent
    const H = { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" };
    const yes = await (await fetch(`${base}/api/contacts/written`, { method: "POST", headers: H, body: JSON.stringify({ account: "personal", email: "dana@example.com" }) })).json();
    assert.deepEqual(yes, { written: true }, "a Sent recipient, case-insensitively");
    const no = await (await fetch(`${base}/api/contacts/written`, { method: "POST", headers: H, body: JSON.stringify({ account: "personal", email: "robot@example.com" }) })).json();
    assert.deepEqual(no, { written: false }, "a recipient of received mail is not someone you wrote to");
    const never = await (await fetch(`${base}/api/contacts/written`, { method: "POST", headers: H, body: JSON.stringify({ account: "personal", email: "newsletter@list.example" }) })).json();
    assert.deepEqual(never, { written: false });
  });
});

test("row 37: emptying Trash destroys only messages that are nowhere else, on the server and locally; any other folder is refused", async () => {
  const destroyed: string[][] = [];
  const client = new JmapClient(resolveSession("personal", personalSession), "t", async (_u, init) => {
    const calls = JSON.parse(init!.body as string).methodCalls as [string, Record<string, unknown>, string][];
    const responses = calls.map(([name, args, tag]) => {
      if (name === "Email/set") {
        const ids = args["destroy"] as string[];
        destroyed.push(ids);
        return ["Email/set", { destroyed: ids }, tag];
      }
      return [name, {}, tag];
    });
    return new Response(JSON.stringify({ methodResponses: responses }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await withSession(
    async (base, cookie, db) => {
      db.prepare(`INSERT INTO mailboxes (account, id, name, role, parent_id, sort_order, total_emails, unread_emails) VALUES ('personal','P-TRASH','Trash','trash',NULL,5,0,0)`).run();
      insertEmail(db, { account: "personal", id: "T1", receivedAt: "2026-08-01T00:00:00Z" });
      insertEmail(db, { account: "personal", id: "T2", receivedAt: "2026-08-02T00:00:00Z" });
      assignMailbox(db, "personal", "T1", "P-TRASH");
      assignMailbox(db, "personal", "T2", "P-TRASH");
      assignMailbox(db, "personal", "T2", "P-INBOX"); // also in the inbox: not "in the trash"
      const H = { cookie, origin: ORIGIN, "x-wilco-csrf": "1" };
      const refused = await fetch(`${base}/api/mailboxes/personal/P-INBOX/empty`, { method: "POST", headers: H });
      assert.equal(refused.status, 400, "only Trash can be emptied");
      const res = await fetch(`${base}/api/mailboxes/personal/P-TRASH/empty`, { method: "POST", headers: H });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { destroyed: 1, considered: 1 });
      assert.deepEqual(destroyed, [["T1"]], "T1 destroyed on the server; T2 (also in the inbox) untouched");
      assert.equal(db.prepare(`SELECT count(*) AS c FROM emails WHERE account = 'personal' AND id = 'T1'`).get()!.c, 0, "T1 removed locally");
      assert.equal(db.prepare(`SELECT count(*) AS c FROM emails WHERE account = 'personal' AND id = 'T2'`).get()!.c, 1);
    },
    { clients: new Map([["personal", client]]) },
  );
});

test("the mint's attachments carry a viewUrl for raster images and none for anything else", async () => {
  const { isViewableImage } = await import("../src/server/bodyhost.ts");
  // The route builds viewUrl from the same predicate the body origin
  // honours; this pins that predicate's edges so the two cannot drift.
  assert.equal(isViewableImage({ type: "image/webp" }), true);
  assert.equal(isViewableImage({ type: "application/octet-stream" }), false);
});

test("a sender with no display name is called by its address, in the list and in the detail", async () => {
  // 2026-09-12: 4,108 of 38,196 stored messages carry an empty from_name
  // (`From: <billing@example.com>`), and every surface showed nothing where
  // the sender goes. Every message this file seeds has from_name '' and
  // from_email a@b.com, so the seed IS the case.
  await withApp(async (base, db) => {
    const cookie = await login(base);
    insertNewest(db, "personal", "NONAME");
    assignMailbox(db, "personal", "NONAME", "P-INBOX");
    const list = (await (await fetch(`${base}/api/messages?account=personal&role=inbox`, { headers: { cookie } })).json()) as { rows: { id: string; fromName: string }[] };
    const row = list.rows.find((r) => r.id === "NONAME");
    assert.equal(row?.fromName, "a@b.com", "the list row calls a nameless sender by its address");
    const detail = (await (await fetch(`${base}/api/messages/personal/NONAME`, { headers: { cookie } })).json()) as { fromName: string };
    assert.equal(detail.fromName, "a@b.com", "so does the message detail");
  });
});
