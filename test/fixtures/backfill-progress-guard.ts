/**
 * Standalone fixture, run as a CHILD PROCESS (not imported) by
 * test/backfill.test.ts, so an external OS-level timeout can kill it if the
 * progress guard is ever removed from backfillBodies.
 *
 * Why a subprocess and not an in-process `Promise.race` timeout: the loop
 * this exercises is all-microtask (mock fetch resolves without any real I/O
 * or macrotask), so it can starve Node's timer phase and a `setTimeout`-based
 * race is not guaranteed to ever fire. Only an external process kill is.
 *
 * Wraps `db` in a Proxy whose `prepare()` intercepts the UPDATE
 * `writeBodyText` issues and makes it a no-op -- i.e. simulates exactly the
 * regression the guard exists to catch: the write path silently stops
 * persisting body_text, so unfetchedIds() returns the same rows forever.
 *
 * Prints "REJECTED: <message>" and exits 1 if backfillBodies rejects (the
 * expected, correct behaviour with the guard in place); exits 0 printing
 * "RESOLVED" if it somehow resolves; otherwise runs forever, until the
 * parent's execFileSync `timeout` SIGTERMs it.
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
    receivedAt: "2026-01-01T00:00:00Z",
    subject: `S ${id}`,
    keywords: {},
    mailboxIds: { "P-Arc": true },
    from: [{ email: "ada@example.com" }],
  })),
);

// Every UPDATE ... SET body_text ... becomes a no-op: the write path silently
// fails to persist, exactly the regression the progress guard defends against.
const brokenDb = new Proxy(d, {
  get(target, prop, receiver) {
    if (prop === "prepare") {
      return (sql: string) => {
        if (typeof sql === "string" && sql.includes("UPDATE emails SET body_text")) {
          return { run: () => undefined };
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
