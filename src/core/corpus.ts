import type { DatabaseSync } from "node:sqlite";
import type { JmapCall, JmapClient } from "./client.ts";
import type { JmapEmail } from "./types.ts";
import { storeEmails, setSyncState, getSyncState, unfetchedIds, writeBodyText } from "./mutations.ts";
import { classify, HttpStatusError } from "./failures.ts";

/** Trash and Spam are not part of the archive. Stated because the completeness
 *  verifier compares counts and would otherwise fail on day one (spec 5.1). */
export const EXCLUDED_ROLES = ["trash", "junk"] as const;

const DEFAULT_PAGE = 50;
/** Properties the walk needs. Bodies are fetched separately, by the backfill. */
const METADATA_PROPS = [
  "id",
  "threadId",
  "receivedAt",
  "subject",
  "preview",
  "hasAttachment",
  "keywords",
  "mailboxIds",
  "from",
];

/**
 * Minimum spacing between JMAP requests. A full backfill is ~2,220 requests
 * per account (~8,880 across all four) -- at 120ms that is ~4.5 minutes per
 * account, a reasonable one-time cost, and it is our first ever contact with
 * Fastmail's servers. Overridable so tests run instantly (spec task-16a).
 */
export const DEFAULT_PACE_MS = 120;

/** Used when a 429 carries no `Retry-After` at all. Exported for tests, which
 *  need to distinguish "the default fallback fired" from "paceMs fired". */
export const DEFAULT_RETRY_AFTER_MS = 5_000;
/** A cap on any single wait, including a server-supplied `Retry-After` --
 *  an absurd value (a server bug, or a deliberately hostile one) must not
 *  turn one 429 into an hours-long stall. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** Consecutive 429s for the SAME request before giving up. Bounds the retry
 *  loop so a server that never stops rate-limiting cannot wait forever. */
export const MAX_CONSECUTIVE_RATE_LIMITS = 5;

export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

interface PaceContext {
  paceMs: number;
  sleep: Sleep;
}

function paceContext(opts: { paceMs?: number; sleep?: Sleep }): PaceContext {
  return { paceMs: opts.paceMs ?? DEFAULT_PACE_MS, sleep: opts.sleep ?? defaultSleep };
}

/**
 * Issue one JMAP request, paced and rate-limit-aware.
 *
 * Every call is preceded by a `paceMs` sleep -- a fixed minimum interval
 * between requests, not a token bucket, which is all a one-time backfill
 * needs. A 429 is retried IN PLACE: the same `calls` are resent after
 * waiting `Retry-After` (falling back to a default, capped so a hostile or
 * broken server can't stall us for hours), up to `MAX_CONSECUTIVE_RATE_LIMITS`
 * times, after which it throws rather than waiting forever.
 *
 * Deliberately does NOT touch client.ts: a 429 is an HTTP status error, and
 * JmapClient.send()'s "no retry on a status error" invariant is proven by
 * its own tests. Retrying belongs here, where the caller (walkArchive /
 * backfillBodies) already has an anchor/cursor to resume from, and can tell
 * "the same page, retried" apart from "the same page, repeated" -- this
 * function returns only on success or a non-rate-limit failure, so a 429
 * retry is invisible to the caller's own progress guards.
 */
async function pacedRequest(client: JmapClient, calls: JmapCall[], ctx: PaceContext): Promise<any[][]> {
  let consecutiveRateLimits = 0;
  for (;;) {
    await ctx.sleep(ctx.paceMs);
    try {
      return await client.request(calls);
    } catch (err) {
      const failure = classify(err);
      if (failure.kind !== "rate-limited") throw err;

      consecutiveRateLimits += 1;
      if (consecutiveRateLimits > MAX_CONSECUTIVE_RATE_LIMITS) {
        // An HttpStatusError, not a bare Error (I1). A bare Error classifies
        // as "unknown", which is precisely the ONE classification
        // backfillBodies treats as message-specific -- so giving up on a
        // rate limit took the poison-pill branch and wrote body_text = '' to
        // every id in the batch, permanently, for a fault that was about the
        // request and would have hit every following item identically.
        throw new HttpStatusError(
          `rate-limited ${consecutiveRateLimits - 1} times in a row for the same request; giving up`,
          429,
        );
      }
      const waitMs = Math.min(failure.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS);
      await ctx.sleep(waitMs);
    }
  }
}

