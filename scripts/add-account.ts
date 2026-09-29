// scripts/add-account.ts
/**
 * Add one JMAP account and its token to a Wilco database. Headless twin of
 * the Add Account UI. Dry run by default; --commit writes.
 *
 *   WILCO_ACCOUNT_TOKEN=... node scripts/add-account.ts \
 *     --key personal --label Personal [--accent blue] [--code PER] \
 *     [--endpoint https://api.fastmail.com/jmap/session] --commit
 *
 * Run it INSIDE the container against the live database, then restart the
 * container: the server reads the account list once at boot.
 *
 *   docker compose run --rm -e WILCO_ACCOUNT_TOKEN wilco node scripts/add-account.ts ... --commit
 *   docker compose up -d wilco
 *
 * The token comes from the environment only. Nothing here prints it.
 */
import { existsSync } from "node:fs";
import { openDb } from "../src/core/db.ts";
import { chooseStore } from "../src/core/credentials.ts";
import { resolveMasterSecret } from "../src/core/config.ts";
import { resolveMasterKey } from "../src/server/main.ts";
import { parseAddAccountArgs, addAccountWithCredential } from "../src/core/add-account.ts";

let args;
try { args = parseAddAccountArgs(process.argv.slice(2)); }
catch (err) { console.error(`error: ${(err as Error).message}`); process.exit(2); }

const token = process.env["WILCO_ACCOUNT_TOKEN"];
if (!token) { console.error("error: WILCO_ACCOUNT_TOKEN is not set"); process.exit(2); }

const dbPath = process.env["WILCO_DB_PATH"] ?? "/data/wilco.db";
if (!existsSync(dbPath)) { console.error(`no database at ${dbPath} -- start Wilco once first`); process.exit(1); }

const db = openDb(dbPath);
const masterKey = await resolveMasterKey(db, resolveMasterSecret(process.env));
const store = chooseStore({ db, masterKey, env: { WILCO_CREDENTIAL_STORE: "db" } });

console.log(`database: ${dbPath}`);
console.log(`account:  ${args.spec.key} (${args.spec.label}) at ${args.spec.endpoint}`);
console.log(`mode:     ${args.commit ? "COMMIT" : "dry run (pass --commit to write)"}`);

db.exec("BEGIN");
try {
  await addAccountWithCredential(db, store, args.spec, token);
  db.exec(args.commit ? "COMMIT" : "ROLLBACK");
  console.log(args.commit ? "stored. Now: docker compose up -d wilco" : "would store (rolled back)");
} catch (err) {
  db.exec("ROLLBACK");
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
