import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { allowSenderImages, forgetSenderImages, senderImagesAllowed } from "../src/core/mutations.ts";
import { openDb, MIGRATIONS, SCHEMA_VERSION, applyMigrations } from "../src/core/db.ts";
import { tempDbPath, tempDir } from "./tmpdir.ts";

function tmpPath(): string {
  return tempDbPath();
}

test("migrations are ordered, contiguous, and start at 1", () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, versions.slice().sort((a, b) => a - b), "must be ordered");
  assert.deepEqual(versions, Array.from({ length: versions.length }, (_, i) => i + 1),
    "must be contiguous from 1 — a gap means a database can never reach the current version");
  assert.equal(SCHEMA_VERSION, versions[versions.length - 1]);
});

test("a version-1 database is migrated up to the current version, keeping its data", () => {
  // The live database is a populated v1. This is the test standing between
  // 37,586 real messages and a bad migration.
  //
  // The v1 fixture is built by opening a fresh (current-version) database and
  // dropping everything migration 2+ added, rather than by exposing migration
  // 1's raw SQL through a test-only field on the production Migration type.
  const p = tmpPath();
  openDb(p).close();
  const db = new DatabaseSync(p);
  db.exec("DROP TABLE credentials");
  db.exec("DROP TABLE accounts");
  db.exec("DROP TABLE meta");
  db.exec("DROP INDEX emails_undetailed");
  db.exec("DROP TABLE email_recipients");
  db.exec("DROP TABLE email_attachments");
  db.exec("DROP TABLE saved_searches");
  db.exec("DROP TABLE api_tokens");
  db.exec("ALTER TABLE emails DROP COLUMN via");
  db.exec("ALTER TABLE emails DROP COLUMN details_at");
  db.exec("ALTER TABLE emails DROP COLUMN has_html");
  db.exec("DROP TABLE sender_image_allow");
  db.exec("DROP TABLE settings"); // migration 7
  db.exec("DROP INDEX IF EXISTS emails_thread_key"); // migration 10
  db.exec("DROP INDEX IF EXISTS email_mailboxes_recent"); // migration 11
  db.exec("DROP INDEX IF EXISTS email_mailboxes_thread"); // migration 11
  db.exec("ALTER TABLE email_mailboxes DROP COLUMN received_at"); // migration 11
  db.exec("ALTER TABLE email_mailboxes DROP COLUMN thread_key"); // migration 11
  db.exec("PRAGMA user_version = 1");
  db.exec(`INSERT INTO emails (account, id, received_at, subject)
           VALUES ('personal', 'm1', '2026-01-01T00:00:00Z', 'keep me')`);
  db.close();

  const migrated = openDb(p);
  const { user_version } = migrated.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(user_version, SCHEMA_VERSION);
  const row = migrated.prepare("SELECT subject FROM emails WHERE id = 'm1'").get() as { subject: string };
  assert.equal(row.subject, "keep me", "existing mail must survive the migration");
  migrated.close();
});

test("A FAILING MIGRATION ROLLS BACK AND LEAVES THE VERSION UNCHANGED", () => {
  const p = tmpPath();
  openDb(p).close();                                 // now at SCHEMA_VERSION

  const db = new DatabaseSync(p);
  const before = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

  const bad = [{ version: before + 1, up: (d: DatabaseSync) => {
    d.exec("CREATE TABLE half_done (a TEXT)");
    d.exec("THIS IS NOT SQL");                       // throws mid-migration
  } }];

  assert.throws(() => applyMigrations(db, bad));

  const after = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.equal(after, before, "a failed migration must not advance the version");
  const tables = db.prepare(
    "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='half_done'",
  ).get() as { c: number };
  assert.equal(tables.c, 0, "and must not leave half its work behind");
  db.close();
});

test("migrations apply in order, not all at once", () => {
  const p = tmpPath();
  const db = new DatabaseSync(p);
  const seen: number[] = [];
  applyMigrations(db, [
    { version: 1, up: () => { seen.push(1); db.exec("CREATE TABLE a (x TEXT)"); } },
    { version: 2, up: () => { seen.push(2); db.exec("CREATE TABLE b (x TEXT)"); } },
    { version: 3, up: () => { seen.push(3); db.exec("CREATE TABLE c (x TEXT)"); } },
  ]);
  assert.deepEqual(seen, [1, 2, 3]);
  db.close();
});