export interface WalkOptions {
  pageSize?: number;
  onProgress?: (fetched: number) => void;
  paceMs?: number;
  sleep?: Sleep;
}

export function excludedMailboxIds(db: DatabaseSync, account: string): string[] {
  const placeholders = EXCLUDED_ROLES.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id FROM mailboxes WHERE account = ? AND role IN (${placeholders})`)
    .all(account, ...EXCLUDED_ROLES) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Walk the archive backwards, paged by ANCHOR rather than timestamp.
 *
 * Timestamp paging silently skips messages when several share a second. Anchor
 * paging does not -- but the anchor message can be deleted mid-walk, which the
 * server reports as `anchorNotFound`; that falls back to positional paging for
 * one page rather than ending the walk.
 *
 * Resumable: sync_state('walk') stores `"<lastId>|<position>"` -- both the
 * last anchor id AND the position it corresponds to, not the id alone. Both
 * are needed: `position` is what anchorNotFound falls back to (see below),
 * and it must be accurate on a RESUMED walk, not just within one call --
 * storing only the id and always restarting `position` at 0 (finding 6) means
 * a restart mid-walk plus a deleted anchor re-walks the entire account from
 * the top, silently, because the position used for the fallback no longer
 * means what the comment beside it claims. `sync_state.state` is explicitly
 * an opaque string, so this composite value is legal there. Older stored
 * state predating this format (a bare id, no `|`) is still accepted -- see
 * the parse below -- and resumes with position 0, exactly today's imperfect
 * behaviour, rather than fabricating a number.
 *
 * A walk that has already finished short-circuits on the sentinel 'done'.
 */
export async function walkArchive(
  db: DatabaseSync,
  client: JmapClient,
  account: string,
  opts: WalkOptions = {},
): Promise<{ fetched: number; complete: boolean }> {
  // Checked FIRST, and with no JMAP request behind it: refreshAccount now
  // calls this on every supervisor pass (C3), so the finished case must cost
  // exactly one getSyncState and nothing else.
  const stored = getSyncState(db, account, "walk");
  if (stored === "done") return { fetched: 0, complete: true };

  // One walker per account per process. main.ts kicks off the first walk
  // in parallel across accounts while the supervisor's pass now also calls
  // this; without the guard both would advance the same stored anchor,
  // duplicating fetches and tripping walkArchive's own progress guard.
  const inFlight = walksInFlight.get(account);
  if (inFlight) return inFlight;
  const run = walkArchiveOnce(db, client, account, opts, stored);
  walksInFlight.set(account, run);
  try {
    return await run;
  } finally {
    walksInFlight.delete(account);
  }
}

const walksInFlight = new Map<string, Promise<{ fetched: number; complete: boolean }>>();

async function walkArchiveOnce(
  db: DatabaseSync,
  client: JmapClient,
  account: string,
  opts: WalkOptions,
  stored: string | null,
): Promise<{ fetched: number; complete: boolean }> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE;
  const accountId = client.session.mailAccountId;
  const excluded = excludedMailboxIds(db, account);
  const ctx = paceContext(opts);

  let anchor: string | null;
  let position: number;
  if (stored === null) {
    anchor = null;
    position = 0;
  } else {
    const sep = stored.lastIndexOf("|");
    if (sep === -1) {
      // Pre-finding-6 stored state: a bare id, no position. Cannot recover
      // the true position, so fall back to 0 -- today's existing (imperfect)
      // behaviour for state written before this fix shipped -- rather than
      // fabricate one.
      anchor = stored;
      position = 0;
    } else {
      anchor = stored.slice(0, sep);
      const parsed = Number(stored.slice(sep + 1));
      position = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
  }
  let fetched = 0;
  // Guards against a server that returns the same page forever (a real fake
  // observed in review: it ignored the anchor and always answered with the
  // same 20 ids). Without this the loop's only exit -- `ids.length === 0` --
  // never fires, and it spins indefinitely.
  let previousLast: string | null = null;

  const filter =
    excluded.length > 0
      ? {
          operator: "AND",
          conditions: excluded.map((id) => ({ operator: "NOT", conditions: [{ inMailbox: id }] })),
        }
      : undefined;

  for (;;) {
    const queryArgs: Record<string, unknown> = {
      accountId,
      sort: [{ property: "receivedAt", isAscending: false }],
      limit: pageSize,
      calculateTotal: false,
    };
    if (filter) queryArgs["filter"] = filter;
    if (anchor !== null) {
      queryArgs["anchor"] = anchor;
      queryArgs["anchorOffset"] = 1;
    } else {
      queryArgs["position"] = position;
    }

    let ids: string[];
    try {
      const responses = await pacedRequest(client, [["Email/query", queryArgs, "c0"]], ctx);
      const queryRes = responses[0];
      const queryArgsOut = queryRes?.[1] as { ids?: string[] } | undefined;
      ids = queryArgsOut?.ids ?? [];
    } catch (err) {
      // The anchor message was deleted mid-walk. Fall back to positional
      // paging for this page -- `position` reflects everything walked so
      // far, INCLUDING across a resumed walk now that it is restored from
      // sync_state alongside the anchor (finding 6) -- so this resumes
      // rather than restarting at 0, and the walk continues rather than
      // ending.
      if (anchor !== null && String(err).includes("anchorNotFound")) {
        anchor = null;
        continue;
      }
      throw err;
    }

    if (ids.length === 0) break;

    const getResponses = await pacedRequest(
      client,
      [["Email/get", { accountId, ids, properties: METADATA_PROPS }, "c0"]],
      ctx,
    );
    const getRes = getResponses[0];
    const getArgs = getRes?.[1] as { list?: JmapEmail[]; state?: string } | undefined;
    const list = getArgs?.list ?? [];

    // Capture the Email/changes cursor BEFORE any more of the walk runs, or
    // changes occurring during a multi-hour backfill are never seen. Taken
    // from the first response that carries a state, not necessarily the very
    // first Email/get call -- deliberate: if that first response happened to
    // omit `state`, waiting for the next one is still "before the walk gets
    // far" and is safer than recording no cursor at all.
    if (getArgs?.state && getSyncState(db, account, "email") === null) {
      setSyncState(db, account, "email", getArgs.state);
    }

    storeEmails(db, account, list);
    fetched += list.length;
    opts.onProgress?.(fetched);

    const last = ids[ids.length - 1]!;
    // A page identical to the last one means the server made no progress
    // (anchor ignored, or repeated for some other reason). THROW, do not
    // break: a break falls through to the 'done' sentinel below, which would
    // falsely record an incomplete archive as finished -- turning a loud
    // failure into a silent gap in someone's mail. Throwing leaves the
    // stored anchor exactly where it was, so a retry resumes from here.
    if (last === previousLast) {
      throw new Error(
        `archive walk made no progress for ${account}: the server repeated the page ending at ${last}`,
      );
    }
    previousLast = last;
    position += ids.length;
    // Store the anchor AND the position it corresponds to (finding 6) -- see
    // the resumability doc comment above walkArchive for why the id alone
    // is not enough.
    setSyncState(db, account, "walk", `${last}|${position}`);
    anchor = last;

    // Deliberately NOT `if (ids.length < pageSize) break;`. A short page is
    // not a sound end-of-list signal in JMAP -- a server may clamp `limit`
    // to its own maximum, and if that ever happened on page 1 the account
    // would be recorded fully walked (a one-way door, see below) after a
    // single page. `ids.length === 0` above is the only terminator. Costs
    // one extra request per account.
  }

  setSyncState(db, account, "walk", "done");
  return { fetched, complete: true };
}

export const MAX_BODY_BYTES = 1_000_000;
/**
 * Ceiling on the body-fetch batch size, independent of what the server
 * advertises. `maxObjectsInGet` is a session-wide cap the server sets for
 * ANY Email/get, not a recommendation tuned for full message bodies -- a
 * batch of, say, 4096 message bodies (Fastmail's live value) is a very
 * large single response. Finding 5's fix (deriving the default from the
 * session) is still bound by this so a generous server can't turn one
 * request into an unreasonable one.
 */
export const MAX_BODY_BATCH = 500;

/**
 * Reduce a message to the plaintext rendition FTS5 indexes.
 *
 * Every regex here is linear. `\s+` before a literal, or `[^>]*` on both sides
 * of one, is the shape that turned a 75,645-character whitespace run into 2.4
 * seconds of server time for a single message (spec 6.11).
 */
export function extractPlainText(input: { textBody?: string; htmlBody?: string }): string {
  const raw =
    input.textBody && input.textBody !== ""
      ? input.textBody
      : htmlToText(input.htmlBody ?? "");
  return raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES) : raw;
}

/**
 * A single forward scan. Deliberately NOT a regex for script/style stripping:
 * message HTML is attacker-controlled, and the previous implementation --
 * `<(script|style)\\b[\\s\\S]*?<\\/\\1>` -- was quadratic in the number of
 * unterminated <script tags (measured: ~600-650ms for one 335KB message; see
 * task-11-report.md "Fix round 1"). Every index here (`i`) only advances, and
 * nothing is rescanned, so this is O(n) in the length of the input.
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase(); // computed ONCE -- inside the loop this
                                     // would reintroduce the quadratic cost
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break; // unterminated tag: drop the remainder

    const raw = lower.slice(lt + 1, gt);
    const isClosing = raw.startsWith("/");
    const isSelfClosing = raw.endsWith("/"); // <script/> opens nothing
    const name = isClosing ? raw.slice(1).trim() : raw.trim();
    const tag = name.split(/[\s/]/, 1)[0] ?? "";

    // Only a genuine OPENING script/style begins skippable content. A stray
    // closing tag (Fix round 2) or a self-closing <script/>/<style/> (Fix
    // round 3) must fall through and become a space like any other tag --
    // treating either as the start of an element silently swallows the text
    // that follows it. <script/> in particular has no </script> anywhere in
    // the message, so without this guard the scan runs off the end looking
    // for one and drops the ENTIRE rest of the message via the close === -1
    // branch below.
    if (!isClosing && !isSelfClosing && (tag === "script" || tag === "style")) {
      const close = lower.indexOf(`</${tag}`, gt + 1);
      // A genuinely UNTERMINATED <script>/<style> (no closing tag anywhere)
      // drops the remainder. This is a DELIBERATE choice, not an oversight:
      // the only alternative is emitting unclosed script/style content into
      // the search index, and of "loses trailing text" vs. "indexes script
      // bodies", losing text is the better failure. Do not "fix" this by
      // falling through -- see the "<script>evil" test in backfill.test.ts,
      // which exists specifically to pin this down.
      if (close === -1) break;
      const closeEnd = html.indexOf(">", close);
      i = closeEnd === -1 ? html.length : closeEnd + 1;
    } else {
      out += " ";
      i = gt + 1;
    }
  }

  return decodeEntities(out).replace(/[ \t\r\n]+/g, " ").trim();
}

/**
 * Entity decoding for the plaintext rendition of an HTML part.
 *
 * 🚨 The four-entity version this replaced left every OTHER reference in
 * `body_text` verbatim, and `body_text` is what the reading pane shows and
 * what the FTS index is built from. Measured on the live archive (audit
 * pass 4): **1,119 messages carried a literal `&#nn;`**, 427 carried
 * `&zwnj;` (marketing mail pads its preheader with hundreds of them), 272
 * carried smart quotes, 271 `&quot;`, 267 dashes. A body storing
 * `don&#39;t` tokenizes as `don`/`39`/`t`, so the phrase a person actually
 * searches for cannot match it.
 *
 * 🚨 `&amp;` is decoded LAST, not first. Decoding it first makes the pass
 * double-decode: `&amp;lt;` becomes `&lt;` and then `<`, so a message that
 * literally wrote out an escaped tag — mail about HTML, which this codebase
 * receives — silently gains markup it never contained.
 *
 * Numeric references are done with a single bounded pass. `{1,7}` caps the
 * digits so a runaway `&#000...` cannot make the regex do super-linear work
 * (spec 6.11's linear rule), and anything outside the Unicode range or in
 * the surrogate block is left exactly as written rather than turned into a
 * replacement character: an undecodable reference is data, not damage.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (whole, hex: string) => fromCodePoint(parseInt(hex, 16), whole))
    .replace(/&#([0-9]{1,7});/g, (whole, dec: string) => fromCodePoint(parseInt(dec, 10), whole))
    .replace(/&(nbsp|zwnj|zwj|shy|ensp|emsp|thinsp);/g, (_w, name: string) => (name === "nbsp" ? " " : ""))
    .replace(/&(lt|gt|quot|apos|rsquo|lsquo|ldquo|rdquo|mdash|ndash|hellip|middot|bull|trade|copy|reg|deg|euro|pound|yen|times|divide|laquo|raquo|sbquo|bdquo|dagger|permil|larr|rarr|harr|minus|frac12|frac14|frac34|sup2|sup3|micro|para|sect|plusmn|not|iexcl|iquest|cent|curren|brvbar|uml|ordf|ordm|acute|cedil|szlig|agrave|aacute|eacute|egrave|iacute|oacute|uacute|ntilde|ccedil|uuml|ouml|auml);/gi, (whole, name: string) => NAMED[name.toLowerCase()] ?? whole)
    // Last. See the comment above.
    .replace(/&amp;/g, "&");
}

/**
 * A code point that is not a legal scalar value is left as written.
 *
 * 🚨 Tab, LF and CR are ALLOWED through even though they are C0 controls.
 * They are the three whitespace characters HTML actually writes as numeric
 * references, and rejecting the whole `< 0x20` range left literal `&#10;`
 * in the text -- 1,023 occurrences of `&#10;`, 921 of `&#9;` and 107 of
 * `&#13;` were still in the archive after the first decoder pass (found in
 * audit pass 4 by measuring the residual instead of assuming it was all
 * sender-authored plaintext). Every other control stays rejected: they are
 * invisible, they cannot help a reader, and they would go into the FTS
 * index. htmlToText collapses whitespace immediately afterwards, so a
 * decoded newline becomes a space rather than a line break.
 */
function fromCodePoint(code: number, whole: string): string {
  if (!Number.isFinite(code) || code > 0x10ffff) return whole;
  if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code < 0x20) return whole;
  if (code >= 0xd800 && code <= 0xdfff) return whole;
  return String.fromCodePoint(code);
}

