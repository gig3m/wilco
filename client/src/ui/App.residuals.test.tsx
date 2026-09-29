// @vitest-environment happy-dom
//
// Covers the fix-wave behaviors that shipped in f880b82 with zero tests of
// their own (the residuals report's item 2): the 401-vs-other split of
// `handleApiError`, cursor "load more" pagination, `activeRows` following
// search results while a search is active and folder rows otherwise,
// Sidebar's folder navigation and theme toggle actually doing something,
// and this pass's own push-subscription wiring (item 1).
import { test } from "vitest";
import assert from "node:assert/strict";
import { ApiError, DEFAULT_PREFERENCES, type EmailRow, type Preferences } from "../lib/api";
import { advance, byTestId, click, fakeApi, fakeHistory, render, tick, type } from "../test-utils";
import { App } from "./App";

function row(overrides: Partial<EmailRow> = {}): EmailRow {
  return {
    account: "personal",
    id: "M1",
    threadId: null,
    receivedAt: "2026-09-03T00:00:00.000Z",
    subject: "Hello",
    fromName: "Someone",
    fromEmail: "someone@example.test",
    preview: "preview text",
    isUnread: false,
    isFlagged: false,
    hasAttachment: false,
    snippet: null,
    via: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleApiError's split: 401 -> Login gate, anything else -> banner, app
// stays mounted.
// ---------------------------------------------------------------------------

// Every test in this file unmounts its App before returning -- the push
// subscription added in this pass (item 1) means EVERY mounted App now
// opens an EventSource whose reconnect loop otherwise keeps running (real
// `setTimeout` backoff) after the test that mounted it has finished,
// which would pollute `FakeEventSource.instances` in the push tests below
// with leftover connections from earlier, unrelated tests in this file.

test("a 401 from any api call shows the full-screen login gate", async () => {
  const { unmount } = render(
    <App
      api={fakeApi({
        messages: () => Promise.reject(new ApiError(401, "session gone")),
      })}
    />,
  );
  await tick();
  assert.ok(byTestId("login-gate"), "a dead session must gate the whole app");
  unmount();
});

test("a non-401 api failure shows the dismissible banner and does NOT blank the app", async () => {
  const { unmount } = render(
    <App
      api={fakeApi({
        messages: () => Promise.reject(new ApiError(500, "server exploded")),
      })}
    />,
  );
  await tick();
  assert.equal(byTestId("login-gate", { optional: true }), null, "a non-401 must not gate the app");
  assert.match(byTestId("error-banner").textContent!, /server exploded/);
  // The shell is still mounted underneath the banner -- e.g. the sidebar.
  assert.ok(byTestId("sidebar"));

  click(byTestId("error-banner-dismiss"));
  await tick();
  assert.equal(byTestId("error-banner", { optional: true }), null, "dismiss removes the banner");
  unmount();
});

// ---------------------------------------------------------------------------
// Cursor pagination: "load more" appends the next page and the header
// total stays the API's real total, not the accumulated page length.
// ---------------------------------------------------------------------------

test("load more appends the next page and keeps the header total as the server's total", async () => {
  const api = fakeApi({
    messages: (filters) => {
      const f = filters as { cursor?: string };
      if (f.cursor === undefined) {
        return Promise.resolve({
          rows: Array.from({ length: 12 }, (_, i) => row({ id: `M${i}`, subject: `First page ${i}` })),
          total: 40,
          cursor: "page-2",
          truncated: false,
        });
      }
      return Promise.resolve({
        rows: Array.from({ length: 12 }, (_, i) => row({ id: `N${i}`, subject: `Second page ${i}` })),
        total: 40,
        cursor: null,
        truncated: false,
      });
    },
  });
  const { unmount } = render(<App api={api} />);
  await tick();
  assert.ok(byTestId("load-more"), "server has more (cursor !== null), so the button must appear");
  assert.equal(byTestId("list-count").textContent, "40 · 0 unread", "header total is the server's total, not the 12-row page");

  click(byTestId("load-more"));
  await tick();
  assert.ok(byTestId("row-subject-personal-M0"), "first page rows are still present");
  assert.equal(byTestId("list-count").textContent, "40 · 0 unread", "total still the server's total after the append");
  assert.equal(byTestId("load-more", { optional: true }), null, "cursor is now null -- no further page");

  // The appended rows are RENDERED, not merely held in state. This used
  // to need a click on MessageList's local "Show N more" reveal first --
  // that reveal is gone (it was the reason a folder appeared to hold 200
  // messages), so a fetched row is a visible row.
  assert.ok(byTestId("row-subject-personal-N0"), "second page rows were appended, not a replacement");
  unmount();
});

// ---------------------------------------------------------------------------
// activeRows: j/k walk search results while a search is active, and folder
// rows otherwise -- the round-11 seam this fix wave repaired.
// ---------------------------------------------------------------------------

test("j/k move through SEARCH results while a search is active", async () => {
  const api = fakeApi({
    messages: () =>
      Promise.resolve({ rows: [row({ id: "F1", subject: "Folder row" })], total: 1, cursor: null, truncated: false }),
    search: {
      rows: [
        { id: "S1", subject: "Search hit one" },
        { id: "S2", subject: "Search hit two" },
      ],
      total: 2,
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox")} />);
  await tick();

  type(byTestId("search"), "hit");
  await advance(250);
  assert.ok(byTestId("search-active"));

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal S1", "j opened the first SEARCH result, not the folder row");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal S2", "a second j advanced within the search results");
  unmount();
});

test("j/k move through FOLDER rows once the search box is empty again", async () => {
  const api = fakeApi({
    messages: () =>
      Promise.resolve({
        rows: [row({ id: "F1", subject: "First folder row" }), row({ id: "F2", subject: "Second folder row" })],
        total: 2,
        cursor: null,
        truncated: false,
      }),
    search: { rows: [{ id: "S1", subject: "Search hit" }], total: 1 },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox")} />);
  await tick();

  type(byTestId("search"), "hit");
  await advance(250);
  assert.ok(byTestId("search-active"));
  type(byTestId("search"), "");
  await advance(250);
  assert.equal(byTestId("search-active", { optional: true }), null, "search cleared");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal F1", "j opened the first FOLDER row, not a stale search result");
  unmount();
});

// ---------------------------------------------------------------------------
// Sidebar folder navigation and the theme toggle actually doing something.
// ---------------------------------------------------------------------------

test("clicking a sidebar folder navigates to it through the real route", async () => {
  const h = fakeHistory("/inbox");
  const { unmount } = render(
    <App
      api={fakeApi({
        accountsData: [{ key: "personal", label: "Personal", accent: "#888888" }],
        mailboxesData: [{ account: "personal", id: "mb-archive", role: "archive", name: "Archive" }],
      })}
      history={h}
    />,
  );
  // Two ticks: the sidebar takes its account list from App now (audit pass
  // 6 -- both used to fetch /api/accounts independently), so it renders one
  // microtask after App's fetch resolves rather than racing its own. Same
  // latency, one request.
  await tick();
  await tick();
  click(byTestId("mailbox-personal-mb-archive"));
  await tick();
  assert.equal(h.path(), "/archive/personal", "clicking the folder pushed the route App actually reads");
  unmount();
});

test("the theme toggle flips data-theme on the document and the sidebar's own state", async () => {
  document.documentElement.removeAttribute("data-theme");
  const { unmount } = render(<App api={fakeApi()} />);
  await tick();
  assert.equal(byTestId("theme-toggle").getAttribute("aria-pressed"), "false", "starts light");

  click(byTestId("theme-toggle"));
  await tick();
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark", "toggling flips the real document attribute");
  assert.equal(byTestId("theme-toggle").getAttribute("aria-pressed"), "true");

  click(byTestId("theme-toggle"));
  await tick();
  assert.equal(document.documentElement.getAttribute("data-theme"), "light");
  unmount();
});

// ---------------------------------------------------------------------------
// Push (item 1): a `change` frame refetches with reason "server", and a
// fatal stream failure routes to the same login gate as any other 401.
// ---------------------------------------------------------------------------

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readyState = 0;
  constructor(_url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  close(): void {}
  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) } as MessageEvent);
  }
}

test("a push change frame refetches the list with reason 'server', not 'local'", async () => {
  const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource as unknown;
  FakeEventSource.instances.length = 0;
  try {
    let call = 0;
    const api = fakeApi({
      messages: () => {
        call += 1;
        // First call: initial folder load. Second call: the push-driven
        // refetch. Return a NEW row so the test can tell the refetch
        // actually happened rather than the initial fetch re-rendering.
        const subject = call === 1 ? "Before push" : "After push";
        return Promise.resolve({ rows: [row({ id: "M1", subject })], total: 1, cursor: null, truncated: false });
      },
    });
    const { unmount } = render(<App api={api} history={fakeHistory("/inbox")} />);
    await tick();
    assert.equal(byTestId("row-subject-personal-M1").textContent, "Before push");

    const es = FakeEventSource.instances.at(-1);
    assert.ok(es, "App must open an EventSource for GET /api/events");
    es!.emit("change", { account: "personal" });
    await tick();

    assert.equal(byTestId("row-subject-personal-M1").textContent, "After push", "a change frame triggered a real refetch");
    assert.equal(call, 2, "exactly one push-driven refetch happened");
    unmount();
  } finally {
    (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
  }
});

test("a fatal SSE error (session gone) routes to the login gate, same as any other 401", async () => {
  const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource as unknown;
  FakeEventSource.instances.length = 0;
  try {
    const { unmount } = render(<App api={fakeApi()} />);
    await tick();
    assert.equal(byTestId("login-gate", { optional: true }), null, "not gated yet");

    const es = FakeEventSource.instances.at(-1)!;
    es.readyState = 2; // EventSource.CLOSED -- the "retrying will never work" signal.
    es.onerror?.(new Event("error"));
    await tick();

    assert.ok(byTestId("login-gate"), "a fatal SSE failure must route to the same login gate a 401 does");
    unmount();
  } finally {
    (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
  }
});

// ---------------------------------------------------------------------------
// Row 7 of harness/CHECKLIST.md: `j` at the last LOADED row must fetch the
// next page and land on its first row -- not clamp and re-open the row it
// is already on. The check pressed `j` 205 times through a 200-row page
// and moved through 199 distinct messages: the walk stopped dead at the
// page boundary because only scrolling ever paged.
// ---------------------------------------------------------------------------

test("KEYBOARD: j at the end of a page loads the next page and opens its first row", async () => {
  let pages = 0;
  const api = fakeApi({
    messages: (filters) => {
      const f = filters as { cursor?: string };
      if (f.cursor === undefined) {
        return Promise.resolve({
          rows: [row({ id: "M0", subject: "First page 0" }), row({ id: "M1", subject: "First page 1" })],
          total: 4,
          cursor: "page-2",
          truncated: false,
        });
      }
      pages += 1;
      return Promise.resolve({
        rows: [row({ id: "N0", subject: "Second page 0" }), row({ id: "N1", subject: "Second page 1" })],
        total: 4,
        cursor: null,
        truncated: false,
      });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal M1", "opened on the LAST row of the first page");
  assert.equal(pages, 0, "no second page has been asked for yet");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  await tick();
  await tick();
  assert.equal(pages, 1, "j at the page boundary fetched the next page");
  assert.ok(byTestId("row-subject-personal-N0"), "the next page's rows were appended to the list");
  assert.equal(byTestId("reading-subject").textContent, "Personal N0", "and j landed on the first row of that page");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal M1", "k walks back across the boundary");

  // At the true end (cursor null) j stays put rather than fetching again.
  for (let i = 0; i < 3; i++) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    await tick();
  }
  assert.equal(byTestId("reading-subject").textContent, "Personal N1", "j reached the last row of the last page");
  assert.equal(pages, 1, "no further fetch once the cursor is null");
  unmount();
});

test("KEYBOARD: Escape closes the open message (row 7), but not while compose is open over it", async () => {
  const api = fakeApi({
    messages: () =>
      Promise.resolve({
        rows: [row({ id: "M0", subject: "Only" })],
        total: 1,
        cursor: null,
        truncated: false,
      }),
  });
  const history = fakeHistory("/inbox/personal/M0");
  const { unmount } = render(<App api={api} history={history} />);
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal M0", "opened from the URL");

  // Compose on top: Escape belongs to compose (it closes the sheet); the
  // message underneath must stay open.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
  await tick();
  assert.ok(byTestId("compose-card"), "c opened compose");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  assert.equal(byTestId("compose-card", { optional: true }), null, "Escape closed compose");
  assert.equal(byTestId("reading-subject").textContent, "Personal M0", "the message behind compose is still open");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  assert.ok(byTestId("reading-empty"), "Escape with nothing on top closed the message");
  // `/inbox/personal/M0` is the personal-filtered list with M0 open (the
  // URL model's one segment does both jobs), so closing keeps that filter.
  assert.equal(history.path(), "/inbox/personal", "the route dropped the message, keeping the folder and its filter");
  assert.ok(byTestId("row-subject-personal-M0"), "the list is untouched");
  unmount();
});

// ---------------------------------------------------------------------------
// Row 12 (HTML compose, 2026-09-07): every reply is composed in HTML. The
// send carries the editor's HTML and the quoted original's SOURCE; the
// server attaches the original and derives the text half.
// ---------------------------------------------------------------------------

test("REPLY: the send carries the editor's HTML and the quoted original's source, whatever the source's format", async () => {
  const sent: { html?: string | boolean; quoteSource?: { account: string; id: string } | null }[] = [];
  let sourceHasHtml = true;
  const api = fakeApi({
    messages: () =>
      Promise.resolve({ rows: [row({ id: "M0", subject: "Hi" })], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    identities: () =>
      Promise.resolve({
        identities: {
          personal: [{ id: "id-1", name: null, email: "robin@example.test", primary: true, textSignature: "", htmlSignature: "" }],
        },
      }),
    draftFor: () =>
      Promise.resolve({
        account: "personal",
        to: [{ email: "dana@example.com", name: null }],
        cc: [],
        subject: "Re: Hi",
        quoted: "\n\nDana wrote:\n> hi",
        inReplyTo: "<abc@example.com>",
        references: ["<abc@example.com>"],
        ownAddressesKnown: true,
        sourceHasHtml,
        attribution: "Dana wrote:",
        quoteSource: { account: "personal", id: "M0", mode: "reply" as const },
        attachments: [],
      }),
    send: (input: { html?: string | boolean; quoteSource?: { account: string; id: string } | null }) => {
      sent.push(input);
      return Promise.resolve({ sent: true as const, emailId: "E1", submissionId: "S1" });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} />);
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
  await tick();
  await tick();
  assert.ok(byTestId("compose-card"), "r opened the reply");
  click(byTestId("send"));
  await tick();
  await tick();
  assert.equal(sent.length, 1, `the reply was sent (${byTestId("send-error", { optional: true })?.textContent ?? "no error"})`);
  assert.equal(typeof sent[0]!.html, "string", "the send carries the editor's HTML");
  assert.equal(sent[0]!.quoteSource, null, "row 44: the quote is in the HTML; the server attaches nothing");

  sourceHasHtml = false;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
  await tick();
  await tick();
  click(byTestId("send"));
  await tick();
  await tick();
  assert.equal(sent.length, 2, "the second reply was sent");
  assert.equal(typeof sent[1]!.html, "string", "a reply to a plaintext message is composed in HTML too");
  assert.ok(String(sent[1]!.html).includes("data-wilco-quote"), "the plaintext original is quoted in the body");
  unmount();
});

// ---------------------------------------------------------------------------
// Row 14: a forward carries the original's attachments -- as ready chips in
// the source account, and on into the send by blob.
// ---------------------------------------------------------------------------

test("FORWARD: the original's attachments open as chips and go out with the send", async () => {
  const sent: { attachments?: { blobId: string; account: string; name: string; size: number }[] }[] = [];
  const api = fakeApi({
    messages: () =>
      Promise.resolve({ rows: [row({ id: "M0", subject: "Hi" })], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    identities: () =>
      Promise.resolve({
        identities: {
          personal: [{ id: "id-1", name: null, email: "robin@example.test", primary: true, textSignature: "", htmlSignature: "" }],
        },
      }),
    draftFor: () =>
      Promise.resolve({
        account: "personal",
        to: [],
        cc: [],
        subject: "Fwd: Hi",
        quoted: "\n\n---------- Forwarded message ----------\nSee attached.",
        inReplyTo: null,
        references: null,
        ownAddressesKnown: true,
        sourceHasHtml: false,
        attribution: "someone wrote:",
        quoteSource: null,
        attachments: [{ blobId: "B1", name: "report.pdf", type: "application/pdf", size: 2048 }],
      }),
    send: (input: { attachments?: { blobId: string; account: string; name: string; size: number }[] }) => {
      sent.push(input);
      return Promise.resolve({ sent: true as const, emailId: "E1", submissionId: "S1" });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} />);
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
  await tick();
  await tick();
  assert.ok(byTestId("compose-card"), "f opened the forward");
  const chip = byTestId("attachment-chip-report.pdf");
  assert.match(chip.textContent ?? "", /2\.0 KB/, "the chip shows the original's size");
  type(byTestId("compose-to"), "dana@example.com");
  click(byTestId("send"));
  await tick();
  await tick();
  assert.equal(sent.length, 1, `the forward was sent (${byTestId("send-error", { optional: true })?.textContent ?? "no error"})`);
  assert.deepEqual(
    sent[0]!.attachments?.map((a) => ({ blobId: a.blobId, account: a.account, name: a.name, size: a.size })),
    [{ blobId: "B1", account: "personal", name: "report.pdf", size: 2048 }],
    "the original's attachment went out by blob, in the source account",
  );
  unmount();
});

// ---------------------------------------------------------------------------
// Row 8: the action that changes a message's state updates the open message
// too. `s` used to fill the row's star and say "Flagged 1" while the reading
// pane's own button stayed outline -- so a second `s` flagged it AGAIN.
// ---------------------------------------------------------------------------

test("TRIAGE: s flags the OPEN message on screen, and a second s unflags it", async () => {
  const actions: { kind: string; value?: boolean }[] = [];
  const api = fakeApi({
    messages: () =>
      Promise.resolve({ rows: [row({ id: "M0", subject: "Hi", isFlagged: false })], total: 1, cursor: null, truncated: false }),
    triage: (action: { kind: string; value?: boolean }) => {
      actions.push(action);
      return Promise.resolve({ applied: 1, failed: [], undoId: null });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} />);
  await tick();
  assert.ok(byTestId("act-flag-outline"), "opens unflagged");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
  await tick();
  await tick();
  assert.deepEqual(actions, [{ kind: "flag", value: true }]);
  assert.ok(byTestId("act-flag-filled"), "the reading pane's star filled");
  assert.ok(byTestId("row-personal-M0").querySelector(".msg-row-star"), "the row shows the star");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
  await tick();
  await tick();
  assert.deepEqual(actions[1], { kind: "flag", value: false }, "the second s UNflags -- it saw the new state");
  assert.ok(byTestId("act-flag-outline"), "the star is outline again");
  assert.equal(byTestId("row-personal-M0").querySelector(".msg-row-star"), null, "the row's star is gone");
  unmount();
});


// ---------------------------------------------------------------------------
// Row 22: "Move to…" lists the account's REAL folders (custom ones
// included) and moving is a real moveTo -- the picker used to be a
// disabled Inbox/Archive placeholder.
// ---------------------------------------------------------------------------

test("MOVE: the picker lists the message's account's real folders, and picking one moves the message", async () => {
  const calls: { action: unknown; targets: unknown }[] = [];
  const api = fakeApi({
    messages: () =>
      Promise.resolve({ rows: [row({ id: "M0", subject: "Hi" })], total: 1, cursor: null, truncated: false }),
    mailboxes: () =>
      Promise.resolve({
        accounts: [
          {
            account: "personal",
            mailboxes: [
              { id: "mb-inbox", name: "Inbox", role: "inbox", parent: null, unread: 0, total: 1 },
              { id: "mb-custom", name: "Receipts 2026", role: null, parent: null, unread: 0, total: 3 },
            ],
          },
          {
            account: "work",
            mailboxes: [{ id: "mb-work-inbox", name: "Inbox", role: "inbox", parent: null, unread: 0, total: 0 }],
          },
        ],
      }),
    triage: (action: unknown, targets: unknown) => {
      calls.push({ action, targets });
      return Promise.resolve({ applied: 1, failed: [], undoId: null });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} />);
  await tick();
  click(byTestId("message-menu"));
  await tick();
  const items = Array.from(document.querySelectorAll('[data-testid^="contextmenu-item-"]'));
  const move = items.find((el) => el.textContent?.startsWith("Move to"));
  assert.ok(move !== undefined, "no Move to… item");
  click(move as HTMLElement);
  await tick();
  await tick();
  assert.ok(byTestId("move-overlay"), "the picker opened");
  assert.ok(byTestId("move-folder-mb-custom"), "the custom folder is listed by its mailbox id");
  assert.equal(byTestId("move-folder-mb-work-inbox", { optional: true }), null, "another account's folders are not offered");
  const target = byTestId("move-folder-mb-custom") as HTMLButtonElement;
  assert.equal(target.disabled, false, `the row is disabled: ${target.title}`);
  click(target);
  await tick();
  await tick();
  assert.deepEqual(calls[0]?.action, { kind: "moveTo", mailboxId: "mb-custom" });
  assert.deepEqual(calls[0]?.targets, [{ account: "personal", id: "M0" }]);
  unmount();
});

// ---------------------------------------------------------------------------
// Row 32: dropping a row on a sidebar folder moves it there.
// ---------------------------------------------------------------------------

test("DRAG: a row dropped on a folder of its account is moved there with moveTo", async () => {
  const calls: { action: unknown; targets: unknown }[] = [];
  const api = fakeApi({
    messages: () =>
      Promise.resolve({ rows: [row({ id: "M0", subject: "Hi" })], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    mailboxesData: [{ account: "personal", id: "mb-arch", role: "archive", name: "Archive", unread: 0 }],
    triage: (action: unknown, targets: unknown) => {
      calls.push({ action, targets });
      return Promise.resolve({ applied: 1, failed: [], undoId: null });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox")} />);
  await tick();
  await tick();
  const data = new Map<string, string>();
  const dt = {
    effectAllowed: "uninitialized",
    dropEffect: "none",
    types: ["application/x-wilco-messages", "application/x-wilco-account-personal"],
    setData: (t: string, v: string) => void data.set(t, v),
    getData: (t: string) => data.get(t) ?? "",
  };
  const start = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(start, "dataTransfer", { value: dt });
  byTestId("row-personal-M0").dispatchEvent(start);
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: dt });
  byTestId("mailbox-personal-mb-arch").dispatchEvent(drop);
  await tick();
  assert.deepEqual(calls[0]?.action, { kind: "moveTo", mailboxId: "mb-arch" });
  assert.deepEqual(calls[0]?.targets, [{ account: "personal", id: "M0" }]);
  unmount();
});

// ---------------------------------------------------------------------------
// Row 31: the reading pane probes for an unsubscribe method on open, and
// the control runs it server-side and reports.
// ---------------------------------------------------------------------------

test("UNSUBSCRIBE: the control appears when the server says the message offers one, and clicking it reports the outcome", async () => {
  const probed: string[] = [];
  const ran: string[] = [];
  const api = fakeApi({
    messages: () =>
      Promise.resolve({ rows: [row({ id: "M0", subject: "News" }), row({ id: "M1", subject: "Note" })], total: 2, cursor: null, truncated: false }),
    unsubscribeInfo: (_account: string, id: string) => {
      probed.push(id);
      return Promise.resolve({ method: id === "M0" ? ("mailto" as const) : null });
    },
    unsubscribe: (_account: string, id: string) => {
      ran.push(id);
      return Promise.resolve({ method: "mailto" as const, ok: true as const, to: "leave@list.example", emailId: "E1" });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} />);
  await tick();
  await tick();
  assert.deepEqual(probed, ["M0"], "opening a message probes once");
  click(byTestId("unsubscribe"));
  await tick();
  await tick();
  assert.deepEqual(ran, ["M0"]);
  assert.match(byTestId("toast").textContent ?? "", /leave@list\.example/, "the toast says where the unsubscribe went");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  await tick();
  await tick();
  assert.equal(byTestId("unsubscribe", { optional: true }), null, "the next message offers nothing, so no control");
  unmount();
});

// ---------------------------------------------------------------------------
// Row 35 (reported on day 1 of the week): the sidebar's counts follow what
// you do. They used to load once and sit there until a reload.
// ---------------------------------------------------------------------------

test("SIDEBAR COUNTS: a triage refetches the folder counts without a reload", async () => {
  let fetches = 0;
  const api = fakeApi({
    messages: () =>
      Promise.resolve({ rows: [row({ id: "M0", subject: "Hi" })], total: 1, cursor: null, truncated: false }),
    mailboxes: () => {
      fetches += 1;
      return Promise.resolve({
        accounts: [{ account: "personal", mailboxes: [{ id: "mb-inbox", name: "Inbox", role: "inbox", parent: null, unread: 1, total: 1 }] }],
      });
    },
    triage: () => Promise.resolve({ applied: 1, failed: [], undoId: null }),
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} />);
  await tick();
  await tick();
  const before = fetches;
  assert.ok(before >= 1, "the sidebar loaded its counts");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
  await tick();
  await tick();
  assert.equal(fetches, before + 1, "archiving refetched the counts once");
  unmount();
});

// ---------------------------------------------------------------------------
// Row 36 (reported day 1): rapid deletes rubberbanded -- a sync event's
// refetch, answered from before the later deletes landed, put deleted rows
// back above the selected message, and they stayed.
// ---------------------------------------------------------------------------

test("RUBBERBAND: a sync-event refetch answered before a delete landed cannot put the deleted row back", async () => {
  let fire: () => void = () => {};
  let resolveTriage: (v: { applied: number; failed: never[]; undoId: null }) => void = () => {};
  type Page = { rows: ReturnType<typeof row>[]; total: number; cursor: null; truncated: false };
  const pending: ((p: Page) => void)[] = [];
  let serverRows = [row({ id: "M0", subject: "A" }), row({ id: "M1", subject: "B" }), row({ id: "M2", subject: "C" })];
  let fetches = 0;
  const api = fakeApi({
    messages: () => {
      fetches += 1;
      // The first fetch (mount) answers at once; every later one is held
      // until the test releases it, so the ORDER of answers is the test's.
      if (fetches === 1) return Promise.resolve({ rows: serverRows, total: 3, cursor: null, truncated: false });
      return new Promise<Page>((r) => pending.push(r));
    },
    triage: () => new Promise((r) => { resolveTriage = r; }),
  });
  const subscribeFn = ((onChange: () => void) => {
    fire = onChange;
    return () => {};
  }) as unknown as Parameters<typeof App>[0]["subscribeFn"];
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} subscribeFn={subscribeFn} />);
  await tick();
  assert.ok(byTestId("row-personal-M0"));

  // `#` on M0: optimistic removal, triage in flight.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "#", shiftKey: true, bubbles: true }));
  await tick();
  assert.equal(byTestId("row-personal-M0", { optional: true }), null, "M0 left the list at once");

  // Case 1: a sync event whose answer (still listing M0) arrives while the
  // delete is in flight -- M0 is filtered out of it.
  fire();
  await tick();
  pending.shift()!({ rows: serverRows, total: 3, cursor: null, truncated: false });
  await tick();
  await tick();
  assert.equal(byTestId("row-personal-M0", { optional: true }), null, "an answer from during the delete did not put M0 back");

  // Case 2: a sync event whose answer was computed before the delete landed
  // but ARRIVES after it settled -- the answer is discarded and a fresh
  // one asked for.
  fire();
  await tick();
  const staleAnswer = pending.shift()!;
  resolveTriage({ applied: 1, failed: [], undoId: null });
  await tick();
  await tick();
  serverRows = serverRows.filter((r) => r.id !== "M0");
  const before = fetches;
  staleAnswer({ rows: [row({ id: "M0", subject: "A" }), row({ id: "M1", subject: "B" }), row({ id: "M2", subject: "C" })], total: 3, cursor: null, truncated: false });
  await tick();
  await tick();
  assert.equal(byTestId("row-personal-M0", { optional: true }), null, "the stale answer was discarded, M0 stays gone");
  assert.ok(fetches > before, "a fresh refetch was asked for after the discarded answer");
  pending.shift()!({ rows: serverRows, total: 2, cursor: null, truncated: false });
  await tick();
  await tick();
  assert.equal(byTestId("row-personal-M0", { optional: true }), null);
  assert.ok(byTestId("row-personal-M1") && byTestId("row-personal-M2"), "the fresh answer is applied");
  unmount();
});

test("RAPID DELETE: two # presses in the same instant delete two DIFFERENT messages, top down", async () => {
  const targets: string[] = [];
  const api = fakeApi({
    messages: () =>
      Promise.resolve({
        rows: [row({ id: "M0", subject: "A" }), row({ id: "M1", subject: "B" }), row({ id: "M2", subject: "C" })],
        total: 3,
        cursor: null,
        truncated: false,
      }),
    triage: (_a: unknown, t: { id: string }[]) => {
      targets.push(t[0]!.id);
      return Promise.resolve({ applied: 1, failed: [], undoId: null });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} />);
  await tick();
  // No await between the two presses: the second runs before any render.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "#", shiftKey: true, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "#", shiftKey: true, bubbles: true }));
  await tick();
  await tick();
  assert.deepEqual(targets, ["M0", "M1"], "each press deletes the next message, never the same one twice");
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal M2", `the selection moved on to the third, not back to the top (pane shows ${JSON.stringify(byTestId("reading-subject").textContent)}, url ${window.location.pathname})`);
  unmount();
});

test("READ-ON-OPEN: a message deleted before the dwell elapses is not marked read afterwards", async () => {
  const actions: string[] = [];
  const api = fakeApi({
    messages: () =>
      Promise.resolve({
        rows: [row({ id: "M0", subject: "A", isUnread: true }), row({ id: "M1", subject: "B" })],
        total: 2,
        cursor: null,
        truncated: false,
      }),
    // M0 loads at once; M1's fetch never resolves -- the lag the browser
    // has between the route moving on and the next message arriving, in
    // which the dwell timer set for M0 is still armed.
    message: (account: string, id: string) =>
      id === "M0"
        ? Promise.resolve({
            account, id, threadId: null, receivedAt: "2026-01-01T00:00:00.000Z", subject: id, fromName: "S", fromEmail: "s@x.test",
            to: [], cc: [], bcc: [], replyTo: [], via: null, isUnread: true, isFlagged: false, hasAttachment: false, mailboxIds: [],
            bodyText: "b", preview: "", hasHtml: false, keywords: {}, attachments: [], inlineParts: [],
          })
        : new Promise(() => {}),
    triage: (a: { kind: string }, t: { id: string }[]) => {
      actions.push(`${a.kind}:${t[0]!.id}`);
      return Promise.resolve({ applied: 1, failed: [], undoId: null });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} />);
  await tick();
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "#", shiftKey: true, bubbles: true }));
  await tick();
  await new Promise((r) => setTimeout(r, 1300));
  assert.deepEqual(actions.filter((a) => a.startsWith("read:")), [], `no mark-read of the deleted message; saw ${JSON.stringify(actions)}`);
  assert.ok(actions.includes("move:M0"), "the delete itself went out");
  unmount();
});

// ---------------------------------------------------------------------------
// Row 37: theme/density/layout are stored preferences -- applied at boot,
// written on change. They used to reset on every reload.
// ---------------------------------------------------------------------------

test("PREFERENCES: the stored theme/layout are applied at boot, and a toggle is written back", async () => {
  document.documentElement.removeAttribute("data-theme");
  const written: [string, string][] = [];
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row({ id: "M0", subject: "Hi" })], total: 1, cursor: null, truncated: false }),
    preferences: () => Promise.resolve({ preferences: { ...DEFAULT_PREFERENCES, theme: "dark" as const, density: "compact" as const, layout: "rows" as const } }),
    setPreference: (key: string, value: string) => {
      written.push([key, value]);
      return Promise.resolve({ preferences: { ...DEFAULT_PREFERENCES, theme: "dark" as const, density: "compact" as const, layout: "rows" as const } });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox")} />);
  await tick();
  await tick();
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark", "the stored theme is applied at boot");
  assert.ok(byTestId("row-wide-personal-M0"), "the stored layout (rows) is applied at boot");
  assert.deepEqual(written, [], "applying stored preferences writes nothing back");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
  await tick();
  assert.equal(document.documentElement.getAttribute("data-theme"), "light");
  assert.deepEqual(written, [["theme", "light"]], "the toggle is written to the server");
  document.documentElement.removeAttribute("data-theme");
  unmount();
});

test("PREFERENCES: markRead=manual never marks on open; remoteImages=always asks for images; groupConversations=off lists every message", async () => {
  const bodyCalls: { images?: boolean }[] = [];
  const listCalls: { group?: boolean }[] = [];
  const actions: string[] = [];
  const api = fakeApi({
    messages: (filters: { group?: boolean } = {}) => {
      listCalls.push(filters);
      return Promise.resolve({ rows: [row({ id: "M0", subject: "Hi", isUnread: true })], total: 1, cursor: null, truncated: false });
    },
    message: (account: string, id: string) =>
      Promise.resolve({
        account, id, threadId: null, receivedAt: "2026-01-01T00:00:00.000Z", subject: id, fromName: "S", fromEmail: "s@x.test",
        to: [], cc: [], bcc: [], replyTo: [], via: null, isUnread: true, isFlagged: false, hasAttachment: false, mailboxIds: [],
        bodyText: "b", preview: "", hasHtml: true, keywords: {}, attachments: [], inlineParts: [],
      }),
    bodyUrl: (_a: string, _i: string, opts: { images?: boolean } = {}) => {
      bodyCalls.push(opts);
      return Promise.resolve({ url: "https://mailbody.invalid/m/t", expiresInMs: 600_000, remoteImages: opts.images === true, imagesAlways: false, sender: "s@x.test", blockedRemoteImages: 0, truncated: false, shownBytes: 0, totalBytes: 0, full: false, attachments: [] });
    },
    preferences: () => Promise.resolve({ preferences: { ...DEFAULT_PREFERENCES, markRead: "manual" as const, remoteImages: "always" as const, groupConversations: "off" as const } }),
    triage: (a: { kind: string }) => {
      actions.push(a.kind);
      return Promise.resolve({ applied: 1, failed: [], undoId: null });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} />);
  await tick();
  await tick();
  await tick();
  assert.ok(listCalls.some((f) => f.group === false), `the list was asked ungrouped once the preference loaded: ${JSON.stringify(listCalls)}`);
  assert.ok(bodyCalls.some((o) => o.images === true), `remote images were asked for from the start: ${JSON.stringify(bodyCalls)}`);
  await new Promise((r) => setTimeout(r, 2300));
  assert.deepEqual(actions.filter((a) => a === "read"), [], "manual: no mark-read on open, even past the dwell");
  unmount();
});

test("PREFERENCES: replyAllDefault makes r a reply-all; quoteHistory off opens the reply empty; archiveOnReply archives the source after the send", async () => {
  const modes: string[] = [];
  const triage: { kind: string; role?: string; id: string }[] = [];
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row({ id: "M0", subject: "Hi" })], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    identities: () =>
      Promise.resolve({ identities: { personal: [{ id: "id-1", name: null, email: "robin@example.test", primary: true, textSignature: "", htmlSignature: "" }] } }),
    preferences: () => Promise.resolve({ preferences: { ...DEFAULT_PREFERENCES, replyAllDefault: "on" as const, quoteHistory: "off" as const, archiveOnReply: "on" as const } }),
    draftFor: (_a: string, _i: string, mode: string) => {
      modes.push(mode);
      return Promise.resolve({ account: "personal", to: [{ email: "dana@example.com", name: null }], cc: [], subject: "Re: Hi", quoted: "\n\nDana wrote:\n> hi", inReplyTo: "<abc>", references: ["<abc>"], ownAddressesKnown: true, sourceHasHtml: false, attribution: "Dana wrote:", quoteSource: { account: "personal", id: "M0", mode: "reply" as const }, attachments: [] });
    },
    triage: (a: { kind: string; role?: string }, t: { id: string }[]) => {
      triage.push({ kind: a.kind, role: a.role, id: t[0]!.id });
      return Promise.resolve({ applied: 1, failed: [], undoId: null });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal/M0")} />);
  await tick();
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
  await tick();
  await tick();
  assert.deepEqual(modes, ["reply-all"], "r asked for a reply-all");
  assert.equal(byTestId("compose-quote", { optional: true }), null, "quote history off: no quoted original is shown");
  click(byTestId("send"));
  await tick();
  await tick();
  await tick();
  assert.deepEqual(triage.filter((t) => t.kind === "move"), [{ kind: "move", role: "archive", id: "M0" }], "the message replied to was archived after the send");
  unmount();
});

test("PREFERENCES: unifiedInboxAtLaunch off lands a launch at / on the first account's inbox, by replace, once", async () => {
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [], total: 0, cursor: null, truncated: false }),
    accountsData: [{ key: "work", label: "Work" }, { key: "personal", label: "Personal" }],
    preferences: () => Promise.resolve({ preferences: { ...DEFAULT_PREFERENCES, unifiedInboxAtLaunch: "off" as const } }),
  });
  const history = fakeHistory("/");
  const { unmount } = render(<App api={api} history={history} />);
  await tick();
  await tick();
  await tick();
  assert.equal(history.path(), "/inbox/work", "launched into the first account's inbox");
  unmount();
});

test("PREFERENCES: notifDesktop off shows no toast; people-only shows one only for a sender the account wrote to; sound plays a tone", async () => {
  let fire: () => void = () => {};
  let serverRows = [row({ id: "M0", subject: "A" })];
  const asked: string[] = [];
  let tones = 0;
  const prefs: Preferences = { ...DEFAULT_PREFERENCES, notifDesktop: "off" };
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: serverRows, total: serverRows.length, cursor: null, truncated: false }),
    preferences: () => Promise.resolve({ preferences: prefs }),
    writtenTo: (_a: string, email: string) => {
      asked.push(email);
      return Promise.resolve({ written: email === "dana@example.com" });
    },
  });
  (globalThis as { AudioContext?: unknown }).AudioContext = class {
    currentTime = 0;
    destination = {};
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    createOscillator() { return { type: "", frequency: { value: 0 }, connect() {}, start() { tones += 1; }, stop() {} }; }
    close() { return Promise.resolve(); }
  };
  const subscribeFn = ((onChange: () => void) => { fire = onChange; return () => {}; }) as unknown as Parameters<typeof App>[0]["subscribeFn"];
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox")} subscribeFn={subscribeFn} />);
  await tick();
  await tick();

  // Off: a new unread message arrives, no toast.
  serverRows = [row({ id: "N1", subject: "Newsletter", fromEmail: "news@list.example", isUnread: true }), ...serverRows];
  fire(); await tick(); await tick();
  assert.equal(byTestId("toast", { optional: true }), null, "notifDesktop off: no toast");

  // People only: a robot is quiet, a person you wrote to is announced, with a tone.
  prefs.notifDesktop = "on"; prefs.notifPeopleOnly = "on"; prefs.notifSound = "on";
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true })); // any preference write re-reads nothing; force the ref via a pref change
  await tick();
  serverRows = [row({ id: "N2", subject: "Robot", fromEmail: "robot@example.com", isUnread: true }), ...serverRows];
  fire(); await tick(); await tick();
  assert.equal(byTestId("toast", { optional: true }), null, "a sender never written to is muted");
  serverRows = [row({ id: "N3", subject: "Lunch", fromEmail: "dana@example.com", isUnread: true }), ...serverRows];
  fire(); await tick(); await tick();
  assert.ok(byTestId("toast"), "a person you wrote to is announced");
  assert.ok(tones >= 1, "with a tone");
  assert.deepEqual(asked, ["robot@example.com", "dana@example.com"]);
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  unmount();
});

test("PREFERENCES: with the account's switch off, the composer opens WITHOUT the signature block (HTML compose: nothing is appended later)", async () => {
  const sent: { html?: string | boolean }[] = [];
  let switchState: "on" | "off" = "off";
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row({ id: "M0", subject: "Hi" })], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    identities: () => Promise.resolve({ identities: { personal: [{ id: "id-1", name: null, email: "robin@example.test", primary: true, textSignature: "-- \nSig", htmlSignature: "" }] } }),
    accountSettings: () => Promise.resolve({ settings: { signatureNew: switchState }, mailboxes: [] }),
    signatureHtml: () => Promise.resolve({ html: "", text: "-- \nSig" }),
    send: (input: { html?: string | boolean }) => { sent.push(input); return Promise.resolve({ sent: true as const, emailId: "E1", submissionId: "S1" }); },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal")} />);
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
  await tick(); await tick();
  assert.equal(byTestId("compose-signature", { optional: true }), null, "signatureNew off: no block inserted");
  type(byTestId("compose-to"), "dana@example.com");
  click(byTestId("send"));
  await tick(); await tick(); await tick();
  assert.equal(sent.length, 1, "sent");
  assert.ok(!String(sent[0]!.html).includes("data-wilco-signature"), "and the send carries none");
  assert.ok(!("signature" in sent[0]!), "the old signature flag is gone");
  unmount();

  // On: the block is in the editor at open.
  switchState = "on";
  const second = render(<App api={api} history={fakeHistory("/inbox/personal")} />);
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
  await tick(); await tick(); await tick();
  assert.match(byTestId("compose-signature").textContent!, /Sig/, "signatureNew on: the block is there to edit");
  second.unmount();
});

// ---------------------------------------------------------------------------
// Row 37: custom folders open; Mark all read marks the whole folder.
// ---------------------------------------------------------------------------

test("CUSTOM FOLDER: the sidebar opens it, the list asks by mailbox id, the header shows its name, and opening/closing a message keeps it", async () => {
  const listCalls: { account?: string; mailbox?: string; role?: string }[] = [];
  const api = fakeApi({
    messages: (f: { account?: string; mailbox?: string; role?: string } = {}) => {
      listCalls.push(f);
      return Promise.resolve({ rows: [row({ id: "R1", subject: "Receipt" })], total: 1, cursor: null, truncated: false });
    },
    accountsData: [{ key: "personal", label: "Personal" }],
    mailboxesData: [
      { account: "personal", id: "P-INBOX", role: "inbox", name: "Inbox", unread: 0 },
      { account: "personal", id: "CUSTOM1", role: null, name: "Receipts 2026", unread: 0 },
    ],
  });
  const history = fakeHistory("/inbox");
  const { unmount } = render(<App api={api} history={history} />);
  await tick();
  await tick();
  click(byTestId("mailbox-personal-CUSTOM1"));
  await tick();
  await tick();
  assert.equal(history.path(), "/folder/personal/CUSTOM1");
  assert.ok(listCalls.some((f) => f.account === "personal" && f.mailbox === "CUSTOM1" && f.role === undefined), `the list was asked by mailbox id: ${JSON.stringify(listCalls)}`);
  assert.equal(byTestId("list-title").textContent, "Receipts 2026", "the header shows the folder's name");
  click(byTestId("row-personal-R1"));
  await tick();
  assert.equal(history.path(), "/folder/personal/CUSTOM1/R1", "opening a message stays in the folder");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  assert.equal(history.path(), "/folder/personal/CUSTOM1", "closing it too");
  unmount();
});

test("MARK ALL READ: the folder menu marks every unread message in the folder read, in chunks, and reports the count", async () => {
  let unreadLeft = [row({ id: "U1", isUnread: true }), row({ id: "U2", isUnread: true }), row({ id: "U3", isUnread: true })];
  const triaged: string[][] = [];
  const api = fakeApi({
    messages: (f: { unread?: boolean; group?: boolean } = {}) =>
      Promise.resolve(f.unread === true
        ? { rows: unreadLeft, total: unreadLeft.length, cursor: null, truncated: false }
        : { rows: [row({ id: "M0" })], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    mailboxesData: [{ account: "personal", id: "P-INBOX", role: "inbox", name: "Inbox", unread: 3 }],
    triage: (a: { kind: string }, targets: { id: string }[]) => {
      assert.equal(a.kind, "read");
      triaged.push(targets.map((t) => t.id));
      unreadLeft = [];
      return Promise.resolve({ applied: targets.length, failed: [], undoId: null });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox")} />);
  await tick();
  await tick();
  byTestId("mailbox-personal-P-INBOX").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await tick();
  const items = Array.from(document.querySelectorAll('[data-testid^="contextmenu-item-"]'));
  const mark = items.find((el) => el.textContent?.startsWith("Mark all read")) as HTMLButtonElement | undefined;
  assert.ok(mark !== undefined && !mark.disabled, "Mark all read is live");
  click(mark!);
  await tick(); await tick(); await tick();
  assert.deepEqual(triaged, [["U1", "U2", "U3"]]);
  assert.match(byTestId("toast").textContent ?? "", /Marked 3 read/);
  unmount();
});

test("EMPTY TRASH: the banner's button empties every trash in view after a confirm and reports the count", async () => {
  const emptied: [string, string][] = [];
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row({ id: "T1", subject: "old" })], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }, { key: "work", label: "Work" }],
    mailboxes: () =>
      Promise.resolve({
        accounts: [
          { account: "personal", mailboxes: [{ id: "P-TRASH", name: "Trash", role: "trash", parent: null, unread: 0, total: 1 }] },
          { account: "work", mailboxes: [{ id: "W-TRASH", name: "Trash", role: "trash", parent: null, unread: 0, total: 2 }] },
        ],
      }),
    emptyTrash: (account: string, id: string) => {
      emptied.push([account, id]);
      return Promise.resolve({ destroyed: account === "work" ? 2 : 1, considered: 3 });
    },
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/trash")} />);
  await tick();
  await tick();
  const btn = byTestId("empty-trash") as HTMLButtonElement;
  assert.equal(btn.disabled, false, "the button is live");
  const realConfirm = window.confirm;
  window.confirm = () => false;
  click(btn);
  await tick();
  assert.deepEqual(emptied, [], "declined: nothing destroyed");
  window.confirm = () => true;
  click(btn);
  await tick(); await tick(); await tick();
  window.confirm = realConfirm;
  assert.deepEqual(emptied, [["personal", "P-TRASH"], ["work", "W-TRASH"]], "the unified Trash empties every account's Trash");
  assert.match(byTestId("toast").textContent ?? "", /Deleted 3 from Trash/);
  unmount();
});

// ---------------------------------------------------------------------------
// Row 42: a message the owner SENT never raises the new-mail notification.
// The send confirmation is a plain label toast, not a notification card.
// ---------------------------------------------------------------------------

test("ROW 42: after Send the toast is a plain 'Sent' label, never a new-mail notification naming me as the sender", async () => {
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row({ id: "M0", subject: "Hi" })], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    identities: () => Promise.resolve({ identities: { personal: [{ id: "id-1", name: null, email: "robin@example.test", primary: true, textSignature: "", htmlSignature: "" }] } }),
  });
  const { unmount } = render(<App api={api} history={fakeHistory("/inbox/personal")} />);
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
  await tick(); await tick();
  type(byTestId("compose-to"), "dana@example.com");
  type(byTestId("compose-subject"), "Test from Wilco");
  click(byTestId("send"));
  await tick(); await tick(); await tick();
  const toast = byTestId("toast");
  assert.notEqual(toast.getAttribute("data-toast-kind"), "notification", "a sent message must not be announced as new mail");
  assert.match(toast.textContent!, /Sent: Test from Wilco/);
  assert.doesNotMatch(toast.textContent!, /robin@example.test/, "the owner is not the 'sender' of news");
  unmount();
});
