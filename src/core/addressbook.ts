/**
 * The address book: every address any account has corresponded with, held
 * in memory.
 *
 * 🚨 WHY THIS IS A CACHE AND NOT A QUERY. Answering "who am I writing to"
 * means ranking correspondents by how often and how recently they appear,
 * which is an aggregate over EVERY contact event in the archive -- a
 * message's sender, and the to/cc of every message held. Computed live on
 * the owner's archive (39,856 messages / 116,656 recipient rows) that cost
 * **175ms per keystroke**, measured 2026-10-03, against 59ms for the
 * per-account version it replaced. Behind the To field's 150ms debounce
 * that is a third of a second before any suggestion appears, in a control
 * meant to be arrowed through.
 *
 * 🚨 NO INDEX FIXES IT, and three were tried and measured before this
 * module existed: covering indexes on `emails(from_email, from_name,
 * received_at)`, on `emails(account, id, received_at)` and on
 * `email_recipients(kind, email, account, email_id)`, plus `WITH …
 * MATERIALIZED` and folding the two statements into one. Best case 88ms;
 * the recipients index made it WORSE (211ms) by luring the planner into a
 * primary-key lookup per recipient row. The cost is the GROUP BY: counting
 * and dating every address requires touching every event, and `emails`
 * rows here average 2.4KB against a 91MB table, so the scan is PAGING, not
 * row count -- the same lesson the sidebar's unread count taught.
 *
 * Materialized, the whole book is 11,687 contacts / 12,179 (email,
 * account) pairs, builds in ~250ms, and answers in **under a
 * millisecond**.
 *
 * It is deliberately NOT a table (owner ruling 2026-10-03): a derived
 * table needs a migration, a write-path hook and a backfill script, and a
 * process-lifetime Map needs none of those and loses nothing that matters
 * here. The cost of that choice, stated rather than left to be found: the
 * first lookup after a restart pays the build, and a correspondent who
 * appears between rebuilds waits for the next one.
 */
import type { DatabaseSync } from "node:sqlite";

export interface ContactSuggestion {
  name: string;
  email: string;
  /** How many times any account has seen this address. */
  n: number;
  /** The accounts that know the address, most recent contact first. */
  accounts: string[];
}

export interface BookEntry {
  email: string;
  name: string;
  n: number;
  lastSeen: string;
  /** The accounts that KNOW the address, most recent contact first. */
  accounts: string[];
  /** The accounts that have WRITTEN to it, most recently used first. */
  writtenFrom: string[];
}

export type Book = Map<string, BookEntry>;

export const CONTACT_SUGGESTION_LIMIT = 8;
/** A correspondent seen within this long counts as current. */
const CONTACT_RECENT_MS = 365 * 24 * 60 * 60 * 1000;
/** How long a built book is trusted without an invalidation. The
 *  supervisor marks it stale whenever a pass stored anything, so this is
 *  the backstop for a missed signal, not the normal path. */
export const BOOK_TTL_MS = 5 * 60 * 1000;

/** Every (account, address) contact event: a message's sender, and the
 *  to/cc of any message the account holds. One definition of "knowing
 *  someone", shared by every pass below. */
const SEEN = `seen AS (
         SELECT account, lower(from_email) AS email, from_name AS name, received_at
           FROM emails WHERE from_email <> ''
         UNION ALL
         SELECT r.account, lower(r.email) AS email, r.name AS name, e.received_at
           FROM email_recipients r JOIN emails e ON e.account = r.account AND e.id = r.email_id
          WHERE r.kind IN ('to', 'cc') AND r.email <> ''
       )`;

/**
 * Reads the whole book out of the archive. Three passes, each a plain
 * aggregate with no predicate: the ranking numbers, the accounts that know
 * each address, and the accounts that have written to it.
 */
export function loadBook(db: DatabaseSync): Book {
  const book: Book = new Map();

  for (const r of db
    .prepare(
      `WITH ${SEEN}
       SELECT email,
              COALESCE(MAX(CASE WHEN name <> '' THEN name ELSE NULL END), '') AS name,
              COUNT(*) AS n,
              MAX(received_at) AS last_seen
         FROM seen GROUP BY email`,
    )
    .all() as { email: string; name: string; n: number; last_seen: string }[]) {
    book.set(r.email, { email: r.email, name: r.name, n: r.n, lastSeen: r.last_seen, accounts: [], writtenFrom: [] });
  }

  // Ordered by recency so the push order IS the "most recent first" the
  // suggestion dots and the mismatch note both rely on.
  for (const r of db
    .prepare(
      `WITH ${SEEN}
       SELECT email, account, MAX(received_at) AS last_seen
         FROM seen GROUP BY email, account ORDER BY last_seen DESC`,
    )
    .all() as { email: string; account: string }[]) {
    book.get(r.email)?.accounts.push(r.account);
  }

  for (const r of db
    .prepare(
      `SELECT lower(r.email) AS email, em.account AS account, MAX(e.received_at) AS last_seen
         FROM email_recipients r
         JOIN email_mailboxes em ON em.account = r.account AND em.email_id = r.email_id
         JOIN mailboxes m ON m.account = em.account AND m.id = em.mailbox_id
         JOIN emails e ON e.account = r.account AND e.id = r.email_id
        WHERE r.kind IN ('to', 'cc') AND r.email <> '' AND m.role = 'sent'
        GROUP BY lower(r.email), em.account
        ORDER BY last_seen DESC`,
    )
    .all() as { email: string; account: string }[]) {
    book.get(r.email)?.writtenFrom.push(r.account);
  }

  return book;
}