/** The named references that actually turn up in mail. Not the full HTML5
 *  table (2,231 entries): this runs over every message body in the archive,
 *  and the long tail is reached by the numeric passes above anyway. */
const NAMED: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  middot: "\u00b7",
  bull: "\u2022",
  trade: "\u2122",
  copy: "\u00a9",
  reg: "\u00ae",
  deg: "\u00b0",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  times: "\u00d7",
  divide: "\u00f7",
  laquo: "\u00ab",
  raquo: "\u00bb",
  sbquo: "\u201a",
  bdquo: "\u201e",
  dagger: "\u2020",
  permil: "\u2030",
  larr: "\u2190",
  rarr: "\u2192",
  harr: "\u2194",
  minus: "\u2212",
  frac12: "\u00bd",
  frac14: "\u00bc",
  frac34: "\u00be",
  sup2: "\u00b2",
  sup3: "\u00b3",
  micro: "\u00b5",
  para: "\u00b6",
  sect: "\u00a7",
  plusmn: "\u00b1",
  not: "\u00ac",
  iexcl: "\u00a1",
  iquest: "\u00bf",
  cent: "\u00a2",
  curren: "\u00a4",
  brvbar: "\u00a6",
  uml: "\u00a8",
  ordf: "\u00aa",
  ordm: "\u00ba",
  acute: "\u00b4",
  cedil: "\u00b8",
  szlig: "\u00df",
  agrave: "\u00e0",
  aacute: "\u00e1",
  eacute: "\u00e9",
  egrave: "\u00e8",
  iacute: "\u00ed",
  oacute: "\u00f3",
  uacute: "\u00fa",
  ntilde: "\u00f1",
  ccedil: "\u00e7",
  uuml: "\u00fc",
  ouml: "\u00f6",
  auml: "\u00e4",
};

