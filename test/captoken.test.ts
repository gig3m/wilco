import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_TOKEN_TTL_MS,
  deriveBodyTokenKey,
  mintBodyToken,
  randomBodyTokenKey,
  verifyBodyToken,
} from "../src/core/captoken.ts";

const key = randomBodyTokenKey();

test("a minted token verifies back to the exact grant it was minted for", () => {
  const token = mintBodyToken(key, { account: "work", id: "M1" });
  assert.deepEqual(verifyBodyToken(key, token), {
    account: "work",
    id: "M1",
    remoteImages: false,
    // Defaults to "message": a token minted before the signature kind
    // existed, or by a caller that does not care, addresses a message.
    kind: "message",
    // v1.1 #2's "Load full message" -- the capped body unless asked.
    full: false,
  });
});

test("the remote-image opt-in rides IN the token, and cannot be flipped on the URL", () => {
  // Spec 6.6. Carried in the signed payload rather than as a query
  // parameter so the URL alone decides the policy -- the blocking and
  // opted-in variants are different URLs, which is what stops a cached
  // blocking response being served for an opted-in request.
  const blocking = mintBodyToken(key, { account: "work", id: "M1" });
  const opted = mintBodyToken(key, { account: "work", id: "M1", remoteImages: true });

  assert.equal(verifyBodyToken(key, blocking)!.remoteImages, false);
  assert.equal(verifyBodyToken(key, opted)!.remoteImages, true);
  assert.notEqual(blocking, opted, "the two variants are different URLs");

  // Flipping the flag by hand invalidates the MAC.
  const [payload, mac] = opted.split(".");
  const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  delete decoded["r"];
  const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url") + "." + mac;
  assert.equal(verifyBodyToken(key, forged), null);
});

test("a token is scoped to (account, id), not to an id alone", () => {
  // Ids genuinely collide across the four accounts, so a token that
  // verified on the id alone would hand the holder another account's mail.
  const token = mintBodyToken(key, { account: "work", id: "M1" });
  const grant = verifyBodyToken(key, token)!;
  assert.equal(grant.account, "work");
  assert.notEqual(grant.account, "personal");
});

test("tampering with the account, the id or the expiry all fail", () => {
  const token = mintBodyToken(key, { account: "work", id: "M1" });
  const [payload, mac] = token.split(".");
  const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));

  for (const mutate of [
    (d: Record<string, unknown>) => (d["a"] = "personal"),
    (d: Record<string, unknown>) => (d["i"] = "M2"),
    (d: Record<string, unknown>) => (d["e"] = Date.now() + 10 * 365 * 24 * 3600 * 1000),
  ]) {
    const copy = { ...decoded };
    mutate(copy);
    const forged = Buffer.from(JSON.stringify(copy), "utf8").toString("base64url") + "." + mac;
    assert.equal(verifyBodyToken(key, forged), null);
  }
});

test("an expired token is refused", () => {
  const now = Date.now();
  const token = mintBodyToken(key, { account: "work", id: "M1" }, 1000, now);
  assert.ok(verifyBodyToken(key, token, now + 500), "still live before the TTL");
  assert.equal(verifyBodyToken(key, token, now + 1001), null, "refused after it");
});

test("a token signed with a different key is refused", () => {
  const token = mintBodyToken(randomBodyTokenKey(), { account: "work", id: "M1" });
  assert.equal(verifyBodyToken(key, token), null);
});

test("malformed tokens return null rather than throwing", () => {
  for (const bad of ["", ".", "no-dot", "a.b", "....", " . ", "\u0000.\u0000", "x".repeat(10_000)]) {
    assert.doesNotThrow(() => verifyBodyToken(key, bad));
    assert.equal(verifyBodyToken(key, bad), null, `refused: ${JSON.stringify(bad.slice(0, 20))}`);
  }
});

test("a wrong-length MAC is refused, not a crash", () => {
  // timingSafeEqual THROWS on a length mismatch rather than returning
  // false, so an unequal-length MAC must be rejected before it is called.
  const token = mintBodyToken(key, { account: "work", id: "M1" });
  const truncated = token.slice(0, token.lastIndexOf(".") + 4);
  assert.doesNotThrow(() => verifyBodyToken(key, truncated));
  assert.equal(verifyBodyToken(key, truncated), null);
});

