// scripts/refetch-part-dispositions.ts
/**
 * Re-fetches message details for every message holding a part with a
 * content id, so those parts gain the `disposition` schema 13 added.
 *
 * Cause (fixed in `isFilePart`, src/core/queries.ts): a part carrying a
 * content id was classified as decoration the body draws -- a signature
 * logo -- and never offered as a file. Gmail assigns a `f_...` content id
 * to EVERY part it sends, so a message whose PDFs the sender declared
 * `disposition: "attachment"` rendered them as inert labels: no download
 * link, no click handler, and no paperclip on the list row. Reported live
 * on 2026-09-23 against a message holding eight invoice PDFs, none of which
 * could be opened at all.
 *
 * The sender's disposition is what decides, and Wilco was discarding it.
 * It is stored from schema 13 onward, but every row written before that has
 * `disposition IS NULL` and keeps the old cid-only reading -- so the
 * messages already in the archive stay broken until their details are
 * fetched again.
 *
 * 🚨 This script does NOT write a disposition itself. It sets the affected
 * messages' `details_at` back to NULL, which is exactly what
 * `pendingDetailIds` (src/core/details.ts) looks for: the running
 * supervisor's next `backfillDetails` pass re-fetches them from JMAP and
 * re-writes their parts through the FIXED path. So:
 *
 *   1. Deploy the fix FIRST. Running this against an old container just
 *      re-stores rows with no disposition.
 *   2. Then run this with --commit.
 *   3. Leave wilco running. Progress is visible as the pending count falls.
 *
 * `via` and `has_html` are cleared alongside `details_at` because they are
 * written by the same pass and `resetDetails` treats them as one unit; they
 * come back with it. A message is briefly reported as having no HTML, which
 * resolves on the next pass.
 *
 * Scope is deliberately "any message with a cid-bearing part" rather than
 * "any message whose parts look misclassified": the penalty for a false
 * positive is one JMAP round trip that recomputes the same values, while a
 * false negative leaves a file the reader still cannot open.
 *
 *   node scripts/refetch-part-dispositions.ts            # dry run, the default
 *   node scripts/refetch-part-dispositions.ts --commit
 *   node scripts/refetch-part-dispositions.ts --status   # how far along is it
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

const db = openDb(dbPath);

const AFFECTED = `
  SELECT count(*) c FROM emails e
   WHERE EXISTS (
     SELECT 1 FROM email_attachments a
      WHERE a.account = e.account AND a.email_id = e.id AND a.cid IS NOT NULL
   )`;

const pending = db.prepare("SELECT count(*) c FROM emails WHERE details_at IS NULL").get() as { c: number };
const recorded = db
  .prepare("SELECT count(*) c FROM email_attachments WHERE cid IS NOT NULL AND disposition IS NOT NULL")
  .get() as { c: number };
const unrecorded = db
  .prepare("SELECT count(*) c FROM email_attachments WHERE cid IS NOT NULL AND disposition IS NULL")
  .get() as { c: number };

if (statusOnly) {
  console.log(`cid-bearing parts with a disposition recorded: ${recorded.c}`);
  console.log(`still unrecorded:                              ${unrecorded.c}`);
  console.log(`messages awaiting a details pass:              ${pending.c}`);
  process.exit(0);
}

const affected = db.prepare(AFFECTED).get() as { c: number };
console.log(`messages holding a cid-bearing part: ${affected.c}`);
console.log(`of their parts, ${unrecorded.c} have no disposition recorded and ${recorded.c} do`);
console.log(`messages already awaiting a details pass: ${pending.c}`);

if (!commit) {
  console.log("\ndry run -- nothing changed. Re-run with --commit to queue the re-fetch.");
  process.exit(0);
}

const result = db
  .prepare(
    `UPDATE emails SET via = NULL, has_html = NULL, details_at = NULL
      WHERE details_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM email_attachments a
           WHERE a.account = emails.account AND a.email_id = emails.id AND a.cid IS NOT NULL
        )`,
  )
  .run();

console.log(`\nqueued ${Number(result.changes)} message(s) for a details re-fetch.`);
console.log("Leave wilco running; watch progress with --status.");
