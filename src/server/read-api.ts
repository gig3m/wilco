import { isViewableImage } from "./bodyhost.ts";
import type { DatabaseSync } from "node:sqlite";
import { BODY_TOKEN_TTL_MS, mintBodyToken } from "../core/captoken.ts";
import { allowSenderImages, senderImagesAllowed } from "../core/mutations.ts";
import type { JmapClient } from "../core/client.ts";
import { BlobCache, loadMessageBody } from "../core/htmlbody.ts";
import { sanitizeHtml } from "../core/sanitize.ts";
import { getAccount, listAccounts } from "../core/accounts.ts";
import {
  searchEmails,
  listMailboxes,
  getMessage,
  getThread,
} from "../core/queries.ts";
// The paged list lives in core/list.ts: it is four small indexed queries
// (walk, conversation counts, folder-scoped flags, header total) rather than
// the single collapsing statement that used to sit at the bottom of this
// file and grouped the whole table on every read.
import { listConversations } from "../core/list.ts";
import {
  addSaved,
  listSaved,
  removeSaved,
  renameSaved,
  reorderSaved,
  SavedSearchError,
} from "../core/saved.ts";
import type { Ctx, Router } from "./router.ts";
import { json } from "./router.ts";
import { authenticate, checkCsrf, hasScope, type Principal } from "./auth.ts";
import { readJson } from "./body.ts";

export interface ReadApiDeps {
  db: DatabaseSync;
  origin: string;
  /** Minting key and base URL for body capability tokens (spec 3.3).
   *  Optional so the many existing router tests that build a read API
   *  without a body origin keep working; absent means the mint route is
   *  not mounted and the SPA falls back to plaintext. */
  bodyTokenKey?: Buffer;
  bodyBaseUrl?: string;
  /** Live JMAP clients and the blob cache, so the mint route can report
   *  what the frame will actually show. Read per request, not captured. */
  clients?: Map<string, JmapClient>;
  blobs?: BlobCache;
}

export type { MailboxSummary } from "../core/queries.ts";

/**
 * Mounts the read-only mailbox/message/search surface: `GET /api/mailboxes`,
 * `GET /api/messages`, `GET /api/messages/:account/:id`,
 * `GET /api/threads/:account/:threadId`, saved-searches CRUD, and search
 * (`POST /api/search` only -- spec 8.3 requires the query travel in the
 * body, never the URL, because NPM logs the request line. There is no `GET
 * /api/search`; a formerly-kept "deprecated alias" leaked real queries into
 * NPM's access log and was removed).
 *
 * Every route accepts EITHER a session cookie or a bearer token (Task 8's
 * `authenticate()`/`Principal`) -- an agent is meant to be an equal
 * consumer of this whole surface, not a second-class one bolted on beside
 * it. What differs per route is scope and CSRF, not whether a token is
 * accepted at all:
 *
 *  - Every GET here, plus `POST /api/search` (a read shaped like a write --
 *    see below), only needs "read" scope, which every Principal satisfies
 *    (a session always does; so does a "read" or "write" token -- write
 *    implies read). `hasScope` is not even called for these: reaching this
 *    handler at all already proves a valid, unexpired Principal exists.
 *  - The saved-searches mutators (POST/PATCH/DELETE) require "write" scope,
 *    checked explicitly with `hasScope(principal, "write")` -- a read-only
 *    token must not be able to create, rename, reorder or delete a saved
 *    search.
 *  - CSRF applies ONLY to a session Principal. A bearer token carries no
 *    ambient authority the way a cookie does (nothing auto-attaches it to a
 *    cross-origin request a browser makes on the caller's behalf), so there
 *    is nothing for CSRF to defend against on a token-authenticated call --
 *    requiring the header there would just break every agent for no
 *    security benefit. A session, by contrast, still needs it: that's the
 *    entire reason CSRF exists.
 */
