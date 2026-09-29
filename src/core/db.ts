import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

export class UnusableDatabase extends Error {}

/**
 * The database file opened, but its `user_version` is AHEAD of what this
 * build understands. That is not a broken cache -- it is an operator error,
 * almost always a rollback to an older build after a migration already ran
 * (see `deploy.sh`'s guard). The data is intact and belongs to a NEWER
 * build, so it must never be moved aside and rebuilt: that would silently
 * discard exactly the thing an operator would want back. Boot refuses
 * loudly instead (`main.ts`'s catch), the same shape as a wrong master key.
 *
 * A subclass of `UnusableDatabase`, not a sibling: existing callers that
 * only test `instanceof UnusableDatabase` (there is at least one, in
 * `db.test.ts`) keep working, and the catch in `main.ts` distinguishes the
 * two by checking this MORE SPECIFIC type first.
 */
export class FutureSchemaVersion extends UnusableDatabase {
  readonly foundVersion: number;
  readonly expectedVersion: number;

  constructor(foundVersion: number, expectedVersion: number) {
    super(
      `database is at schema version ${foundVersion}, this build understands ${expectedVersion} -- deploy the newer build or restore a backup`,
    );
    this.foundVersion = foundVersion;
    this.expectedVersion = expectedVersion;
    this.name = "FutureSchemaVersion";
  }
}

export interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}

/**
 * Migration 1. NEVER edit this constant: existing databases already ran it, so
 * changing it makes the code describe something they do not contain. Schema
 * changes are new MIGRATIONS entries (spec 4.5).
 *
 * The FTS5 index is created here, with the first schema, deliberately. Adding
 * it to an already-populated store means re-downloading every archive.
 */
const SCHEMA = `
CREATE TABLE emails (
  account        TEXT NOT NULL,
  id             TEXT NOT NULL,
  thread_id      TEXT,
  received_at    TEXT NOT NULL,          -- ISO8601 UTC; sorts lexicographically
  subject        TEXT NOT NULL DEFAULT '',
  from_name      TEXT NOT NULL DEFAULT '',
  from_email     TEXT NOT NULL DEFAULT '',
  preview        TEXT NOT NULL DEFAULT '',
  body_text      TEXT,                   -- NULL = not backfilled; '' = nothing there
  is_unread      INTEGER NOT NULL DEFAULT 0,
  is_flagged     INTEGER NOT NULL DEFAULT 0,
  has_attachment INTEGER NOT NULL DEFAULT 0,
  keywords       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (account, id)
);

-- The unified inbox is an ORDER BY across every account. This index is what
-- makes the feature that motivated the project cost nothing.
CREATE INDEX emails_received_at ON emails(received_at DESC);
CREATE INDEX emails_thread ON emails(account, thread_id);
CREATE INDEX emails_unfetched ON emails(account, id) WHERE body_text IS NULL;

-- A message belongs to many mailboxes; JMAP models it that way and so do we.
CREATE TABLE email_mailboxes (
  account    TEXT NOT NULL,
  email_id   TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  PRIMARY KEY (account, email_id, mailbox_id)
);
CREATE INDEX email_mailboxes_by_mailbox ON email_mailboxes(account, mailbox_id);

CREATE TABLE mailboxes (
  account       TEXT NOT NULL,
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT,
  parent_id     TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  total_emails  INTEGER NOT NULL DEFAULT 0,
  unread_emails INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, id)
);

CREATE TABLE sync_state (
  account    TEXT NOT NULL,
  kind       TEXT NOT NULL,              -- 'email' | 'mailbox' | 'walk'
  state      TEXT NOT NULL,              -- opaque to everything but the provider
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account, kind)
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE emails_fts USING fts5(
  subject, from_name, from_email, preview, body_text,
  content = 'emails',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER emails_ai AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, from_name, from_email, preview, body_text)
  VALUES (new.rowid, new.subject, new.from_name, new.from_email, new.preview, new.body_text);
END;

CREATE TRIGGER emails_ad AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_email, preview, body_text)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_email, old.preview, old.body_text);
END;

CREATE TRIGGER emails_au AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_email, preview, body_text)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_email, old.preview, old.body_text);
  INSERT INTO emails_fts(rowid, subject, from_name, from_email, preview, body_text)
  VALUES (new.rowid, new.subject, new.from_name, new.from_email, new.preview, new.body_text);
END;
`;

