import type { DatabaseSync } from "node:sqlite";
import type { JmapClient } from "./client.ts";
import type { JmapEmail, JmapMailbox } from "./types.ts";
import { fetchChanges } from "./changes.ts";
import { storeEmails, syncMailboxes, removeEmails, setSyncState, getSyncState } from "./mutations.ts";
import { backfillBodies, walkArchive, type Sleep } from "./corpus.ts";
import { reconcileDeleted, reconcilePending } from "./reconcile.ts";

/** Email/changes does not carry mailbox changes, so a folder created on
 *  another device would never appear without its own refresh. Ten minutes is
 *  frequent enough to notice and rare enough to cost nothing. */
export const MAILBOX_REFRESH_MS = 10 * 60 * 1000;

/**
 * Ceiling on one metadata Email/get, independent of what the server
 * advertises -- the same reasoning as corpus.ts's MAX_BODY_BATCH.
 *
 * The un-chunked version of this call was C2's certain trigger: a drain of
 * MAX_CHANGES_PER_ROUND x MAX_CHANGE_ROUNDS = 5,000 ids went into ONE
 * Email/get against a live maxObjectsInGet of 4,096, so bulk-archiving 5,000
 * messages drained the cursor to head and then failed requestTooLarge. Spec
 * 5.6 requires page sizes to come from the session; corpus.ts honoured it,
 * this file did not.
 */
export const MAX_METADATA_BATCH = 500;

function metadataChunk(client: JmapClient): number {
  return Math.max(1, Math.min(client.session.maxObjectsInGet, MAX_METADATA_BATCH));
}

function chunked(ids: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

const METADATA_PROPS = [
  "id", "threadId", "receivedAt", "subject", "preview",
  "hasAttachment", "keywords", "mailboxIds", "from",
];

export interface RefreshResult {
  created: number;
  updated: number;
  destroyed: number;
  /** Rows removed because a resync found the server no longer had them. */
  reconciled: number;
  mailboxesRefreshed: boolean;
  resynced: boolean;
  bodiesWritten: number;
  bodiesFailed: number;
}

export interface RefreshOptions {
  now?: () => number;
  paceMs?: number;
  sleep?: Sleep;
  signal?: AbortSignal;
  /** Invoked once after each batch of messages is stored -- a walk page, a
   *  changes-round metadata chunk, or a body-fetch batch -- so a caller
   *  (the supervisor's progress-aware pass deadline) can tell a stalled
   *  pass from a slow-but-moving one without knowing any of those phases'
   *  internal batch sizes. */
  onProgress?: () => void;
}

export async function refreshAccount(
  db: DatabaseSync,
  client: JmapClient,
  account: string,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const now = opts.now ?? Date.now;
  const accountId = client.session.mailAccountId;

  const mailboxesRefreshed = await maybeRefreshMailboxes(db, client, account, now());

  // Self-healing (C3). A finished walk short-circuits on its 'done' sentinel
  // with ZERO JMAP requests -- one getSyncState per pass -- so the steady
  // state costs nothing. What it buys: after a cannotCalculateChanges resync
  // clears the sentinel, or after a walk that died on its progress guard,
  // the walk actually restarts instead of waiting for a container restart.
  const walk = await walkArchive(db, client, account, {
    paceMs: opts.paceMs,
    sleep: opts.sleep,
    onProgress: opts.onProgress,
  });

  // After a resync's re-walk has COMPLETED (it captured the fresh cursor on
  // its first page, so anything destroyed since is a normal change), remove
  // what the server no longer has. Before completion the walk's own state
  // is the thing in flux; reconciling then would race it.
  let reconciled = 0;
  if (walk.complete && reconcilePending(db, account)) {
    reconciled = await reconcileDeleted(db, client, account, { paceMs: opts.paceMs, sleep: opts.sleep });
  }

  let destroyed = 0;

  // Applied round by round, before each round's cursor is committed (C2).
  const changes = await fetchChanges(db, client, account, {
    applyRound: async (round) => {
      // created and updated are both "fetch the current metadata and upsert
      // it". storeEmails deliberately never writes body_text, so an updated
      // message keeps the body the backfill already indexed.
      const toFetch = [...new Set([...round.created, ...round.updated])];
      for (const chunk of chunked(toFetch, metadataChunk(client))) {
        const [res] = await client.request([
          ["Email/get", { accountId, ids: chunk, properties: METADATA_PROPS }, "c0"],
        ]);
        const list = ((res?.[1] as { list?: JmapEmail[] } | undefined)?.list ?? []);
        storeEmails(db, account, list);
        opts.onProgress?.();
      }
      destroyed += removeEmails(db, account, round.destroyed);
    },
  });
  if (changes.resynced) {
    return {
      created: 0, updated: 0, destroyed: 0, reconciled, mailboxesRefreshed, resynced: true,
      bodiesWritten: 0, bodiesFailed: 0,
    };
  }

  // storeEmails never writes body_text (see the comment above), so a
  // created message would otherwise sit with body_text NULL forever --
  // metadata-searchable but invisible to a body search -- until the next
  // process restart re-ran the startup backfill. Called unconditionally,
  // not only when something was created: unfetchedIds' WHERE body_text IS
  // NULL is one indexed SELECT and an immediate return when there is
  // nothing pending (negligible at a few passes a minute), and it also
  // self-heals any row an earlier, interrupted backfill left NULL.
  const bodies = await backfillBodies(db, client, account, {
    paceMs: opts.paceMs,
    sleep: opts.sleep,
    signal: opts.signal,
    onProgress: opts.onProgress,
  });

  return {
    created: changes.created.length,
    updated: changes.updated.length,
    destroyed,
    reconciled,
    mailboxesRefreshed,
    resynced: false,
    bodiesWritten: bodies.written,
    bodiesFailed: bodies.failed,
  };
}

async function maybeRefreshMailboxes(
  db: DatabaseSync,
  client: JmapClient,
  account: string,
  nowMs: number,
): Promise<boolean> {
  // getSyncState distinguishes "never refreshed" (null) from "refreshed at
  // time 0" (the stored string "0") -- a test drives the clock from 0, so
  // treating "0" as "absent" would make the cadence never apply.
  const raw = getSyncState(db, account, "mailbox_at");
  if (raw !== null) {
    const last = Number(raw);
    if (Number.isFinite(last) && nowMs - last < MAILBOX_REFRESH_MS) return false;
  }

  const [res] = await client.request([
    ["Mailbox/get", { accountId: client.session.mailAccountId, ids: null }, "c0"],
  ]);
  const args = res?.[1] as { list?: JmapMailbox[]; state?: string } | undefined;
  syncMailboxes(db, account, args?.list ?? []);
  if (args?.state) setSyncState(db, account, "mailbox", args.state);
  setSyncState(db, account, "mailbox_at", String(nowMs));
  return true;
}
