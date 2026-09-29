// test/auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import {
  hashPassword,
  verifyPassword,
  createSession,
  validateSession,
  destroySession,
  sessionCookie,
  readCookie,
  checkCsrf,
  RateLimiter,
  authenticate,
  hasScope,
  type Principal,
} from "../src/server/auth.ts";
import { createHash, randomBytes } from "node:crypto";
import { tempDbPath } from "./tmpdir.ts";

function db() {
  return openDb(tempDbPath());
}

test("a password verifies against its own hash and nothing else", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
});

test("the same password hashes differently each time (salted)", async () => {
  const a = await hashPassword("same");
  const b = await hashPassword("same");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same", b), true);
});

test("the stored hash contains no plaintext", async () => {
  const stored = await hashPassword("hunter2");
  assert.ok(!stored.includes("hunter2"));
});

test("verifyPassword returns false, not a throw, for a malformed stored hash", async () => {
  await assert.doesNotReject(async () => {
    assert.equal(await verifyPassword("x", ""), false);
    assert.equal(await verifyPassword("x", "not-a-hash"), false);
    assert.equal(await verifyPassword("x", "bcrypt$abc$def"), false);
    assert.equal(await verifyPassword("x", "scrypt$not-base64!!$def"), false);
    assert.equal(await verifyPassword("x", "scrypt$onlyonepart"), false);
  });
});

test("a session round-trips and can be destroyed", () => {
  const d = db();
  const id = createSession(d);
  assert.equal(validateSession(d, id), true);
  destroySession(d, id);
  assert.equal(validateSession(d, id), false);
  d.close();
});

test("an expired session is rejected AND swept from the table", () => {
  // 🚨 Audit pass 8 (T8). The assertion used to be the
  // return value alone -- and `validateSession` returns false from the date
  // check BEFORE it calls `destroySession`, so deleting that call left this
  // test green. The behaviour under test was the side effect and nothing
  // looked at it.
  //
  // It matters because nothing else prunes `sessions`: there is no
  // scheduled sweep, so expiry-on-read is the ONLY thing that ever removes
  // a row. Without it the table grows without bound and every expired
  // session id stays on disk in a database that is already restricted to
  // local-tier backup for being credential-bearing.
  const d = db();
  const id = createSession(d, -1000); // already expired
  assert.equal(validateSession(d, id), false);
  assert.equal(
    d.prepare(`SELECT count(*) AS n FROM sessions WHERE id = ?`).get(id)!.n,
    0,
    "the expired row survived the read that rejected it -- nothing else ever prunes sessions",
  );
  d.close();
});

test("a LIVE session is not swept by the same path", () => {
  // The other direction, so the sweep above cannot be satisfied by deleting
  // every row it touches.
  const d = db();
  const id = createSession(d);
  assert.equal(validateSession(d, id), true);
  assert.equal(d.prepare(`SELECT count(*) AS n FROM sessions WHERE id = ?`).get(id)!.n, 1);
  d.close();
});

test("an unknown session id is rejected", () => {
  const d = db();
  assert.equal(validateSession(d, "made-up"), false);
  d.close();
});

test("the cookie is HttpOnly, Secure, SameSite=Lax and host-only", () => {
  const c = sessionCookie("abc", 3600);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.ok(!/Domain=/i.test(c), "a Domain cookie would be sent to every example.com service");
});

test("reads one cookie out of a header without matching a prefix", () => {
  assert.equal(readCookie("other=1; wilco_session=abc; x=2", "wilco_session"), "abc");
  assert.equal(readCookie("wilco_session_other=zzz", "wilco_session"), null);
  assert.equal(readCookie("", "wilco_session"), null);
});

test("CSRF requires both the custom header and an exact Origin", () => {
  const origin = "https://mail.example.com";
  const ok = { method: "POST", headers: { origin, "x-wilco-csrf": "1" } } as any;
  assert.equal(checkCsrf(ok, origin), true);

  // SameSite=Lax buys nothing here: every example.com service is same-site.
  assert.equal(
    checkCsrf({ method: "POST", headers: { origin: "https://frame.example.com", "x-wilco-csrf": "1" } } as any, origin),
    false,
  );
  assert.equal(checkCsrf({ method: "POST", headers: { origin } } as any, origin), false);
});

