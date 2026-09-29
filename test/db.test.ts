import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openDb,
  rebuildDatabase,
  UnusableDatabase,
  FutureSchemaVersion,
  SCHEMA_VERSION,
} from "../src/core/db.ts";
import { tempDbPath } from "./tmpdir.ts";

function tmpPath(): string {
  return tempDbPath();
}

test("a fresh database is created at the current schema version", () => {
  const db = openDb(tmpPath());
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(user_version, SCHEMA_VERSION);
  db.close();
});

test("WAL and busy_timeout are set", () => {
  const db = openDb(tmpPath());
  const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(mode.journal_mode.toLowerCase(), "wal");
  const bt = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  assert.ok(bt.timeout >= 5000, "a nightly snapshot will collide with the sync loop");
  db.close();
});

test("opening an existing database twice is a no-op", () => {
  const p = tmpPath();
  openDb(p).close();
  const db = openDb(p);
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(user_version, SCHEMA_VERSION);
  db.close();
});

test("a database from a NEWER build is refused, not opened", () => {
  const p = tmpPath();
  const raw = new DatabaseSync(p);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
  raw.close();
  // FutureSchemaVersion IS an UnusableDatabase (a subclass), so this
  // pre-existing assertion still holds -- see the more specific one below.
  assert.throws(() => openDb(p), UnusableDatabase);
});

test("a database from a NEWER build throws the more specific FutureSchemaVersion, naming both versions", () => {
  const p = tmpPath();
  const raw = new DatabaseSync(p);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
  raw.close();

  assert.throws(() => openDb(p), (err: unknown) => {
    assert.ok(err instanceof FutureSchemaVersion);
    assert.equal(err.foundVersion, SCHEMA_VERSION + 5);
    assert.equal(err.expectedVersion, SCHEMA_VERSION);
    assert.match(err.message, new RegExp(`schema version ${SCHEMA_VERSION + 5}`));
    assert.match(err.message, new RegExp(`understands ${SCHEMA_VERSION}`));
    return true;
  });
});

test("a genuinely unopenable database throws UnusableDatabase, NOT FutureSchemaVersion", () => {
  const p = tmpPath();
  // A directory exists (tmpPath's parent) but the file itself is garbage --
  // this is the truncated/overwritten-mid-write shape from a real power
  // loss, not a version mismatch: node:sqlite refuses to open it at all.
  writeFileSync(p, "not a real sqlite file, just garbage bytes to corrupt it");

  assert.throws(() => openDb(p), (err: unknown) => {
    assert.ok(err instanceof UnusableDatabase);
    assert.ok(!(err instanceof FutureSchemaVersion));
    return true;
  });
});

test("a permission-denied database file is NOT unusable -- it propagates untouched (review fix: Critical 1)", () => {
  // The parent directory stays writable throughout; only the file itself is
  // locked down. This is the exact shape of wrong ownership/permissions on
  // /data after a volume restore -- the failure this fix exists to NOT
  // classify as "cache is gone, rebuild it". A fresh empty database would
  // not fix a permissions problem, and rebuilding it would wipe real data
  // sitting behind a fixable mistake.
  const p = tmpPath();
  openDb(p).close();
  chmodSync(p, 0o000);
  try {
    assert.throws(() => openDb(p), (err: unknown) => {
      assert.ok(!(err instanceof UnusableDatabase), "a permission error must propagate as itself");
      return true;
    });
    assert.ok(existsSync(p), "the file must still be at its original path");
    const dir = readdirSync(path.dirname(p));
    assert.ok(
      !dir.some((f) => f.includes(".unusable-")),
      "a permission error must never trigger a rename-aside",
    );
  } finally {
    chmodSync(p, 0o600);
  }
});

test("rebuildDatabase renames the file AND its sidecars", () => {
  const p = tmpPath();
  openDb(p).close();
  writeFileSync(`${p}-wal`, "stale");
  writeFileSync(`${p}-shm`, "stale");

  const renamed = rebuildDatabase(p);

  assert.ok(!existsSync(p), "the original must be moved out of the way");
  assert.ok(existsSync(renamed));
  const dir = readdirSync(path.dirname(p));
  assert.ok(!dir.includes("wilco.db-wal"), "a stale -wal beside a fresh db is a mismatched pair");
  assert.ok(!dir.includes("wilco.db-shm"));
});

