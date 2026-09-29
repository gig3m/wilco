// The sidebar (Task 2 of the design-fidelity plan): header/logo, compose,
// "All inboxes", one block per account (color bar, mono code, folders),
// "+ Add account", saved searches, and a footer. Transcribed from the
// design's own markup (docs/design/Wilco.dc.html, the `<nav style="width:
// 242px...">` block) rather than interpreted from prose -- every literal
// px/color/weight below is read off that file's inline `style=`
// attributes, not guessed. Structural/layout rules that don't need to vary
// per instance live in ../styles/components.css as real classes (ruling
// P3); only values that come from data (an account's accent, computed
// per-instance) or that a test reads back via `getComputedStyle` (the
// account code's font-family) stay inline, matching the convention already
// used across MessageList/Reading for the same reason.
//
// Two facts the design's own mock data does not know:
//   - Accents and codes come from `GET /api/accounts` (`AccountSpec.accent`
//     / `.code`), never a hardcoded palette or a derived abbreviation --
//     the design's Halden/Wilco/Meridian/Personal are mock names, not
//     keys a real install will have.
//   - Unread counts come from `GET /api/mailboxes`, computed from the
//     junction table. `mailboxes.unread_emails` is never read here --
//     `Mailbox.unread` is the only unread field this file's data model has.
//
// Folder and account names are attacker-controlled (they come from the
// server, which got them from JMAP, and a user can rename a folder to
// anything). Every name renders as a JSX child -- Preact escapes those
// automatically -- and `text()` from escape.ts is used even so, matching
// the convention everywhere else in this codebase. This file never sets
// raw HTML on an element.
//
// Design-fidelity Pass C: the per-account "syncing"/"error"/"pending"
// glyphs (Wilco.dc.html lines 63-65, `a.syncing`/`a.error`/`a.pending`) DO
// now have a real source -- `GET /healthz` (src/server/health.ts's
// `HealthReport`), which reports per-account `state`, `stale`,
// `walkComplete` and `lastSyncAt`. `syncBadgeFor` below maps that onto the
// design's three literal states:
//   - `spec.provider === "imap"` -> "pending" (the design's own literal
//     case is Personal/Gmail; this app's real signal is the account's
//     provider field, not a hardcoded account key -- DESIGN.md: "Personal
//     shows 'IMAP · soon' pending state" describes the DESIGN's mock data,
//     not a name to special-case here).
//   - a caught FailureKind ("auth"/"network"/"rate-limited"/"server") ->
//     "error", the design's amber ⚠. The design's own glyph is titled
//     "Authentication expired" for the auth case specifically; the other
//     three kinds reuse the same glyph/color (no separate design affordance
//     exists for them) with the server's own message as the tooltip instead
//     -- an account that needs attention should never render as healthy
//     for want of a bespoke icon.
//   - `!walkComplete` (initial backfill still running) -> "syncing", the
//     design's spinning ⟳.
//   - otherwise (state "ok", walk complete, not stale) -> nothing extra,
//     matching the design's own markup: there is no rendered glyph for a
//     healthy account, only the chevron.
// One genuine ambiguity, called out rather than silently resolved:
// health.ts's `state` field uses the literal string "unknown" for TWO
// different things -- the "never synced yet" default (states.get() finds
// nothing) and failures.ts's own catch-all FailureKind for an
// unrecognized error. This client cannot tell them apart, so "unknown" is
// treated as "syncing" (the far more common case for a freshly-added
// account) rather than "error".
// The footer status line still renders steady-state text only ("JMAP
// push") -- DESIGN.md's account-health branches for THAT line
// (`"MER needs attention"`, `"N queued"`) describe a different design
// field this endpoint doesn't carry (a queue depth), so that line is left
// as a prior pass found it.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  Archive,
  Ban,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Contrast,
  Folder,
  Inbox,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Settings as SettingsIcon,
  Trash2,
  TriangleAlert,
} from "lucide-preact";
import type { AccountHealth, AccountSpec, Api, Mailbox, SavedSearch } from "../lib/api";
import { toCssColor } from "../lib/color";
import { text } from "../lib/escape";
import { DRAG_ACCOUNT_TYPE_PREFIX, DRAG_MESSAGES_TYPE } from "./MessageList";

/** Matches tokens.css's `--font-mono` value literally (not `var(...)`):
 *  happy-dom's `getComputedStyle` doesn't resolve custom properties set
 *  via an inline `style`, so a test reading this back for "Plex Mono"
 *  needs the literal font stack, not a reference to it. */
const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

/** Shown when the caller passed no `onSavedSearch` -- a rendered saved
 *  search with nowhere to send its query says so rather than looking
 *  live (audit guardrail 3). */
/** The design's `f.count`: unread for the inbox, held messages for every
 *  other folder. `0` renders as nothing, not as a literal "0" -- the design
 *  writes `n || ''`. */
function folderCount(mailbox: Mailbox): string {
  const n = mailbox.role === "inbox" ? mailbox.unread : (mailbox.total ?? 0);
  return formatCount(n);
}

function formatCount(n: number): string {
  return n > 0 ? n.toLocaleString("en-US") : "";
}

const SAVED_SEARCH_REASON = "Running a saved search needs a search pane, which this view was rendered without";

