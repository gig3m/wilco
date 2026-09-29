/**
 * Unsubscribe (CHECKLIST row 31). Two headers decide what a message offers:
 *
 *   List-Unsubscribe       (RFC 2369)  -- a list of mailto: and/or https URLs
 *   List-Unsubscribe-Post  (RFC 8058)  -- "List-Unsubscribe=One-Click" means
 *                                         the https URL accepts a one-click POST
 *
 * Preference, in order: a one-click POST (silent, no page to visit, what
 * every major client does), then a mailto (an email the account sends).
 * An https URL WITHOUT the one-click header is a page meant for a person
 * and is not posted to. Plain http is never posted to: RFC 8058 requires
 * https, and a one-click over cleartext is a request anyone on the path
 * can replay.
 *
 * The POST is performed SERVER-SIDE (owner ruling 2026-09-06): the SPA's
 * CSP is `connect-src 'self'`, and loosening it for this would spend
 * defence-in-depth on a feature the server can do without it. The cost is
 * that the harness cannot observe the POST land -- the mailto path is what
 * it proves on Fastmail.
 */

export type UnsubscribePlan =
  | { kind: "post"; url: string }
  | { kind: "mailto"; to: string; subject: string; body: string };

const ONE_CLICK = /\blist-unsubscribe=one-click\b/i;

export function planUnsubscribe(urls: string[] | null | undefined, post: string | null | undefined): UnsubscribePlan | null {
  const list = Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string") : [];
  if (list.length === 0) return null;

  if (typeof post === "string" && ONE_CLICK.test(post)) {
    const https = list.find((u) => /^https:\/\//i.test(u.trim()));
    if (https !== undefined) return { kind: "post", url: https.trim() };
  }
  for (const u of list) {
    const m = parseMailto(u.trim());
    if (m !== null) return m;
  }
  return null;
}

/** RFC 6068, the parts that matter: `mailto:addr[,addr]?subject=..&body=..`.
 *  Only the first address is used -- an unsubscribe goes to one place. */
function parseMailto(value: string): UnsubscribePlan | null {
  if (!/^mailto:/i.test(value)) return null;
  const rest = value.slice("mailto:".length);
  const q = rest.indexOf("?");
  const addrPart = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q + 1);
  const to = decode(addrPart.split(",")[0] ?? "").trim();
  if (to === "" || !to.includes("@")) return null;
  let subject = "Unsubscribe";
  let body = "";
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = decode(eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    const val = decode(eq === -1 ? "" : pair.slice(eq + 1));
    if (key === "subject" && val !== "") subject = val;
    else if (key === "body") body = val;
  }
  return { kind: "mailto", to, subject, body };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Performs the one-click POST. Reports rather than throws: the caller
 *  turns the report into a toast, and a sender's broken endpoint is not an
 *  exception in this process. No credentials, no referrer, no redirects
 *  followed -- the POST is the whole protocol; a 3xx counts as accepted
 *  the way RFC 8058's "2xx or 3xx" reads. */
export async function oneClickPost(url: string, fetchFn: FetchLike, timeoutMs = 10_000): Promise<{ ok: boolean; status: number | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      body: "List-Unsubscribe=One-Click",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    return { ok: res.status >= 200 && res.status < 400, status: res.status };
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}
