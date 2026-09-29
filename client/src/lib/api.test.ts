// @vitest-environment node
import { test } from "vitest";
import assert from "node:assert/strict";
import { ApiError, makeApi } from "./api";

test("THE SEARCH QUERY NEVER APPEARS IN A URL", async () => {
  // Spec 8.3. The reverse proxy logs the request line; a search for a
  // person's name is exactly the string that must not sit in an access log.
  // This already leaked once, through a deprecated GET alias, and was
  // remediated in plan 4 -- this test is what stops it coming back client-side.
  const seen: string[] = [];
  const fetchMock = (url: string, _init?: RequestInit) => {
    seen.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ rows: [], total: 0, cursor: null, truncated: false }), { status: 200 }),
    );
  };
  await makeApi(fetchMock).search("from:robin secret-project", {});
  assert.equal(seen.length, 1);
  assert.ok(!seen[0]!.includes("secret-project"), `query leaked into ${seen[0]}`);
  assert.ok(!seen[0]!.includes("from%3A"), "no encoded form either");
});

test("every mutating request carries the CSRF header", async () => {
  const inits: RequestInit[] = [];
  const fetchMock = (_u: string, init?: RequestInit) => {
    inits.push(init ?? {});
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const a = makeApi(fetchMock);
  await a.search("x", {});
  await a.addSaved("N", "q");
  for (const init of inits) {
    assert.equal((init.headers as Record<string, string>)["x-wilco-csrf"], "1");
  }
});

test("a 401 is surfaced as a session failure, not retried", async () => {
  let calls = 0;
  const fetchMock = () => {
    calls++;
    return Promise.resolve(new Response("{}", { status: 401 }));
  };
  await assert.rejects(() => makeApi(fetchMock).mailboxes(), (e: unknown) => e instanceof ApiError && e.status === 401);
  assert.equal(calls, 1, "a dead session must not be retried in a loop");
});

test("GET requests never carry a body and never send the CSRF header", async () => {
  const inits: RequestInit[] = [];
  const fetchMock = (_u: string, init?: RequestInit) => {
    inits.push(init ?? {});
    return Promise.resolve(
      new Response(JSON.stringify({ accounts: [] }), { status: 200 }),
    );
  };
  await makeApi(fetchMock).mailboxes();
  assert.equal(inits.length, 1);
  assert.equal(inits[0]!.body, undefined);
  assert.equal((inits[0]!.headers as Record<string, string> | undefined)?.["x-wilco-csrf"], undefined);
});

test("every request is same-origin", async () => {
  const inits: RequestInit[] = [];
  const fetchMock = (_u: string, init?: RequestInit) => {
    inits.push(init ?? {});
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  await makeApi(fetchMock).logout();
  assert.equal(inits[0]!.credentials, "same-origin");
});

test("a non-401 error status throws an ApiError carrying the server's message", async () => {
  const fetchMock = () =>
    Promise.resolve(new Response(JSON.stringify({ error: "no such account" }), { status: 400 }));
  await assert.rejects(
    () => makeApi(fetchMock).messages({ account: "bogus" }),
    (e: unknown) => e instanceof ApiError && e.status === 400 && e.message === "no such account",
  );
});

test("messages() filters land as opaque query params, never a body", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify({ rows: [], total: 0, cursor: null, truncated: false }), { status: 200 }),
    );
  };
  await makeApi(fetchMock).messages({ account: "acct1", mailbox: "INBOX", unread: true, limit: 20 });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.init?.method ?? "GET", "GET");
  assert.equal(call.init?.body, undefined);
  const url = new URL(call.url, "http://x");
  assert.equal(url.pathname, "/api/messages");
  assert.equal(url.searchParams.get("account"), "acct1");
  assert.equal(url.searchParams.get("mailbox"), "INBOX");
  assert.equal(url.searchParams.get("unread"), "true");
  assert.equal(url.searchParams.get("limit"), "20");
});

test("a role filter travels as `role`, distinct from a mailbox id", async () => {
  // The two are different filters on the wire (a role spans accounts, an
  // id doesn't), and conflating them is what made the deployed inbox
  // answer 400 -- so assert the parameter NAME, not just that something
  // was sent.
  const calls: { url: string }[] = [];
  const fetchMock: typeof fetch = (input) => {
    calls.push({ url: String(input) });
    return Promise.resolve(
      new Response(JSON.stringify({ rows: [], total: 0, cursor: null, truncated: false }), { status: 200 }),
    );
  };
  await makeApi(fetchMock).messages({ role: "inbox" });
  const url = new URL(calls[0]!.url, "http://x");
  assert.equal(url.searchParams.get("role"), "inbox");
  assert.equal(url.searchParams.get("mailbox"), null, "a role is never sent as a mailbox id");
});

