import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import { tempDbPath } from "./tmpdir.ts";
import { defaultPreferences, getPreferences, setPreference, isPreferenceKey, isPreferenceValue } from "../src/core/preferences.ts";
import { PREFERENCES } from "../src/core/preferences.ts";

function db() {
  return openDb(tempDbPath());
}

test("row 37: every preference has a default, and an empty table yields exactly the defaults", () => {
  const d = db();
  assert.deepEqual(getPreferences(d), defaultPreferences());
  assert.deepEqual(getPreferences(d), {
    theme: "light", density: "comfortable", layout: "columns",
    markRead: "after2s", remoteImages: "ask", groupConversations: "on",
    quoteHistory: "on", replyAllDefault: "off", archiveOnReply: "off", unifiedInboxAtLaunch: "on",
    notifDesktop: "on", notifPeopleOnly: "off", notifSound: "off",
    signaturePlacement: "above",
  });
  d.close();
});

test("row 37: a preference written is a preference read back, and a rewrite replaces it", () => {
  const d = db();
  setPreference(d, "theme", "dark");
  assert.equal(getPreferences(d).theme, "dark");
  setPreference(d, "theme", "light");
  assert.equal(getPreferences(d).theme, "light");
  d.close();
});

test("row 37: an unknown key or a value outside the allowed set is refused, and a stale stored value falls back to the default", () => {
  const d = db();
  assert.equal(isPreferenceKey("colour"), false);
  assert.equal(isPreferenceValue("theme", "sepia"), false);
  assert.throws(() => setPreference(d, "theme", "sepia"), /cannot be/);
  // A value stored by an older build whose option was since renamed.
  d.prepare(`INSERT INTO preferences (key, value, updated_at) VALUES ('layout', 'split', '2026-01-01T00:00:00Z')`).run();
  assert.equal(getPreferences(d).layout, "columns");
  d.close();
});

test("signaturePlacement exists, defaults to above, and refuses anything else", () => {
  assert.equal(PREFERENCES.signaturePlacement?.default, "above");
  assert.deepEqual(PREFERENCES.signaturePlacement?.values, ["above", "below"]);
});