test("a migration already applied is not re-run", () => {
  const p = tmpPath();
  const db = new DatabaseSync(p);
  let runs = 0;
  const m = [{ version: 1, up: () => { runs += 1; db.exec("CREATE TABLE once (x TEXT)"); } }];
  applyMigrations(db, m);
  applyMigrations(db, m);
  assert.equal(runs, 1, "re-running migration 1 would throw on the duplicate table anyway");
  db.close();
});

test("migration 3 adds the read-surface tables without touching the archive", () => {
  const dir = tempDir("m3");
  const dbPath = path.join(dir, "wilco.db");
  const db = openDb(dbPath);

  // A message that must survive, with a mailbox membership and an FTS row.
  db.exec(`
    INSERT INTO emails (account, id, thread_id, received_at, subject,
                        from_name, from_email, preview, body_text)
    VALUES ('personal', 'M1', 'T1', '2026-01-01T00:00:00Z', 'keep me',
            'Robin', 'robin@halden.example', 'hello', 'body words here');
    INSERT INTO email_mailboxes (account, email_id, mailbox_id)
    VALUES ('personal', 'M1', 'P-F');
  `);

  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(user_version, SCHEMA_VERSION, "openDb runs every migration, not just 3");

  // The four new tables exist and are STRICT.
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all() as { name: string }[]).map((r) => r.name);
  for (const t of ["email_recipients", "email_attachments", "saved_searches", "api_tokens"]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }

  // The new emails columns exist and default to NULL.
  const row = db.prepare(
    "SELECT via, details_at, subject FROM emails WHERE account='personal' AND id='M1'",
  ).get() as { via: string | null; details_at: string | null; subject: string };
  assert.equal(row.subject, "keep me", "the archive row survived migration 3");
  assert.equal(row.via, null);
  assert.equal(row.details_at, null, "NULL means never fetched, not 'no details'");

  // FTS still works after the ALTER — the external-content table is unchanged.
  const hits = db.prepare(
    "SELECT count(*) AS c FROM emails_fts WHERE emails_fts MATCH ?",
  ).get('"body"*') as { c: number };
  assert.equal(hits.c, 1, "the FTS index still matches the pre-existing row");

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("recipients and attachments cascade when their message is deleted", () => {
  const dir = tempDir("m3c");
  const db = openDb(path.join(dir, "wilco.db"));
  db.exec(`
    INSERT INTO emails (account, id, received_at) VALUES ('personal','M1','2026-01-01T00:00:00Z');
    INSERT INTO email_recipients (account, email_id, kind, name, email)
      VALUES ('personal','M1','to','Robin','robin@halden.example');
    INSERT INTO email_attachments (account, email_id, part_id, name, type, size, cid)
      VALUES ('personal','M1','2','budget.pdf','application/pdf',1024,NULL);
    DELETE FROM emails WHERE account='personal' AND id='M1';
  `);
  const r = db.prepare("SELECT count(*) AS c FROM email_recipients").get() as { c: number };
  const a = db.prepare("SELECT count(*) AS c FROM email_attachments").get() as { c: number };
  assert.equal(r.c, 0, "recipients cascaded");
  assert.equal(a.c, 0, "attachments cascaded");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migration 4 adds has_html, nullable and defaulting to NULL, without disturbing FTS", () => {
  const dir = tempDir("m4");
  const dbPath = path.join(dir, "wilco.db");
  const db = openDb(dbPath);

  db.exec(`
    INSERT INTO emails (account, id, thread_id, received_at, subject,
                        from_name, from_email, preview, body_text)
    VALUES ('personal', 'M1', 'T1', '2026-01-01T00:00:00Z', 'keep me',
            'Robin', 'robin@halden.example', 'hello', 'body words here');
  `);

  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(user_version, SCHEMA_VERSION);

  const row = db.prepare(
    "SELECT has_html FROM emails WHERE account='personal' AND id='M1'",
  ).get() as { has_html: number | null };
  assert.equal(row.has_html, null, "NULL means never determined, not 'no HTML part'");

  // FTS still matches the pre-existing row after the ALTER -- has_html is
  // not one of the columns emails_fts references, so it needs no reindex.
  const hits = db.prepare(
    "SELECT count(*) AS c FROM emails_fts WHERE emails_fts MATCH ?",
  ).get('"body"*') as { c: number };
  assert.equal(hits.c, 1, "the FTS index still matches the pre-existing row after migration 4");

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migration 5 adds accounts.code without touching the archive", () => {
  const dir = tempDir("m5");
  const db = openDb(path.join(dir, "wilco.db"));
  db.exec(`INSERT INTO emails (account, id, received_at, subject)
           VALUES ('personal','M1','2026-01-01T00:00:00Z','keep me')`);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  const cols = (db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("code"));
  const row = db.prepare("SELECT subject FROM emails WHERE id='M1'").get() as { subject: string };
  assert.equal(row.subject, "keep me");
  const hits = db.prepare("SELECT count(*) AS c FROM emails_fts WHERE emails_fts MATCH ?").get('"keep"*') as { c: number };
  assert.equal(hits.c, 1, "FTS still matches after the ALTER");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a version-3 database migrates to 4, keeping has_html NULL for existing rows", () => {
  // Mirrors the v1 fixture above, one migration shallower: build a v3
  // database by dropping just what migration 4 added, then confirm the
  // upgrade path preserves data and leaves has_html unset.
  const p = tmpPath();
  openDb(p).close();
  const db = new DatabaseSync(p);
  db.exec("ALTER TABLE emails DROP COLUMN has_html");
  db.exec("ALTER TABLE accounts DROP COLUMN code");
  db.exec("DROP TABLE sender_image_allow");
  db.exec("DROP TABLE settings"); // migration 7
  db.exec("DROP INDEX IF EXISTS emails_thread_key"); // migration 10
  db.exec("DROP INDEX IF EXISTS email_mailboxes_recent"); // migration 11
  db.exec("DROP INDEX IF EXISTS email_mailboxes_thread"); // migration 11
  db.exec("ALTER TABLE email_mailboxes DROP COLUMN received_at"); // migration 11
  db.exec("ALTER TABLE email_mailboxes DROP COLUMN thread_key"); // migration 11
  db.exec("DROP INDEX IF EXISTS emails_unread"); // migration 12
  db.exec("ALTER TABLE email_attachments DROP COLUMN disposition"); // migration 13
  db.exec("PRAGMA user_version = 3");
  db.exec(`INSERT INTO emails (account, id, received_at, subject)
           VALUES ('personal', 'm1', '2026-01-01T00:00:00Z', 'keep me')`);
  db.close();

  const migrated = openDb(p);
  const { user_version } = migrated.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(user_version, SCHEMA_VERSION);
  const row = migrated.prepare(
    "SELECT subject, has_html FROM emails WHERE id = 'm1'",
  ).get() as { subject: string; has_html: number | null };
  assert.equal(row.subject, "keep me");
  assert.equal(row.has_html, null);
  migrated.close();
});

test("migration 6 adds the per-sender image allowance without touching the archive", () => {
  // Handoff v1.1 #2's "Always from this sender" needs somewhere to live, or
  // the control forgets by the next time you open that sender's mail.
  const p = tmpPath();
  const db = openDb(p);
  db.exec(`INSERT INTO emails (account, id, received_at, subject)
           VALUES ('personal', 'm1', '2026-01-01T00:00:00Z', 'keep me')`);

  allowSenderImages(db, "personal", "News@Example.test");
  // 🚨 Lowercased on the way in AND out: senders vary the casing of their
  // own From line between sends, and an allowance granted once must not
  // stop applying because of it.
  assert.equal(senderImagesAllowed(db, "personal", "news@example.test"), true);
  assert.equal(senderImagesAllowed(db, "personal", "NEWS@EXAMPLE.TEST"), true);
  assert.equal(senderImagesAllowed(db, "personal", " news@example.test "), true);

  // Scoped per account: allowing a newsletter in one is not a statement
  // about another.
  assert.equal(senderImagesAllowed(db, "work", "news@example.test"), false);

  // Idempotent -- clicking twice must not throw on the primary key.
  assert.doesNotThrow(() => allowSenderImages(db, "personal", "news@example.test"));

  assert.equal(forgetSenderImages(db, "personal", "news@example.test"), 1);
  assert.equal(senderImagesAllowed(db, "personal", "news@example.test"), false);

  const row = db.prepare("SELECT subject FROM emails WHERE id = 'm1'").get() as { subject: string };
  assert.equal(row.subject, "keep me", "the archive is untouched");
  db.close();
});

test("migration 10 adds emails_thread_key and advances user_version to 10", () => {
  const p = tmpPath();
  const db = openDb(p);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 10);

  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='emails_thread_key'",
  ).all() as { name: string }[]).map((r) => r.name);
  assert.ok(names.includes("emails_thread_key"), "emails_thread_key must exist after migration 10");
  db.close();
});

