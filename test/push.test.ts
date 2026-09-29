import { test } from "node:test";
import assert from "node:assert/strict";
import { startPush, expandEventSourceUrl, PUSH_MAX_BACKOFF_MS } from "../src/core/push.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import { inspect } from "node:util";

const session = resolveSession("personal", personalSession);

/** A stream that emits `body` then closes after `ms` of simulated time. */
function streamOnce(body: string): Response {
  return new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("the event-source template is expanded, never hand-built", () => {
  const u = expandEventSourceUrl(session);
  assert.ok(!u.includes("{"), "every placeholder must be substituted");
  assert.match(u, /types=/);
});

test("a StateChange notifies with the account id", async () => {
  const seen: string[] = [];
  const ac = new AbortController();
  let n = 0;
  await startPush(session, "t", {
    signal: ac.signal,
    now: () => n,
    sleep: async () => { n += 1000; if (n > 3000) ac.abort(); },
    fetcher: async () => streamOnce(
      `event: state\ndata: {"changed":{"u02214062":{"Email":"J1"}},"type":"connect"}\n\n`,
    ),
    onStateChange: (id) => { seen.push(id); },
  });
  assert.ok(seen.includes("u02214062"));
});

test("BACKOFF IS FORGIVEN ONLY BY A CONNECTION THAT LASTED", async () => {
  // Fastmail hangs up after ~1.2s. Resetting the backoff whenever a connection
  // OPENS turns this into ~27 connections per minute per account, forever.
  const waits: number[] = [];
  const ac = new AbortController();
  let clock = 0;
  await startPush(session, "t", {
    signal: ac.signal,
    durableMs: 5000,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
      if (waits.length >= 5) ac.abort();
    },
    // Every connection opens successfully and dies 1.2s later -- the real
    // Fastmail behaviour.
    fetcher: async () => { clock += 1200; return streamOnce(""); },
    onStateChange: () => {},
  });
  assert.ok(waits.length >= 4);
  for (let i = 1; i < waits.length; i += 1) {
    assert.ok(waits[i]! > waits[i - 1]!,
      `backoff must grow across short-lived connections, saw ${JSON.stringify(waits)}`);
  }
});

test("a connection that lasted DOES reset the backoff", async () => {
  // After a connection that lasted, the next reconnect should be prompt --
  // the whole point of forgiving the backoff is to recover quickly once
  // things are working again, not to make a healthy connection wait out the
  // longest backoff seen so far.
  const waits: number[] = [];
  const ac = new AbortController();
  let clock = 0;
  let call = 0;
  await startPush(session, "t", {
    signal: ac.signal,
    durableMs: 5000,
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; if (waits.length >= 4) ac.abort(); },
    fetcher: async () => {
      call += 1;
      clock += call === 3 ? 30_000 : 1200;   // the third connection is long-lived
      return streamOnce("");
    },
    onStateChange: () => {},
  });
  // waits[2] is the wait immediately AFTER the long-lived third connection.
  // It must have dropped back to the base, not merely be smaller than some
  // later value.
  assert.equal(waits[2], 1000, `a durable connection must reset the backoff to base, saw ${JSON.stringify(waits)}`);
  assert.ok(waits[2]! < waits[1]!, "and that is a drop from the grown backoff before it");
});

test("backoff is capped", async () => {
  const waits: number[] = [];
  const ac = new AbortController();
  let clock = 0;
  await startPush(session, "t", {
    signal: ac.signal,
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; if (waits.length >= 15) ac.abort(); },
    fetcher: async () => { clock += 10; return streamOnce(""); },
    onStateChange: () => {},
  });
  assert.ok(Math.max(...waits) <= PUSH_MAX_BACKOFF_MS);
});

test("a fetch that throws is treated as a short connection, not a crash", async () => {
  const ac = new AbortController();
  let n = 0;
  await startPush(session, "t", {
    signal: ac.signal,
    now: () => n,
    sleep: async (ms) => { n += ms; if (n > 5000) ac.abort(); },
    fetcher: async () => { throw new TypeError("fetch failed"); },
    onStateChange: () => {},
  });
  // Reaching here without throwing is the assertion.
  assert.ok(true);
});

