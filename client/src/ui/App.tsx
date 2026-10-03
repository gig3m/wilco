// The app shell (Task 5): three panes wired to a URL (spec 7.3's
// `/{mailbox}/{account}/{id}` model) and resizable per DESIGN.md's
// "Layout" section. Message list rows, the sidebar's account tree and
// search all land in later tasks of this plan -- this file's job is the
// frame they render inside, plus the two behaviors spec 7.3 names
// explicitly: Back closes an open message before it leaves the app, and a
// reload lands back on whatever was open.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { Menu, X } from "lucide-preact";
import { DEFAULT_PREFERENCES } from "../lib/api";
import { rememberTheme } from "../lib/theme";
import type {
  AccountHealth,
  AccountSpec,
  Api,
  EmailRow,
  Mailbox,
  MessageDetail,
  SavedSearch,
  TriageAction,
  TriageScope,
  TriageTarget,
  DraftPrefill,
  Preferences,
} from "../lib/api";
import { subscribe } from "../lib/events";
import { describeApiError, isSessionExpired } from "../lib/errors";
import { chordState, COMMANDS, COMPOSE_REASON, feed, resolve, TRIAGE_REASON, type CommandContext, type CommandId } from "../lib/keymap";
import { parseRoute, routeToPath, type Route } from "../lib/router";
import { syncBadgeFor } from "./Sidebar";
import { createStore } from "../lib/store";
import { AddAccount } from "./AddAccount";
import { Compose, type OutgoingDraft } from "./Compose";
import { Login } from "./Login";
import { MessageList, type MessageListRow, type MessageListSelection } from "./MessageList";
import {
  Overlays,
  type ContextMenu,
  type ContextMenuItem,
  type MovePicker,
  type NotificationToast,
  type OverlayOpen,
  type RawSource,
  type ToastState,
} from "./Overlays";
import { Palette, type PaletteItem } from "./Palette";
import { Divider, ListPane } from "./Panes";
import { PrintView } from "./PrintView";
import { Reading, type ReadingAttachment, type ReadingMessage, formatSize } from "./Reading";
import { Search } from "./Search";
import { Settings } from "./Settings";
import { Sidebar } from "./Sidebar";

// Folder cycle order for `[`/`]` (spec 7.4's "unported" list). Mirrors
// MessageList.tsx's `EMPTY_MESSAGES` role set -- there's no server-side
// "folder order" endpoint, so this is a fixed, reasonable default rather
// than something fetched.
const FOLDER_ORDER = ["inbox", "drafts", "sent", "archive", "trash", "spam"];

/** The navigation seam `App` drives instead of touching `window.history`
 *  directly -- so a test can hand in `fakeHistory` from `test-utils.tsx`
 *  and never need a real URL bar. Mirrors that module's `HistoryLike`
 *  exactly; duplicated here (rather than imported) because this is the
 *  production contract the test type happens to satisfy, not the other
 *  way around -- `ui/` code must not depend on `test-utils.tsx`. */
export interface HistoryLike {
  path(): string;
  push(path: string): void;
  replace(path: string): void;
  back(): void;
  listen(cb: (path: string) => void): () => void;
}

/**
 * 🚨 `history.pushState` DOES NOT FIRE `popstate` -- the event only fires
 * for a user-driven traversal (Back/Forward). An earlier version of this
 * function listened for `popstate` and nothing else, so every programmatic
 * navigation in the app -- clicking a row, the command palette, `[`/`]`,
 * `g i` -- changed the URL and then rendered nothing: the reading pane sat
 * on "Nothing selected" while the address bar said a message was open, and
 * a RELOAD of that same URL showed the message correctly. Every test passed
 * throughout, because they all inject `fakeHistory`, whose `push` notifies
 * its listeners the way a router is expected to.
 *
 * So this keeps its own listener set and notifies it on push/replace as
 * well as on popstate. Found by clicking a row in a real browser during
 * Task 11's screenshot pass; the same class of bug as Task 10's unmounted
 * `App`, and for the same reason -- the production seam was the one thing
 * no test exercised.
 */
function createBrowserHistory(): HistoryLike {
  const listeners = new Set<(path: string) => void>();

  function currentPath(): string {
    return window.location.pathname;
  }
  function notify(): void {
    const path = currentPath();
    for (const cb of [...listeners]) cb(path);
  }

  return {
    path: currentPath,
    push(path) {
      window.history.pushState(null, "", path);
      notify();
    },
    replace(path) {
      window.history.replaceState(null, "", path);
      notify();
    },
    back() {
      // popstate DOES fire for this one, and asynchronously -- notifying
      // here as well would run the listeners against the pre-Back URL.
      window.history.back();
    },
    listen(cb) {
      listeners.add(cb);
      const handler = (): void => cb(currentPath());
      window.addEventListener("popstate", handler);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("popstate", handler);
      };
    },
  };
}

// DESIGN.md "Layout": sidebar 242px fixed; list 392px default, drag
// clamped 280-620px; reading pane fills the rest. Rows layout: list on
// top at 42% default, drag clamped 20-75%.
/** Spec 7.3's "~1s dwell" before an opened message is marked read. Long
 *  enough that a `j`-sweep down the list marks nothing; short enough that
 *  actually reading a message always counts. */
const READ_ON_OPEN_DWELL_MS = 2000; // the "After 2s" option of the markRead preference

/**
 * How long a toast stays up before dismissing itself.
 *
 * 🚨 Both values are the design's own, and neither was implemented — toasts
 * lingered until something else replaced them, so an undo toast from a
 * message you archived ten minutes ago was still sitting there.
 *
 * `Wilco.dc.html:908` — `pushUndo` sets `setTimeout(..., ttl || 7000)`, so
 * seven seconds is the floor for EVERY undo, not just the ones passing a ttl.
 * `Wilco.dc.html:947` — a notification removes itself after nine.
 *
 * ⚠️ No visible countdown, deliberately. The design shows `label + " Ns"`
 * only when `pushUndo` is given its optional third argument, and every
 * triage call site omits it — the one caller that passes a ttl is the
 * send-delay outbox, which is deferred. See `UndoToast`'s own note in
 * Overlays.tsx, which reached the same conclusion and is still right: the
 * countdown is a different feature from the auto-dismiss.
 */
export const TOAST_MS: Record<"undo" | "notification", number> = { undo: 7000, notification: 9000 };

/** How often App re-reads `/healthz` for the reauthorize banner. Matches the
 *  cadence Sidebar uses for the same data. */
const HEALTH_POLL_MS = 60_000;

/** Debounce before the palette searches the corpus. A palette that fires a
 *  full-text search on every keystroke makes the box work harder than the
 *  person using it. */
const PALETTE_SEARCH_DEBOUNCE_MS = 200;


/** A short, quiet two-note tone for the new-mail toast (the notifSound
 *  preference). Web Audio, no asset; silently nothing where the API is
 *  absent (tests) or the context cannot start (autoplay policy). */
function playNotificationTone(): void {
  const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (AC === undefined) return;
  try {
    const ctx = new AC();
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    gain.connect(ctx.destination);
    for (const [freq, at] of [[880, 0], [1174.7, 0.12]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.1);
    }
    setTimeout(() => void ctx.close().catch(() => {}), 500);
  } catch {
    // No tone is better than an exception in the sync path.
  }
}

/** The move picker's folder order and glyphs: role folders in the
 *  sidebar's order, then custom folders (no role) by name. */
const MOVE_ROLE_ORDER = ["inbox", "drafts", "sent", "archive", "trash", "junk"];
const MOVE_ROLE_ICON: Record<string, string> = { inbox: "▤", drafts: "✎", sent: "↗", archive: "▣", trash: "▣", junk: "▣" };

const SIDEBAR_WIDTH = 242;
const LIST_WIDTH_DEFAULT = 392;
const LIST_WIDTH_MIN = 280;
const LIST_WIDTH_MAX = 620;
const ROW_HEIGHT_DEFAULT_PCT = 42;
const ROW_HEIGHT_MIN_PCT = 20;
const ROW_HEIGHT_MAX_PCT = 75;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Responsive breakpoints (Task 11 / spec 10 M3c "usable at 600 CSS px").
// Three regimes, not a continuum:
//
//   wide   (>= 1024)  three panes side by side -- the desktop layout, with
//                     the drag dividers and the columns/rows toggle.
//   medium (600-1023) the sidebar stays, but the reading pane OVERLAYS the
//                     list instead of taking a third column.
//
// The wide threshold is 1024, not the 900 this task's brief names as the
// point BELOW which the reading pane must overlay. 900 was tried first and
// screenshotted: 242px sidebar + 392px list leaves a 262px reading pane, in
// which the subject truncates to "[Homelab] ✅ Backup s..." and the action
// row (Archive/Spam/Delete/Forward/Reply) runs off the right edge with
// Reply invisible. Overlaying from 1024 down satisfies the brief's rule
// (everything below 900 overlays) and additionally fixes the band the rule
// left standing.
//   narrow (< 600)    phone. The sidebar becomes a drawer over a scrim, so
//                     the list gets the whole width; opening a message
//                     still overlays, giving the list-then-message flow.
//
// Measured against `window.innerWidth` rather than a CSS media query
// because the panes are sized with inline styles (see Panes.tsx: happy-dom
// runs no layout engine, so a class-driven width is invisible to a test).
// One resize listener for the whole app.
export const BREAKPOINT_WIDE = 1024;
export const BREAKPOINT_NARROW = 600;

export type Viewport = "wide" | "medium" | "narrow";

/** Exported so a test can assert the boundaries themselves without
 *  standing up a DOM: 600 is deliberately MEDIUM, not narrow -- the exit
 *  condition is "usable AT 600 CSS px", and at exactly 600 the sidebar
 *  plus a 358px list still fits. */
export function viewportFor(width: number): Viewport {
  if (width < BREAKPOINT_NARROW) return "narrow";
  if (width < BREAKPOINT_WIDE) return "medium";
  return "wide";
}

