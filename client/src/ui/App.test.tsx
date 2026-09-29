// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";
import { DEFAULT_PREFERENCES, type EmailRow, type MessageDetail } from "../lib/api";
import { advance, byTestId, click, drag, fakeApi, fakeHistory, px, render, tick, type } from "../test-utils";
import { CHORD_TIMEOUT_MS, COMMANDS } from "../lib/keymap";
import { App, TOAST_MS } from "./App";

/**
 * The shortcuts overlay's "a deferred command explains itself" contract,
 * asserted against whichever command is deferred TODAY.
 *
 * 🚨 Audit pass 8 (T5). Three tests used to hard-code `attach:1` as the
 * example. They were not stale -- attachment saving really is deferred --
 * but they made shipping the number keys break three tests that had nothing
 * to do with the number keys, so the friction pointed the wrong way. The
 * structural half of the contract ("every command is wired OR visibly
 * disabled") is already enforced by keymap.test.ts over the whole list; what
 * these add is that the RENDERED overlay carries the reason, which needs one
 * concrete command. Now it asks for one.
 *
 * When nothing is deferred any more this passes vacuously, which is the
 * right ending: the assertion retires quietly instead of failing on the
 * commit that finishes the app.
 */
function assertDeferredCommandExplainsItself(): void {
  const deferred = COMMANDS.find((c) => c.disabledReason !== undefined);
  if (deferred === undefined) return;
  const el = byTestId(`shortcut-disabled-${deferred.id}`);
  // The whole reason, not a substring of it: the overlay is what makes
  // "nothing is reachable only by key" true (spec 7.3), and a truncated
  // explanation is the failure this is watching for.
  assert.ok(
    el.textContent!.includes(deferred.disabledReason!),
    `the overlay rendered no reason for the deferred command ${deferred.id}: ${el.textContent}`,
  );
}

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

function detail(overrides: Partial<MessageDetail> = {}): MessageDetail {
  return {
    account: "personal",
    id: "M1",
    threadId: null,
    receivedAt: "2026-09-03T00:00:00.000Z",
    subject: "Hello",
    fromName: "Someone",
    fromEmail: "someone@example.test",
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    via: null,
    isUnread: false,
    isFlagged: false,
    bodyText: "body text",
    hasHtml: false,
    keywords: {},
    mailboxIds: [],
    attachments: [],
    inlineParts: [],
    ...overrides,
  };
}

test("the shell renders three panes at their specified widths", () => {
  render(<App api={fakeApi()} />);
  assert.equal(px(byTestId("sidebar")), 242);
  assert.equal(px(byTestId("list")), 392);
});

// Design-fidelity Pass C, item 2: the `v` layout toggle must switch the
// message list to the single-line "rows layout" table (MessageList's
// `rowsLayout` prop), not merely rearrange panes while reusing the
// three-line row -- see MessageList.test.tsx for the row-shape assertions
// themselves; this test is the end-to-end wiring proof through App.tsx.
test("the 'v' layout toggle switches the list to the single-line rows-layout row", async () => {
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
  });
  render(<App api={api} />);
  await tick();
  assert.ok(byTestId("row-personal-M1"), "columns layout starts on the three-line row");
  assert.equal(byTestId("row-wide-personal-M1", { optional: true }), null);

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true }));
  await tick();

  assert.ok(byTestId("row-wide-personal-M1"), "rows layout renders the single-line row");
  assert.equal(byTestId("row-personal-M1", { optional: true }), null);
});

// Design-fidelity Pass C, item 5 (register, don't build): "Print view:
// Georgia serif" has a visible design affordance (the thread context
// menu's "Print" entry, Wilco.dc.html line ~1553), so it must render disabled with a
// reason, never be omitted.
test("a thread's context menu offers Print, and it opens the print document for THAT row (row 33)", async () => {
  const opened: string[] = [];
  const realOpen = window.open;
  window.open = ((url: string) => void opened.push(url)) as unknown as typeof window.open;
  try {
    const api = fakeApi({
      messages: () => Promise.resolve({ rows: [row(), row({ id: "M3" })], total: 2, cursor: null, truncated: false }),
    });
    render(<App api={api} />);
    await tick();
    byTestId("row-personal-M3").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await tick();
    // F7 (design-fidelity Pass D): the menu renders all 11 of the design's
    // items in its order -- Open, Reply, Forward, --, Mark read/unread,
    // Flag, Select, Print, ... -- so Print is index 7, not 2.
    const printItem = byTestId("contextmenu-item-7");
    assert.equal(printItem.textContent, "Print");
    assert.equal((printItem as HTMLButtonElement).disabled, false, "Print is live");
    click(printItem);
    assert.deepEqual(opened, ["/print/personal/M3"], "the print document opens in a new window, for the right-clicked row");
  } finally {
    window.open = realOpen;
  }
});

test("the reading pane's Print button opens the open message's print document (row 33)", async () => {
  const opened: string[] = [];
  const realOpen = window.open;
  window.open = ((url: string) => void opened.push(url)) as unknown as typeof window.open;
  try {
    const api = fakeApi({
      messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
    });
    render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
    await tick();
    click(byTestId("print"));
    assert.deepEqual(opened, ["/print/personal/M1"]);
  } finally {
    window.open = realOpen;
  }
});

test("the /print route renders the print document instead of the app shell (row 33)", async () => {
  render(<App api={fakeApi()} history={fakeHistory("/print/personal/M1")} />);
  await tick();
  await tick();
  assert.ok(byTestId("print-view"), "the print document rendered");
  assert.equal(byTestId("app-shell", { optional: true }), null, "and not the shell");
});

test("the divider clamps rather than letting a pane vanish", () => {
  render(<App api={fakeApi()} />);
  drag(byTestId("divider-list"), -400);
  assert.equal(px(byTestId("list")), 280, "clamped at the floor, not 0");
  drag(byTestId("divider-list"), +900);
  assert.equal(px(byTestId("list")), 620);
});

test("BACK CLOSES THE MESSAGE BEFORE LEAVING THE APP", () => {
  // Spec 7.3 names this explicitly. Without it, Back from an open message
  // exits the app and reload loses your place.
  const h = fakeHistory("/inbox");
  render(<App api={fakeApi()} history={h} />);
  h.push("/inbox/personal/M1");
  h.back();
  assert.equal(h.path(), "/inbox", "back closed the message");
  assert.equal(h.left(), false, "and did not leave the app");
});