test("a token-bearing failure is swallowed without the token reaching a throw or a log", async () => {
  const TOKEN = "super-secret-token-value";
  const logged: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  const realLog = console.log;
  // console.* serialises with util.inspect, which prints an Error's own
  // properties -- including a `request` carrying an Authorization header.
  // Joining String(arg) instead would coerce an Error to "name: message"
  // and could never see the token, which is what made an earlier version
  // of this test vacuous.
  const capture = (...a: unknown[]) => {
    logged.push(a.map((x) => inspect(x, { depth: 6 })).join(" "));
  };
  console.error = capture;
  console.warn = capture;
  console.log = capture;

  const ac = new AbortController();
  let n = 0;
  let rejected: unknown;
  try {
    await startPush(session, TOKEN, {
      signal: ac.signal,
      now: () => n,
      sleep: async (ms) => { n += ms; if (n > 5000) ac.abort(); },
      // A real fetch failure can carry the request -- and the request
      // carries the bearer token in a header. Simulate that precisely.
      fetcher: async () => {
        const err = new Error("fetch failed") as Error & { request?: unknown };
        err.request = { headers: { authorization: `Bearer ${TOKEN}` } };
        throw err;
      },
      onStateChange: () => {},
    });
  } catch (err) {
    rejected = err;
  } finally {
    console.error = realError;
    console.warn = realWarn;
    console.log = realLog;
  }

  // The reader must absorb it: a dropped connection is the normal case.
  assert.equal(rejected, undefined, "startPush must not reject on a transport failure");
  // And nothing it wrote anywhere may carry the token.
  assert.ok(!logged.join("\n").includes(TOKEN), `token leaked to a log: ${logged.join("\n")}`);
});

test("CRLF frames parse -- an SSE stream may end lines with \\r\\n, \\n or \\r", async () => {
  // The whole of C1: the splitter accepted only "\n\n", so a CRLF stream
  // produced ZERO frames forever behind a connection that looked healthy.
  for (const eol of ["\r\n", "\n", "\r"]) {
    const seen: string[] = [];
    const ac = new AbortController();
    let n = 0;
    await startPush(session, "t", {
      signal: ac.signal,
      now: () => n,
      sleep: async () => { n += 1000; if (n > 3000) ac.abort(); },
      fetcher: async () => streamOnce(
        `event: state${eol}data: {"changed":{"u02214062":{"Email":"J1"}}}${eol}${eol}`,
      ),
      onStateChange: (id) => { seen.push(id); },
    });
    assert.ok(seen.includes("u02214062"), `no frame parsed with ${JSON.stringify(eol)} line endings`);
  }
});

test("a frame split across two reads still parses", async () => {
  const seen: string[] = [];
  const ac = new AbortController();
  let n = 0;
  const parts = [`event: state\r\ndata: {"changed":{"u1":{"Email":"J1"}}}\r`, `\n\r\n`];
  await startPush(session, "t", {
    signal: ac.signal,
    now: () => n,
    sleep: async () => { n += 1000; ac.abort(); },
    fetcher: async () => new Response(new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    }), { status: 200 }),
    onStateChange: (id) => { seen.push(id); },
  });
  assert.deepEqual(seen, ["u1"], "a separator arriving in two chunks must not be lost");
});

test("a REFUSED connection is reported, not silently dropped", async () => {
  const statuses: number[] = [];
  const logs: string[] = [];
  const ac = new AbortController();
  let n = 0;
  await startPush(session, "t", {
    signal: ac.signal,
    now: () => n,
    sleep: async (ms) => { n += ms; if (n > 3000) ac.abort(); },
    fetcher: async () => new Response("nope", { status: 401 }),
    onStateChange: () => {},
    onNotOk: (s) => { statuses.push(s); },
    onLog: (m) => { logs.push(m); },
  });
  assert.ok(statuses.includes(401), "a 401 on the event-source URL must be surfaced");
  assert.ok(logs.some((l) => l.includes("401")), "and logged");
});

