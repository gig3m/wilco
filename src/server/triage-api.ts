/**
 * POST /api/triage        -- apply an action to one or more messages
 * POST /api/triage/undo   -- restore a previous batch exactly
 *
 * The first write surface in Wilco. Requires "write" scope AND CSRF, unlike
 * every read route: a read-only token must never be able to move mail, and
 * `POST /api/search` is the only POST here that is exempt from the scope
 * check (it is a read shaped like a write).
 *
 * Undo is server-side and stateful by design. The client could in principle
 * send back the prior state itself, but then the authority for "what was
 * this message's state before?" would live in a browser tab that can be
 * closed, reloaded, or lied to. The batch is recorded here, keyed by an
 * opaque id, and undo replays the captured snapshots.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import type { JmapClient } from "../core/client.ts";
import {
  applyLocal,
  destinationFor,
  planAction,
  planRestore,
  snapshot,
  TriageError,
  MOVE_ROLES,
  type MessageSnapshot,
  type TriageAction,
  scopedTargets,
  type TriageScope,
  type TriageTarget,
} from "../core/triage.ts";
import { beginWrite, endWrite } from "../core/pending.ts";
import type { Router } from "./router.ts";
import { json } from "./router.ts";
import { authenticate, checkCsrf, hasScope } from "./auth.ts";
import { readJson } from "./body.ts";

export interface TriageDeps {
  db: DatabaseSync;
  origin: string;
  clients: Map<string, JmapClient>;
  onChange?: (account: string) => void;
}

/** How many undo batches to remember. Undo is a few-seconds affordance
 *  behind a toast, not a history feature -- an unbounded map would grow for
 *  the life of the process. */
const MAX_UNDO_BATCHES = 50;

interface UndoBatch {
  at: number;
  snapshots: MessageSnapshot[];
}

export type { TriageTarget } from "../core/triage.ts";

/** Cap on messages per request. The design's select-all acts on a visible
 *  page, not the whole archive; a request naming 40k ids would hold the JMAP
 *  connection for minutes and time out having half-applied. */
const MAX_TARGETS = 200;

