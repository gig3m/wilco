// scripts/verify-corpus.ts
/**
 * Milestone 1's exit condition (spec 5.5).
 *
 * Asks each server how many messages it holds outside Trash and Spam, and
 * compares that against the local cache. `tar` exiting 0 is not proof anything
 * was written, and neither is a walk that completed without error.
 *
 * Read-only. Talks to live accounts, so run it deliberately.
 *
 * Resolves credentials through the SAME CredentialStore the server uses
 * (chooseStore + WILCO_CREDENTIAL_STORE), so on this deployment it reads the
 * sealed rows and needs no tokens in the environment -- only the master
 * secret the container already has:
 *
 *   docker compose exec wilco node scripts/verify-corpus.ts
 */
import { openDb } from "../src/core/db.ts";
import { loadConfig } from "../src/core/config.ts";
import { listAccounts } from "../src/core/accounts.ts";
import { chooseStore, DEFAULT_NAME_FOR } from "../src/core/credentials.ts";
import { resolveMasterKey } from "../src/server/main.ts";
import { fetchSession, JmapClient, FASTMAIL_SESSION_URL } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { excludedIdsFromMailboxes, buildExclusionFilter } from "./verify-corpus-filter.ts";

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const accounts = listAccounts(db);

// Zero accounts is never "nothing to verify, so it passed" -- it is the
// completeness checker verifying nothing and exiting 0, which is exactly
// the false confidence this script exists to prevent (mirrors the
// accountHealth empty-list guard in src/server/health.ts).
if (accounts.length === 0) {
  console.error("no accounts configured -- there is nothing to verify");
  db.close();
  process.exit(1);
}

// Final-review fix 7: this used to hardcode `new EnvStore(process.env, ...)`,
// which made it the ONE tool in the codebase that did not ask chooseStore.
// After a rotation through PUT /api/accounts/:key/credential the live
// credential lives in the sealed `credentials` table, so an env-only read
// would validate the corpus against a stale `keys` value -- or, far more
// likely on this deployment, find no credential at all and report a false
// "no JMAP token" failure. It now resolves exactly what the server resolves.
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
  process.exit(1);
}

let failures = 0;

for (const account of accounts) {
  const token = tokens.get(account.key)!;
  const session = resolveSession(account.key, await fetchSession(FASTMAIL_SESSION_URL, token));
  const client = new JmapClient(session, token);

  const [mailboxRes] = await client.request([
    ["Mailbox/get", { accountId: session.mailAccountId, ids: null }, "c0"],
  ]);
  const mailboxList =
    (mailboxRes?.[1] as { list?: { id: string; role?: string | null }[] } | undefined)?.list ?? [];

  if (mailboxList.length === 0) {
    // Zero mailboxes is never a valid account state -- it means the session
    // or account is broken, not that there is nothing to exclude. Reporting
    // a number here is exactly the failure mode this script exists to catch:
    // proceeding on bad input and printing a confident, wrong answer.
    failures += 1;
    console.log(`ERR  ${account.key.padEnd(10)} server reported zero mailboxes -- cannot verify`);
    continue;
  }

  const excluded = excludedIdsFromMailboxes(mailboxList);
  const filter = buildExclusionFilter(excluded);

  const [res] = await client.request([
    [
      "Email/query",
      {
        accountId: session.mailAccountId,
        ...(filter ? { filter } : {}),
        limit: 1,
        calculateTotal: true,
      },
      "c0",
    ],
  ]);
  const remote = (res?.[1] as { total?: number }).total ?? -1;

  const { c: local } = db
    .prepare(`SELECT count(*) AS c FROM emails WHERE account = ?`)
    .get(account.key) as { c: number };

  const { c: unfetched } = db
    .prepare(`SELECT count(*) AS c FROM emails WHERE account = ? AND body_text IS NULL`)
    .get(account.key) as { c: number };

  const agree = local === remote && unfetched === 0;
  if (!agree) failures += 1;

  console.log(
    `${agree ? "OK  " : "FAIL"} ${account.key.padEnd(10)} ` +
      `local=${local} remote=${remote} bodies-missing=${unfetched}`,
  );
}

db.close();

if (failures > 0) {
  console.error(`\n${failures} account(s) disagree with their server. The archive is NOT complete.`);
  process.exit(1);
}
console.log("\nAll accounts agree. The archive is complete.");
