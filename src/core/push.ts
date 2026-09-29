import type { ResolvedSession } from "./session.ts";
import type { Fetcher } from "./client.ts";
import type { Sleep } from "./corpus.ts";

/**
 * Push is a long poll, not a stream.
 *
 * Fastmail accepts the event-source connection, sends the opening `connect`
 * StateChange, and closes it about 1.2 seconds later -- reproducibly, and
 * independent of types, closeafter, ping, HTTP version, client or account.
 * Each reconnect therefore delivers the current Email state, which is what
 * drives a refresh.
 *
 * The trap: resetting the backoff whenever a connection OPENS turns this into
 * connect / 1.2s / close / wait 1s / repeat -- about 27 connections per minute
 * per account, indefinitely. Backoff is forgiven only by a connection that
 * LASTED (durableMs), never by one that merely opened.
 */
export const PUSH_DURABLE_MS = 5000;
export const PUSH_MAX_BACKOFF_MS = 60_000;
/** Fastmail sends a ping event this often (the `{ping}` URL parameter, in
 *  seconds) ... */
export const PUSH_PING_S = 30;
/** ... so a stream with no bytes for this long is a dead socket, not a
 *  quiet one, and is dropped so the loop reconnects. Measured 2026-09-06:
 *  a harness account's push reported "connected" and then delivered
 *  nothing and never closed, while every change waited for the 5-minute
 *  safety poll -- with `ping=0` a healthy-but-quiet stream and a dead one
 *  looked identical. */
export const PUSH_IDLE_MS = 90_000;
/** How long a connect may take before the stream is opened. The idle timer
 *  only exists once the stream is open; before that a reconnect parked in a
 *  dead pool (2026-09-08) had nothing to end it. */
export const PUSH_CONNECT_MS = 30_000;
const PUSH_BASE_BACKOFF_MS = 1000;

export interface PushOptions {
  fetcher?: Fetcher;
  sleep?: Sleep;
  now?: () => number;
  signal?: AbortSignal;
  durableMs?: number;
  maxBackoffMs?: number;
  /** Bytes-silence after which the stream is dropped (see PUSH_IDLE_MS). */
  idleMs?: number;
  /** Bound on opening the stream (see PUSH_CONNECT_MS). */
  connectTimeoutMs?: number;
  /** `changed` is the frame's per-type state map for that account
   *  (`{ Email: "J1", Mailbox: "M7" }`), so a consumer can tell a folder
   *  change from a mail change without a round trip (row 22). */
  onStateChange: (accountId: string, changed: Record<string, string>) => void | Promise<void>;
  /**
   * The event-source connection was REFUSED (a 401 on an expired token, a 5xx,
   * a proxy 404). Previously `if (res.ok && res.body)` dropped this on the
   * floor, so a push reader that could never connect was indistinguishable
   * from one that was connected and quiet -- which is exactly how push managed
   * to deliver nothing in production for a week without a single log line.
   * The status only; never the response, which echoes nothing but could grow
   * a body carrying who-knows-what.
   */
  onNotOk?: (status: number) => void;
  /**
   * One line per reconnect cycle, low volume by construction: Fastmail hangs
   * up after ~1.2s but the backoff climbs to a 60s ceiling, so this is about
   * one line a minute per account in the steady state. Injected rather than
   * console.log'd here because src/core must not decide how a server logs.
   */
  onLog?: (message: string) => void;
}

export function expandEventSourceUrl(s: ResolvedSession): string {
  return s.eventSourceUrl
    .replaceAll("{types}", "Email,Mailbox")
    .replaceAll("{closeafter}", "no")
    .replaceAll("{ping}", String(PUSH_PING_S));
}

