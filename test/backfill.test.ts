import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/core/db.ts";
import { storeEmails } from "../src/core/mutations.ts";
import { backfillBodies, collectBody, extractPlainText, MAX_BODY_BYTES, MAX_BODY_BATCH } from "../src/core/corpus.ts";
import { JmapClient } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import { searchEmails } from "../src/core/queries.ts";
import { HttpStatusError } from "../src/core/failures.ts";
import { tempDbPath } from "./tmpdir.ts";

const session = resolveSession("personal", personalSession);

function db() {
  const d = openDb(tempDbPath());
  storeEmails(
    d,
    "personal",
    ["a", "b", "c"].map((id) => ({
      id,
      receivedAt: "2026-01-01T00:00:00Z",
      subject: `S ${id}`,
      keywords: {},
      mailboxIds: { "P-Arc": true },
      from: [{ email: "ada@example.com" }],
    })),
  );
  return d;
}

/** An injectable Sleep that never really waits, and records every call. */
function recordingSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
  };
  return { sleep, calls };
}

function serverReturning(bodies: Record<string, string | null>) {
  return new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [, args] = body.methodCalls[0];
    const list = (args.ids as string[]).map((id) => {
      if (bodies[id] === null) throw new Error(`poison message ${id}`);
      return { id, textBody: [{ partId: "1" }], bodyValues: { "1": { value: bodies[id] ?? "" } } };
    });
    return new Response(
      JSON.stringify({ methodResponses: [["Email/get", { list }, "c0"]] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

/**
 * A client whose session advertises a custom maxObjectsInGet, backed by a
 * server that always answers every id with a trivial body and records the
 * size of every Email/get batch it was asked for -- for finding 5's tests,
 * which are about the batch SIZE the client chooses, not the bodies.
 */
function clientWithMaxObjectsInGet(maxObjectsInGet: number) {
  const s = resolveSession("personal", {
    ...personalSession,
    capabilities: {
      ...personalSession.capabilities,
      "urn:ietf:params:jmap:core": { maxObjectsInGet, maxCallsInRequest: 64 },
    },
  });
  const batchSizes: number[] = [];
  const client = new JmapClient(s, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [, args] = body.methodCalls[0];
    const ids = args.ids as string[];
    batchSizes.push(ids.length);
    const list = ids.map((id) => ({
      id,
      textBody: [{ partId: "1" }],
      bodyValues: { "1": { value: `body for ${id}` } },
    }));
    return new Response(
      JSON.stringify({ methodResponses: [["Email/get", { list }, "c0"]] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { client, batchSizes };
}

test("the body backfill batch size defaults from the session, not a hardcoded 50 (finding 5)", async () => {
  // Spec 5.6: page sizes must come from the session's maxObjectsInGet. A
  // session that advertises a small cap (3) must never see a batch larger
  // than that -- the old hardcoded BODY_BATCH=50 would have asked for every
  // one of these 7 rows in a single request, ignoring the session entirely.
  const d = db();
  storeEmails(
    d,
    "personal",
    Array.from({ length: 4 }, (_, i) => ({
      id: `extra${i}`,
      receivedAt: "2026-01-01T00:00:00Z",
      subject: `extra ${i}`,
      keywords: {},
      mailboxIds: { "P-Arc": true },
    })),
  ); // 3 from db() + 4 more = 7 rows, session cap = 3
  const { client, batchSizes } = clientWithMaxObjectsInGet(3);
  const r = await backfillBodies(d, client, "personal", { paceMs: 0 });
  assert.equal(r.written, 7);
  assert.ok(batchSizes.length >= 3, `expected several batches, got ${JSON.stringify(batchSizes)}`);
  for (const n of batchSizes) assert.ok(n <= 3, `batch of ${n} exceeds the session's maxObjectsInGet=3`);
  d.close();
});

test("the derived batch size is clamped to MAX_BODY_BATCH, not handed the session's cap verbatim", async () => {
  // A generous server (Fastmail's live maxObjectsInGet is 4096) must not turn
  // into a single request for thousands of full message BODIES -- a much
  // larger response than an arbitrary Email/get. MAX_BODY_BATCH bounds it.
  const d = db();
  const many = Array.from({ length: MAX_BODY_BATCH + 50 }, (_, i) => ({
    id: `m${i}`,
    receivedAt: "2026-01-01T00:00:00Z",
    subject: `m ${i}`,
    keywords: {},
    mailboxIds: { "P-Arc": true },
  }));
  storeEmails(d, "personal", many);
  const { client, batchSizes } = clientWithMaxObjectsInGet(4096);
  const r = await backfillBodies(d, client, "personal", { paceMs: 0 });
  // db() already seeded 3 rows (a, b, c); "many" adds MAX_BODY_BATCH + 50 more.
  assert.equal(r.written, MAX_BODY_BATCH + 50 + 3);
  assert.equal(batchSizes[0], MAX_BODY_BATCH, `expected the first batch clamped to ${MAX_BODY_BATCH}, got ${batchSizes[0]}`);
  for (const n of batchSizes) assert.ok(n <= MAX_BODY_BATCH, `batch of ${n} exceeds MAX_BODY_BATCH`);
  d.close();
});

test("an explicit batchSize option still overrides the session-derived default", async () => {
  const d = db();
  const { client, batchSizes } = clientWithMaxObjectsInGet(4096);
  await backfillBodies(d, client, "personal", { paceMs: 0, batchSize: 1 });
  for (const n of batchSizes) assert.equal(n, 1, "an explicit batchSize must win over the session default");
  d.close();
});

test("writes body text and it becomes searchable", async () => {
  const d = db();
  const r = await backfillBodies(d, serverReturning({ a: "quick brown fox", b: "x", c: "y" }), "personal", { paceMs: 0 });
  assert.equal(r.written, 3);
  assert.equal(searchEmails(d, "brown").rows[0]!.id, "a");
  d.close();
});

test("a message with no body is written as '' and never retried", async () => {
  const d = db();
  await backfillBodies(d, serverReturning({ a: "", b: "", c: "" }), "personal", { paceMs: 0 });
  const rows = d.prepare("SELECT body_text FROM emails").all() as any[];
  for (const r of rows) assert.equal(r.body_text, "", "NULL here means the loop never terminates");

  // A second pass must find nothing left to do.
  const again = await backfillBodies(d, serverReturning({}), "personal", { paceMs: 0 });
  assert.equal(again.written, 0);
  d.close();
});

test("one poisonous message does not stall the account", async () => {
  const d = db();
  const client = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const ids = body.methodCalls[0][1].ids as string[];
    if (ids.length > 1) throw new Error("batch failed");   // force per-item retry
    if (ids[0] === "b") throw new Error("poison");
    return new Response(
      JSON.stringify({
        methodResponses: [
          ["Email/get", { list: [{ id: ids[0], textBody: [{ partId: "1" }], bodyValues: { "1": { value: "ok" } } }] }, "c0"],
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const r = await backfillBodies(d, client, "personal", { paceMs: 0 });
  assert.equal(r.written, 2);
  assert.equal(r.failed, 1);
  d.close();
});

test("an auth failure mid-batch aborts instead of blanking the rest of the account (finding 1)", async () => {
  // Reviewer-proven regression: the old code wrote '' for ANY per-item
  // exception, so a 401 mid-walk (tokens are shared with another client,
  // rotation is a realistic trigger) blanked every remaining row -- and ''
  // is never selected by unfetchedIds() again, so nothing ever retries.
  // Rows a, b, c start out NULL (see db()). "a" fetches fine; "b" 401s.
  const d = db();
  const client = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const ids = body.methodCalls[0][1].ids as string[];
    if (ids.length > 1) throw new Error("batch failed"); // force per-item retry
    if (ids[0] === "b") throw new HttpStatusError("unauthorized", 401);
    return new Response(
      JSON.stringify({
        methodResponses: [
          ["Email/get", { list: [{ id: ids[0], textBody: [{ partId: "1" }], bodyValues: { "1": { value: "ok" } } }] }, "c0"],
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  await assert.rejects(
    () => backfillBodies(d, client, "personal", { paceMs: 0 }),
    /unauthorized/,
    "an auth failure must propagate, not be swallowed as a poisoned message",
  );

  // Row order among ties on received_at is not something to depend on, so
  // assert the invariant that actually matters: nothing was blanked to ''
  // (unfetchedIds() would never select it again), and "b" itself -- the
  // message that 401'd -- was never written at all, still NULL and so still
  // retryable on the next pass.
  const rows = d.prepare("SELECT id, body_text FROM emails").all() as { id: string; body_text: string | null }[];
  for (const r of rows) {
    assert.notEqual(r.body_text, "", `row ${r.id} was blanked to '' by a request-level failure`);
  }
  const b = rows.find((r) => r.id === "b")!;
  assert.equal(b.body_text, null, "the 401'd message must stay NULL, not be written at all");
  d.close();
});

test("backfillBodies paces its requests at the configured interval", async () => {
  const d = db();
  const { sleep, calls } = recordingSleep();
  await backfillBodies(d, serverReturning({ a: "x", b: "y", c: "z" }), "personal", {
    paceMs: 55,
    sleep,
  });
  assert.ok(calls.length > 0, "expected at least one paced request");
  for (const ms of calls) assert.equal(ms, 55);
  d.close();
});

test("backfillBodies waits out a 429 and still writes every body, not just '' failures", async () => {
  const d = db();
  let rateLimited = false;
  const client = new JmapClient(session, "t", async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const [, args] = body.methodCalls[0];
    if (!rateLimited) {
      rateLimited = true;
      return new Response("rate limited", {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }
    const list = (args.ids as string[]).map((id: string) => ({
      id,
      textBody: [{ partId: "1" }],
      bodyValues: { "1": { value: `body for ${id}` } },
    }));
    return new Response(
      JSON.stringify({ methodResponses: [["Email/get", { list }, "c0"]] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const { sleep } = recordingSleep();
  const r = await backfillBodies(d, client, "personal", { paceMs: 0, sleep });
  assert.equal(r.written, 3, "a 429 must be retried, not counted as a failure");
  assert.equal(r.failed, 0);
  const rows = d.prepare("SELECT body_text FROM emails ORDER BY id").all() as any[];
  for (const row of rows) assert.notEqual(row.body_text, "", "the real body must survive the retry");
  d.close();
});

test("a body is truncated at MAX_BODY_BYTES", () => {
  const huge = "x".repeat(MAX_BODY_BYTES + 5000);
  assert.equal(extractPlainText({ textBody: huge }).length, MAX_BODY_BYTES);
});

test("html is reduced to text without a backtracking regex", () => {
  // 75k of whitespace inside one tag is a real payload (research.md). This must
  // return promptly; a backtracking quantifier takes seconds.
  const evil = `<p${" ".repeat(75_000)}>hello</p>`;
  const started = Date.now();
  const out = extractPlainText({ htmlBody: evil });
  assert.ok(Date.now() - started < 500, "the extraction regex must be linear");
  assert.match(out, /hello/);

  // Second, distinct pathological input: many UNTERMINATED <script tags. The
  // ORIGINAL script/style stripper `<(script|style)\b[\s\S]*?<\/\1>` used a
  // lazy quantifier, so for each unterminated `<script` it could scan all the
  // way to end-of-input before failing to find a matching `</script>` --
  // quadratic in the number of unterminated tags. Measured before the fix
  // (Fix round 1, task-11-report.md): this exact construction -- 5,000
  // unterminated `<script` tags padded to ~335KB, matching the brief's
  // instruction to build "a few hundred KB" -- took ~600-650ms.
  //
  // htmlToText is now a single forward scan (no backtracking possible by
  // construction), so this bound is tight: a linear scan of ~335KB should
  // cost low single-digit milliseconds, not hundreds. 250ms leaves headroom
  // for slow CI, not headroom for quadratic behaviour to sneak back in.
  const evilScript = "<script".repeat(5000) + "y ".repeat(150_000);
  const startedScript = Date.now();
  extractPlainText({ htmlBody: evilScript });
  const elapsedScript = Date.now() - startedScript;
  assert.ok(
    elapsedScript < 250,
    `unterminated <script> stripping took ${elapsedScript}ms -- must be linear, see task-11-report.md`,
  );
});

test("script and style CONTENT is dropped, never emitted as searchable text", () => {
  assert.equal(extractPlainText({ htmlBody: "<script>alert(1)</script>hello" }), "hello");
  assert.equal(
    extractPlainText({ htmlBody: "<style>body{color:red}</style>hello<div>world</div>" }),
    "hello world",
  );
});

test("plain text is preferred over html when both are present", () => {
  assert.equal(extractPlainText({ textBody: "plain", htmlBody: "<p>rich</p>" }), "plain");
});

test("an orphan closing tag must not swallow legitimate message text (Fix round 2)", () => {
  // Reviewer-found regression in Fix round 1's forward scan: it stripped the
  // leading '/' from a tag's name BEFORE deciding whether the tag is an
  // OPENING <script>/<style>, so a stray </script> or </style> with no
  // matching opener was treated as an opener -- and everything up to the
  // next same-named close (or end of input) was discarded as element
  // content. A quoted HTML/code snippet with a lone closing tag is entirely
  // normal in mail Robin receives, so this was silent data loss from the
  // search index, not a corner case.
  const out = extractPlainText({
    htmlBody: "<div>hi</script>bye<script>ignored</script>tail",
  });
  // "bye" is the text the bug ate -- it sits between the orphan </script>
  // and the next real <script>...</script> pair, and must survive.
  assert.ok(out.includes("hi"), `expected "hi" to survive, got ${JSON.stringify(out)}`);
  assert.ok(out.includes("bye"), `expected "bye" to survive, got ${JSON.stringify(out)}`);
  assert.ok(out.includes("tail"), `expected "tail" to survive, got ${JSON.stringify(out)}`);
  // "ignored" is genuine <script> content (this time behind a real opening
  // tag) and must still be dropped.
  assert.ok(!out.includes("ignored"), `expected script content to be dropped, got ${JSON.stringify(out)}`);
});

test("an orphan closing tag inside a nested-looking <script> must not swallow trailing text either", () => {
  // Second reproduction from the same regression: a spurious extra
  // </script> after a real <script>...</script> pair must fall through as
  // an ordinary (harmless) closing tag, not re-open a skip region and eat
  // "hello".
  const out = extractPlainText({
    htmlBody: "<script><script>evil</script>evil2</script>hello",
  });
  assert.ok(out.includes("hello"), `expected "hello" to survive, got ${JSON.stringify(out)}`);
  // "evil" (the actual dropped script content, up to the FIRST </script>)
  // must never appear as its own token. "evil2" is legitimate text that
  // follows the closed script element under real HTML semantics -- script
  // elements do not nest, so the first </script> literal ends the element
  // regardless of the second <script> that appeared inside it -- and is
  // correctly NOT script content; \bevil\b (not \bevil2\b) is the precise
  // check for "did script content leak", not a ban on the substring "evil".
  assert.ok(
    !/\bevil\b/.test(out),
    `script content leaked into searchable text: ${JSON.stringify(out)}`,
  );
});

test("a single-level scanner does not nest <script>, but must not leak script content either", () => {
  // The reviewer's own nesting case: with a single-level scanner the inner
  // <script> is not tracked specially -- the outer script's content is
  // simply "everything up to the first </script>", which is also correct
  // real-HTML behaviour (script elements cannot nest). "hello" -- the text
  // after that first close -- must survive, and "evil" must never leak.
  const out = extractPlainText({ htmlBody: "<script><script>evil</script>hello" });
  assert.equal(out, "hello");
});

test("a self-closing <script/> or <style/> opens nothing and must not eat the rest of the message (Fix round 3)", () => {
  // `<script/>` has a TRAILING slash, not a leading one -- isClosing (Fix
  // round 2) is false for it, so without a separate check it is classified
  // as an OPENING tag. There is no </script> anywhere afterward, so the scan
  // hit the "unterminated element: drop the remainder" branch and discarded
  // the entire rest of the message -- not just the (nonexistent) element
  // content. One stray self-closing tag in a message was enough to erase it
  // from search.
  assert.equal(extractPlainText({ htmlBody: "<script/>hello" }), "hello");
  assert.equal(extractPlainText({ htmlBody: "<style/>world" }), "world");
});

test("a genuinely unterminated <script> still drops the remainder, and this is deliberate", () => {
  // Pins down the considered choice recorded in htmlToText: an opening
  // <script>/<style> with NO closing tag anywhere in the message drops
  // everything from that point on, rather than falling through and risking
  // script/style CONTENT being emitted into the search index. Losing
  // trailing text is judged the better failure of the two. If this test
  // ever fails because "evil" starts appearing in the output, that is a
  // regression toward indexing script bodies, not a fix -- do not "fix" it
  // by making the scan fall through here.
  assert.equal(extractPlainText({ htmlBody: "<script>evil" }), "");
});

test("a write path that makes no progress rejects, it does not hang the process", () => {
  // Proves the progress guard added in Fix round 1. Run as a CHILD PROCESS
  // with an OS-level timeout (see test/fixtures/backfill-progress-guard.ts
  // for why an in-process setTimeout race is not safe here): if the guard is
  // ever removed, this test fails within the timeout instead of hanging the
  // whole suite forever.
  const fixture = fileURLToPath(new URL("./fixtures/backfill-progress-guard.ts", import.meta.url));
  let stdout: string;
  let status = 0;
  try {
    stdout = execFileSync("node", [fixture], { encoding: "utf8", timeout: 5000 });
  } catch (err) {
    const e = err as { status?: number | null; signal?: string | null; stdout?: string };
    assert.notEqual(
      e.signal,
      "SIGTERM",
      "the fixture was killed by the timeout -- the progress guard did not fire and the loop hung",
    );
    stdout = e.stdout ?? "";
    status = e.status ?? 1;
  }
  assert.equal(status, 1, `expected the fixture to exit 1 (rejected); got exit ${status}: ${stdout}`);
  assert.match(stdout, /REJECTED: body backfill made no progress/);
});

test("a same-SET-different-order pass still trips the progress guard (finding 7)", () => {
  // The old guard compared only (after.length, after[0]) against
  // (before.length, before[0]). Rows tied on received_at (unfetchedIds'
  // ORDER BY) have no guaranteed secondary order, so a broken write path
  // that happens to come back in a different row order between the two
  // calls -- exact same SET of ids, different leading element -- would slip
  // past a first-id-only check and spin forever. The full-set comparison
  // must not be fooled by order. Same child-process contract as the sibling
  // test above, and for the same reason (an all-microtask loop can starve
  // Node's timer phase, so only an external process kill is a safe timeout).
  const fixture = fileURLToPath(
    new URL("./fixtures/backfill-progress-guard-reorder.ts", import.meta.url),
  );
  let stdout: string;
  let status = 0;
  try {
    stdout = execFileSync("node", [fixture], { encoding: "utf8", timeout: 5000 });
  } catch (err) {
    const e = err as { status?: number | null; signal?: string | null; stdout?: string };
    assert.notEqual(
      e.signal,
      "SIGTERM",
      "the fixture was killed by the timeout -- a same-set-different-order pass fooled the guard and the loop hung",
    );
    stdout = e.stdout ?? "";
    status = e.status ?? 1;
  }
  assert.equal(status, 1, `expected the fixture to exit 1 (rejected); got exit ${status}: ${stdout}`);
  assert.match(stdout, /REJECTED: body backfill made no progress/);
});

test("giving up on a sustained RATE LIMIT must not blank the batch (I1)", async () => {
  // pacedRequest's give-up throw was a bare Error, which classifies as
  // "unknown" -- the one classification backfillBodies treats as
  // message-specific. So the exact request-level fault the poison-pill guard
  // exists to catch took the poison-pill branch and wrote '' to every id.
  const d = db();
  const client = new JmapClient(session, "t", async () => new Response("slow down", {
    status: 429, headers: { "retry-after": "0" },
  }));

  await assert.rejects(
    () => backfillBodies(d, client, "personal", { paceMs: 0, sleep: async () => {} }),
    /rate-limited/,
    "a sustained rate limit must propagate, not poison the batch",
  );

  const rows = d.prepare("SELECT id, body_text FROM emails").all() as { id: string; body_text: string | null }[];
  for (const r of rows) {
    assert.equal(r.body_text, null, `row ${r.id} was blanked to '' by a rate limit`);
  }
  d.close();
});

test("a JMAP METHOD ERROR is request-level too, and must not blank the batch (I1)", async () => {
  // client.ts turns every method-level error -- serverFail, rateLimit,
  // requestTooLarge -- into Error("JMAP method error: <type>"), which also
  // classifies as "unknown".
  const d = db();
  const client = new JmapClient(session, "t", async () => new Response(
    JSON.stringify({ methodResponses: [["error", { type: "serverFail" }, "c0"]] }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));

  await assert.rejects(
    () => backfillBodies(d, client, "personal", { paceMs: 0, sleep: async () => {} }),
    /JMAP method error: serverFail/,
  );

  const rows = d.prepare("SELECT id, body_text FROM emails").all() as { id: string; body_text: string | null }[];
  for (const r of rows) {
    assert.equal(r.body_text, null, `row ${r.id} was blanked to '' by a serverFail`);
  }
  d.close();
});

// -- collectBody classifies on the part TYPE, not on the list name ---------

test("🚨 an HTML-ONLY message does not store raw markup as its plaintext", () => {
  // JMAP's `textBody` is "the parts a client should display as the body",
  // and for an HTML-only message that IS the text/html part. Reading it as
  // plaintext put `<!DOCTYPE html>` and stylesheet text into body_text for
  // 5,736 live messages -- into the FTS5 index, every preview, and the
  // reading pane's plaintext fallback.
  const part = { partId: "1", type: "text/html" };
  const out = collectBody({
    textBody: [part],
    htmlBody: [part],
    bodyValues: { "1": { value: "<style>p{color:red}</style><p>Hello there</p>" } },
  });

  assert.equal(out.textBody, "", "the html part must NOT be filed as plaintext");
  assert.match(out.htmlBody!, /Hello there/);
  assert.equal(extractPlainText(out), "Hello there", "and it renders down to text");
});

test("the same part listed in both textBody and htmlBody is not duplicated", () => {
  const part = { partId: "1", type: "text/html" };
  const out = collectBody({
    textBody: [part],
    htmlBody: [part],
    bodyValues: { "1": { value: "<p>once</p>" } },
  });
  assert.equal(out.htmlBody, "<p>once</p>", "not '<p>once</p>\\n<p>once</p>'");
});

test("multipart/alternative still prefers the real text/plain part", () => {
  const out = collectBody({
    textBody: [{ partId: "1", type: "text/plain" }],
    htmlBody: [{ partId: "2", type: "text/html" }],
    bodyValues: { "1": { value: "plain rendition" }, "2": { value: "<p>rich</p>" } },
  });
  assert.equal(out.textBody, "plain rendition");
  assert.equal(out.htmlBody, "<p>rich</p>");
  assert.equal(extractPlainText(out), "plain rendition");
});

test("a part with no declared type is treated as plaintext, as before", () => {
  // JMAP requires `type`, so this only fires for a non-conforming server --
  // and mis-filing genuine plaintext as HTML would strip real `<`
  // characters out of a message that meant them literally.
  const out = collectBody({
    textBody: [{ partId: "1" }],
    bodyValues: { "1": { value: "5 < 6 and a > b" } },
  });
  assert.equal(out.textBody, "5 < 6 and a > b");
});

test("a text/html part listed ONLY under textBody is still rendered down", () => {
  const out = collectBody({
    textBody: [{ partId: "1", type: "text/html" }],
    bodyValues: { "1": { value: "<div>only here</div>" } },
  });
  assert.equal(out.textBody, "");
  assert.equal(extractPlainText(out), "only here");
});

test("an empty body value contributes nothing to either side", () => {
  const out = collectBody({
    textBody: [{ partId: "1", type: "text/plain" }],
    bodyValues: { "1": { value: "" } },
  });
  assert.equal(out.textBody, "");
  assert.equal(out.htmlBody, "");
});

test("a WHOLE HTML DOCUMENT in a declared text/plain part is still rendered down", () => {
  // Some senders declare text/plain and put a full document in it, while
  // also sending a correct text/html part. Confirmed against the live
  // server, not assumed: Email/get reports type "text/plain" for a part
  // whose value begins `<!DOCTYPE HTML PUBLIC ...`. 167 of 37,725 live
  // messages look like this.
  const out = collectBody({
    textBody: [{ partId: "1", type: "text/plain" }],
    bodyValues: { "1": { value: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">\n<html><body><p>Invoice</p></body></html>' } },
  });
  assert.equal(out.textBody, "", "a document is not plaintext, whatever the sender declared");
  assert.equal(extractPlainText(out), "Invoice");
});

test("but a plaintext message that merely QUOTES markup is left alone", () => {
  // This is the line the sniff must not cross: stripping tags out of a
  // developer's mail would lose the very content they would search for.
  const quoted = "Try this:\n\n  <div class=\"row\">hello</div>\n\nDoes that work?";
  const out = collectBody({
    textBody: [{ partId: "1", type: "text/plain" }],
    bodyValues: { "1": { value: quoted } },
  });
  assert.equal(out.textBody, quoted, "a fragment mid-message is a quote, not a document");
  assert.equal(out.htmlBody, "");
});

test("the sniff anchors at the START, so a document quoted mid-message is a quote", () => {
  const out = collectBody({
    textBody: [{ partId: "1", type: "text/plain" }],
    bodyValues: { "1": { value: "Here is what they sent:\n<!DOCTYPE html><html>...</html>" } },
  });
  assert.match(out.textBody!, /^Here is what they sent/);
});

test("a dense run of tags in a declared text/plain part is an HTML body, not a quote", () => {
  // Not every such body starts with a doctype: a Gmail-composed message
  // arrives as `<div>Good evening, <br><br>...`. The threshold (30 element
  // openings) is measured, not guessed -- see looksLikeHtmlDocument.
  // 3 openings + 20 x 2 = 43, comfortably over the measured threshold of 30.
  const gmail = "<div>Good evening, <br><br>" + "<div><span>line</span></div>".repeat(20) + "</div>";
  const out = collectBody({
    textBody: [{ partId: "1", type: "text/plain" }],
    bodyValues: { "1": { value: gmail } },
  });
  assert.equal(out.textBody, "", "a body this dense is markup, whatever it was declared");
  assert.match(extractPlainText(out), /Good evening/);
});

test("a handful of tags does NOT trip the density rule", () => {
  // The 11-30 band on the live archive is legitimate plaintext throughout:
  // markdown newsletters, `<name@host>` addresses, stray `<br>`s. Stripping
  // it would lose real content.
  const plain = "Dear Robin,\n\n" + "See <https://example.com/a> and <br>\n".repeat(8) + "\nThanks";
  const out = collectBody({
    textBody: [{ partId: "1", type: "text/plain" }],
    bodyValues: { "1": { value: plain } },
  });
  assert.equal(out.textBody, plain);
  assert.equal(out.htmlBody, "");
});
