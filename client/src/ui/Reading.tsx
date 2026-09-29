// The reading pane (design-fidelity plan, Task 4) -- PLAINTEXT ONLY. Spec
// 3.1's three privilege levels: the server holds credentials, the SPA holds
// none, and the body frame -- a separate origin under a capability token,
// serving message HTML -- holds neither and cannot run code. That frame is
// a later plan's work; until it exists, message HTML must never enter this
// document. So:
//
//   - Every message body renders `bodyText` (or a thread item's `preview`
//     as a stand-in until it has one). There is no `html` field on
//     `MessageDetail` and there must never be one (see api.ts).
//   - `hasHtml` is tri-state (`boolean | null`). `null` means details were
//     never fetched and must NOT be reported as "no HTML" -- only `true`
//     shows the notice.
//   - Attachment chips render name/type/size only, no download link --
//     attachment serving is spec 6.7, arriving with the body pipeline.
//     `inlineParts` (parts with a `cid`) are reported separately from
//     `attachments`; an inline signature logo is not an attachment.
//
// Everything rendered here is attacker-authored -- the body text most of
// all, plus subject, sender names and filenames -- and it renders in the
// CHROME, the origin holding the session cookie, well before the body
// sandbox exists (spec 10). Every string reaches the DOM only through
// `text()` (a Preact child, auto-escaped) or `safeExternalHref()` (for the
// one place a value reaches an attribute, an `href`). No raw-HTML-injection
// API is used anywhere in this file (Task 2's project-wide grep test bans
// it; its name is deliberately not spelled out literally here, same reason
// escape.ts's module comment gives, so this file doesn't trip that guard).
//
// The visual shape is transcribed from docs/design/Wilco.dc.html's Reading
// section (~lines 465-560), not invented: a header (subject, account
// square, mono meta, right-aligned action row ending in a filled accent
// Reply), then a centered conversation column -- earlier messages
// collapsed to one line until clicked, the open message as a card
// (avatar, name, mono address, a `text/plain` chip, time, an unwired `···`
// menu), a plaintext body, a `···` quoted-history toggle, attachment
// chips, and a `↩ Reply to <name>…` footer button. Every action button
// here except ↑/↓ is unwired in this plan -- rendered `disabled` with a
// `title` naming the reason, never silently dead, never omitted.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { ArrowDown, ArrowUp, Star } from "lucide-preact";
import { toCssColor } from "../lib/color";
import { safeExternalHref, text } from "../lib/escape";
import { COMPOSE_REASON, TRIAGE_REASON } from "../lib/keymap";
import { formatDetailTime } from "../lib/time";
import { BodyFrame, useMessageBody } from "./BodyFrame";
import type { BodyUrlResult } from "../lib/api";

/** Deliberately NOT `AttachmentMeta` from api.ts -- that type requires
 *  `partId`/`cid`, which is more than this pane needs to display a chip
 *  (name/type/size only, per the brief). A looser local shape keeps this
 *  component usable from a test that hands in exactly the three fields
 *  that matter, and `MessageDetail`'s real `AttachmentMeta[]` is still
 *  structurally assignable to it (every real attachment already has a
 *  name/type/size). */
export interface ReadingAttachment {
  name: string;
  type: string;
  size: number;
  /** The download URL on the body origin, once the mint has come back. */
  href?: string;
  /** The in-app viewer's URL (a raster image, inline), once minted. */
  viewUrl?: string;
}

/** A looser, display-only shape of `MessageDetail` -- every field but
 *  `subject` is optional so a test (or a thread item, or a not-yet-loaded
 *  message) can hand in only what it cares about. `MessageDetail` itself
 *  satisfies this by construction, which is what lets `App.tsx` pass the
 *  real fetched message straight through. Also doubles as the shape of
 *  one entry in `ReadingThread.messages` -- the design's earlier,
 *  collapsed conversation messages are lighter (name/preview/time) than
 *  the fully-fetched open message, and this type covers both without two
 *  near-identical interfaces. */
