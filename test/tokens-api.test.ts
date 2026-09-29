// test/tokens-api.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.ts";
import { buildRouter } from "../src/server/main.ts";
import { hashPassword } from "../src/server/auth.ts";
import { tempDbPath } from "./tmpdir.ts";

const ORIGIN = "https://mail.example.com";

function tempDb(): DatabaseSync {
  return openDb(tempDbPath());
}

/**
 * Local to this file (Ruling P1: no shared test/helpers.ts). Mirrors
 * read-api.test.ts's withApp/withSession shape: a real HTTP server around
 * buildRouter, with a session already established.
 */
async function withApp(fn: (base: string, db: DatabaseSync) => Promise<void>): Promise<void> {
  const db = tempDb();
  const router = buildRouter({
    db,
    passwordHash: await hashPassword("letmein"),
    origin: ORIGIN,
    accountStates: new Map(),
    accounts: [],
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

interface MintedToken {
  id: string;
  label: string;
  scope: "read" | "write";
  createdAt: string;
  expiresAt: string;
  token: string;
}

/** Mints a token over the live session. Not a public route helper -- POSTs
 *  with the CSRF header a real browser session must supply. */
function mint(
  base: string,
  cookie: string,
  body: { label: string; expiresInDays: number; scope?: "read" | "write" },
): Promise<Response> {
  return fetch(`${base}/api/tokens`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
    body: JSON.stringify(body),
  });
}

async function mintJson(
  base: string,
  cookie: string,
  body: { label: string; expiresInDays?: number; scope?: "read" | "write" },
): Promise<MintedToken> {
  return (await mint(base, cookie, body as { label: string; expiresInDays: number; scope?: "read" | "write" }).then(
    (r) => r.json(),
  )) as MintedToken;
}

test("THE PLAINTEXT TOKEN IS NEVER STORED", async () => {
  await withApp(async (base, db) => {
    const cookie = await login(base);
    const res = await mint(base, cookie, { label: "phone", expiresInDays: 30 });
    assert.equal(res.status, 201);
    const { token } = (await res.json()) as { token: string };
    assert.ok(token && token.length >= 32);

    const rows = db.prepare("SELECT hash FROM api_tokens").all() as { hash: string }[];
    assert.ok(
      !rows.some((r) => r.hash === token),
      "the row must hold a hash, not the token",
    );
    const dump = JSON.stringify(db.prepare("SELECT * FROM api_tokens").all());
    assert.ok(!dump.includes(token), "the token appears nowhere in the table");
  });
});

test("a token is returned exactly once, never in a listing", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const minted = await mintJson(base, cookie, { label: "phone", expiresInDays: 30 });
    const list = await (await fetch(`${base}/api/tokens`, { headers: { cookie } })).json();
    const dump = JSON.stringify(list);
    assert.ok(!dump.includes(minted.token), "a listing must never repeat the plaintext");
    assert.ok(
      !dump.match(/[A-Za-z0-9_-]{32,}/),
      "listing tokens must not expose anything token-shaped",
    );
  });
});

test("read is the default scope and write must be asked for", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const a = await mintJson(base, cookie, { label: "a", expiresInDays: 1 });
    assert.equal(a.scope, "read");
    const b = await mintJson(base, cookie, { label: "b", expiresInDays: 1, scope: "write" });
    assert.equal(b.scope, "write");
  });
});

