// The one seam the SPA calls through to reach the server. Every method
// returns typed data or throws ApiError -- there is no other error shape a
// caller needs to handle.
//
// Two facts about the server this file exists to honour (spec 8.3 and the
// CSRF story in src/server/auth.ts):
//
//   - Search travels as POST /api/search with `{ q, limit?, cursor? }` in
//     the body. NPM logs the request line, so a query string sitting in a
//     URL is a leak waiting to happen -- it already happened once, through
//     a deprecated GET alias that is now gone server-side. Nothing in this
//     file may ever put query text in a URL.
//   - Every non-GET request needs the CSRF header. The real header name is
//     `x-wilco-csrf` (src/server/auth.ts's CSRF_HEADER), checked for mere
//     presence, not a specific value -- "1" is sent here only because it is
//     a legible truthy marker, not because the server compares it.
//
// The SPA never talks to Fastmail/JMAP directly and never holds a
// credential (spec 3.1) -- this file's entire job is being the one place
// that knows Wilco's own API shape, so every component calls `api.*`
// instead of touching `fetch` itself.

/** Thrown for every non-2xx response. `status` lets callers special-case
 *  401 (session gone -> route to login, never retried in a loop) without
 *  string-matching the message. */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const CSRF_HEADER = "x-wilco-csrf";

/** An account's connection details, mirrored from the server's own
 *  `src/core/accounts.ts` -- `GET /api/accounts` returns these directly
 *  (a bare array, not wrapped). `accent` is a real color value (currently
 *  a hex string), not a name to look up in a fixed palette: the sidebar
 *  must never hardcode a per-account color list. */
/** What `GET /api/accounts/:key/settings` returns. `settings` is sparse --
 *  an absent key means "not chosen", which is a different state from any
 *  particular value and must stay so (see core/settings.ts). */
export interface AccountSettings {
  settings: Record<string, string>;
  mailboxes: { id: string; name: string; role: string | null }[];
}

export interface AccountSpec {
  key: string;
  label: string;
  accent: string;
  provider: string;
  endpoint: string;
  /** Short uppercase code (design task-1's `accounts.code`) -- always
   *  present on anything the server reads back (migration 5 makes the
   *  column NOT NULL), but marked optional here so a stale server or a
   *  hand-built test fixture that omits it doesn't fail to typecheck. */
  code?: string;
  /** The owner's sidebar order, 0 first (row 34). Sent by every server that
   *  has migration 8; optional so an older fixture still typechecks. */
  position?: number;
  /** false: switched out of "All inboxes" (row 48) -- out of the unified
   *  list and its count, still in the sidebar and its own view. */
  showInUnified?: boolean;
  /** The JMAP session's own username, echoed back only when a credential
   *  was verified in the same request (accounts-api.ts's `addAccount`
   *  route). `null` means verification ran but the session reported none;
   *  absent means no credential was submitted (or an older server).
   *  AddAccount.tsx's step-3 log shows this, never a fabricated line. */
  username?: string | null;
  /** Merged in by App after `GET /api/identities` resolves -- the accounts
   *  endpoint itself does not carry them, and the identities call is a JMAP
   *  round trip per account that must not delay the sidebar. Absent means
   *  "not loaded yet", not "this account has none". */
  identities?: {
    id: string;
    email: string;
    /** The display name this identity sends under -- the name a recipient
     *  sees, which is NOT the account's `label` above (row 60). Optional
     *  so an older fixture still typechecks; absent means "no name known",
     *  and the select then shows the bare address. */
    name?: string | null;
    /** From the server's `mayDelete === false` (spec 11), never position. */
    primary: boolean;
    /** Byte for byte; the trailing space of `-- ` is significant. */
    textSignature: string;
    /** The HTML signature. `data:` images inside it are converted to `cid:`
     *  parts by the server on send (spec 11). */
    htmlSignature: string;
  }[];
}

export interface Mailbox {
  id: string;
  name: string;
  role: string | null;
  parent: string | null;
  /** Unread messages here. The sidebar shows this ONLY beside the inbox --
   *  see `total` and Sidebar's own comment on the design's `f.count`. */
  unread: number;
  /** Messages this client holds in the mailbox. Optional so a fixture or an
   *  older server that predates the field still renders (falls back to
   *  showing nothing rather than `undefined`). */
  total?: number;
}

