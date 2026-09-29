import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../core/config.ts";
import { getAccount, listAccounts, type AccountSpec } from "../core/accounts.ts";
import { chooseStore, TOKEN_RETRY_MS, type CredentialStore } from "../core/credentials.ts";
import { registerAccountRoutes } from "./accounts-api.ts";
import { registerReadRoutes } from "./read-api.ts";
import { registerTriageRoutes } from "./triage-api.ts";
import { registerTrashRoutes } from "./trash-api.ts";
import { htmlSignatureFor, registerSendRoutes } from "./send-api.ts";
import { registerPreferenceRoutes } from "./preferences-api.ts";
import { registerTokenRoutes } from "./tokens-api.ts";
import { readJson } from "./body.ts";
import { deriveMasterKey, MASTER_KEY_SALT_BYTES, SealError } from "../core/crypto.ts";
import { FutureSchemaVersion, openDb, rebuildDatabase, UnusableDatabase } from "../core/db.ts";
import { fetchSession, JmapClient } from "../core/client.ts";
import type { verifyEndpoint } from "../core/verify-account.ts";
import { resolveSession } from "../core/session.ts";
import { syncMailboxes, setSyncState } from "../core/mutations.ts";
import { walkArchive } from "../core/corpus.ts";
import { Router, json } from "./router.ts";
import { serveStatic } from "./static.ts";
import { accountHealth, failureState, type AccountState } from "./health.ts";
import { EventHub, HEARTBEAT_MS } from "./events.ts";
import { startSupervisor, type SupervisorHandle } from "./supervisor.ts";
import { clientAddress } from "./proxy.ts";
import { deriveBodyTokenKey } from "../core/captoken.ts";
import { BlobCache } from "../core/htmlbody.ts";
import { handleBodyHost } from "./bodyhost.ts";
import {
  SESSION_COOKIE,
  checkCsrf,
  clearSessionCookie,
  createSession,
  destroySession,
  readCookie,
  sessionCookie,
  validateSession,
  verifyPassword,
  RateLimiter,
  SESSION_TTL_MS,
} from "./auth.ts";

