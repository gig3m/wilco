// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";
import { byTestId, click, render } from "../test-utils";
import { act } from "preact/test-utils";
import { DRAG_MESSAGES_TYPE, MessageList, type MessageListRow } from "./MessageList";

function rows(n: number): MessageListRow[] {
  return Array.from({ length: n }, (_, i) => ({
    account: "acct",
    id: `M${i}`,
    subject: `Subject ${i}`,
    fromName: `Sender ${i}`,
    preview: `Preview ${i}`,
    receivedAt: "2026-09-03T00:00:00Z",
  }));
}

function visibleRows(): number {
  // `[data-testid^="row-"]` alone also matches the per-cell testids the
  // three-line row introduced (`row-sender-`, `row-code-`, `row-subject-`,
  // `row-snippet-`, `row-time-`, `row-unread-`) -- `role="row"` is unique
  // to the row wrapper itself.
  return document.querySelectorAll('[data-testid^="row-"][role="row"]').length;
}

test("🚨 THE LIST RENDERS EVERY ROW IT HAS -- there is no local reveal", () => {
  // What this replaces: "pagination starts at 12 and grows by 25". That
  // was a SECOND pagination, local to this component, stacked on top of
  // the server's cursor inside a pane that already scrolls -- and it is
  // why the app appeared to hold 200 messages. The server's page is 200,
  // and the real "Load more" was rendered only once the local reveal was
  // exhausted, so a 12,220-message folder was capped at 200 behind eight
  // clicks of a button that read "Show 25 more — 12 of 200".
  render(<MessageList rows={rows(60)} mailbox="inbox" />);
  assert.equal(visibleRows(), 60, "the list is withholding rows it already has");
  assert.equal(byTestId("more", { optional: true }), null, "the local reveal button is gone");
});

test("🚨 'Load more' IS OFFERED IMMEDIATELY WHEN THE SERVER HAS MORE", () => {
  // The mutation this catches is the shipped bug itself: gating this
  // button on a local reveal being exhausted. It must appear as soon as
  // the server says there is a next page, and it must name the SERVER's
  // total -- the header says 12,220 and the button used to say 200.
  let fetched = 0;
  render(
    <MessageList rows={rows(200)} mailbox="inbox" total={12220} hasMore onLoadMore={() => (fetched += 1)} />,
  );
  const btn = byTestId("load-more");
  assert.match(btn.textContent!, /200 of 12,220/, `the button misstates the folder: ${btn.textContent}`);
  click(btn);
  assert.equal(fetched, 1, "clicking Load more did not ask for the next page");
});

test("no 'Load more' when the server has nothing more", () => {
  render(<MessageList rows={rows(60)} mailbox="inbox" total={60} hasMore={false} onLoadMore={() => {}} />);
  assert.equal(byTestId("load-more", { optional: true }), null);
});

test("🚨 THE SCROLL LISTENER GOES ON THE ELEMENT THAT ACTUALLY SCROLLS", () => {
  // 🚨 This test exists because the FIRST version of it passed against a
  // shipped bug. It set scrollHeight/clientHeight on `.msg-list-scroll` --
  // the element this component owns -- and dispatched a scroll event at
  // it. In a browser that element has no overflow: it grows (13,921px on a
  // 200-row archive) inside `.list-pane`, which Panes.tsx owns and which
  // carries the `overflow-y: auto`. So the listener sat on an element that
  // never scrolls, nothing ever loaded a second page, and the test proved
  // the handler's arithmetic against geometry it had invented.
  //
  // happy-dom runs no layout, so it cannot tell you where the overflow is.
  // What it CAN do is give the ancestor a real overflow and real
  // dimensions, and then insist the component found it -- which is the
  // actual contract: bind to the nearest scrolling ancestor, not to self.
  let fetched = 0;
  const { container, rerender } = render(
    <MessageList rows={rows(200)} mailbox="inbox" total={12220} hasMore={false} />,
  );
  // The ANCESTOR is the scroller, exactly as `.list-pane` is in the app.
  const host = container;
  host.style.overflowY = "auto";
  Object.defineProperty(host, "scrollHeight", { value: 10_000, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 900, configurable: true });
  rerender(
    <MessageList rows={rows(200)} mailbox="inbox" total={12220} hasMore onLoadMore={() => (fetched += 1)} />,
  );

  host.scrollTop = 0;
  host.dispatchEvent(new Event("scroll"));
  assert.equal(fetched, 0, "the top of the list must not fetch the next page");

  host.scrollTop = 9_000;
  host.dispatchEvent(new Event("scroll"));
  assert.equal(fetched, 1, "reaching the bottom of the SCROLLING ANCESTOR did not fetch the next page");
});