export interface SidebarProps {
  api: Api;
  /** Fixed width in px. The design hardcodes 242px on the sidebar's own
   *  `<nav>` element, and `components.css`'s `.sidebar` class carries that
   *  same 242px as its default -- this prop only exists so a caller (or a
   *  future responsive layout) can override it without touching the
   *  stylesheet. */
  width?: number;
  /** Called on any of this component's three fetches failing --
   *  `App.tsx` routes it through the same session-expired/banner handling
   *  every other pane uses. Optional so this component's own tests, which
   *  don't exercise failure, need not pass one. */
  onError?: (err: unknown, context: string) => void;
  /** A folder WITH a role (inbox/drafts/sent/archive/spam/trash) can
   *  navigate -- that's the route model App.tsx already drives
   *  (`/{mailbox}/{account}`). A custom folder (`role === null`) has no
   *  route this app can express yet, so it's rendered without one at all. */
  onNavigateFolder?: (role: string, account: string) => void;
  /** Row 37: opens a CUSTOM folder (no role) by its mailbox id. */
  onOpenMailbox?: (account: string, mailboxId: string) => void;
  /** The open custom folder's id, for the active row. */
  currentMailboxId?: string;
  /** Row 32: messages dragged from the list and dropped on one of this
   *  account's folder rows. Targets are what the list put in the drag
   *  payload; a drag from another account is refused at dragover, so the
   *  cursor says no before anything is dropped. */
  onDropMessages?: (mailboxId: string, account: string, targets: { account: string; id: string }[]) => void;
  onAllInboxes?: () => void;
  /** Opens the compose pane (Task 5 fix round 1). The design's "C" hint
   *  next to this button is the same keyboard shortcut the keymap's `c`
   *  command now drives, so both paths land on the same handler --
   *  `App.tsx` passes the same function to this prop and to
   *  `commandContext.compose`. Optional so this component's own tests,
   *  which don't need composing to do anything, need not pass one. */
  onCompose?: () => void;
  /** Wired directly -- it has no backend dependency at all. */
  /** Account health, when a caller already has it. Audit pass 6: three
   *  components polled `/healthz` independently (App, Sidebar, Settings) and
   *  could disagree about the same account for a poll interval — the badge
   *  saying one thing while the banner said another is exactly the seam this
   *  pass is for. When supplied, the poll below does not run; when absent
   *  this still fetches its own, so rendering `Sidebar` standalone (which
   *  every test does) is unchanged. */
  health?: Map<string, AccountHealth>;
  /** The account list, when a caller already has it. Same reasoning as
   *  `health`: App fetches `/api/accounts` for the row accents and codes and
   *  this fetched them again, so the sidebar and the message list could hold
   *  different account lists after one is added or removed. Absent -> this
   *  fetches its own, so standalone rendering is unchanged. */
  accountSpecs?: AccountSpec[];
  /** The saved-search list, when a caller already has it. Same reasoning as
   *  `health`/`accountSpecs` (audit pass 6): App needs them for the ⌘K
   *  palette, and two fetches means two lists that can disagree. */
  savedSearches?: SavedSearch[];
  onToggleTheme?: () => void;
  theme?: "light" | "dark";
  /** Bumped by `App.tsx` whenever a search is saved from the search pane
   *  -- this component owns its own fetched copy of the saved-search list
   *  and has no other way to learn that it changed. */
  savedSearchesRefreshToken?: number;
  /** Bumped by `App.tsx` after `AddAccount`'s `onCreated` fires (Task 7)
   *  -- this component owns its own fetched copy of the account list too
   *  (see the account-accent-colors comment on `App.tsx`'s own fetch) and
   *  has no other way to learn a new row exists. */
  accountsRefreshToken?: number;
  /** Row 35: bumped by App after anything that changes a folder's counts
   *  (a triage, undo, read-on-open, a sync event), so the badges follow
   *  what was just done instead of waiting for a reload. */
  mailboxesRefreshToken?: number;
  /** Opens Settings (Task 6) -- the surface itself needs no backend (see
   *  Settings.tsx's module comment). Optional so this component's own
   *  tests, which don't need Settings to open, need not pass one. */
  onOpenSettings?: () => void;
  /** Highlights this button exactly like the design's own `settingsBg`
   *  (`var(--sel)` while open, transparent otherwise). */
  settingsOpen?: boolean;
  /** Opens the add-account modal (Task 7) -- real and reachable now.
   *  Optional so this component's own tests, which don't need the modal
   *  to open, need not pass one. */
  onOpenAddAccount?: () => void;
  /** Opens a folder's `···`/right-click context menu (design's
   *  `S.ctx.type === 'folder'`) -- Task 8. Fired on `contextmenu` for ANY
   *  mailbox row, including a custom one with no route (`onNavigateFolder`
   *  can't open it, but its menu can still offer "Mark all read"). App.tsx
   *  owns the menu's item list. Optional, same "unwired unless a caller
   *  passes it" convention as every other new prop here. */
  onFolderMenu?: (mailbox: Mailbox, accountKey: string, evt: { clientX: number; clientY: number }) => void;
  /** Opens a saved search's context menu (design's `S.ctx.type ===
   *  'saved'`) -- Task 8. Same firing convention as `onFolderMenu`. */
  onSavedSearchMenu?: (search: SavedSearch, evt: { clientX: number; clientY: number }) => void;
  /** Clicking a saved search runs it (design's `ss.select`, which sets
   *  `searchQ`). Audit pass 1: the row had only `onContextMenu`, so a
   *  plain click -- the obvious gesture -- did nothing at all. */
  onSavedSearch?: (search: SavedSearch) => void;
  /** The `?` footer button (design's `toggleShortcuts`). */
  onShortcuts?: () => void;
  /** `App.tsx`'s `route.account` -- `null` means "All inboxes" is the
   *  active scope. Design-fidelity Pass B finding 3: DESIGN.md is
   *  explicit ("Active folder = --sel background, weight 600") and no
   *  row ever carried a selected state before this. Optional so this
   *  component's own tests, which don't exercise selection, need not
   *  pass one -- no row highlights, matching today's behavior. */
  currentAccount?: string | null;
  /** `App.tsx`'s `route.mailbox` -- a folder ROLE ("inbox", "archive",
   *  ...), matching `Mailbox.role`. Only meaningful together with
   *  `currentAccount`: a folder is "active" when both its account key
   *  and its role match. */
  currentFolder?: string;
}

