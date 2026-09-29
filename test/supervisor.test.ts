import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../src/core/db.ts";
import { setSyncState, lastSyncAt, storeEmails, detailsFailureCount } from "../src/core/mutations.ts";
import { startSupervisor, SAFETY_POLL_MS } from "../src/server/supervisor.ts";
import { JmapClient } from "../src/core/client.ts";
import { walkArchive } from "../src/core/corpus.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import type { AccountState } from "../src/server/health.ts";
import type { AccountSpec } from "../src/core/accounts.ts";
import { tempDbPath } from "./tmpdir.ts";

const session = resolveSession("personal", personalSession);

const TEST_ACCOUNTS: AccountSpec[] = [
  { key: "personal", label: "Personal", accent: "blue", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
  { key: "work", label: "Work", accent: "green", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
];
function db() { return openDb(tempDbPath()); }
function json(b: unknown) { return new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }); }

/**
 * `detailsGet` answers the ONE call the generic fallback below cannot
 * safely stand in for (review fix, Important 1): a real Email/get for
 * `backfillDetails`' detail properties, distinguished from a body-fetch
 * Email/get by the presence of "attachments" in `properties`. Teaching the
 * fake this shape -- rather than letting it fall through to a
 * whole-batch-empty response, which (correctly) trips backfillDetails'
 * progress guard -- is what stops the test double from silently dictating
 * "swallow every details-backfill error" as production policy.
 */
function quietClient(
  onCall?: (name: string) => void,
  opts: { detailsGet?: { list?: unknown[]; notFound?: string[] } } = {},
) {
  return new JmapClient(session, "t", async (_u, init) => {
    const [name, args] = JSON.parse(init.body as string).methodCalls[0];
    onCall?.(name);
    if (name === "Email/changes") {
      return json({ methodResponses: [["Email/changes", {
        oldState: args.sinceState, newState: args.sinceState, hasMoreChanges: false,
        created: [], updated: [], destroyed: [],
      }, "c0"]] });
    }
    if (name === "Email/get" && Array.isArray(args.properties) && args.properties.includes("attachments")) {
      const body = opts.detailsGet ?? { list: [], notFound: [] };
      return json({ methodResponses: [["Email/get", body, "c0"]] });
    }
    return json({ methodResponses: [["Mailbox/get", { list: [], state: "M1" }, "c0"]] });
  });
}

/** startSupervisor now REQUIRES a store (final-review fix 1) -- there is no
 *  KeysCliStore fallback to omit it into. Tests that are not exercising
 *  re-auth pass this inert one. */
const SILENT_STORE = {
  kind: "test",
  get: async () => null,
  put: async () => {},
  remove: async () => {},
};

test("the safety-net poll refreshes each account and records liveness", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  const states = new Map<string, AccountState>();
  const ac = new AbortController();
  let clock = 0;
  let polls = 0;

  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", quietClient()]]),
    tokens: new Map([["personal", "t"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => clock,
    sleep: async (ms) => { clock += ms; polls += 1; if (polls >= 2) ac.abort(); },
    startPushFn: async () => {},          // push disabled for this test
  });

  assert.equal(states.get("personal")?.kind, "ok");
  assert.ok(lastSyncAt(d, "personal") !== null, "a successful pass must record liveness");
  d.close();
});

test("ONE account failing does not stop the others", async () => {
  const d = db();
  for (const k of ["personal", "work"]) setSyncState(d, k, "email", "S0");
  const states = new Map<string, AccountState>();
  const ac = new AbortController();
  let clock = 0;

  const bad = new JmapClient(session, "t", async () => new Response("no", { status: 503 }));
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", bad], ["work", quietClient()]]),
    tokens: new Map([["personal", "t"], ["work", "t"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => clock,
    sleep: async (ms) => { clock += ms; ac.abort(); },
    startPushFn: async () => {},
  });

  assert.notEqual(states.get("personal")?.kind, "ok", "the broken account is reported");
  assert.equal(states.get("work")?.kind, "ok", "the healthy one still synced");
  assert.equal(lastSyncAt(d, "personal"), null, "a failed pass must NOT record liveness");
  d.close();
});

test("a failed pass leaves a message a human can act on", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  const states = new Map<string, AccountState>();
  const ac = new AbortController();
  const bad = new JmapClient(session, "t", async () => new Response("no", { status: 401 }));
  await startSupervisor({
    store: SILENT_STORE,
    db: d, accounts: TEST_ACCOUNTS, clients: new Map([["personal", bad]]), tokens: new Map([["personal", "t"]]),
    states, onChange: () => {}, signal: ac.signal, now: () => 0,
    sleep: async () => { ac.abort(); }, startPushFn: async () => {},
  });
  const s = states.get("personal")!;
  assert.equal(s.kind, "auth");
  assert.ok("message" in s && s.message.length > 0);
  d.close();
});

test("onChange fires when a pass actually changed something", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  const changed: string[] = [];
  const ac = new AbortController();
  const client = new JmapClient(session, "t", async (_u, init) => {
    const [name, args] = JSON.parse(init.body as string).methodCalls[0];
    if (name === "Email/changes") {
      return json({ methodResponses: [["Email/changes", {
        oldState: args.sinceState, newState: "S1", hasMoreChanges: false,
        created: ["new1"], updated: [], destroyed: [],
      }, "c0"]] });
    }
    if (name === "Email/get") {
      return json({ methodResponses: [["Email/get", { list: [{ id: "new1", receivedAt: "2026-01-01T00:00:00Z", keywords: {}, mailboxIds: {}, from: [] }] }, "c0"]] });
    }
    return json({ methodResponses: [["Mailbox/get", { list: [], state: "M1" }, "c0"]] });
  });
  await startSupervisor({
    store: SILENT_STORE,
    db: d, accounts: TEST_ACCOUNTS, clients: new Map([["personal", client]]), tokens: new Map([["personal", "t"]]),
    states: new Map(), onChange: (a) => changed.push(a), signal: ac.signal,
    now: () => 0, sleep: async () => { ac.abort(); }, startPushFn: async () => {},
  });
  assert.deepEqual(changed, ["personal"]);
  d.close();
});

