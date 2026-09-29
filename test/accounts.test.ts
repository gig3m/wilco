import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { listAccounts, getAccount, addAccount, removeAccount, setAccountOrder, updateAccount, deriveCode, AccountError } from "../src/core/accounts.ts";
import { tempDbPath } from "./tmpdir.ts";

function db() { return openDb(tempDbPath()); }
// Same shape as db() -- the brief's tests call it freshDb(), which does not
// exist anywhere in this codebase; defined locally per-file rather than
// exported, matching how db() itself is scoped to this file only.
function freshDb() { return openDb(tempDbPath()); }
const spec = { key: "personal", label: "Personal", accent: "blue", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" };

test("an added account is listed and fetchable", () => {
  const d = db();
  addAccount(d, spec);
  assert.deepEqual(listAccounts(d).map((a) => a.key), ["personal"]);
  assert.equal(getAccount(d, "personal")?.label, "Personal");
  d.close();
});

test("accounts list in a stable order", () => {
  const d = db();
  for (const k of ["work", "personal", "atelier"]) addAccount(d, { ...spec, key: k, label: k });
  const first = listAccounts(d).map((a) => a.key);
  const second = listAccounts(d).map((a) => a.key);
  assert.deepEqual(first, second);
  d.close();
});

test("an empty database has no accounts and does not throw", () => {
  const d = db();
  assert.deepEqual(listAccounts(d), []);
  assert.equal(getAccount(d, "nobody"), undefined);
  d.close();
});

test("A KEY MUST BE SAFE TO USE AS A CACHE KEY", () => {
  // The key is stored in emails.account and used in every query and every
  // capability URL later. Accepting arbitrary text here is how a path or an
  // injection problem gets in through the front door.
  const d = db();
  for (const bad of ["", " ", "has space", "has/slash", "has'quote", "../..", "a".repeat(200), "UPPER"]) {
    assert.throws(() => addAccount(d, { ...spec, key: bad }), AccountError, `key: ${JSON.stringify(bad)}`);
  }
  for (const good of ["personal", "work2", "south-side", "a"]) {
    addAccount(d, { ...spec, key: good });
  }
  d.close();
});

test("a duplicate key is refused rather than overwriting", () => {
  const d = db();
  addAccount(d, spec);
  assert.throws(() => addAccount(d, { ...spec, label: "Other" }), AccountError);
  assert.equal(getAccount(d, "personal")?.label, "Personal");
  d.close();
});

test("REMOVING AN ACCOUNT DOES NOT DELETE ITS MAIL", () => {
  // Removing an account from the sidebar must not destroy an archive. If that
  // is ever wanted it is a separate, explicit operation.
  const d = db();
  addAccount(d, spec);
  d.prepare(`INSERT INTO emails (account,id,received_at) VALUES ('personal','m1','2026-01-01T00:00:00Z')`).run();
  removeAccount(d, "personal");
  const c = d.prepare("SELECT count(*) c FROM emails WHERE account='personal'").get() as any;
  assert.equal(c.c, 1, "the mail stays; only the account row goes");
  d.close();
});

test("removing an account removes its credential", () => {
  const d = db();
  addAccount(d, spec);
  d.prepare(`INSERT INTO credentials (account,sealed,updated_at) VALUES ('personal','v1.a.b.c','2026-01-01T00:00:00Z')`).run();
  removeAccount(d, "personal");
  const c = d.prepare("SELECT count(*) c FROM credentials").get() as any;
  assert.equal(c.c, 0);
  d.close();
});

test("an endpoint must be https", () => {
  const d = db();
  assert.throws(() => addAccount(d, { ...spec, endpoint: "http://api.fastmail.com/jmap/session" }), AccountError);
  assert.throws(() => addAccount(d, { ...spec, endpoint: "not a url" }), AccountError);
  d.close();
});

test("a code is derived from the key when none is given", () => {
  const db = freshDb();
  const a = addAccount(db, { key: "society", label: "Society", accent: "#c9903a",
                             provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" });
  assert.equal(a.code, "SOC");
  db.close();
});

test("an explicit code is kept verbatim", () => {
  const db = freshDb();
  const a = addAccount(db, { key: "work", label: "Work", accent: "#2a9d6e", code: "HAL",
                             provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" });
  assert.equal(a.code, "HAL");
  db.close();
});

// -- Account order (checklist rows 34 and 15) ---------------------------------

test("🚨 ACCOUNTS COME BACK IN THE OWNER'S ORDER, AND CARRY IT", () => {
  // Rows 34 and 15. `listAccounts` ordered by KEY, so the sidebar was
  // alphabetical and `accounts[0]` -- which compose defaults to -- was
  // `atelier`. That default is how every reply and a harness run's drafts
  // went out from the wrong account. The order is the owner's to choose,
  // and it rides on every account as `position`.
  const d = freshDb();
  for (const key of ["atelier", "personal", "work"]) {
    addAccount(d, { key, label: key, accent: "#000000", provider: "jmap", endpoint: "https://x.test/jmap/session" });
  }
  // Untouched, a new database keeps insertion order -- and says so.
  assert.deepEqual(listAccounts(d).map((a) => [a.key, a.position]), [["atelier", 0], ["personal", 1], ["work", 2]]);

  setAccountOrder(d, ["personal", "work", "atelier"]);
  assert.deepEqual(listAccounts(d).map((a) => a.key), ["personal", "work", "atelier"]);
  assert.deepEqual(listAccounts(d).map((a) => a.position), [0, 1, 2]);

  // A new account goes to the END, not into the alphabet.
  addAccount(d, { key: "aaa", label: "aaa", accent: "#000000", provider: "jmap", endpoint: "https://x.test/jmap/session" });
  assert.deepEqual(listAccounts(d).map((a) => a.key), ["personal", "work", "atelier", "aaa"]);
  d.close();
});

test("an order that is not a full permutation of the accounts is refused, and nothing changes", () => {
  const d = freshDb();
  for (const key of ["a", "b"]) addAccount(d, { key, label: key, accent: "#000000", provider: "jmap", endpoint: "https://x.test/jmap/session" });
  for (const bad of [["a"], ["a", "b", "c"], ["a", "a"], ["b", "zzz"]]) {
    assert.throws(() => setAccountOrder(d, bad), AccountError, JSON.stringify(bad));
  }
  assert.deepEqual(listAccounts(d).map((a) => a.key), ["a", "b"]);
  d.close();
});

test("a derived sidebar code is never one another account already wears", () => {
  // test-a and test-b both derived TES; their badges collided for two days.
  const d = freshDb();
  const a = addAccount(d, { ...spec, accent: "#5b6ee0", key: "test-a", label: "TEST A" });
  const b = addAccount(d, { ...spec, accent: "#5b6ee0", key: "test-b", label: "TEST B" });
  assert.equal(a.code, "TES");
  assert.equal(b.code, "TEB", "the fallback keeps the key's own letters");
  assert.equal(deriveCode(d, "test-c"), "TEC");
  // An explicit code is taken as given, and a later update may not steal
  // one that is in use.
  const c = addAccount(d, { ...spec, accent: "#5b6ee0", key: "third", label: "Third", code: "THR" });
  assert.equal(c.code, "THR");
  assert.throws(() => updateAccount(d, "test-b", { code: "THR" }), AccountError);
  assert.equal(updateAccount(d, "test-b", { code: "TB" }).code, "TB");
});