export interface AccountMailboxes {
  account: string;
  mailboxes: Mailbox[];
}

export interface MailboxesResult {
  accounts: AccountMailboxes[];
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
  /** Messages in the conversation (v1.1 #1). Shown after the sender when
   *  greater than 1; absent or 1 on a search hit, which is one message. */
  threadCount?: number;
  via: string | null;
}

/** `cursor === null` means no next page. `truncated` means `total > limit`
 *  -- a global fact about the result set, still true on the last page, so
 *  it must never be read as "there is more". */
export interface ListResult<T> {
  rows: T[];
  total: number;
  cursor: string | null;
  truncated: boolean;
}

export interface MessagesFilters {
  account?: string;
  /** A mailbox ID, scoped to one account -- so `account` is required
   *  alongside it (the server rejects it otherwise: ids collide across
   *  accounts). Nothing in the SPA sends this today; the routes it has
   *  are all role-shaped. */
  mailbox?: string;
  /** A mailbox ROLE ("inbox", "archive", ...), which means the same thing
   *  in every account and so works with or without `account`. This is what
   *  the app's `/{mailbox}/...` route segment actually holds. */
  role?: string;
  unread?: boolean;
  flagged?: boolean;
  /** false: one row per message rather than per conversation. */
  group?: boolean;
  cursor?: string;
  limit?: number;
}

export interface SearchOpts {
  limit?: number;
  cursor?: string | null;
}

export interface Addr {
  name: string;
  email: string;
}

export interface AttachmentMeta {
  partId: string;
  name: string;
  type: string;
  size: number;
  cid: string | null;
}

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
  /** Tri-state (spec 3.1): `null` means details were never fetched -- it
   *  must never be reported as "no HTML". There is no `html` field and
   *  there must never be one. */
  hasHtml: boolean | null;
  keywords: Record<string, boolean>;
  mailboxIds: string[];
  attachments: AttachmentMeta[];
  inlineParts: AttachmentMeta[];
}

export interface UploadedAttachment {
  /** The account the blob was uploaded INTO. Blob ids are account-scoped
   *  (spec 11), so this must travel with the blob or a send from a
   *  different account is refused. */
  account: string;
  blobId: string;
  name: string;
  type: string;
  size: number;
}

export interface BodyAttachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
  /** On the body origin, under the same capability token. Never a link to
   *  this origin: an .html or .svg attachment served from here would be
   *  stored XSS on the origin holding the session cookie (spec 6.7). */
  url: string;
  /** The in-app viewer's URL: the same bytes inline, raster images only
   *  (2026-09-08). Absent means the chip is a download. */
  viewUrl?: string;
}

export interface BodyUrlResult {
  /** Absolute, on the body origin, carrying a short-lived capability
   *  token. Goes straight into an iframe `src` and nowhere else. */
  url: string;
  expiresInMs: number;
  remoteImages: boolean;
  /** True when images are on because of a standing per-sender allowance
   *  rather than this open (v1.1 #2's "· always for {address}"). */
  imagesAlways: boolean;
  sender: string;
  /** How many remote images the sanitizer blocked, or `null` when the
   *  server could not fetch the body to find out. `null` is NOT zero: the
   *  banner says nothing rather than claiming nothing was blocked. Reported
   *  here because a page cannot read the response headers of a cross-origin
   *  frame it embeds. */
  blockedRemoteImages: number | null;
  truncated: boolean;
  /** v1.1 #2's strip reads "showing 64 KB of 412 KB" -- both real. */
  shownBytes: number;
  totalBytes: number;
  full: boolean;
  attachments: BodyAttachment[];
}

export interface ThreadResult {
  messages: MessageDetail[];
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  position: number;
  createdAt: string;
}

export interface SavedSearchesResult {
  savedSearches: SavedSearch[];
}

export interface OkResult {
  ok: true;
}

