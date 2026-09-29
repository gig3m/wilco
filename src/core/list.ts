import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { hiddenFromUnified } from "./settings.ts";
import {
  HAS_REAL_ATTACHMENT_SQL,
  SEARCH_LIMIT,
  senderName,
  type EmailRow,
  type SearchResult,
} from "./queries.ts";

/**
 * The paged unified list -- one row per CONVERSATION, newest first.
 *
 * Deliberately separate from searchEmails: there is no free-text term here,
 * only equality filters, so it never touches emails_fts and never produces a
 * snippet.
 *
 * 🚨 This is WALK-AND-ENRICH, not collapse-then-page, and the difference is
 * the whole point of the module. What stood here before was one 60-line
 * statement that grouped the entire `emails` table (twice), materialised the
 * entire `email_attachments` table, and ranked the whole filtered set with
 * four window functions -- before taking 50 rows. None of that shrank when
 * the folder was small, which is why a 139-message inbox cost 73% of what a
 * 111,000-message archive cost: 2,272ms against 3,097ms on the 167,749
 * message instance. Now:
 *
 *   1. WALK the folder newest-first over `email_mailboxes_recent`, keeping
 *      the first message seen per thread key, until `limit + 1` distinct
 *      conversations have been found. Measured on the live archive: 65 rows
 *      scanned to find 50 conversations.
 *   2. COUNT each conversation's messages, UNFILTERED by folder.
 *   3. AGGREGATE each conversation's flags and paperclip, FOLDER-SCOPED.
 *   4. COUNT the folder's distinct conversations for the header.
 *
 * 2 and 3 are two queries rather than one on purpose; see the asymmetry
 * below. Everything here is bounded by the page except 4, which is a
 * covering `count(DISTINCT)` (16ms at 111k) and is the price of computing
 * the header locally rather than trusting JMAP's `totalThreads`.
 */

export interface ListFilter {
  account: string | null;
  mailbox: string | null;
  /** A mailbox ROLE ("inbox", "archive", ...) rather than an id -- the
   *  only form that means the same thing across accounts. Mutually
   *  exclusive with `mailbox`. */
  role: string | null;
  unread: boolean | null;
  flagged: boolean | null;
  cursor: string | null;
  limit?: number;
  /** false: one row per MESSAGE instead of per conversation (the
   *  groupConversations preference). Default true. */
  group?: boolean;
}

interface MessageCursor {
  receivedAt: string;
  account: string;
  id: string;
}

/**
 * Same shape as queries.ts's cursor (received_at, account, id) -- a page
 * boundary encoded as "the last row you saw", not an OFFSET, so a row
 * inserted between two page fetches (new mail arriving at the top) cannot
 * shift the second page and repeat a row. Kept local rather than exported
 * from queries.ts because it is only ever used against emails/plain
 * filters here, not the FTS query queries.ts builds.
 */
export function encodeCursor(row: { received_at: string; account: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.received_at, row.account, row.id]), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): MessageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string"
    ) {
      return null;
    }
    return { receivedAt: parsed[0], account: parsed[1], id: parsed[2] };
  } catch {
    return null;
  }
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return SEARCH_LIMIT;
  return Math.max(1, Math.min(SEARCH_LIMIT, Math.trunc(value)));
}

/**
 * One account's slice of the filter. `mailboxes` is the set of that
 * account's mailbox ids the filter resolves to -- normally one, but a role
 * could in principle name more than one folder in an account, and a message
 * sitting in two of them must still be one row. `null` means no folder
 * scope at all (`GET /api/messages` with neither `mailbox` nor `role`),
 * which walks `emails` directly.
 */
interface Scope {
  account: string;
  mailboxes: string[];
}

/** A row the walk produced: enough to dedupe and to page, nothing more. */
interface WalkRow {
  account: string;
  id: string;
  received_at: string;
  thread_key: string;
}

/** Message-level restrictions. They narrow the set the page, the flags AND
 *  the total are all taken over, exactly as the old `baseWhere` did. */
