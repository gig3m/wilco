import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { syncMailboxes, getSyncState, setSyncState } from "../src/core/mutations.ts";
import {
  walkArchive,
  excludedMailboxIds,
  EXCLUDED_ROLES,
  DEFAULT_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  MAX_CONSECUTIVE_RATE_LIMITS,
} from "../src/core/corpus.ts";
import { JmapClient } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import { tempDbPath } from "./tmpdir.ts";

const session = resolveSession("personal", personalSession);

function db() {
  const d = openDb(tempDbPath());
  syncMailboxes(d, "personal", [
    { id: "P-F", name: "Inbox", role: "inbox" },
    { id: "P-Arc", name: "Archive", role: "archive" },
    { id: "P-Trash", name: "Trash", role: "trash" },
    { id: "P-Spam", name: "Identified Spam", role: "junk" },
  ]);
  return d;
}

/** A fake server holding `total` messages, paged by anchor. */
function fakeServer(total: number, opts: { anchorMissingOnce?: boolean } = {}) {
  const ids = Array.from({ length: total }, (_, i) => `m${i}`);
  let anchorFailuresLeft = opts.anchorMissingOnce ? 1 : 0;
  const seen: { anchor: string | null; position: number }[] = [];

  const client = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [name, args] = body.methodCalls[0];

    if (name === "Email/query") {
      const anchor = (args.anchor as string | undefined) ?? null;
      seen.push({ anchor, position: args.position ?? 0 });

      if (anchor !== null && anchorFailuresLeft > 0) {
        anchorFailuresLeft -= 1;
        return new Response(
          JSON.stringify({ methodResponses: [["error", { type: "anchorNotFound" }, "c0"]] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      const start = anchor === null ? (args.position ?? 0) : ids.indexOf(anchor) + 1;
      const page = ids.slice(start, start + (args.limit ?? 50));
      return new Response(
        JSON.stringify({
          methodResponses: [["Email/query", { ids: page, total, queryState: "Q1" }, "c0"]],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (name === "Email/get") {
      const list = (args.ids as string[]).map((id) => ({
        id,
        threadId: `t-${id}`,
        receivedAt: "2026-01-01T00:00:00Z",
        subject: `Subject ${id}`,
        preview: "",
        keywords: {},
        mailboxIds: { "P-Arc": true },
        from: [{ name: "Ada", email: "ada@example.com" }],
      }));
      return new Response(
        JSON.stringify({ methodResponses: [["Email/get", { list, state: "J1" }, "c0"]] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`unexpected method ${name}`);
  });

  return { client, seen };
}

/** An injectable Sleep that never really waits, and records every call. */
function recordingSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
  };
  return { sleep, calls };
}

/**
 * Like fakeServer, but the first `rateLimitQueryCount` calls to Email/query
 * answer 429 instead of a page -- everything after that (and every
 * Email/get) behaves exactly like fakeServer. Lets a test simulate "the
 * server rate-limited us N times running", independent of pacing.
 */
function fakeServerWithRateLimiting(
  total: number,
  opts: { rateLimitQueryCount: number; retryAfterHeader?: string },
) {
  const ids = Array.from({ length: total }, (_, i) => `m${i}`);
  let remaining = opts.rateLimitQueryCount;

  const client = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [name, args] = body.methodCalls[0];

    if (name === "Email/query") {
      if (remaining > 0) {
        remaining -= 1;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (opts.retryAfterHeader !== undefined) headers["retry-after"] = opts.retryAfterHeader;
        return new Response("rate limited", { status: 429, headers });
      }

      const anchor = (args.anchor as string | undefined) ?? null;
      const start = anchor === null ? (args.position ?? 0) : ids.indexOf(anchor) + 1;
      const page = ids.slice(start, start + (args.limit ?? 50));
      return new Response(
        JSON.stringify({
          methodResponses: [["Email/query", { ids: page, total, queryState: "Q1" }, "c0"]],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (name === "Email/get") {
      const list = (args.ids as string[]).map((id) => ({
        id,
        threadId: `t-${id}`,
        receivedAt: "2026-01-01T00:00:00Z",
        subject: `Subject ${id}`,
        preview: "",
        keywords: {},
        mailboxIds: { "P-Arc": true },
        from: [{ name: "Ada", email: "ada@example.com" }],
      }));
      return new Response(
        JSON.stringify({ methodResponses: [["Email/get", { list, state: "J1" }, "c0"]] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`unexpected method ${name}`);
  });

  return { client };
}

test("Trash and Spam mailboxes are excluded from the walk", () => {
  const d = db();
  const excluded = excludedMailboxIds(d, "personal");
  assert.deepEqual(new Set(excluded), new Set(["P-Trash", "P-Spam"]));
  assert.deepEqual([...EXCLUDED_ROLES].sort(), ["junk", "trash"]);
  d.close();
});

test("walks the whole archive and stores every message", async () => {
  const d = db();
  const { client } = fakeServer(137);
  const r = await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0 });
  assert.equal(r.fetched, 137);
  assert.equal(r.complete, true);
  const { c } = d.prepare("SELECT count(*) AS c FROM emails").get() as any;
  assert.equal(c, 137);
  d.close();
});

test("a server-clamped short page is not mistaken for the end of the list (finding 2)", async () => {
  // JMAP servers may clamp `limit` to their own maximum. A page shorter than
  // the REQUESTED pageSize is therefore not a sound end-of-list signal --
  // only `ids.length === 0` is. This fake always answers with at most 5 ids
  // even though the walk asks for pageSize 20, on every page including the
  // very first -- the case that used to record the account as fully walked
  // after one page.
  const d = db();
  const total = 37;
  const serverMax = 5;
  const ids = Array.from({ length: total }, (_, i) => `m${i}`);
  const client = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [name, args] = body.methodCalls[0];
    if (name === "Email/query") {
      const anchor = (args.anchor as string | undefined) ?? null;
      const start = anchor === null ? (args.position ?? 0) : ids.indexOf(anchor) + 1;
      const page = ids.slice(start, start + serverMax); // ignores the requested pageSize
      return new Response(
        JSON.stringify({
          methodResponses: [["Email/query", { ids: page, total, queryState: "Q1" }, "c0"]],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const list = (args.ids as string[]).map((id: string) => ({
      id,
      receivedAt: "2026-01-01T00:00:00Z",
      subject: id,
      keywords: {},
      mailboxIds: { "P-Arc": true },
    }));
    return new Response(
      JSON.stringify({ methodResponses: [["Email/get", { list, state: "J1" }, "c0"]] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const r = await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0 });
  assert.equal(r.fetched, total, "a short first page must not truncate the walk");
  assert.equal(r.complete, true);
  assert.equal(getSyncState(d, "personal", "walk"), "done");
  const { c } = d.prepare("SELECT count(*) AS c FROM emails").get() as any;
  assert.equal(c, total, "every message must be walked despite every page being short");
  d.close();
});

test("pages by ANCHOR, not by position", async () => {
  const d = db();
  const { client, seen } = fakeServer(60);
  await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0 });
  // The first page has no anchor; every later page must carry one, or messages
  // sharing a second get skipped.
  assert.equal(seen[0]!.anchor, null);
  assert.ok(seen.length > 1);
  for (const s of seen.slice(1)) assert.notEqual(s.anchor, null, "later pages must use an anchor");
  d.close();
});

test("anchorNotFound falls back and the walk still completes", async () => {
  const d = db();
  const { client } = fakeServer(60, { anchorMissingOnce: true });
  const r = await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0 });
  assert.equal(r.complete, true, "a deleted anchor must not end the walk");
  const { c } = d.prepare("SELECT count(*) AS c FROM emails").get() as any;
  assert.equal(c, 60);
  d.close();
});

test("the Email/changes cursor is captured BEFORE the walk begins", async () => {
  const d = db();
  const { client } = fakeServer(40);
  await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0 });
  // Captured up front, or changes during a multi-hour backfill are never seen.
  assert.equal(getSyncState(d, "personal", "email"), "J1");
  d.close();
});

test("a walk resumes from its stored anchor rather than restarting", async () => {
  const d = db();
  const { client, seen } = fakeServer(100);
  // Simulate an interrupted walk that got as far as m39.
  const { setSyncState } = await import("../src/core/mutations.ts");
  setSyncState(d, "personal", "walk", "m39");

  await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0 });
  assert.equal(seen[0]!.anchor, "m39", "an interruption at hour three is not a restart");
  d.close();
});

test("an old bare-id stored state (pre-finding-6) still resumes, with position 0", async () => {
  const d = db();
  const { client, seen } = fakeServer(60);
  setSyncState(d, "personal", "walk", "m19"); // old format: no "|position"
  await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0 });
  assert.equal(seen[0]!.anchor, "m19", "an old-format stored id must still resume the anchor");
  d.close();
});

test("anchorNotFound on a RESUMED walk falls back to the restored position, not 0 (finding 6)", async () => {
  // Reviewer-found regression: `position` reflects everything walked so far
  // only WITHIN one call -- it starts back at 0 on every call, while `anchor`
  // is restored from sync_state. A restart mid-walk plus a deleted anchor
  // re-walks the entire account, because the position the anchorNotFound
  // fallback uses no longer means what its comment claims.
  //
  // Simulate: a first walkArchive() call gets through 2 pages (ids m0..m39,
  // last anchor "m39", true position 40) and then the process dies -- a
  // network fetch throws mid-walk, well before the archive is done. The
  // NEXT call resumes from sync_state and immediately hits anchorNotFound
  // (the anchor was deleted while the process was down). The positional
  // fallback query it issues must ask for position 40, not 0 -- otherwise
  // it silently re-walks ids m0..m39 it already has.
  const d = db();
  const total = 100;
  const ids = Array.from({ length: total }, (_, i) => `m${i}`);

  function metadataResponse(pageIds: string[]) {
    const list = pageIds.map((id) => ({
      id,
      receivedAt: "2026-01-01T00:00:00Z",
      subject: id,
      keywords: {},
      mailboxIds: { "P-Arc": true },
    }));
    return new Response(
      JSON.stringify({ methodResponses: [["Email/get", { list, state: "J1" }, "c0"]] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  let queryCount = 0;
  const crashingClient = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [name, args] = body.methodCalls[0];
    if (name === "Email/query") {
      queryCount += 1;
      if (queryCount === 3) throw new Error("simulated process crash");
      const anchor = (args.anchor as string | undefined) ?? null;
      const start = anchor === null ? (args.position ?? 0) : ids.indexOf(anchor) + 1;
      const page = ids.slice(start, start + (args.limit ?? 50));
      return new Response(
        JSON.stringify({
          methodResponses: [["Email/query", { ids: page, total, queryState: "Q1" }, "c0"]],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return metadataResponse(args.ids as string[]);
  });

  await assert.rejects(
    () => walkArchive(d, crashingClient, "personal", { pageSize: 20, paceMs: 0 }),
    /simulated process crash/,
  );
  assert.equal(getSyncState(d, "personal", "walk"), "m39|40", "state must carry BOTH anchor and position");

  // Resume: the anchor was deleted server-side while the process was down.
  const seenFallbackPositions: number[] = [];
  const resumedClient = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [name, args] = body.methodCalls[0];
    if (name === "Email/query") {
      const anchor = (args.anchor as string | undefined) ?? null;
      if (anchor === "m39") {
        return new Response(
          JSON.stringify({ methodResponses: [["error", { type: "anchorNotFound" }, "c0"]] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const start = anchor === null ? (args.position ?? 0) : ids.indexOf(anchor) + 1;
      if (anchor === null) seenFallbackPositions.push(args.position as number);
      const page = ids.slice(start, start + (args.limit ?? 50));
      return new Response(
        JSON.stringify({
          methodResponses: [["Email/query", { ids: page, total, queryState: "Q1" }, "c0"]],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return metadataResponse(args.ids as string[]);
  });

  const r = await walkArchive(d, resumedClient, "personal", { pageSize: 20, paceMs: 0 });
  assert.equal(r.complete, true);
  assert.equal(
    seenFallbackPositions[0],
    40,
    `the fallback must resume from position 40 (already walked), got ${JSON.stringify(seenFallbackPositions)}`,
  );
  d.close();
});

test("the walk anchor is cleared once the archive is complete", async () => {
  const d = db();
  const { client } = fakeServer(30);
  await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0 });
  assert.equal(getSyncState(d, "personal", "walk"), "done");
  d.close();
});

test("a server that repeats a page aborts the walk instead of looping forever", async () => {
  const d = db();
  const page = Array.from({ length: 20 }, (_, i) => `m${i}`);
  const client = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [name, args] = body.methodCalls[0];
    if (name === "Email/query") {
      return new Response(
        JSON.stringify({
          methodResponses: [["Email/query", { ids: page, total: 999, queryState: "Q1" }, "c0"]],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const list = (args.ids as string[]).map((id) => ({
      id,
      receivedAt: "2026-01-01T00:00:00Z",
      subject: id,
      keywords: {},
      mailboxIds: { "P-Arc": true },
    }));
    return new Response(
      JSON.stringify({ methodResponses: [["Email/get", { list, state: "J1" }, "c0"]] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  await assert.rejects(() => walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0 }), /no progress/);
  // The critical half: a repeated page must NOT be recorded as a finished archive.
  assert.notEqual(getSyncState(d, "personal", "walk"), "done");
  d.close();
});

test("pacing sleeps between requests at the configured interval", async () => {
  const d = db();
  const { client } = fakeServer(60);
  const { sleep, calls } = recordingSleep();
  await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 77, sleep });
  // 60 messages at pageSize 20 is 3 pages -- at least one query + one get
  // each, so at least 6 paced requests.
  assert.ok(calls.length >= 6, `expected several paced requests, got ${calls.length}`);
  for (const ms of calls) assert.equal(ms, 77, "every pacing sleep must use the configured interval");
  d.close();
});

test("a 429 is waited out and the walk COMPLETES rather than aborting", async () => {
  const d = db();
  // The very first Email/query calls are rate-limited twice running; the
  // walk must still land every message once the server relents.
  const { client } = fakeServerWithRateLimiting(60, { rateLimitQueryCount: 2, retryAfterHeader: "0" });
  const { sleep } = recordingSleep();
  const r = await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0, sleep });
  assert.equal(r.fetched, 60);
  assert.equal(r.complete, true);
  const { c } = d.prepare("SELECT count(*) AS c FROM emails").get() as any;
  assert.equal(c, 60, "a 429 must not end the walk with messages missing");
  d.close();
});

test("the rate-limit wait honours the server's Retry-After when present", async () => {
  const d = db();
  const { client } = fakeServerWithRateLimiting(20, { rateLimitQueryCount: 1, retryAfterHeader: "3" });
  const { sleep, calls } = recordingSleep();
  await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 10, sleep });
  assert.ok(
    calls.includes(3000),
    `expected a 3000ms wait for "Retry-After: 3", got ${JSON.stringify(calls)}`,
  );
  d.close();
});

test("the rate-limit wait falls back to a default when Retry-After is absent", async () => {
  const d = db();
  const { client } = fakeServerWithRateLimiting(20, { rateLimitQueryCount: 1 });
  const { sleep, calls } = recordingSleep();
  await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 10, sleep });
  assert.ok(
    calls.includes(DEFAULT_RETRY_AFTER_MS),
    `expected the default fallback wait (${DEFAULT_RETRY_AFTER_MS}ms), got ${JSON.stringify(calls)}`,
  );
  d.close();
});

test("an absurd Retry-After is capped, not honoured verbatim", async () => {
  const d = db();
  // 999,999 seconds is ~11.5 days.
  const { client } = fakeServerWithRateLimiting(20, { rateLimitQueryCount: 1, retryAfterHeader: "999999" });
  const { sleep, calls } = recordingSleep();
  await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 10, sleep });
  assert.ok(
    calls.includes(MAX_RETRY_AFTER_MS),
    `expected the wait capped at ${MAX_RETRY_AFTER_MS}ms, got ${JSON.stringify(calls)}`,
  );
  assert.ok(!calls.some((ms) => ms > MAX_RETRY_AFTER_MS), "no wait may exceed the cap");
  d.close();
});

test("consecutive rate limits beyond the bound throw rather than waiting forever", async () => {
  const d = db();
  // Always 429s -- comfortably more than MAX_CONSECUTIVE_RATE_LIMITS.
  const { client } = fakeServerWithRateLimiting(20, {
    rateLimitQueryCount: MAX_CONSECUTIVE_RATE_LIMITS + 10,
    retryAfterHeader: "0",
  });
  const { sleep } = recordingSleep();
  await assert.rejects(
    () => walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0, sleep }),
    /rate-limited/,
  );
  d.close();
});

test("a 429 retry of the same page does not trip the repeated-page guard, but a genuine repeat still does", async () => {
  // Direction 1: the query for the walk's first page is rate-limited once,
  // then succeeds with the SAME page it would always have returned. This
  // must not look like "the server made no progress" to walkArchive's guard.
  const d = db();
  const { client } = fakeServerWithRateLimiting(40, { rateLimitQueryCount: 1, retryAfterHeader: "0" });
  const { sleep } = recordingSleep();
  const r = await walkArchive(d, client, "personal", { pageSize: 20, paceMs: 0, sleep });
  assert.equal(r.complete, true, "a 429 retry of the same page must not trip the progress guard");
  assert.equal(getSyncState(d, "personal", "walk"), "done");
  d.close();

  // Direction 2: a genuinely repeated page (a server bug, not rate limiting)
  // must still trip the guard -- even with pacing and an injected sleep in
  // the mix, so the guard is not accidentally weakened by this change.
  const d2 = db();
  const page = Array.from({ length: 20 }, (_, i) => `m${i}`);
  const repeatingClient = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [name, args] = body.methodCalls[0];
    if (name === "Email/query") {
      return new Response(
        JSON.stringify({
          methodResponses: [["Email/query", { ids: page, total: 999, queryState: "Q1" }, "c0"]],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const list = (args.ids as string[]).map((id) => ({
      id,
      receivedAt: "2026-01-01T00:00:00Z",
      subject: id,
      keywords: {},
      mailboxIds: { "P-Arc": true },
    }));
    return new Response(
      JSON.stringify({ methodResponses: [["Email/get", { list, state: "J1" }, "c0"]] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const { sleep: sleep2 } = recordingSleep();
  await assert.rejects(
    () => walkArchive(d2, repeatingClient, "personal", { pageSize: 20, paceMs: 0, sleep: sleep2 }),
    /no progress/,
  );
  assert.notEqual(getSyncState(d2, "personal", "walk"), "done");
  d2.close();
});