/**
 * Fetch bodies for messages whose body_text is still NULL.
 *
 * Two rules keep this terminating and robust: a message-specific fault gets
 * '' written -- otherwise a permanently unfetchable message is retried
 * forever -- and a failed batch is retried item by item so one poisonous
 * message cannot stall an account.
 *
 * The '' write is deliberately NOT unconditional. An error that is about the
 * REQUEST rather than the message -- auth, network, rate-limited-past-the-cap,
 * server -- affects every following item identically, because it says nothing
 * about that message's content. Poisoning on one of those blanks the rest of
 * the batch (and, one batch at a time, the rest of the account) with '',
 * which unfetchedIds() then treats as "fetched, nothing there" forever --
 * there is no retry path back from that. Proven live: a mid-walk auth failure
 * wrote '' to 120 rows with 0 left NULL. classify(err).kind !== "unknown" is
 * the test for "about the request, not the message"; only "unknown" -- a
 * fault classify cannot pin on the transport or the server -- earns the
 * poison pill. Anything else is rethrown, so the whole account's remaining
 * rows stay NULL and are retried on the next pass rather than lost.
 *
 * A THIRD rule, added in Fix round 1 after the first two were proven not to be
 * enough: if a full pass over a batch leaves the exact same SET of rows
 * unfetched -- not merely the same count and leading id, which ties on
 * received_at can slip past (finding 7) -- that means the write path itself
 * is broken (a regression, not a poisonous message; poisonous messages get ''
 * and so disappear from unfetchedIds()). THROW rather than break, mirroring
 * walkArchive's `previousLast` guard and for the same reason: a silent break
 * makes an incomplete backfill look finished, and search would then be
 * quietly missing bodies. Proven necessary by measurement: reverting to a
 * bare `if (!fetchedAny) break` here and breaking the write path causes this
 * function to hang forever rather than fail (task-11-report.md).
 */
