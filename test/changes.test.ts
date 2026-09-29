import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { setSyncState, getSyncState } from "../src/core/mutations.ts";
import { fetchChanges, MAX_CHANGE_ROUNDS } from "../src/core/changes.ts";
import { JmapClient } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import { tempDbPath } from "./tmpdir.ts";

const session = resolveSession("personal", personalSession);

function db() {
  return openDb(tempDbPath());
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A server holding `pages` successive change pages. */
function changeServer(pages: { created?: string[]; updated?: string[]; destroyed?: string[]; newState: string; hasMore: boolean }[]) {
  const seen: string[] = [];
  let i = 0;
  const client = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [name, args] = body.methodCalls[0];
    assert.equal(name, "Email/changes");
    seen.push(args.sinceState as string);
    const p = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    return jsonResponse({
      methodResponses: [["Email/changes", {
        oldState: args.sinceState,
        newState: p.newState,
        hasMoreChanges: p.hasMore,
        created: p.created ?? [],
        updated: p.updated ?? [],
        destroyed: p.destroyed ?? [],
      }, "c0"]],
    });
  });
  return { client, seen };
}

test("a single page of changes is returned and the cursor advances", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  const { client } = changeServer([{ created: ["a"], updated: ["b"], destroyed: ["c"], newState: "S1", hasMore: false }]);
  const r = await fetchChanges(d, client, "personal");
  assert.deepEqual(r.created, ["a"]);
  assert.deepEqual(r.updated, ["b"]);
  assert.deepEqual(r.destroyed, ["c"]);
  assert.equal(r.newState, "S1");
  assert.equal(getSyncState(d, "personal", "email"), "S1", "the cursor must be persisted");
  d.close();
});

test("changes are DRAINED, not sampled — hasMoreChanges keeps going", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  const { client, seen } = changeServer([
    { created: ["a"], newState: "S1", hasMore: true },
    { created: ["b"], newState: "S2", hasMore: true },
    { created: ["c"], newState: "S3", hasMore: false },
  ]);
  const r = await fetchChanges(d, client, "personal");
  assert.deepEqual(r.created, ["a", "b", "c"], "reading one page and stopping loses mail");
  assert.equal(r.rounds, 3);
  assert.deepEqual(seen, ["S0", "S1", "S2"], "each round must resume from the previous newState");
  d.close();
});

test("the cursor is persisted after EVERY round, not only at the end", async () => {
  // A crash mid-drain must not replay from the start, and must not skip.
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  let seenAfterFirst: string | null = null;
  const client = new JmapClient(session, "t", async (_url, init) => {
    const [, args] = JSON.parse(init.body as string).methodCalls[0];
    if (args.sinceState === "S1") seenAfterFirst = getSyncState(d, "personal", "email");
    const next = args.sinceState === "S0" ? "S1" : "S2";
    return jsonResponse({ methodResponses: [["Email/changes", {
      oldState: args.sinceState, newState: next, hasMoreChanges: next === "S1",
      created: [], updated: [], destroyed: [],
    }, "c0"]] });
  });
  await fetchChanges(d, client, "personal");
  assert.equal(seenAfterFirst, "S1", "round 2 should already see round 1's cursor committed");
  d.close();
});

test("a server that never advances its state cannot loop forever", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  // hasMore always true, newState never changes: the shape that hangs a naive drain.
  const { client } = changeServer([{ created: ["a"], newState: "S0", hasMore: true }]);
  const r = await fetchChanges(d, client, "personal");
  assert.ok(r.rounds < MAX_CHANGE_ROUNDS, "an unadvancing state must stop immediately, not burn every round");
  d.close();
});

test("the drain is bounded even when the server keeps advancing", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  let n = 0;
  const client = new JmapClient(session, "t", async (_url, init) => {
    const [, args] = JSON.parse(init.body as string).methodCalls[0];
    n += 1;
    return jsonResponse({ methodResponses: [["Email/changes", {
      oldState: args.sinceState, newState: `S${n}`, hasMoreChanges: true,
      created: [`m${n}`], updated: [], destroyed: [],
    }, "c0"]] });
  });
  const r = await fetchChanges(d, client, "personal");
  assert.equal(r.rounds, MAX_CHANGE_ROUNDS, "a huge backlog must yield after a bounded number of rounds");
  assert.equal(getSyncState(d, "personal", "email"), `S${MAX_CHANGE_ROUNDS}`, "and leave the cursor where it got to, so the next pass continues");
  d.close();
});

test("cannotCalculateChanges triggers a full resync rather than throwing forever", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S-ancient");
  setSyncState(d, "personal", "walk", "done");
  const client = new JmapClient(session, "t", async () =>
    jsonResponse({ methodResponses: [["error", { type: "cannotCalculateChanges" }, "c0"]] }),
  );
  const r = await fetchChanges(d, client, "personal");
  assert.equal(r.resynced, true);
  assert.equal(getSyncState(d, "personal", "walk"), null,
    "a resync must clear the walk sentinel so the archive is re-walked");
  d.close();
});

test("no stored cursor means there is nothing to do yet", async () => {
  // The archive walk captures the first cursor. Before that, changes are meaningless.
  const d = db();
  let called = false;
  const client = new JmapClient(session, "t", async () => { called = true; return jsonResponse({ methodResponses: [] }); });
  const r = await fetchChanges(d, client, "personal");
  assert.equal(called, false, "must not query changes without a cursor");
  assert.equal(r.rounds, 0);
  d.close();
});

test("an ordinary error propagates and does NOT clear the cursor", async () => {
  const d = db();
  setSyncState(d, "personal", "email", "S0");
  const client = new JmapClient(session, "t", async () => new Response("nope", { status: 503 }));
  await assert.rejects(() => fetchChanges(d, client, "personal"));
  assert.equal(getSyncState(d, "personal", "email"), "S0", "a transient failure must not lose the cursor");
  d.close();
});

test("a resync clears the EMAIL CURSOR too, not just the walk sentinel", async () => {
  // C3: walkArchive writes the cursor only when there is none, so leaving the
  // expired cursor behind means the re-walk never replaces it -- the next
  // pass throws cannotCalculateChanges, "resyncs" again, and reports success
  // forever while nothing syncs.
  const d = db();
  setSyncState(d, "personal", "email", "OLD");
  setSyncState(d, "personal", "walk", "done");
  const client = new JmapClient(session, "t", async () =>
    jsonResponse({ methodResponses: [["error", { type: "cannotCalculateChanges" }, "c0"]] }));

  const r = await fetchChanges(d, client, "personal");
  assert.equal(r.resynced, true);
  assert.equal(getSyncState(d, "personal", "walk"), null, "the walk sentinel is cleared");
  assert.equal(getSyncState(d, "personal", "email"), null, "and so is the stale cursor");
  d.close();
});