export interface ReadingMessage {
  /** `$draft` marks a message of the owner's own, opened for editing by App -- never framed here. */
  keywords?: Record<string, boolean>;
  /** Needed to build a stable `collapsed-<account>-<id>` /
   *  `expanded-<account>-<id>` test id and an expand/collapse key for
   *  each thread item. Optional because the brief's own existing tests
   *  construct a bare `{ bodyText, subject }` for the single open
   *  message, which never needs either. */
  account?: string;
  id?: string;
  /** Optional because a thread item (design's `sel.msgs` entries, all of
   *  which share the open message's subject) never needs to carry its
   *  own -- only `ReadingProps.message`, the header's title, does. */
  subject?: string;
  fromName?: string;
  fromEmail?: string;
  /** Real data when present -- `MessageDetail.isFlagged` (api.ts) carries
   *  JMAP's `$flagged` keyword, and `App.tsx` passes its fetched
   *  `MessageDetail` straight through as `ReadingProps.message` (see this
   *  file's module comment on that duck-typing convention). Drives the
   *  action row's flag button between the design's outline/filled star
   *  (Task: adopt Lucide icons, round-1 finding) -- omitted (`undefined`)
   *  renders the unflagged/outline state, same "no data means don't
   *  guess" convention `hasHtml` uses below. */
  isFlagged?: boolean;
  /** A collapsed thread row's one-line summary (design's `m.preview`).
   *  Falls back to `bodyText`'s first line when a caller supplies a full
   *  message instead of a summary row. */
  preview?: string;
  receivedAt?: string;
  bodyText?: string | null;
  /** Tri-state -- see the module comment. `undefined` (a test that omits
   *  it entirely) is treated exactly like `null`: no notice. */
  hasHtml?: boolean | null;
  attachments?: ReadingAttachment[];
  inlineParts?: ReadingAttachment[];
}

export interface ReadingThread {
  /** Oldest-first, matching `api.thread()` -- and, per the design, NOT
   *  including the currently open message (that's `ReadingProps.message`
   *  below). These render collapsed-by-default, expanding on click. */
  messages: ReadingMessage[];
}

export interface ReadingProps {
  message: ReadingMessage | null;
  /** The rest of the conversation, oldest-first, excluding `message`
   *  itself. Optional: a caller showing a single, threadless message (or
   *  a test not exercising the conversation) simply omits it. */
  thread?: ReadingThread;
  /** The opened message's account accent color (hex), from `GET
   *  /api/accounts` via `App`'s `accents` map -- passed in rather than
   *  looked up here so this component stays ignorant of account lookup,
   *  matching `MessageList`'s `accents` prop. */
  accent?: string;
  /** The account's short uppercase code and its own address (design's
   *  `acctById[sel.acct].code` / `.email`), for the header's mono meta
   *  line (`HAL · kai@halden.example · 4 messages`). `AccountSpec` (api.ts)
   *  has no `email` field today -- there is nothing to look up until the
   *  server grows one -- so both are optional and the meta line simply
   *  omits whatever it isn't given, rather than inventing a value. */
  accountCode?: string;
  accountEmail?: string;
  /** The ↑/↓ buttons in the action row. Unlike the other six buttons
   *  here, these duplicate real, wired keyboard commands (`j`/`k` ->
   *  `moveSelection`, keymap.ts's `next`/`prev`, which carry no
   *  `disabledReason` because they're NOT disabled) -- so disabling them
   *  here would contradict the keymap instead of agreeing with it, the
   *  exact bug this finding is about. Optional so this component's own
   *  tests don't need to supply them; the buttons render disabled with no
   *  handler wired, same as any other missing optional callback. */
  onPrev?: () => void;
  onNext?: () => void;
  /** Triage handlers. Omitted -> the control renders disabled with
   *  TRIAGE_REASON, the same convention every unwired control here
   *  uses. Supplied -> the action is live. */
  onArchive?: () => void;
  onSpam?: () => void;
  onDelete?: () => void;
  onToggleFlag?: () => void;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  /** Row 33: opens the message's print document in a new window. */
  onPrint?: () => void;
  /** Row 37: the "Reply to …" footer under the conversation. Omitted ->
   *  disabled with COMPOSE_REASON like the header's buttons. */
  onFooterReply?: () => void;
  /** Row 31: the unsubscribe method the open message offers (App probes
   *  the server on open). The control renders only when there is one. */
  unsubscribe?: "post" | "mailto" | null;
  onUnsubscribe?: () => void;
  /** Opens the per-message `···` context menu (design's `S.ctx.type ===
   *  'msg'`) at the click point -- Task 8 of this plan. `msg` is whichever
   *  card's menu was clicked (the open message or an expanded earlier
   *  one); App.tsx builds the menu's items (Reply/Reply all/Forward/View
   *  source/Copy address) since it alone knows which of those are really
   *  wired. Optional so this component's own tests, which don't exercise
   *  the menu, need not pass one -- the button stays `disabled` with
   *  `MENU_REASON` exactly as before when omitted. */
  onMessageMenu?: (msg: ReadingMessage, x: number, y: number) => void;
  /** Opens the attachment preview overlay (design's `S.filePreview`) --
   *  Task 8. Fires only for real attachments, never `inlineParts` (an
   *  inline signature logo isn't something a user asked to preview).
   *  Optional, same reasoning as `onMessageMenu` -- chips render inert
   *  when omitted, matching this file's pre-Task-8 behavior exactly. */
  onAttachmentClick?: (attachment: ReadingAttachment) => void;
  /** Mints the body-frame capability URL for a message (spec 3.3).
   *  Optional: absent means every message renders as plaintext, which is
   *  exactly the pre-body-pipeline behaviour every existing test asserts. */
  loadBodyUrl?: (account: string, id: string, opts: { images?: boolean; full?: boolean }) => Promise<BodyUrlResult>;
  /** The remoteImages preference: load remote images for every message. */
  remoteImagesDefault?: boolean;
  /** v1.1 #2's "Always from this sender". */
  onAlwaysAllowImages?: (account: string, sender: string) => Promise<void>;
}