export async function startPush(
  session: ResolvedSession,
  token: string,
  opts: PushOptions,
): Promise<void> {
  const fetcher: Fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
  const sleep: Sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const durableMs = opts.durableMs ?? PUSH_DURABLE_MS;
  const idleMs = opts.idleMs ?? PUSH_IDLE_MS;
  const connectMs = opts.connectTimeoutMs ?? PUSH_CONNECT_MS;
  const maxBackoff = opts.maxBackoffMs ?? PUSH_MAX_BACKOFF_MS;
  const url = expandEventSourceUrl(session);

  let backoff = PUSH_BASE_BACKOFF_MS;

  while (!opts.signal?.aborted) {
    const startedAt = now();
    // One controller per connection: the idle watchdog aborts THIS stream
    // (and only this one); shutdown reaches it through the outer signal.
    const conn = new AbortController();
    const onOuterAbort = (): void => conn.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idled = false;
    const armIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idled = true;
        conn.abort();
      }, idleMs);
    };
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimedOut = false;
    try {
      connectTimer = setTimeout(() => {
        connectTimedOut = true;
        conn.abort(new DOMException("push connect timed out", "TimeoutError"));
      }, connectMs);
      const res = await fetcher(url, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        signal: conn.signal,
      });
      clearTimeout(connectTimer);
      connectTimer = null;
      if (!res.ok) {
        opts.onNotOk?.(res.status);
        opts.onLog?.(`push connection refused with ${res.status}`);
      } else if (res.body) {
        opts.onLog?.("push connected");
        armIdle();
        const frames = await readStream(res.body, opts.onStateChange, armIdle);
        opts.onLog?.(`push closed after ${frames} frame(s)`);
      }
    } catch (err) {
      // A dropped connection is the normal case here, but a SILENT one hid
      // the six-stream drop that preceded the 2026-09-08 stall. Log the
      // error's NAME only: the error can carry the request, and the request
      // carries the token in a header.
      if (!opts.signal?.aborted && !idled) {
        const name = (err as { name?: string } | null)?.name ?? "Error";
        opts.onLog?.(`push dropped: ${connectTimedOut ? "TimeoutError" : name}`);
      }
    }

    if (connectTimer !== null) clearTimeout(connectTimer);
    if (idleTimer !== null) clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    if (idled) opts.onLog?.(`push idle for ${Math.round(idleMs / 1000)}s, reconnecting`);
    if (opts.signal?.aborted) break;

    const lasted = now() - startedAt;

    // Decide the next wait from what just happened, THEN wait it. A durable
    // connection must be followed by a SHORT wait -- sleeping the old backoff
    // first would make every recovery the slowest reconnect. Forgiven only by
    // a connection that lasted (durableMs), never by one that merely opened.
    backoff = lasted >= durableMs ? PUSH_BASE_BACKOFF_MS : Math.min(backoff * 2, maxBackoff);
    await sleep(backoff);
  }
}

/**
 * SSE ends a frame with a blank line, and a "line" in the wire format is
 * LF, CRLF *or* a bare CR (RFC 8895 / the WHATWG event-stream grammar). This
 * splitter accepted only "\n\n": against a CRLF stream it found zero frames,
 * forever, behind a connection that looked perfectly healthy -- the leading
 * cause of push delivering nothing in production. The alternation is three
 * literals, so matching stays linear over this remote input.
 *
 * A partial separator at the end of the buffer simply does not match and is
 * carried into the next read: "\r\n\r" is not a terminator, and once
 * "\r\n\r\n" or "\r\r" HAS matched no further byte can change what it is.
 *
 * Returns the number of frames seen so the caller can log "connected, saw N"
 * -- the one number that distinguishes a live reader from a dead one.
 */
const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

async function readStream(
  body: ReadableStream<Uint8Array>,
  onStateChange: PushOptions["onStateChange"],
  onBytes?: () => void,
): Promise<number> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let frames = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Any bytes -- a ping event counts -- prove the socket alive.
    onBytes?.();
    buf += decoder.decode(value, { stream: true });

    for (;;) {
      const m = FRAME_SEPARATOR.exec(buf);
      if (!m) break;
      const frame = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      frames += 1;
      await handleFrame(frame, onStateChange);
    }
  }
  return frames;
}

async function handleFrame(
  frame: string,
  onStateChange: PushOptions["onStateChange"],
): Promise<void> {
  // Linear parsing only: this text is remote input.
  const dataLines = frame
    .split(/\r\n|\n|\r/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return;

  let parsed: { changed?: Record<string, Record<string, string>> };
  try {
    parsed = JSON.parse(dataLines.join("\n")) as typeof parsed;
  } catch {
    return;
  }
  for (const [accountId, changed] of Object.entries(parsed.changed ?? {})) {
    const states: Record<string, string> = {};
    if (changed && typeof changed === "object") {
      for (const [type, state] of Object.entries(changed)) {
        if (typeof state === "string") states[type] = state;
      }
    }
    await onStateChange(accountId, states);
  }
}
