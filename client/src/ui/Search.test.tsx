// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";
import type { EmailRow, ListResult } from "../lib/api";
import { advance, byTestId, fakeApi, render, tick, type } from "../test-utils";
import { Search } from "./Search";

function rows(n: number, start = 0): Partial<EmailRow>[] {
  return Array.from({ length: n }, (_, i) => ({
    account: "personal",
    id: `M${start + i}`,
    subject: `Result ${start + i}`,
  }));
}

// A full EmailRow, for the one test below that bypasses fakeApi's
// canned-data `search` shortcut (buildEmailRow's defaults) because it
// needs to control resolution order itself -- the shortcut always
// resolves immediately.
function emailRow(overrides: Partial<EmailRow> = {}): EmailRow {
  return {
    account: "personal",
    id: "M1",
    threadId: null,
    receivedAt: "2026-01-01T00:00:00.000Z",
    subject: "Subject",
    fromName: "Someone",
    fromEmail: "someone@example.test",
    preview: "",
    isUnread: false,
    isFlagged: false,
    hasAttachment: false,
    snippet: null,
    via: null,
    ...overrides,
  };
}

// F5/F6 (design-fidelity Pass D, 2026-09-04): the design's own `listMeta`
// 🚨 Checklist row 18 (2026-09-06). The count is the SERVER's total, and the
// results page on scroll -- the previous version of this test pinned "the
// count of rows actually rendered" because "there is no load more
// affordance for search results", which described the defect as a design:
// search said "200 results" against 2,917 matches and the other 2,717 were
// unreachable.
test("the count is the server's total, and scrolling to the bottom pages the results without duplicates", async () => {
  const calls: { q: string; cursor?: string | null }[] = [];
  const api = fakeApi({
    search: (q: string, opts?: { cursor?: string | null }) => {
      calls.push({ q, cursor: opts?.cursor });
      const page = opts?.cursor === "c1" ? { rows: rows(50, 200) as EmailRow[], total: 250, cursor: null, truncated: false }
                                        : { rows: rows(200) as EmailRow[], total: 250, cursor: "c1", truncated: true };
      return Promise.resolve(page);
    },
  });
  const { container } = render(<Search api={api} />);
  // The scroll parent is the ancestor pane in the app, and it is scrollable
  // BEFORE any result exists; happy-dom runs no layout, so give the
  // ancestor the overflow up front and insist the component found it (the
  // same lesson as MessageList's paging).
  const host = container as HTMLElement;
  host.style.overflowY = "auto";
  Object.defineProperty(host, "scrollHeight", { value: 10_000, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 900, configurable: true });

  type(byTestId("search"), "budget");
  await advance(250);
  assert.equal(byTestId("count").textContent, "250 results", "the header must say the server's total, not the page length");
  assert.equal(container.querySelectorAll('[data-testid^="search-row-"]').length, 200);

  host.scrollTop = 9_500;
  host.dispatchEvent(new Event("scroll"));
  await advance(50);
  assert.deepEqual(calls.map((c) => c.cursor ?? null), [null, "c1"], "reaching the bottom must fetch the next page with the cursor");
  const keys = Array.from(container.querySelectorAll('[data-testid^="search-row-"]')).map((e) => e.getAttribute("data-testid"));
  assert.equal(keys.length, 250, "the second page was not appended");
  assert.equal(new Set(keys).size, 250, "paging duplicated rows");
  assert.equal(byTestId("count").textContent, "250 results");
  assert.equal(byTestId("search-load-more", { optional: true }), null, "no more pages, so no Load more");
});

test("a singular result is worded '1 result', not '1 results'", async () => {
  const api = fakeApi({ search: { rows: rows(1), total: 1, cursor: null, truncated: false } });
  render(<Search api={api} />);
  type(byTestId("search"), "budget");
  await advance(250);
  assert.equal(byTestId("count").textContent, "1 result");
});

test("SEARCHING IS DEBOUNCED AND SUPERSEDED REQUESTS ARE CANCELLED", async () => {
  // The count half of every search cannot short-circuit, so a request per
  // keystroke is the expensive half repeated for the narrow queries users
  // type while still refining.
  const api = fakeApi();
  render(<Search api={api} />);
  for (const s of ["b", "bu", "bud", "budg", "budge", "budget"]) type(byTestId("search"), s);
  await advance(250);
  assert.equal(api.searchCalls.length, 1, `debounce failed: ${api.searchCalls.length} calls`);
  assert.equal(api.searchCalls[0], "budget");
});

test("matches are highlighted as segments, and a hostile subject stays text", async () => {
  const api = fakeApi({
    search: { rows: [{ account: "personal", id: "M1", subject: "<script>budget</script>" }], total: 1 },
  });
  render(<Search api={api} />);
  type(byTestId("search"), "budget");
  await advance(250);
  assert.equal(document.querySelectorAll("script").length, 0);
  assert.equal(byTestId("hit-0").textContent, "budget", "the matched substring is marked");
});

test("an empty search box shows the folder, not an empty result set", async () => {
  const api = fakeApi();
  render(<Search api={api} />);
  type(byTestId("search"), "budget");
  await advance(250);
  type(byTestId("search"), "");
  await advance(250);
  assert.equal(byTestId("search-active", { optional: true }), null);
});

test("the operator set matches CLIENT_OPERATORS: recognised prefixes render as chips", async () => {
  const api = fakeApi({ search: { rows: [], total: 0 } });
  render(<Search api={api} />);
  type(byTestId("search"), "from:robin note:x budget");
  await advance(250);
  assert.ok(byTestId("search-chip-from"));
  assert.equal(api.searchCalls[0], "from:robin note:x budget", "the FULL string still goes to the server");
});

test("a stale response cannot overwrite a newer query's results (generation guard)", async () => {
  // fakeApi's canned-data `search` shortcut always resolves immediately,
  // which can't exercise out-of-order arrival -- this test hand-rolls a
  // `search` override that hands back a promise it holds the resolver
  // for, so resolution order is fully under the test's control.
  const resolvers: Record<string, (r: ListResult<EmailRow>) => void> = {};
  const api = fakeApi({
    search: (q: string) =>
      new Promise<ListResult<EmailRow>>((resolve) => {
        resolvers[q] = resolve;
      }),
  });
  render(<Search api={api} />);

  type(byTestId("search"), "alpha");
  await advance(250); // debounce fires: api.search("alpha") issued, unresolved
  type(byTestId("search"), "beta");
  await advance(250); // debounce fires: api.search("beta") issued, unresolved

  // Resolve the NEWER query first, then the STALE one -- exactly the
  // out-of-order arrival a generation guard exists to survive.
  resolvers["beta"]!({
    rows: [emailRow({ id: "B1", subject: "beta result" })],
    total: 1,
    cursor: null,
    truncated: false,
  });
  await tick();

  resolvers["alpha"]!({
    rows: [emailRow({ id: "A1", subject: "alpha result" })],
    total: 1,
    cursor: null,
    truncated: false,
  });
  await tick();

  assert.ok(byTestId("search-row-personal-B1"), "the newer query's row is shown");
  assert.equal(
    byTestId("search-row-personal-A1", { optional: true }),
    null,
    "the STALE response must not overwrite the newer query's rows",
  );
});
