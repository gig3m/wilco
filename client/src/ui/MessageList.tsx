// The message list (Task 7, brought to design fidelity in the design-
// fidelity plan's Task 3) -- the pane the whole product is about. Per
// docs/design/Wilco.dc.html's list-pane markup (the design's own inline
// `style=` attributes are the literal spec, transcribed here, not
// interpreted -- see docs/design/RENDERING.md): header (view title + mono
// count, replaced by a bulk action bar once any row is checked), an amber
// reauthorize banner, a grey IMAP "support coming" banner, THREE-LINE rows
// (checkbox; sender/code/time; subject; snippet+flags) with a 3px
// account-color left edge, Today/Earlier group headers, and pagination
// capped at 12 with +25 per click, resetting on folder switch.
//
// 🚨 The defect this task fixes: a prior pass crammed sender, code, time,
// subject and snippet onto ONE line, which starved the subject to ~12
// characters while ~800px of reading pane sat empty beside it (verified on
// the deployed client). The design's row (docs/design/Wilco.dc.html
// `t.tall`, lines ~336-354) is three lines:
//   1. checkbox, sender (700 weight when unread), account code (mono,
//      account-coloured, NOT a badge/chip -- the design carries no
//      background on it), time (mono), right-aligned.
//   2. subject alone, bold when unread, on its own line.
//   3. snippet in --muted, plus star/attachment/unread-dot flags.
// The design's OTHER row shape (`t.wide`, a single line) is used only
// when the mail pane stacks list-above-reading (`layoutDir: 'row'` is
// FALSE, i.e. `rows` layout -- see Wilco.dc.html's `layoutDir`/`listW`).
// Per an explicit owner ruling, phone/narrow layout in this app matches
// desktop exactly (the prototype has no phone treatment of its own), so
// only the three-line row is implemented here.
//
// Deliberately NOT virtualized (spec 7.3): dovetail rendered a 200-row
// page with plain DOM nodes and no virtualization, and the corpus (37k+
// messages) is never what gets rendered -- only a capped, paginated slice
// of whatever the caller already fetched. This component does no
// fetching of its own; `rows` is the full list the caller loaded (already
// filtered to a mailbox/search), and pagination here only controls how
// much of that array is *rendered*, not another round-trip to the server.
//
// Two distinct notions of "selected" exist on a row, and they must not be
// conflated:
//   - Opening a message (clicking the row) -- keyed (account, id), exactly
//     like store.ts's `Selection`, because ids collide across accounts
//     (spec 4.2). `onOpen` reports this; `opened` lets a caller (App, via
//     the store/route) control which row shows `aria-selected`.
//   - Checking a row's checkbox -- an independent multi-select used only
//     to drive the bulk action bar. Purely local state: this task ships
//     no bulk actions themselves (mark read/archive/delete), only the bar
//     that would host them, per the brief's scope.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { Paperclip, Star, TriangleAlert, X } from "lucide-preact";
import { accentForTheme, toCssColor } from "../lib/color";
import { text } from "../lib/escape";
import { Snippet } from "./Snippet";
import { SelectBox } from "./SelectBox";
import { formatRowsLayoutTime, formatRowTime } from "../lib/time";

export interface MessageListRow {
  account: string;
  id: string;
  subject: string;
  fromName?: string;
  /** The address, shown where the name goes when there is no name. */
  fromEmail?: string;
  preview?: string;
  snippet?: string | null;
  /** Messages in the conversation. The badge shows only when >1. */
  threadCount?: number;
  receivedAt?: string;
  isUnread?: boolean;
  isFlagged?: boolean;
  hasAttachment?: boolean;
  via?: string | null;
  threadId?: string | null;
}

export interface MessageListSelection {
  account: string;
  id: string;
}

/** A single account needing reauthorization, per Wilco.dc.html's
 *  `bannerError`/`bannerErrorText` -- the amber banner with a warning
 *  glyph and a filled "Reauthorize" button. `account` is the key `onReauthorize`
 *  is called with; `message` is the exact, already-composed banner text
 *  (the caller owns whether it names one account or several -- see the
 *  design's own `S.scope === 'all'` branch, which this component has no
 *  opinion on). */
export interface MessageListReauth {
  account: string;
  message: string;
}

