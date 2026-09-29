// src/server/auth.ts
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "wilco_session";
export const CSRF_HEADER = "x-wilco-csrf";

/** A read token can do everything a write token can except mutate mail or
 *  server-side state (spec 7.1). `enum` is not usable here (erasableSyntaxOnly) --
 *  a union type alias is the equivalent that survives type stripping. */
export type Scope = "read" | "write";

/**
 * The result of authenticate(): who is making this request and what they
 * are allowed to do, independent of *how* they proved it. Every route
 * downstream of authenticate() should reason in terms of a Principal, not
 * re-inspect cookies or headers itself -- that is what let Task 8 retrofit
 * Tasks 5-7's session-only routes onto bearer tokens without duplicating
 * the auth logic per route.
 *
 * A session Principal always carries scope "write": the human behind a
 * validated cookie is not scope-limited the way an issued token is: they
 * already can do anything the API can do, by design (spec 3 -- sessions are
 * the account owner logged in via password, not a delegated credential).
 */
export interface Principal {
  kind: "session" | "token";
  scope: Scope;
  tokenId?: string;
}

/** At most one last_used write per token per this window -- see
 *  authenticate()'s doc comment: a write per read would make a read API
 *  write-amplified. */
const TOKEN_LAST_USED_THROTTLE_MS = 60_000;

interface ApiTokenRow {
  id: string;
  hash: string;
  scope: string;
  expires_at: string;
  last_used: string | null;
}

/** sha256 digest as raw bytes (not hex) -- two fixed-length 32-byte Buffers
 *  are exactly what timingSafeEqual requires, and it is the SAME digest
 *  function used at mint time (tokens-api.ts), so a valid token always
 *  produces a same-length comparison. */
function hashTokenBytes(plain: string): Buffer {
  return createHash("sha256").update(plain).digest();
}

/**
 * Looks up a bearer token by hash and, if it matches an unexpired row,
 * returns a token Principal.
 *
 * The comparison is `timingSafeEqual` against the *hashed* token, on
 * fixed-length 32-byte buffers, never `===` on plaintext and never a
 * `WHERE hash = ?` equality left to do the comparing on its own -- every
 * candidate row's stored hash is compared this way, not just the one SQLite
 * happens to return first, so a well-formed lookup gives no early-exit
 * timing signal about which row (if any) is close to a match.
 */
function authenticateToken(db: DatabaseSync, token: string): Principal | null {
  if (!token) return null;
  const digest = hashTokenBytes(token);

  const rows = db
    .prepare(`SELECT id, hash, scope, expires_at, last_used FROM api_tokens`)
    .all() as unknown as ApiTokenRow[];

  let match: ApiTokenRow | null = null;
  for (const row of rows) {
    let stored: Buffer;
    try {
      stored = Buffer.from(row.hash, "hex");
    } catch {
      // Buffer.from() does not actually throw on malformed hex -- invalid
      // characters are silently dropped, so this catch is effectively dead
      // code. The real protection against a corrupt/short/garbage stored
      // hash is the length check immediately below: anything that isn't
      // exactly a 32-byte sha256 digest is rejected there, before it can
      // ever reach timingSafeEqual (which itself throws on a length
      // mismatch -- see the guard's comment).
      continue;
    }
    // timingSafeEqual throws on a length mismatch -- guard first, same as
    // verifyPassword above.
    if (stored.length !== digest.length) continue;
    if (timingSafeEqual(stored, digest)) match = row;
  }
  if (!match) return null;

  // Expiry is required at mint (tokens-api.ts enforces this) and enforced
  // here on every use -- an expired row is exactly as useless as no row.
  if (Date.parse(match.expires_at) <= Date.now()) return null;

  touchLastUsed(db, match.id, match.last_used);

  const scope: Scope = match.scope === "write" ? "write" : "read";
  return { kind: "token", scope, tokenId: match.id };
}

function touchLastUsed(db: DatabaseSync, id: string, lastUsed: string | null): void {
  const now = Date.now();
  if (lastUsed !== null && now - Date.parse(lastUsed) < TOKEN_LAST_USED_THROTTLE_MS) return;
  db.prepare(`UPDATE api_tokens SET last_used = ? WHERE id = ?`).run(new Date(now).toISOString(), id);
}

