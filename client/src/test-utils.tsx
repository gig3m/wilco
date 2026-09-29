// Shared test scaffolding for the client's component tests, established
// here (Task 5, Ruling S1) because six later tasks (6-10) each need
// `render`/`byTestId`/history and API fakes and inventing one per file
// would be strictly worse than one small shared module. Deliberately not
// clever: a thin wrapper over `preact` + `preact/test-utils`, a couple of
// DOM query helpers, and hand-rolled fakes for the two seams every screen
// depends on (`Api`, history). Extend this file rather than duplicating
// its shape elsewhere.
//
// `fakeApi`'s two kinds of override, and which key each uses (Task 6
// review, round 1): every REAL `Api` method can be overridden directly by
// name (`fakeApi({ message: () => ... })`) -- that key always takes a
// FUNCTION. `accounts` and `mailboxes` additionally have a convenience
// CANNED-DATA form, but it lives on a *separate* key with a `Data` suffix
// -- `accountsData: FakeAccountSpec[]` and `mailboxesData:
// FakeMailboxSpec[]` -- specifically so no key on this object ever means
// two different shapes depending on what's passed. An earlier version
// overloaded `accounts`/`mailboxes` themselves to accept either a function
// or an array; that was flagged as a foot-gun before more tasks could
// build on it. Use `accountsData`/`mailboxesData` for "here's the data a
// test needs"; use `accounts`/`mailboxes` only to replace the fetch
// behavior itself (an error, a delay, a call-count assertion).
//
// `spy()` (Task 6): a minimal call-recording function double for a plain
// callback prop (`onThemeChange`, etc.) -- `fakeApi` above records calls
// on the `Api` seam specifically and is the wrong shape for "did this one
// prop get called." Not vitest's own `vi.fn()`, to keep this file's
// helpers framework-light like everything else here.
import { render as preactRender, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import { DEFAULT_PREFERENCES } from "./lib/api";
import type {
  AccountHealth,
  AccountSpec,
  AddAccountInput,
  Api,
  EmailRow,
  HealthReport,
  ListResult,
  Mailbox,
  MailboxesResult,
  MessageDetail,
  OkResult,
  SavedSearchesResult,
} from "./lib/api";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The container most recently produced by `render`. `byTestId` reads from
 *  this rather than a value threaded through every test -- the brief's own
 *  examples call `byTestId(...)` with no container argument, so this module
 *  tracks "the thing under test" the same way Testing Library's default
 *  export does. Reset to `null` on `unmount` so a stale reference can't
 *  leak into the next render. */
let currentContainer: HTMLElement | null = null;

/** The container `render` must tear down before mounting the next one. Kept
 *  separate from `currentContainer` (which `unmount` nulls out) so an
 *  explicit `unmount()` and the implicit one here can't double-remove. */
let previousContainer: HTMLElement | null = null;

export interface RenderResult {
  container: HTMLElement;
  /** Re-renders a new vnode into the SAME container/root as the initial
   *  `render` call (Preact's diffing semantics -- component instances
   *  survive a `rerender`, only their props change). Task 7 needs this to
   *  test that a prop change alone -- e.g. switching `mailbox` -- resets
   *  local state, which a fresh `render`/`unmount` pair can't exercise. */
  rerender(vnode: ComponentChild): void;
  unmount(): void;
}

/** Mounts `vnode` into a fresh `<div>` appended to `document.body` and
 *  returns a handle to it. Wrapped in `act` so the initial render -- and
 *  any effects it schedules -- are flushed synchronously; a caller that
 *  needs to observe an async effect (a fetch) still awaits `tick()`
 *  afterward. */
export function render(vnode: ComponentChild): RenderResult {
  // 🚨 The previous render is torn down first. Nothing ever called
  // `unmount()`, so every container ever created stayed in `document.body`
  // for the rest of the file: a test reading the DOM through anything wider
  // than `byTestId` -- `document.querySelectorAll`, `document.body.textContent`
  // -- saw the accumulated output of every test before it. That produced
  // four false results and one hung worker before it was named, and it
  // produced another one in the audit (pass 4's folder-count test read
  // eleven folders from three different fixtures).
  //
  // Torn down with `preactRender(null, ...)` rather than just detached, so
  // effect cleanups actually run: a component holding an interval or an
  // open EventSource would otherwise keep running against a detached tree.
  //
  // 🚨 THIS ALONE IS NOT ENOUGH, and the gap took the host down twice.
  // Tearing down the PREVIOUS render leaves the LAST render of every file
  // mounted for the rest of the run. Once `App` grew a `setInterval` health
  // poll (b628caa), every such orphan kept polling, re-rendering and
  // allocating — six OOM kills across two boots, `anon-rss` 57–60 GB on a
  // 60 GB machine, taking the other services on it down too. See
  // `cleanupRenders`, wired as a global `afterEach` in vite.config.ts.
  if (previousContainer !== null) {
    act(() => {
      preactRender(null, previousContainer as HTMLElement);
    });
    previousContainer.remove();
    previousContainer = null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  previousContainer = container;
  act(() => {
    preactRender(vnode, container);
  });
  currentContainer = container;

  return {
    container,
    rerender(next: ComponentChild) {
      act(() => {
        preactRender(next, container);
      });
    },
    unmount() {
      act(() => {
        preactRender(null, container);
      });
      container.remove();
      if (currentContainer === container) currentContainer = null;
      if (previousContainer === container) previousContainer = null;
    },
  };
}

/** Dispatches a real, bubbling `click` (mousedown+mouseup+click, matching
 *  what a browser fires for a pointer click) at `el`, wrapped in `act` so
 *  any resulting state update/effect is flushed before this returns. */
export function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Dispatches a real, bubbling `keydown` at `window` (Task 8) -- matching
 *  where every real keyboard listener in this codebase attaches
 *  (App.tsx's global handler, and Overlays.tsx's own Escape handler).
 *  `key` is whatever `KeyboardEvent.key` would be ("Escape", "j", "?"),
 *  wrapped in `act` so any resulting state update is flushed before this
 *  returns. A thin convenience over the `window.dispatchEvent(new
 *  KeyboardEvent(...))` calls App.test.tsx already hand-writes -- exists
 *  here so Overlays.test.tsx (which has no App instance, no route, no
 *  keymap.ts dispatch to piggyback on) doesn't need to duplicate that
 *  boilerplate for its own, simpler "Escape closes this" assertions. */
export function press(key: string, opts: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean } = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        shiftKey: opts.shift === true,
        ctrlKey: opts.ctrl === true,
        metaKey: opts.meta === true,
        altKey: opts.alt === true,
      }),
    );
  });
}