test("mint requires a session and CSRF, and rejects a missing/invalid body", async () => {
  await withApp(async (base) => {
    const anon = await fetch(`${base}/api/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "x", expiresInDays: 1 }),
    });
    assert.equal(anon.status, 401);

    const cookie = await login(base);
    const noCsrf = await fetch(`${base}/api/tokens`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "x", expiresInDays: 1 }),
    });
    assert.equal(noCsrf.status, 403);

    const noExpiry = await mint(base, cookie, { label: "x" } as any);
    assert.equal(noExpiry.status, 400, "expiry is required at mint, not optional");

    const badScope = await fetch(`${base}/api/tokens`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ label: "x", expiresInDays: 1, scope: "admin" }),
    });
    assert.equal(badScope.status, 400);
  });
});

test("expiresInDays is capped at 365 -- a century-long token is refused", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const tooLong = await mint(base, cookie, { label: "century", expiresInDays: 36500 });
    assert.equal(tooLong.status, 400, "no credential minted by this API may outlive a year");

    // The boundary itself must still work.
    const atCap = await mintJson(base, cookie, { label: "year", expiresInDays: 365 });
    assert.ok(typeof atCap.token === "string" && atCap.token.length > 0);
  });
});

test("a bearer token reads, and skips CSRF; a session still needs it", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const { token } = await mintJson(base, cookie, { label: "agent", expiresInDays: 1 });

    const ok = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ q: "budget" }),
    });
    assert.equal(ok.status, 200, "a bearer token carries no ambient authority, so CSRF does not apply");

    const bad = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ q: "budget" }),
    });
    assert.equal(bad.status, 403, "a session without the CSRF header is still refused");
  });
});

test("A TOKEN CANNOT MINT ANOTHER TOKEN", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const { token } = await mintJson(base, cookie, { label: "agent", expiresInDays: 1 });

    const res = await fetch(`${base}/api/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "escalate", scope: "write", expiresInDays: 1 }),
    });
    assert.equal(res.status, 403);
  });
});

test("a token cannot list or revoke tokens either", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const minted = await mintJson(base, cookie, { label: "agent", expiresInDays: 1 });

    const list = await fetch(`${base}/api/tokens`, {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    assert.equal(list.status, 403);

    const del = await fetch(`${base}/api/tokens/${minted.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${minted.token}` },
    });
    assert.equal(del.status, 403);
  });
});

test("an expired token is refused", async () => {
  await withApp(async (base, db) => {
    const cookie = await login(base);
    const { token } = await mintJson(base, cookie, { label: "old", expiresInDays: 1 });
    db.exec("UPDATE api_tokens SET expires_at = '2020-01-01T00:00:00Z'");

    const res = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ q: "budget" }),
    });
    assert.equal(res.status, 401);
  });
});

test("a revoked token stops working immediately", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const minted = await mintJson(base, cookie, { label: "gone", expiresInDays: 1 });

    const del = await fetch(`${base}/api/tokens/${minted.id}`, {
      method: "DELETE",
      headers: { cookie, "x-wilco-csrf": "1", origin: ORIGIN },
    });
    assert.equal(del.status, 200);

    const res = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
      body: JSON.stringify({ q: "budget" }),
    });
    assert.equal(res.status, 401);
  });
});

test("an unknown or garbage bearer token is rejected", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
      body: JSON.stringify({ q: "budget" }),
    });
    assert.equal(res.status, 401);
  });
});

test("a read-scope token cannot perform a write (saved-searches POST)", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const { token } = await mintJson(base, cookie, { label: "reader", expiresInDays: 1 });

    const res = await fetch(`${base}/api/saved-searches`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", query: "foo" }),
    });
    assert.equal(res.status, 403, "a read-scope token must not be able to write");
  });
});

test("a write-scope token can perform a write (saved-searches POST)", async () => {
  await withApp(async (base) => {
    const cookie = await login(base);
    const { token } = await mintJson(base, cookie, { label: "writer", expiresInDays: 1, scope: "write" });

    const res = await fetch(`${base}/api/saved-searches`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", query: "foo" }),
    });
    assert.equal(res.status, 201);
  });
});

test("last_used is updated on use, and not bumped again within a minute", async () => {
  await withApp(async (base, db) => {
    const cookie = await login(base);
    const minted = await mintJson(base, cookie, { label: "agent", expiresInDays: 1 });

    await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
      body: JSON.stringify({ q: "budget" }),
    });
    const row1 = db.prepare("SELECT last_used FROM api_tokens WHERE id = ?").get(minted.id) as {
      last_used: string | null;
    };
    assert.ok(row1.last_used, "last_used must be set after first use");

    await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
      body: JSON.stringify({ q: "budget" }),
    });
    const row2 = db.prepare("SELECT last_used FROM api_tokens WHERE id = ?").get(minted.id) as {
      last_used: string | null;
    };
    assert.equal(row2.last_used, row1.last_used, "must not be bumped again within a minute");
  });
});
