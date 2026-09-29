/**
 * The pending-write set — spec 3.7, "One writer, and the race that makes it
 * necessary".
 *
 * > "§3.6 applies actions optimistically, then calls `Email/set`.
 * > Concurrently the push reader runs `Email/changes` roughly every 1.2s
 * > and upserts `is_unread`, `is_flagged` and mailbox membership **from the
 * > server's view**. With no ordering between them: archive a message, push
 * > fires mid-flight, `Email/get` returns the pre-action state, and **the
 * > row reappears in the inbox** before vanishing again on the next round."
 * >
 * > "Discipline: a pending-write set keyed `(account, id)` is held for the
 * > duration of each `Email/set`, and sync skips those rows. The spec names
 * > a single writer for every row at every moment; **an implementation that
 * > does not is wrong even if it passes tests.**"
 *
 * Audit pass 2 (F1) found this had never been built — the only one of the
 * spec's 54 sections marked absent, and the one the spec itself flags in
 * bold as the kind an implementation can silently get wrong.
 *
 * ## Why a process-level singleton
 *
 * The writer (`triage-api`, `send-api`) and the reader (`refresh`, the
 * archive walk) are the same Node process, so a module-level map is exactly
 * the scope the invariant needs. It is deliberately NOT in SQLite: a write
 * in flight is a property of THIS process's runtime, and a row left marked
 * pending in a table by a crashed process would freeze that row out of sync
 * forever with nothing to clear it.
 *
 * ## The failure mode this must not have
 *
 * 🚨 A leaked entry is WORSE than the race it prevents. The race resolves
 * itself on the next sync round; a row stuck pending is invisible to sync
 * permanently, which looks like mail that never updates. So:
 *
 *   - `withPendingWrites` releases in a `finally`, so a throw cannot leak.
 *   - Entries carry a start time and `isPending` ignores anything older than
 *     `MAX_PENDING_MS`. A JMAP call outliving that has failed in a way no
 *     bookkeeping will fix, and the row must rejoin sync rather than be
 *     frozen out by a bug somewhere else.
 *   - Held as a REFERENCE COUNT, not a boolean: two overlapping writes to
 *     one row (archive a selection, then flag one of them) must not have the
 *     first release cancel the second's protection.
 */

/** How long an entry is honoured before sync stops skipping the row. Well
 *  past any real `Email/set` round trip -- this is a safety valve against a
 *  leak, not a timeout for the write itself. */
const MAX_PENDING_MS = 60_000;

interface Entry {
  /** Overlapping writes to the same row; the row is protected until every
   *  one of them has finished. */
  count: number;
  startedAt: number;
}

/** A NUL separator, written as the ESCAPE `\u0000` and never as a literal.
 *  An account key or a JMAP id can contain most things but never a NUL, so
 *  it is the one byte that cannot collide two different pairs onto one key.
 *
 *  🚨 A literal NUL renders as a space in every editor and makes git treat
 *  the whole file as BINARY -- its diffs stop being reviewable. Audit pass 4
 *  found a test file that had been unreviewable since creation for exactly
 *  this reason, and `test/source-hygiene.test.ts` exists because of it. That
 *  test caught this file on its first full run; the fix is the escape, not
 *  an exemption. */
function keyFor(account: string, id: string): string {
  return `${account}\u0000${id}`;
}

const entries = new Map<string, Entry>();

/** Test seam only: the set is process state, so a test that leaves an entry
 *  behind would silently change what the NEXT test's sync sees. */
export function resetPendingWrites(): void {
  entries.clear();
}

/** How many rows are currently held. Exposed for assertions and for the
 *  leak check in tests -- never branch on it in production code. */
export function pendingWriteCount(): number {
  return entries.size;
}

export function beginWrite(account: string, id: string, now: number = Date.now()): void {
  const k = keyFor(account, id);
  const existing = entries.get(k);
  if (existing === undefined) {
    entries.set(k, { count: 1, startedAt: now });
    return;
  }
  existing.count += 1;
}

export function endWrite(account: string, id: string): void {
  const k = keyFor(account, id);
  const existing = entries.get(k);
  if (existing === undefined) return;
  existing.count -= 1;
  if (existing.count <= 0) entries.delete(k);
}

/**
 * Whether sync should SKIP this row because we are mid-write on it.
 *
 * A stale entry (see `MAX_PENDING_MS`) reports false and is dropped: the
 * safe direction is to let sync win, because a row that rejoins sync
 * self-corrects while a row frozen out of it does not.
 */
export function isPending(account: string, id: string, now: number = Date.now()): boolean {
  const k = keyFor(account, id);
  const existing = entries.get(k);
  if (existing === undefined) return false;
  if (now - existing.startedAt > MAX_PENDING_MS) {
    entries.delete(k);
    return false;
  }
  return true;
}

/**
 * Holds `targets` for the duration of `fn` — the whole discipline in one
 * call, so no caller has to remember to release.
 *
 * 🚨 Release is in a `finally`. `Email/set` rejecting is the NORMAL failure
 * path here (an expired token, a network drop), and a leak on that path
 * would freeze exactly the rows a person just acted on.
 */
export async function withPendingWrites<T>(
  targets: readonly { account: string; id: string }[],
  fn: () => Promise<T>,
): Promise<T> {
  for (const t of targets) beginWrite(t.account, t.id);
  try {
    return await fn();
  } finally {
    for (const t of targets) endWrite(t.account, t.id);
  }
}
