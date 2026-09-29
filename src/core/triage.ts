/**
 * Triage: the first WRITE path against Fastmail.
 *
 * Everything before this plan was read-only -- `Email/get`, `Email/query`,
 * `Mailbox/get` and nothing else. This module adds `Email/set`, which means
 * a bug here does not render something wrong on a screen, it MOVES OR
 * DESTROYS REAL MAIL. Three rules follow from that and are enforced below:
 *
 *  1. **Never delete.** `trash` and `spam` are MOVES into the account's own
 *     Trash/Spam mailbox, which Fastmail retains for 30 days. There is no
 *     `destroy` array anywhere in this file and there must never be one --
 *     an `Email/set` with `destroy` is irreversible and undo could not
 *     restore it. Emptying trash is a separate, explicit act.
 *  2. **Capture before you change.** Every action snapshots the message's
 *     prior mailboxIds and keywords FIRST, so undo restores exactly what
 *     was there rather than guessing an inverse. "Unarchive" is not the
 *     inverse of "archive" when a message lived in three mailboxes.
 *  3. **The server is the authority, the local row is a cache.** Local rows
 *     are updated optimistically so the UI is instant, but a JMAP failure
 *     rolls the local row back. A local row that disagrees with the server
 *     is a lie the next sync would silently overwrite.
 */

import type { DatabaseSync } from "node:sqlite";
import { spamMailboxId } from "./settings.ts";

/** Roles this module is willing to move mail INTO. Deliberately not "sent"
 *  or "drafts" -- moving a message into either would misrepresent its
 *  provenance, and nothing in the design offers it. */
export const MOVE_ROLES = ["inbox", "archive", "trash", "junk"] as const;
export type MoveRole = (typeof MOVE_ROLES)[number];

export type TriageAction =
  | { kind: "move"; role: MoveRole }
  | { kind: "moveTo"; mailboxId: string }
  // 🚨 "Mark as spam" is its OWN action, not `{ kind: "move", role: "junk" }`.
  //
  // Spec 7.6: "Fastmail only learns from the folder its training points at;
  // this account uses *Identified Spam*, and a key bound to `role=junk`
  // would quietly do the wrong thing. There is no correct default to
  // hardcode." Audit pass 2 F4 measured it: `personal` and `work` each hold
  // BOTH an "Identified Spam" (role NULL) and a "Spam" (role junk) mailbox,
  // and every message ever marked spam went to the one the filter does not
  // read.
  //
  // Modelling it as a move-to-junk is what made that invisible — the action
  // named a ROLE, so there was nowhere for a per-account answer to live. As
  // its own kind it resolves through `settings.spamMailboxId`, and refuses
  // when the operator has not chosen (see `destinationFor`).
  | { kind: "spam" }
  | { kind: "flag"; value: boolean }
  | { kind: "read"; value: boolean };

export class TriageError extends Error {}

export interface MessageSnapshot {
  account: string;
  id: string;
  mailboxIds: string[];
  keywords: Record<string, true>;
}

/** JMAP patch object for one message, plus the local effect to mirror. */
export interface TriagePlan {
  patch: Record<string, unknown>;
  mailboxIds: string[] | null; // null = unchanged
  keywords: Record<string, true> | null; // null = unchanged
}

export function mailboxIdForRole(db: DatabaseSync, account: string, role: string): string {
  const row = db
    .prepare(`SELECT id FROM mailboxes WHERE account = ? AND role = ? LIMIT 1`)
    .get(account, role) as { id?: string } | undefined;
  if (!row?.id) throw new TriageError(`${account}: no mailbox with role "${role}"`);
  return row.id;
}

export function snapshot(db: DatabaseSync, account: string, id: string): MessageSnapshot {
  const row = db
    .prepare(`SELECT keywords FROM emails WHERE account = ? AND id = ?`)
    .get(account, id) as { keywords?: string } | undefined;
  if (!row) throw new TriageError(`${account}/${id}: no such message`);
  const boxes = db
    .prepare(`SELECT mailbox_id FROM email_mailboxes WHERE account = ? AND email_id = ?`)
    .all(account, id) as { mailbox_id: string }[];
  return {
    account,
    id,
    mailboxIds: boxes.map((b) => b.mailbox_id),
    keywords: parseKeywords(row.keywords),
  };
}

