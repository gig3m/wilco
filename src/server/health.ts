import type { DatabaseSync } from "node:sqlite";
import type { AccountSpec } from "../core/accounts.ts";
import { getSyncState, lastSyncAt, detailsFailureCount } from "../core/mutations.ts";
import { classify } from "../core/failures.ts";
import type { FailureKind } from "../core/failures.ts";

export type AccountState = { kind: "ok" } | { kind: FailureKind; message: string };

export interface HealthReport {
  ok: boolean;
  /** Set only when there is nothing to report on. An empty `accounts` array
   *  must never look identical to "every account is healthy" -- that is the
   *  vacuous truth of Array.prototype.every() on an empty list, and it is
   *  exactly the silent-green state a stopped sync loop (or a genuinely
   *  empty accounts table, e.g. before it is seeded) must not produce. */
  error?: string;
  accounts: {
    account: string;
    label: string;
    state: string;
    message?: string;
    walkComplete: boolean;
    hasEmailCursor: boolean;
    lastSyncAt: string | null;
    stale: boolean;
    /**
     * A first walk that is MOVING: not yet complete, not failing, and it
     * stored something within `staleAfterMs`. It is not a fault, and before
     * 2026-09-22 it was reported as one -- a 167k-message mailbox spends
     * hours here with `walk` unfinished and no completed pass to record
     * liveness, so /healthz answered 503 for the whole of a healthy sync.
     * `stale` is false while this is true, and `ok` does not demand a
     * finished walk. Progress comes from the supervisor's progressAt map;
     * with no map, nothing is ever syncing and the old report stands.
     */
    syncing: boolean;
    /** Review fix, Important 1: a details-backfill error (recipients/
     *  attachments/Via) is deliberately kept from flipping `state`/`ok` --
     *  see supervisor.ts and mutations.ts's recordDetailsFailure -- but a
     *  persistently failing account must still be visible to an operator
     *  somewhere. This is that somewhere. Zero is the overwhelmingly common
     *  case and carries no meaning beyond "nothing to report". */
    detailsBackfillFailures: number;
  }[];
}

/**
 * A sync loop that has stopped must be visible from outside. Reporting only
 * boot-time state pins the endpoint at "ok" for the life of the process, which
 * means the monitor can only ever go red on a dead container -- exactly the
 * failure this endpoint exists to catch (spec 8.5).
 */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export interface HealthOptions {
  now?: () => number;
  staleAfterMs?: number;
  /** The supervisor's progress map: account -> epoch ms of the last batch
   *  stored (or pass started). See SupervisorDeps.progressAt. */
  progressAt?: Map<string, number>;
}

/**
 * Per-account, deliberately. A mail client whose sync loop has stopped for one
 * account looks perfectly healthy in an aggregate (spec 8.5).
 */
export function accountHealth(
  db: DatabaseSync,
  accountList: AccountSpec[],
  states: Map<string, AccountState>,
  opts: HealthOptions = {},
): HealthReport {
  if (accountList.length === 0) {
    // [].every(...) is vacuously true -- without this branch, zero configured
    // accounts (the live table before Task 8 seeds it, or a caller that
    // forgets to pass any) reports 200 {ok:true, accounts:[]} while nothing
    // syncs anything. Before accounts were table-backed this state was
    // unreachable (ACCOUNTS was a nonempty compile-time constant); it is
    // reachable now, so it needs its own explicit answer.
    return { ok: false, error: "no accounts configured", accounts: [] };
  }

  const now = (opts.now ?? Date.now)();
  const staleAfter = opts.staleAfterMs ?? STALE_AFTER_MS;

  const accounts = accountList.map((a) => {
    const state = states.get(a.key) ?? { kind: "unknown" as const, message: "never synced" };
    const at = lastSyncAt(db, a.key);
    const walkComplete = getSyncState(db, a.key, "walk") === "done";
    const progress = opts.progressAt?.get(a.key);
    // Deliberately gated on `state.kind === "ok"`: the supervisor abandons a
    // pass by setting a failure state, and the abandoned pass keeps running
    // underneath and may tick again. Without this gate that stray tick would
    // dress a reported failure up as a healthy walk.
    const syncing =
      !walkComplete && state.kind === "ok" && progress !== undefined && now - progress <= staleAfter;
    const stale = syncing ? false : at === null || now - at > staleAfter;
    return {
      account: a.key,
      label: a.label,
      state: state.kind,
      ...("message" in state ? { message: state.message } : {}),
      walkComplete,
      hasEmailCursor: getSyncState(db, a.key, "email") !== null,
      lastSyncAt: at === null ? null : new Date(at).toISOString(),
      stale,
      syncing,
      detailsBackfillFailures: detailsFailureCount(db, a.key),
    };
  });

  // walkComplete and hasEmailCursor are JUDGED, not merely reported (C4).
  // Ruling G16 deliberately stopped the startup walk writing `states`, so a
  // walk that died on its progress guard leaves nothing but a console.error;
  // and fetchChanges returns an empty SUCCESSFUL ChangeSet when there is no
  // cursor, so an account syncing nothing on every pass recorded liveness and
  // reported healthy. Both facts come from the DB, so this needs no write to
  // `states` and stays compatible with G16.
  return {
    // `|| a.syncing`: walkComplete is still JUDGED, it is simply not yet DUE
    // on an account whose first walk is visibly advancing.
    ok: accounts.every((a) => a.state === "ok" && !a.stale && (a.walkComplete || a.syncing) && a.hasEmailCursor),
    accounts,
  };
}

/**
 * Turn a caught error into the AccountState bootstrapAccount records.
 *
 * classify() only recognises HttpStatusError and a fixed set of node network
 * error codes -- everything else, including the two most diagnostic messages
 * in this codebase (walkArchive's and backfillBodies's own progress-guard
 * errors, e.g. "archive walk made no progress for personal: the server
 * repeated the page ending at Mabc"), collapses to the generic "an
 * unrecognised error occurred". For an "unknown" failure, use the real
 * Error.message instead so those messages are reachable.
 *
 * Safe: every throw site in src/core/ builds its message from account keys,
 * message ids, schema versions and env-var NAMES only, never a token value
 * (see client.ts's "Message is built from the status only" comment and
 * KeysCliStore in credentials.ts, which discards the subprocess error whose
 * `stdout` IS the credential) -- verified by inspection before this
 * function was written, not assumed.
 */
export function failureState(err: unknown): AccountState {
  const f = classify(err);
  if (f.kind !== "unknown") return { kind: f.kind, message: f.message };
  const detail = err instanceof Error ? err.message : String(err);
  return { kind: f.kind, message: detail };
}