// Accounts are runtime configuration (spec 8.6), keyed by the SAME text key
// that emails.account, email_mailboxes.account, mailboxes.account and
// sync_state.account already store. That is deliberate: it means adding this
// table migrates no mail data at all.
//
// meta is a generic key/value table for schema-level singletons — nothing in
// this migration writes to it. Task 5/6 will store the master-key salt there
// at meta('master_key_salt').
const MIGRATION_2 = `
CREATE TABLE accounts (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  accent     TEXT NOT NULL,
  provider   TEXT NOT NULL DEFAULT 'jmap',
  endpoint   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  position   INTEGER
);

-- Sealed with the master key (src/core/crypto.ts). One row per account; the
-- foreign key makes an orphaned credential impossible, because a credential
-- nobody knows they still have is the worst kind.
CREATE TABLE credentials (
  account    TEXT PRIMARY KEY REFERENCES accounts(key) ON DELETE CASCADE,
  sealed     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

// Recipients as a junction, not a JSON column, because `to:` and `cc:` are
// search predicates: a JSON scan over 37.6k rows to answer "to:robin" is the
// same mistake email_mailboxes exists to avoid (4.3). The FK to emails
// (account, id) with ON DELETE CASCADE only fires because openDb sets
// foreign_keys = ON — the cascade test proves it.
//
// Attachments, saved searches and api tokens: saved_searches stores the
// QUERY TEXT, never a materialised result set, so it re-runs and cannot go
// stale (7.3), and it is server-side so two devices cannot disagree about
// what exists. api_tokens never stores a plaintext token, only its SHA-256
// hash (7.1), so a leaked database yields no usable credential; 'read' is
// the default scope because a token that can EmailSubmission/set from your
// identities is the highest-value credential in the system.
const MIGRATION_3 = `
CREATE TABLE email_recipients (
  account  TEXT NOT NULL,
  email_id TEXT NOT NULL,
  kind     TEXT NOT NULL,          -- 'to' | 'cc' | 'bcc' | 'reply-to'
  name     TEXT NOT NULL DEFAULT '',
  email    TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (account, email_id) REFERENCES emails(account, id) ON DELETE CASCADE
) STRICT;

-- The index that makes to:/cc: an indexed lookup rather than a scan. email
-- is lowercased on write (see details.ts), so this is usable for equality
-- and for a prefix LIKE without a COLLATE surprise.
CREATE INDEX email_recipients_email ON email_recipients(email);
CREATE INDEX email_recipients_msg ON email_recipients(account, email_id);

