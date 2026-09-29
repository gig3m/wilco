// @vitest-environment node
//
// The first test reads the server's own source file off disk to guard
// against operator-set drift (see query.ts's module doc comment), which a
// happy-dom environment cannot do -- there is no filesystem in that
// sandbox. Runs under plain node, matching escape.test.ts's precedent.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";
import { CLIENT_OPERATORS, tokenise } from "./query";

// Resolved from this file's own location, not process.cwd() -- see
// escape.test.ts's identical reasoning (round 1 review there flagged a
// cwd-dependent path as silently reporting nothing under some invocations).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the client's operator set matches the server's exactly", () => {
  // Drift here means the UI shows a chip for something the server treats as
  // text, or vice versa -- the user sees a chip and gets full-text results.
  const server = readFileSync(join(REPO_ROOT, "src/core/searchquery.ts"), "utf8");
  for (const op of CLIENT_OPERATORS) {
    assert.ok(server.includes(`"${op}"`), `server does not know ${op}`);
  }
  assert.equal(CLIENT_OPERATORS.length, 10);
});

test("tokenising splits chips from free text and keeps an unknown prefix as text", () => {
  const t = tokenise("from:robin note:x budget");
  assert.deepEqual(t.chips, [{ op: "from", value: "robin" }]);
  assert.equal(t.text, "note:x budget", "an unrecognised prefix is a term, not a chip");
});

test("a bare operator with nothing after the colon is text, not a chip", () => {
  const t = tokenise("from: budget");
  assert.deepEqual(t.chips, []);
  assert.equal(t.text, "from: budget");
});

test("multiple recognised operators all become chips, in order", () => {
  const t = tokenise("is:unread has:attachment budget report");
  assert.deepEqual(t.chips, [
    { op: "is", value: "unread" },
    { op: "has", value: "attachment" },
  ]);
  assert.equal(t.text, "budget report");
});

test("an empty or whitespace-only input has no chips and no text", () => {
  assert.deepEqual(tokenise(""), { chips: [], text: "" });
  assert.deepEqual(tokenise("   "), { chips: [], text: "" });
});