interface AccountBlock {
  spec: AccountSpec;
  mailboxes: Mailbox[];
  unread: number;
}

// Folders shown in this fixed order when present, ahead of whatever custom
// folders a user has. A mailbox with no role (or an unrecognized one) is a
// custom folder and sorts after all of these, in whatever order the server
// returned it.
const ROLE_ORDER = ["inbox", "drafts", "sent", "archive", "spam", "trash"];

// Per-folder icons. inbox/drafts/sent/archive were transcribed verbatim as
// unicode glyphs from the design's own `baseFolders`/`icons` tables
// (Wilco.dc.html), which never modeled spam or trash; spam/trash instead
// came from an earlier, since-removed design draft:
//   ['archive', 'Archive', '▣'], ['spam', 'Spam', '⊘'], ['trash', 'Trash', '⌫'],
// -- owner ruling 2026-09-04 (round-1 review of that task) was to use that
// source's glyphs for both.
//
// 🚨 SUPERSEDED 2026-09-04 (this task, "adopt Lucide icons"): DESIGN.md's
// own "Assets" section says verbatim to "replace with a real icon set (e.g.
// Lucide) at implementation, keeping the compact 11–13px scale" -- an
// instruction that predates and overrides the round-1 glyph ruling above,
// which was made without anyone having noticed it. Every glyph here (the
// `⌫` included) is now a Lucide icon component instead of a unicode
// character; the mapping below preserves the SAME per-role identity the
// glyph table established (inbox/drafts/sent/archive from Wilco.dc.html,
// spam/trash from the earlier draft), just rendered as SVG.
// All lucide-preact icon exports share this exact function type, so aliasing
// off one of them (rather than hand-rolling a narrower props type) is what
// keeps assignments below structurally compatible with what `<Icon .../>`
// actually accepts (its `size` is `string | number`, not just `number`).
type IconComponent = typeof Inbox;

// `sent` maps to `Send` (a paper plane), not `CornerUpRight` -- design
// review fix round 1 caught that CornerUpRight collides with the
// conventional Forward icon this app also has (Reading's Forward
// button), which would read as two different actions sharing one glyph.
const FOLDER_ICON: Record<string, IconComponent> = {
  inbox: Inbox,
  drafts: Pencil,
  sent: Send,
  archive: Archive,
  spam: Ban,
  trash: Trash2,
};
// Generic marker for a folder with no recognized role -- design's `▸`
// meant "this is some folder" here, a different meaning from the
// disclosure-chevron use of the identical glyph on the account-collapse
// toggle below (that one maps to ChevronRight/ChevronDown instead).
const CUSTOM_FOLDER_ICON = Folder;

// Design review fix round 1: these render at `--faint` (`.sidebar-folder-icon`),
// and the default strokeWidth (2) measured 68% heavier ink at that token
// than the design's glyphs did. 1.5 is the fix, applied wherever a Lucide
// icon sits at `--faint` across this whole task, not just here.
const FAINT_STROKE = 1.5;

function FolderIcon({ role }: { role: string | null }): JSX.Element {
  const Icon = (role === null ? undefined : FOLDER_ICON[role]) ?? CUSTOM_FOLDER_ICON;
  return <Icon size={12} strokeWidth={FAINT_STROKE} />;
}

/** Whether a drag is a message drag whose every target is in `account`,
 *  judged from the type list alone -- all a dragover may read. */
function dragAccepts(e: DragEvent, account: string): boolean {
  const dt = e.dataTransfer;
  if (dt === null) return false;
  const types = Array.from(dt.types);
  return types.includes(DRAG_MESSAGES_TYPE) && types.includes(DRAG_ACCOUNT_TYPE_PREFIX + account);
}

/** The move targets a drag carries, or null when the drag is not a
 *  message drag of THIS account (a file from the desktop, another
 *  account's message). Parsed defensively: the payload is a string the
 *  list wrote, but nothing here trusts its shape. */