test("a quiet pass does NOT notify clients", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  const changed: string[] = [];
  const ac = new AbortController();
  await startSupervisor({
    store: SILENT_STORE,
    db: d, accounts: TEST_ACCOUNTS, clients: new Map([["personal", quietClient()]]), tokens: new Map([["personal", "t"]]),
    states: new Map(), onChange: (a) => changed.push(a), signal: ac.signal,
    now: () => 0, sleep: async () => { ac.abort(); }, startPushFn: async () => {},
  });
  assert.deepEqual(changed, [], "waking every connected client for nothing is a thundering herd");
  d.close();
});

test("the poll interval is the safety net, not the primary path", () => {
  assert.equal(SAFETY_POLL_MS, 5 * 60 * 1000);
});

test("aborting mid-sleep shuts the loop down promptly, without waiting out the poll interval", async () => {
  // Deliberately uses real timers: the point is the DEFAULT sleep, which
  // every other test replaces. Docker gives a container 10s to stop, so a
  // supervisor that ignores the signal gets SIGKILLed on every restart.
  const d = db();
  const ac = new AbortController();
  const started = Date.now();
  const run = startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map(),          // no accounts: the loop goes straight to sleep
    tokens: new Map(),
    states: new Map(),
    onChange: () => {},
    signal: ac.signal,
    pollMs: 60_000,              // would hang the test for a minute if unhandled
    startPushFn: async () => {},
  });
  setTimeout(() => ac.abort(), 20);
  await run;
  assert.ok(Date.now() - started < 2000, "abort must not wait out pollMs");
  d.close();
});

test("a pass without an injected sleep is still abortable (the production wiring)", async () => {
  // main.ts never sets deps.sleep -- this is the ONE shape production
  // actually uses, and the shape every other supervisor test skips by
  // injecting its own `sleep`. Round 2 wired pass() to forward `deps.sleep`
  // (undefined here, exactly as in production) instead of the module's own
  // abort-aware local `sleep`, which silently reinstated corpus.ts's raw,
  // non-abort-aware setTimeout for backfillBodies' pacing. A rate-limited
  // pass (up to MAX_CONSECUTIVE_RATE_LIMITS retries, each waiting up to
  // retry-after) could then block shutdown for tens of seconds -- measured
  // at 21.5s against this exact scenario before the fix.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  storeEmails(d, "personal", [
    { id: "a", receivedAt: "2026-01-01T00:00:00Z", subject: "s", keywords: {}, mailboxIds: {}, from: [] },
  ]);

  const rateLimited = new JmapClient(session, "t", async (_u, init) => {
    const [name, args] = JSON.parse(init.body as string).methodCalls[0];
    if (name === "Email/changes") {
      return json({ methodResponses: [["Email/changes", {
        oldState: args.sinceState, newState: args.sinceState, hasMoreChanges: false,
        created: [], updated: [], destroyed: [],
      }, "c0"]] });
    }
    if (name === "Mailbox/get") {
      return json({ methodResponses: [["Mailbox/get", { list: [], state: "M1" }, "c0"]] });
    }
    // Email/get body fetch -- always rate-limited, so backfillBodies' own
    // pacedRequest retry-wait is what has to notice the abort.
    return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
  });

  const ac = new AbortController();
  const started = Date.now();
  const run = startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", rateLimited]]),
    tokens: new Map([["personal", "t"]]),
    states: new Map(),
    onChange: () => {},
    signal: ac.signal,
    pollMs: 60_000,
    // Deliberately NOT setting `sleep` -- see the comment above.
    startPushFn: async () => {},
  });
  setTimeout(() => ac.abort(), 50);
  await run;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `abort must not wait out a 429 retry chain; took ${elapsed}ms`);
  d.close();
});

test("overlapping passes for one account COALESCE into a single pass", async () => {
  // I3: with backfillBodies inside the pass (G13) and push finally
  // delivering (C1), unbounded overlap means N concurrent passes reading the
  // same unfetchedIds and re-fetching the same bodies.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  let changesCalls = 0;
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });
  const client = new JmapClient(session, "t", async (_u, init) => {
    const [name, args] = JSON.parse(init.body as string).methodCalls[0];
    if (name === "Email/changes") {
      changesCalls += 1;
      await gate;
      return json({ methodResponses: [["Email/changes", {
        oldState: args.sinceState, newState: args.sinceState, hasMoreChanges: false,
        created: [], updated: [], destroyed: [],
      }, "c0"]] });
    }
    return json({ methodResponses: [["Mailbox/get", { list: [], state: "M1" }, "c0"]] });
  });

  const states = new Map<string, AccountState>();
  const ac = new AbortController();
  let fire: (() => void) | undefined;
  const loop = startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", client]]),
    tokens: new Map([["personal", "t"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => 0,
    sleep: async () => { ac.abort(); },
    startPushFn: async (_s, _t, opts) => {
      // Stand in for a burst of push notifications while a pass is running.
      fire = () => { for (let i = 0; i < 10; i += 1) void opts.onStateChange("u1", {}); };
    },
  });

  await new Promise((r) => setTimeout(r, 20));
  fire?.();
  await new Promise((r) => setTimeout(r, 20));
  release();
  await loop;

  assert.ok(changesCalls <= 2,
    `a burst of notifications must coalesce, saw ${changesCalls} Email/changes calls`);
  d.close();
});