test("reload lands on the same message", async () => {
  const { unmount } = render(<App api={fakeApi()} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal M1");
  unmount();
});

test("the real sidebar is what's mounted in the shell, not the old placeholder", async () => {
  // Task 6 review, round 1: the placeholder Sidebar (Panes.tsx) and the
  // real one (Sidebar.tsx) both render an <aside data-testid="sidebar">,
  // so a width-only assertion can't tell them apart -- that's exactly how
  // the real sidebar shipped orphaned once already. Assert something ONLY
  // the real component produces: an account's accent bar.
  render(
    <App
      api={fakeApi({
        accountsData: [{ key: "personal", label: "Personal", accent: "#b05fc9" }],
      })}
    />,
  );
  await tick();
  assert.equal(byTestId("account-bar-personal").style.background, "rgb(176, 95, 201)");
});

test("the real message list is what's mounted in the list pane, not an empty placeholder", async () => {
  // Same trap as the sidebar test above (Task 6 review, round 1), now for
  // the list pane: the old `ListPane` rendered an empty `<section
  // data-testid="list">` with nothing inside it, so a width-only
  // assertion couldn't tell "the real list is wired in" from "there's an
  // empty box here". Assert something ONLY `MessageList` produces: a real
  // row rendered from fetched data.
  render(
    <App
      api={fakeApi({
        messages: () => Promise.resolve({ rows: [row({ subject: "Orphan check" })], total: 1, cursor: null, truncated: false }),
      })}
    />,
  );
  await tick();
  assert.equal(byTestId("row-subject-personal-M1").textContent, "Orphan check");
});

test("BACK CLOSES THE MESSAGE BEFORE LEAVING THE APP -- proven end to end from a real row click", async () => {
  // Task 5's version of this test could only drive `fakeHistory` directly
  // (`h.push(...)`), because nothing in the app actually called
  // `history.push` itself yet -- there was no row to click. Now there is:
  // this clicks a REAL row, lets `MessageList`'s `onOpen` -> `App`'s
  // `handleOpenRow` -> `h.push` chain run for real, and only then presses
  // Back -- proving the whole path spec 7.3 names, not just the history
  // object's own semantics.
  const h = fakeHistory("/inbox");
  render(
    <App
      api={fakeApi({
        messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
      })}
      history={h}
    />,
  );
  await tick();

  click(byTestId("row-personal-M1"));
  await tick();
  // 🚨 `/inbox/all/...`, not `/inbox/personal/...`. The `all` segment is
  // the LIST FILTER, stated separately from the open message's account --
  // without it, opening a message from the unified inbox filtered the list
  // to that message's account (see router.ts).
  assert.equal(h.path(), "/inbox/all/personal/M1", "clicking a row navigated to it");
  assert.equal(byTestId("reading-subject").textContent, "Personal M1", "and the reading pane opened it");

  h.back();
  await tick();
  assert.equal(h.path(), "/inbox", "back closed the message");
  assert.ok(byTestId("reading-empty"), "the reading pane is empty again");
  assert.equal(h.left(), false, "and the app was not left");
});

test("the real reading pane is what's mounted, not the old placeholder", async () => {
  // Same trap as the sidebar/list tests above (Task 6 review, round 1),
  // now for the reading pane: the old `ReadingPane` placeholder rendered
  // only a subject and a from-line, so a `reading-subject` assertion
  // alone can't tell "the real Reading component is wired in" from "the
  // placeholder still is" -- exactly how Task 6 shipped an orphaned
  // sidebar once already. Assert something ONLY `Reading.tsx` produces:
  // the plaintext body (`data-testid="body"`) and the tri-state
  // `hasHtml` notice, neither of which the placeholder ever rendered.
  render(
    <App
      api={fakeApi({
        message: () =>
          Promise.resolve({
            account: "personal",
            id: "M1",
            threadId: null,
            receivedAt: "2026-09-03T00:00:00.000Z",
            subject: "Real reading pane",
            fromName: "Someone",
            fromEmail: "someone@example.test",
            to: [],
            cc: [],
            bcc: [],
            replyTo: [],
            via: null,
            isUnread: false,
            isFlagged: false,
            bodyText: "hello from the real pane",
            hasHtml: true,
            keywords: {},
            mailboxIds: [],
            attachments: [],
            inlineParts: [],
          }),
      })}
      history={fakeHistory("/inbox/personal/M1")}
    />,
  );
  await tick();
  // `hasHtml: true` now renders the BODY FRAME (spec 6) rather than the old
  // "HTML arrives with the body pipeline" placeholder notice. The frame is
  // still only ever a cross-origin URL -- assert on its `src`, which no
  // placeholder could produce, and on the fact that the SPA's own document
  // holds no message markup.
  await tick();
  const frame = byTestId("body-frame") as HTMLIFrameElement;
  assert.match(frame.getAttribute("src")!, /^https:\/\/mailbody\./, "the frame points at the body ORIGIN");
  // allow-scripts is for the body origin's OWN hashed resize script; the
  // absence of allow-same-origin is the guarantee, and is pinned.
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  assert.ok(!frame.getAttribute("sandbox")!.includes("allow-same-origin"));
  assert.equal(frame.getAttribute("tabindex"), "-1", "the frame never takes focus (spec 6.10)");
});

test("a message with no HTML still renders the plaintext body, unframed", async () => {
  render(
    <App
      api={fakeApi({
        message: () =>
          Promise.resolve({
            account: "personal",
            id: "M1",
            threadId: null,
            receivedAt: "2026-09-03T00:00:00.000Z",
            subject: "Plain",
            fromName: "Someone",
            fromEmail: "someone@example.test",
            to: [],
            cc: [],
            bcc: [],
            replyTo: [],
            via: null,
            isUnread: false,
            isFlagged: false,
            bodyText: "hello from the real pane",
            hasHtml: false,
            keywords: {},
            mailboxIds: [],
            attachments: [],
            inlineParts: [],
          }),
      })}
      history={fakeHistory("/inbox/personal/M1")}
    />,
  );
  await tick();
  assert.match(byTestId("body").textContent!, /hello from the real pane/);
  assert.equal(byTestId("body-frame", { optional: true }), null, "no frame for a plaintext-only message");
});

// Task 6 shipped an orphaned Sidebar once: the shell rendered a placeholder
// while the real component sat unreferenced, and no test caught it because
// the component's own tests never rendered inside App. This test exists so
// Search can't suffer the same fate -- it asserts on output ONLY the real
// Search component produces (a real result row fetched from the server via
// `api.search`, its count, and a highlighted match segment), which no
// placeholder search box could fake. F5/F6 (design-fidelity Pass D,
// 2026-09-04): the count text itself changed from "N of M" (the server's
// unbounded `total`) to "N results" (rows actually rendered, matching
// Wilco.dc.html's own `listMeta` -- see Search.test.tsx's own updated
// test), so this no longer asserts on `total` at all.
test("SEARCH IS WIRED INTO THE REAL APP, NOT A PLACEHOLDER", async () => {
  const api = fakeApi({
    search: {
      rows: [row({ id: "S1", subject: "budget report" })],
      total: 9612,
      cursor: "c",
      truncated: true,
    },
  });
  render(<App api={api} />);
  type(byTestId("search"), "budget");
  await advance(250);
  assert.equal(api.searchCalls[0], "budget");
  // Row 18: the header says the SERVER's total, which is what a person is
  // asking. It used to say the page length -- "200 results" against 2,917.
  assert.equal(byTestId("count").textContent, "9,612 results", "reports the server's total, not the page length");
  assert.equal(byTestId("hit-0").textContent, "budget", "the real Search component highlights the match");
});

test("clearing the search box shows the folder list again, not an empty result set", async () => {
  const api = fakeApi({ search: { rows: [row({ id: "S1" })], total: 1 }, messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }) });
  render(<App api={api} />);
  await tick();
  type(byTestId("search"), "budget");
  await advance(250);
  assert.ok(byTestId("search-active"));
  type(byTestId("search"), "");
  await advance(250);
  assert.equal(byTestId("search-active", { optional: true }), null);
  assert.ok(byTestId("message-list"), "the folder view (MessageList) is back");
});

// Task 10 review ruling: Task 6 shipped an orphaned Sidebar once -- the
// shell rendered a placeholder while the real component sat unreferenced,
// and no test caught it. These two tests exist so the keyboard layer
// (keymap.ts + Palette + Overlays) can't suffer the same fate: each
// asserts on behavior that ONLY the real, wired keyboard layer produces,
// not something a stub `window.addEventListener` could fake by accident.

test("KEYBOARD: j moves through the list and opens each row in turn, keyed by (account,id) not index", async () => {
  const api = fakeApi({
    messages: () =>
      Promise.resolve({
        rows: [row({ id: "M1", subject: "First" }), row({ id: "M2", subject: "Second" })],
        total: 2,
        cursor: null,
        truncated: false,
      }),
  });
  render(<App api={api} history={fakeHistory("/inbox")} />);
  await tick();
  assert.ok(byTestId("reading-empty"), "nothing open yet");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal M1", "j opened the first row");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal M2", "a second j advanced to the next row");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Personal M1", "k moved back");
});

