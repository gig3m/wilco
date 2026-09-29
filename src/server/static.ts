import { promises as fs } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Ctx } from "./router.ts";

// Never inferred from user input -- a request for an unrecognized extension
// falls to application/octet-stream rather than guessing from the byte
// content or trusting whatever a client claims.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function statOrNull(path: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

/**
 * Serves the built SPA out of `root` (client/dist in production). Returns
 * true when it wrote a response, false when the caller should fall through
 * -- to the API router in main.ts, or to the test harness's own 404.
 *
 * Deliberately does its own decoding rather than trusting c.url.pathname
 * as-is: Router.handle() decodes path segments before matching its own
 * routes, but this handler is meant to run standalone against the raw
 * request too (see test/static.test.ts), so it cannot assume that decode
 * already happened. decodeURIComponent is what turns "..%2f..%2f" back into
 * literal ".." segments for the traversal check below -- the URL parser
 * itself only normalizes LITERAL dot-segments in the raw path, not ones
 * hidden behind percent-encoding.
 */
export function serveStatic(root: string): (c: Ctx) => Promise<boolean> {
  const absRoot = resolve(root);
  const indexPath = join(absRoot, "index.html");

  return async (c: Ctx): Promise<boolean> => {
    const method = c.req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return false;

    let pathname: string;
    try {
      pathname = decodeURIComponent(c.url.pathname);
    } catch {
      return false;
    }

    // Never swallow the API or the healthcheck -- doing so would turn every
    // backend error into an HTML app-shell response the client can't parse.
    if (pathname === "/healthz" || pathname.startsWith("/api/")) return false;

    // Resolve against root and compare RESOLVED ABSOLUTE PATHS, not by
    // string-matching "..": "." + pathname keeps the join relative (so a
    // leading "/" in pathname can't jump to the filesystem root on its own),
    // and resolve() collapses any ".." segments -- including ones smuggled
    // in via %2f -- before the boundary check below ever runs.
    const requested = resolve(absRoot, "." + pathname);
    const withinRoot = requested === absRoot || requested.startsWith(absRoot + sep);

    let filePath = withinRoot ? requested : indexPath;
    let servingIndex = filePath === indexPath;

    if (!servingIndex) {
      const st = await statOrNull(filePath);
      if (!st || st.isDirectory()) {
        filePath = indexPath;
        servingIndex = true;
      }
    }

    const st = await statOrNull(filePath);
    if (!st) return false; // no index.html to fall back to -- nothing to serve

    const contentType = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    // Only Vite's own content-hashed output (assets/*) is safe to cache
    // forever -- a deploy changes the hash, so the old immutable response
    // simply stops being requested. Everything else non-index (unhashed
    // static files like the vendored font woff2s) gets a short, ordinary
    // cache instead of pretending it can never change; index.html itself
    // must never be cached at all, or a deploy serves a stale shell against
    // a new API.
    const cacheControl = servingIndex
      ? "no-cache"
      : pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600";

    c.res.writeHead(200, {
      "content-type": contentType,
      "cache-control": cacheControl,
      "content-length": st.size,
    });

    if (method === "HEAD") {
      c.res.end();
      return true;
    }

    const body = await fs.readFile(filePath);
    c.res.end(body);
    return true;
  };
}
