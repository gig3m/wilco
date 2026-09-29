import type { DatabaseSync } from "node:sqlite";

/**
 * Owner-wide preferences (checklist row 37). One row per key, every key
 * known here with its allowed values and its default, so Settings, the
 * API and the code that ACTS on a preference all agree on what exists.
 *
 * A preference is added here only together with the behaviour it drives
 * -- a switch that stores a value nothing reads is the placeholder row 37
 * exists to remove.
 */
export const PREFERENCES = {
  theme: { values: ["light", "dark"], default: "light" },
  density: { values: ["comfortable", "compact"], default: "comfortable" },
  layout: { values: ["columns", "rows"], default: "columns" },
  /** When an open message counts as read: at once, after a 2s dwell, or
   *  only when the reader says so (`u`/the row menu). Drives App's
   *  read-on-open timer. */
  markRead: { values: ["instant", "after2s", "manual"], default: "after2s" },
  /** Remote images in HTML mail: loaded for every message, or blocked
   *  until asked for (per message, or "always from this sender"). Drives
   *  the body loader's starting state. */
  remoteImages: { values: ["always", "ask"], default: "ask" },
  /** One row per conversation, or one per message. Drives the list
   *  query's `group` filter. */
  groupConversations: { values: ["on", "off"], default: "on" },
  /** A reply starts with the original quoted below it (on), or empty. */
  quoteHistory: { values: ["on", "off"], default: "on" },
  /** `r` and the Reply button mean reply-all (on) or reply (off). */
  replyAllDefault: { values: ["on", "off"], default: "off" },
  /** After a reply is sent, the message replied to is archived. Off by
   *  default: a side effect the owner did not have before is opted into,
   *  not discovered. */
  archiveOnReply: { values: ["on", "off"], default: "off" },
  /** Launching at `/` opens All inboxes (on) or the first account's inbox
   *  in the owner's order (off). */
  unifiedInboxAtLaunch: { values: ["on", "off"], default: "on" },
  /** The new-mail toast in the corner: shown (on) or not. */
  notifDesktop: { values: ["on", "off"], default: "on" },
  /** Toast only for people the account has written to -- receipts, robots
   *  and newsletters stay quiet. Off by default: muting is opted into. */
  notifPeopleOnly: { values: ["on", "off"], default: "off" },
  /** A short tone with the toast. */
  notifSound: { values: ["on", "off"], default: "off" },
  /** Where the signature goes in a reply: above the quote (adjacent to the
   *  owner's message) or below it. HTML compose spec 3.6. */
  signaturePlacement: { values: ["above", "below"], default: "above" },
} as const satisfies Record<string, { values: readonly string[]; default: string }>;

export type PreferenceKey = keyof typeof PREFERENCES;
export type Preferences = { [K in PreferenceKey]: (typeof PREFERENCES)[K]["values"][number] };

export function isPreferenceKey(key: string): key is PreferenceKey {
  return Object.prototype.hasOwnProperty.call(PREFERENCES, key);
}

export function isPreferenceValue(key: PreferenceKey, value: string): boolean {
  return (PREFERENCES[key].values as readonly string[]).includes(value);
}

export function defaultPreferences(): Preferences {
  const out: Record<string, string> = {};
  for (const [k, spec] of Object.entries(PREFERENCES)) out[k] = spec.default;
  return out as Preferences;
}

/** Every preference, stored value or default. A stored value that is no
 *  longer allowed (a renamed option) falls back to the default rather
 *  than leaking an unknown string into the client. */
export function getPreferences(db: DatabaseSync): Preferences {
  const prefs = defaultPreferences() as Record<string, string>;
  const rows = db.prepare(`SELECT key, value FROM preferences`).all() as { key: string; value: string }[];
  for (const r of rows) {
    if (isPreferenceKey(r.key) && isPreferenceValue(r.key, r.value)) prefs[r.key] = r.value;
  }
  return prefs as Preferences;
}

export function setPreference(db: DatabaseSync, key: PreferenceKey, value: string, now: () => number = Date.now): void {
  if (!isPreferenceValue(key, value)) throw new Error(`preference ${key} cannot be "${value}"`);
  db.prepare(
    `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date(now()).toISOString());
}