function flagConditions(filter: ListFilter, alias: string): { sql: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.unread !== null) {
    parts.push(`${alias}.is_unread = ?`);
    params.push(filter.unread ? 1 : 0);
  }
  if (filter.flagged !== null) {
    parts.push(`${alias}.is_flagged = ?`);
    params.push(filter.flagged ? 1 : 0);
  }
  return { sql: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "", params };
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

/**
 * The cursor clause, specialised for ONE account.
 *
 * The page order is `received_at DESC, account ASC, id ASC`, so the general
 * predicate is `received_at < c OR (received_at = c AND (account > ca OR
 * (account = ca AND id > ci)))`. Inside a per-account walk `account` is a
 * constant, so the whole thing collapses to a plain range on `received_at`
 * for every account but the cursor's own -- which is what keeps the walk a
 * covering index range scan rather than a scan with a filter.
 */
function cursorClause(
  cursor: MessageCursor | null,
  account: string,
  receivedCol: string,
  idCol: string,
): { sql: string; params: SQLInputValue[] } {
  if (cursor === null) return { sql: "", params: [] };
  if (account > cursor.account) return { sql: ` AND ${receivedCol} <= ?`, params: [cursor.receivedAt] };
  if (account < cursor.account) return { sql: ` AND ${receivedCol} < ?`, params: [cursor.receivedAt] };
  return {
    sql: ` AND (${receivedCol} < ? OR (${receivedCol} = ? AND ${idCol} > ?))`,
    params: [cursor.receivedAt, cursor.receivedAt, cursor.id],
  };
}

/** Page order, used both to merge the per-account walks and to order the
 *  resolved representatives (decision 5's third order). */
