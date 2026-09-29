import { test } from "vitest";
import assert from "node:assert/strict";
import { formatDetailTime, formatRowTime } from "./time";

// A fixed anchor so every case here is boundary-exact and clock-independent
// (the brief's own requirement). Wednesday, chosen so "this week" has
// distinct earlier weekdays (Mon, Tue) still inside the 6-day window.
const NOW = new Date(2026, 8, 9, 14, 30, 0); // Wed 2026-09-09 14:30 local

function at(y: number, m: number, d: number, h: number, min: number, s = 0): Date {
  return new Date(y, m, d, h, min, s);
}

test("formatRowTime: under 60s ago is 'now'", () => {
  assert.equal(formatRowTime(at(2026, 8, 9, 14, 29, 30).toISOString(), NOW), "now");
});

test("formatRowTime: exactly 60s ago is no longer 'now'", () => {
  assert.equal(formatRowTime(at(2026, 8, 9, 14, 29, 0).toISOString(), NOW), "14:29");
});

test("formatRowTime: later today renders a bare H:MM, hour not zero-padded", () => {
  assert.equal(formatRowTime(at(2026, 8, 9, 9, 41, 0).toISOString(), NOW), "9:41");
});

test("formatRowTime: minute is always two digits", () => {
  assert.equal(formatRowTime(at(2026, 8, 9, 18, 2, 0).toISOString(), NOW), "18:02");
});

test("formatRowTime: just before local midnight today is still 'today', not 'yesterday'", () => {
  assert.equal(formatRowTime(at(2026, 8, 9, 0, 0, 30).toISOString(), NOW), "0:00");
});

test("formatRowTime: yesterday renders as the bare weekday, never 'Yesterday'", () => {
  // NOW is Wed; yesterday is Tue.
  assert.equal(formatRowTime(at(2026, 8, 8, 23, 59, 0).toISOString(), NOW), "Tue");
});

test("formatRowTime: two days ago (this week) renders as the bare weekday", () => {
  assert.equal(formatRowTime(at(2026, 8, 7, 10, 0, 0).toISOString(), NOW), "Mon");
});

test("formatRowTime: six days ago is still this week", () => {
  assert.equal(formatRowTime(at(2026, 8, 3, 10, 0, 0).toISOString(), NOW), "Thu");
});

test("formatRowTime: seven or more days ago falls back to a plain date", () => {
  assert.equal(formatRowTime(at(2026, 8, 2, 10, 0, 0).toISOString(), NOW), "Sep 2");
});

test("formatRowTime: a prior year includes the year", () => {
  assert.equal(formatRowTime(at(2025, 11, 25, 10, 0, 0).toISOString(), NOW), "Dec 25, 2025");
});

test("formatRowTime: missing or invalid input renders empty", () => {
  assert.equal(formatRowTime(undefined, NOW), "");
  assert.equal(formatRowTime(null, NOW), "");
  assert.equal(formatRowTime("not a date", NOW), "");
});

test("formatDetailTime: under 60s ago is 'Just now'", () => {
  assert.equal(formatDetailTime(at(2026, 8, 9, 14, 30, 0).toISOString(), NOW), "Just now");
});

test("formatDetailTime: later today is 'Today H:MM'", () => {
  assert.equal(formatDetailTime(at(2026, 8, 9, 9, 41, 0).toISOString(), NOW), "Today 9:41");
});

test("formatDetailTime: yesterday is 'Yesterday H:MM'", () => {
  assert.equal(formatDetailTime(at(2026, 8, 8, 18, 2, 0).toISOString(), NOW), "Yesterday 18:02");
});

test("formatDetailTime: this week (not today/yesterday) pairs the weekday with the time", () => {
  assert.equal(formatDetailTime(at(2026, 8, 7, 10, 12, 0).toISOString(), NOW), "Mon 10:12");
});

test("formatDetailTime: older than a week falls back to a plain date, same as the row formatter", () => {
  assert.equal(formatDetailTime(at(2026, 8, 2, 10, 0, 0).toISOString(), NOW), "Sep 2");
});

test("formatDetailTime: missing or invalid input renders empty", () => {
  assert.equal(formatDetailTime(undefined, NOW), "");
  assert.equal(formatDetailTime("garbage", NOW), "");
});
