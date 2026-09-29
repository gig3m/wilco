import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Capability tokens for the body origin (spec 3.3).
 *
 * The body origin authenticates with these and with NOTHING else -- no
 * cookie, no session, no bearer token. That is not belt-and-braces, it is
 * forced: a sandboxed frame without `allow-same-origin` has an opaque
 * origin, so its site-for-cookies is null and EVERY subresource request it
 * issues drops SameSite cookies, `Strict` included. Measured in Chromium
 * under the exact policy (spec 3.3):
 *
 *     BODY /m/1         cookie=[lax_c=LAX; strict_c=STRICT]
 *     BODY /inline/cid1 cookie=[NONE]
 *
 * The document load carries a cookie; the `cid:` images inside it do not.
 * A cookie-authenticated body origin would therefore 401 every inline
 * image -- the entire justification for `img-src` being anything but
 * 'none' -- and marketing mail would render as a page of broken boxes that
 * looks exactly like a sanitizer bug. The only cookie that would survive is
 * `SameSite=None`, which is the cookie with no CSRF protection.
 *
 * A token scopes to ONE message: `(account, id)`, never an id alone. Ids
 * genuinely collide across the four accounts.
 */

export type GrantKind = "message" | "signature";

export interface BodyGrant {
  account: string;
  /** A message id for `kind: "message"`, a JMAP Identity id for
   *  `kind: "signature"`. */
  id: string;
  /**
   * What this capability grants. A signature preview is served from the
   * SAME sandboxed origin as message bodies -- our own HTML gets no
   * privilege message HTML does not have, which is the point: the
   * alternative was rendering it in the SPA's document, and an exception
   * "just for our own HTML" is how the next one gets justified.
   */
  kind?: GrantKind;
  /**
   * Whether this grant permits REMOTE images (spec 6.6). Carried in the
   * token rather than as a query parameter so the URL alone determines the
   * policy the body origin applies -- there is no second input a proxy,
   * a cache or a redirect could vary independently of the signature.
   *
   * It is not a privilege boundary: the reader can always ask the API for
   * another token with it set, which is exactly what the "Load images"
   * button does. What it buys is that the two variants are DIFFERENT URLs,
   * so a cached blocking response can never be served for an opted-in
   * request (the reason `Cache-Control: no-store` is also mandatory).
   */
  remoteImages?: boolean;
  /**
   * Whether this grant is for the FULL body rather than the capped one
   * (v1.1 #2's "Load full message"). In the token for the same reason
   * `remoteImages` is: the URL alone decides what the body origin serves,
   * so the capped and full variants are different URLs and no cache can
   * cross them.
   */
  full?: boolean;
}

/** Ten minutes. The SPA mints a token per message open, so this never
 *  needs to outlive reading one message. */
export const BODY_TOKEN_TTL_MS = 10 * 60 * 1000;

const VERSION = "b1";
const KEY_BYTES = 32;

/**
 * Derives the body-token signing key from the master secret via HKDF with a
 * distinct `info` label, so this key and the credential-sealing key are
 * unrelated even though both descend from the same operator secret. A
 * signing key that could also open sealed credentials would make a token
 * forgery into a credential disclosure.
 */
export function deriveBodyTokenKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "wilco/body-capability/v1", KEY_BYTES));
}

/**
 * Mints a token granting read access to one message's document and inline
 * parts until `now + ttlMs`.
 *
 * The payload is not encrypted -- it does not need to be. It names an
 * account key and a message id, both of which the holder already knows
 * (they asked for this message). What the MAC buys is that the holder
 * cannot change either one.
 */
export function mintBodyToken(
  key: Buffer,
  grant: BodyGrant,
  ttlMs: number = BODY_TOKEN_TTL_MS,
  now: number = Date.now(),
): string {
  const payload = encodePayload(grant, now + ttlMs);
  return `${payload}.${sign(key, payload)}`;
}

/**
 * Verifies a token and returns what it grants, or `null` for anything
 * wrong -- bad shape, bad MAC, expired. One `null` for every failure on
 * purpose: a caller that could tell "expired" from "forged" would leak
 * whether a forgery was otherwise well-formed.
 *
 * The MAC is checked BEFORE the expiry, so an attacker cannot use the
 * expiry branch to learn anything about an unsigned payload, and the
 * comparison is `timingSafeEqual` rather than `===`.
 */
export function verifyBodyToken(key: Buffer, token: string, now: number = Date.now()): BodyGrant | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  // 🚨 The MAC must be spelled CANONICALLY, not merely decode to the right
  // bytes. A 256-bit MAC occupies 43 base64url characters, and 43 × 6 = 258
  // bits -- so the final character carries only 4 significant bits and the
  // low 2 are discarded by the decoder. Four different strings therefore
  // decode to the same MAC. Measured on the deployed origin (audit pass 5):
  // a token ending `…YySU` also verified as `…YySV`, `…YySW` and `…YySX`,
  // while `…YyST` and `…YySY` were refused.
  //
  // That is NOT a forgery -- the bytes are identical and the MAC is doing
  // its job. What it costs is CANONICALITY: one grant has four spellings,
  // so anything that ever keys on the token string rather than the grant --
  // a cache key, a revocation list, a rate limiter, a log-based audit --
  // can be sidestepped by re-spelling it. Nothing here does that today
  // (`Cache-Control: no-store`, no revocation), which is exactly why this
  // is cheap to close now and expensive to discover later.
  if (!/^[A-Za-z0-9_-]+$/.test(mac)) return null;
  const provided = Buffer.from(mac, "base64url");
  const expected = Buffer.from(sign(key, payload), "base64url");
  if (provided.toString("base64url") !== mac) return null;
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, and a wrong-length MAC is a forgery, not a crash.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let decoded: { v: string; a: string; i: string; e: number; r?: number; k?: string; f?: number };
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (decoded.v !== VERSION) return null;
  if (typeof decoded.a !== "string" || typeof decoded.i !== "string") return null;
  if (typeof decoded.e !== "number" || !Number.isFinite(decoded.e)) return null;
  if (decoded.e <= now) return null;

  return {
    account: decoded.a,
    id: decoded.i,
    remoteImages: decoded.r === 1,
    full: decoded.f === 1,
    kind: decoded.k === "s" ? "signature" : "message",
  };
}

/** A random key, for tests and for any deployment that has no master key
 *  to derive from. Never persisted: restarting invalidates outstanding
 *  tokens, which for a ten-minute capability is acceptable. */
export function randomBodyTokenKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

function encodePayload(grant: BodyGrant, expiresAt: number): string {
  return Buffer.from(
    JSON.stringify({
      v: VERSION,
      a: grant.account,
      i: grant.id,
      e: expiresAt,
      ...(grant.remoteImages === true ? { r: 1 } : {}),
      ...(grant.kind === "signature" ? { k: "s" } : {}),
      ...(grant.full === true ? { f: 1 } : {}),
    }),
    "utf8",
  ).toString("base64url");
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}
