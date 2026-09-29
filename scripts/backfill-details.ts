// scripts/backfill-details.ts
/**
 * One-shot driver for details.ts's backfillDetails against the real
 * accounts: recipients, attachment metadata and Via for every archived
 * message.
 *
 * Dry run is the DEFAULT and makes NO JMAP request and writes NOTHING -- it
 * only counts, per account, how many rows are still `details_at IS NULL`
 * (the same indexed query backfillDetails itself starts each batch with).
 * Unlike a "run the real code path inside a transaction we roll back"
 * dry run, backfillDetails' own writes are committed batch by
 * batch (one BEGIN IMMEDIATE per batch, inside the loop -- see details.ts),
 * so there is no single outer transaction to wrap the whole run in without
 * either holding one open for the entire backfill or nesting transactions
 * sqlite does not support. A pure count is the honest dry run for a
 * batched, resumable backfill: it tells you the size of the job without
 * touching the network or the database.
 *
 * --commit actually runs the backfill, to completion, for every selected
 * account -- this is the one-shot maintenance path (unlike the supervisor's
 * per-pass, one-batch-at-a-time call), so it is expected to run for a
 * while against the full ~37.6k-message archive.
 *
 * Resolves credentials through the SAME CredentialStore the server uses
 * (chooseStore + WILCO_CREDENTIAL_STORE), exactly like verify-corpus.ts.
 *
 * `ownAddresses` is resolved per account via details.ts's fetchOwnAddresses
 * (JMAP Identity/get), once per account per run (review fix, Critical 1 --
 * the brief made this a parameter specifically so it could be supplied by a
 * real caller; this script and the supervisor are the two that do). A
 * failed identity fetch does not abort the account: it falls back to an
 * empty set, which deriveVia treats as "don't know yet" and answers with
 * NULL rather than a guess -- see deriveVia's own comment.
 *
 *   node scripts/backfill-details.ts                    # dry run, all accounts
 *   node scripts/backfill-details.ts --account personal # dry run, one account
 *   node scripts/backfill-details.ts --commit            # write, all accounts
 *   node scripts/backfill-details.ts --commit --account personal
 */
import { existsSync } from "node:fs";
import { openDb } from "../src/core/db.ts";
import { loadConfig } from "../src/core/config.ts";
import { listAccounts } from "../src/core/accounts.ts";
import { chooseStore, DEFAULT_NAME_FOR } from "../src/core/credentials.ts";
import { resolveMasterKey } from "../src/server/main.ts";
import { fetchSession, JmapClient, FASTMAIL_SESSION_URL } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { undetailedIds, backfillDetails, fetchOwnAddresses } from "../src/core/details.ts";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const accountFlagIndex = args.indexOf("--account");
const onlyAccount = accountFlagIndex === -1 ? undefined : args[accountFlagIndex + 1];

const dbPath = process.env["WILCO_DB_PATH"] ?? "/data/wilco.db";

// openDb() would happily create and migrate a fresh database at a typo'd
// path -- refuse rather than fabricate an empty one (same guard as
// reset-account.ts).
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath} -- nothing to backfill`);
  process.exit(1);
}

const db = openDb(dbPath);
const config = loadConfig(process.env);

let accounts = listAccounts(db);
if (onlyAccount) {
  accounts = accounts.filter((a) => a.key === onlyAccount);
  if (accounts.length === 0) {
    console.error(`unknown account "${onlyAccount}"`);
    db.close();
    process.exit(1);
  }
}

if (accounts.length === 0) {
  console.error("no accounts configured -- there is nothing to backfill");
  db.close();
  process.exit(1);
}

console.log(`database: ${dbPath}`);
console.log(commit ? "mode: COMMIT (writing)" : "mode: dry run (no writes, no requests)");

if (!commit) {
  for (const account of accounts) {
    // A large limit turns this into an effectively-unbounded count without
    // a second, ad hoc query -- undetailedIds is already the indexed
    // `details_at IS NULL` lookup backfillDetails itself uses.
    const pending = undetailedIds(db, account.key, 1_000_000).length;
    console.log(`${account.key.padEnd(12)} pending=${pending}`);
  }
  db.close();
  process.exit(0);
}

const store = chooseStore({
  db,
  masterKey: await resolveMasterKey(db, config.masterKeySecret),
  env: { ...process.env, WILCO_CREDENTIAL_STORE: config.credentialStore },
});

const missing: string[] = [];
const tokens = new Map<string, string>();
for (const a of accounts) {
  const token = await store.get(a.key);
  if (!token) missing.push(DEFAULT_NAME_FOR(a.key));
  else tokens.set(a.key, token);
}
if (missing.length > 0) {
  console.error(`no credential from the ${store.kind} store for: ${missing.join(", ")}`);
  db.close();
  process.exit(1);
}

let failures = 0;

for (const account of accounts) {
  const token = tokens.get(account.key)!;
  try {
    const session = resolveSession(account.key, await fetchSession(FASTMAIL_SESSION_URL, token));
    const client = new JmapClient(session, token);
    let ownAddresses = new Set<string>();
    try {
      ownAddresses = await fetchOwnAddresses(client);
    } catch (err) {
      console.log(`${account.key.padEnd(12)} identity fetch failed, Via will not be stored: ${(err as Error).message}`);
    }
    let batchCount = 0;
    const detailed = await backfillDetails(db, client, account.key, {
      ownAddresses,
      // onProgress ticks once per stored batch and carries no count of its
      // own (src/core/details.ts); this script only needs a heartbeat, not
      // an exact running total, so it counts its own batches.
      onProgress: () => process.stdout.write(`\r${account.key.padEnd(12)} batch=${++batchCount}`),
    });
    process.stdout.write("\n");
    console.log(`${account.key.padEnd(12)} DONE detailed=${detailed}`);
  } catch (err) {
    failures += 1;
    // Never the error's full detail if it could carry a credential -- the
    // message alone is enough for an operator to act on.
    console.log(`${account.key.padEnd(12)} FAILED ${(err as Error).message}`);
  }
}

db.close();

if (failures > 0) {
  console.error(`\n${failures} account(s) failed to backfill.`);
  process.exit(1);
}
console.log("\nAll selected accounts backfilled.");