function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(() => viewportFor(window.innerWidth || BREAKPOINT_WIDE));
  useEffect(() => {
    const onResize = (): void => setViewport(viewportFor(window.innerWidth || BREAKPOINT_WIDE));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return viewport;
}

export interface AppProps {
  api: Api;
  history?: HistoryLike;
  /** The sync-event subscription (lib/events.ts). Injectable so a test
   *  can fire a sync event by hand -- the rubberband fix (row 36) lives
   *  in what a sync event is allowed to do to the list. */
  subscribeFn?: typeof subscribe;
}

export function App({ api, history, subscribeFn }: AppProps): JSX.Element {
  // The history instance is fixed for the component's lifetime -- a prop
  // change here would mean swapping navigation systems out from under a
  // mounted app, which is not a real scenario for either callers or tests.
  const historyRef = useRef<HistoryLike>(history ?? createBrowserHistory());
  const h = historyRef.current;
  const storeRef = useRef(createStore());

  const [route, setRoute] = useState<Route>(() => parseRoute(h.path()));
  const [layout, setLayout] = useState<"columns" | "rows">("columns");
  const [listWidth, setListWidth] = useState(LIST_WIDTH_DEFAULT);
  const [rowHeightPct, setRowHeightPct] = useState(ROW_HEIGHT_DEFAULT_PCT);
  const [message, setMessage] = useState<MessageDetail | null>(null);
  // The rest of the open message's conversation, oldest-first, EXCLUDING
  // `message` itself (Reading's own contract -- see ReadingThread's doc
  // comment). Fetched below once `message.threadId` is known; reset on
  // every navigation so a stale thread from the previous message never
  // flashes under a new one before its own fetch resolves.
  const [threadMessages, setThreadMessages] = useState<MessageDetail[]>([]);
  /** Row 31: what the open message offers for unsubscribing, probed on
   *  open; null until known (and when there is nothing). */
  const [unsubscribeMethod, setUnsubscribeMethod] = useState<"post" | "mailto" | null>(null);
  // `undefined` until the first response for the CURRENT view has arrived --
  // matching MessageList's own contract (see its `rows` prop doc). Task 5
  // review finding: this used to start `[]`, which is indistinguishable
  // from "this folder is empty", so the very first paint after login always
  // rendered "Inbox zero" for as long as the first fetch took (measured
  // 3.5s on a 167k-message instance) before real rows replaced it. The
  // fetch effect below (`route.mailbox`/`route.filter`/...) does NOT reset
  // this to `undefined` on a folder switch -- it leaves the previous
  // folder's array in place, which is what lets MessageList's own
  // `rowsForMailbox` mechanism (mailbox prop vs. when `rows` last changed)
  // detect "switch in flight" and show loading without ever displaying the
  // old folder's rows under the new title.
  const [rows, setRowsState] = useState<EmailRow[] | undefined>(undefined);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsCursor, setRowsCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // The list App/Search's keyboard layer (j/k/x, `open`) must actually
  // operate on -- whichever one is on screen. `Search` swaps its children
  // out for its own results (Search.tsx) while `rows` above keeps holding
  // the FOLDER's rows underneath, so without this, j/k during an active
  // search walked invisible messages (round-11 review finding). Reported
  // upward by `Search` via `onResultsChange` rather than lifted entirely,
  // since Search still owns its own fetch/debounce.
  const [searchState, setSearchState] = useState<{ active: boolean; rows: EmailRow[] }>({ active: false, rows: [] });
  const [accents, setAccents] = useState<Record<string, string>>({});
  // account key -> short uppercase code (`AccountSpec.code`), built exactly
  // like `accents` above from the same `GET /api/accounts` fetch -- this
  // was the wiring the design-fidelity reviews found missing: MessageList
  // already accepted a `codes` prop and fell back to a derived
  // `key.slice(0,3).toUpperCase()` whenever it was absent, but nothing
  // here ever supplied the real one. A `code` that is a real column but
  // still empty (pre-backfill live rows default to `''`) falls back to
  // that same derivation -- MessageList's own fallback only fires when a
  // key is MISSING from the map entirely, so an explicit `''` value must
  // be resolved here rather than passed through.
  const [codes, setCodes] = useState<Record<string, string>>({});
  // The full fetched account list, for Compose's `from` select (Task 5).
  // Not derivable from `accents`/`codes` above -- those two maps discard
  // everything but the accent/code, and Compose needs `key`/`label` too.
  const [accountSpecs, setAccountSpecs] = useState<AccountSpec[]>([]);
  // Compose (Task 5, fix round 1): the PANE is real and reachable --
  // Sidebar's compose button and the keymap's `c` command both flip this
  // -- but there is still no send path anywhere in this codebase, so
  // Compose itself keeps Send/Attach/Discard disabled with
  // `COMPOSE_REASON`. `reply`/`forward` stay disabled here too: unlike
  // plain compose, they need a message-scoped context (subject, quote
  // chain) this app has nowhere to source yet.
  const [composeOpen, setComposeOpen] = useState(false);
  /** Set when compose was opened as a reply/forward, so the window can be
   *  prefilled and the send carries the threading headers. null = a new
   *  message. */
  const [composeDraft, setComposeDraft] = useState<DraftPrefill | null>(null);
  /** The message the open reply is TO (archiveOnReply). */
  const replySourceRef = useRef<MessageListSelection | null>(null);
  const [composeMode, setComposeMode] = useState<"new" | "reply" | "forward">("new");
  /** Set when compose was opened by RESUMING an existing draft, so the
   *  first autosave updates that draft rather than creating a second copy
   *  of the same unfinished message. */
  const [resumedDraftId, setResumedDraftId] = useState<string | null>(null);
  /** A resumed draft's HTML for the editor to adopt (HTML compose 3.5). */
  const [resumedHtml, setResumedHtml] = useState<string | null>(null);
  // A dismissible, non-alarming strip for any API failure that ISN'T a
  // dead session (that gets the full-screen `Login` gate below instead).
  // Centralizing this here -- rather than each pane inventing its own
  // inline error UI -- is what lets every `.catch` added in this pass
  // reach a visible surface with one shared mechanism.
  const [banner, setBanner] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Bumped whenever a saved search is added from the search pane, so
  // Sidebar (which owns its own fetched copy of the list) knows to
  // refetch instead of showing a stale sidebar until the next reload.
  const [savedSearchesVersion, setSavedSearchesVersion] = useState(0);
  /** Saved searches, owned here so the palette and the sidebar read ONE
   *  list -- the pattern audit pass 6 established for `/healthz` and
   *  `/api/accounts` after finding three independent polls of the first. */
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .savedSearches()
      .then((r) => {
        if (!cancelled) setSavedSearches(r.savedSearches);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, savedSearchesVersion]);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
  );
  // List row spacing (Task 6, Settings' Appearance > Density row) -- the
  // only other real client state this task adds. No command binds it
  // (unlike theme/layout, which also have their own single-key shortcut);
  // Settings is currently the only surface that changes it.
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Task 8 (overlays and toasts): ONE `OverlayOpen` slot -- `Overlays`
  // itself only ever shows one modal-shaped thing at a time (its own
  // module comment) -- plus the payload each overlay type needs. Every
  // payload state stays populated after its overlay closes (cheap, and
  // it avoids a render where the overlay is still animating out but its
  // data already vanished); only `overlay` itself gates what's visible.
  const [overlay, setOverlay] = useState<OverlayOpen>("none");
  const [contextMenuData, setContextMenuData] = useState<ContextMenu | null>(null);
  const [moveData, setMoveData] = useState<MovePicker | null>(null);
  const [sourceData, setSourceData] = useState<RawSource | null>(null);
  const [attachmentData, setAttachmentData] = useState<ReadingAttachment | null>(null);
  // The one-at-a-time toast layer (Overlays.tsx's own `ToastState`).
  // Undo has no real path to populate this yet -- see `runCommand`'s
  // `undo` entry and the task report's "UI-only" decision -- so in
  // practice this only ever carries a `NotificationToast`, pushed by the
  // push-driven effect below.
  const [toast, setToast] = useState<ToastState | undefined>(undefined);
  // Settings (Task 6): a real, reachable screen -- the sidebar's ⚙
  // button and the `,` key both open it (commandContext.settings below).
  // Closed by its own "← Back to mail"/"esc" handling, and implicitly by
  // any navigation (the drawerOpen-closing effect below now closes this
  // too), matching the design's own `settingsOpen: false` resets on every
  // folder/account/search/palette selection.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Add-account onboarding (Task 7) -- a real modal, unlike Settings/
  // Compose (first-class panes): reachable from both the sidebar's own
  // "+ Add account" row and Settings' "+ Add account" row, so it lives
  // here rather than inside either of them. Bumped by `accountsVersion`
  // (below) rather than closed automatically on navigation -- there's no
  // navigation happening while it's open, since it renders on top of
  // whatever pane was already showing.
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  // Bumped once an account is really created server-side (AddAccount's
  // `onCreated`) so the accounts-fetch effect below re-runs and Sidebar/
  // Settings pick up the new row -- it does NOT mean the account is
  // syncing yet (see AddAccount.tsx's module comment).
  const [accountsVersion, setAccountsVersion] = useState(0);
  // Row 35: the sidebar's folder counts refetch when this moves. Bumped
  // after every local action that changes a count and on every sync
  // event -- the counts used to load once and sit there until a reload.
  const [mailboxesVersion, setMailboxesVersion] = useState(0);
  // Row 37: every stored preference, loaded at boot (see the effect on
  // applyTheme below) and changed through `changePreference`, which writes
  // it back. Theme/density/layout keep their own state for the shortcuts
  // and are mirrored here.
  const [prefs, setPrefs] = useState<Preferences>({ ...DEFAULT_PREFERENCES });
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  /** True once the stored preferences have been read (or failed to). */
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const launchRoutedRef = useRef(false);
  // unifiedInboxAtLaunch off (row 37): a launch at the unified inbox lands
  // on the FIRST account's inbox in the owner's order -- once, and only
  // once both the accounts and the preferences are known. `replace`, so
  // back does not return to a unified view that never showed. Deep links
  // and everything after launch are untouched.
  useEffect(() => {
    if (launchRoutedRef.current || !prefsLoaded || accountSpecs.length === 0) return;
    launchRoutedRef.current = true;
    const r = parseRoute(h.path());
    const first = accountSpecs[0];
    if (prefs.unifiedInboxAtLaunch === "off" && r.filter === null && r.account === null && r.mailbox === "inbox" && first !== undefined) {
      h.replace(routeToPath({ mailbox: "inbox", filter: first.key, account: null, id: null }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsLoaded, accountSpecs]);
  function changePreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    setPrefs((p) => ({ ...p, [key]: value }));
    api.setPreference(key, value).catch((err: unknown) => handleApiError(err, "save your preference"));
  }
  const bumpMailboxes = (): void => setMailboxesVersion((v) => v + 1);
  const viewport = useViewport();
  // The phone drawer. Closed on every navigation (the effect below) so a
  // tap on a folder doesn't leave the sidebar sitting over the list it
  // just changed.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // A query pushed into `Search` from outside it -- today only the
  // sidebar's saved searches. Tokened rather than a bare string so
  // clicking the SAME saved search twice re-runs it; see Search's own
  // `requestedQuery` comment.
  const [requestedQuery, setRequestedQuery] = useState<{ value: string; token: number } | undefined>(undefined);

  /**
   * Account health, for the reauthorize banner (audit pass 3 D1).
   *
   * 🚨 `MessageList` has had `reauth`/`onReauthorize`/`imapPending` since it
   * was written, with tests rendering both banners — and `App` passed
   * NEITHER, so an expired token showed a sidebar badge and no banner
   * anywhere in the list. Two tests rendering a component directly, over a
   * feature no user could reach: the same shape as the attachment-preview
   * `onDownload` pass 7 found.
   *
   * ⚠️ This is a THIRD `/healthz` poll — Sidebar and Settings each own one
   * already. Consolidating them belongs in the seams pass; a third poll of a
   * local endpoint that reads one table is the smaller problem, and leaving
   * the banner unreachable to avoid it would be the wrong trade.
   */
  const [healthByAccount, setHealthByAccount] = useState<Map<string, AccountHealth>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      api
        .health()
        .then((report) => {
          if (!cancelled) setHealthByAccount(new Map(report.accounts.map((a) => [a.account, a])));
        })
        // Losing the banner is a cosmetic degrade, not a reason to show the
        // session-expired banner a failed message fetch would — same ruling
        // Sidebar's own poll makes.
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);

  /** The account to name in the banner, or null. Uses `syncBadgeFor` — the
   *  SAME bucket the sidebar badge reads — so the badge and the banner can
   *  never disagree about whether an account is in trouble. */
  const reauth = (() => {
    for (const spec of accountSpecs) {
      if (syncBadgeFor(spec, healthByAccount.get(spec.key)) === "error") {
        const health = healthByAccount.get(spec.key);
        return {
          account: spec.key,
          message:
            health?.state === "auth"
              ? `${spec.label} needs to be reauthorized — its token was rejected.`
              : `${spec.label} is not syncing${health?.message !== undefined ? ` — ${health.message}` : "."}`,
        };
      }
    }
    return null;
  })();
  const imapPending = accountSpecs.some((a) => a.provider === "imap");
  // Persists across re-renders of the keydown effect below (which
  // re-registers whenever its deps change) so a chord in progress ("g")
  // survives -- a fresh ChordState on every effect run would silently
  // drop it.
  const chordRef = useRef(chordState());
  // Real wall-clock timestamp of the moment the CURRENT chord became
  // pending (set whenever a "g" starts one, or a chord key continues one
  // that's still pending). This is what lets the keydown handler below
  // drive `chordRef.current.advance()` off ACTUAL elapsed time between
  // keystrokes -- without it, `feed()`'s staleness check never moves
  // (nothing else in this file calls `advance`), so a chord left pending
  // for an hour would still fire on the next matching key. keymap.ts's
  // own unit test drives `advance()` directly to prove the pure math;
  // this ref is what makes that math a property of the running app.
  const chordAnchorRef = useRef(0);

  // A snapshot of the size being dragged, taken at mousedown -- the
  // Divider reports a *cumulative* offset from drag start, not an
  // incremental one, so clamping has to be relative to this, not to
  // whatever the size was on the previous mousemove.
  const dragBaseRef = useRef(0);

  // The one place every `.catch` below routes to: a dead session goes to
  // the full-screen login gate (never retried, never left as a blank
  // pane); anything else becomes a short, dismissible banner. `context`
  // is a few words of what was being attempted ("load your mail",
  // "search") -- shown verbatim, never `err.message` for a non-ApiError,
  // matching `lib/errors.ts`'s `describeApiError`.
  function handleApiError(err: unknown, context: string): void {
    if (isSessionExpired(err)) {
      setSessionExpired(true);
      return;
    }
    setBanner(`Couldn't ${context}. ${describeApiError(err)}`);
  }

  useEffect(() => {
    setDrawerOpen(false);
    setSettingsOpen(false);
  }, [route.mailbox, route.filter, route.account, route.id, viewport]);

  // Follow the URL: a `history.push`/`back`/reload all funnel through
  // here as a path, which is exactly the point -- the shell has one
  // source of truth for "what's open" instead of route state and pushState
  // calls drifting apart.
  useEffect(() => h.listen((path) => setRoute(parseRoute(path))), [h]);

  // The message fetch. Selection lives in the store (keyed by
  // account+id, per store.ts) so later tasks' list/sidebar can read it;
  // this is a purely local navigation, so `reason` is left at its
  // "local" default -- passing "server" here would be the exact bug
  // store.ts's doc comment warns about.
  useEffect(() => {
    const { account, id } = route;
    if (account === null || id === null) {
      storeRef.current.select(null);
      setMessage(null);
      setThreadMessages([]);
      return;
    }

    storeRef.current.select({ account, id });
    let cancelled = false;
    setThreadMessages([]);
    setUnsubscribeMethod(null);
    api
      .message(account, id)
      .then((detail) => {
        if (cancelled) return;
        setMessage(detail);
        // Row 31: does this message offer a way out? A probe, not a
        // column -- the header is not in the archive. A failed probe
        // means no control, not a banner.
        api
          .unsubscribeInfo(account, id)
          .then((r) => {
            if (!cancelled) setUnsubscribeMethod(r.method);
          })
          .catch(() => {});

        // The conversation (Reading's collapsed earlier messages). A
        // message with no `threadId` has no conversation to fetch --
        // Reading renders it alone, which is already what an empty
        // `threadMessages` (the default above) gives it. A thread fetch
        // that FAILS must not blank the reading pane either: the single
        // message is already set above, so this `.catch` only ever
        // leaves `threadMessages` at its already-empty default rather
        // than routing to `handleApiError` (a missing "earlier messages"
        // section is not a failure worth a banner over).
        if (detail.threadId === null) return;
        api
          .thread(account, detail.threadId)
          .then((result) => {
            if (cancelled) return;
            // getThread() (server) returns every message in the thread,
            // oldest-first, INCLUDING the one just opened -- Reading's
            // `thread` prop must exclude it (ReadingMessage's own doc
            // comment), so it's filtered out here rather than asked of
            // the server.
            setThreadMessages(result.messages.filter((m) => m.id !== id));
          })
          .catch(() => {
            if (!cancelled) setThreadMessages([]);
          });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMessage(null);
        setThreadMessages([]);
        handleApiError(err, "open that message");
      });
    return () => {
      cancelled = true;
    };
  }, [route.account, route.id, api]);

  // Account accent colors, for the list's per-row left edge -- fetched
  // here rather than threaded through Sidebar (which fetches the same
  // `GET /api/accounts` for its own purposes) so MessageList doesn't
  // depend on Sidebar's internal state.
  useEffect(() => {
    let cancelled = false;
    api
      .accounts()
      .then((specs) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        const codeMap: Record<string, string> = {};
        for (const spec of specs) {
          map[spec.key] = spec.accent;
          codeMap[spec.key] = spec.code !== undefined && spec.code.length > 0 ? spec.code : spec.key.slice(0, 3).toUpperCase();
        }
        setAccents(map);
        setCodes(codeMap);
        setAccountSpecs(specs);
        // Identities are what make the From select produce a real sending
        // address ("<account>|<email>"). Fetched separately because it is a
        // JMAP round trip per account and must not delay the sidebar.
        api
          .identities()
          .then(({ identities }) => {
            if (cancelled) return;
            setAccountSpecs((prev) =>
              prev.map((spec) => {
                const list = identities[spec.key] ?? [];
                if (list.length === 0) return spec;
                return {
                  ...spec,
                  // 🚨 `primary` comes from the SERVER, which derives it
                  // from `mayDelete === false` (spec 11). This used to be
                  // `idx === 0` -- exactly the positional guess the spec
                  // singles out as wrong, on an account with five aliases.
                  identities: list.map((i) => ({
                    id: i.id,
                    email: i.email,
                    // Row 60: the From select shows this, not `spec.label`.
                    name: i.name,
                    primary: i.primary,
                    textSignature: i.textSignature,
                    htmlSignature: i.htmlSignature,
                  })),
                } as AccountSpec;
              }),
            );
          })
          .catch(() => {
            // A failure here leaves the From select showing account labels
            // with no address, and Send explains it -- better than blocking
            // the whole app on an optional lookup.
          });
      })
      .catch((err: unknown) => {
        if (!cancelled) handleApiError(err, "load your accounts");
      });
    return () => {
      cancelled = true;
    };
  }, [api, accountsVersion]);

  // The list's rows: refetched on a folder switch (mailbox or account
  // filter changing), never on the open message changing -- opening a
  // message must not re-fetch or reshuffle the list underneath it. This
  // is a local navigation, exactly like the message fetch above, so
  // `setRows` gets `{ reason: "local" }` (its default, made explicit
  // here since store.ts's whole point is that this call site must never
  // silently become "server").
  // `role`, never `mailbox`: the route's first segment is a role name
  // ("inbox", "archive"), and a mailbox ID is scoped per account, so
  // sending it as `mailbox` made the unified inbox a 400 and rendered an
  // empty list against a full archive. Caught by Task 11's screenshots.
  // Factored out (rather than inlined in the effect below) so
  // `handleLoadMore` can build the exact same filters for a `cursor` page.
  function listFilters(): { role?: string; mailbox?: string; account?: string; group?: boolean } {
    // 🚨 `route.filter`, NOT `route.account`. `account` is the account the
    // OPEN MESSAGE lives in; filtering the list by it is what collapsed
    // every unified view the moment anything was opened (see router.ts).
    // `group: false` (the groupConversations preference off) lists every
    // message as its own row; the default sends nothing and groups.
    const group = prefs.groupConversations === "off" ? { group: false } : {};
    if (route.mailboxId !== undefined && route.filter !== null) return { account: route.filter, mailbox: route.mailboxId, ...group };
    return route.filter === null ? { role: route.mailbox, ...group } : { role: route.mailbox, account: route.filter, ...group };
  }

  useEffect(() => {
    let cancelled = false;
    api
      .messages(listFilters())
      .then((result) => {
        if (cancelled) return;
        setRowsState(result.rows);
        setRowsTotal(result.total);
        setRowsCursor(result.cursor);
        storeRef.current.setRows(result.rows, { reason: "local" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        handleApiError(err, "load your mail");
        // A failed fetch must still terminate MessageList's loading state.
        // `rows` staying `undefined` (first load) or holding the PREVIOUS
        // folder's array (a folder switch) is indistinguishable, from
        // MessageList's `notYetLoaded`/`folderPending` checks, from "still in
        // flight" -- so a load that errors out left the skeleton spinning
        // forever underneath the error banner `handleApiError` just raised.
        // `[]` is a real, new array (an identity change even when the
        // previous state was already `[]`), so it always clears both checks.
        setRowsState([]);
        setRowsTotal(0);
        setRowsCursor(null);
      });
    return () => {
      cancelled = true;
    };
  }, [route.mailbox, route.filter, api, prefs.groupConversations, route.mailboxId]);

  // Push (spec 7.3): a `change` frame off GET /api/events means the SERVER
  // moved something under the currently open view, so the refetch it
  // triggers passes `{ reason: "server" }` -- the one call site in this
  // file that does, exactly matching store.ts's rule (see the `local`
  // comments above/below). Subscribed once for the component's lifetime
  // ([api] only, via `listFiltersRef` for the latest route) rather than
  // re-opened on every route change, which would otherwise churn the SSE
  // connection on each folder switch. A fatal stream error (401 -- the
  // session cookie is gone) routes to the same `Login` gate every other
  // `.catch` in this file uses, via `handleApiError`'s branch.
  const listFiltersRef = useRef(listFilters);
  listFiltersRef.current = listFilters;
  // Task 8: the ingredients for a REAL desktop-notification toast (design's
  // `notifs`), all kept fresh via refs for the same reason `listFiltersRef`
  // exists -- this effect's `subscribe` callback is registered once ([api]
  // only) and must never close over a stale `rows`/`route`/`accents`/
  // `codes` from whatever render happened to be current when it mounted.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const routeRef = useRef(route);
  routeRef.current = route;
  const accentsRef = useRef(accents);
  accentsRef.current = accents;
  const codesRef = useRef(codes);
  codesRef.current = codes;
  // Row 36 (reported day 1: rapid `#` rubberbanded). A sync event's
  // refetch used to replace the list with whatever the server answered --
  // including rows the user had just deleted whose triage had not landed
  // when the server computed the answer. Three guards: a refetch requested
  // before the latest triage settled is DISCARDED (a newer one follows), a
  // row with a move in flight is filtered out of any answer, and once the
  // triages settle a fresh refetch reconciles if anything was discarded.
  const triageGenRef = useRef(0);
  const inFlightRemovalsRef = useRef(new Set<string>());
  const staleDroppedRef = useRef(false);
  const refreshListRef = useRef<() => void>(() => {});
  useEffect(() => {
    const refreshList = (): void => {
        // A sync event means counts changed somewhere: new mail, or a
        // change made in Fastmail (row 21). Refetch the sidebar's counts.
        bumpMailboxes();
        const before = rowsRef.current ?? [];
        const gen = triageGenRef.current;
        api
          .messages(listFiltersRef.current())
          .then((result) => {
            if (gen !== triageGenRef.current) {
              // Answered from before a later triage landed: applying it
              // would put deleted rows back. If that triage is still in
              // flight its completion asks for a fresh answer; if it has
              // already settled, ask now.
              if (inFlightRemovalsRef.current.size > 0) staleDroppedRef.current = true;
              else refreshListRef.current();
              return;
            }
            const inFlight = inFlightRemovalsRef.current;
            if (inFlight.size > 0) {
              result = { ...result, rows: result.rows.filter((r) => !inFlight.has(`${r.account}:${r.id}`)) };
            }
            // A genuinely NEW, unread row (not present in `before` by
            // (account, id), never index -- store.ts's own rule) that
            // isn't the message already open. This is what makes the
            // notification toast real push-driven data, not a demo: it
            // only ever shows a sender/subject the server truly just
            // reported, off the account/mailbox actually being viewed.
            // Only one toast at a time (Overlays.tsx's `toast` slot is
            // singular) -- the first qualifying row wins; a burst of
            // several new messages shows just the latest-processed one,
            // which is an acknowledged simplification (see task report).
            const beforeKeys = new Set(before.map((r) => `${r.account}:${r.id}`));
            const fresh = result.rows.find(
              (r) =>
                r.isUnread &&
                !beforeKeys.has(`${r.account}:${r.id}`) &&
                !(r.account === routeRef.current.account && r.id === routeRef.current.id),
            );
            // Notification preferences (row 37): no toast when off; with
            // "people only", a toast only for a sender the account has
            // written to; a short tone with it when sound is on.
            if (fresh !== undefined && prefsRef.current.notifDesktop !== "off") {
            const arrived = fresh;
            const showToast = (): void => {
              if (prefsRef.current.notifSound === "on") playNotificationTone();
              setToast({
                kind: "notification",
                account: arrived.account,
                accent: accentsRef.current[arrived.account] ?? "#8a8f97",
                code: codesRef.current[arrived.account],
                from: arrived.fromName,
                subject: arrived.subject,
                snippet: arrived.snippet ?? undefined,
                onOpen: () => {
                  setToast(undefined);
                  handleOpenRow({ account: arrived.account, id: arrived.id });
                },
                onDismiss: () => setToast(undefined),
              });
            };
              if (prefsRef.current.notifPeopleOnly === "on") {
                api
                  .writtenTo(arrived.account, arrived.fromEmail)
                  .then((r) => {
                    if (r.written) showToast();
                  })
                  .catch(() => {});
              } else {
                showToast();
              }
            }
            setRowsState(result.rows);
            setRowsTotal(result.total);
            setRowsCursor(result.cursor);
            storeRef.current.setRows(result.rows, { reason: "server" });
          })
          .catch((err: unknown) => handleApiError(err, "refresh your mail"));
    };
    refreshListRef.current = refreshList;
    return (subscribeFn ?? subscribe)(refreshList, { onFatalError: () => setSessionExpired(true) });
  }, [api, subscribeFn]);

  // "Show N more" (MessageList.tsx) only reveals more of what's already in
  // `rows` -- a purely local reveal, no network call. This is the OTHER
  // half: once that local reveal is exhausted and the server says there's
  // more (`rowsCursor !== null`), fetch the next page and append. Passed
  // to MessageList as `onLoadMore`/`hasMore`/`loadingMore`, all optional,
  // so every existing MessageList test (which passes none of them) keeps
  // its current "local reveal only" behavior unchanged.
  //
  // Resolves with the rows it APPENDED (empty when there was nothing to
  // load or the fetch failed), so a caller that needs to act on the new
  // page -- `moveSelection` walking `j` across the boundary -- can land on
  // the first new row. One fetch at a time: a second call while a page is
  // in flight (a scroll-trigger and a keypress racing) joins the same
  // promise rather than being dropped or fetching the same cursor twice.
  const pendingLoadRef = useRef<Promise<EmailRow[]> | null>(null);
  function loadMore(): Promise<EmailRow[]> {
    if (pendingLoadRef.current !== null) return pendingLoadRef.current;
    if (rowsCursor === null) return Promise.resolve([]);
    setLoadingMore(true);
    const p = api
      .messages({ ...listFilters(), cursor: rowsCursor })
      .then((result) => {
        setRowsState((prev) => {
          const next = [...(prev ?? []), ...result.rows];
          storeRef.current.setRows(next, { reason: "local" });
          return next;
        });
        setRowsTotal(result.total);
        setRowsCursor(result.cursor);
        return result.rows;
      })
      .catch((err: unknown) => {
        handleApiError(err, "load more mail");
        return [] as EmailRow[];
      })
      .finally(() => {
        pendingLoadRef.current = null;
        setLoadingMore(false);
      });
    pendingLoadRef.current = p;
    return p;
  }
  function handleLoadMore(): void {
    void loadMore();
  }

  function handleOpenRow(sel: MessageListSelection): void {
    // Row 36: the open message is tracked in a ref the moment navigation
    // happens, not when the next render commits its closures. Two fast
    // `#` presses used to resolve against the SAME message (the second
    // keydown ran the previous render's handler), delete it twice, and
    // the duplicate's moveSelection from index -1 jumped the selection to
    // the top -- the reported "messages appear above the selected one".
    openedRef.current = { account: sel.account, id: sel.id };
    // The filter is carried through unchanged: opening a message must not
    // narrow the list it was opened from.
    h.push(routeToPath({ mailbox: route.mailbox, filter: route.filter, mailboxId: route.mailboxId, account: sel.account, id: sel.id }));
  }

  // Sidebar's folder rows and "All inboxes" (finding (c): folders "read as
  // a link" but nothing was clickable). `role` is a mailbox ROLE, exactly
  // what the route model already expects (see `listFilters` above) --
  // this only ever fires for a mailbox that HAS one; a custom folder
  // (role === null) has no route this app can express yet, so Sidebar
  // renders those without a click handler at all rather than pretending.
  function handleNavigateFolder(role: string, account: string): void {
    h.push(routeToPath({ mailbox: role, filter: account, account: null, id: null }));
  }
  // Row 32: a message dragged from the list onto a sidebar folder is a
  // move into that folder -- the same moveTo the picker and `e`/`#` use.
  function handleDropMessages(mailboxId: string, _account: string, targets: TriageTarget[]): void {
    void runTriage({ kind: "moveTo", mailboxId }, targets, "Moved");
  }

  // Row 31: the server performs the unsubscribe and says what it did.
  async function runUnsubscribe(): Promise<void> {
    if (message === null) return;
    try {
      const r = await api.unsubscribe(message.account, message.id);
      const label =
        r.method === "mailto"
          ? `Unsubscribe email sent to ${r.to}`
          : r.ok
            ? "Unsubscribed"
            : `The sender refused the unsubscribe request${r.status !== null ? ` (${r.status})` : ""}`;
      setToast({ kind: "undo", label });
      if (r.method === "mailto") bumpMailboxes();
    } catch (err) {
      handleApiError(err, "unsubscribe");
    }
  }

  // Row 33: the print document opens in its own window, so the dialog it
  // asks for is about that page alone and the app stays where it was.
  function openPrint(account: string, id: string): void {
    window.open(routeToPath({ mailbox: route.mailbox, filter: route.filter, mailboxId: route.mailboxId, account, id, print: true }), "_blank", "noopener");
  }

  // Row 37: a custom folder opens by its mailbox id, scoped to its account.
  function handleOpenMailbox(account: string, mailboxId: string): void {
    h.push(routeToPath({ mailbox: "folder", filter: account, mailboxId, account: null, id: null }));
  }
  // The header titles a custom folder by its NAME; the route carries only
  // the id, so the name is looked up when such a route is active.
  const [customFolderName, setCustomFolderName] = useState<string | null>(null);
  useEffect(() => {
    if (route.mailboxId === undefined || route.filter === null) {
      setCustomFolderName(null);
      return;
    }
    let cancelled = false;
    const account = route.filter;
    const id = route.mailboxId;
    api
      .mailboxes()
      .then((r) => {
        if (cancelled) return;
        const name = r.accounts.find((a) => a.account === account)?.mailboxes.find((m) => m.id === id)?.name ?? null;
        setCustomFolderName(name);
      })
      .catch(() => {
        if (!cancelled) setCustomFolderName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, route.mailboxId, route.filter]);

  // Row 37: "Empty trash" -- every account in view (one, or all in the
  // unified Trash), after a confirm: this destroys mail on the server.
  async function emptyTrash(): Promise<void> {
    if (!window.confirm("Permanently delete everything in Trash? This cannot be undone.")) return;
    try {
      const boxes = await api.mailboxes();
      const inView = boxes.accounts.filter((a) => route.filter === null || a.account === route.filter);
      let destroyed = 0;
      for (const a of inView) {
        const trash = a.mailboxes.find((m) => m.role === "trash");
        if (trash === undefined) continue;
        const r = await api.emptyTrash(a.account, trash.id);
        destroyed += r.destroyed;
      }
      setRowsState([]);
      setRowsTotal(0);
      bumpMailboxes();
      setToast({ kind: "undo", label: destroyed === 0 ? "Trash was already empty" : `Deleted ${destroyed} from Trash` });
    } catch (err) {
      handleApiError(err, "empty the trash");
    }
  }

  // Row 37: "Mark all read" on a folder -- every unread message in it,
  // ungrouped, in chunks the triage route accepts, through the same
  // triage path `u`-on-a-row would take. Reports the count.
  async function markFolderRead(account: string, where: { role: string } | { mailbox: string }): Promise<void> {
    let done = 0;
    try {
      for (let guard = 0; guard < 200; guard++) {
        const page = await api.messages({ account, ...where, unread: true, group: false, limit: 200 });
        if (page.rows.length === 0) break;
        const targets = page.rows.map((r) => ({ account: r.account, id: r.id }));
        const result = await api.triage({ kind: "read", value: true }, targets);
        done += result.applied;
        if (result.applied === 0) break;
      }
      setRowsState((prev) => (prev ?? []).map((r) => (r.account === account ? { ...r, isUnread: false } : r)));
      bumpMailboxes();
      setToast({ kind: "undo", label: done === 0 ? "Nothing unread" : `Marked ${done} read` });
    } catch (err) {
      handleApiError(err, "mark the folder read");
    }
  }

  // Row 59: "All inboxes" is the unified INBOX from wherever you are. It
  // used to keep `route.mailbox` and drop only the account, so from an
  // account's Archive it opened every account's Archive under an "All
  // inboxes" highlight, and from a custom folder it opened `/folder`, which
  // names no folder (owner, 2026-09-16).
  function handleAllInboxes(): void {
    h.push(routeToPath({ mailbox: "inbox", filter: null, account: null, id: null }));
  }

  const opened: MessageListSelection | null =
    route.account !== null && route.id !== null ? { account: route.account, id: route.id } : null;
  // Kept in step with the route on every render, and set AHEAD of it by
  // handleOpenRow (row 36). Read by the keyboard actions, which must act
  // on what is open now, not on what was open when their closure formed.
  const openedRef = useRef<MessageListSelection | null>(opened);
  openedRef.current = opened;

  // Shared across the three `<Reading>` call sites below (columns layout,
  // rows layout, and the compact overlay) so all three stay in sync rather
  // than drifting the way three separately-hand-written prop lists would.
  // `accountEmail` is deliberately never passed -- `AccountSpec` (api.ts)
  // has no email field, and inventing one (e.g. guessing a domain from the
  // account key) is exactly the "don't resolve an open question in code"
  // trap the brief calls out. Reading already renders its meta line
  // without it when omitted.
  // Mints the body-frame capability URL (spec 3.3). Stable across renders
  // via useCallback because BodyFrame has it in an effect dependency list --
  // a fresh function identity every render would re-mint a token, and
  // re-load the frame, on every keystroke elsewhere in the app.
  const loadBodyUrl = useCallback(
    (account: string, id: string, opts: { images?: boolean; full?: boolean }) => api.bodyUrl(account, id, opts),
    [api],
  );

  const readingThread = { messages: threadMessages };
  const readingAccountCode = message !== null ? codes[message.account] : undefined;

  // Task 8: builds the message-scoped context menu (design's `S.ctx.type
  // === 'msg'`), reachable from Reading's own `···` card menu (both the
  // open message and any expanded earlier one -- `onMessageMenu` is wired
  // identically to every `MessageCard`). Reply/Reply all/Forward stay
  // disabled with `COMPOSE_REASON` -- same gap Reading's own header
  // buttons already admit. "View source" and "Copy address" are REAL:
  // the only two message-level actions this codebase can actually do
  // without a write API. "Move to…" opens the move picker, whose folder
  // rows are themselves disabled (TRIAGE_REASON) -- Wilco has no
  // `Email/set`-backed move endpoint, so the picker is honestly a preview
  // of a control, not a working one (see `openMoveTo` below and the task
  // report's reasoning).
  function openMessageMenu(msg: ReadingMessage, x: number, y: number): void {
    const items: ContextMenuItem[] = [
      { label: "Reply", hint: "r", onSelect: () => void openReply("reply") },
      { label: "Reply all", hint: "a", onSelect: () => void openReply("reply-all") },
      { label: "Forward", hint: "f", onSelect: () => void openReply("forward") },
      { label: "", divider: true },
      { label: "View source", onSelect: () => openSourceFor(msg) },
      {
        label: "Copy address",
        onSelect: () => {
          if (msg.fromEmail === undefined) return;
          navigator.clipboard?.writeText(msg.fromEmail).catch(() => {});
        },
      },
      {
        label: "Move to…",
        onSelect: () =>
          void openMoveTo(
            msg.account,
            msg.account !== undefined && msg.id !== undefined ? [{ account: msg.account, id: msg.id }] : triageTargets(),
          ),
      },
    ];
    setContextMenuData({ x, y, items });
    setOverlay("contextmenu");
  }

  // Task 8: the raw-source overlay's data. Unlike the design's own mock
  // (`rawSource()`, Wilco.dc.html ~line 1176), which fabricates a
  // plausible Received/Message-ID chain purely for visual flavor, this
  // only ever states fields the server truly returned -- see
  // `RawSource`'s own doc comment in Overlays.tsx for why.
  function openSourceFor(msg: ReadingMessage): void {
    const lines = [
      `From: ${msg.fromName ?? ""} <${msg.fromEmail ?? ""}>`.trim(),
      `Subject: ${msg.subject ?? message?.subject ?? ""}`,
      `Date: ${msg.receivedAt ?? ""}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      msg.bodyText ?? msg.preview ?? "",
    ];
    const id = msg.account !== undefined && msg.id !== undefined ? `${msg.account}:${msg.id}` : "";
    setSourceData({ id, text: lines.join("\n") });
    setOverlay("source");
  }

  // Task 8: the attachment preview overlay's data (Reading's `···`-free
  // attachment chips, now clickable). `onDownload` is omitted -- there is
  // no attachment-serving endpoint yet (spec 6.7) -- so the overlay's own
  // Download button renders disabled with its reason, matching every
  // other not-yet-wired action in this file.
  function openAttachmentPreview(attachment: ReadingAttachment): void {
    setAttachmentData(attachment);
    setOverlay("attachment");
  }

  // The move picker (row 22): the account's REAL folders, fetched at open
  // so a folder created a moment ago on Fastmail is offered as soon as
  // the sync has learned it. Role folders first in the sidebar's order,
  // then custom folders by name; picking one is a `moveTo` on the
  // targets, the same triage path `e`/`#` use.
  async function openMoveTo(accountKey: string | undefined, targets: TriageTarget[]): Promise<void> {
    if (accountKey === undefined || targets.length === 0) return;
    let boxes: Mailbox[] = [];
    try {
      const result = await api.mailboxes();
      boxes = result.accounts.find((a) => a.account === accountKey)?.mailboxes ?? [];
    } catch (err) {
      handleApiError(err, "load your folders");
      return;
    }
    const rank = (m: Mailbox): number => {
      const i = MOVE_ROLE_ORDER.indexOf(m.role ?? "");
      return i === -1 ? MOVE_ROLE_ORDER.length : i;
    };
    const sorted = [...boxes].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    setMoveData({
      account: codes[accountKey] ?? accountKey,
      folders: sorted.map((m) => ({
        id: m.id,
        name: m.name,
        icon: MOVE_ROLE_ICON[m.role ?? ""] ?? "▸",
        onSelect: () => void runTriage({ kind: "moveTo", mailboxId: m.id }, targets, "Moved"),
      })),
    });
    setOverlay("move");
  }

  // Task 8: the folder context menu (design's `S.ctx.type === 'folder'`).
  // "Open folder" is real for any folder WITH a role -- exactly
  // `handleNavigateFolder`'s own condition (see its doc comment); a
  // custom folder's row is `disabled` in Sidebar already, so this never
  // even fires for one. "Mark all read" has no backend (TRIAGE_REASON).
  function openFolderMenu(mailbox: Mailbox, accountKey: string, evt: { clientX: number; clientY: number }): void {
    const items: ContextMenuItem[] = [
      {
        label: "Open folder",
        onSelect: mailbox.role !== null ? () => handleNavigateFolder(mailbox.role!, accountKey) : () => handleOpenMailbox(accountKey, mailbox.id),
      },
      {
        label: "Mark all read",
        hint: mailbox.unread > 0 ? String(mailbox.unread) : "0",
        onSelect: () => void markFolderRead(accountKey, mailbox.role !== null ? { role: mailbox.role } : { mailbox: mailbox.id }),
      },
    ];
    setContextMenuData({ x: evt.clientX, y: evt.clientY, items });
    setOverlay("contextmenu");
  }

  // Task 8: the saved-search context menu (design's `S.ctx.type ===
  // 'saved'`). "Run search" stays disabled -- Search.tsx owns its `query`
  // as uncontrolled local state with no prop this file can set it
  // through, so filling the search box from here would need a Search.tsx
  // change this task's scope doesn't cover (see the task report's open
  // list). "Remove from sidebar" IS real: it calls the actual
  // `DELETE`-shaped `api.removeSaved` (the same call Search.tsx's own
  // save/remove UI would make) and bumps `savedSearchesVersion` the same
  // way saving one already does, so Sidebar refetches.
  function openSavedSearchMenu(saved: SavedSearch, evt: { clientX: number; clientY: number }): void {
    const items: ContextMenuItem[] = [
      // Audit pass 7 F1e: this read "the saved-search menu can't fill the
      // search box in this plan" -- the prop it named as missing
      // (`Search`'s `requestedQuery`) was added in pass 1, and
      // `runSavedSearch` below is what the sidebar's own click already uses.
      { label: "Run search", hint: saved.query, onSelect: () => runSavedSearch(saved) },
      {
        label: "Remove from sidebar",
        danger: true,
        onSelect: () => {
          api
            .removeSaved(saved.id)
            .then(() => setSavedSearchesVersion((v) => v + 1))
            .catch((err: unknown) => handleApiError(err, "remove the saved search"));
        },
      },
    ];
    setContextMenuData({ x: evt.clientX, y: evt.clientY, items });
    setOverlay("contextmenu");
  }

  // Task 8: the thread/row context menu (design's `S.ctx.type ===
  // 'thread'`). "Open" is real (the same `handleOpenRow` a click already
  // uses); every triage action stays disabled with `TRIAGE_REASON`, and
  // "Move to…" opens the same honestly-disabled picker `openMessageMenu`
  // does.
  // F7 (design-fidelity Pass D, 2026-09-04): the design's row context
  // menu (Wilco.dc.html line ~1541-1553) has 11 items in this order --
  // Open, Reply, Forward, --, Mark read/unread, Flag, Select, Print, Move
  // to…, --, Archive, Mark spam/Not spam, Delete. An earlier pass reduced
  // this to 5 (dropping Reply/Forward/Mark read/Mark spam entirely and
  // omitting Select), reasoning it was "consistent with omit-don't-
  // invent" -- it is NOT: omit-don't-invent covers DATA with no source,
  // not actions the design itself specifies whose backend merely isn't
  // wired up yet, which is what the owner's standing "implement the
  // entire design as is... unwired means visible and explained, never
  // silently dead and never omitted" ruling covers. All 11 render here,
  // in the design's order, with its two separators; the ones with no
  // backend are `disabled` with a `title` explaining why, same pattern
  // as every other unwired control in this file (TRIAGE_REASON,
  // COMPOSE_REASON already exists for exactly this).
  function openThreadMenu(row: MessageListRow, evt: { clientX: number; clientY: number }): void {
    const inSpam = route.mailbox === "spam";
    const items: ContextMenuItem[] = [
      { label: "Open", hint: "⏎", onSelect: () => handleOpenRow({ account: row.account, id: row.id }) },
      { label: "Reply", hint: "r", onSelect: () => void openReply("reply", { account: row.account, id: row.id }) },
      { label: "Forward", hint: "f", onSelect: () => void openReply("forward", { account: row.account, id: row.id }) },
      { label: "", divider: true },
      // 🚨 Targeted at the RIGHT-CLICKED row, not the opened one. That is
      // the whole reason these were disabled: the `r`/`e`/`#` handlers all
      // run against `triageTargets()`, which returns the OPENED message,
      // and the two are routinely different. `runTriage` has always taken
      // an array, so a row-scoped target is all that was missing -- the
      // same thing the bulk bar needed in audit pass 1.
      //
      // The reason string they carried ("not yet available for a
      // multi-message selection") described a gap that was never theirs.
      {
        label: row.isUnread === true ? "Mark read" : "Mark unread",
        onSelect: () =>
          void runTriage(
            { kind: "read", value: row.isUnread === true },
            [{ account: row.account, id: row.id }],
            row.isUnread === true ? "Marked read" : "Marked unread",
          ),
      },
      {
        label: row.isFlagged === true ? "Unflag" : "Flag",
        hint: "s",
        onSelect: () =>
          void runTriage(
            { kind: "flag", value: row.isFlagged !== true },
            [{ account: row.account, id: row.id }],
            row.isFlagged === true ? "Unflagged" : "Flagged",
          ),
      },
      // "Select" IS real -- MessageList's checkbox state is the same one
      // `x` (`toggleSelectOpened`, above) already drives for the opened
      // row; this reaches the SAME element for whichever row was right-
      // clicked, not necessarily the opened one.
      {
        label: "Select",
        hint: "x",
        onSelect: () => {
          const selector = `[data-testid="checkbox-${CSS.escape(row.account)}-${CSS.escape(row.id)}"]`;
          document.querySelector<HTMLInputElement>(selector)?.click();
        },
      },
      // "Print" (Wilco.dc.html line ~1553): the message's print document
      // in a new window (row 33; PrintView.tsx).
      { label: "Print", onSelect: () => openPrint(row.account, row.id) },
      { label: "Move to…", onSelect: () => void openMoveTo(row.account, [{ account: row.account, id: row.id }]) },
      { label: "", divider: true },
      {
        label: "Archive",
        hint: "e",
        onSelect: () =>
          void runTriage({ kind: "move", role: "archive" }, [{ account: row.account, id: row.id }], "Archived"),
      },
      // 🚨 `{ kind: "spam" }`, NOT `{ kind: "move", role: "junk" }`.
      // Spec 7.6: Fastmail only learns from the folder its training points
      // at, and this account uses "Identified Spam". The old role=junk
      // binding filed spam where the filter never saw it (audit pass 2 F4).
      // The server resolves the per-account setting and REFUSES if none is
      // chosen, so a 400 here means "go pick one in Settings" -- which is
      // what `runTriage` surfaces in the banner.
      //
      // "Not spam" is still a plain move back to the inbox: there is no
      // per-account question about where non-spam lives.
      {
        label: inSpam ? "Not spam" : "Mark spam",
        onSelect: () =>
          void runTriage(
            inSpam ? { kind: "move", role: "inbox" } : { kind: "spam" },
            [{ account: row.account, id: row.id }],
            inSpam ? "Moved to inbox" : "Marked as spam",
          ),
      },
      {
        label: "Delete",
        hint: "#",
        danger: true,
        onSelect: () =>
          void runTriage({ kind: "move", role: "trash" }, [{ account: row.account, id: row.id }], "Deleted"),
      },
    ];
    setContextMenuData({ x: evt.clientX, y: evt.clientY, items });
    setOverlay("contextmenu");
  }

  // Shared across the three layout branches below, same reasoning as
  // `readingThread`/`readingAccountCode` above: Compose (design line
  // 367's `sc-if value="composeOpen"`) REPLACES the reading pane in the
  // main area, it never overlays it -- so this picks one or the other
  // once, rather than each of the three branches inventing its own
  // composeOpen check.
  /**
   * Run a triage action and show the undo toast.
   *
   * Rows are removed from the list optimistically for MOVES only -- a flag
   * or a read-toggle leaves the message where it is, and stripping it from
   * the list would make `s` look like it deleted something. On failure the
   * rows go back: the server already rolled its own state back, so leaving
   * the UI showing a message as archived when it is not would be a lie the
   * next sync silently corrects.
   */
  /**
   * Row 58 (owner ruling 2026-09-15): "archive/move act on conversations,
   * delete and spam act on the message only." A row is a conversation
   * (read-api collapses on the thread), so archiving only the open message
   * left the row standing on its siblings and the owner watched one
   * conversation "come back" twice. For archive and folder moves the
   * request names the folder in view; the server widens each target to the
   * thread's members in that folder. No scope when the rows ARE messages
   * (grouping off), in search results (no one folder is in view), or for
   * delete/spam -- and the server refuses to widen those two regardless.
   */
  function triageScope(action: TriageAction): TriageScope | undefined {
    const widens = action.kind === "moveTo" || (action.kind === "move" && action.role !== "trash");
    if (!widens) return undefined;
    if (prefs.groupConversations === "off" || searchState.active) return undefined;
    const r = routeRef.current;
    if (r.mailboxId !== undefined) return { kind: "conversation", mailboxId: r.mailboxId };
    return { kind: "conversation", role: r.mailbox };
  }

  async function runTriage(
    action: TriageAction,
    targets: TriageTarget[],
    verb: string,
  ): Promise<void> {
    if (targets.length === 0) return;
    // Spam is a move too (to the account's spam folder): it used to be left
    // out, so the row lingered until the sync round and the message stayed
    // open in the reading pane after the row had gone (owner, 2026-09-09).
    const isMove = action.kind === "move" || action.kind === "moveTo" || action.kind === "spam";
    const removed = isMove ? activeRows.filter((r) => targets.some((t) => t.account === r.account && t.id === r.id)) : [];
    const restoreRows = (): void => {
      if (removed.length === 0) return;
      setRowsState((prev) => {
        const base = prev ?? [];
        const have = new Set(base.map((r) => `${r.account} ${r.id}`));
        const merged = [...base, ...removed.filter((r) => !have.has(`${r.account} ${r.id}`))];
        merged.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
        return merged;
      });
    };

    const targetKeys = targets.map((t) => `${t.account}:${t.id}`);
    if (isMove) {
      // Advance off the message being moved BEFORE it leaves the list, or
      // the reading pane is left pointing at a message no longer shown.
      const cur = openedRef.current;
      if (cur !== null && targets.some((t) => t.account === cur.account && t.id === cur.id)) {
        advanceOff(targets);
      }
      for (const k of targetKeys) inFlightRemovalsRef.current.add(k);
      setRowsState((prev) => (prev ?? []).filter((r) => !targets.some((t) => t.account === r.account && t.id === r.id)));
    }
    // Whatever happens next, a refetch answered before this point is stale
    // (row 36); and a refetch that was discarded because of it gets its
    // fresh answer once we know the outcome.
    const settle = (): void => {
      for (const k of targetKeys) inFlightRemovalsRef.current.delete(k);
      triageGenRef.current += 1;
      if (staleDroppedRef.current) {
        staleDroppedRef.current = false;
        refreshListRef.current();
      }
    };

    try {
      const result = await api.triage(action, targets, triageScope(action));
      settle();
      if (result.applied === 0) {
        restoreRows();
        setBanner(result.failed[0]?.error ?? `Could not ${verb.toLowerCase()}.`);
        return;
      }
      if (result.failed.length > 0) setBanner(`${result.failed.length} of ${targets.length} failed.`);
      // Reflect a flag/read change locally, on the OPEN message as well as
      // its row (CHECKLIST row 8). The row used to catch up through the
      // sync round while the reading pane's own button stayed stale -- so
      // the next `s` read the old state and flagged it again.
      if (action.kind === "flag" || action.kind === "read") {
        const hit = (m: { account: string; id: string }): boolean =>
          targets.some((t) => t.account === m.account && t.id === m.id);
        const patch = action.kind === "flag" ? { isFlagged: action.value } : { isUnread: !action.value };
        setMessage((prev) => (prev !== null && hit(prev) ? { ...prev, ...patch } : prev));
        setRowsState((prev) => (prev ?? []).map((r) => (hit(r) ? { ...r, ...patch } : r)));
      }
      bumpMailboxes();
      const undoId = result.undoId;
      setToast({
        kind: "undo",
        label: `${verb} ${result.applied}`,
        onUndo:
          undoId === null
            ? undefined
            : () => {
                void (async () => {
                  try {
                    await api.undoTriage(undoId);
                    restoreRows();
                    bumpMailboxes();
                  } catch (err) {
                    setBanner(err instanceof Error ? err.message : "Undo failed.");
                  }
                  setToast(undefined);
                })();
              },
      });
    } catch (err) {
      settle();
      restoreRows();
      setBanner(err instanceof Error ? err.message : `Could not ${verb.toLowerCase()}.`);
    }
  }

  /**
   * Split a raw address field into structured addresses.
   *
   * Deliberately simple: comma/semicolon separated, with an optional
   * `Name <addr@host>` form. It does NOT try to be a full RFC 5322 parser --
   * a half-correct one that mangles a quoted display name containing a comma
   * would send to the wrong place, which is worse than rejecting. Anything
   * without an `@` is surfaced as an error rather than silently dropped.
   */
  function parseAddressField(raw: string): { ok: { email: string; name: string | null }[] } | { error: string } {
    const out: { email: string; name: string | null }[] = [];
    for (const piece of raw.split(/[,;]/)) {
      const s = piece.trim();
      if (s === "") continue;
      const angle = /^(.*?)<([^>]+)>$/.exec(s);
      const email = (angle ? angle[2]! : s).trim();
      const name = angle ? angle[1]!.trim().replace(/^"|"$/g, "") : "";
      if (!email.includes("@") || /\s/.test(email)) {
        return { error: `"${s}" is not an email address` };
      }
      out.push({ email, name: name === "" ? null : name });
    }
    return { ok: out };
  }

  /**
   * Opening a message that IS a draft reopens it for editing rather than
   * showing it in the reading pane. A draft is an unfinished message of the
   * user's own; rendering it as received mail -- with Reply and Forward
   * buttons pointed at themselves -- is the wrong affordance entirely.
   *
   * Keyed on the `$draft` keyword rather than on the route's mailbox: a
   * draft is a draft wherever it is listed (search results, All inboxes),
   * and the keyword is what Fastmail and every other client agree on.
   */
  useEffect(() => {
    if (message === null) return;
    if (message.keywords?.["$draft"] !== true) return;
    if (composeOpen) return;
    // A resumed draft opens as it was saved: its own HTML (sanitized by
    // the server) into the editor, and the quote source it carried in its
    // headers back into the panel (HTML compose spec 3.5). A draft whose
    // HTML cannot be read still opens, empty, with its fields.
    let live = true;
    const open = (html: string | null, quoteSource: { account: string; id: string; mode: "reply" | "forward" } | null) => {
      if (!live) return;
      setResumedHtml(html);
      setComposeDraft({
        account: message.account,
        to: message.to ?? [],
        cc: message.cc ?? [],
        subject: message.subject ?? "",
        quoted: message.bodyText ?? "",
        inReplyTo: null,
        references: null,
        ownAddressesKnown: true,
        sourceHasHtml: false,
        attribution: "",
        quoteSource,
        attachments: [],
      } as DraftPrefill);
      setResumedDraftId(message.id);
      setComposeMode(quoteSource === null ? "new" : quoteSource.mode === "forward" ? "forward" : "reply");
      setComposeOpen(true);
    };
    api.draftHtml(message.account, message.id).then(
      (d) => open(d.html, d.quoteSource),
      () => open(null, null),
    );
    return () => {
      live = false;
    };
    // `composeOpen` is deliberately not a dependency: this must fire when a
    // DRAFT is opened, not re-fire when the window it opened closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.account, message?.id]);

  /**
   * A toast dismisses itself.
   *
   * Keyed on the toast OBJECT, not its contents: every `setToast` builds a
   * fresh one, so archiving twice in a row restarts the clock rather than
   * letting the second toast inherit the first's remaining time. That is
   * what the design's `clearTimeout(this.undoTimer)` does at the top of
   * `pushUndo`.
   *
   * Dismissing early — `z`, the Undo button, the notification's ✕ — already
   * clears `toast`, and this effect's cleanup cancels the pending timer, so
   * a stale timer cannot dismiss a toast that replaced the one it was for.
   */
  useEffect(() => {
    if (toast === undefined) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS[toast.kind]);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * Read-on-open, after a ~1s dwell (spec 7.3).
   *
   * 🚨 This is the fix the spec calls Dovetail's largest: "opening a message
   * never marked it read... anything read in Dovetail stayed unread on every
   * other device". It had never been built here either — audit pass 2 found
   * that `App.tsx` contained no `setTimeout` at all, while a comment on
   * `moveSelection` asserted the dwell as the reason `j`/`k` previewing is
   * safe. The mechanism was described and absent.
   *
   * The DWELL is the whole point. Marking read on arrival would make a
   * `j`-sweep down the list mark every message it passed through, on the
   * server, on every device. One second is long enough that passing over a
   * row costs nothing and short enough that actually reading one always
   * counts.
   *
   * Deliberately NOT routed through `runTriage`: this is not a user action
   * and must not raise an undo toast or touch the undo stack — `z` after
   * reading a message has to undo whatever the user last DID, not the fact
   * that they read something. It also does not remove the row (a read
   * message stays exactly where it is), so there is nothing to roll back
   * beyond the flag, which the next sync corrects anyway.
   *
   * A failure is swallowed on purpose. The user asked to read a message,
   * not to mark one; a banner saying "could not mark as read" over a
   * message they are reading is noise about a thing they did not request.
   */
  useEffect(() => {
    if (message === null || message.isUnread !== true) return;
    const target = { account: message.account, id: message.id };
    // The markRead preference (row 37): "manual" never marks on open;
    // "instant" marks at once; "after2s" is the dwell.
    if (prefs.markRead === "manual") return;
    const dwellMs = prefs.markRead === "instant" ? 0 : READ_ON_OPEN_DWELL_MS;
    const timer = setTimeout(() => {
      // The reader may have moved on -- or deleted this message -- since
      // the timer was set; the timer is cleared when the LOADED message
      // changes, which lags the route by a fetch. Mark read only what is
      // still open (row 36's side finding: a delete followed by a stray
      // mark-read of the deleted message).
      const cur = openedRef.current;
      if (cur === null || cur.account !== target.account || cur.id !== target.id) return;
      void (async () => {
        try {
          await api.triage({ kind: "read", value: true }, [target]);
        } catch {
          return; // see above: not the user's request, not their problem
        }
        // Reflect it locally so the row's unread dot and the sidebar count
        // update now rather than on the next sync round.
        setMessage((prev) =>
          prev !== null && prev.account === target.account && prev.id === target.id
            ? { ...prev, isUnread: false }
            : prev,
        );
        setRowsState((prev) =>
          (prev ?? []).map((r) => (r.account === target.account && r.id === target.id ? { ...r, isUnread: false } : r)),
        );
        bumpMailboxes();
      })();
    }, dwellMs);
    // Cleared when the opened message changes or the pane closes, so a
    // message passed THROUGH never fires its own timer.
    return () => clearTimeout(timer);
  }, [message?.account, message?.id, message?.isUnread, api, prefs.markRead]);

  /**
   * Spec 7.4's `1`...`9`: download the nth attachment of the open message.
   *
   * 🚨 Mints a FRESH capability URL rather than reusing whatever the reading
   * pane holds. Body tokens are short-lived by design (spec 6), and the
   * pane's may have been minted minutes ago when the message was opened --
   * a key that works when you open a message and silently 401s once you have
   * read it is worse than one that does not exist.
   *
   * The download is an anchor click, not a fetch: the bytes come back with
   * `Content-Disposition: attachment` on a different origin, so letting the
   * browser navigate is what turns them into a file. A fetch would need CORS
   * the body origin deliberately does not grant.
   *
   * INLINE PARTS ARE NOT COUNTED. `n` indexes the attachment chips a person
   * can see, which is `attachments` -- the inline `cid:` images rendered
   * inside the message are a separate list (spec 4.1) and are not chips.
   * Counting them would make `2` mean different files depending on whether
   * the sender used an inline logo.
   */
  async function saveAttachment(n: number): Promise<void> {
    if (opened === null) return;
    try {
      const body = await api.bodyUrl(opened.account, opened.id, {});
      const attachment = body.attachments[n - 1];
      if (attachment === undefined) {
        // Silent: pressing `3` on a message with two attachments is a
        // mis-key, not an error worth a banner.
        return;
      }
      const a = document.createElement("a");
      a.href = attachment.url;
      // The server already sends the filename in Content-Disposition; this
      // is the same value, and it keeps the name if a browser ever prefers
      // the attribute.
      a.download = attachment.name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      handleApiError(err, "download that attachment");
    }
  }

  /** Open compose prefilled from the message on screen. The prefill is
   *  computed SERVER-side (src/core/reply.ts) so the rules about who a
   *  reply goes to are tested once, not reimplemented in the client. */
  async function openReply(
    mode: "reply" | "reply-all" | "forward",
    // Which message to reply TO. Defaults to the opened one, which is what
    // the `r`/`f` keys mean. The row context menu passes the RIGHT-CLICKED
    // row instead -- audit pass 7 F1a found those two menu items disabled
    // with "there is no send path in this codebase yet" while `r` and `f`
    // both worked, so the menu was telling the user a capability was
    // missing that the same gesture's keyboard equivalent already had.
    target: MessageListSelection | null = openedRef.current,
  ): Promise<void> {
    if (target === null) return;
    try {
      const prefill = await api.draftFor(target.account, target.id, mode);
      // Remembered for archiveOnReply (row 37): the message this reply is
      // to, archived once the reply has gone. A forward is not a reply.
      replySourceRef.current = mode === "forward" ? null : { account: target.account, id: target.id };
      setComposeDraft(prefill);
      setComposeMode(mode === "forward" ? "forward" : "reply");
      setComposeOpen(true);
      if (!prefill.ownAddressesKnown && mode === "reply-all") {
        setBanner("Could not read this account's aliases, so reply-all may include your own address. Check the Cc line.");
      }
    } catch (err) {
      handleApiError(err, "prepare that reply");
    }
  }

/** Render structured addresses back into the raw string the compose
 *  fields hold. Quotes a display name containing a comma, or the field
 *  would re-split it into two bogus recipients on send. */
function fmtAddrs(list: { email: string; name: string | null }[]): string {
  return list
    .map((a) => {
      if (a.name === null || a.name === "") return a.email;
      const name = /[,;<>"]/.test(a.name) ? `"${a.name.replace(/"/g, "")}"` : a.name;
      return `${name} <${a.email}>`;
    })
    .join(", ");
}

  /**
   * Autosave. Unlike `sendDraft` this must NOT throw on an incomplete
   * message: a draft with no recipient, or with an address still being
   * typed, is the normal state of one. So addresses that do not parse yet
   * are simply omitted from the saved copy rather than failing the save and
   * telling the user their work is not being kept.
   */
  async function saveComposeDraft(draft: OutgoingDraft, draftId: string | null): Promise<string> {
    const bar = draft.from.indexOf("|");
    const account = bar === -1 ? draft.from : draft.from.slice(0, bar);
    const fromEmail = bar === -1 ? "" : draft.from.slice(bar + 1);

    const addrs = (raw: string) => {
      const r = parseAddressField(raw);
      return "error" in r ? [] : r.ok;
    };

    const res = await api.saveDraft({
      account,
      from: fromEmail,
      to: addrs(draft.to),
      cc: addrs(draft.cc),
      bcc: addrs(draft.bcc),
      subject: draft.subject,
      html: draft.html,
      // Row 44: the quoted original is IN the editor's HTML; the server
      // attaches nothing. (`quoteSource` remains for API callers.)
      quoteSource: null,
      signaturePlacement: prefs.signaturePlacement,
      inReplyTo: composeDraft?.inReplyTo ?? null,
      references: composeDraft?.references ?? null,
      draftId,
      attachments: draft.attachments
        .filter((a) => a.blobId !== undefined && a.account !== undefined)
        .map((a) => ({
          account: a.account!,
          blobId: a.blobId!,
          name: a.name,
          type: a.type ?? "application/octet-stream",
          size: a.bytes ?? 0,
        })),
    });
    return res.draftId;
  }

  /** Writes a signature to its JMAP Identity, then re-reads the identities
   *  so the compose preview reflects it without a reload. The server's own
   *  identity cache was invalidated by the write. */
  async function saveSignature(
    account: string,
    identityId: string,
    textSignature: string,
    htmlSignature?: string,
  ): Promise<void> {
    await api.saveSignature(account, identityId, textSignature, htmlSignature);
    const { identities } = await api.identities();
    setAccountSpecs((prev) =>
      prev.map((spec) => {
        const list = identities[spec.key] ?? [];
        if (list.length === 0) return spec;
        return {
          ...spec,
          identities: list.map((i) => ({
            id: i.id,
            email: i.email,
            name: i.name,
            primary: i.primary,
            textSignature: i.textSignature,
            htmlSignature: i.htmlSignature,
          })),
        } as AccountSpec;
      }),
    );
  }

  /** The signature the composer inserts (HTML compose spec 3.2): null when
   *  the account's switch for this kind of message is off (row 37: absent
   *  means on), else the identity's sanitized signature document. */
  async function loadSignatureFor(account: string, identityId: string): Promise<{ html: string; text: string } | null> {
    try {
      const st = (await api.accountSettings(account)).settings;
      const key = composeMode === "reply" ? "signatureReplies" : "signatureNew";
      if ((st[key] ?? "on") === "off") return null;
    } catch {
      // Unknown settings: the signature goes in, as it always has.
    }
    return api.signatureHtml(account, identityId);
  }

  async function sendDraft(draft: OutgoingDraft): Promise<void> {
    // The `from` select's value is "<accountKey>|<email>"; with no
    // identities loaded it is the bare account key and there is no address
    // to send as, which the server would reject anyway -- say so here.
    const bar = draft.from.indexOf("|");
    if (bar === -1) throw new Error("No sending address is available for this account.");
    const account = draft.from.slice(0, bar);
    const fromEmail = draft.from.slice(bar + 1);

    const fields: { key: "to" | "cc" | "bcc"; raw: string }[] = [
      { key: "to", raw: draft.to },
      { key: "cc", raw: draft.cc },
      { key: "bcc", raw: draft.bcc },
    ];
    const parsed: Record<string, { email: string; name: string | null }[]> = {};
    for (const f of fields) {
      const r = parseAddressField(f.raw);
      if ("error" in r) throw new Error(`${f.key.toUpperCase()}: ${r.error}`);
      parsed[f.key] = r.ok;
    }
    if ((parsed["to"] ?? []).length === 0) throw new Error("Add at least one recipient.");

    await api.send({
      account,
      from: fromEmail,
      to: parsed["to"]!,
      cc: parsed["cc"],
      bcc: parsed["bcc"],
      subject: draft.subject,
      // HTML compose (2026-09-07): what is on screen is what goes out. The
      // signature is IN the editor's HTML wherever the owner left it; the
      // server attaches the quoted original and derives the text half.
      html: draft.html,
      // Row 44: the quoted original is IN the editor's HTML; the server
      // attaches nothing. (`quoteSource` remains for API callers.)
      quoteSource: null,
      signaturePlacement: prefs.signaturePlacement,
      inReplyTo: composeDraft?.inReplyTo ?? null,
      references: composeDraft?.references ?? null,
      // Only chips that finished uploading. A chip still in flight, or one
      // that failed, has no blob -- Compose blocks Send while any exist, so
      // reaching here with one would be a bug, and dropping it silently
      // would send a message the user believes carries a file.
      attachments: draft.attachments
        .filter((a) => a.blobId !== undefined && a.account !== undefined)
        .map((a) => ({
          account: a.account!,
          blobId: a.blobId!,
          name: a.name,
          type: a.type ?? "application/octet-stream",
          size: a.bytes ?? 0,
        })),
    });
    // archiveOnReply (row 37): the message this reply was to leaves the
    // inbox once the reply has gone. Same triage path as `e`.
    const source = replySourceRef.current;
    replySourceRef.current = null;
    if (prefs.archiveOnReply === "on" && source !== null && composeMode === "reply") {
      void runTriage({ kind: "move", role: "archive" }, [source], "Archived");
    }
    // Row 42 (owner, 2026-09-07: "I just got a toast for a message I sent,
    // not received"). This confirmation used to be built as a NOTIFICATION
    // card -- sender, subject, the new-mail chrome -- with the owner's own
    // address as the sender. A sent message is not news; it gets the plain
    // label toast every other action gets.
    setToast({ kind: "undo", label: `Sent: ${draft.subject === "" ? "(no subject)" : draft.subject}` });
  }

  /** The messages an action applies to.
   *
   *  Currently the OPEN message only. The design's bulk action bar acts on
   *  the checkbox selection, but that selection is `MessageList`'s own
   *  `checked` state and is not lifted to App yet -- reading it from here
   *  would mean either duplicating the state (two sources of truth for
   *  "what is selected", which drift) or a refactor that does not belong
   *  in the change that makes triage work at all. Bulk triage is the next
   *  step, not a silent omission. */
  /** Sidebar saved search clicked (design's `ss.select`). Runs it in the
   *  search pane, and on narrow viewports closes the drawer -- the results
   *  are behind it. */
  function runSavedSearch(saved: { query: string }): void {
    setRequestedQuery((prev) => ({ value: saved.query, token: (prev?.token ?? 0) + 1 }));
    setDrawerOpen(false);
  }

  function triageTargets(): TriageTarget[] {
    const cur = openedRef.current;
    if (cur !== null) return [{ account: cur.account, id: cur.id }];
    return [];
  }

  const readingPane = composeOpen ? (
    <Compose
      accounts={accountSpecs}
      mode={composeMode}
      replySubject={composeDraft?.subject}
      initialTo={composeDraft ? fmtAddrs(composeDraft.to) : undefined}
      initialCc={composeDraft ? fmtAddrs(composeDraft.cc) : undefined}
      initialSubject={composeDraft?.subject}
      initialHtml={resumedDraftId !== null ? resumedHtml : null}
      loadSignature={loadSignatureFor}
      signaturePlacement={prefs.signaturePlacement}
      quote={
        composeDraft?.quoteSource && prefs.quoteHistory !== "off"
          ? {
              mode: composeDraft.quoteSource.mode,
              attribution: composeDraft.attribution,
              html: composeDraft.quoteHtml ?? null,
              text: composeDraft.quoteText ?? composeDraft.quoted ?? null,
            }
          : null
      }
      // A forward's inherited attachments (row 14): already blobs in the
      // source account, so they open as READY chips -- nothing to upload.
      // Switching the From account has no File to re-upload from; the send
      // then refuses the foreign blob by name, which is the honest failure.
      attachments={composeDraft?.attachments.map((a) => ({
        name: a.name,
        size: formatSize(a.size),
        blobId: a.blobId,
        type: a.type,
        bytes: a.size,
        account: composeDraft.account,
      }))}
      onClose={() => {
        setComposeOpen(false);
        setComposeDraft(null);
        setComposeMode("new");
        setResumedDraftId(null);
        setResumedHtml(null);
      }}
      onSend={sendDraft}
      onUpload={(account, file, onProgress) => api.uploadAttachment(account, file, onProgress)}
      lookupContacts={(q, from) => api.contacts(q, from).then((r) => r.contacts)}
      lookupHabits={(emails) => api.contactHabits(emails).then((r) => r.habits)}
      initialDraftId={resumedDraftId}
      // A resumed draft was saved when it was last written -- show that
      // time rather than a blank one (v1.1 #4).
      initialSavedAt={
        resumedDraftId !== null && message !== null
          ? new Date(message.receivedAt).toTimeString().slice(0, 5)
          : null
      }
      initialAccount={composeDraft?.account}
      onSaveDraft={saveComposeDraft}
      onDiscardDraft={(account, draftId) => api.discardDraft(account, draftId).then(() => undefined)}
    />
  ) : (
    <Reading
      message={message}
      accent={message !== null ? accents[message.account] : undefined}
      thread={readingThread}
      accountCode={readingAccountCode}
      onPrev={() => moveSelection(-1)}
      onNext={() => moveSelection(1)}
      onMessageMenu={openMessageMenu}
      onAttachmentClick={openAttachmentPreview}
      loadBodyUrl={loadBodyUrl}
      remoteImagesDefault={prefs.remoteImages === "always"}
      onAlwaysAllowImages={(account, sender) => api.allowSenderImages(account, sender).then(() => undefined)}
      onArchive={() => void runTriage({ kind: "move", role: "archive" }, triageTargets(), "Archived")}
      onSpam={() => void runTriage({ kind: "spam" }, triageTargets(), "Marked as spam")}
      onDelete={() => void runTriage({ kind: "move", role: "trash" }, triageTargets(), "Deleted")}
      onReply={() => void openReply(prefs.replyAllDefault === "on" ? "reply-all" : "reply")}
      onFooterReply={() => void openReply("reply")}
      onReplyAll={() => void openReply("reply-all")}
      onForward={() => void openReply("forward")}
      onPrint={message !== null ? () => openPrint(message.account, message.id) : undefined}
      unsubscribe={unsubscribeMethod}
      onUnsubscribe={() => void runUnsubscribe()}
      onToggleFlag={() =>
        void runTriage({ kind: "flag", value: message?.isFlagged !== true }, triageTargets(), message?.isFlagged === true ? "Unflagged" : "Flagged")
      }
    />
  );

  // The list actually on screen -- the folder view's `rows`, or search's
  // results while a search is active. `j`/`k`/`x`/`open` all key off this
  // instead of `rows` directly, which is the fix for the round-11 review
  // finding: Search swaps its children out for results while `rows` kept
  // holding the folder underneath, so the keyboard layer walked/toggled
  // messages that weren't even rendered.
  const activeRows: EmailRow[] = searchState.active ? searchState.rows : (rows ?? []);

  // `j`/`k`: move to the next/previous row in the CURRENTLY DISPLAYED
  // list and open it. The read-on-open dwell below is what keeps this
  // safe -- previewing with j/k doesn't mark anything read, only a ~1s
  // stop does, so sweeping through with the keyboard costs nothing.
  // Keyed by (account, id) against the active list, never an index,
  // matching store.ts's rule for the same reason: a server-pushed
  // reorder must not make j/k land on the wrong message.
  /**
   * The open message is leaving the list: show the next available one, or
   * nothing. "Next" is the row below, then the row above; on the last
   * loaded row of a folder with more pages, the next page's first row.
   * With nothing available the reading pane closes -- `moveSelection(1)`
   * used to clamp on the last row and RE-OPEN the message that was being
   * removed, so an archived last message stayed on screen (owner,
   * 2026-09-09: "Message body should disappear").
   */
  function advanceOff(leaving: TriageTarget[]): void {
    const cur = openedRef.current;
    const gone = (r: { account: string; id: string }): boolean => leaving.some((t) => t.account === r.account && t.id === r.id);
    const idx = cur !== null ? activeRows.findIndex((r) => r.account === cur.account && r.id === cur.id) : -1;
    const below = activeRows.slice(idx + 1).find((r) => !gone(r));
    const above = idx > 0 ? [...activeRows.slice(0, idx)].reverse().find((r) => !gone(r)) : undefined;
    if (below !== undefined) return void handleOpenRow({ account: below.account, id: below.id });
    if (!searchState.active && rowsCursor !== null) {
      void loadMore().then((appended) => {
        const first = appended.find((r) => !gone(r));
        if (first !== undefined) handleOpenRow({ account: first.account, id: first.id });
        else if (above !== undefined) handleOpenRow({ account: above.account, id: above.id });
        else closeMessage();
      });
      return;
    }
    if (above !== undefined) return void handleOpenRow({ account: above.account, id: above.id });
    closeMessage();
  }

  function moveSelection(direction: 1 | -1): void {
    if (activeRows.length === 0) return;
    const cur = openedRef.current;
    const currentIndex = cur !== null ? activeRows.findIndex((r) => r.account === cur.account && r.id === cur.id) : -1;
    // `j` on the last LOADED row of a folder is not the end of the list
    // while the server still holds a cursor: fetch the next page and land
    // on its first row. Clamping here (the previous behaviour) re-opened
    // the same row and the walk stopped dead at the page boundary
    // (CHECKLIST row 7). Search results page on scroll only -- `Search`
    // owns that cursor -- so this applies to the folder list alone.
    if (direction === 1 && currentIndex === activeRows.length - 1 && !searchState.active && rowsCursor !== null) {
      void loadMore().then((appended) => {
        const first = appended[0];
        if (first !== undefined) handleOpenRow({ account: first.account, id: first.id });
      });
      return;
    }
    const nextIndex =
      currentIndex === -1 ? (direction === 1 ? 0 : activeRows.length - 1) : clamp(currentIndex + direction, 0, activeRows.length - 1);
    const target = activeRows[nextIndex];
    if (target !== undefined) handleOpenRow({ account: target.account, id: target.id });
  }

  // `x`: toggles the currently opened row's checkbox. MessageList owns
  // that state internally (it's purely local multi-select, per its own
  // module comment) and exposes no imperative API for it -- clicking its
  // real checkbox element is the one existing, real way to flip it
  // without duplicating that state up here. A no-op during an active
  // search: Search renders no checkboxes at all (it has no bulk-action
  // surface, matching MessageList's folder-only scope), so there is
  // nothing for `x` to toggle there -- rather than querying the DOM for
  // an element that can never exist, this says so explicitly.
  function toggleSelectOpened(): void {
    if (opened === null || searchState.active) return;
    // CSS.escape: `opened.id`/`opened.account` are opaque server strings
    // (spec 4.2), not guaranteed to be attribute-selector-safe -- an id
    // containing `"` or `]` (e.g. `/inbox/personal/a"]`) would otherwise
    // throw a SyntaxError out of this keydown handler instead of just
    // finding no element.
    const selector = `[data-testid="checkbox-${CSS.escape(opened.account)}-${CSS.escape(opened.id)}"]`;
    const el = document.querySelector<HTMLInputElement>(selector);
    el?.click();
  }

  function focusSearch(): void {
    document.querySelector<HTMLInputElement>('[data-testid="search"]')?.focus();
  }

  function closeTopmost(): void {
    if (paletteOpen) {
      setPaletteOpen(false);
      return;
    }
    if (overlay !== "none") {
      setOverlay("none");
      return;
    }
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    // Escape's other job (spec 7.4): leaving whatever text field has
    // focus, since it's the one command bound to fire even from inside
    // one (keymap.ts's `resolve`).
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      active.blur();
      return;
    }
    // Compose owns Escape while it is open (Compose.tsx's own window
    // listener closes the sheet); the message underneath must not close
    // with it.
    if (composeOpen) return;
    // Nothing on top and no field to leave: Escape closes the open
    // message (DESIGN.md "esc close", CHECKLIST row 7). Route only --
    // the folder and its filter are kept, so the list does not change.
    if (opened !== null) {
      h.push(routeToPath({ mailbox: route.mailbox, filter: route.filter, mailboxId: route.mailboxId, account: null, id: null }));
    }
  }

  // Settings' Theme row (Task 6) sets a SPECIFIC value ("Light"/"Dark"
  // are two buttons, not one flip) -- `toggleTheme` below (Sidebar's icon
  // button, the `t` command) stays a pure toggle and is now defined in
  // terms of this, rather than duplicating the `data-theme` write.
  // Row 37: theme, density and layout are PREFERENCES -- stored on the
  // server, loaded at boot, written on every change (the `t`/`v` keys
  // included). They used to be plain component state and reset on reload.
  function persistPreference(key: "theme" | "density" | "layout", value: string): void {
    api.setPreference(key, value).catch((err: unknown) => handleApiError(err, "save your preference"));
  }
  function applyTheme(next: "light" | "dark", opts: { persist?: boolean } = {}): void {
    document.documentElement.setAttribute("data-theme", next);
    // Mirrored on EVERY apply, the boot-time one included, so the next load
    // paints this theme before the server has answered (row 49).
    rememberTheme(next);
    setTheme(next);
    if (opts.persist !== false) persistPreference("theme", next);
  }
  function toggleTheme(): void {
    applyTheme(theme === "light" ? "dark" : "light");
  }
  function applyDensity(next: "comfortable" | "compact", opts: { persist?: boolean } = {}): void {
    setDensity(next);
    if (opts.persist !== false) persistPreference("density", next);
  }
  function applyLayout(next: "columns" | "rows", opts: { persist?: boolean } = {}): void {
    setLayout(next);
    if (opts.persist !== false) persistPreference("layout", next);
  }
  useEffect(() => {
    let cancelled = false;
    api
      .preferences()
      .then((r) => {
        if (cancelled) return;
        // A malformed answer must not take the app down with it (main.test's
        // empty backend answered `[]` here and the whole tree failed to
        // render): defaults stand. The object itself is kept, not copied.
        const p = r?.preferences;
        const loaded: Preferences = p !== null && typeof p === "object" ? p : { ...DEFAULT_PREFERENCES };
        setPrefs(loaded);
        setPrefsLoaded(true);
        applyTheme(loaded.theme, { persist: false });
        applyDensity(loaded.density, { persist: false });
        applyLayout(loaded.layout, { persist: false });
      })
      .catch(() => {
        // Defaults stand; a failed read is not worth a banner at boot.
        if (!cancelled) setPrefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  function stepFolder(direction: 1 | -1): void {
    const currentIndex = FOLDER_ORDER.indexOf(route.mailbox);
    const base = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (base + direction + FOLDER_ORDER.length) % FOLDER_ORDER.length;
    h.push(routeToPath({ mailbox: FOLDER_ORDER[nextIndex]!, filter: route.filter, account: null, id: null }));
  }

  // The dispatch table `COMMANDS[i].handler` calls into. Rebuilt on every
  // render (cheap -- plain function refs) so it always closes over the
  // latest `route`/`rows`/`opened`/etc., matching how the keydown effect
  // below re-registers on the same deps.
  const commandContext: CommandContext = {
    next: () => moveSelection(1),
    prev: () => moveSelection(-1),
    open: () => {
      if (opened === null && activeRows.length > 0) handleOpenRow({ account: activeRows[0]!.account, id: activeRows[0]!.id });
    },
    select: toggleSelectOpened,
    allInboxes: handleAllInboxes,
    layout: () => applyLayout(layout === "columns" ? "rows" : "columns"),
    theme: toggleTheme,
    search: focusSearch,
    palette: () => setPaletteOpen(true),
    overlay: () => setOverlay("shortcuts"),
    close: closeTopmost,
    folderPrev: () => stepFolder(-1),
    folderNext: () => stepFolder(1),
    gotoTop: () => window.scrollTo({ top: 0 }),
    gotoInbox: () => h.push(routeToPath({ mailbox: "inbox", filter: null, account: null, id: null })),
    // The design's g d / g s / g t / g a. Keeps the current account scope,
    // matching how `[`/`]` already step folders.
    gotoFolder: (role: string) => h.push(routeToPath({ mailbox: role, filter: route.filter, account: null, id: null })),
    // g f is a SEARCH, not a route -- flagged mail is in every folder.
    gotoFlagged: () => runSavedSearch({ query: "is:flagged" }),
    archive: () => void runTriage({ kind: "move", role: "archive" }, triageTargets(), "Archived"),
    deleteMessage: () => void runTriage({ kind: "move", role: "trash" }, triageTargets(), "Deleted"),
    flag: () => void runTriage({ kind: "flag", value: message?.isFlagged !== true }, triageTargets(), message?.isFlagged === true ? "Unflagged" : "Flagged"),
    // `z` re-invokes whatever the visible undo toast offers -- the toast is
    // the single source of "what is undoable", so the key and the button can
    // never disagree about which batch they act on.
    undo: () => {
      if (toast !== undefined && toast.kind === "undo") toast.onUndo?.();
    },
    // replyAllDefault (row 37): `r` and the Reply button mean reply-all.
    reply: () => void openReply(prefs.replyAllDefault === "on" ? "reply-all" : "reply"),
    replyAll: () => void openReply("reply-all"),
    forward: () => void openReply("forward"),
    compose: () => setComposeOpen(true),
    settings: () => setSettingsOpen(true),
    saveAttachment: (n: number) => void saveAttachment(n),
  };

  function runCommand(id: CommandId): void {
    const cmd = COMMANDS.find((c) => c.id === id);
    cmd?.handler?.(commandContext);
  }

  // The global keyboard layer (Task 10, spec 7.4/7.3). One `window`
  // listener for the whole app -- keymap.ts's `resolve`/`feed` are the
  // only things that decide whether a keystroke is a command, a chord in
  // progress, or plain text; this effect just wires their answer to
  // `runCommand`. Deps mirror everything `commandContext` closes over, so
  // a stale closure never fires last render's `route`/`rows`.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const target = e.target;
      const targetTag = target instanceof HTMLElement ? target.tagName : undefined;
      const isContentEditable = target instanceof HTMLElement && target.isContentEditable;

      // "g" starts (or continues) a chord -- fed to chordState/feed
      // BEFORE resolve() gets a look, so the second keystroke of "g i"
      // never also matches a single-key binding of its own, and "g"
      // itself never falls through resolve()'s (deliberately empty)
      // handling of it. Chords, like every other command, are inert
      // inside a text field.
      const inText = targetTag === "INPUT" || targetTag === "TEXTAREA" || isContentEditable === true;
      const chords = chordRef.current as unknown as { pending: string | null };
      const isChordStart = e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey && chords.pending === null;
      const isChordContinuation = chords.pending !== null;
      if (!inText && (isChordStart || isChordContinuation)) {
        const now = Date.now();
        if (isChordContinuation) {
          // Advance the chord's virtual clock by the REAL wall-clock time
          // since it became pending -- the only thing that makes feed()'s
          // timeout check (spec 7.4: "a stale g must not fire a command
          // seconds later") a property of the running app rather than of
          // a test calling advance() itself.
          chordRef.current.advance(now - chordAnchorRef.current);
        }
        const result = feed(chordRef.current, e.key);
        if ((chordRef.current as unknown as { pending: string | null }).pending !== null) {
          chordAnchorRef.current = now;
        }
        if (result !== null) {
          e.preventDefault();
          runCommand(result);
        }
        return;
      }

      const commandId = resolve({
        key: e.key,
        targetTag,
        isContentEditable,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
      });
      if (commandId !== null) {
        e.preventDefault();
        runCommand(commandId);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [route.mailbox, route.filter, opened, rows, searchState, paletteOpen, overlay, settingsOpen, composeOpen, h, message, toast]);

  // The palette's item list: keymap.ts's enabled COMMANDS (excluding the
  // chord targets, which aren't user-facing entries of their own) plus a
  // "go to mailbox" entry per FOLDER_ORDER and a "go to account" entry
  // per fetched account. Assembled here rather than inside Palette.tsx
  // itself so that component stays ignorant of routes/accounts, matching
  // Search/MessageList's existing division of labor.
  const paletteItems: PaletteItem[] = useMemo(() => {
    const commandItems: PaletteItem[] = COMMANDS.filter((c) => !c.id.startsWith("goto:")).map((c) => ({
      id: `cmd:${c.id}`,
      label: c.label,
      hint: c.keys,
      disabledReason: c.disabledReason,
    }));
    const mailboxItems: PaletteItem[] = FOLDER_ORDER.map((m) => ({
      id: `mailbox:${m}`,
      label: `Go to ${m[0]!.toUpperCase()}${m.slice(1)}`,
      hint: "Mailbox",
    }));
    const accountItems: PaletteItem[] = Object.keys(accents).map((key) => ({
      id: `account:${key}`,
      label: `Go to ${key[0]!.toUpperCase()}${key.slice(1)}`,
      hint: "Account",
    }));
    // Saved searches (DESIGN.md 5 lists them explicitly; design `:1270-1287`
    // renders one `◎ Search: {label}` per saved query). `runSavedSearch`
    // has run one from outside the search pane since audit pass 1, so this
    // is a list plus a select, not a feature.
    const savedItems: PaletteItem[] = savedSearches.map((ss) => ({
      id: `saved:${ss.id}`,
      label: `Search: ${ss.name}`,
      hint: "Saved",
    }));
    return [...commandItems, ...mailboxItems, ...accountItems, ...savedItems];
  }, [accents, savedSearches]);

  /**
   * Live mail results for the palette (audit pass 3 D4).
   *
   * 🚨 The gap this closes: the palette advertises itself as "anything" and
   * mail was the one thing it could not find.
   *
   * Debounced, and only from two characters up — a palette that fires a
   * full-corpus search on every keystroke is a palette that makes the box
   * work harder than the person using it. Capped at the design's four.
   */
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteMail, setPaletteMail] = useState<EmailRow[]>([]);
  useEffect(() => {
    const q = paletteQuery.trim();
    if (!paletteOpen || q.length < 2) {
      setPaletteMail([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .search(q)
        .then((result) => {
          if (!cancelled) setPaletteMail(result.rows.slice(0, 4));
        })
        // A palette that cannot search is a palette with fewer rows, not an
        // error worth a banner over.
        .catch(() => undefined);
    }, PALETTE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paletteQuery, paletteOpen, api]);

  const paletteMailItems: PaletteItem[] = paletteMail.map((row) => ({
    id: `mail:${row.account}:${row.id}`,
    label: `${row.fromName !== "" ? row.fromName : row.fromEmail} — ${row.subject}`,
    hint: "Mail",
  }));

  function handlePaletteSelect(id: string): void {
    if (id.startsWith("mail:")) {
      // `mail:<account>:<id>` -- split on the FIRST two colons only: a
      // message id can contain one, and an account key never does.
      const rest = id.slice("mail:".length);
      const cut = rest.indexOf(":");
      handleOpenRow({ account: rest.slice(0, cut), id: rest.slice(cut + 1) });
      return;
    }
    if (id.startsWith("saved:")) {
      const saved = savedSearches.find((ss) => ss.id === id.slice("saved:".length));
      if (saved !== undefined) runSavedSearch(saved);
      return;
    }
    if (id.startsWith("cmd:")) {
      runCommand(id.slice(4) as CommandId);
      return;
    }
    if (id.startsWith("mailbox:")) {
      h.push(routeToPath({ mailbox: id.slice(8), filter: null, account: null, id: null }));
      return;
    }
    if (id.startsWith("account:")) {
      h.push(routeToPath({ mailbox: route.mailbox, filter: id.slice(8), account: null, id: null }));
    }
  }

  function handleListDragStart(): void {
    dragBaseRef.current = listWidth;
  }
  function handleListDrag(deltaX: number): void {
    setListWidth(clamp(dragBaseRef.current + deltaX, LIST_WIDTH_MIN, LIST_WIDTH_MAX));
  }

  function handleRowDragStart(): void {
    dragBaseRef.current = rowHeightPct;
  }
  function handleRowDrag(deltaY: number): void {
    // No layout engine backs the shell's own container in a test
    // environment, so the drag is read against the viewport height as
    // the best available stand-in for "the pane's height" -- real usage
    // runs in a real, laid-out viewport, and this task carries no test
    // that exercises the rows divider's math.
    const containerHeight = window.innerHeight || 800;
    const deltaPct = (deltaY / containerHeight) * 100;
    setRowHeightPct(clamp(dragBaseRef.current + deltaPct, ROW_HEIGHT_MIN_PCT, ROW_HEIGHT_MAX_PCT));
  }

  const shellStyle: JSX.CSSProperties = {
    display: "flex",
    flexDirection: layout === "columns" ? "row" : "column",
    width: "100%",
    height: "100%",
  };

  function closeMessage(): void {
    h.push(routeToPath({ mailbox: route.mailbox, filter: route.filter, mailboxId: route.mailboxId, account: null, id: null }));
  }

  // A function, not a plain constant, because the single-line "rows
  // layout" row (design-fidelity Pass C, MessageList's `rowsLayout` prop)
  // must be true ONLY in the wide desktop rows-layout branch below (design:
  // "layoutDir !== 'row'" is the desktop columns/rows toggle -- a
  // wide-only feature) and false everywhere else, including the compact/
  // medium viewport's own list render, which always keeps the three-line
  // row per the existing "phone layout stays ours" owner ruling (see
  // MessageList.tsx's module comment).
  function renderListBody(rowsLayout: boolean): JSX.Element {
    return (
      <Search
        api={api}
        accents={accents}
        codes={codes}
        onOpen={handleOpenRow}
        onError={(err) => handleApiError(err, "search")}
        onResultsChange={(active, searchRows) => setSearchState({ active, rows: searchRows })}
        onSaved={() => setSavedSearchesVersion((v) => v + 1)}
        requestedQuery={requestedQuery}
      >
        <MessageList
          rows={rows}
          mailbox={route.mailboxId !== undefined ? (customFolderName ?? "Folder") : route.mailbox}
          // 🚨 The list's transition identity, NOT its title. `mailbox`
          // above is a placeholder for a custom folder until
          // `/api/mailboxes` resolves the name; once the list read path
          // got fast that rename landed AFTER the rows and read as a
          // folder switch, leaving the skeleton up for good. This key
          // changes only when the page being fetched changes -- it is
          // the same scope `listFilters` builds its request from.
          mailboxKey={
            route.mailboxId !== undefined
              ? `folder/${route.filter ?? ""}/${route.mailboxId}`
              : `${route.mailbox}/${route.filter ?? "all"}`
          }
          accents={accents}
          codes={codes}
          opened={opened}
          onOpen={handleOpenRow}
          total={rowsTotal}
          hasMore={rowsCursor !== null}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
          onEmptyTrash={() => void emptyTrash()}
          theme={theme}
          density={density}
          reauth={reauth}
          onReauthorize={(account) => {
            // The account needs a new token, which is the Add-account flow's
            // credential step. Settings is where that lives.
            setSettingsOpen(true);
            setBanner(`Reauthorize ${account} from its account settings.`);
          }}
          imapPending={imapPending}
          onBulk={(action, targets) => {
            if (action === "read") {
              void runTriage({ kind: "read", value: true }, targets, "Marked read");
            } else {
              void runTriage({ kind: "move", role: "archive" }, targets, "Archived");
            }
          }}
          onRowContextMenu={openThreadMenu}
          rowsLayout={rowsLayout}
        />
      </Search>
    );
  }
  const listBody = renderListBody(false);

  // Settings (Task 6): matches the design's own structure exactly --
  // `<nav>` (Sidebar) stays mounted, and this REPLACES the list+reading
  // area, it never overlays it (the same "replaces, doesn't overlay"
  // relationship Compose already has with Reading, above). Rendered in
  // every viewport regime the same way; there is no separate mobile
  // design for this screen (owner ruling: phone layout stays ours).
  const settingsPane = (
    <Settings
      health={healthByAccount}
      accounts={accountSpecs}
      api={api}
      onAccountSettingSaved={(_account, key) => {
        // Row 48: switching an account out of (or into) All inboxes changes
        // the unified list, its count, and the accounts' own flag.
        if (key === "showInUnified") {
          setAccountsVersion((v) => v + 1);
          bumpMailboxes();
          refreshListRef.current();
        }
      }}
      onSaveSignature={saveSignature}
      loadSignatureUrl={(account, identityId) => api.signatureUrl(account, identityId)}
      theme={theme}
      density={density}
      layout={layout}
      onReorder={(order) => {
        void api.setAccountOrder(order).then(() => setAccountsVersion((v) => v + 1)).catch((err: unknown) => handleApiError(err, "reorder accounts"));
      }}
      onThemeChange={applyTheme}
      onDensityChange={applyDensity}
      onLayoutChange={applyLayout}
      preferences={prefs}
      onPreferenceChange={changePreference}
      onAccountsChanged={() => setAccountsVersion((v) => v + 1)}
      onClose={() => setSettingsOpen(false)}
      onOpenAddAccount={() => setAddAccountOpen(true)}
    />
  );

  // Compact (<900px): the reading pane is an overlay, not a column. It
  // covers the list (and, on a phone, the whole viewport) and carries the
  // one control that layout needs and the wide one doesn't -- a way back
  // to the list, since there is no longer a list visible beside it.
  const readingOverlay =
    opened === null || settingsOpen ? null : (
      <section
        data-testid="reading-overlay"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          left: viewport === "medium" ? `${SIDEBAR_WIDTH}px` : 0,
          zIndex: 30,
          background: "var(--panel)",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 12px",
            borderBottom: "1px solid var(--line)",
            background: "var(--panel2)",
          }}
        >
          <button
            type="button"
            data-testid="reading-back"
            onClick={closeMessage}
            style={{
              font: "inherit",
              fontSize: "13px",
              color: "var(--ink)",
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-md)",
              padding: "5px 10px",
              cursor: "pointer",
            }}
          >
            ← Back
          </button>
        </div>
        <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", overflow: "auto" }}>
          {readingPane}
        </div>
      </section>
    );

  const compactShell = (
    <div class="app-shell" data-testid="app-shell" style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
      {viewport === "medium" && <Sidebar
            api={api}
            width={SIDEBAR_WIDTH}
            onError={(err) => handleApiError(err, "load the sidebar")}
            onNavigateFolder={handleNavigateFolder}
            onOpenMailbox={handleOpenMailbox}
            currentMailboxId={route.mailboxId}
            onAllInboxes={handleAllInboxes}
            onCompose={() => setComposeOpen(true)}
            onToggleTheme={toggleTheme}
            theme={theme}
            savedSearchesRefreshToken={savedSearchesVersion}
            onOpenSettings={() => setSettingsOpen(true)}
            settingsOpen={settingsOpen}
            accountsRefreshToken={accountsVersion}
            onOpenAddAccount={() => setAddAccountOpen(true)}
            onFolderMenu={openFolderMenu}
            onDropMessages={handleDropMessages}
            mailboxesRefreshToken={mailboxesVersion}
            onSavedSearchMenu={openSavedSearchMenu}
            health={healthByAccount}
            savedSearches={savedSearches}
            accountSpecs={accountSpecs}
            onSavedSearch={runSavedSearch}
            onShortcuts={() => setOverlay("shortcuts")}
            currentAccount={route.filter}
            currentFolder={route.mailbox}
          />}
      <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0, height: "100%" }}>
        {viewport === "narrow" && (
          <div
            data-testid="compact-bar"
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "8px 12px",
              borderBottom: "1px solid var(--line)",
              background: "var(--panel2)",
            }}
          >
            <button
              type="button"
              data-testid="drawer-toggle"
              aria-label="Folders"
              onClick={() => setDrawerOpen(true)}
              style={{
                font: "inherit",
                lineHeight: 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--ink)",
                background: "var(--panel)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-md)",
                padding: "6px 9px",
                cursor: "pointer",
              }}
            >
              <Menu size={15} aria-hidden="true" />
            </button>
            <span style={{ fontSize: "13px", fontWeight: 600, textTransform: "capitalize" }}>{route.mailbox}</span>
          </div>
        )}
        {settingsOpen ? settingsPane : <ListPane>{listBody}</ListPane>}
      </div>
      {readingOverlay}
      {viewport === "narrow" && drawerOpen && (
        <>
          <div
            data-testid="drawer-scrim"
            onClick={() => setDrawerOpen(false)}
            style={{ position: "fixed", top: 0, right: 0, bottom: 0, left: 0, zIndex: 40, background: "var(--scrim)" }}
          />
          <div
            data-testid="drawer"
            onClick={() => setDrawerOpen(false)}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              bottom: 0,
              zIndex: 41,
              background: "var(--panel)",
              borderRight: "1px solid var(--line)",
              overflow: "auto",
            }}
          >
            <Sidebar
            api={api}
            width={SIDEBAR_WIDTH}
            onError={(err) => handleApiError(err, "load the sidebar")}
            onNavigateFolder={handleNavigateFolder}
            onOpenMailbox={handleOpenMailbox}
            currentMailboxId={route.mailboxId}
            onAllInboxes={handleAllInboxes}
            onCompose={() => setComposeOpen(true)}
            onToggleTheme={toggleTheme}
            theme={theme}
            savedSearchesRefreshToken={savedSearchesVersion}
            onOpenSettings={() => setSettingsOpen(true)}
            settingsOpen={settingsOpen}
            accountsRefreshToken={accountsVersion}
            onOpenAddAccount={() => setAddAccountOpen(true)}
            onFolderMenu={openFolderMenu}
            onDropMessages={handleDropMessages}
            mailboxesRefreshToken={mailboxesVersion}
            onSavedSearchMenu={openSavedSearchMenu}
            health={healthByAccount}
            savedSearches={savedSearches}
            accountSpecs={accountSpecs}
            onSavedSearch={runSavedSearch}
            onShortcuts={() => setOverlay("shortcuts")}
            currentAccount={route.filter}
            currentFolder={route.mailbox}
          />
          </div>
        </>
      )}
    </div>
  );

  const wideShell =
    layout === "columns" ? (
      <div class="app-shell" data-testid="app-shell" style={shellStyle}>
        <Sidebar
            api={api}
            width={SIDEBAR_WIDTH}
            onError={(err) => handleApiError(err, "load the sidebar")}
            onNavigateFolder={handleNavigateFolder}
            onOpenMailbox={handleOpenMailbox}
            currentMailboxId={route.mailboxId}
            onAllInboxes={handleAllInboxes}
            onCompose={() => setComposeOpen(true)}
            onToggleTheme={toggleTheme}
            theme={theme}
            savedSearchesRefreshToken={savedSearchesVersion}
            onOpenSettings={() => setSettingsOpen(true)}
            settingsOpen={settingsOpen}
            accountsRefreshToken={accountsVersion}
            onOpenAddAccount={() => setAddAccountOpen(true)}
            onFolderMenu={openFolderMenu}
            onDropMessages={handleDropMessages}
            mailboxesRefreshToken={mailboxesVersion}
            onSavedSearchMenu={openSavedSearchMenu}
            health={healthByAccount}
            savedSearches={savedSearches}
            accountSpecs={accountSpecs}
            onSavedSearch={runSavedSearch}
            onShortcuts={() => setOverlay("shortcuts")}
            currentAccount={route.filter}
            currentFolder={route.mailbox}
          />
        {settingsOpen ? (
          settingsPane
        ) : (
          <>
            <ListPane width={listWidth}>{listBody}</ListPane>
            <Divider testId="divider-list" axis="x" onDragStart={handleListDragStart} onDrag={handleListDrag} />
            {readingPane}
          </>
        )}
      </div>
    ) : (
      <div class="app-shell" data-testid="app-shell" style={shellStyle}>
        <Sidebar
            api={api}
            width={SIDEBAR_WIDTH}
            onError={(err) => handleApiError(err, "load the sidebar")}
            onNavigateFolder={handleNavigateFolder}
            onOpenMailbox={handleOpenMailbox}
            currentMailboxId={route.mailboxId}
            onAllInboxes={handleAllInboxes}
            onCompose={() => setComposeOpen(true)}
            onToggleTheme={toggleTheme}
            theme={theme}
            savedSearchesRefreshToken={savedSearchesVersion}
            onOpenSettings={() => setSettingsOpen(true)}
            settingsOpen={settingsOpen}
            accountsRefreshToken={accountsVersion}
            onOpenAddAccount={() => setAddAccountOpen(true)}
            onFolderMenu={openFolderMenu}
            onDropMessages={handleDropMessages}
            mailboxesRefreshToken={mailboxesVersion}
            onSavedSearchMenu={openSavedSearchMenu}
            health={healthByAccount}
            savedSearches={savedSearches}
            accountSpecs={accountSpecs}
            onSavedSearch={runSavedSearch}
            onShortcuts={() => setOverlay("shortcuts")}
            currentAccount={route.filter}
            currentFolder={route.mailbox}
          />
        <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0 }}>
          {settingsOpen ? (
            settingsPane
          ) : (
            <>
              <div style={{ flex: `0 0 ${rowHeightPct}%` }}>
                <ListPane width={LIST_WIDTH_DEFAULT}>{renderListBody(true)}</ListPane>
              </div>
              <Divider testId="divider-row" axis="y" onDragStart={handleRowDragStart} onDrag={handleRowDrag} />
              {readingPane}
            </>
          )}
        </div>
      </div>
    );

  // Row 33: /print/{account}/{id} is the print document, rendered in place
  // of the shell. After every hook above, so the hook order is stable.
  if (route.print === true && route.account !== null && route.id !== null) {
    return <PrintView api={api} account={route.account} id={route.id} />;
  }

  const shell = viewport === "wide" ? wideShell : compactShell;

  // A dead session replaces the ENTIRE shell -- every pane underneath is
  // mid-fetch against a session that will only ever 401 again, so there
  // is nothing worth keeping mounted behind the gate. `window.location`
  // reload on success (not just clearing the flag) so every effect above
  // re-runs from a clean mount against the fresh cookie, rather than this
  // file trying to individually re-trigger each one.
  if (sessionExpired) {
    return <Login api={api} onSuccess={() => window.location.reload()} />;
  }

  return (
    <>
      {shell}
      {banner !== null && (
        <div
          data-testid="error-banner"
          role="status"
          style={{
            position: "fixed",
            left: "50%",
            bottom: "16px",
            transform: "translateX(-50%)",
            zIndex: 90,
            display: "flex",
            alignItems: "center",
            gap: "10px",
            maxWidth: "min(480px, 90vw)",
            padding: "8px 12px",
            fontSize: "13px",
            color: "var(--ink)",
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 6px 18px var(--scrim)",
          }}
        >
          <span>{banner}</span>
          <button
            type="button"
            data-testid="error-banner-dismiss"
            aria-label="Dismiss"
            onClick={() => setBanner(null)}
            style={{
              font: "inherit",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--muted)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      {paletteOpen && (
        <Palette
          items={paletteItems}
          mailItems={paletteMailItems}
          onQueryChange={setPaletteQuery}
          onSelect={handlePaletteSelect}
          onClose={() => {
            setPaletteOpen(false);
            setPaletteQuery("");
          }}
        />
      )}
      <Overlays
        open={overlay}
        onClose={() => setOverlay("none")}
        commands={COMMANDS}
        source={sourceData ?? undefined}
        attachment={
          attachmentData !== null
            ? {
                ...attachmentData,
                onDownload:
                  attachmentData.href !== undefined
                    ? () => { window.open(attachmentData.href, "_blank", "noopener,noreferrer"); }
                    : undefined,
              }
            : undefined
        }
        move={moveData ?? undefined}
        contextMenu={contextMenuData ?? undefined}
        toast={toast}
      />
      {addAccountOpen && (
        <AddAccount
          api={api}
          onClose={() => setAddAccountOpen(false)}
          onCreated={() => setAccountsVersion((v) => v + 1)}
        />
      )}
    </>
  );
}
