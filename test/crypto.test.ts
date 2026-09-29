import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deriveMasterKey, seal, open, SealError } from "../src/core/crypto.ts";

const SECRET = "correct horse battery staple";
const SALT = Buffer.alloc(16, 7);

test("a sealed value round-trips", async () => {
  const key = await deriveMasterKey(SECRET, SALT);
  const sealed = seal(key, "a-fastmail-token");
  assert.equal(open(key, sealed), "a-fastmail-token");
});

test("THE PLAINTEXT DOES NOT APPEAR IN THE SEALED FORM", async () => {
  // The whole point: this string lands in a database that gets backed up.
  const key = await deriveMasterKey(SECRET, SALT);
  const sealed = seal(key, "a-fastmail-token");
  assert.ok(!sealed.includes("a-fastmail-token"));
  assert.ok(!Buffer.from(sealed).toString("hex").includes(Buffer.from("a-fastmail-token").toString("hex")));
});

test("sealing the same value twice gives different ciphertext", async () => {
  // A fresh IV each time, or identical tokens are visibly identical at rest.
  const key = await deriveMasterKey(SECRET, SALT);
  assert.notEqual(seal(key, "same"), seal(key, "same"));
});

test("a different master secret cannot open it", async () => {
  const a = await deriveMasterKey(SECRET, SALT);
  const b = await deriveMasterKey("wrong secret", SALT);
  const sealed = seal(a, "token");
  assert.throws(() => open(b, sealed), SealError);
});

test("a different salt derives a different key", async () => {
  const a = await deriveMasterKey(SECRET, SALT);
  const b = await deriveMasterKey(SECRET, Buffer.alloc(16, 9));
  assert.throws(() => open(b, seal(a, "token")), SealError);
});

test("TAMPERING IS DETECTED — GCM's tag is the point of using it", async () => {
  const key = await deriveMasterKey(SECRET, SALT);
  const sealed = seal(key, "token");
  const parts = sealed.split(".");

  // Flip a bit in the ciphertext.
  const ct = Buffer.from(parts[3]!, "base64url");
  ct[0] = ct[0]! ^ 0x01;
  const tampered = [parts[0], parts[1], parts[2], ct.toString("base64url")].join(".");
  assert.throws(() => open(key, tampered), SealError, "a modified ciphertext must not decrypt");

  // Flip a bit in the auth tag.
  const tag = Buffer.from(parts[2]!, "base64url");
  tag[0] = tag[0]! ^ 0x01;
  assert.throws(
    () => open(key, [parts[0], parts[1], tag.toString("base64url"), parts[3]].join(".")),
    SealError,
  );
});

test("a malformed sealed value throws SealError rather than anything else", async () => {
  const key = await deriveMasterKey(SECRET, SALT);
  for (const bad of ["", "nonsense", "v1.only.three", "v2.a.b.c", "v1...", "v1.!!!.!!!.!!!"]) {
    assert.throws(() => open(key, bad), SealError, `input: ${JSON.stringify(bad)}`);
  }
});

test("neither the key nor the plaintext appears in a thrown error", async () => {
  const key = await deriveMasterKey(SECRET, SALT);
  let caught: unknown;
  try {
    open(key, seal(await deriveMasterKey("other", SALT), "super-secret-token"));
  } catch (err) {
    caught = err;
  }
  const dump = JSON.stringify(caught, Object.getOwnPropertyNames(caught ?? {}));
  assert.ok(!dump.includes("super-secret-token"));
  assert.ok(!dump.includes(key.toString("base64")));
  assert.ok(!dump.includes(key.toString("hex")));
});

test("a long value round-trips unchanged", async () => {
  const key = await deriveMasterKey(SECRET, SALT);
  const big = randomBytes(4096).toString("base64");
  assert.equal(open(key, seal(key, big)), big);
});
