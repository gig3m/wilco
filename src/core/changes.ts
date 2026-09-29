import { markReconcilePending } from "./reconcile.ts";
import type { DatabaseSync } from "node:sqlite";
import type { JmapClient } from "./client.ts";
import { getSyncState, setSyncState, resetWalk, resetEmailCursor } from "./mutations.ts";

/**
 * The server caps a page and says whether more remain. Reading one page and
 * stopping loses mail on a busy account and looks completely fine.
 *
 * Bounded, though: an unbounded drain trades "loses mail" for "holds the sync
 * loop indefinitely on a large backlog", which on an always-on server is the
 * worse failure. The cursor advances every round, so the remainder arrives on
 * the next pass.
 */
export const MAX_CHANGES_PER_ROUND = 200;
export const MAX_CHANGE_ROUNDS = 25;

/**
 * Applied to the database BEFORE this round's cursor is committed.
 *
 * The cursor advances every round (see below), but the ids a round returned
 * used to be applied only after the WHOLE drain finished. Anything throwing
 * in between -- and one thing certainly did, see refresh.ts -- left the
 * cursor past changes that were never written, with no recovery path short
 * of a full resync. Ordering the write first means a throw leaves the cursor
 * where it was and the round is simply replayed: Email/get + storeEmails is
 * an upsert, so a replay is free.
 */
export type ApplyRound = (round: {
  created: string[];
  updated: string[];
  destroyed: string[];
}) => Promise<void>;

export interface ChangesOptions {
  applyRound?: ApplyRound;
}

export interface ChangeSet {
  created: string[];
  updated: string[];
  destroyed: string[];
  newState: string;
  rounds: number;
  resynced: boolean;
}

interface ChangesArgs {
  oldState?: string;
  newState?: string;
  hasMoreChanges?: boolean;
  created?: string[];
  updated?: string[];
  destroyed?: string[];
}

export async function fetchChanges(
  db: DatabaseSync,
  client: JmapClient,
  account: string,
  opts: ChangesOptions = {},
): Promise<ChangeSet> {
  const empty: ChangeSet = {
    created: [], updated: [], destroyed: [], newState: "", rounds: 0, resynced: false,
  };

  let since = getSyncState(db, account, "email");
  // The archive walk is what captures the first cursor. Without one there is
  // no baseline to ask for changes against.
  if (since === null) return empty;

  const created: string[] = [];
  const updated: string[] = [];
  const destroyed: string[] = [];
  let rounds = 0;

  while (rounds < MAX_CHANGE_ROUNDS) {
    let args: ChangesArgs;
    try {
      const [res] = await client.request([
        ["Email/changes", {
          accountId: client.session.mailAccountId,
          sinceState: since,
          maxChanges: MAX_CHANGES_PER_ROUND,
        }, "c0"],
      ]);
      args = (res?.[1] ?? {}) as ChangesArgs;
    } catch (err) {
      // The cursor is too old for the server to answer from. The only recovery
      // is to walk the archive again -- so clear the walk sentinel and let the
      // corpus walk redo it. Without this the account throws forever and sync
      // stops silently, which is the worst failure this system can have.
      if (String(err).includes("cannotCalculateChanges")) {
        // BOTH rows, not just the walk sentinel (C3). walkArchive writes the
        // cursor only `if getSyncState(...,"email") === null`, so leaving the
        // expired cursor in place means the re-walk never replaces it: the
        // next pass throws cannotCalculateChanges again, resets again, and
        // reports {kind:"ok"} again -- forever, while zero mail syncs.
        resetWalk(db, account);
        resetEmailCursor(db, account);
        // And reconcile once the re-walk completes: the walk only adds rows,
        // and everything destroyed inside this gap is otherwise lost forever
        // (checklist row 28; see reconcile.ts).
        markReconcilePending(db, account);
        return { ...empty, resynced: true };
      }
      throw err;
    }

    const next = args.newState;
    if (typeof next !== "string" || next === "") break;

    const roundCreated = args.created ?? [];
    const roundUpdated = args.updated ?? [];
    const roundDestroyed = args.destroyed ?? [];
    created.push(...roundCreated);
    updated.push(...roundUpdated);
    destroyed.push(...roundDestroyed);
    rounds += 1;

    // Write this round's changes BEFORE moving the cursor past them. If this
    // throws, the cursor still points at `since` and the round replays.
    await opts.applyRound?.({
      created: roundCreated,
      updated: roundUpdated,
      destroyed: roundDestroyed,
    });

    // Commit the cursor every round. A crash mid-drain then resumes from here
    // rather than replaying from the start or skipping what it already read.
    setSyncState(db, account, "email", next);

    // A server that reports more changes without advancing its state would
    // otherwise spin. Treat an unadvanced state as the end.
    if (next === since) break;
    since = next;

    if (!args.hasMoreChanges) break;
  }

  return { created, updated, destroyed, newState: since, rounds, resynced: false };
}
