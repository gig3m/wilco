// @vitest-environment node
import { test } from "vitest";
import assert from "node:assert/strict";
import { createStore, type Row } from "./store";

// Local helper -- this task predates the shared test-utils module that
// arrives in Task 5, and the brief's own `row()` calls need a definition.
function row(account: string, id: string): Row {
  return { account, id };
}

test("SELECTION SURVIVES NEW MAIL ARRIVING AT THE TOP", () => {
  // The dovetail bug this exists to prevent: index-tracking moves the
  // highlight onto a different message while the pane still shows the one
  // you opened.
  const store = createStore();
  store.setRows([row("personal", "M2"), row("personal", "M1")]);
  store.select({ account: "personal", id: "M1" });
  store.setRows([row("personal", "M3"), row("personal", "M2"), row("personal", "M1")]);
  assert.deepEqual(store.selection(), { account: "personal", id: "M1" });
});

test("the same id in two accounts is two different selections", () => {
  // Real collision test (Important 3): select {work, M1}, then push a row
  // list where {personal, M1} is STILL present but {work, M1} is gone. If
  // the reconciliation matched by id alone -- ignoring account -- it would
  // wrongly see {personal, M1} as "the same message" and keep the
  // selection. The correct behavior is for the selection to clear, because
  // {work, M1} really is a distinct message and it is no longer there.
  const store = createStore();
  store.setRows([row("personal", "M1"), row("work", "M1")]);
  store.select({ account: "work", id: "M1" });
  assert.deepEqual(store.selection(), { account: "work", id: "M1" });

  store.setRows([row("personal", "M1")], { reason: "server" });
  assert.equal(
    store.selection(),
    null,
    "selection must clear -- {personal, M1} is a different message than {work, M1}, not a match",
  );
});

test("A LIST CHANGE FROM TYPING DOES NOT MOVE THE READING PANE", () => {
  // Spec 7.3: the pane follows the highlight only when the SERVER moved a
  // message under you. Following a local list change is what silently
  // steals focus from the search box mid-word.
  const store = createStore();
  store.setRows([row("personal", "M1")]);
  store.select({ account: "personal", id: "M1" });
  store.setRows([row("personal", "M9")], { reason: "local" });
  assert.equal(store.selection(), null, "selection clears, but");
  assert.equal(store.paneFollowed(), false, "the pane does not chase it");
});

test("A LOCAL CHANGE THAT LEAVES THE SELECTED ROW IN PLACE DOES NOT COUNT AS A FOLLOW", () => {
  // Important 2: the brief's own "list change from typing" test removes
  // the selected row entirely, which clears selection regardless of
  // reason -- it would pass even if the reason logic were deleted. The
  // real search-box-focus-steal scenario is a local (typing-driven) list
  // change where the selected row is STILL present: selection must be
  // left alone (never re-matched/re-highlighted), and paneFollowed() must
  // be false because nothing server-driven happened.
  const store = createStore();
  store.setRows([row("personal", "M1"), row("personal", "M2")]);
  store.select({ account: "personal", id: "M1" });
  store.setRows([row("personal", "M2"), row("personal", "M1")], { reason: "local" });
  assert.deepEqual(store.selection(), { account: "personal", id: "M1" }, "selection is untouched");
  assert.equal(store.paneFollowed(), false, "a local change is never a follow, even when nothing was dropped");
});

test("a server push that carries the selected message forward is a follow", () => {
  const store = createStore();
  store.setRows([row("personal", "M1")]);
  store.select({ account: "personal", id: "M1" });
  store.setRows([row("personal", "M2"), row("personal", "M1")], { reason: "server" });
  assert.deepEqual(store.selection(), { account: "personal", id: "M1" });
  assert.equal(store.paneFollowed(), true);
});

test("selecting nothing clears the selection", () => {
  const store = createStore();
  store.setRows([row("personal", "M1")]);
  store.select({ account: "personal", id: "M1" });
  store.select(null);
  assert.equal(store.selection(), null);
});

test("rows() reflects the last setRows call", () => {
  const store = createStore();
  const rows = [row("personal", "M1"), row("personal", "M2")];
  store.setRows(rows);
  assert.deepEqual(store.rows(), rows);
});
