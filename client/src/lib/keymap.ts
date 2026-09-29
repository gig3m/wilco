// The keyboard layer (Task 10, spec §7.4 + the design handoff's
// "Keyboard-first" line). Three rules, all cost real bugs in Dovetail and
// are why this module exists as pure, DOM-free logic that a component
// wires up rather than each screen rolling its own `keydown` handler:
//
//   1. A keystroke inside a text field is text, not a command -- `j`
//      typed in the search box must insert `j`. `Escape` is the
//      deliberate exception, because it is how you leave a field.
//   2. The browser owns Ctrl/Meta/Alt too, not just the OS -- `Ctrl+K` is
//      the address bar, `Ctrl+W` closes the tab. Single-key commands are
//      ours; the palette binds `⌘K` on macOS (Meta, which browsers don't
//      reserve) and `Ctrl+Shift+K` elsewhere, never bare `Ctrl+K`.
//   3. Every command in the `?` overlay is either wired (a `handler`) or
//      visibly disabled with a `disabledReason` -- never silently absent.
//      Triage (archive/delete/flag/undo) lands in plan 7, compose/
//      reply/forward in plan 8, and attachment downloads arrive with the
//      body pipeline (spec 6.7) -- none of those backends exist yet in
//      this plan, so those commands are registered and explained, not
//      wired.
//
// This module knows nothing about `App`'s state -- `resolve`/`feed` turn a
// keystroke into a `CommandId`, and `COMMANDS[i].handler` is a thin
// dispatcher that calls whatever method the caller's `CommandContext`
// supplies. The caller (App.tsx) owns all real behavior.

export type CommandId =
  | "next"
  | "prev"
  | "open"
  | "select"
  | "archive"
  | "delete"
  | "flag"
  | "undo"
  | "allInboxes"
  | "layout"
  | "theme"
  | "search"
  | "palette"
  | "overlay"
  | "close"
  | "folderPrev"
  | "folderNext"
  | "compose"
  | "reply"
  | "replyAll"
  | "forward"
  | "settings"
  | "goto:top"
  | "goto:inbox"
  | "goto:drafts"
  | "goto:sent"
  | "goto:trash"
  | "goto:archive"
  | "goto:flagged"
  | `attach:${number}`;

/** The shape `resolve` needs off a real `KeyboardEvent` -- a plain object
 *  so this module (and its tests) never touch the DOM. `targetTag` is the
 *  originating element's tag name (any case; compared lower-cased);
 *  `isContentEditable` covers a rich-text region, which has no tag name
 *  that would otherwise flag it as a field. */
