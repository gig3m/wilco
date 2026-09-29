export type FailureKind = "auth" | "network" | "rate-limited" | "server" | "unknown";

export interface Failure {
  kind: FailureKind;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfter: string | undefined;

  constructor(message: string, status: number, retryAfter?: string) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

export function classify(err: unknown): Failure {
  if (err instanceof HttpStatusError) {
    if (err.status === 401 || err.status === 403) {
      return { kind: "auth", message: "authentication was refused", retryable: false };
    }
    if (err.status === 429) {
      return {
        kind: "rate-limited",
        message: "the server asked us to slow down",
        retryable: true,
        retryAfterMs: parseRetryAfter(err.retryAfter),
      };
    }
    if (err.status >= 500) {
      return { kind: "server", message: `server error ${err.status}`, retryable: true };
    }
    return { kind: "unknown", message: `unexpected status ${err.status}`, retryable: false };
  }

  const code = (err as { code?: string } | null)?.code;
  if (code && NETWORK_CODES.has(code)) {
    return { kind: "network", message: `connection failed (${code})`, retryable: true };
  }

  // The bound every outbound request now carries (client.ts, 2026-09-08).
  // A request Node's fetch parked with no socket and no timer -- the shape
  // of the four-and-a-half-hour stall -- ends only this way, and one more
  // try is right: the pool was at fault, not the server. A caller's OWN
  // abort (shutdown) is the opposite: retrying it is disobeying it.
  if (err instanceof DOMException || (err as { name?: string } | null)?.name === "TimeoutError") {
    const name = (err as { name?: string }).name;
    if (name === "TimeoutError") return { kind: "network", message: "the request timed out", retryable: true };
    if (name === "AbortError") return { kind: "network", message: "the request was aborted", retryable: false };
  }

  // Undici surfaces a dropped HTTP/2 connection as exactly this, with no status.
  if (err instanceof TypeError && err.message.includes("fetch failed")) {
    return { kind: "network", message: "the connection was dropped", retryable: true };
  }

  return { kind: "unknown", message: "an unrecognised error occurred", retryable: false };
}

function parseRetryAfter(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}
