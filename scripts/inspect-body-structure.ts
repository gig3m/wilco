// scripts/inspect-body-structure.ts
/**
 * What MIME parts a message actually has, straight from the server.
 *
 * Read-only, one message, run deliberately:
 *   docker compose exec wilco node scripts/inspect-body-structure.ts <account> <id>
 *
 * Exists because "does this message have a text/html part?" is a question
 * this codebase has now got wrong twice, in both directions, by reading it
 * off `textBody`/`htmlBody` -- which are DISPLAY lists, not type lists.
 * The rule is to read `bodyStructure` when you need
 * certainty rather than trusting either.
 */
import { openDb } from "../src/core/db.ts";
import { loadConfig } from "../src/core/config.ts";
import { listAccounts } from "../src/core/accounts.ts";
import { chooseStore } from "../src/core/credentials.ts";
import { resolveMasterKey } from "../src/server/main.ts";
import { fetchSession, JmapClient, FASTMAIL_SESSION_URL } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";

const [accountKey, id] = process.argv.slice(2);
if (!accountKey || !id) {
  console.error("usage: inspect-body-structure.ts <account> <id>");
  process.exit(1);
}

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const account = listAccounts(db).find((a) => a.key === accountKey);
if (!account) {
  console.error(`no such account: ${accountKey}`);
  process.exit(1);
}
const store = chooseStore({
  db,
  masterKey: await resolveMasterKey(db, config.masterKeySecret),
  env: { ...process.env, WILCO_CREDENTIAL_STORE: config.credentialStore },
});
const token = await store.get(account.key);
if (!token) {
  console.error(`no credential for ${accountKey}`);
  process.exit(1);
}
const session = resolveSession(account.key, await fetchSession(FASTMAIL_SESSION_URL, token));
const client = new JmapClient(session, token);
const [res] = await client.request([
  ["Email/get", {
    accountId: session.mailAccountId,
    ids: [id],
    properties: ["id", "subject", "bodyStructure", "textBody", "htmlBody"],
    bodyProperties: ["partId", "type", "size", "disposition", "name", "cid"],
  }, "c0"],
]);
const msg = ((res?.[1] as any).list ?? [])[0];
if (!msg) {
  console.error("no such message");
  process.exit(1);
}
const brief = (p: any) => (p === undefined || p === null ? null : { partId: p.partId, type: p.type, size: p.size });
console.log("subject:      ", msg.subject);
console.log("bodyStructure:", JSON.stringify(msg.bodyStructure, null, 2));
console.log("textBody:     ", JSON.stringify((msg.textBody ?? []).map(brief)));
console.log("htmlBody:     ", JSON.stringify((msg.htmlBody ?? []).map(brief)));
db.close();
