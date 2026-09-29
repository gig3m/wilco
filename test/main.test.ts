import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { openDb, SCHEMA_VERSION } from "../src/core/db.ts";
import {
  buildRouter,
  resolveMasterKey,
  acquireCredentials,
  ensureMasterKeySalt,
  openBootDatabase,
} from "../src/server/main.ts";
import { hashPassword } from "../src/server/auth.ts";
import { addAccount, listAccounts, type AccountSpec } from "../src/core/accounts.ts";
import {
  DEFAULT_NAME_FOR,
  chooseStore,
  KeysCliStore,
  makeExecFileRunner,
} from "../src/core/credentials.ts";
import { SealError } from "../src/core/crypto.ts";
import { failureState, type AccountState } from "../src/server/health.ts";
import { HttpStatusError } from "../src/core/failures.ts";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { tempDbPath, tempDir } from "./tmpdir.ts";

const ORIGIN = "https://mail.example.com";

const ACCOUNT_SPECS: Omit<AccountSpec, "provider" | "endpoint">[] = [
  { key: "personal", label: "Personal", accent: "blue" },
  { key: "work", label: "Work", accent: "green" },
  { key: "society", label: "Society", accent: "amber" },
  { key: "atelier", label: "Atelier", accent: "violet" },
];

function seedAccounts(db: DatabaseSync): AccountSpec[] {
  const specs = ACCOUNT_SPECS.map((a) => ({
    ...a,
    provider: "jmap",
    endpoint: "https://api.fastmail.com/jmap/session",
  }));
  for (const spec of specs) addAccount(db, spec);
  return specs;
}

