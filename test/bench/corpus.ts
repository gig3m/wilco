/**
 * A deterministic, seeded synthetic corpus for the performance benchmark
 * (`test/bench/list.bench.ts`).
 *
 * 🚨 It writes through the REAL write paths -- `storeEmails` (mutations.ts)
 * for the emails/email_mailboxes rows and `writeDetails` (details.ts) for
 * recipients/attachments -- not hand-stamped INSERTs. Task 2 put denormalized
 * columns (`email_mailboxes.received_at`/`thread_key`) onto those two write
 * paths specifically so every reader could stop re-deriving them; a
 * benchmark corpus that bypassed them would exercise a database this
 * application can no longer actually produce, exactly the trap
 * `test/list.test.ts`'s own `put()` helper comment calls out.
 *
 * The database goes through `openDb` (never a bare `new DatabaseSync`), so
 * `applyMigrations` runs for real and every index in the live schema exists
 * before a single row is written.
 *
 * Shape (measured on a real 167k-message archive):
 * mean 1.26 messages per thread, maximum 90. The size table below is
 * hand-tuned to that mean (worked out at ~1.25) with a long thin tail
 * reaching up to 90; nothing here is asserted against it in a test -- it
 * only has to be REALISTIC, not exact, because what the benchmark measures
 * is query cost against a shape like the one that broke, not a statistical
 * reproduction of it.
 *
 * Three accounts: a big ARCHIVE (role "archive", ~88% of that account's
 * mail -- "the largest folder"), an INBOX (role "inbox", shared across
 * accounts so the unified list has something to merge), and, on
 * SMALL_ACCOUNT only, a small SMALL folder (no role, a couple dozen
 * messages) for the "first page of a small folder" case plus 60 small
 * custom folders. Those 60 exist for `listMailboxes`, the one read whose
 * cost scales with the number of FOLDERS as well as the number of
 * messages; three folders per account measured a sidebar nobody has.
 */
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../../src/core/db.ts";
import { storeEmails } from "../../src/core/mutations.ts";
import { syncMailboxes } from "../../src/core/mutations.ts";
import { writeDetails, type MessageDetails } from "../../src/core/details.ts";
import type { JmapEmail } from "../../src/core/types.ts";

export const DEFAULT_CORPUS_SIZE = 200_000;
export const ACCOUNTS = ["bench-a", "bench-b", "bench-c"] as const;
export const ARCHIVE_ID = "ARCHIVE";
export const INBOX_ID = "INBOX";
export const SMALL_ID = "SMALL";
/** Only this account gets the small folder -- one is enough to benchmark
 *  "a small folder", and giving every account one would just be more of the
 *  same folder shape at three times the build cost. */
export const SMALL_ACCOUNT: (typeof ACCOUNTS)[number] = "bench-a";
export const SMALL_FOLDER_SIZE = 24;
/** 🚨 A realistic FOLDER COUNT, not just a realistic message count. The
 *  corpus had three folders per account while the live instance that
 *  exposed the sidebar's cost has 60 in one account -- so the per-folder
 *  count queries were being grouped into three buckets here and sixty
 *  there. `listMailboxes` is the one read whose cost scales with both, and
 *  it is benchmarked against `SMALL_ACCOUNT`, so the folders go there.
 *  Small on purpose: real custom folders are filing, not archives. */
export const CUSTOM_FOLDER_COUNT = 60;
export const CUSTOM_FOLDER_SIZE = 150;
export const customFolderId = (i: number): string => `CUSTOM${i}`;
/** Unread rate by folder, replacing a flat 25% everywhere. Unread mail
 *  collects in the INBOX and an archive is read -- the live instance had
 *  164 unread of 167,756 (0.1%). The rates below come out around 1.3%
 *  overall, still an order of magnitude more unread than that, which keeps
 *  the benchmark conservative: the unread count now rides a PARTIAL index
 *  (schema 12), so a corpus where everything is unread would measure a
 *  database no mail client ever has. */
