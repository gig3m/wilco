import type { DatabaseSync } from "node:sqlite";

/**
 * An account's connection details -- what the rest of the codebase needs to
 * talk to it. Credentials are deliberately NOT part of this shape any more:
 * they come from a CredentialStore (src/core/credentials.ts), keyed by the
 * same `key` this record carries.
 */
export interface AccountSpec {
  /** Stable local key. Used as the `account` half of every (account, id). */
  key: string;
  label: string;
  /** A NAMED hue, so it survives a theme change (spec 7.3). */
  accent: string;
  provider: string;
  endpoint: string;
  /**
   * Short uppercase code shown next to every row and account block (design
   * task-1). Optional on input to addAccount() -- when omitted, it is
   * derived from the key -- but always present on anything read back out of
   * the database (listAccounts/getAccount), since migration 5 makes the
   * column NOT NULL.
   */
  code?: string;
  /** The owner's chosen position in the sidebar, 0 first. Always present
   *  on anything read back; optional so a caller adding an account need not
   *  pick one (it goes to the end). */
  position?: number;
}

/**
 * An account key is stored in emails.account and used in every cache query,
 * every log line, and (from plan 5) capability URLs. Constrain it at the door
 * rather than sanitising it at every use.
 */
export const ACCOUNT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class AccountError extends Error {}

/** Ordered by key so the sidebar does not reshuffle between requests. */
export function listAccounts(db: DatabaseSync): AccountSpec[] {
  return db
    .prepare("SELECT key, label, accent, provider, endpoint, code, position FROM accounts ORDER BY position, key")
    .all() as unknown as AccountSpec[];
}

export function getAccount(db: DatabaseSync, key: string): AccountSpec | undefined {
  return db
    .prepare("SELECT key, label, accent, provider, endpoint, code, position FROM accounts WHERE key = ?")
    .get(key) as AccountSpec | undefined;
}

/**
 * Checks the parts of an AccountSpec that must hold before anything is done
 * with it -- including, per the whole-branch review's Important 1, before
 * the endpoint is ever probed with a live credential. Throws AccountError
 * (never a bare Error) so both addAccount and the accounts-api route that
 * calls this ahead of verifyEndpoint can answer the same 400 shape.
 *
 * Deliberately does NOT check `getAccount(db, spec.key)` (the "already
 * exists" 409 case) -- that check needs the db and is fine to run after a
 * successful probe, since it costs the caller nothing but a wasted verify
 * on an already-known-bad key. What must run first is exactly the checks
 * that stop an untrusted endpoint from ever seeing the token.
 */
export function validateAccountSpec(spec: Pick<AccountSpec, "key" | "endpoint">): void {
  if (!ACCOUNT_KEY_PATTERN.test(spec.key)) {
    throw new AccountError(`invalid account key: ${JSON.stringify(spec.key)}`);
  }

  let url: URL;
  try {
    url = new URL(spec.endpoint);
  } catch {
    throw new AccountError(`endpoint is not a valid URL: ${JSON.stringify(spec.endpoint)}`);
  }
  if (url.protocol !== "https:") {
    throw new AccountError(`endpoint must be https: ${JSON.stringify(spec.endpoint)}`);
  }
}

