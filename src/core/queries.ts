import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { parseQuery, type ParsedQuery } from "./searchquery.ts";
import type { Addr, AttachmentMeta } from "./details.ts";

export const SEARCH_LIMIT = 200;

/**
 * The markers FTS5's snippet() wraps around each match. Private Use Area
 * codepoints, chosen so a marker can never be confused with a character a
 * sender actually wrote -- see the comment at the snippet() call site.
 * Mirrored by `SNIPPET_OPEN`/`SNIPPET_CLOSE` in client/src/lib/escape.ts.
 */
export const SNIPPET_OPEN = "\uE000";
export const SNIPPET_CLOSE = "\uE001";

/**
 * What a sender is CALLED: the display name when there is one, else the
 * address. 2026-09-12: 4,108 of 38,196 stored messages carry no name --
 * `From: <billing@example.com>` and the like -- and every surface showed
 * an empty string where the sender should be. The fallback lives here,
 * where rows and details are built, so the list, the reading card, thread
 * items and search results cannot disagree.
 */
export function senderName(name: string | null | undefined, email: string): string {
  const n = (name ?? "").trim();
  return n !== "" ? n : email;
}

export interface EmailRow {
  account: string;
  id: string;
  threadId: string | null;
  receivedAt: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  preview: string;
  isUnread: boolean;
  isFlagged: boolean;
  hasAttachment: boolean;
  snippet: string | null;
  via: string | null;
  /**
   * Messages in this conversation (v1.1 #1). 1 for a search hit, which is a
   * message rather than a thread -- the list row shows this only when it is
   * greater than 1.
   */
  threadCount?: number;
}

export interface SearchOptions {
  limit?: number;
  cursor?: string | null;
}

export interface SearchResult {
  rows: EmailRow[];
  total: number;
  cursor: string | null; // null when there are no further pages
  truncated: boolean; // true when total exceeds what one page can show
}

const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * Turn a search box's contents into an FTS5 query.
 *
 * Every term is quoted so that punctuation -- an email address, most obviously
 * -- cannot become FTS5 syntax. The last term gets a prefix match so results
 * appear while the query is still being typed, which is most of what makes
 * search feel instant.
 */
export function ftsQuery(input: string): string | null {
  const terms = input
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "" && HAS_WORD.test(t));
  if (terms.length === 0) return null;

  const quoted = terms.map((t) => `"${t.replaceAll('"', '""')}"`);
  quoted[quoted.length - 1] = `${quoted[quoted.length - 1]}*`;
  return quoted.join(" ");
}

const ROW_COLUMNS = `
  e.account, e.id, e.thread_id, e.received_at, e.subject,
  e.from_name, e.from_email, e.preview,
  e.is_unread, e.is_flagged, e.has_attachment, e.via
`;

interface RawRow {
  account: string;
  id: string;
  thread_id: string | null;
  received_at: string;
  subject: string;
  from_name: string;
  from_email: string;
  preview: string;
  is_unread: number;
  is_flagged: number;
  has_attachment: number;
  via: string | null;
  snippet: string | null;
}

function toRow(r: RawRow): EmailRow {
  return {
    account: r.account,
    id: r.id,
    threadId: r.thread_id,
    receivedAt: r.received_at,
    subject: r.subject,
    fromName: senderName(r.from_name, r.from_email),
    fromEmail: r.from_email,
    preview: r.preview,
    isUnread: r.is_unread === 1,
    isFlagged: r.is_flagged === 1,
    hasAttachment: r.has_attachment === 1,
    snippet: r.snippet ?? null,
    via: r.via,
  };
}

/**
 * Build every "%value%" LIKE pattern in JS, never in SQL, so the value it
 * came from is always bound as a parameter -- never interpolated.
 */
function likePattern(value: string): string {
  return `%${value}%`;
}

/**
 * `received_at` is stored as a JMAP UTCDate -- "2026-01-01T00:00:00Z", no
 * fractional seconds. parseQuery's before:/after: bounds come from
 * `Date.toISOString()`, which always includes ".000". Comparing those two
 * shapes as strings sorts correctly today only because '.' (0x2E) sorts
 * below 'Z' (0x5A) -- coincidence, not correctness. Strip the milliseconds
 * so the bound is compared against the same shape it's stored in.
 */