function dragTargets(e: DragEvent, account: string): { account: string; id: string }[] | null {
  const dt = e.dataTransfer;
  if (dt === null || !dragAccepts(e, account)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dt.getData(DRAG_MESSAGES_TYPE) || "null");
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const targets: { account: string; id: string }[] = [];
  for (const t of parsed) {
    if (!t || typeof t !== "object") return null;
    const { account: a, id } = t as { account?: unknown; id?: unknown };
    if (typeof a !== "string" || typeof id !== "string" || a !== account) return null;
    targets.push({ account: a, id });
  }
  return targets;
}

function sortMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  return [...mailboxes].sort((a, b) => {
    const ai = a.role === null ? ROLE_ORDER.length : ROLE_ORDER.indexOf(a.role);
    const bi = b.role === null ? ROLE_ORDER.length : ROLE_ORDER.indexOf(b.role);
    const aRank = ai === -1 ? ROLE_ORDER.length : ai;
    const bRank = bi === -1 ? ROLE_ORDER.length : bi;
    return aRank - bRank;
  });
}

/** One row of the folder tree: the mailbox, its depth, and its subtree's
 *  held-message total (what a folded parent shows). Row 43: Fastmail
 *  folders nest (`parent`), and the sidebar used to flatten them, so a
 *  parent sat alphabetically among its own children. */
export interface FolderNode {
  mailbox: Mailbox;
  depth: number;
  children: FolderNode[];
  /** `total` of this folder plus every descendant, for the folded view. */
  subtreeTotal: number;
}

/** Role folders first in ROLE_ORDER, flat; then the custom folders as a
 *  tree in the server's order (a child whose parent is not in this
 *  account's list is treated as a root, never dropped). */
export function folderTree(mailboxes: Mailbox[]): FolderNode[] {
  const sorted = sortMailboxes(mailboxes);
  const ids = new Set(mailboxes.map((m) => m.id));
  const kids = new Map<string, Mailbox[]>();
  const roots: Mailbox[] = [];
  for (const m of sorted) {
    if (m.role === null && m.parent !== null && ids.has(m.parent)) {
      const list = kids.get(m.parent) ?? [];
      list.push(m);
      kids.set(m.parent, list);
    } else {
      roots.push(m);
    }
  }
  const build = (m: Mailbox, depth: number, seen: Set<string>): FolderNode => {
    seen.add(m.id);
    const children = (kids.get(m.id) ?? []).filter((c) => !seen.has(c.id)).map((c) => build(c, depth + 1, seen));
    const subtreeTotal = (m.total ?? 0) + children.reduce((n, c) => n + c.subtreeTotal, 0);
    return { mailbox: m, depth, children, subtreeTotal };
  };
  return roots.map((m) => build(m, 0, new Set()));
}

const COLLAPSED_KEY = "wilco.folders.collapsed";

/** Folded parents, remembered per browser like a scroll position -- not a
 *  stored preference, which is per owner and enum-valued. Every read and
 *  write is guarded: storage can be absent, full or blocked. */
