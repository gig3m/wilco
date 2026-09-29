import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, resolveMasterSecret, ConfigError } from "../src/core/config.ts";

const complete = {
  WILCO_DB_PATH: "/data/wilco.db",
  WILCO_BLOB_DIR: "/data/blobs",
  WILCO_PORT: "8794",
  WILCO_BASE_URL: "https://mail.example.com",
  WILCO_BODY_BASE_URL: "https://mailbody.example.com",
  WILCO_MASTER_KEY: "a-sufficiently-long-master-secret",
};

test("loads a complete environment", () => {
  const c = loadConfig(complete);
  assert.equal(c.dbPath, "/data/wilco.db");
  assert.equal(c.port, 8794);
  assert.equal(c.bodyBaseUrl, "https://mailbody.example.com");
});

test("names every missing key at once, not just the first", () => {
  try {
    loadConfig({ WILCO_DB_PATH: "/data/wilco.db" });
    assert.fail("should have thrown ConfigError");
  } catch (err) {
    assert(err instanceof ConfigError);
    const message = (err as ConfigError).message;
    assert.match(message, /WILCO_BLOB_DIR/);
    assert.match(message, /WILCO_PORT/);
    assert.match(message, /WILCO_BASE_URL/);
    assert.match(message, /WILCO_BODY_BASE_URL/);
  }
});

test("rejects a non-numeric port", () => {
  assert.throws(() => loadConfig({ ...complete, WILCO_PORT: "eight" }), ConfigError);
});

test("rejects a body base url equal to the app base url", () => {
  // Spec 3.2: the body origin must be a DIFFERENT origin, or the sandbox
  // buys nothing. Catching this in config is cheaper than in review.
  assert.throws(
    () => loadConfig({ ...complete, WILCO_BODY_BASE_URL: complete.WILCO_BASE_URL }),
    ConfigError,
  );
});

test("the master secret can come from an environment variable", () => {
  assert.equal(resolveMasterSecret({ WILCO_MASTER_KEY: "s3cret-long-enough" }), "s3cret-long-enough");
});

test("A DOCKER SECRET FILE IS PREFERRED OVER THE ENVIRONMENT", () => {
  // A file is not visible in `docker inspect` or a crashed process's env dump.
  const secret = resolveMasterSecret(
    { WILCO_MASTER_KEY: "from-env", WILCO_MASTER_KEY_FILE: "/run/secrets/wilco" },
    () => "from-file-long-enough\n",
  );
  assert.equal(secret, "from-file-long-enough", "and the trailing newline a secret file always has is trimmed");
});

test("a missing master secret fails loudly, naming both ways to supply it", () => {
  const err = (() => { try { resolveMasterSecret({}); return null; } catch (e) { return e; } })();
  assert.ok(err instanceof ConfigError);
  assert.match((err as Error).message, /WILCO_MASTER_KEY/);
  assert.match((err as Error).message, /WILCO_MASTER_KEY_FILE/);
});

test("A SHORT MASTER SECRET IS REFUSED", () => {
  // A 4-character master key protecting four mailbox credentials is theatre.
  assert.throws(() => resolveMasterSecret({ WILCO_MASTER_KEY: "abc" }), ConfigError);
});

test("the secret never appears in the error when it is too short", () => {
  let caught: unknown;
  try { resolveMasterSecret({ WILCO_MASTER_KEY: "shortsecret" }); } catch (e) { caught = e; }
  const dump = JSON.stringify(caught, Object.getOwnPropertyNames(caught ?? {}));
  assert.ok(!dump.includes("shortsecret"));
});

test("an unreadable secret file is a config error, not a crash", () => {
  assert.throws(
    () => resolveMasterSecret({ WILCO_MASTER_KEY_FILE: "/nope" }, () => { throw new Error("ENOENT"); }),
    ConfigError,
  );
});

test("the credential store defaults to db and rejects an unknown value", () => {
  const base = {
    WILCO_DB_PATH: "/data/wilco.db", WILCO_BLOB_DIR: "/data/blobs", WILCO_PORT: "8794",
    WILCO_BASE_URL: "https://mail.example.com", WILCO_BODY_BASE_URL: "https://mailbody.example.com",
    WILCO_MASTER_KEY: "a-sufficiently-long-master-secret",
  };
  assert.equal(loadConfig(base).credentialStore, "db");
  assert.equal(loadConfig({ ...base, WILCO_CREDENTIAL_STORE: "keys" }).credentialStore, "keys");
  assert.throws(() => loadConfig({ ...base, WILCO_CREDENTIAL_STORE: "magic" }), ConfigError);
});
