import { expandDownloadUrl, expandUploadUrl, type ResolvedSession } from "./session.ts";
import { classify, HttpStatusError } from "./failures.ts";

export const USING_MAIL = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
export const USING_SUBMISSION = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];

export type JmapCall = [string, Record<string, unknown>, string];
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * 🚨 Every outbound request is bounded, and the bound is Wilco's, not
 * Node's. On 2026-09-08 the sync loop sat for four and a half hours on JMAP
 * requests that Node's fetch had parked with no socket, no connection
 * attempt and no timer: the global agent had closed and discarded its pool
 * for api.fastmail.com while the six push streams reconnected through it,
 * and requests dispatched into that transition neither completed nor
 * failed. Node's own 300s header/body timeouts start only once a request is
 * on a socket, so they never ran. An AbortSignal fires at every stage,
 * parked included -- this is what a bound must be made of.
 */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Blobs can be 25MB each way; a body of that size deserves longer. */
export const BLOB_TIMEOUT_MS = 300_000;

export interface JmapClientOptions {
  requestTimeoutMs?: number;
  blobTimeoutMs?: number;
}

/**
 * A signal that fires at the bound OR when the caller's own signal does.
 * Built on a plain timer rather than AbortSignal.timeout(): that one is
 * unref'd, so it fires only while something ELSE keeps the process alive --
 * true of the server, not of a test, and not a property a bound should
 * rest on. `release()` clears the timer once the request has settled.
 */
export function bound(ms: number, outer?: AbortSignal | null): { signal: AbortSignal; release: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException(`the request exceeded ${ms}ms`, "TimeoutError")), ms);
  const onOuter = (): void => ac.abort(outer?.reason);
  if (outer?.aborted) onOuter();
  else outer?.addEventListener("abort", onOuter, { once: true });
  return {
    signal: ac.signal,
    release: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

export interface UploadedBlob {
  blobId: string;
  type: string;
  size: number;
}

export class JmapClient {
  readonly session: ResolvedSession;
  private token: string;
  private readonly fetcher: Fetcher;
  private readonly requestTimeoutMs: number;
  private readonly blobTimeoutMs: number;

  constructor(
    session: ResolvedSession,
    token: string,
    fetcher: Fetcher = (u, i) => fetch(u, i),
    opts: JmapClientOptions = {},
  ) {
    this.session = session;
    this.token = token;
    this.fetcher = fetcher;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.blobTimeoutMs = opts.blobTimeoutMs ?? BLOB_TIMEOUT_MS;
  }

  setToken(token: string): void {
    this.token = token;
  }

  async request(calls: JmapCall[], using: string[] = USING_MAIL, signal?: AbortSignal): Promise<any[][]> {
    const body = JSON.stringify({ using, methodCalls: calls });
    const json = (await this.send(this.session.apiUrl, body, signal)) as { methodResponses?: any[][] };
    const responses = json.methodResponses ?? [];

    for (const [name, args] of responses) {
      if (name === "error") {
        const type = (args as { type?: string }).type ?? "unknown";
        throw new Error(`JMAP method error: ${type}`);
      }
    }
    return responses;
  }

  /**
   * Downloads one blob (an inline image part, an attachment) as bytes.
   *
   * A GET rather than the JSON API, so it does not go through `send`: the
   * download URL is a template expanded per blob, and the response is
   * arbitrary bytes, not JSON. It carries the same bearer token, which is
   * exactly why nothing outside this module may ever be handed a raw
   * download URL -- spec 3.1 puts "never a raw upstream URL" on the wire
   * between the server and the SPA.
   */
  async downloadBlob(p: { accountId: string; blobId: string; name: string; type: string }): Promise<Buffer> {
    const url = expandDownloadUrl(this.session, p);
    const res = await this.fetcher(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      // Built from the status alone -- the URL and headers carry the token.
      throw new HttpStatusError(
        `blob download failed with ${res.status}`,
        res.status,
        res.headers.get("retry-after") ?? undefined,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Uploads bytes and returns the blob the server stored them as.
   *
   * 🚨 **Blob ids are account-scoped** (spec 11 [dovetail]). A blob uploaded
   * into one account cannot be attached to a message sent from another --
   * the send is refused. Changing the sending account therefore means
   * re-uploading every attachment, which is why the caller keeps the
   * account alongside each blob rather than the blob id alone.
   */
  async uploadBlob(accountId: string, bytes: Buffer, type: string): Promise<UploadedBlob> {
    const res = await this.fetcher(expandUploadUrl(this.session, accountId), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        // The server records this as the blob's type, and it is what the
        // recipient sees. It comes from the browser's own File.type and is
        // therefore attacker-influenced only by the OPERATOR, not a sender.
        "content-type": type || "application/octet-stream",
      },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      throw new HttpStatusError(`blob upload failed with ${res.status}`, res.status, res.headers.get("retry-after") ?? undefined);
    }
    const json = (await res.json()) as { blobId?: string; type?: string; size?: number };
    if (!json.blobId) throw new Error("upload response carried no blobId");
    return { blobId: json.blobId, type: json.type ?? type, size: json.size ?? bytes.length };
  }

  /**
   * Opens a blob for STREAMING rather than buffering it (spec 4.6: "Downloads
   * stream; a large attachment is not buffered through Node"). Returns the
   * upstream response so the caller can pipe its body straight to a client
   * socket -- a 25MB attachment must not become 25MB of resident Node heap
   * on a box that is also a Plex server.
   *
   * The caller gets the Response, never the URL: the download URL carries
   * the bearer token, and spec 3.1 puts "never a raw upstream URL" on the
   * wire out of this process.
   */
  async openBlob(p: { accountId: string; blobId: string; name: string; type: string }): Promise<Response> {
    const url = expandDownloadUrl(this.session, p);
    // The caller streams the body, so the bound covers reaching the headers
    // and is released once they are here; the stream is the caller's.
    const b = bound(this.blobTimeoutMs);
    try {
      const res = await this.fetcher(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
        signal: b.signal,
      });
      if (!res.ok) {
        throw new HttpStatusError(
          `blob download failed with ${res.status}`,
          res.status,
          res.headers.get("retry-after") ?? undefined,
        );
      }
      return res;
    } finally {
      b.release();
    }
  }

  /** One retry for a transport failure; none for an HTTP status. */
  /** POSTs one JMAP request and returns its PARSED body. The bound spans
   *  the whole exchange -- headers and body -- because a body that never
   *  ends is the same hang as a request that never answers. */
  private async send(url: string, body: string, signal?: AbortSignal): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // A fresh bound per attempt: the retry gets its own full allowance.
      const b = bound(this.requestTimeoutMs, signal);
      try {
        const res = await this.fetcher(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body,
          signal: b.signal,
        });
        if (!res.ok) {
          // Message is built from the status only -- never the request, which
          // carries the token in a header.
          throw new HttpStatusError(
            `JMAP request failed with ${res.status}`,
            res.status,
            res.headers.get("retry-after") ?? undefined,
          );
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
        if (!classify(err).retryable || err instanceof HttpStatusError) throw err;
      } finally {
        b.release();
      }
    }
    throw lastErr;
  }
}

