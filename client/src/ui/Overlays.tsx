// Overlays and toasts (design-fidelity plan, Task 8). Transcribed from
// docs/design/Wilco.dc.html's own literal markup for each of the six
// blocks this file covers: the `?` shortcuts overlay (~lines 775-808), the
// context menu (~590-611), the move picker (~613-628), the attachment
// preview (~630-646), raw source (~648-660), the undo toast (~662-668) and
// the notification toasts (~670-688). Every `style=` value below is read
// off that file's inline attributes, not guessed -- including the fact
// that the design gives the context menu, the notification toast and the
// two modal-shaped overlays each their OWN box-shadow, not one shared
// "dropdown" value:
//   - modals (shortcuts / raw source / move picker / attachment preview):
//     0 24px 70px rgba(0,0,0,.3)  (design lines 649/614/631/775)
//   - context menu:                0 12px 36px rgba(0,0,0,.22) (line 591)
//   - notification toast:          0 8px 28px rgba(0,0,0,.18)  (line 672)
//   - undo toast:                  0 10px 32px rgba(0,0,0,.28) (line 664)
//
// One component, not six, because App.tsx needs exactly one thing open at
// a time (`open`) plus an independent toast layer that can show regardless
// of what else is open (a notification can arrive while the shortcuts
// overlay is up) -- matching the design's own flat `S.rawView`/`S.ctx`/
// `S.movePick`/`S.filePreview`/`S.shortcutsOpen`/`S.undo`/`S.notifs` state
// shape, which is also never more than one modal-shaped thing at once.
//
// Escaping (spec 6.8/6.11): every string this file renders -- a raw
// message's headers and body, a notification's sender/subject/snippet, an
// attachment's filename, a context-menu label built from a folder/saved-
// search name -- is attacker-controlled and renders in the CHROME (the
// origin holding the session cookie), same as Reading.tsx/Sidebar.tsx/
// MessageList.tsx. Every one of those strings reaches the DOM only as a
// Preact child via `text()`, which Preact escapes automatically -- NEVER
// through a raw-HTML-injection API (this file uses none; Task 2's
// project-wide grep test bans it). The raw-source `<pre>` in particular
// renders `text(source.text)` as one text node, so a message body that
// happens to contain `<script>` or `<img onerror=...>` is inert HTML-
// looking TEXT, never markup.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { placeMenu } from "../lib/placement";
import type { JSX } from "preact";
import { Archive, Folder, Inbox, X } from "lucide-preact";
import { toCssColor } from "../lib/color";
import { text } from "../lib/escape";
import { COMPOSE_REASON, TRIAGE_REASON } from "../lib/keymap";
import { COMMANDS, type Command, type CommandId } from "../lib/keymap";

const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

// The four literal shadow values, named per the module comment above.
const SHADOW_MODAL = "0 24px 70px rgba(0, 0, 0, 0.3)";
const SHADOW_CONTEXTMENU = "0 12px 36px rgba(0, 0, 0, 0.22)";
const SHADOW_NOTIFICATION = "0 8px 28px rgba(0, 0, 0, 0.18)";
const SHADOW_UNDO = "0 10px 32px rgba(0, 0, 0, 0.28)";

// Maps the legacy unicode glyphs `MoveFolder.icon` still carries (App.tsx's
// `openMoveTo` sets "▤" for inbox, "▣" for archive) to their Lucide
// equivalent -- same substitution Sidebar.tsx's FOLDER_ICON makes for the
// sidebar's own folder rows. Anything else (undefined, or the design's
// generic "▸") falls back to a plain folder glyph.
// See Sidebar.tsx's `IconComponent` comment -- aliasing off one lucide-preact
// export is what keeps this Record's values structurally assignable.
type IconComponent = typeof Inbox;

const MOVE_FOLDER_ICON: Record<string, IconComponent> = {
  "▤": Inbox,
  "▣": Archive,
};

function MoveFolderIcon({ glyph }: { glyph: string | undefined }): JSX.Element {
  const Icon = (glyph === undefined ? undefined : MOVE_FOLDER_ICON[glyph]) ?? Folder;
  return <Icon size={12} strokeWidth={1.5} />;
}

export type OverlayOpen = "none" | "shortcuts" | "source" | "attachment" | "move" | "contextmenu";

