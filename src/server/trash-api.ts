import type { DatabaseSync } from "node:sqlite";
import type { JmapClient } from "../core/client.ts";
import { removeEmails } from "../core/mutations.ts";
import type { Router } from "./router.ts";
import { json } from "./router.ts";
import { authenticate, checkCsrf, hasScope } from "./auth.ts";

/**
 * The ONE route in this codebase that destroys mail: "Empty trash" (row
 * 37). Kept out of triage-api.ts on purpose -- test/triage.test.ts pins
 * that the triage path never contains `destroy`, because every triage
 * action is a MOVE the user can undo. Emptying Trash is not undoable and
 * says so in its confirm; this module exists so that invariant stays
 * true where it matters and the destructive action stays alone, refused
 * for anything but an account's own Trash folder.
 */
export interface TrashApiDeps {
  db: DatabaseSync;
  origin: string;
  clients: Map<string, JmapClient>;
  onChange?: (account: string) => void;
}

export function registerTrashRoutes(router: Router, deps: TrashApiDeps): void {
  /**
   * POST /api/mailboxes/:account/:id/empty -- "Empty trash" (row 37).
   * Refused for anything but the account's role=trash mailbox: this
   * DESTROYS mail on the server, and only Trash is where a person means
   * that. Only messages that are in Trash and NOWHERE ELSE go (a message
   * also filed elsewhere is not "in the trash" the way the banner means);
   * destroyed in chunks, then removed locally. Reports the count.
   */
  router.add("POST", "/api/mailboxes/:account/:id/empty", async (c) => {
    const principal = authenticate(deps.db, c.req);
    if (!principal) return json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return json(c.res, 403, { error: "forbidden" });
    if (!hasScope(principal, "write")) return json(c.res, 403, { error: "write scope required" });
    const account = c.params["account"] ?? "";
    const mailboxId = c.params["id"] ?? "";
    const box = deps.db.prepare(`SELECT role FROM mailboxes WHERE account = ? AND id = ?`).get(account, mailboxId) as { role: string | null } | undefined;
    if (!box) return json(c.res, 404, { error: "no such mailbox" });
    if (box.role !== "trash") return json(c.res, 400, { error: "only the Trash folder can be emptied" });
    const client = deps.clients.get(account);
    if (!client) return json(c.res, 503, { error: "account not connected" });

    const ids = (
      deps.db
        .prepare(
          `SELECT em.email_id AS id FROM email_mailboxes em
            WHERE em.account = ? AND em.mailbox_id = ?
              AND NOT EXISTS (SELECT 1 FROM email_mailboxes o WHERE o.account = em.account AND o.email_id = em.email_id AND o.mailbox_id <> em.mailbox_id)`,
        )
        .all(account, mailboxId) as { id: string }[]
    ).map((r) => r.id);
    let destroyed = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const responses = await client.request([
        ["Email/set", { accountId: client.session.mailAccountId, destroy: chunk }, "e0"],
      ]);
      const done = ((responses[0]?.[1] as { destroyed?: string[] } | undefined)?.destroyed ?? []).filter((x): x is string => typeof x === "string");
      // A message the server no longer has is gone either way.
      const notFound = Object.keys((responses[0]?.[1] as { notDestroyed?: Record<string, { type?: string }> } | undefined)?.notDestroyed ?? {}).filter(
        (id) => ((responses[0]![1] as { notDestroyed: Record<string, { type?: string }> }).notDestroyed[id]?.type === "notFound"),
      );
      const gone = [...done, ...notFound];
      removeEmails(deps.db, account, gone);
      destroyed += done.length;
    }
    deps.onChange?.(account);
    json(c.res, 200, { destroyed, considered: ids.length });
  });

}
