// The test runner entry point. `npm test` goes through here, never straight
// to `node --test`.
//
// 🚨 WHY THIS EXISTS: the suite leaked 930 MB of /tmp on the host.
//
// Every test file builds its database with
// `mkdtempSync(path.join(tmpdir(), "wilco-"))` and never removes it -- 69 call
// sites across 23 files, each leaving one directory holding a ~160 KB
// `wilco.db` behind. A single run leaks hundreds; a day of repeated runs left
// 6,336 directories and 930 MB on the dev box, found by a filesystem audit and
// not by anything in this repo.
//
// 🚨 THIS FILE IS THE BELT, NOT THE BRACES. `test/tmpdir.ts` is the real fix:
// it creates every test directory inside one per-process root and removes it on
// exit, so the cleanup travels with the call site.
//
// This wrapper existed first and covered only `npm test`, which turned out to
// be the wrong half. A direct `node --test test/one.test.ts` bypasses it
// completely, and that invocation is not an edge case -- it is what iterating
// on one file or mutation-testing a fix looks like, and it is measurably what
// produced the leak (one loop over `read-api.test.ts` made 39 directories a
// run). Measured by the session that was running that loop, which is how the
// gap was found.
//
// What the wrapper still earns its place for:
//
//   * `$TMPDIR`. `os.tmpdir()` honours it on Linux, so this relocates anything
//     that reaches for a temp directory WITHOUT going through the helper --
//     including code written later by someone who never reads either file.
//   * Signals. `tmpdir.ts` cleans up via `process.on("exit")`, which does not
//     fire on SIGINT/SIGTERM. The handlers below forward the signal to the
//     child and then clean up on its `close`, so Ctrl-C leaves nothing.
//   * Child processes. `backfill.test.ts` spawns
//     `test/fixtures/backfill-progress-guard*.ts`; they inherit the
//     environment, so even the ones that predate the helper land inside the
//     run root.
//
// What neither covers, stated rather than left to be discovered: `SIGKILL` or a
// hard crash leaves one root behind. One directory, not several hundred, and
// the next run does not compound it.
//
// Two files already got this right and are the evidence the mechanism works:
// `test/migrations.test.ts` and `client/harness/shoot.mjs` both `rmSync` their
// scratch directories, and neither has ever appeared in the leak.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Resolved BEFORE $TMPDIR is overwritten, or the root would be created inside
// whatever the previous run set.
const root = mkdtempSync(path.join(tmpdir(), "wilco-testrun-"));

function cleanup() {
  rmSync(root, { recursive: true, force: true });
}

// A glob, not the `test/` directory. On Node 22.23 `node --test test/` no
// longer treats the positional as a directory to search -- it tries to LOAD it
// as a module, fails with MODULE_NOT_FOUND, and exits 1 having run zero tests
// while printing a plausible-looking `# fail 1` (audit pass 1). Node expands
// this pattern itself, so passing it as a single argv entry is correct.
const args = process.argv.slice(2);
const child = spawn(process.execPath, ["--test", ...(args.length > 0 ? args : ["test/*.test.ts"])], {
  stdio: "inherit",
  env: { ...process.env, TMPDIR: root },
});

// Forward the interrupt rather than dying with it: the child gets to finish
// tearing down, and THIS process stays alive long enough to run cleanup on the
// 'close' below. Exiting here instead would leak the root on every Ctrl-C.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("close", (code, signal) => {
  try {
    cleanup();
  } finally {
    // Report the child's own outcome verbatim. Swallowing a failure here would
    // make `npm test` green on a red suite, which is the same class of defect
    // as the `node --test test/` bug above.
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  }
});

child.on("error", (err) => {
  cleanup();
  console.error(err);
  process.exit(1);
});
