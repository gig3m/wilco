// scripts/reextract-html-bodies.ts
/**
 * Repairs `emails.body_text` rows that hold RAW HTML instead of plaintext.
 *
 * Cause (fixed in `collectBody`, src/core/corpus.ts): JMAP's `textBody` is
 * not "the text/plain parts" -- it is the list of parts a client should
 * display as the body, and for an HTML-only message the server puts the
 * **text/html** part in it. The old extractor read that as plaintext, so
 * 5,736 messages (~15% of the live archive) stored `<!DOCTYPE html>` and
 * stylesheet text. That markup is in the FTS5 index, in every preview, and
 * in the reading pane's plaintext fallback -- a search for a CSS property
 * name matched real mail.
 *
 * 🚨 This script does NOT rewrite any body itself. It sets the affected
 * rows' `body_text` back to `NULL`, which is exactly what
 * `unfetchedIds` looks for: the running supervisor's next `backfillBodies`
 * pass re-fetches those messages from JMAP and re-extracts them through the
 * FIXED collectBody. So:
 *
 *   1. Deploy the collectBody fix FIRST. Running this against an old
 *      container just re-stores the same markup.
 *   2. Then run this with --commit.
 *   3. Leave wilco running. Nothing else to do; progress is visible as the
 *      NULL count falling.
 *
 * Because the repair is a re-fetch rather than an edit, a false positive
 * costs one JMAP round trip and nothing else -- the re-fetch recomputes the
 * same correct value for a row that was already fine. The detection below
 * is therefore deliberately generous rather than conservative.
 *
 *   node scripts/reextract-html-bodies.ts            # dry run, the default
 *   node scripts/reextract-html-bodies.ts --commit
 *   node scripts/reextract-html-bodies.ts --status   # how far along is it
 */
import { existsSync } from "node:fs";
import { openDb } from "../src/core/db.ts";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const statusOnly = args.includes("--status");

const dbPath = process.env["WILCO_DB_PATH"] ?? "/data/wilco.db";
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(1);
}

/**
 * Markup shapes that do not occur in prose. Kept broad on purpose (see the
 * header): the penalty for a false positive is a re-fetch that produces the
 * same value, while a false negative leaves markup in the search index.
 */
const HTML_MARKERS = [
  "<!doctype%",
  "<html%",
  "%<head%",
  "%<body%",
  "%<div%",
  "%<table%",
  "%<td%",
  "%<tr%",
  "%<span%",
  "%<style%",
  "%<img%",
  "%<meta%",
  "%<a href%",
  "%&nbsp;%",
];

const where = HTML_MARKERS.map(() => "body_text LIKE ?").join(" OR ");
const db = openDb(dbPath);

const total = db.prepare("SELECT count(*) c FROM emails").get() as { c: number };
const pending = db.prepare("SELECT count(*) c FROM emails WHERE body_text IS NULL").get() as { c: number };

if (statusOnly) {
  console.log(`messages:            ${total.c}`);
  console.log(`awaiting a body:     ${pending.c}   (this falls as the supervisor re-fetches)`);
  const stillHtml = db
    .prepare(`SELECT count(*) c FROM emails WHERE body_text IS NOT NULL AND (${where})`)
    .get(...HTML_MARKERS) as { c: number };
  console.log(`still holding HTML:  ${stillHtml.c}`);
  process.exit(0);
}

const affected = db
  .prepare(
    `SELECT account, count(*) c FROM emails
      WHERE body_text IS NOT NULL AND (${where})
      GROUP BY account ORDER BY c DESC`,
  )
  .all(...HTML_MARKERS) as { account: string; c: number }[];

const sum = affected.reduce((n, r) => n + r.c, 0);

console.log(`database:  ${dbPath}`);
console.log(`messages:  ${total.c}`);
console.log(`affected:  ${sum}`);
for (const row of affected) console.log(`  ${row.account.padEnd(12)} ${row.c}`);

if (sum === 0) {
  console.log("\nnothing to do.");
  process.exit(0);
}

// A sample, so the operator can see what is actually being matched rather
// than trusting the count. Truncated hard -- these are real message bodies.
console.log("\nsample of what matched:");
const sample = db
  .prepare(
    `SELECT account, subject, substr(body_text, 1, 70) p FROM emails
      WHERE body_text IS NOT NULL AND (${where}) LIMIT 5`,
  )
  .all(...HTML_MARKERS) as { account: string; subject: string; p: string }[];
for (const row of sample) {
  console.log(`  [${row.account}] ${JSON.stringify(row.subject).slice(0, 44)}`);
  console.log(`      ${JSON.stringify(row.p)}`);
}

if (!commit) {
  console.log("\nDRY RUN -- nothing written. Re-run with --commit to queue these for re-fetch.");
  console.log("Deploy the collectBody fix BEFORE committing, or the re-fetch re-stores the markup.");
  process.exit(0);
}

const result = db
  .prepare(`UPDATE emails SET body_text = NULL WHERE body_text IS NOT NULL AND (${where})`)
  .run(...HTML_MARKERS);

console.log(`\nqueued ${Number(result.changes)} messages for re-fetch (body_text set to NULL).`);
console.log("The running supervisor's next backfillBodies pass picks them up; watch with --status.");