/**
 * "Is this fault about the REQUEST rather than this message?"
 *
 * classify() alone was not enough (I1). Two shapes it collapses to "unknown"
 * are unambiguously request-level:
 *  - pacedRequest's give-up throw -- now an HttpStatusError(429), so classify
 *    handles it, but the case is what motivated this helper;
 *  - every JMAP method error, which client.ts surfaces as
 *    Error("JMAP method error: <type>"): serverFail, rateLimit,
 *    requestTooLarge, invalidArguments. None of them say anything about the
 *    message's content, and blanking a batch on one of them is unrecoverable
 *    because '' is never selected again.
 *
 * Deliberately NARROWING what earns the poison pill, never widening it: a
 * body_text of '' means "fetched, nothing there" and is never retried, so the
 * cost of a false negative here is a row retried next pass, and the cost of a
 * false positive is mail permanently missing from search.
 */
function isRequestLevel(err: unknown): boolean {
  if (classify(err).kind !== "unknown") return true;
  return err instanceof Error && err.message.startsWith("JMAP method error:");
}

export async function backfillBodies(
  db: DatabaseSync,
  client: JmapClient,
  account: string,
  opts: {
    batchSize?: number;
    onProgress?: (written: number) => void;
    paceMs?: number;
    sleep?: Sleep;
    signal?: AbortSignal;
  } = {},
): Promise<{ written: number; failed: number }> {
  // Finding 5 (spec 5.6): page sizes must come from the session's
  // maxObjectsInGet, not a hardcoded constant -- the spec's whole point is
  // being polite to the server we ask this of. Live cost of the old
  // hardcoded 50: ~440 requests for 21,974 messages where maxObjectsInGet
  // (4096, live) would have done it in ~44. Still clamped to
  // MAX_BODY_BATCH: a message BODY batch is a much larger response than an
  // arbitrary Email/get, so the session's cap is not, by itself, a sane
  // batch size for this call. `opts.batchSize` remains an explicit override
  // for tests.
  const batchSize = opts.batchSize ?? Math.min(client.session.maxObjectsInGet, MAX_BODY_BATCH);
  const accountId = client.session.mailAccountId;
  const ctx = paceContext(opts);
  let written = 0;
  let failed = 0;

  for (;;) {
    // Checked at the top of every batch, not just between calls to this
    // function: a paced backfill (retries, rate-limit waits) can otherwise
    // run for tens of seconds after shutdown was requested, well past
    // Docker's 10s grace window. Returning the counts so far is correct --
    // nothing written is lost, and the rows still NULL are picked up by the
    // next pass.
    if (opts.signal?.aborted) break;

    const before = unfetchedIds(db, account, batchSize);
    if (before.length === 0) break;

    try {
      written += await fetchInto(db, client, accountId, account, before, ctx);
    } catch {
      // Retry item by item so one bad message does not stop the account.
      for (const id of before) {
        try {
          written += await fetchInto(db, client, accountId, account, [id], ctx);
        } catch (err) {
          // Only a message-specific fault earns the poison pill. auth/network/
          // rate-limited/server errors will hit every following item identically;
          // blanking the archive on one of those destroys the body index with no
          // retry path, because '' is never selected again.
          if (isRequestLevel(err)) throw err;
          writeBodyText(db, account, id, "");
          failed += 1;
        }
      }
    }

    opts.onProgress?.(written);

    const after = unfetchedIds(db, account, batchSize);
    // Compare the full SET of ids, not just after[0] === before[0] (finding
    // 7). Two rows tying on received_at (unfetchedIds' own ORDER BY) have no
    // guaranteed relative order, so a same-size batch that happens to start
    // with a different id -- while still being the exact same rows -- could
    // slip past a first-id-only check. This is the same guard that failed to
    // catch finding 1 in review.
    const beforeIds = new Set(before);
    const madeNoProgress = after.length === before.length && after.every((id) => beforeIds.has(id));
    if (madeNoProgress) {
      throw new Error(
        `body backfill made no progress for ${account}: ${after.length} rows still unfetched after a full pass`,
      );
    }
  }

  return { written, failed };
}

