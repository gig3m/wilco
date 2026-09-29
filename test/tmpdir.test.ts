/**
 * The temp-directory cleanup, proven by observation.
 *
 * 🚨 Without this, reverting `tmpdir.ts` brings the leak back SILENTLY — the
 * suite would stay green while the host filled up again, which is precisely
 * how 930 MB and 6,336 directories accumulated unnoticed in the first place.
 * The cleanup runs in a `process.on("exit")` handler and so cannot be
 * observed from inside the process that registered it: by the time it fires
 * there is no test left to assert in. A child process is the only way to see
 * it, so that is what these do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir, tempDbPath } from "./tmpdir.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tmpdir-cleanup.ts");

test("🚨 a temp directory is REMOVED when the process exits", () => {
  const dir = execFileSync("node", [FIXTURE], { encoding: "utf8", timeout: 10_000 }).trim();
  assert.ok(dir.length > 0, "the fixture printed no directory");
  assert.equal(
    existsSync(dir),
    false,
    `${dir} survived the process that created it — the /tmp leak is back`,
  );
});

test("🚨 a CRASHING process still cleans up", () => {
  // The case that matters most: the leak returns exactly when the suite is
  // red and someone is running it repeatedly.
  let dir = "";
  try {
    execFileSync("node", [FIXTURE, "throw"], { encoding: "utf8", timeout: 10_000, stdio: "pipe" });
    assert.fail("the fixture was supposed to crash");
  } catch (err) {
    dir = String((err as { stdout?: Buffer }).stdout ?? "").trim();
  }
  assert.ok(dir.length > 0, "the crashing fixture printed no directory");
  assert.equal(existsSync(dir), false, `${dir} survived a crashed process`);
});

test("each call gets its own directory, and a db path has a directory to itself", () => {
  // SQLite writes `-wal` and `-shm` siblings, so two databases cannot share
  // a directory without colliding.
  const a = tempDir("x");
  const b = tempDir("x");
  assert.notEqual(a, b, "two calls returned the same directory");
  assert.notEqual(path.dirname(tempDbPath()), path.dirname(tempDbPath()), "two db paths share a directory");
});