test("GET is not subject to the CSRF check", () => {
  assert.equal(checkCsrf({ method: "GET", headers: {} } as any, "https://mail.example.com"), true);
});

test("the rate limiter blocks after the burst and recovers", () => {
  const rl = new RateLimiter({ limit: 3, windowMs: 1000, now: fakeClock() });
  for (let i = 0; i < 3; i += 1) assert.equal(rl.allow("1.2.3.4"), true);
  assert.equal(rl.allow("1.2.3.4"), false, "scrypt on an open endpoint is a CPU lever");
  assert.equal(rl.allow("5.6.7.8"), true, "a different client is unaffected");
});

test("the rate limiter prunes idle keys instead of retaining them forever", () => {
  let t = 0;
  const clock = () => t;
  const rl = new RateLimiter({ limit: 3, windowMs: 1000, now: clock });

  assert.equal(rl.allow("1.2.3.4"), true);
  t = 5000; // well outside the 1000ms window -- "1.2.3.4" is now idle
  assert.equal(rl.allow("5.6.7.8"), true);

  const hits = (rl as unknown as { hits: Map<string, number[]> }).hits;
  assert.equal(hits.has("1.2.3.4"), false, "an idle key must be pruned, not retained forever");
  assert.equal(hits.has("5.6.7.8"), true);
});

function fakeClock() {
  let t = 0;
  return () => (t += 1);
}

