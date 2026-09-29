/**
 * Set the Wilco web login password.
 *
 * Replaces a three-step manual ritual that had two traps in it: compute an
 * scrypt hash by hand, remember that docker compose eats single `$` so the
 * hash must be written with DOUBLED dollars, and separately record the
 * plaintext in `keys`. Getting the doubling wrong fails at login with
 * "that password didn't work" and no indication that `.env` is the problem.
 *
 * Usage (from the repo root, on the host — it edits `.env`):
 *
 *   node scripts/set-password.ts                 # prompt, no echo; dry run
 *   node scripts/set-password.ts --commit        # prompt, then write
 *   node scripts/set-password.ts --commit --stdin < file
 *
 * `WILCO_ENV_PATH` overrides which `.env` gets edited — set it when only
 * `scripts/` exists (an image-only install) or when driving this from
 * `bootstrap.sh`. Unset, it defaults to the `.env` beside this checkout.
 *
 * Dry run by default, like the other scripts here. It prints what it would
 * change and exits without touching anything.
 *
 * The password is never printed, never logged, and never passed as an argv
 * value (argv is world-readable via /proc). It is read from a no-echo TTY
 * prompt, or from stdin with --stdin.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { hashPassword, verifyPassword } from "../src/server/auth.ts";

/** The .env to edit. Defaults to the one beside this checkout; bootstrap.sh
 *  and image-only installs set WILCO_ENV_PATH explicitly. */
const ENV_PATH = process.env["WILCO_ENV_PATH"] ?? new URL("../.env", import.meta.url).pathname;
const VAR = "WILCO_PASSWORD_HASH";
// 8, not 12: the owner chose a 9-character password on 2026-09-08 and this
// is their front door on a tailnet-only host -- their call, made knowingly.
const MIN_LENGTH = 8;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Read a password without echoing it to the terminal. */
function promptNoEcho(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("stdin is not a TTY — use --stdin to pipe the password in"));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Suppress echo: readline writes the prompt, we blank everything after it.
    const output = process.stdout as unknown as { write: (chunk: string) => boolean };
    const realWrite = output.write.bind(output);
    let muted = false;
    output.write = (chunk: string) => (muted ? true : realWrite(chunk));
    rl.question(prompt, (answer) => {
      output.write = realWrite;
      realWrite("\n");
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
    process.stdin.on("error", reject);
  });
}

/**
 * Write the hash into `.env`, doubling every `$`.
 *
 * 🚨 This is the trap the script exists to remove. docker compose performs
 * variable interpolation on `.env` values, so a literal `scrypt$salt$key`
 * loses `$salt` and `$key` as "undefined variables" and the container
 * receives a truncated hash. `$$` is compose's escape for a literal `$`.
 */
function envLineFor(hash: string): string {
  return `${VAR}=${hash.replaceAll("$", "$$$$")}`;
}

function upsert(contents: string, line: string): string {
  const pattern = new RegExp(`^${VAR}=.*$`, "m");
  // 🚨 The replacement MUST be a function. `String.replace` treats `$$` in a
  // string replacement as an escape for a literal `$`, which silently undoes
  // the dollar-doubling above and writes a single-dollar hash that compose
  // then truncates -- the exact failure this script exists to prevent. A
  // replacer function receives no `$` substitution at all.
  if (pattern.test(contents)) return contents.replace(pattern, () => line);
  return contents.endsWith("\n") || contents === "" ? `${contents}${line}\n` : `${contents}\n${line}\n`;
}

const args = new Set(process.argv.slice(2));
const commit = args.has("--commit");
const fromStdin = args.has("--stdin");

if (!existsSync(ENV_PATH)) fail(`${ENV_PATH} does not exist — run this on the host, from the repo root`);

const password = fromStdin ? await readStdin() : await promptNoEcho("New Wilco password: ");
if (password.length === 0) fail("empty password");
if (password.length < MIN_LENGTH) fail(`password must be at least ${MIN_LENGTH} characters (got ${password.length})`);

if (!fromStdin) {
  const again = await promptNoEcho("Confirm: ");
  if (again !== password) fail("passwords do not match");
}

const hash = await hashPassword(password);

// Prove the hash verifies before it is written anywhere. A hash that does not
// round-trip would lock the account out with no way back in short of editing
// the file by hand — exactly the situation this script exists to prevent.
if (!(await verifyPassword(password, hash))) fail("internal: generated hash failed to verify — nothing written");

const before = readFileSync(ENV_PATH, "utf8");
const after = upsert(before, envLineFor(hash));

if (!commit) {
  const had = new RegExp(`^${VAR}=`, "m").test(before);
  console.log(`dry run — nothing written. Re-run with --commit.`);
  console.log(`  ${ENV_PATH}: would ${had ? "replace" : "add"} ${VAR} (${hash.length}-char hash, dollars doubled)`);
  console.log(`  password accepted: ${password.length} characters, hash verified`);
  process.exit(0);
}

const backup = `${ENV_PATH}.bak-${new Date().toISOString().slice(0, 10)}`;
copyFileSync(ENV_PATH, backup);
writeFileSync(ENV_PATH, after, { mode: 0o600 });

console.log(`wrote ${VAR} to ${ENV_PATH} (previous file saved as ${backup})`);
console.log("");
console.log("Next: docker compose up -d wilco    # `restart` does NOT re-read .env");
console.log("Verify through WILCO_BASE_URL, never the raw host:port -- the CSRF check");
console.log("requires Origin to equal WILCO_BASE_URL, so a raw-IP login answers 403 and");
console.log("looks exactly like a wrong password.");
