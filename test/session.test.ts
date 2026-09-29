import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSession, expandDownloadUrl, SessionError } from "../src/core/session.ts";
import { personalSession, workSession } from "./fixtures/session.ts";

test("resolves the mail account through primaryAccounts, not by position", () => {
  // The masteruser account is FIRST in personal and LAST in work. A positional
  // read passes one of these and fails the other -- which is the bug.
  assert.equal(resolveSession("personal", personalSession).mailAccountId, "u02214062");
  assert.equal(resolveSession("work", workSession).mailAccountId, "u11111111");
});

test("never selects an account without the mail capability", () => {
  const s = resolveSession("personal", personalSession);
  assert.notEqual(s.mailAccountId, "u99999999");
});

test("reads apiUrl, downloadUrl and uploadUrl from the session", () => {
  const s = resolveSession("personal", personalSession);
  assert.equal(s.apiUrl, "https://phl.api.fastmail.com/jmap/api/");
  assert.match(s.downloadUrl, /fastmailusercontent\.com/);
  assert.ok(
    !s.downloadUrl.startsWith(s.apiUrl),
    "downloadUrl is on a different host from apiUrl (research.md)",
  );
});

test("reads page-size limits from core capabilities rather than hardcoding", () => {
  const s = resolveSession("personal", personalSession);
  assert.equal(s.maxObjectsInGet, 4096);
  assert.equal(s.maxCallsInRequest, 64);
});

test("falls back to conservative limits when the server omits them", () => {
  const stripped = {
    ...personalSession,
    capabilities: { ...personalSession.capabilities, "urn:ietf:params:jmap:core": {} },
  };
  const s = resolveSession("personal", stripped);
  assert.equal(s.maxObjectsInGet, 500);
  assert.equal(s.maxCallsInRequest, 16);
});

test("rejects a session with no mail primary account", () => {
  const broken = { ...personalSession, primaryAccounts: {} };
  assert.throws(() => resolveSession("personal", broken), SessionError);
});

test("expands the download template, escaping each value", () => {
  const s = resolveSession("personal", personalSession);
  const url = expandDownloadUrl(s, {
    accountId: "u02214062",
    blobId: "B-abc",
    name: "quarterly report.pdf",
    type: "application/pdf",
  });
  assert.match(url, /quarterly%20report\.pdf/);
  assert.match(url, /type=application%2Fpdf/);
  assert.ok(!url.includes("{"), "every placeholder must be substituted");
});

/**
 * 🚨 The session document decides where the token goes next, so it is not
 * trusted material.
 *
 * `establishClient` fetches it from the endpoint stored on the ACCOUNT, and
 * since accounts became user-addable that endpoint is user-supplied: the
 * add-account modal derives it from the address domain. `resolveSession`
 * used to check only that the four URLs were non-empty strings, and
 * `JmapClient` then sent `authorization: Bearer <token>` to whatever they
 * said, on every request, for the life of the process. A host answering
 * with `apiUrl: "http://collector.example/jmap"` would have collected the
 * credential in cleartext while the app reported a healthy account.
 */
test("🚨 a session URL that is not https is refused", () => {
  for (const key of ["apiUrl", "downloadUrl", "uploadUrl", "eventSourceUrl"]) {
    const hostile = { ...personalSession, [key]: "http://collector.example/jmap" };
    assert.throws(
      () => resolveSession("personal", hostile),
      (err: unknown) => err instanceof SessionError && /https/i.test((err as Error).message),
      `${key} was accepted over plaintext http`,
    );
  }
});

test("🚨 a session URL that is not an absolute URL is refused", () => {
  for (const value of ["/jmap/api/", "notaurl", "javascript:fetch('//x')", "//host/path"]) {
    const hostile = { ...personalSession, apiUrl: value };
    assert.throws(
      () => resolveSession("personal", hostile),
      (err: unknown) => err instanceof SessionError,
      `apiUrl ${value} was accepted`,
    );
  }
});

/**
 * The guard that stops the obvious "hardening" from breaking every account.
 *
 * Measured against the live Fastmail session on 2026-09-23: the endpoint is
 * `api.fastmail.com`, `apiUrl` is `phl.api.fastmail.com`, and `downloadUrl`
 * is `phl-www.fastmailusercontent.com` -- a DIFFERENT REGISTRABLE DOMAIN.
 * So neither same-host nor same-domain is a rule real JMAP can satisfy;
 * https is. Anyone tempted to tighten this further has to keep this passing.
 */
test("the real Fastmail shape -- three hosts, two domains -- still resolves", () => {
  const s = resolveSession("personal", personalSession);
  assert.match(s.apiUrl, /^https:\/\/phl\.api\.fastmail\.com\//);
  assert.match(s.downloadUrl, /^https:\/\/phl-www\.fastmailusercontent\.com\//);
  assert.notEqual(new URL(s.apiUrl).host, new URL(s.downloadUrl).host);
});