export function registerTriageRoutes(router: Router, deps: TriageDeps): void {
  const undoBatches = new Map<string, UndoBatch>();

  function remember(batch: UndoBatch): string {
    const id = randomBytes(9).toString("base64url");
    undoBatches.set(id, batch);
    while (undoBatches.size > MAX_UNDO_BATCHES) {
      const oldest = undoBatches.keys().next();
      if (oldest.done) break;
      undoBatches.delete(oldest.value);
    }
    return id;
  }

  /**
   * Apply one already-built patch per message, grouped by account so each
   * account makes exactly one `Email/set` call rather than one per message.
   *
   * The local cache is written FIRST (so the UI is instant) and rolled back
   * per-account if that account's JMAP call fails. Rolling back only the
   * failed account matters: a four-account batch where `work` rejects must
   * not silently revert the three that succeeded.
   */
  async function applyBatch(
    plans: { target: TriageTarget; plan: ReturnType<typeof planAction> }[],
    before: Map<string, MessageSnapshot>,
  ): Promise<{ applied: TriageTarget[]; failed: { target: TriageTarget; error: string }[] }> {
    const applied: TriageTarget[] = [];
    const failed: { target: TriageTarget; error: string }[] = [];
    const byAccount = new Map<string, typeof plans>();
    for (const p of plans) {
      const list = byAccount.get(p.target.account) ?? [];
      list.push(p);
      byAccount.set(p.target.account, list);
    }

    for (const [account, list] of byAccount) {
      const client = deps.clients.get(account);
      if (!client) {
        for (const p of list) failed.push({ target: p.target, error: "account not connected" });
        continue;
      }
      // 🚨 SPEC 3.7: the pending-write set is held from BEFORE the optimistic
      // local write until after `Email/set` resolves, so a push round landing
      // in that window cannot overwrite our value with the server's
      // pre-action view. Taken before `applyLocal`, not after: the gap
      // between writing locally and marking pending is the race itself.
      //
      // `withPendingWrites` releases in a finally, so a rejected `Email/set`
      // -- the normal failure path -- cannot leave these rows frozen out of
      // sync. See core/pending.ts for why a leak is worse than the race.
      for (const p of list) beginWrite(account, p.target.id);
      try {
        // Optimistic local write.
        for (const p of list) applyLocal(deps.db, account, p.target.id, p.plan);

      const update: Record<string, unknown> = {};
      for (const p of list) update[p.target.id] = p.plan.patch;

      try {
        // Indexed, not destructured. `[[result]]` throws a TypeError on an
        // empty `responses` -- a malformed/empty JMAP reply would have
        // surfaced as an opaque crash inside the try rather than as the
        // "rejected" path this code already has. It also never typechecked
        // under noUncheckedIndexedAccess (audit pass 1: `npm run typecheck`
        // was red on main).
        const responses = await client.request([
          ["Email/set", { accountId: client.session.mailAccountId, update }, "t0"],
        ]);
        const result = responses[0];
        const body = (result?.[1] ?? {}) as {
          updated?: Record<string, unknown>;
          notUpdated?: Record<string, { type?: string; description?: string }>;
        };
        const notUpdated = body.notUpdated ?? {};
        for (const p of list) {
          const problem = notUpdated[p.target.id];
          if (problem) {
            // Server refused this one specifically -- put the local row back.
            const snap = before.get(key(p.target));
            if (snap) applyLocal(deps.db, account, p.target.id, planRestore(snap));
            failed.push({
              target: p.target,
              error: problem.type ?? problem.description ?? "rejected",
            });
          } else {
            applied.push(p.target);
          }
        }
      } catch (err) {
        // The whole call failed: nothing on the server changed, so every
        // optimistic local write for this account must be undone.
        for (const p of list) {
          const snap = before.get(key(p.target));
          if (snap) applyLocal(deps.db, account, p.target.id, planRestore(snap));
          failed.push({ target: p.target, error: (err as Error).message });
        }
      }
        deps.onChange?.(account);
      } finally {
        // Released here and nowhere else, closing the window opened before
        // `applyLocal`. Every path falls through to this -- success, the
        // per-message rejection path, and the whole-call rollback -- so the
        // rows stay protected while the ROLLBACK writes too. Sync landing
        // between a restore and the release would reintroduce exactly the
        // race this exists to close.
        for (const p of list) endWrite(account, p.target.id);
      }
    }
    return { applied, failed };
  }

  router.add("POST", "/api/triage", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    if (!hasScope(principal, "write")) return json(c.res, 403, { error: "write scope required" });

    let payload: unknown;
    try {
      payload = await readJson(c.req);
    } catch {
      return json(c.res, 400, { error: "invalid json" });
    }
    const body = payload as { action?: unknown; targets?: unknown; scope?: unknown };
    const action = parseAction(body.action);
    if (!action) return json(c.res, 400, { error: "unknown action" });
    const named = parseTargets(body.targets);
    if (!named) return json(c.res, 400, { error: "targets must be [{account, id}]" });
    if (named.length === 0) return json(c.res, 400, { error: "no targets" });
    if (named.length > MAX_TARGETS) {
      return json(c.res, 400, { error: `too many targets (max ${MAX_TARGETS})` });
    }
    const scope = parseScope(body.scope);
    if (scope === null) return json(c.res, 400, { error: "scope must be {kind: 'conversation', role | mailboxId}" });
    // Row 58: widened BEFORE the snapshots, so undo restores every member
    // the action touched, not only the ones the client named.
    const targets = scopedTargets(deps.db, action, named, scope);

    const before = new Map<string, MessageSnapshot>();
    const plans: { target: TriageTarget; plan: ReturnType<typeof planAction> }[] = [];
    const destCache = new Map<string, string | undefined>();
    try {
      for (const t of targets) {
        const snap = snapshot(deps.db, t.account, t.id);
        before.set(key(t), snap);
        if (!destCache.has(t.account)) {
          destCache.set(t.account, destinationFor(deps.db, t.account, action));
        }
        plans.push({ target: t, plan: planAction(snap, action, destCache.get(t.account)) });
      }
    } catch (err) {
      if (err instanceof TriageError) return json(c.res, 400, { error: err.message });
      throw err;
    }

    const { applied, failed } = await applyBatch(plans, before);
    const undoId = applied.length > 0 ? remember({ at: Date.now(), snapshots: [...before.values()] }) : null;
    json(c.res, failed.length > 0 && applied.length === 0 ? 502 : 200, {
      applied: applied.length,
      failed,
      undoId,
    });
  });

  router.add("POST", "/api/triage/undo", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    if (!hasScope(principal, "write")) return json(c.res, 403, { error: "write scope required" });

    let payload: unknown;
    try {
      payload = await readJson(c.req);
    } catch {
      return json(c.res, 400, { error: "invalid json" });
    }
    const undoId = (payload as { undoId?: unknown }).undoId;
    if (typeof undoId !== "string") return json(c.res, 400, { error: "undoId required" });
    const batch = undoBatches.get(undoId);
    if (!batch) return json(c.res, 404, { error: "nothing to undo" });

    const before = new Map<string, MessageSnapshot>();
    const plans: { target: TriageTarget; plan: ReturnType<typeof planAction> }[] = [];
    for (const snap of batch.snapshots) {
      const target = { account: snap.account, id: snap.id };
      // Snapshot the CURRENT state before restoring, so a failed undo can be
      // rolled back the same way a failed action is.
      before.set(key(target), snapshot(deps.db, snap.account, snap.id));
      plans.push({ target, plan: planRestore(snap) });
    }
    const { applied, failed } = await applyBatch(plans, before);
    // An undo is consumed whether or not every message came back, so a retry
    // cannot re-apply a stale snapshot over newer state.
    undoBatches.delete(undoId);
    json(c.res, failed.length > 0 && applied.length === 0 ? 502 : 200, {
      restored: applied.length,
      failed,
    });
  });
}

