/**
 * Standalone fixture, run as a CHILD PROCESS by test/backfill.test.ts, for
 * finding 7: the progress guard used to compare only (count, before[0]).
 *
 * This simulates the exact gap that comparison left: the write path is
 * broken (body_text never actually persists, same as the sibling
 * backfill-progress-guard.ts fixture), but unfetchedIds()'s underlying
 * SELECT -- ORDER BY received_at DESC, with no secondary tiebreaker -- comes
 * back in a DIFFERENT row order on alternating calls even though it is the
 * exact same SET of ids both times. A first-id-only comparison sees a
 * different id in front and concludes "progress was made", so the loop never
 * trips the guard and spins forever. The full-set comparison (finding 7's
 * fix) is not fooled by order and still throws.
 *
 * Same exit contract as backfill-progress-guard.ts: prints "REJECTED: <msg>"
 * and exits 1 if backfillBodies rejects (expected with the fix); exits 0
 * printing "RESOLVED" if it somehow resolves; otherwise runs forever until
 * the parent's execFileSync `timeout` SIGTERMs it -- which is exactly what
 * happens against the pre-finding-7 comparison.
 */

import { openDb } from "../../src/core/db.ts";
import { storeEmails } from "../../src/core/mutations.ts";
import { backfillBodies } from "../../src/core/corpus.ts";
import { JmapClient } from "../../src/core/client.ts";
import { resolveSession } from "../../src/core/session.ts";
import { personalSession } from "./session.ts";
import { tempDbPath } from "../tmpdir.ts";

const session = resolveSession("personal", personalSession);

const d = openDb(tempDbPath());
storeEmails(
  d,
  "personal",
  ["a", "b", "c"].map((id) => ({
    id,
    receivedAt: "2026-01-01T00:00:00Z", // tied -- ORDER BY alone gives no stable secondary order
    subject: `S ${id}`,
    keywords: {},
    mailboxIds: { "P-Arc": true },
    from: [{ email: "ada@example.com" }],
  })),
);

let unfetchedCall = 0;

// Every write becomes a no-op (broken write path, as in the sibling
// fixture), AND unfetchedIds()'s own SELECT alternates row order on every
// call -- same set, different first element.
const brokenDb = new Proxy(d, {
  get(target, prop, receiver) {
    if (prop === "prepare") {
      return (sql: string) => {
        if (typeof sql === "string" && sql.includes("UPDATE emails SET body_text")) {
          return { run: () => undefined };
        }
        if (typeof sql === "string" && sql.includes("SELECT id FROM emails")) {
          const real = Reflect.get(target, "prepare").call(target, sql) as {
            all: (...args: unknown[]) => unknown[];
          };
          return {
            all: (...args: unknown[]) => {
              unfetchedCall += 1;
              const rows = real.all(...args) as { id: string }[];
              return unfetchedCall % 2 === 0 ? [...rows].reverse() : rows;
            },
          };
        }
        return Reflect.get(target, "prepare").call(target, sql);
      };
    }
    return Reflect.get(target, prop, receiver);
  },
});

const client = new JmapClient(session, "t", async (_url, init) => {
  const body = JSON.parse((init as RequestInit).body as string);
  const ids = body.methodCalls[0][1].ids as string[];
  const list = ids.map((id) => ({
    id,
    textBody: [{ partId: "1" }],
    bodyValues: { "1": { value: "hello" } },
  }));
  return new Response(
    JSON.stringify({ methodResponses: [["Email/get", { list }, "c0"]] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});

try {
  await backfillBodies(brokenDb as unknown as typeof d, client, "personal", { batchSize: 50, paceMs: 0 });
  console.log("RESOLVED");
  process.exit(0);
} catch (err) {
  console.log(`REJECTED: ${(err as Error).message}`);
  process.exit(1);
}
