import type { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { open, seal } from "./crypto.ts";

export type Runner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * TOKEN_RETRY_MS bounds the retry COUNT, not any single attempt's duration.
 * Without a timeout here, a `keys` CLI that hangs instead of failing --
 * rather than the "unreachable, fails fast" case a retry loop is built for
 * -- would leave a caller that acquires credentials sequentially across
 * accounts stuck on the first attempt forever, so startup never finishes for
 * any account. 10s is ample for a local CLI call; a real hang becomes a
 * rejection the caller's own retry logic already knows how to handle.
 *
 * Exported (as a factory, not a fixed instance) purely so a test can drive a
 * real hanging process through a short timeout without waiting out
 * production's 10s -- KeysCliStore's own default below always uses the 10s
 * instance.
 */
export function makeExecFileRunner(timeoutMs: number): Runner {
  return (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout, stderr) => {
        // Do NOT pass `err` on: execFile attaches stdout -- the token -- to it.
        if (err) reject(new Error("child process failed"));
        else resolve({ stdout, stderr });
      });
    });
}

/**
 * Every implementation of this interface is a place an account's secret
 * comes from. `get` returns null for "this store has nothing for that
 * account" -- not an error -- so callers can fall back to another store
 * without wrapping every call in try/catch. `kind` names the store, never
 * what it holds, so a failure message can say "the db store failed" without
 * risking a credential.
 */
export interface CredentialStore {
  get(account: string): Promise<string | null>;
  put(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
  readonly kind: string;
}

/**
 * Sealed at rest with the master key derived in src/core/crypto.ts. This is
 * the only store that can actually persist a rotation -- see spec 8.6 for
 * why the encrypted database, not the environment, is the canonical answer
 * to "where does this account's token live".
 */
export class EncryptedDbStore implements CredentialStore {
  readonly kind = "db";
  private db: DatabaseSync;
  private key: Buffer;

  constructor(db: DatabaseSync, key: Buffer) {
    this.db = db;
    this.key = key;
  }

  async get(account: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT sealed FROM credentials WHERE account = ?")
      .get(account) as { sealed: string } | undefined;
    if (!row) return null;
    // open() throws SealError on a wrong key or tampered value -- that is
    // exactly the "cannot read a stored credential" case a test asserts on,
    // and SealError's own message never carries the plaintext.
    return open(this.key, row.sealed);
  }

  async put(account: string, secret: string): Promise<void> {
    const sealed = seal(this.key, secret);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO credentials (account, sealed, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(account) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
      )
      .run(account, sealed, now);
  }

  async remove(account: string): Promise<void> {
    this.db.prepare("DELETE FROM credentials WHERE account = ?").run(account);
  }
}

/**
 * Read-only by construction: an env var is set once, outside this process,
 * and there is nowhere for a `put` to write to that would survive a
 * restart. Pretending to accept a write here would silently lose whatever
 * the caller thought it just persisted.
 */
export class EnvStore implements CredentialStore {
  readonly kind = "env";
  private env: Record<string, string | undefined>;
  private nameFor: (account: string) => string;

  constructor(env: Record<string, string | undefined>, nameFor: (account: string) => string) {
    this.env = env;
    this.nameFor = nameFor;
  }

  async get(account: string): Promise<string | null> {
    const raw = this.env[this.nameFor(account)];
    if (!raw || raw.trim() === "") return null;
    return raw.trim();
  }

  async put(_account: string, _secret: string): Promise<void> {
    throw new Error("EnvStore is read-only: an environment variable cannot be written from here");
  }

  async remove(_account: string): Promise<void> {
    throw new Error("EnvStore is read-only: an environment variable cannot be written from here");
  }
}

const DEFAULT_RUNNER_TIMEOUT_MS = 10_000;

/**
 * Fetches a credential from an external `keys` secrets CLI via `keys exec NAME
 * -- printenv NAME`, which injects the secret into the child's environment
 * and prints it on the child's stdout -- it never reaches a terminal, which
 * is what the `keys get` prohibition is about. Deliberately NOT a write path
 * either -- rotation happens in `keys` itself (`keys set NAME`), not through
 * this process, so `put`/`remove` are refused the same way EnvStore refuses
 * them, just with a message naming the real mechanism.
 */
export class KeysCliStore implements CredentialStore {
  readonly kind = "keys";
  private nameFor: (account: string) => string;
  private run: Runner;

  constructor(nameFor: (account: string) => string, run?: Runner) {
    this.nameFor = nameFor;
    this.run = run ?? makeExecFileRunner(DEFAULT_RUNNER_TIMEOUT_MS);
  }

  async get(account: string): Promise<string | null> {
    const name = this.nameFor(account);
    let out: { stdout: string };
    try {
      out = await this.run("keys", ["exec", name, "--", "printenv", name]);
    } catch {
      // Deliberately swallowing the cause: execFile attaches the child's
      // stdout to its error, and that stdout can be the secret itself.
      throw new Error(`keys exec failed for ${name}`);
    }
    const value = out.stdout.trim();
    return value === "" ? null : value;
  }

  async put(_account: string, _secret: string): Promise<void> {
    throw new Error("KeysCliStore is read-only: rotate with `keys set NAME`, not through wilco");
  }

  async remove(_account: string): Promise<void> {
    throw new Error("KeysCliStore is read-only: rotate with `keys set NAME`, not through wilco");
  }
}

export const DEFAULT_NAME_FOR = (account: string): string => `${account.toUpperCase()}_FASTMAIL_JMAP`;

export interface ChooseStoreOptions {
  db: DatabaseSync;
  masterKey: Buffer;
  env: Record<string, string | undefined>;
  nameFor?: (account: string) => string;
  run?: Runner;
}

/**
 * WILCO_CREDENTIAL_STORE picks the backend explicitly ("db" | "env" |
 * "keys"); anything else -- unset included -- falls back to the encrypted
 * database, which is the only backend that can actually persist a write.
 */
export function chooseStore(opts: ChooseStoreOptions): CredentialStore {
  const nameFor = opts.nameFor ?? DEFAULT_NAME_FOR;
  const selection = opts.env.WILCO_CREDENTIAL_STORE;
  if (selection === "env") return new EnvStore(opts.env, nameFor);
  if (selection === "keys") return new KeysCliStore(nameFor, opts.run);
  return new EncryptedDbStore(opts.db, opts.masterKey);
}

/**
 * Bounded, growing waits. The keys service and this container start together,
 * so losing that race must degrade one account for a few seconds -- not leave
 * a permanently dead sync loop, and not exit before the HTTP server is up to
 * report it.
 *
 * Fix round 1 (Task 6 review): the boot-time acquisition loop that used to
 * live in the now-deleted src/core/tokens.ts as `acquireTokens` (env first,
 * then `keys` retried with this schedule) is now `acquireCredentials` in
 * src/server/main.ts, which
 * resolves a single, already-chosen CredentialStore per boot instead of a
 * hardcoded env-then-keys chain -- see that function's doc comment. This
 * constant stays here because both the `keys`-backend retry loop in
 * acquireCredentials and this module's own tests need it.
 */
export const TOKEN_RETRY_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];
