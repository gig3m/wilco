import type { DatabaseSync } from "node:sqlite";
import { isPending } from "./pending.ts";
import type { JmapEmail, JmapMailbox } from "./types.ts";

/**
 * The single write path for message metadata.
 *
 * The upsert's ON CONFLICT clause deliberately EXCLUDES body_text -- it lists
 * every other column and nothing else. An Email/changes refresh calls this
 * with fresh metadata and no body; including body_text in the update would
 * overwrite an already-indexed body with nothing and silently degrade search
 * over months, with no error and nothing to see. DO NOT ADD IT.
 */
export function storeEmails(db: DatabaseSync, account: string, emails: JmapEmail[]): void {
  // 🚨 SPEC 3.7: sync SKIPS rows with a write in flight.
  //
  // This is the single upsert point every sync path goes through --
  // `refresh.ts`'s change reader and `corpus.ts`'s archive walk -- so it is
  // the one place the discipline has to hold. Without it: archive a
  // message, a push round fires mid-flight, `Email/get` returns the
  // pre-action state, and the row REAPPEARS in the inbox before vanishing
  // again on the next round.
  //
  // Filtering here rather than at each caller is deliberate: a future third
  // sync path would otherwise reintroduce the race silently, which is
  // exactly how this went unbuilt for the whole project (audit pass 2 F1).
  const writable = emails.filter((e) => !isPending(account, e.id));
  if (writable.length === 0) return;
  emails = writable;

  const upsert = db.prepare(`
    INSERT INTO emails
      (account, id, thread_id, received_at, subject, from_name, from_email,
       preview, is_unread, is_flagged, has_attachment, keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account, id) DO UPDATE SET
      thread_id      = excluded.thread_id,
      received_at    = excluded.received_at,
      subject        = excluded.subject,
      from_name      = excluded.from_name,
      from_email     = excluded.from_email,
      preview        = excluded.preview,
      is_unread      = excluded.is_unread,
      is_flagged     = excluded.is_flagged,
      has_attachment = excluded.has_attachment,
      keywords       = excluded.keywords
    -- body_text is deliberately absent from both the column list and this
    -- UPDATE SET. Adding it here silently deletes indexed bodies on every
    -- metadata refresh. See the module doc comment. Do not add it.
  `);

  const clearBoxes = db.prepare(`DELETE FROM email_mailboxes WHERE account = ? AND email_id = ?`);
  // received_at and thread_key are denormalized copies of the email's own
  // columns (migration 11) -- written here from the row already being
  // stored, never re-SELECTed, and never recomputed by a reader. Keep this
  // in lockstep with the `upsert` above: whatever fallback/derivation an
  // email's own row gets, its membership rows must get the same value or
  // `assertNoMembershipDrift` (mutations.test.ts) fails.
  const addBox = db.prepare(
    `INSERT OR IGNORE INTO email_mailboxes (account, email_id, mailbox_id, received_at, thread_key)
     VALUES (?, ?, ?, ?, ?)`,
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const e of emails) {
      // Keywords are stored whole -- Fastmail's own annotations ($notjunk,
      // $x-me-annot-2, ...) go beyond the standard set, and only $seen is
      // interpreted here. Discarding the rest would lose server state we
      // have no other record of.
      const kw = e.keywords ?? {};
      const from = e.from?.[0];
      const receivedAt = e.receivedAt ?? "1970-01-01T00:00:00Z";
      const threadKey = e.threadId ?? e.id;
      upsert.run(
        account,
        e.id,
        e.threadId ?? null,
        receivedAt,
        e.subject ?? "",
        from?.name ?? "",
        from?.email ?? "",
        e.preview ?? "",
        kw["$seen"] ? 0 : 1,
        kw["$flagged"] ? 1 : 0,
        e.hasAttachment ? 1 : 0,
        JSON.stringify(kw),
      );

      // Mailbox membership is REPLACED, not accumulated: the server's view is
      // authoritative, so clear this message's junction rows and re-insert.
      // received_at/threadKey are the exact values just written to `emails`
      // above, not re-read -- see the addBox comment.
      clearBoxes.run(account, e.id);
      for (const mailboxId of Object.keys(e.mailboxIds ?? {})) {
        addBox.run(account, e.id, mailboxId, receivedAt, threadKey);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Rewritten wholesale: the server's mailbox list is authoritative for one
 * account, so absence from it DELETES the local row. Scoped tightly to
 * `account` -- Fastmail's inbox id ("P-F") is shared across accounts, so an
 * unscoped delete would destroy another account's mailboxes.
 */
export function syncMailboxes(db: DatabaseSync, account: string, boxes: JmapMailbox[]): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`DELETE FROM mailboxes WHERE account = ?`).run(account);
    const ins = db.prepare(
      `INSERT INTO mailboxes (account, id, name, role, parent_id, sort_order, total_emails, unread_emails)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of boxes) {
      ins.run(
        account,
        b.id,
        b.name,
        b.role ?? null,
        b.parentId ?? null,
        b.sortOrder ?? 0,
        b.totalEmails ?? 0,
        b.unreadEmails ?? 0,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function setSyncState(db: DatabaseSync, account: string, kind: string, state: string): void {
  db.prepare(
    `INSERT INTO sync_state (account, kind, state, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account, kind) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  ).run(account, kind, state, new Date().toISOString());
}

/** Forget one sync-state entry, so its reader sees "never" rather than a
 *  stale value. Distinct from writing "0": `mailbox_at` treats "0" as a
 *  real timestamp (a test drives the clock from 0), so only ABSENCE makes
 *  the cadence check refresh at once. */
export function clearSyncState(db: DatabaseSync, account: string, kind: string): void {
  db.prepare(`DELETE FROM sync_state WHERE account = ? AND kind = ?`).run(account, kind);
}

export function getSyncState(db: DatabaseSync, account: string, kind: string): string | null {
  const row = db.prepare(`SELECT state FROM sync_state WHERE account = ? AND kind = ?`).get(
    account,
    kind,
  ) as { state: string } | undefined;
  return row?.state ?? null;
}

/** Liveness, stored in sync_state so it survives a restart. */
export function recordSync(db: DatabaseSync, account: string, atMs: number): void {
  setSyncState(db, account, "synced_at", String(atMs));
}

export function lastSyncAt(db: DatabaseSync, account: string): number | null {
  const raw = getSyncState(db, account, "synced_at");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ancillary-backfill failure counter (review fix, Important 1). The
 * supervisor deliberately does NOT let a details-backfill error (Via/
 * recipients/attachments) flip an account's overall sync state -- that
 * state is what /healthz reads as "is mail syncing", and details are
 * enrichment, not the sync itself. Without SOME durable signal, a
 * details-backfill error that recurs every pass produced one log line per
 * pass and nothing else -- easy to lose, and invisible to /healthz. This
 * makes it visible without changing what "ok" means. Stored in sync_state
 * (survives a restart) rather than an in-memory counter, same reasoning as
 * lastSyncAt above.
 */
export function recordDetailsFailure(db: DatabaseSync, account: string): number {
  const next = detailsFailureCount(db, account) + 1;
  setSyncState(db, account, "details_failures", String(next));
  return next;
}

/**
 * Called after a SUCCESSFUL backfillDetails pass (fix wave, finding 2).
 *
 * Without this, the counter above only ever went up: one transient failure
 * left a permanent non-zero forever, indistinguishable from an account
 * failing every single pass -- exactly the "permanently failing enrichment"
 * /healthz's detailsBackfillFailures exists to surface. Zeroing on success
 * makes the counter mean "consecutive failures since the last clean pass",
 * which is the question an operator actually has. (Alternative considered:
 * record a details_last_failure_at timestamp instead of zeroing, so recency
 * is visible without losing the historical count. Zeroing was chosen because
 * /healthz already treats this as a boolean-ish "is this stuck" signal, not
 * a historical log, and a monotonically increasing counter with no reset is
 * the more common bug shape to guard against here.)
 */
export function clearDetailsFailure(db: DatabaseSync, account: string): void {
  setSyncState(db, account, "details_failures", "0");
}

export function detailsFailureCount(db: DatabaseSync, account: string): number {
  const raw = getSyncState(db, account, "details_failures");
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The ONLY function that writes body_text. '' means "fetched, nothing there"
 * and is a deliberate, distinct value from NULL ("not yet fetched") -- that
 * distinction is what lets a backfill loop over unfetchedIds() terminate.
 */
export function writeBodyText(db: DatabaseSync, account: string, id: string, text: string): void {
  db.prepare(`UPDATE emails SET body_text = ? WHERE account = ? AND id = ?`).run(
    text,
    account,
    id,
  );
}

/**
 * Rows still awaiting a body backfill. Only body_text IS NULL counts --
 * '' (fetched, nothing there) must never come back, or the backfill loop
 * never terminates.
 */
export function unfetchedIds(db: DatabaseSync, account: string, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM emails
        WHERE account = ? AND body_text IS NULL
        ORDER BY received_at DESC
        LIMIT ?`,
    )
    .all(account, limit) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Operator escape hatch for sync_state('walk', 'done') -- a one-way door
 * that findings 1 and 2 showed is reachable through failure (a server-clamped
 * short page recording an incomplete archive as finished). Clearing it makes
 * the next walkArchive() call start over from the beginning rather than
 * short-circuiting on the 'done' sentinel.
 */
export function resetWalk(db: DatabaseSync, account: string): void {
  db.prepare(`DELETE FROM sync_state WHERE account = ? AND kind = 'walk'`).run(account);
}

/**
 * Clear the Email/changes cursor.
 *
 * Paired with resetWalk in the cannotCalculateChanges branch (C3). Clearing
 * the walk sentinel alone does NOT resync: walkArchive writes the cursor only
 * when there is none (corpus.ts), so a re-walk against a surviving expired
 * cursor leaves Email/changes throwing the same error forever while the pass
 * reports success on every cycle.
 */
export function resetEmailCursor(db: DatabaseSync, account: string): void {
  db.prepare(`DELETE FROM sync_state WHERE account = ? AND kind = 'email'`).run(account);
}

/**
 * Operator escape hatch for the OTHER one-way door: rows whose body_text was
 * poisoned to '' by finding 1's bug (or by any genuinely message-specific
 * fault worth re-trying) are otherwise invisible to unfetchedIds() forever.
 * Setting them back to NULL puts them back in front of the next
 * backfillBodies() pass. Returns the number of rows changed so an operator
 * (or the CLI wrapper) can report what happened.
 */
export function resetBodies(db: DatabaseSync, account: string): number {
  const result = db
    .prepare(`UPDATE emails SET body_text = NULL WHERE account = ? AND body_text = ''`)
    .run(account);
  return Number(result.changes);
}

/**
 * Remove messages the server reports as destroyed.
 *
 * Deletes from `emails` (which fires the FTS5 delete trigger, keeping the
 * external-content index in step) and from the `email_mailboxes` junction,
 * which has no foreign key and would otherwise accumulate orphans forever.
 */
export function removeEmails(db: DatabaseSync, account: string, ids: string[]): number {
  if (ids.length === 0) return 0;

  const delEmail = db.prepare(`DELETE FROM emails WHERE account = ? AND id = ?`);
  const delBoxes = db.prepare(`DELETE FROM email_mailboxes WHERE account = ? AND email_id = ?`);

  // One parameterised statement PER ID, so SQLITE_MAX_VARIABLE_NUMBER is
  // never approached and the chunk loop that used to wrap this (M3) never
  // did anything -- it sliced the list into 500s and then ran exactly the
  // same per-id statements.
  let removed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of ids) {
      delBoxes.run(account, id);
      removed += delEmail.run(account, id).changes as number;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return removed;
}

/**
 * Remote-image allowances, per sender per account (handoff v1.1 #2's
 * "Always from this sender").
 *
 * 🚨 The address is lowercased on the way in AND on the way out. Senders
 * vary the casing of their own From line between sends, and an allowance
 * the reader granted once must not stop applying because of it.
 */
export function allowSenderImages(db: DatabaseSync, account: string, sender: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sender_image_allow (account, sender, created_at) VALUES (?, ?, ?)`,
  ).run(account, sender.trim().toLowerCase(), new Date().toISOString());
}

export function senderImagesAllowed(db: DatabaseSync, account: string, sender: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sender_image_allow WHERE account = ? AND sender = ?`)
    .get(account, sender.trim().toLowerCase()) as { ok?: number } | undefined;
  return row?.ok === 1;
}

export function forgetSenderImages(db: DatabaseSync, account: string, sender: string): number {
  const res = db
    .prepare(`DELETE FROM sender_image_allow WHERE account = ? AND sender = ?`)
    .run(account, sender.trim().toLowerCase());
  return Number(res.changes);
}
