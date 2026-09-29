/**
 * A performance budget for the list read path, run as its own gate phase
 * (`npm run bench`, wired into `deploy.sh` as `== performance budget ==`).
 * Deliberately NOT under `test/*.test.ts` -- building a 200k-message corpus
 * costs real time (see the log line this file prints), and `npm test` has
 * to stay fast.
 *
 * Why this file exists at all: the history of list.ts says it outright -- an O(mailbox) read path shipped once,
 * sat unnoticed at 38k messages for months, and only surfaced at 167k
 * because "nothing measured it, correctness was the only thing under test."
 * A budget nobody has seen fail (step 4 below) is a budget nobody should
 * trust, so this file also proves its own teeth against the exact statement
 * that regressed, recovered from git history and never re-added to `src/`.
 *
 * Two kinds of assertion, deliberately both required:
 *
 *   - A wall-clock BUDGET, generous enough not to flake on a loaded box.
 *     This is what an operator feels.
 *   - A QUERY PLAN assertion: `EXPLAIN QUERY PLAN` must show no `SCAN
 *     emails` or `SCAN email_mailboxes` and no `USE TEMP B-TREE` for any
 *     statement the operation issues. This is what does not flake -- a fast
 *     box can make a bad
 *     plan meet a generous budget, but a table scan is a table scan
 *     regardless of clock speed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { tempDbPath } from "../tmpdir.ts";
import { openDb } from "../../src/core/db.ts";
import { buildCorpusAt, DEFAULT_CORPUS_SIZE } from "./corpus.ts";
import { listConversations, type ListFilter } from "../../src/core/list.ts";
import { listMailboxes } from "../../src/core/queries.ts";

// Overridable so a full CI run and a quick local sanity check don't have to
// pay the same corpus-build cost. See the report for how long 200k takes.
const N = Number(process.env["WILCO_BENCH_N"] ?? DEFAULT_CORPUS_SIZE);
const RUNS = Number(process.env["WILCO_BENCH_RUNS"] ?? 7);

/**
 * Budgets, per operation, at N=200,000.
 *
 * Observed (this box, 2026-09-22, median of 7 runs, N=200,000, corpus build
 * ~11s): first page of the largest folder 4.2ms, page 2 via cursor 4.1ms,
 * first page of a small folder 0.5ms, unified role across three accounts
 * 2.7ms, listMailboxes 24.8ms. All comfortably under the brief's starting
 * points (150ms / 100ms) -- the budgets are kept at the brief's numbers
 * rather than tightened to the observed figures, because the point of a
 * budget is catching a RETURN to O(mailbox)/O(folder), not chasing the
 * fastest possible box: a 200,000-message O(page) read costing single-digit
 * milliseconds and a collapse-then-page read costing hundreds of
 * milliseconds to whole seconds (see the regression proof below, 209ms at
 * this same N -- already over budget, and the live 167k archive's real
 * regression was 57.8 SECONDS) are separated by well over an order of
 * magnitude even at this modest N, and the gap only widens with more mail.
 * 150ms/100ms is still an enormous, deliberate margin above what a healthy
 * read path costs and nowhere near what a regressed one does.
 */
const BUDGET_PAGE_MS = 150;
const BUDGET_MAILBOXES_MS = 100;

console.error(`== performance budget == building a ${N}-message corpus (this can take a while)...`);
const buildStart = performance.now();
const { db, info } = buildCorpusAt(tempDbPath("bench"), { n: N });
const buildSeconds = (performance.now() - buildStart) / 1000;
console.error(
  `== performance budget == corpus ready in ${buildSeconds.toFixed(1)}s: ${info.n} messages, ` +
    `${info.threads} threads, largest thread ${info.maxThreadSize} messages`,
);

function medianMs(fn: () => void, runs = RUNS): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

/**
 * Captures the SQL text of every statement `fn` prepares against `d` --
 * same Proxy-on-`prepare` shape as `test/list.test.ts`'s `counting()`
 * helper, reused rather than reinvented because that file already
 * established this is how to observe list.ts's private SQL without
 * exporting it.
 */
function capturedStatements(d: DatabaseSync, fn: (proxied: DatabaseSync) => void): Set<string> {
  const seen = new Set<string>();
  const real = d.prepare.bind(d);
  const proxy = new Proxy(d, {
    get(t: DatabaseSync, k: string | symbol): unknown {
      if (k !== "prepare") {
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      }
      return (sql: string) => {
        seen.add(sql);
        return real(sql);
      };
    },
  });
  fn(proxy as unknown as DatabaseSync);
  return seen;
}

