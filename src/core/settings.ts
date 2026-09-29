import type { DatabaseSync } from "node:sqlite";

/**
 * Per-account settings (spec 4.1's `settings` table, spec 7.6's screen).
 *
 * Its first tenant is the **spam-training folder**, and that one carries the
 * whole reason this table exists rather than a constant somewhere:
 *
 * > "Fastmail only learns from the folder its training points at; this
 * > account uses *Identified Spam*, and a key bound to `role=junk` would
 * > quietly do the wrong thing. **There is no correct default to hardcode.**"
 * > — spec 7.6
 *
 * Audit pass 2 (F4) measured the consequence on the live archive: `personal`
 * and `work` each hold BOTH an "Identified Spam" (role `NULL`) and a "Spam"
 * (role `junk`) mailbox. Every message marked as spam went to the latter, so
 * the filter never learned from any of it — the code ran, the mail moved, and
 * the feature did nothing it was for.
 */

/** The setting keys this codebase knows. A string union rather than free
 *  text: an unrecognised key is a typo, and a typo that silently stores is a
 *  preference the operator sets and never sees applied. */
export type SettingKey = "spamMailboxId" | "signatureNew" | "signatureReplies" | "showInUnified";

const KNOWN_KEYS: ReadonlySet<string> = new Set<SettingKey>(["spamMailboxId", "signatureNew", "signatureReplies", "showInUnified"]);

/** The on/off settings (row 37's signature switches): the send path
 *  appends the identity's signature to a new message / a reply unless the
 *  account has turned it off. Absent means on. */
export const SWITCH_SETTINGS: ReadonlySet<string> = new Set(["signatureNew", "signatureReplies", "showInUnified"]);

/**
 * Accounts switched OUT of "All inboxes" (row 48, owner ruling 2026-09-07:
 * the harness accounts' fixtures kept returning to the combined inbox
 * after every run's reset). Absent means shown. They stay in the sidebar
 * and in their own views; only the unified list and its count skip them.
 */
export function hiddenFromUnified(db: DatabaseSync): string[] {
  const rows = db.prepare(`SELECT account FROM settings WHERE key = 'showInUnified' AND value = 'off'`).all() as unknown as { account: string }[];
  return rows.map((r) => r.account);
}

export function isSettingKey(key: string): key is SettingKey {
  return KNOWN_KEYS.has(key);
}

export function getSetting(db: DatabaseSync, account: string, key: SettingKey): string | null {
  const row = db
    .prepare(`SELECT value FROM settings WHERE account = ? AND key = ?`)
    .get(account, key) as { value: string } | undefined;
  return row === undefined ? null : row.value;
}

/** Writes a setting. An empty value DELETES the row rather than storing `""`
 *  — "no preference" and "the preference is the empty string" must not be the
 *  same state, because the first has a defined fallback and the second does
 *  not. */
export function setSetting(db: DatabaseSync, account: string, key: SettingKey, value: string): void {
  if (value === "") {
    db.prepare(`DELETE FROM settings WHERE account = ? AND key = ?`).run(account, key);
    return;
  }
  db.prepare(
    `INSERT INTO settings (account, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(account, key, value, new Date().toISOString());
}

/** Every setting for one account, as a plain object. */
export function getSettings(db: DatabaseSync, account: string): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE account = ?`).all(account) as unknown as {
    key: string;
    value: string;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/**
 * The mailbox a "mark as spam" should file into, or `null` when the operator
 * has not chosen one.
 *
 * 🚨 `null` means **do not guess**. Callers must refuse the action, not fall
 * back to `role=junk`: falling back is precisely the behaviour spec 7.6 calls
 * "quietly doing the wrong thing", and it is worse than refusing because the
 * message moves, the toast says it worked, and the filter learns nothing.
 *
 * A stale id — the operator chose a mailbox that has since been deleted or
 * renamed away on the server — also returns `null`. The `mailboxes` table is
 * rewritten wholesale on every sync (spec 4.1), so an id that is no longer in
 * it does not exist, and filing mail into a mailbox id the server does not
 * recognise is a JMAP error at best and a silent misfile at worst.
 */
export function spamMailboxId(db: DatabaseSync, account: string): string | null {
  const chosen = getSetting(db, account, "spamMailboxId");
  if (chosen === null) return null;
  const exists = db
    .prepare(`SELECT 1 FROM mailboxes WHERE account = ? AND id = ?`)
    .get(account, chosen);
  return exists === undefined ? null : chosen;
}