test("migration 10's index is actually used by the grouped thread-key query", () => {
  const p = tmpPath();
  const db = openDb(p);
  db.exec(`
    INSERT INTO emails (account, id, thread_id, received_at, subject)
    VALUES
      ('personal', 'M1', 'T1', '2026-01-01T00:00:00Z', 'a'),
      ('personal', 'M2', 'T1', '2026-01-02T00:00:00Z', 'b'),
      ('personal', 'M3', NULL, '2026-01-03T00:00:00Z', 'c'),
      ('personal', 'M4', NULL, '2026-01-04T00:00:00Z', 'd');
  `);

  const plan = db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT COALESCE(thread_id,id) k, count(*) n FROM emails
     WHERE account = ? AND COALESCE(thread_id,id) IN (?,?)
     GROUP BY COALESCE(thread_id,id)`,
  ).all("personal", "T1", "M3") as { detail: string }[];

  const usesIndex = plan.some((row) => row.detail.includes("emails_thread_key"));
  assert.ok(usesIndex, `expected emails_thread_key in query plan, got: ${JSON.stringify(plan)}`);
  db.close();
});

test("migration 10 is idempotent against a database that already has the index by hand", () => {
  // Mirrors the live 167k-row database: the index was created by hand
  // during diagnosis, on a database already at version 9, before this
  // migration existed. The migration must not throw on the duplicate.
  const p = tmpPath();
  openDb(p).close(); // fully migrated, including (once implemented) migration 10
  const db = new DatabaseSync(p);
  db.exec("DROP INDEX IF EXISTS emails_thread_key");
  db.exec("DROP INDEX IF EXISTS email_mailboxes_recent"); // migration 11, re-added below
  db.exec("DROP INDEX IF EXISTS email_mailboxes_thread"); // migration 11, re-added below
  db.exec("ALTER TABLE email_mailboxes DROP COLUMN received_at"); // migration 11, re-added below
  db.exec("ALTER TABLE email_mailboxes DROP COLUMN thread_key"); // migration 11, re-added below
  db.exec("PRAGMA user_version = 9");
  db.exec(
    "CREATE INDEX emails_thread_key ON emails(account, COALESCE(thread_id, id), received_at DESC)",
  );
  db.close();

  assert.doesNotThrow(() => {
    const reopened = openDb(p);
    reopened.close();
  });

  const migrated = new DatabaseSync(p);
  const { user_version } = migrated.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(user_version, SCHEMA_VERSION);
  migrated.close();
});

test("migration 11 adds received_at and thread_key to email_mailboxes and advances user_version to 11", () => {
  const p = tmpPath();
  const db = openDb(p);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  // >= rather than ===, same relaxation migration 10's equivalent assertion
  // got in this branch (M7 review finding): a hard `equal(SCHEMA_VERSION,
  // 11)` fails the instant migration 12 lands, for a reason that has
  // nothing to do with what this test actually checks (that migration 11's
  // columns exist).
  assert.ok(SCHEMA_VERSION >= 11);

  const cols = (db.prepare("PRAGMA table_info(email_mailboxes)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("received_at"), "email_mailboxes.received_at must exist after migration 11");
  assert.ok(cols.includes("thread_key"), "email_mailboxes.thread_key must exist after migration 11");
  db.close();
});

test("migration 11 backfills received_at and thread_key from emails, including NULL thread_id rows", () => {
  // Seed a v10-shaped database (a fresh open is already v11 once implemented,
  // so build the fixture by hand, add data, force the version back to 10,
  // and reopen to run migration 11 against it).
  const p = tmpPath();
  openDb(p).close();
  const db = new DatabaseSync(p);
  db.exec("DROP INDEX IF EXISTS email_mailboxes_recent");
  db.exec("DROP INDEX IF EXISTS email_mailboxes_thread");
  db.exec("ALTER TABLE email_mailboxes DROP COLUMN received_at");
  db.exec("ALTER TABLE email_mailboxes DROP COLUMN thread_key");
  db.exec("PRAGMA user_version = 10");

  db.exec(`
    INSERT INTO emails (account, id, thread_id, received_at, subject)
    VALUES
      ('personal', 'M1', 'T1', '2026-01-01T00:00:00Z', 'a'),
      ('personal', 'M2', NULL, '2026-01-02T00:00:00Z', 'b');
    INSERT INTO email_mailboxes (account, email_id, mailbox_id) VALUES
      ('personal', 'M1', 'P-F'),
      ('personal', 'M2', 'P-F');
  `);
  db.close();

  const migrated = openDb(p);
  const { user_version } = migrated.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(user_version, SCHEMA_VERSION);

  const rows = (migrated.prepare(
    `SELECT email_id, received_at, thread_key FROM email_mailboxes WHERE account = 'personal' ORDER BY email_id`,
  ).all() as { email_id: string; received_at: string; thread_key: string }[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { email_id: "M1", received_at: "2026-01-01T00:00:00Z", thread_key: "T1" },
    { email_id: "M2", received_at: "2026-01-02T00:00:00Z", thread_key: "M2" },
  ]);
  migrated.close();
});

test("migration 11's recent index covers the newest-first-per-mailbox scan", () => {
  const p = tmpPath();
  const db = openDb(p);
  db.exec(`
    INSERT INTO emails (account, id, thread_id, received_at, subject) VALUES
      ('personal', 'M1', 'T1', '2026-01-01T00:00:00Z', 'a'),
      ('personal', 'M2', NULL, '2026-01-02T00:00:00Z', 'b');
    INSERT INTO email_mailboxes (account, email_id, mailbox_id, received_at, thread_key) VALUES
      ('personal', 'M1', 'P-F', '2026-01-01T00:00:00Z', 'T1'),
      ('personal', 'M2', 'P-F', '2026-01-02T00:00:00Z', 'M2');
  `);

  // Pinned to the WALK's real order (`m.received_at DESC, m.email_id ASC`
  // in `list.ts`'s `walkScope`), not just its leading column -- the whole
  // reason the column order in `email_mailboxes_recent` was reversed to
  // `(account, mailbox_id, received_at DESC, email_id, thread_key)`. A test
  // that only EXPLAINs `ORDER BY received_at DESC` still gets a covering
  // index scan if that reorder is swapped back (M6 review finding): the
  // covering-index sort-avoidance property survives even with the tie-break
  // column missing from the ORDER BY, so this would not have caught a
  // regression back to the old column order.
  const plan = db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT email_id, received_at, thread_key FROM email_mailboxes
     WHERE account = ? AND mailbox_id = ? ORDER BY received_at DESC, email_id ASC LIMIT 65`,
  ).all("personal", "P-F") as { detail: string }[];

  const detail = plan.map((r) => r.detail).join(" | ");
  assert.ok(detail.includes("email_mailboxes_recent"), `expected email_mailboxes_recent in plan, got: ${detail}`);
  assert.ok(detail.toUpperCase().includes("COVERING"), `expected a covering index scan, got: ${detail}`);
  db.close();
});

test("migration 11's thread index covers the distinct-thread-count scan", () => {
  const p = tmpPath();
  const db = openDb(p);
  db.exec(`
    INSERT INTO emails (account, id, thread_id, received_at, subject) VALUES
      ('personal', 'M1', 'T1', '2026-01-01T00:00:00Z', 'a'),
      ('personal', 'M2', NULL, '2026-01-02T00:00:00Z', 'b');
    INSERT INTO email_mailboxes (account, email_id, mailbox_id, received_at, thread_key) VALUES
      ('personal', 'M1', 'P-F', '2026-01-01T00:00:00Z', 'T1'),
      ('personal', 'M2', 'P-F', '2026-01-02T00:00:00Z', 'M2');
  `);

  const plan = db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT count(DISTINCT thread_key) FROM email_mailboxes WHERE account = ? AND mailbox_id = ?`,
  ).all("personal", "P-F") as { detail: string }[];

  const detail = plan.map((r) => r.detail).join(" | ");
  assert.ok(detail.includes("email_mailboxes_thread"), `expected email_mailboxes_thread in plan, got: ${detail}`);
  assert.ok(detail.toUpperCase().includes("COVERING"), `expected a covering index scan, got: ${detail}`);
  db.close();
});