/**
 * Runs `EXPLAIN QUERY PLAN` on every captured SELECT that touches `emails`
 * or `email_mailboxes` and returns any plan line that scans one of those
 * tables directly or falls back to a temp b-tree. No bound parameter VALUES
 * are needed -- SQLite's planner decides the plan shape from the statement
 * and the schema/indexes/stats, not from what a `?` happens to be bound to
 * at run time.
 *
 * Scoped to statements that touch the two tables whose row count scales
 * with the corpus, deliberately: `listMailboxes` also runs a plain
 * `SELECT ... FROM mailboxes ... ORDER BY sort_order, name, id`, which
 * genuinely costs a temp b-tree on this box (there is no index on that sort
 * order) -- but it sorts a handful of rows PER ACCOUNT, not per message, so
 * it cannot be the O(mailbox)/O(folder) failure mode this file exists to
 * catch, and a `mailboxes`-only statement is by construction unable to be
 * one: it never reads a table whose size depends on message count at all.
 */
function planOffenders(d: DatabaseSync, statements: Set<string>): string[] {
  const offenders: string[] = [];
  for (const sql of statements) {
    if (!/^\s*SELECT/i.test(sql)) continue; // storeEmails/writeDetails writes never run here, but be explicit
    if (!/\bemails\b/i.test(sql) && !/\bemail_mailboxes\b/i.test(sql)) continue;
    const rows = d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as { detail: string }[];
    const detail = rows.map((r) => r.detail).join(" | ");
    // A statement DRIVEN by the partial unread index reads only unread
    // messages, so its GROUP BY sorter is bounded by the unread count --
    // the number in the sidebar badge -- and not by the folder. That is the
    // whole point of `emails_unread` (schema 12); flagging its sorter would
    // forbid the fix. Everything else is judged as before.
    const drivenByUnreadIndex = /\bemails_unread\b/.test(detail);
    for (const row of rows) {
      const scans = /SCAN\s+(TABLE\s+)?(emails|email_mailboxes)\b/i.test(row.detail);
      const sorts = /USE TEMP B-TREE/i.test(row.detail) && !drivenByUnreadIndex;
      if (scans || sorts) {
        offenders.push(`${row.detail}   <=   ${sql.replace(/\s+/g, " ").trim()}`);
      }
    }
  }
  return offenders;
}

function assertBudget(name: string, ms: number, budgetMs: number): void {
  assert.ok(ms <= budgetMs, `${name}: took ${ms.toFixed(2)}ms, budget is ${budgetMs}ms`);
}

function assertPlan(name: string, offenders: string[]): void {
  assert.deepEqual(offenders, [], `${name}: bad query plan --\n${offenders.join("\n")}`);
}

const bigAccount = info.accounts[0]!;
const bigFilter: ListFilter = {
  account: bigAccount,
  mailbox: info.archiveId,
  role: null,
  unread: null,
  flagged: null,
  cursor: null,
  limit: 50,
};

test("bench: first page of the largest folder is O(page), not O(folder)", () => {
  const statements = capturedStatements(db, (proxied) => void listConversations(proxied, bigFilter));
  const ms = medianMs(() => void listConversations(db, bigFilter));
  assertPlan("largest folder, page 1", planOffenders(db, statements));
  assertBudget("largest folder, page 1", ms, BUDGET_PAGE_MS);
});

test("bench: page 2 via cursor costs the same as page 1", () => {
  const page1 = listConversations(db, bigFilter);
  assert.notEqual(page1.cursor, null, "the largest folder must span more than one page at this corpus size");
  const page2Filter: ListFilter = { ...bigFilter, cursor: page1.cursor };

  const statements = capturedStatements(db, (proxied) => void listConversations(proxied, page2Filter));
  const ms = medianMs(() => void listConversations(db, page2Filter));
  assertPlan("largest folder, page 2", planOffenders(db, statements));
  assertBudget("largest folder, page 2", ms, BUDGET_PAGE_MS);
});

const smallFilter: ListFilter = {
  account: info.smallAccount,
  mailbox: info.smallId,
  role: null,
  unread: null,
  flagged: null,
  cursor: null,
  limit: 50,
};

test("bench: first page of a small folder", () => {
  const statements = capturedStatements(db, (proxied) => void listConversations(proxied, smallFilter));
  const ms = medianMs(() => void listConversations(db, smallFilter));
  assertPlan("small folder, page 1", planOffenders(db, statements));
  assertBudget("small folder, page 1", ms, BUDGET_PAGE_MS);
});

const unifiedFilter: ListFilter = {
  account: null,
  mailbox: null,
  role: "inbox",
  unread: null,
  flagged: null,
  cursor: null,
  limit: 50,
};

test("bench: the unified inbox role across all accounts", () => {
  const statements = capturedStatements(db, (proxied) => void listConversations(proxied, unifiedFilter));
  const ms = medianMs(() => void listConversations(db, unifiedFilter));
  assertPlan("unified inbox", planOffenders(db, statements));
  assertBudget("unified inbox", ms, BUDGET_PAGE_MS);
});