export function registerReadRoutes(router: Router, deps: ReadApiDeps): void {
  // Resolves the caller once and reports 401 if neither a token nor a
  // session authenticates. Returns null (already having written the 401)
  // so every call site can `if (!p) return;`.
  const requireRead = (c: Ctx): Principal | null => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) {
      json(c.res, 401, { error: "unauthorized" });
      return null;
    }
    return principal;
  };

  // For the saved-searches mutators: requires "write" scope on top of a
  // valid Principal, and requires CSRF when (and only when) that Principal
  // is a session.
  const requireWrite = (c: Ctx): Principal | null => {
    const principal = requireRead(c);
    if (!principal) return null;
    if (!hasScope(principal, "write")) {
      json(c.res, 403, { error: "forbidden" });
      return null;
    }
    if (principal.kind === "session" && !checkCsrf(c.req, deps.origin)) {
      json(c.res, 403, { error: "forbidden" });
      return null;
    }
    return principal;
  };

  // For POST /api/search: a read (scope "read" suffices), shaped like a
  // write because it takes a POST body -- CSRF still applies to a session,
  // same reasoning as requireWrite, just without the scope check.
  const requireReadCsrf = (c: Ctx): Principal | null => {
    const principal = requireRead(c);
    if (!principal) return null;
    if (principal.kind === "session" && !checkCsrf(c.req, deps.origin)) {
      json(c.res, 403, { error: "forbidden" });
      return null;
    }
    return principal;
  };

  router.add("GET", "/api/mailboxes", (c) => {
    if (!requireRead(c)) return;

    const accounts = listAccounts(deps.db).map((a) => ({
      account: a.key,
      mailboxes: listMailboxes(deps.db, a.key),
    }));
    json(c.res, 200, { accounts });
  });

  router.add("GET", "/api/messages", (c) => {
    if (!requireRead(c)) return;

    const account = c.url.searchParams.get("account");
    const mailbox = c.url.searchParams.get("mailbox");
    // `role` is the UNIFIED counterpart to `mailbox` (Task 11). A mailbox
    // id is scoped per account, so "the inbox of every account at once" --
    // which is the SPA's default screen and the whole premise of one
    // indexed inbox -- cannot be expressed as an id at all. A role can:
    // it is the same well-known string ("inbox", "archive", ...) in every
    // account, so filtering on it is unambiguous with or without an
    // account filter, and the id ambiguity the check below guards against
    // simply does not arise.
    //
    // Found by the Task 11 screenshot pass, not by any test: the client
    // was sending its route's mailbox ROLE in the `mailbox` param, so the
    // live SPA's inbox answered 400 and rendered "Inbox zero" against
    // 37,625 stored messages. Every client test passed throughout --
    // they all run against a fake Api.
    const role = c.url.searchParams.get("role");

    if (account !== null && !getAccount(deps.db, account)) {
      return void json(c.res, 400, { error: `no such account: ${JSON.stringify(account)}` });
    }
    // Spec 4.2: mailbox ids are scoped per account and genuinely collide
    // ("P-F" is a real inbox id in several accounts), so a mailbox filter
    // with no account is ambiguous and a mailbox filter naming another
    // account's mailbox must be rejected, not silently answered against
    // the wrong account.
    if (mailbox !== null && account === null) {
      return void json(c.res, 400, { error: "mailbox filter requires account" });
    }
    // Two spellings of the same filter would have to be intersected, and
    // an id that isn't the named role is a caller bug, not a query.
    if (mailbox !== null && role !== null) {
      return void json(c.res, 400, { error: "mailbox and role are mutually exclusive" });
    }
    if (mailbox !== null && account !== null && !mailboxExists(deps.db, account, mailbox)) {
      return void json(c.res, 400, { error: `no such mailbox ${JSON.stringify(mailbox)} in account ${JSON.stringify(account)}` });
    }

    const unread = parseBoolParam(c.url.searchParams.get("unread"));
    if (unread === "invalid") return void json(c.res, 400, { error: "unread must be true or false" });
    const flagged = parseBoolParam(c.url.searchParams.get("flagged"));
    if (flagged === "invalid") return void json(c.res, 400, { error: "flagged must be true or false" });
    const group = parseBoolParam(c.url.searchParams.get("group"));
    if (group === "invalid") return void json(c.res, 400, { error: "group must be true or false" });

    const limitParam = c.url.searchParams.get("limit");
    const limit = limitParam !== null && limitParam !== "" ? Number(limitParam) : undefined;

    const result = listConversations(deps.db, {
      account,
      mailbox,
      role,
      unread,
      flagged,
      group: group === undefined || group === null ? true : group,
      cursor: c.url.searchParams.get("cursor"),
      limit,
    });
    json(c.res, 200, result);
  });

  // The real search endpoint (spec 8.3). NPM logs the request line, and a
  // search for a person's name in a mail client is exactly the string that
  // must not sit in a proxy access log -- so the query travels in the body,
  // never the URL.
  router.add("POST", "/api/search", async (c) => {
    if (!requireReadCsrf(c)) return;

    const body = await readJson(c.req);
    const q = typeof body?.["q"] === "string" ? (body["q"] as string) : "";
    const limit = typeof body?.["limit"] === "number" ? (body["limit"] as number) : undefined;
    const cursor = typeof body?.["cursor"] === "string" ? (body["cursor"] as string) : null;

    json(c.res, 200, searchEmails(deps.db, q, { limit, cursor }));
  });

  // GET /api/messages/:account/:id -- the (account, id) compound key means a
  // message id that exists in another account is simply a DIFFERENT row,
  // never this one, so an unknown account and an unknown id both fall out
  // of the same getMessage() null check with no separate account lookup.
  /**
   * POST /api/senders/:account/allow-images — v1.1 #2's "Always from this
   * sender". Grants a standing remote-image allowance for one address.
   *
   * A real store rather than session state: the control says "always", and
   * a button that forgets by the next time you open that sender's mail is
   * worse than not offering one.
   */
  router.add("POST", "/api/senders/:account/allow-images", async (c) => {
    const principal = requireRead(c);
    if (!principal) return;
    if (!hasScope(principal, "write")) return void json(c.res, 403, { error: "write scope required" });
    if (principal.kind === "session" && !checkCsrf(c.req, deps.origin)) {
      return void json(c.res, 403, { error: "forbidden" });
    }

    const account = c.params["account"] ?? "";
    if (!getAccount(deps.db, account)) {
      return void json(c.res, 400, { error: `no such account: ${JSON.stringify(account)}` });
    }
    const b = (await readJson(c.req)) as Record<string, unknown>;
    const sender = typeof b["sender"] === "string" ? b["sender"].trim() : "";
    if (sender === "") return void json(c.res, 400, { error: "sender required" });

    allowSenderImages(deps.db, account, sender);
    json(c.res, 200, { allowed: true, sender: sender.toLowerCase() });
  });

  // Mints a capability URL for one message's HTML body (spec 3.3).
  //
  // A GET, because minting changes nothing -- it derives a MAC over data
  // the caller already supplied. The token lands in the response BODY, not
  // in a URL on this origin; it does end up in the body origin's own access
  // log when the frame loads it, which is why the TTL is ten minutes. A
  // token in a log that expired the same morning is not a credential by the
  // time that log rides a nightly tar (URLs
  // that land in logs get this scrutiny).
  if (deps.bodyTokenKey && deps.bodyBaseUrl) {
    const key = deps.bodyTokenKey;
    const base = deps.bodyBaseUrl;
    router.add("GET", "/api/messages/:account/:id/body-url", async (c) => {
      if (!requireRead(c)) return;

      const account = c.params["account"]!;
      const id = c.params["id"]!;
      // Only for a message we actually hold: minting for an arbitrary id
      // would turn this into an oracle for what exists upstream.
      if (getMessage(deps.db, account, id) === null) {
        return void json(c.res, 404, { error: "not found" });
      }

      // Spec 6.6: opt-in per message, and the SPA asks for it explicitly.
      // The flag rides in the token, so the opted-in and blocking variants
      // are different URLs rather than one URL with two behaviours.
      const message = getMessage(deps.db, account, id)!;
      // v1.1 #2: images load when this open asked for them, OR when the
      // sender carries a standing allowance ("Always from this sender").
      const asked = c.url.searchParams.get("images") === "1";
      const sender = message.fromEmail ?? "";
      const always = sender !== "" && senderImagesAllowed(deps.db, account, sender);
      const remoteImages = asked || always;
      const full = c.url.searchParams.get("full") === "1";
      const token = mintBodyToken(key, { account, id, remoteImages, full });

      // 🚨 The counts are reported HERE, not read off the frame's response.
      // A page cannot read the headers of a cross-origin frame it embeds,
      // so the blocked-image banner has no other way to learn there is
      // anything to announce -- and it must live in the chrome, outside the
      // frame, because a message's own stylesheet would restyle it into
      // invisibility (spec 6.8).
      let blockedRemoteImages: number | null = null;
      let truncated = false;
      let shownBytes = 0;
      let totalBytes = 0;
      let attachments: { blobId: string; name: string; type: string; size: number; url: string; viewUrl?: string }[] = [];

      const client = deps.clients?.get(account);
      if (client && deps.blobs) {
        try {
          const body = await loadMessageBody(client, account, id, deps.blobs, full);
          if (body !== null) {
            truncated = body.truncated;
            shownBytes = body.shownBytes;
            totalBytes = body.totalBytes;
            // Counted by running the SAME sanitizer the body origin will
            // run, over the memoised body -- not estimated from the HTML
            // here and hoped to match. Two different answers to "how many
            // were blocked" would be worse than none.
            blockedRemoteImages = sanitizeHtml(body.html, {
              resolveCid: () => null,
              allowRemoteImages: remoteImages,
            }).blockedRemoteImages;
            attachments = body.attachments.map((a) => ({
              blobId: a.blobId,
              name: a.name,
              type: a.type,
              size: a.size,
              url: `${base}/a/${encodeURIComponent(token)}/${encodeURIComponent(a.blobId)}`,
              // The in-app viewer's URL: the same bytes inline, for raster
              // images only (bodyhost VIEWABLE_TYPES). Absent means download.
              ...(isViewableImage(a) ? { viewUrl: `${base}/a/${encodeURIComponent(token)}/${encodeURIComponent(a.blobId)}?view=1` } : {}),
            }));
          }
        } catch {
          // A body we cannot fetch must not fail the mint: the frame will
          // report its own failure, and `null` says "we do not know how
          // many were blocked" rather than claiming zero.
        }
      }

      json(c.res, 200, {
        url: `${base}/m/${encodeURIComponent(token)}`,
        expiresInMs: BODY_TOKEN_TTL_MS,
        remoteImages,
        // Which of the two reasons images are on, so the loaded strip can
        // say "· this message" or "· always for {address}" (v1.1 #2).
        imagesAlways: always,
        sender,
        blockedRemoteImages,
        truncated,
        shownBytes,
        totalBytes,
        full,
        attachments,
      });
    });
  }

  router.add("GET", "/api/messages/:account/:id", (c) => {
    if (!requireRead(c)) return;

    const message = getMessage(deps.db, c.params["account"]!, c.params["id"]!);
    if (message === null) return void json(c.res, 404, { error: "not found" });
    json(c.res, 200, message);
  });

  // GET /api/threads/:account/:threadId -- oldest first (spec: reading a
  // conversation top to bottom is reading it in the order it happened),
  // scoped to the one account named in the path. An empty result is 404:
  // there is no meaningful difference between "no such thread" and "a
  // thread with zero messages" from the caller's side.
  router.add("GET", "/api/threads/:account/:threadId", (c) => {
    if (!requireRead(c)) return;

    const messages = getThread(deps.db, c.params["account"]!, c.params["threadId"]!);
    if (messages.length === 0) return void json(c.res, 404, { error: "not found" });
    json(c.res, 200, { messages });
  });

  // GET /api/saved-searches -- ordered by position, then name (see
  // listSaved). Read-only, so no CSRF check, same as every other GET here.
  router.add("GET", "/api/saved-searches", (c) => {
    if (!requireRead(c)) return;
    json(c.res, 200, { savedSearches: listSaved(deps.db) });
  });

  // POST /api/saved-searches -- creates one. addSaved() throws
  // SavedSearchError only for an empty (post-trim) query; an unrecognised
  // operator like `note:followup` is a legitimate literal search term
  // (spec 4.4 rule 2) and must NOT be rejected here.
  router.add("POST", "/api/saved-searches", async (c) => {
    if (!requireWrite(c)) return;

    const body = await readJson(c.req);
    const name = typeof body?.["name"] === "string" ? (body["name"] as string) : "";
    const query = typeof body?.["query"] === "string" ? (body["query"] as string) : "";

    try {
      json(c.res, 201, addSaved(deps.db, name, query));
    } catch (err) {
      if (err instanceof SavedSearchError) return void json(c.res, 400, { error: err.message });
      throw err;
    }
  });

  // PATCH /api/saved-searches -- bulk reorder. Takes the FULL, reordered id
  // list (see reorderSaved's doc comment for why a partial list is
  // refused rather than silently accepted). Kept on the collection route,
  // not `:id`, because a reorder is not an edit to one row.
  router.add("PATCH", "/api/saved-searches", async (c) => {
    if (!requireWrite(c)) return;

    const body = await readJson(c.req);
    const ids = Array.isArray(body?.["ids"]) ? (body["ids"] as unknown[]) : null;
    if (ids === null || !ids.every((id) => typeof id === "string")) {
      return void json(c.res, 400, { error: "ids must be an array of strings" });
    }

    try {
      reorderSaved(deps.db, ids as string[]);
    } catch (err) {
      if (err instanceof SavedSearchError) return void json(c.res, 400, { error: err.message });
      throw err;
    }
    json(c.res, 200, { savedSearches: listSaved(deps.db) });
  });

  // PATCH /api/saved-searches/:id -- rename. Unlike DELETE below, this is
  // NOT idempotent on an unknown id: renaming claims a specific new value
  // was persisted, and if there's no row, nothing was -- so renameSaved()
  // throws and this route answers 404, rather than the false-success 200
  // a delete-style "already gone" treatment would give here.
  router.add("PATCH", "/api/saved-searches/:id", async (c) => {
    if (!requireWrite(c)) return;

    const body = await readJson(c.req);
    const name = typeof body?.["name"] === "string" ? (body["name"] as string) : "";
    if (name.trim() === "") return void json(c.res, 400, { error: "name must not be empty" });

    try {
      renameSaved(deps.db, c.params["id"]!, name);
    } catch (err) {
      if (err instanceof SavedSearchError) return void json(c.res, 404, { error: err.message });
      throw err;
    }
    json(c.res, 200, { ok: true });
  });

  // DELETE /api/saved-searches/:id -- idempotent on purpose (see
  // removeSaved's doc comment): "this id is gone" is the same end state
  // whether or not a row existed, so this stays 200 even on an unknown
  // id -- deliberately unlike PATCH above.
  router.add("DELETE", "/api/saved-searches/:id", (c) => {
    if (!requireWrite(c)) return;

    removeSaved(deps.db, c.params["id"]!);
    json(c.res, 200, { ok: true });
  });

}

function parseBoolParam(raw: string | null): boolean | null | "invalid" {
  if (raw === null) return null;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return "invalid";
}

function mailboxExists(db: DatabaseSync, account: string, mailboxId: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM mailboxes WHERE account = ? AND id = ?`).get(account, mailboxId) !== undefined
  );
}