export interface KeyEvent {
  key: string;
  targetTag?: string;
  isContentEditable?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

function isTextTarget(e: KeyEvent): boolean {
  const tag = (e.targetTag ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || e.isContentEditable === true;
}

/** Single-key (no chord) command bindings. Deliberately excludes `g` --
 *  that key is a chord prefix only, handled by `chordState`/`feed` below,
 *  never a command on its own. */
const SINGLE_KEY_MAP: Record<string, CommandId> = {
  j: "next",
  k: "prev",
  Enter: "open",
  x: "select",
  e: "archive",
  "#": "delete",
  s: "flag",
  u: "allInboxes",
  v: "layout",
  t: "theme",
  "/": "search",
  z: "undo",
  "?": "overlay",
  "[": "folderPrev",
  "]": "folderNext",
  c: "compose",
  r: "reply",
  // Reply-all. The reading pane's own "Reply all" already advertises `a` as
  // its hint (App.tsx:767) and the key was never bound -- audit pass 3 D5.
  a: "replyAll",
  f: "forward",
  ",": "settings",
};
for (let n = 1; n <= 9; n++) {
  SINGLE_KEY_MAP[String(n)] = `attach:${n}` as CommandId;
}

/** Resolves ONE keystroke (no chord state) into a command, or `null` when
 *  the key is either not bound or belongs to a text field/the browser.
 *  Chord keys (`g …`) are handled separately by `feed`, which calls this
 *  only for the keys that follow a chord prefix, not for `g` itself. */
export function resolve(e: KeyEvent): CommandId | null {
  // The deliberate exception: Escape must work even while a field has
  // focus, because it's how you leave the field.
  if (e.key === "Escape") return "close";

  if (isTextTarget(e)) return null;

  const ctrl = e.ctrl === true;
  const meta = e.meta === true;
  const alt = e.alt === true;
  const shift = e.shift === true;

  if (ctrl || meta || alt) {
    const key = e.key.toLowerCase();
    // The palette's two deliberate, non-conflicting bindings (spec 7.4):
    // Meta+K on macOS (browsers don't reserve it), Ctrl+Shift+K
    // elsewhere. Bare Ctrl+K is the address bar and must never resolve.
    if (meta && !ctrl && !alt && key === "k") return "palette";
    if (ctrl && shift && !meta && !alt && key === "k") return "palette";
    return null; // every other modifier combo belongs to the OS/browser
  }

  return SINGLE_KEY_MAP[e.key] ?? null;
}

// ---------------------------------------------------------------------------
// Chords ("g" then a second key)
// ---------------------------------------------------------------------------

export const CHORD_TIMEOUT_MS = 1500;

/**
 * `g`-prefixed chords. The design's own set (`Wilco.dc.html:1035-1044`) is
 * inbox / drafts / sent / trash / archive / flagged; `g g` (top) is ours,
 * from spec 7.4, and additive.
 *
 * 🚨 Four of the design's six were unbound until audit pass 3 D5. In a
 * keyboard-first client that is not a small gap: the shortcut sheet lists
 * what the app can do, and `g d` was simply not one of them.
 */
const CHORDS: Record<string, Record<string, CommandId>> = {
  g: {
    g: "goto:top",
    i: "goto:inbox",
    d: "goto:drafts",
    s: "goto:sent",
    t: "goto:trash",
    a: "goto:archive",
    f: "goto:flagged",
  },
};

export interface ChordState {
  /** Advances the chord's virtual clock by `ms`. A real caller drives
   *  this off actual elapsed time between keystrokes; tests drive it
   *  directly, which is the whole point of not touching `Date.now()`
   *  here -- a stale chord must time out deterministically, not by
   *  chance of wall-clock timing in CI. */
  advance(ms: number): void;
}

interface ChordStateImpl extends ChordState {
  pending: string | null;
  elapsed: number;
}

export function chordState(): ChordState {
  const state: ChordStateImpl = {
    pending: null,
    elapsed: 0,
    advance(ms: number): void {
      if (state.pending !== null) state.elapsed += ms;
    },
  };
  return state;
}

/** Feeds one key into a chord in progress. Returns the resolved command
 *  once the sequence completes, or `null` while a chord is pending (or
 *  the key doesn't start/continue one at all). A chord that's gone stale
 *  (`advance`d past `CHORD_TIMEOUT_MS` since its first key) is dropped
 *  silently rather than firing late -- the exact bug a "user pressed g,
 *  walked away, came back and typed i for something else" scenario would
 *  otherwise produce. */
export function feed(state: ChordState, key: string): CommandId | null {
  const s = state as ChordStateImpl;

  if (s.pending !== null) {
    const prefix = s.pending;
    const timedOut = s.elapsed >= CHORD_TIMEOUT_MS;
    s.pending = null;
    s.elapsed = 0;
    if (timedOut) {
      // The stale chord is dropped. If the key that arrived is itself a
      // fresh chord prefix, start over instead of losing it.
      if (key in CHORDS) {
        s.pending = key;
        s.elapsed = 0;
      }
      return null;
    }
    return CHORDS[prefix]?.[key] ?? null;
  }

  if (key in CHORDS) {
    s.pending = key;
    s.elapsed = 0;
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The command registry -- backs the ⌘K palette and the `?` overlay
// ---------------------------------------------------------------------------

/** Everything a `Command.handler` may call. Every field is optional --
 *  App.tsx supplies only what it actually implements, and a command
 *  invoked without its method wired is a silent no-op rather than a
 *  crash. That's deliberate slack for a registry shared between the
 *  palette and the overlay: the two rendering surfaces need the full
 *  list (including disabled entries) even though only App.tsx's live
 *  instance can run any of it for real. */
export interface CommandContext {
  next?: () => void;
  prev?: () => void;
  open?: () => void;
  select?: () => void;
  allInboxes?: () => void;
  layout?: () => void;
  theme?: () => void;
  search?: () => void;
  palette?: () => void;
  overlay?: () => void;
  close?: () => void;
  folderPrev?: () => void;
  folderNext?: () => void;
  gotoTop?: () => void;
  gotoInbox?: () => void;
  /** Navigates to a folder by role -- the design's `g d`/`g s`/`g t`/`g a`. */
  gotoFolder?: (role: string) => void;
  /** The design's `g f`: runs `is:flagged` as a SEARCH, because flagged mail
   *  is not a folder. */
  gotoFlagged?: () => void;
  /** Triage (plan 7). Present -> the command is live; absent -> it stays
   *  disabled with TRIAGE_REASON, the same contract every other optional
   *  slot here uses. */
  reply?: () => void;
  replyAll?: () => void;
  forward?: () => void;
  archive?: () => void;
  deleteMessage?: () => void;
  flag?: () => void;
  undo?: () => void;
  /** Opens the compose pane. 🚨 The note that used to sit here -- "reply/
   *  forward still have no compose-shaped context to open INTO ... so those
   *  two stay disabledReason-only below" -- was false: both are wired, and
   *  have been since compose shipped. Audit pass 7 F1a found the row context
   *  menu still repeating that claim to the user next to a working `r`. */
  compose?: () => void;
  /** Opens Settings (Task 6 of this plan) -- the surface itself is real
   *  and reachable (`,` and the sidebar's ⚙ button both call this); only
   *  the individual controls inside it that need a backend (everything
   *  but theme/density/layout) stay disabled. Same "screen is reachable,
   *  actions inside may not be" shape as `compose` above. */
  settings?: () => void;
  /** Downloads the nth attachment (1-9) of the open message -- spec 7.4's
   *  `1`...`9`. Present -> the nine commands are live; absent -> they stay
   *  disabled, the same contract every other optional slot here uses. */
  saveAttachment?: (n: number) => void;
}

export interface Command {
  id: CommandId;
  label: string;
  /** Display form for the palette hint column and the `?` overlay --
   *  IBM Plex Mono in the UI, per the handoff's "mono-for-facts"
   *  convention. */
  keys: string;
  /** Present exactly when the command has a real, wired implementation.
   *  Mutually exclusive with `disabledReason` -- the keymap.test.ts
   *  guard (and the `?` overlay itself) enforce that every command
   *  carries one or the other. */
  handler?: (ctx: CommandContext) => void;
  /** Present exactly when the command is NOT wired -- shown verbatim in
   *  the `?` overlay so it admits the gap instead of listing a shortcut
   *  that silently does nothing. */
  disabledReason?: string;
}

// Exported so any chrome that renders one of these actions OUTSIDE the
// palette/overlay (Reading.tsx's action row, Sidebar.tsx's footer) uses
// the exact same wording instead of inventing its own -- the review's
// finding that the overlay "already does this correctly" while the
// chrome contradicted it.
/** Still used by controls whose triage backing is genuinely absent --
 *  today that is bulk actions on a checkbox selection, which is not
 *  lifted out of MessageList yet. The four single-message commands below
 *  are LIVE as of plan 7 and no longer carry this. */
export const TRIAGE_REASON = "Not yet available for a multi-message selection -- select-and-act arrives with bulk triage.";
/** 🚨 Rewritten in audit pass 7 (F1a). It used to read "there is no send
 *  path in this codebase yet; compose/reply/forward arrive in a later
 *  plan" -- send shipped 2026-09-04 and is verified end to end, and the
 *  row context menu was showing that sentence next to a Reply item whose
 *  own key hint `r` opened a reply. It now describes the only case that
 *  is still true: a Compose rendered without the handler prop. */
export const COMPOSE_REASON = "Unavailable here -- this window was rendered without a send handler.";
/** 🚨 Also rewritten in pass 7 (F1b). The old text blamed the body
 *  pipeline, which shipped 2026-09-04 -- an attachment chip is a real
 *  download link today (Reading.test.tsx:199). What is actually missing is
 *  the binding from these nine keys to those links, which is a keyboard
 *  gap, not a backend one. A disabled control naming a blocker that has
 *  shipped tells the next reader the work is upstream. */
const ATTACHMENT_REASON = "Not yet available -- attachment downloads work from the chip, but the number keys are not wired to them yet.";

export const COMMANDS: Command[] = [
  { id: "next", label: "Next message", keys: "j", handler: (ctx) => ctx.next?.() },
  { id: "prev", label: "Previous message", keys: "k", handler: (ctx) => ctx.prev?.() },
  { id: "open", label: "Open", keys: "⏎", handler: (ctx) => ctx.open?.() },
  { id: "select", label: "Select", keys: "x", handler: (ctx) => ctx.select?.() },
  { id: "archive", label: "Archive", keys: "e", handler: (ctx) => ctx.archive?.() },
  { id: "delete", label: "Delete", keys: "#", handler: (ctx) => ctx.deleteMessage?.() },
  { id: "flag", label: "Flag", keys: "s", handler: (ctx) => ctx.flag?.() },
  { id: "undo", label: "Undo", keys: "z", handler: (ctx) => ctx.undo?.() },
  { id: "allInboxes", label: "All inboxes", keys: "u", handler: (ctx) => ctx.allInboxes?.() },
  { id: "layout", label: "Toggle layout", keys: "v", handler: (ctx) => ctx.layout?.() },
  { id: "theme", label: "Toggle theme", keys: "t", handler: (ctx) => ctx.theme?.() },
  { id: "search", label: "Search", keys: "/", handler: (ctx) => ctx.search?.() },
  { id: "palette", label: "Command palette", keys: "⌘K", handler: (ctx) => ctx.palette?.() },
  { id: "goto:top", label: "Go to top", keys: "g g", handler: (ctx) => ctx.gotoTop?.() },
  { id: "goto:inbox", label: "Go to inbox", keys: "g i", handler: (ctx) => ctx.gotoInbox?.() },
  { id: "goto:drafts", label: "Go to drafts", keys: "g d", handler: (ctx) => ctx.gotoFolder?.("drafts") },
  { id: "goto:sent", label: "Go to sent", keys: "g s", handler: (ctx) => ctx.gotoFolder?.("sent") },
  { id: "goto:trash", label: "Go to trash", keys: "g t", handler: (ctx) => ctx.gotoFolder?.("trash") },
  { id: "goto:archive", label: "Go to archive", keys: "g a", handler: (ctx) => ctx.gotoFolder?.("archive") },
  // 🚨 Not a folder: the design's `g f` runs the SEARCH `is:flagged`
  // (Wilco.dc.html:1043). Flagged mail lives in every folder, so a route
  // would be the wrong shape for it.
  { id: "goto:flagged", label: "Go to flagged", keys: "g f", handler: (ctx) => ctx.gotoFlagged?.() },
  { id: "overlay", label: "Keyboard shortcuts", keys: "?", handler: (ctx) => ctx.overlay?.() },
  { id: "close", label: "Close", keys: "esc", handler: (ctx) => ctx.close?.() },
  { id: "folderPrev", label: "Previous folder", keys: "[", handler: (ctx) => ctx.folderPrev?.() },
  { id: "folderNext", label: "Next folder", keys: "]", handler: (ctx) => ctx.folderNext?.() },
  { id: "compose", label: "Compose", keys: "c", handler: (ctx) => ctx.compose?.() },
  { id: "settings", label: "Settings", keys: ",", handler: (ctx) => ctx.settings?.() },
  { id: "reply", label: "Reply", keys: "r", handler: (ctx) => ctx.reply?.() },
  { id: "replyAll", label: "Reply all", keys: "a", handler: (ctx) => ctx.replyAll?.() },
  { id: "forward", label: "Forward", keys: "f", handler: (ctx) => ctx.forward?.() },
  // 🚨 These were registered permanently disabled, blaming a body pipeline
  // that shipped on 2026-09-04 (audit pass 7 F1b). An attachment chip has
  // been a real download link since then; only the keys were never bound to
  // it. A disabled control naming a blocker that has already landed tells
  // the next reader the work is upstream, which is why it stayed unbuilt.
  ...Array.from({ length: 9 }, (_, i) => i + 1).map(
    (n): Command => ({
      id: `attach:${n}` as CommandId,
      label: `Save attachment ${n}`,
      keys: String(n),
      handler: (ctx) => ctx.saveAttachment?.(n),
      // Kept for the case the context does not supply the handler -- a
      // Reading rendered without one, exactly like `reply` and the rest.
      disabledReason: ATTACHMENT_REASON,
    }),
  ),
];