const FALLBACK_ACCENT = "#8a8f97";

/** Transcribed verbatim from Wilco.dc.html line ~1205 -- the design's
 *  fixed five-color avatar palette for anyone who isn't "You". */
const AVATAR_COLORS = ["#5b6ee0", "#2a9d6e", "#c9903a", "#b05fc9", "#4a9bb8"];

const MENU_REASON = "Not yet available -- per-message actions arrive in a later plan.";

/** Matches Sidebar.tsx's/MessageList.tsx's `FONT_MONO` -- belt-and-braces
 *  alongside the CSS class's own `font-family: var(--font-mono)`. happy-dom
 *  (the test environment) does not load `components.css`, so a test
 *  reading `getComputedStyle(...).fontFamily` back only sees a value set
 *  right here, inline, never one that arrives solely through the class. */
const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function initials(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

/** Design line 1659: `m.from === 'You' ? 'var(--accent)' : avatarColors[(m.email.length + i) % avatarColors.length]`. */
function avatarBg(msg: ReadingMessage, index: number): string {
  if (msg.fromName === "You") return "var(--accent)";
  const email = msg.fromEmail ?? "";
  const n = (email.length + index) % AVATAR_COLORS.length;
  return AVATAR_COLORS[n]!;
}

/** Renders one line of plaintext body as a mix of escaped text and safe
 *  `<a>` links. Deliberately whitespace-tokenized rather than regex-global
 *  matched: `safeExternalHref` is the single source of truth for "is this
 *  a link", so a candidate is anything that survives it whole, and
 *  anything that doesn't (a bare `javascript:` scheme, stray punctuation)
 *  falls through to plain escaped text with no separate blocklist to keep
 *  in sync. */
export function linkifyLine(line: string, keyPrefix: string): (string | JSX.Element)[] {
  const parts = line.split(/(\s+)/);
  return parts.map((part, i) => {
    if (part.trim() === "") return part;
    const href = safeExternalHref(part);
    if (href === null) return part;
    return (
      <a key={`${keyPrefix}-${i}`} href={href} target="_blank" rel="noopener noreferrer">
        {text(part)}
      </a>
    );
  });
}

/** Splits a plaintext body into "main" text and a trailing "quoted
 *  history" section, per the design's `···` quoted-history toggle.
 *  Heuristic, not a parser: the first line that looks like a quote marker
 *  (`>` prefix, or an "On ... wrote:" attribution line) and everything
 *  after it is treated as quoted. A body with no such line has no quoted
 *  section at all -- nothing to collapse. */
function splitQuoted(bodyText: string): { main: string; quoted: string | null } {
  const lines = bodyText.split("\n");
  const quoteStart = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith(">") || /^On .+wrote:$/.test(trimmed);
  });
  if (quoteStart === -1) return { main: bodyText, quoted: null };
  return { main: lines.slice(0, quoteStart).join("\n"), quoted: lines.slice(quoteStart).join("\n") };
}

