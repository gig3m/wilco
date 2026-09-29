/**
 * Parse a search box's contents into structured operators plus whatever
 * plain text remains for FTS5.
 *
 * Rules (spec §4.4):
 *   1. Operators are parsed OUT before the FTS5 string is built. They become
 *      SQL predicates on the `emails` row, never FTS tokens -- otherwise
 *      `from:robin` would search body text for the literal string
 *      "from:robin".
 *   2. An unrecognised `word:` is a search term, not an error. Mail
 *      genuinely contains `http:` and `re:`.
 *   3. The quoting rule still applies to whatever text is left: `ftsQuery`
 *      (in src/core/queries.ts) quotes every leftover term and gives the
 *      last one a trailing prefix match. This module does not call or
 *      reimplement that function -- something downstream wires the two
 *      together.
 *
 * This file is pure: no database, no I/O, no imports beyond types.
 */

export interface ParsedQuery {
  text: string; // what remains for FTS5, unparsed
  from: string[]; // from: -- matched against from_email/from_name
  to: string[]; // to: -- matched against email_recipients (kind IN ('to', 'cc'))
  cc: string[]; // cc: -- matched against email_recipients (kind = 'cc' only)
  in: string[]; // in: -- mailbox name or role
  acct: string[]; // acct: -- account key
  isUnread: boolean | null; // is:unread / is:read
  isFlagged: boolean | null; // is:flagged
  hasAttachment: boolean | null; // has:attachment
  before: string | null; // ISO date (exclusive upper bound)
  after: string | null; // ISO date (inclusive lower bound)
}

const KNOWN_OPERATORS = new Set([
  "from",
  "to",
  "cc",
  "in",
  "acct",
  "is",
  "has",
  "before",
  "after",
  "newer_than",
]);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NEWER_THAN_RE = /^(\d+)d$/;

function parseStrictDateToUtcMidnightIso(value: string): string | null {
  const m = DATE_RE.exec(value);
  if (m === null) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject overflowed dates (e.g. 2026-02-30) rather than silently rolling
  // them into March.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

/**
 * Turn `input` into a stream of raw `key:value` / bare-word tokens by a
 * single left-to-right scan. Written as a hand-rolled scanner rather than a
 * regex so it cannot backtrack pathologically on adversarial input
 * (spec §6.11 -- regexes over message-shaped data must be linear).
 */
interface RawToken {
  raw: string; // the token exactly as it appeared in the input, for fallback
  operatorPrefix: string | null; // text before ':' when a ':' was present, lowercased
  value: string | null; // text after ':' (unquoted if quoted), only when operatorPrefix is set
}

function scanTokens(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  const len = input.length;
  let i = 0;
  while (i < len) {
    // Skip whitespace.
    while (i < len && /\s/.test(input[i]!)) i++;
    if (i >= len) break;

    const start = i;
    // Scan the "word" part up to the first whitespace or ':'.
    while (i < len && input[i] !== ":" && !/\s/.test(input[i]!)) i++;

    if (i < len && input[i] === ":") {
      const prefix = input.slice(start, i);
      i++; // consume ':'
      let value: string;
      if (i < len && input[i] === '"') {
        // Quoted value: consume to the closing quote, or to end of input if
        // unterminated.
        const quoteStart = i + 1;
        let j = quoteStart;
        while (j < len && input[j] !== '"') j++;
        value = input.slice(quoteStart, j);
        i = j < len ? j + 1 : j; // consume closing quote if present
      } else {
        const valueStart = i;
        while (i < len && !/\s/.test(input[i]!)) i++;
        value = input.slice(valueStart, i);
      }
      const raw = input.slice(start, i);
      tokens.push({ raw, operatorPrefix: prefix.toLowerCase(), value });
    } else {
      const raw = input.slice(start, i);
      tokens.push({ raw, operatorPrefix: null, value: null });
    }
  }
  return tokens;
}

export function parseQuery(input: string, now?: () => Date): ParsedQuery {
  const result: ParsedQuery = {
    text: "",
    from: [],
    to: [],
    cc: [],
    in: [],
    acct: [],
    isUnread: null,
    isFlagged: null,
    hasAttachment: null,
    before: null,
    after: null,
  };

  const textParts: string[] = [];
  const tokens = scanTokens(input);

  for (const token of tokens) {
    if (token.operatorPrefix === null || !KNOWN_OPERATORS.has(token.operatorPrefix)) {
      textParts.push(token.raw);
      continue;
    }

    const op = token.operatorPrefix;
    const value = token.value ?? "";

    if (value === "") {
      // An operator with an empty value is a term, not an operator.
      textParts.push(token.raw);
      continue;
    }

    // Free-text values keep their case only where case could matter -- it
    // does not, for any operator in this set (addresses/mailbox names/
    // account keys/dates all compare case-insensitively downstream), so
    // every operator value is lowercased here.
    const lower = value.toLowerCase();

    switch (op) {
      case "from":
        result.from.push(lower);
        break;
      case "to":
        result.to.push(lower);
        break;
      case "cc":
        result.cc.push(lower);
        break;
      case "in":
        result.in.push(lower);
        break;
      case "acct":
        result.acct.push(lower);
        break;
      case "is": {
        if (lower === "unread") {
          result.isUnread = true;
        } else if (lower === "read") {
          result.isUnread = false;
        } else if (lower === "flagged") {
          result.isFlagged = true;
        } else {
          textParts.push(token.raw);
        }
        break;
      }
      case "has": {
        if (lower === "attachment") {
          result.hasAttachment = true;
        } else {
          textParts.push(token.raw);
        }
        break;
      }
      case "before": {
        const iso = parseStrictDateToUtcMidnightIso(lower);
        if (iso === null) {
          textParts.push(token.raw);
        } else {
          result.before = iso;
        }
        break;
      }
      case "after": {
        const iso = parseStrictDateToUtcMidnightIso(lower);
        if (iso === null) {
          textParts.push(token.raw);
        } else {
          result.after = iso;
        }
        break;
      }
      case "newer_than": {
        const m = NEWER_THAN_RE.exec(lower);
        if (m === null) {
          textParts.push(token.raw);
        } else {
          const days = Number(m[1]);
          const base = now !== undefined ? now() : new Date();
          const ms = base.getTime() - days * 24 * 60 * 60 * 1000;
          result.after = new Date(ms).toISOString();
        }
        break;
      }
      default:
        textParts.push(token.raw);
    }
  }

  result.text = textParts.join(" ");
  return result;
}