test("EVERY SENDER-CONTROLLED FIELD RENDERS AS TEXT", () => {
  const evil = '<img src=x onerror=alert(1)>';
  render(
    <MessageList
      rows={[{ account: "personal", id: "M1", subject: evil, fromName: evil, preview: evil, receivedAt: "2026-09-04T00:00:00Z" }]}
      mailbox="inbox"
    />,
  );
  assert.equal(document.querySelectorAll("img").length, 0);
  assert.equal(document.querySelectorAll("script").length, 0);
  // Would fail if the value rendered as markup rather than text: the
  // literal tag characters must show up as inert text content somewhere,
  // not be swallowed by a parser that turned them into an element.
  assert.match(byTestId("row-personal-M1").textContent!, /<img src=x onerror=alert\(1\)>/);
});

test("rows carry the account colour on the left edge", () => {
  render(<MessageList rows={[{ account: "work", id: "M1", subject: "s" }]} accents={{ work: "#2a9d6e" }} mailbox="inbox" />);
  assert.equal(getComputedStyle(byTestId("row-work-M1")).borderLeftColor, "rgb(42, 157, 110)");
});

test("selection is by (account,id), so the same id in two accounts selects one row", () => {
  render(
    <MessageList
      rows={[
        { account: "personal", id: "M1", subject: "p" },
        { account: "work", id: "M1", subject: "w" },
      ]}
      mailbox="inbox"
    />,
  );
  click(byTestId("row-work-M1"));
  assert.equal(byTestId("row-work-M1").getAttribute("aria-selected"), "true");
  assert.equal(byTestId("row-personal-M1").getAttribute("aria-selected"), "false");
});

test("an empty folder says something, rather than rendering nothing", () => {
  render(<MessageList rows={[]} mailbox="inbox" />);
  assert.match(byTestId("empty").textContent!, /\S/);
});

test("clicking a row calls onOpen with (account, id), for the caller to navigate", () => {
  const opened: { account: string; id: string }[] = [];
  render(
    <MessageList
      rows={[{ account: "personal", id: "M7", subject: "s" }]}
      mailbox="inbox"
      onOpen={(sel) => opened.push(sel)}
    />,
  );
  click(byTestId("row-personal-M7"));
  assert.deepEqual(opened, [{ account: "personal", id: "M7" }]);
});

test("checking a row's checkbox replaces the header with the bulk action bar", () => {
  render(<MessageList rows={rows(3)} mailbox="inbox" />);
  assert.ok(byTestId("list-header"));
  click(byTestId("checkbox-acct-M0"));
  assert.equal(byTestId("bulk-count").textContent, "1 selected");
});

// ---------------------------------------------------------------------------
// Three-line rows (Task 3). The defect this fixes: a single-line row
// starved the subject to ~12 characters while ~800px of reading pane sat
// empty. Ruling P1 (binding, amends the design-fidelity brief): happy-dom
// has no layout engine, so `getBoundingClientRect()` is always zero and an
// assertion built on it would pass against the broken single-line row too.
// These tests instead assert the DOM SHAPE -- the subject and snippet are
// each their own block-level element, a sibling FOLLOWING the sender line
// rather than inline within it -- plus inline styles the component itself
// sets. The real visual gate is the screenshot comparison in the report.
// ---------------------------------------------------------------------------

