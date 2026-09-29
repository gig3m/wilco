import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyEndpoint, VerifyError } from "../src/core/verify-account.ts";
import { FASTMAIL_SESSION_URL } from "../src/core/client.ts";
import type { Fetcher } from "../src/core/client.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("verifyEndpoint: direct endpoint 200 returns it, username from body", async () => {
  // Two calls now, and the ORDER is the point: the anonymous probe, then the
  // credential. The body carries `apiUrl` because that is what a session
  // document is -- `resolveSession` requires it -- and it is how the probe
  // recognises a server that serves its session unauthenticated.
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(`${url}${headers["authorization"] === undefined ? " (anon)" : " (authed)"}`);
    return jsonResponse(200, { apiUrl: "https://mail.example.com/jmap/api", username: "robin@example.com" });
  };

  const result = await verifyEndpoint("https://mail.example.com/jmap/session", "tok", fetcher);

  assert.deepEqual(calls, [
    "https://mail.example.com/jmap/session (anon)",
    "https://mail.example.com/jmap/session (authed)",
  ]);
  assert.deepEqual(result, { endpoint: "https://mail.example.com/jmap/session", username: "robin@example.com" });
});

test("verifyEndpoint: .well-known 404 then Fastmail 200 falls back", async () => {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    if (url === "https://example.com/.well-known/jmap") return jsonResponse(404, {});
    if (url === FASTMAIL_SESSION_URL) return jsonResponse(200, { username: "robin@example.com" });
    throw new Error(`unexpected url ${url}`);
  };

  const result = await verifyEndpoint("https://example.com/.well-known/jmap", "tok", fetcher);

  assert.deepEqual(calls, ["https://example.com/.well-known/jmap", FASTMAIL_SESSION_URL]);
  assert.deepEqual(result, { endpoint: FASTMAIL_SESSION_URL, username: "robin@example.com" });
});

test("verifyEndpoint: .well-known 404 then Fastmail 401 throws auth naming both URLs", async () => {
  const fetcher: Fetcher = async (url) => {
    if (url === "https://example.com/.well-known/jmap") return jsonResponse(404, {});
    if (url === FASTMAIL_SESSION_URL) return jsonResponse(401, {});
    throw new Error(`unexpected url ${url}`);
  };

  await assert.rejects(
    () => verifyEndpoint("https://example.com/.well-known/jmap", "tok", fetcher),
    (err: unknown) => {
      assert.ok(err instanceof VerifyError);
      assert.equal(err.reason, "auth");
      assert.match(err.message, /example\.com\/\.well-known\/jmap/);
      assert.match(err.message, new RegExp(FASTMAIL_SESSION_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
});

test("verifyEndpoint: direct non-well-known endpoint 401 throws auth, and only that endpoint is contacted", async () => {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    // 401 to the anonymous probe means "a JMAP endpoint that wants a
    // credential", so the credential IS sent here -- and 401 again ends it.
    return jsonResponse(401, {});
  };

  await assert.rejects(
    () => verifyEndpoint("https://mail.example.com/jmap/session", "tok", fetcher),
    (err: unknown) => {
      assert.ok(err instanceof VerifyError);
      assert.equal(err.reason, "auth");
      return true;
    },
  );
  // The probe then the credential, and nothing else: Fastmail is never
  // contacted for an endpoint the owner typed, and never after an auth
  // failure from a host that does speak JMAP.
  assert.deepEqual(calls, [
    "https://mail.example.com/jmap/session",
    "https://mail.example.com/jmap/session",
  ]);
});

test("verifyEndpoint: fetcher throws (DNS failure) -> reason unreachable", async () => {
  const fetcher: Fetcher = async () => {
    const err = new Error("getaddrinfo ENOTFOUND mail.example.com") as Error & { code?: string };
    err.code = "ENOTFOUND";
    throw err;
  };

  await assert.rejects(
    () => verifyEndpoint("https://mail.example.com/jmap/session", "tok", fetcher),
    (err: unknown) => {
      assert.ok(err instanceof VerifyError);
      assert.equal(err.reason, "unreachable");
      return true;
    },
  );
});

test("verifyEndpoint: non-well-known endpoint failing with a non-auth http status -> reason http", async () => {
  const fetcher: Fetcher = async () => jsonResponse(500, {});

  await assert.rejects(
    () => verifyEndpoint("https://mail.example.com/jmap/session", "tok", fetcher),
    (err: unknown) => {
      assert.ok(err instanceof VerifyError);
      assert.equal(err.reason, "http");
      return true;
    },
  );
});

test("verifyEndpoint: a JSON-parse failure on a captive-portal/WAF HTML page does not echo the page (Minor 5)", async () => {
  // A 200 whose body is an HTML error page makes fetchSession's res.json()
  // throw a SyntaxError whose .message quotes the offending characters --
  // e.g. `Unexpected token '<', "<!DOCTYPE ..." is not valid JSON`. Before
  // the fix, describe(err) returned err.message verbatim, so that page's
  // text ended up in the 400 body this API sends back to the add-account
  // modal. It must not appear anywhere in the VerifyError's message.
  const html = "<!DOCTYPE html><html><body>Access Denied by WAF rule 41412: block-outbound</body></html>";
  const fetcher: Fetcher = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });

  await assert.rejects(
    () => verifyEndpoint("https://mail.example.com/jmap/session", "tok", fetcher),
    (err: unknown) => {
      assert.ok(err instanceof VerifyError);
      // `http`, not `unreachable`: the host answered perfectly well, it just
      // did not answer like JMAP. That verdict is now reached by the
      // ANONYMOUS probe, before any credential exists in the request -- which
      // is the point of the change; the reason moved because the failure is
      // caught a step earlier, and the no-echo rule below is unchanged.
      assert.equal(err.reason, "http");
      assert.match(err.message, /mail\.example\.com/, "the endpoint tried must still be named");
      assert.doesNotMatch(err.message, /Access Denied|WAF rule|DOCTYPE|block-outbound/i,
        `remote page content must never be echoed: ${err.message}`);
      return true;
    },
  );
});

test("verifyEndpoint: a non-HttpStatusError message names the endpoint and, where available, the error's code -- never err.message verbatim", async () => {
  const fetcher: Fetcher = async () => {
    const err = new Error("connect ECONNREFUSED 10.10.10.68:8081 -- some arbitrary remote-controlled detail") as Error & { code?: string };
    err.code = "ECONNREFUSED";
    throw err;
  };

  await assert.rejects(
    () => verifyEndpoint("https://mail.example.com/jmap/session", "tok", fetcher),
    (err: unknown) => {
      assert.ok(err instanceof VerifyError);
      assert.equal(err.reason, "unreachable");
      assert.match(err.message, /mail\.example\.com/);
      assert.match(err.message, /ECONNREFUSED/, "the error's code is the most that may be echoed");
      assert.doesNotMatch(err.message, /arbitrary remote-controlled detail/);
      return true;
    },
  );
});

/**
 * 🚨 The credential must not be handed to a host that has not shown it
 * speaks JMAP.
 *
 * The add-account modal derives `https://<domain-of-the-address>/.well-known/
 * jmap`, and for a Fastmail-hosted custom domain that is the owner's ORDINARY
 * WEB HOST -- not Fastmail. Sending the token there first, which is what this
 * function used to do, put a long-lived Fastmail API token in a third party's
 * access log on the normal, successful path, and then reported "connected"
 * without ever saying so.
 */
test("🚨 a non-JMAP endpoint is NEVER sent the credential", async () => {
  const authed: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["authorization"] !== undefined) authed.push(url);
    // The owner's web host: no such path, exactly like a parked domain or a CMS.
    if (url === "https://example.com/.well-known/jmap") return new Response("<!DOCTYPE html>", { status: 404 });
    if (url === FASTMAIL_SESSION_URL) return jsonResponse(200, { apiUrl: "https://x/api", username: "robin@example.com" });
    throw new Error(`unexpected url ${url}`);
  };

  const result = await verifyEndpoint("https://example.com/.well-known/jmap", "tok", fetcher);

  assert.deepEqual(
    authed,
    [FASTMAIL_SESSION_URL],
    "the credential was sent to a host that answered 404 to an anonymous probe",
  );
  assert.equal(result.endpoint, FASTMAIL_SESSION_URL);
});

