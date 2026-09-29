import { test } from "node:test";
import assert from "node:assert/strict";
import { excludedIdsFromMailboxes, buildExclusionFilter } from "../scripts/verify-corpus-filter.ts";

// Pins the live defect: an empty mailbox list (or one with no trash/junk
// roles) must produce an empty exclusion list and NO filter -- not a filter
// that happens to exclude nothing, and never a crash.
test("excludedIdsFromMailboxes: no trash/junk roles present -> empty list", () => {
  const list = [
    { id: "P-Inbox", role: "inbox" },
    { id: "P-Arc", role: "archive" },
  ];
  assert.deepEqual(excludedIdsFromMailboxes(list), []);
});

test("excludedIdsFromMailboxes: empty mailbox list -> empty list", () => {
  assert.deepEqual(excludedIdsFromMailboxes([]), []);
});

test("excludedIdsFromMailboxes: null/undefined role is not trash/junk", () => {
  const list = [
    { id: "P-Inbox", role: null },
    { id: "P-Weird", role: undefined },
  ];
  assert.deepEqual(excludedIdsFromMailboxes(list), []);
});

test("excludedIdsFromMailboxes: picks trash and junk ids, ignores everything else", () => {
  const list = [
    { id: "P-Inbox", role: "inbox" },
    { id: "P-Trash", role: "trash" },
    { id: "P-Spam", role: "junk" },
    { id: "P-Arc", role: "archive" },
  ];
  assert.deepEqual(excludedIdsFromMailboxes(list).sort(), ["P-Spam", "P-Trash"].sort());
});

test("buildExclusionFilter: empty exclusion list -> no filter at all", () => {
  assert.equal(buildExclusionFilter([]), undefined);
});

test("buildExclusionFilter: matches walkArchive's AND/NOT/inMailbox shape", () => {
  const filter = buildExclusionFilter(["T1", "S1"]);
  assert.deepEqual(filter, {
    operator: "AND",
    conditions: [
      { operator: "NOT", conditions: [{ inMailbox: "T1" }] },
      { operator: "NOT", conditions: [{ inMailbox: "S1" }] },
    ],
  });
});