export interface MessageListProps {
  /** `undefined` means "not fetched yet" and renders a loading state --
   *  distinct from `[]`, which means "fetched, and this folder is empty"
   *  and renders the empty state. Measured live: for 3.5s on a
   *  167k-message instance the list rendered "Inbox zero / Enjoy it while
   *  it lasts" before 120 real rows arrived, because an empty array was
   *  the only way to say "nothing yet" -- there was no way to say it
   *  without also claiming the folder was empty. */
  rows: MessageListRow[] | undefined;
  /** The mailbox currently being viewed, as DISPLAY TEXT: the header's
   *  view title and the empty state's wording. This component never
   *  filters `rows` by it; the caller already did.
   *
   *  🚨 This is a LABEL and may change while the view does not. Never
   *  compare it to decide whether the view changed -- use `mailboxKey`.
   *  A custom folder's route carries only the mailbox id, so the caller
   *  passes a placeholder until `/api/mailboxes` resolves the real name;
   *  treating that late rename as a folder switch left the list stuck in
   *  the loading skeleton forever (a second instance, 2026-09-22). */
  mailbox: string;
  /** STABLE identity of the view `rows` belong to -- a role for a native
   *  folder, `account/mailboxId` for a custom one. Changes exactly when
   *  the caller starts fetching a different page, and never merely
   *  because a title resolved.
   *
   *  🚨 Gates the loading state above: when `mailboxKey` changes, this
   *  component keeps showing loading (never the PREVIOUS folder's rows,
   *  never the empty state) until `rows` itself changes again -- observed
   *  live as the previous folder's rows sitting under the new folder's
   *  title for ~3s while the new page was still in flight. `rows`
   *  changing for the SAME view (search-as-you-type, load-more) does not
   *  retrigger this; only a `mailboxKey` change does.
   *
   *  Defaults to `mailbox` so the many tests that pass a role for both
   *  keep working; the app always passes it explicitly. */
  mailboxKey?: string;
  /** account key -> accent color (hex), from `GET /api/accounts`. A key
   *  missing here (a mailbox arrived before the accounts list did, or a
   *  fake in a test that doesn't care) falls back to a neutral gray,
   *  matching Sidebar's `fallbackAccountSpec`. */
  accents?: Record<string, string>;
  /** account key -> short uppercase code (`AccountSpec.code`, design
   *  task-1). NEVER a hardcoded map -- sourced from `GET /api/accounts`
   *  by the caller, same as `accents`. A key missing here falls back to
   *  the account key itself, uppercased, so a caller/test that doesn't
   *  pass it still gets something legible. */
  codes?: Record<string, string>;
  /** The currently *opened* message, if any -- controlled by the caller
   *  (App reads it off the route/store). When omitted, the component
   *  tracks it itself so it's usable standalone in tests. */
  opened?: MessageListSelection | null;
  /** Called when a row is clicked, i.e. the user wants to open it. */
  onOpen?: (sel: MessageListSelection) => void;
  /** The bulk action bar's Mark read / Archive (design's `bulkRead` /
   *  `bulkArchive`). The list owns the selection, so it hands the caller
   *  the resolved targets; the caller owns the API call, the toast and
   *  the undo. Omitted disables both buttons with a reason rather than
   *  leaving them silently dead -- audit pass 1. */
  onBulk?: (action: "read" | "archive", targets: MessageListSelection[]) => void;
  /** The server's TRUE total for this view (`ListResult.total`), not a
   *  page length. Optional and defaulting to `rows.length` -- every
   *  existing caller/test that doesn't pass it keeps today's behavior
   *  (accidentally correct only because it never fetched more than one
   *  short page); a caller that HAS the real total (App.tsx) must pass
   *  it, per the round-11 review finding that "200" was being shown
   *  against a 9,612-match mailbox. */
  total?: number;
  /** True when the server has more rows beyond what's already in `rows`
   *  (i.e. a non-null cursor). Together with `onLoadMore`, this is the
   *  other half of that same finding: "Show N more" on its own only
   *  reveals more of the already-fetched page. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Row 37: "Empty trash". Omitted -> the button renders disabled with
   *  its reason, as it did before the route existed. */
  onEmptyTrash?: () => void;
  /** Only used to keep a per-account accent legible against the current
   *  panel color (finding (b)) -- `lib/color.ts`'s `accentForTheme`.
   *  Omitted defaults to plain `toCssColor` (today's behavior), so every
   *  existing test that doesn't pass it is unaffected. */
  theme?: "light" | "dark";
  /** An account currently needing reauthorization -- renders the amber
   *  banner (Wilco.dc.html `bannerError`). `null`/omitted renders
   *  nothing, matching every existing caller/test. */
  reauth?: MessageListReauth | null;
  /** Called when the banner's "Reauthorize" button is clicked, with the
   *  account key from `reauth`. */
  onReauthorize?: (account: string) => void;
  /** True while the viewed scope is an IMAP account -- renders the grey
   *  "Support coming" banner (Wilco.dc.html `bannerPending`). IMAP sync
   *  does not exist yet; this is the honest label for it. */
  imapPending?: boolean;
  /** List row spacing (Settings' Appearance > Density row, design-fidelity
   *  Task 6 fix round 1). The design's own literal values: comfortable
   *  9px top/bottom row padding (this component's existing default,
   *  unchanged), compact 5px. Left/right padding (9px/12px) stay fixed --
   *  the design only varies the vertical `--row-pad`. Defaults to
   *  `"comfortable"` so every existing caller/test that doesn't pass this
   *  keeps today's rendering exactly. */
  density?: "comfortable" | "compact";
  /** Opens the row's `···`/right-click context menu (design's `S.ctx.type
   *  === 'thread'`) -- Task 8 of this plan. Fired on `contextmenu`
   *  (`e.preventDefault()`'d by this component so the browser's own menu
   *  never appears), with the clicked row and the event's client
   *  coordinates for positioning. App.tsx owns the menu's actual item
   *  list, same division of labor as `onReauthorize`. Optional so every
   *  existing test/caller that doesn't pass it is unaffected -- rows
   *  simply show the browser's default context menu, exactly today's
   *  behavior. */
  onRowContextMenu?: (row: MessageListRow, evt: { clientX: number; clientY: number }) => void;
  /** Design-fidelity Pass C. DESIGN.md's Message list section, verbatim:
   *  "Rows layout: single-line table (checkbox · code · sender 168px ·
   *  subject — snippet · flags · time 38px right)." Transcribed from
   *  Wilco.dc.html's OTHER row shape (`t.wide`, lines ~324-335) -- used
   *  only when the app's own top/bottom "rows" layout is active
   *  (`layoutDir !== 'row'` in the design, i.e. list-above-reading), never
   *  in the side-by-side "columns" layout, which keeps the three-line
   *  `t.tall` row this component already rendered. `false`/omitted keeps
   *  every existing caller/test on today's three-line row exactly. */
  rowsLayout?: boolean;
}

