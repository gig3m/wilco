import type { DatabaseSync } from "node:sqlite";
import type { JmapClient } from "../core/client.ts";
import type { Sleep } from "../core/corpus.ts";
import { refreshAccount } from "../core/refresh.ts";
import { backfillDetails, fetchOwnAddresses } from "../core/details.ts";
import { recordSync, recordDetailsFailure, clearDetailsFailure, getSyncState, clearSyncState } from "../core/mutations.ts";
import { startPush } from "../core/push.ts";
import type { AccountSpec } from "../core/accounts.ts";
import type { CredentialStore } from "../core/credentials.ts";
import { failureState, type AccountState } from "./health.ts";
import { HttpStatusError } from "../core/failures.ts";

/** The safety net behind push, not the primary path. */
export const SAFETY_POLL_MS = 5 * 60 * 1000;
/**
 * The longest a single pass may go WITHOUT MAKING PROGRESS. Passes are
 * sequential, so one that never returns stops every account (2026-09-08:
 * four and a half hours, all six accounts, one parked request). The request
 * bound in client.ts should make this unreachable; this is the line behind
 * it.
 *
 * It is a progress watchdog, not a wall-clock cap, because the two are not
 * the same thing and treating them as one broke a real sync (2026-09-22): a
 * first walk of a 167k-message mailbox is HOURS of perfectly healthy work,
 * and the fixed cap fired mid-walk, flipped the account to `network` ("a
 * sync pass hung"), left it stale in /healthz and dropped the pass from
 * `inFlight` while the walk carried on underneath. A pass that is storing
 * batches is not hung however long it runs; only silence is.
 *
 * Deliberately LONGER than health.ts's STALE_AFTER_MS (15 min): silence shows
 * up in /healthz first, and the supervisor only tears a pass down once that
 * silence has been reportable for five minutes.
 */
export const PASS_DEADLINE_MS = 20 * 60 * 1000;

/**
 * What a running supervisor lets the rest of the process do to it.
 *
 * One method, deliberately: `wake()` is the mirror image of main.ts's
 * `onAccountRemoved`. An account added (or given a credential) through
 * /api/accounts is pushed into the SAME `accounts`/`tokens` objects this
 * supervisor holds, and `wake()` is what makes the running loop notice
 * without waiting up to a full safety-poll interval -- or, before this
 * existed, a container restart.
 */
export interface SupervisorHandle {
  /**
   * Establish every account in `deps.accounts` that has no client yet, and
   * start a first pass for each one established. Resolves once the clients
   * are up; the passes themselves are NOT awaited (a first walk is minutes
   * to hours, and the HTTP request that called this must not wait on it).
   * A no-op when nothing is missing.
   */
  wake(): Promise<void>;
}

export interface SupervisorDeps {
  db: DatabaseSync;
  /** Accounts to establish/poll. Supplied by main.ts (this module must not
   *  reach into a database itself -- see accounts.ts). */
  accounts: AccountSpec[];
  clients: Map<string, JmapClient>;
  tokens: Map<string, string>;
  states: Map<string, AccountState>;
  /**
   * account -> epoch ms of the last sign of life from a pass for it: set at
   * pass start and on every batch stored (refreshAccount/backfillDetails'
   * onProgress). Shared with /healthz, which uses it to tell a first walk
   * that is MOVING (reported `syncing`) from one that has stalled (`stale`).
   * Optional so the many tests that do not care need not supply one.
   */
  progressAt?: Map<string, number>;
  onChange: (account: string) => void;
  now?: () => number;
  sleep?: Sleep;
  signal?: AbortSignal;
  pollMs?: number;
  /** See PASS_DEADLINE_MS. */
  passDeadlineMs?: number;
  /** Where this daemon's own diagnostics go. Injectable so a test can assert
   *  on them without capturing console. */
  log?: (message: string) => void;
  /** Injectable so tests can run the loop without a push reader. */
  startPushFn?: typeof startPush;
  /**
   * Re-read one account's credential after an auth failure (spec 5.6, 8.1).
   *
   * REQUIRED, and deliberately so (final-review fix 1). It used to default to
   * `new KeysCliStore(DEFAULT_NAME_FOR)`, and main() did not pass one -- so in
   * production the whole CredentialStore seam was bypassed on the re-auth
   * path and a credential rotated through the accounts API was silently
   * reverted to the `keys` value on the next 401. With no default, omitting
   * it cannot compile.
   */
  store: CredentialStore;
  /**
   * Bring an account up from nothing: session + mailbox tree -> a client.
   * Supplied by main.ts (this module must not own that wiring). Without it
   * an account whose establishClient failed at boot never enters `clients`
   * and the supervisor never touches it again -- /healthz 503s permanently
   * with no retry.
   */
  establishFn?: (accountKey: string, token: string) => Promise<JmapClient | undefined>;
  /**
   * Handed the handle once, before the first poll, so the process that
   * started this supervisor can wake it (see SupervisorHandle). Optional:
   * every test that only drives the loop can ignore it.
   */
  expose?: (handle: SupervisorHandle) => void;
}

