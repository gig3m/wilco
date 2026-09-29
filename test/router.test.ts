import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Router, json } from "../src/server/router.ts";
import { readJson } from "../src/server/body.ts";
import { accountHealth, STALE_AFTER_MS } from "../src/server/health.ts";
import { openDb } from "../src/core/db.ts";
import { setSyncState, recordSync, recordDetailsFailure } from "../src/core/mutations.ts";
import type { AccountSpec } from "../src/core/accounts.ts";
import { tempDbPath } from "./tmpdir.ts";

const ACCOUNTS: AccountSpec[] = [
  { key: "personal", label: "Personal", accent: "blue", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
  { key: "work", label: "Work", accent: "green", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
  { key: "society", label: "Society", accent: "amber", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
  { key: "atelier", label: "Atelier", accent: "violet", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
];

async function withServer(router: Router, fn: (base: string) => Promise<void>) {
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("routes by method and exact path", async () => {
  const router = new Router();
  router.add("GET", "/healthz", (c) => json(c.res, 200, { ok: true }));
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("extracts path parameters", async () => {
  const router = new Router();
  router.add("GET", "/api/message/:account/:id", (c) => json(c.res, 200, c.params));
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/api/message/personal/M-123`);
    assert.deepEqual(await res.json(), { account: "personal", id: "M-123" });
  });
});

test("an unknown path is 404, an unknown method on a known path is 405", async () => {
  const router = new Router();
  router.add("GET", "/thing", (c) => json(c.res, 200, {}));
  await withServer(router, async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/thing`, { method: "POST" })).status, 405);
  });
});

test("a handler that throws becomes a 500 without leaking the message", async () => {
  const router = new Router();
  router.add("GET", "/boom", () => {
    throw new Error("secret-internal-detail");
  });
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes("secret-internal-detail"));
  });
});

test("a body over the readJson cap is a 413, not a 500 (fix wave, finding 6)", async () => {
  const router = new Router();
  router.add("POST", "/echo", async (c) => {
    const body = await readJson(c.req);
    json(c.res, 200, body);
  });
  await withServer(router, async (base) => {
    const oversized = "x".repeat(64 * 1024 + 1);
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: oversized }),
    });
    assert.equal(res.status, 413, "a client fault must not be reported as a server fault");
    const payload = await res.json();
    assert.ok(!JSON.stringify(payload).includes(oversized), "the oversized value must not be echoed back");
  });
});