function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage?.getItem(COLLAPSED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(set: Set<string>): void {
  try {
    window.localStorage?.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    // Nothing to do: the fold still applies for this page's life.
  }
}

/** A stable, readable stand-in for an account whose key hasn't (yet, or
 *  ever) shown up in `GET /api/accounts` -- e.g. a mailbox arrived before
 *  the accounts list did, in a fake, or in a real race. Rendering nothing
 *  would silently drop real unread mail from the total; inventing a
 *  plausible spec keeps the block visible instead. */
function fallbackAccountSpec(key: string): AccountSpec {
  return { key, label: key, accent: "#8a8f97", provider: "jmap", endpoint: "", code: key.slice(0, 3).toUpperCase() };
}

export type SyncBadge = "syncing" | "error" | "pending";

const FAILURE_KINDS = new Set(["auth", "network", "rate-limited", "server"]);

/** See the module comment above for the full reasoning. `health` is
 *  `undefined` before `/healthz` has answered (or for a fallback spec with
 *  no matching health row) -- renders nothing, same as an "ok" account,
 *  rather than guessing.
 *
 *  Exported (design-fidelity F10, 2026-09-04) so Settings.tsx's account
 *  card can render the design's `connected`/`syncing…`/`auth expired`/
 *  `waiting on IMAP` status label off the SAME bucket this sidebar badge
 *  already uses, rather than a second, drift-prone reading of
 *  `AccountHealth`. */
export function syncBadgeFor(spec: AccountSpec, health: AccountHealth | undefined): SyncBadge | null {
  if (spec.provider === "imap") return "pending";
  if (health === undefined) return null;
  if (FAILURE_KINDS.has(health.state)) return "error";
  if (!health.walkComplete || health.state === "unknown") return "syncing";
  if (health.stale) return "error";
  return null;
}

/** The badge's tooltip -- the design's own literal wording for the two
 *  cases it names ("Syncing", "Authentication expired"); everything else
 *  (the other three FailureKinds, and a stale-but-otherwise-ok account)
 *  uses the server's own message so a real, specific failure is never
 *  hidden behind a generic label. */
function syncBadgeTitle(badge: SyncBadge, health: AccountHealth | undefined): string {
  if (badge === "pending") return "IMAP support coming";
  if (badge === "syncing") return "Syncing";
  if (health?.state === "auth") return "Authentication expired";
  return health?.message ?? (health?.stale === true ? "Sync stalled" : "Needs attention");
}

export function Sidebar({
  api,
  width,
  onError,
  onNavigateFolder,
  onOpenMailbox,
  currentMailboxId,
  onDropMessages,
  onAllInboxes,
  onCompose,
  health,
  accountSpecs,
  savedSearches: savedSearchesProp,
  onToggleTheme,
  theme,
  savedSearchesRefreshToken,
  accountsRefreshToken,
  mailboxesRefreshToken,
  onOpenSettings,
  settingsOpen,
  onOpenAddAccount,
  onFolderMenu,
  onSavedSearchMenu,
  onSavedSearch,
  onShortcuts,
  currentAccount,
  currentFolder,
}: SidebarProps): JSX.Element {
  /** The drop-target handlers for one folder row (row 32). Lowercase
   *  event names on purpose: Preact binds `onDragOver` to the camel-cased
   *  event when the element has no `ondragover` property (happy-dom has
   *  none), so the tests would exercise a listener the browser never
   *  fires. `ondragover`/`ondrop` bind the plain event in both. */
  function dropHandlers(mailboxId: string, account: string): Record<string, (e: DragEvent) => void> {
    if (onDropMessages === undefined) return {};
    return {
      ondragover: (e: DragEvent) => {
        // Types only: the payload is unreadable until drop (protected
        // mode), and without preventDefault here the drop never fires.
        if (!dragAccepts(e, account)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      },
      ondrop: (e: DragEvent) => {
        const targets = dragTargets(e, account);
        if (targets === null) return;
        e.preventDefault();
        onDropMessages(mailboxId, account, targets);
      },
    };
  }

  const [fetchedAccounts, setFetchedAccounts] = useState<AccountSpec[]>([]);
  // The prop wins when a caller has it; otherwise this component's own fetch.
  const accounts = accountSpecs ?? fetchedAccounts;
  const [mailboxesByAccount, setMailboxesByAccount] = useState<Map<string, Mailbox[]>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Folded custom-folder parents, as `${account}:${id}` (row 43). */
  const [foldedFolders, setFoldedFolders] = useState<Set<string>>(() => readCollapsed());
  const toggleFolder = (account: string, id: string): void => {
    setFoldedFolders((prev) => {
      const next = new Set(prev);
      const key = `${account}:${id}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsed(next);
      return next;
    });
  };
  const [fetchedSavedSearches, setFetchedSavedSearches] = useState<SavedSearch[]>([]);
  const savedSearches = savedSearchesProp ?? fetchedSavedSearches;
  // `undefined` (never fetched -- see syncBadgeFor's own doc) vs a real
  // AccountHealth (a normal answer, whether ok or not) -- there is no
  // third "no data" value to invent, `Map.get` already returns undefined.
  const [fetchedHealth, setFetchedHealth] = useState<Map<string, AccountHealth>>(new Map());
  // The prop wins when a caller has it; otherwise this component's own poll.
  const healthByAccount = health ?? fetchedHealth;
  // `null` per saved-search id = not yet counted (nothing renders --
  // see the module doc comment / this task's report for why a real count
  // was chosen over omitting the field). Never a placeholder number.
  const [savedSearchCounts, setSavedSearchCounts] = useState<Map<string, number>>(new Map());

  // 🚨 FOUR SEPARATE EFFECTS, one per fetch.
  //
  // These were a single effect issuing four unrelated requests — accounts,
  // mailboxes, saved searches and health. Audit pass 6 found it the hard
  // way: adding an early return so this component would stop re-fetching
  // accounts the caller already had ALSO silenced mailboxes and saved
  // searches, and the sidebar rendered no folders at all. One guard, three
  // unintended casualties. The health fetch happened to survive only because
  // it sat last, after the return.
  //
  // Split, so a condition on one cannot reach the others, and so each has an
  // honest dependency list.
  useEffect(() => {
    if (accountSpecs !== undefined) return;
    let cancelled = false;
    api
      .accounts()
      .then((specs) => {
        if (!cancelled) setFetchedAccounts(specs);
      })
      .catch((err: unknown) => {
        if (!cancelled) onError?.(err, "load your accounts");
      });
    return () => {
      cancelled = true;
    };
  }, [api, accountSpecs, accountsRefreshToken]);

  useEffect(() => {
    let cancelled = false;
    api
      .mailboxes()
      .then((result) => {
        if (cancelled) return;
        const byAccount = new Map<string, Mailbox[]>();
        for (const entry of result.accounts) {
          byAccount.set(entry.account, entry.mailboxes);
        }
        setMailboxesByAccount(byAccount);
      })
      .catch((err: unknown) => {
        if (!cancelled) onError?.(err, "load your folders");
      });
    return () => {
      cancelled = true;
    };
  }, [api, accountsRefreshToken, mailboxesRefreshToken]);

  useEffect(() => {
    if (savedSearchesProp !== undefined) return;
    let cancelled = false;
    api
      .savedSearches()
      .then((result) => {
        if (!cancelled) setFetchedSavedSearches(result.savedSearches);
      })
      .catch((err: unknown) => {
        if (!cancelled) onError?.(err, "load saved searches");
      });
    return () => {
      cancelled = true;
    };
  }, [api, savedSearchesRefreshToken]);

  useEffect(() => {
    // Skipped when a caller passed `health`: one poll, one answer (pass 6).
    if (health !== undefined) return;
    let cancelled = false;
    // A failure here is NOT routed through `onError` (unlike the three
    // fetches above): losing the sync badges is a cosmetic degrade, not a
    // reason to show the same session-expired/error banner a failure to
    // load accounts or folders would.
    api
      .health()
      .then((report) => {
        if (cancelled) return;
        setFetchedHealth(new Map(report.accounts.map((a) => [a.account, a])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, health, accountsRefreshToken]);

  // Saved-search result counts (DESIGN.md: "◎ icon + mono query + result
  // count"). `api.search`'s `total` (read-api.ts's `searchEmails`, backed
  // by a real `count(*)` query) is the true corpus-wide match count for
  // that saved query -- NOT a page length -- so this is a real number, not
  // an invented one; see this task's report for why this source was
  // chosen over rendering the slot empty. `limit: 1` keeps the row
  // payload trivial; the count query itself always runs regardless of
  // limit. Re-runs whenever the saved-search LIST changes (a query's own
  // text can change via rename... no, rename doesn't touch `query`; only
  // add/remove/reorder do -- but this still keys on the whole array so a
  // future query-edit feature gets a fresh count for free).
  useEffect(() => {
    if (savedSearches.length === 0) return;
    let cancelled = false;
    Promise.all(
      savedSearches.map((s) =>
        api
          .search(s.query, { limit: 1 })
          .then((result): [string, number] => [s.id, result.total])
          .catch((): [string, number] | null => null),
      ),
    ).then((entries) => {
      if (cancelled) return;
      const next = new Map<string, number>();
      for (const entry of entries) {
        if (entry !== null) next.set(entry[0], entry[1]);
      }
      setSavedSearchCounts(next);
    });
    return () => {
      cancelled = true;
    };
  }, [api, savedSearches]);

  // Every account that either has a spec (from /api/accounts) or a
  // mailbox list (from /api/mailboxes) gets a block -- a mailbox arriving
  // for an account not yet in the accounts list must not silently
  // disappear (see fallbackAccountSpec above), and an account with no
  // mailboxes yet (still syncing) still shows its header.
  const keys = new Set<string>([...accounts.map((a) => a.key), ...mailboxesByAccount.keys()]);
  const specByKey = new Map(accounts.map((a) => [a.key, a]));

  const blocks: AccountBlock[] = Array.from(keys, (key) => {
    const mailboxes = mailboxesByAccount.get(key) ?? [];
    // 🚨 INBOX unread, not unread everywhere. The design's `unreadFor(id)`
    // filters `effFolder(t) === 'inbox'`, and summing every mailbox instead
    // put Archive, Trash, Spam and Drafts into the headline: measured on the
    // live archive it read "774 unread" while every inbox was at zero, with
    // 598 of the 774 coming from work/Archive alone. A number a person reads
    // as "things waiting for me" must not count the archive. Audit pass 4.
    const unread = mailboxes.reduce((sum, m) => sum + (m.role === "inbox" ? m.unread : 0), 0);
    return { spec: specByKey.get(key) ?? fallbackAccountSpec(key), mailboxes, unread };
  }).sort((a, b) => {
    // Row 34: the OWNER's order, carried on each account as `position`.
    // This used to sort by key, which is the one place that overrode the
    // API's order and kept the sidebar alphabetical whatever was chosen.
    const pa = a.spec.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.spec.position ?? Number.MAX_SAFE_INTEGER;
    return pa !== pb ? pa - pb : a.spec.key.localeCompare(b.spec.key);
  });

  // Row 48: an account switched out of "All inboxes" is out of its count.
  const totalUnread = blocks.reduce((sum, b) => sum + (b.spec.showInUnified === false ? 0 : b.unread), 0);

  function toggleCollapsed(key: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // `px()` (test-utils) reads the INLINE style, not a computed/class
  // value -- components.css's `.sidebar` rule also carries 242px as a
  // belt-and-braces default (the design hardcodes 242px on the sidebar's
  // own element), but the prop must default here too so a caller that
  // renders `<Sidebar api={...} />` with no `width` still measures 242.
  const effectiveWidth = width ?? 242;
  const sidebarStyle: JSX.CSSProperties = { width: `${effectiveWidth}px`, flex: `0 0 ${effectiveWidth}px` };

  return (
    <aside data-testid="sidebar" class="sidebar" style={sidebarStyle}>
      <div class="sidebar-header">
        <span aria-hidden="true" class="sidebar-logo">
          W
        </span>
        <span class="sidebar-wordmark">Wilco</span>
        <span data-testid="total-unread" class="sidebar-total-unread" style={{ fontFamily: FONT_MONO }}>
          {totalUnread} unread
        </span>
      </div>

      <div class="sidebar-compose-wrap">
        {/* Task 5 fix round 1: the PANE is real now (built in Task 5), so
         *  its trigger is wired -- only Send/Attach/Discard inside it stay
         *  disabled, per COMPOSE_REASON's own wording ("arrive in a later
         *  plan" describes send/reply/forward FUNCTIONALITY, not whether
         *  the screen can be opened). */}
        <button type="button" data-testid="compose" class="sidebar-compose" onClick={onCompose}>
          <span class="sidebar-compose-label">Compose</span>
          <span class="sidebar-compose-hint" style={{ fontFamily: FONT_MONO }}>
            C
          </span>
        </button>
      </div>

      <nav class="sidebar-scroll">
        <button
          type="button"
          data-testid="nav-all-inboxes"
          class={"sidebar-row sidebar-all-inboxes" + (currentAccount === null && (currentFolder === undefined || currentFolder === "inbox") ? " sidebar-row--active" : "")}
          onClick={onAllInboxes}
        >
          <span aria-hidden="true" class="sidebar-row-icon">
            <Inbox size={13} />
          </span>
          <span class="sidebar-row-label">All inboxes</span>
          <span data-testid="all-inboxes-count" class="sidebar-row-count sidebar-row-count--accent" style={{ fontFamily: FONT_MONO }}>
            {totalUnread}
          </span>
        </button>

        {blocks.map((block) => {
          const isCollapsed = collapsed.has(block.spec.key);
          return (
            <div key={block.spec.key} class="sidebar-account" data-testid={`account-block-${block.spec.key}`}>
              <button
                type="button"
                class="sidebar-account-toggle"
                data-testid={`account-toggle-${block.spec.key}`}
                onClick={() => toggleCollapsed(block.spec.key)}
              >
                <span
                  aria-hidden="true"
                  data-testid={`account-bar-${block.spec.key}`}
                  class="sidebar-account-bar"
                  style={{ background: toCssColor(block.spec.accent) }}
                />
                <span class="sidebar-account-name">{text(block.spec.label)}</span>
                <span
                  data-testid={`account-code-${block.spec.key}`}
                  class="sidebar-account-code"
                  style={{ fontFamily: FONT_MONO }}
                >
                  {text(block.spec.code ?? block.spec.key.slice(0, 3).toUpperCase())}
                </span>
                {(() => {
                  const badge = syncBadgeFor(block.spec, healthByAccount.get(block.spec.key));
                  if (badge === null) return null;
                  const title = syncBadgeTitle(badge, healthByAccount.get(block.spec.key));
                  if (badge === "syncing") {
                    return (
                      <span
                        aria-hidden="true"
                        title={title}
                        data-testid={`account-sync-${block.spec.key}`}
                        class="sidebar-account-sync sidebar-account-sync--syncing"
                      >
                        <RefreshCw size={10} strokeWidth={2} />
                      </span>
                    );
                  }
                  if (badge === "error") {
                    return (
                      <span
                        aria-hidden="true"
                        title={title}
                        data-testid={`account-sync-${block.spec.key}`}
                        class="sidebar-account-sync sidebar-account-sync--error"
                      >
                        <TriangleAlert size={10} strokeWidth={2} />
                      </span>
                    );
                  }
                  return (
                    <span
                      title={title}
                      data-testid={`account-sync-${block.spec.key}`}
                      class="sidebar-account-sync sidebar-account-sync--pending"
                    >
                      soon
                    </span>
                  );
                })()}
                <span aria-hidden="true" class="sidebar-account-chev">
                  {isCollapsed ? (
                    <ChevronRight size={11} strokeWidth={FAINT_STROKE} />
                  ) : (
                    <ChevronDown size={11} strokeWidth={FAINT_STROKE} />
                  )}
                </span>
              </button>

              {!isCollapsed && (
                <div class="sidebar-folders" data-testid={`account-folders-${block.spec.key}`}>
                  {(() => {
                    const renderNode = (node: FolderNode): JSX.Element[] => {
                      const mailbox = node.mailbox;
                      const folded = foldedFolders.has(`${block.spec.key}:${mailbox.id}`);
                      const isParent = node.children.length > 0;
                      // Only a folder with a ROLE can navigate -- see the
                      // `onNavigateFolder` doc comment on `SidebarProps`.
                      const clickable =
                        mailbox.role !== null ? onNavigateFolder !== undefined : onOpenMailbox !== undefined;
                      const iconKey = mailbox.role ?? mailbox.id;
                      const isActive =
                        currentAccount === block.spec.key &&
                        (mailbox.role !== null ? mailbox.role === currentFolder : mailbox.id === currentMailboxId);
                      const row = (
                        <div
                          key={mailbox.id}
                          class="sidebar-folder-row"
                          data-depth={node.depth}
                          style={node.depth > 0 ? { paddingLeft: `${node.depth * 14}px` } : undefined}
                        >
                          <button
                            type="button"
                            data-testid={`mailbox-${block.spec.key}-${mailbox.id}`}
                            data-depth={node.depth}
                            class={"sidebar-folder" + (isActive ? " sidebar-folder--active" : "")}
                            disabled={!clickable}
                            onClick={
                              !clickable
                                ? undefined
                                : mailbox.role !== null
                                  ? () => onNavigateFolder!(mailbox.role!, block.spec.key)
                                  : () => onOpenMailbox!(block.spec.key, mailbox.id)
                            }
                            onContextMenu={(e: MouseEvent) => {
                              if (onFolderMenu === undefined) return;
                              e.preventDefault();
                              onFolderMenu(mailbox, block.spec.key, { clientX: e.clientX, clientY: e.clientY });
                            }}
                            {...dropHandlers(mailbox.id, block.spec.key)}
                            title={clickable ? undefined : mailbox.role === null ? "This view cannot open a custom folder" : undefined}
                          >
                            <span
                              aria-hidden="true"
                              data-testid={`folder-icon-${block.spec.key}-${iconKey}`}
                              class="sidebar-folder-icon"
                            >
                              <FolderIcon role={mailbox.role} />
                            </span>
                            <span class="sidebar-folder-name">{text(mailbox.name)}</span>
                            {/* The design derives this count per folder, and only
                                the INBOX one is unread (Wilco.dc.html ~1318; audit
                                pass 4). A FOLDED parent shows its whole subtree's
                                held count, so nothing goes invisible (row 43). */}
                            <span
                              class={
                                "sidebar-folder-count" +
                                (mailbox.role === "inbox" && mailbox.unread > 0 ? " sidebar-folder-count--accent" : "")
                              }
                              style={{ fontFamily: FONT_MONO }}
                              data-testid={`folder-count-${block.spec.key}-${mailbox.id}`}
                            >
                              {isParent && folded ? formatCount(node.subtreeTotal) : folderCount(mailbox)}
                            </span>
                          </button>
                          {isParent && (
                            <button
                              type="button"
                              data-testid={`folder-chev-${block.spec.key}-${mailbox.id}`}
                              class="sidebar-folder-chev"
                              aria-label={folded ? `Expand ${mailbox.name}` : `Collapse ${mailbox.name}`}
                              aria-expanded={!folded}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleFolder(block.spec.key, mailbox.id);
                              }}
                            >
                              {folded ? (
                                <ChevronRight size={11} strokeWidth={FAINT_STROKE} />
                              ) : (
                                <ChevronDown size={11} strokeWidth={FAINT_STROKE} />
                              )}
                            </button>
                          )}
                        </div>
                      );
                      return folded ? [row] : [row, ...node.children.flatMap(renderNode)];
                    };
                    return folderTree(block.mailboxes).flatMap(renderNode);
                  })()}
                </div>
              )}
            </div>
          );
        })}

        <button type="button" data-testid="add-account" class="sidebar-row sidebar-add-account" onClick={() => onOpenAddAccount?.()}>
          <span aria-hidden="true" class="sidebar-row-icon">
            <Plus size={13} strokeWidth={FAINT_STROKE} />
          </span>
          <span class="sidebar-row-label">Add account</span>
        </button>

        <div class="sidebar-saved-label">Saved searches</div>
        {savedSearches.map((s) => (
          <button
            type="button"
            key={s.id}
            data-testid={`saved-search-${s.id}`}
            class="sidebar-row sidebar-saved"
            disabled={onSavedSearch === undefined}
            title={onSavedSearch === undefined ? SAVED_SEARCH_REASON : `Run: ${s.query}`}
            onClick={() => onSavedSearch?.(s)}
            onContextMenu={(e: MouseEvent) => {
              if (onSavedSearchMenu === undefined) return;
              e.preventDefault();
              onSavedSearchMenu(s, { clientX: e.clientX, clientY: e.clientY });
            }}
          >
            <span aria-hidden="true" class="sidebar-row-icon">
              <Bookmark size={12} />
            </span>
            <span class="sidebar-saved-query" style={{ fontFamily: FONT_MONO }}>
              {text(s.query)}
            </span>
            {/* Result count (DESIGN.md: "◎ icon + mono query + result
             *  count") -- a real `api.search` total, per-search, per this
             *  file's own doc comment. `undefined` while uncounted (fetch
             *  in flight, or it failed) renders NOTHING here, never a
             *  placeholder/invented number. */}
            <span data-testid={`saved-search-count-${s.id}`} class="sidebar-saved-count" style={{ fontFamily: FONT_MONO }}>
              {savedSearchCounts.has(s.id) ? savedSearchCounts.get(s.id)!.toLocaleString("en-US") : ""}
            </span>
          </button>
        ))}
      </nav>

      <div class="sidebar-status">
        <span aria-hidden="true" class="sidebar-status-dot" />
        <span data-testid="status-line" class="sidebar-status-line" style={{ fontFamily: FONT_MONO }}>
          JMAP push
        </span>
      </div>
      <div class="sidebar-footer">
        <button
          type="button"
          data-testid="settings"
          class={settingsOpen === true ? "sidebar-footer-btn sidebar-settings sidebar-settings-active" : "sidebar-footer-btn sidebar-settings"}
          onClick={onOpenSettings}
        >
          <SettingsIcon size={13} aria-hidden="true" />
          Settings
        </button>
        <button
          type="button"
          data-testid="theme-toggle"
          class="sidebar-footer-btn sidebar-icon-btn"
          aria-label="Toggle theme"
          aria-pressed={theme === "dark"}
          onClick={onToggleTheme}
        >
          <Contrast size={13} />
        </button>
        <button
          type="button"
          data-testid="shortcuts"
          class="sidebar-footer-btn sidebar-icon-btn"
          aria-label="Keyboard shortcuts"
          title="Shortcuts (?)"
          disabled={onShortcuts === undefined}
          style={{ fontFamily: FONT_MONO }}
          onClick={onShortcuts}
        >
          ?
        </button>
      </div>
    </aside>
  );
}