const UNREAD_RATE_INBOX = 0.25;
const UNREAD_RATE_FILED = 0.01;

export interface CorpusInfo {
  n: number;
  threads: number;
  maxThreadSize: number;
  accounts: readonly string[];
  archiveId: string;
  inboxId: string;
  smallAccount: string;
  smallId: string;
  customAccount: string;
  customIds: string[];
}

/** Deterministic PRNG (mulberry32) -- same shape of guarantee as
 *  list.test.ts's fuzz test's own LCG: a fixed seed reproduces byte-identical
 *  runs, which matters for a benchmark whose whole point is comparing one
 *  run's timings and query plans against another's. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rnd: () => number, n: number): number {
  return Math.floor(rnd() * n);
}

/**
 * Thread size distribution, tuned to a ~1.25 mean with a long thin tail to
 * 90. See the module doc comment: the live archive's mean was 1.26, max 90.
 */
function sampleThreadSize(rnd: () => number): number {
  const r = rnd();
  if (r < 0.9) return 1;
  if (r < 0.98) return 2;
  if (r < 0.995) return 3 + randInt(rnd, 4); // 3..6
  if (r < 0.999) return 7 + randInt(rnd, 20); // 7..26
  return 26 + randInt(rnd, 65); // 26..90
}

const FIRST_NAMES = ["Alice", "Bob", "Cara", "Deshawn", "Elin", "Faisal", "Grace", "Hana"];
const DOMAINS = ["example.com", "example.org", "mail.test"];

function personFor(rnd: () => number): { name: string; email: string } {
  const first = FIRST_NAMES[randInt(rnd, FIRST_NAMES.length)]!;
  const domain = DOMAINS[randInt(rnd, DOMAINS.length)]!;
  return { name: first, email: `${first.toLowerCase()}${randInt(rnd, 10000)}@${domain}` };
}

/** A contiguous run of `seq` values that all get pinned to the SAME instant,
 *  mirroring a bulk import (a season-pack-sized batch landing in one
 *  `Email/changes` sync round, or an initial account import) -- the shape
 *  M2's review finding calls out as the one this corpus never exercised.
 *  `isoAt` had given every message its own distinct minute, so the gate
 *  never drove the boundary/frontier tie-breaking logic (`received_at DESC,
 *  email_id ASC`) that exists specifically for two of the three silent-
 *  omission defects found during this work. Sized proportionally to `n` so
 *  a small `WILCO_BENCH_N` override for local iteration still gets a real
 *  (if smaller) tie block rather than one bigger than the corpus, and
 *  anchored at 20% of `n` so it sits inside the big account's ARCHIVE share
 *  (the folder every "O(page)" bench test targets) rather than spilling
 *  into its inbox or the next account. */
function tieBlockFor(n: number): { start: number; size: number } | null {
  const size = Math.max(1, Math.min(3000, Math.floor(n * 0.02)));
  if (size < 2) return null; // too small a corpus for a meaningful tie block
  return { start: Math.floor(n * 0.2), size };
}

function isoAt(seq: number, tie: { start: number; size: number } | null): string {
  // seq increases with recency: higher seq -> later time. One "minute" per
  // sequence step keeps four years of headroom for 200k messages while
  // staying comfortably inside ISO8601's range. Within `tie`'s range every
  // seq collapses onto `tie.start`'s instant, so a contiguous block of
  // messages -- distinct ids, distinct threads, real rows -- shares one
  // `received_at` exactly the way a bulk import does.
  const effectiveSeq = tie !== null && seq >= tie.start && seq < tie.start + tie.size ? tie.start : seq;
  return new Date(Date.UTC(2020, 0, 1) + effectiveSeq * 60_000).toISOString();
}