async function fetchInto(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  account: string,
  ids: string[],
  ctx: PaceContext,
): Promise<number> {
  const [res] = await pacedRequest(
    client,
    [
      [
        "Email/get",
        {
          accountId,
          ids,
          properties: ["id", "textBody", "htmlBody", "bodyValues"],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: MAX_BODY_BYTES,
        },
        "c0",
      ],
    ],
    ctx,
  );

  const list = ((res?.[1] as { list?: any[] }).list ?? []) as any[];
  const byId = new Map(list.map((m) => [m.id as string, m]));

  let n = 0;
  for (const id of ids) {
    const m = byId.get(id);
    const text = m ? extractPlainText(collectBody(m)) : "";
    writeBodyText(db, account, id, text);
    n += 1;
  }
  return n;
}

/**
 * Splits a message's fetched body values into "plaintext we were given" and
 * "HTML we must render down", BY PART TYPE.
 *
 * 🚨 JMAP's `textBody` is NOT "the text/plain parts". It is the list of
 * parts *a client should display as the body*, and for an HTML-only message
 * the server puts the **text/html** part in it. Reading `textBody` as
 * plaintext therefore stores raw markup: 5,736 messages -- about 15% of the
 * live archive -- had `<!DOCTYPE html>` and stylesheet text sitting in
 * `emails.body_text`, so CSS property names were in the FTS5 index, in
 * every preview, and in the reading pane's plaintext fallback. Found by
 * screenshot on 2026-09-04, not by any test: `htmlToText` is correct and
 * well covered, it was simply never reached on this path.
 *
 * So classify on `type`, never on which list a part arrived in. A part
 * declaring text/html goes to the HTML side wherever it was listed.
 *
 * A part with no `type` is treated as plaintext, which is both the old
 * behaviour and the safe direction: JMAP requires `type` on an
 * EmailBodyPart, so this only fires for a non-conforming server, and
 * mis-filing genuine plaintext as HTML would strip real `<` characters out
 * of a message that meant them literally.
 */
