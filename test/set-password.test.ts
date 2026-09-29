import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./tmpdir.ts";

const SCRIPT = new URL("../scripts/set-password.ts", import.meta.url).pathname;

test("set-password honours WILCO_ENV_PATH and writes a doubled-dollar hash", () => {
  const dir = tempDir("set-password");
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "OTHER=1\n");
  const r = spawnSync(process.execPath, [SCRIPT, "--commit", "--stdin"], {
    input: "correct horse battery\n",
    env: { ...process.env, WILCO_ENV_PATH: envPath },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(envPath, "utf8");
  assert.match(out, /^OTHER=1$/m, "existing lines survive");
  const line = out.match(/^WILCO_PASSWORD_HASH=(.*)$/m)?.[1];
  assert.ok(line, "hash line written");
  assert.ok(line.includes("$$"), "dollars are doubled for compose");
  assert.ok(!line.match(/[^$]\$[^$]/), "no single dollar remains");
  assert.doesNotMatch(r.stdout + r.stderr, /correct horse/, "password never printed");
});

test("set-password refuses a missing env file", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--commit", "--stdin"], {
    input: "correct horse battery\n",
    env: { ...process.env, WILCO_ENV_PATH: "/nonexistent/.env" },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
});