function AttachmentChip({
  attachment,
  testId,
  onClick,
  href,
}: {
  attachment: ReadingAttachment;
  testId: string;
  onClick?: () => void;
  /** A download URL on the BODY origin (spec 6.7). Never a link to this
   *  origin: an .html or .svg attachment served from here would be stored
   *  XSS on the origin holding the session cookie. */
  href?: string;
}): JSX.Element {
  // Three forms, one chip. A downloadable attachment is an `<a>`; a real
  // attachment with a preview handler is a `<button>`; an inline part, or
  // one with neither, stays the original inert `<span>`.
  const Tag = href !== undefined ? "a" : onClick !== undefined ? "button" : "span";
  return (
    <Tag
      type={href === undefined && onClick !== undefined ? "button" : undefined}
      href={href}
      // `noreferrer` so the capability URL is never sent onward. The
      // `download` attribute is deliberately absent: it is ignored
      // cross-origin, and what actually forces a save is the body origin's
      // own `Content-Disposition: attachment`.
      rel={href !== undefined ? "noopener noreferrer" : undefined}
      data-testid={testId}
      class="reading-attachment-chip"
      onClick={onClick}
    >
      <span>{text(attachment.name)}</span>
      <span class="reading-attachment-meta" style={{ fontFamily: FONT_MONO }}>
        {text(attachment.type)}
      </span>
      <span class="reading-attachment-meta" style={{ fontFamily: FONT_MONO }}>
        {formatSize(attachment.size)}
      </span>
    </Tag>
  );
}

/** One message rendered as the design's "open" card: avatar, name, mono
 *  address, a `text/plain` chip, time, an unwired `···` menu, the
 *  plaintext body, a quoted-history toggle, and attachment chips.
 *
 *  `idPrefix === null` marks THE currently open message (`ReadingProps
 *  .message`) -- it alone gets the plain test ids the brief's tests query
 *  by literal name (`body`, `from-address`, `body-type-chip`,
 *  `quote-toggle`). Every earlier, expanded thread message gets the same
 *  structure with an `-<account>-<id>` suffix instead, so two open cards
 *  on screen at once never collide on the same test id. */