/** Fetch and parse the session resource. Separate from the client because it
 *  runs before a client can exist. */
export async function fetchSession(
  sessionUrl: string,
  token: string,
  fetcher: Fetcher = (u, i) => fetch(u, i),
): Promise<unknown> {
  const b = bound(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetcher(sessionUrl, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: b.signal,
    });
    if (!res.ok) {
      throw new HttpStatusError(`session request failed with ${res.status}`, res.status);
    }
    return await res.json();
  } finally {
    b.release();
  }
}

/**
 * Does this URL speak JMAP, asked WITHOUT a credential?
 *
 * 🚨 This exists so a token is never the thing that finds out. The
 * add-account modal derives `https://<domain-of-the-address>/.well-known/
 * jmap`, and for a Fastmail-hosted custom domain that address is served by
 * the owner's ORDINARY WEB HOST. Probing it with the credential attached --
 * which is what verifyEndpoint used to do -- put a long-lived API token into
 * a third party's access log on the normal, successful path.
 *
 * "jmap" means one of two things, and nothing else:
 *   * the resource refused an anonymous request with 401/403 and did NOT
 *     offer a `Basic` challenge. JMAP authenticates with Bearer; a Basic
 *     challenge is an ordinary password-protected web page, which would
 *     otherwise qualify and collect the token.
 *   * it answered 200 with something shaped like a session document
 *     (`apiUrl` or `capabilities`). A session resource normally requires
 *     auth -- Fastmail answers `401 No Authorization header` -- but a
 *     self-hosted server may not, and a body carrying those keys is
 *     evidence no web host produces by accident.
 *
 * Anything else -- 404, an HTML 200, a redirect to a marketing page, a 5xx
 * -- is "not-jmap". A transport failure THROWS, so a caller can tell
 * "unreachable" from "reachable and not JMAP".
 */
export async function probeSession(
  sessionUrl: string,
  fetcher: Fetcher = (u, i) => fetch(u, i),
): Promise<"jmap" | "not-jmap"> {
  const b = bound(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetcher(sessionUrl, {
      headers: { accept: "application/json" },
      signal: b.signal,
    });
    if (res.status === 401 || res.status === 403) {
      const challenge = res.headers.get("www-authenticate") ?? "";
      return /^\s*basic\b/i.test(challenge) ? "not-jmap" : "jmap";
    }
    if (!res.ok) return "not-jmap";
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return "not-jmap"; // 200 text/html, which is what a parked domain serves
    }
    const doc = body as Record<string, unknown> | null;
    const looksLikeSession =
      doc !== null && typeof doc === "object" && ("apiUrl" in doc || "capabilities" in doc);
    return looksLikeSession ? "jmap" : "not-jmap";
  } finally {
    b.release();
  }
}

/** The real session resource. `jmap.fastmail.com` resolves, looks
 *  authoritative, and redirects every path to a marketing page. */
export const FASTMAIL_SESSION_URL = "https://api.fastmail.com/jmap/session";