/**
 * How close to the bottom of the scroll pane counts as "the reader has
 * reached the end" and the next server page should be fetched. One
 * viewport's worth, so the rows are already there by the time they scroll
 * into view rather than arriving after a visible stop.
 */
const NEAR_BOTTOM_PX = 900;

/**
 * The nearest ancestor that actually scrolls, starting from `el` itself.
 *
 * 🚨 It is NOT this component's own element. `.msg-list-scroll` has no
 * overflow of its own -- it grows (measured: 13,921px tall on a 200-row
 * archive) inside `.list-pane`, which `Panes.tsx` owns and which carries
 * the `overflow-y: auto`. The first version of the scroll paging bound its
 * listener to `.msg-list-scroll`, which therefore never fires a scroll
 * event, and NOTHING ever loaded a second page.
 *
 * 🚨 That version's test PASSED. It set `scrollHeight`/`clientHeight` on
 * the element the component owns and dispatched a scroll event at it --
 * proving the handler's arithmetic against geometry the test invented, on
 * an element that does not scroll in a browser. happy-dom runs no layout,
 * so it cannot tell you which element has the overflow. Found in a
 * screenshot, like every other defect of this shape in this project.
 *
 * Resolved at runtime rather than hardcoding `.list-pane`, so which pane
 * owns the overflow stays a layout decision instead of a coupling.
 */
export function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node !== null) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return el;
}

const FALLBACK_ACCENT = "#8a8f97";

/** A stable reference for "no rows to show yet" -- reused rather than
 *  `[]` inline so it doesn't itself count as a `rows` change on every
 *  render while `rows` is `undefined` (that would defeat the mailbox
 *  effect below, which keys on `rows`'s identity). */
const EMPTY_ROWS: MessageListRow[] = [];

/** Shown when the caller passed no `onBulk`. A component rendered without
 *  a handler must say so rather than presenting a live-looking button --
 *  audit guardrail 3. */
const BULK_REASON = "Bulk actions need a triage handler, which this view was rendered without";