test("KEYBOARD: a keystroke in the search box is text, not a command -- and ? opens the real shortcuts overlay", async () => {
  render(<App api={fakeApi()} history={fakeHistory("/inbox")} />);
  await tick();

  // The single most common way a keyboard layer becomes unusable (spec
  // 7.4): typing "j" into the search box must insert "j", not navigate.
  type(byTestId("search"), "j");
  assert.equal((byTestId("search") as HTMLInputElement).value, "j");
  assert.ok(byTestId("reading-empty"), "typing into search did not open a message");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
  await tick();
  assert.ok(byTestId("shortcuts-overlay"), "? opened the real overlay");
  // Only the real overlay, driven by keymap.ts's COMMANDS, would show a
  // deferred command's reason -- a placeholder couldn't fake this.
  //
  // 🚨 The example is CHOSEN AT RUNTIME (audit pass 8, T5). This used to
  // name `attach:1`, which made wiring the number keys break three tests
  // that were never about the number keys. The contract is "a deferred
  // command explains itself", so ask COMMANDS which command that is today
  // and assert against that one. It moves by itself, and when the list is
  // finally empty the assertion can be dropped deliberately rather than
  // tripped over.
  assertDeferredCommandExplainsItself();

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  assert.equal(byTestId("shortcuts-overlay", { optional: true }), null, "Escape closed the overlay");
});

test("KEYBOARD: Meta+K opens the real palette, never bare Ctrl+K (the browser's address bar)", async () => {
  render(<App api={fakeApi()} history={fakeHistory("/inbox")} />);
  await tick();

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await tick();
  assert.equal(byTestId("palette", { optional: true }), null, "bare Ctrl+K must not open the palette");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  await tick();
  assert.ok(byTestId("palette"), "Meta+K opened the real palette");
});

test("KEYBOARD: g then i navigates to the inbox through the REAL keyboard layer (not the pure function alone)", async () => {
  // keymap.test.ts already proves feed()'s own math with a fake, caller-
  // driven clock. This test exists because that is NOT the same claim as
  // "the running app enforces the timeout" -- App.tsx has to actually call
  // chordRef.current.advance() off a real clock in its keydown path for
  // that to be true, and nothing short of dispatching real keydowns
  // through the mounted App, with real wall-clock time in between, can
  // tell the two apart.
  const h = fakeHistory("/trash");
  render(<App api={fakeApi()} history={h} />);
  await tick();

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }));
  await tick();
  assert.equal(h.path(), "/inbox", "g then i (in quick succession) navigated to the inbox");
});

test("KEYBOARD: a stale g does not fire i late -- proven with REAL elapsed time, not a mocked clock", async () => {
  const h = fakeHistory("/trash");
  render(<App api={fakeApi()} history={h} />);
  await tick();

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
  // Real wall-clock wait past the chord timeout -- if App.tsx never wired
  // a real clock into chordRef (the bug this test exists to catch), this
  // wait changes nothing, feed()'s internal `elapsed` stays 0 forever, and
  // "i" would wrongly fire goto:inbox even after this delay.
  await advance(CHORD_TIMEOUT_MS + 300);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }));
  await tick();
  assert.equal(h.path(), "/trash", "a stale g did not let a later i navigate anywhere");
});

test("THE SHELL ASKS FOR A ROLE, NOT A MAILBOX ID", async () => {
  // The route's first segment is a role name. Sent as `mailbox` it is a
  // mailbox ID to the server, which rejects an id with no account (they
  // collide across accounts) -- so the live unified inbox answered 400 and
  // rendered "Inbox zero" over a full archive, with every test still
  // green. This asserts the wire shape the server actually accepts.
  const seen: Record<string, unknown>[] = [];
  render(
    <App
      api={fakeApi({
        messages: (filters) => {
          seen.push(filters as Record<string, unknown>);
          return Promise.resolve({ rows: [], total: 0, cursor: null, truncated: false });
        },
      })}
      history={fakeHistory("/archive")}
    />,
  );
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!["role"], "archive");
  assert.equal(seen[0]!["mailbox"], undefined, "never as a mailbox id");
});

test("CLICKING A ROW OPENS IT THROUGH THE REAL BROWSER HISTORY", async () => {
  // Deliberately passes NO `history` prop, so `App` builds its own
  // `createBrowserHistory` over `window.history` -- the seam every other
  // test in this file replaces with `fakeHistory`, and therefore the one
  // that shipped broken: `pushState` fires no `popstate`, so the app never
  // learned the URL had changed and the reading pane stayed empty while
  // the address bar said otherwise. Reloading that URL worked, which is
  // what made it survive to production.
  window.history.replaceState(null, "", "/inbox");
  const { unmount } = render(
    <App
      api={fakeApi({
        messages: () => Promise.resolve({ rows: [row({ subject: "Opened via pushState" })], total: 1, cursor: null, truncated: false }),
      })}
    />,
  );
  await tick();
  click(byTestId("row-personal-M1"));
  await tick();
  await tick();
  assert.equal(window.location.pathname, "/inbox/all/personal/M1");
  assert.equal(byTestId("reading-subject").textContent, "Personal M1", "the reading pane followed the push");
  unmount();
  window.history.replaceState(null, "", "/");
});

// -----------------------------------------------------------------------
// Task 4b: account codes wired from `GET /api/accounts`, the conversation
// wired through `api.thread()`, and the shared relative-time formatter.
// -----------------------------------------------------------------------

test("a real account code reaches a rendered row, and wins over the derived fallback", async () => {
  // "personal" derives to "PER" (MessageList's own `key.slice(0,3)`
  // fallback) -- deliberately different from the real code below, so a
  // test asserting only "WOR" against the DERIVED value would pass by
  // accident. This proves the real field made it through App, not just
  // that a code renders at all.
  const api = fakeApi({
    accountsData: [{ key: "personal", code: "WOR" }],
    messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
  });
  render(<App api={api} />);
  await tick();
  assert.equal(byTestId("row-code-personal-M1").textContent, "WOR");
});

test("an empty (pre-backfill) account code falls back to the derived one, not a blank cell", async () => {
  const api = fakeApi({
    accountsData: [{ key: "personal", code: "" }],
    messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
  });
  render(<App api={api} />);
  await tick();
  assert.equal(byTestId("row-code-personal-M1").textContent, "PER");
});

test("opening a message fetches its thread and renders the earlier messages collapsed", async () => {
  const api = fakeApi({
    message: () => Promise.resolve(detail({ threadId: "T1" })),
    thread: (account, threadId) => {
      assert.equal(account, "personal");
      assert.equal(threadId, "T1");
      return Promise.resolve({
        messages: [
          detail({ id: "M0", fromName: "Earlier Sender", bodyText: "earlier body" }),
          // The server's getThread() includes the currently open message
          // too (oldest-first, per its own doc comment) -- App must
          // filter it back out before handing the thread to Reading.
          detail({ threadId: "T1" }),
        ],
      });
    },
  });
  render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  await tick();
  assert.ok(byTestId("collapsed-personal-M0"), "the earlier message rendered, collapsed");
  assert.equal(byTestId("expanded-personal-M0", { optional: true }), null, "collapsed by default");
  assert.equal(byTestId("collapsed-personal-M1", { optional: true }), null, "the OPEN message is not also in the collapsed list");
});

test("a message with no threadId renders alone, and never calls api.thread", async () => {
  const api = fakeApi({ message: () => Promise.resolve(detail({ threadId: null })) });
  render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Hello");
  assert.equal(api.calls.some((c) => c.method === "thread"), false, "no threadId means nothing to fetch");
});