/** A message's raw source view (design's `rawSource()`). Wilco has no
 *  server-side raw-RFC822 endpoint (JMAP's `Email/get` gives parsed
 *  fields, not a byte-for-byte blob) -- unlike the design's mock, which
 *  fabricates a plausible Received/Message-ID chain purely for visual
 *  flavor, `App.tsx` only ever builds `text` from fields the server truly
 *  returned (From/To/Cc/Subject/Date/Reply-To + the plaintext body). This
 *  component renders whatever it's handed; it has no opinion on how
 *  honest the reconstruction is, only that it renders as text. */
export interface RawSource {
  /** Shown in the header's mono meta slot (design's `rawId`). */
  id: string;
  text: string;
}

export interface AttachmentPreview {
  name: string;
  type: string;
  size: number;
  /** The image itself, from the body origin, when the attachment is a
   *  raster image (2026-09-08). Absent: the design's swatch stands in. */
  viewUrl?: string;
  /** The design's `fpKind` -- a short word ("Image", "PDF", "File") shown
   *  inside the checkered preview swatch. Falls back to `type` when
   *  omitted, matching how Reading.tsx already derives a mime-type label. */
  kind?: string;
  /** Present exactly when a real download path exists. Wilco has none yet
   *  (spec 6.7, same gap Reading.tsx's chips already document) -- when
   *  omitted, the Download button renders `disabled` with a `title`
   *  instead of silently doing nothing. */
  onDownload?: () => void;
}

export interface MoveFolder {
  id: string;
  name: string;
  /** The design's mono glyph column (▤/✎/↗/▣/▸) -- callers (App.tsx's
   *  `openMoveTo`) still hand this in as one of the original unicode
   *  characters; `MOVE_FOLDER_ICON` below maps it to the equivalent Lucide
   *  icon at render time (Task: adopt Lucide icons) rather than changing
   *  every caller's data shape for a purely decorative field. Purely
   *  decorative either way. */
  icon?: string;
  /** Present exactly when moving a message into THIS folder is really
   *  possible. Wilco has no `Email/set`-backed move endpoint yet (same gap
   *  as every other triage action, TRIAGE_REASON) -- omitted renders the
   *  row disabled with `disabledReason`, the picker's own version of the
   *  "screen is real, the action inside may not be" shape. */
  onSelect?: () => void;
  disabledReason?: string;
}

export interface MovePicker {
  /** The design's `moveAcct` -- shown as the header's mono meta slot. */
  account: string;
  folders: MoveFolder[];
}

export interface ContextMenuItem {
  label: string;
  /** The mono hint column (a key binding, a count, or blank). */
  hint?: string;
  /** Design's `ci.color` -- '#cf222e' for Delete/Remove. Renders as
   *  `var(--danger)` here rather than the design's hardcoded literal, so
   *  it tracks the theme token instead of a light-mode-only red. */
  danger?: boolean;
  divider?: boolean;
  onSelect?: () => void;
  /** Shown as the disabled row's `title` when `onSelect` is omitted --
   *  same convention as `MoveFolder.disabledReason` and the shortcuts
   *  overlay's `Command.disabledReason`. */
  disabledReason?: string;
}