export function collectBody(m: any): { textBody?: string; htmlBody?: string } {
  const values = (m.bodyValues ?? {}) as Record<string, { value?: string }>;

  const plain: string[] = [];
  const html: string[] = [];

  const sort = (parts: { partId?: string; type?: string }[] | undefined): void => {
    for (const part of parts ?? []) {
      if (!part.partId) continue;
      const value = values[part.partId]?.value ?? "";
      if (value === "") continue;
      const type = (part.type ?? "text/plain").toLowerCase().split(";")[0]!.trim();
      (type === "text/html" || looksLikeHtmlDocument(value) ? html : plain).push(value);
    }
  };

  // `textBody` first so a multipart/alternative message's plaintext part
  // stays the preferred rendition, exactly as before.
  sort(m.textBody);
  sort(m.htmlBody);

  // The same part can legitimately appear in BOTH lists (an HTML-only
  // message is the common case), so de-duplicate rather than concatenating
  // the message to itself.
  return { textBody: join(plain), htmlBody: join(html) };
}

/**
 * A last-resort content sniff for senders that declare `text/plain` and put
 * a WHOLE HTML DOCUMENT in it. Measured on the live archive after the
 * type-classification fix: 167 messages of 37,725 (0.44%), all from billing
 * systems that also send a correct text/html part alongside. Confirmed
 * against the server rather than guessed -- `Email/get` reports
 * `textBody: [{partId: "1", type: "text/plain"}]` for a part whose value
 * begins `<!DOCTYPE HTML PUBLIC ...`.
 *
 * 🚨 Deliberately narrow: only a value that BEGINS with a doctype or an
 * `<html` root counts. A message that merely CONTAINS `<div>` is left
 * alone, because that is what a person quoting markup looks like, and
 * stripping tags out of a developer's mail would lose the very content they
 * would search for. A whole document at offset zero is not a quote.
 */
