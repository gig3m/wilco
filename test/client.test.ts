import { test } from "node:test";
import assert from "node:assert/strict";
import { JmapClient, USING_MAIL, USING_SUBMISSION } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import { HttpStatusError } from "../src/core/failures.ts";

const session = resolveSession("personal", personalSession);
const TOKEN = "token-value";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("sends a bearer token and the declared capabilities", async () => {
  let seenUrl = "";
  let seenInit: RequestInit = {};
  const client = new JmapClient(session, TOKEN, async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ methodResponses: [["Mailbox/get", { list: [] }, "c0"]] });
  });

  await client.request([["Mailbox/get", { accountId: session.mailAccountId }, "c0"]]);

  assert.equal(seenUrl, session.apiUrl);
  const headers = new Headers(seenInit.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  const body = JSON.parse(seenInit.body as string);
  assert.deepEqual(body.using, USING_MAIL);
});

test("submission calls must declare the submission capability", () => {
  // Omitting it makes the server answer `unknownMethod`, which reads like the
  // method is unsupported rather than like the capability was undeclared.
  assert.ok(USING_SUBMISSION.includes("urn:ietf:params:jmap:submission"));
  assert.ok(USING_SUBMISSION.includes("urn:ietf:params:jmap:core"));
});

test("returns methodResponses in order", async () => {
  const client = new JmapClient(session, TOKEN, async () =>
    jsonResponse({
      methodResponses: [
        ["Mailbox/get", { list: [{ id: "P-F" }] }, "c0"],
        ["Email/query", { ids: ["m1"] }, "c1"],
      ],
    }),
  );
  const out = await client.request([
    ["Mailbox/get", {}, "c0"],
    ["Email/query", {}, "c1"],
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1]![1].ids[0], "m1");
});

test("a method-level error is thrown, not returned as data", async () => {
  const client = new JmapClient(session, TOKEN, async () =>
    jsonResponse({ methodResponses: [["error", { type: "unknownMethod" }, "c0"]] }),
  );
  await assert.rejects(() => client.request([["Email/get", {}, "c0"]]), /unknownMethod/);
});

test("a transport failure is retried exactly once", async () => {
  let calls = 0;
  const client = new JmapClient(session, TOKEN, async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return jsonResponse({ methodResponses: [["Mailbox/get", { list: [] }, "c0"]] });
  });
  await client.request([["Mailbox/get", {}, "c0"]]);
  assert.equal(calls, 2, "GOAWAY is graceful; one retry is correct");
});

test("a transport failure twice in a row gives up", async () => {
  let calls = 0;
  const client = new JmapClient(session, TOKEN, async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  });
  await assert.rejects(() => client.request([["Mailbox/get", {}, "c0"]]));
  assert.equal(calls, 2, "one retry, not a loop");
});

test("an HTTP status error is NOT retried", async () => {
  let calls = 0;
  const client = new JmapClient(session, TOKEN, async () => {
    calls += 1;
    return jsonResponse({ error: "nope" }, 401);
  });
  await assert.rejects(() => client.request([["Mailbox/get", {}, "c0"]]), HttpStatusError);
  assert.equal(calls, 1, "retrying a 401 just burns requests");
});

test("an error never carries the token", async () => {
  const client = new JmapClient(session, TOKEN, async () => jsonResponse({ e: 1 }, 500));
  let caught: unknown;
  try {
    await client.request([["Mailbox/get", {}, "c0"]]);
    assert.fail("expected the request to reject");
  } catch (err) {
    caught = err;
  }
  assert.ok(
    !JSON.stringify(caught, Object.getOwnPropertyNames(caught as object)).includes(TOKEN),
  );
});

test("a request nobody answers is abandoned after the bound, tried once more, and then fails as a timeout", async () => {
  // A fetcher that behaves like Node's fetch did on 2026-09-08: it never
  // resolves on its own and only ends when the signal it was handed aborts.
  let calls = 0;
  const client = new JmapClient(session, TOKEN, (_u, init) => {
    calls += 1;
    return new Promise<Response>((_, reject) => {
      const s = init.signal;
      assert.ok(s, "every request carries a signal");
      s!.addEventListener("abort", () => reject(s!.reason), { once: true });
    });
  }, { requestTimeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(client.request([["Mailbox/get", {}, "c0"]]), (err: unknown) =>
    err instanceof DOMException && err.name === "TimeoutError");
  assert.equal(calls, 2, "one retry, no more");
  assert.ok(Date.now() - started < 2000, "bounded, not Node's five minutes");
});

test("a caller's own signal is honoured alongside the bound", async () => {
  const ac = new AbortController();
  const client = new JmapClient(session, TOKEN, (_u, init) =>
    new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })),
  { requestTimeoutMs: 60_000 });
  const p = client.request([["Mailbox/get", {}, "c0"]], undefined, ac.signal);
  ac.abort();
  await assert.rejects(p, (err: unknown) => err instanceof DOMException && err.name === "AbortError");
});