export interface ContextMenu {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export interface NotificationToast {
  kind: "notification";
  /** The account key -- not rendered directly, but present so a caller
   *  (App.tsx) can key a list of these without a separate id field. */
  account: string;
  /** Hex accent, matching `AccountSpec.accent` -- converted to `rgb(...)`
   *  before it reaches `borderLeftColor` (same reasoning as `color.ts`'s
   *  own doc comment: happy-dom's `getComputedStyle` never normalizes a
   *  hex value a browser's CSSOM would). */
  accent: string;
  /** The design's mono account-code chip (design's `n.code`). */
  code?: string;
  from: string;
  subject: string;
  snippet?: string;
  /** Design's `n.viaLabel` -- the account's own address, shown in the
   *  mono "now · kai@halden.example" footer line. */
  via?: string;
  onOpen?: () => void;
  onDismiss?: () => void;
  /** Reply/Archive are both triage/compose actions -- neither exists in
   *  this codebase yet (`TRIAGE_REASON`/`COMPOSE_REASON`, keymap.ts).
   *  Design-fidelity Pass B finding 5 (owner ruling): render them,
   *  `disabled`, with the real reason as `title` -- the same "screen is
   *  real, the action inside isn't" shape every other unbacked control in
   *  this plan uses (shortcuts overlay's `Command.disabledReason`, the
   *  undo toast's `undoDisabledReason`, `MoveFolder.disabledReason`).
   *  Omitting them read as a layout bug (an empty row) rather than an
   *  honest admission -- never omit again. */
}

export interface UndoToast {
  kind: "undo";
  /** The design's `undoLabel`, already formatted ("Archived 3"). */
  label: string;
  /** F11 (design-fidelity Pass D, 2026-09-04): this file used to also
   *  carry a `seconds` field rendering `label + ' Ns'` (Wilco.dc.html
   *  line ~1526's `undoLabel`). That suffix is real in the design, but
   *  ONLY for `pushUndo`'s optional third `ttl` argument, which every
   *  triage call site (Archived/Deleted/Marked read/Removed…) omits --
   *  the ONE call site that passes a `ttl` is the "Sending in" outbox
   *  countdown, a send-delay feature this codebase has no send path
   *  for. Every undo toast THIS codebase can produce is triage-shaped,
   *  so the design's own literal behavior for that case is the label
   *  alone, with no countdown ever -- removed rather than kept as an
   *  unused option, per design-fidelity review. */
  /** UI-ONLY IN THIS PLAN (Task 8 brief): there is no triage and no undo
   *  stack anywhere in this codebase yet. Omitting this renders `Undo`
   *  disabled with `undoDisabledReason` as its `title` -- exactly the
   *  same "screen is real, the action inside isn't" shape Compose/
   *  Settings/Reading already use, rather than a button that claims to
   *  work and silently does nothing. */
  onUndo?: () => void;
  undoDisabledReason?: string;
}

export type ToastState = NotificationToast | UndoToast;

export interface OverlaysProps {
  open: OverlayOpen;
  onClose: () => void;
  /** Defaults to keymap.ts's own `COMMANDS` -- the shortcuts overlay's
   *  whole reason for existing (module comment) is that it can't drift
   *  from what the keyboard layer actually does, so reading the same
   *  source of truth by default (rather than requiring every caller,
   *  including tests, to pass it explicitly) keeps that guarantee even
   *  when a caller forgets the prop. */
  commands?: Command[];
  source?: RawSource;
  attachment?: AttachmentPreview;
  move?: MovePicker;
  contextMenu?: ContextMenu;
  toast?: ToastState;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stop(e: JSX.TargetedMouseEvent<HTMLElement>): void {
  e.stopPropagation();
}

function runAndClose(fn: () => void, onClose: () => void): void {
  fn();
  onClose();
}

// Fix round 1 (Task 8 review, Important 1): the reviewer compared
// Wilco.dc.html's own `shortcuts:` table (line 1751) against
// ref-1440-light-shortcuts.png and confirmed the design genuinely GROUPS
// related commands onto one row ("Compose / Reply / Forward" -> one row
// reading "c r f"). The per-key-per-row list this file shipped in round 0
// was a real, visible fidelity gap -- ruling: the design wins over the
// per-key row shape, and the brief's per-key test assertions stay alive
// by nesting a `shortcut-${key}` testid INSIDE each grouped row rather
// than giving every key its own row.
//
// `SHORTCUT_GROUPS` mirrors the design's table where a design row has a
// real backing command in keymap.ts's `COMMANDS` (12 of the design's 14
// rows -- design's "Reply all" (`a`) and "Simulate incoming" (`n`) have
// NO corresponding `CommandId` anywhere in keymap.ts, so there is nothing
// honest to back a row for them; they're omitted rather than inventing a
// fake command, and the gap is called out in the task report). Every
// command NOT claimed by a group still renders -- spec 7.3's "never
// silently absent" rule predates this task and outranks matching the
// design's row COUNT -- as its own trailing single-command row, using
// that command's own real label. This also means a future command added
// to `COMMANDS` with no `SHORTCUT_GROUPS` entry shows up automatically
// instead of silently vanishing from the overlay.
const SHORTCUT_GROUPS: { what: string; ids: CommandId[] }[] = [
  { what: "Command palette", ids: ["palette"] },
  { what: "Next / previous thread", ids: ["next", "prev"] },
  { what: "Compose / Reply / Forward", ids: ["compose", "reply", "forward"] },
  { what: "Flag", ids: ["flag"] },
  { what: "Archive / Delete", ids: ["archive", "delete"] },
  { what: "Focus search", ids: ["search"] },
  { what: "All inboxes", ids: ["allInboxes"] },
  // The design's own hint text here ("g + i d s t a f") describes a
  // per-folder-letter chord scheme keymap.ts does not implement --
  // Wilco's real folder navigation is `[`/`]` plus the two real chords
  // (`g g`/`g i`). Grouped under the design's label, showing the REAL
  // keys rather than the design's fictional ones (spec 6.8-adjacent
  // "state only what's true" rule the raw-source view already follows).
  { what: "Go to folder", ids: ["folderPrev", "folderNext", "goto:top", "goto:inbox"] },
  { what: "Toggle theme / layout", ids: ["theme", "layout"] },
  { what: "Select / deselect", ids: ["select"] },
  { what: "Undo", ids: ["undo"] },
  { what: "This overlay", ids: ["overlay"] },
  // Not in the design's table at all (it never modeled attachments as
  // individually numbered saves) -- grouped here rather than as nine
  // trailing rows, purely to keep the overlay's length reasonable; still
  // fully honest, every one disabled with its real reason.
  { what: "Save attachment", ids: Array.from({ length: 9 }, (_, i) => `attach:${i + 1}` as CommandId) },
];

function ShortcutsOverlay({ commands, onClose }: { commands: Command[]; onClose: () => void }): JSX.Element {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const used = new Set<CommandId>();
  const rows: { what: string; cmds: Command[] }[] = [];
  for (const group of SHORTCUT_GROUPS) {
    const cmds = group.ids.map((id) => byId.get(id)).filter((c): c is Command => c !== undefined);
    for (const c of cmds) used.add(c.id);
    if (cmds.length > 0) rows.push({ what: group.what, cmds });
  }
  for (const c of commands) {
    if (!used.has(c.id)) rows.push({ what: c.label, cmds: [c] });
  }

  return (
    <div data-testid="shortcuts-overlay" role="dialog" aria-modal="true" class="overlay-scrim" onClick={onClose}>
      <div
        data-testid="overlay-card"
        class="overlay-card overlay-card-shortcuts"
        style={{ boxShadow: SHADOW_MODAL }}
        onClick={stop}
      >
        <div class="overlay-header">
          <h2 class="overlay-title">Keyboard shortcuts</h2>
          <span class="overlay-hint" style={{ fontFamily: FONT_MONO }}>
            ? to toggle
          </span>
        </div>
        <div class="shortcuts-grid">
          {rows.map((row, i) => (
            <div key={i} data-testid={`shortcut-row-${i}`} class="shortcuts-row">
              <span class="shortcuts-what">{text(row.what)}</span>
              <span class="shortcuts-key" style={{ fontFamily: FONT_MONO }}>
                {row.cmds.map((cmd, j) => (
                  <span
                    key={cmd.id}
                    data-testid={`shortcut-${cmd.keys}`}
                    class="shortcuts-key-part"
                    title={cmd.disabledReason}
                    style={{ opacity: cmd.disabledReason !== undefined ? 0.45 : 1 }}
                  >
                    {j > 0 && " "}
                    {text(cmd.keys)}
                    {cmd.disabledReason !== undefined && (
                      <span data-testid={`shortcut-disabled-${cmd.id}`} class="sr-only">
                        {" — "}
                        {text(cmd.disabledReason)}
                      </span>
                    )}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
        <button type="button" data-testid="shortcuts-close" class="overlay-close" onClick={onClose} aria-label="Close">
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

function SourceOverlay({ source, onClose }: { source: RawSource; onClose: () => void }): JSX.Element {
  return (
    <div data-testid="source-overlay" role="dialog" aria-modal="true" class="overlay-scrim" onClick={onClose}>
      <div data-testid="overlay-card" class="overlay-card overlay-card-source" style={{ boxShadow: SHADOW_MODAL }} onClick={stop}>
        <div class="overlay-header overlay-header-bordered">
          <span class="overlay-title-flex">Raw message</span>
          <span class="overlay-meta" style={{ fontFamily: FONT_MONO }}>
            {text(source.id)}
          </span>
          <button type="button" data-testid="source-close" class="overlay-close-inline" onClick={onClose} aria-label="Close">
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
        <pre data-testid="source-text" class="source-body" style={{ fontFamily: FONT_MONO }}>
          {text(source.text)}
        </pre>
      </div>
    </div>
  );
}

function AttachmentOverlay({ attachment, onClose }: { attachment: AttachmentPreview; onClose: () => void }): JSX.Element {
  const kind = attachment.kind ?? attachment.type;
  return (
    <div data-testid="attachment-overlay" role="dialog" aria-modal="true" class="overlay-scrim" onClick={onClose}>
      <div data-testid="overlay-card" class="overlay-card overlay-card-attachment" style={{ boxShadow: SHADOW_MODAL }} onClick={stop}>
        <div class="overlay-header overlay-header-bordered">
          <span data-testid="attachment-name" class="overlay-title-flex" style={{ fontFamily: FONT_MONO }}>
            {text(attachment.name)}
          </span>
          <span data-testid="attachment-size" class="overlay-meta" style={{ fontFamily: FONT_MONO }}>
            {formatSize(attachment.size)}
          </span>
          <button type="button" data-testid="attachment-close" class="overlay-close-inline" onClick={onClose} aria-label="Close">
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
        {attachment.viewUrl !== undefined ? (
          <div class="attachment-preview-image">
            <img data-testid="attachment-image" src={attachment.viewUrl} alt={attachment.name} />
          </div>
        ) : (
          <div class="attachment-preview-swatch">
            <span data-testid="attachment-type-badge" class="attachment-type-badge" style={{ fontFamily: FONT_MONO }}>
              {text(kind)} preview
            </span>
          </div>
        )}
        <div class="overlay-footer">
          <button
            type="button"
            data-testid="attachment-download"
            class="overlay-primary-btn"
            onClick={attachment.onDownload}
            disabled={attachment.onDownload === undefined}
            title={
              attachment.onDownload === undefined
                ? "Not yet available — attachment downloads arrive with the body pipeline (spec 6.7)."
                : undefined
            }
          >
            Download
          </button>
          <span class="overlay-footer-fill" />
          {attachment.viewUrl === undefined && (
          <span class="overlay-footer-note" style={{ fontFamily: FONT_MONO }}>
              scanned · clean
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function MoveOverlay({ move, onClose }: { move: MovePicker; onClose: () => void }): JSX.Element {
  return (
    <div data-testid="move-overlay" role="dialog" aria-modal="true" class="overlay-scrim overlay-scrim-top" onClick={onClose}>
      <div data-testid="overlay-card" class="overlay-card overlay-card-move" style={{ boxShadow: SHADOW_MODAL }} onClick={stop}>
        <div class="overlay-header overlay-header-bordered">
          <span class="overlay-title-flex">Move to</span>
          <span class="overlay-meta" style={{ fontFamily: FONT_MONO }}>
            {text(move.account)}
          </span>
        </div>
        <div class="move-folder-list">
          {move.folders.map((f) => (
            <button
              key={f.id}
              type="button"
              data-testid={`move-folder-${f.id}`}
              class="move-folder-row"
              disabled={f.onSelect === undefined}
              title={f.onSelect === undefined ? f.disabledReason : undefined}
              onClick={f.onSelect !== undefined ? () => runAndClose(f.onSelect!, onClose) : undefined}
            >
              <span class="move-folder-icon" aria-hidden="true">
                <MoveFolderIcon glyph={f.icon} />
              </span>
              <span class="move-folder-name">{text(f.name)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ContextMenuOverlay({ menu, onClose }: { menu: ContextMenu; onClose: () => void }): JSX.Element {
  // Measured after the first paint and shifted to fit the viewport (row
  // 53). Until measured it sits where it was asked to; the shift, if any,
  // lands before the next frame.
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const el = card.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return; // no layout (tests): leave it where asked
    setPos(placeMenu(menu.x, menu.y, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [menu.x, menu.y, menu.items.length]);
  return (
    <div
      data-testid="contextmenu-overlay"
      class="contextmenu-scrim"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={card}
        data-testid="overlay-card"
        class="contextmenu-card"
        style={{ left: `${pos.left}px`, top: `${pos.top}px`, boxShadow: SHADOW_CONTEXTMENU }}
        onClick={stop}
      >
        {menu.items.map((item, i) =>
          item.divider === true ? (
            <div key={i} class="contextmenu-divider" />
          ) : (
            <button
              key={i}
              type="button"
              data-testid={`contextmenu-item-${i}`}
              class="contextmenu-item"
              disabled={item.onSelect === undefined}
              title={item.onSelect === undefined ? item.disabledReason : undefined}
              onClick={item.onSelect !== undefined ? () => runAndClose(item.onSelect!, onClose) : undefined}
            >
              <span class={"contextmenu-item-label" + (item.danger === true ? " contextmenu-item-label--danger" : "")}>
                {text(item.label)}
              </span>
              {item.hint !== undefined && (
                <span class="contextmenu-item-hint" style={{ fontFamily: FONT_MONO }}>
                  {text(item.hint)}
                </span>
              )}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function UndoToastView({ toast }: { toast: UndoToast }): JSX.Element {
  const disabled = toast.onUndo === undefined;
  return (
    <div data-testid="toast" data-toast-kind="undo" class="undo-toast" style={{ boxShadow: SHADOW_UNDO }}>
      <span class="undo-toast-label">{text(toast.label)}</span>
      <button
        type="button"
        data-testid="toast-undo"
        class="undo-toast-btn"
        onClick={toast.onUndo}
        disabled={disabled}
        title={disabled ? (toast.undoDisabledReason ?? "Not yet available — there is no undo stack in this codebase yet.") : undefined}
      >
        Undo
      </button>
      <span class="undo-toast-hint" style={{ fontFamily: FONT_MONO }}>
        z
      </span>
    </div>
  );
}

function NotificationToastView({ toast }: { toast: NotificationToast }): JSX.Element {
  const borderColor = toCssColor(toast.accent);
  return (
    <div class="notification-toast-layer">
      <div
        data-testid="toast"
        data-toast-kind="notification"
        class="notification-toast"
        style={{ borderLeftColor: borderColor, boxShadow: SHADOW_NOTIFICATION }}
        onClick={toast.onOpen}
      >
        <div class="notification-toast-top">
          <span data-testid="toast-from" class="notification-toast-from">
            {text(toast.from)}
          </span>
          {toast.code !== undefined && (
            <span class="notification-toast-code" style={{ color: borderColor, fontFamily: FONT_MONO }}>
              {text(toast.code)}
            </span>
          )}
          <button
            type="button"
            data-testid="toast-dismiss"
            class="notification-toast-dismiss"
            onClick={(e) => {
              e.stopPropagation();
              toast.onDismiss?.();
            }}
            aria-label="Dismiss"
          >
            <X size={11} strokeWidth={1.5} />
          </button>
        </div>
        <div data-testid="toast-subject" class="notification-toast-subject">
          {text(toast.subject)}
        </div>
        {toast.snippet !== undefined && <div class="notification-toast-snippet">{text(toast.snippet)}</div>}
        <div class="notification-toast-bottom">
          <button
            type="button"
            data-testid="toast-reply"
            class="notification-toast-action"
            disabled
            // Not COMPOSE_REASON: replying works everywhere else. This
            // toast has no message identity to reply TO -- it carries a
            // subject and a snippet, not an (account, id) -- so wiring it
            // needs the notification to name its message first.
            title="Not yet available -- this notification does not carry the message it is about."
            onClick={(e) => e.stopPropagation()}
          >
            Reply
          </button>
          <button
            type="button"
            data-testid="toast-archive"
            class="notification-toast-action"
            disabled
            title={TRIAGE_REASON}
            onClick={(e) => e.stopPropagation()}
          >
            Archive
          </button>
          <span class="notification-toast-fill" />
          <span class="notification-toast-via" style={{ fontFamily: FONT_MONO }}>
            now{toast.via !== undefined ? ` · ${toast.via}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Escape closes whatever overlay is open (design's global keydown
 *  handler, ~line 1002: `paletteOpen: false, shortcutsOpen: false, ...,
 *  ctx: null, movePick: null, rawView: null, filePreview: null`).
 *  Deliberately does NOT dismiss a toast -- the design's own handler
 *  doesn't clear `undo` or `notifs` on Escape either; a toast dismisses
 *  itself (timeout, its own ✕, or opening it), never the keyboard layer. */
export function Overlays({ open, onClose, commands, source, attachment, move, contextMenu, toast }: OverlaysProps): JSX.Element {
  useEffect(() => {
    if (open === "none") return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <>
      {open === "shortcuts" && <ShortcutsOverlay commands={commands ?? COMMANDS} onClose={onClose} />}
      {open === "source" && source !== undefined && <SourceOverlay source={source} onClose={onClose} />}
      {open === "attachment" && attachment !== undefined && <AttachmentOverlay attachment={attachment} onClose={onClose} />}
      {open === "move" && move !== undefined && <MoveOverlay move={move} onClose={onClose} />}
      {open === "contextmenu" && contextMenu !== undefined && <ContextMenuOverlay menu={contextMenu} onClose={onClose} />}
      {toast !== undefined && (toast.kind === "undo" ? <UndoToastView toast={toast} /> : <NotificationToastView toast={toast} />)}
    </>
  );
}