/** Mirrored from the server's own `src/server/health.ts` (`HealthReport`),
 *  the same "duplicate the DTO shape, don't import server code" convention
 *  every other type in this file already follows (see `EmailRow`,
 *  `MessageDetail`, ...). `state` is a free string on purpose -- the
 *  server's `FailureKind` union ("auth" | "network" | "rate-limited" |
 *  "server" | "unknown") plus "ok" and "unknown" (never-synced default),
 *  none of which this client hardcodes as a closed set, so a new kind the
 *  server adds later degrades to "unrecognized" here instead of a type
 *  error. */
export interface AccountHealth {
  account: string;
  label: string;
  state: string;
  message?: string;
  walkComplete: boolean;
  hasEmailCursor: boolean;
  lastSyncAt: string | null;
  stale: boolean;
  detailsBackfillFailures: number;
}

export interface HealthReport {
  ok: boolean;
  error?: string;
  accounts: AccountHealth[];
}

/** Body for `POST /api/accounts` (Task 7, add-account onboarding).
 *  `credential` travels in the SAME request as the account row -- the
 *  server (accounts-api.ts) creates the row and, when `credential` is
 *  present, seals it into the configured `CredentialStore` atomically,
 *  rolling the row back if that write fails. There is no separate
 *  "create, then attach a credential" round trip on this path: `code` is
 *  deliberately absent here too, since the server derives it from `key`
 *  itself (accounts.ts's own default) whenever the caller doesn't supply
 *  one -- this client never invents a different rule for the same thing. */
/** A message addressed the only way that is ever correct here: ids collide
 *  across the four accounts, so `(account, id)` is the key, never `id`. */
export interface DraftPrefill {
  account: string;
  to: { email: string; name: string | null }[];
  cc: { email: string; name: string | null }[];
  subject: string;
  quoted: string;
  inReplyTo: string | null;
  references: string[] | null;
  /** false when the server could not read the account's identities, which
   *  means reply-all may include the user's own address. Surfaced rather
   *  than hidden. */
  ownAddressesKnown: boolean;
  /** The source has a text/html part: the reply is sent with `html: true`. */
  sourceHasHtml: boolean;
  /** "On …, X wrote:" for the composer's quote panel. */
  attribution: string;
  /** The message this reply quotes; shown read-only, attached at send.
   *  `mode` decides the attribution the server writes above it. */
  quoteSource: { account: string; id: string; mode: "reply" | "forward" } | null;
  /** The original's HTML through the editor profile, for the editor to
   *  adopt as the quote (row 44); null for a plaintext source. */
  quoteHtml?: string | null;
  /** The original's plain text, quoted when there is no HTML. */
  quoteText?: string | null;
  /** A forward's inherited attachments, by blob in `account`. Empty for a
   *  reply. */
  attachments: { blobId: string; name: string; type: string; size: number }[];
}

export interface Identity {
  id: string;
  name: string | null;
  email: string;
  /** 🚨 The server derives this from `mayDelete === false` (spec 11), which
   *  is the ONLY reliable marker: JMAP promises no ordering and the personal
   *  account has five identities. Never infer it from position. */
  primary: boolean;
  /** The HTML signature, byte for byte. `data:` images inside it become
   *  `cid:` parts on send (spec 11). */
  htmlSignature: string;
  /** Byte for byte as stored -- the trailing space of RFC 3676's `-- `
   *  separator is significant and must not be trimmed anywhere. */
  textSignature: string;
}

export interface IdentitiesResult {
  identities: Record<string, Identity[]>;
}

/** The mint response for a signature preview. `height` is the server's
 *  GENEROUS estimate of the rendered height in px (a cross-origin frame
 *  cannot be measured); null when the identity has no HTML signature. */
export interface SignatureUrl {
  url: string;
  hasHtml: boolean;
  height?: number | null;
}

export interface DraftInput extends Omit<SendInput, "to"> {
  /** A draft needs no recipient: "I have not decided who to send this to"
   *  is the normal state of an unfinished message. */
  to?: { email: string; name?: string | null }[];
  /** Absent on the first save; the id returned by the previous one after. */
  draftId?: string | null;
}