/** Matches Sidebar.tsx's `FONT_MONO` -- belt-and-braces alongside the
 *  `.msg-*` CSS classes. happy-dom (the test environment) never loads
 *  `components.css`, so a test reading a computed `font-family` back only
 *  matches if this is ALSO set as an inline style, not just in the
 *  stylesheet a real browser applies. */
const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

function sameSelection(a: MessageListSelection | null, account: string, id: string): boolean {
  return a !== null && a.account === account && a.id === id;
}

function isToday(iso: string | undefined): boolean {
  if (iso === undefined) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/** [title, sub] per folder, transcribed from Wilco.dc.html's
 *  `emptyByFolder` (line ~1448) -- the design gives every folder its own
 *  empty-state copy, not one generic message. */
const EMPTY_MESSAGES: Record<string, [string, string]> = {
  inbox: ["Inbox zero", "Enjoy it while it lasts"],
  drafts: ["Nothing in progress", "c starts a new message"],
  spam: ["No spam", "The robots are behaving"],
  trash: ["Trash is empty", "Deleted mail is kept 30 days, then gone"],
  sent: ["Nothing sent yet", ""],
  archive: ["Archive is empty", "e files the selected thread here"],
};

function emptyMessage(mailbox: string): [string, string] {
  return EMPTY_MESSAGES[mailbox] ?? ["Nothing here", ""];
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

interface Row {
  account: string;
  id: string;
  key: string;
}

/** The drag payload's MIME type: a JSON list of `{account, id}` targets.
 *  Custom, so a folder row can tell a message drag from a stray file. */
export const DRAG_MESSAGES_TYPE = "application/x-wilco-messages";
/** Prefix of a second, data-less type naming the ONE account every target
 *  is in. A drop target reads `types` during dragover -- the payload
 *  itself is unreadable there (the DataTransfer is in protected mode) --
 *  so the account has to be visible in the type list to accept or refuse
 *  the drag before it is dropped. Absent for a mixed-account selection,
 *  which no single folder can take. */
export const DRAG_ACCOUNT_TYPE_PREFIX = "application/x-wilco-account-";

export function MessageList({
  rows,
  mailbox,
  mailboxKey,
  accents,
  codes,
  opened,
  onOpen,
  onBulk,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
  onEmptyTrash,
  theme,
  reauth,
  onReauthorize,
  imapPending,
  density,
  onRowContextMenu,
  rowsLayout,
}: MessageListProps): JSX.Element {
  // Literal, not var(--row-pad): happy-dom's getComputedStyle doesn't
  // resolve a custom property set via an inline style (same trap as
  // Sidebar.tsx's FONT_MONO / Settings.tsx's switch radius), and the
  // "density actually changes row padding" test reads this back per row.
  const rowPad = density === "compact" ? 5 : 9;
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [localOpened, setLocalOpened] = useState<MessageListSelection | null>(null);

  // The view's stable identity. `mailbox` is display text and can change
  // under a settled list (a custom folder's name resolving), which must
  // not read as a folder switch anywhere below.
  const viewKey = mailboxKey ?? mailbox;

  // The checkbox selection is scoped to a single view and resets on a
  // folder switch. Deliberately keyed on `viewKey` alone, not on `rows` (a
  // search-as-you-type update to the SAME view must not clear what the
  // reader has ticked).
  useEffect(() => {
    setChecked(new Set());
  }, [viewKey]);

  // `rows === undefined` is "not fetched yet"; `effectiveRows` is what
  // everything below actually renders, defaulting to a stable empty array
  // rather than `[]` so `rows` staying `undefined` across renders doesn't
  // itself look like a change.
  const notYetLoaded = rows === undefined;
  const effectiveRows = rows ?? EMPTY_ROWS;

  // Tracks which view the CURRENT `rows` actually belong to, as best
  // this component can tell without the caller tagging every row with its
  // folder. `viewKey` (updated the instant the route changes) and
  // `rowsForMailbox` (this state, updated only once `rows` itself next
  // changes) fall out of step for exactly the window a folder switch is
  // in flight -- `rows` still holds the PREVIOUS folder's page, since the
  // new page hasn't arrived yet. `folderPending` below is true for that
  // whole window and false the instant new rows land, whatever they are.
  //
  // 🚨 Deliberately a ref, not read to gate rendering directly, would be
  // wrong here: a ref mutation doesn't itself trigger a re-render, so the
  // render that receives the NEW rows (settling the transition) would
  // still test its OWN stale copy of "what mailbox is this?" against the
  // ref before the ref's owning effect had a chance to run, and nothing
  // would ever schedule the extra render needed to reflect the update.
  // State does: the effect's `setRowsForMailbox` below issues a fresh
  // render once `rows` changes, and that render sees the fresh value.
  const [rowsForMailbox, setRowsForMailbox] = useState(viewKey);
  useEffect(() => {
    setRowsForMailbox(viewKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  const folderPending = rowsForMailbox !== viewKey;
  const showLoading = notYetLoaded || folderPending;

  /**
   * 🚨 THE LIST RENDERS EVERY ROW IT HAS, and fetches the next page when
   * the reader reaches the bottom.
   *
   * What was here before: a SECOND, purely local pagination -- 12 rows
   * revealed initially, +25 per click of a "Show N more" button -- stacked
   * on top of the server's real cursor, inside a pane that already scrolls.
   * The server's own page is 200 (`SEARCH_LIMIT`), and "Load more" was
   * rendered ONLY once the local reveal was exhausted. So a folder was
   * capped at 200 messages behind EIGHT clicks, and the button under a
   * 12,220-message Archive read
   *
   *     Show 25 more — 12 of 200
   *
   * while the header above it correctly said 12,220. Measured on the live
   * archive, which is how it was found: the app looked like it held 200
   * messages. Reaching the oldest message in that folder would have taken
   * roughly 490 clicks.
   *
   * A scroll pane does not need a button to reveal rows it already has.
   * The only paging left is the real one -- the server cursor -- and it
   * happens on scroll, with the button kept as the explicit affordance for
   * anyone who does not scroll (and as the thing a test can click).
   */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollParentOf(scrollRef.current);
    if (el === null || hasMore !== true || onLoadMore === undefined) return;
    const onScroll = (): void => {
      if (loadingMore === true) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) onLoadMore();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasMore, loadingMore, onLoadMore, effectiveRows.length]);

  const effectiveOpened = opened !== undefined ? opened : localOpened;

  function handleOpen(account: string, id: string): void {
    const sel = { account, id };
    if (opened === undefined) setLocalOpened(sel);
    onOpen?.(sel);
  }

  // The anchor for shift-click: the row last checked by a plain click. A
  // shift-click selects everything between it and the clicked row, in
  // list order, inclusive (row 26) -- and leaves the anchor where it was,
  // so a second shift-click extends from the same place, as every mail
  // client's list does.
  const anchorRef = useRef<string | null>(null);
  function toggleChecked(key: string, shift = false): void {
    const anchor = anchorRef.current;
    if (shift && anchor !== null && anchor !== key) {
      const order = effectiveRows.map((r) => `${r.account}:${r.id}`);
      const a = order.indexOf(anchor);
      const b = order.indexOf(key);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setChecked((prev) => {
          const next = new Set(prev);
          for (const k of order.slice(lo, hi + 1)) next.add(k);
          return next;
        });
        return;
      }
    }
    anchorRef.current = key;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }


  /** Fires the caller's bulk handler with the checked rows resolved to
   *  targets, then clears the selection -- the rows are about to change
   *  meaning (or leave the list entirely) and a stale checked set would
   *  keep the bar open over messages that are no longer there. */
  function runBulk(action: "read" | "archive"): void {
    if (onBulk === undefined) return;
    const targets: MessageListSelection[] = [];
    for (const key of checked) {
      const row = effectiveRows.find((r) => `${r.account}:${r.id}` === key);
      if (row !== undefined) targets.push({ account: row.account, id: row.id });
    }
    if (targets.length === 0) return;
    onBulk(action, targets);
    setChecked(new Set());
  }
  const unreadTotal = effectiveRows.reduce((sum, r) => sum + (r.isUnread ? 1 : 0), 0);

  // Group headers (DESIGN.md: "Today / Earlier"). Computed over the
  // VISIBLE slice, in the order `rows` already arrived in (newest first,
  // the caller's responsibility) -- this component never re-sorts.
  const groups: { label: string; items: Row[] }[] = [];
  for (const r of effectiveRows) {
    const label = isToday(r.receivedAt) ? "Today" : "Earlier";
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) {
      last.items.push({ account: r.account, id: r.id, key: `${r.account}:${r.id}` });
    } else {
      groups.push({ label, items: [{ account: r.account, id: r.id, key: `${r.account}:${r.id}` }] });
    }
  }
  const byKey = new Map(effectiveRows.map((r) => [`${r.account}:${r.id}`, r]));
  const [emptyTitle, emptySub] = emptyMessage(mailbox);

  return (
    <div className="msg-list-root" data-testid="message-list">
      <header className="msg-list-header">
        {checked.size === 0 ? (
          <div data-testid="list-header" className="msg-list-title-row">
            <span data-testid="list-title" className="msg-list-title">
              {text(capitalize(mailbox))}
            </span>
            {/* `total ?? rows.length`: the server's real count when the
                caller has it (App.tsx), never a page length passed off as
                a total (round-11 review finding). */}
            <span data-testid="list-count" className="msg-list-meta">
              {(total ?? effectiveRows.length).toLocaleString("en-US")} · {unreadTotal} unread
            </span>
          </div>
        ) : (
          <div data-testid="bulk-bar" className="msg-bulk-bar">
            <span data-testid="bulk-count" className="msg-bulk-count">
              {checked.size} selected
            </span>
            <button
              type="button"
              data-testid="bulk-all"
              className="msg-bulk-btn"
              title="Select every message in view"
              onClick={() => setChecked(new Set(effectiveRows.map((r) => `${r.account}:${r.id}`)))}
            >
              All
            </button>
            <button
              type="button"
              data-testid="bulk-mark-read"
              className="msg-bulk-btn"
              disabled={onBulk === undefined}
              title={onBulk === undefined ? BULK_REASON : "Mark the selected messages read"}
              onClick={() => runBulk("read")}
            >
              Mark read
            </button>
            <button
              type="button"
              data-testid="bulk-archive"
              className="msg-bulk-btn msg-bulk-btn--primary"
              disabled={onBulk === undefined}
              title={onBulk === undefined ? BULK_REASON : "Archive the selected messages"}
              onClick={() => runBulk("archive")}
            >
              Archive
            </button>
            <button
              type="button"
              data-testid="bulk-clear"
              className="msg-bulk-clear"
              title="Clear selection (esc)"
              onClick={() => setChecked(new Set())}
            >
              <X size={11} strokeWidth={1.5} />
            </button>
          </div>
        )}

        {reauth != null && (
          <div data-testid="reauth-banner" className="msg-reauth-banner">
            <span className="msg-reauth-icon" aria-hidden="true">
              <TriangleAlert size={11} />
            </span>
            <span data-testid="reauth-message" className="msg-reauth-text">
              {text(reauth.message)}
            </span>
            <button
              type="button"
              data-testid="reauth-button"
              className="msg-reauth-btn"
              onClick={() => onReauthorize?.(reauth.account)}
            >
              Reauthorize
            </button>
          </div>
        )}

        {imapPending === true && (
          <div data-testid="imap-banner" className="msg-imap-banner">
            <span className="msg-imap-badge">IMAP</span>
            <span className="msg-imap-text">Support coming — showing imported snapshot, not syncing.</span>
          </div>
        )}
      </header>

      <div className="msg-list-scroll" ref={scrollRef}>
        {/* Neither the empty state nor the previous folder's rows: shown
         *  while `rows` is `undefined` (never fetched) or while a folder
         *  switch is in flight (see `folderPending` above). Plain markup,
         *  no dependency -- three placeholder rows, not a spinner, so it
         *  reads as "the list" rather than as an interstitial. */}
        {showLoading && (
          <div data-testid="list-loading" className="msg-list-loading" aria-busy="true">
            <div className="msg-list-loading-row" />
            <div className="msg-list-loading-row" />
            <div className="msg-list-loading-row" />
          </div>
        )}

        {!showLoading && effectiveRows.length === 0 && (
          <div data-testid="empty" className="msg-list-empty">
            {text(emptyTitle)}
            <br />
            <span className="msg-list-empty-sub">{text(emptySub)}</span>
          </div>
        )}

        {/* Wilco.dc.html's `trashMode` banner (line ~314-319). Its gating
         *  boolean (line ~1519): `trashMode: !searching && S.folder ===
         *  'trash' && vis.length > 0` -- the design only shows this banner
         *  when Trash has visible rows, NOT unconditionally on the folder
         *  alone (an earlier version of this file assumed the opposite
         *  from the markup's DOM ordering, before reading the logic that
         *  actually computes the sc-if's value; caught comparing against
         *  a real render of the design, see this task's report). An empty
         *  Trash shows only the ordinary "Trash is empty" empty state.
         *  "Empty trash" is destructive and this codebase has no backend
         *  mutation for it (no DELETE-all-in-mailbox route exists) -- per
         *  this task's brief, the button is real, in the design's exact
         *  red, and permanently `disabled` with an explanatory `title`;
         *  it must never be omitted and never wired live. */}
        {!showLoading && mailbox === "trash" && effectiveRows.length > 0 && (
          <div data-testid="trash-banner" className="msg-trash-banner">
            <span className="msg-trash-banner-text">Deleted mail is kept 30 days, then gone.</span>
            <button
              type="button"
              data-testid="empty-trash"
              className="msg-trash-empty-btn"
              disabled={onEmptyTrash === undefined}
              title={onEmptyTrash === undefined ? "Not available yet -- this view was rendered without an empty-trash handler." : "Permanently deletes everything in Trash"}
              onClick={onEmptyTrash}
            >
              Empty trash
            </button>
          </div>
        )}

        {!showLoading && effectiveRows.length > 0 && (
          <>
          {groups.map((group) => (
            <div key={`${group.label}-${group.items[0]!.key}`}>
              <div
                data-testid={`group-header-${group.label.toLowerCase()}`}
                className="msg-group-header"
                style={{ textTransform: "uppercase", fontFamily: FONT_MONO }}
              >
                {group.label}
              </div>
              {group.items.map((item) => {
                const row = byKey.get(item.key)!;
                const accent = accents?.[row.account] ?? FALLBACK_ACCENT;
                const swatchColor = theme !== undefined ? accentForTheme(accent, theme) : toCssColor(accent);
                const code = codes?.[row.account] ?? row.account.slice(0, 3).toUpperCase();
                const isOpen = sameSelection(effectiveOpened, row.account, row.id);
                const isChecked = checked.has(item.key);
                const rowKey = `${row.account}-${row.id}`;
                const rowClass = "msg-row" + (isOpen || isChecked ? " msg-row--selected" : "");
                const senderClass = "msg-row-sender" + (row.isUnread === true ? " msg-row-sender--unread" : "");
                const subjectClass = "msg-row-subject" + (row.isUnread === true ? " msg-row-subject--unread" : "");
                const sharedHandlers = {
                  onClick: () => handleOpen(row.account, row.id),
                  onContextMenu: (e: MouseEvent) => {
                    if (onRowContextMenu === undefined) return;
                    e.preventDefault();
                    onRowContextMenu(row, { clientX: e.clientX, clientY: e.clientY });
                  },
                  // Row 32: a row can be dragged onto a sidebar folder. The
                  // payload is the move's targets -- this row, or the whole
                  // checked set when this row is part of it, the way every
                  // mail client treats dragging a selection.
                  draggable: true,
                  ondragstart: (e: DragEvent) => {
                    const dt = e.dataTransfer;
                    if (dt === null) return;
                    const targets = checked.has(item.key)
                      ? effectiveRows.filter((r) => checked.has(`${r.account}:${r.id}`)).map((r) => ({ account: r.account, id: r.id }))
                      : [{ account: row.account, id: row.id }];
                    dt.setData(DRAG_MESSAGES_TYPE, JSON.stringify(targets));
                    const accounts = new Set(targets.map((t) => t.account));
                    if (accounts.size === 1) dt.setData(DRAG_ACCOUNT_TYPE_PREFIX + targets[0]!.account, "1");
                    dt.effectAllowed = "move";
                  },
                };
                const checkbox = (
                  <SelectBox
                    testId={`checkbox-${rowKey}`}
                    checked={isChecked}
                    offset={rowsLayout !== true}
                    onToggle={({ shift }) => toggleChecked(item.key, shift)}
                  />
                );
                const flags = (
                  <>
                    {row.isFlagged === true && (
                      <span aria-hidden="true" className="msg-row-star">
                        <Star size={10} fill="currentColor" stroke="none" />
                      </span>
                    )}
                    {row.hasAttachment === true && (
                      <span aria-hidden="true" className="msg-row-attach">
                        <Paperclip size={10} strokeWidth={1.5} />
                      </span>
                    )}
                    {row.isUnread === true && (
                      <span aria-hidden="true" data-testid={`row-unread-${rowKey}`} className="msg-row-unread-dot" />
                    )}
                  </>
                );

                if (rowsLayout === true) {
                  // Wilco.dc.html's `t.wide` article (lines ~324-335):
                  // checkbox, code (32px), sender (168px), subject + em
                  // dash + snippet on ONE line (flex:1), flags, time
                  // (38px, right-aligned) -- DESIGN.md's own paraphrase
                  // of this same row.
                  return (
                    <article
                      key={item.key}
                      data-testid={`row-wide-${rowKey}`}
                      className={"msg-row-wide" + (isOpen || isChecked ? " msg-row--selected" : "")}
                      role="row"
                      aria-selected={isOpen ? "true" : "false"}
                      style={{ borderLeftColor: swatchColor, borderLeftWidth: "3px" }}
                      {...sharedHandlers}
                    >
                      {checkbox}
                      <span
                        data-testid={`row-code-${rowKey}`}
                        className="msg-row-wide-code"
                        title={row.account}
                        style={{ color: swatchColor, fontFamily: FONT_MONO }}
                      >
                        {text(code)}
                      </span>
                      <span
                        data-testid={`row-sender-${rowKey}`}
                        className={senderClass + " msg-row-wide-sender"}
                        style={{ fontWeight: row.isUnread === true ? 700 : 500 }}
                      >
                        {text(row.fromName || row.fromEmail || "")}
                      </span>
                      <ThreadCount count={row.threadCount} testId={`thread-count-${rowKey}`} />
                      <span className="msg-row-wide-subject-line">
                        <span data-testid={`row-subject-${rowKey}`} className={subjectClass + " msg-row-wide-subject"}>
                          {text(row.subject)}
                        </span>
                        <span className="msg-row-wide-dash"> — </span>
                        <span data-testid={`row-snippet-${rowKey}`} className="msg-row-wide-snippet">
                          <Snippet value={row.snippet ?? row.preview ?? ""} />
                        </span>
                      </span>
                      {flags}
                      <span data-testid={`row-time-${rowKey}`} className="msg-row-wide-time">
                        {formatRowsLayoutTime(row.receivedAt, new Date())}
                      </span>
                    </article>
                  );
                }

                return (
                  <div
                    key={item.key}
                    data-testid={`row-${rowKey}`}
                    className={rowClass}
                    role="row"
                    aria-selected={isOpen ? "true" : "false"}
                    style={{
                      borderLeftColor: swatchColor,
                      borderLeftWidth: "3px",
                      paddingTop: `${rowPad}px`,
                      paddingBottom: `${rowPad}px`,
                    }}
                    {...sharedHandlers}
                  >
                    {checkbox}
                    <div className="msg-row-body">
                      <div className="msg-row-line1">
                        <span
                          data-testid={`row-sender-${rowKey}`}
                          className={senderClass}
                          style={{ fontWeight: row.isUnread === true ? 700 : 500 }}
                        >
                          {text(row.fromName || row.fromEmail || "")}
                        </span>
                        <ThreadCount count={row.threadCount} testId={`thread-count-${rowKey}`} />
                        <span
                          data-testid={`row-code-${rowKey}`}
                          className="msg-row-code"
                          title={row.account}
                          style={{ color: swatchColor, fontFamily: FONT_MONO }}
                        >
                          {text(code)}
                        </span>
                        <span data-testid={`row-time-${rowKey}`} className="msg-row-time">
                          {formatRowTime(row.receivedAt, new Date())}
                        </span>
                      </div>
                      <div data-testid={`row-subject-${rowKey}`} className={subjectClass}>
                        {text(row.subject)}
                      </div>
                      <div className="msg-row-line3">
                        <span data-testid={`row-snippet-${rowKey}`} className="msg-row-snippet">
                          <Snippet value={row.snippet ?? row.preview ?? ""} />
                        </span>
                        {flags}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {hasMore === true && (
            <button
              type="button"
              data-testid="load-more"
              className="msg-list-more"
              onClick={onLoadMore}
              disabled={loadingMore === true}
            >
              {loadingMore === true
                ? "Loading…"
                : `Load more — ${effectiveRows.length.toLocaleString("en-US")} of ${(total ?? effectiveRows.length).toLocaleString("en-US")}`}
            </button>
          )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The conversation's message count (handoff v1.1 #1): mono 9.5px, --faint,
 * directly after the sender, ONLY when the thread holds more than one
 * message. "No parentheses, no pill" -- a bare number.
 */
function ThreadCount({ count, testId }: { count?: number; testId: string }): JSX.Element | null {
  if (count === undefined || count <= 1) return null;
  return (
    <span data-testid={testId} className="msg-row-thread-count" style={{ fontFamily: FONT_MONO }}>
      {count}
    </span>
  );
}
