import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * A saved search stores the QUERY TEXT, never a materialised result set
 * (spec 7.3) -- it re-runs against live mail every time it's opened, so it
 * cannot go stale the way a cached row list would. It lives server-side in
 * `saved_searches` (migration 3), not in browser storage, for the same
 * reason the undo stack is server-side: two devices must not disagree
 * about what exists.
 */
export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  position: number;
  createdAt: string;
}

export class SavedSearchError extends Error {}

interface SavedRow {
  id: string;
  name: string;
  query: string;
  position: number;
  created_at: string;
}

function toSaved(r: SavedRow): SavedSearch {
  return { id: r.id, name: r.name, query: r.query, position: r.position, createdAt: r.created_at };
}

/** Ordered by position, then name, so ties (freshly added rows all at 0)
 *  come back in a predictable, stable order rather than insertion/rowid
 *  order. */
export function listSaved(db: DatabaseSync): SavedSearch[] {
  const rows = db
    .prepare("SELECT id, name, query, position, created_at FROM saved_searches ORDER BY position, name")
    .all() as unknown as SavedRow[];
  return rows.map(toSaved);
}

/**
 * Validates only that the query is non-empty once trimmed -- `parseQuery`
 * (src/core/searchquery.ts) never throws, so it is not a validator, and an
 * unrecognised `word:` operator (spec 4.4 rule 2) is a legitimate literal
 * search term, not an error. Names may repeat; ids never do (random,
 * per-row).
 */
export function addSaved(db: DatabaseSync, name: string, query: string): SavedSearch {
  if (query.trim() === "") {
    throw new SavedSearchError("query must not be empty");
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const { max } = db.prepare("SELECT COALESCE(MAX(position), -1) AS max FROM saved_searches").get() as {
    max: number;
  };
  const position = max + 1;

  db.prepare(
    `INSERT INTO saved_searches (id, name, query, position, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, query, position, now);

  return { id, name, query, position, createdAt: now };
}

/**
 * Renaming an unknown id is deliberately NOT idempotent the way
 * removeSaved() below is. A rename tells the caller a SPECIFIC new value
 * was persisted; if there is no row, nothing was persisted, and reporting
 * success would be a false success -- exactly the "two devices disagree
 * about what exists" failure saved searches exist server-side to prevent
 * (spec 7.3). Delete's end state ("this id is gone") is the same whether
 * or not a row existed, so idempotency is honest there; rename has no such
 * equivalent end state to fall back on. Throws SavedSearchError when no
 * row matched `id`, which the route below turns into a 404.
 */
export function renameSaved(db: DatabaseSync, id: string, name: string): void {
  const result = db.prepare("UPDATE saved_searches SET name = ? WHERE id = ?").run(name, id);
  if (Number(result.changes) === 0) {
    throw new SavedSearchError(`no saved search with id ${JSON.stringify(id)}`);
  }
}

/**
 * Idempotent by design, unlike renameSaved() above: "this id is gone" is
 * the same end state whether or not a row existed, so a DELETE on an
 * already-missing id is honestly a 200, not a 404.
 */
export function removeSaved(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM saved_searches WHERE id = ?").run(id);
}

/**
 * `ids` must be a full permutation of every existing saved-search id --
 * never a subset. Accepting a partial list would leave every row it
 * omits at whatever position it last had (or, worse, colliding at 0),
 * which reads to the user as the sidebar spontaneously reshuffling.
 */
export function reorderSaved(db: DatabaseSync, ids: string[]): void {
  const existing = db.prepare("SELECT id FROM saved_searches").all() as unknown as { id: string }[];
  const existingIds = new Set(existing.map((r) => r.id));

  const isPermutation =
    ids.length === existingIds.size &&
    new Set(ids).size === ids.length &&
    ids.every((id) => existingIds.has(id));

  if (!isPermutation) {
    throw new SavedSearchError("reorder must include every saved search exactly once");
  }

  const update = db.prepare("UPDATE saved_searches SET position = ? WHERE id = ?");
  ids.forEach((id, index) => update.run(index, id));
}