/**
 * The default sleep, used when the caller does not inject one (i.e.
 * production). Races the timer against the abort signal so shutdown is
 * prompt: Docker gives a container 10s to stop on `docker compose restart`
 * or `stop`, and the safety poll interval is 5 minutes by default -- a sleep
 * that ignores the signal makes every deploy a SIGKILL of the sync daemon.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function startSupervisor(deps: SupervisorDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep: Sleep = deps.sleep ?? ((ms) => abortableSleep(ms, deps.signal));
  const pollMs = deps.pollMs ?? SAFETY_POLL_MS;
  const passDeadlineMs = deps.passDeadlineMs ?? PASS_DEADLINE_MS;
  const push = deps.startPushFn ?? startPush;
  const log = deps.log ?? ((m: string) => console.log(m));

  // Push and the poll both call the same pass. Push is paced by Fastmail's own
  // ~1.2s reconnect cycle; the poll is what keeps mail arriving if push stops.
  // No `??` fallback here: see SupervisorDeps.store. The runtime guard exists
  // because type stripping erases the `store: CredentialStore` requirement --
  // a JS caller (or a `deps` object built dynamically) could still omit it,
  // and the failure must be a loud boot crash, not a silent reversion to the
  // `keys` CLI on the first 401.
  const store = deps.store;
  if (!store) {
    throw new Error("startSupervisor requires a CredentialStore: re-auth must use the configured store");
  }

  // "The operator's own addresses" for deriveVia (review fix, Critical 1),
  // resolved once per account and cached for the life of this supervisor
  // run -- Identity/get is cheap but there is no reason to repeat it every
  // pass. A failed fetch is NOT cached (so it is retried on a later pass,
  // rather than pinned to empty forever) and does not fail the pass: it
  // falls back to an empty set, which deriveVia already treats as "don't
  // know yet" and answers NULL rather than a guess.
  const ownAddressesCache = new Map<string, Set<string>>();
  async function getOwnAddresses(account: string, client: JmapClient): Promise<Set<string>> {
    const cached = ownAddressesCache.get(account);
    if (cached) return cached;
    try {
      const addrs = await fetchOwnAddresses(client);
      ownAddressesCache.set(account, addrs);
      return addrs;
    } catch (err) {
      log(`${account}: identity fetch failed, Via will not be stored this pass: ${(err as Error).message}`);
      return new Set<string>();
    }
  }

  const pushers: Promise<void>[] = [];
  function startPusher(account: string, client: JmapClient): void {
    pushers.push(push(client.session, deps.tokens.get(account) ?? "", {
      signal: deps.signal,
      // The frame's accountId is not decoration (M4): one token can see
      // several JMAP accounts, so a StateChange naming another of them would
      // otherwise fire a pass for THIS account too -- N passes for one
      // change. Compare against this client's own mail account.
      onStateChange: (accountId, changed = {}) => {
        if (accountId !== client.session.mailAccountId) return;
        // A Mailbox state we have not seen means the folder tree changed
        // on the server (a folder created, renamed, moved). The tree is
        // otherwise refreshed on a 10-minute cadence; clearing the
        // cadence stamp makes THIS pass fetch it (row 22).
        const mailboxState = changed["Mailbox"];
        if (mailboxState !== undefined && mailboxState !== getSyncState(deps.db, account, "mailbox")) {
          clearSyncState(deps.db, account, "mailbox_at");
        }
        void pass(account);
      },
      // A refused event-source connection used to be discarded silently, so
      // "push is delivering nothing" and "push is connected and nothing has
      // happened" looked identical from outside the process. Record it the
      // same way a failed pass is recorded; the next pass overwrites it if
      // the API itself is fine.
      onNotOk: (status) => {
        setState(account, failureState(new HttpStatusError(`push connection refused with ${status}`, status)));
      },
      onLog: (m) => log(`${account}: ${m}`),
    }).catch(() => {
      // A dead push reader must degrade to the poll, never take the process
      // down. The account's state is set by the pass itself.
    }));
  }
  for (const [account, client] of deps.clients) startPusher(account, client);

  /**
   * An expired token used to leave the account {kind:"auth"} forever: no
   * re-read path existed and setToken was wired to nothing, so rotating the
   * secret in `keys` changed nothing until a container recreate (I2).
   * Returns the new token if one was obtained.
   */
  async function reauthenticate(account: string): Promise<string | undefined> {
    let token: string | null;
    try {
      token = await store.get(account);
    } catch {
      // Never surface the cause. KeysCliStore scrubs it deliberately --
      // execFile attaches the child's stdout, and that stdout IS the token.
      log(`${account}: token re-read failed`);
      return undefined;
    }
    if (!token) {
      log(`${account}: token re-read failed`);
      return undefined;
    }
    deps.tokens.set(account, token);
    log(`${account}: token re-read from keys after an auth failure`);
    return token;
  }

  /**
   * Accounts that never made it into `clients` (a boot-time auth failure, a
   * token that was not available yet, or an account ADDED since this loop
   * started) get one more chance per poll cycle -- and immediately, on
   * `wake()`. Returns the keys it actually brought up this run, which is
   * what `wake()` starts a first pass for.
   *
   * Coalesced like `pass()` is, because it now has two callers: the poll and
   * `wake()`. Two concurrent runs would both see the same account missing
   * from `clients` (there is an `await` between the check and the insert)
   * and establish it twice -- two sessions, two push readers, and only one
   * of them reachable through the map afterwards.
   */
  let establishing: Promise<string[]> | null = null;
  function establishMissing(): Promise<string[]> {
    const existing = establishing;
    if (existing) return existing;
    const started: Promise<string[]> = runEstablishMissing().finally(() => {
      if (establishing === started) establishing = null;
    });
    establishing = started;
    return started;
  }

  async function runEstablishMissing(): Promise<string[]> {
    const established: string[] = [];
    if (!deps.establishFn) return established;
    for (const a of deps.accounts) {
      if (deps.clients.has(a.key)) continue;
      // The re-auth is INSIDE the try with the establish: this promise is
      // shared (see the wrapper above) and is awaited by the poll loop, so
      // anything that rejects here stops the supervisor for EVERY account,
      // not just this one. reauthenticate has its own try/catch today; that
      // is not a reason to depend on it having one tomorrow.
      try {
        const token = deps.tokens.get(a.key) ?? (await reauthenticate(a.key));
        if (!token) continue;
        const client = await deps.establishFn(a.key, token);
        if (!client) continue;
        // The account can have been removed WHILE establishFn's await was
        // in flight (DELETE /api/accounts/:key calling onRemoved). Without
        // this re-check, an account no longer in deps.accounts still gets
        // inserted into deps.clients with a live pusher, and nothing ever
        // tears that pusher down -- it keeps fetching a deleted account's
        // mail until the next restart, the exact bug onRemoved exists to
        // avoid.
        if (!deps.accounts.some((x) => x.key === a.key)) continue;
        deps.clients.set(a.key, client);
        setState(a.key, { kind: "ok" });
        log(`${a.key}: account established on retry`);
        startPusher(a.key, client);
        // ONCE, here: /healthz cannot tell an account with no progress entry
        // from one whose walk has stalled, so a freshly added account would
        // report stale for the seconds before its first batch lands. Written
        // at establish rather than at every pass start, which is the
        // difference that matters: this ages out. A walk that then DIES stops
        // refreshing it, the entry passes the stale threshold, and /healthz
        // goes red -- which a per-poll stamp could never allow.
        noteProgress(a.key);
        established.push(a.key);
      } catch (err) {
        setState(a.key, failureState(err));
      }
    }
    return established;
  }

  /** See SupervisorHandle.wake. */
  async function wake(): Promise<void> {
    // Whether this call STARTED the run or joined one already in progress
    // matters: a run that is already past the new account's position in
    // `deps.accounts` will not see it, and would leave it waiting for the
    // next poll. Joining, then re-running once anything is still missing,
    // costs one extra (uncontended) pass over the array and cannot loop --
    // the second run is not coalesced onto anything.
    const joined = establishing !== null;
    const established = await establishMissing();
    if (joined && deps.accounts.some((a) => !deps.clients.has(a.key))) {
      established.push(...(await establishMissing()));
    }
    // NOT awaited: a first pass on a new account is a full walk. The caller
    // is an HTTP handler answering 201.
    //
    // No progress is stamped here: nothing has been stored yet. A newly
    // added account reports not-yet-syncing for the seconds between the add
    // and its walk's first batch, which is the truth -- and the alternative,
    // stamping progress it has not made, is what let a DEAD walk pass for a
    // healthy one indefinitely.
    for (const key of established) { void pass(key); }
  }

  /**
   * In-flight passes, one per account (I3).
   *
   * Ruling G11 accepted `void pass(account)` racing the poll on the reasoning
   * that a pass is a short call and the worst case is a duplicate
   * Email/changes. Ruling G13 then put backfillBodies INSIDE the pass, so a
   * pass is now minutes of paced batches on any backlog -- and with push
   * finally delivering (C1), nothing bounded how many could overlap. Each
   * concurrent one reads the same unfetchedIds and re-fetches the same
   * bodies, multiplying request volume and driving straight into the
   * sustained 429s that trigger I1.
   *
   * Coalescing rather than queueing is correct: a pass already running will
   * pick up whatever the notification was about.
   */
  const inFlight = new Map<string, Promise<void>>();

  /**
   * Every finding in the plan-2 review was invisible from the logs by
   * construction (M2): a pass logged nothing on success or failure, and
   * bodiesFailed, bodiesWritten, mailboxesRefreshed and the ChangeSet's
   * rounds/newState were all computed and discarded. One line per account
   * state TRANSITION -- not per pass, which would be a line a minute per
   * account forever.
   */
  function setState(account: string, next: AccountState): void {
    const prev = deps.states.get(account);
    const changed =
      prev === undefined ||
      prev.kind !== next.kind ||
      ("message" in prev ? prev.message : "") !== ("message" in next ? next.message : "");
    deps.states.set(account, next);
    if (changed) {
      const detail = "message" in next ? `: ${next.message}` : "";
      log(`${account}: state ${prev?.kind ?? "unknown"} -> ${next.kind}${detail}`);
    }
  }

  /**
   * The one place a pass's progress is recorded, and the ONLY thing the
   * watchdog below judges a pass by. `deps.progressAt` when the caller
   * supplied one (main.ts does, and /healthz reads that same map), otherwise
   * a private one so the watchdog behaves identically without it.
   *
   * It is a shared MAP rather than a callback captured by whoever is waiting,
   * because neither of the two ways a pass makes progress belongs to the
   * waiter:
   *   * `pass` coalesces -- the poll routinely waits on a pass a push event
   *     started, whose onProgress was handed out before this waiter existed;
   *   * `walkArchive` coalesces too, and DROPS the second caller's options
   *     (corpus.ts: `if (inFlight) return inFlight`). main.ts starts the boot
   *     walk before the supervisor exists, so for the whole of a first walk --
   *     hours on a large mailbox, the exact case this watchdog was rewritten
   *     for -- the supervisor's own onProgress is never called ONCE. The boot
   *     walk writes this map directly instead.
   * A closure-based tick cannot see either writer. A map can see all of them.
   */
  const progressAt = deps.progressAt ?? new Map<string, number>();

  /**
   * One batch STORED for `account`.
   *
   * 🚨 Work only. This map is shared with /healthz, which reads it to tell a
   * first walk that is MOVING from one that has stalled, so anything written
   * here is a claim that the walk advanced. It used to be stamped at pass
   * START as well -- and the poll starts a pass for every account every five
   * minutes against a fifteen-minute stale threshold, so the value could
   * never age past it. `syncing` was then permanently true for any
   * healthy-state account with an unfinished walk, `ok` stopped requiring a
   * finished walk, and an account whose first walk had DIED reported healthy
   * for good. The watchdog's need for a "the pass just started" baseline is
   * met locally in `passWithin`, where it cannot be mistaken for progress.
   */
  function noteProgress(account: string): void {
    progressAt.set(account, now());
  }

  function pass(account: string): Promise<void> {
    const existing = inFlight.get(account);
    if (existing) return existing;
    // runPass is an async function and so cannot reject synchronously, and
    // the finally callback is a microtask -- the set below therefore always
    // happens before the delete. A pass that THROWS must still clear its
    // entry or the account never passes again, which is why this is finally
    // and not then.
    // Only THIS pass's entry: an abandoned pass that finally settles must
    // not clear the fresh one the watchdog let start in its place.
    const started: Promise<void> = runPass(account).finally(() => {
      if (inFlight.get(account) === started) inFlight.delete(account);
    });
    inFlight.set(account, started);
    return started;
  }

  /**
   * The loop's wait on a pass, bounded by PROGRESS. A pass that goes
   * `passDeadlineMs` without a single batch stored is ABANDONED: reported on
   * the account, dropped from `inFlight` so the next cycle starts fresh, and
   * left to settle (or not) on its own. Nothing can cancel a promise; what
   * can be guaranteed is that the loop moves on. A pass that keeps ticking
   * is waited on for as long as it keeps ticking.
   */
  async function passWithin(account: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveDeadline!: (v: "deadline") => void;
    const deadline = new Promise<"deadline">((resolve) => { resolveDeadline = resolve; });
    // Fires, then CHECKS rather than concluding: if the map advanced while
    // the timer ran, the pass is alive and the timer re-arms for whatever is
    // left of the window. Polling the map -- instead of being re-armed by a
    // callback -- is what makes this work for a writer the supervisor never
    // handed a callback to, i.e. main.ts's boot walk (see progressAt above).
    // The watchdog's baseline, LOCAL to this wait. A pass that has only just
    // begun has not stalled, so the clock runs from the later of "this pass
    // started" and "this account last stored something". Deliberately not
    // written into `progressAt`: that map is /healthz's evidence that a walk
    // is advancing, and a pass merely starting is not that.
    const startedAt = now();
    const lastSign = (): number => Math.max(startedAt, progressAt.get(account) ?? 0);

    const arm = (delay: number): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        const since = now() - lastSign();
        if (since < passDeadlineMs) { arm(passDeadlineMs - since); return; }
        resolveDeadline("deadline");
      }, delay);
    };

    arm(passDeadlineMs);

    const p = pass(account);
    try {
      const outcome = await Promise.race([p.then(() => "done" as const), deadline]);
      if (outcome === "deadline") {
        const minutes = Math.round(passDeadlineMs / 60_000);
        log(`${account}: pass made no progress for ${minutes} minutes and was abandoned; the next cycle starts fresh`);
        setState(account, { kind: "network", message: `no progress for ${minutes} minutes; the pass was abandoned` });
        if (inFlight.get(account) === p) inFlight.delete(account);
      }
    } finally {
      // The abandoned pass goes on running and goes on writing progressAt;
      // clearing the timer is what stops that from concerning a waiter that
      // has already given up on it.
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function runPass(account: string): Promise<void> {
    const client = deps.clients.get(account);
    if (!client) return;
    try {
      // Thread pacing AND cancellation through -- and thread the LOCAL
      // `sleep` (the abort-aware default computed above), not `deps.sleep`.
      // deps.sleep is undefined in production (main.ts never sets it), so
      // passing it straight through silently reinstates corpus.ts's raw,
      // non-abort-aware setTimeout for backfillBodies' pacing, and a
      // rate-limited pass can then block shutdown for tens of seconds --
      // observed at 21.5s -- past Docker's 10s grace window. Round 2 wired
      // `deps.sleep` here by mistake; every test that exercised this line
      // injected its own `sleep`, which is exactly the one shape production
      // never uses (see "a pass without an injected sleep is still
      // abortable" below).
      // onProgress is what makes the deadline above a progress watchdog:
      // every walk page, changes chunk and body batch is a tick.
      const onProgress = (): void => noteProgress(account);
      const r = await refreshAccount(deps.db, client, account, { now, sleep, signal: deps.signal, onProgress });
      setState(account, { kind: "ok" });
      recordSync(deps.db, account, now());

      // One batch of the detail backfill (recipients/attachments/Via) per
      // pass, AFTER the body backfill -- bounded to maxBatches: 1 so this
      // whole-corpus job (task-2-brief: ~37.6k messages across four
      // accounts) never starves incremental sync, the way backfillBodies
      // (unbounded, inside refreshAccount) is allowed to. An account whose
      // details are already complete costs one indexed query and returns 0.
      //
      // Deliberately NOT allowed to fail the pass: this is an ancillary
      // enrichment, not the sync itself, so a details-backfill error (e.g.
      // a "made no progress" guard tripping) does not flip the account to a
      // failure state a human would read as "mail sync is broken." It IS,
      // however, counted via recordDetailsFailure (review fix, Important 1)
      // so a persistently failing account is still visible somewhere an
      // operator would look (/healthz's detailsBackfillFailures) rather than
      // only in a log line that scrolls away. Skipped entirely once
      // shutdown has been requested, so an aborted pass never starts new
      // work.
      if (!deps.signal?.aborted) {
        try {
          const ownAddresses = await getOwnAddresses(account, client);
          await backfillDetails(deps.db, client, account, {
            maxBatches: 1,
            signal: deps.signal,
            ownAddresses,
            onProgress,
          });
          // A clean pass resets the streak (fix wave, finding 2) -- see
          // clearDetailsFailure's doc comment for why this must reset, not
          // just increment on failure.
          clearDetailsFailure(deps.db, account);
        } catch (err) {
          const count = recordDetailsFailure(deps.db, account);
          log(`${account}: details backfill failed (count=${count}): ${(err as Error).message}`);
        }
      }
      // Only when something actually happened, so a quiet mailbox stays
      // quiet in the log. bodiesFailed in particular was returned and
      // discarded -- it is the counter that would have shown I1 blanking
      // bodies in production.
      const noise =
        r.created + r.updated + r.destroyed + r.bodiesWritten + r.bodiesFailed > 0 ||
        r.reconciled > 0 ||  // a reconcile that removed rows is news, and the SPA must refetch
        r.resynced ||
        r.mailboxesRefreshed;
      if (noise) {
        log(
          `${account}: pass created=${r.created} updated=${r.updated} destroyed=${r.destroyed} reconciled=${r.reconciled} ` +
            `bodies=${r.bodiesWritten} bodiesFailed=${r.bodiesFailed} ` +
            `mailboxes=${r.mailboxesRefreshed} resynced=${r.resynced}`,
        );
      }
      if (r.created + r.updated + r.destroyed + r.reconciled > 0 || r.resynced) deps.onChange(account);
    } catch (err) {
      // One account's failure must not stop the others, and liveness is NOT
      // recorded -- a failing account must go stale in /healthz.
      const state = failureState(err);
      setState(account, state);
      if (state.kind === "auth") {
        const token = await reauthenticate(account);
        if (token) client.setToken(token);
      }
    }
  }

  // Once, before the first poll: from here on an account added through the
  // API takes effect in THIS loop (see SupervisorHandle).
  deps.expose?.({ wake });

  while (!deps.signal?.aborted) {
    await establishMissing();
    for (const account of [...deps.clients.keys()]) await passWithin(account);
    if (deps.signal?.aborted) break;
    await sleep(pollMs);
  }

  await Promise.allSettled(pushers);
}