/**
 * 🚨 The sidebar's own rule, and it is a PLAN rule because a time budget
 * cannot see this one.
 *
 * `listMailboxes` used to take both per-folder numbers from one grouped
 * statement that joined `emails` for `sum(is_unread)`, looking up every
 * membership row's email by primary key. That cost 491ms on the live
 * 167k-message instance -- and 25ms here at a LARGER corpus, because these
 * synthetic rows are thin while a real `emails` row carries `body_text` and
 * the lookups walk a table hundreds of megabytes wide. No budget this side
 * of a millisecond would have caught it, so the guard is the shape instead:
 * the counts may read `emails` only through the partial `emails_unread`
 * index (schema 12), which holds unread messages alone.
 *
 * 🚨 Judged PER PLAN STEP, not "does the index appear somewhere". The
 * planner's choice of driving table for the unread count flips with the
 * data: below roughly 10% unread it drives from `emails_unread` and probes
 * membership, and at around half unread it drives from membership and
 * probes `emails_unread`. BOTH are acceptable and the rule passes both,
 * because what makes the old statement ruinous is not which side drives but
 * that it reached `emails` ROWS through the primary key -- a wide table,
 * paged off disk once per membership row. Measured at 170,000 messages with
 * 1.2KB bodies: 0.1ms at 0.1% unread, 128ms at 50% unread, against 491ms
 * for the pre-schema-12 statement on the live archive at 0.1% unread.
 * `INDEXED BY emails_unread` was measured too and is NOT worth taking: at
 * 50% unread it made no difference (129.8ms against 128.1ms), because that
 * cost is proportional to the number of unread messages, which is the
 * question being asked.
 */
function mailboxCountOffenders(d: DatabaseSync, statements: Set<string>): string[] {
  const offenders: string[] = [];
  for (const sql of statements) {
    if (!/^\s*SELECT/i.test(sql)) continue;
    if (!/\bemails\b/i.test(sql)) continue; // a membership-only count is fine by construction
    const rows = (d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as { detail: string }[]).map((r) => r.detail);
    for (const detail of rows) {
      // Only steps that touch `emails` are judged; the membership side is
      // covered by planOffenders' own rules.
      if (!/\b(emails|sqlite_autoindex_emails_1)\b/.test(detail)) continue;
      if (/\bemails_unread\b/.test(detail)) continue; // the narrow, covering path: allowed
      offenders.push(`${detail}   <=   ${sql.replace(/\s+/g, " ").trim()}`);
    }
  }
  return offenders;
}

test("bench: listMailboxes for one account", () => {
  const statements = capturedStatements(db, (proxied) => void listMailboxes(proxied, bigAccount));
  const ms = medianMs(() => void listMailboxes(db, bigAccount));
  assertPlan("listMailboxes", planOffenders(db, statements));
  assertPlan("listMailboxes counts", mailboxCountOffenders(db, statements));
  assertBudget("listMailboxes", ms, BUDGET_MAILBOXES_MS);
});

test("bench: the sidebar's plan rule holds when the planner FLIPS the driving table", () => {
  // The planner's choice depends on how much of the account is unread, and
  // the bench corpus is deliberately mostly-read. This builds the other
  // extreme in a small database of its own and re-runs the same rule, so the
  // guard is known to accept the flipped shape rather than merely never
  // having met it. Small on purpose: the assertion is about the PLAN, which
  // the planner decides from the schema and statistics, not from row count.
  const d = openDb(tempDbPath("bench-unread"));
  d.exec("BEGIN");
  const ie = d.prepare(
    `INSERT INTO emails (account,id,received_at,subject,keywords,is_unread,is_flagged) VALUES ('a',?,?,'s','{}',?,0)`,
  );
  const im = d.prepare(
    `INSERT INTO email_mailboxes (account,email_id,mailbox_id,received_at,thread_key) VALUES ('a',?,?,?,?)`,
  );
  for (let i = 0; i < 4000; i += 1) {
    const at = new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString();
    ie.run(`m${i}`, at, 1); // every message unread: the far end of the range
    im.run(`m${i}`, `F${i % 60}`, at, `m${i}`);
  }
  d.exec("COMMIT");
  d.exec("ANALYZE");

  const statements = capturedStatements(d, (proxied) => void listMailboxes(proxied, "a"));
  assertPlan("listMailboxes counts (all unread)", mailboxCountOffenders(d, statements));
  d.close();
});

