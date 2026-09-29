// A shared relative-time formatter (design-fidelity plan, task 4b), so
// MessageList and Reading render the same output for the same timestamp
// instead of forking the logic per component -- the fidelity reviews
// flagged that drift risk explicitly.
//
// Transcribed from docs/design/Wilco.dc.html's mock data, NOT from a
// computed rule in that file -- there isn't one. Every `time:` value in
// the design (both the row-level field and each thread message's own
// `time:`) is a hand-authored string, not the output of a function; the
// closest thing to logic is `groupOf`/`dayOf` (Wilco.dc.html ~line 1051,
// 1506), which only classifies an already-authored string into "Today" vs
// "Earlier" for grouping, and says nothing about how a real timestamp
// becomes one of those strings in the first place.
//
// What IS evidenced, by grepping every literal `time: '...'` value in the
// file, is two different presentations at two different call sites:
//
//   - Row level (MessageList): 'now', a bare 'H:MM' (today, hour never
//     zero-padded -- '9:41', '8:55', '7:32'), or a bare weekday
//     abbreviation ('Mon', 'Sun', 'Sat', 'Fri') for anything from
//     yesterday through six days ago. There is NO 'Yesterday' row-level
//     value anywhere in the mock -- yesterday's rows use the weekday
//     abbreviation, same as any other day this week.
//   - Detail level (Reading, a thread message's own `time:`): 'Just now',
//     'Today H:MM', or 'Yesterday H:MM'. No mock message is ever more than
//     one day old at this level, so a "this week, not today/yesterday"
//     detail string is NOT evidenced -- see the `formatDetailTime` doc
//     comment below for how this implementation extrapolated one anyway,
//     and the task-4b report for the flag asking whether that guess is
//     right.
//
// Two things the design never shows at all, at either level:
//   1. The numeric threshold for "now"/"Just now" itself -- there is no
//      computed rule, only a hand-picked label per mock row. This
//      implementation uses 60 seconds; flagged in the report.
//   2. Anything older than about a week. No mock message is ever that
//      old. This implementation falls back to a plain "Mon D" / "Mon D,
//      YYYY" date; flagged in the report.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const JUST_NOW_THRESHOLD_MS = 60_000;
const MS_PER_DAY = 86_400_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 'H:MM' -- hour never zero-padded, minute always two digits. Matches the
 *  design's own row-level values ('9:41', '8:55') and the task brief's
 *  cited example ('Yesterday 18:02'). */
function clockTime(d: Date): string {
  return `${d.getHours()}:${pad2(d.getMinutes())}`;
}

function olderFallback(d: Date, now: Date): string {
  const month = MONTHS[d.getMonth()]!;
  return d.getFullYear() === now.getFullYear() ? `${month} ${d.getDate()}` : `${month} ${d.getDate()}, ${d.getFullYear()}`;
}

type Bucket = "now" | "today" | "yesterday" | "week" | "older";

function classify(d: Date, now: Date): Bucket {
  const diffMs = now.getTime() - d.getTime();
  if (diffMs >= 0 && diffMs < JUST_NOW_THRESHOLD_MS) return "now";

  const dayDiff = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / MS_PER_DAY);
  if (dayDiff === 0) return "today";
  if (dayDiff === 1) return "yesterday";
  if (dayDiff > 1 && dayDiff < 7) return "week";
  return "older";
}

/** MessageList's row time column. `now` is an injected parameter (never
 *  `Date.now()`/`new Date()` read internally) so a test can assert every
 *  boundary without being clock-dependent. `iso` may be missing/invalid
 *  (a row the server hasn't stamped yet, or a malformed fixture) -- both
 *  render as `""`, matching the component's prior `formatTime`. */
export function formatRowTime(iso: string | null | undefined, now: Date): string {
  if (iso === null || iso === undefined) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  switch (classify(d, now)) {
    case "now":
      return "now";
    case "today":
      return clockTime(d);
    // Yesterday shares the plain-weekday row presentation -- there is no
    // 'Yesterday' row-level value anywhere in the design's mock data (see
    // the module doc comment).
    case "yesterday":
    case "week":
      return WEEKDAYS[d.getDay()]!;
    case "older":
      return olderFallback(d, now);
  }
}

/** Reading's message-card / collapsed-thread-row time. Same `now`
 *  contract as `formatRowTime`. The "week" case ('Mon 14:30'-shaped) is
 *  this implementation's own extrapolation from the 'Today H:MM' /
 *  'Yesterday H:MM' pattern the design DOES show -- no mock thread
 *  message is ever more than a day old, so this specific string is not
 *  directly evidenced. Flagged in the task-4b report. */
export function formatDetailTime(iso: string | null | undefined, now: Date): string {
  if (iso === null || iso === undefined) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  switch (classify(d, now)) {
    case "now":
      return "Just now";
    case "today":
      return `Today ${clockTime(d)}`;
    case "yesterday":
      return `Yesterday ${clockTime(d)}`;
    case "week":
      return `${WEEKDAYS[d.getDay()]} ${clockTime(d)}`;
    case "older":
      return olderFallback(d, now);
  }
}

/** `M/D` -- numeric, no leading zeros, no year. The rows-layout time
 *  cell's only fix for design-fidelity finding F1 (2026-09-04): the
 *  design's literal `width: 38px` is correct for *its* mock times ('now',
 *  '9:41', 'Mon'), and F1's ruling is to keep that width and shorten what
 *  gets rendered into it, not to widen the cell. `formatRowTime`'s
 *  "older" fallback ('Aug 10' / 'Aug 10, 2025') was measured (headless
 *  Chrome canvas `measureText`, real self-hosted "IBM Plex Mono" at the
 *  cell's actual 400 10.5px) at 42px / 84px -- both overflow 38px, which
 *  is why real (non-mock) dates wrapped the cell to two lines. Every
 *  `M/D` combination from '1/1' to '12/31' measured 21-35px, so this
 *  fits with room to spare in every case, including the prior-year case
 *  the design never shows. It drops the year -- the design never shows a
 *  year at row level either (nothing in its mock is ever that old), so
 *  this is consistent with, not a regression from, what the design
 *  actually specifies. `formatRowTime` itself is UNCHANGED: the columns
 *  layout's time span is auto-width (`flex:none`, no fixed width) and
 *  already matches the design with the full 'Aug 10, 2025' fallback. */
export function formatRowsLayoutTime(iso: string | null | undefined, now: Date): string {
  if (iso === null || iso === undefined) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  switch (classify(d, now)) {
    case "now":
      return "now";
    case "today":
      return clockTime(d);
    case "yesterday":
    case "week":
      return WEEKDAYS[d.getDay()]!;
    case "older":
      return `${d.getMonth() + 1}/${d.getDate()}`;
  }
}
