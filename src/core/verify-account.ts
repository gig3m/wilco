import { fetchSession, probeSession, FASTMAIL_SESSION_URL, type Fetcher } from "./client.ts";
import { HttpStatusError } from "./failures.ts";

export type VerifyReason = "unreachable" | "http" | "auth";

/** Thrown by verifyEndpoint when neither the submitted endpoint nor (where
 *  applicable) the Fastmail fallback accepted the token. Never carries the
 *  token itself -- only the endpoint(s) tried and the status, so it is safe
 *  to log or return to the API caller verbatim. */
export class VerifyError extends Error {
  readonly reason: VerifyReason;

  constructor(message: string, reason: VerifyReason) {
    super(message);
    this.reason = reason;
  }
}

function reasonFor(err: unknown): VerifyReason {
  if (err instanceof HttpStatusError) {
    return err.status === 401 || err.status === 403 ? "auth" : "http";
  }
  return "unreachable";
}

function usernameOf(session: unknown): string | null {
  const username = (session as { username?: unknown } | null)?.username;
  return typeof username === "string" ? username : null;
}

/**
 * Proves an endpoint+token pair actually works before anything is stored.
 * The account-add modal derives `https://<domain>/.well-known/jmap`, which
 * 404s for a Fastmail-hosted domain, so a guess that fails falls back to
 * Fastmail's own session URL -- if THAT accepts the token, the account is a
 * Fastmail mailbox and the URL that works is what gets stored.
 *
 * 🚨 THE CREDENTIAL IS THE LAST THING SENT, NEVER THE FIRST. Every endpoint
 * is probed ANONYMOUSLY first (`probeSession`), and the token goes only to
 * one that has shown it speaks JMAP. This function used to send the token
 * to the submitted endpoint immediately and fall back on failure -- and for
 * the very case the fallback exists to serve, a Fastmail-hosted custom
 * domain, that endpoint is the owner's ORDINARY WEB HOST. The normal,
 * successful path therefore put a long-lived Fastmail API token into a
 * third party's access log, then reported "connected" without ever saying
 * so.
 *
 * 🚨 AND AN AUTH FAILURE NEVER FALLS BACK. A 401 from a JMAP endpoint means
 * "this IS a JMAP server and it refused you" -- a mistyped token against a
 * self-hosted server. Handing that same credential to Fastmail afterwards
 * discloses it a second time and cannot help: the endpoint was real. Only a
 * host that does not speak JMAP at all, or is unreachable, falls back.
 */
export async function verifyEndpoint(
  endpoint: string,
  token: string,
  fetcher?: Fetcher,
): Promise<{ endpoint: string; username: string | null }> {
  const isWellKnownGuess = endpoint.endsWith("/.well-known/jmap") && endpoint !== FASTMAIL_SESSION_URL;

  // Step 1, WITHOUT the credential: does this host speak JMAP at all?
  // A transport failure is not a verdict, so it is caught and treated the
  // same as "not JMAP" -- for a guess that means falling back, and for an
  // endpoint the owner typed it means reporting it unreachable below.
  let speaksJmap: "jmap" | "not-jmap";
  let probeErr: unknown = null;
  try {
    speaksJmap = await probeSession(endpoint, fetcher);
  } catch (err) {
    speaksJmap = "not-jmap";
    probeErr = err;
  }

  // Step 2: only now, and only to an endpoint that answered like JMAP.
  if (speaksJmap === "jmap") {
    try {
      const session = await fetchSession(endpoint, token, fetcher);
      return { endpoint, username: usernameOf(session) };
    } catch (err) {
      // No fallback from here, whatever the endpoint looked like: the host
      // is a JMAP server, so Fastmail cannot be the answer and would only
      // be a second place the credential has been.
      throw new VerifyError(`could not verify ${endpoint}: ${describe(err, endpoint)}`, reasonFor(err));
    }
  }

  // Step 3: it is not a JMAP endpoint, and it has been sent nothing.
  if (!isWellKnownGuess) {
    const detail = probeErr === null
      ? "it did not answer like a JMAP session endpoint"
      : describe(probeErr, endpoint);
    throw new VerifyError(
      `could not verify ${endpoint}: ${detail}`,
      probeErr === null ? "http" : reasonFor(probeErr),
    );
  }

  try {
    const session = await fetchSession(FASTMAIL_SESSION_URL, token, fetcher);
    return { endpoint: FASTMAIL_SESSION_URL, username: usernameOf(session) };
  } catch (secondErr) {
    const firstDetail = probeErr === null
      ? "it did not answer like a JMAP session endpoint"
      : describe(probeErr, endpoint);
    throw new VerifyError(
      `could not verify ${endpoint} (${firstDetail}) or ${FASTMAIL_SESSION_URL} (${describe(secondErr, FASTMAIL_SESSION_URL)})`,
      reasonFor(secondErr),
    );
  }
}

/**
 * Describes a verify failure for the 400 body a caller (and, from there, the
 * add-account modal) sees. An HttpStatusError is safe to quote in full -- it
 * carries nothing but a status code we set ourselves. Anything else came
 * from the network/fetch layer and can wrap arbitrary content: a JSON-parse
 * failure on a captive portal or WAF's HTML error page puts that page's text
 * in `err.message` verbatim, and echoing it back would put remote content in
 * our own response. So a non-HttpStatusError gets a FIXED message naming the
 * endpoint that was tried, plus at most the error's `code` (Node's own
 * classification, e.g. `ENOTFOUND`) or `name` -- never `err.message`.
 */
function describe(err: unknown, endpoint: string): string {
  if (err instanceof HttpStatusError) return `HTTP ${err.status}`;
  const detail = err instanceof Error ? ((err as Error & { code?: unknown }).code ?? err.name) : undefined;
  return typeof detail === "string" && detail.length > 0
    ? `unreachable: ${endpoint} (${detail})`
    : `unreachable: ${endpoint}`;
}
