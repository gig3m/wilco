import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, HttpStatusError } from "../src/core/failures.ts";

test("401 and 403 are auth failures, and are not retried", () => {
  for (const status of [401, 403]) {
    const f = classify(new HttpStatusError("nope", status));
    assert.equal(f.kind, "auth");
    assert.equal(f.retryable, false, "retrying an expired token just burns requests");
  }
});

test("429 is rate limiting, retryable, and honours Retry-After seconds", () => {
  const f = classify(new HttpStatusError("slow down", 429, "30"));
  assert.equal(f.kind, "rate-limited");
  assert.equal(f.retryable, true);
  assert.equal(f.retryAfterMs, 30_000);
});

test("429 Retry-After also accepts an HTTP-date, and never yields a negative delay", () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const f = classify(new HttpStatusError("slow down", 429, future));
  assert.equal(f.kind, "rate-limited");
  assert.ok(f.retryAfterMs !== undefined && f.retryAfterMs > 0);
  assert.ok(f.retryAfterMs <= 60_000);

  // A date already in the past must clamp to 0, not go negative -- a
  // negative delay is a busy loop, not a backoff.
  const past = new Date(Date.now() - 60_000).toUTCString();
  const g = classify(new HttpStatusError("slow down", 429, past));
  assert.equal(g.retryAfterMs, 0);
});

test("5xx is a server failure and is retryable", () => {
  const f = classify(new HttpStatusError("boom", 503));
  assert.equal(f.kind, "server");
  assert.equal(f.retryable, true);
});

test("a bare `fetch failed` is a transport failure, retryable", () => {
  // Fastmail cycles HTTP/2 connections with GOAWAY; the in-flight fetch
  // rejects with no status at all (research.md).
  const f = classify(new TypeError("fetch failed"));
  assert.equal(f.kind, "network");
  assert.equal(f.retryable, true);
});

test("common node network error codes are transport failures", () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"]) {
    const err = Object.assign(new Error("socket"), { code });
    const f = classify(err);
    assert.equal(f.kind, "network", code);
    assert.equal(f.retryable, true, code);
  }
});

test("an unrecognised error is unknown and NOT retryable", () => {
  const f = classify(new Error("something odd"));
  assert.equal(f.kind, "unknown");
  assert.equal(f.retryable, false, "retrying an unclassified error is how a busy loop starts");
});

test("a request that ran out its time bound is a network failure, and is retried; a caller's own abort is not", () => {
  // 2026-09-08: the sync loop sat for four and a half hours on JMAP requests
  // that Node's fetch had parked without a socket, a timer, or an error. The
  // bound that now exists on every outbound request surfaces as a
  // DOMException named TimeoutError, and a single timeout is worth one more
  // try -- the parked request was the pool's fault, not Fastmail's.
  const t = classify(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  assert.equal(t.kind, "network");
  assert.equal(t.retryable, true);
  assert.match(t.message, /timed out/);
  const a = classify(new DOMException("This operation was aborted", "AbortError"));
  assert.equal(a.retryable, false, "shutdown asked for this; retrying it is wrong");
});
