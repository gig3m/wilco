// @vitest-environment happy-dom
// Task 11: responsive layout. A separate file from App.test.tsx on purpose
// -- these tests mutate `window.innerWidth`, which is global and sticky,
// and interleaving them with the shell's other tests in one worker made the
// vitest worker die outright. The real gate for this task is the
// screenshots in the task report; happy-dom runs no layout engine, so what
// can be asserted here is WHICH elements exist at a given width, not
// whether they visually fit.
import { test } from "vitest";
import assert from "node:assert/strict";
import { act } from "preact/test-utils";
import { byTestId, click, fakeApi, fakeHistory, render, tick } from "../test-utils";
import { App, viewportFor } from "./App";

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

test("the breakpoint function puts 600 in the medium band, not the narrow one", () => {
  // The exit condition is "usable AT 600 CSS px" -- so 600 keeps the
  // sidebar and 599 is the phone.
  assert.equal(viewportFor(1440), "wide");
  assert.equal(viewportFor(1024), "wide");
  // 900 is MEDIUM: measured on a screenshot, the three-column layout at
  // 900px leaves a 262px reading pane whose action row runs off-screen.
  assert.equal(viewportFor(1023), "medium");
  assert.equal(viewportFor(900), "medium");
  assert.equal(viewportFor(600), "medium");
  assert.equal(viewportFor(599), "narrow");
  assert.equal(viewportFor(390), "narrow");
});

test("below 900px the reading pane overlays the list instead of taking a column", async () => {
  setViewportWidth(800);
  const { unmount } = render(<App api={fakeApi()} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  const overlay = byTestId("reading-overlay");
  assert.equal(overlay.style.position, "fixed", "it covers the list rather than sitting beside it");
  assert.equal(overlay.style.left, "242px", "and stops at the sidebar, which is still visible at this width");
  assert.equal(byTestId("sidebar").style.width, "242px");
  assert.equal(document.querySelector('[data-testid="divider-list"]'), null, "no drag divider in a collapsed layout");
  unmount();
  setViewportWidth(1440);
});

test("the compact reading overlay carries a way back to the list", async () => {
  setViewportWidth(800);
  const h = fakeHistory("/inbox/personal/M1");
  const { unmount } = render(<App api={fakeApi()} history={h} />);
  await tick();
  click(byTestId("reading-back"));
  await tick();
  assert.equal(h.path(), "/inbox/personal", "back to the list, message closed");
  assert.equal(document.querySelector('[data-testid="reading-overlay"]'), null);
  unmount();
  setViewportWidth(1440);
});

test("below 600px the sidebar is a drawer, not a column", async () => {
  setViewportWidth(390);
  const { unmount } = render(<App api={fakeApi()} />);
  await tick();
  assert.equal(document.querySelector('[data-testid="sidebar"]'), null, "no sidebar column on a phone");
  assert.equal(document.querySelector('[data-testid="drawer"]'), null, "and the drawer starts closed");

  click(byTestId("drawer-toggle"));
  await tick();
  assert.notEqual(document.querySelector('[data-testid="drawer"]'), null);
  assert.notEqual(document.querySelector('[data-testid="drawer-scrim"]'), null);
  assert.notEqual(document.querySelector('[data-testid="sidebar"]'), null, "the real sidebar renders inside it");

  click(byTestId("drawer-scrim"));
  await tick();
  assert.equal(document.querySelector('[data-testid="drawer"]'), null, "tapping the scrim closes it");
  unmount();
  setViewportWidth(1440);
});

test("on a phone an open message covers the whole width", async () => {
  setViewportWidth(390);
  const { unmount } = render(<App api={fakeApi()} history={fakeHistory("/inbox/personal/M1")} />);
  await tick();
  assert.equal(byTestId("reading-overlay").style.left, "0px", "no sidebar gutter to leave room for");
  unmount();
  setViewportWidth(1440);
});

test("a resize switches layouts without a remount", async () => {
  setViewportWidth(1440);
  const { unmount } = render(<App api={fakeApi()} />);
  await tick();
  assert.notEqual(document.querySelector('[data-testid="divider-list"]'), null, "wide layout to begin with");

  setViewportWidth(390);
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
  });
  await tick();
  assert.equal(document.querySelector('[data-testid="divider-list"]'), null);
  assert.notEqual(document.querySelector('[data-testid="drawer-toggle"]'), null, "now the phone layout");
  unmount();
  setViewportWidth(1440);
});