export interface Deps {
  db: DatabaseSync;
  passwordHash: string;
  origin: string;
  accountStates: Map<string, AccountState>;
  /** The supervisor's per-account progress clock, so /healthz can tell a
   *  first walk that is moving from one that has stalled. Optional so
   *  existing tests that build a router directly need not supply one. */
  progressAt?: Map<string, number>;
  /** Accounts to report on in /healthz. Optional so existing tests that
   *  build a router without any accounts configured still get a router;
   *  defaults to the empty list, not a read from the database. */
  accounts?: AccountSpec[];
  /** Optional so existing tests that build a router directly need not supply
   *  one; buildRouter makes its own rather than leaving /api/events unusable. */
  hub?: EventHub;
  /** Optional so existing tests that build a router without touching
   *  credentials still get a router. When present, mounts the /api/accounts
   *  routes (registerAccountRoutes); when absent, those routes are simply
   *  not mounted -- callers that need them must supply a store. */
  store?: CredentialStore;
  /** Live JMAP clients, keyed by account. Passed in (rather than built
   *  here) because main() populates the SAME Map after the router is
   *  constructed -- triage routes read it at request time, by which point
   *  it is full. Optional so existing router tests need not supply one;
   *  absent means an empty map, and triage answers "account not
   *  connected" rather than throwing. */
  clients?: Map<string, JmapClient>;
  /** Signing key and base URL for body capability tokens. Optional so
   *  existing router tests need neither; absent means /api/messages/:a/:id/
   *  body-url is not mounted and the SPA stays on plaintext. */
  bodyTokenKey?: Buffer;
  bodyBaseUrl?: string;
  /** Shared with the body origin so the mint route reports exactly what the
   *  frame will render (same memo, same sanitizer). */
  blobs?: BlobCache;
  /** The unsubscribe one-click POST's transport (row 31); tests inject one. */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Drops a deleted account from the running sync (row 37's Remove). */
  onAccountRemoved?: (key: string) => void;
  /** The mirror image: adds a just-created account to the running sync, so
   *  POST /api/accounts takes effect without a restart. */
  onAccountAdded?: (spec: AccountSpec, credential: string) => void;
  /** Puts a rotated credential into the running supervisor's token map, so
   *  the next re-auth (or the next established client) uses the new one. */
  onCredentialRotated?: (key: string, credential: string) => void;
  /** Probes an endpoint+token before POST /api/accounts stores either.
   *  Optional: registerAccountRoutes defaults to the real `verifyEndpoint`
   *  when this is absent; tests inject a stub instead. */
  verifyAccountEndpoint?: typeof verifyEndpoint;
}

export function buildRouter(deps: Deps): Router {
  const router = new Router();
  const loginLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });
  const hub = deps.hub ?? new EventHub();

  const authed = (req: IncomingMessage): boolean =>
    validateSession(deps.db, readCookie(req.headers["cookie"], SESSION_COOKIE) ?? "");

  router.add("GET", "/healthz", (c) => {
    const report = accountHealth(deps.db, deps.accounts ?? [], deps.accountStates, {
      progressAt: deps.progressAt,
    });
    json(c.res, report.ok ? 200 : 503, report);
  });

  router.add("GET", "/api/events", (c) => {
    if (!authed(c.req)) return json(c.res, 401, { error: "unauthorized" });
    hub.subscribe(c.res);
  });

  router.add("POST", "/api/login", async (c) => {
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });

    const key = clientAddress(c.req);
    if (!loginLimiter.allow(key)) return json(c.res, 429, { error: "too many attempts" });

    const body = await readJson(c.req);
    const password = typeof body?.["password"] === "string" ? (body["password"] as string) : "";
    if (!(await verifyPassword(password, deps.passwordHash))) {
      return json(c.res, 401, { error: "invalid credentials" });
    }

    const id = createSession(deps.db);
    c.res.setHeader("set-cookie", sessionCookie(id, Math.floor(SESSION_TTL_MS / 1000)));
    json(c.res, 200, { ok: true });
  });

  router.add("POST", "/api/logout", (c) => {
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    const id = readCookie(c.req.headers["cookie"], SESSION_COOKIE);
    if (id) destroySession(deps.db, id);
    c.res.setHeader("set-cookie", clearSessionCookie());
    json(c.res, 200, { ok: true });
  });

  // Mailboxes, the paged unified list, and search (POST /api/search --
  // the deprecated GET alias was deleted) all live in
  // read-api.ts.
  registerReadRoutes(router, {
    db: deps.db,
    origin: deps.origin,
    bodyTokenKey: deps.bodyTokenKey,
    bodyBaseUrl: deps.bodyBaseUrl,
    clients: deps.clients,
    blobs: deps.blobs,
  });

  // The first WRITE surface: POST /api/triage and /api/triage/undo.
  registerTriageRoutes(router, {
    db: deps.db,
    origin: deps.origin,
    clients: deps.clients ?? new Map(),
    onChange: (a) => deps.hub?.publish(a),
  });
  // Empty trash: the one destroying route, in its own module (see it).
  registerTrashRoutes(router, {
    db: deps.db,
    origin: deps.origin,
    clients: deps.clients ?? new Map(),
    onChange: (a) => deps.hub?.publish(a),
  });

  // The only outward-facing action in the app: GET /api/identities and
  // POST /api/send.
  // Owner-wide preferences (row 37). Mounted unconditionally: unlike the
  // account routes they need no credential store.
  registerPreferenceRoutes(router, { db: deps.db, origin: deps.origin });

  registerSendRoutes(router, {
    db: deps.db,
    origin: deps.origin,
    clients: deps.clients ?? new Map(),
    onChange: (a) => deps.hub?.publish(a),
    bodyTokenKey: deps.bodyTokenKey,
    bodyBaseUrl: deps.bodyBaseUrl,
    fetchFn: deps.fetchFn,
    blobs: deps.blobs,
  });

  // /api/tokens (list/mint) and /api/tokens/:id (revoke) -- session-only,
  // no CredentialStore needed, so mounted unconditionally (unlike
  // registerAccountRoutes below, which is gated on deps.store).
  registerTokenRoutes(router, { db: deps.db, origin: deps.origin });

  if (deps.store) {
    registerAccountRoutes(router, {
      db: deps.db,
      origin: deps.origin,
      store: deps.store,
      onRemoved: deps.onAccountRemoved,
      onAdded: deps.onAccountAdded,
      onCredentialRotated: deps.onCredentialRotated,
      verify: deps.verifyAccountEndpoint,
    });
  }

  return router;
}