test("the emails table exists with a composite primary key", () => {
  const db = openDb(tmpPath());
  db.prepare(
    `INSERT INTO emails (account, id, received_at) VALUES ('personal', 'P-F', '2026-01-01T00:00:00Z')`,
  ).run();
  // Same id, different account: this MUST be allowed, because Fastmail
  // accounts genuinely share ids (spec 4.2).
  db.prepare(
    `INSERT INTO emails (account, id, received_at) VALUES ('work', 'P-F', '2026-01-01T00:00:00Z')`,
  ).run();
  const { c } = db.prepare("SELECT count(*) AS c FROM emails").get() as { c: number };
  assert.equal(c, 2);
  db.close();
});

test("body_text defaults to NULL, meaning not-yet-backfilled", () => {
  const db = openDb(tmpPath());
  db.prepare(
    `INSERT INTO emails (account, id, received_at) VALUES ('personal', 'm1', '2026-01-01T00:00:00Z')`,
  ).run();
  const row = db.prepare("SELECT body_text FROM emails").get() as { body_text: string | null };
  assert.equal(row.body_text, null);
  db.close();
});

test("the FTS5 triggers keep the index in step through insert, update and delete", () => {
  const d = openDb(tmpPath());
  const matches = (q: string): number =>
    (d.prepare("SELECT count(*) AS c FROM emails_fts WHERE emails_fts MATCH ?").get(q) as { c: number }).c;

  d.prepare(
    `INSERT INTO emails (account, id, received_at, body_text)
     VALUES ('personal', 'm1', '2026-01-01T00:00:00Z', 'quick brown fox')`,
  ).run();
  assert.equal(matches('"brown"*'), 1, "insert trigger");

  d.prepare(`UPDATE emails SET body_text = 'lazy green dog' WHERE account='personal' AND id='m1'`).run();
  assert.equal(matches('"brown"*'), 0, "update trigger must remove the OLD text from the index");
  assert.equal(matches('"green"*'), 1, "and index the new text");

  d.prepare(`DELETE FROM emails WHERE account='personal' AND id='m1'`).run();
  assert.equal(matches('"green"*'), 0, "delete trigger must remove the row from the index");

  // An external-content FTS5 table stores no copy of the data, so a broken
  // delete leaves orphaned index entries rather than failing loudly.
  d.exec("INSERT INTO emails_fts(emails_fts) VALUES('integrity-check')");
  d.close();
});

test("migration 2 creates accounts and credentials without touching mail", () => {
  const d = openDb(tempDbPath());
  d.prepare(
    `INSERT INTO accounts (key, label, accent, provider, endpoint, created_at)
     VALUES ('personal', 'Personal', 'blue', 'jmap', 'https://api.fastmail.com/jmap/session', '2026-01-01T00:00:00Z')`,
  ).run();
  d.prepare(`INSERT INTO credentials (account, sealed, updated_at) VALUES ('personal', 'v1.a.b.c', '2026-01-01T00:00:00Z')`).run();

  const a = d.prepare("SELECT label, accent FROM accounts WHERE key='personal'").get() as any;
  assert.equal(a.label, "Personal");

  // The account key is the SAME text key emails.account already holds, which
  // is why no mail data migrates.
  d.prepare(`INSERT INTO emails (account, id, received_at) VALUES ('personal','m1','2026-01-01T00:00:00Z')`).run();
  const joined = d.prepare(
    `SELECT count(*) c FROM emails e JOIN accounts a ON a.key = e.account`,
  ).get() as any;
  assert.equal(joined.c, 1);
  d.close();
});

test("a credential row is deleted when its account is", () => {
  const d = openDb(tempDbPath());
  d.prepare(`INSERT INTO accounts (key,label,accent,provider,endpoint,created_at) VALUES ('x','X','blue','jmap','https://e','2026-01-01T00:00:00Z')`).run();
  d.prepare(`INSERT INTO credentials (account,sealed,updated_at) VALUES ('x','v1.a.b.c','2026-01-01T00:00:00Z')`).run();
  d.prepare(`DELETE FROM accounts WHERE key='x'`).run();
  const c = d.prepare("SELECT count(*) c FROM credentials").get() as any;
  assert.equal(c.c, 0, "an orphaned credential is a credential nobody knows they still have");
  d.close();
});