function byPageOrder(a: { received_at: string; account: string; id: string }, b: typeof a): number {
  if (a.received_at !== b.received_at) return a.received_at < b.received_at ? 1 : -1;
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * 🚨 The cursor applies to the REPRESENTATIVE, never to the row that
 * discovered it -- "the cursor is applied after collapsing", the rule the
 * statement this replaces enforced by filtering its `rn = 1` rows.
 *
 * A conversation shown on page 1 can easily have an older message sitting
 * below page 1's cursor; the walk meets that older message and rediscovers
 * the thread, but the thread's representative is still the newer message
 * above the cursor. Emitting it would repeat the conversation AND put a row
 * newer than the cursor on page 2. Measured on the live 167k archive before
 * this check existed: page 3 of a 1,000-message folder opened with a message
 * two months newer than page 2's last row.
 */
function belowCursor(rep: { received_at: string; account: string; id: string }, cursor: MessageCursor | null): boolean {
  if (cursor === null) return true;
  if (rep.received_at !== cursor.receivedAt) return rep.received_at < cursor.receivedAt;
  if (rep.account !== cursor.account) return rep.account > cursor.account;
  return rep.id > cursor.id;
}

/**
 * Which accounts and folders this filter names.
 *
 * `null` means the filter names no folder at all, in which case the walk
 * runs over `emails` instead of the membership table. The unified list skips
 * accounts switched out of "All inboxes" (row 48); a per-account view is
 * unaffected, which is why the hidden set is consulted only when no account
 * was named.
 */
function resolveScopes(db: DatabaseSync, filter: ListFilter): Scope[] | null {
  if (filter.mailbox !== null) {
    // Validated upstream: a mailbox filter without an account is a 400,
    // because mailbox ids genuinely collide across accounts.
    return [{ account: filter.account ?? "", mailboxes: [filter.mailbox] }];
  }
  if (filter.role === null) return null;

  const conditions = ["role = ?"];
  const params: SQLInputValue[] = [filter.role];
  if (filter.account !== null) {
    conditions.push("account = ?");
    params.push(filter.account);
  } else {
    const hidden = hiddenFromUnified(db);
    if (hidden.length > 0) {
      conditions.push(`account NOT IN (${placeholders(hidden.length)})`);
      params.push(...hidden);
    }
  }
  const rows = db
    .prepare(`SELECT account, id FROM mailboxes WHERE ${conditions.join(" AND ")} ORDER BY account, id`)
    .all(...params) as unknown as { account: string; id: string }[];

  const byAccount = new Map<string, string[]>();
  for (const r of rows) {
    const list = byAccount.get(r.account);
    if (list === undefined) byAccount.set(r.account, [r.id]);
    else list.push(r.id);
  }
  return [...byAccount].map(([account, mailboxes]) => ({ account, mailboxes }));
}

/** The account predicate for the unscoped walk, where there is no folder to
 *  range over and `emails` is read directly. */
function unscopedAccountWhere(db: DatabaseSync, filter: ListFilter): { sql: string; params: SQLInputValue[] } {
  if (filter.account !== null) return { sql: "e.account = ?", params: [filter.account] };
  const hidden = hiddenFromUnified(db);
  if (hidden.length === 0) return { sql: "1 = 1", params: [] };
  return { sql: `e.account NOT IN (${placeholders(hidden.length)})`, params: [...hidden] };
}

function walkScope(
  db: DatabaseSync,
  scope: Scope,
  filter: ListFilter,
  cursor: MessageCursor | null,
  window: number,
): WalkRow[] {
  const flags = flagConditions(filter, "e");
  const cur = cursorClause(cursor, scope.account, "m.received_at", "m.email_id");
  const join = flags.sql === "" ? "" : ` JOIN emails e ON e.account = m.account AND e.id = m.email_id`;
  const rows = db
    .prepare(
      `SELECT m.email_id AS id, m.received_at AS received_at, m.thread_key AS thread_key
         FROM email_mailboxes m${join}
        WHERE m.account = ? AND m.mailbox_id IN (${placeholders(scope.mailboxes.length)})${flags.sql}${cur.sql}
        ORDER BY m.received_at DESC, m.email_id ASC
        LIMIT ?`,
    )
    .all(scope.account, ...scope.mailboxes, ...flags.params, ...cur.params, window) as unknown as {
    id: string;
    received_at: string;
    thread_key: string;
  }[];
  return rows.map((r) => ({ account: scope.account, ...r }));
}

function walkUnscoped(
  db: DatabaseSync,
  filter: ListFilter,
  cursor: MessageCursor | null,
  window: number,
): WalkRow[] {
  const where = unscopedAccountWhere(db, filter);
  const flags = flagConditions(filter, "e");
  // No folder means no per-account range to walk, so the general form of
  // the cursor predicate is the one that applies.
  let curSql = "";
  const curParams: SQLInputValue[] = [];
  if (cursor !== null) {
    curSql = ` AND (e.received_at < ? OR (e.received_at = ? AND (e.account > ? OR (e.account = ? AND e.id > ?))))`;
    curParams.push(cursor.receivedAt, cursor.receivedAt, cursor.account, cursor.account, cursor.id);
  }
  return db
    .prepare(
      `SELECT e.account AS account, e.id AS id, e.received_at AS received_at,
              COALESCE(e.thread_id, e.id) AS thread_key
         FROM emails e
        WHERE ${where.sql}${flags.sql}${curSql}
        ORDER BY e.received_at DESC, e.account ASC, e.id ASC
        LIMIT ?`,
    )
    .all(...where.params, ...flags.params, ...curParams, window) as unknown as WalkRow[];
}

function walk(
  db: DatabaseSync,
  scopes: Scope[] | null,
  filter: ListFilter,
  cursor: MessageCursor | null,
  window: number,
): { rows: WalkRow[]; exhausted: boolean } {
  if (scopes === null) {
    const rows = walkUnscoped(db, filter, cursor, window);
    return { rows, exhausted: rows.length < window };
  }
  /**
   * Per account, then merged: each walk is its own covering range scan, and
   * merging sorted lists is cheaper than asking SQLite for a temp b-tree
   * across accounts.
   *
   * 🚨 `window` is EACH SCOPE'S budget, never a shared one, and the merged
   * result is NOT trimmed back to it. Trimming it silently dropped a whole
   * account: the combined sorted list was cut at `window`, so if the
   * alphabetically-first account had `window` rows of its own at a tied
   * instant, every other account's rows fell off the end -- and `exhausted`,
   * computed per scope, still said true, so the discovery loop stopped and
   * those conversations appeared on NO page while `total` went on counting
   * them. Measured by review: two accounts with dense ties dropped at least
   * one conversation entirely in 11 of 20 random trials. The unified inbox
   * is the premise of this app and it was losing mail from it.
   *
   * What makes the merge safe is the FRONTIER. A scope that returned its
   * full window may have more rows below its last one, so nothing past that
   * row can be ordered against it yet. The frontier is the earliest such
   * last row across the scopes that filled their window; rows at or before
   * it are fully ordered and usable, rows after it wait for a wider window.
   * `exhausted` therefore means "no scope can produce another row", which is
   * the only reading the discovery loop may act on.
   */
  const perScope: WalkRow[][] = [];
  let exhausted = true;
  let frontier: WalkRow | null = null;
  for (const scope of scopes) {
    const rows = walkScope(db, scope, filter, cursor, window);
    perScope.push(rows);
    if (rows.length >= window) {
      exhausted = false;
      const last = rows[rows.length - 1]!;
      if (frontier === null || byPageOrder(last, frontier) < 0) frontier = last;
    }
  }
  const merged = perScope.flat().sort(byPageOrder);
  // A message in two of the scope's mailboxes is still one message.
  const seen = new Set<string>();
  const deduped: WalkRow[] = [];
  for (const r of merged) {
    if (frontier !== null && byPageOrder(r, frontier) > 0) break;
    const key = `${r.account}\u0000${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return { rows: deduped, exhausted };
}

interface Representative {
  account: string;
  id: string;
  received_at: string;
  thread_key: string;
}

/**
 * 🚨 Decision 5: the row that TRIGGERED discovery is not necessarily the row
 * that REPRESENTS the conversation. Discovery walks in page order
 * (`received_at DESC, account ASC, email_id ASC`) so that the order threads
 * are found in is the order they will be shown in and the cursor is
 * expressible in it; the representative is `received_at DESC, email_id
 * DESC`, matching the ROW_NUMBER() the old statement used. The two disagree
 * only when a thread has two messages at the same instant -- which is why it
 * is easy to get wrong and hard to notice.
 */
function resolveRepresentative(
  db: DatabaseSync,
  scope: Scope | null,
  filter: ListFilter,
  account: string,
  key: string,
): Representative | null {
  const flags = flagConditions(filter, "e");
  if (scope !== null) {
    const join = flags.sql === "" ? "" : ` JOIN emails e ON e.account = m.account AND e.id = m.email_id`;
    const row = db
      .prepare(
        `SELECT m.email_id AS id, m.received_at AS received_at
           FROM email_mailboxes m${join}
          WHERE m.account = ? AND m.mailbox_id IN (${placeholders(scope.mailboxes.length)})
            AND m.thread_key = ?${flags.sql}
          ORDER BY m.received_at DESC, m.email_id DESC
          LIMIT 1`,
      )
      .get(account, ...scope.mailboxes, key, ...flags.params) as
      | { id: string; received_at: string }
      | undefined;
    return row === undefined ? null : { account, thread_key: key, ...row };
  }
  const row = db
    .prepare(
      `SELECT e.id AS id, e.received_at AS received_at
         FROM emails e
        WHERE e.account = ? AND COALESCE(e.thread_id, e.id) = ?${flags.sql}
        ORDER BY e.received_at DESC, e.id DESC
        LIMIT 1`,
    )
    .get(account, key, ...flags.params) as { id: string; received_at: string } | undefined;
  return row === undefined ? null : { account, thread_key: key, ...row };
}

interface DetailRow {
  account: string;
  id: string;
  thread_id: string | null;
  received_at: string;
  subject: string;
  from_name: string;
  from_email: string;
  preview: string;
  via: string | null;
}

function loadDetails(db: DatabaseSync, account: string, ids: string[]): Map<string, DetailRow> {
  const rows = db
    .prepare(
      `SELECT account, id, thread_id, received_at, subject, from_name, from_email, preview, via
         FROM emails WHERE account = ? AND id IN (${placeholders(ids.length)})`,
    )
    .all(account, ...ids) as unknown as DetailRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * 🚨 The count is of the WHOLE CONVERSATION, not of its messages in this
 * folder. The badge first shipped reading "5" for a thread the reading pane
 * called "18 messages": 8 of them were in Sent, 3 in Archive, 2 in Drafts.
 * Two numbers for one thing in adjacent panes. The design settles it:
 * msgCount is the thread's whole message array.
 *
 * So this query carries NO folder predicate and no unread/flagged predicate
 * -- unlike `threadFlags` below, which carries both. That asymmetry is the
 * single most likely defect in this module and test/list.test.ts pins it in
 * both directions.
 *
 * `emails_thread_key` (account, COALESCE(thread_id, id), received_at DESC)
 * makes it ≤50 index lookups rather than the grouping of the whole table
 * that the old statement did twice. Measured: 211ms -> 1ms.
 */
function threadCounts(db: DatabaseSync, account: string, keys: string[]): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(thread_id, id) AS k, count(*) AS n
         FROM emails
        WHERE account = ? AND COALESCE(thread_id, id) IN (${placeholders(keys.length)})
        GROUP BY COALESCE(thread_id, id)`,
    )
    .all(account, ...keys) as unknown as { k: string; n: number }[];
  return new Map(rows.map((r) => [r.k, r.n]));
}

interface Flags {
  unread: boolean;
  flagged: boolean;
  attachment: boolean;
}

/**
 * The flags are aggregated across the conversation's messages IN THIS
 * FOLDER: a conversation with an unread message in it is unread, even when
 * its latest message has been read. Taking the representative row's own
 * flags would show a thread as read while it still holds unread mail.
 *
 * 🚨 The paperclip is derived from OUR definition of an attachment, not from
 * `e.has_attachment` -- which is JMAP's flag and counts inline imagery.
 * Measured on the live archive: 1,807 messages (27% of the 6,747 showing a
 * paperclip) had one and opened to no attachments at all, and 17 had a file
 * and no paperclip. Owner ruling 2026-09-05: "Attachment means attachment,
 * not embedded image. Files, calendar invites, etc." See queries.ts's
 * NON_FILE_PART_TYPES for what that excludes.
 *
 * 🚨 The attachment test is a correlated EXISTS, bounded by the thread_key
 * IN list. The old statement could not do that: beside three `MAX() OVER`
 * windows SQLite evaluated a correlated subquery once per row of the WHOLE
 * TABLE, which is how this endpoint reached 57.8 seconds once, so it used a
 * `SELECT DISTINCT` over the entire attachments table instead. Here there
 * are no windows and no whole table -- the outer query is already ≤50
 * conversations' worth of membership rows, so EXISTS runs that many times
 * against the attachments primary key. What must never come back is an
 * unbounded materialisation of `email_attachments`.
 */
function threadFlags(
  db: DatabaseSync,
  scope: Scope | null,
  filter: ListFilter,
  account: string,
  keys: string[],
): Map<string, Flags> {
  const flags = flagConditions(filter, "e");
  const clip = `max(CASE WHEN ${HAS_REAL_ATTACHMENT_SQL} THEN 1 ELSE 0 END) AS att`;
  const rows =
    scope !== null
      ? (db
          .prepare(
            `SELECT m.thread_key AS k, max(e.is_unread) AS u, max(e.is_flagged) AS f, ${clip}
               FROM email_mailboxes m
               JOIN emails e ON e.account = m.account AND e.id = m.email_id
              WHERE m.account = ? AND m.mailbox_id IN (${placeholders(scope.mailboxes.length)})
                AND m.thread_key IN (${placeholders(keys.length)})${flags.sql}
              GROUP BY m.thread_key`,
          )
          .all(account, ...scope.mailboxes, ...keys, ...flags.params) as unknown as {
          k: string;
          u: number;
          f: number;
          att: number;
        }[])
      : (db
          .prepare(
            `SELECT COALESCE(e.thread_id, e.id) AS k, max(e.is_unread) AS u, max(e.is_flagged) AS f, ${clip}
               FROM emails e
              WHERE e.account = ? AND COALESCE(e.thread_id, e.id) IN (${placeholders(keys.length)})${flags.sql}
              GROUP BY COALESCE(e.thread_id, e.id)`,
          )
          .all(account, ...keys, ...flags.params) as unknown as {
          k: string;
          u: number;
          f: number;
          att: number;
        }[]);
  return new Map(rows.map((r) => [r.k, { unread: r.u === 1, flagged: r.f === 1, attachment: r.att === 1 }]));
}

/** Grouping off (row 37's "Group into conversations" switch): every message
 *  is its own row, so its flags are its own and there is nothing to
 *  aggregate. The thread count still says how big its conversation is. */
function messageFlags(db: DatabaseSync, account: string, ids: string[]): Map<string, Flags> {
  const rows = db
    .prepare(
      `SELECT e.id AS k, e.is_unread AS u, e.is_flagged AS f,
              CASE WHEN ${HAS_REAL_ATTACHMENT_SQL} THEN 1 ELSE 0 END AS att
         FROM emails e
        WHERE e.account = ? AND e.id IN (${placeholders(ids.length)})`,
    )
    .all(account, ...ids) as unknown as { k: string; u: number; f: number; att: number }[];
  return new Map(rows.map((r) => [r.k, { unread: r.u === 1, flagged: r.f === 1, attachment: r.att === 1 }]));
}

/**
 * The header total. Decision 6: this counts the conversations THIS CLIENT
 * HOLDS, never Fastmail's `totalThreads` -- the number beside a folder must
 * be what the folder will show, and Trash and Spam are deliberately excluded
 * from the archive walk, so the two disagree by hundreds (audit pass 4, see
 * queries.ts).
 *
 * The one deliberately non-O(page) query on this path: a `count(DISTINCT
 * thread_key)` covering scan of `email_mailboxes_thread`, 16ms over the
 * 111k-message archive against the 371ms the grouped `count(*)` cost.
 */
function folderTotal(db: DatabaseSync, scopes: Scope[] | null, filter: ListFilter, grouped: boolean): number {
  const flags = flagConditions(filter, "e");
  if (scopes === null) {
    const where = unscopedAccountWhere(db, filter);
    const expr = grouped ? "count(DISTINCT e.account || char(0) || COALESCE(e.thread_id, e.id))" : "count(*)";
    const { c } = db
      .prepare(`SELECT ${expr} AS c FROM emails e WHERE ${where.sql}${flags.sql}`)
      .get(...where.params, ...flags.params) as { c: number };
    return c;
  }
  // A thread cannot span accounts, so a per-account sum is the same number
  // the old statement's GROUP BY (account, thread key) produced.
  let total = 0;
  for (const scope of scopes) {
    const join = flags.sql === "" ? "" : ` JOIN emails e ON e.account = m.account AND e.id = m.email_id`;
    const expr = grouped ? "count(DISTINCT m.thread_key)" : "count(DISTINCT m.email_id)";
    const { c } = db
      .prepare(
        `SELECT ${expr} AS c
           FROM email_mailboxes m${join}
          WHERE m.account = ? AND m.mailbox_id IN (${placeholders(scope.mailboxes.length)})${flags.sql}`,
      )
      .get(scope.account, ...scope.mailboxes, ...flags.params) as { c: number };
    total += c;
  }
  return total;
}

function toRow(
  detail: DetailRow,
  flags: Flags,
  threadCount: number,
): EmailRow {
  return {
    account: detail.account,
    id: detail.id,
    threadId: detail.thread_id,
    receivedAt: detail.received_at,
    subject: detail.subject,
    fromName: senderName(detail.from_name, detail.from_email),
    fromEmail: detail.from_email,
    preview: detail.preview,
    isUnread: flags.unread,
    isFlagged: flags.flagged,
    hasAttachment: flags.attachment,
    snippet: null, // this is a plain listing, not a search hit -- no match to snippet
    via: detail.via,
    // v1.1 #1: the row shows this after the sender when it is >1.
    threadCount,
  };
}

export function listConversations(db: DatabaseSync, filter: ListFilter): SearchResult {
  const limit = clampLimit(filter.limit);
  const grouped = filter.group !== false;
  const scopes = resolveScopes(db, filter);
  const cursor = filter.cursor ? decodeCursor(filter.cursor) : null;

  // No folder in this account matched the role: an empty list, not an error.
  if (scopes !== null && scopes.length === 0) {
    return { rows: [], total: 0, cursor: null, truncated: false };
  }

  const total = folderTotal(db, scopes, filter, grouped);

  // Decision 5: walk `limit + 1` distinct conversations so `hasMore` and the
  // cursor are decided after resolution, not during discovery. The window
  // starts at ceil(limit * 1.3) -- measured on the live archive, 193 of the
  // newest 200 Archive messages are distinct conversations -- and doubles
  // when a folder turns out to be one long thread.
  const wanted = limit + 1;
  let window = Math.max(wanted, Math.ceil(limit * 1.3));
  const scopeOf = (account: string): Scope | null =>
    scopes === null ? null : (scopes.find((s) => s.account === account) ?? null);
  // Resolution is memoised across window widenings: a rediscovered key must
  // not cost a second lookup, and a key rejected by the cursor must not cost
  // one on every pass.
  const resolved = new Map<string, Representative | null>();

  let reps: Representative[] = [];
  for (;;) {
    const walked = walk(db, scopes, filter, cursor, window);
    // `complete` is "this pass saw everything that could still belong on the
    // page", which is NOT the same as "it found enough". See the tie block
    // below: stopping the moment `wanted` conversations exist drops mail.
    let complete = walked.exhausted;
    if (!grouped) {
      reps = walked.rows
        .slice(0, wanted)
        .map((r) => ({ account: r.account, id: r.id, received_at: r.received_at, thread_key: r.thread_key }));
      complete = complete || reps.length >= wanted;
    } else {
      const seen = new Set<string>();
      reps = [];
      /**
       * 🚨 The cut is taken in REPRESENTATIVE order, so discovery cannot stop
       * at the `wanted`-th conversation FOUND -- it must finish the tie block
       * that conversation sits in.
       *
       * Discovery order and representative order agree everywhere except
       * inside a run of equal `received_at`: a thread is discovered at its
       * LOWEST-id member in the folder (page order) but represented by its
       * HIGHEST-id one, and the representative therefore sorts BELOW the row
       * that found it. So a tied thread can take a page slot ahead of a
       * conversation whose representative sorts above it -- and that
       * conversation, never discovered on this page, is then excluded from
       * the next one by the cursor. The failure is silent OMISSION: five rows
       * at one instant, threads {a,z} and {b,w} plus singleton {m}, gave
       * pages ['w'], ['z'] and a total of 3, with `m` on no page at all.
       *
       * `boundary` is the current `wanted`-th representative, and the walk
       * stops at the first row that sorts strictly below it IN PAGE ORDER --
       * not at the first row with an older `received_at`.
       *
       * Both are correct; only the page-order form is affordable. A thread
       * first discovered at row `r` is represented either by a message that
       * fails `belowCursor`, or by one that sorts AT OR BELOW `r` in page
       * order -- any newer member would have been walked first, and a tied
       * member has a higher id, which sorts later. So no row below the
       * `wanted`-th representative can displace it, whether or not it shares
       * its instant. 🚨 Comparing `received_at` alone made a same-instant
       * block cost the WHOLE block and then made the widening loop re-walk
       * it: measured on a folder of 8,000 messages at one instant,
       * `limit: 50` took 8,012 statements / 985ms against 56 / 9.6ms for the
       * same folder at distinct instants. A bulk `Email/import` produces
       * exactly that shape, so this was the O(folder) page cost this module
       * exists to delete, coming back for one kind of data.
       */
      let boundary: Representative | null = null;
      for (const r of walked.rows) {
        if (boundary !== null && byPageOrder(r, boundary) > 0) {
          complete = true;
          break;
        }
        const key = `${r.account}\u0000${r.thread_key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let rep = resolved.get(key);
        if (rep === undefined) {
          rep = resolveRepresentative(db, scopeOf(r.account), filter, r.account, r.thread_key);
          resolved.set(key, rep);
        }
        // Not `rep === null` only: a conversation whose representative sits
        // ABOVE the cursor has already been shown. See belowCursor.
        if (rep === null || !belowCursor(rep, cursor)) continue;
        reps.push(rep);
        if (reps.length >= wanted) {
          // Adding a representative can only move the boundary UP in page
          // order, so it is monotonic and the walk can stop at it.
          boundary = [...reps].sort(byPageOrder)[wanted - 1]!;
        }
      }
    }
    // A window that ran out mid-tie-block must widen even though it already
    // holds `wanted` conversations -- the missing one may be in the next row.
    if (walked.exhausted || (reps.length >= wanted && complete)) break;
    window *= 2;
  }

  // Decision 5's third order: the resolved representatives are re-sorted
  // before anything is emitted, and the cursor is taken from the last row
  // that survives the cut.
  reps.sort(byPageOrder);
  const hasMore = reps.length > limit;
  const emitted = hasMore ? reps.slice(0, limit) : reps;

  const byAccount = new Map<string, Representative[]>();
  for (const r of emitted) {
    const list = byAccount.get(r.account);
    if (list === undefined) byAccount.set(r.account, [r]);
    else list.push(r);
  }

  const rows: EmailRow[] = [];
  const assembled = new Map<string, EmailRow>();
  for (const [account, group] of byAccount) {
    const details = loadDetails(db, account, group.map((r) => r.id));
    const countKeys = [...new Set(group.map((r) => details.get(r.id)?.thread_id ?? r.id))];
    const counts = threadCounts(db, account, countKeys);
    const flags = grouped
      ? threadFlags(db, scopeOf(account), filter, account, [...new Set(group.map((r) => r.thread_key))])
      : messageFlags(db, account, group.map((r) => r.id));
    for (const rep of group) {
      const detail = details.get(rep.id);
      // A membership row whose email is gone (a delete racing this read)
      // consumes a page slot and emits no row, and the cursor still advances
      // past it -- a short page, never a repeated or skipped conversation.
      if (detail === undefined) continue;
      const countKey = detail.thread_id ?? detail.id;
      const flagKey = grouped ? rep.thread_key : rep.id;
      const f = flags.get(flagKey) ?? { unread: false, flagged: false, attachment: false };
      assembled.set(`${account}\u0000${rep.id}`, toRow(detail, f, counts.get(countKey) ?? 1));
    }
  }
  for (const rep of emitted) {
    const row = assembled.get(`${rep.account}\u0000${rep.id}`);
    if (row !== undefined) rows.push(row);
  }

  const last = emitted.length > 0 ? emitted[emitted.length - 1]! : null;
  const nextCursor =
    hasMore && last !== null
      ? encodeCursor({ received_at: last.received_at, account: last.account, id: last.id })
      : null;

  return { rows, total, cursor: nextCursor, truncated: total > limit };
}