test("bench: the sidebar's plan rule rejects the statement it replaced", () => {
  // The shipped code before schema 12, verbatim. It must fail the rule
  // above -- otherwise that rule is decoration, and this whole file's
  // premise is that a plan check is what guards a read whose real cost
  // lives in row WIDTH rather than row count.
  const oldCombined = `SELECT m.mailbox_id AS mailboxId,
              count(*) AS total,
              sum(e.is_unread) AS unread
         FROM email_mailboxes m
         JOIN emails e ON e.account = m.account AND e.id = m.email_id
        WHERE m.account = ?
        GROUP BY m.mailbox_id`;
  const offenders = mailboxCountOffenders(db, new Set([oldCombined]));
  assert.ok(
    offenders.length > 0,
    "the pre-schema-12 sidebar statement passed the plan rule meant to reject it",
  );
});

// ---------------------------------------------------------------------------
// Step 4: prove the harness has teeth. This is the OLD collapsing statement
// -- one 60-line SELECT that grouped the entire `emails` table (twice),
// LEFT JOINed the entire `email_attachments` table, and ranked the whole
// filtered set with three window functions PLUS a ROW_NUMBER(), all before
// taking 50 rows -- recovered verbatim (the SQL only; nothing here is wired
// back into src/) from commit d9ece09's parent revision of
// src/server/read-api.ts's `listMessages`, the version that cost 57.8
// seconds on the live archive per commit 04187bb. It is reproduced here,
// fixed to exactly the "largest folder, page 1" case above, ONLY so this
// file can assert that both kinds of check this benchmark relies on --
// the budget and the query plan -- actually fail against it. If this test
// ever went green, the harness above would have stopped meaning anything.
// ---------------------------------------------------------------------------

const NON_FILE_TYPES_SQL = "'text/x-amp-html', 'text/x-watch-html'";

function oldCollapsingListSql(threadKeyExpr: string): string {
  return `
    SELECT e.account, e.id, e.thread_id, e.received_at, e.subject,
           e.from_name, e.from_email, e.preview, e.via,
           MAX(e.is_unread)      OVER (PARTITION BY ${threadKeyExpr}) AS is_unread,
           MAX(e.is_flagged)     OVER (PARTITION BY ${threadKeyExpr}) AS is_flagged,
           MAX(CASE WHEN att.email_id IS NULL THEN 0 ELSE 1 END)
                                 OVER (PARTITION BY ${threadKeyExpr}) AS has_attachment,
           tc.n AS thread_count,
           ROW_NUMBER()          OVER (PARTITION BY ${threadKeyExpr}
                                       ORDER BY e.received_at DESC, e.id DESC) AS rn
      FROM emails e
      JOIN (SELECT account, COALESCE(thread_id, id) AS k, COUNT(*) AS n
              FROM emails GROUP BY account, COALESCE(thread_id, id)) tc
        ON tc.account = e.account AND tc.k = COALESCE(e.thread_id, e.id)
      LEFT JOIN (SELECT DISTINCT account, email_id FROM email_attachments
                  WHERE cid IS NULL AND type NOT IN (${NON_FILE_TYPES_SQL})) att
        ON att.account = e.account AND att.email_id = e.id
      WHERE e.account = ?
        AND EXISTS (SELECT 1 FROM email_mailboxes em
                     WHERE em.account = e.account AND em.email_id = e.id AND em.mailbox_id = ?)`;
}

function oldListLargestFolderFirstPage(d: DatabaseSync): { rows: unknown[]; sql: string } {
  const threadKeyExpr = "e.account, COALESCE(e.thread_id, e.id)";
  const collapsed = oldCollapsingListSql(threadKeyExpr);
  const sql = `
    SELECT account, id, thread_id, received_at, subject, from_name, from_email,
           preview, is_unread, is_flagged, has_attachment, via, thread_count
      FROM (${collapsed})
     WHERE rn = 1
     ORDER BY received_at DESC, account, id
     LIMIT ?`;
  const rows = d.prepare(sql).all(bigAccount, info.archiveId, 51) as unknown[];
  return { rows, sql };
}

test("bench: the regression proof -- the old collapsing statement fails BOTH checks at 200k", () => {
  const statements = capturedStatements(db, (proxied) => void oldListLargestFolderFirstPage(proxied));
  const ms = medianMs(() => void oldListLargestFolderFirstPage(db), 3); // 3 runs: it is genuinely slow
  const offenders = planOffenders(db, statements);

  console.error(
    `== performance budget == regression proof: old statement took ${ms.toFixed(1)}ms ` +
      `(budget ${BUDGET_PAGE_MS}ms) with ${offenders.length} bad plan line(s)`,
  );

  assert.ok(
    ms > BUDGET_PAGE_MS,
    `expected the old collapsing statement to BLOW the ${BUDGET_PAGE_MS}ms budget at N=${N}, ` +
      `but it took only ${ms.toFixed(2)}ms -- the budget itself may be too loose to catch a regression`,
  );
  assert.ok(
    offenders.length > 0,
    "expected the old collapsing statement's plan to show a table scan or a temp b-tree, but it did not -- " +
      "the plan assertion would not have caught this regression",
  );
});
