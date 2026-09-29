import type { DatabaseSync } from "node:sqlite";
import { addAccount, getAccount, listAccounts, removeAccount, AccountError, setAccountOrder, updateAccount, validateAccountSpec, type AccountPatch } from "../core/accounts.ts";
import type { AccountSpec } from "../core/accounts.ts";
import type { CredentialStore } from "../core/credentials.ts";
import type { Ctx, Router } from "./router.ts";
import { json } from "./router.ts";
import { markReconcilePending } from "../core/reconcile.ts";
import { clearSyncState } from "../core/mutations.ts";
import { authenticate, checkCsrf } from "./auth.ts";
import { readJson } from "./body.ts";
import { getSetting, getSettings, isSettingKey, setSetting, SWITCH_SETTINGS } from "../core/settings.ts";
import { verifyEndpoint, VerifyError } from "../core/verify-account.ts";

export interface AccountsApiDeps {
  db: DatabaseSync;
  origin: string;
  /** Where a credential is read from and written to. Note EnvStore and
   *  KeysCliStore both reject put/remove -- a deployment on those backends
   *  cannot create or rotate a credential through this API, and that must
   *  surface as a real error, not a lie that it succeeded. */
  store: CredentialStore;
  /** Called after DELETE removes an account, so the running sync drops it
   *  too -- without this the supervisor kept fetching the account's mail
   *  until a restart (see the DELETE route's own note). */
  onRemoved?: (key: string) => void;
  /** Called after POST has stored BOTH the account row and its credential,
   *  so the running supervisor establishes and syncs the new account without
   *  a restart. Not called when no credential was supplied (there is nothing
   *  to authenticate with yet) nor when the credential write failed and the
   *  row was rolled back. */
  onAdded?: (spec: AccountSpec, credential: string) => void;
  /** Called after PUT /api/accounts/:key/credential stores a new credential,
   *  so the supervisor's in-memory token for that account is the one just
   *  set rather than the one it booted with. */
  onCredentialRotated?: (key: string, credential: string) => void;
  /** Probes an endpoint+token before POST stores either. Defaults to the
   *  real `verifyEndpoint` (a live HTTP call); tests inject a stub so the
   *  suite makes no network calls. */
  verify?: typeof verifyEndpoint;
}

/**
 * Mounts the routes the SPA's add-account flow calls: list, create, delete,
 * and set-credential. Every route requires a session; every mutating route
 * additionally requires the CSRF header and an exact Origin -- the same
 * pattern /api/login and /api/logout already use in main.ts. This endpoint
 * reads and writes secrets, so those checks are load-bearing, not
 * boilerplate.
 *
 * No response body from any route here ever includes a credential, sealed
 * or otherwise: create and list both hand back listAccounts()'s shape
 * (key/label/accent/provider/endpoint/code only), and the credential routes
 * answer with `{ ok: true }`, never an echo of what was stored.
 *
 * Task 8 deliberately keeps this whole file SESSION-ONLY, unlike
 * read-api.ts's retrofit onto bearer tokens. These routes mutate account
 * configuration and read/write the sealed credential a JMAP session is
 * authenticated with -- reachable capability here (add an account with an
 * attacker-supplied endpoint + credential, rotate an existing credential,
 * delete an account) is a strictly worse blast radius than anything a
 * "write" scope grants over mail (spec 7.1's own worst case, minting an
 * `EmailSubmission/set`-capable token, still can't rewrite what account a
 * credential belongs to). There is no scope in this design meant to cover
 * that, so rather than inventing one, these routes use `authenticate()` for
 * the same 401/403 shape as everywhere else but require `kind === "session"`
 * outright -- the same pattern tokens-api.ts uses to stop a token minting
 * another token.
 *
 * The 401-vs-403 split mirrors tokens-api.ts's `requireSession` exactly: no
 * Principal at all is 401 ("who are you"); a real, valid, unexpired token
 * Principal is 403 ("I know who you are, and no"). A token hitting this
 * file must get the same 403 it gets from /api/tokens for the identical
 * reason -- it authenticated fine and is simply not the kind of caller
 * these routes accept.
 */
