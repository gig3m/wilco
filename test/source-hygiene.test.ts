/**
 * No tracked TEXT file may contain a raw NUL byte (audit pass 5).
 *
 * 🚨 The reason is git, not the compiler. Git decides a file is binary by
 * looking for a NUL in roughly its first 8000 bytes, and a binary file gets
 * `Bin 3603 -> 8365 bytes` instead of a diff. `test/captoken.test.ts` carried
 * two NULs at line 86 from the commit that created it, so **every diff of the
 * capability-token test had been unreviewable for its entire history** — in a
 * codebase whose defects repeatedly passed review with green tests.
 *
 * `src/server/triage-api.ts` had one too, at line 241, where `key()` joined an
 * account and an id. That one still diffed only because the NUL sits past
 * git's 8000-byte window — the same defect, hidden or not by nothing more
 * than where in the file it landed. Both were invisible in an editor: a raw
 * 0x00 renders as a space.
 *
 * So this guard is about REVIEWABILITY. A source file you cannot diff is one
 * nobody can review, and that is upstream of every other check here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Extensions that are text by definition. Fonts and screenshots are
 *  legitimately binary and are not listed. */
const TEXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".yml", ".yaml", ".html", ".css", ".py", ".sh", ".sql", ".txt",
]);

test("NO TRACKED TEXT FILE CONTAINS A RAW NUL BYTE", (t) => {
  // `npm run test:docker` runs this suite inside the wilco-test image, which
  // has no git binary (and .dockerignore excludes .git from the build
  // context in the first place, so there is no worktree to ask either). That
  // makes this check meaningless there, not failing -- it is still a hard
  // gate on the host, where deploy.sh's release gate runs the full suite
  // with both git and the real worktree present.
  let raw: Buffer;
  try {
    raw = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "buffer" });
  } catch {
    t.skip("no git/worktree in this environment");
    return;
  }
  const tracked = raw
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0);

  const offenders: string[] = [];
  for (const rel of tracked) {
    if (!TEXT.has(extname(rel))) continue;
    const full = join(REPO, rel);
    let contents: Buffer;
    try {
      if (!statSync(full).isFile()) continue;
      contents = readFileSync(full);
    } catch {
      continue; // deleted or unreadable in this checkout; not this test's business
    }
    const at = contents.indexOf(0);
    if (at !== -1) {
      const line = contents.subarray(0, at).toString("utf8").split("\n").length;
      offenders.push(`${rel}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "Raw NUL bytes in text files. They render as a space in every editor and " +
      "make git treat the file as binary, so its diffs stop being reviewable. " +
      `Write the escape (\\u0000) instead:\n  ${offenders.join("\n  ")}`,
  );
});