test("a pass that THROWS still clears its in-flight entry", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  let calls = 0;
  const bad = new JmapClient(session, "t", async () => {
    calls += 1;
    return new Response("no", { status: 503 });
  });
  const states = new Map<string, AccountState>();
  const ac = new AbortController();
  let polls = 0;
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", bad]]),
    tokens: new Map([["personal", "t"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => 0,
    sleep: async () => { polls += 1; if (polls >= 3) ac.abort(); },
    startPushFn: async () => {},
  });
  assert.ok(calls >= 3, `a failed pass must not wedge the account, saw ${calls} attempts`);
  d.close();
});

test("an AUTH failure re-reads the token and applies it to the client (I2)", async () => {
  // Spec 5.6/8.1. refreshToken and setToken existed and were wired to
  // nothing, so rotating the secret in `keys` changed nothing until a
  // container recreate.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const seenTokens: string[] = [];
  const client = new JmapClient(session, "old-token", async (_u, init) => {
    seenTokens.push(String((init.headers as Record<string, string>)["authorization"]));
    return new Response("no", { status: 401 });
  });

  const states = new Map<string, AccountState>();
  const ac = new AbortController();
  let polls = 0;
  let refreshes = 0;
  await startSupervisor({
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", client]]),
    tokens: new Map([["personal", "old-token"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => 0,
    sleep: async () => { polls += 1; if (polls >= 2) ac.abort(); },
    startPushFn: async () => {},
    store: { kind: "test", get: async () => { refreshes += 1; return "new-token"; }, put: async () => {}, remove: async () => {} },
  });

  assert.ok(refreshes >= 1, "an auth failure must re-read the token");
  assert.ok(seenTokens.some((t) => t.includes("new-token")),
    `the refreshed token must reach the client, saw ${JSON.stringify(seenTokens)}`);
  d.close();
});

test("an account absent from `clients` is RE-ESTABLISHED, not abandoned (I2)", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const states = new Map<string, AccountState>([
    ["personal", { kind: "auth", message: "no JMAP token available" }],
  ]);
  const ac = new AbortController();
  let polls = 0;
  let established = 0;
  await startSupervisor({
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map(),
    tokens: new Map(),
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => 0,
    sleep: async () => { polls += 1; ac.abort(); },
    startPushFn: async () => {},
    store: {
      kind: "test",
      get: async (k) => (k === "personal" ? "t" : Promise.reject(new Error("no"))),
      put: async () => {},
      remove: async () => {},
    },
    establishFn: async (k) => {
      if (k !== "personal") return undefined;
      established += 1;
      return quietClient();
    },
  });

  assert.equal(established, 1, "the boot-failed account must be retried");
  assert.equal(states.get("personal")?.kind, "ok");
  assert.ok(lastSyncAt(d, "personal") !== null, "and it must then actually sync");
  d.close();
});

test("a pass that did work LOGS it, and a quiet one does not (M2)", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const logs: string[] = [];
  const states = new Map<string, AccountState>();
  const ac = new AbortController();

  // A quiet pass: nothing changed, mailboxes already refreshed.
  setSyncState(d, "personal", "mailbox_at", String(Date.now()));
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", quietClient()]]),
    tokens: new Map([["personal", "t"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => Date.now(),
    sleep: async () => { ac.abort(); },
    startPushFn: async () => {},
    log: (m) => { logs.push(m); },
  });
  assert.equal(logs.filter((l) => l.includes("pass created=")).length, 0,
    `a quiet mailbox must stay quiet, saw ${JSON.stringify(logs)}`);
  // But the state transition to ok IS logged.
  assert.ok(logs.some((l) => l.includes("state unknown -> ok")),
    `every state transition must be logged, saw ${JSON.stringify(logs)}`);
  d.close();
});

test("a FAILING account logs its state transition once, not every pass (M2)", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const logs: string[] = [];
  const ac = new AbortController();
  let polls = 0;
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", new JmapClient(session, "t", async () => new Response("no", { status: 503 }))]]),
    tokens: new Map([["personal", "t"]]),
    states: new Map<string, AccountState>(),
    onChange: () => {},
    signal: ac.signal,
    now: () => 0,
    sleep: async () => { polls += 1; if (polls >= 3) ac.abort(); },
    startPushFn: async () => {},
    log: (m) => { logs.push(m); },
  });
  const transitions = logs.filter((l) => l.includes("state "));
  assert.equal(transitions.length, 1, `expected one transition, saw ${JSON.stringify(logs)}`);
  assert.match(transitions[0]!, /-> server/);
  d.close();
});

test("a StateChange for ANOTHER JMAP account does not fire a pass (M4)", async () => {
  // One token can see several JMAP accounts, so a frame naming a different
  // one used to fire a pass for every account on that token.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  let changes = 0;
  const client = quietClient((name) => { if (name === "Email/changes") changes += 1; });
  const ac = new AbortController();
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", client]]),
    tokens: new Map([["personal", "t"]]),
    states: new Map<string, AccountState>(),
    onChange: () => {},
    signal: ac.signal,
    now: () => 0,
    sleep: async () => { ac.abort(); },
    startPushFn: async (_s, _t, opts) => {
      // After the poll's own pass, so the two are not coalesced (I3).
      await new Promise((r) => setTimeout(r, 5));
      await opts.onStateChange("some-other-account", {});
    },
  });
  assert.equal(changes, 1, `only the poll's own pass should have run, saw ${changes}`);

  changes = 0;
  const ac2 = new AbortController();
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", client]]),
    tokens: new Map([["personal", "t"]]),
    states: new Map<string, AccountState>(),
    onChange: () => {},
    signal: ac2.signal,
    now: () => 0,
    sleep: async () => { ac2.abort(); },
    startPushFn: async (s, _t, opts) => {
      await new Promise((r) => setTimeout(r, 5));
      await opts.onStateChange(s.mailAccountId, {});
    },
  });
  assert.equal(changes, 2, "a frame naming THIS account must still fire a pass");
  d.close();
});