test("a FAILING thread fetch still renders the single message, not a blank pane", async () => {
  const api = fakeApi({
    message: () => Promise.resolve(detail({ threadId: "T1" })),
    thread: () => Promise.reject(new Error("boom")),
  });
  render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Hello", "the message still rendered");
  assert.equal(byTestId("reading-empty", { optional: true }), null, "not the empty state either");
});

test("COMPOSE IS REACHABLE: the sidebar button and the real 'c' keystroke both open the pane", async () => {
  // Task 5 fix round 1 -- the pane itself was built and fully tested in
  // isolation, but nothing in the running app could open it. That's the
  // bug this test exists to prevent from ever coming back: a click AND a
  // real dispatched keydown, through the full App, must both land on the
  // same compose-card.
  render(<App api={fakeApi()} history={fakeHistory("/inbox")} />);
  await tick();
  assert.equal(byTestId("compose-card", { optional: true }), null, "not open yet");

  click(byTestId("compose"));
  assert.ok(byTestId("compose-card"), "the sidebar's Compose button opened the pane");

  click(byTestId("compose-close"));
  assert.equal(byTestId("compose-card", { optional: true }), null, "closed again");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
  await tick();
  assert.ok(byTestId("compose-card"), "the 'c' keystroke opened the pane too");
});

test("COMPOSE: reply and forward are LIVE; attachment saving is what remains unwired", async () => {
  render(<App api={fakeApi()} history={fakeHistory("/inbox")} />);
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
  await tick();
  // Reply and forward gained a real send path, so neither may still render
  // as deferred -- the overlay is generated from COMMANDS, so this is a
  // direct assertion about the app's actual capability.
  assert.equal(byTestId("shortcut-disabled-reply", { optional: true }), null, "reply is wired");
  assert.equal(byTestId("shortcut-disabled-forward", { optional: true }), null, "forward is wired");
  assertDeferredCommandExplainsItself();
});

test("SETTINGS IS REACHABLE: the sidebar's gear button and the real ',' keystroke both open it", async () => {
  // Same shape as the compose test above -- a real click AND a real
  // dispatched keydown must both land on the settings screen through the
  // full App, not just in Settings.tsx's own isolated tests.
  render(<App api={fakeApi()} history={fakeHistory("/inbox")} />);
  await tick();
  assert.equal(byTestId("settings-pane", { optional: true }), null, "not open yet");

  click(byTestId("settings"));
  const settings = byTestId("settings-pane");
  assert.match(settings.textContent ?? "", /Settings/);

  click(byTestId("settings-close"));
  assert.equal(byTestId("app-shell").querySelector('[data-testid="settings-close"]'), null, "closed again");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", bubbles: true }));
  await tick();
  assert.ok(byTestId("settings-close"), "the ',' keystroke opened it too");
});

test("SETTINGS: theme actually flips the real document attribute from inside Settings", async () => {
  document.documentElement.removeAttribute("data-theme");
  render(<App api={fakeApi()} history={fakeHistory("/inbox")} />);
  await tick();
  click(byTestId("settings"));
  click(byTestId("switch-theme"));
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
});

test("SETTINGS: Escape closes it, same as every other overlay", async () => {
  render(<App api={fakeApi()} history={fakeHistory("/inbox")} />);
  await tick();
  click(byTestId("settings"));
  assert.ok(byTestId("settings-close"));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  assert.equal(byTestId("settings-close", { optional: true }), null, "closed again");
});

test("🚨 opening a DRAFT reopens it for editing, not in the reading pane", async () => {
  // A draft is an unfinished message of the user's own. Rendering it as
  // received mail -- with Reply and Forward pointed at themselves -- is the
  // wrong affordance. Keyed on the $draft keyword, not the route's mailbox,
  // because a draft is a draft wherever it is listed.
  render(
    <App
      api={fakeApi({
        message: () =>
          Promise.resolve({
            account: "personal",
            id: "D1",
            threadId: null,
            receivedAt: "2026-09-04T00:00:00.000Z",
            subject: "half written",
            fromName: "Robin",
            fromEmail: "robin@example.test",
            to: [{ email: "you@example.test", name: "" }],
            cc: [],
            bcc: [],
            replyTo: [],
            via: null,
            isUnread: false,
            isFlagged: false,
            bodyText: "so far",
            hasHtml: false,
            keywords: { $draft: true },
            mailboxIds: [],
            attachments: [],
            inlineParts: [],
          }),
      })}
      history={fakeHistory("/drafts/personal/D1")}
    />,
  );
  await tick();
  await tick();
  assert.ok(byTestId("compose-card", { optional: true }), "compose is what opens");
  assert.equal(byTestId("body", { optional: true }), null, "not the reading pane");
  assert.equal((byTestId("compose-subject") as HTMLInputElement).value, "half written");
});

test("an ordinary message still opens in the reading pane", async () => {
  render(
    <App
      api={fakeApi({
        message: () =>
          Promise.resolve({
            account: "personal",
            id: "M1",
            threadId: null,
            receivedAt: "2026-09-04T00:00:00.000Z",
            subject: "real mail",
            fromName: "Someone",
            fromEmail: "someone@example.test",
            to: [],
            cc: [],
            bcc: [],
            replyTo: [],
            via: null,
            isUnread: false,
            isFlagged: false,
            bodyText: "hello",
            hasHtml: false,
            keywords: {},
            mailboxIds: [],
            attachments: [],
            inlineParts: [],
          }),
      })}
      history={fakeHistory("/inbox/personal/M1")}
    />,
  );
  await tick();
  await tick();
  assert.equal(byTestId("compose-card", { optional: true }), null);
  assert.match(byTestId("body").textContent!, /hello/);
});

// -- Read-on-open (spec 7.3) ----------------------------------------------
//
// 🚨 The spec calls this Dovetail's LARGEST notable fix: "opening a message
// never marked it read... anything read in Dovetail stayed unread on every
// other device". Audit pass 2 found it had never been built in Wilco either,
// while a comment on `moveSelection` asserted the dwell as the reason j/k
// previewing is safe. These tests exist so that cannot recur silently.

/** An App wired to record every triage call, with one unread message. */
function readOnOpenSetup(rows: EmailRow[]) {
  const calls: { action: unknown; targets: unknown }[] = [];
  const api = fakeApi({
    messages: () => Promise.resolve({ rows, total: rows.length, cursor: null, truncated: false }),
    message: (account: string, id: string) =>
      Promise.resolve(detail({ account, id, isUnread: rows.find((r) => r.id === id)?.isUnread ?? false })),
    triage: (action: unknown, targets: unknown) => {
      calls.push({ action, targets });
      return Promise.resolve({ applied: 1, failed: [], undoId: null });
    },
  });
  return { api, calls };
}

test("🚨 opening an unread message marks it read after the dwell, not on arrival", async () => {
  const { api, calls } = readOnOpenSetup([row({ id: "M1", isUnread: true })]);
  render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();

  // Before the dwell elapses: nothing. Marking on arrival is the bug.
  await advance(400);
  assert.equal(calls.length, 0, "the message was marked read before the dwell elapsed");

  await advance(1700); // the dwell is the "After 2s" preference default
  assert.equal(calls.length, 1, "the message was never marked read");
  assert.deepEqual(calls[0]!.action, { kind: "read", value: true });
  assert.deepEqual(calls[0]!.targets, [{ account: "personal", id: "M1" }]);
});