/** Sets an `<input>`/`<textarea>`'s value and dispatches a real, bubbling
 *  `input` event, wrapped in `act` -- matching what a browser does as the
 *  user types. Task 9's Search debounces off this event, so a test that
 *  wants to observe debounce behavior calls this once per keystroke,
 *  exactly like a real typist, rather than setting `.value` directly
 *  (which fires no event at all). */
export function type(el: HTMLElement, value: string): void {
  act(() => {
    const input = el as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Waits `ms` of REAL wall time (parked behind a real `setTimeout`,
 *  `act`-wrapped so any effect/state update the wait uncovers is flushed
 *  before this resolves) -- a parametrised `tick()`. This deliberately
 *  does NOT fake timers: Search's debounce uses a real `setTimeout`, and a
 *  handful of synchronous `type()` calls followed by `await advance(250)`
 *  reliably outlasts a 200ms debounce without either side needing to agree
 *  on a virtual clock. */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

/** Finds the element carrying `data-testid={id}` inside the most recently
 *  rendered container (falling back to the whole document, in case a test
 *  ever wants to look outside it). Throws rather than returning `null` --
 *  a missing test id is a test failure, not a value to null-check --
 *  UNLESS the caller passes `{ optional: true }` (Task 8), for the one
 *  legitimate case: asserting something did NOT render (e.g. no
 *  `html-notice` when `hasHtml` is `null`, which must not be conflated
 *  with `false`). Every other call site keeps the throw-on-miss default. */
export function byTestId(id: string, opts: { optional: true }): HTMLElement | null;
export function byTestId(id: string, opts?: { optional?: false }): HTMLElement;
export function byTestId(id: string, opts?: { optional?: boolean }): HTMLElement | null {
  const root = currentContainer ?? document.body;
  const el = root.querySelector(`[data-testid="${id}"]`);
  if (!el) {
    if (opts?.optional === true) return null;
    throw new Error(`byTestId: no element with data-testid="${id}"`);
  }
  return el as HTMLElement;
}

/** Reads a pixel width off an element's inline style (the shell sizes its
 *  panes with `style.width`, never CSS classes, precisely so tests can read
 *  the number back without a layout engine -- happy-dom does not compute
 *  layout). Throws on anything that isn't a plain `"<n>px"` value. */
export function px(el: HTMLElement): number {
  const raw = el.style.width;
  const n = parseFloat(raw);
  if (raw === "" || Number.isNaN(n)) {
    throw new Error(`px: element has no numeric inline width (got "${raw}")`);
  }
  return n;
}

/** Flushes pending effects/renders, including ones triggered by a promise
 *  that resolves after this call starts (a `fakeApi` fetch, most notably).
 *  Implemented as an `act`-wrapped macrotask: Preact schedules both
 *  re-renders (via a microtask) and effects (via `requestAnimationFrame`,
 *  which `act` intercepts and drains synchronously once the callback
 *  settles), so parking behind a real `setTimeout` guarantees every
 *  microtask queued in between -- including chained ones from a `.then` --
 *  has already drained by the time this resolves. */
export async function tick(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** Simulates a divider drag: mousedown on `el` at x=0, mousemove on the
 *  document to `clientX = deltaX`, then mouseup. Cumulative, not
 *  incremental -- matches the brief's `drag(byTestId("divider-list"), -400)`
 *  shape, one call per gesture rather than a sequence of small moves. */
export function drag(el: HTMLElement, deltaX: number, deltaY = 0): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: deltaX, clientY: deltaY }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: deltaX, clientY: deltaY }));
  });
}