/**
 * The single entry point every route should call: resolves the caller to a
 * Principal from either an `Authorization: Bearer <token>` header or the
 * session cookie, or returns null if neither authenticates.
 *
 * A bearer token takes priority when both are present -- an agent request
 * carrying its own token should never accidentally ride on a stray browser
 * cookie forwarded by some intermediary. Any `Authorization` header at
 * all -- including an empty string, a non-Bearer scheme, or a bare
 * `Bearer` with no token -- is treated as a hard failure rather than
 * falling through to check the cookie: a caller that attempted bearer auth
 * and got the syntax wrong should see "unauthorized", not silently succeed
 * via an unrelated session it didn't ask to use. See auth.test.ts for the
 * cases this pins down.
 *
 * The `Bearer` scheme name is matched case-insensitively (RFC 7235 makes
 * the auth-scheme token case-insensitive, and real clients send `bearer`)
 * -- the token value itself is NOT lowercased or otherwise normalized.
 */
export function authenticate(db: DatabaseSync, req: IncomingMessage): Principal | null {
  const header = req.headers["authorization"];
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return null;
    return authenticateToken(db, match[1]!.trim());
  }

  const sessionId = readCookie(req.headers["cookie"], SESSION_COOKIE) ?? "";
  if (!validateSession(db, sessionId)) return null;
  return { kind: "session", scope: "write" };
}

/**
 * Whether `principal` is allowed to perform an action requiring `required`.
 * A session always qualifies (see Principal's doc comment). A token
 * qualifies for "read" regardless of its own scope (write implies read),
 * and for "write" only if it was minted with scope "write".
 */
export function hasScope(principal: Principal, required: Scope): boolean {
  if (principal.kind === "session") return true;
  if (required === "read") return true;
  return principal.scope === "write";
}

const SCRYPT_KEYLEN = 64;
// scrypt, not argon2: argon2 needs a native module, and node:sqlite was chosen
// partly to avoid native builds (spec 2.2).
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(plain: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS, (err, key) =>
      err ? reject(err) : resolve(key as Buffer),
    );
  });
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(plain, salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const [scheme, saltB64, keyB64] = stored.split("$");
    if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await derive(plain, salt);
    // timingSafeEqual throws on mismatched lengths, so length-check first.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    // A malformed stored hash (bad base64, unexpected scheme, scrypt
    // rejecting its own params) must fail closed, not become a 500.
    return false;
  }
}

export function createSession(db: DatabaseSync, ttlMs: number = SESSION_TTL_MS): string {
  // 32 bytes of entropy (256 bits) — session ids are opaque, unguessable
  // bearer tokens, not database keys chosen for convenience.
  const id = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)`).run(
    id,
    new Date(now).toISOString(),
    new Date(now + ttlMs).toISOString(),
  );
  return id;
}

export function validateSession(db: DatabaseSync, id: string): boolean {
  if (!id) return false;
  const row = db.prepare(`SELECT expires_at FROM sessions WHERE id = ?`).get(id) as
    | { expires_at: string }
    | undefined;
  if (!row) return false;
  if (Date.parse(row.expires_at) <= Date.now()) {
    destroySession(db, id);
    return false;
  }
  return true;
}

export function destroySession(db: DatabaseSync, id: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

/** Host-only deliberately: a Domain=.example.com cookie would be sent to every
 *  other service on the box (spec 3.3). */
export function sessionCookie(id: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    // Compare the trimmed cookie name for exact equality — do not use
    // startsWith, or "wilco_session_other" would satisfy a lookup for
    // "wilco_session".
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * SameSite=Lax provides no protection here: mail.example.com and every other
 * service on this box share the eTLD+1, so they are same-site (spec 3.4).
 * A non-simple header plus an exact Origin is the actual defence. Either
 * alone is insufficient — a same-site page can set custom headers on its
 * own fetches, and Origin alone is spoofable by anything that isn't a
 * browser enforcing CORS.
 */
export function checkCsrf(req: IncomingMessage, expectedOrigin: string): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const headers = req.headers as Record<string, string | undefined>;
  if (!headers[CSRF_HEADER]) return false;
  return headers["origin"] === expectedOrigin;
}

export class RateLimiter {
  private hits: Map<string, number[]>;
  private limit: number;
  private windowMs: number;
  private now: () => number;

  constructor(opts: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.hits = new Map();
    this.limit = opts.limit ?? 10;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    // Prune every idle key on each call, not just the one being touched --
    // otherwise a distinct key per client IP (or per attacker) accumulates
    // in `hits` forever, since nothing else ever removes an entry.
    for (const [k, times] of this.hits) {
      if (k === key) continue;
      const stillLive = times.some((x) => t - x < this.windowMs);
      if (!stillLive) this.hits.delete(k);
    }

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
