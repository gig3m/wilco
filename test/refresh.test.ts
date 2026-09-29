import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { setSyncState, getSyncState, storeEmails } from "../src/core/mutations.ts";
import { refreshAccount, MAILBOX_REFRESH_MS } from "../src/core/refresh.ts";
import { JmapClient } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import { searchEmails } from "../src/core/queries.ts";
import { tempDbPath } from "./tmpdir.ts";

const session = resolveSession("personal", personalSession);
function db() { return openDb(tempDbPath()); }
function json(b: unknown) { return new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }); }

/**
 * Server with one page of changes plus Email/get and Mailbox/get.
 *
 * Email/get is used for two different fetches -- METADATA_PROPS in
 * refreshAccount itself, and the body-fetch shape (fetchTextBodyValues:
 * true) that refreshAccount now also drives via backfillBodies -- so this
 * dispatches on that flag rather than assuming every Email/get call is the
 * metadata one. `opts.bodies` supplies the body-fetch response per id; an id
 * with no entry gets no textBody/bodyValues, matching the pre-fix behavior
 * (empty body_text) for every test that does not care about bodies.
 */
function server(opts: {
  created?: string[];
  updated?: string[];
  destroyed?: string[];
  bodies?: Record<string, string>;
}) {
  const calls: string[] = [];
  const client = new JmapClient(session, "t", async (_url, init) => {
    const [name, args] = JSON.parse(init.body as string).methodCalls[0];
    calls.push(name);
    if (name === "Email/changes") {
      return json({ methodResponses: [["Email/changes", {
        oldState: args.sinceState, newState: "S1", hasMoreChanges: false,
        created: opts.created ?? [], updated: opts.updated ?? [], destroyed: opts.destroyed ?? [],
      }, "c0"]] });
    }
    if (name === "Email/get" && args.fetchTextBodyValues) {
      const list = (args.ids as string[]).map((id) => {
        const text = opts.bodies?.[id];
        return text === undefined
          ? { id }
          : { id, textBody: [{ partId: "1" }], bodyValues: { "1": { value: text } } };
      });
      return json({ methodResponses: [["Email/get", { list }, "c0"]] });
    }
    if (name === "Email/get") {
      const list = (args.ids as string[]).map((id) => ({
        id, receivedAt: "2026-01-01T00:00:00Z", subject: `S ${id}`,
        keywords: {}, mailboxIds: { "P-F": true }, from: [{ email: "a@b.c" }],
      }));
      return json({ methodResponses: [["Email/get", { list, state: "S1" }, "c0"]] });
    }
    if (name === "Mailbox/get") {
      return json({ methodResponses: [["Mailbox/get", {
        list: [{ id: "P-F", name: "Inbox", role: "inbox" }], state: "M1",
      }, "c0"]] });
    }
    throw new Error(`unexpected ${name}`);
  });
  return { client, calls };
}

test("created messages are fetched and stored", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const { client } = server({ created: ["a", "b"] });
  const r = await refreshAccount(d, client, "personal", { now: () => 0 });
  assert.equal(r.created, 2);
  assert.equal((d.prepare("SELECT count(*) c FROM emails").get() as any).c, 2);
  d.close();
});

test("destroyed messages are removed", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  storeEmails(d, "personal", [{ id: "gone", receivedAt: "2026-01-01T00:00:00Z", keywords: {}, mailboxIds: {}, from: [] }]);
  const { client } = server({ destroyed: ["gone"] });
  const r = await refreshAccount(d, client, "personal", { now: () => 0 });
  assert.equal(r.destroyed, 1);
  assert.equal((d.prepare("SELECT count(*) c FROM emails").get() as any).c, 0);
  d.close();
});

test("an UPDATED message keeps its already-indexed body", async () => {
  // This is the plan-1 rule that matters most: a metadata refresh must not
  // erase body_text, or search silently degrades over months.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  storeEmails(d, "personal", [{ id: "a", receivedAt: "2026-01-01T00:00:00Z", subject: "old", keywords: {}, mailboxIds: {}, from: [] }]);
  d.prepare("UPDATE emails SET body_text = ? WHERE account='personal' AND id='a'").run("quick brown fox");
  const { client } = server({ updated: ["a"] });
  await refreshAccount(d, client, "personal", { now: () => 0 });
  const row = d.prepare("SELECT subject, body_text FROM emails WHERE id='a'").get() as any;
  assert.equal(row.subject, "S a", "metadata should update");
  assert.equal(row.body_text, "quick brown fox", "the indexed body must survive");
  d.close();
});

