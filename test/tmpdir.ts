/**
 * Temp directories for tests, which remove themselves.
 *
 * 🚨 WHY THIS EXISTS: the suite leaked 930 MB of /tmp on the host — 6,336
 * `/tmp/wilco-XXXXXX` directories over about a day, each holding one
 * `wilco.db`, found by a filesystem audit and not by anything in this repo.
 * Every test built its database with `mkdtempSync(path.join(tmpdir(),
 * "wilco-"))` and nothing ever removed it.
 *
 * `test/run.mjs` closes half of that by pointing `$TMPDIR` at a run root it
 * deletes afterwards. It is not enough on its own: it is wired into
 * `npm test`, and a direct `node --test test/one.test.ts` bypasses it
 * entirely. That invocation is not an edge case — it is what iterating on one
 * file or mutation-testing a fix looks like, and it is measurably what
 * produced the leak (one loop over `read-api.test.ts` makes 39 directories a
 * run). So the cleanup has to live where the directory is created.
 *
 * Use `tempDir()` instead of `mkdtempSync`, and `tempDbPath()` for the common
 * case of "somewhere to put a `wilco.db`".
 *
 * HOW IT CLEANS UP
 *
 * One root per process, removed by a single `process.on("exit")` handler. Per
 * root rather than per directory because `exit` handlers must be synchronous
 * and few: one `rmSync` of a tree beats several hundred registrations.
 *
 * `exit` fires on a normal return, on `process.exit()`, and after an uncaught
 * exception — so a FAILING run cleans up as readily as a passing one, which
 * was explicitly part of the ask. It does NOT fire on a signal, so `run.mjs`
 * keeps its own root and its SIGINT/SIGTERM forwarding as the belt to this
 * pair of braces: under `npm test` this root is created inside run.mjs's root
 * (it honours `$TMPDIR` like everything else), so a Ctrl-C is covered there,
 * and a hard `SIGKILL` leaves one directory rather than several hundred.
 *
 * The database is still open when the handler runs. That is fine on Linux —
 * unlinking an open file is legal and the pages go when the fd does — and it
 * is why this does not try to close anything first.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let root: string | null = null;

function ensureRoot(): string {
  if (root !== null) return root;
  root = mkdtempSync(path.join(tmpdir(), "wilco-tests-"));
  const created = root;
  process.on("exit", () => {
    rmSync(created, { recursive: true, force: true });
  });
  return created;
}

/**
 * A fresh directory that will be removed when this process exits.
 *
 * `label` is a readable hint, not a uniqueness mechanism — every call gets its
 * own directory whether or not the labels collide. It exists so that a run
 * killed with `SIGKILL` leaves something a human can identify.
 */
export function tempDir(label = "d"): string {
  return mkdtempSync(path.join(ensureRoot(), `${label}-`));
}

/** The common case: a path to put a `wilco.db` at, in a directory of its own
 *  (SQLite writes `-wal` and `-shm` siblings, so the file cannot share a
 *  directory with another database). */
export function tempDbPath(label = "db"): string {
  return path.join(tempDir(label), "wilco.db");
}
