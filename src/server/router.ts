import type { IncomingMessage, ServerResponse } from "node:http";
import { PayloadTooLargeError } from "./body.ts";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

type Handler = (ctx: Ctx) => void | Promise<void>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: split(pattern), handler });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Belt and braces: `handle` is invoked as `void router.handle(req, res)`,
    // so nothing else backstops a rejection here -- an uncaught throw in this
    // method (not just in a route handler) becomes an unhandled promise
    // rejection and Node kills the process by default. Everything below runs
    // inside this try.
    try {
      const url = new URL(req.url ?? "/", "http://internal");

      // Decode BEFORE matching, and treat a malformed escape as a bad request.
      // decodeURIComponent throws on input like "%ZZ"; doing this decode
      // inside match()'s loop put it outside the per-handler try/catch below,
      // so a single malformed path segment used to crash the whole server.
      const segments: string[] = [];
      for (const raw of split(url.pathname)) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(raw);
        } catch {
          json(res, 400, { error: "malformed path" });
          return;
        }
        segments.push(decoded);
      }

      let pathMatched = false;
      for (const route of this.routes) {
        const params = match(route.segments, segments);
        if (params === null) continue;
        pathMatched = true;
        if (route.method !== (req.method ?? "GET")) continue;

        try {
          await route.handler({ req, res, url, params });
        } catch (err) {
          // A body over the size cap is a CLIENT fault, not a server one --
          // answer 413, not 500 (fix wave, finding 6). Everything else
          // stays an opaque 500: never surface an internal message, it can
          // carry a path, an id, or upstream detail we do not want in a
          // client or a log.
          if (err instanceof PayloadTooLargeError) {
            if (!res.headersSent) json(res, 413, { error: "payload too large" });
            else res.end();
          } else if (!res.headersSent) json(res, 500, { error: "internal error" });
          else res.end();
        }
        return;
      }

      json(res, pathMatched ? 405 : 404, { error: pathMatched ? "method not allowed" : "not found" });
    } catch {
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    }
  }
}

// Leading, trailing, and repeated slashes are all collapsed away deliberately
// (empty segments are dropped): "/thing", "/thing/", and "//thing" all match
// the same route. Acceptable for this JSON API; if a future route needs to
// tell those apart, this is where that distinction would have to be added.
function split(p: string): string[] {
  return p.split("/").filter((s) => s !== "");
}

// `pattern` and `actual` are both already-decoded segments (decoding happens
// once, in handle(), before matching) -- do NOT decodeURIComponent here.
// Decoding again would double-decode (e.g. "%2520" -> "%20" instead of
// "%20"), and doing the decode here instead of in handle() previously let a
// malformed escape throw outside the routing try/catch and kill the process.
function match(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i]!;
    const a = actual[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = a;
    else if (p !== a) return null;
  }
  return params;
}