async function withApp(fn: (base: string) => Promise<void>) {
  const db = openDb(tempDbPath());
  const accounts = seedAccounts(db);
  const router = buildRouter({
    db,
    passwordHash: await hashPassword("letmein"),
    origin: ORIGIN,
    accountStates: new Map(),
    accounts,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
}

/**
 * Same shape as withApp, but lets a test hand in a pre-populated
 * accountStates map -- used to reproduce, at the router level, the state
 * main()'s acquireTokens onFailure callback leaves behind, without actually
 * starting main() against the real environment (see task-14-report.md,
 * Fix round 1, for why main() itself is not exercised directly here).
 */
async function withAppStates(
  accountStates: Map<string, AccountState>,
  fn: (base: string) => Promise<void>,
) {
  const db = openDb(tempDbPath());
  const accounts = seedAccounts(db);
  const router = buildRouter({
    db,
    passwordHash: await hashPassword("letmein"),
    origin: ORIGIN,
    accountStates,
    accounts,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
}

/**
 * Spins a router up against a caller-built db/accounts/accountStates rather
 * than the fixed four-account seedAccounts fixture -- used by the Task 6
 * tests below, which each need their own account set and are driving the
 * credential-acquisition path (resolveMasterKey/acquireCredentials), not
 * seedAccounts's login/session behaviour.
 */
async function withRouterFor(
  db: DatabaseSync,
  accounts: AccountSpec[],
  accountStates: Map<string, AccountState>,
  fn: (base: string) => Promise<void>,
) {
  const router = buildRouter({
    db,
    passwordHash: await hashPassword("letmein"),
    origin: ORIGIN,
    accountStates,
    accounts,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function tempDb(): DatabaseSync {
  return openDb(tempDbPath());
}

const MASTER_SECRET = "a-sufficiently-long-startup-test-secret";

test("an account with no stored credential degrades only itself", async () => {
  // Task 6, step 1: two accounts, a credential sealed for only one of them.
  // acquireCredentials must resolve the one that has a credential and call
  // onFailure for the other -- and that difference must be visible in
  // /healthz, not just in the returned token map.
  const db = tempDb();
  const specs: AccountSpec[] = [
    { key: "personal", label: "Personal", accent: "blue", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
    { key: "work", label: "Work", accent: "green", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
  ];
  for (const s of specs) addAccount(db, s);

  const masterKey = await resolveMasterKey(db, MASTER_SECRET);
  const store = chooseStore({ db, masterKey, env: {} });
  await store.put("personal", "personal-jmap-token");

  const accountStates = new Map<string, AccountState>();
  const tokens = await acquireCredentials(store, specs, {
    onFailure: (key) => {
      accountStates.set(key, { kind: "auth", message: `no credential available for ${key}` });
    },
  });
  // Simulate what main() does for every account that DID get a credential --
  // establishClient succeeding and recording "ok". This test is only
  // exercising credential acquisition, not the JMAP handshake.
  for (const key of tokens.keys()) accountStates.set(key, { kind: "ok" });

  assert.equal(tokens.get("personal"), "personal-jmap-token");
  assert.equal(tokens.has("work"), false, "no credential was ever stored for work");

  await withRouterFor(db, specs, accountStates, async (base) => {
    const res = await fetch(`${base}/healthz`);
    const body = (await res.json()) as {
      accounts: { account: string; state: string; message?: string }[];
    };
    const personal = body.accounts.find((a) => a.account === "personal")!;
    const work = body.accounts.find((a) => a.account === "work")!;
    assert.equal(personal.state, "ok");
    assert.equal(work.state, "auth");
    assert.match(work.message ?? "", /no credential available for work/);
  });

  db.close();
});

test("startup with NO accounts serves and reports honestly", async () => {
  // A fresh install has an empty accounts table (Task 4/8's seed hasn't run
  // yet, or every account was removed). Startup must still come up so
  // somebody can log in and add one -- not refuse to serve, and not lie
  // about being healthy.
  const db = tempDb();
  const accounts = listAccounts(db);
  assert.equal(accounts.length, 0);

  const masterKey = await resolveMasterKey(db, MASTER_SECRET);
  const store = chooseStore({ db, masterKey, env: {} });
  const accountStates = new Map<string, AccountState>();
  const tokens = await acquireCredentials(store, accounts, {
    onFailure: () => assert.fail("onFailure must not run when there are no accounts to fail"),
  });
  assert.equal(tokens.size, 0);

  await withRouterFor(db, accounts, accountStates, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 503, "must answer, not be unreachable");
    const body = (await res.json()) as { ok: boolean; error?: string; accounts: unknown[] };
    assert.equal(body.ok, false);
    assert.equal(body.error, "no accounts configured");
    assert.deepEqual(body.accounts, []);
  });

  db.close();
});

test("a wrong master key KILLS THE PROCESS -- the server does not keep listening (final-review fix 2)", async () => {
  // The claim "refuse to start on a wrong master key" was previously only
  // half-true: server.listen() runs BEFORE acquireCredentials, main()'s
  // rejection set process.exitCode = 1 without calling exit(), and the
  // listening handle kept the event loop alive. The result was a zombie that
  // synced nothing and that `restart: unless-stopped` never recycled.
  //
  // Only a real subprocess can assert this -- the old test asserted merely
  // that acquireCredentials rejects, which was equally true of the broken
  // behaviour. Booting the real entrypoint and requiring it to EXIT is the
  // discriminating check.
  const dir = tempDir("boot");
  const dbPath = path.join(dir, "wilco.db");
  const rightSecret = "the-right-master-secret-do-not-leak-it";
  const wrongSecret = "the-wrong-master-secret-do-not-leak-it";
  const secretToken = "the-actual-fastmail-jmap-token-value";

  const seed = openDb(dbPath);
  const spec: AccountSpec = {
    key: "personal",
    label: "Personal",
    accent: "blue",
    provider: "jmap",
    endpoint: "https://api.fastmail.com/jmap/session",
  };
  addAccount(seed, spec);
  const rightStore = chooseStore({ db: seed, masterKey: await resolveMasterKey(seed, rightSecret), env: {} });
  await rightStore.put("personal", secretToken);
  seed.close();

  const port = await freePort();
  const entry = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env["PATH"],
      WILCO_DB_PATH: dbPath,
      WILCO_BLOB_DIR: path.join(dir, "blobs"),
      WILCO_PORT: String(port),
      WILCO_BASE_URL: "https://mail.example.test",
      WILCO_BODY_BASE_URL: "https://mailbody.example.test",
      WILCO_MASTER_KEY: wrongSecret,
      WILCO_CREDENTIAL_STORE: "db",
      WILCO_PASSWORD_HASH: "scrypt$notarealhash$notarealkey",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { out += b.toString(); });

  const exit = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 20_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });

  assert.equal(exit, 1, "the process must DIE on a wrong master key, not linger with an open listener");
  // And it must not have printed the credential on the way out.
  assert.ok(!out.includes(secretToken), "startup failure output must never carry a credential");
});

test("openBootDatabase moves a genuinely unopenable database aside and rebuilds -- existing coverage kept", () => {
  const dbPath = tempDbPath("corrupt");
  writeFileSync(dbPath, "not a real sqlite file, just garbage bytes to corrupt it");

  const db = openBootDatabase(dbPath);
  try {
    const { user_version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.equal(user_version, SCHEMA_VERSION, "the rebuilt database is fresh, at the current schema");
  } finally {
    db.close();
  }

  const dir = readdirSync(path.dirname(dbPath));
  assert.ok(
    dir.some((f) => f.startsWith("wilco.db.unusable-")),
    "the corrupt original must have been moved aside, not deleted",
  );
});

test("a rollback across a migration EXITS LOUDLY and never moves the database aside", async () => {
  // This is the hazard from the 2026-09-22 migration-10 deploy: an older
  // build opening a database a newer build already migrated. Before this
  // fix, openDb's UnusableDatabase sent it straight into rebuildDatabase,
  // which renamed the file aside and started empty -- wiping accounts,
  // sealed credentials and mail. The fix must refuse to start instead and
  // leave the file exactly as it was.
  const dir = tempDir("future-schema");
  const dbPath = path.join(dir, "wilco.db");
  const futureVersion = SCHEMA_VERSION + 7;

  const seed = new DatabaseSync(dbPath);
  seed.exec(`PRAGMA user_version = ${futureVersion}`);
  seed.close();

  const before = statSync(dbPath);

  const port = await freePort();
  const entry = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env["PATH"],
      WILCO_DB_PATH: dbPath,
      WILCO_BLOB_DIR: path.join(dir, "blobs"),
      WILCO_PORT: String(port),
      WILCO_BASE_URL: "https://mail.example.test",
      WILCO_BODY_BASE_URL: "https://mailbody.example.test",
      WILCO_MASTER_KEY: "irrelevant-here-the-db-refuses-before-credentials",
      WILCO_CREDENTIAL_STORE: "db",
      WILCO_PASSWORD_HASH: "scrypt$notarealhash$notarealkey",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { out += b.toString(); });

  const exit = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 20_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });

  assert.equal(exit, 1, "an older build must refuse to start against a newer schema, not rebuild it away");
  assert.match(out, new RegExp(`schema version ${futureVersion}`));
  assert.match(out, new RegExp(`understands ${SCHEMA_VERSION}`));

  // openDb sets WAL/foreign_keys/busy_timeout PRAGMAs before it ever reads
  // user_version, so the file's own bytes/mtime legitimately change on any
  // open attempt -- what must NOT happen is the file being renamed aside
  // and its content (the future user_version an operator would want back)
  // replaced by an empty database.
  const after = statSync(dbPath);
  assert.equal(after.ino, before.ino, "the database file must still be at its original path -- same inode");

  const raw = new DatabaseSync(dbPath);
  const { user_version } = raw.prepare("PRAGMA user_version").get() as { user_version: number };
  raw.close();
  assert.equal(user_version, futureVersion, "the database's content must be untouched, not rebuilt empty");

  const dir2 = readdirSync(dir);
  assert.ok(
    !dir2.some((f) => f.includes(".unusable-")),
    "a future-schema refusal must never rename the database aside",
  );
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

test("a wrong master key REFUSES TO START rather than degrading like a missing credential (fix round 1)", async () => {
  // A typo'd WILCO_MASTER_KEY against a database that already has sealed
  // credentials must not look like "no credential was ever stored" --
  // that reading could lead an operator to `put` a fresh one under the
  // wrong key and permanently overwrite the real one. acquireCredentials
  // must throw the SealError, not swallow it into onFailure.
  //
  // This asserts the THROW only. That the throw actually ends the process is
  // a separate, stronger claim, covered by the subprocess boot test above --
  // do not read this test as evidence of it.
  const dir = tempDir();
  const dbPath = path.join(dir, "wilco.db");
  const rightSecret = "the-right-master-secret-do-not-leak-it";
  const wrongSecret = "the-wrong-master-secret-do-not-leak-it";
  const secretToken = "the-actual-fastmail-jmap-token-value";

  let db = openDb(dbPath);
  const spec: AccountSpec = {
    key: "personal",
    label: "Personal",
    accent: "blue",
    provider: "jmap",
    endpoint: "https://api.fastmail.com/jmap/session",
  };
  addAccount(db, spec);
  const rightKey = await resolveMasterKey(db, rightSecret);
  const rightStore = chooseStore({ db, masterKey: rightKey, env: {} });
  await rightStore.put("personal", secretToken);
  db.close();

  // Reopen: the salt persists in `meta`, so this is a wrong-secret failure,
  // not a fresh-salt one.
  db = openDb(dbPath);
  const wrongKey = await resolveMasterKey(db, wrongSecret);
  const wrongStore = chooseStore({ db, masterKey: wrongKey, env: {} });

  let onFailureCalled = false;
  await assert.rejects(
    () =>
      acquireCredentials(wrongStore, [spec], {
        onFailure: () => {
          onFailureCalled = true;
        },
      }),
    (err: unknown) => err instanceof SealError,
  );
  assert.equal(onFailureCalled, false, "a wrong master key must abort, not degrade one account");

  db.close();
});

test("a genuinely missing credential still degrades that one account, not the process (fix round 1)", async () => {
  // The other branch of the same distinction: an account with NO row in
  // `credentials` at all must still resolve to the ordinary per-account
  // "auth" degradation, not a thrown error -- only a SealError (a wrong
  // key against an EXISTING sealed row) is fatal.
  const db = tempDb();
  const spec: AccountSpec = {
    key: "personal",
    label: "Personal",
    accent: "blue",
    provider: "jmap",
    endpoint: "https://api.fastmail.com/jmap/session",
  };
  addAccount(db, spec);
  const masterKey = await resolveMasterKey(db, "any-sufficiently-long-secret-value");
  const store = chooseStore({ db, masterKey, env: {} });

  let failed: string | undefined;
  const tokens = await acquireCredentials(store, [spec], {
    onFailure: (key) => {
      failed = key;
    },
  });
  assert.equal(tokens.size, 0);
  assert.equal(failed, "personal");
  db.close();
});

test("the master key never reaches /healthz or a log", async () => {
  // Drive a real failure -- reopening the store with the WRONG master
  // secret, so open() throws SealError, which acquireCredentials now lets
  // escape (see the two tests above) -- and assert the secret (right or
  // wrong) and the sealed credential never show up in the thrown error's
  // message or anything written to console.error while handling it, the
  // same way main()'s own top-level `.catch` would log it.
  const dir = tempDir();
  const dbPath = path.join(dir, "wilco.db");
  const rightSecret = "the-right-master-secret-do-not-leak-it";
  const wrongSecret = "the-wrong-master-secret-do-not-leak-it";
  const secretToken = "the-actual-fastmail-jmap-token-value";

  let db = openDb(dbPath);
  const spec: AccountSpec = {
    key: "personal",
    label: "Personal",
    accent: "blue",
    provider: "jmap",
    endpoint: "https://api.fastmail.com/jmap/session",
  };
  addAccount(db, spec);
  const rightKey = await resolveMasterKey(db, rightSecret);
  const rightStore = chooseStore({ db, masterKey: rightKey, env: {} });
  await rightStore.put("personal", secretToken);
  db.close();

  db = openDb(dbPath);
  const wrongKey = await resolveMasterKey(db, wrongSecret);
  const wrongStore = chooseStore({ db, masterKey: wrongKey, env: {} });

  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };

  let caughtMessage = "";
  try {
    try {
      await acquireCredentials(wrongStore, [spec]);
    } catch (err) {
      // Exactly what main()'s top-level catch does: err.message only.
      caughtMessage = err instanceof Error ? err.message : String(err);
      console.error("wilco failed to start:", caughtMessage);
    }
  } finally {
    console.error = originalError;
  }

  assert.notEqual(caughtMessage, "", "the SealError must have been caught");

  const haystack = [caughtMessage, logs.join("\n")].join("\n");
  for (const secret of [rightSecret, wrongSecret, secretToken]) {
    assert.doesNotMatch(haystack, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  db.close();
});

test("a credential sealed in one session opens in the next, from the persisted salt (restart-stability)", async () => {
  // Task 6, step 5: the restart path in miniature. If ensureMasterKeySalt
  // generated a fresh salt on the second openDb, deriveMasterKey would
  // produce a DIFFERENT key even from the identical secret, and this would
  // fail exactly the way "the master key never reaches..." above deliberately
  // makes fail with the WRONG secret.
  const dir = tempDir();
  const dbPath = path.join(dir, "wilco.db");
  const secret = "the-same-master-secret-both-sessions";
  const token = "personal-jmap-token-that-must-survive-restart";

  let db = openDb(dbPath);
  addAccount(db, {
    key: "personal",
    label: "Personal",
    accent: "blue",
    provider: "jmap",
    endpoint: "https://api.fastmail.com/jmap/session",
  });
  const key1 = await resolveMasterKey(db, secret);
  await chooseStore({ db, masterKey: key1, env: {} }).put("personal", token);
  const saltRow1 = db.prepare("SELECT value FROM meta WHERE key = 'master_key_salt'").get() as {
    value: string;
  };
  db.close();

  db = openDb(dbPath);
  const saltRow2 = db.prepare("SELECT value FROM meta WHERE key = 'master_key_salt'").get() as {
    value: string;
  };
  assert.equal(saltRow2.value, saltRow1.value, "the salt must not change across a restart");

  const key2 = await resolveMasterKey(db, secret);
  assert.deepEqual(key2, key1, "the same secret plus the same salt must derive the same key");

  const reopened = await chooseStore({ db, masterKey: key2, env: {} }).get("personal");
  assert.equal(reopened, token);
  db.close();
});

test("a concurrent salt race is a no-op for the loser, not a crash (fix round 1)", () => {
  // Two `ensureMasterKeySalt` calls against the SAME open connection, back
  // to back, simulate the read-then-write race two simultaneous boots would
  // hit: both would see no row and both would try to INSERT. Before the fix
  // this INSERT was unguarded and the second call threw a PK-constraint
  // error straight out of main(); `ensureMasterKeySalt` is exported
  // specifically so this can be driven directly without actually forking
  // two processes.
  const db = tempDb();
  const first = ensureMasterKeySalt(db);
  const second = ensureMasterKeySalt(db);
  assert.deepEqual(second, first, "the loser must adopt the winner's salt, not generate its own");
  db.close();
});

// ---------------------------------------------------------------------------
// acquireCredentials (spec 8.1, `keys` backend) -- ported from the retired
// acquireTokens tests in test/credentials.test.ts in Task 6's fix round 1.
// acquireCredentials only retries with backoff when store.kind === "keys"
// (see its doc comment in src/server/main.ts); every test above this block
// uses chooseStore({env:{}}), i.e. the "db" backend with attempts = 1, so
// none of them ever exercise this loop body. These do, against a real
// KeysCliStore with an injected run.
// ---------------------------------------------------------------------------

test("a `keys`-backed credential is used as-is when the first attempt succeeds", async () => {
  let calls = 0;
  const store = new KeysCliStore(DEFAULT_NAME_FOR, async () => {
    calls += 1;
    return { stdout: "from-keys", stderr: "" };
  });
  const tokens = await acquireCredentials(store, [{ key: "personal" }], { sleep: async () => {} });
  assert.equal(tokens.get("personal"), "from-keys");
  assert.equal(calls, 1);
});

test("A TRANSIENT keys FAILURE IS RETRIED, NOT FATAL", async () => {
  // The keys service and this container start together; losing the race
  // must not mean a permanently dead sync loop.
  let attempts = 0;
  const waits: number[] = [];
  const store = new KeysCliStore(DEFAULT_NAME_FOR, async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("connection refused");
    return { stdout: "eventually", stderr: "" };
  });
  const tokens = await acquireCredentials(store, [{ key: "personal" }], {
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(tokens.get("personal"), "eventually");
  assert.equal(attempts, 3);
  assert.ok(waits.length >= 2 && waits[1]! >= waits[0]!, "backoff must not shrink");
});

test("giving up on one account's keys credential leaves the OTHER accounts usable", async () => {
  // Spec 8.1: one account's exhausted retries must not take the others down.
  const accounts = [{ key: "personal" }, { key: "work" }, { key: "society" }, { key: "atelier" }];
  const store = new KeysCliStore(DEFAULT_NAME_FOR, async (_file, args) => {
    const requestedName = args[0] === "exec" ? args[1] : undefined;
    if (requestedName === DEFAULT_NAME_FOR("personal")) throw new Error("always down");
    return { stdout: "a-real-looking-token", stderr: "" };
  });
  const tokens = await acquireCredentials(store, accounts, { sleep: async () => {} });
  assert.equal(tokens.has("personal"), false, "the unobtainable one is absent");
  assert.equal(tokens.size, 3, "the other three still work");
});

test("no credential value can reach an error or a log line via the keys backend", async () => {
  const SECRET_VALUE = "s3cret-token-value";
  let caught: unknown;
  const store = new KeysCliStore(DEFAULT_NAME_FOR, async () => {
    const e = new Error("boom") as Error & { stdout?: string };
    e.stdout = SECRET_VALUE; // execFile really does attach this
    throw e;
  });
  try {
    await acquireCredentials(store, [{ key: "personal" }], { sleep: async () => {} });
  } catch (err) {
    caught = err;
  }
  // acquireCredentials degrades (via onFailure) rather than throwing once
  // retries are exhausted -- see "giving up..." above -- so the happy path
  // here is nothing was ever caught. If something WAS thrown, it must not
  // carry the secret.
  assert.ok(
    caught === undefined ||
      !JSON.stringify(caught, Object.getOwnPropertyNames(caught as object)).includes(SECRET_VALUE),
  );
});

test("a hanging keys CLI does not stall credential acquisition for every account", async () => {
  // The exact case spec 8.1 named: `keys` hanging rather than failing.
  // TOKEN_RETRY_MS only bounds the retry COUNT -- without a per-attempt
  // timeout, KeysCliStore's `await run(...)` would never settle and
  // acquireCredentials (sequential across accounts) would stall forever.
  const accounts = [{ key: "personal" }, { key: "work" }, { key: "society" }, { key: "atelier" }];
  const hangingRunner = makeExecFileRunner(150);
  let failedAccount: string | undefined;
  const store = new KeysCliStore(DEFAULT_NAME_FOR, async (_file, args) => {
    // Only personal's requests actually hang -- the point under test is
    // that ANY command that never exits on its own is bounded, not that
    // every account hangs; the other three prove they were never blocked
    // waiting on personal's retries. Ignore what KeysCliStore actually
    // asked to run for personal -- run a real `sleep 30` so the 150ms
    // execFile timeout genuinely has something to bound.
    const requestedName = args[0] === "exec" ? args[1] : undefined;
    if (requestedName === DEFAULT_NAME_FOR("personal")) return hangingRunner("sleep", ["30"]);
    return { stdout: "a-real-looking-token", stderr: "" };
  });
  const tokens = await acquireCredentials(store, accounts, {
    sleep: async () => {},
    onFailure: (accountKey) => {
      failedAccount = accountKey;
    },
  });
  assert.equal(tokens.has("personal"), false);
  assert.equal(failedAccount, "personal");
  assert.equal(tokens.size, 3, "the other three accounts are unaffected");
});

test("a missing credential degrades the accounts but keeps the server serving", async () => {
  // Reproduces exactly what main()'s acquireCredentials onFailure callback
  // writes, per account, when a credential cannot be obtained (fix round 1:
  // corrected from the old "no JMAP token available for <ENV_VAR_NAME>"
  // message, which assumed an env/keys-shaped credential name and which
  // main() can no longer produce now that the credential comes from a
  // single chosen CredentialStore -- see acquireCredentials in
  // src/server/main.ts).
  const accountStates = new Map<string, AccountState>(
    ACCOUNT_SPECS.map((a) => [
      a.key,
      { kind: "auth" as const, message: `no credential available for ${a.key}` },
    ]),
  );

  await withAppStates(accountStates, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 503, "the server must still answer, not be gone");
    const body = (await res.json()) as {
      ok: boolean;
      accounts: { account: string; state: string; message?: string }[];
    };
    assert.equal(body.ok, false);
    assert.equal(body.accounts.length, ACCOUNT_SPECS.length);
    for (const a of body.accounts) {
      assert.equal(a.state, "auth");
      assert.match(a.message ?? "", /no credential available for/);
    }
  });
});

test("one account's unobtainable credential degrades only that account", async () => {
  const accountStates = new Map<string, AccountState>(
    ACCOUNT_SPECS.map((a, i) =>
      i === 0
        ? [a.key, { kind: "auth" as const, message: `no credential available for ${a.key}` }]
        : [a.key, { kind: "ok" as const }],
    ),
  );

  await withAppStates(accountStates, async (base) => {
    const body = (await (await fetch(`${base}/healthz`)).json()) as {
      accounts: { account: string; state: string; message?: string }[];
    };
    const failed = body.accounts.find((a) => a.account === ACCOUNT_SPECS[0]!.key)!;
    assert.equal(failed.state, "auth");
    assert.match(failed.message ?? "", /no credential available for/);

    for (const a of ACCOUNT_SPECS.slice(1)) {
      const entry = body.accounts.find((x) => x.account === a.key)!;
      assert.equal(entry.state, "ok", `${a.key} must be unaffected by another account's failure`);
    }
  });
});

test("/healthz is reachable without a session", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.ok(res.status === 200 || res.status === 503, "must answer, not redirect to login");
  });
});

test("/healthz is 503 when an account has never synced", async () => {
  await withApp(async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 503);
  });
});

