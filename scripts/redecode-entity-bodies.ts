// scripts/redecode-entity-bodies.ts
/**
 * Repairs `emails.body_text` rows holding UNDECODED HTML entity references.
 *
 * Cause (fixed in `decodeEntities`, src/core/corpus.ts): the plaintext
 * extractor decoded exactly four entities — `&nbsp;`, `&amp;`, `&lt;`,
 * `&gt;` — and left every other reference verbatim. `body_text` is what the
 * reading pane's plaintext view shows and what the FTS5 index is built from,
 * so measured on the live archive (audit pass 4): **1,119 messages carried a
 * literal `&#nn;`**, 427 carried `&zwnj;` (marketing preheader padding), 272
 * smart quotes, 271 `&quot;`, 267 dashes.
 *
 * The search consequence is the sharp one. `unicode61` tokenizes
 * `don&#39;t` as `don` / `39` / `t`, so the phrase a person types cannot
 * match the message that contains it.
 *
 * 🚨 Same mechanism as `reextract-html-bodies.ts`, deliberately: this script
 * rewrites NOTHING. It sets the affected rows' `body_text` back to `NULL`,
 * which is exactly what `unfetchedIds` looks for, and the running
 * supervisor's next `backfillBodies` pass re-fetches and re-extracts them
 * through the fixed decoder. So:
 *
 *   1. Deploy the decodeEntities fix FIRST. Against an old container this
 *      just re-stores the same references.
 *   2. Then run this with --commit.
 *   3. Leave wilco running. Progress is the NULL count falling.
 *
 * Because the repair is a re-fetch rather than an edit, a false positive
 * costs one JMAP round trip and recomputes the same value for a row that was
 * already fine. Detection is therefore generous rather than conservative.
 *
 * 🚨 `--status` DOES NOT REACH ZERO, and that is correct. A few hundred
 * messages ship a **text/plain part that the sender wrote with entities in
 * it** — a lazy HTML-to-text conversion at their end, so the part literally
 * contains `&#124;` or `?source&#x3D;email`. Wilco does not run `htmlToText`
 * over a text/plain part, and it must not: those bytes are what the sender
 * sent, they display that way in every mail client, and decoding them would
 * silently rewrite someone else's message. Measured after the first run:
 * ~200 such rows out of 2,850. **Do not re-run this script chasing that
 * remainder** — it will reset the same rows and get the same answer.
 *
 *   node scripts/redecode-entity-bodies.ts            # dry run, the default
 *   node scripts/redecode-entity-bodies.ts --commit
 *   node scripts/redecode-entity-bodies.ts --status   # how far along is it
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
 * Entity shapes that survived the old four-entity decoder.
 *
 * 🚨 `&amp;` is NOT here and must not be added. It was decoded correctly all
 * along, and `&` is common enough in prose that matching it would select the
 * whole archive for a re-fetch — 37,755 JMAP round trips to change nothing.
 */
const ENTITY_MARKERS = [
  "%&#%", // every numeric reference, decimal and hex
  "%&quot;%",
  "%&apos;%",
  "%&zwnj;%",
  "%&zwj;%",
  "%&shy;%",
  "%&rsquo;%",
  "%&lsquo;%",
  "%&ldquo;%",
  "%&rdquo;%",
  "%&mdash;%",
  "%&ndash;%",
  "%&hellip;%",
  "%&middot;%",
  "%&bull;%",
  "%&trade;%",
  "%&copy;%",
  "%&reg;%",
  "%&deg;%",
  "%&euro;%",
  "%&eacute;%",
  "%&uuml;%",
  "%&ouml;%",
  "%&auml;%",
  "%&ntilde;%",
  "%&ccedil;%",
];

const where = ENTITY_MARKERS.map(() => "body_text LIKE ?").join(" OR ");
const db = openDb(dbPath);

const total = db.prepare("SELECT count(*) c FROM emails").get() as { c: number };
const pending = db.prepare("SELECT count(*) c FROM emails WHERE body_text IS NULL").get() as { c: number };

if (statusOnly) {
  const remaining = db
    .prepare(`SELECT count(*) c FROM emails WHERE body_text IS NOT NULL AND (${where})`)
    .get(...ENTITY_MARKERS) as { c: number };
  console.log(`messages:              ${total.c}`);
  console.log(`awaiting a body:       ${pending.c}   (this falls as the supervisor re-fetches)`);
  console.log(`still holding entities:${String(remaining.c).padStart(7)}`);
  process.exit(0);
}

const affected = db
  .prepare(
    `SELECT account, count(*) c FROM emails
      WHERE body_text IS NOT NULL AND (${where})
      GROUP BY account ORDER BY c DESC`,
  )
  .all(...ENTITY_MARKERS) as { account: string; c: number }[];

const sum = affected.reduce((n, r) => n + r.c, 0);

console.log(`database:  ${dbPath}`);
console.log(`messages:  ${total.c}`);
console.log(`affected:  ${sum}`);
for (const row of affected) console.log(`  ${row.account.padEnd(12)} ${row.c}`);

if (sum === 0) {
  console.log("\nnothing to do.");
  process.exit(0);
}

// A sample, so the operator can see what is actually matched rather than
// trusting the count. Truncated hard -- these are real message bodies.
console.log("\nsample of what matched:");
const sample = db
  .prepare(
    `SELECT account, subject, substr(body_text, 1, 70) p FROM emails
      WHERE body_text IS NOT NULL AND (${where}) LIMIT 5`,
  )
  .all(...ENTITY_MARKERS) as { account: string; subject: string; p: string }[];
for (const row of sample) {
  console.log(`  [${row.account}] ${JSON.stringify(row.subject).slice(0, 44)}`);
  console.log(`      ${JSON.stringify(row.p)}`);
}

if (!commit) {
  console.log("\nDRY RUN. Re-run with --commit to reset these rows to NULL.");
  process.exit(0);
}

const result = db
  .prepare(`UPDATE emails SET body_text = NULL WHERE body_text IS NOT NULL AND (${where})`)
  .run(...ENTITY_MARKERS);
console.log(`\nreset ${result.changes} rows to NULL.`);
console.log("The supervisor re-fetches them on its next backfill pass; watch --status.");
