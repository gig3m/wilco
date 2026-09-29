import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

/**
 * Authenticated encryption for credentials at rest.
 *
 * GCM rather than CBC because the auth tag is what makes tampering detectable:
 * a credential store whose rows can be silently altered is worth very little.
 *
 * Read spec 8.6 for the honest limit on what this buys, and do not overstate
 * it. It does NOT meaningfully protect a leaked backup: the master-key file
 * (in the `secrets` tree) and the sealed rows (in the wilco snapshot) both
 * land in ~/backups, so against the one tier that actually holds this
 * database, an attacker gets the key alongside the ciphertext. It obviously
 * does not protect against an attacker who has the container either.
 *
 * What it really buys is that the database no longer carries credentials at
 * all in any usable form: a copy of wilco.db -- handed to a debugging agent,
 * pulled off a disk, or leaked WITHOUT the separately-stored key -- is inert.
 * That is a narrow, true claim. It is not a vault and must never be described
 * as one.
 */
export class SealError extends Error {}

export const MASTER_KEY_SALT_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const VERSION = "v1";

export function deriveMasterKey(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_BYTES, SCRYPT_PARAMS, (err, key) =>
      err ? reject(new SealError("could not derive the master key")) : resolve(key),
    );
  });
}

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

export function open(key: Buffer, sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SealError("not a sealed value");
  }
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ct = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new SealError("malformed sealed value");

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (err) {
    // Never pass the cause on: a crypto error can carry buffers, and this
    // function's inputs are a key and a credential.
    if (err instanceof SealError) throw err;
    throw new SealError("could not open the sealed value");
  }
}