test("🚨 sweeping past a message with j does NOT mark it read", async () => {
  // The whole reason for the dwell. Without it, walking the list with the
  // keyboard marks every message it passes -- on the server, on every device.
  const { api, calls } = readOnOpenSetup([
    row({ id: "M1", isUnread: true }),
    row({ id: "M2", isUnread: true }),
    row({ id: "M3", isUnread: true }),
  ]);
  render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();

  // Pass through M1 and M2 quickly, stop on M3.
  await advance(300);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  await tick();
  await advance(300);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  await tick();

  assert.equal(calls.length, 0, "a message was marked read while being swept past");

  await advance(2100); // past the 2s dwell
  assert.equal(calls.length, 1, "the message actually stopped on was not marked read");
  assert.deepEqual(calls[0]!.targets, [{ account: "personal", id: "M3" }]);
});

test("an already-read message is not re-marked", async () => {
  const { api, calls } = readOnOpenSetup([row({ id: "M1", isUnread: false })]);
  render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  await advance(1500);
  assert.equal(calls.length, 0, "a read message was marked read again");
});

test("read-on-open raises no undo toast -- it is not a user action", async () => {
  // `z` must undo whatever the user last DID, not the fact that they read
  // something. This is why it does not route through runTriage.
  const { api } = readOnOpenSetup([row({ id: "M1", isUnread: true })]);
  render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  await advance(1500);
  assert.equal(byTestId("toast", { optional: true }), null, "read-on-open raised an undo toast");
});

// -- The row context menu acts on the RIGHT-CLICKED row (audit pass 7 F1f) --

test("🚨 the row menu's Archive targets the right-clicked row, not the opened one", async () => {
  // This is the whole reason those items were disabled. Every keyboard
  // handler runs against `triageTargets()`, which returns the OPENED
  // message; the menu is opened on a row that is routinely a different one.
  // Wiring them to `triageTargets()` would have archived the wrong message
  // while looking completely correct.
  const calls: { action: unknown; targets: unknown }[] = [];
  const rows = [row({ id: "M1" }), row({ id: "M2" }), row({ id: "M3" })];
  const api = fakeApi({
    messages: () => Promise.resolve({ rows, total: rows.length, cursor: null, truncated: false }),
    triage: (action: unknown, targets: unknown) => {
      calls.push({ action, targets });
      return Promise.resolve({ applied: 1, failed: [], undoId: "u1" });
    },
  });
  // M1 is the OPENED message; M3 is the one right-clicked.
  render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();

  byTestId("row-personal-M3").dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
  );
  await tick();

  const items = Array.from(document.querySelectorAll('[data-testid^="contextmenu-item-"]'));
  const archive = items.find((el) => el.textContent?.startsWith("Archive"));
  assert.ok(archive !== undefined, "no Archive item in the row context menu");
  assert.equal((archive as HTMLButtonElement).disabled, false, "Archive is still disabled");
  click(archive as HTMLElement);
  await tick();

  assert.equal(calls.length, 1, "Archive did nothing");
  assert.deepEqual(calls[0]!.action, { kind: "move", role: "archive" });
  assert.deepEqual(
    calls[0]!.targets,
    [{ account: "personal", id: "M3" }],
    "the menu archived the OPENED message instead of the right-clicked one",
  );
});

test("🚨 Mark spam sends {kind:'spam'}, NEVER a move to role=junk", async () => {
  // The bug this whole feature exists to close. Spec 7.6: Fastmail only
  // learns from the folder its training points at, and which folder that is
  // differs per account -- audit pass 2 F4 found personal and work each hold
  // BOTH an "Identified Spam" (role null) and a "Spam" (role junk) mailbox,
  // and every message ever marked spam went to the one the filter does not
  // read. A move to role=junk looks completely correct from here: the mail
  // moves and the toast says it worked.
  const calls: { action: unknown; targets: unknown }[] = [];
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
    triage: (action: unknown, targets: unknown) => {
      calls.push({ action, targets });
      return Promise.resolve({ applied: 1, failed: [], undoId: "u1" });
    },
  });
  render(<App api={api} />);
  await tick();
  byTestId("row-personal-M1").dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
  );
  await tick();
  const items = Array.from(document.querySelectorAll('[data-testid^="contextmenu-item-"]'));
  const spam = items.find((el) => (el.textContent ?? "").includes("Mark spam"));
  assert.ok(spam !== undefined, "no Mark spam item in the row context menu");
  assert.equal((spam as HTMLButtonElement).disabled, false, "Mark spam is disabled");
  click(spam as HTMLElement);
  await tick();

  assert.equal(calls.length, 1, "Mark spam did nothing");
  assert.deepEqual(calls[0]!.action, { kind: "spam" });
  assert.notDeepEqual(
    calls[0]!.action,
    { kind: "move", role: "junk" },
    "spam was filed by ROLE, which is the folder the filter does not learn from",
  );
  assert.deepEqual(calls[0]!.targets, [{ account: "personal", id: "M1" }]);
});

// -- Spec 7.4's 1..9 = save attachment (audit pass 7 F1b) ------------------

test("🚨 pressing 2 downloads the SECOND attachment of the open message", async () => {
  // These nine keys were registered permanently disabled, blaming a body
  // pipeline that shipped on 2026-09-04. An attachment chip has been a real
  // download link since then; only the keys were never bound to it.
  const clicked: { href: string; download: string }[] = [];
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicked.push({ href: this.getAttribute("href") ?? "", download: this.download });
  };
  try {
    const api = fakeApi({
      messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
      bodyUrl: () =>
        Promise.resolve({
          url: "https://body.test/m/tok",
          expiresInMs: 600000,
          remoteImages: false,
          imagesAlways: false,
          sender: "someone@example.test",
          blockedRemoteImages: 0,
          truncated: false,
          full: false,
          shownBytes: 0,
          totalBytes: 0,
          attachments: [
            { blobId: "b1", name: "first.pdf", url: "https://body.test/a/tok/b1", type: "application/pdf", size: 1 },
            { blobId: "b2", name: "second.docx", url: "https://body.test/a/tok/b2", type: "application/msword", size: 2 },
          ],
        }),
    });
    render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
    await tick();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    await tick();
    await tick();

    assert.equal(clicked.length, 1, "pressing 2 downloaded nothing");
    assert.equal(clicked[0]!.href, "https://body.test/a/tok/b2", "it downloaded the wrong attachment");
    assert.equal(clicked[0]!.download, "second.docx");
  } finally {
    HTMLAnchorElement.prototype.click = realClick;
  }
});

test("pressing a number past the last attachment does nothing, quietly", async () => {
  // A mis-key, not an error worth a banner.
  const clicked: string[] = [];
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicked.push(this.getAttribute("href") ?? "");
  };
  try {
    const api = fakeApi({
      messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
      bodyUrl: () =>
        Promise.resolve({
          url: "https://body.test/m/tok",
          expiresInMs: 600000,
          remoteImages: false,
          imagesAlways: false,
          sender: "s@example.test",
          blockedRemoteImages: 0,
          truncated: false,
          full: false,
          shownBytes: 0,
          totalBytes: 0,
          attachments: [{ blobId: "b1", name: "only.pdf", url: "https://body.test/a/tok/b1", type: "application/pdf", size: 1 }],
        }),
    });
    render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
    await tick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "5", bubbles: true }));
    await tick();
    await tick();
    assert.deepEqual(clicked, [], "pressing 5 with one attachment downloaded something");
    assert.equal(byTestId("banner", { optional: true }), null, "a mis-key raised a banner");
  } finally {
    HTMLAnchorElement.prototype.click = realClick;
  }
});

// -- The reauthorize banner is REACHABLE (audit pass 3 D1) ----------------

