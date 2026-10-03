import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { openDb } from "../src/core/db.ts";
import { deriveMasterKey } from "../src/core/crypto.ts";
import {
  EncryptedDbStore,
  EnvStore,
  KeysCliStore,
  chooseStore,
  TOKEN_RETRY_MS,
  makeExecFileRunner,
  DEFAULT_NAME_FOR,
} from "../src/core/credentials.ts";
import { tempDbPath } from "./tmpdir.ts";

const SECRET = "master secret";
const SALT = Buffer.alloc(16, 3);
const TOKEN = "a-real-looking-fastmail-token";

function db() {
  const d = openDb(tempDbPath());
  d.prepare(
    `INSERT INTO accounts (key,label,accent,provider,endpoint,created_at)
     VALUES ('personal','Personal','blue','jmap','https://e','2026-01-01T00:00:00Z')`,
  ).run();
  return d;
}

test("DEFAULT_NAME_FOR follows the keys grammar: FASTMAIL_<ACCOUNT>_TOKEN", () => {
  // keys 2.4.0 renamed <ACCOUNT>_FASTMAIL_JMAP to FASTMAIL_<ACCOUNT>_TOKEN; the old names are
  // only aliases now and will be removed.
  assert.equal(DEFAULT_NAME_FOR("personal"), "FASTMAIL_PERSONAL_TOKEN");
  assert.equal(DEFAULT_NAME_FOR("mathetes"), "FASTMAIL_MATHETES_TOKEN");
});

test("EncryptedDbStore round-trips a credential", async () => {
  const d = db();
  const store = new EncryptedDbStore(d, await deriveMasterKey(SECRET, SALT));
  await store.put("personal", TOKEN);
  assert.equal(await store.get("personal"), TOKEN);
  d.close();
});

test("THE CREDENTIAL IS NOT READABLE IN THE DATABASE", async () => {
  // This row lands in a nightly backup. If the token is legible there, the
  // whole exercise was pointless.
  const d = db();
  const store = new EncryptedDbStore(d, await deriveMasterKey(SECRET, SALT));
  await store.put("personal", TOKEN);
  const row = d.prepare("SELECT sealed FROM credentials WHERE account='personal'").get() as any;
  assert.ok(!row.sealed.includes(TOKEN));
  d.close();
});

test("a wrong master key cannot read a stored credential", async () => {
  const d = db();
  await new EncryptedDbStore(d, await deriveMasterKey(SECRET, SALT)).put("personal", TOKEN);
  const wrong = new EncryptedDbStore(d, await deriveMasterKey("not it", SALT));
  await assert.rejects(() => wrong.get("personal"));
  d.close();
});

test("an unknown account reads as null, not an error", async () => {
  const d = db();
  const store = new EncryptedDbStore(d, await deriveMasterKey(SECRET, SALT));
  assert.equal(await store.get("nobody"), null);
  d.close();
});

test("put replaces rather than accumulating — rotation must not leave the old one", async () => {
  const d = db();
  const store = new EncryptedDbStore(d, await deriveMasterKey(SECRET, SALT));
  await store.put("personal", "old-token");
  await store.put("personal", "new-token");
  const rows = d.prepare("SELECT count(*) c FROM credentials WHERE account='personal'").get() as any;
  assert.equal(rows.c, 1);
  assert.equal(await store.get("personal"), "new-token");
  d.close();
});

test("remove deletes the row", async () => {
  const d = db();
  const store = new EncryptedDbStore(d, await deriveMasterKey(SECRET, SALT));
  await store.put("personal", TOKEN);
  await store.remove("personal");
  assert.equal(await store.get("personal"), null);
  d.close();
});

test("EnvStore reads the named variable and refuses to write", async () => {
  const store = new EnvStore({ PERSONAL_FASTMAIL_JMAP: TOKEN }, (a) => `${a.toUpperCase()}_FASTMAIL_JMAP`);
  assert.equal(await store.get("personal"), TOKEN);
  assert.equal(await store.get("work"), null);
  await assert.rejects(() => store.put("personal", "x"), /read-only/,
    "an env-backed store cannot persist; failing loudly beats pretending");
});

test("KeysCliStore shells `keys exec`, never `keys get`", async () => {
  let seen: string[] = [];
  const store = new KeysCliStore((a) => `${a.toUpperCase()}_FASTMAIL_JMAP`, async (file, args) => {
    seen = [file, ...args];
    return { stdout: TOKEN, stderr: "" };
  });
  assert.equal(await store.get("personal"), TOKEN);
  assert.equal(seen[0], "keys");
  assert.equal(seen[1], "exec");
  assert.ok(!seen.includes("get"), "keys get prints a secret where a transcript captures it");
});