test("mailboxes refresh on their own slower cadence, not every pass", async () => {
  // Email/changes does not carry mailbox changes, so a folder created on the
  // phone would never appear -- but refreshing them every pass is wasteful.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const { client, calls } = server({});
  await refreshAccount(d, client, "personal", { now: () => 0 });
  assert.equal(calls.filter((c) => c === "Mailbox/get").length, 1, "first pass refreshes");

  calls.length = 0;
  await refreshAccount(d, client, "personal", { now: () => 1000 });
  assert.equal(calls.filter((c) => c === "Mailbox/get").length, 0, "a pass moments later must not");

  calls.length = 0;
  await refreshAccount(d, client, "personal", { now: () => MAILBOX_REFRESH_MS + 1 });
  assert.equal(calls.filter((c) => c === "Mailbox/get").length, 1, "past the cadence it refreshes again");
  d.close();
});

test("nothing changed means no Email/get at all", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const { client, calls } = server({});
  const r = await refreshAccount(d, client, "personal", { now: () => 0 });
  assert.equal(r.created + r.updated + r.destroyed, 0);
  assert.equal(calls.filter((c) => c === "Email/get").length, 0);
  d.close();
});

test("a newly created message gets its body fetched and indexed", async () => {
  // Metadata-only rows are invisible to body search. Incremental sync that
  // produces them silently defeats the point of the archive.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const { client } = server({ created: ["a"], bodies: { a: "the quick brown fox jumps" } });
  const r = await refreshAccount(d, client, "personal", { now: () => 0, paceMs: 0, sleep: async () => {} });
  assert.equal(r.bodiesWritten, 1);
  assert.equal(r.bodiesFailed, 0);

  const row = d.prepare("SELECT body_text FROM emails WHERE id='a'").get() as { body_text: string };
  assert.equal(row.body_text, "the quick brown fox jumps");

  const result = searchEmails(d, "jumps");
  assert.ok(result.rows.some((x) => x.id === "a"), "must be findable by a word from the body");
  d.close();
});

test("a pass with nothing to backfill does not trip the progress guard", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  storeEmails(d, "personal", [{ id: "a", receivedAt: "2026-01-01T00:00:00Z", subject: "old", keywords: {}, mailboxIds: {}, from: [] }]);
  d.prepare("UPDATE emails SET body_text = ? WHERE account='personal' AND id='a'").run("already indexed");
  const { client } = server({});
  const r = await refreshAccount(d, client, "personal", { now: () => 0, paceMs: 0, sleep: async () => {} });
  assert.equal(r.bodiesWritten, 0);
  assert.equal(r.bodiesFailed, 0);
  d.close();
});

test("a resync is reported and does not also try to apply changes", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S-ancient");
  setSyncState(d, "personal", "walk", "done");
  const client = new JmapClient(session, "t", async (_url, init) => {
    const [name] = JSON.parse(init.body as string).methodCalls[0];
    if (name === "Email/changes") return json({ methodResponses: [["error", { type: "cannotCalculateChanges" }, "c0"]] });
    return json({ methodResponses: [["Mailbox/get", { list: [], state: "M1" }, "c0"]] });
  });
  const r = await refreshAccount(d, client, "personal", { now: () => 0 });
  assert.equal(r.resynced, true);
  assert.equal(getSyncState(d, "personal", "walk"), null);
  d.close();
});