test("🚨 an account whose token was rejected shows the banner, not just a badge", async () => {
  // MessageList has had `reauth`/`onReauthorize`/`imapPending` since it was
  // written, with tests rendering both banners -- and App passed NEITHER, so
  // an expired token produced a sidebar badge and no banner anywhere. Two
  // tests rendering a component directly, over a feature no user could
  // reach.
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    health: () =>
      Promise.resolve({
        ok: false,
        accounts: [
          {
            account: "personal",
            label: "Personal",
            state: "auth",
            walkComplete: true,
            hasEmailCursor: true,
            lastSyncAt: null,
            stale: false,
            detailsBackfillFailures: 0,
          },
        ],
      }),
  });
  render(<App api={api} />);
  await tick();
  await tick();

  const banner = byTestId("reauth-banner", { optional: true });
  assert.ok(banner !== null, "an auth failure showed no reauthorize banner");
  assert.match(banner.textContent ?? "", /reauthoriz/i);
});

test("a healthy account shows no banner", async () => {
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    health: () =>
      Promise.resolve({
        ok: true,
        accounts: [
          {
            account: "personal",
            label: "Personal",
            state: "ok",
            walkComplete: true,
            hasEmailCursor: true,
            lastSyncAt: "2026-09-05T00:00:00Z",
            stale: false,
            detailsBackfillFailures: 0,
          },
        ],
      }),
  });
  render(<App api={api} />);
  await tick();
  await tick();
  assert.equal(byTestId("reauth-banner", { optional: true }), null, "a healthy account raised a banner");
});

// -- Seams: one poll, one answer (audit pass 6) ---------------------------

test("🚨 /healthz is polled ONCE for the whole app, not once per component", async () => {
  // Audit pass 6 found `healthByAccount` living in three components -- App,
  // Sidebar and Settings -- each with its own poll. Three answers that can
  // disagree for a poll interval, which is how the sidebar badge and the
  // reauth banner could say different things about the same account. App
  // owns it now and passes it down; the others keep their own fetch only for
  // rendering standalone.
  let calls = 0;
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    health: () => {
      calls++;
      return Promise.resolve({ ok: true, accounts: [] });
    },
  });
  render(<App api={api} />);
  await tick();
  await tick();
  assert.equal(calls, 1, `/healthz was fetched ${calls} times on one mount`);
});

test("the sidebar badge and the reauth banner read the SAME health", async () => {
  // They are derived from one map through one function (`syncBadgeFor`), so
  // they cannot disagree about whether an account is in trouble. Before, two
  // independent polls could land either side of a token expiring.
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "personal", label: "Personal" }],
    health: () =>
      Promise.resolve({
        ok: false,
        accounts: [
          {
            account: "personal",
            label: "Personal",
            state: "auth",
            walkComplete: true,
            hasEmailCursor: true,
            lastSyncAt: null,
            stale: false,
            detailsBackfillFailures: 0,
          },
        ],
      }),
  });
  render(<App api={api} />);
  await tick();
  await tick();
  assert.ok(byTestId("reauth-banner", { optional: true }) !== null, "no banner for an auth failure");
  const badge = byTestId("account-sync-personal", { optional: true });
  assert.ok(badge !== null, "no sidebar badge for the same account");
});

// -- Multi-hop props, exercised end to end (audit pass 6) -----------------

test("🚨 the signature preview URL is minted for the right ACCOUNT and IDENTITY, three hops down", async () => {
  // `loadUrl`/`account`/`identityId` are threaded App -> Settings ->
  // SignaturePreview. Every hop had a test; the PATH had none, and this is
  // the shape mode-E defects take: each task correct alone, the join wrong.
  //
  // The specific bug this would let through is the one the capability
  // token's signed `kind` exists to catch -- passing an account key where an
  // identity id belongs, or the primary resolved positionally instead of
  // from the server's `mayDelete === false` (spec 11, on an account with
  // five aliases).
  const minted: { account: string; identityId: string }[] = [];
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false }),
    accountsData: [{ key: "work", label: "Work" }],
    identities: () =>
      Promise.resolve({
        identities: {
          work: [
            // Deliberately NOT first: a positional guess would pick this one.
            { id: "alias-1", name: null, email: "sales@work.example", primary: false, textSignature: "", htmlSignature: "" },
            { id: "primary-1", name: null, email: "robin@work.example", primary: true, textSignature: "sig", htmlSignature: "<b>sig</b>" },
          ],
        },
      }),
    signatureUrl: (account: string, identityId: string) => {
      minted.push({ account, identityId });
      return Promise.resolve({ url: "https://body.test/s/tok", hasHtml: false });
    },
  });
  render(<App api={api} />);
  await tick();
  await tick();

  window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", bubbles: true }));
  await tick();
  click(byTestId("acct-manage-work"));
  await tick();
  await tick();

  assert.ok(minted.length > 0, "no signature preview URL was minted three hops down");
  assert.equal(minted[0]!.account, "work", "the preview was minted for the wrong account");
  assert.equal(
    minted[0]!.identityId,
    "primary-1",
    "the preview used a positional identity, not the server's primary (spec 11)",
  );
});

// -- Toasts dismiss themselves (reported 2026-09-05: "they linger") -------

// -- Toast auto-dismiss is verified in the BROWSER, not here ---------------
//
// 🚨 There is deliberately no unit test for the 7s/9s dismissal, and the
// reason is worth more than the test would be.
//
// The first attempt mocked the clock so it would not have to wait. Vitest's
// fake timers, preact's `act` and happy-dom together sent it into a render
// loop that consumed this box's 60 GB: the kernel OOM-killed the worker,
// Docker started restarting containers under the pressure, and the machine
// -- which also runs other services -- had to
// be rebooted. The second attempt used REAL elapsed time inside a long-held
// `act()` and did the same thing.
//
// So the mechanism is verified end to end in `harness/run.py`'s `toast`
// scenario, against the deployed app in a real browser, where seven seconds
// is just seven seconds and nothing is being simulated. `TOAST_MS` below
// pins the design's values. If someone later wants this in the unit suite,
// the render loop has to be understood FIRST -- it is a real defect in the
// interaction, not a flaky test.


test("the toast durations are the design's own values", () => {
  // A literal check, and legitimate as one: the VALUE is the requirement.
  // Wilco.dc.html:908 (`ttl || 7000`) and :947 (a notification removes itself
  // after 9000). The behavioural test above proves the mechanism; this pins
  // the numbers without spending nine more real seconds to do it.
  assert.equal(TOAST_MS.undo, 7000);
  assert.equal(TOAST_MS.notification, 9000);
});

test("🚨 OPENING A MESSAGE FROM THE UNIFIED INBOX DOES NOT SHRINK THE LIST", async () => {
  // 🚨 This is the defect that made the app unusable, and it is asserted on
  // the LIST, not on the URL. Every existing test around this checked where
  // the URL went -- `/inbox/personal/M1` looked perfectly reasonable -- and
  // none checked what the list then showed. Measured on the live app: All
  // inboxes went 13 rows -> 8 on a click, all-accounts Archive went 25,208
  // -> 12,792, and one press of `j` in the unified inbox (which opens the
  // first row) collapsed the list to a single message, leaving `j` and `k`
  // with nowhere to go. The unified inbox is this application's premise.
  //
  // Cause: `Route.account` meant both "filter the list to this account" and
  // "the open message is in this account". They are now separate fields.
  //
  // ⚠️ Mutation note: reverting `listFilters` alone does NOT fail this, and
  // that is correct rather than a weakness -- the list effect keys on the
  // filter, so a wrong filter that is never re-read changes nothing anyone
  // can see. Reverting BOTH (the filter and the effect's dependency), which
  // is exactly the code that shipped, does fail it.
  const rows = [
    row({ account: "personal", id: "P1", subject: "Personal one" }),
    row({ account: "work", id: "W1", subject: "Work one" }),
    row({ account: "society", id: "S1", subject: "Society one" }),
  ];
  const seen: (string | undefined)[] = [];
  const api = fakeApi({
    messages: (filters?: { account?: string }) => {
      seen.push(filters?.account);
      const visible = filters?.account ? rows.filter((r) => r.account === filters.account) : rows;
      return Promise.resolve({ rows: visible, total: visible.length, cursor: null, truncated: false });
    },
  });

  const h = fakeHistory("/inbox");
  const { unmount } = render(<App api={api} history={h} />);
  await tick();
  assert.equal(document.querySelectorAll('[data-testid^="row-"][role="row"]').length, 3, "the unified list starts with every account");

  click(byTestId("row-work-W1"));
  await tick();
  await tick();

  // fakeApi's `message` renders its own subject from (account, id), so
  // this asserts WHICH message opened without depending on the row text.
  assert.equal(byTestId("reading-subject").textContent, "Work W1", "the wrong message opened, or none did");
  assert.equal(
    document.querySelectorAll('[data-testid^="row-"][role="row"]').length,
    3,
    "opening a message narrowed the unified list to that message's account",
  );
  assert.ok(
    seen.every((a) => a === undefined),
    `the list was re-fetched filtered to one account: ${JSON.stringify(seen)}`,
  );
  unmount();
});

