// scripts/verify-corpus-filter.ts
/**
 * Pure filter-construction helpers for verify-corpus.ts, split into their own
 * module so they can be unit-tested without importing (and thereby running)
 * the script's top-level network/DB loop.
 */
import { EXCLUDED_ROLES } from "../src/core/corpus.ts";

/**
 * Which mailboxes this account's server currently considers Trash/Spam, by
 * role. Deliberately derived from a live `Mailbox/get` response rather than
 * the local `mailboxes` table (that is what `excludedMailboxIds` in
 * corpus.ts does, for `walkArchive`, which syncs mailboxes before it needs
 * them).
 *
 * The verifier has no such guarantee -- it can run before a first sync, or
 * against a `mailboxes` table that is empty or stale for any other reason.
 * Observed live 2026-09-02: querying with an empty local exclusion list sent
 * NO filter to Fastmail, so the server returned its unfiltered total
 * (Trash+Spam included) while the local count excluded them -- a false FAIL
 * ("society" reported local=0 remote=239 before its mailboxes had synced,
 * then local=205 remote=205 minutes later once they had, with nothing on the
 * server having changed). Deriving the exclusion from a live `Mailbox/get`
 * makes the comparison correct regardless of what has or hasn't synced
 * locally yet.
 */
export function excludedIdsFromMailboxes(list: { id: string; role?: string | null }[]): string[] {
  const roles: readonly string[] = EXCLUDED_ROLES;
  return list.filter((m) => m.role != null && roles.includes(m.role)).map((m) => m.id);
}

/** Same filter shape `walkArchive` sends -- an empty exclusion list means no
 *  filter at all, not an empty AND. */
export function buildExclusionFilter(excluded: string[]): Record<string, unknown> | undefined {
  return excluded.length > 0
    ? {
        operator: "AND",
        conditions: excluded.map((id) => ({ operator: "NOT", conditions: [{ inMailbox: id }] })),
      }
    : undefined;
}