test("NO STORE PUTS A CREDENTIAL IN AN ERROR", async () => {
  // Final-review fix 6: this test used to run `put(); get();` inside ONE try
  // block. For EnvStore and KeysCliStore, put() rejects (both are read-only),
  // so get() was never reached -- the KeysCliStore runner crafted below,
  // whose whole point is to attach the token to an error the way execFile
  // does, never ran, and the assertion could not fail for two of its three
  // stores. Each operation now gets its own try/catch and BOTH dumps are
  // asserted, so every store's get() path is genuinely exercised.
  //
  // util.inspect(depth: 6) rather than String(err): String() and
  // args.join(" ") omit an Error's own enumerable properties (`stdout` is
  // exactly such a property) and have made this test vacuous before.
  const d = db();
  const stores = [
    // A wrong master key against a real sealed row: get() throws a SealError
    // with the ciphertext in scope. The plaintext must not ride along.
    new EncryptedDbStore(d, await deriveMasterKey("a different master secret", SALT)),
    new EnvStore({ PERSONAL_FASTMAIL_JMAP: TOKEN }, () => "PERSONAL_FASTMAIL_JMAP"),
    new KeysCliStore(() => "X", async () => {
      const e = new Error("boom") as Error & { stdout?: string };
      e.stdout = TOKEN;                      // execFile really does this
      throw e;
    }),
  ];

  // Seal a real row under the RIGHT key first, so the db store's get() has
  // something to fail to open rather than trivially returning null.
  await new EncryptedDbStore(d, await deriveMasterKey(SECRET, SALT)).put("personal", TOKEN);

  for (const s of stores) {
    let putErr: unknown;
    let getErr: unknown;
    let got: unknown;
    // get() BEFORE put(): the db store's put would re-seal the row under the
    // wrong key and make its own get succeed, defeating the point.
    try { got = await s.get("personal"); } catch (err) { getErr = err; }
    try { await s.put("personal", TOKEN); } catch (err) { putErr = err; }

    for (const [label, caught] of [["get", getErr], ["put", putErr]] as const) {
      if (caught === undefined) continue;
      const dump = inspect(caught, { depth: 6 });
      assert.ok(!dump.includes(TOKEN), `${s.kind} leaked the credential via a ${label} error`);
    }

    // Guard against the reverse vacuity -- a leak assertion over an
    // operation that never ran passes for the wrong reason. Name what each
    // store's get() is expected to have DONE:
    if (s.kind === "env") {
      assert.equal(got, TOKEN, "env get() must have really read the value");
      assert.equal(getErr, undefined);
    } else {
      assert.ok(getErr instanceof Error,
        `${s.kind}: get() must have been reached and thrown (this is the path that could leak)`);
    }
  }

  d.close();
});

test("chooseStore defaults to the encrypted database", async () => {
  const d = db();
  const s = chooseStore({ db: d, masterKey: await deriveMasterKey(SECRET, SALT), env: {} });
  assert.equal(s.kind, "db");
  d.close();
});

test("chooseStore honours an explicit selection", async () => {
  const d = db();
  const key = await deriveMasterKey(SECRET, SALT);
  assert.equal(chooseStore({ db: d, masterKey: key, env: { WILCO_CREDENTIAL_STORE: "env" } }).kind, "env");
  assert.equal(chooseStore({ db: d, masterKey: key, env: { WILCO_CREDENTIAL_STORE: "keys" } }).kind, "keys");
  d.close();
});

// ---------------------------------------------------------------------------
// The env-first-then-keys-CLI-with-backoff acquisition loop that used to
// live here as `acquireTokens` moved to `acquireCredentials` in
// src/server/main.ts in Task 6's fix round 1 -- it now resolves a single,
// already-chosen CredentialStore per boot rather than hardcoding an
// env-then-keys chain. Its retry/backoff/hang coverage moved with it: see
// test/main.test.ts, the block after "// acquireCredentials (spec 8.1,
// `keys` backend)". TOKEN_RETRY_MS and makeExecFileRunner stay covered here
// since they are still exported from this module.
// ---------------------------------------------------------------------------

test("the retry schedule is bounded", () => {
  assert.ok(TOKEN_RETRY_MS.length > 0 && TOKEN_RETRY_MS.length <= 6);
});

test("a runner that hangs forever is bounded by a timeout, not left to hang", async () => {
  // The sole test of makeExecFileRunner's `timeout:` option -- without it,
  // the option could be deleted from execFile's call and this suite would
  // stay green, which is exactly the state Task 4's fix round found.
  const runner = makeExecFileRunner(200);
  const start = Date.now();
  await assert.rejects(() => runner("sleep", ["30"]));
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `expected the 200ms timeout to bound this; took ${elapsed}ms`);
});