/**
 * The composite key for the pre-triage snapshot map.
 *
 * 🚨 The separator is an explicit NUL escape, not a raw NUL byte. It was
 * written as a literal 0x00 in the source, which READS as a space in every
 * editor and diff -- and is exactly the kind of thing an audit is for. Kept
 * as a NUL rather than "corrected" to a space: an id cannot contain one, so
 * it is genuinely the safer separator. Only its spelling changes.
 */
function key(t: TriageTarget): string {
  return `${t.account}\u0000${t.id}`;
}

function parseAction(raw: unknown): TriageAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as { kind?: unknown; role?: unknown; value?: unknown; mailboxId?: unknown };
  if (a.kind === "move") {
    return MOVE_ROLES.includes(a.role as never) ? { kind: "move", role: a.role as never } : null;
  }
  if (a.kind === "moveTo") {
    return typeof a.mailboxId === "string" && a.mailboxId !== ""
      ? { kind: "moveTo", mailboxId: a.mailboxId }
      : null;
  }
  if (a.kind === "spam") return { kind: "spam" };
  if (a.kind === "flag" || a.kind === "read") {
    return typeof a.value === "boolean" ? { kind: a.kind, value: a.value } : null;
  }
  return null;
}

/** undefined = no scope sent; null = a scope was sent and is malformed. */
function parseScope(raw: unknown): TriageScope | undefined | null {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") return null;
  const s = raw as { kind?: unknown; role?: unknown; mailboxId?: unknown };
  if (s.kind !== "conversation") return null;
  if (typeof s.mailboxId === "string" && s.mailboxId !== "") return { kind: "conversation", mailboxId: s.mailboxId };
  if (typeof s.role === "string" && s.role !== "") return { kind: "conversation", role: s.role };
  return null;
}

function parseTargets(raw: unknown): TriageTarget[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TriageTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const t = item as { account?: unknown; id?: unknown };
    if (typeof t.account !== "string" || typeof t.id !== "string") return null;
    if (t.account === "" || t.id === "") return null;
    out.push({ account: t.account, id: t.id });
  }
  return out;
}
