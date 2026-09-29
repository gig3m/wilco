/**
 * The SPA's own CSP, asserted on real responses from the app handler.
 *
 * 🚨 Audit pass 8 (T3). `applyAppCsp` had NO test — `grep -rn 'applyAppCsp'
 * test/ client/src` returned nothing — and its own docstring says
 * `frame-src` there is "the fix for a measured problem, not hardening":
 * spec 6.3's probe, where a plain same-frame `<a href>` click inside a
 * message navigates the frame to the sender's host and the open is
 * reported to them. `default-src 'none'` does not govern a frame
 * navigating itself, and CSP's `navigate-to` was removed.
 *
 * Pass 8's sharpest observation about this: the body origin's policy has
 * THREE independent proofs — a unit assertion, a live curl in run.py, and a
 * browser probe that removes each directive in turn — and the origin
 * holding the session cookie had none.
 *
 * 🚨 These drive the handler, not the function. Asserting what
 * `applyAppCsp` composes would repeat T1's mistake one level down: it would
 * prove the string and say nothing about whether any response carries it.
 * Deleting the `applyAppCsp` call from the handler fails every test here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAppHandler } from "../src/server/main.ts";

const BODY_BASE = "https://mailbody.example.com";

/** The static client and the router BOTH write their own responses, so both
 *  are exercised: a header set after `writeHead` is silently dropped, and a
 *  CSP applied in only one branch is a policy the SPA's index.html or its
 *  API responses would go without. */
async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const handler = createAppHandler({
    bodyBaseUrl: BODY_BASE,
    serveClient: async ({ res, url }) => {
      if (!url.pathname.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html>");
        return true;
      }
      return false;
    },
    handle: async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    void handler(req, res, url);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function directives(csp: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of csp.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const space = trimmed.indexOf(" ");
    if (space === -1) out.set(trimmed, "");
    else out.set(trimmed.slice(0, space), trimmed.slice(space + 1).trim());
  }
  return out;
}

/** Both branches of the handler: the served SPA and an API response. */
const PATHS = ["/", "/index.html", "/inbox/personal/M1", "/api/messages"];

test("🚨 EVERY APP RESPONSE CARRIES A CSP", async () => {
  await withApp(async (base) => {
    for (const path of PATHS) {
      const res = await fetch(`${base}${path}`);
      assert.ok(
        res.headers.get("content-security-policy"),
        `${path} was served from the origin holding the session cookie with NO policy`,
      );
    }
  });
});

test("🚨 frame-src NAMES THE BODY ORIGIN AND NOTHING ELSE", async () => {
  // The measured attack, in full: a message renders in the frame, the
  // reader clicks an ordinary link, the frame navigates itself to the
  // sender's host, and the sender now knows the message was opened -- and
  // the reading pane is showing their page where mail is expected. Only
  // `frame-src` stops that navigation.
  await withApp(async (base) => {
    const res = await fetch(`${base}/`);
    const d = directives(res.headers.get("content-security-policy")!);
    assert.equal(
      d.get("frame-src"),
      BODY_BASE,
      "frame-src must name the body origin exactly -- a missing one lets the message frame navigate anywhere",
    );
  });
});

test("🚨 THE POLICY DENIES BY DEFAULT AND FORBIDS INLINE SCRIPT", async () => {
  // `script-src 'self'` and not 'unsafe-inline': the client is a built
  // bundle with no inline script, so allowing it would buy nothing and cost
  // the one directive standing between injected markup and the cookie.
  // `style-src` DOES allow inline, deliberately -- the SPA sets element
  // styles from design tokens at runtime.
  await withApp(async (base) => {
    const d = directives((await fetch(`${base}/`)).headers.get("content-security-policy")!);
    assert.equal(d.get("default-src"), "'none'");
    assert.equal(d.get("script-src"), "'self'", "the SPA must not permit inline or foreign script");
    assert.ok(!d.get("script-src")!.includes("unsafe"), "script-src has grown an unsafe- keyword");
    assert.equal(d.get("form-action"), "'none'");
    assert.equal(d.get("base-uri"), "'none'");
  });
});

test("🚨 NOTHING MAY FRAME THE SPA", async () => {
  // The body frame's own `frame-ancestors` trusts this origin. An attacker
  // who could frame US would inherit that trust, so the two directives are
  // one mechanism and this half is not optional.
  await withApp(async (base) => {
    const d = directives((await fetch(`${base}/`)).headers.get("content-security-policy")!);
    assert.equal(d.get("frame-ancestors"), "'none'");
  });
});

test("nosniff and a same-origin referrer policy ride with it", async () => {
  // `referrer-policy: same-origin` keeps the path of a deep link -- which
  // carries an account key and a message id -- off any foreign request.
  await withApp(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
  });
});
