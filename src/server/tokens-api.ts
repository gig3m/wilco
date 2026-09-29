// src/server/tokens-api.ts
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Ctx, Router } from "./router.ts";
import { json } from "./router.ts";
import { authenticate, checkCsrf, type Scope } from "./auth.ts";
import { readJson } from "./body.ts";

export interface TokensApiDeps {
  db: DatabaseSync;
  origin: string;
}

interface ApiTokenRow {
  id: string;
  label: string;
  scope: string;
  created_at: string;
  expires_at: string;
  last_used: string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// The highest-value credential this branch introduces, with no rotation
// nag and no alarm behind it -- unbounded would let `expiresInDays: 36500`
// mint a century-long bearer token (fix wave, finding 3).
const MAX_EXPIRES_IN_DAYS = 365;

/**
 * Mounts `GET/POST /api/tokens` and `DELETE /api/tokens/:id`.
 *
 * SESSION-ONLY, deliberately, and not by a scope check: a bearer token
 * principal (even scope "write") is refused with 403 here regardless of its
 * scope. The reason is not "tokens can't write" (a write-scope token CAN
 * write, e.g. saved-searches) -- it's that minting/listing/revoking tokens
 * is a capability of being the logged-in human, full stop. If a token could
 * mint a token, a leaked read token would trivially escalate itself to a
 * write token by minting one; there is no scope that closes that hole
 * except never letting a token in this door at all.
 *
 * A response from GET or POST here must NEVER include a hash or a
 * previously-minted plaintext -- POST's response is the ONLY place the
 * plaintext token is ever visible, and only once, at the moment of minting.
 */
export function registerTokenRoutes(router: Router, deps: TokensApiDeps): void {
  const requireSession = (c: Ctx): boolean => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) {
      json(c.res, 401, { error: "unauthorized" });
      return false;
    }
    if (principal.kind !== "session") {
      // Not 401: the caller successfully authenticated as *something* --
      // a real, unexpired token -- it's just not allowed through this door.
      json(c.res, 403, { error: "forbidden" });
      return false;
    }
    return true;
  };

  router.add("GET", "/api/tokens", (c) => {
    if (!requireSession(c)) return;
    const rows = deps.db
      .prepare(
        `SELECT id, label, scope, created_at, expires_at, last_used
           FROM api_tokens
          ORDER BY created_at DESC`,
      )
      .all() as unknown as ApiTokenRow[];
    json(c.res, 200, { tokens: rows.map(toSummary) });
  });

  router.add("POST", "/api/tokens", async (c) => {
    if (!requireSession(c)) return;
    if (!checkCsrf(c.req, deps.origin)) return void json(c.res, 403, { error: "forbidden" });

    const body = await readJson(c.req);

    const label = typeof body?.["label"] === "string" ? (body["label"] as string).trim() : "";
    if (!label) return void json(c.res, 400, { error: "label is required" });

    const scopeRaw = body?.["scope"];
    if (scopeRaw !== undefined && scopeRaw !== "read" && scopeRaw !== "write") {
      return void json(c.res, 400, { error: "scope must be 'read' or 'write'" });
    }
    // "read" is the default scope -- a write token must be asked for
    // explicitly (spec 7.1).
    const scope: Scope = scopeRaw === "write" ? "write" : "read";

    const expiresInDays = body?.["expiresInDays"];
    if (typeof expiresInDays !== "number" || !Number.isFinite(expiresInDays) || expiresInDays <= 0) {
      // Expiry is required at mint, not optional -- there is no code path
      // that inserts a row with no (or an infinite) expires_at.
      return void json(c.res, 400, { error: "expiresInDays is required and must be a positive number" });
    }
    if (expiresInDays > MAX_EXPIRES_IN_DAYS) {
      return void json(c.res, 400, {
        error: `expiresInDays must be at most ${MAX_EXPIRES_IN_DAYS}`,
      });
    }

    // A short, non-secret identifier -- NOT the token itself, and
    // deliberately short (16 hex chars): the id is returned in every list
    // response, and a UUID-length id is long enough to be mistaken for
    // (and to trip a "nothing token-shaped in this response" check
    // against) an actual credential. It only needs to be unique among this
    // operator's own tokens, not cryptographically unguessable -- knowing
    // it grants nothing without the plaintext token, which is never stored.
    const id = randomBytes(8).toString("hex");
    // 32 bytes of entropy, same as createSession -- base64url keeps it
    // URL/header-safe and >= 32 chars long (the no-leak test's own bar).
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");

    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + expiresInDays * MS_PER_DAY).toISOString();

    deps.db
      .prepare(
        `INSERT INTO api_tokens (id, label, hash, scope, created_at, expires_at, last_used)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, label, hash, scope, createdAt, expiresAt);

    // THE ONE PLACE the plaintext token is ever returned. It is never
    // stored (only `hash` is), never logged, and this response body is the
    // only time it is visible again.
    json(c.res, 201, { id, label, scope, createdAt, expiresAt, token });
  });

  router.add("DELETE", "/api/tokens/:id", (c) => {
    if (!requireSession(c)) return;
    if (!checkCsrf(c.req, deps.origin)) return void json(c.res, 403, { error: "forbidden" });

    // Idempotent, like DELETE /api/saved-searches/:id: "this id is gone" is
    // the same end state whether or not a row existed.
    deps.db.prepare(`DELETE FROM api_tokens WHERE id = ?`).run(c.params["id"]!);
    json(c.res, 200, { ok: true });
  });
}

function toSummary(r: ApiTokenRow) {
  return {
    id: r.id,
    label: r.label,
    scope: r.scope,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsed: r.last_used,
  };
}
