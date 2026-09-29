// The URL model. A route names a mailbox, WHICH ACCOUNTS THE LIST SHOWS,
// and which message (if any) is open -- three facts, deliberately kept
// apart.
//
// 🚨 THEY USED TO BE TWO. `Route` had one `account` field doing double
// duty: "filter the list to this account" AND "the open message lives in
// this account". Opening anything from a unified view therefore filtered
// the list to that message's account. Measured on the live app: All
// inboxes went 13 messages -> 8 on a click, All-accounts Archive went
// 25,208 -> 12,792, and in the unified inbox a single press of `j` (which
// opens the first row) collapsed the list to one message and left `j`/`k`
// with nowhere to go. The unified inbox is this application's entire
// premise, and one keystroke destroyed it.
//
// The old notes recorded this as "opening a message from the unified inbox
// narrows the list to that account", filed under known-and-not-fixed. That
// wording undersells it -- it reads like a cosmetic quirk rather than "the
// main view cannot be read through" -- which is part of why it sat.
//
// Deliberately never validates against a known mailbox or account list:
// this module has no access to that data and must not fail closed on a
// value it simply hasn't seen yet (a new account, a renamed mailbox).
//
// `parseRoute` never throws. An empty or malformed path falls back to the
// unified inbox (spec: "an unknown path falls back to the unified inbox
// rather than erroring") -- a bookmarked URL, a typo, or a stale link must
// never hard-fail the SPA.
//
// Mailbox/account/id are opaque server strings (ids especially -- spec
// 4.2), never assumed to be URL-safe. Each segment is percent-encoded on
// the way out (`routeToPath`) and decoded on the way in (`parseRoute`), so
// a `/`, `%`, `#`, `?` or space inside one doesn't corrupt the path or get
// misread as a path separator/query/fragment.
//
// The four URL shapes:
//
//   /inbox                        unified list, nothing open
//   /inbox/personal               one account's list, nothing open
//   /inbox/personal/M1            one account's list, M1 open        (*)
//   /inbox/all/personal/M1        UNIFIED list, personal's M1 open
//
// (*) The three-segment form is what every existing link, bookmark and
// test uses, and it still means exactly what it did. Only the unified-list
// case needed a new shape, because "no filter" had no spelling.

/** The sentinel in the filter position meaning "every account". Cannot
 *  collide with a real account key: those come from the accounts table and
 *  this value is only ever produced by `routeToPath`, which writes it in a
 *  four-segment path where a real key would be ambiguous anyway. */
const ALL = "all";

export interface Route {
  mailbox: string;
  /** Which account the LIST is filtered to. `null` is the unified view. */
  filter: string | null;
  /** The open message's account. Independent of `filter`: a message in
   *  `personal` can be open while the list still shows all accounts. */
  account: string | null;
  id: string | null;
  /** `/print/{account}/{id}`: the print document for one message (row 33),
   *  rendered INSTEAD of the app shell. Carries no list state -- it opens
   *  in its own window. */
  print?: boolean;
  /** `/folder/{account}/{mailboxId}[/{id}]`: a CUSTOM folder (row 37 --
   *  custom folders could not be opened at all). Folders with a role keep
   *  their role routes; a custom folder has no role, so it is addressed by
   *  its mailbox id, scoped to `filter` (the account). `mailbox` is the
   *  literal "folder" on such a route. */
  mailboxId?: string;
}

export function parseRoute(pathname: string): Route {
  const segments = pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        // A malformed percent-escape is not a reason to hard-fail routing.
        return s;
      }
    });

  if (segments.length === 0) {
    return { mailbox: "inbox", filter: null, account: null, id: null };
  }

  const [mailbox, a = null, b = null, c = null] = segments;

  if (mailbox === "print" && a !== null && b !== null && c === null) {
    return { mailbox: "inbox", filter: null, account: a, id: b, print: true };
  }
  if (mailbox === "folder" && a !== null && b !== null) {
    return c !== null
      ? { mailbox: "folder", filter: a, account: a, id: c, mailboxId: b }
      : { mailbox: "folder", filter: a, account: null, id: null, mailboxId: b };
  }

  // Four segments: the filter is stated separately from the message.
  if (c !== null) {
    return { mailbox: mailbox!, filter: a === ALL ? null : a, account: b, id: c };
  }
  // Three: one account's list, with one of its messages open.
  if (b !== null) {
    return { mailbox: mailbox!, filter: a, account: a, id: b };
  }
  // Two: one account's list. One: the unified list.
  return { mailbox: mailbox!, filter: a === ALL ? null : a, account: null, id: null };
}

export function routeToPath(r: Route): string {
  const open = r.account !== null && r.id !== null;
  if (r.print === true && open) {
    return `/print/${encodeURIComponent(r.account!)}/${encodeURIComponent(r.id!)}`;
  }
  if (r.mailboxId !== undefined && r.filter !== null) {
    const base = `/folder/${encodeURIComponent(r.filter)}/${encodeURIComponent(r.mailboxId)}`;
    return open ? `${base}/${encodeURIComponent(r.id!)}` : base;
  }
  // The compact three-segment form whenever the filter and the open
  // message agree -- which is every link that existed before the filter
  // was a separate idea.
  const parts: (string | null)[] =
    open && r.filter === r.account
      ? [r.mailbox, r.account, r.id]
      : open
        ? [r.mailbox, r.filter ?? ALL, r.account, r.id]
        : [r.mailbox, r.filter];
  return "/" + parts.filter((s): s is string => s !== null).map(encodeURIComponent).join("/");
}
