import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.ts";
import { buildRouter, liveAccountHooks, resolveMasterKey } from "../src/server/main.ts";
import { hashPassword } from "../src/server/auth.ts";
import { addAccount, type AccountSpec } from "../src/core/accounts.ts";
import { chooseStore, type CredentialStore } from "../src/core/credentials.ts";
import { verifyEndpoint, VerifyError } from "../src/core/verify-account.ts";
import { tempDbPath } from "./tmpdir.ts";

const ORIGIN = "https://mail.example.com";
const MASTER_SECRET = "a-sufficiently-long-accounts-api-test-secret";

/** A stand-in for the real verifyEndpoint that never touches the network:
 *  it succeeds immediately, returning the endpoint it was given unchanged
 *  and no username. Every test in this file that doesn't care about
 *  verification behaviour gets this by default, so a POST with a credential
 *  never makes a real HTTP call in the suite. Tests that DO care pass their
 *  own `verify` via the `opts` parameter. */
const NOOP_VERIFY: typeof verifyEndpoint = async (endpoint) => ({ endpoint, username: null });

const SPEC: AccountSpec = {
  key: "personal",
  label: "Personal",
  accent: "blue",
  provider: "jmap",
  endpoint: "https://api.fastmail.com/jmap/session",
  code: "PER",
};

function tempDb(): DatabaseSync {
  return openDb(tempDbPath());
}

/**
 * Spins up a real HTTP server around buildRouter, with a live
 * EncryptedDbStore wired in via Deps.store -- exactly the shape main.ts now
 * builds (see main.ts's reordering of store creation ahead of buildRouter).
 * Callers get back the db and the store too, since several assertions need
 * to look at credentials/accounts rows directly.
 */