test("🚨 a JMAP endpoint that REFUSES the credential does not then get it sent to Fastmail", async () => {
  // A mistyped token against a real self-hosted JMAP server. 401 means "this
  // IS a JMAP endpoint and it refused you" -- the one case that must not fall
  // back, because falling back mails the same credential to a third party.
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(`${url}${headers["authorization"] === undefined ? " (anon)" : " (authed)"}`);
    if (url === "https://example.com/.well-known/jmap") return new Response("", { status: 401 });
    if (url === FASTMAIL_SESSION_URL) return jsonResponse(200, { apiUrl: "https://x/api", username: "someone@fastmail.com" });
    throw new Error(`unexpected url ${url}`);
  };

  await assert.rejects(
    () => verifyEndpoint("https://example.com/.well-known/jmap", "tok", fetcher),
    (err: unknown) => err instanceof VerifyError && err.reason === "auth",
  );
  assert.ok(
    !calls.some((c) => c.startsWith(FASTMAIL_SESSION_URL)),
    `the credential was passed on to Fastmail after a JMAP server refused it: ${JSON.stringify(calls)}`,
  );
});

test("a 401 carrying a Basic challenge is a password-protected WEB host, not JMAP", async () => {
  // JMAP authenticates with Bearer. A `WWW-Authenticate: Basic` challenge is
  // an ordinary protected web page, so it must not qualify as "speaks JMAP"
  // and collect the token.
  const authed: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["authorization"] !== undefined) authed.push(url);
    if (url === "https://example.com/.well-known/jmap")
      return new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="staging"' } });
    if (url === FASTMAIL_SESSION_URL) return jsonResponse(200, { apiUrl: "https://x/api", username: "robin@example.com" });
    throw new Error(`unexpected url ${url}`);
  };

  await verifyEndpoint("https://example.com/.well-known/jmap", "tok", fetcher);

  assert.deepEqual(authed, [FASTMAIL_SESSION_URL], "the token went to a Basic-auth web host");
});