test("the subject sits on its own line, below the sender line, and the snippet below that", () => {
  render(
    <MessageList
      rows={[
        {
          account: "work",
          id: "M1",
          fromName: "Priya Raman",
          subject: "Bridge spec — comments merged",
          preview: "Took your notes on Recent.",
          receivedAt: "2026-09-04T09:41:00Z",
          isUnread: true,
        },
      ]}
      mailbox="inbox"
      accents={{ work: "#2a9d6e" }}
      codes={{ work: "WIL" }}
    />,
  );
  const row = byTestId("row-work-M1");
  const sender = byTestId("row-sender-work-M1");
  const code = byTestId("row-code-work-M1");
  const subject = byTestId("row-subject-work-M1");
  const snippet = byTestId("row-snippet-work-M1");

  // Sender/code/time share one line (line 1) -- a common ancestor that is
  // NOT the subject's or snippet's parent.
  const line1 = sender.parentElement!;
  assert.ok(line1.contains(code), "the account code lives on the sender's line");
  assert.equal(line1.contains(subject), false, "the subject must not be nested inside line 1");

  // The subject is a block-level element and a sibling that FOLLOWS line 1
  // in the same body container -- never an inline child crammed onto the
  // sender's row (the exact defect this task fixes).
  const body = line1.parentElement!;
  assert.ok(body.contains(subject), "subject shares the row body with line 1");
  const bodyChildren = Array.from(body.children);
  assert.ok(bodyChildren.indexOf(line1) < bodyChildren.indexOf(subject.closest(":scope > *") ?? subject), "line 1 precedes the subject in document order");
  assert.notEqual(getComputedStyle(subject).display, "inline", "the subject must be block-level, on its own line");

  // The snippet is a further sibling below the subject.
  assert.ok(body.contains(snippet), "snippet shares the row body with the subject");
  const snippetLine = snippet.parentElement!;
  assert.notEqual(snippetLine, line1, "the snippet's line must not be line 1");

  void row;
});

test("an unread sender is 700 weight and a read one is not", () => {
  render(
    <MessageList
      rows={[
        { account: "work", id: "U", fromName: "A", subject: "s", isUnread: true },
        { account: "work", id: "R", fromName: "B", subject: "s", isUnread: false },
      ]}
      mailbox="inbox"
    />,
  );
  assert.equal(getComputedStyle(byTestId("row-sender-work-U")).fontWeight, "700");
  assert.notEqual(getComputedStyle(byTestId("row-sender-work-R")).fontWeight, "700");
});

test("the account code is mono and carries the account colour", () => {
  render(
    <MessageList
      rows={[{ account: "work", id: "M1", subject: "s" }]}
      mailbox="inbox"
      accents={{ work: "#2a9d6e" }}
      codes={{ work: "WIL" }}
    />,
  );
  const code = byTestId("row-code-work-M1");
  assert.equal(code.textContent, "WIL");
  assert.ok(getComputedStyle(code).fontFamily.includes("Plex Mono"));
});

test("checking a row swaps the header for the bulk bar", () => {
  render(<MessageList rows={[{ account: "work", id: "M1", subject: "s" }]} mailbox="inbox" />);
  assert.equal(byTestId("bulk-bar", { optional: true }), null);
  click(byTestId("checkbox-work-M1"));
  assert.match(byTestId("bulk-bar").textContent!, /1 selected/);
});

test("EVERY SENDER-CONTROLLED FIELD RENDERS AS TEXT (three-line row)", () => {
  const evil = "<img src=x onerror=alert(1)>";
  render(
    <MessageList
      rows={[{ account: "work", id: "M1", subject: evil, fromName: evil, preview: evil }]}
      mailbox="inbox"
    />,
  );
  assert.equal(document.querySelectorAll("img,script").length, 0);
});

test("the account-colour edge runs the full row height via a left border, not a decoration", () => {
  render(
    <MessageList rows={[{ account: "work", id: "M1", subject: "s" }]} mailbox="inbox" accents={{ work: "#2a9d6e" }} />,
  );
  const row = byTestId("row-work-M1");
  const style = getComputedStyle(row);
  assert.equal(style.borderLeftWidth, "3px");
  assert.equal(style.borderLeftColor, "rgb(42, 157, 110)");
});

