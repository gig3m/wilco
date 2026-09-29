import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "../src/server/static.ts";
import type { Ctx } from "../src/server/router.ts";
import { tempDir } from "./tmpdir.ts";

type Serve = (c: Ctx) => boolean | Promise<boolean>;

/**
 * Spins up a real HTTP server around a `serveStatic` handler, mirroring
 * exactly how main.ts will call it: build the Ctx from a live req/res, call
 * the handler, and 404 if it declines. This does not import Router at all --
 * static.ts is tested in isolation, the same way read-api.test.ts and
 * accounts-api.test.ts each define their own withApp-style harness rather
 * than sharing one (no shared client test-utils module exists yet; that
 * lands in Task 5 for the component tests).
 */
async function withServe(serve: Serve, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://internal");
      const ctx: Ctx = { req, res, url, params: {} };
      const ok = await serve(ctx);
      if (!ok && !res.headersSent) {
        res.writeHead(404);
        res.end();
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Returns the content-type header when the handler served the request, or
 *  null when it declined (fell through to a 404 in the harness above). */
async function handled(serve: Serve, method: string, path: string): Promise<string | null> {
  let result: string | null = null;
  await withServe(serve, async (base) => {
    const res = await fetch(`${base}${path}`, { method });
    result = res.status === 404 ? null : res.headers.get("content-type");
  });
  return result;
}

/** Returns the response body text, regardless of whether the handler served
 *  the request or the harness 404'd it. */
async function bodyOf(serve: Serve, method: string, path: string): Promise<string> {
  let result = "";
  await withServe(serve, async (base) => {
    const res = await fetch(`${base}${path}`, { method });
    result = await res.text();
  });
  return result;
}

test("the static handler serves index.html for the app root and returns false for API paths", async () => {
  const dir = tempDir("static");
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Wilco</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");

  const serve = serveStatic(dir);
  assert.equal(await handled(serve, "GET", "/"), "text/html; charset=utf-8");
  assert.equal(await handled(serve, "GET", "/assets/app.js"), "text/javascript; charset=utf-8");

  // A deep link is the SPA's own route, not a file: it must serve index.html
  // so a reload of /inbox/personal/M1 lands in the app rather than a 404.
  assert.equal(await handled(serve, "GET", "/inbox/personal/M1"), "text/html; charset=utf-8");

  // But it must NOT swallow the API, or every endpoint returns the app shell.
  assert.equal(await handled(serve, "GET", "/api/mailboxes"), null);
  assert.equal(await handled(serve, "GET", "/healthz"), null);
});

test("THE STATIC HANDLER CANNOT ESCAPE ITS ROOT", async () => {
  // Path traversal on a static server is the classic way to serve /etc/passwd
  // or, here, /data/wilco.db. The router decodes %2e%2e before matching, so
  // the check must run on the DECODED path.
  const dir = tempDir("static");
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  const serve = serveStatic(dir);
  for (const evil of ["/../../etc/passwd", "/..%2f..%2fetc%2fpasswd", "/assets/../../../etc/passwd"]) {
    const body = await bodyOf(serve, "GET", evil);
    assert.ok(!String(body).includes("root:"), `${evil} escaped the root`);
  }
});

test("hashed assets get an immutable cache header, index.html gets no-cache", async () => {
  const dir = tempDir("static");
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.abc123.js"), "console.log(1)");

  const serve = serveStatic(dir);
  await withServe(serve, async (base) => {
    const asset = await fetch(`${base}/assets/app.abc123.js`);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    await asset.text();

    const shell = await fetch(`${base}/`);
    assert.equal(shell.headers.get("cache-control"), "no-cache");
    await shell.text();
  });
});

test("unknown extensions fall back to application/octet-stream, never inferred from user input", async () => {
  const dir = tempDir("static");
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  writeFileSync(join(dir, "weird.bin"), "binary");

  const serve = serveStatic(dir);
  assert.equal(await handled(serve, "GET", "/weird.bin"), "application/octet-stream");
});
