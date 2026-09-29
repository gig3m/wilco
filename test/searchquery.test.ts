import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery } from "../src/core/searchquery.ts";

test("operators are removed from the text, not left in it", () => {
  const q = parseQuery("from:robin budget report");
  assert.deepEqual(q.from, ["robin"]);
  assert.equal(q.text, "budget report",
    "if 'from:robin' survived into text, FTS would search bodies for that literal");
});

test("AN UNRECOGNISED PREFIX IS A SEARCH TERM, NOT AN ERROR", () => {
  // Refusing to search for these would be worse than having no operators.
  for (const input of ["http://example.test", "re: your invoice", "note:something"]) {
    const q = parseQuery(input);
    assert.equal(q.text, input, `${input} must survive parsing untouched`);
    assert.deepEqual(q.from, []);
  }
});

test("a quoted value keeps its spaces", () => {
  const q = parseQuery('from:"robin halden" budget');
  assert.deepEqual(q.from, ["robin halden"]);
  assert.equal(q.text, "budget");
});

test("repeated operators accumulate as OR within a field", () => {
  const q = parseQuery("acct:personal acct:work invoice");
  assert.deepEqual(q.acct, ["personal", "work"]);
  assert.equal(q.text, "invoice");
});

test("is: and has: set tristate flags, and is:read is the negation", () => {
  assert.equal(parseQuery("is:unread").isUnread, true);
  assert.equal(parseQuery("is:read").isUnread, false);
  assert.equal(parseQuery("budget").isUnread, null, "null means 'no opinion', not false");
  assert.equal(parseQuery("is:flagged").isFlagged, true);
  assert.equal(parseQuery("has:attachment").hasAttachment, true);
});

test("dates parse to ISO bounds and newer_than is relative to now", () => {
  const now = () => new Date("2026-09-03T12:00:00Z");
  assert.equal(parseQuery("after:2026-01-01").after, "2026-01-01T00:00:00.000Z");
  assert.equal(parseQuery("before:2026-02-01").before, "2026-02-01T00:00:00.000Z");
  assert.equal(parseQuery("newer_than:7d", now).after, "2026-08-27T12:00:00.000Z");
});

test("AN UNPARSEABLE DATE IS A SEARCH TERM, NOT A SILENT EMPTY RESULT", () => {
  // The failure this prevents: before:lastweek quietly becoming
  // before:Invalid Date, which matches nothing, and the user seeing zero
  // results for a query they believe is valid.
  const q = parseQuery("before:lastweek budget");
  assert.equal(q.before, null);
  assert.equal(q.text, "before:lastweek budget");
});

test("an operator with an empty value is a term", () => {
  const q = parseQuery("from: budget");
  assert.equal(q.from.length, 0);
  assert.equal(q.text, "from: budget");
});

test("operator value case is lowercased, including addresses", () => {
  const q = parseQuery("From:Robin@Halden.EXAMPLE");
  assert.deepEqual(q.from, ["robin@halden.example"],
    "addresses lowercase to match email_recipients' write-side normalisation");
});

test("an unrecognised is:/has: sub-value degrades to a search term", () => {
  // The top-level unrecognised-prefix case is covered above; these are the
  // in-operator sub-value case -- a recognised prefix with a value this
  // module doesn't understand must still fall through to text, not vanish.
  const starred = parseQuery("is:starred budget");
  assert.equal(starred.isUnread, null);
  assert.equal(starred.isFlagged, null);
  assert.equal(starred.text, "is:starred budget");

  const banana = parseQuery("has:banana budget");
  assert.equal(banana.hasAttachment, null);
  assert.equal(banana.text, "has:banana budget");
});

test("cc: is parsed as its own operator, distinct from to:", () => {
  const q = parseQuery("cc:robin@halden.example budget");
  assert.deepEqual(q.cc, ["robin@halden.example"]);
  assert.deepEqual(q.to, []);
  assert.equal(q.text, "budget",
    "if cc: fell through to text, it would become a full-text phrase search instead of a recipient match");
});