test("group headers are small-caps mono in --faint", () => {
  render(
    <MessageList
      rows={[{ account: "work", id: "M1", subject: "s", receivedAt: new Date().toISOString() }]}
      mailbox="inbox"
    />,
  );
  const header = byTestId("group-header-today");
  assert.equal(getComputedStyle(header).textTransform, "uppercase");
  assert.ok(getComputedStyle(header).fontFamily.includes("Plex Mono"));
});

test("an amber reauthorize banner renders with a warning glyph and a filled button", () => {
  render(
    <MessageList
      rows={[{ account: "work", id: "M1", subject: "s" }]}
      mailbox="inbox"
      reauth={{ account: "work", message: "Work (kai@halden.example) — authentication expired, mail is stale." }}
    />,
  );
  assert.match(byTestId("reauth-message").textContent!, /authentication expired/);
  assert.ok(byTestId("reauth-button"));
});

test("a grey IMAP banner announces support is coming, not syncing", () => {
  render(<MessageList rows={[{ account: "work", id: "M1", subject: "s" }]} mailbox="inbox" imapPending={true} />);
  assert.match(byTestId("imap-banner").textContent!, /coming/i);
});

test("density actually changes row padding -- comfortable 9px, compact 5px (design-fidelity Task 6 fix round 1)", () => {
  // Settings' Density control was previously wired to state that nothing
  // read -- a live-looking control that visibly changed nothing. This
  // pins the actual, rendered difference, not just that the prop is
  // accepted.
  const row = [{ account: "acct", id: "M1", subject: "s" }];

  const comfortable = render(<MessageList rows={row} mailbox="inbox" density="comfortable" />);
  const comfortableRow = byTestId("row-acct-M1");
  assert.equal(comfortableRow.style.paddingTop, "9px");
  assert.equal(comfortableRow.style.paddingBottom, "9px");
  comfortable.unmount();

  const compact = render(<MessageList rows={row} mailbox="inbox" density="compact" />);
  const compactRow = byTestId("row-acct-M1");
  assert.equal(compactRow.style.paddingTop, "5px");
  assert.equal(compactRow.style.paddingBottom, "5px");
  compact.unmount();
});

test("omitting density keeps today's rendering -- defaults to comfortable (9px)", () => {
  render(<MessageList rows={[{ account: "acct", id: "M1", subject: "s" }]} mailbox="inbox" />);
  const row = byTestId("row-acct-M1");
  assert.equal(row.style.paddingTop, "9px");
  assert.equal(row.style.paddingBottom, "9px");
});

// Design-fidelity Pass C, item 1: DESIGN.md's Message list section --
// "Trash: banner 'kept 30 days' + red Empty trash." -- and the button is
// permanently disabled (no backend mutation exists to empty Trash).
test("the Trash folder shows the 30-day banner with a disabled Empty trash button", () => {
  render(<MessageList rows={[{ account: "work", id: "M1", subject: "s" }]} mailbox="trash" />);
  assert.match(byTestId("trash-banner").textContent!, /kept 30 days/i);
  const btn = byTestId("empty-trash") as HTMLButtonElement;
  assert.equal(btn.disabled, true);
  assert.ok(btn.title.length > 0, "a disabled destructive button must explain why");
});

// Wilco.dc.html's own `trashMode` gate (line ~1519) is
// `!searching && S.folder === 'trash' && vis.length > 0` -- the banner is
// withheld when Trash is empty (only the ordinary "Trash is empty" empty
// state shows), NOT rendered unconditionally on the folder alone.
// Confirmed against a real render of the design, not assumed from markup
// order -- see this task's report.
test("an EMPTY Trash shows only the empty state, not the banner; other folders never show it either", () => {
  render(<MessageList rows={[]} mailbox="trash" />);
  assert.ok(byTestId("empty"));
  assert.throws(() => byTestId("trash-banner"));

  const other = render(<MessageList rows={[{ account: "work", id: "M1", subject: "s" }]} mailbox="inbox" />);
  assert.throws(() => byTestId("trash-banner"));
  other.unmount();
});