/**
 * The two callbacks that keep a RUNNING supervisor's view of the accounts
 * current -- the add/rotate half of what `onAccountRemoved` does for a
 * delete. Exported (rather than written inline in main) so the wiring itself
 * is testable: main() is a whole boot, and the interesting behaviour here is
 * one branch deep.
 *
 * `accounts` and `tokens` are the very objects the supervisor holds; `wake`
 * is main's non-awaited call into SupervisorHandle.wake.
 */
export function liveAccountHooks(deps: {
  db: DatabaseSync;
  accounts: AccountSpec[];
  tokens: Map<string, string>;
  wake: () => void;
}): { onAccountAdded: (spec: AccountSpec, credential: string) => void; onCredentialRotated: (key: string, credential: string) => void } {
  /** Push the spec and wake, unless the supervisor already knows this key. */
  const adopt = (spec: AccountSpec): void => {
    if (deps.accounts.some((a) => a.key === spec.key)) return;
    deps.accounts.push(spec);
    deps.wake();
  };
  return {
    // Hot-add: the same two objects the supervisor holds, then a wake so the
    // account is established now rather than at the next safety poll (up to
    // 5 minutes) -- or, before this existed, the next restart.
    onAccountAdded: (spec, credential) => {
      deps.tokens.set(spec.key, credential);
      adopt(spec);
    },
    /**
     * A rotation for an account the supervisor already holds needs no wake:
     * it has a client, and the re-auth path re-reads this map on the next
     * 401, which is what a rotation is usually fixing.
     *
     * 🚨 But a rotation is ALSO how a credential-less account gets its first
     * one -- POST /api/accounts accepts one without a credential, and
     * onAccountAdded deliberately does not fire for it (there was nothing to
     * authenticate with). That account is in the database and in NO in-memory
     * array, so setting its token alone writes a dead entry: the supervisor
     * iterates `accounts`, not `tokens`, and would never look at it again
     * until a restart. Read the spec back and adopt it.
     */
    onCredentialRotated: (key, credential) => {
      deps.tokens.set(key, credential);
      const spec = getAccount(deps.db, key);
      if (spec) adopt(spec);
    },
  };
}

const MASTER_KEY_SALT_META_KEY = "master_key_salt";

/**
 * The master key must derive to the SAME bytes on every boot, or every
 * credential already sealed in `credentials` becomes permanently unreadable
 * the moment the salt changes. The salt itself carries no secrecy -- scrypt's
 * security comes from the secret, not the salt -- so storing it in `meta`
 * next to the sealed rows it protects is fine; what matters is that this
 * function reads an existing row before ever writing one, and never
 * overwrites a row that is already there.
 *
 * Fix round 1: the read-then-write was not concurrency-safe -- two processes
 * booting at once could both see no row, both generate a salt, and the
 * loser would hit the `meta` PK constraint and crash out of main() instead
 * of just using the winner's salt (which is exactly as good: any salt this
 * boot didn't originate the credentials under is only correct if it is the
 * one already on disk). `INSERT ... ON CONFLICT DO NOTHING` makes the loser
 * a no-op instead of a throw; the re-SELECT then reads whichever row won.
 */
export function ensureMasterKeySalt(db: DatabaseSync): Buffer {
  const existing = db.prepare("SELECT value FROM meta WHERE key = ?").get(MASTER_KEY_SALT_META_KEY) as
    | { value: string }
    | undefined;
  if (existing) return Buffer.from(existing.value, "base64");

  const salt = randomBytes(MASTER_KEY_SALT_BYTES);
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(
    MASTER_KEY_SALT_META_KEY,
    salt.toString("base64"),
  );

  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(MASTER_KEY_SALT_META_KEY) as {
    value: string;
  };
  return Buffer.from(row.value, "base64");
}

/** Derives the master key from the operator's secret and the database's own,
 *  persistent salt (see ensureMasterKeySalt). Never logs or returns the
 *  secret itself -- only the derived key, which is meaningless without it. */
export function resolveMasterKey(db: DatabaseSync, secret: string): Promise<Buffer> {
  return deriveMasterKey(secret, ensureMasterKeySalt(db));
}

export interface AcquireCredentialsOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Never handed the credential value or the underlying error -- only the
   *  account key, so a caller can record a failure without any risk of it
   *  naming or carrying the secret that could not be read. */
  onFailure?: (accountKey: string) => void;
}