/**
 * Who to offer as the To field is typed.
 *
 * 🚨 UNIFIED ACROSS ACCOUNTS BY OWNER RULING (2026-10-03), and the
 * per-account version this replaced was a real defect, not a preference: a
 * correspondent of `personal` offered NO suggestion while composing from
 * `work`, with nothing on screen to say why. The first thought when
 * writing a message is "to who", not "from which me", so the field answers
 * "to who" from the whole archive and the account is SHOWN rather than
 * being a precondition for finding anyone.
 *
 * Counts POOL across accounts: someone you write to under two hats is one
 * correspondent seen twice as often.
 *
 * Ranked `(seen within a year) DESC, times seen DESC, last seen DESC` --
 * frequency alone puts a newsletter's noreply@ at the top of every list,
 * and someone you exchanged three messages with last week beats a sender
 * from 2024 with forty. Matched by substring on email OR name, because
 * people search by surname. Needs two characters; capped at 8.
 *
 * `exclude` is the SENDING account's own addresses, and only those: nobody
 * writes to the address they are writing from. 🚨 Not every account's --
 * that was tried first and board row 23 went red on it, because the owner's
 * other accounts are legitimate recipients (writing from work to personal is
 * ordinary). They rank high on frequency, but only surface when the typed
 * fragment matches them, which is when you are typing your own name.
 */
export function rankContacts(
  book: Book,
  q: string,
  opts: { exclude: Set<string>; limit?: number; now?: () => number },
): ContactSuggestion[] {
  const fragment = q.trim().toLowerCase();
  if (fragment.length < 2) return [];
  const limit = opts.limit ?? CONTACT_SUGGESTION_LIMIT;
  const cutoff = new Date((opts.now ?? Date.now)() - CONTACT_RECENT_MS).toISOString();
  const own = new Set([...opts.exclude].map((e) => e.toLowerCase()));

  const matched: BookEntry[] = [];
  for (const entry of book.values()) {
    if (own.has(entry.email)) continue;
    // A plain substring test: the fragment is the user's text, so there is
    // no pattern syntax for a `%` or `_` in it to escape into.
    if (entry.email.includes(fragment) || entry.name.toLowerCase().includes(fragment)) matched.push(entry);
  }
  matched.sort((a, b) => {
    const aCurrent = a.lastSeen > cutoff ? 1 : 0;
    const bCurrent = b.lastSeen > cutoff ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    if (a.n !== b.n) return b.n - a.n;
    if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? 1 : -1;
    // A total order, so a page is stable between identical calls.
    return a.email < b.email ? -1 : 1;
  });
  return matched.slice(0, limit).map((e) => ({ name: e.name, email: e.email, n: e.n, accounts: e.accounts }));
}

/**
 * A book held for the life of the process, rebuilt when the supervisor says
 * something changed or when the TTL lapses.
 */
export class AddressBook {
  #db: DatabaseSync;
  #book: Book | null = null;
  #builtAt = 0;
  #ttlMs: number;
  #now: () => number;

  constructor(db: DatabaseSync, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.#db = db;
    this.#ttlMs = opts.ttlMs ?? BOOK_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** Discards the built book. Called whenever a sync pass stored anything. */
  markStale(): void {
    this.#book = null;
  }

  #current(): Book {
    if (this.#book === null || this.#now() - this.#builtAt > this.#ttlMs) {
      this.#book = loadBook(this.#db);
      this.#builtAt = this.#now();
    }
    return this.#book;
  }

  suggest(q: string, opts: { exclude: Set<string>; limit?: number }): ContactSuggestion[] {
    return rankContacts(this.#current(), q, { ...opts, now: this.#now });
  }

  /** The accounts that have written to `email`, most recently used first.
   *  Empty means NO habit exists, which the composer's note stays silent
   *  about -- a warning on every new recipient is a warning nobody reads. */
  habits(email: string): string[] {
    return this.#current().get(email.trim().toLowerCase())?.writtenFrom ?? [];
  }
}
