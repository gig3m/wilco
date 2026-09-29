/**
 * Removes an account AND every row that belongs to it -- emails, mailboxes,
 * recipients, attachments, sync state, settings, sealed credential -- so
 * the archive no longer shows it anywhere.
 *
 *   docker compose exec wilco node scripts/purge-account.ts test-a           # dry run: counts only
 *   docker compose exec wilco node scripts/purge-account.ts test-a --commit
 *
 * Written 2026-09-08 for moving the two harness accounts off production and
 * onto the harness instance. `DELETE /api/accounts/:key` drops the account
 * from sync and its accounts row (credentials cascade); the mail it had
 * already synced stayed behind, and nothing filters lists by the accounts
 * table, so those rows would go on appearing in All inboxes and in search.
 *
 * Tables are discovered by PRAGMA table_info, not listed here: a table that
 * gains an `account` column later is purged without anyone remembering to
 * add it. emails_fts follows emails through its own DELETE trigger.
 * The supervisor is told nothing -- restart the container afterwards so the
 * running sync forgets the account too.
 */
import { openDb } from "../src/core/db.ts";

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith("--"));
const commit = args.includes("--commit");
if (!key) {
  console.error("usage: purge-account.ts <account-key> [--commit]");
  process.exit(2);
}
const db = openDb(process.env["WILCO_DB_PATH"] ?? "/data/wilco.db");

const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`).all() as { name: string }[])
  .map((t) => t.name)
  .filter((name) => (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).some((c) => c.name === "account"))
  .filter((name) => name !== "accounts");

const counts: Record<string, number> = {};
for (const t of tables) {
  counts[t] = (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE account = ?`).get(key) as { n: number }).n;
}
const acct = db.prepare(`SELECT key, label FROM accounts WHERE key = ?`).get(key) as { key: string; label: string } | undefined;
console.log(`${key}: ${acct ? `account "${acct.label}"` : "no accounts row"}; rows by table:`, counts);

if (!commit) {
  console.log("dry run -- nothing deleted; add --commit");
  process.exit(0);
}
db.exec("BEGIN");
try {
  // Children before parents where a foreign key could object; the rest in
  // any order. emails last among the mail tables so its FTS trigger runs
  // with nothing pointing at the rows.
  const order = [...tables].sort((a, b) => (a === "emails" ? 1 : b === "emails" ? -1 : 0));
  for (const t of order) db.prepare(`DELETE FROM ${t} WHERE account = ?`).run(key);
  db.prepare(`DELETE FROM accounts WHERE key = ?`).run(key);
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}
console.log(`${key}: purged. Restart the container so the running sync forgets it.`);