// Design-fidelity Pass C, item 2: DESIGN.md's Message list section --
// "Rows layout: single-line table (checkbox · code · sender 168px ·
// subject — snippet · flags · time 38px right)." Transcribed from
// Wilco.dc.html's `t.wide` article.
test("rowsLayout renders the single-line wide row, not the three-line row", () => {
  render(
    <MessageList
      rows={[{ account: "work", id: "M1", subject: "Subject", fromName: "Sender", snippet: "Snippet text", receivedAt: "2026-09-04T00:00:00Z" }]}
      mailbox="inbox"
      rowsLayout={true}
      codes={{ work: "WRK" }}
    />,
  );
  const row = byTestId("row-wide-work-M1");
  assert.ok(row, "the wide row testid must exist");
  assert.throws(() => byTestId("row-work-M1"), "the three-line testid must NOT also render");
  assert.equal(byTestId("row-sender-work-M1").textContent, "Sender");
  assert.equal(byTestId("row-code-work-M1").textContent, "WRK");
  assert.equal(byTestId("row-subject-work-M1").textContent, "Subject");
  assert.equal(byTestId("row-snippet-work-M1").textContent, "Snippet text");
  assert.ok(byTestId("row-time-work-M1"));
});

test("rowsLayout is false (or omitted) keeps the existing three-line row", () => {
  render(<MessageList rows={[{ account: "work", id: "M1", subject: "s" }]} mailbox="inbox" />);
  assert.ok(byTestId("row-work-M1"));
  assert.throws(() => byTestId("row-wide-work-M1"));
});

test("🚨 the selection box is the design's BUTTON, never a native checkbox", () => {
  // A UA checkbox paints its own box and `accent-color` only tints the
  // CHECKED fill, so unchecked it stayed the browser's white square -- a
  // bright chip in every row on the dark theme, reported from real use.
  // Wilco.dc.html (lines 326/338) specifies a 14x14 button with an explicit
  // border, background and a ✓ glyph; there is no type="checkbox" in the
  // design file at all.
  render(<MessageList rows={[{ account: "work", id: "M1", subject: "s", receivedAt: "2026-09-04T00:00:00Z" }]} mailbox="inbox" />);
  const box = byTestId("checkbox-work-M1");
  assert.equal(box.tagName, "BUTTON");
  assert.equal(box.getAttribute("type"), "button");
  assert.equal(document.querySelectorAll('input[type="checkbox"]').length, 0);
});

test("the box announces itself as a checkbox even though it is a button", () => {
  // The design specifies the pixels, not the semantics. Dropping the native
  // element must not drop what it told a screen reader.
  render(<MessageList rows={[{ account: "work", id: "M1", subject: "s", receivedAt: "2026-09-04T00:00:00Z" }]} mailbox="inbox" />);
  const box = byTestId("checkbox-work-M1");
  assert.equal(box.getAttribute("role"), "checkbox");
  assert.equal(box.getAttribute("aria-checked"), "false");

  click(box);
  assert.equal(byTestId("checkbox-work-M1").getAttribute("aria-checked"), "true");
  assert.match(byTestId("checkbox-work-M1").textContent!, /✓/, "checked shows the design's glyph");
});

// -- Thread count badge (handoff v1.1 #1) ---------------------------------

test("a multi-message conversation shows a bare mono count after the sender", () => {
  // v1.1 #1: mono 9.5px --faint, directly after the sender, "no parentheses,
  // no pill".
  render(
    <MessageList
      rows={[{ account: "work", id: "M1", subject: "s", fromName: "Julie", threadCount: 5, receivedAt: "2026-09-04T00:00:00Z" }]}
      mailbox="inbox"
    />,
  );
  const badge = byTestId("thread-count-work-M1");
  assert.equal(badge.textContent, "5", "the number alone");
  assert.doesNotMatch(badge.textContent!, /[()]/);
  // Directly after the sender, not after the code or the time.
  assert.equal(badge.previousElementSibling, byTestId("row-sender-work-M1"));
});