test("startSupervisor REFUSES a missing store rather than falling back to the keys CLI", async () => {
  // Final-review fix 1. This used to be `deps.store ?? new KeysCliStore(...)`,
  // and main() did not pass a store -- so in production the re-auth path
  // bypassed the configured CredentialStore entirely and re-read the OLD
  // value out of `keys`, silently reverting any credential rotated through
  // PUT /api/accounts/:key/credential. The type now requires it; this asserts
  // the runtime behaviour that type stripping cannot enforce.
  const d = db();
  const ac = new AbortController();
  await assert.rejects(
    () =>
      startSupervisor({
        db: d,
        accounts: TEST_ACCOUNTS,
        clients: new Map(),
        tokens: new Map(),
        states: new Map(),
        onChange: () => {},
        signal: ac.signal,
        sleep: async () => { ac.abort(); },
        startPushFn: async () => {},
      } as unknown as Parameters<typeof startSupervisor>[0]),
    /requires a CredentialStore/,
  );
  ac.abort();
  d.close();
});

test("main.ts hands the supervisor the configured store", () => {
  // The direct regression guard for the omitted argument. The seam is only
  // real if the ONE production call site actually uses it, and no unit test
  // of startSupervisor can observe main()'s wiring -- so assert on the call
  // site itself. If this ever fails, do not delete it: pass the store.
  const src = readFileSync(new URL("../src/server/main.ts", import.meta.url), "utf8");
  const at = src.indexOf("startSupervisor({");
  assert.ok(at > 0, "main.ts must still call startSupervisor");
  const call = src.slice(at, src.indexOf("})", at));
  assert.match(call, /^\s*store,\s*$/m, "main() must pass `store` to startSupervisor");
});

// -- Review fix round 1, Important 1: the detail backfill is not deaf ----

test("a pass actually details a message needing it, through a fake that answers the detail Email/get for real (review fix)", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  storeEmails(d, "personal", [
    { id: "a", receivedAt: "2026-01-01T00:00:00Z", subject: "s", keywords: {}, mailboxIds: {}, from: [] },
  ]);
  // Body already indexed -- keeps backfillBodies a no-op so only the
  // detail-Email/get path under test issues a request.
  d.prepare("UPDATE emails SET body_text = ? WHERE account='personal' AND id='a'").run("already indexed");

  const states = new Map<string, AccountState>();
  const ac = new AbortController();
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", quietClient(undefined, {
      detailsGet: {
        list: [{ id: "a", to: [{ name: "Ada", email: "ada@example.com" }], cc: [], bcc: [], replyTo: [], attachments: [] }],
      },
    })]]),
    tokens: new Map([["personal", "t"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => 0,
    sleep: async () => { ac.abort(); },
    startPushFn: async () => {},
  });

  assert.equal(states.get("personal")?.kind, "ok");
  const row = d.prepare(
    "SELECT details_at FROM emails WHERE account='personal' AND id='a'",
  ).get() as { details_at: string | null };
  assert.notEqual(row.details_at, null, "the supervisor's per-pass call actually wrote details");
  const rec = d.prepare(
    "SELECT email FROM email_recipients WHERE account='personal' AND email_id='a'",
  ).get() as { email: string };
  assert.equal(rec.email, "ada@example.com");
  assert.equal(detailsFailureCount(d, "personal"), 0);
  d.close();
});

test("a details backfill failure is counted where an operator would see it, and does not flip account state (review fix)", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  storeEmails(d, "personal", [
    { id: "a", receivedAt: "2026-01-01T00:00:00Z", subject: "s", keywords: {}, mailboxIds: {}, from: [] },
  ]);
  d.prepare("UPDATE emails SET body_text = ? WHERE account='personal' AND id='a'").run("already indexed");

  const states = new Map<string, AccountState>();
  const ac = new AbortController();
  let polls = 0;
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    // No notFound entry either -- a whole-batch-empty response with no
    // explanation, exactly what trips backfillDetails' progress guard.
    clients: new Map([["personal", quietClient(undefined, { detailsGet: { list: [], notFound: [] } })]]),
    tokens: new Map([["personal", "t"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => 0,
    sleep: async () => { polls += 1; if (polls >= 2) ac.abort(); },
    startPushFn: async () => {},
  });

  assert.equal(states.get("personal")?.kind, "ok",
    "an ancillary enrichment failure must not read as mail sync being broken");
  assert.equal(detailsFailureCount(d, "personal"), 2,
    "two passes, two recorded failures -- visible to an operator via /healthz's detailsBackfillFailures");
  d.close();
});

test("row 22: a pushed Mailbox state that differs from ours refreshes the mailbox tree NOW, not at the 10-minute cadence", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  // Refreshed a moment ago, with state M1 -- the cadence alone would skip it.
  setSyncState(d, "personal", "mailbox", "M1");
  setSyncState(d, "personal", "mailbox_at", "0");
  let mailboxGets = 0;
  const client = quietClient((name) => { if (name === "Mailbox/get") mailboxGets += 1; });
  const ac = new AbortController();
  let passes = 0;
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", client]]),
    tokens: new Map([["personal", "t"]]),
    states: new Map<string, AccountState>(),
    onChange: () => {},
    signal: ac.signal,
    now: () => 1,
    sleep: async () => { passes += 1; if (passes > 1) ac.abort(); },
    startPushFn: async (_s, _t, opts) => {
      await new Promise((r) => setTimeout(r, 5));
      await opts.onStateChange(client.session.mailAccountId, { Email: "S0", Mailbox: "M2" });
    },
  });
  assert.equal(mailboxGets, 1, `a new Mailbox state must fetch the tree once, saw ${mailboxGets}`);
  d.close();
});

