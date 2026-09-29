/**
 * The HOST DISPATCH, driven by real requests with real `Host` headers.
 *
 * 🚨 Audit pass 8 (T1). `main.ts`'s own comment calls this "a security
 * boundary, not tidiness", and it had NO test: `grep -n 'host'
 * test/main.test.ts` returned nothing, and no test in this repo ever set a
 * `Host` header.
 *
 * The sharp part is that it LOOKED covered. `bodyhost.test.ts:125` is
 * titled "the SPA and the API are NOT reachable on the body origin" and
 * calls `handleBodyHost` directly. It proves that handler 404s those paths.
 * It can never prove that handler is what RECEIVES them — so inverting the
 * `===` in the dispatch left all 20 of those tests green while
 * `mailbody.example.com` served the SPA, the API and the session cookie.
 *
 * A shape assertion standing in for the behaviour, over exactly the claim
 * the curl check verifies by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createHostDispatch } from "../src/server/main.ts";

/**
 * 🚨 `fetch` CANNOT be used here. `Host` is a forbidden header in undici, so
 * `fetch(url, { headers: { host } })` silently drops it and the request
 * arrives as `127.0.0.1:<port>` — every assertion then measures the app
 * branch no matter what it asked for. That is very likely part of why this
 * boundary never had a test: the obvious way to write one cannot express it.
 */
function get(base: string, path: string, host: string): Promise<string> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });
}

const BODY_HOST = "mailbody.example.com";
const APP_HOST = "mail.example.com";

/** Runs a server whose dispatch records which side each request reached. */
async function withDispatch(fn: (base: string, seen: string[]) => Promise<void>): Promise<void> {
  const seen: string[] = [];
  const dispatch = createHostDispatch({
    bodyHostname: BODY_HOST,
    onBody: async (_req, res, url) => {
      seen.push(`body:${url.pathname}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("BODY");
    },
    onApp: async (_req, res, url) => {
      seen.push(`app:${url.pathname}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("APP");
    },
  });
  const server = createServer((req, res) => void dispatch(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("🚨 THE BODY ORIGIN NEVER REACHES THE APP HANDLER", async () => {
  // Every path that would hand out something the sandbox exists to keep
  // away from message HTML: the SPA itself, the API, and the health probe
  // used as the curl check for this boundary.
  await withDispatch(async (base, seen) => {
    for (const path of ["/", "/index.html", "/api/messages", "/api/login", "/healthz", "/inbox/personal/M1"]) {
      const text = await get(base, path, BODY_HOST);
      assert.equal(text, "BODY", `${path} on the body origin reached the APP handler`);
    }
    assert.ok(
      seen.every((s) => s.startsWith("body:")),
      `something on the body origin reached the app: ${JSON.stringify(seen)}`,
    );
  });
});

test("🚨 THE APP ORIGIN NEVER REACHES THE BODY HANDLER", async () => {
  // The other direction matters too: if the app origin were dispatched to
  // the body handler, Wilco would 404 its own SPA.
  await withDispatch(async (base, seen) => {
    for (const path of ["/", "/api/messages", "/m/token"]) {
      assert.equal(await get(base, path, APP_HOST), "APP", `${path} on the app origin reached the BODY handler`);
    }
    assert.ok(seen.every((s) => s.startsWith("app:")), JSON.stringify(seen));
  });
});

test("a Host carrying a PORT still dispatches by hostname", async () => {
  // `Host` legitimately carries `:port`, and a naive equality against the
  // bare hostname would send `mailbody.example.com:443` to the app handler --
  // the failure open, not closed.
  await withDispatch(async (base) => {
    const text = await get(base, "/api/messages", `${BODY_HOST}:443`);
    assert.equal(text, "BODY", "a Host with a port bypassed the body dispatch");
  });
});

test("an absent or unknown Host is treated as the APP, never the body origin", async () => {
  // Failing the other way would make the body origin the default, which is
  // the dangerous direction: an unrecognised Host must not be handed the
  // SPA's origin semantics by accident.
  await withDispatch(async (base) => {
    assert.equal(await get(base, "/api/messages", "example.invalid"), "APP");
  });
});
