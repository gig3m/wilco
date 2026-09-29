export class SessionError extends Error {}

const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const CORE = "urn:ietf:params:jmap:core";

export interface ResolvedSession {
  accountKey: string;
  mailAccountId: string;
  submissionAccountId: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  maxObjectsInGet: number;
  maxCallsInRequest: number;
}

export function resolveSession(accountKey: string, raw: unknown): ResolvedSession {
  const s = raw as Record<string, any>;
  if (!s || typeof s !== "object") throw new SessionError(`${accountKey}: session is not an object`);

  const primary = s["primaryAccounts"] as Record<string, string> | undefined;
  const mailAccountId = primary?.[MAIL];
  if (!mailAccountId) {
    // Never fall back to accounts[0]: each session exposes a masteruser
    // account with no mail capability, and the ordering differs per session.
    throw new SessionError(`${accountKey}: no primaryAccounts["${MAIL}"]`);
  }
  const submissionAccountId = primary?.[SUBMISSION] ?? mailAccountId;

  const accounts = (s["accounts"] ?? {}) as Record<string, any>;
  const caps = accounts[mailAccountId]?.["accountCapabilities"] ?? {};
  if (!(MAIL in caps)) {
    throw new SessionError(`${accountKey}: primary mail account lacks the mail capability`);
  }

  // 🚨 These four URLs decide WHERE THE TOKEN GOES, and the document they
  // come from is not trusted material: `establishClient` fetches it from the
  // endpoint stored on the account, and since accounts became user-addable
  // that endpoint is user-supplied (the modal derives it from the address
  // domain). Checking only "non-empty string", as this did, let a host
  // answering `apiUrl: "http://collector.example/jmap"` collect
  // `authorization: Bearer <token>` in cleartext on every request for the
  // life of the process, while the app reported a healthy account.
  //
  // https is the rule, and it is the ONLY rule available. Same-host and even
  // same-registrable-domain both LOOK right and both break real JMAP:
  // measured against the live Fastmail session on 2026-09-23, the endpoint
  // is `api.fastmail.com`, `apiUrl` is `phl.api.fastmail.com`, and
  // `downloadUrl` is `phl-www.fastmailusercontent.com` -- a different
  // domain entirely. `session.test.ts` pins that shape so a future
  // tightening cannot quietly take every account offline.
  for (const key of ["apiUrl", "downloadUrl", "uploadUrl", "eventSourceUrl"]) {
    const value = s[key];
    if (typeof value !== "string" || value === "") {
      throw new SessionError(`${accountKey}: session is missing ${key}`);
    }
    let parsed: URL;
    try {
      // The templates carry `{accountId}`-style placeholders, which parse
      // fine -- verified against the live document, not assumed.
      parsed = new URL(value);
    } catch {
      throw new SessionError(`${accountKey}: session ${key} is not an absolute URL`);
    }
    if (parsed.protocol !== "https:") {
      throw new SessionError(
        `${accountKey}: session ${key} is ${parsed.protocol}//, and only https is accepted -- ` +
          `this URL would carry the account's credential`,
      );
    }
  }

  const core = (s["capabilities"]?.[CORE] ?? {}) as Record<string, unknown>;
  const maxObjectsInGet = intOr(core["maxObjectsInGet"], 500);
  const maxCallsInRequest = intOr(core["maxCallsInRequest"], 16);

  return {
    accountKey,
    mailAccountId,
    submissionAccountId,
    apiUrl: s["apiUrl"],
    downloadUrl: s["downloadUrl"],
    uploadUrl: s["uploadUrl"],
    eventSourceUrl: s["eventSourceUrl"],
    maxObjectsInGet,
    maxCallsInRequest,
  };
}

function intOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
}

export function expandDownloadUrl(
  s: ResolvedSession,
  p: { accountId: string; blobId: string; name: string; type: string },
): string {
  return s.downloadUrl
    .replaceAll("{accountId}", encodeURIComponent(p.accountId))
    .replaceAll("{blobId}", encodeURIComponent(p.blobId))
    .replaceAll("{name}", encodeURIComponent(p.name))
    .replaceAll("{type}", encodeURIComponent(p.type));
}

export function expandUploadUrl(s: ResolvedSession, accountId: string): string {
  return s.uploadUrl.replaceAll("{accountId}", encodeURIComponent(accountId));
}