function MessageCard({
  msg,
  index,
  idPrefix,
  onHeaderClick,
  onMenu,
  onAttachmentClick,
  loadBodyUrl,
  remoteImagesDefault,
  onAlwaysAllowImages,
  unsubscribe,
  onUnsubscribe,
}: {
  msg: ReadingMessage;
  index: number;
  idPrefix: string | null;
  /** Row 31's offer, for the OPEN message only. Shown as a strip on the
   *  card, not a button in the action bar: a bar whose contents change per
   *  message moves every other button (owner, 2026-09-09). */
  unsubscribe?: "post" | "mailto" | null;
  onUnsubscribe?: () => void;
  onHeaderClick?: () => void;
  onMenu?: (msg: ReadingMessage, x: number, y: number) => void;
  onAttachmentClick?: (attachment: ReadingAttachment) => void;
  loadBodyUrl?: (account: string, id: string, opts: { images?: boolean; full?: boolean }) => Promise<BodyUrlResult>;
  remoteImagesDefault?: boolean;
  onAlwaysAllowImages?: (account: string, sender: string) => Promise<void>;
}): JSX.Element {
  const [quoteOpen, setQuoteOpen] = useState(false);
  const bodyText = msg.bodyText ?? msg.preview ?? "";
  const { main, quoted } = splitQuoted(bodyText);
  const attachments = msg.attachments ?? [];
  const inlineParts = msg.inlineParts ?? [];
  const suffix = idPrefix !== null ? `-${idPrefix}` : "";

  // Whether this message can be shown through the body frame at all: it
  // must HAVE html (tri-state -- `null` means "we never looked", which is
  // not "no HTML"), we must know its (account, id) to mint a capability
  // for, and a minting function must have been supplied.
  // A capability is minted whenever the body pipeline can serve ANYTHING
  // for this message -- its HTML, or a download URL for its attachments.
  // Gating on hasHtml alone left a plaintext message's attachments as inert
  // metadata chips while an HTML message's were clickable, for no reason a
  // reader could see.
  // A DRAFT is opened for editing by App's $draft effect, never read here;
  // minting for it wasted a token and 404'd once the next autosave had
  // replaced the id (found by the sleepless harness, 2026-09-08).
  const isDraft = msg.keywords?.["$draft"] === true;
  const canUseBody =
    !isDraft && (msg.hasHtml === true || attachments.length > 0) && !!msg.account && !!msg.id && loadBodyUrl !== undefined;
  const canFrame = msg.hasHtml === true && canUseBody;
  const bodyHook = useMessageBody(
    canUseBody ? msg.account : undefined,
    canUseBody ? msg.id : undefined,
    loadBodyUrl,
    remoteImagesDefault === true,
  );
  // Download URLs by blobId, when the mint has come back. Absent means the
  // chips stay inert rather than linking somewhere that would 404.
  const downloadUrls = new Map(
    bodyHook.state.kind === "ready" ? bodyHook.state.body.attachments.map((a) => [a.name, a.url]) : [],
  );
  // A raster image opens in the app's viewer (2026-09-08: a jpg attachment
  // had "no way of opening it" -- the chip downloaded, silently, to a
  // folder). Everything else is still a download link.
  const viewUrls = new Map(
    bodyHook.state.kind === "ready"
      ? bodyHook.state.body.attachments.flatMap((a) => (a.viewUrl !== undefined ? [[a.name, a.viewUrl] as const] : []))
      : [],
  );

  // The plaintext body, built either way: it is what the frame falls back
  // to when the HTML cannot be fetched, and what the reader sees when they
  // ask for plaintext explicitly.
  const plainBody = (
        <div data-testid={`body${suffix}`} class="reading-body">
          {main.split("\n").map((line, i) =>
            // An empty <div> with no inline content forms no line box at
            // all (CSS gives it zero height regardless of `line-height`),
            // so a blank line between paragraphs silently vanished --
            // caught by the screenshot gate, not any test. A lone `<br>`
            // gives the div real content, and with it a real line's worth
            // of height, matching the design's blank-line paragraph gaps.
            line === "" ? (
              <div key={i}>
                <br />
              </div>
            ) : (
              <div key={i}>{linkifyLine(line, `main-${i}`)}</div>
            ),
          )}
          {quoted !== null && (
            <div class="reading-quote">
              <button
                type="button"
                data-testid={`quote-toggle${suffix}`}
                class="reading-quote-toggle"
                style={{ fontFamily: FONT_MONO }}
                title="Show quoted text"
                onClick={() => setQuoteOpen((o) => !o)}
              >
                ···
              </button>
              {quoteOpen && (
                <div data-testid={`quoted-body${suffix}`} class="reading-quote-body">
                  {quoted.split("\n").map((line, i) =>
                    line === "" ? (
                      <div key={i}>
                        <br />
                      </div>
                    ) : (
                      <div key={i}>{linkifyLine(line, `quoted-${i}`)}</div>
                    ),
                  )}
                </div>
              )}
            </div>
          )}
        </div>
  );

  return (
    <div class="reading-card">
      <div class="reading-card-header" onClick={onHeaderClick}>
        <span aria-hidden="true" class="reading-card-avatar" style={{ background: avatarBg(msg, index) }}>
          {initials(msg.fromName)}
        </span>
        <span class="reading-card-name">{text(msg.fromName || msg.fromEmail || "")}</span>
        <span data-testid={`from-address${suffix}`} class="reading-card-address" style={{ fontFamily: FONT_MONO }}>
          {text(msg.fromEmail ?? "")}
        </span>
        {/* 🚨 v1.1 #2: this badge IS the formatted/plaintext toggle. Click
            flips the rendered HTML to extracted plain text and the label
            follows. There is NO separate control -- the v1 "Show plaintext"
            button below the frame is gone. A non-HTML message shows an
            inert `text/plain` badge with a default cursor. */}
        {canFrame ? (
          <button
            type="button"
            data-testid={`body-type-chip${suffix}`}
            class="reading-card-chip reading-card-chip--toggle"
            style={{ fontFamily: FONT_MONO }}
            title="Toggle formatted / plain text"
            onClick={() => bodyHook.setShowPlaintext(!bodyHook.showPlaintext)}
          >
            {!bodyHook.showPlaintext ? "text/html" : "text/plain"}
          </button>
        ) : (
          /* A plaintext message has nothing to toggle, so the chip is a
             LABEL, not a disabled button -- row 37's tightened rule (every
             disabled control is a placeholder unless it has a live reason)
             found it as the app's one disabled-with-a-benign-title control. */
          <span
            data-testid={`body-type-chip${suffix}`}
            class="reading-card-chip"
            style={{ fontFamily: FONT_MONO }}
            title="Plain text message"
          >
            text/plain
          </span>
        )}
        <span class="reading-card-time" style={{ fontFamily: FONT_MONO }}>
          {formatDetailTime(msg.receivedAt, new Date())}
        </span>
        <button
          type="button"
          data-testid={`message-menu${suffix}`}
          class="reading-card-menu"
          disabled={onMenu === undefined}
          title={onMenu === undefined ? MENU_REASON : undefined}
          aria-label="Message actions"
          onClick={(e: MouseEvent) => onMenu?.(msg, e.clientX, e.clientY)}
        >
          ···
        </button>
      </div>

      {/* The old placeholder notice ("HTML formatting arrives with the body
          pipeline") is gone: the pipeline is here. It survives only for a
          message whose HTML we cannot fetch -- see BodyFrame's failure
          branch, which says so honestly rather than pretending. */}
      {unsubscribe !== undefined && unsubscribe !== null && onUnsubscribe !== undefined && (
        <div data-testid="unsubscribe-strip" class="body-strip body-strip--top">
          <span class="body-strip-text" style={{ fontFamily: FONT_MONO }}>
            {unsubscribe === "post" ? "mailing list · one-click unsubscribe, sent by Wilco" : "mailing list · unsubscribe by email"}
          </span>
          <button type="button" class="body-strip-btn" data-testid="unsubscribe" onClick={onUnsubscribe}>
            Unsubscribe
          </button>
        </div>
      )}

      {msg.hasHtml === true && !canFrame && (
        <div data-testid={`html-notice${suffix}`} class="reading-html-notice">
          Showing the plaintext version.
        </div>
      )}

      {canFrame ? (
        <BodyFrame
          body={bodyHook}
          suffix={suffix}
          fallback={plainBody}
          onAlwaysAllowImages={
            onAlwaysAllowImages === undefined || msg.account === undefined || msg.fromEmail === undefined
              ? undefined
              : (sender) => onAlwaysAllowImages(msg.account!, sender)
          }
        />
      ) : (
        plainBody
      )}

      {(attachments.length > 0 || inlineParts.length > 0) && (
        <div class="reading-attachments">
          {attachments.map((a, i) => (
            <AttachmentChip
              key={i}
              attachment={a}
              testId={`attachment-${i}${suffix}`}
              href={viewUrls.has(a.name) && onAttachmentClick !== undefined ? undefined : downloadUrls.get(a.name)}
              onClick={
                onAttachmentClick === undefined
                  ? undefined
                  : viewUrls.has(a.name)
                    ? () => onAttachmentClick({ ...a, href: downloadUrls.get(a.name), viewUrl: viewUrls.get(a.name) })
                    : downloadUrls.has(a.name)
                      ? undefined
                      : () => onAttachmentClick(a)
              }
            />
          ))}
          {inlineParts.map((a, i) => (
            <AttachmentChip key={i} attachment={a} testId={`inline-${i}${suffix}`} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Reading({
  message,
  thread,
  accent,
  accountCode,
  accountEmail,
  onPrev,
  onNext,
  onArchive,
  onSpam,
  onDelete,
  onToggleFlag,
  onReply,
  onReplyAll,
  onForward,
  onPrint,
  unsubscribe,
  onUnsubscribe,
  onFooterReply,
  onMessageMenu,
  onAttachmentClick,
  loadBodyUrl,
  remoteImagesDefault,
  onAlwaysAllowImages,
}: ReadingProps): JSX.Element {
  // See the comment on the element itself: focusing this column is what
  // stops Space/PageDown scrolling the message list instead of the message.
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const openKey = message === null ? null : `${message.account ?? ""}:${message.id ?? ""}`;
  useEffect(() => {
    if (openKey === null) return;
    // preventScroll so focusing does not itself jump the column -- a newly
    // opened message must start at the top.
    conversationRef.current?.focus({ preventScroll: true });
  }, [openKey]);

  // Keyed by "<account>:<id>" -- which earlier thread messages have been
  // clicked open. Starts empty: every earlier message is collapsed by
  // default (design's `msgToggles[key] ?? (i === last)`, and an earlier
  // message is by definition never the last).
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  if (message === null) {
    return (
      <section data-testid="reading" class="reading" style={{ flex: "1 1 auto", minWidth: 0, boxSizing: "border-box" }}>
        <div data-testid="reading-empty" class="reading-empty">
          <div class="reading-empty-inner">
            <div class="reading-empty-title">Nothing selected</div>
            <div class="reading-empty-hint">j / k to move · ⏎ to open · ⌘K for anything</div>
          </div>
        </div>
      </section>
    );
  }

  const earlier = thread?.messages ?? [];
  // The conversation in chronological order, the OPEN message placed among
  // the others by its time rather than always last (row 5, reported day
  // 1: opened by its middle message, a thread read first, third, second).
  // A message with no time keeps the order it arrived in; the open
  // message without one goes last, as before.
  const conversation: { msg: ReadingMessage; open: boolean }[] =
    message === null
      ? []
      : [...earlier.map((m) => ({ msg: m, open: false })), { msg: message, open: true }].sort((a, b) => {
          const ta = a.msg.receivedAt ?? "";
          const tb = b.msg.receivedAt ?? "";
          if (ta === "" || tb === "") return 0;
          return ta < tb ? -1 : ta > tb ? 1 : 0;
        });
  const accentColor = toCssColor(accent ?? FALLBACK_ACCENT);
  const totalCount = earlier.length + 1;
  const metaParts = [accountCode, accountEmail, `${totalCount} message${totalCount === 1 ? "" : "s"}`].filter(
    (p): p is string => p !== undefined && p.length > 0,
  );

  function toggle(key: string): void {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <section
      data-testid="reading"
      class="reading"
      style={{ flex: "1 1 auto", minWidth: 0, boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <header class="reading-header">
        <div class="reading-header-top">
          <h1 data-testid="reading-subject" class="reading-subject">
            {text(message.subject ?? "")}
          </h1>
          <div class="reading-meta-row">
            <span aria-hidden="true" data-testid="reading-account-square" class="reading-account-square" style={{ background: accentColor }} />
            <span data-testid="reading-meta" class="reading-meta" style={{ fontFamily: FONT_MONO }}>
              {metaParts.join(" · ")}
            </span>
          </div>
        </div>
        <div data-testid="reading-actions" class="reading-actions">
          {/* No previous/next buttons here (owner, 2026-09-09): j/k do it, and
              a bar that is the same width on every message is the point --
              buttons that move are buttons you chase. */}
          <button
            type="button"
            class="reading-act reading-act-icon"
            data-testid="act-flag"
            aria-label={message?.isFlagged === true ? "Unflag" : "Flag"}
            onClick={onToggleFlag}
            disabled={onToggleFlag === undefined}
            title={onToggleFlag === undefined ? TRIAGE_REASON : "Flag (s)"}
          >
            {message?.isFlagged === true ? (
              <Star size={12} fill="var(--flag)" stroke="var(--flag)" data-testid="act-flag-filled" />
            ) : (
              <Star size={12} data-testid="act-flag-outline" />
            )}
          </button>
          <button
            type="button"
            class="reading-act"
            data-testid="act-archive"
            onClick={onArchive}
            disabled={onArchive === undefined}
            title={onArchive === undefined ? TRIAGE_REASON : "Archive (e)"}
          >
            Archive
          </button>
          <button
            type="button"
            class="reading-act"
            data-testid="act-spam"
            onClick={onSpam}
            disabled={onSpam === undefined}
            title={onSpam === undefined ? TRIAGE_REASON : "Mark as spam"}
          >
            Spam
          </button>
          <button
            type="button"
            class="reading-act"
            data-testid="act-delete"
            onClick={onDelete}
            disabled={onDelete === undefined}
            title={onDelete === undefined ? TRIAGE_REASON : "Move to trash (#)"}
          >
            Delete
          </button>
          <button
            type="button"
            class="reading-act"
            data-testid="act-forward"
            onClick={onForward}
            disabled={onForward === undefined}
            title={onForward === undefined ? COMPOSE_REASON : "Forward (f)"}
          >
            Forward
          </button>
          {onPrint !== undefined && (
            <button type="button" class="reading-act" data-testid="print" onClick={onPrint} title="Print">
              Print
            </button>
          )}
          <button
            type="button"
            class="reading-act reading-act-reply"
            data-testid="act-reply"
            onClick={onReply}
            disabled={onReply === undefined}
            title={onReply === undefined ? COMPOSE_REASON : "Reply (r)"}
          >
            Reply
          </button>
        </div>
      </header>

      {/* 🚨 tabIndex=-1 and focused on open, and it is a SCROLL-KEY fix, not
          an accessibility nicety. Measured on the deployed build: with focus
          left on <body>, pressing Space or PageDown while reading scrolled
          the MESSAGE LIST 106px -- the browser walks from the focused
          element to the nearest scrollable ancestor, and that was the list
          pane, not this column. Focusing the column makes scroll keys act
          on the thing being read.

          Focusing a CHROME container is unrelated to spec 6.10's rule that
          the FRAME never takes focus: the frame keeps tabIndex=-1 and is
          never focused, so every shortcut still works with a message
          open. */}
      <div
        data-testid="reading-conversation"
        class="reading-conversation"
        tabIndex={-1}
        ref={conversationRef}
      >
        <div class="reading-conversation-inner">
          {conversation.map(({ msg: m, open }, i) => {
            if (open) {
              return (
                <MessageCard
                  key="open"
                  msg={m}
                  index={i}
                  idPrefix={null}
                  unsubscribe={unsubscribe}
                  onUnsubscribe={onUnsubscribe}
                  onMenu={onMessageMenu}
                  onAttachmentClick={onAttachmentClick}
                  loadBodyUrl={loadBodyUrl}
                  remoteImagesDefault={remoteImagesDefault}
                  onAlwaysAllowImages={onAlwaysAllowImages}
                />
              );
            }
            const key = `${m.account ?? ""}:${m.id ?? i}`;
            const suffix = `${m.account ?? ""}-${m.id ?? i}`;
            const isOpen = expandedKeys.has(key);

            if (!isOpen) {
              return (
                <button key={key} type="button" data-testid={`collapsed-${suffix}`} class="reading-collapsed" onClick={() => toggle(key)}>
                  <span aria-hidden="true" class="reading-collapsed-avatar">
                    {initials(m.fromName)}
                  </span>
                  <span class="reading-collapsed-name">{text(m.fromName || m.fromEmail || "")}</span>
                  <span class="reading-collapsed-preview">{text(m.preview ?? (m.bodyText ?? "").split("\n")[0] ?? "")}</span>
                  <span class="reading-collapsed-time" style={{ fontFamily: FONT_MONO }}>
                    {formatDetailTime(m.receivedAt, new Date())}
                  </span>
                </button>
              );
            }

            return (
              <div key={key} data-testid={`expanded-${suffix}`}>
                <MessageCard
                  msg={m}
                  index={i}
                  idPrefix={suffix}
                  onHeaderClick={() => toggle(key)}
                  onMenu={onMessageMenu}
                  onAttachmentClick={onAttachmentClick}
                  loadBodyUrl={loadBodyUrl}
                  remoteImagesDefault={remoteImagesDefault}
                  onAlwaysAllowImages={onAlwaysAllowImages}
                />
              </div>
            );
          })}

          <button
            type="button"
            class="reading-reply-footer"
            data-testid="reply-footer"
            disabled={onFooterReply === undefined}
            title={onFooterReply === undefined ? COMPOSE_REASON : "Reply (r)"}
            onClick={onFooterReply}
          >
            ↩ Reply to {text(message.fromName ?? "")}…
          </button>
        </div>
      </div>
    </section>
  );
}
