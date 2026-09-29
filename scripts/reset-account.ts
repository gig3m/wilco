// scripts/reset-account.ts
/**
 * Operator escape hatch for the two one-way doors findings 1 and 2 exposed:
 * sync_state('walk', 'done') and body_text = '' are each reachable through
 * failure, and each is otherwise permanent -- 'done' short-circuits
 * walkArchive(), and '' is invisible to unfetchedIds() forever.
 *
 * Read-write on the live cache. Run it deliberately, and restart wilco (or
 * otherwise re-invoke bootstrapAccount) afterward so the next walk/backfill
 * pass actually happens.
 *
 *   node scripts/reset-account.ts personal --walk
 *   node scripts/reset-account.ts personal --bodies
 *   node scripts/reset-account.ts personal --details
 *   node scripts/reset-account.ts personal --walk --bodies
 *   node scripts/reset-account.ts personal --walk --cursor
 *   node scripts/reset-account.ts personal --reconcile   # next pass removes rows the server no longer has
 */
import { existsSync } from "node:fs";
import { openDb } from "../src/core/db.ts";
import { getAccount } from "../src/core/accounts.ts";
import { resetWalk, resetBodies, resetEmailCursor } from "../src/core/mutations.ts";
import { resetDetails } from "../src/core/details.ts";
import { markReconcilePending } from "../src/core/reconcile.ts";

const args = process.argv.slice(2);
const accountKey = args.find((a) => !a.startsWith("--"));
const doWalk = args.includes("--walk");
const doBodies = args.includes("--bodies");
const doCursor = args.includes("--cursor");
const doDetails = args.includes("--details");
const doReconcile = args.includes("--reconcile");

if (!accountKey || (!doWalk && !doBodies && !doCursor && !doDetails && !doReconcile)) {
  console.error(
    "usage: node scripts/reset-account.ts <account> [--walk] [--bodies] [--details]\n" +
      "  --walk    clear sync_state('walk') so the next pass re-walks the archive\n" +
      "  --bodies  set body_text='' rows back to NULL so the next backfill retries them\n" +
      "  --details clear via/details_at so the next backfillDetails pass re-fetches\n" +
      "            recipients/attachments/Via (the supported undo for a wrong Via --\n" +
      "            e.g. one written while ownAddresses was empty)\n" +
      "  --cursor  clear sync_state('email') so a re-walk can capture a fresh one\n" +
      "            (pair it with --walk: a walk will NOT replace a surviving cursor)",
  );
  process.exit(1);
}

const dbPath = process.env["WILCO_DB_PATH"] ?? "/data/wilco.db";

// Accounts now live IN the database (Task 4), so validating one against
// getAccount requires opening it -- but openDb() creates and migrates a
// fresh file if none exists (see db.ts: `new DatabaseSync(dbPath)` +
// mkdirSync). A typo'd account name on a box with no db yet would otherwise
// leave a brand-new, empty /data/wilco.db behind as a side effect of a
// failed usage check. Check existence first so that case fails loudly
// instead.
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath} -- nothing to reset`);
  process.exit(1);
}

const db = openDb(dbPath);

if (!getAccount(db, accountKey)) {
  console.error(`unknown account "${accountKey}"`);
  process.exit(1);
}

if (doWalk) {
  resetWalk(db, accountKey);
  console.log(`${accountKey}: cleared sync_state('walk') -- the next walk starts over`);
}

if (doCursor) {
  resetEmailCursor(db, accountKey);
  console.log(`${accountKey}: cleared sync_state('email') -- the next walk captures a fresh cursor`);
}

if (doBodies) {
  const changed = resetBodies(db, accountKey);
  console.log(`${accountKey}: reset ${changed} row(s) from body_text='' back to NULL`);
}

if (doDetails) {
  const changed = resetDetails(db, accountKey);
  console.log(`${accountKey}: cleared via/details_at on ${changed} row(s) -- the next pass re-fetches them`);
}

if (doReconcile) {
  markReconcilePending(db, accountKey);
  console.log(`${accountKey}: reconcile pending -- the next pass lists the server's ids and removes every local row it no longer has`);
}
