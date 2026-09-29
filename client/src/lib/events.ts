// The push side of the API seam: a persistent connection to
// GET /api/events (src/server/events.ts's EventHub) that tells the SPA
// "something changed in this account, go re-read" -- never message
// content. The stream deliberately carries no mail, so this file never has
// anything sensitive to lose track of.
//
// The server names the SSE event `change` (`event: change`), which the
// browser's EventSource only delivers via addEventListener("change", ...)
// -- the generic `.onmessage` fires solely for unnamed/`message` events and
// would never see this stream's frames.

/** The subset of `EventSource` this module actually uses -- small enough
 *  that a test can hand in a fake without implementing the whole DOM
 *  interface, and structurally compatible with a real `EventSource`. */
export interface EventSourceLike {
  close(): void;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  /** Optional so a test's fake (see events.test.ts) can omit it and keep
   *  today's "always transient" behavior -- a real `EventSource` always
   *  has one. Per the SSE spec, a non-2xx response (401 included: the
   *  server's own `/api/events` route returns exactly that when the
   *  session cookie is gone) makes the browser "fail the connection":
   *  `readyState` goes straight to `CLOSED` (2) rather than `CONNECTING`
   *  (0), which is the one portable signal this module has for "retrying
   *  will never work" -- `onerror`'s `Event` carries no HTTP status. */
  readyState?: number;
}

/** `EventSource.CLOSED` -- restated as a literal rather than read off a
 *  real `EventSource` constructor, so this module still works against a
 *  test's plain-object fake (no DOM `EventSource` global required). */
const READY_STATE_CLOSED = 2;

export interface SubscribeOptions {
  /** Defaults to `new EventSource("/api/events")`. Injectable so a test can
   *  simulate a connection that fails to open at all, without a real
   *  EventSource (a flake generator in a unit test -- see the brief). */
  open?: () => EventSourceLike;
  /** Defaults to `setTimeout`-backed real time. Injectable so the backoff
   *  test can run on a virtual clock instead of an actual 60 seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Called (in addition to the normal backoff continuing) whenever a
   *  connection fails in the way a 401/403/404 fails -- `readyState ===
   *  CLOSED` on error, per the spec comment on `EventSourceLike` above.
   *  Reconnecting is still attempted (a session can come back via a fresh
   *  login in another tab), but this is what lets a caller -- App.tsx,
   *  once this module is wired into the shell -- route to the same
   *  session-expired handling `lib/errors.ts`'s `isSessionExpired` drives
   *  for every other API call, instead of the stream failing forever in
   *  total silence. */
  onFatalError?: () => void;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

interface ChangeFrame {
  account?: unknown;
}

function defaultOpen(): EventSourceLike {
  return new EventSource("/api/events");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Subscribes to the change stream, reconnecting with exponential backoff
 * (capped at 30s, reset to the initial delay on a successful open) any
 * time the connection fails to open or drops. `onChange` is called with
 * the single changed account wrapped in an array -- the server only ever
 * reports one account per frame, but the Produces signature (and every
 * caller) treats "which accounts changed" as a list so a future batched
 * frame does not need a new shape.
 *
 * Returns an unsubscribe function that stops reconnecting and closes any
 * open connection.
 */
export function subscribe(onChange: (accounts: string[]) => void, opts: SubscribeOptions = {}): () => void {
  const open = opts.open ?? defaultOpen;
  const sleep = opts.sleep ?? defaultSleep;

  let stopped = false;
  let current: EventSourceLike | null = null;
  // Resolves the currently-pending runOnce() promise from outside it, so
  // stop() can unblock a connection that is open and healthy (never fires
  // onerror on a manual close) instead of leaving that promise dangling
  // forever.
  let settleCurrent: (() => void) | null = null;
  let backoff = INITIAL_BACKOFF_MS;
  // 🚨 Cancels the BACKOFF WAIT, not just the connection. `stop()` used to
  // set `stopped` and close the socket while the loop was parked inside
  // `sleep(backoff)` -- an uncancellable `setTimeout` of up to 30 seconds.
  // The subscription therefore outlived its own unsubscribe by up to half a
  // minute, holding its closure (and everything `onChange` captures) alive.
  //
  // Harmless in a browser, where a subscription is per-tab. Not harmless in
  // the test suite, where every mounted `App` starts one and (until the
  // global afterEach landed) the last render of every file was never
  // unmounted: each orphan sat in this loop reopening a connection that
  // cannot succeed, forever. Found by a timer audit that counted 2
  // `setTimeout` against 0 `clearTimeout` in this file.
  let wakeFromBackoff: (() => void) | null = null;

  async function runOnce(): Promise<void> {
    const es = open();
    current = es;
    try {
      await new Promise<void>((resolve, reject) => {
        settleCurrent = resolve;
        es.onopen = () => {
          // A live connection resets the backoff -- a long-lived stream
          // that eventually drops should not inherit whatever delay a much
          // earlier outage had climbed to.
          backoff = INITIAL_BACKOFF_MS;
        };
        es.addEventListener("change", (ev: MessageEvent) => {
          try {
            const frame = JSON.parse(ev.data as string) as ChangeFrame;
            if (typeof frame.account === "string") onChange([frame.account]);
          } catch {
            // A malformed frame is not a reason to tear down the stream.
          }
        });
        es.onerror = () => {
          if (es.readyState === READY_STATE_CLOSED) opts.onFatalError?.();
          reject(new Error("SSE connection error"));
        };
      });
    } finally {
      settleCurrent = null;
      es.close();
      if (current === es) current = null;
    }
  }

  (async () => {
    while (!stopped) {
      try {
        await runOnce();
      } catch {
        // open() itself can throw synchronously (no connection could be
        // established at all) -- treated the same as an onerror from a
        // connection that opened and later dropped.
      }
      if (stopped) return;
      // Races the backoff against stop(), so unsubscribing returns the loop
      // immediately instead of after up to MAX_BACKOFF_MS.
      await Promise.race([
        sleep(backoff),
        new Promise<void>((resolve) => {
          wakeFromBackoff = resolve;
        }),
      ]);
      wakeFromBackoff = null;
      if (stopped) return;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  })();

  return () => {
    stopped = true;
    settleCurrent?.();
    wakeFromBackoff?.();
    current?.close();
  };
}
