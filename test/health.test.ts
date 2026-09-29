import { test } from "node:test";
import assert from "node:assert/strict";
import { accountHealth, STALE_AFTER_MS } from "../src/server/health.ts";
import { openDb } from "../src/core/db.ts";
import { setSyncState, recordSync } from "../src/core/mutations.ts";
import type { AccountSpec } from "../src/core/accounts.ts";
import { tempDbPath } from "./tmpdir.ts";

/**
 * The first walk of a large mailbox (2026-09-22: 167,000 messages) is hours
 * of healthy work during which `walk` is not "done" and, until the walk
 * finishes, `recordSync` has never run -- so the old report called such an
 * account stale AND not ok, and the monitor was red for the whole of a
 * perfectly good sync. Progress, not completion, is what distinguishes the
 * two states, and the supervisor's progressAt map is what carries it.
 */
const ACCOUNTS: AccountSpec[] = [
  { key: "personal", label: "Personal", accent: "blue", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
];
const OK = new Map(ACCOUNTS.map((a) => [a.key, { kind: "ok" as const }]));

test("a first walk that is MOVING reports syncing, not stale", () => {
  const d = openDb(tempDbPath());
  const now = Date.now();
  setSyncState(d, "personal", "email", "J1");   // the cursor is captured on page 1
  // No `walk: done`, and no recordSync: a pass has never COMPLETED.
  const progressAt = new Map([["personal", now - 60_000]]);

  const report = accountHealth(d, ACCOUNTS, OK, { now: () => now, progressAt });
  const a = report.accounts[0]!;
  assert.equal(a.walkComplete, false);
  assert.equal(a.syncing, true, "a walk that stored a batch a minute ago is syncing");
  assert.equal(a.stale, false, "a syncing account is not stale");
  assert.equal(report.ok, true, "a first walk in progress is not a fault");
  d.close();
});

test("a first walk that has gone SILENT is stale and not ok", () => {
  const d = openDb(tempDbPath());
  const now = Date.now();
  setSyncState(d, "personal", "email", "J1");
  const progressAt = new Map([["personal", now - (STALE_AFTER_MS + 60_000)]]);

  const report = accountHealth(d, ACCOUNTS, OK, { now: () => now, progressAt });
  const a = report.accounts[0]!;
  assert.equal(a.syncing, false, "no progress for longer than staleAfter is not syncing");
  assert.equal(a.stale, true);
  assert.equal(report.ok, false);
  d.close();
});

test("a FAILING account is never reported as syncing, however recent its last tick", () => {
  // Otherwise an account that ticked once and then threw would hide behind
  // `syncing` -- the state the watchdog sets on an abandoned pass is set
  // AFTER that pass's last tick, and the abandoned pass goes on running and
  // may tick again.
  const d = openDb(tempDbPath());
  const now = Date.now();
  setSyncState(d, "personal", "email", "J1");
  const states = new Map([["personal", { kind: "network" as const, message: "no progress for 20 minutes; the pass was abandoned" }]]);

  const report = accountHealth(d, ACCOUNTS, states, { now: () => now, progressAt: new Map([["personal", now]]) });
  const a = report.accounts[0]!;
  assert.equal(a.syncing, false);
  assert.equal(a.stale, true);
  assert.equal(report.ok, false);
  d.close();
});

test("a completed account is unaffected by progressAt", () => {
  const d = openDb(tempDbPath());
  const now = Date.now();
  setSyncState(d, "personal", "email", "J1");
  setSyncState(d, "personal", "walk", "done");
  recordSync(d, "personal", now);

  const report = accountHealth(d, ACCOUNTS, OK, { now: () => now, progressAt: new Map() });
  const a = report.accounts[0]!;
  assert.equal(a.walkComplete, true);
  assert.equal(a.syncing, false, "a finished walk is not syncing, it is synced");
  assert.equal(a.stale, false);
  assert.equal(report.ok, true);
  d.close();
});

test("a stopped sync loop on a COMPLETED account still goes stale (the endpoint's original job)", () => {
  const d = openDb(tempDbPath());
  const now = Date.now();
  setSyncState(d, "personal", "email", "J1");
  setSyncState(d, "personal", "walk", "done");
  recordSync(d, "personal", now - (STALE_AFTER_MS + 60_000));

  // Even with a recent tick: `syncing` is about a walk in progress, and this
  // walk finished -- a completed account that has not SYNCED in 16 minutes is
  // exactly what STALE_AFTER_MS exists to report.
  const report = accountHealth(d, ACCOUNTS, OK, { now: () => now, progressAt: new Map([["personal", now]]) });
  assert.equal(report.accounts[0]!.stale, true);
  assert.equal(report.ok, false);
  d.close();
});

test("with no progressAt at all, nothing is syncing and the old behaviour stands", () => {
  const d = openDb(tempDbPath());
  const now = Date.now();
  setSyncState(d, "personal", "email", "J1");

  const report = accountHealth(d, ACCOUNTS, OK, { now: () => now });
  const a = report.accounts[0]!;
  assert.equal(a.syncing, false);
  assert.equal(a.stale, true, "never synced is stale");
  assert.equal(report.ok, false);
  d.close();
});