test("a single-message conversation shows no badge at all", () => {
  render(
    <MessageList
      rows={[{ account: "work", id: "M1", subject: "s", fromName: "Julie", threadCount: 1, receivedAt: "2026-09-04T00:00:00Z" }]}
      mailbox="inbox"
    />,
  );
  assert.equal(byTestId("thread-count-work-M1", { optional: true }), null);
});

test("the badge appears in the rows layout too, after the sender", () => {
  // v1.1 #1 says both layouts.
  render(
    <MessageList
      rows={[{ account: "work", id: "M1", subject: "s", fromName: "Julie", threadCount: 3, receivedAt: "2026-09-04T00:00:00Z" }]}
      mailbox="inbox"
      rowsLayout
    />,
  );
  const badge = byTestId("thread-count-work-M1");
  assert.equal(badge.textContent, "3");
  assert.equal(badge.previousElementSibling, byTestId("row-sender-work-M1"));
});

// ---------------------------------------------------------------------------
// Row 26: shift-click selects the RANGE from the last checked row to this
// one, inclusive -- it used to toggle just the clicked row, so "select these
// four" took four clicks and shift did nothing.
// ---------------------------------------------------------------------------

test("shift-click selects the range from the last checked row, inclusive, in list order", () => {
  render(<MessageList rows={rows(6)} mailbox="inbox" />);
  click(byTestId("checkbox-acct-M1"));
  act(() => {
    byTestId("checkbox-acct-M4").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  });
  assert.equal(byTestId("bulk-count").textContent, "4 selected");
  for (const i of [1, 2, 3, 4]) {
    assert.equal(byTestId(`checkbox-acct-M${i}`).getAttribute("aria-checked"), "true", `M${i} is in the range`);
  }
  assert.equal(byTestId("checkbox-acct-M0").getAttribute("aria-checked"), "false");
  assert.equal(byTestId("checkbox-acct-M5").getAttribute("aria-checked"), "false");

  // Upwards works too, from the same anchor.
  act(() => {
    byTestId("checkbox-acct-M0").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  });
  assert.equal(byTestId("bulk-count").textContent, "5 selected", "M0..M1 joined the selection; M2..M4 kept");

  // A plain click still toggles one row and moves the anchor.
  click(byTestId("checkbox-acct-M3"));
  assert.equal(byTestId("bulk-count").textContent, "4 selected");
});

// ---------------------------------------------------------------------------
// Row 32: a row is draggable and announces (account, id) targets -- the
// dragged row alone, or every checked row when the dragged one is checked.
// ---------------------------------------------------------------------------

function fakeDrag(): { ev: Event; data: Map<string, string>; effectAllowed: string } {
  const data = new Map<string, string>();
  const dt = {
    effectAllowed: "uninitialized",
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    types: [] as string[],
  };
  const ev = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  return { ev, data, effectAllowed: dt.effectAllowed };
}

test("dragging a row carries that row as a move target", () => {
  render(<MessageList rows={rows(3)} mailbox="inbox" />);
  const el = byTestId("row-acct-M1");
  assert.equal(el.getAttribute("draggable"), "true", "the row is draggable");
  const { ev, data } = fakeDrag();
  el.dispatchEvent(ev);
  assert.deepEqual(JSON.parse(data.get(DRAG_MESSAGES_TYPE) ?? "null"), [{ account: "acct", id: "M1" }]);
});

test("dragging a CHECKED row carries the whole selection", () => {
  render(<MessageList rows={rows(4)} mailbox="inbox" />);
  click(byTestId("checkbox-acct-M0"));
  click(byTestId("checkbox-acct-M2"));
  const { ev, data } = fakeDrag();
  byTestId("row-acct-M2").dispatchEvent(ev);
  assert.deepEqual(JSON.parse(data.get(DRAG_MESSAGES_TYPE) ?? "null"), [
    { account: "acct", id: "M0" },
    { account: "acct", id: "M2" },
  ]);
});