/**
 * Resolves one credential per account from a single chosen CredentialStore
 * (spec 8.6 / Task 6). Unlike the old env-then-keys fallback chain
 * (formerly acquireTokens, deleted in this fix round -- see credentials.test.ts
 * for where its retry/backoff/hang coverage now lives), there is exactly one
 * backend -- WILCO_CREDENTIAL_STORE picked it -- so there is nothing to fall
 * back to. Retries with backoff are only worth doing for the `keys` backend,
 * whose failure mode is a flaky subprocess; a missing row in the db store or
 * a missing env var will not un-miss itself by waiting, so those backends
 * are tried once.
 *
 * A failure for one account -- a missing row, or a `keys` timeout that
 * exhausts its retries -- calls onFailure for THAT account and moves on to
 * the next; it must never abort acquisition for the others (spec 8.1's
 * rule, unchanged by the backend swap).
 *
 * Fix round 1: a SealError is deliberately NOT one of those per-account
 * failures and is left to propagate instead of being caught here. A wrong
 * master key against a non-empty `credentials` table can only mean an
 * operator error (a typo'd WILCO_MASTER_KEY, or the wrong secret file) --
 * catching it here would make that indistinguishable from "no credential
 * was ever stored," and an operator reading it that way could reasonably
 * `put` a fresh credential under the wrong key, permanently overwriting the
 * real one. Refusing to start the whole process is the safe response to an
 * unrecoverable-looking condition; degrading one account to "auth" is not.
 *
 * "Refusing to start" is only true because of what the caller does with the
 * throw: main() is invoked as `main().catch(exitOnStartupFailure)`, and that
 * handler calls process.exit(1). Rejecting alone is NOT enough -- the HTTP
 * server is already listening by this point, so an unhandled exitCode would
 * leave a live-but-useless process (see exitOnStartupFailure).
 */
export async function acquireCredentials(
  store: CredentialStore,
  accounts: { key: string }[],
  opts: AcquireCredentialsOptions = {},
): Promise<Map<string, string>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = store.kind === "keys" ? TOKEN_RETRY_MS.length + 1 : 1;
  const tokens = new Map<string, string>();

  for (const a of accounts) {
    let value: string | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        value = await store.get(a.key);
      } catch (err) {
        // A SealError means the key/ciphertext are mismatched -- not that
        // the credential is absent -- and must never be silently treated as
        // "missing" (see the doc comment above). Everything else (KeysCliStore's
        // scrubbed subprocess error) is the ordinary "could not get it this
        // attempt" case the retry loop exists for.
        if (err instanceof SealError) throw err;
        value = null;
      }
      if (value) break;
      if (attempt < attempts - 1) await sleep(TOKEN_RETRY_MS[attempt]!);
    }
    if (value) tokens.set(a.key, value);
    else opts.onFailure?.(a.key);
  }

  return tokens;
}

/**
 * The boot-time database open, split out of `main()` so a future-schema-
 * version refusal and a genuine-corruption rebuild can each be tested
 * without booting the whole server (main() also acquires credentials,
 * opens sockets, etc).
 *
 * `FutureSchemaVersion` is checked FIRST because it is a SUBCLASS of
 * `UnusableDatabase` -- checking the broad type first would wrongly rebuild
 * the version case. A future version means the data belongs to a NEWER
 * build (a rollback across a migration is exactly this), so it is an
 * operator error, not a broken cache: exit loudly and leave the file alone,
 * the same shape as a wrong master key (see `exitOnStartupFailure`).
 * Anything else that makes `openDb` unusable (the file itself won't open)
 * is the cache being genuinely gone, and keeps the existing rename-aside
 * and rebuild.
 */