// -- Leaving the list (owner, 2026-09-09) ------------------------------------
// "when I mark a message as spam it disappears from the inbox listing, but
// the message stays up... Message body should disappear, either selecting
// the next available message or selecting nothing."

test("marking the open message as spam drops its row at once and opens the row below", async () => {
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row({ id: "M1", subject: "First" }), row({ id: "M2", subject: "Second" })], total: 2, cursor: null, truncated: false }),
    message: (_a: string, id: string) => Promise.resolve(detail({ id, subject: id === "M1" ? "First" : "Second" })),
    triage: () => Promise.resolve({ applied: 1, failed: [], undoId: "u1" }),
  });
  render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "First");
  click(byTestId("act-spam"));
  await tick();
  assert.equal(byTestId("row-personal-M1", { optional: true }), null, "the spam row is gone from the list at once, not after a sync round");
  assert.equal(byTestId("reading-subject").textContent, "Second", "the reading pane moved to the next available message");
});

test("archiving the LAST row closes the reading pane instead of re-opening the message that just left", async () => {
  const api = fakeApi({
    messages: () => Promise.resolve({ rows: [row({ id: "M1", subject: "Only" })], total: 1, cursor: null, truncated: false }),
    message: (_a: string, id: string) => Promise.resolve(detail({ id, subject: "Only" })),
    triage: () => Promise.resolve({ applied: 1, failed: [], undoId: "u1" }),
  });
  render(<App api={api} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  assert.equal(byTestId("reading-subject").textContent, "Only");
  click(byTestId("act-archive"));
  await tick();
  assert.ok(byTestId("reading-empty"), "nothing is left to show, so nothing is shown");
  assert.equal(byTestId("row-personal-M1", { optional: true }), null);
});

// -- Row 58: archive and folder moves act on the CONVERSATION the row shows;
// delete and spam act on the message (owner ruling 2026-09-15). The list is
// one row per conversation, so an archive that named only the open message
// left the row standing on its siblings: "I archived it twice and it came
// back." The client names the folder it is looking at; the server widens. --

function scopeSetup(path: string) {
  const calls: { action: unknown; targets: unknown; scope: unknown }[] = [];
  const rows = [row({ id: "M1", threadId: "T" }), row({ id: "M2", threadId: "U" })];
  const api = fakeApi({
    messages: () => Promise.resolve({ rows, total: rows.length, cursor: null, truncated: false }),
    triage: (action: unknown, targets: unknown, scope?: unknown) => {
      calls.push({ action, targets, scope });
      return Promise.resolve({ applied: 1, failed: [], undoId: "u1" });
    },
  });
  render(<App api={api} history={fakeHistory(path)} />);
  return calls;
}

test("🚨 archive (e) from the unified inbox names the conversation and the viewed folder", async () => {
  const calls = scopeSetup("/inbox/all/personal/M1");
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
  await tick();
  assert.equal(calls.length, 1, "archive did nothing");
  assert.deepEqual(calls[0]!.targets, [{ account: "personal", id: "M1" }]);
  assert.deepEqual(calls[0]!.scope, { kind: "conversation", role: "inbox" }, "the server needs the viewed folder to widen");
});

test("archive from a custom folder names that folder by mailbox id", async () => {
  const calls = scopeSetup("/folder/personal/LBL/M1");
  await tick();
  click(byTestId("act-archive"));
  await tick();
  assert.equal(calls.length, 1, "archive did nothing");
  assert.deepEqual(calls[0]!.scope, { kind: "conversation", mailboxId: "LBL" });
});

test("🚨 delete (#) and spam send NO scope: they act on the message only", async () => {
  const calls = scopeSetup("/inbox/all/personal/M1");
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "#", bubbles: true }));
  await tick();
  assert.equal(calls.length, 1, "delete did nothing");
  assert.deepEqual(calls[0]!.action, { kind: "move", role: "trash" });
  assert.equal(calls[0]!.scope, undefined, "a delete widened to the conversation is the one thing the ruling forbids");
});

test("with conversation grouping OFF every row is a message, and archive names no scope", async () => {
  const calls: { scope: unknown }[] = [];
  const rows = [row({ id: "M1", threadId: "T" })];
  const api = fakeApi({
    messages: () => Promise.resolve({ rows, total: 1, cursor: null, truncated: false }),
    preferences: () => Promise.resolve({ preferences: { ...DEFAULT_PREFERENCES, groupConversations: "off" } as never }),
    triage: (_a: unknown, _t: unknown, scope?: unknown) => {
      calls.push({ scope });
      return Promise.resolve({ applied: 1, failed: [], undoId: "u1" });
    },
  });
  render(<App api={api} history={fakeHistory("/inbox/all/personal/M1")} />);
  await tick();
  click(byTestId("act-archive"));
  await tick();
  assert.equal(calls.length, 1, "archive did nothing");
  assert.equal(calls[0]!.scope, undefined, "the rows are messages; widening would archive rows the user cannot see as one");
});

// -- Row 59: "All inboxes" is the unified INBOX from wherever you are (owner,
// 2026-09-16: "when I am viewing a folder for an account and then return to
// the unified view, I am not shown the correct emails. Different folders to
// start with show different folders as a result"). The row kept the route's
// folder and dropped only the account, so from test-a's Archive it opened
// every account's Archive under an "All inboxes" highlight, and from a custom
// folder it opened `/folder`, which names no folder at all. --

for (const start of ["/archive/personal", "/sent/personal", "/folder/personal/LBL", "/trash/personal/M1"]) {
  test(`🚨 All inboxes from ${start} opens the unified inbox`, async () => {
    const lists: unknown[] = [];
    const api = fakeApi({
      messages: (filters: unknown) => {
        lists.push(filters);
        return Promise.resolve({ rows: [row()], total: 1, cursor: null, truncated: false });
      },
    });
    const history = fakeHistory(start);
    render(<App api={api} history={history} />);
    await tick();
    click(byTestId("nav-all-inboxes"));
    await tick();
    assert.equal(history.path(), "/inbox", `All inboxes from ${start} went to ${history.path()}`);
    assert.deepEqual(lists.at(-1), { role: "inbox" }, "the list asked for something other than every account's inbox");
  });
}

test("the u key goes to the unified inbox from an account's Archive, too", async () => {
  const history = fakeHistory("/archive/personal");
  render(<App api={fakeApi({ messages: () => Promise.resolve({ rows: [], total: 0, cursor: null, truncated: false }) })} history={history} />);
  await tick();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
  await tick();
  assert.equal(history.path(), "/inbox");
});