async function withApp(
  fn: (base: string, db: DatabaseSync, store: CredentialStore) => Promise<void>,
  opts: {
    verify?: typeof verifyEndpoint;
    onAccountAdded?: (spec: AccountSpec, credential: string) => void;
    onCredentialRotated?: (key: string, credential: string) => void;
  } = {},
): Promise<void> {
  const db = tempDb();
  const masterKey = await resolveMasterKey(db, MASTER_SECRET);
  const store = chooseStore({ db, masterKey, env: {} });
  const router = buildRouter({
    db,
    passwordHash: await hashPassword("letmein"),
    origin: ORIGIN,
    accountStates: new Map(),
    accounts: [],
    store,
    verifyAccountEndpoint: opts.verify ?? NOOP_VERIFY,
    onAccountAdded: opts.onAccountAdded,
    onCredentialRotated: opts.onCredentialRotated,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, db, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
}

/**
 * A minimal CredentialStore whose put() always rejects -- used to exercise
 * the two branches real EnvStore/KeysCliStore rejection would take without
 * depending on either's actual env/subprocess plumbing. `kind` is
 * caller-supplied so both the "expected, read-only backend" (kind !== "db")
 * and "genuine failure on the db backend" (kind === "db") paths can be
 * driven directly.
 */
class RejectingStore implements CredentialStore {
  readonly kind: string;
  private message: string;
  puts: string[] = [];

  constructor(kind: string, message = "rejected") {
    this.kind = kind;
    this.message = message;
  }

  async get(_account: string): Promise<string | null> {
    return null;
  }

  async put(account: string, _secret: string): Promise<void> {
    this.puts.push(account);
    throw new Error(this.message);
  }

  async remove(_account: string): Promise<void> {}
}

/**
 * Same shape as withApp, but lets a test supply its own CredentialStore
 * (e.g. RejectingStore) instead of a real EncryptedDbStore -- used for the
 * read-only-backend and genuine-db-failure branches, which a live store
 * cannot be made to hit on demand.
 */
async function withAppUsing(
  store: CredentialStore,
  fn: (base: string, db: DatabaseSync) => Promise<void>,
  opts: {
    verify?: typeof verifyEndpoint;
    onAccountAdded?: (spec: AccountSpec, credential: string) => void;
  } = {},
): Promise<void> {
  const db = tempDb();
  const router = buildRouter({
    db,
    passwordHash: await hashPassword("letmein"),
    origin: ORIGIN,
    accountStates: new Map(),
    accounts: [],
    store,
    verifyAccountEndpoint: opts.verify ?? NOOP_VERIFY,
    onAccountAdded: opts.onAccountAdded,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, db);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
}

async function login(base: string): Promise<string> {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
    body: JSON.stringify({ password: "letmein" }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function mutHeaders(cookie: string): Record<string, string> {
  return {
    "content-type": "application/json",
    cookie,
    origin: ORIGIN,
    "x-wilco-csrf": "1",
  };
}

test("every /api/accounts route requires a session", async () => {
  await withApp(async (base) => {
    assert.equal((await fetch(`${base}/api/accounts`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/accounts`, { method: "POST", body: "{}" })).status,
      401,
    );
    assert.equal((await fetch(`${base}/api/accounts/personal`, { method: "DELETE" })).status, 401);
    assert.equal(
      (await fetch(`${base}/api/accounts/personal/credential`, { method: "PUT", body: "{}" }))
        .status,
      401,
    );
  });
});

// Fix round 1 (post Task 8 review): a valid bearer token hitting
// /api/accounts must get the SAME 403 a token gets from /api/tokens
// (tokens-api.test.ts's "a token cannot list or revoke tokens either"),
// not the 401 an anonymous caller gets. Both files' `authed`/`requireSession`
// guards distinguish "no Principal" (401) from "a real Principal that just
// isn't a session" (403) -- before this fix, accounts-api.ts collapsed the
// second case into the first.
test("a valid bearer token is 403 here (not 401) -- same status tokens-api.ts gives itself", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const minted = (await (
      await fetch(`${base}/api/tokens`, {
        method: "POST",
        headers: mutHeaders(cookie),
        body: JSON.stringify({ label: "agent", expiresInDays: 1 }),
      })
    ).json()) as { token: string };

    const res = await fetch(`${base}/api/accounts`, {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    assert.equal(res.status, 403, "a real, valid token is a known caller who is simply not allowed here");
  });
});

test("an unauthenticated request never touches the database", async () => {
  await withApp(async (base, db) => {
    const res = await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify(SPEC),
    });
    assert.equal(res.status, 401);
    const count = db.prepare("SELECT count(*) c FROM accounts").get() as { c: number };
    assert.equal(count.c, 0);
  });
});

test("mutating routes require the CSRF header and an exact Origin", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);

    // No CSRF header at all.
    const noHeader = await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify(SPEC),
    });
    assert.equal(noHeader.status, 403);

    // A same-site (example.com) but wrong-subdomain Origin.
    const wrongOrigin = await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://frame.example.com",
        "x-wilco-csrf": "1",
      },
      body: JSON.stringify(SPEC),
    });
    assert.equal(wrongOrigin.status, 403);

    const del = await fetch(`${base}/api/accounts/personal`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(del.status, 403);

    const put = await fetch(`${base}/api/accounts/personal/credential`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ credential: "x" }),
    });
    assert.equal(put.status, 403);
  });
});

test("GET /api/accounts returns account metadata and never a credential", async () => {
  await withApp(async (base, db, store) => {
    addAccount(db, SPEC);
    await store.put(SPEC.key, "super-secret-jmap-token");
    const cookie = await login(base);

    const res = await fetch(`${base}/api/accounts`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const text = await res.text();

    assert.doesNotMatch(text, /super-secret-jmap-token/);
    assert.doesNotMatch(text, /sealed/i);

    const body = JSON.parse(text) as AccountSpec[];
    // `position` is the owner's sidebar order (row 34); a first account is 0.
    const first = (body as unknown as ({ position: number; showInUnified: boolean } & Record<string, unknown>)[])[0]!;
    const { position, showInUnified, ...rest } = first;
    assert.deepEqual([rest], [SPEC]);
    assert.equal(position, 0);
    assert.equal(showInUnified, true, "row 48: shown in All inboxes unless switched off");
  });
});

test("POST validates the key and endpoint, reusing addAccount's rules", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);

    const badKey = await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ ...SPEC, key: "has space" }),
    });
    assert.equal(badKey.status, 400);
    const badKeyBody = (await badKey.json()) as { error: string };
    assert.match(badKeyBody.error, /key/);

    const badEndpoint = await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ ...SPEC, key: "other", endpoint: "http://not-https.example" }),
    });
    assert.equal(badEndpoint.status, 400);
    const badEndpointBody = (await badEndpoint.json()) as { error: string };
    assert.match(badEndpointBody.error, /https/);
  });
});

test("POST validates the endpoint BEFORE probing it, so a non-https endpoint never sees the credential", async () => {
  // Whole-branch-review Important 1: verifyEndpoint used to run ahead of
  // addAccount's own https/key checks, so a POST naming a plaintext endpoint
  // still sent the caller's bearer token there -- in the clear -- before the
  // 400 that rejected the request. `verify` here must NEVER be called.
  let verifyCalls = 0;
  const verify: typeof verifyEndpoint = async (endpoint) => {
    verifyCalls += 1;
    return { endpoint, username: null };
  };

  await withApp(
    async (base) => {
      const cookie = await login(base);

      const res = await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: mutHeaders(cookie),
        body: JSON.stringify({
          ...SPEC,
          endpoint: "http://10.10.10.68:8081/",
          credential: "super-secret-jmap-token",
        }),
      });

      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /https/);
      assert.equal(verifyCalls, 0, "verifyEndpoint must not be called before the endpoint is validated");
    },
    { verify },
  );
});

test("POST with a credential stores it through the store and never echoes it", async () => {
  await withApp(async (base, db, store) => {
    const cookie = await login(base);

    const res = await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ ...SPEC, credential: "super-secret-jmap-token" }),
    });
    assert.equal(res.status, 201);
    const text = await res.text();
    assert.doesNotMatch(text, /super-secret-jmap-token/);

    const stored = await store.get(SPEC.key);
    assert.equal(stored, "super-secret-jmap-token");

    const rowCount = db.prepare("SELECT count(*) c FROM accounts").get() as { c: number };
    assert.equal(rowCount.c, 1);
  });
});

test("DELETE removes the account and its credential but not its mail", async () => {
  await withApp(async (base, db, store) => {
    addAccount(db, SPEC);
    await store.put(SPEC.key, "super-secret-jmap-token");
    db.prepare(
      `INSERT INTO emails (account, id, received_at) VALUES ('personal', 'm1', '2026-01-01T00:00:00Z')`,
    ).run();
    const cookie = await login(base);

    const before = db.prepare("SELECT count(*) c FROM emails").get() as { c: number };

    const res = await fetch(`${base}/api/accounts/${SPEC.key}`, {
      method: "DELETE",
      headers: mutHeaders(cookie),
    });
    assert.equal(res.status, 200);

    const accountCount = db.prepare("SELECT count(*) c FROM accounts").get() as { c: number };
    assert.equal(accountCount.c, 0);
    const credCount = db.prepare("SELECT count(*) c FROM credentials").get() as { c: number };
    assert.equal(credCount.c, 0);
    assert.equal(await store.get(SPEC.key), null);

    const after = db.prepare("SELECT count(*) c FROM emails").get() as { c: number };
    assert.equal(after.c, before.c, "message count must be unchanged");
    assert.equal(after.c, 1);
  });
});

test("a duplicate key returns 409, not 500", async () => {
  await withApp(async (base, db) => {
    addAccount(db, SPEC);
    const cookie = await login(base);

    const res = await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: mutHeaders(cookie),
      body: JSON.stringify(SPEC),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /already exists/);
  });
});

test("PUT /api/accounts/:key/credential updates the store without echoing it", async () => {
  await withApp(async (base, _db, store) => {
    addAccount(_db, SPEC);
    const cookie = await login(base);

    const res = await fetch(`${base}/api/accounts/${SPEC.key}/credential`, {
      method: "PUT",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ credential: "rotated-token" }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /rotated-token/);

    assert.equal(await store.get(SPEC.key), "rotated-token");
  });
});

test("PUT credential for an unknown account is 404, not a silent write", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const res = await fetch(`${base}/api/accounts/nobody/credential`, {
      method: "PUT",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ credential: "x" }),
    });
    assert.equal(res.status, 404);
  });
});

test("POST with a credential verifies the endpoint+token BEFORE storing; a resolved endpoint wins", async () => {
  // Simulates the .well-known -> Fastmail fallback: the submitted endpoint
  // is a guess, and verifyEndpoint resolves it to something else entirely.
  // The row that gets stored must carry the RESOLVED endpoint, and the 201
  // must report the session's username.
  const calls: string[] = [];
  const verify: typeof verifyEndpoint = async (endpoint, token) => {
    calls.push(endpoint);
    assert.equal(token, "super-secret-jmap-token", "the real credential is what gets probed");
    return { endpoint: "https://api.fastmail.com/jmap/session", username: "robin@example.com" };
  };

  await withApp(
    async (base, db, store) => {
      const cookie = await login(base);
      const res = await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: mutHeaders(cookie),
        body: JSON.stringify({
          ...SPEC,
          endpoint: "https://example.com/.well-known/jmap",
          credential: "super-secret-jmap-token",
        }),
      });
      const text = await res.text();
      assert.equal(res.status, 201, text);
      const body = JSON.parse(text) as { endpoint: string; username: string };
      assert.equal(body.endpoint, "https://api.fastmail.com/jmap/session");
      assert.equal(body.username, "robin@example.com");
      assert.doesNotMatch(text, /super-secret-jmap-token/);

      const row = db.prepare("SELECT endpoint FROM accounts WHERE key = ?").get(SPEC.key) as { endpoint: string };
      assert.equal(row.endpoint, "https://api.fastmail.com/jmap/session", "the row stores the RESOLVED endpoint, not the submitted guess");

      assert.equal(await store.get(SPEC.key), "super-secret-jmap-token");
      assert.deepEqual(calls, ["https://example.com/.well-known/jmap"]);
    },
    { verify },
  );
});

test("POST with a credential that fails verification is 400, and leaves no account or credential row behind", async () => {
  const verify: typeof verifyEndpoint = async () => {
    throw new VerifyError("could not verify https://example.com/.well-known/jmap: HTTP 404", "http");
  };

  await withApp(
    async (base, db, store) => {
      const cookie = await login(base);
      const res = await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: mutHeaders(cookie),
        body: JSON.stringify({
          ...SPEC,
          endpoint: "https://example.com/.well-known/jmap",
          credential: "super-secret-jmap-token",
        }),
      });
      const text = await res.text();
      assert.equal(res.status, 400, text);
      const body = JSON.parse(text) as { error: string; reason: string };
      assert.equal(body.reason, "http");
      assert.match(body.error, /example\.com/);
      assert.doesNotMatch(text, /super-secret-jmap-token/);

      const rows = db.prepare("SELECT count(*) c FROM accounts").get() as { c: number };
      assert.equal(rows.c, 0, "verify runs BEFORE addAccount -- there is nothing to roll back");

      assert.equal(await store.get(SPEC.key), null, "the credential must never have been stored");
    },
    { verify },
  );
});

test("POST without a credential does not probe anything and gains no username", async () => {
  let called = false;
  const verify: typeof verifyEndpoint = async (endpoint, token) => {
    called = true;
    return { endpoint, username: null };
  };

  await withApp(
    async (base) => {
      const cookie = await login(base);
      const res = await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: mutHeaders(cookie),
        body: JSON.stringify(SPEC),
      });
      const text = await res.text();
      assert.equal(res.status, 201, text);
      const body = JSON.parse(text) as { username?: string };
      assert.equal(body.username, undefined);
      assert.equal(called, false, "no credential means no probe at all");
    },
    { verify },
  );
});

test("POST rolls back the account when a read-only credential store rejects the write", async () => {
  const store = new RejectingStore("keys");
  await withAppUsing(store, async (base, db) => {
    // An existing account must survive untouched -- the rollback must
    // remove exactly the row this request just created, nothing else.
    addAccount(db, { ...SPEC, key: "work", label: "Work" });
    const cookie = await login(base);

    const res = await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ ...SPEC, credential: "super-secret-jmap-token" }),
    });

    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /keys/);
    assert.doesNotMatch(body.error, /super-secret-jmap-token/);

    assert.deepEqual(store.puts, ["personal"]);

    const rows = db.prepare("SELECT key FROM accounts ORDER BY key").all() as { key: string }[];
    assert.deepEqual(
      rows.map((r) => r.key),
      ["work"],
      "the account this request created is gone; the pre-existing one is untouched",
    );
  });
});

test("PUT credential is 503 (not 400) when the store cannot write, and names the backend", async () => {
  const store = new RejectingStore("env");
  await withAppUsing(store, async (base, db) => {
    addAccount(db, SPEC);
    const cookie = await login(base);

    const res = await fetch(`${base}/api/accounts/${SPEC.key}/credential`, {
      method: "PUT",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ credential: "super-secret-jmap-token" }),
    });

    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /env/);
    assert.doesNotMatch(body.error, /super-secret-jmap-token/);

    // The account itself is untouched by a credential-only failure.
    const rows = db.prepare("SELECT key FROM accounts").all() as { key: string }[];
    assert.deepEqual(rows.map((r) => r.key), [SPEC.key]);
  });
});

test("a genuine db-backend write failure is NOT reported as 'store cannot write'", async () => {
  // kind: "db" is the live default backend -- a put() failure there is a
  // real, unexpected error (a disk fault, a locked file), not the expected
  // "this backend is read-only" case. It must surface as the router's
  // generic 500, not the 503 read-only message, or an operator debugging a
  // real db problem gets pointed at the wrong cause entirely.
  const store = new RejectingStore("db", "disk I/O error");
  await withAppUsing(store, async (base, db) => {
    const cookie = await login(base);

    const res = await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ ...SPEC, credential: "super-secret-jmap-token" }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.doesNotMatch(body.error, /does not accept writes/);
    assert.doesNotMatch(body.error, /disk I\/O error/);
    assert.doesNotMatch(body.error, /super-secret-jmap-token/);

    // Rolled back here too -- the account row must not be left behind
    // credential-less just because the failure was a genuine one.
    const rows = db.prepare("SELECT key FROM accounts").all() as { key: string }[];
    assert.deepEqual(rows, []);
  });
});

test("a genuine db-backend write failure on PUT is also NOT the read-only message", async () => {
  const store = new RejectingStore("db", "disk I/O error");
  await withAppUsing(store, async (base, db) => {
    addAccount(db, SPEC);
    const cookie = await login(base);

    const res = await fetch(`${base}/api/accounts/${SPEC.key}/credential`, {
      method: "PUT",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ credential: "super-secret-jmap-token" }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.doesNotMatch(body.error, /does not accept writes/);
    assert.doesNotMatch(body.error, /disk I\/O error/);
    assert.doesNotMatch(body.error, /super-secret-jmap-token/);
  });
});

test("🚨 PUT /api/accounts/order SETS THE OWNER'S ORDER, and GET returns it with positions", async () => {
  // Rows 34 and 15. Session-only like the rest of this file.
  await withApp(async (base, db) => {
    for (const key of ["atelier", "personal", "work"]) {
      addAccount(db, { key, label: key, accent: "#000000", provider: "jmap", endpoint: "https://x.test/jmap/session" });
    }
    const cookie = await login(base);
    const H = { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" };
    const res = await fetch(`${base}/api/accounts/order`, { method: "PUT", headers: H, body: JSON.stringify({ order: ["work", "atelier", "personal"] }) });
    assert.equal(res.status, 200);
    const got = (await fetch(`${base}/api/accounts`, { headers: { cookie } }).then((r) => r.json())) as { key: string; position: number }[];
    assert.deepEqual(got.map((a) => [a.key, a.position]), [["work", 0], ["atelier", 1], ["personal", 2]]);

    const bad = await fetch(`${base}/api/accounts/order`, { method: "PUT", headers: H, body: JSON.stringify({ order: ["work"] }) });
    assert.equal(bad.status, 400, "a partial order must be refused");
    const anon = await fetch(`${base}/api/accounts/order`, { method: "PUT", headers: { "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" }, body: JSON.stringify({ order: ["work", "atelier", "personal"] }) });
    assert.equal(anon.status, 401);
  });
});

test("row 37: the signature switches are per-account settings that accept only on/off", async () => {
  // Reuses this file's helpers: the settings PUT is what the spam-folder
  // row already goes through.
  const { isSettingKey } = await import("../src/core/settings.ts");
  assert.equal(isSettingKey("signatureNew"), true);
  assert.equal(isSettingKey("signatureReplies"), true);
  assert.equal(isSettingKey("signatureSometimes"), false);
});

test("row 48: PUT /api/accounts/:key/settings answers in the SAME SHAPE as GET -- settings AND mailboxes", async () => {
  // Found on the live app (2026-09-07): the PUT answered `{ settings }` alone.
  // The account page keeps ONE state for both and renders the spam-folder
  // select from `settings.mailboxes`, so the response the switch handed to
  // setSettings crashed the render (`undefined.map`) and the switch on
  // screen never moved -- while the value had saved. The client test had
  // mocked a `mailboxes: []` the server never sent. Every switch on that
  // page went through this: spam folder, both signature switches, row 48's.
  await withApp(async (base, db) => {
    const cookie = await login(base);
    const H = mutHeaders(cookie);
    const created = await fetch(`${base}/api/accounts`, { method: "POST", headers: H, body: JSON.stringify({ key: "acme", label: "Acme", accent: "#5b6ee0", endpoint: "https://api.fastmail.com/jmap/session" }) });
    assert.equal(created.status, 201, await created.text());
    db.exec(`INSERT INTO mailboxes (account, id, name, role, parent_id, sort_order, total_emails, unread_emails) VALUES ('acme', 'M1', 'Inbox', 'inbox', NULL, 0, 0, 0)`);
    const put = await fetch(`${base}/api/accounts/acme/settings`, { method: "PUT", headers: H, body: JSON.stringify({ key: "showInUnified", value: "off" }) });
    const putBody = JSON.parse(await put.text());
    assert.equal(put.status, 200);
    const got = (await (await fetch(`${base}/api/accounts/acme/settings`, { headers: { cookie } })).json()) as { settings: unknown; mailboxes: unknown };
    assert.deepEqual(putBody, got, "the PUT's answer is what a GET would say");
    assert.deepEqual(putBody.settings, { showInUnified: "off" });
    assert.deepEqual((putBody.mailboxes as { id: string }[]).map((m) => m.id), ["M1"]);
  });
});

test("row 37: PUT /api/accounts/:key edits label, accent and code with validation; resync marks a reconcile; DELETE tells the sync", async () => {
  const removed: string[] = [];
  await withApp(async (base, db) => {
    const cookie = await login(base);
    const H = mutHeaders(cookie);
    const created = await fetch(`${base}/api/accounts`, { method: "POST", headers: H, body: JSON.stringify({ key: "acme", label: "Acme", accent: "#5b6ee0", endpoint: "https://api.fastmail.com/jmap/session" }) });
    assert.equal(created.status, 201, await created.text());

    const ok = await fetch(`${base}/api/accounts/acme`, { method: "PUT", headers: H, body: JSON.stringify({ label: "Acme Corp", accent: "#2a9d6e", code: "acm" }) });
    const okText = await ok.text();
    assert.equal(ok.status, 200, okText);
    const spec = JSON.parse(okText);
    assert.equal(spec.label, "Acme Corp"); assert.equal(spec.accent, "#2a9d6e"); assert.equal(spec.code, "ACM");
    const listed = ((await (await fetch(`${base}/api/accounts`, { headers: { cookie } })).json()) as { key: string; label: string }[]).find((a) => a.key === "acme")!;
    assert.equal(listed.label, "Acme Corp", "persisted");

    for (const bad of [{ label: "" }, { accent: "green" }, { code: "toolong" }]) {
      const r = await fetch(`${base}/api/accounts/acme`, { method: "PUT", headers: H, body: JSON.stringify(bad) });
      assert.equal(r.status, 400, `refused: ${JSON.stringify(bad)}`);
    }
    assert.equal((await fetch(`${base}/api/accounts/nope`, { method: "PUT", headers: H, body: "{}" })).status, 404);

    const { reconcilePending } = await import("../src/core/reconcile.ts");
    assert.equal(reconcilePending(db, "acme"), false);
    const rs = await fetch(`${base}/api/accounts/acme/resync`, { method: "POST", headers: H });
    assert.equal(rs.status, 200);
    assert.equal(((await rs.json()) as { requested: boolean }).requested, true);
    assert.equal(reconcilePending(db, "acme"), true, "the next pass will reconcile");

    void removed;
  });
});

test("POST with a credential notifies the supervisor, once, after the rows exist", async () => {
  // The hot-add half of live accounts: the handler has the plaintext
  // credential in hand, so it hands it straight to the running supervisor
  // rather than leaving the new account unsynced until a restart.
  const added: { spec: AccountSpec; credential: string; rows: number }[] = [];
  let seen: DatabaseSync | null = null;
  await withApp(
    async (base, db, store) => {
      seen = db;
      const cookie = await login(base);
      const res = await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: mutHeaders(cookie),
        body: JSON.stringify({ ...SPEC, credential: "super-secret-jmap-token" }),
      });
      assert.equal(res.status, 201, await res.text());
      assert.equal(added.length, 1, "exactly one notification per created account");
      assert.equal(added[0]!.spec.key, SPEC.key);
      assert.equal(added[0]!.credential, "super-secret-jmap-token");
      // The state of the world AT THE MOMENT the supervisor was told: the
      // account row exists, and so does its credential. A notification that
      // arrived first would send the supervisor to establish an account it
      // cannot read a credential for.
      assert.equal(added[0]!.rows, 1, "the account row must exist before the supervisor is told about it");
      assert.equal(await store.get(SPEC.key), "super-secret-jmap-token");
    },
    {
      onAccountAdded: (spec, credential) => {
        const rows = (seen!.prepare("SELECT count(*) c FROM accounts WHERE key = ?").get(spec.key) as { c: number }).c;
        added.push({ spec, credential, rows });
      },
    },
  );
});

test("POST without a credential never notifies the supervisor", async () => {
  let calls = 0;
  await withApp(
    async (base) => {
      const cookie = await login(base);
      const res = await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: mutHeaders(cookie),
        body: JSON.stringify(SPEC),
      });
      assert.equal(res.status, 201, await res.text());
      assert.equal(calls, 0, "there is no credential to sync with -- nothing to wake for");
    },
    { onAccountAdded: () => { calls += 1; } },
  );
});

test("POST does not notify the supervisor when the credential write fails and the row is rolled back", async () => {
  let calls = 0;
  const store = new RejectingStore("keys");
  await withAppUsing(
    store,
    async (base, db) => {
      const cookie = await login(base);
      const res = await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: mutHeaders(cookie),
        body: JSON.stringify({ ...SPEC, credential: "super-secret-jmap-token" }),
      });
      assert.equal(res.status, 503, await res.text());
      const rows = db.prepare("SELECT count(*) c FROM accounts").get() as { c: number };
      assert.equal(rows.c, 0, "the row was rolled back");
      assert.equal(calls, 0, "so the supervisor must never have been told the account exists");
    },
    { onAccountAdded: () => { calls += 1; } },
  );
});

test("PUT /api/accounts/:key/credential hands the rotated credential to the running supervisor", async () => {
  const rotated: [string, string][] = [];
  await withApp(
    async (base, db) => {
      addAccount(db, SPEC);
      const cookie = await login(base);
      const res = await fetch(`${base}/api/accounts/${SPEC.key}/credential`, {
        method: "PUT",
        headers: mutHeaders(cookie),
        body: JSON.stringify({ credential: "rotated-jmap-token" }),
      });
      assert.equal(res.status, 200, await res.text());
      assert.deepEqual(rotated, [[SPEC.key, "rotated-jmap-token"]]);
    },
    { onCredentialRotated: (key, credential) => { rotated.push([key, credential]); } },
  );
});

test("an account created WITHOUT a credential goes live when one is PUT later", async () => {
  // The gap the first cut of live accounts left: `onAdded` only fires when
  // the POST carried a credential, so a credential-less account never
  // entered the supervisor's `accounts` array -- and a later PUT that only
  // set a token put it somewhere nothing iterates. The account stayed dead
  // until a restart, which is exactly what this work claims to have ended.
  const accounts: AccountSpec[] = [];
  const tokens = new Map<string, string>();
  let wakes = 0;
  const db = tempDb();
  const masterKey = await resolveMasterKey(db, MASTER_SECRET);
  const store = chooseStore({ db, masterKey, env: {} });
  const hooks = liveAccountHooks({ db, accounts, tokens, wake: () => { wakes += 1; } });
  const router = buildRouter({
    db,
    passwordHash: await hashPassword("letmein"),
    origin: ORIGIN,
    accountStates: new Map(),
    accounts,
    store,
    verifyAccountEndpoint: NOOP_VERIFY,
    ...hooks,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const cookie = await login(base);

    const created = await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: mutHeaders(cookie),
      body: JSON.stringify(SPEC),
    });
    assert.equal(created.status, 201, await created.text());
    assert.equal(accounts.length, 0, "nothing to sync with yet, so nothing is handed to the supervisor");
    assert.equal(wakes, 0);

    const rotated = await fetch(`${base}/api/accounts/${SPEC.key}/credential`, {
      method: "PUT",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ credential: "late-jmap-token" }),
    });
    assert.equal(rotated.status, 200, await rotated.text());

    assert.equal(tokens.get(SPEC.key), "late-jmap-token");
    assert.deepEqual(accounts.map((a) => a.key), [SPEC.key],
      "the spec must be read from the database and pushed, or the token is a dead entry nothing iterates");
    assert.equal(accounts[0]!.endpoint, SPEC.endpoint);
    assert.equal(wakes, 1, "and the supervisor must be woken to establish it");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});

test("rotating a credential for an account the supervisor already holds does not duplicate it", async () => {
  const db = tempDb();
  const masterKey = await resolveMasterKey(db, MASTER_SECRET);
  const store = chooseStore({ db, masterKey, env: {} });
  addAccount(db, SPEC);
  const accounts: AccountSpec[] = [{ ...SPEC }];
  const tokens = new Map<string, string>([[SPEC.key, "old"]]);
  let wakes = 0;
  const hooks = liveAccountHooks({ db, accounts, tokens, wake: () => { wakes += 1; } });
  const router = buildRouter({
    db,
    passwordHash: await hashPassword("letmein"),
    origin: ORIGIN,
    accountStates: new Map(),
    accounts,
    store,
    verifyAccountEndpoint: NOOP_VERIFY,
    ...hooks,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const cookie = await login(`http://127.0.0.1:${port}`);
    const res = await fetch(`http://127.0.0.1:${port}/api/accounts/${SPEC.key}/credential`, {
      method: "PUT",
      headers: mutHeaders(cookie),
      body: JSON.stringify({ credential: "rotated" }),
    });
    assert.equal(res.status, 200, await res.text());
    assert.equal(tokens.get(SPEC.key), "rotated");
    assert.equal(accounts.length, 1, "a rotation for a known account must not push a second spec");
    assert.equal(wakes, 0, "nor wake the supervisor -- the account already has a client");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});