function looksLikeHtmlDocument(value: string): boolean {
  const head = value.slice(0, 100).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return true;

  // Not every such body starts with a doctype: a Gmail-composed message
  // arrives as `<div>Good evening, <br><br>...`, and some lead with a line
  // of prose before the markup begins. So fall back to TAG DENSITY, with
  // the threshold measured against the live archive rather than guessed --
  // element openings per message, over the 37,725 stored bodies:
  //
  //     1 tag      362      2-3     182      4-10    213
  //     11-30      139      31-100   63      100+     22
  //
  // Inspection at the boundary is what sets the number. The 11-30 band is
  // legitimate plaintext throughout -- markdown newsletters, transcript
  // notifications, `<name@host>` addresses and stray `<br>`s. The 31+ band
  // is HTML bodies without exception. 30 is where those two populations
  // actually separate, not a round number picked in advance.
  return countTags(value) > HTML_TAG_THRESHOLD;
}

/** See looksLikeHtmlDocument for how this number was arrived at. */
const HTML_TAG_THRESHOLD = 30;

/** Element openings. Linear, and bounded per match (spec 6.11): no
 *  quantifier here can backtrack over a long whitespace run. */
function countTags(value: string): number {
  const matches = value.match(/<[a-zA-Z][a-zA-Z0-9]{0,14}[\s>/]/g);
  return matches === null ? 0 : matches.length;
}

function join(values: string[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    kept.push(v);
  }
  return kept.join("\n").trim();
}