export function addAccount(db: DatabaseSync, spec: AccountSpec): AccountSpec {
  validateAccountSpec(spec);

  if (getAccount(db, spec.key)) {
    throw new AccountError(`an account with key ${JSON.stringify(spec.key)} already exists`);
  }

  const code = spec.code && spec.code.length > 0 ? spec.code : deriveCode(db, spec.key);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO accounts (key, label, accent, provider, endpoint, code, created_at, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(spec.key, spec.label, spec.accent, spec.provider, spec.endpoint, code, now, nextPosition(db));

  return { key: spec.key, label: spec.label, accent: spec.accent, provider: spec.provider, endpoint: spec.endpoint, code };
}

/**
 * Deletes only the `accounts` row. The `credentials` foreign key (ON DELETE
 * CASCADE) removes the secret with it -- but mail (`emails` and everything
 * keyed off `account`) is deliberately untouched. Removing an account from
 * the sidebar must not destroy an archive; that is a separate, explicit
 * operation if it is ever wanted at all.
 */
/** Editable, non-identity fields of an account (row 37's account page):
 *  the label Wilco shows for it, its accent, its three-letter code. The
 *  key never changes (it is the `account` half of every row in `emails`);
 *  the endpoint and provider are what the credential was made for. */
export interface AccountPatch {
  label?: string;
  accent?: string;
  code?: string;
}

export function updateAccount(db: DatabaseSync, key: string, patch: AccountPatch): AccountSpec {
  const current = getAccount(db, key);
  if (current === undefined) throw new AccountError(`no such account: ${JSON.stringify(key)}`);
  const label = patch.label === undefined ? current.label : patch.label.trim();
  if (label === "" || label.length > 64) throw new AccountError("label must be 1-64 characters");
  const accent = patch.accent === undefined ? current.accent : patch.accent.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) throw new AccountError("accent must be a #rrggbb colour");
  const code = patch.code === undefined ? (current.code ?? deriveCode(db, key)) : patch.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(code)) throw new AccountError("code must be 1-4 letters or digits");
  if (listAccounts(db).some((a) => a.key !== key && a.code === code)) {
    throw new AccountError(`code ${JSON.stringify(code)} already belongs to another account`);
  }
  db.prepare("UPDATE accounts SET label = ?, accent = ?, code = ? WHERE key = ?").run(label, accent, code, key);
  return getAccount(db, key)!;
}

export function removeAccount(db: DatabaseSync, key: string): void {
  db.prepare("DELETE FROM accounts WHERE key = ?").run(key);
}


function nextPosition(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM accounts").get() as { next: number };
  return row.next;
}

/**
 * Sets the owner's account order (checklist row 34). `keys` must be a full
 * permutation of the accounts: a partial or duplicated list is refused and
 * nothing changes, because a sidebar that silently dropped an account is
 * worse than an order that did not apply.
 */
export function setAccountOrder(db: DatabaseSync, keys: string[]): void {
  const existing = listAccounts(db).map((a) => a.key).sort();
  const given = [...keys].sort();
  if (given.length !== existing.length || given.some((k, i) => k !== existing[i])) {
    throw new AccountError(`order must name every account exactly once: have ${JSON.stringify(existing)}, got ${JSON.stringify(keys)}`);
  }
  const set = db.prepare("UPDATE accounts SET position = ? WHERE key = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    keys.forEach((k, i) => set.run(i, k));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * The sidebar code for a key, when the caller supplies none: the first
 * three letters of the key, uppercased (design task-1 ruling) -- UNLESS an
 * account already wears that code. `test-a` and `test-b` both derived `TES`
 * and their badges were indistinguishable for two days. Fallbacks keep the
 * key's own letters (first two + last, first + last two, the initials of
 * its parts), then a digit; a code is never reused while it is in use.
 */
export function deriveCode(db: DatabaseSync, key: string): string {
  const taken = new Set(listAccounts(db).filter((a) => a.key !== key).map((a) => a.code));
  const letters = key.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const parts = key.toUpperCase().split(/[^A-Z0-9]+/).filter((p) => p.length > 0);
  const candidates = [
    letters.slice(0, 3),
    letters.slice(0, 2) + letters.slice(-1),
    letters.slice(0, 1) + letters.slice(-2),
    parts.map((p) => p[0]).join("").padEnd(3, letters.slice(1)).slice(0, 3),
  ];
  for (const c of candidates) {
    if (c.length > 0 && !taken.has(c)) return c;
  }
  for (let n = 2; n < 100; n++) {
    const c = `${letters.slice(0, 2)}${n}`;
    if (!taken.has(c)) return c;
  }
  return letters.slice(0, 3);
}