export interface SendInput {
  account: string;
  /** Must be one of the account's own identities -- the server refuses
   *  anything else with 403 rather than trusting Fastmail to catch it. */
  from: string;
  to: { email: string; name?: string | null }[];
  cc?: { email: string; name?: string | null }[];
  bcc?: { email: string; name?: string | null }[];
  subject: string;
  /** API senders: plain text, signature appended by the server. */
  text?: string;
  inReplyTo?: string | null;
  references?: string[] | null;
  /** The SPA: the editor's HTML (HTML compose). `true` is the older
   *  "generate an HTML half from `text`" request, still honoured for API
   *  callers. */
  html?: string | boolean;
  signature?: boolean;
  quoteSource?: { account: string; id: string; mode?: "reply" | "forward" } | null;
  signaturePlacement?: "above" | "below";
  /** Each carries the account it was uploaded into, so the server can
   *  refuse a stale blob by name rather than letting JMAP fail opaquely. */
  attachments?: UploadedAttachment[];
}

export type UnsubscribeResult =
  | { method: "post"; ok: boolean; status: number | null }
  | { method: "mailto"; ok: true; to: string; emailId: string };

/** Mirrors core/preferences.ts's PREFERENCES; the server validates. */
export interface Preferences {
  theme: "light" | "dark";
  density: "comfortable" | "compact";
  layout: "columns" | "rows";
  markRead: "instant" | "after2s" | "manual";
  remoteImages: "always" | "ask";
  groupConversations: "on" | "off";
  quoteHistory: "on" | "off";
  replyAllDefault: "on" | "off";
  archiveOnReply: "on" | "off";
  unifiedInboxAtLaunch: "on" | "off";
  notifDesktop: "on" | "off";
  notifPeopleOnly: "on" | "off";
  notifSound: "on" | "off";
  signaturePlacement: "above" | "below";
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "light",
  density: "comfortable",
  layout: "columns",
  markRead: "after2s",
  remoteImages: "ask",
  groupConversations: "on",
  quoteHistory: "on",
  replyAllDefault: "off",
  archiveOnReply: "off",
  unifiedInboxAtLaunch: "on",
  notifDesktop: "on",
  notifPeopleOnly: "off",
  notifSound: "off",
  signaturePlacement: "above",
};

export interface SendResult {
  sent: true;
  emailId: string;
  submissionId: string;
}

export interface TriageTarget {
  account: string;
  id: string;
}

export type TriageAction =
  | { kind: "move"; role: "inbox" | "archive" | "trash" | "junk" }
  | { kind: "moveTo"; mailboxId: string }
  /** 🚨 Marking spam is its OWN action, never `{ kind: "move", role: "junk" }`.
   *  Fastmail only learns from the folder its training points at, and which
   *  folder that is differs per account (spec 7.6) -- this account uses
   *  "Identified Spam", not the one carrying `role=junk`. The server
   *  resolves the per-account setting and REFUSES with a 400 when none is
   *  chosen, rather than guessing. */
  | { kind: "spam" }
  | { kind: "flag"; value: boolean }
  | { kind: "read"; value: boolean };

/** Row 58: the folder the user was looking at when they archived or moved.
 *  The list is one row per CONVERSATION, so the server widens each target
 *  to its thread's members in that folder. Sent for archive and folder
 *  moves only; delete and spam act on the message (owner ruling
 *  2026-09-15), and the server holds that rule on its own side too. */
export interface TriageScope {
  kind: "conversation";
  role?: string;
  mailboxId?: string;
}

export interface TriageResult {
  applied: number;
  failed: { target: TriageTarget; error: string }[];
  /** Present when at least one message changed. Feed it to `undoTriage`.
   *  null means nothing was applied, so there is nothing to undo. */
  undoId: string | null;
}

export interface UndoResult {
  restored: number;
  failed: { target: TriageTarget; error: string }[];
}

export interface AddAccountInput {
  key: string;
  label: string;
  accent: string;
  provider: string;
  endpoint: string;
  credential: string;
}

/**
 * Builds an API client bound to `fetchImpl` -- exported so tests can pass a
 * mock instead of touching the network. `api` below is the production
 * instance, bound to `globalThis.fetch`.
 */
/**
 * How many API requests are in flight, mirrored onto the document root as
 * `data-wilco-busy` so the harness can wait for the app to go QUIET instead
 * of sleeping a fixed number of seconds after every page load and click
 * (2026-09-08: 384s of a 657s board run was fixed sleeps). "0" means idle;
 * the attribute's presence means the app has mounted its API client.
 */