export function registerAccountRoutes(router: Router, deps: AccountsApiDeps): void {
  const authed = (c: Ctx): boolean => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) {
      json(c.res, 401, { error: "unauthorized" });
      return false;
    }
    if (principal.kind !== "session") {
      json(c.res, 403, { error: "forbidden" });
      return false;
    }
    return true;
  };

  router.add("GET", "/api/accounts", (c) => {
    if (!authed(c)) return;
    // `showInUnified` rides along so the sidebar's "All inboxes" count can
    // skip a hidden account the way the unified list does (row 48).
    json(c.res, 200, listAccounts(deps.db).map((a) => ({ ...a, showInUnified: getSetting(deps.db, a.key, "showInUnified") !== "off" })));
  });

  /**
   * Per-account settings (spec 4.1's `settings` table, spec 7.6's screen).
   *
   * Session-only like the rest of this file: a bearer token must not be able
   * to read or change which folder trains spam. The 403 comes from `authed`.
   *
   * The response carries the account's MAILBOXES alongside its settings,
   * because every setting here so far is a choice OF a mailbox and a picker
   * with no options is not a picker. One round trip rather than two also
   * means the two cannot disagree about which mailboxes exist.
   */
  /** PUT /api/accounts/order -- the owner's sidebar order (row 34). Session
   *  only, like everything else here; the body is `{ order: [key, ...] }`
   *  naming every account exactly once. Answers with the accounts in their
   *  new order. */
  router.add("PUT", "/api/accounts/order", async (c) => {
    if (!authed(c)) return;
    if (!checkCsrf(c.req, deps.origin)) return void json(c.res, 403, { error: "forbidden" });
    const body = await readJson(c.req);
    const order = Array.isArray(body?.["order"]) ? (body["order"] as unknown[]).filter((k): k is string => typeof k === "string") : null;
    if (order === null) return void json(c.res, 400, { error: "order must be a list of account keys" });
    try {
      setAccountOrder(deps.db, order);
    } catch (err) {
      if (err instanceof AccountError) return void json(c.res, 400, { error: err.message });
      throw err;
    }
    json(c.res, 200, listAccounts(deps.db));
  });

  const accountSettingsBody = (key: string) => {
    const mailboxes = deps.db
      .prepare(`SELECT id, name, role FROM mailboxes WHERE account = ? ORDER BY sort_order, name, id`)
      .all(key) as unknown as { id: string; name: string; role: string | null }[];
    return { settings: getSettings(deps.db, key), mailboxes };
  };

  router.add("GET", "/api/accounts/:key/settings", (c) => {
    if (!authed(c)) return;
    const key = c.params["key"]!;
    if (getAccount(deps.db, key) === null) return void json(c.res, 404, { error: "not found" });
    json(c.res, 200, accountSettingsBody(key));
  });

  router.add("PUT", "/api/accounts/:key/settings", async (c) => {
    if (!authed(c)) return;
    if (!checkCsrf(c.req, deps.origin)) return void json(c.res, 403, { error: "forbidden" });

    const key = c.params["key"]!;
    if (getAccount(deps.db, key) === null) return void json(c.res, 404, { error: "not found" });

    const body = await readJson(c.req);
    const settingKey = typeof body?.["key"] === "string" ? (body["key"] as string) : "";
    const value = typeof body?.["value"] === "string" ? (body["value"] as string) : "";
    // An unknown key is REFUSED, not stored. A typo that silently persists is
    // a preference the operator sets and never sees applied.
    if (!isSettingKey(settingKey)) return void json(c.res, 400, { error: `unknown setting "${settingKey}"` });

    // 🚨 A chosen mailbox must exist in THIS account. Fastmail reuses mailbox
    // ids across accounts ("P-F" is every account's inbox), so an unscoped
    // check would happily accept a personal folder id for the work account
    // and then file work mail nowhere the operator expects.
    if (SWITCH_SETTINGS.has(settingKey) && value !== "on" && value !== "off") {
      return void json(c.res, 400, { error: `${settingKey} must be on or off` });
    }
    if (settingKey === "spamMailboxId" && value !== "") {
      const exists = deps.db.prepare(`SELECT 1 FROM mailboxes WHERE account = ? AND id = ?`).get(key, value);
      if (exists === undefined) return void json(c.res, 400, { error: "no such mailbox in this account" });
    }

    setSetting(deps.db, key, settingKey, value);
    // The SAME shape as GET. The account page holds one state for both
    // halves and renders the spam-folder select from `mailboxes`; a PUT that
    // answered `{ settings }` alone crashed that render (`undefined.map`)
    // and left every switch on the page visibly stuck while the value had
    // saved (found live, row 48, 2026-09-07).
    json(c.res, 200, accountSettingsBody(key));
  });

  router.add("POST", "/api/accounts", async (c) => {
    if (!authed(c)) return;
    if (!checkCsrf(c.req, deps.origin)) return void json(c.res, 403, { error: "forbidden" });

    const body = await readJson(c.req);
    const spec: AccountSpec = {
      // `body?.[...]`, not `body[...]`: a JSON body of literal `null` parses
      // to null, and an unguarded index on it is a TypeError that surfaces as
      // a generic 500 instead of the 400 this is (main.ts's /api/login does
      // the same).
      key: asString(body?.["key"]),
      label: asString(body?.["label"]),
      accent: asString(body?.["accent"]),
      provider: asString(body?.["provider"]) || "jmap",
      endpoint: asString(body?.["endpoint"]),
      code: asString(body?.["code"]) || undefined,
    };
    const credential = typeof body?.["credential"] === "string" ? (body["credential"] as string) : undefined;

    // Validate the spec's SHAPE (key pattern, endpoint parses, endpoint is
    // https:) before anything -- including before verify, below. Without
    // this a POST naming a plaintext endpoint (or a malformed key) still
    // sent the caller's token there over an unencrypted connection, and
    // only 400ed afterwards: verifyEndpoint ran first and addAccount's own
    // check never got a chance to stop it. validateAccountSpec is the same
    // check addAccount does internally; extracted so both paths share it.
    try {
      validateAccountSpec(spec);
    } catch (err) {
      if (err instanceof AccountError) return void json(c.res, 400, { error: err.message });
      throw err;
    }

    // Verify BEFORE addAccount, not after -- a failure here must leave
    // nothing to roll back. This is what stops the modal's derived
    // `.well-known/jmap` guess (which 404s for a Fastmail-hosted domain)
    // from being stored unchecked: verifyEndpoint tries it, and on failure
    // falls back to Fastmail's own session URL, resolving the endpoint that
    // actually accepted the token. Without a credential the old behaviour
    // stands -- no probe, no username, whatever endpoint was submitted is
    // stored as-is (an account can still be added credential-less and have
    // one attached later via PUT .../credential).
    let username: string | null = null;
    if (credential) {
      const verify = deps.verify ?? verifyEndpoint;
      try {
        const verified = await verify(spec.endpoint, credential);
        spec.endpoint = verified.endpoint;
        username = verified.username;
      } catch (err) {
        if (err instanceof VerifyError) {
          return void json(c.res, 400, { error: err.message, reason: err.reason });
        }
        throw err;
      }
    }

    let created: AccountSpec;
    try {
      created = addAccount(deps.db, spec);
    } catch (err) {
      if (err instanceof AccountError) {
        const status = /already exists/.test(err.message) ? 409 : 400;
        return void json(c.res, status, { error: err.message });
      }
      throw err;
    }

    // The supervisor is told about this account (below, once its credential
    // is stored too) rather than finding out at the next restart: main.ts's
    // onAccountAdded pushes the spec and credential into the same
    // accounts/tokens objects the running loop holds and wakes it.
    if (credential) {
      try {
        await deps.store.put(spec.key, credential);
      } catch (err) {
        // Undo the account row rather than leaving one behind with no way
        // to ever attach a credential through this API. Done regardless of
        // *why* the write failed -- an account this API claims to have
        // created but silently left credential-less is a worse state than
        // reporting the whole request failed.
        removeAccount(deps.db, spec.key);

        // Two different failure shapes here, and they must not be
        // conflated: a read-only backend (env/keys) rejecting put() is an
        // expected, deploy-time fact about which store is configured -- the
        // client did nothing wrong, so this is a 503 naming the backend's
        // `kind` (never its contents). A `put` failure on the db backend
        // itself is a genuine unexpected error (e.g. a real sqlite fault)
        // and must not be reported as "this backend can't write" -- that
        // would send an operator debugging a disk/db problem down the
        // wrong path. Rethrow it instead and let the router's catch-all
        // turn it into a generic 500 with no message text, the same
        // guarantee every other unexpected failure in this codebase gets.
        if (deps.store.kind !== "db") {
          return void json(c.res, 503, {
            error: `the configured credential store (${deps.store.kind}) does not accept writes`,
          });
        }
        throw err;
      }
      // AFTER both writes, never before: the supervisor is about to
      // establish a session with this credential, and a notification that
      // outran the rows would send it looking for either.
      deps.onAdded?.(created, credential);
    }

    json(c.res, 201, {
      key: created.key,
      label: created.label,
      accent: created.accent,
      provider: created.provider,
      endpoint: created.endpoint,
      code: created.code,
      ...(credential ? { username } : {}),
    });
  });

  /**
   * PUT /api/accounts/:key { label?, accent?, code? } -- the account page's
   * editable fields (row 37). Validation is updateAccount's.
   */
  router.add("PUT", "/api/accounts/:key", async (c) => {
    if (!authed(c)) return;
    if (!checkCsrf(c.req, deps.origin)) return void json(c.res, 403, { error: "forbidden" });
    const key = c.params["key"]!;
    if (getAccount(deps.db, key) === undefined) return void json(c.res, 404, { error: "not found" });
    const body = await readJson(c.req);
    const patch: AccountPatch = {};
    for (const f of ["label", "accent", "code"] as const) {
      if (body?.[f] !== undefined) {
        if (typeof body[f] !== "string") return void json(c.res, 400, { error: `${f} must be a string` });
        patch[f] = body[f] as string;
      }
    }
    try {
      const spec = updateAccount(deps.db, key, patch);
      json(c.res, 200, { key: spec.key, label: spec.label, accent: spec.accent, provider: spec.provider, endpoint: spec.endpoint, code: spec.code, position: spec.position });
    } catch (err) {
      if (err instanceof AccountError) return void json(c.res, 400, { error: err.message });
      throw err;
    }
  });

  /**
   * POST /api/accounts/:key/resync -- "Resync now" (row 37). Asks the next
   * sync pass for a full reconcile (every local row checked against the
   * server, the mailbox tree refetched). The pass runs on the next push
   * event or the 5-minute safety poll; the response says so rather than
   * pretending the resync has happened.
   */
  router.add("POST", "/api/accounts/:key/resync", (c) => {
    if (!authed(c)) return;
    if (!checkCsrf(c.req, deps.origin)) return void json(c.res, 403, { error: "forbidden" });
    const key = c.params["key"]!;
    if (getAccount(deps.db, key) === undefined) return void json(c.res, 404, { error: "not found" });
    markReconcilePending(deps.db, key);
    clearSyncState(deps.db, key, "mailbox_at");
    json(c.res, 200, { requested: true, note: "runs on the next sync pass (push, or the safety poll within 5 minutes)" });
  });

  router.add("DELETE", "/api/accounts/:key", (c) => {
    if (!authed(c)) return;
    if (!checkCsrf(c.req, deps.origin)) return void json(c.res, 403, { error: "forbidden" });

    const key = c.params["key"]!;
    // removeAccount cascades the credentials row via the FK (ON DELETE
    // CASCADE) regardless of which store is configured -- see accounts.ts.
    // Mail is untouched by design.
    //
    // onRemoved drops the account from the running sync (client, token,
    // state and the `accounts` array the supervisor re-establishes from), so
    // mail stops arriving for it immediately rather than at the next
    // restart.
    removeAccount(deps.db, key);
    deps.onRemoved?.(key);
    json(c.res, 200, { ok: true });
  });

  router.add("PUT", "/api/accounts/:key/credential", async (c) => {
    if (!authed(c)) return;
    if (!checkCsrf(c.req, deps.origin)) return void json(c.res, 403, { error: "forbidden" });

    const key = c.params["key"]!;
    if (!getAccount(deps.db, key)) return void json(c.res, 404, { error: "no such account" });

    const body = await readJson(c.req);
    const credential = typeof body?.["credential"] === "string" ? (body["credential"] as string) : "";
    if (!credential) return void json(c.res, 400, { error: "credential is required" });

    try {
      await deps.store.put(key, credential);
    } catch (err) {
      // Same distinction as POST above: a read-only backend is an expected
      // 503 naming its kind; a genuine db-backend failure rethrows into the
      // router's generic 500.
      if (deps.store.kind !== "db") {
        return void json(c.res, 503, {
          error: `the configured credential store (${deps.store.kind}) does not accept writes`,
        });
      }
      throw err;
    }
    deps.onCredentialRotated?.(key, credential);
    json(c.res, 200, { ok: true });
  });
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