test("the body-token key is NOT the master key it derives from", () => {
  // A signing key that could also open sealed credentials would turn a
  // token forgery into a credential disclosure.
  const master = Buffer.alloc(32, 7);
  const derived = deriveBodyTokenKey(master);
  assert.equal(derived.length, 32);
  assert.notEqual(derived.toString("hex"), master.toString("hex"));
  assert.equal(
    deriveBodyTokenKey(master).toString("hex"),
    derived.toString("hex"),
    "derivation is deterministic, or tokens die on every restart",
  );
});

test("the default TTL is short enough to be a capability, not a session", () => {
  assert.ok(BODY_TOKEN_TTL_MS <= 15 * 60 * 1000);
});

test("🚨 the grant KIND is signed, so a signature token cannot address a message", () => {
  // The id means different things in the two cases -- a message id versus a
  // JMAP Identity id -- so the routes check the kind, and the kind has to be
  // part of what the MAC covers or the check is decorative.
  const message = mintBodyToken(key, { account: "work", id: "M1" });
  const signature = mintBodyToken(key, { account: "work", id: "I1", kind: "signature" });

  assert.equal(verifyBodyToken(key, message)!.kind, "message");
  assert.equal(verifyBodyToken(key, signature)!.kind, "signature");

  // Strip the kind marker by hand: the MAC no longer matches.
  const [payload, mac] = signature.split(".");
  const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  delete decoded["k"];
  const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url") + "." + mac;
  assert.equal(verifyBodyToken(key, forged), null);
});

test("🚨 a non-canonical spelling of a valid MAC is refused (audit pass 5)", () => {
  // A 256-bit MAC is 43 base64url characters and 43 x 6 = 258 bits, so the
  // final character carries only 4 significant bits. Four different strings
  // decode to identical MAC bytes, and byte comparison alone accepts all
  // four. Measured against the deployed body origin: a token ending `...YySU`
  // also served under `...YySV`, `...YySW` and `...YySX`.
  //
  // This is not a forgery -- the bytes are the same and the MAC is sound.
  // What it costs is canonicality: one grant with four spellings defeats
  // anything that keys on the token STRING rather than the grant.
  const key = Buffer.alloc(32, 7);
  const token = mintBodyToken(key, { account: "personal", id: "M1", kind: "message" }, 60_000);
  assert.notEqual(verifyBodyToken(key, token), null, "the canonical token must verify");

  const dot = token.lastIndexOf(".");
  const mac = token.slice(dot + 1);
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = ALPHABET.indexOf(mac[mac.length - 1]!);
  assert.ok(last >= 0, "the MAC must be base64url");

  // The three other characters sharing this one's top nibble decode to the
  // same bytes. Every one of them must now be refused.
  const nibble = last & 0b111100;
  let checked = 0;
  for (let i = nibble; i < nibble + 4; i++) {
    if (i === last) continue;
    const variant = token.slice(0, dot + 1) + mac.slice(0, -1) + ALPHABET[i];
    assert.equal(
      verifyBodyToken(key, variant),
      null,
      `non-canonical spelling ${ALPHABET[i]} was accepted`,
    );
    checked++;
  }
  assert.equal(checked, 3, "the test did not actually exercise three variants");
});

test("a MAC outside the base64url alphabet is refused, not coerced", () => {
  // Buffer.from(..., "base64url") SKIPS characters it does not recognise
  // rather than failing, so `+`/`/`/whitespace/padding would otherwise be
  // silently dropped on the way to a byte comparison.
  const key = Buffer.alloc(32, 7);
  const token = mintBodyToken(key, { account: "personal", id: "M1", kind: "message" }, 60_000);
  const dot = token.lastIndexOf(".");
  const mac = token.slice(dot + 1);
  for (const junk of ["=", "+", "/", " ", "\n", "%3D"]) {
    assert.equal(verifyBodyToken(key, token.slice(0, dot + 1) + mac + junk), null, `accepted ${JSON.stringify(junk)}`);
  }
});