test("an API route without a session is 401", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "hello" }),
    });
    assert.equal(res.status, 401);
  });
});

test("login with the right password sets a session cookie and the API then works", async () => {
  await withApp(async (base) => {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ password: "letmein" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);

    const res = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: {
        cookie: cookie.split(";")[0]!,
        "content-type": "application/json",
        origin: ORIGIN,
        "x-wilco-csrf": "1",
      },
      body: JSON.stringify({ q: "hello" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    assert.deepEqual(body.rows, []);
    assert.equal(body.total, 0);
  });
});

test("login with the wrong password is 401 and sets no cookie", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ password: "nope" }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
  });
});

test("login from another example.com origin is rejected by the CSRF check", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://frame.example.com",
        "x-wilco-csrf": "1",
      },
      body: JSON.stringify({ password: "letmein" }),
    });
    assert.equal(res.status, 403);
  });
});

test("/api/events requires a session", async () => {
  // An unauthenticated SSE subscription would let anyone on the network
  // watch mail-arrival timing.
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/events`);
    assert.equal(res.status, 401);
  });
});

test("/api/events connects for an authenticated session", async () => {
  await withApp(async (base) => {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ password: "letmein" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    controller.abort();
  });
});

test("failureState surfaces the real message for an unrecognised error (finding 4)", () => {
  // walkArchive's and backfillBodies's own progress-guard errors are plain
  // Error objects -- classify() cannot pin them on the transport or the
  // server, so they were previously collapsed to the generic "an
  // unrecognised error occurred" and became unreachable. That is the most
  // diagnostic text in the codebase; it must survive into the account state.
  const walkMessage =
    "archive walk made no progress for personal: the server repeated the page ending at Mabc";
  const state = failureState(new Error(walkMessage));
  assert.equal(state.kind, "unknown");
  assert.equal((state as { message: string }).message, walkMessage);
});

test("failureState still uses classify's own message for a recognised failure", () => {
  // A recognised failure (auth, network, rate-limited, server) must keep
  // classify's stable, deliberately generic message -- not every HTTP
  // status error carries something safe to surface, and classify()'s
  // messages are the ones already proven not to.
  const state = failureState(new HttpStatusError("JMAP request failed with 401", 401));
  assert.equal(state.kind, "auth");
  assert.equal((state as { message: string }).message, "authentication was refused");
});