function normalizeUtcBound(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

/**
 * SQLite treats a negative LIMIT as "no limit" -- `limit=-5` would otherwise
 * fetch the entire archive with full previews before `.slice()` trims the
 * JS array back down. Clamp to [1, SEARCH_LIMIT] so a request can shrink a
 * page but never grow or invert one.
 */
function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return SEARCH_LIMIT;
  return Math.max(1, Math.min(SEARCH_LIMIT, Math.trunc(value)));
}

interface Cursor {
  receivedAt: string;
  account: string;
  id: string;
}

/**
 * Encodes the tuple (received_at, account, id) that ORDER BY sorts on. A
 * plain OFFSET drifts as new mail arrives mid-paging; this encodes "the last
 * row you saw" instead, so the next page's predicate is a tuple comparison.
 */
function encodeCursor(row: RawRow): string {
  return Buffer.from(
    JSON.stringify([row.received_at, row.account, row.id]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
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

/**
 * Build the operator predicates from a ParsedQuery (everything except the
 * free-text terms, which the caller joins to emails_fts separately). Every
 * value is bound, never interpolated -- the search box is direct user input
 * and this is the only injection surface in the codebase.
 */
function operatorConditions(parsed: ParsedQuery): {
  conditions: string[];
  params: SQLInputValue[];
} {
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];

  if (parsed.acct.length > 0) {
    conditions.push(`e.account IN (${parsed.acct.map(() => "?").join(", ")})`);
    params.push(...parsed.acct);
  }

  if (parsed.from.length > 0) {
    const clauses = parsed.from.map((v) => {
      params.push(likePattern(v), likePattern(v));
      return "(e.from_email LIKE ? OR e.from_name LIKE ?)";
    });
    conditions.push(`(${clauses.join(" OR ")})`);
  }

  if (parsed.to.length > 0) {
    const clauses = parsed.to.map((v) => {
      params.push(likePattern(v));
      return `EXISTS (
        SELECT 1 FROM email_recipients r
         WHERE r.account = e.account AND r.email_id = e.id
           AND r.kind IN ('to', 'cc') AND r.email LIKE ?
      )`;
    });
    conditions.push(`(${clauses.join(" OR ")})`);
  }

  if (parsed.cc.length > 0) {
    const clauses = parsed.cc.map((v) => {
      params.push(likePattern(v));
      return `EXISTS (
        SELECT 1 FROM email_recipients r
         WHERE r.account = e.account AND r.email_id = e.id
           AND r.kind = 'cc' AND r.email LIKE ?
      )`;
    });
    conditions.push(`(${clauses.join(" OR ")})`);
  }

  if (parsed.in.length > 0) {
    const clauses = parsed.in.map((v) => {
      params.push(v, v);
      return `EXISTS (
        SELECT 1 FROM email_mailboxes em
        JOIN mailboxes m ON m.account = em.account AND m.id = em.mailbox_id
         WHERE em.account = e.account AND em.email_id = e.id
           AND (LOWER(m.name) = ? OR LOWER(m.role) = ?)
      )`;
    });
    conditions.push(`(${clauses.join(" OR ")})`);
  }

  if (parsed.isUnread !== null) {
    conditions.push("e.is_unread = ?");
    params.push(parsed.isUnread ? 1 : 0);
  }

  if (parsed.isFlagged !== null) {
    conditions.push("e.is_flagged = ?");
    params.push(parsed.isFlagged ? 1 : 0);
  }

  if (parsed.hasAttachment === true) {
    // See HAS_REAL_ATTACHMENT_SQL: not `e.has_attachment`, which is JMAP's
    // flag and counts inline imagery. parseQuery never produces `false` here
    // (there is no `has:no-attachment` operator), so there is deliberately no
    // negated branch to leave unreachable and untested.
    conditions.push(HAS_REAL_ATTACHMENT_SQL);
  }

  if (parsed.after !== null) {
    conditions.push("e.received_at >= ?");
    params.push(normalizeUtcBound(parsed.after));
  }

  if (parsed.before !== null) {
    conditions.push("e.received_at < ?");
    params.push(normalizeUtcBound(parsed.before));
  }

  return { conditions, params };
}

/**
 * Full-text (and/or operator-scoped) search across every account, newest
 * first.
 *
 * Ordered by date rather than by relevance rank: you search mail to find a
 * specific message you remember receiving, and recency is the strongest
 * signal available. The (received_at, account, id) tiebreak is what makes
 * the cursor stable across pages.
 *
 * The load-bearing branch: a query built entirely of operators (no text
 * terms) is a real search -- `is:unread acct:work` -- and must not touch
 * emails_fts at all. ftsQuery("") is null, and joining that would silently
 * mean "no results" instead of "every unread work email".
 */
export function searchEmails(db: DatabaseSync, input: string, opts: SearchOptions = {}): SearchResult {
  const limit = clampLimit(opts.limit);
  const parsed = parseQuery(input);
  const matchQuery = ftsQuery(parsed.text);
  const { conditions: opConditions, params: opParams } = operatorConditions(parsed);

  const hasAnyPredicate = matchQuery !== null || opConditions.length > 0;
  if (!hasAnyPredicate) {
    return { rows: [], total: 0, cursor: null, truncated: false };
  }

  const from =
    matchQuery !== null
      ? "FROM emails_fts JOIN emails e ON e.rowid = emails_fts.rowid"
      : "FROM emails e";
  // FTS5's snippet() wraps each match in a pair of literal marker strings,
  // which the SPA splits back out to render `<mark>` segments (see
  // `splitSnippet` in client/src/lib/escape.ts -- the two ends of this
  // contract must stay in step, and there is no shared module between the
  // server and client packages to hold them).
  //
  // The markers are U+E000/U+E001 from the Private Use Area, NOT the '‹'/'›'
  // guillemets this originally used. Guillemets are ordinary characters that
  // appear in real mail, so any client that failed to split them showed them
  // as literal text -- which is exactly what shipped, and they are also
  // indistinguishable from a sender's own guillemets once split. A PUA
  // codepoint has no legitimate use in message text, so an unpaired one is
  // unambiguously ours to drop.
  const snippetSelect =
    matchQuery !== null
      ? `snippet(emails_fts, -1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 12) AS snippet`
      : "NULL AS snippet";

  const baseConditions = [...opConditions];
  const baseParams = [...opParams];
  if (matchQuery !== null) {
    baseConditions.unshift("emails_fts MATCH ?");
    baseParams.unshift(matchQuery);
  }

  const baseWhere = baseConditions.length > 0 ? `WHERE ${baseConditions.join(" AND ")}` : "";

  const { c: total } = db
    .prepare(`SELECT count(*) AS c ${from} ${baseWhere}`)
    .get(...baseParams) as { c: number };

  const pageConditions = [...baseConditions];
  const pageParams = [...baseParams];
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cursor !== null) {
    pageConditions.push(
      "(e.received_at < ? OR (e.received_at = ? AND (e.account > ? OR (e.account = ? AND e.id > ?))))",
    );
    pageParams.push(cursor.receivedAt, cursor.receivedAt, cursor.account, cursor.account, cursor.id);
  }
  const pageWhere = pageConditions.length > 0 ? `WHERE ${pageConditions.join(" AND ")}` : "";

  // Fetch one extra row so "is there a next page" doesn't require knowing
  // how many rows came before this one -- which the cursor deliberately
  // does not track.
  const fetched = db
    .prepare(
      `SELECT ${ROW_COLUMNS}, ${snippetSelect}
         ${from}
         ${pageWhere}
        ORDER BY e.received_at DESC, e.account, e.id
        LIMIT ?`,
    )
    .all(...pageParams, limit + 1) as unknown as RawRow[];

  // "Is there a next page" (hasMore) and "does the whole match set exceed
  // one page" (truncated) are different facts. truncated stays true on the
  // LAST page too -- a "200 of 9,612" UI needs that, and it would be wrong
  // to report false just because this happens to be the final page.
  const hasMore = fetched.length > limit;
  const rawRows = hasMore ? fetched.slice(0, limit) : fetched;
  const nextCursor = hasMore && rawRows.length > 0 ? encodeCursor(rawRows[rawRows.length - 1]!) : null;
  const truncated = total > limit;

  return { rows: rawRows.map(toRow), total, cursor: nextCursor, truncated };
}

/**
 * Computed from the junction table, NEVER read from mailboxes.unread_emails --
 * that column only moves when the whole mailbox list is refetched, so marking a
 * message read leaves it stale until restart (spec 4.3).
 */
/**
 * How many messages this client HOLDS in a mailbox.
 *
 * 🚨 Not `mailboxes.total_emails`, which is the SERVER's count. The two
 * legitimately differ by a lot: Trash and Spam are excluded from the archive
 * walk on purpose, so Fastmail reports 886 in personal/trash where 97 are
 * here. The sidebar labels a list, and the number beside a folder has to be
 * the number of things that folder will show — audit pass 4.
 */
export function mailboxTotal(db: DatabaseSync, account: string, mailboxId: string): number {
  const { c } = db
    .prepare(
      `SELECT count(*) AS c
         FROM email_mailboxes m
        WHERE m.account = ? AND m.mailbox_id = ?`,
    )
    .get(account, mailboxId) as { c: number };
  return c;
}

/**
 * What counts as an ATTACHMENT — one definition, used everywhere.
 *
 * 🚨 Owner ruling 2026-09-05: "Attachment means attachment, not embedded
 * image. Files, calendar invites, etc. Email clients already know what this
 * means, we follow that convention."
 *
 * So NOT `emails.has_attachment`, which is JMAP's own flag and counts inline
 * imagery: measured on the live archive, 1,807 messages (27% of the 6,747
 * showing a paperclip) had one and opened to no attachments at all — a
 * marketing header logo, a tracking pixel, a signature image. The paperclip
 * promised a file and there was none.
 *
 * Two exclusions, and only two:
 *
 * - **A part with a `cid`** is an inline image the message renders itself.
 * - **`text/x-amp-html` and `text/x-watch-html`** are alternative renderings
 *   of the BODY that Fastmail reports in `attachments`. They are not files;
 *   offering a download chip for one is offering to save the email as itself.
 *
 * Everything else stays, deliberately including `text/calendar`,
 * `text/x-vcalendar` and `text/x-vcard` — an invite and a contact card are
 * files a person means to keep — and `text/html` / `text/plain`, which are
 * routinely real `.html` and `.txt` attachments (this archive holds five).
 *
 * 🚨 This lived in TWO places with two different answers before: search used
 * the `cid IS NULL` form while the message list used `e.has_attachment`, so
 * `has:attachment` and the paperclip disagreed about the same message. One
 * exported predicate is what stops that recurring.
 */
export const NON_FILE_PART_TYPES = ["text/x-amp-html", "text/x-watch-html"] as const;

/**
 * Is this part a FILE the reader can open, as opposed to decoration the body
 * draws?
 *
 * 🚨 A content id alone does not answer that, and believing it did made real
 * attachments unopenable (2026-09-23: eight invoice PDFs rendered as inert
 * labels, "I am clicking the pdf chip and nothing happens"). Gmail assigns a
 * `f_...` cid to every part it sends, so `cid IS NULL` classified those
 * files as a signature logo.
 *
 * The SENDER'S OWN disposition decides. `attachment` means a file however it
 * is tagged; anything else keeps the historical cid reading, which is what
 * keeps a real signature logo out of the list -- those parts are declared
 * `inline`, or carry no disposition at all. NULL disposition is also every
 * row written before schema 13, so the old behaviour stands until the
 * details backfill re-fetches them.
 */
export const isFilePart = (a: { cid: string | null; type: string; disposition?: string | null }): boolean =>
  (a.cid === null || (a.disposition ?? "").toLowerCase() === "attachment") &&
  !(NON_FILE_PART_TYPES as readonly string[]).includes(a.type);

/** SQL for "this message has a real attachment", correlated to `e`. Takes no
 *  parameters, so it drops into any query without disturbing its binds.
 *  🚨 Must stay the same rule as `isFilePart` -- the paperclip, the read
 *  API's attachment list and `has:attachment` all run off this one idea, and
 *  they disagreed about the same message once already. */
export const HAS_REAL_ATTACHMENT_SQL = `EXISTS (
      SELECT 1 FROM email_attachments a
       WHERE a.account = e.account AND a.email_id = e.id
         AND (a.cid IS NULL OR lower(a.disposition) = 'attachment')
         AND a.type NOT IN (${NON_FILE_PART_TYPES.map((t) => `'${t}'`).join(", ")})
    )`;

export function unreadCount(db: DatabaseSync, account: string, mailboxId: string): number {
  const { c } = db
    .prepare(
      `SELECT count(*) AS c
         FROM email_mailboxes m
         JOIN emails e ON e.account = m.account AND e.id = m.email_id
        WHERE m.account = ? AND m.mailbox_id = ? AND e.is_unread = 1`,
    )
    .get(account, mailboxId) as { c: number };
  return c;
}

export interface MailboxSummary {
  id: string;
  name: string;
  role: string | null;
  parent: string | null;
  /** Unread messages in this mailbox. The sidebar shows this ONLY for the
   *  inbox; see `total`. */
  unread: number;
  /** Messages this client holds in the mailbox — what the folder's list
   *  will actually show, not the server's own `total_emails` (Trash and
   *  Spam are deliberately not fully synced, so those two disagree by
   *  hundreds). Audit pass 4. */
  total: number;
}

interface MailboxRow {
  id: string;
  name: string;
  role: string | null;
  parent_id: string | null;
}

/**
 * One grouped query for every mailbox's unread/total counts, joined onto the
 * mailbox rows in memory -- replaces a `unreadCount` + `mailboxTotal` call
 * per mailbox (130 queries for 65 folders, measured at 509ms on a
 * 167,749-message instance vs 38ms on a 38k one). The count query's semantics
 * are unchanged from `unreadCount`/`mailboxTotal` above: computed from the
 * `email_mailboxes` junction, never `mailboxes.total_emails`/`unread_emails`
 * (audit pass 4) -- a mailbox with zero rows in the junction just doesn't
 * appear in the grouped result and defaults to 0/0 below.
 */
export function listMailboxes(db: DatabaseSync, account: string): MailboxSummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, role, parent_id
         FROM mailboxes
        WHERE account = ?
        ORDER BY sort_order, name, id`,
    )
    .all(account) as unknown as MailboxRow[];

  // 🚨 TWO queries, and they must stay two (schema 12, 2026-09-23). One
  // grouped statement that joined `emails` for `sum(is_unread)` cost 491ms
  // on the live 167k-message instance -- 473ms of it looking up every
  // membership row's email by primary key, through a table made wide by
  // `body_text`. Nothing about the sidebar needs to read those rows:
  //
  //   totals  -- `email_mailboxes` alone, served entirely by the covering
  //              index migration 11 added (18ms at that size). The folder's
  //              membership IS the folder's size; a membership row whose
  //              email is missing is drift, which the tests forbid, not a
  //              number to correct for here.
  //   unread  -- driven from the UNREAD messages (partial index
  //              `emails_unread`), not from every message. 164 of 167,756
  //              on that instance, and an archive stays mostly-read by
  //              nature, so this side is small by construction.
  //
  // Putting them back together, or counting unread from the membership
  // side, restores the original cost. `list.bench.ts` asserts the PLAN for
  // exactly this reason: at a synthetic corpus's row width the slow version
  // still comes in under any sane time budget.
  const totals = db
    .prepare(
      `SELECT mailbox_id AS mailboxId, count(*) AS total
         FROM email_mailboxes
        WHERE account = ?
        GROUP BY mailbox_id`,
    )
    .all(account) as unknown as { mailboxId: string; total: number }[];

  const unread = db
    .prepare(
      `SELECT m.mailbox_id AS mailboxId, count(*) AS unread
         FROM emails e
         JOIN email_mailboxes m ON m.account = e.account AND m.email_id = e.id
        WHERE e.account = ? AND e.is_unread = 1
        GROUP BY m.mailbox_id`,
    )
    .all(account) as unknown as { mailboxId: string; unread: number }[];

  const totalById = new Map(totals.map((c) => [c.mailboxId, c.total]));
  const unreadById = new Map(unread.map((c) => [c.mailboxId, c.unread]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    parent: r.parent_id,
    unread: unreadById.get(r.id) ?? 0,
    total: totalById.get(r.id) ?? 0,
  }));
}

/**
 * Full read of one message: recipients, attachments split from inline
 * parts, keywords, and mailbox membership -- everything the read API
 * (task 6) exposes for `GET /api/messages/:account/:id` and
 * `GET /api/threads/:account/:threadId`.
 *
 * Deliberately NOT `html`: message HTML is served by the body origin under
 * a capability token (spec §3.3, §6 -- plan 5), never by this JSON API. See
 * `hasHtml`'s own comment for how "we haven't looked yet" is represented.
 */
export interface MessageDetail {
  account: string;
  id: string;
  threadId: string | null;
  receivedAt: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  via: string | null;
  isUnread: boolean;
  isFlagged: boolean;
  bodyText: string | null;
  // emails.has_html (migration 4, task 6b) follows the same three-state
  // convention as bodyText/detailsAt: NULL until the one-time detail
  // backfill (task 2) has actually fetched this message's htmlBody, 0/1
  // once it has. Reporting `false` for the NULL case would be a lie the
  // SPA cannot detect -- it gates body-frame requests on this field (spec
  // §3.1), so a false "no HTML" would silently render real HTML mail as
  // plaintext-only. `null` here means exactly that: not yet determined:
  // ask again once the backfill has reached this message.
  hasHtml: boolean | null;
  keywords: Record<string, boolean>;
  mailboxIds: string[];
  attachments: AttachmentMeta[];
  inlineParts: AttachmentMeta[];
}

interface RawDetailRow {
  account: string;
  id: string;
  thread_id: string | null;
  received_at: string;
  subject: string;
  from_name: string;
  from_email: string;
  via: string | null;
  is_unread: number;
  is_flagged: number;
  body_text: string | null;
  has_html: number | null;
  keywords: string;
}

interface RawRecipientRow {
  kind: string;
  name: string;
  email: string;
}

interface RawAttachmentRow {
  part_id: string;
  name: string;
  type: string;
  size: number;
  cid: string | null;
  /** The sender's own Content-Disposition (schema 13). NULL on every row
   *  written before it, and on senders that declare none. */
  disposition: string | null;
}

function toAttachmentMeta(r: RawAttachmentRow): AttachmentMeta {
  return { partId: r.part_id, name: r.name, type: r.type, size: r.size, cid: r.cid };
}

function parseKeywords(raw: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
    return {};
  } catch {
    return {};
  }
}

function buildDetail(db: DatabaseSync, row: RawDetailRow): MessageDetail {
  const recipients = db
    .prepare(`SELECT kind, name, email FROM email_recipients WHERE account = ? AND email_id = ?`)
    .all(row.account, row.id) as unknown as RawRecipientRow[];

  const to: Addr[] = [];
  const cc: Addr[] = [];
  const bcc: Addr[] = [];
  const replyTo: Addr[] = [];
  for (const r of recipients) {
    const addr: Addr = { name: r.name, email: r.email };
    if (r.kind === "to") to.push(addr);
    else if (r.kind === "cc") cc.push(addr);
    else if (r.kind === "bcc") bcc.push(addr);
    else if (r.kind === "reply-to") replyTo.push(addr);
  }

  const attachmentRows = db
    .prepare(
      `SELECT part_id, name, type, size, cid, disposition FROM email_attachments WHERE account = ? AND email_id = ?`,
    )
    .all(row.account, row.id) as unknown as RawAttachmentRow[];
  // The cid distinction (spec 6.5): a non-NULL cid is an inline image (a
  // signature logo) referenced FROM the body, not a real attachment --
  // search's has:attachment already depends on this same split
  // (queries.ts's operatorConditions), and the read API must agree with it
  // rather than showing a different count.
  // Same definition as the paperclip and `has:attachment` -- a chip offering
  // to download an alternative rendering of the body is offering to save the
  // email as itself.
  const attachments = attachmentRows.filter(isFilePart).map(toAttachmentMeta);
  // 🚨 NOT `!isFilePart`. These two lists deliberately OVERLAP now: the body
  // frame resolves every `cid:` reference against this one (bodyhost.ts's
  // `byCid`), so a part must stay here whenever it has a cid at all, even
  // when it is also offered as a file. Making them exclusive is what would
  // break an image a body genuinely draws.
  const inlineParts = attachmentRows.filter((a) => a.cid !== null).map(toAttachmentMeta);

  const mailboxRows = db
    .prepare(`SELECT mailbox_id FROM email_mailboxes WHERE account = ? AND email_id = ?`)
    .all(row.account, row.id) as unknown as { mailbox_id: string }[];

  return {
    account: row.account,
    id: row.id,
    threadId: row.thread_id,
    receivedAt: row.received_at,
    subject: row.subject,
    fromName: senderName(row.from_name, row.from_email),
    fromEmail: row.from_email,
    to,
    cc,
    bcc,
    replyTo,
    via: row.via,
    isUnread: row.is_unread === 1,
    isFlagged: row.is_flagged === 1,
    bodyText: row.body_text,
    hasHtml: row.has_html === null ? null : row.has_html === 1,
    keywords: parseKeywords(row.keywords),
    mailboxIds: mailboxRows.map((m) => m.mailbox_id),
    attachments,
    inlineParts,
  };
}

const DETAIL_ROW_COLUMNS = `
  account, id, thread_id, received_at, subject, from_name, from_email,
  via, is_unread, is_flagged, body_text, has_html, keywords
`;

/** `(account, id)` is the whole key -- see spec 4.2. Null when either half is wrong. */
export function getMessage(db: DatabaseSync, account: string, id: string): MessageDetail | null {
  const row = db
    .prepare(`SELECT ${DETAIL_ROW_COLUMNS} FROM emails WHERE account = ? AND id = ?`)
    .get(account, id) as unknown as RawDetailRow | undefined;
  if (row === undefined) return null;
  return buildDetail(db, row);
}

/**
 * Every message in one account's thread, oldest first -- reading a
 * conversation top to bottom is reading it in the order it happened.
 * Scoped by `account` the same way everything else here is: `thread_id` is
 * only ever meaningful within the account that assigned it, so a thread id
 * that also appears in another account is a coincidence, not a shared
 * conversation.
 */
export function getThread(db: DatabaseSync, account: string, threadId: string): MessageDetail[] {
  const rows = db
    .prepare(
      `SELECT ${DETAIL_ROW_COLUMNS} FROM emails
        WHERE account = ? AND thread_id = ?
        ORDER BY received_at ASC, id ASC`,
    )
    .all(account, threadId) as unknown as RawDetailRow[];
  return rows.map((r) => buildDetail(db, r));
}

// ---------------------------------------------------------------------------
// "Written to" for the per-account notification switch (row 37). The
// COMPOSE side of contacts moved to core/addressbook.ts on 2026-10-03: it
// is held in memory because ranking correspondents is an aggregate over the
// whole archive, which cost 175ms per keystroke as a query.
// ---------------------------------------------------------------------------

/** Whether the account has ever WRITTEN to `email`: it is a To/Cc of a
 *  message in the account's Sent folder. The definition behind the
 *  "people only" notification switch (row 37): a person is someone you
 *  have replied to; a receipt, a robot or a newsletter is not. */
export function writtenTo(db: DatabaseSync, account: string, email: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM email_recipients r
         JOIN email_mailboxes em ON em.account = r.account AND em.email_id = r.email_id
         JOIN mailboxes m ON m.account = em.account AND m.id = em.mailbox_id
        WHERE r.account = ? AND lower(r.email) = lower(?) AND r.kind IN ('to', 'cc') AND m.role = 'sent'
        LIMIT 1`,
    )
    .get(account, email);
  return row !== undefined;
}