test("row 22: a pushed Mailbox state equal to ours does not refetch the tree", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  setSyncState(d, "personal", "mailbox", "M1");
  setSyncState(d, "personal", "mailbox_at", "0");
  let mailboxGets = 0;
  const client = quietClient((name) => { if (name === "Mailbox/get") mailboxGets += 1; });
  const ac = new AbortController();
  let passes = 0;
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", client]]),
    tokens: new Map([["personal", "t"]]),
    states: new Map<string, AccountState>(),
    onChange: () => {},
    signal: ac.signal,
    now: () => 1,
    sleep: async () => { passes += 1; if (passes > 1) ac.abort(); },
    startPushFn: async (_s, _t, opts) => {
      await new Promise((r) => setTimeout(r, 5));
      await opts.onStateChange(client.session.mailAccountId, { Email: "S0", Mailbox: "M1" });
    },
  });
  assert.equal(mailboxGets, 0, `an unchanged Mailbox state must not refetch, saw ${mailboxGets}`);
  d.close();
});

test("a pass that hangs is abandoned at the deadline: the other account still syncs, the hung one says so, and the next cycle starts a fresh pass", async () => {
  // 2026-09-08: one JMAP request parked forever inside Node's fetch held the
  // sequential poll loop at `fetchChanges` for four and a half hours, and all
  // six accounts went stale together. The request bound in JmapClient is the
  // first line; this is the second -- a pass that outlives the deadline for
  // ANY reason must not stop the loop.
  const d = db();
  for (const k of ["personal", "work"]) setSyncState(d, k, "email", "S0");
  const states = new Map<string, AccountState>();
  const ac = new AbortController();
  const logs: string[] = [];
  let hungCalls = 0;
  let cycles = 0;
  // A fetcher that never answers and ignores its signal -- a hang the client
  // bound cannot end, which is exactly the case the watchdog exists for.
  const hung = new JmapClient(session, "t", () => { hungCalls += 1; return new Promise<Response>(() => {}); });
  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", hung], ["work", quietClient()]]),
    tokens: new Map([["personal", "t"], ["work", "t"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    passDeadlineMs: 30,
    pollMs: 4242,
    log: (m) => logs.push(m),
    // Only the poll sleep counts a cycle; the same sleep paces batches inside a pass.
    sleep: async (ms) => { if (ms !== 4242) return; cycles += 1; if (cycles === 2) ac.abort(); },
    startPushFn: async () => {},
  });
  assert.equal(states.get("work")?.kind, "ok", "the healthy account synced behind the hung one");
  assert.notEqual(lastSyncAt(d, "work"), null);
  assert.notEqual(states.get("personal")?.kind, "ok", "the hung account is reported");
  assert.match((states.get("personal") as { message: string }).message, /no progress|abandoned/);
  assert.ok(logs.some((l) => /personal: .*abandoned/.test(l)), `logged: ${logs.join(" | ")}`);
  assert.equal(hungCalls, 2, "the second cycle started a FRESH pass instead of awaiting the abandoned one");
  d.close();
});

/**
 * A client whose Email/query pages each take `delayMs` to answer, so a first
 * walk of `pages` pages outlives a short pass deadline by wall time while
 * ticking `onProgress` once per page. Everything else answers immediately.
 */
function slowWalkClient(pages: number, delayMs: number) {
  let page = 0;
  return new JmapClient(session, "t", async (_u, init) => {
    const [name, args] = JSON.parse(init.body as string).methodCalls[0];
    if (name === "Email/query") {
      await new Promise((r) => setTimeout(r, delayMs));
      if (page >= pages) return json({ methodResponses: [["Email/query", { ids: [] }, "c0"]] });
      const ids = Array.from({ length: 50 }, (_v, i) => `m${page * 50 + i}`);
      page += 1;
      return json({ methodResponses: [["Email/query", { ids }, "c0"]] });
    }
    if (name === "Email/get") {
      const ids = args.ids as string[];
      if (Array.isArray(args.properties) && args.properties.includes("attachments")) {
        return json({ methodResponses: [["Email/get", { list: [], notFound: ids }, "c0"]] });
      }
      const wantsBodies = Array.isArray(args.properties) && args.properties.includes("bodyValues");
      const list = ids.map((id) =>
        wantsBodies
          ? { id, textBody: [{ partId: "1", type: "text/plain" }], bodyValues: { "1": { value: `body ${id}` } } }
          : { id, threadId: id, receivedAt: "2026-01-01T00:00:00Z", subject: id, preview: "", hasAttachment: false, keywords: {}, mailboxIds: {}, from: [] },
      );
      return json({ methodResponses: [["Email/get", { list, state: "S0" }, "c0"]] });
    }
    if (name === "Email/changes") {
      return json({ methodResponses: [["Email/changes", {
        oldState: args.sinceState, newState: args.sinceState, hasMoreChanges: false,
        created: [], updated: [], destroyed: [],
      }, "c0"]] });
    }
    return json({ methodResponses: [["Mailbox/get", { list: [], state: "M1" }, "c0"]] });
  });
}

test("a pass that keeps making progress past the deadline is NOT abandoned; one with no progress still is", async () => {
  // 2026-09-22: a first walk of a 167k-message mailbox was abandoned mid-walk
  // by the fixed deadline -- the account flipped to `network` and the pass was
  // dropped from `inFlight` while the walk kept running. The deadline is a
  // PROGRESS watchdog: only silence counts against it.
  const d = db();
  for (const k of ["personal", "work"]) setSyncState(d, k, "email", "S0");
  const states = new Map<string, AccountState>();
  const progressAt = new Map<string, number>();
  const ac = new AbortController();
  const logs: string[] = [];
  let cycles = 0;
  const t0 = Date.now();

  // Five pages at 100ms each: 500ms+ of wall time against a 300ms deadline
  // (3x margin over the 100ms page interval, so a slow CI host cannot flake
  // this into a false abandon), but never 300ms without a tick.
  const slow = slowWalkClient(5, 100);
  const hung = new JmapClient(session, "t", () => new Promise<Response>(() => {}));

  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", slow], ["work", hung]]),
    tokens: new Map([["personal", "t"], ["work", "t"]]),
    states,
    progressAt,
    onChange: () => {},
    signal: ac.signal,
    passDeadlineMs: 300,
    pollMs: 4242,
    log: (m) => logs.push(m),
    sleep: async (ms) => { if (ms !== 4242) return; cycles += 1; ac.abort(); },
    startPushFn: async () => {},
  });

  assert.equal(cycles, 1, "one cycle only");
  assert.equal(states.get("personal")?.kind, "ok", `the progressing walk must survive: ${logs.join(" | ")}`);
  assert.ok(
    !logs.some((l) => /^personal: .*abandoned/.test(l)),
    `the progressing account must not be abandoned: ${logs.join(" | ")}`,
  );
  assert.equal(states.get("work")?.kind, "network", "the silent pass is still abandoned");
  assert.equal(
    logs.filter((l) => /^work: pass made no progress .* and was abandoned/.test(l)).length,
    1,
    `exactly one abandon line for the hung account: ${logs.join(" | ")}`,
  );
  assert.ok((progressAt.get("personal") ?? 0) > t0 + 300, "progress was recorded as the walk moved");
  d.close();
});