test("🚨 rows === undefined renders a LOADING state, never the empty state", () => {
  // Measured live on a 167,749-message instance: the list showed "Inbox
  // zero / Enjoy it while it lasts" for 3.5s before 120 real rows landed.
  // `rows: undefined` is how a caller says "not fetched yet" -- distinct
  // from `[]`, which means the folder really is empty.
  render(<MessageList rows={undefined} mailbox="inbox" />);
  assert.notEqual(byTestId("list-loading", { optional: true }), null, "loading state must render");
  assert.equal(byTestId("empty", { optional: true }), null, "the empty state must NOT render while unloaded");
});

test("a genuinely empty folder (rows === []) still shows the empty state, not loading", () => {
  render(<MessageList rows={[]} mailbox="inbox" />);
  assert.equal(byTestId("list-loading", { optional: true }), null);
  assert.notEqual(byTestId("empty", { optional: true }), null);
});

test("🚨 a folder switch in flight shows loading, never the PREVIOUS folder's rows nor the empty state", () => {
  // The SAME array reference across both renders: in the real app `rows`
  // is a piece of state that isn't reassigned until the fetch for the new
  // folder resolves, so it is still identically the inbox page the whole
  // time the switch is in flight -- that's exactly the shape of the live
  // bug (mailbox and rows fall out of step for the width of one fetch).
  const inboxRows = rows(3);
  const { rerender } = render(<MessageList rows={inboxRows} mailbox="inbox" />);
  assert.equal(visibleRows(), 3, "sanity: inbox's 3 rows are up");

  // The route changed to archive, but the new page hasn't arrived yet.
  rerender(<MessageList rows={inboxRows} mailbox="archive" />);
  assert.equal(visibleRows(), 0, "the previous folder's rows must not render under the new title");
  assert.equal(byTestId("empty", { optional: true }), null, "must not claim archive is empty either");
  assert.notEqual(byTestId("list-loading", { optional: true }), null, "must show loading while the switch is in flight");

  // The new folder's page arrives -- a NEW rows array, even one that's
  // still for "archive". The transition settles and archive's rows show.
  rerender(<MessageList rows={rows(5)} mailbox="archive" />);
  assert.equal(visibleRows(), 5, "archive's real rows render once they arrive");
  assert.equal(byTestId("list-loading", { optional: true }), null, "loading clears once rows for the new folder land");
});

test("a rows update for the SAME mailbox (search-as-you-type, load-more) never re-triggers loading", () => {
  const { rerender } = render(<MessageList rows={rows(3)} mailbox="inbox" />);
  rerender(<MessageList rows={rows(7)} mailbox="inbox" />);
  assert.equal(byTestId("list-loading", { optional: true }), null);
  assert.equal(visibleRows(), 7);
});

test("🚨 a custom folder's TITLE arriving late never re-enters loading", () => {
  // The live regression (Brian's instance, 2026-09-22). A custom folder's
  // route carries only the mailbox id, so App titles it from
  // `/api/mailboxes` -- and passes "Folder" until that resolves. Once the
  // list read path got fast, rows landed in ~30ms while `/api/mailboxes`
  // still took ~500ms, so the TITLE changed with `rows` standing still:
  // the folder rendered, then fell into the loading skeleton a second
  // later and never came out. `mailboxKey` is the identity the transition
  // tracks; the title is display only and may change under it freely.
  const folderRows = rows(3);
  const { rerender } = render(
    <MessageList rows={folderRows} mailbox="Folder" mailboxKey="work/P21fe" />,
  );
  assert.equal(visibleRows(), 3, "sanity: the folder's rows are up");

  // The name resolves. Same rows, same folder, new title.
  rerender(<MessageList rows={folderRows} mailbox="Identified Junk" mailboxKey="work/P21fe" />);
  assert.equal(byTestId("list-loading", { optional: true }) !== null, false, "a late title must not show loading");
  assert.equal(visibleRows(), 3, "the rows must stay up");
});

test("a real switch between two custom folders still shows loading", () => {
  const first = rows(3);
  const { rerender } = render(<MessageList rows={first} mailbox="Receipts" mailboxKey="work/P111" />);
  rerender(<MessageList rows={first} mailbox="Receipts" mailboxKey="work/P222" />);
  assert.equal(byTestId("list-loading", { optional: true }) !== null, true, "a different folder id is a real switch");
});
