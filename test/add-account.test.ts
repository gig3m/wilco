import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./tmpdir.ts";
import { openDb } from "../src/core/db.ts";
import { listAccounts } from "../src/core/accounts.ts";
import { chooseStore } from "../src/core/credentials.ts";
import { resolveMasterKey } from "../src/server/main.ts";
import { parseAddAccountArgs, addAccountWithCredential } from "../src/core/add-account.ts";

test("parseAddAccountArgs: defaults and required flags", () => {
  const a = parseAddAccountArgs(["--key", "home", "--label", "Home"]);
  assert.equal(a.spec.key, "home");
  assert.equal(a.spec.endpoint, "https://api.fastmail.com/jmap/session");
  assert.equal(a.spec.accent, "blue");
  assert.equal(a.commit, false);
  assert.throws(() => parseAddAccountArgs(["--label", "x"]), /--key/);
  assert.throws(() => parseAddAccountArgs(["--key", "home", "--label", "x", "--token", "t"]), /WILCO_ACCOUNT_TOKEN/);
});

test("parseAddAccountArgs: rejects unknown options and missing values", () => {
  assert.throws(
    () => parseAddAccountArgs(["--key", "home", "--label", "x", "--acent", "blue"]),
    /unknown option: --acent/,
  );
  assert.throws(
    () => parseAddAccountArgs(["--key", "home", "--label", "x", "--accent"]),
    /--accent requires a value/,
  );
  assert.throws(
    () => parseAddAccountArgs(["--label", "--commit"]),
    /--label requires a value/,
  );
});

test("addAccountWithCredential stores the row and a sealed credential that reads back", async () => {
  const db = openDb(join(tempDir("add-account"), "wilco.db"));
  const key = await resolveMasterKey(db, "a-test-master-secret-1234");
  const store = chooseStore({ db, masterKey: key, env: { WILCO_CREDENTIAL_STORE: "db" } });
  const spec = { key: "home", label: "Home", accent: "blue", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" };
  assert.equal(await addAccountWithCredential(db, store, spec, "tok-123"), "stored");
  assert.deepEqual(listAccounts(db).map((a) => a.key), ["home"]);
  assert.equal(await store.get("home"), "tok-123");
  await assert.rejects(addAccountWithCredential(db, store, spec, "tok-123"), /already exists/);
});