test("a pass the poll COALESCES onto is kept alive by that pass's own progress", async () => {
  // The watchdog cannot be private to the passWithin call that armed it.
  // `pass` coalesces, so when the poll reaches an account a PUSH event already
  // started a pass for, the ticks were handed out before this waiter existed
  // -- and a call-scoped callback would never fire, abandoning a pass that was
  // storing batches the whole time.
  const d = db();
  for (const k of ["personal", "work"]) setSyncState(d, k, "email", "S0");
  const states = new Map<string, AccountState>();
  const ac = new AbortController();
  const logs: string[] = [];
  // personal holds the sequential loop for ~30ms; work's pass is started by
  // push 5ms in, so the loop JOINS it rather than starting it.
  const slow = slowWalkClient(5, 100);
  let pushers = 0;

  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", slowWalkClient(0, 30)], ["work", slow]]),
    tokens: new Map([["personal", "t"], ["work", "t"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    passDeadlineMs: 300,
    pollMs: 4242,
    log: (m) => logs.push(m),
    sleep: async (ms) => { if (ms !== 4242) return; ac.abort(); },
    startPushFn: async (_s, _t, opts) => {
      pushers += 1;
      if (pushers !== 2) return;          // the work pusher only
      await new Promise((r) => setTimeout(r, 5));
      opts.onStateChange(slow.session.mailAccountId, { Email: "S1" });
    },
  });

  assert.equal(states.get("work")?.kind, "ok", `logged: ${logs.join(" | ")}`);
  assert.ok(!logs.some((l) => /abandoned/.test(l)), `logged: ${logs.join(" | ")}`);
  d.close();
});

test("a pass coalescing onto an ALREADY-RUNNING boot walk is not abandoned", async () => {
  // The production shape of the 2026-09-22 incident, and the one a callback
  // cannot cover: main.ts starts the boot walk before the supervisor exists,
  // walkArchive coalesces and DROPS the second caller's options, so the
  // supervisor's own onProgress is never invoked for the whole walk. The only
  // ticks are the boot walk's own writes into progressAt -- which is why the
  // watchdog reads that map rather than waiting to be called.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  const states = new Map<string, AccountState>();
  const progressAt = new Map<string, number>();
  const ac = new AbortController();
  const logs: string[] = [];
  const slow = slowWalkClient(5, 100);

  // Started FIRST, exactly as main.ts does, with its own progress callback
  // and nothing connecting it to the supervisor but the map.
  // paceMs 0 so the walk's speed is the fake's 100ms page delay and nothing
  // else -- pacedRequest's default 250ms pause would otherwise dominate.
  const boot = walkArchive(d, slow, "personal", {
    paceMs: 0,
    onProgress: () => { progressAt.set("personal", Date.now()); },
  });

  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS,
    clients: new Map([["personal", slow]]),
    tokens: new Map([["personal", "t"]]),
    states,
    progressAt,
    onChange: () => {},
    signal: ac.signal,
    passDeadlineMs: 300,
    pollMs: 4242,
    log: (m) => logs.push(m),
    sleep: async (ms) => { if (ms !== 4242) return; ac.abort(); },
    startPushFn: async () => {},
  });
  await boot;

  assert.ok(!logs.some((l) => /abandoned/.test(l)), `logged: ${logs.join(" | ")}`);
  assert.equal(states.get("personal")?.kind, "ok", `logged: ${logs.join(" | ")}`);
  d.close();
});