export function openBootDatabase(dbPath: string): DatabaseSync {
  try {
    return openDb(dbPath);
  } catch (err) {
    if (err instanceof FutureSchemaVersion) {
      console.error(`wilco failed to start: ${err.message}`);
      process.exit(1);
    }
    if (!(err instanceof UnusableDatabase)) throw err;
    const moved = rebuildDatabase(dbPath);
    console.warn(`cache was unusable; moved to ${moved} and rebuilding`);
    return openDb(dbPath);
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const passwordHash = process.env["WILCO_PASSWORD_HASH"];
  if (!passwordHash) throw new Error("WILCO_PASSWORD_HASH is required");

  const db: DatabaseSync = openBootDatabase(config.dbPath);

  const accounts = listAccounts(db);
  const accountStates = new Map<string, AccountState>();
  // Written by the supervisor (and by the boot walk below, which the
  // supervisor's own pass coalesces onto), read by /healthz.
  const progressAt = new Map<string, number>();
  const hub = new EventHub();

  // The master key is derived once, here, from the operator's secret and the
  // database's own persistent salt (ensureMasterKeySalt) -- never a fresh
  // salt per boot, which would make every already-sealed credential
  // unreadable. config.credentialStore -- already parsed and validated by
  // loadConfig -- is the one source of truth for which backend answers
  // `get`; it is threaded straight into chooseStore's `env` rather than
  // handing chooseStore process.env and letting it re-read
  // WILCO_CREDENTIAL_STORE a second time. A missing or unreadable credential
  // degrades only that one account instead of stopping Node from starting
  // at all -- except a wrong master key, which acquireCredentials refuses to
  // treat as "missing" and instead throws, aborting startup outright (see
  // its doc comment).
  //
  // Computed before buildRouter (rather than after, as in earlier task
  // rounds) so the /api/accounts routes -- which need a live store to
  // create/rotate a credential -- can actually be mounted.
  const masterKey = await resolveMasterKey(db, config.masterKeySecret);
  const store = chooseStore({
    db,
    masterKey,
    env: { ...process.env, WILCO_CREDENTIAL_STORE: config.credentialStore },
  });

  // Created HERE, before buildRouter, and populated further down. The
  // triage routes hold this same Map by reference and read it per
  // request, so an account that connects after the router is built is
  // still triageable -- but a route that captured `clients` by VALUE at
  // construction time would see an empty map forever.
  const clients = new Map<string, JmapClient>();

  // Created empty HERE and FILLED further down, for the same reason as
  // `clients` above: the accounts API's hot-add hooks (liveAccountHooks) take
  // this very Map by reference at router-construction time. Acquiring the
  // credentials is deliberately left where it was -- it retries a slow or
  // unreachable store, and doing it here would hold up server.listen() and
  // with it /healthz.
  const tokens = new Map<string, string>();

  // Set by startSupervisor's `expose` below, read by onAccountAdded above
  // it: buildRouter runs BEFORE the supervisor exists, so what the route
  // captures has to be this binding, not its value. Null until the loop is
  // running -- an add before that point (there is no HTTP server serving
  // requests yet) needs no wake, because the supervisor establishes from
  // `accounts` when it starts.
  let supervisor: SupervisorHandle | null = null;

  // The body origin's signing key is derived from the master key with its
  // own HKDF label, so a token forgery could never become a credential
  // disclosure (see captoken.ts).
  const bodyTokenKey = deriveBodyTokenKey(masterKey);
  const blobs = new BlobCache(config.blobDir);

  const router = buildRouter({
    db,
    passwordHash,
    origin: config.baseUrl,
    accountStates,
    progressAt,
    accounts,
    hub,
    store,
    clients,
    bodyTokenKey,
    bodyBaseUrl: config.bodyBaseUrl,
    blobs,
    // Row 37's Remove: the supervisor re-establishes any account in
    // `accounts` that lacks a client, so a removal must leave that array
    // too, not just the client and token.
    onAccountRemoved: (key) => {
      clients.delete(key);
      tokens.delete(key);
      accountStates.delete(key);
      progressAt.delete(key);
      const i = accounts.findIndex((a) => a.key === key);
      if (i !== -1) accounts.splice(i, 1);
    },
    ...liveAccountHooks({
      db,
      accounts,
      tokens,
      wake: () => {
        // .catch, not a bare `void`: an escaping rejection here would be an
        // unhandled one, and this process exits on those (see the
        // supervisor's own .catch below). establishMissing already records a
        // per-account failure as state; anything past that is a bug, not a
        // lost account.
        void supervisor?.wake().catch((err: unknown) => {
          console.error("supervisor wake failed:", err instanceof Error ? err.message : err);
        });
      },
    }),
  });

  // The built SPA lives alongside src/ in the image (see the Dockerfile's
  // builder stage), at client/dist relative to this file's own directory.
  // serveStatic itself declines /api/* and /healthz without touching `res`
  // (see static.ts), so trying it first can never swallow an API response --
  // it only intercepts asset/deep-link GETs, which the router has no routes
  // for anyway. If client/dist doesn't exist (e.g. a dev checkout that never
  // ran the client build), every stat inside it fails and serve() just
  // returns false, falling through to the router exactly as before this
  // change.
  const serveClient = serveStatic(path.join(import.meta.dirname, "../../client/dist"));
  const bodyHostname = new URL(config.bodyBaseUrl).hostname;

  const dispatch = createHostDispatch({
    bodyHostname,
    onBody: (req, res, url) =>
      handleBodyHost(req, res, url, {
        bodyTokenKey,
        bodyBaseUrl: config.bodyBaseUrl,
        appBaseUrl: config.baseUrl,
        blobs,
        clients,
        signatureFor: (account, identityId) => htmlSignatureFor(clients, account, identityId),
      }),
    onApp: createAppHandler({
      bodyBaseUrl: config.bodyBaseUrl,
      serveClient,
      handle: (req, res) => router.handle(req, res),
    }),
  });

  const server = createServer((req, res) => void dispatch(req, res));
  server.listen(config.port, () => {
    console.log(`wilco listening on ${config.port}`);
  });

  // A comment frame every HEARTBEAT_MS is what stops an idle proxy from
  // deciding the SSE stream is dead (see events.ts). unref() so this timer
  // alone never keeps the process alive past a clean shutdown.
  setInterval(() => hub.heartbeat(), HEARTBEAT_MS).unref();

  for (const [key, token] of await acquireCredentials(store, accounts, {
    onFailure: (accountKey) => {
      accountStates.set(accountKey, {
        kind: "auth",
        message: `no credential available for ${accountKey}`,
      });
    },
  })) tokens.set(key, token);

  // Session + initial mailbox sync is awaited, concurrently across accounts,
  // before the supervisor starts: startSupervisor snapshots `clients` once
  // to set up its push readers, so every account that is going to sync must
  // already be in the map by then. The one-time historical corpus walk is
  // NOT awaited here -- see walkAccount -- it can run for a long time on
  // a large mailbox and must not delay the ongoing incremental sync loop.
  await Promise.all(
    accounts.map(async (account) => {
      const token = tokens.get(account.key);
      if (!token) return; // acquireCredentials already recorded the auth failure
      const client = await establishClient(db, account, token, accountStates);
      if (client) {
        clients.set(account.key, client);
        walkAccount(db, client, account.key, progressAt);
      }
    }),
  );

  const controller = new AbortController();
  const shutdown = (): void => {
    controller.abort();
    hub.close();
    server.close();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  startSupervisor({
    db,
    accounts,
    clients,
    tokens,
    // Final-review fix 1: omitting this used to be silent -- the supervisor
    // fell back to building its own KeysCliStore, which resurrected the
    // two-mechanism state ruling H3 collapsed. A credential rotated through
    // PUT /api/accounts/:key/credential was then reverted on the next 401,
    // because re-auth re-read the OLD value out of the `keys` CLI. The field
    // is now REQUIRED in SupervisorDeps (no fallback exists to omit it into),
    // so leaving it out is a typecheck failure, not a runtime regression.
    store,
    states: accountStates,
    progressAt,
    onChange: (a) => hub.publish(a),
    signal: controller.signal,
    // An account that failed to come up at boot gets another chance every
    // poll cycle instead of being abandoned for the life of the process
    // (I2). The walk is kicked off here too, for the same reason it is
    // above: it can run for hours and must not block the sync loop.
    establishFn: async (accountKey, token) => {
      const spec = accounts.find((a) => a.key === accountKey);
      if (!spec) return undefined; // account was removed since the supervisor last read `accounts`
      const client = await establishClient(db, spec, token, accountStates);
      if (client) walkAccount(db, client, accountKey, progressAt);
      return client;
    },
    expose: (h) => { supervisor = h; },
  }).catch((err) => {
    // Not `void`: an escaping throw became an unhandled rejection and took
    // the process down (M4). err.message only -- an error object in this
    // codebase can carry a `stdout` property that is a token.
    console.error("supervisor stopped:", err instanceof Error ? err.message : err);
  });
}

/** The fast, blocking half of bringing an account up: prove the token works
 *  and get its mailbox tree, so the supervisor has a usable client. Takes
 *  the account's own spec (not just its key) because it now honours the
 *  STORED endpoint -- verified at add-time by verifyEndpoint -- rather than
 *  always dialling Fastmail's fixed session URL. */
async function establishClient(
  db: DatabaseSync,
  spec: AccountSpec,
  token: string,
  states: Map<string, AccountState>,
): Promise<JmapClient | undefined> {
  const accountKey = spec.key;
  try {
    const raw = await fetchSession(spec.endpoint, token);
    const session = resolveSession(accountKey, raw);
    const client = new JmapClient(session, token);

    const [boxes] = await client.request([
      ["Mailbox/get", { accountId: session.mailAccountId, ids: null }, "c0"],
    ]);
    const list = ((boxes?.[1] as { list?: any[] }).list ?? []) as any[];
    const state = (boxes?.[1] as { state?: string }).state;
    syncMailboxes(db, accountKey, list);
    if (state) setSyncState(db, accountKey, "mailbox", state);

    states.set(accountKey, { kind: "ok" });
    return client;
  } catch (err) {
    const state = failureState(err);
    states.set(accountKey, state);
    console.error(`${accountKey}: ${state.kind} — ${"message" in state ? state.message : ""}`);
    return undefined;
  }
}

/**
 * The slow, one-time half: walk the full historical archive. Deliberately
 * not part of the supervisor's ongoing pass -- it is a full listing walk
 * driven by its own "done" sentinel (see corpus.ts), not the incremental
 * Email/changes sync refreshAccount already performs, so running it every
 * poll cycle would be pure overhead once an account is caught up.
 * Fire-and-forget so it never blocks establishClient's caller.
 *
 * Round 2 fix: no longer calls backfillBodies. Since round 1, refreshAccount
 * backfills bodies unconditionally on every supervisor pass, and the
 * supervisor's first pass runs immediately after this is kicked off -- a
 * second, concurrent backfillBodies call here raced the supervisor's own
 * call against the same unfetchedIds()/writeBodyText() rows for no benefit.
 * On a fresh database the supervisor's first pass now does the full body
 * backfill; this function's only remaining job is getting message metadata
 * into the table for it to find.
 *
 * Deliberately does NOT write to `states`. Once establishClient hands an
 * account to the supervisor, the supervisor is that map's single writer --
 * a late walk failure here racing the supervisor's own `{ kind: "ok" }`
 * with no ordering could leave /healthz reporting a problem live sync has
 * already superseded. If the failure is real (an expired token, say), the
 * supervisor's very next pass hits the same kind of JMAP call and records
 * it there instead, within a minute.
 */
function walkAccount(
  db: DatabaseSync,
  client: JmapClient,
  accountKey: string,
  progressAt: Map<string, number>,
): void {
  void (async () => {
    try {
      await walkArchive(db, client, accountKey, {
        onProgress: (n) => {
          // walkArchive coalesces per account AND drops the second caller's
          // options, so the supervisor's pass awaits THIS walk and its own
          // onProgress is never called for the whole of a first walk. These
          // are the only ticks that exist while the boot walk runs; without
          // them the pass's progress watchdog abandons it every cycle (the
          // 2026-09-22 incident) and /healthz calls it stale.
          //
          // Date.now() is the one clock: startSupervisor below is constructed
          // without a `now`, so it reads and writes this same map with
          // Date.now too. A caller that injects a clock must write this map
          // with that clock.
          progressAt.set(accountKey, Date.now());
          if (n % 1000 === 0) console.log(`${accountKey}: ${n} messages`);
        },
      });
      // Statistics, or the planner drives unread counts from folder membership.
      db.exec("ANALYZE");
    } catch (err) {
      const state = failureState(err);
      console.error(
        `${accountKey}: archive walk failed: ${state.kind} — ${"message" in state ? state.message : ""}`,
      );
    }
  })();
}

/**
 * The one place a startup failure is turned into a dead process.
 *
 * Final-review fix 2: this used to set `process.exitCode = 1` and return.
 * That is not "refuse to start": by the time acquireCredentials can throw,
 * `server.listen` has already registered a handle that keeps the event loop
 * alive forever, so the process stayed up, synced nothing, and
 * `restart: unless-stopped` never recycled it -- a zombie whose only honest
 * signal was /healthz answering 503. `process.exit(1)` is what makes the
 * refusal real, and what makes Docker restart (and keep restarting, loudly)
 * on a wrong master key rather than parking on a container that will never
 * work.
 *
 * Exported so a test can assert the exit ACTUALLY happens with a listening
 * server open -- the previous test only asserted acquireCredentials rejects,
 * which was true of the broken behaviour too.
 *
 * err.message only -- an error object in this codebase can carry a `stdout`
 * property (KeysCliStore scrubs it, but see credentials.ts), which could be
 * a credential.
 */
export function exitOnStartupFailure(err: unknown): never {
  console.error("wilco failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
}

if (import.meta.filename === process.argv[1]) {
  main().catch(exitOnStartupFailure);
}

/** The hostname from a `Host` header, without its port and case-folded.
 *  A missing header is not the body host. */
/**
 * The HOST DISPATCH: which handler a request reaches, decided by its `Host`.
 *
 * 🚨 A security boundary, not tidiness. Both hostnames reach this one
 * process, so without this branch the entire SPA and API would be reachable
 * on the body origin — defeating the whole point of spec 3.2, that a total
 * failure of the body CSP still reaches no cookie, no localStorage and no
 * DOM of Wilco's. The body origin serves two routes and 404s the rest.
 *
 * 🚨 EXTRACTED SO IT CAN BE TESTED (audit pass 8, T1). It lived inline in
 * `createServer`'s callback and therefore had no test at all: no test in
 * this repo ever set a `Host` header. `bodyhost.test.ts` is titled "the SPA
 * and the API are NOT reachable on the body origin" and calls
 * `handleBodyHost` DIRECTLY — it proves that handler 404s those paths, and
 * can never prove that handler is what receives them. Inverting the `===`
 * below left all 20 of those tests green while `mailbody.example.com` served
 * the SPA, the API and the session cookie.
 */
export function createHostDispatch(opts: {
  bodyHostname: string;
  onBody: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
  onApp: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    if (hostnameOf(req.headers.host) === opts.bodyHostname) {
      await opts.onBody(req, res, url);
      return;
    }
    await opts.onApp(req, res, url);
  };
}

/**
 * The APP side of the host dispatch: the SPA's CSP, then the static client,
 * then the router.
 *
 * 🚨 EXTRACTED SO THE CSP CAN BE TESTED WHERE IT IS APPLIED (audit pass 8,
 * T3). `applyAppCsp` had no test at all, and testing it directly would have
 * repeated T1's mistake one level down: composing the right string proves
 * nothing about whether any response carries it. This ran inline in a
 * closure inside `main()`, so no test could reach it, and deleting the
 * `applyAppCsp` line left the whole suite green while the origin that holds
 * the session cookie served every response with no policy at all.
 *
 * 🚨 The CSP is set BEFORE either handler runs, because both write their own
 * responses. A header set after `writeHead` is silently dropped.
 */
export function createAppHandler(opts: {
  bodyBaseUrl: string;
  serveClient: (ctx: { req: IncomingMessage; res: ServerResponse; url: URL; params: {} }) => Promise<boolean>;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> {
  return async (req, res, url) => {
    applyAppCsp(res, opts.bodyBaseUrl);
    const handledByClient = await opts.serveClient({ req, res, url, params: {} });
    if (!handledByClient) await opts.handle(req, res);
  };
}

function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  // An IPv6 literal is bracketed, so split on the LAST colon only when it
  // is not inside brackets.
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close === -1 ? trimmed : trimmed.slice(1, close);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/**
 * The SPA's own CSP. Spec 6.3: "The first draft gave a policy only to the
 * body origin and none to the origin holding the credentials."
 *
 * 🚨 `frame-src` naming the body origin is the fix for a measured problem,
 * not hardening. A plain same-frame `<a href>` click inside a message
 * NAVIGATES THE FRAME to the remote host and the request goes out --
 * `default-src 'none'` does not govern a frame navigating itself, and CSP's
 * `navigate-to` was removed. Without `frame-src` the reading pane can end
 * up showing attacker-controlled content where the user expects mail, and
 * the open has been reported to the sender.
 *
 * `script-src 'self'` and not `'unsafe-inline'`: the client is a built
 * bundle with no inline script. `style-src` does allow inline, because the
 * SPA sets element styles from design tokens at runtime.
 */
export function applyAppCsp(res: ServerResponse, bodyBaseUrl: string): void {
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      // The body origin too, for the attachment viewer's <img> (2026-09-08).
      // An image is not a document: nothing in it runs.
      `img-src 'self' data: blob: ${bodyBaseUrl}`,
      "font-src 'self' data:",
      "connect-src 'self'",
      `frame-src ${bodyBaseUrl}`,
      "form-action 'none'",
      "base-uri 'none'",
      // Nothing may frame the SPA: the body frame's own `frame-ancestors`
      // trusts this origin, so an attacker who could frame US would inherit
      // that trust.
      "frame-ancestors 'none'",
    ].join("; "),
  );
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
}