test("a large change set is CHUNKED, never sent as one oversized Email/get", async () => {
  // C2's certain trigger: 5,000 drained ids in one Email/get against a live
  // maxObjectsInGet of 4,096 fails requestTooLarge -- after the cursor has
  // already advanced past them.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const ids = Array.from({ length: 1200 }, (_, i) => `M${i}`);
  const sizes: number[] = [];
  const client = new JmapClient(session, "t", async (_u, init) => {
    const [name, args] = JSON.parse(init.body as string).methodCalls[0];
    if (name === "Email/changes") {
      return json({ methodResponses: [["Email/changes", {
        oldState: "S0", newState: "S1", hasMoreChanges: false,
        created: ids, updated: [], destroyed: [],
      }, "c0"]] });
    }
    if (name === "Email/get" && args.fetchTextBodyValues) {
      return json({ methodResponses: [["Email/get", {
        list: (args.ids as string[]).map((id) => ({ id })),
      }, "c0"]] });
    }
    if (name === "Email/get") {
      sizes.push((args.ids as string[]).length);
      if ((args.ids as string[]).length > 500) {
        return json({ methodResponses: [["error", { type: "requestTooLarge" }, "c0"]] });
      }
      return json({ methodResponses: [["Email/get", {
        list: (args.ids as string[]).map((id) => ({
          id, receivedAt: "2026-01-01T00:00:00Z", subject: `S ${id}`,
          keywords: {}, mailboxIds: { "P-F": true }, from: [{ email: "a@b.c" }],
        })),
        state: "S1",
      }, "c0"]] });
    }
    return json({ methodResponses: [["Mailbox/get", { list: [], state: "M1" }, "c0"]] });
  });

  const r = await refreshAccount(d, client, "personal", { paceMs: 0, sleep: async () => {} });
  assert.equal(r.created, 1200);
  assert.ok(sizes.length >= 3, `expected several chunks, saw ${JSON.stringify(sizes)}`);
  assert.ok(Math.max(...sizes) <= 500, `a chunk exceeded the cap: ${JSON.stringify(sizes)}`);
  const n = d.prepare("SELECT COUNT(*) AS c FROM emails WHERE account = 'personal'").get() as { c: number };
  assert.equal(Number(n.c), 1200);
  d.close();
});

test("a metadata fetch that fails leaves the cursor BEHIND the changes it lost", async () => {
  // The deeper half of C2: the cursor used to be committed every round while
  // the ids were applied only after the whole drain, so a throw in between
  // advanced past changes that were never written -- permanently.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const client = new JmapClient(session, "t", async (_u, init) => {
    const [name] = JSON.parse(init.body as string).methodCalls[0];
    if (name === "Email/changes") {
      return json({ methodResponses: [["Email/changes", {
        oldState: "S0", newState: "S1", hasMoreChanges: false,
        created: ["M1"], updated: [], destroyed: [],
      }, "c0"]] });
    }
    if (name === "Email/get") {
      return json({ methodResponses: [["error", { type: "requestTooLarge" }, "c0"]] });
    }
    return json({ methodResponses: [["Mailbox/get", { list: [], state: "M1" }, "c0"]] });
  });

  await assert.rejects(() => refreshAccount(d, client, "personal", { paceMs: 0, sleep: async () => {} }));
  assert.equal(getSyncState(d, "personal", "email"), "S0",
    "the cursor must not advance past changes that were never stored");
  d.close();
});

test("a FINISHED walk costs zero JMAP requests on every pass", async () => {
  // C3 adds walkArchive to every pass. If the 'done' sentinel did not
  // short-circuit before the first request, this would re-walk 37,000
  // messages on a live account every single pass.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  setSyncState(d, "personal", "mailbox_at", "0");
  const seen: string[] = [];
  const { client, calls } = server({});
  void seen;
  await refreshAccount(d, client, "personal", {
    now: () => 1000, paceMs: 0, sleep: async () => {},
  });
  assert.equal(calls.filter((c) => c === "Email/query").length, 0,
    `a finished walk must issue no Email/query, saw ${JSON.stringify(calls)}`);
  d.close();
});