function ensureMailboxes(db: DatabaseSync, account: string, withSmall: boolean): void {
  const boxes = [
    { id: ARCHIVE_ID, name: "Archive", role: "archive", sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
    { id: INBOX_ID, name: "Inbox", role: "inbox", sortOrder: 1, totalEmails: 0, unreadEmails: 0 },
  ];
  if (withSmall) {
    boxes.push({ id: SMALL_ID, name: "Small Folder", role: null as unknown as string, sortOrder: 2, totalEmails: 0, unreadEmails: 0 });
    for (let i = 0; i < CUSTOM_FOLDER_COUNT; i += 1) {
      boxes.push({
        id: customFolderId(i),
        name: `Filed ${i}`,
        role: null as unknown as string,
        sortOrder: 3 + i,
        totalEmails: 0,
        unreadEmails: 0,
      });
    }
  }
  syncMailboxes(db, account, boxes);
}

interface PlannedMessage {
  account: string;
  id: string;
  threadId: string | null;
  seq: number;
  mailboxId: string;
}

/**
 * Lays out `count` messages for one account/mailbox as thread groups, oldest
 * first, advancing the shared `seq` cursor (so timestamps interleave across
 * accounts and mailboxes the way real mail does) and the shared thread
 * counter (so no two accounts' thread ids collide, even though nothing here
 * actually depends on that -- thread scoping is per-account everywhere it
 * matters).
 */
function layout(
  rnd: () => number,
  account: string,
  mailboxId: string,
  count: number,
  seqRef: { v: number },
  threadRef: { v: number },
  maxThreadRef: { v: number },
): PlannedMessage[] {
  const out: PlannedMessage[] = [];
  let remaining = count;
  while (remaining > 0) {
    let size = Math.min(sampleThreadSize(rnd), remaining);
    if (size < 1) size = 1;
    maxThreadRef.v = Math.max(maxThreadRef.v, size);
    const threadId = size > 1 ? `T${threadRef.v++}` : null;
    for (let i = 0; i < size; i++) {
      const seq = seqRef.v++;
      out.push({ account, id: `m${seq}`, threadId, seq, mailboxId });
    }
    remaining -= size;
  }
  return out;
}

export interface BuildOptions {
  n?: number;
  seed?: number;
  /** How many messages are pushed through storeEmails/writeDetails per
   *  transaction. Larger batches amortize BEGIN/COMMIT overhead; smaller
   *  ones bound peak memory. 2000 was measured to be comfortably in the
   *  knee of that tradeoff for this shape of row. */
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Builds the corpus into `db` (already migrated -- callers open it with
 * `openDb`). Returns the layout info the benchmark needs to target its
 * queries (which account/mailbox is "the largest folder", etc).
 */
export function buildCorpus(db: DatabaseSync, opts: BuildOptions = {}): CorpusInfo {
  const n = opts.n ?? DEFAULT_CORPUS_SIZE;
  const rnd = mulberry32(opts.seed ?? 0xc0ffee);
  const batchSize = opts.batchSize ?? 2000;
  const tie = tieBlockFor(n);

  for (const account of ACCOUNTS) {
    ensureMailboxes(db, account, account === SMALL_ACCOUNT);
  }

  const seqRef = { v: 0 };
  const threadRef = { v: 0 };
  const maxThreadRef = { v: 0 };

  const perAccount = Math.floor(n / ACCOUNTS.length);
  const planned: PlannedMessage[] = [];
  ACCOUNTS.forEach((account, i) => {
    // Last account absorbs the remainder so the total is exactly `n`
    // (plus the small folder's fixed addition below).
    let share = i === ACCOUNTS.length - 1 ? n - perAccount * (ACCOUNTS.length - 1) : perAccount;
    let smallShare = 0;
    if (account === SMALL_ACCOUNT) {
      smallShare = Math.min(SMALL_FOLDER_SIZE, share);
      share -= smallShare;
    }
    // The custom folders come out of this account's share before archive
    // and inbox split what is left, so `n` still means what it says and
    // ARCHIVE stays comfortably the largest folder.
    let customShare = 0;
    if (account === SMALL_ACCOUNT) {
      customShare = Math.min(CUSTOM_FOLDER_COUNT * CUSTOM_FOLDER_SIZE, Math.floor(share / 2));
      share -= customShare;
    }
    const archiveShare = Math.round(share * 0.88);
    const inboxShare = share - archiveShare;
    planned.push(...layout(rnd, account, ARCHIVE_ID, archiveShare, seqRef, threadRef, maxThreadRef));
    planned.push(...layout(rnd, account, INBOX_ID, inboxShare, seqRef, threadRef, maxThreadRef));
    if (smallShare > 0) {
      planned.push(...layout(rnd, account, SMALL_ID, smallShare, seqRef, threadRef, maxThreadRef));
    }
    if (customShare > 0) {
      const per = Math.floor(customShare / CUSTOM_FOLDER_COUNT);
      let left = customShare;
      for (let i = 0; i < CUSTOM_FOLDER_COUNT && left > 0; i += 1) {
        const take = i === CUSTOM_FOLDER_COUNT - 1 ? left : Math.min(per, left);
        if (take <= 0) break;
        planned.push(...layout(rnd, account, customFolderId(i), take, seqRef, threadRef, maxThreadRef));
        left -= take;
      }
    }
  });

  const total = planned.length;
  let done = 0;
  for (let start = 0; start < planned.length; start += batchSize) {
    const batch = planned.slice(start, start + batchSize);
    // Grouped by account: storeEmails/writeDetails both take one account at
    // a time (every real call site does too -- one JMAP account per batch).
    const byAccount = new Map<string, PlannedMessage[]>();
    for (const m of batch) {
      const list = byAccount.get(m.account);
      if (list) list.push(m);
      else byAccount.set(m.account, [m]);
    }
    for (const [account, msgs] of byAccount) {
      const emails: JmapEmail[] = msgs.map((m) => {
        const sender = personFor(rnd);
        const unread = rnd() < (m.mailboxId === INBOX_ID ? UNREAD_RATE_INBOX : UNREAD_RATE_FILED);
        const flagged = rnd() < 0.05;
        return {
          id: m.id,
          threadId: m.threadId ?? undefined,
          receivedAt: isoAt(m.seq, tie),
          subject: `Re: benchmark message ${m.seq}`,
          preview: `This is synthetic message ${m.seq} for the performance corpus.`,
          hasAttachment: rnd() < 0.08,
          keywords: { ...(unread ? {} : { $seen: true }), ...(flagged ? { $flagged: true } : {}) },
          mailboxIds: { [m.mailboxId]: true },
          from: [sender],
        };
      });
      storeEmails(db, account, emails);

      const details: MessageDetails[] = msgs.map((m) => {
        const to = [personFor(rnd)];
        const hasAttachment = emails.find((e) => e.id === m.id)!.hasAttachment === true;
        return {
          id: m.id,
          to,
          cc: [],
          bcc: [],
          replyTo: [],
          attachments: hasAttachment
            ? [{ partId: "2", name: "attachment.pdf", type: "application/pdf", size: 12_345, cid: null }]
            : [],
          via: null,
          hasHtml: false,
        };
      });
      writeDetails(db, account, details);
    }
    done += batch.length;
    opts.onProgress?.(done, total);
  }

  return {
    n: total,
    threads: threadRef.v,
    maxThreadSize: maxThreadRef.v,
    accounts: ACCOUNTS,
    archiveId: ARCHIVE_ID,
    inboxId: INBOX_ID,
    smallAccount: SMALL_ACCOUNT,
    smallId: SMALL_ID,
    customAccount: SMALL_ACCOUNT,
    customIds: Array.from({ length: CUSTOM_FOLDER_COUNT }, (_, i) => customFolderId(i)),
  };
}

/** Convenience: open a fresh migrated database at `dbPath` and build the
 *  corpus into it in one call. */
export function buildCorpusAt(dbPath: string, opts: BuildOptions = {}): { db: DatabaseSync; info: CorpusInfo } {
  const db = openDb(dbPath);
  const info = buildCorpus(db, opts);
  return { db, info };
}
