import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.ts";
import { addSaved, listSaved, removeSaved, renameSaved, reorderSaved } from "../src/core/saved.ts";
import { tempDbPath } from "./tmpdir.ts";

/**
 * Local to this file (Ruling P1): a fresh temp-file database per test, same
 * pattern test/read-api.test.ts uses for its own tempDb().
 */
function freshDb(): DatabaseSync {
  return openDb(tempDbPath());
}

test("a saved search stores the query text, not results", () => {
  const db = freshDb();
  const s = addSaved(db, "Unread work", "is:unread acct:work");
  assert.equal(s.query, "is:unread acct:work");
  const cols = db.prepare("PRAGMA table_info(saved_searches)").all() as { name: string }[];
  assert.ok(
    !cols.some((c) => c.name.includes("result")),
    "materialising results would let a saved search go stale",
  );
});

test("names may repeat but ids do not", () => {
  const db = freshDb();
  const a = addSaved(db, "Work", "acct:work");
  const b = addSaved(db, "Work", "acct:work is:unread");
  assert.notEqual(a.id, b.id);
});

test("reordering is a permutation, and a partial list is refused", () => {
  const db = freshDb();
  const a = addSaved(db, "A", "acct:work");
  const b = addSaved(db, "B", "acct:personal");
  reorderSaved(db, [b.id, a.id]);
  assert.deepEqual(listSaved(db).map((s) => s.name), ["B", "A"]);
  assert.throws(
    () => reorderSaved(db, [a.id]),
    /every saved search/,
    "a partial reorder would silently drop rows to position 0",
  );
});

test("reorderSaved rejects a same-length list with a duplicated id", () => {
  // Same length as the real id set, so a bare length check would wrongly
  // accept this -- it's the Set dedup inside isPermutation that catches
  // it. Pinned so a future "simplification" can't drop that dedup.
  const db = freshDb();
  const a = addSaved(db, "A", "acct:work");
  addSaved(db, "B", "acct:personal");
  assert.throws(() => reorderSaved(db, [a.id, a.id]), /every saved search/);
});

test("an empty query is refused", () => {
  const db = freshDb();
  assert.throws(() => addSaved(db, "Nothing", "   "), /query/);
});

test("a tab-only query is refused", () => {
  // String.trim() strips tabs today; pin the behavior explicitly rather
  // than leaving it to be inherited incidentally from trim()'s full
  // whitespace definition.
  const db = freshDb();
  assert.throws(() => addSaved(db, "Nothing", "\t\t"), /query/);
});

test("AN UNKNOWN OPERATOR IS A VALID SAVED SEARCH", () => {
  // Rule 2 of spec 4.4: 'note:' is a search term, so it is savable.
  const db = freshDb();
  assert.doesNotThrow(() => addSaved(db, "Notes", "note:followup"));
});

test("listSaved orders by position then name", () => {
  const db = freshDb();
  addSaved(db, "Zeta", "acct:work");
  addSaved(db, "Alpha", "acct:personal");
  // Ties on position (the common case is two rows added in the same batch,
  // or a client that hasn't reordered yet) fall back to name.
  db.exec("UPDATE saved_searches SET position = 0");
  const names = listSaved(db).map((s) => s.name);
  assert.deepEqual(names, ["Alpha", "Zeta"]);
});

test("renameSaved changes the name only", () => {
  const db = freshDb();
  const s = addSaved(db, "Old", "acct:work");
  renameSaved(db, s.id, "New");
  const found = listSaved(db).find((x) => x.id === s.id)!;
  assert.equal(found.name, "New");
  assert.equal(found.query, "acct:work");
});

test("removeSaved deletes the row", () => {
  const db = freshDb();
  const s = addSaved(db, "Gone", "acct:work");
  removeSaved(db, s.id);
  assert.equal(listSaved(db).length, 0);
});

test("reorderSaved rejects an id that does not belong to any saved search", () => {
  const db = freshDb();
  const a = addSaved(db, "A", "acct:work");
  assert.throws(() => reorderSaved(db, [a.id, "no-such-id"]), /every saved search/);
});