let inFlight = 0;
function markBusy(delta: number): void {
  inFlight += delta;
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-wilco-busy", String(inFlight));
}

export function makeApi(fetchImpl: FetchImpl) {
  markBusy(0);
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    markBusy(1);
    try {
      return await requestInner<T>(path, init);
    } finally {
      markBusy(-1);
    }
  }
  async function requestInner<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };

    // Every non-GET/HEAD call needs the CSRF header -- this includes
    // POST /api/search, which is a read shaped like a write purely because
    // it carries a body (see the module doc comment).
    if (method !== "GET" && method !== "HEAD") {
      headers[CSRF_HEADER] = "1";
    }
    if (init.body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }

    const res = await fetchImpl(path, {
      ...init,
      method,
      headers,
      // A session, never a bearer token -- the SPA always sends the
      // cookie, never holds a credential of its own (spec 3.1).
      credentials: "same-origin",
    });

    const raw = await res.text();
    let body: unknown = null;
    if (raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }

    if (!res.ok) {
      // 401 means the session is gone. It is surfaced through the same
      // ApiError as every other failure -- callers branch on `.status`,
      // not on a special exception type -- but it must never be retried
      // here; that is the caller's (routing) responsibility, not a loop
      // in this file.
      const message =
        body !== null && typeof body === "object" && typeof (body as Record<string, unknown>)["error"] === "string"
          ? ((body as Record<string, unknown>)["error"] as string)
          : res.statusText || `request failed (${res.status})`;
      throw new ApiError(res.status, message);
    }

    return body as T;
  }

  function messagesQuery(filters: MessagesFilters): string {
    const params = new URLSearchParams();
    if (filters.account !== undefined) params.set("account", filters.account);
    if (filters.mailbox !== undefined) params.set("mailbox", filters.mailbox);
    if (filters.role !== undefined) params.set("role", filters.role);
    if (filters.unread !== undefined) params.set("unread", String(filters.unread));
    if (filters.flagged !== undefined) params.set("flagged", String(filters.flagged));
    if (filters.group !== undefined) params.set("group", String(filters.group));
    if (filters.cursor !== undefined) params.set("cursor", filters.cursor);
    if (filters.limit !== undefined) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return qs === "" ? "/api/messages" : `/api/messages?${qs}`;
  }

  return {
    accounts: (): Promise<AccountSpec[]> => request<AccountSpec[]>("/api/accounts"),

    /** The owner's account order: every key exactly once, first first
     *  (row 34). The server answers with the accounts in that order. */
    setAccountOrder: (order: string[]): Promise<AccountSpec[]> =>
      request<AccountSpec[]>("/api/accounts/order", { method: "PUT", body: JSON.stringify({ order }) }),

    /** Per-account settings, with the account's mailboxes alongside them --
     *  every setting so far is a choice OF a mailbox, and a picker with no
     *  options is not a picker. One round trip so the two cannot disagree
     *  about which mailboxes exist. */
    /** Owner-wide preferences (row 37): theme, density, layout and the
     *  Settings switches, stored server-side so they survive a browser. */
    preferences: (): Promise<{ preferences: Preferences }> => request<{ preferences: Preferences }>("/api/preferences"),
    setPreference: (key: keyof Preferences, value: string): Promise<{ preferences: Preferences }> =>
      request<{ preferences: Preferences }>("/api/preferences", { method: "PUT", body: JSON.stringify({ key, value }) }),

    accountSettings: (account: string): Promise<AccountSettings> =>
      request<AccountSettings>(`/api/accounts/${encodeURIComponent(account)}/settings`),

    setAccountSetting: (account: string, key: string, value: string): Promise<AccountSettings> =>
      request<AccountSettings>(`/api/accounts/${encodeURIComponent(account)}/settings`, {
        method: "PUT",
        body: JSON.stringify({ key, value }),
      }),

    mailboxes: (): Promise<MailboxesResult> => request<MailboxesResult>("/api/mailboxes"),

    messages: (filters: MessagesFilters = {}): Promise<ListResult<EmailRow>> =>
      request<ListResult<EmailRow>>(messagesQuery(filters)),

    // POST body only -- the query text must never reach a URL (spec 8.3).
    search: (q: string, opts: SearchOpts = {}): Promise<ListResult<EmailRow>> =>
      request<ListResult<EmailRow>>("/api/search", {
        method: "POST",
        body: JSON.stringify({ q, ...opts }),
      }),

    message: (account: string, id: string): Promise<MessageDetail> =>
      request<MessageDetail>(`/api/messages/${encodeURIComponent(account)}/${encodeURIComponent(id)}`),

    /** The capability URL for a message's HTML body (spec 3.3). The SPA
     *  never receives the HTML itself -- only a URL on the BODY ORIGIN it
     *  puts in an iframe's src, so message HTML never enters this
     *  document. */
    bodyUrl: (account: string, id: string, opts: { images?: boolean; full?: boolean } = {}): Promise<BodyUrlResult> => {
      const params = new URLSearchParams();
      if (opts.images === true) params.set("images", "1");
      if (opts.full === true) params.set("full", "1");
      const query = params.toString();
      return request<BodyUrlResult>(
        `/api/messages/${encodeURIComponent(account)}/${encodeURIComponent(id)}/body-url` +
          (query === "" ? "" : `?${query}`),
      );
    },

    /** v1.1 #2's "Always from this sender". */
    allowSenderImages: (account: string, sender: string): Promise<{ allowed: boolean }> =>
      request<{ allowed: boolean }>(`/api/senders/${encodeURIComponent(account)}/allow-images`, {
        method: "POST",
        body: JSON.stringify({ sender }),
      }),

    thread: (account: string, threadId: string): Promise<ThreadResult> =>
      request<ThreadResult>(`/api/threads/${encodeURIComponent(account)}/${encodeURIComponent(threadId)}`),

    draftFor: (account: string, id: string, mode: "reply" | "reply-all" | "forward"): Promise<DraftPrefill> =>
      request<DraftPrefill>(
        `/api/messages/${encodeURIComponent(account)}/${encodeURIComponent(id)}/draft?mode=${mode}`,
      ),

    identities: (): Promise<IdentitiesResult> => request<IdentitiesResult>("/api/identities"),

    /** A capability URL for previewing an identity's HTML signature in the
     *  body frame -- our own HTML gets no privileged path into this
     *  document that a sender's does not have. */
    /** The identity's signature as a document the editor may ADOPT --
     *  sanitized server-side (HTML compose spec 3.2). */
    signatureHtml: (account: string, identityId: string): Promise<{ html: string; text: string }> =>
      request<{ html: string; text: string }>(
        `/api/identities/${encodeURIComponent(account)}/${encodeURIComponent(identityId)}/signature-html`,
      ),

    /** A $draft's own HTML, sanitized, with the quote source and placement
     *  it was saved with (HTML compose spec 3.5). */
    draftHtml: (
      account: string,
      id: string,
    ): Promise<{ html: string | null; quoteSource: { account: string; id: string; mode: "reply" | "forward" } | null; signaturePlacement: "above" | "below" | null }> =>
      request(`/api/messages/${encodeURIComponent(account)}/${encodeURIComponent(id)}/draft-html`),

    signatureUrl: (
      account: string,
      identityId: string,
    ): Promise<SignatureUrl> =>
      request<SignatureUrl>(
        `/api/identities/${encodeURIComponent(account)}/${encodeURIComponent(identityId)}/signature-url`,
      ),

    /** Writes a signature back to its JMAP Identity, byte for byte. */
    saveSignature: (
      account: string,
      identityId: string,
      textSignature: string,
      htmlSignature?: string,
    ): Promise<{ saved: boolean }> =>
      request<{ saved: boolean }>(
        `/api/identities/${encodeURIComponent(account)}/${encodeURIComponent(identityId)}/signature`,
        {
          method: "PUT",
          // `htmlSignature` omitted (not null) when the caller is only
          // touching the plaintext half -- the server leaves the other one
          // alone rather than blanking it.
          body: JSON.stringify(htmlSignature === undefined ? { textSignature } : { textSignature, htmlSignature }),
        },
      ),

    /** Uploads one file as a RAW body -- the filename rides in a header
     *  because a header cannot carry raw UTF-8, hence the encodeURIComponent.
     *  One request per file; there is no multipart parser on the server. */
    uploadAttachment: (
      account: string,
      file: File,
      onProgress?: (percent: number) => void,
    ): Promise<UploadedAttachment> =>
      // 🚨 XMLHttpRequest, not fetch, and only because of the progress
      // callback: v1.1 #3's uploading chip shows a LIVE percent, and
      // `fetch` still has no upload-progress event. Everything else about
      // the call is identical to `request` -- same CSRF header, same
      // same-origin cookie.
      new Promise<UploadedAttachment>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/attachments/${encodeURIComponent(account)}`);
        xhr.withCredentials = true;
        xhr.setRequestHeader(CSRF_HEADER, "1");
        xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
        xhr.setRequestHeader("x-wilco-filename", encodeURIComponent(file.name));
        if (onProgress) {
          xhr.upload.addEventListener("progress", (e) => {
            // `lengthComputable` is false for a chunked body; reporting 0
            // beats reporting a number derived from an unknown total.
            if (e.lengthComputable && e.total > 0) {
              onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
            }
          });
        }
        xhr.addEventListener("load", () => {
          if (xhr.status < 200 || xhr.status >= 300) {
            let message = `Upload failed (${xhr.status})`;
            try {
              const body = JSON.parse(xhr.responseText) as { error?: string };
              if (typeof body.error === "string") message = body.error;
            } catch {
              // A non-JSON error body: the status is all we can report.
            }
            reject(new Error(message));
            return;
          }
          try {
            resolve(JSON.parse(xhr.responseText) as UploadedAttachment);
          } catch {
            reject(new Error("The server's response could not be read."));
          }
        });
        xhr.addEventListener("error", () => reject(new Error("The upload could not reach the server.")));
        xhr.addEventListener("abort", () => reject(new Error("Upload cancelled.")));
        xhr.send(file);
      }),

    /** Creates the draft on the first call and updates it thereafter --
     *  pass back the `draftId` you were given. */
    saveDraft: (input: DraftInput): Promise<{ draftId: string; account: string }> =>
      request<{ draftId: string; account: string }>("/api/drafts", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    discardDraft: (account: string, draftId: string): Promise<{ discarded: boolean }> =>
      request<{ discarded: boolean }>(
        `/api/drafts/${encodeURIComponent(account)}/${encodeURIComponent(draftId)}`,
        { method: "DELETE" },
      ),

    send: (input: SendInput): Promise<SendResult> =>
      request<SendResult>("/api/send", { method: "POST", body: JSON.stringify(input) }),

    /** Row 31: which unsubscribe method the message offers (null: none),
     *  and performing it -- the server does the one-click POST or sends
     *  the mailto from the account, and reports what happened. */
    /** Empty trash (row 37): destroys the messages that are only in that
     *  account's Trash, on the server and locally. Refused for any other
     *  folder. */
    emptyTrash: (account: string, mailboxId: string): Promise<{ destroyed: number; considered: number }> =>
      request<{ destroyed: number; considered: number }>(`/api/mailboxes/${encodeURIComponent(account)}/${encodeURIComponent(mailboxId)}/empty`, { method: "POST" }),

    /** "People only" (row 37): has this account ever written to that address? */
    writtenTo: (account: string, email: string): Promise<{ written: boolean }> =>
      request<{ written: boolean }>("/api/contacts/written", { method: "POST", body: JSON.stringify({ account, email }) }),

    unsubscribeInfo: (account: string, id: string): Promise<{ method: "post" | "mailto" | null }> =>
      request<{ method: "post" | "mailto" | null }>(
        `/api/messages/${encodeURIComponent(account)}/${encodeURIComponent(id)}/unsubscribe`,
      ),
    unsubscribe: (account: string, id: string): Promise<UnsubscribeResult> =>
      request<UnsubscribeResult>(`/api/messages/${encodeURIComponent(account)}/${encodeURIComponent(id)}/unsubscribe`, {
        method: "POST",
      }),

    /** To-field suggestions (row 23). POST: the fragment is a search term
     *  and never rides a URL. */
    contacts: (account: string, q: string): Promise<{ contacts: { name: string; email: string }[] }> =>
      request<{ contacts: { name: string; email: string }[] }>("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ account, q }),
      }),

    triage: (action: TriageAction, targets: TriageTarget[], scope?: TriageScope): Promise<TriageResult> =>
      request<TriageResult>("/api/triage", {
        method: "POST",
        body: JSON.stringify(scope === undefined ? { action, targets } : { action, targets, scope }),
      }),

    undoTriage: (undoId: string): Promise<UndoResult> =>
      request<UndoResult>("/api/triage/undo", {
        method: "POST",
        body: JSON.stringify({ undoId }),
      }),

    savedSearches: (): Promise<SavedSearchesResult> => request<SavedSearchesResult>("/api/saved-searches"),

    addSaved: (name: string, query: string): Promise<SavedSearch> =>
      request<SavedSearch>("/api/saved-searches", {
        method: "POST",
        body: JSON.stringify({ name, query }),
      }),

    renameSaved: (id: string, name: string): Promise<OkResult> =>
      request<OkResult>(`/api/saved-searches/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),

    // Idempotent server-side on an unknown id (200), unlike renameSaved
    // (404) -- see read-api.ts's DELETE route doc comment. This client just
    // passes that through; it does not special-case either status.
    removeSaved: (id: string): Promise<OkResult> =>
      request<OkResult>(`/api/saved-searches/${encodeURIComponent(id)}`, { method: "DELETE" }),

    // Bulk reorder takes the FULL id list -- a partial list is refused
    // server-side, not silently accepted (see reorderSaved in saved.ts).
    reorderSaved: (ids: string[]): Promise<SavedSearchesResult> =>
      request<SavedSearchesResult>("/api/saved-searches", {
        method: "PATCH",
        body: JSON.stringify({ ids }),
      }),

    // Task 7's add-account onboarding. Session-only, like every route in
    // accounts-api.ts (never sent with a bearer token) -- `api`'s CSRF
    // header above covers that the same way every other mutating call
    // does. The response is a bare `AccountSpec` (the server's 201 body),
    // never an echo of `credential`.
    /** Row 37's account page: edit label/accent/code, ask for a resync,
     *  paste a new credential, remove the account. */
    updateAccount: (key: string, patch: { label?: string; accent?: string; code?: string }): Promise<AccountSpec> =>
      request<AccountSpec>(`/api/accounts/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify(patch) }),
    resyncAccount: (key: string): Promise<{ requested: boolean; note: string }> =>
      request<{ requested: boolean; note: string }>(`/api/accounts/${encodeURIComponent(key)}/resync`, { method: "POST" }),
    setCredential: (key: string, credential: string): Promise<OkResult> =>
      request<OkResult>(`/api/accounts/${encodeURIComponent(key)}/credential`, { method: "PUT", body: JSON.stringify({ credential }) }),
    removeAccount: (key: string): Promise<OkResult> =>
      request<OkResult>(`/api/accounts/${encodeURIComponent(key)}`, { method: "DELETE" }),

    addAccount: (input: AddAccountInput): Promise<AccountSpec> =>
      request<AccountSpec>("/api/accounts", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    logout: (): Promise<OkResult> => request<OkResult>("/api/logout", { method: "POST" }),

    // Used only by the login gate the SPA shows itself when a call comes
    // back 401 (there is no separate server-rendered login page). Same CSRF header as every other non-GET call; the
    // server's rate limiter (main.ts's `loginLimiter`) is what actually
    // stops a brute-force loop, not anything in this file.
    login: (password: string): Promise<OkResult> =>
      request<OkResult>("/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),

    // GET /healthz -- deliberately NOT routed through `request()`: that
    // helper throws on any non-2xx status, but `/healthz` answers 503
    // (main.ts's `buildRouter`) exactly when `HealthReport.ok` is false,
    // which is the ordinary "an account needs attention" case this method
    // exists to surface, not a fetch failure. The body carries the real
    // report either way; only a genuinely unparseable response (network
    // error, non-JSON) should reject. No CSRF header needed -- GET, same
    // as every other read in this file.
    health: async (): Promise<HealthReport> => {
      const res = await fetchImpl("/healthz", { credentials: "same-origin" });
      return (await res.json()) as HealthReport;
    },
  };
}

export type Api = ReturnType<typeof makeApi>;

/** The production instance every component calls through. */
export const api: Api = makeApi((url, init) => globalThis.fetch(url, init));