function parseKeywords(raw: string | undefined): Record<string, true> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, true> = {};
    for (const k of Object.keys(parsed as Record<string, unknown>)) out[k] = true;
    return out;
  } catch {
    // A malformed keywords blob must not take down a triage action; treat it
    // as "no keywords" and let the next sync rewrite it correctly.
    return {};
  }
}

/**
 * Build the JMAP patch for one action against one message's current state.
 *
 * A move sets `mailboxIds` WHOLESALE rather than patching individual keys.
 * Fastmail messages routinely live in several mailboxes at once (a label
 * plus the inbox); a patch that only removed the inbox would leave the
 * message visible under its labels and "archive" would appear not to work.
 */
export function planAction(before: MessageSnapshot, action: TriageAction, dest?: string): TriagePlan {
  switch (action.kind) {
    case "move":
    case "moveTo":
    case "spam": {
      if (!dest) throw new TriageError("move requires a destination mailbox id");
      return { patch: { mailboxIds: { [dest]: true } }, mailboxIds: [dest], keywords: null };
    }
    case "flag": {
      const keywords = { ...before.keywords };
      if (action.value) keywords["$flagged"] = true;
      else delete keywords["$flagged"];
      return {
        patch: { "keywords/$flagged": action.value ? true : null },
        mailboxIds: null,
        keywords,
      };
    }
    case "read": {
      const keywords = { ...before.keywords };
      if (action.value) keywords["$seen"] = true;
      else delete keywords["$seen"];
      return {
        patch: { "keywords/$seen": action.value ? true : null },
        mailboxIds: null,
        keywords,
      };
    }
  }
}

/** The patch that restores a snapshot exactly -- used by undo. Sets both
 *  mailboxIds and keywords wholesale, because a partial restore of either
 *  would leave the message in a state it was never actually in. */
export function planRestore(before: MessageSnapshot): TriagePlan {
  const mailboxIds: Record<string, true> = {};
  for (const id of before.mailboxIds) mailboxIds[id] = true;
  return {
    patch: { mailboxIds, keywords: { ...before.keywords } },
    mailboxIds: [...before.mailboxIds],
    keywords: { ...before.keywords },
  };
}

/**
 * Mirror a plan onto the local cache.
 *
 * `is_unread` and `is_flagged` are derived columns the list and sidebar read
 * directly, so they must be kept consistent with `keywords` in the same
 * transaction -- a keywords blob saying `$seen` while `is_unread` stays 1
 * shows a message as unread forever until the next full refresh.
 */
export function applyLocal(db: DatabaseSync, account: string, id: string, plan: TriagePlan): void {
  if (plan.keywords) {
    const kw = plan.keywords;
    db.prepare(
      `UPDATE emails SET keywords = ?, is_unread = ?, is_flagged = ? WHERE account = ? AND id = ?`,
    ).run(JSON.stringify(kw), kw["$seen"] ? 0 : 1, kw["$flagged"] ? 1 : 0, account, id);
  }
  if (plan.mailboxIds) {
    // received_at/thread_key are denormalized copies of the message's own
    // columns (migration 11), read ONCE here rather than re-queried per
    // mailbox -- see mutations.ts's storeEmails for the sibling write path
    // and assertNoMembershipDrift (triage.test.ts) for the invariant.
    const email = db
      .prepare(`SELECT received_at, thread_id FROM emails WHERE account = ? AND id = ?`)
      .get(account, id) as { received_at: string; thread_id: string | null } | undefined;
    if (!email) throw new TriageError(`${account}/${id}: no such message`);
    const threadKey = email.thread_id ?? id;

    db.prepare(`DELETE FROM email_mailboxes WHERE account = ? AND email_id = ?`).run(account, id);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO email_mailboxes (account, email_id, mailbox_id, received_at, thread_key)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const mb of plan.mailboxIds) ins.run(account, id, mb, email.received_at, threadKey);
  }
}

/**
 * Resolve the destination mailbox for an action, or undefined when the
 * action does not move anything. Kept separate from planAction so the
 * database lookup happens once per batch rather than once per message.
 */