test("a healthy connection logs open, close and how many frames it saw", async () => {
  const logs: string[] = [];
  const ac = new AbortController();
  let n = 0;
  await startPush(session, "t", {
    signal: ac.signal,
    now: () => n,
    sleep: async (ms) => { n += ms; ac.abort(); },
    fetcher: async () => streamOnce(`data: {"changed":{"u1":{"Email":"J1"}}}\n\n`),
    onStateChange: () => {},
    onLog: (m) => { logs.push(m); },
  });
  assert.ok(logs.some((l) => l.includes("connected")), `expected an open line, saw ${JSON.stringify(logs)}`);
  assert.ok(logs.some((l) => /closed after 1 frame/.test(l)), `expected a frame count, saw ${JSON.stringify(logs)}`);
});

test("row 22: the subscription covers Mailbox, and a StateChange hands over each type's state", async () => {
  assert.match(expandEventSourceUrl(session), /types=Email(%2C|,)Mailbox/);
  const seen: { id: string; changed: Record<string, string> }[] = [];
  const ac = new AbortController();
  let n = 0;
  await startPush(session, "t", {
    signal: ac.signal,
    now: () => n,
    sleep: async () => { n += 1000; if (n > 3000) ac.abort(); },
    fetcher: async () => streamOnce(
      `event: state\ndata: {"changed":{"u02214062":{"Email":"J1","Mailbox":"M7"}}}\n\n`,
    ),
    onStateChange: (id, changed) => { seen.push({ id, changed }); },
  });
  assert.deepEqual(seen[0], { id: "u02214062", changed: { Email: "J1", Mailbox: "M7" } });
});

test("a stream silent past the idle limit is dropped and reconnected; the URL asks for pings", async () => {
  assert.match(expandEventSourceUrl(session), /ping=30/);
  const opens: number[] = [];
  const logs: string[] = [];
  const ac = new AbortController();
  let n = 0;
  await startPush(session, "t", {
    signal: ac.signal,
    now: () => n,
    sleep: async () => { n += 1000; if (opens.length >= 2) ac.abort(); },
    idleMs: 40,
    fetcher: async (_u, init) => {
      opens.push(n);
      // One frame, then silence forever: only the idle watchdog's abort ends it.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"changed":{"u02214062":{"Email":"J1"}}}\n\n`));
          init?.signal?.addEventListener("abort", () => { try { c.error(new Error("aborted")); } catch { /* already closed */ } });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    onStateChange: () => {},
    onLog: (m) => logs.push(m),
  });
  assert.ok(opens.length >= 2, `the silent stream must be dropped and reopened, saw ${opens.length} open(s)`);
  assert.ok(logs.some((l) => /idle for/.test(l)), `the reconnect says why: ${JSON.stringify(logs)}`);
});

test("a stream that keeps sending -- pings count -- is NOT dropped by the idle watchdog", async () => {
  const opens: number[] = [];
  const ac = new AbortController();
  let n = 0;
  await startPush(session, "t", {
    signal: ac.signal,
    now: () => n,
    sleep: async () => { n += 1000; ac.abort(); },
    idleMs: 60,
    fetcher: async () => {
      opens.push(n);
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 20));
            c.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n"));
          }
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    onStateChange: () => {},
  });
  assert.equal(opens.length, 1, "pings every 20ms under a 60ms idle limit keep the stream open until it closes itself");
});

test("a connect that never answers is abandoned after the connect bound, and a dropped stream says why", async () => {
  // The 2026-09-08 stall began with all six push streams dropping and
  // reconnecting with nothing logged: the catch swallowed the reason. A
  // reconnect parked in a dead pool would then have hung forever, since the
  // idle timer is only armed once the stream is open.
  const logs: string[] = [];
  const ac = new AbortController();
  let calls = 0;
  await startPush(session, "tok", {
    fetcher: (_u, init) => {
      calls += 1;
      if (calls === 2) ac.abort();
      return new Promise<Response>((_, reject) => {
        const s = init.signal!;
        if (s.aborted) reject(s.reason);
        else s.addEventListener("abort", () => reject(s.reason), { once: true });
      });
    },
    connectTimeoutMs: 20,
    sleep: async () => {},
    signal: ac.signal,
    onStateChange: () => {},
    onLog: (m) => logs.push(m),
  });
  assert.ok(logs.some((l) => /push dropped: TimeoutError/.test(l)), `logged why: ${logs.join(" | ")}`);
  assert.ok(logs.every((l) => !l.includes("tok")), "never the token");
});
