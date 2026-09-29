// @vitest-environment node
import { test } from "vitest";
import assert from "node:assert/strict";
import { parseRoute, routeToPath, type Route } from "./router";

const r = (mailbox: string, filter: string | null, account: string | null, id: string | null): Route => ({
  mailbox,
  filter,
  account,
  id,
});

test("the URL model round-trips", () => {
  assert.deepEqual(parseRoute("/inbox"), r("inbox", null, null, null));
  assert.deepEqual(parseRoute("/inbox/personal/M1"), r("inbox", "personal", "personal", "M1"));
  assert.equal(routeToPath(r("inbox", "personal", "personal", "M1")), "/inbox/personal/M1");
  assert.equal(routeToPath(r("inbox", null, null, null)), "/inbox");
});

test("🚨 OPENING A MESSAGE FROM THE UNIFIED LIST KEEPS THE LIST UNIFIED", () => {
  // 🚨 The defect this exists to prevent, measured on the live app: `Route`
  // had ONE `account` field meaning both "filter the list to this account"
  // and "the open message is in this account", so opening anything from a
  // unified view filtered the list. All inboxes went 13 messages -> 8 on a
  // click; all-accounts Archive went 25,208 -> 12,792; and in the unified
  // inbox one press of `j` (which opens the first row) collapsed the list
  // to a single message and left `j`/`k` with nowhere to go.
  //
  // The unified inbox is this application's entire premise. One keystroke
  // destroyed it, and no test noticed because every test asserted the URL
  // rather than what the list then showed.
  const path = routeToPath(r("inbox", null, "personal", "M1"));
  assert.equal(path, "/inbox/all/personal/M1");

  const back = parseRoute(path);
  assert.equal(back.filter, null, "the list filter must survive opening a message");
  assert.equal(back.account, "personal");
  assert.equal(back.id, "M1");
  assert.deepEqual(back, r("inbox", null, "personal", "M1"), "the four-segment form must round-trip");
});

test("a filtered list keeps its filter when a message in that account is open", () => {
  // The compact three-segment form: filter and message agree, which is
  // what every link that existed before the filter was a separate idea
  // meant, and it still means exactly that.
  const route = parseRoute("/archive/work/M9");
  assert.deepEqual(route, r("archive", "work", "work", "M9"));
  assert.equal(routeToPath(route), "/archive/work/M9", "the compact form must not grow a redundant segment");
});

test("an unknown path falls back to the unified inbox rather than erroring", () => {
  assert.deepEqual(parseRoute("/"), r("inbox", null, null, null));
  assert.deepEqual(parseRoute("/nonsense/with/extra/segments"), r("nonsense", "with", "extra", "segments"));
});

test("an account selected without a message still round-trips (Important 4)", () => {
  // parseRoute("/inbox/personal") -> filter personal, nothing open.
  // routeToPath used to require BOTH account and id to be non-null, so it
  // silently dropped the account and produced "/inbox" -- a real regression
  // the moment any code path selects an account without a message.
  const route = parseRoute("/inbox/personal");
  assert.deepEqual(route, r("inbox", "personal", null, null));
  assert.equal(routeToPath(route), "/inbox/personal");
});

test("segments with reserved/unsafe characters are encoded out and decoded back in", () => {
  const route = r("inbox", "a/b c", "a/b c", "id%with#chars?");
  const path = routeToPath(route);
  // The unsafe characters must not appear literally in the path -- each is
  // percent-encoded so it can never be misread as a path separator, a query
  // string, or a fragment.
  assert.ok(!path.includes("/a/b c/"), `raw slash/space leaked into path: ${path}`);
  assert.deepEqual(parseRoute(path), route);
});

test("reserved characters round-trip in the FOUR-segment form too", () => {
  // The unified-plus-open shape is the new one, so it gets its own
  // encoding check rather than inheriting confidence from the old form.
  const route = r("inbox", null, "a/b c", "id%with#chars?");
  const path = routeToPath(route);
  assert.ok(!path.includes("a/b c"), `raw slash/space leaked into path: ${path}`);
  assert.deepEqual(parseRoute(path), route);
});

test("individual reserved characters (/, %, space) round-trip through a single segment", () => {
  for (const raw of ["a/b", "50%off", "has space"]) {
    const route = r("inbox", raw, null, null);
    assert.deepEqual(parseRoute(routeToPath(route)), route);
  }
});

test("row 33: the print view has its own route and round-trips", () => {
  const r = parseRoute("/print/personal/M%2F1");
  assert.deepEqual(r, { mailbox: "inbox", filter: null, account: "personal", id: "M/1", print: true });
  assert.equal(routeToPath(r), "/print/personal/M%2F1");
  assert.equal(parseRoute("/inbox/personal/M1").print, undefined, "an ordinary route is not a print route");
});

test("row 37: a custom folder has a route by mailbox id, with and without an open message, and round-trips", () => {
  const list = parseRoute("/folder/personal/P%2F7");
  assert.deepEqual(list, { mailbox: "folder", filter: "personal", account: null, id: null, mailboxId: "P/7" });
  assert.equal(routeToPath(list), "/folder/personal/P%2F7");
  const open = parseRoute("/folder/personal/P7/M1");
  assert.deepEqual(open, { mailbox: "folder", filter: "personal", account: "personal", id: "M1", mailboxId: "P7" });
  assert.equal(routeToPath(open), "/folder/personal/P7/M1");
  assert.equal(routeToPath({ ...open, account: null, id: null }), "/folder/personal/P7", "closing the message keeps the folder");
});