// -- Task 5 review follow-up: `rows === undefined` must be REACHABLE ------
//
// Commit e5ea752 gave MessageList a loading state for `rows === undefined`,
// with good component-level tests, but no App-level test ever drove the
// real fetch that state exists for. `rows` there started life as `[]`
// (App.tsx's own state), which MessageList can never distinguish from "this
// folder has nothing in it" -- so the very first paint after login rendered
// "Inbox zero" for as long as the first `api.messages()` call took (measured
// 3.5s against a 167,749-message instance) before real rows replaced it.
// These tests drive that fetch by hand, with a promise this file controls,
// so the gap can't reopen invisibly the way it did the first time.

/** A promise plus its own `resolve`, for a test that needs to observe what
 *  renders WHILE a fake `api.messages()` call is still in flight -- every
 *  other `fakeApi({ messages: ... })` in this file resolves immediately,
 *  which is exactly why this gap went unnoticed. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("🚨 first mount shows the LOADING state, never 'Inbox zero', while the first fetch is in flight", async () => {
  const first = deferred<{ rows: EmailRow[]; total: number; cursor: null; truncated: boolean }>();
  render(<App api={fakeApi({ messages: () => first.promise })} />);
  await tick();

  assert.notEqual(byTestId("list-loading", { optional: true }), null, "the first paint must show loading");
  assert.equal(byTestId("empty", { optional: true }), null, "the first paint must NOT claim the inbox is empty");

  // Let the deferred promise resolve so nothing leaks into the next test.
  first.resolve({ rows: [], total: 0, cursor: null, truncated: false });
  await tick();
});

test("once the first response lands with rows, neither loading nor empty renders", async () => {
  const first = deferred<{ rows: EmailRow[]; total: number; cursor: null; truncated: boolean }>();
  render(<App api={fakeApi({ messages: () => first.promise })} />);
  await tick();
  assert.notEqual(byTestId("list-loading", { optional: true }), null, "sanity: still loading before resolving");

  first.resolve({ rows: [row()], total: 1, cursor: null, truncated: false });
  await tick();

  assert.equal(byTestId("list-loading", { optional: true }), null, "loading did not clear once rows arrived");
  assert.equal(byTestId("empty", { optional: true }), null, "a non-empty response must not render the empty state");
  assert.ok(byTestId("row-personal-M1"), "the real row never rendered");
});

test("once the first response lands with ZERO rows, the empty state shows (and only then)", async () => {
  // The counterpart to the test above: a genuinely empty folder (Spam,
  // documented elsewhere as 0 messages across every account) must still
  // reach the empty state once loading actually finishes -- this fix must
  // not turn into "loading forever".
  const first = deferred<{ rows: EmailRow[]; total: number; cursor: null; truncated: boolean }>();
  render(<App api={fakeApi({ messages: () => first.promise })} history={fakeHistory("/spam")} />);
  await tick();
  assert.notEqual(byTestId("list-loading", { optional: true }), null, "sanity: still loading before resolving");
  assert.equal(byTestId("empty", { optional: true }), null, "must not show empty before the response arrives");

  first.resolve({ rows: [], total: 0, cursor: null, truncated: false });
  await tick();

  assert.equal(byTestId("list-loading", { optional: true }), null, "loading did not clear for a real empty folder");
  assert.notEqual(byTestId("empty", { optional: true }), null, "a genuinely empty folder must still show the empty state");
});

test("🚨 a folder change mid-flight shows neither the previous folder's rows nor the empty state", async () => {
  // The folder-SWITCH half of the live bug was already fixed by
  // MessageList's own `folderPending` mechanism (rows for the OLD folder
  // stay in App's state by reference until the new page arrives); this
  // pins that App.tsx's fetch effect really does leave `rows` untouched
  // across a route change rather than reintroducing a reset-to-undefined
  // that would collapse this into the same bug from the other direction.
  const inbox = deferred<{ rows: EmailRow[]; total: number; cursor: null; truncated: boolean }>();
  const archive = deferred<{ rows: EmailRow[]; total: number; cursor: null; truncated: boolean }>();
  const history = fakeHistory("/inbox");
  const api = fakeApi({
    messages: (filters) => ((filters as { role?: string }).role === "archive" ? archive.promise : inbox.promise),
  });
  render(<App api={api} history={history} />);
  await tick();
  inbox.resolve({ rows: [row({ id: "M1", subject: "Inbox message" })], total: 1, cursor: null, truncated: false });
  await tick();
  assert.ok(byTestId("row-personal-M1"), "sanity: the inbox's row is up before switching");

  history.push("/archive");
  await tick();

  assert.equal(byTestId("row-personal-M1", { optional: true }), null, "the previous folder's row must not render under the new title");
  assert.equal(byTestId("empty", { optional: true }), null, "must not claim archive is empty while its page is still in flight");
  assert.notEqual(byTestId("list-loading", { optional: true }), null, "must show loading while the folder switch is in flight");

  archive.resolve({ rows: [row({ id: "M2", subject: "Archive message" })], total: 1, cursor: null, truncated: false });
  await tick();
  assert.equal(byTestId("list-loading", { optional: true }), null, "loading did not clear once archive's page landed");
  assert.ok(byTestId("row-personal-M2"), "archive's real row never rendered");
});

// Review finding I2: a rejected `api.messages()` used to leave `rows`
// untouched (`undefined` on a first load, or the previous folder's array on
// a switch), which MessageList's `notYetLoaded`/`folderPending` checks can
// never distinguish from "still in flight" -- so a failed fetch spun the
// loading skeleton forever underneath the error banner. The fix terminates
// it by setting `rows` to a fresh `[]` in the `.catch`.

test("🚨 a failed first load clears the loading state and shows the error banner, not an eternal skeleton", async () => {
  let reject!: (err: unknown) => void;
  const promise = new Promise<{ rows: EmailRow[]; total: number; cursor: null; truncated: boolean }>((_resolve, r) => {
    reject = r;
  });
  render(<App api={fakeApi({ messages: () => promise })} />);
  await tick();
  assert.notEqual(byTestId("list-loading", { optional: true }), null, "sanity: still loading before rejecting");

  reject(new Error("network down"));
  await tick();

  assert.equal(byTestId("list-loading", { optional: true }), null, "loading must not spin forever after a failed fetch");
  assert.ok(byTestId("error-banner"), "a failed load must surface the error banner");
});

test("🚨 a failed FOLDER SWITCH clears the loading state instead of spinning forever", async () => {
  const inbox = deferred<{ rows: EmailRow[]; total: number; cursor: null; truncated: boolean }>();
  let rejectArchive!: (err: unknown) => void;
  const archivePromise = new Promise<{ rows: EmailRow[]; total: number; cursor: null; truncated: boolean }>((_resolve, r) => {
    rejectArchive = r;
  });
  const history = fakeHistory("/inbox");
  const api = fakeApi({
    messages: (filters) => ((filters as { role?: string }).role === "archive" ? archivePromise : inbox.promise),
  });
  render(<App api={api} history={history} />);
  await tick();
  inbox.resolve({ rows: [row({ id: "M1", subject: "Inbox message" })], total: 1, cursor: null, truncated: false });
  await tick();
  assert.ok(byTestId("row-personal-M1"), "sanity: the inbox's row is up before switching");

  history.push("/archive");
  await tick();
  assert.notEqual(byTestId("list-loading", { optional: true }), null, "must show loading while the folder switch is in flight");

  rejectArchive(new Error("network down"));
  await tick();

  assert.equal(byTestId("list-loading", { optional: true }), null, "a failed folder switch must not spin loading forever");
  assert.ok(byTestId("error-banner"), "a failed folder switch must surface the error banner");
});