test("wake() establishes an account added while the supervisor is running", async () => {
  // The hot-add path: POST /api/accounts pushes the spec and its credential
  // into the SAME `accounts`/`tokens` objects the supervisor holds, then
  // calls wake(). Nothing restarts.
  const d = db();
  for (const k of ["personal", "b"]) { setSyncState(d, k, "email", "S0"); setSyncState(d, k, "walk", "done"); }
  const accounts: AccountSpec[] = [TEST_ACCOUNTS[0]!];
  const tokens = new Map([["personal", "t"]]);
  const clients = new Map([["personal", quietClient()]]);
  const states = new Map<string, AccountState>();
  const ac = new AbortController();

  let sawB!: () => void;
  const bFetched = new Promise<void>((r) => { sawB = r; });
  const pushedTokens: string[] = [];
  let handle: { wake(): Promise<void> } | null = null;

  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts,
    clients,
    tokens,
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => Date.now(),
    startPushFn: async (_s, token) => { pushedTokens.push(token); },
    expose: (h) => { handle = h; },
    establishFn: async (key) => (key === "b" ? quietClient(() => sawB()) : undefined),
    sleep: async () => {
      assert.ok(handle, "the supervisor must expose its handle before the first poll");
      accounts.push({ key: "b", label: "B", accent: "red", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" });
      tokens.set("b", "tok-b");
      await handle!.wake();
      assert.ok(clients.has("b"), "wake() must establish the new account's client");
      await Promise.race([bFetched, new Promise((_r, rej) => setTimeout(() => rej(new Error("no pass ran for b")), 2000))]);
      ac.abort();
    },
  });

  assert.equal(states.get("b")?.kind, "ok");
  assert.ok(pushedTokens.includes("tok-b"), `a pusher must start for the new account, saw ${JSON.stringify(pushedTokens)}`);
  d.close();
});

test("wake() with nothing missing establishes nothing and starts no pass", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const ac = new AbortController();
  let established = 0;
  let handle: { wake(): Promise<void> } | null = null;

  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: [TEST_ACCOUNTS[0]!],
    clients: new Map([["personal", quietClient()]]),
    tokens: new Map([["personal", "t"]]),
    states: new Map<string, AccountState>(),
    onChange: () => {},
    signal: ac.signal,
    now: () => Date.now(),
    startPushFn: async () => {},
    expose: (h) => { handle = h; },
    establishFn: async () => { established += 1; return undefined; },
    sleep: async () => { await handle!.wake(); ac.abort(); },
  });

  assert.equal(established, 0, "an account that already has a client must not be re-established");
  d.close();
});

test("two concurrent wake()s establish an account ONCE", async () => {
  // establishMissing has two callers now (the poll and wake), and there is
  // an await between "is this key missing from `clients`?" and the set.
  // Without the coalescing wrapper both callers see it missing and bring it
  // up twice: two JMAP sessions, two push readers, and only one of them
  // reachable through the map afterwards.
  const d = db();
  for (const k of ["personal", "b"]) { setSyncState(d, k, "email", "S0"); setSyncState(d, k, "walk", "done"); }
  const accounts: AccountSpec[] = [TEST_ACCOUNTS[0]!];
  const tokens = new Map([["personal", "t"]]);
  const states = new Map<string, AccountState>();
  const ac = new AbortController();

  let release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  const establishedKeys: string[] = [];
  const pushedTokens: string[] = [];
  let handle: { wake(): Promise<void> } | null = null;

  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts,
    clients: new Map([["personal", quietClient()]]),
    tokens,
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => Date.now(),
    startPushFn: async (_s, token) => { pushedTokens.push(token); },
    expose: (h) => { handle = h; },
    establishFn: async (key) => {
      establishedKeys.push(key);
      await blocked;               // both wakes are in flight while this hangs
      return quietClient();
    },
    sleep: async () => {
      accounts.push({ key: "b", label: "B", accent: "red", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" });
      tokens.set("b", "tok-b");
      const first = handle!.wake();
      const second = handle!.wake();
      release();
      await Promise.all([first, second]);
      assert.deepEqual(establishedKeys, ["b"], `establishFn must run once per key, saw ${JSON.stringify(establishedKeys)}`);
      // "t" is personal's pusher, started when the loop began; what must be
      // exactly one is the new account's.
      assert.deepEqual(pushedTokens.filter((t) => t === "tok-b"), ["tok-b"],
        `one pusher for the new account, saw ${JSON.stringify(pushedTokens)}`);
      ac.abort();
    },
  });

  d.close();
});

test("an account removed WHILE establishFn is in flight is not re-inserted with a live pusher (I2 review Minor 2)", async () => {
  // establishMissing awaits deps.establishFn(key, token) and only THEN sets
  // deps.clients.set(key, client) + startPusher. If the account is deleted
  // (DELETE /api/accounts/:key -> onRemoved splices it out of deps.accounts
  // and deps.tokens) while that await is in flight, the old code re-inserted
  // it into `clients` anyway and started a pusher nothing ever tears down --
  // the exact "kept fetching a deleted account's mail until a restart" bug
  // onRemoved exists to prevent, just arriving a few ticks later.
  const d = db();
  for (const k of ["personal", "b"]) { setSyncState(d, k, "email", "S0"); setSyncState(d, k, "walk", "done"); }
  const accounts: AccountSpec[] = [TEST_ACCOUNTS[0]!];
  const tokens = new Map([["personal", "t"]]);
  const states = new Map<string, AccountState>();
  const ac = new AbortController();

  let release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  const pushedTokens: string[] = [];
  let handle: { wake(): Promise<void> } | null = null;
  const clients = new Map([["personal", quietClient()]]);

  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts,
    clients,
    tokens,
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => Date.now(),
    startPushFn: async (_s, token) => { pushedTokens.push(token); },
    expose: (h) => { handle = h; },
    establishFn: async (key) => {
      if (key !== "b") return quietClient();
      await blocked;               // held open so the removal below lands mid-establish
      return quietClient();
    },
    sleep: async () => {
      accounts.push({ key: "b", label: "B", accent: "red", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" });
      tokens.set("b", "tok-b");
      const waking = handle!.wake();

      // "b" is removed (as onRemoved does) WHILE establishFn's await is
      // still pending -- there has been no chance yet for the resolved
      // client to be recorded.
      const i = accounts.findIndex((a) => a.key === "b");
      if (i !== -1) accounts.splice(i, 1);
      tokens.delete("b");

      release();
      await waking;
      ac.abort();
    },
  });

  assert.ok(!clients.has("b"), "a removed account must not be re-inserted into clients by a late establish");
  assert.equal(states.get("b"), undefined, "a removed account must not gain a state entry from a late establish");
  assert.ok(!pushedTokens.includes("tok-b"), `no pusher must start for an account removed mid-establish, saw ${JSON.stringify(pushedTokens)}`);
  d.close();
});

