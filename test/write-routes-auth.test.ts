/**
 * The guards on every MUTATING route, exercised through a real HTTP server.
 *
 * 🚨 Audit pass 8 (T2): before this file, `grep -rn 'api/triage\|api/send'
 * test/*.test.ts` returned NOTHING. Seven routes and 1,044 lines across
 * `triage-api.ts` and `send-api.ts` — the entire write surface, the only
 * code in this project that can move a person's mail or send email as them —
 * and no test dispatched to any of them.
 *
 * One layer either side was well covered and gave the appearance of
 * coverage: `triage.test.ts` tests core's pure planning, `send-api.test.ts`
 * tests three exported helpers. Neither reaches a handler, so neither
 * notices if the handler stops checking who is asking.
 *
 * These are the mutations that left the whole suite green:
 *
 *   - Delete `checkCsrf` (triage-api.ts:158). Any same-site page on
 *     `example.com` — a home-automation panel, a DNS dashboard, any one of them unauthenticated —
 *     could then trash mail with a form POST.
 *   - Delete `hasScope(principal, "write")` (:159). A READ-scope bearer
 *     token could move mail and send email. `tokens-api.test.ts:270` proves
 *     a read token cannot POST a saved SEARCH; nothing covered the routes
 *     where it matters.
 *
 * The guards run before any JMAP client is needed, so an empty `clients`
 * map is enough: a request that gets past them fails later for a different
 * reason, and every assertion here is about the guard, not the outcome.
 */
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

async function withApp(fn: (base: string, db: DatabaseSync) => Promise<void>): Promise<void> {
  const db = openDb(tempDbPath());
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

async function mintReadToken(base: string, cookie: string): Promise<string> {
  const res = await fetch(`${base}/api/tokens`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
    body: JSON.stringify({ label: "reader", expiresInDays: 1 }),
  });
  assert.equal(res.status, 201, "could not mint a read token");
  return ((await res.json()) as { token: string }).token;
}

/** Every route that can change or send mail, with a minimal valid-shaped
 *  body. The bodies do not have to succeed — each assertion below is about
 *  a guard that runs before the body is even parsed. */
const WRITE_ROUTES: { method: string; path: string; body: unknown }[] = [
  { method: "POST", path: "/api/triage", body: { action: { kind: "read", value: true }, targets: [] } },
  { method: "POST", path: "/api/triage/undo", body: { undoId: "nope" } },
  { method: "POST", path: "/api/send", body: { account: "personal", to: [], subject: "", body: "" } },
  { method: "POST", path: "/api/drafts", body: { account: "personal", subject: "", body: "" } },
  { method: "PUT", path: "/api/identities/personal/i1/signature", body: { textSignature: "x" } },
];

test("🚨 EVERY WRITE ROUTE REFUSES AN ANONYMOUS CALLER", async () => {
  await withApp(async (base) => {
    for (const r of WRITE_ROUTES) {
      const res = await fetch(`${base}${r.path}`, {
        method: r.method,
        headers: { "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
        body: JSON.stringify(r.body),
      });
      assert.equal(res.status, 401, `${r.method} ${r.path} served an anonymous caller`);
    }
  });
});

test("🚨 EVERY WRITE ROUTE REFUSES A READ-SCOPE BEARER TOKEN", async () => {
  // The consequence if this stops holding: a token minted for an agent to
  // READ mail can move it and send email as its owner. Scope defaults to
  // read precisely so that is the safe direction to get wrong.
  await withApp(async (base) => {
    const cookie = await login(base);
    const token = await mintReadToken(base, cookie);

    for (const r of WRITE_ROUTES) {
      const res = await fetch(`${base}${r.path}`, {
        method: r.method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          // 🚨 The CSRF header and origin are sent DELIBERATELY, so this
          // request satisfies every guard except the scope check. Without
          // them the request 403s from `checkCsrf` instead, and the
          // assertion passes whether or not `hasScope` is there at all --
          // which is exactly what the first version of this test did, and
          // it is the same shape-not-behaviour defect audit pass 8 exists
          // to find. Proven: deleting `hasScope` now fails this test.
          origin: ORIGIN,
          "x-wilco-csrf": "1",
        },
        body: JSON.stringify(r.body),
      });
      assert.equal(res.status, 403, `${r.method} ${r.path} accepted a READ-scope token`);
      assert.match(
        JSON.stringify(await res.json()),
        /scope/i,
        `${r.method} ${r.path} refused the read token for the wrong reason -- the scope check may be gone`,
      );
    }
  });
});

test("🚨 EVERY WRITE ROUTE REQUIRES THE CSRF HEADER AND AN EXACT ORIGIN", async () => {
  // Without this a form POST from ANY same-site page can trash mail —
  // iot.example.com, dns.example.com, any other subdomain, none of which
  // authenticate anyone. A session cookie rides along automatically; the
  // header and the origin are what a cross-page form cannot forge.
  await withApp(async (base) => {
    const cookie = await login(base);

    for (const r of WRITE_ROUTES) {
      const noHeader = await fetch(`${base}${r.path}`, {
        method: r.method,
        headers: { cookie, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(r.body),
      });
      assert.equal(noHeader.status, 403, `${r.method} ${r.path} accepted a request with no CSRF header`);

      const wrongOrigin = await fetch(`${base}${r.path}`, {
        method: r.method,
        headers: { cookie, "content-type": "application/json", origin: "https://evil.example", "x-wilco-csrf": "1" },
        body: JSON.stringify(r.body),
      });
      assert.equal(wrongOrigin.status, 403, `${r.method} ${r.path} accepted a foreign origin`);
    }
  });
});

test("a session WITH the CSRF header gets past the guards", async () => {
  // The negative tests above are only meaningful if the positive path
  // reaches the handler. A 4xx here that is NOT 401/403 is the handler
  // rejecting the payload, which is exactly what should happen with no
  // account connected — the point is that authentication stopped being the
  // reason.
  await withApp(async (base) => {
    const cookie = await login(base);
    const res = await fetch(`${base}/api/triage`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN, "x-wilco-csrf": "1" },
      body: JSON.stringify({ action: { kind: "read", value: true }, targets: [] }),
    });
    assert.notEqual(res.status, 401, "a live session was treated as anonymous");
    assert.notEqual(res.status, 403, "a live session with the CSRF header was refused");
  });
});
