import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";

/**
 * The invariant migration 11 exists to serve: every `email_mailboxes` row's
 * denormalized `received_at`/`thread_key` must equal its email's own
 * `received_at` and `COALESCE(thread_id, id)`. Shared by mutations.test.ts
 * and triage.test.ts -- both write membership rows and both must prove they
 * never drift.
 */
export function assertNoMembershipDrift(db: DatabaseSync): void {
  const bad = db.prepare(
    `SELECT m.account, m.email_id, m.mailbox_id
       FROM email_mailboxes m JOIN emails e ON e.account = m.account AND e.id = m.email_id
      WHERE m.received_at IS NOT e.received_at OR m.thread_key IS NOT COALESCE(e.thread_id, e.id)`,
  ).all();
  assert.deepEqual(bad, [], "email_mailboxes drifted from emails");
}