test("a hot-added account has a progress entry from the moment its first pass starts", async () => {
  // /healthz reads progressAt: an account with no entry at all is
  // indistinguishable from one whose pass has stalled, so a freshly added
  // account would report stale while its first walk was running perfectly.
  const d = db();
  for (const k of ["personal", "b"]) { setSyncState(d, k, "email", "S0"); setSyncState(d, k, "walk", "done"); }
  const accounts: AccountSpec[] = [TEST_ACCOUNTS[0]!];
  const tokens = new Map([["personal", "t"]]);
  const progressAt = new Map<string, number>();
  const ac = new AbortController();
  let handle: { wake(): Promise<void> } | null = null;

  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts,
    clients: new Map([["personal", quietClient()]]),
    tokens,
    states: new Map<string, AccountState>(),
    progressAt,
    onChange: () => {},
    signal: ac.signal,
    now: () => 4242,
    startPushFn: async () => {},
    expose: (h) => { handle = h; },
    establishFn: async (key) => (key === "b" ? quietClient() : undefined),
    sleep: async () => {
      accounts.push({ key: "b", label: "B", accent: "red", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" });
      tokens.set("b", "tok-b");
      await handle!.wake();
      assert.equal(progressAt.get("b"), 4242, "wake must note progress before the pass it starts");
      ac.abort();
    },
  });

  d.close();
});

test("one account's re-auth throwing does not take the whole establish down", async () => {
  // reauthenticate is called per account inside establishMissing. A store
  // whose get() throws for ONE account must not reject the shared,
  // coalesced establish promise -- that rejection would escape the poll
  // loop and stop the supervisor for every account.
  const d = db();
  setSyncState(d, "b", "email", "S0");
  setSyncState(d, "b", "walk", "done");
  const accounts: AccountSpec[] = [
    { key: "bad", label: "Bad", accent: "red", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
    { key: "b", label: "B", accent: "red", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
  ];
  const states = new Map<string, AccountState>();
  const clients = new Map();
  const ac = new AbortController();

  await startSupervisor({
    db: d,
    accounts,
    clients,
    tokens: new Map([["b", "tok-b"]]),
    states,
    onChange: () => {},
    signal: ac.signal,
    now: () => Date.now(),
    startPushFn: async () => {},
    store: {
      kind: "test",
      // Not a rejected promise: a store that throws SYNCHRONOUSLY from get()
      // is the shape reauthenticate's own try/catch was written for, and the
      // one a `await reauthenticate(...)` outside the per-account try would
      // let escape.
      get: () => { throw new Error("store exploded"); },
      put: async () => {},
      remove: async () => {},
    },
    establishFn: async (key) => (key === "b" ? quietClient() : undefined),
    sleep: async () => { ac.abort(); },
  });

  assert.ok(clients.has("b"), "the healthy account must still be established");
  d.close();
});

/**
 * 🚨 THE POLL'S OWN HEARTBEAT IS NOT EVIDENCE THAT A WALK IS PROGRESSING.
 *
 * `progressAt` is shared with /healthz, which uses it to tell a first walk
 * that is MOVING (reported `syncing`, and not stale) from one that has
 * stalled. It was also stamped at PASS START -- and the safety poll starts a
 * pass for every account every five minutes, against a fifteen-minute stale
 * threshold. So the value could never age past the threshold while the loop
 * ran, `syncing` was permanently true for any healthy-state account whose
 * walk had not finished, and `ok` stopped requiring a finished walk at all.
 *
 * The effect: an account whose first walk DIED (ruling G16 -- a walk that
 * fails leaves nothing behind but a console.error) reported ok forever, so
 * the uptime monitor watching /healthz could never go red for it. Measured
 * before the fix: 55 simulated minutes of polls storing nothing, and the
 * "progress" signal was 5 minutes old.
 *
 * The watchdog still needs a pass-start baseline -- a pass that has only
 * just begun has not stalled -- but that baseline is local to the wait, not
 * written into the map health reads.
 */
test("🚨 a pass that stores nothing records no progress, however many times it runs", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  const states = new Map<string, AccountState>();
  const progressAt = new Map<string, number>();
  const ac = new AbortController();
  let clock = 0;
  let polls = 0;

  await startSupervisor({
    store: SILENT_STORE,
    db: d,
    accounts: TEST_ACCOUNTS.filter((a) => a.key === "personal"),
    clients: new Map([["personal", quietClient()]]),
    tokens: new Map([["personal", "t"]]),
    states,
    progressAt,
    onChange: () => {},
    signal: ac.signal,
    now: () => clock,
    // Twelve safety polls: an hour of simulated time in which nothing arrives.
    sleep: async (ms) => { clock += ms; polls += 1; if (polls >= 12) ac.abort(); },
    startPushFn: async () => {},
  });

  assert.equal(states.get("personal")?.kind, "ok", "sanity: the passes themselves succeeded");
  assert.equal(
    progressAt.get("personal"),
    undefined,
    "the poll stamped progress for an account that stored nothing, which is what hid a dead walk from /healthz",
  );
  d.close();
});