test("refreshAccount calls onProgress once per stored batch of messages and once per body batch", async () => {
  // Fresh account: no walk sentinel, so the walk runs first. Two Email/query
  // pages (2 ids, then 1 id, then empty) produce two stored walk batches;
  // the three resulting metadata-only rows then get ONE body batch.
  const d = db();
  let queryCalls = 0;
  const client = new JmapClient(session, "t", async (_u, init) => {
    const [name, args] = JSON.parse(init.body as string).methodCalls[0];
    if (name === "Email/query") {
      queryCalls += 1;
      if (queryCalls === 1) return json({ methodResponses: [["Email/query", { ids: ["W1", "W2"] }, "c0"]] });
      if (queryCalls === 2) return json({ methodResponses: [["Email/query", { ids: ["W3"] }, "c0"]] });
      return json({ methodResponses: [["Email/query", { ids: [] }, "c0"]] });
    }
    if (name === "Email/changes") {
      return json({ methodResponses: [["Email/changes", {
        oldState: args.sinceState, newState: args.sinceState, hasMoreChanges: false,
        created: [], updated: [], destroyed: [],
      }, "c0"]] });
    }
    if (name === "Email/get" && args.fetchTextBodyValues) {
      const list = (args.ids as string[]).map((id) => ({
        id, textBody: [{ partId: "1" }], bodyValues: { "1": { value: `body ${id}` } },
      }));
      return json({ methodResponses: [["Email/get", { list }, "c0"]] });
    }
    if (name === "Email/get") {
      const list = (args.ids as string[]).map((id) => ({
        id, receivedAt: "2026-01-01T00:00:00Z", subject: `S ${id}`,
        keywords: {}, mailboxIds: { "P-F": true }, from: [{ email: "a@b.c" }],
      }));
      return json({ methodResponses: [["Email/get", { list, state: "S1" }, "c0"]] });
    }
    if (name === "Mailbox/get") {
      return json({ methodResponses: [["Mailbox/get", {
        list: [{ id: "P-F", name: "Inbox", role: "inbox" }], state: "M1",
      }, "c0"]] });
    }
    throw new Error(`unexpected ${name}`);
  });

  let ticks = 0;
  const r = await refreshAccount(d, client, "personal", {
    now: () => 0, paceMs: 0, sleep: async () => {},
    onProgress: () => { ticks += 1; },
  });
  assert.equal(r.bodiesWritten, 3);
  assert.ok(ticks >= 3, `expected a tick per page (2) plus at least one body batch, got ${ticks}`);
  d.close();
});

test("refreshAccount without onProgress is unchanged", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "walk", "done");
  const { client } = server({ created: ["a"], bodies: { a: "the quick fox" } });
  const r = await refreshAccount(d, client, "personal", { now: () => 0, paceMs: 0, sleep: async () => {} });
  assert.equal(r.created, 1, "must not throw or otherwise misbehave with onProgress absent");
  d.close();
});

test("a cleared walk sentinel makes the NEXT PASS re-walk, without a restart", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  setSyncState(d, "personal", "mailbox_at", "0");
  const queries: number[] = [];
  const client = new JmapClient(session, "t", async (_u, init) => {
    const [name, args] = JSON.parse(init.body as string).methodCalls[0];
    if (name === "Email/query") {
      queries.push(1);
      return json({ methodResponses: [["Email/query", {
        ids: queries.length === 1 ? ["W1"] : [],
      }, "c0"]] });
    }
    if (name === "Email/changes") {
      return json({ methodResponses: [["Email/changes", {
        oldState: "S0", newState: "S0", hasMoreChanges: false,
        created: [], updated: [], destroyed: [],
      }, "c0"]] });
    }
    if (name === "Email/get" && args.fetchTextBodyValues) {
      return json({ methodResponses: [["Email/get", {
        list: (args.ids as string[]).map((id) => ({ id })),
      }, "c0"]] });
    }
    if (name === "Email/get") {
      return json({ methodResponses: [["Email/get", {
        list: (args.ids as string[]).map((id) => ({
          id, receivedAt: "2026-01-01T00:00:00Z", subject: `S ${id}`,
          keywords: {}, mailboxIds: { "P-F": true }, from: [{ email: "a@b.c" }],
        })),
        state: "S9",
      }, "c0"]] });
    }
    return json({ methodResponses: [["Mailbox/get", { list: [], state: "M1" }, "c0"]] });
  });

  await refreshAccount(d, client, "personal", { now: () => 1000, paceMs: 0, sleep: async () => {} });
  assert.ok(queries.length > 0, "the pass must run the walk when the sentinel is absent");
  assert.equal(getSyncState(d, "personal", "walk"), "done");
  d.close();
});