/** A call-recording function double. `spy().calls` is an array of the
 *  argument tuples each invocation received, in order -- a test asserts
 *  `spy.calls.length` for "did this fire" and `spy.calls[0]` for "with
 *  what." Generic over the callback's argument tuple so a typed prop
 *  (`onThemeChange?: (next: "light" | "dark") => void`) can be handed a
 *  `spy()` without a cast. */
export interface Spy<Args extends unknown[] = unknown[]> {
  (...args: Args): void;
  calls: Args[];
}

export function spy<Args extends unknown[] = unknown[]>(): Spy<Args> {
  const calls: Args[] = [];
  const fn = ((...args: Args) => {
    calls.push(args);
  }) as Spy<Args>;
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** The minimal history abstraction the shell drives navigation through.
 *  `App`'s default (no `history` prop) wraps the real
 *  `window.history`/`popstate`; `fakeHistory` below is the in-memory
 *  stand-in tests use instead, so a test never needs a real URL bar. */
export interface HistoryLike {
  path(): string;
  push(path: string): void;
  replace(path: string): void;
  back(): void;
  listen(cb: (path: string) => void): () => void;
}

export interface FakeHistory extends HistoryLike {
  /** True once `back()` was called with nothing earlier on the stack --
   *  i.e. it would have navigated the browser away from the app entirely.
   *  This is the assertion spec 7.3's "back closes the message before it
   *  leaves the app" test is actually checking: opening a message must
   *  `push` a new entry (not `replace`), so a single `back()` lands on the
   *  mailbox route with the app still open, never past it. */
  left(): boolean;
}

/** An in-memory stand-in for browser history: a linear stack plus an
 *  index, exactly like `window.history` (a `push` after navigating back
 *  truncates the forward entries). Deliberately does not try to model
 *  `pushState`'s DOM/state payload -- Wilco's router only ever needs the
 *  path. */
export function fakeHistory(initialPath: string): FakeHistory {
  let stack = [initialPath];
  let index = 0;
  let leftApp = false;
  const listeners = new Set<(path: string) => void>();

  function notify(): void {
    const path = stack[index]!;
    for (const listener of listeners) listener(path);
  }

  return {
    path(): string {
      return stack[index]!;
    },
    push(path: string): void {
      stack = stack.slice(0, index + 1);
      stack.push(path);
      index++;
      notify();
    },
    replace(path: string): void {
      stack[index] = path;
      notify();
    },
    back(): void {
      if (index > 0) {
        index--;
        notify();
      } else {
        leftApp = true;
      }
    },
    listen(cb: (path: string) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    left(): boolean {
      return leftApp;
    },
  };
}

// ---------------------------------------------------------------------------
// Api
// ---------------------------------------------------------------------------

export interface FakeApiCall {
  method: keyof Api;
  args: unknown[];
}

export interface FakeApi extends Api {
  /** Every call made through this instance, in order -- "records calls"
   *  from the ruling. A test asserts on this instead of re-implementing a
   *  spy. */
  calls: FakeApiCall[];
  /** The `q` argument of every `api.search()` call, in order -- the
   *  ergonomic form Task 9's debounce test uses (`api.searchCalls`)
   *  instead of filtering `calls` by method name itself. */
  searchCalls: string[];
}

function emptyList<T>(): ListResult<T> {
  return { rows: [], total: 0, cursor: null, truncated: false };
}

/** A message with a predictable, human-legible subject derived from its
 *  route: account "personal" + id "M1" -> "Personal M1". This is what
 *  lets a shell test assert on `reading-subject` without either side
 *  hard-coding a fixture id neither of them owns. */
function defaultMessage(account: string, id: string): Promise<MessageDetail> {
  const label = account.length === 0 ? account : account[0]!.toUpperCase() + account.slice(1);
  return Promise.resolve({
    account,
    id,
    threadId: null,
    receivedAt: "2026-01-01T00:00:00.000Z",
    subject: `${label} ${id}`,
    fromName: "Someone",
    fromEmail: "someone@example.test",
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    via: null,
    isUnread: false,
    isFlagged: false,
    bodyText: "",
    hasHtml: false,
    keywords: {},
    mailboxIds: [],
    attachments: [],
    inlineParts: [],
  });
}

function defaultMailboxes(): Promise<MailboxesResult> {
  return Promise.resolve({ accounts: [] });
}

function defaultAccounts(): Promise<AccountSpec[]> {
  return Promise.resolve([]);
}

/** A convenience shape for `fakeApi`'s `accounts` shortcut (Task 6):
 *  callers give just what a test cares about (usually `key` + `accent`)
 *  instead of the full `AccountSpec` every time. */
export interface FakeAccountSpec {
  key: string;
  label?: string;
  accent?: string;
  provider?: string;
  endpoint?: string;
  code?: string;
  /** Row 48: false takes the account out of All inboxes. */
  showInUnified?: boolean;
}

/** A convenience shape for `fakeApi`'s `mailboxes` shortcut (Task 6): a
 *  FLAT list of mailboxes, one row per mailbox with its owning account
 *  inline, mirroring the server's `GET /api/mailboxes` unread-by-junction
 *  fields rather than the nested `MailboxesResult` wire shape -- a test
 *  writing "personal inbox, 3 unread" shouldn't have to hand-build the
 *  grouping too. */
export interface FakeMailboxSpec {
  account?: string;
  id: string;
  name?: string;
  role?: string | null;
  parent?: string | null;
  unread?: number;
  /** Messages held in the mailbox. The sidebar shows this for every folder
   *  EXCEPT the inbox, which shows `unread` -- see Sidebar's `folderCount`. */
  total?: number;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function buildAccountsResponse(specs: FakeAccountSpec[]): AccountSpec[] {
  return specs.map((s) => ({
    key: s.key,
    label: s.label ?? capitalize(s.key),
    accent: s.accent ?? "#888888",
    provider: s.provider ?? "jmap",
    endpoint: s.endpoint ?? "https://example.test/jmap",
    code: s.code ?? s.key.slice(0, 3).toUpperCase(),
    showInUnified: s.showInUnified ?? true,
  }));
}

function buildMailboxesResponse(specs: FakeMailboxSpec[]): MailboxesResult {
  const byAccount = new Map<string, Mailbox[]>();
  for (const spec of specs) {
    const account = spec.account ?? "personal";
    const list = byAccount.get(account) ?? [];
    list.push({
      id: spec.id,
      name: spec.name ?? spec.role ?? spec.id,
      role: spec.role ?? null,
      parent: spec.parent ?? null,
      unread: spec.unread ?? 0,
      total: spec.total ?? 0,
    });
    byAccount.set(account, list);
  }
  return { accounts: Array.from(byAccount, ([account, mailboxes]) => ({ account, mailboxes })) };
}

/** A convenience shape for `fakeApi`'s `search` shortcut (Task 9): a
 *  canned `ListResult<EmailRow>` a test hands in directly, with every row
 *  needing only the fields it cares about -- the exact shape the M5
 *  exit-condition test (`N of M`) and the highlighting test use. */
export interface FakeSearchSpec {
  rows: Partial<EmailRow>[];
  total?: number;
  cursor?: string | null;
  truncated?: boolean;
}

function buildEmailRow(overrides: Partial<EmailRow> = {}): EmailRow {
  return {
    account: "personal",
    id: "M1",
    threadId: null,
    receivedAt: "2026-01-01T00:00:00.000Z",
    subject: "Subject",
    fromName: "Someone",
    fromEmail: "someone@example.test",
    preview: "",
    isUnread: false,
    isFlagged: false,
    hasAttachment: false,
    snippet: null,
    via: null,
    ...overrides,
  };
}

function buildSearchResponse(spec: FakeSearchSpec): ListResult<EmailRow> {
  const rows = spec.rows.map((r) => buildEmailRow(r));
  return {
    rows,
    total: spec.total ?? rows.length,
    cursor: spec.cursor ?? null,
    truncated: spec.truncated ?? false,
  };
}

function defaultOk(): Promise<OkResult> {
  return Promise.resolve({ ok: true });
}

/** Mirrors the real server's own default (accounts.ts's `addAccount`):
 *  `code` is the first three letters of `key`, uppercased -- never a
 *  second, drifting rule invented on the client side. */
function defaultAddAccount(input: AddAccountInput): Promise<AccountSpec> {
  return Promise.resolve({
    key: input.key,
    label: input.label,
    accent: input.accent,
    provider: input.provider,
    endpoint: input.endpoint,
    code: input.key.slice(0, 3).toUpperCase(),
  });
}

function defaultSavedSearches(): Promise<SavedSearchesResult> {
  return Promise.resolve({ savedSearches: [] });
}

/** A convenience shape for `fakeApi`'s `healthData` shortcut: a test names
 *  just the fields Sidebar's sync-state mapping cares about (`account`,
 *  `state`, `walkComplete`) instead of the full server `AccountHealth`
 *  every time. */
export interface FakeAccountHealth {
  account: string;
  label?: string;
  state?: string;
  message?: string;
  walkComplete?: boolean;
  hasEmailCursor?: boolean;
  lastSyncAt?: string | null;
  stale?: boolean;
  detailsBackfillFailures?: number;
}

function buildHealthReport(specs: FakeAccountHealth[]): HealthReport {
  const accounts: AccountHealth[] = specs.map((s) => ({
    account: s.account,
    label: s.label ?? capitalize(s.account),
    state: s.state ?? "ok",
    ...(s.message !== undefined ? { message: s.message } : {}),
    walkComplete: s.walkComplete ?? true,
    hasEmailCursor: s.hasEmailCursor ?? true,
    lastSyncAt: s.lastSyncAt ?? "2026-01-01T00:00:00.000Z",
    stale: s.stale ?? false,
    detailsBackfillFailures: s.detailsBackfillFailures ?? 0,
  }));
  return { ok: accounts.every((a) => a.state === "ok" && !a.stale), accounts };
}

/** Default `health()`: an empty report (`{ ok: true, accounts: [] }`,
 *  matching `health.ts`'s own "no accounts configured" shape closely
 *  enough for a test that doesn't care) -- every existing caller/test that
 *  doesn't pass `healthData` sees no per-account badges, exactly today's
 *  behavior. */
function defaultHealth(): Promise<HealthReport> {
  return Promise.resolve({ ok: true, accounts: [] });
}

/** `fakeApi`'s options: every real `Api` method may be overridden directly
 *  by name (a function), exactly as Task 5 established. `accountsData`/
 *  `mailboxesData` are the separate, data-only convenience keys described
 *  in this file's header comment -- deliberately NOT named `accounts`/
 *  `mailboxes` (that would make those keys mean two different things
 *  depending on what was passed, which is the exact foot-gun round 1 of
 *  Task 6's review flagged). Passing both `accounts` and `accountsData`
 *  (or the `mailboxes` pair) is almost certainly a mistake -- `fakeApi`
 *  applies the plain override first and the *Data key second, so the
 *  *Data key always wins; nothing here tries to detect or warn about the
 *  conflict, since no caller in this codebase does it. */
export type FakeApiOptions = Omit<Partial<Api>, "search"> & {
  accountsData?: FakeAccountSpec[];
  mailboxesData?: FakeMailboxSpec[];
  /** Same convention as `accountsData`/`mailboxesData`: canned per-account
   *  health rows instead of a full `HealthReport`. */
  healthData?: FakeAccountHealth[];
  /** `search` is the one deliberate exception to the accountsData/
   *  mailboxesData split above: it accepts EITHER a full override
   *  function (every other key's convention) OR a canned-data object
   *  (`FakeSearchSpec`). Task 9's own tests hand `fakeApi` a literal
   *  `{ rows, total, cursor, truncated }` for `search` directly, and a
   *  plain object can never collide with a function at runtime, so the
   *  two forms are told apart with `typeof` below instead of adding a
   *  `searchData` key just to keep the naming pattern pure. */
  search?: Api["search"] | FakeSearchSpec;
};

/** Builds a canned, call-recording stand-in for `Api` -- the seam `App`
 *  (and every later screen) is handed instead of a real `makeApi(fetch)`.
 *  `overrides` replaces individual methods; everything else falls back to
 *  a plausible empty/ok response so a test only has to specify the calls
 *  it actually cares about. */
export function fakeApi(overrides: FakeApiOptions = {}): FakeApi {
  const calls: FakeApiCall[] = [];
  const searchCalls: string[] = [];

  const defaults: Api = {
    accounts: defaultAccounts,
    mailboxes: defaultMailboxes,
    messages: () => Promise.resolve(emptyList()),
    search: () => Promise.resolve(emptyList()),
    setAccountOrder: () => Promise.resolve([]),
    accountSettings: () => Promise.resolve({ settings: {}, mailboxes: [] }),
    setAccountSetting: () => Promise.resolve({ settings: {}, mailboxes: [] }),
    message: defaultMessage,
    // A body URL that resolves to a harmless about:blank-ish origin: the
    // fake API must not hand a test a URL that would actually be fetched.
    bodyUrl: () =>
      Promise.resolve({
        url: "https://mailbody.invalid/m/test",
        expiresInMs: 600_000,
        remoteImages: false,
        imagesAlways: false,
        sender: "someone@example.test",
        blockedRemoteImages: 0,
        truncated: false,
        shownBytes: 0,
        totalBytes: 0,
        full: false,
        attachments: [],
      }),
    thread: () => Promise.resolve({ messages: [] }),
    draftFor: () => Promise.resolve({ account: 'personal', to: [], cc: [], subject: '', quoted: '',
      inReplyTo: null, references: null, ownAddressesKnown: true, sourceHasHtml: false, attachments: [],
      attribution: 'someone wrote:', quoteSource: { account: 'personal', id: 'M0', mode: 'reply' as const } }),
    signatureHtml: () => Promise.resolve({ html: "", text: "" }),
    draftHtml: () => Promise.resolve({ html: null, quoteSource: null, signaturePlacement: null }),
    identities: () => Promise.resolve({ identities: {} }),
    signatureUrl: () => Promise.resolve({ url: "about:blank", hasHtml: true }),
    allowSenderImages: () => Promise.resolve({ allowed: true }),
    saveSignature: () => Promise.resolve({ saved: true }),
    saveDraft: (input: { account: string; draftId?: string | null }) =>
      Promise.resolve({ draftId: input.draftId ?? "draft-1", account: input.account }),
    discardDraft: () => Promise.resolve({ discarded: true }),
    uploadAttachment: (account: string, file: File) =>
      Promise.resolve({ account, blobId: `blob-${file.name}`, name: file.name, type: file.type, size: file.size }),
    send: () => Promise.resolve({ sent: true as const, emailId: 'E1', submissionId: 'S1' }),
    contacts: () => Promise.resolve({ contacts: [] }),
    updateAccount: (key: string, patch: { label?: string; accent?: string; code?: string }) => Promise.resolve({ key, label: patch.label ?? 'x', accent: patch.accent ?? '#5b6ee0', provider: 'jmap', endpoint: '', code: patch.code ?? 'XXX' } as never),
    resyncAccount: () => Promise.resolve({ requested: true, note: 'runs on the next sync pass' }),
    setCredential: () => Promise.resolve({ ok: true }),
    removeAccount: () => Promise.resolve({ ok: true }),
    writtenTo: () => Promise.resolve({ written: true }),
    emptyTrash: () => Promise.resolve({ destroyed: 0, considered: 0 }),
    preferences: () => Promise.resolve({ preferences: { ...DEFAULT_PREFERENCES } }),
    setPreference: (key: string, value: string) => Promise.resolve({ preferences: { ...DEFAULT_PREFERENCES, [key]: value } as never }),
    unsubscribeInfo: () => Promise.resolve({ method: null }),
    unsubscribe: () => Promise.resolve({ method: 'post' as const, ok: true, status: 200 }),
    triage: () => Promise.resolve({ applied: 0, failed: [], undoId: null }),
    undoTriage: () => Promise.resolve({ restored: 0, failed: [] }),
    savedSearches: defaultSavedSearches,
    addSaved: (name, query) =>
      Promise.resolve({ id: "saved-1", name, query, position: 0, createdAt: "2026-01-01T00:00:00.000Z" }),
    renameSaved: defaultOk,
    removeSaved: defaultOk,
    reorderSaved: () => Promise.resolve({ savedSearches: [] }),
    addAccount: defaultAddAccount,
    logout: defaultOk,
    login: defaultOk,
    health: defaultHealth,
  };

  const { accountsData, mailboxesData, healthData, search: searchOverride, ...rest } = overrides;
  const merged: Api = { ...defaults, ...rest } as Api;

  if (accountsData !== undefined) {
    merged.accounts = () => Promise.resolve(buildAccountsResponse(accountsData));
  }
  if (mailboxesData !== undefined) {
    merged.mailboxes = () => Promise.resolve(buildMailboxesResponse(mailboxesData));
  }
  if (healthData !== undefined) {
    merged.health = () => Promise.resolve(buildHealthReport(healthData));
  }
  if (searchOverride !== undefined) {
    merged.search =
      typeof searchOverride === "function"
        ? searchOverride
        : () => Promise.resolve(buildSearchResponse(searchOverride));
  }

  const api = {} as unknown as Record<string, unknown>;

  for (const key of Object.keys(defaults) as (keyof Api)[]) {
    const fn = merged[key] as (...args: unknown[]) => unknown;
    api[key] = (...args: unknown[]) => {
      calls.push({ method: key, args });
      if (key === "search") searchCalls.push(args[0] as string);
      return fn(...args);
    };
  }
  (api as unknown as FakeApi).calls = calls;
  (api as unknown as FakeApi).searchCalls = searchCalls;

  return api as unknown as FakeApi;
}


/**
 * Tears down whatever is still mounted. Wired as a GLOBAL `afterEach` (see
 * `test.setupFiles` in vite.config.ts), so the last render of every file is
 * unmounted too — not just the previous one.
 *
 * 🚨 This is the fix for the leak that OOM-killed the host twice on
 * 2026-09-05. `render` only ever tore down the PREVIOUS render, so the final
 * one in each file stayed mounted for the whole run. Harmless while
 * components were inert; once `App` polled `/healthz` on an interval, each
 * orphan kept firing, re-rendering and allocating until the machine died.
 *
 * Unmounting runs the effect cleanups, which is what actually clears the
 * intervals — detaching the container would not.
 */
export function cleanupRenders(): void {
  for (const container of [previousContainer, currentContainer]) {
    if (container === null) continue;
    act(() => {
      preactRender(null, container);
    });
    container.remove();
  }
  previousContainer = null;
  currentContainer = null;
}