export function destinationFor(
  db: DatabaseSync,
  account: string,
  action: TriageAction,
): string | undefined {
  if (action.kind === "move") return mailboxIdForRole(db, account, action.role);
  if (action.kind === "spam") {
    // 🚨 REFUSES rather than falling back to role=junk. Falling back is the
    // exact behaviour spec 7.6 calls "quietly doing the wrong thing", and it
    // is worse than an error: the message moves, the toast says it worked,
    // and the filter learns nothing. An error the operator can act on beats
    // a success that lies.
    const dest = spamMailboxId(db, account);
    if (dest === null) {
      throw new TriageError(
        `${account}: no spam-training folder chosen. Fastmail only learns from the folder its training points at, so this has to be set per account in Settings.`,
      );
    }
    return dest;
  }
  if (action.kind === "moveTo") {
    const row = db
      .prepare(`SELECT id FROM mailboxes WHERE account = ? AND id = ?`)
      .get(account, action.mailboxId) as { id?: string } | undefined;
    // Scoped to the account on purpose: Fastmail reuses mailbox ids across
    // accounts ("P-F" is every account's inbox), so an unscoped lookup would
    // happily move a work message into a personal folder id.
    if (!row?.id) throw new TriageError(`${account}: no mailbox ${action.mailboxId}`);
    return row.id;
  }
  return undefined;
}

/** One message, keyed the way every read route keys: `(account, id)`. Ids
 *  collide across accounts, so an id alone names nothing. */
export interface TriageTarget {
  account: string;
  id: string;
}

/**
 * Row 58 (owner ruling 2026-09-15): "archive/move act on conversations,
 * delete and spam act on the message only."
 *
 * The list shows one row per CONVERSATION (read-api collapses on
 * `COALESCE(thread_id, id)`), so a triage that moved only the row's
 * representative message left the row standing on its siblings -- the
 * owner archived one conversation twice and watched it come back both
 * times. A scope names the folder the user was looking at; each target is
 * widened to every message of its thread that is in that folder, and no
 * further: a member already archived, or in Trash, is not part of what the
 * user saw and is not touched.
 */
export interface TriageScope {
  kind: "conversation";
  /** The viewed role (the unified inbox, an account's Archive...). */
  role?: string;
  /** The viewed custom folder; scoped to each target's own account, since
   *  Fastmail reuses mailbox ids across accounts. */
  mailboxId?: string;
}

export function expandConversations(db: DatabaseSync, targets: TriageTarget[], scope: TriageScope): TriageTarget[] {
  const seen = new Set<string>();
  const out: TriageTarget[] = [];
  const add = (t: TriageTarget): void => {
    const k = `${t.account} ${t.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  const viewed = new Map<string, string | null>();
  for (const t of targets) {
    add(t);
    if (!viewed.has(t.account)) {
      let box: string | null = null;
      if (scope.mailboxId !== undefined) box = scope.mailboxId;
      else if (scope.role !== undefined) {
        try {
          box = mailboxIdForRole(db, t.account, scope.role);
        } catch {
          box = null; // an account without that role: the target stands alone
        }
      }
      viewed.set(t.account, box);
    }
    const box = viewed.get(t.account);
    if (box === null || box === undefined) continue;
    const row = db.prepare(`SELECT thread_id FROM emails WHERE account = ? AND id = ?`).get(t.account, t.id) as
      | { thread_id: string | null }
      | undefined;
    if (!row?.thread_id) continue;
    const members = db
      .prepare(
        `SELECT e.id FROM emails e
           JOIN email_mailboxes em ON em.account = e.account AND em.email_id = e.id
          WHERE e.account = ? AND e.thread_id = ? AND em.mailbox_id = ?
          ORDER BY e.received_at DESC`,
      )
      .all(t.account, row.thread_id, box) as { id: string }[];
    for (const m of members) add({ account: t.account, id: m.id });
  }
  return out;
}

/** The ruling, held server-side: only archive and folder moves widen to
 *  the conversation. A trash move (delete) and spam stay one message
 *  whatever the client sends, so no client bug can delete a whole
 *  conversation with one `#`. */
export function scopedTargets(
  db: DatabaseSync,
  action: TriageAction,
  targets: TriageTarget[],
  scope: TriageScope | undefined,
): TriageTarget[] {
  if (scope === undefined) return targets;
  const widens = action.kind === "moveTo" || (action.kind === "move" && action.role !== "trash");
  return widens ? expandConversations(db, targets, scope) : targets;
}
