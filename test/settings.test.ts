/**
 * Per-account settings, and the spam-training folder in particular.
 *
 * 🚨 The bug these exist to prevent is not a crash. Spec 7.6:
 *
 *   "Fastmail only learns from the folder its training points at; this
 *    account uses *Identified Spam*, and a key bound to `role=junk` would
 *    quietly do the wrong thing. There is no correct default to hardcode."
 *
 * Audit pass 2 (F4) measured it on the live archive: `personal` and `work`
 * each hold BOTH an "Identified Spam" (role NULL) and a "Spam" (role junk)
 * mailbox. Every message ever marked spam went to the latter. The code ran,
 * the mail moved, the toast said it worked, and the filter learned nothing.
 *
 * So the behaviour under test is mostly REFUSAL: when no folder is chosen,
 * marking spam must fail loudly rather than fall back to `role=junk`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { getSetting, getSettings, hiddenFromUnified, isSettingKey, setSetting, spamMailboxId } from "../src/core/settings.ts";
import { destinationFor, TriageError } from "../src/core/triage.ts";

function db(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE settings (
      account TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (account, key)) STRICT;
    CREATE TABLE mailboxes (
      account TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, role TEXT,
      parent_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      total_emails INTEGER NOT NULL DEFAULT 0, unread_emails INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, id));
  `);
  // The real shape, from the live archive: both folders exist, and the one
  // that trains the filter is NOT the one with role=junk.
  for (const acct of ["personal", "work"]) {
    d.prepare(`INSERT INTO mailboxes (account,id,name,role) VALUES (?,?,?,?)`).run(acct, "JNK", "Spam", "junk");
    d.prepare(`INSERT INTO mailboxes (account,id,name,role) VALUES (?,?,?,?)`).run(acct, "IDS", "Identified Spam", null);
  }
  return d;
}

test("🚨 with no folder chosen, marking spam REFUSES — it does not fall back to role=junk", () => {
  const d = db();
  assert.equal(spamMailboxId(d, "personal"), null);
  assert.throws(
    () => destinationFor(d, "personal", { kind: "spam" }),
    (err: unknown) => {
      assert.ok(err instanceof TriageError);
      // The message has to tell the operator what to do about it.
      assert.match(err.message, /spam-training folder|per account/i);
      return true;
    },
    "marking spam with no folder chosen silently picked one",
  );
});

test("the chosen folder is used, even though another mailbox holds role=junk", () => {
  const d = db();
  setSetting(d, "personal", "spamMailboxId", "IDS");
  assert.equal(destinationFor(d, "personal", { kind: "spam" }), "IDS");
  // The trap: `role=junk` exists and is the wrong answer.
  const junk = d.prepare(`SELECT id FROM mailboxes WHERE account=? AND role='junk'`).get("personal") as { id: string };
  assert.equal(junk.id, "JNK");
  assert.notEqual(destinationFor(d, "personal", { kind: "spam" }), junk.id);
});

test("🚨 the setting is PER ACCOUNT — one account's choice never answers for another", () => {
  // Fastmail reuses mailbox ids across accounts, which is what makes an
  // unscoped lookup dangerous rather than merely untidy.
  const d = db();
  setSetting(d, "personal", "spamMailboxId", "IDS");
  assert.equal(destinationFor(d, "personal", { kind: "spam" }), "IDS");
  assert.throws(() => destinationFor(d, "work", { kind: "spam" }), TriageError, "work borrowed personal's setting");
});

test("a chosen folder that no longer exists reads as UNSET, not as itself", () => {
  // `mailboxes` is rewritten wholesale on every sync, so an id missing from
  // it does not exist on the server either. Filing mail into it would be a
  // JMAP error at best and a silent misfile at worst.
  const d = db();
  setSetting(d, "personal", "spamMailboxId", "IDS");
  d.prepare(`DELETE FROM mailboxes WHERE account='personal' AND id='IDS'`).run();
  assert.equal(spamMailboxId(d, "personal"), null);
  assert.throws(() => destinationFor(d, "personal", { kind: "spam" }), TriageError);
});

test("an empty value clears the setting rather than storing an empty string", () => {
  // "No preference" and "the preference is empty" must not be the same
  // state: the first has a defined fallback, the second does not.
  const d = db();
  setSetting(d, "personal", "spamMailboxId", "IDS");
  assert.equal(getSetting(d, "personal", "spamMailboxId"), "IDS");
  setSetting(d, "personal", "spamMailboxId", "");
  assert.equal(getSetting(d, "personal", "spamMailboxId"), null);
  assert.deepEqual(getSettings(d, "personal"), {});
});

test("only known keys are settings", () => {
  assert.equal(isSettingKey("spamMailboxId"), true);
  assert.equal(isSettingKey("spamMailBoxId"), false); // a real typo shape
  assert.equal(isSettingKey("__proto__"), false);
});

test("setting a value twice updates rather than duplicating", () => {
  const d = db();
  setSetting(d, "personal", "spamMailboxId", "IDS");
  setSetting(d, "personal", "spamMailboxId", "JNK");
  assert.equal(getSetting(d, "personal", "spamMailboxId"), "JNK");
  const { n } = d.prepare(`SELECT count(*) n FROM settings`).get() as { n: number };
  assert.equal(n, 1);
});

test("row 48: showInUnified is a known on/off setting, and hiddenFromUnified lists the accounts switched off", () => {
  const d = db();
  assert.equal(isSettingKey("showInUnified"), true);
  assert.deepEqual(hiddenFromUnified(d), []);
  setSetting(d, "test-a", "showInUnified", "off");
  setSetting(d, "work", "showInUnified", "on");
  assert.deepEqual(hiddenFromUnified(d), ["test-a"]);
});
