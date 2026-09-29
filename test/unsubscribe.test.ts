import { test } from "node:test";
import assert from "node:assert/strict";
import { planUnsubscribe, oneClickPost } from "../src/core/unsubscribe.ts";

// Row 31. The plan is decided from the two headers alone (RFC 2369
// List-Unsubscribe, RFC 8058 List-Unsubscribe-Post); performing it is a
// separate step that takes an injected fetch.

test("one-click POST is chosen when List-Unsubscribe-Post advertises it and an https URL exists", () => {
  const p = planUnsubscribe(["mailto:unsub@example.com", "https://example.com/unsub?x=1"], "List-Unsubscribe=One-Click");
  assert.deepEqual(p, { kind: "post", url: "https://example.com/unsub?x=1" });
});

test("without List-Unsubscribe-Post the https URL is NOT posted to -- a GET-style link is a page for a person, so mailto wins", () => {
  const p = planUnsubscribe(["https://example.com/unsub", "mailto:unsub@example.com?subject=stop%20please"], null);
  assert.deepEqual(p, { kind: "mailto", to: "unsub@example.com", subject: "stop please", body: "" });
});

test("a plain-http URL is never posted to, even with the one-click header", () => {
  const p = planUnsubscribe(["http://example.com/unsub", "mailto:u@example.com"], "List-Unsubscribe=One-Click");
  assert.deepEqual(p, { kind: "mailto", to: "u@example.com", subject: "Unsubscribe", body: "" });
});

test("mailto carries subject and body from its query, decoded; the default subject is 'Unsubscribe'", () => {
  assert.deepEqual(planUnsubscribe(["mailto:u@example.com?body=please%20remove%20me"], null), {
    kind: "mailto",
    to: "u@example.com",
    subject: "Unsubscribe",
    body: "please remove me",
  });
  assert.deepEqual(planUnsubscribe(["mailto:u@example.com?Subject=Leave"], null)?.kind, "mailto");
});

test("nothing usable yields null: no headers, an empty list, junk schemes, a mailto with no address", () => {
  assert.equal(planUnsubscribe(null, null), null);
  assert.equal(planUnsubscribe([], "List-Unsubscribe=One-Click"), null);
  assert.equal(planUnsubscribe(["ftp://example.com/x", "javascript:alert(1)"], null), null);
  assert.equal(planUnsubscribe(["mailto:?subject=x"], null), null);
});

test("the one-click POST is form-encoded 'List-Unsubscribe=One-Click', sends no cookies or referrer, and reports the status", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const result = await oneClickPost("https://example.com/unsub", async (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response("", { status: 202 });
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://example.com/unsub");
  assert.equal(seen[0]!.init.method, "POST");
  assert.equal(seen[0]!.init.body, "List-Unsubscribe=One-Click");
  assert.equal((seen[0]!.init.headers as Record<string, string>)["content-type"], "application/x-www-form-urlencoded");
  assert.equal(seen[0]!.init.redirect, "manual");
  assert.equal(seen[0]!.init.credentials, "omit");
  assert.deepEqual(result, { ok: true, status: 202 });
});

test("a refusal or a network failure is reported, not thrown", async () => {
  assert.deepEqual(await oneClickPost("https://example.com/u", async () => new Response("", { status: 404 })), { ok: false, status: 404 });
  assert.deepEqual(await oneClickPost("https://example.com/u", async () => { throw new Error("ECONNREFUSED"); }), { ok: false, status: null });
});
