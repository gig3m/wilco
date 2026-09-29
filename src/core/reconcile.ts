/**
 * Reconciliation after a resync: remove local rows the server no longer has.
 *
 * 🚨 Why this exists (checklist row 28, 2026-09-06). Fastmail answers
 * `Email/changes` with `cannotCalculateChanges` from a state only ~270
 * changes old. Wilco's recovery resets the cursor and re-walks the archive
 * -- and a walk only ADDS rows. `removeEmails` had exactly one caller, the
 * `destroyed` list of a changes round, so every message destroyed inside a
 * resync gap stayed in the cache forever: 18 phantom rows in one inbox
 * after an evening of harness runs, unread 3 on Fastmail against 9 on
 * screen. A message deleted elsewhere that stays in the inbox is the kind
 * of thing that makes a mail client untrustworthy.
 *
 * Two rules:
 *
 *   - The id set is an UNFILTERED `Email/query`. The walk excludes Trash
 *     and Spam (spec 5.5), so its ids cannot be the source of truth --
 *     reconciling against them would delete every trashed message.
 *   - All or nothing. Every page is collected before anything is deleted;
 *     a failure mid-listing deletes nothing and leaves the flag pending so
 *     the next pass retries. A partial id set would look like a mass
 *     deletion.
 */
import type { DatabaseSync } from "node:sqlite";
import type { JmapClient } from "./client.ts";
import { getSyncState, setSyncState, removeEmails } from "./mutations.ts";
import type { Sleep } from "./corpus.ts";

const PAGE = 500;

export function markReconcilePending(db: DatabaseSync, account: string): void {
  setSyncState(db, account, "reconcile", "pending");
}

export function reconcilePending(db: DatabaseSync, account: string): boolean {
  return getSyncState(db, account, "reconcile") === "pending";
}

function clearReconcile(db: DatabaseSync, account: string): void {
  db.prepare(`DELETE FROM sync_state WHERE account = ? AND kind = 'reconcile'`).run(account);
}

/** Lists every message id the server holds, all folders. Throws on any
 *  failure rather than returning a partial set. */
async function serverIds(client: JmapClient, opts: { paceMs?: number; sleep?: Sleep }): Promise<Set<string>> {
  const out = new Set<string>();
  let position = 0;
  for (;;) {
    const [res] = await client.request([
      ["Email/query", {
        accountId: client.session.mailAccountId,
        sort: [{ property: "receivedAt", isAscending: false }],
        position,
        limit: PAGE,
        calculateTotal: false,
      }, "c0"],
    ]);
    if (res?.[0] !== "Email/query") throw new Error(`reconcile: ${JSON.stringify(res?.[1]).slice(0, 200)}`);
    const ids = ((res[1] as { ids?: string[] }).ids ?? []);
    for (const id of ids) out.add(id);
    if (ids.length < PAGE) return out;
    position += ids.length;
    if (opts.paceMs && opts.sleep) await opts.sleep(opts.paceMs);
  }
}

/** Removes every local row the server no longer has. Returns how many. */
export async function reconcileDeleted(
  db: DatabaseSync,
  client: JmapClient,
  account: string,
  opts: { paceMs?: number; sleep?: Sleep } = {},
): Promise<number> {
  const remote = await serverIds(client, opts);  // throws → nothing below runs, flag stays
  const local = (db.prepare(`SELECT id FROM emails WHERE account = ?`).all(account) as unknown as { id: string }[]).map((r) => r.id);
  const gone = local.filter((id) => !remote.has(id));
  const removed = removeEmails(db, account, gone);
  clearReconcile(db, account);
  return removed;
}