CREATE TABLE email_attachments (
  account  TEXT NOT NULL,
  email_id TEXT NOT NULL,
  part_id  TEXT NOT NULL,
  name     TEXT NOT NULL DEFAULT '',
  type     TEXT NOT NULL DEFAULT '',
  size     INTEGER NOT NULL DEFAULT 0,
  cid      TEXT,                    -- inline images; NULL for real attachments
  PRIMARY KEY (account, email_id, part_id),
  FOREIGN KEY (account, email_id) REFERENCES emails(account, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE saved_searches (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  query      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE api_tokens (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE,
  scope      TEXT NOT NULL DEFAULT 'read',   -- 'read' | 'write'
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used  TEXT
) STRICT;
`;

// Every new migration added here must also extend the hand-maintained v1
// fixture in test/migrations.test.ts -- that fixture asserts a fresh
// applyMigrations() run produces the same schema as building from v1 and
// replaying every migration on top of it, and it does NOT do so
// automatically just because a new entry landed here. Migration 4
// remembered this; nothing enforces it (fix wave, finding 9).
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(SCHEMA);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(MIGRATION_2);
    },
  },
  {
    version: 3,
    up(db: DatabaseSync): void {
      db.exec(MIGRATION_3);

      // Two columns on the existing table. ALTER TABLE ADD COLUMN is O(1) in
      // SQLite -- it rewrites the schema, not the 37.6k rows -- and because
      // emails_fts is external-content over a NAMED column list, adding a
      // column emails_fts does not reference leaves the index untouched.
      // That is why this is safe to run against the live archive with no
      // reindex.
      db.exec(`
        ALTER TABLE emails ADD COLUMN via TEXT;
        ALTER TABLE emails ADD COLUMN details_at TEXT;
      `);

      // Same three-state rule as body_text: NULL = never fetched, a
      // timestamp = fetched (even if the message had no recipients and no
      // attachments). A boolean could not tell those apart and the backfill
      // would retry the empty ones forever.
      db.exec(`
        CREATE INDEX emails_undetailed ON emails(account, id) WHERE details_at IS NULL;
      `);
    },
  },
  {
    version: 4,
    up(db: DatabaseSync): void {
      // Same three-state convention as body_text/details_at: NULL = never
      // determined, 0 = determined, no HTML part, 1 = determined, has one.
      // NOT NULL DEFAULT 0 would make "never looked" indistinguishable
      // from "looked, no HTML" -- exactly the bug those two columns are
      // shaped to avoid, and the reason getMessage() cannot honestly
      // report `false` for a message whose details were never fetched
      // (task-6b brief).
      //
      // ALTER TABLE ADD COLUMN is O(1) here too, and has_html is not one
      // of the named columns emails_fts indexes, so -- same as migration
      // 3's via/details_at -- no reindex is needed. Proven by a test, not
      // asserted: FTS is queried against a pre-existing row after this
      // ALTER.
      db.exec(`ALTER TABLE emails ADD COLUMN has_html INTEGER;`);
    },
  },
  {
    version: 5,
    up(db: DatabaseSync): void {
      // A short uppercase code shown on every row and account block in the
      // design (task-1 brief). NOT NULL with an empty-string default -- not
      // nullable -- so this is safe against the four live accounts without
      // a backfill; Task 9 gives them their real codes. addAccount() fills
      // in a default (first three letters of the key, uppercased) for any
      // NEW account created after this migration.
      db.exec(`ALTER TABLE accounts ADD COLUMN code TEXT NOT NULL DEFAULT '';`);
    },
  },
  {
    version: 6,
    up(db: DatabaseSync): void {
      // Handoff v1.1 #2's "Always from this sender". Without somewhere to
      // put it that control is a button that does nothing the next time you
      // open the sender's mail -- which is worse than not offering it.
      //
      // Keyed on the LOWERCASED address: senders vary the casing of their
      // own From line between sends, and an allowance the reader granted
      // once must not stop applying because of it.
      //
      // Scoped per account: allowing a newsletter's images in the personal
      // account is not a statement about the work one.
      db.exec(`
        CREATE TABLE sender_image_allow (
          account TEXT NOT NULL,
          sender  TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (account, sender)
        ) STRICT;
      `);
    },
  },
  {
    version: 7,
    up(db: DatabaseSync): void {
      // The `settings` table spec 4.1 lists as arriving with the settings
      // screen. Its first tenant is the per-account spam-training folder.
      //
      // 🚨 Spec 7.6: "Fastmail only learns from the folder its training
      // points at; this account uses *Identified Spam*, and a key bound to
      // `role=junk` would quietly do the wrong thing. **There is no correct
      // default to hardcode.**" Audit pass 2 F4 confirmed the consequence
      // against the live archive -- personal and work each carry BOTH an
      // "Identified Spam" (role NULL) and a "Spam" (role junk) mailbox, so
      // the role=junk binding filed spam where the filter never saw it.
      //
      // Key-value per account rather than a column per preference: the rest
      // of 7.6 lands here too, and a table that needs a migration for every
      // new toggle is a table that quietly stops being used.
      //
      // `account` is NOT a foreign key. A preference must survive an account
      // being removed and re-added -- the account key is stable and is what
      // the value is about -- and ON DELETE CASCADE would silently discard a
      // decision the operator made.
      db.exec(`
        CREATE TABLE settings (
          account    TEXT NOT NULL,
          key        TEXT NOT NULL,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account, key)
        ) STRICT;
      `);
    },
  },
  {
    version: 8,
    up(db: DatabaseSync): void {
      // The owner's account ORDER (checklist rows 34 and 15). Accounts were
      // listed by key, so the sidebar was alphabetical and `accounts[0]` --
      // which compose defaults to -- was `atelier`; that default is how
      // every reply went out from the wrong account. Backfilled in the old
      // alphabetical order so nothing moves until the owner moves it.
      const cols = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[];
      if (!cols.some((c) => c.name === "position")) db.exec("ALTER TABLE accounts ADD COLUMN position INTEGER;");
      const keys = db.prepare("SELECT key FROM accounts ORDER BY key").all() as { key: string }[];
      const set = db.prepare("UPDATE accounts SET position = ? WHERE key = ?");
      keys.forEach((k, i) => set.run(i, k.key));
    },
  },
  {
    version: 9,
    up(db: DatabaseSync): void {
      // Owner-wide preferences (checklist row 37): theme, density, layout
      // and the Settings switches. Server-side rather than localStorage so
      // a preference survives a browser and is the same one an API caller
      // sees; per-ACCOUNT settings stay in `settings`. Keys are validated
      // in core/preferences.ts -- an unknown key is refused, never stored.
      db.exec(`
        CREATE TABLE IF NOT EXISTS preferences (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 10,
    up(db: DatabaseSync): void {
      // The unified message list groups on the expression
      // COALESCE(thread_id, id) -- that IS the thread key, since a message
      // with no thread_id is its own thread of one. `emails_thread` is
      // (account, thread_id), which does not cover that expression, so
      // SQLite fell back to a temp B-tree sort on every page of a large
      // archive (measured: 794ms on 167,749 rows). `received_at DESC` is
      // the third column so the same index also serves newest-first-within-
      // thread lookups without a separate sort.
      //
      // `IF NOT EXISTS` is load-bearing, not decorative: this index was
      // already created by hand on the live 167k-row database during
      // diagnosis, so this migration must be a no-op there while still
      // advancing user_version to 10.
      db.exec(`
        CREATE INDEX IF NOT EXISTS emails_thread_key
          ON emails(account, COALESCE(thread_id, id), received_at DESC);
        ANALYZE emails;
      `);
    },
  },
  {
    version: 11,
    up(db: DatabaseSync): void {
      // The list read path needs to walk ONE folder newest-first and dedupe
      // by conversation without touching `emails` at all -- that is what
      // makes it O(page) instead of O(table). `email_mailboxes` didn't carry
      // enough to do that: it has no date to range-scan and no thread key to
      // count/dedupe by, so every page paid for a join back to `emails` and
      // a full-membership sort.
      //
      // `received_at` and `thread_key` are DENORMALIZED copies of
      // `emails.received_at` and `COALESCE(emails.thread_id, emails.id)`.
      // They are written from the email record already in hand at
      // membership-write time (see `mutations.ts` and `triage.ts`) and are
      // NEVER recomputed by a read -- a membership row that disagrees with
      // its email is a bug, not a cache to refresh, which is exactly what
      // `assertNoMembershipDrift` in the tests checks for.
      //
      // `email_mailboxes_recent` serves "newest N in this folder": all of
      // account/mailbox_id/received_at are in the index, and email_id +
      // thread_key ride along as trailing columns so the same index also
      // covers dedup without a lookup into the table. 🚨 email_id comes
      // BEFORE thread_key deliberately: the walk's order is `received_at
      // DESC, email_id ASC` (the page order of decision 5), and with
      // thread_key in between SQLite satisfies it with a `USE TEMP B-TREE
      // FOR LAST TERM OF ORDER BY`. In this order there is no sorter at all
      // and the index is still covering.
      //
      // `email_mailboxes_thread` serves "how many distinct conversations,
      // and what's the newest message of a given one": thread_key is the
      // third column so `count(DISTINCT thread_key)` is index-only, and
      // `received_at DESC, email_id DESC` trail it so the FIRST row of a
      // thread_key's range in this index is that thread's most recent
      // message -- decision 5's representative lookup needs no separate
      // query.
      //
      // Measured backfilling 178k rows: ~1.3s for the two UPDATEs, ~1.2s to
      // build both indexes, +40MB on disk.
      db.exec(`
        ALTER TABLE email_mailboxes ADD COLUMN received_at TEXT;
        ALTER TABLE email_mailboxes ADD COLUMN thread_key TEXT;
        UPDATE email_mailboxes SET
          received_at = (SELECT e.received_at FROM emails e WHERE e.account = email_mailboxes.account AND e.id = email_mailboxes.email_id),
          thread_key  = (SELECT COALESCE(e.thread_id, e.id) FROM emails e WHERE e.account = email_mailboxes.account AND e.id = email_mailboxes.email_id);
        CREATE INDEX IF NOT EXISTS email_mailboxes_recent ON email_mailboxes(account, mailbox_id, received_at DESC, email_id, thread_key);
        CREATE INDEX IF NOT EXISTS email_mailboxes_thread ON email_mailboxes(account, mailbox_id, thread_key, received_at DESC, email_id DESC);
        ANALYZE email_mailboxes;
      `);
    },
  },
  {
    version: 12,
    up(db: DatabaseSync): void {
      // The sidebar's per-folder counts. `listMailboxes` used to get both
      // numbers from ONE grouped query that joined `emails` for
      // `sum(is_unread)` -- so every sidebar load looked up every membership
      // row's email by primary key. Measured on the live 167k-message
      // instance: 491ms, of which 473ms was that join. The same statement
      // costs 25ms against a synthetic corpus of the same size, because
      // there the rows are thin; `emails` carries `body_text`, so on a real
      // archive the lookups walk a table hundreds of megabytes wide and the
      // cost is paging, not row count. A benchmark cannot be trusted to
      // catch this by TIME -- see the plan assertions in list.bench.ts.
      //
      // Totals now come from `email_mailboxes_recent` alone (covering,
      // 18ms at that size), and unread is counted from the FEW unread
      // messages rather than from every message: 164 of 167,756 on that
      // instance. This partial index holds only those rows, so the unread
      // query reads hundreds of rows instead of hundreds of thousands, and
      // it stays small precisely because an archive is mostly read.
      db.exec(`
        CREATE INDEX IF NOT EXISTS emails_unread ON emails(account, id) WHERE is_unread = 1;
        ANALYZE emails;
      `);
    },
  },
  {
    version: 13,
    up(db: DatabaseSync): void {
      // 🚨 A CONTENT ID DOES NOT MEAN "EMBEDDED IN THE BODY", and treating it
      // that way made real attachments unopenable.
      //
      // `email_attachments.cid` was the only signal, and everything carrying
      // one was classified as decoration: a signature logo, not a file. That
      // is wrong for any sender that assigns a cid to every part -- Gmail
      // does, with its `f_...` ids -- so a message whose parts are declared
      // `disposition: "attachment"` AND carry a cid rendered its files as
      // INERT LABELS with no download link, no click handler, and no
      // paperclip in the list. Reported live on 2026-09-23: eight invoice
      // PDFs that could not be opened at all. 6,183 messages here hold a
      // cid-bearing part.
      //
      // JMAP reports the sender's own `disposition` and Wilco was throwing
      // it away. Stored from here on, and it is what decides whether a part
      // is a file (see `isFile` in queries.ts). NULL means "not recorded" --
      // every row written before this migration -- and those keep the old
      // cid-only reading until the details backfill re-fetches them.
      // Guarded, because SQLite has no ADD COLUMN IF NOT EXISTS and a
      // migration that throws on a database already carrying the column
      // cannot be replayed -- the same property migration 10 is tested for.
      const columns = db.prepare(`PRAGMA table_info(email_attachments)`).all() as unknown as { name: string }[];
      if (!columns.some((c) => c.name === "disposition")) {
        db.exec(`ALTER TABLE email_attachments ADD COLUMN disposition TEXT;`);
      }
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Exported so the ordering and rollback behaviour can be tested against
 *  synthetic migrations rather than only against the real ones. */
export function applyMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (const m of migrations) {
    if (m.version <= current) continue;
    // BEGIN IMMEDIATE, not a deferred transaction that can fail on lock upgrade.
    db.exec("BEGIN IMMEDIATE");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

// node:sqlite's own error carries the underlying SQLite result code as
// `errcode` (see https://www.sqlite.org/rescode.html). Only these two mean
// the FILE ITSELF is permanently damaged -- SQLITE_NOTADB (26, "file is not
// a database": garbage bytes, truncation, mid-write corruption) and
// SQLITE_CORRUPT (11, a malformed database image). Everything else that can
// throw here -- EACCES from wrong ownership after a volume restore, ENOSPC
// from a full disk, SQLITE_BUSY from a concurrent checkpoint, a read-only
// filesystem -- is an OPERATIONAL condition on a database that is otherwise
// fine, and a fresh empty database does not fix any of them. Those must
// propagate as themselves so the process crash-loops with the data intact
// (the same shape as a wrong master key), not get silently classified as
// "unusable, rebuild it".
const SQLITE_NOTADB = 26;
const SQLITE_CORRUPT = 11;

function classifyOpenError(err: unknown): never {
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  if (errcode === SQLITE_NOTADB || errcode === SQLITE_CORRUPT) {
    throw new UnusableDatabase(
      `database file could not be opened: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw err;
}

export function openDb(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });

  // Everything in this block is a READ (the constructor, busy_timeout --
  // which is per-connection state, not a file write -- and the user_version
  // query) and everything that can throw here is wrapped so a genuinely
  // corrupt file is classified, but nothing else is. Reading user_version
  // BEFORE any pragma that can write to the file (journal_mode=WAL rewrites
  // the database header) matters: an older build opening a database from a
  // NEWER one must genuinely touch nothing -- that is the property
  // deploy.sh's rollback guard and the FutureSchemaVersion refusal below
  // both depend on. In practice node:sqlite's "is this even a database"
  // check does not fire on the constructor or on busy_timeout -- both
  // succeed against garbage bytes -- it fires on the first real read, i.e.
  // this user_version query, which is why it has to be inside the try too.
  let db: DatabaseSync | undefined;
  let current: number;
  try {
    db = new DatabaseSync(dbPath);
    // The nightly snapshot and any checkpoint WILL collide with the sync
    // loop, and the user_version read just below is itself a transaction
    // that can hit SQLITE_BUSY under the default zero timeout -- set this
    // first, before anything that takes a lock.
    db.exec("PRAGMA busy_timeout = 10000");
    ({ user_version: current } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    });
  } catch (err) {
    // `db` may already be constructed (the throw can come from the
    // busy_timeout pragma or the user_version read, both after the
    // constructor succeeded) -- close it before rethrowing/reclassifying, or
    // `rebuildDatabase` below renames a file that is still open under this
    // process. Harmless on Linux (an open fd survives a rename just fine),
    // real everywhere else `openDb` might run.
    db?.close();
    classifyOpenError(err);
  }

  if (current > SCHEMA_VERSION) {
    db.close();
    throw new FutureSchemaVersion(current, SCHEMA_VERSION);
  }

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  try {
    applyMigrations(db);
  } catch (err) {
    db.close();
    throw err;
  }

  return db;
}

/**
 * Move a refused database aside so a fresh one can be built. The old file is
 * RENAMED, never deleted -- and its sidecars go with it, because a stale -wal
 * beside a fresh database of the same name is a mismatched pair.
 */
export function rebuildDatabase(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${dbPath}.unusable-${stamp}`;
  renameSync(dbPath, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) renameSync(`${dbPath}${suffix}`, `${target}${suffix}`);
  }
  return target;
}