function insertToken(
  d: ReturnType<typeof db>,
  o: { id: string; label?: string; scope?: "read" | "write"; expiresInMs?: number; token?: string; lastUsed?: string | null },
): string {
  const token = o.token ?? randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  d.prepare(
    `INSERT INTO api_tokens (id, label, hash, scope, created_at, expires_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id,
    o.label ?? "test",
    hash,
    o.scope ?? "read",
    new Date(now).toISOString(),
    new Date(now + (o.expiresInMs ?? 60_000)).toISOString(),
    o.lastUsed ?? null,
  );
  return token;
}

function reqWithAuth(header: string | undefined): any {
  return { headers: header !== undefined ? { authorization: header } : {} };
}

test("authenticate returns a session Principal for a valid cookie", () => {
  const d = db();
  const id = createSession(d);
  const p = authenticate(d, { headers: { cookie: `wilco_session=${id}` } } as any);
  assert.deepEqual(p, { kind: "session", scope: "write" });
  d.close();
});

test("authenticate returns null for no cookie, no header", () => {
  const d = db();
  const p = authenticate(d, { headers: {} } as any);
  assert.equal(p, null);
  d.close();
});

test("authenticate returns a token Principal for a valid bearer token", () => {
  const d = db();
  const token = insertToken(d, { id: "t1", scope: "read" });
  const p = authenticate(d, reqWithAuth(`Bearer ${token}`));
  assert.deepEqual(p, { kind: "token", scope: "read", tokenId: "t1" });
  d.close();
});

test("authenticate rejects an unknown bearer token", () => {
  const d = db();
  const p = authenticate(d, reqWithAuth("Bearer totally-made-up"));
  assert.equal(p, null);
  d.close();
});

test("authenticate rejects an expired bearer token", () => {
  const d = db();
  const token = insertToken(d, { id: "t2", expiresInMs: -1000 });
  const p = authenticate(d, reqWithAuth(`Bearer ${token}`));
  assert.equal(p, null);
  d.close();
});

test("authenticate never mistakes a token for a session or vice versa", () => {
  const d = db();
  const id = createSession(d);
  const token = insertToken(d, { id: "t3" });
  assert.equal(authenticate(d, reqWithAuth(`Bearer ${id}`)), null);
  const p = authenticate(d, { headers: { cookie: `wilco_session=${token}` } } as any);
  assert.equal(p, null);
  d.close();
});

test("hasScope: a session Principal satisfies both read and write", () => {
  const p: Principal = { kind: "session", scope: "write" };
  assert.equal(hasScope(p, "read"), true);
  assert.equal(hasScope(p, "write"), true);
});

test("hasScope: a read-scope token satisfies read but not write", () => {
  const p: Principal = { kind: "token", scope: "read", tokenId: "x" };
  assert.equal(hasScope(p, "read"), true);
  assert.equal(hasScope(p, "write"), false);
});

test("hasScope: a write-scope token satisfies both", () => {
  const p: Principal = { kind: "token", scope: "write", tokenId: "x" };
  assert.equal(hasScope(p, "read"), true);
  assert.equal(hasScope(p, "write"), true);
});

test("last_used is set on first use (no prior last_used)", () => {
  const d = db();
  const token = insertToken(d, { id: "t4" });
  authenticate(d, reqWithAuth(`Bearer ${token}`));
  const row = d.prepare("SELECT last_used FROM api_tokens WHERE id = ?").get("t4") as {
    last_used: string | null;
  };
  assert.ok(row.last_used);
  d.close();
});

// Fix round 1 (post-review): calling authenticate() twice back-to-back and
// asserting the two `last_used` values are EQUAL does not actually pin
// throttling -- millisecond-resolution ISO timestamps make it very likely
// an UNTHROTTLED implementation produces the identical string on a fast
// in-process call too, so that shape of test can pass against a broken
// implementation. Seeding a known, already-recent `last_used` and asserting
// it is untouched (below) can only pass if the throttle window is actually
// being honored; seeding a known-stale one and asserting it DOES change
// (further below) rules out the opposite bug -- a throttle that never
// releases. tokens-api.test.ts's HTTP-level test covers the same behavior
// through real requests.
test("last_used is NOT bumped again within the throttle window", () => {
  const d = db();
  const recent = new Date(Date.now() - 5_000).toISOString(); // 5s ago, well inside the 60s window
  const token = insertToken(d, { id: "t5", lastUsed: recent });
  authenticate(d, reqWithAuth(`Bearer ${token}`));
  const row = d.prepare("SELECT last_used FROM api_tokens WHERE id = ?").get("t5") as {
    last_used: string | null;
  };
  assert.equal(row.last_used, recent, "a use within the throttle window must not update last_used");
  d.close();
});

test("last_used IS bumped once the throttle window has passed", () => {
  const d = db();
  const stale = new Date(Date.now() - 120_000).toISOString(); // 2 minutes ago
  const token = insertToken(d, { id: "t6", lastUsed: stale });
  authenticate(d, reqWithAuth(`Bearer ${token}`));
  const row = d.prepare("SELECT last_used FROM api_tokens WHERE id = ?").get("t6") as {
    last_used: string | null;
  };
  assert.notEqual(row.last_used, stale, "a use after the throttle window must update last_used");
  d.close();
});

test("the Bearer scheme matches case-insensitively; the token itself does not", () => {
  const d = db();
  const token = insertToken(d, { id: "t7" });
  assert.deepEqual(authenticate(d, reqWithAuth(`bearer ${token}`)), {
    kind: "token",
    scope: "read",
    tokenId: "t7",
  });
  assert.deepEqual(authenticate(d, reqWithAuth(`BEARER ${token}`)), {
    kind: "token",
    scope: "read",
    tokenId: "t7",
  });
  d.close();
});

// Fix round 1: pins the "hard failure, no fallback to the cookie" decision
// documented on authenticate() -- a malformed Authorization header must
// refuse the request outright, never silently authenticate the caller via
// whatever session cookie happens to also be present. Without a test, a
// future refactor to `?? cookie` would silently reopen this.
test("a malformed Authorization header hard-fails rather than falling through to a valid session cookie", () => {
  const d = db();
  const id = createSession(d);
  const withCookie = (authorization: string) =>
    ({ headers: { cookie: `wilco_session=${id}`, authorization } }) as any;

  assert.equal(authenticate(d, withCookie("")), null, "an empty Authorization header must hard-fail");
  assert.equal(
    authenticate(d, withCookie("Basic dXNlcjpwYXNz")),
    null,
    "a non-Bearer scheme must hard-fail",
  );
  assert.equal(authenticate(d, withCookie("Bearer")), null, "'Bearer' with no token must hard-fail");
  assert.equal(authenticate(d, withCookie("Bearer ")), null, "'Bearer ' with no token must hard-fail");

  // Sanity check: the SAME cookie, with no Authorization header at all,
  // does authenticate -- proving the failures above are about the header's
  // presence-but-malformedness, not some unrelated problem with the cookie.
  assert.deepEqual(authenticate(d, { headers: { cookie: `wilco_session=${id}` } } as any), {
    kind: "session",
    scope: "write",
  });
  d.close();
});