test("a malformed percent-escape is a 400, not a crash", async () => {
  const router = new Router();
  router.add("GET", "/api/message/:account/:id", (c) => json(c.res, 200, c.params));
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/api/message/personal/%ZZ`);
    assert.equal(res.status, 400);
  });
});

test("the server survives a malformed percent-escape and serves the next request", async () => {
  const router = new Router();
  router.add("GET", "/api/message/:account/:id", (c) => json(c.res, 200, c.params));
  await withServer(router, async (base) => {
    const bad = await fetch(`${base}/api/message/personal/%ZZ`);
    assert.equal(bad.status, 400);

    // The point of this test: prove the PROCESS lived, not merely that one
    // request got a 400. A handler that answered 400 and then died would
    // also pass the assertion above -- this second request is what catches
    // that case, because it can only succeed if handle() returned normally.
    const ok = await fetch(`${base}/api/message/personal/M-123`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { account: "personal", id: "M-123" });
  });
});

test("AN EMPTY ACCOUNT LIST IS NOT OK -- [].every() is not health", () => {
  // The live accounts table is empty before Task 8 seeds it, and
  // Deps.accounts defaults to [] for a caller that forgets to pass any.
  // Array.prototype.every() on an empty list is vacuously true, so without
  // an explicit guard this reports 200 {ok:true, accounts:[]} while nothing
  // syncs anything -- a wiring mistake or an unseeded box would look
  // healthy to Uptime Kuma forever.
  const d = openDb(tempDbPath());
  const report = accountHealth(d, [], new Map());
  assert.equal(report.ok, false, "zero accounts must never look healthy");
  assert.deepEqual(report.accounts, []);
  assert.match(report.error ?? "", /no accounts configured/);
  d.close();
});

test("health reports every account, not an aggregate", () => {
  const d = openDb(tempDbPath());
  for (const a of ACCOUNTS) {
    setSyncState(d, a.key, "email", "J1");
    setSyncState(d, a.key, "walk", "done");
    recordSync(d, a.key, Date.now());
  }
  const report = accountHealth(d, ACCOUNTS, new Map(ACCOUNTS.map((a) => [a.key, { kind: "ok" as const }])));
  assert.equal(report.accounts.length, 4);
  assert.equal(report.ok, true);
  d.close();
});

test("a details-backfill failure is surfaced in /healthz without flipping ok (review fix, Important 1)", () => {
  const d = openDb(tempDbPath());
  for (const a of ACCOUNTS) {
    setSyncState(d, a.key, "email", "J1");
    setSyncState(d, a.key, "walk", "done");
    recordSync(d, a.key, Date.now());
  }
  recordDetailsFailure(d, ACCOUNTS[0]!.key);
  recordDetailsFailure(d, ACCOUNTS[0]!.key);

  const report = accountHealth(d, ACCOUNTS, new Map(ACCOUNTS.map((a) => [a.key, { kind: "ok" as const }])));
  assert.equal(report.ok, true, "a details-backfill failure is enrichment, not sync -- it must not flip ok");
  const flaky = report.accounts.find((a) => a.account === ACCOUNTS[0]!.key)!;
  assert.equal(flaky.detailsBackfillFailures, 2);
  const healthy = report.accounts.find((a) => a.account === ACCOUNTS[1]!.key)!;
  assert.equal(healthy.detailsBackfillFailures, 0);
  d.close();
});

test("health is not ok when any single account has failed", () => {
  const d = openDb(tempDbPath());
  const states = new Map(ACCOUNTS.map((a) => [a.key, { kind: "ok" as const }]));
  states.set(ACCOUNTS[1]!.key, { kind: "auth", message: "authentication was refused" } as any);
  const report = accountHealth(d, ACCOUNTS, states as any);
  assert.equal(report.ok, false, "a mail client with one dead account is not healthy");
  const bad = report.accounts.find((a) => a.account === ACCOUNTS[1]!.key)!;
  assert.equal(bad.state, "auth");
  d.close();
});

test("an account that has not synced within the window is STALE and not ok", () => {
  // A mail client whose sync loop has silently stopped must not look healthy.
  const d = openDb(tempDbPath());
  const states = new Map(ACCOUNTS.map((a) => [a.key, { kind: "ok" as const }]));
  for (const a of ACCOUNTS) {
    setSyncState(d, a.key, "email", "J1");
    setSyncState(d, a.key, "walk", "done");
    recordSync(d, a.key, 0);
  }

  const fresh = accountHealth(d, ACCOUNTS, states, { now: () => STALE_AFTER_MS - 1 });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.accounts.every((a) => a.stale === false), true);

  const stale = accountHealth(d, ACCOUNTS, states, { now: () => STALE_AFTER_MS + 1 });
  assert.equal(stale.ok, false, "a stale sync loop must make health not-ok");
  assert.equal(stale.accounts.every((a) => a.stale === true), true);
  d.close();
});

test("an account that has never synced is stale, not silently fine", () => {
  const d = openDb(tempDbPath());
  const states = new Map(ACCOUNTS.map((a) => [a.key, { kind: "ok" as const }]));
  const r = accountHealth(d, ACCOUNTS, states, { now: () => 1_000_000 });
  assert.equal(r.ok, false);
  assert.equal(r.accounts[0]!.lastSyncAt, null);
  d.close();
});

test("a FAILED WALK is not healthy, however fresh the sync loop looks", () => {
  // C4: ruling G16 stopped the startup walk writing `states`, so a walk that
  // died on its progress guard left nothing but a console.error while
  // /healthz reported ok.
  const d = openDb(tempDbPath());
  const states = new Map(ACCOUNTS.map((a) => [a.key, { kind: "ok" as const }]));
  for (const a of ACCOUNTS) {
    setSyncState(d, a.key, "email", "J1");
    setSyncState(d, a.key, "walk", "M42|900");   // mid-walk, not 'done'
    recordSync(d, a.key, 1000);
  }
  const r = accountHealth(d, ACCOUNTS, states, { now: () => 1000 });
  assert.equal(r.ok, false, "an incomplete archive walk must not report healthy");
  assert.equal(r.accounts.every((a) => a.walkComplete === false), true);
  d.close();
});

test("a MISSING EMAIL CURSOR is not healthy, even though every pass 'succeeds'", () => {
  // fetchChanges returns an empty SUCCESSFUL ChangeSet when since === null,
  // so such an account records liveness on every pass while syncing nothing.
  const d = openDb(tempDbPath());
  const states = new Map(ACCOUNTS.map((a) => [a.key, { kind: "ok" as const }]));
  for (const a of ACCOUNTS) {
    setSyncState(d, a.key, "walk", "done");
    recordSync(d, a.key, 1000);
  }
  const r = accountHealth(d, ACCOUNTS, states, { now: () => 1000 });
  assert.equal(r.ok, false, "no Email/changes cursor means nothing is syncing");
  assert.equal(r.accounts.every((a) => a.hasEmailCursor === false), true);
  d.close();
});
