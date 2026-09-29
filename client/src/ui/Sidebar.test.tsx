// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";
import { byTestId, click, fakeApi, px, render, tick } from "../test-utils";
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { Sidebar } from "./Sidebar";

function bar(account: string): HTMLElement {
  return byTestId(`account-bar-${account}`);
}

// Icons are Lucide SVG components now (Task: adopt Lucide icons), not text
// glyphs -- `createLucideIcon` stamps every icon's root `<svg>` with a
// `lucide-<kebab-name>` class (e.g. `lucide-inbox`) alongside the generic
// `lucide` class, so that's the icon's identity for a test, in place of
// the glyph character `.textContent` used to carry.
function iconName(container: HTMLElement): string | null {
  const svg = container.querySelector("svg");
  if (svg === null) return null;
  const match = /lucide-[a-z0-9-]+/.exec(svg.getAttribute("class") ?? "");
  return match !== null ? match[0] : null;
}

test("the sidebar is 242px and renders an account block per account with its code chip", async () => {
  render(
    <Sidebar
      api={fakeApi({
        accountsData: [
          { key: "personal", label: "Personal", accent: "#b05fc9", code: "PER" },
          { key: "work", label: "Work", accent: "#2a9d6e", code: "HAL" },
        ],
      })}
    />,
  );
  await tick();
  assert.equal(px(byTestId("sidebar")), 242);
  assert.equal(byTestId("account-code-work").textContent, "HAL");
  assert.equal(getComputedStyle(byTestId("account-code-work")).fontFamily.includes("Plex Mono"), true);
});

test("every folder row has an icon", async () => {
  // The design gives each folder a distinct glyph; a text-only list is the
  // single most obvious way this reads as unstyled.
  render(
    <Sidebar
      api={fakeApi({
        mailboxesData: [
          { account: "personal", id: "P-F", role: "inbox", name: "Inbox", unread: 3 },
          { account: "personal", id: "P-D", role: "drafts", name: "Drafts", unread: 0 },
        ],
      })}
    />,
  );
  await tick();
  for (const role of ["inbox", "drafts"]) {
    assert.ok(byTestId(`folder-icon-personal-${role}`), `${role} has no icon`);
  }
});

test("every base folder role (inbox/drafts/sent/archive/spam/trash) gets a distinct icon", async () => {
  render(
    <Sidebar
      api={fakeApi({
        mailboxesData: [
          { account: "personal", id: "F1", role: "inbox", name: "Inbox" },
          { account: "personal", id: "F2", role: "drafts", name: "Drafts" },
          { account: "personal", id: "F3", role: "sent", name: "Sent" },
          { account: "personal", id: "F4", role: "archive", name: "Archive" },
          { account: "personal", id: "F5", role: "spam", name: "Spam" },
          { account: "personal", id: "F6", role: "trash", name: "Trash" },
        ],
      })}
    />,
  );
  await tick();
  const icons = ["inbox", "drafts", "sent", "archive", "spam", "trash"].map((role) =>
    iconName(byTestId(`folder-icon-personal-${role}`)),
  );
  assert.equal(new Set(icons).size, 6, `expected 6 distinct icons, got ${JSON.stringify(icons)}`);
});

test("add-account is enabled and opens the onboarding modal", () => {
  // Compose (Task 5), Settings (Task 6) and add-account (Task 7) are all
  // real, reachable surfaces now -- only the individual controls INSIDE
  // Compose/Settings stay disabled (Compose.test.tsx, Settings.test.tsx).
  let opened = 0;
  render(<Sidebar api={fakeApi()} onOpenAddAccount={() => (opened += 1)} />);
  const addAccountBtn = byTestId("add-account");
  assert.equal(addAccountBtn.hasAttribute("disabled"), false);
  click(addAccountBtn);
  assert.equal(opened, 1);
});

test("compose is enabled and opens the compose pane", () => {
  let opened = 0;
  render(<Sidebar api={fakeApi()} onCompose={() => (opened += 1)} />);
  const composeBtn = byTestId("compose");
  assert.equal(composeBtn.hasAttribute("disabled"), false);
  click(composeBtn);
  assert.equal(opened, 1);
});

test("settings is enabled and reachable", () => {
  let opened = 0;
  render(<Sidebar api={fakeApi()} onOpenSettings={() => (opened += 1)} />);
  const settingsBtn = byTestId("settings");
  assert.equal(settingsBtn.hasAttribute("disabled"), false);
  click(settingsBtn);
  assert.equal(opened, 1);
});

test("a hostile folder name is text, not markup", async () => {
  render(
    <Sidebar
      api={fakeApi({
        mailboxesData: [{ account: "personal", id: "F1", role: null, name: "<img src=x onerror=alert(1)>", unread: 0 }],
      })}
    />,
  );
  await tick();
  assert.equal(document.querySelectorAll("img").length, 0);
  assert.ok(document.body.textContent!.includes("<img src=x onerror=alert(1)>"));
});

test("each account block renders its own accent from the API, not a constant", async () => {
  render(
    <Sidebar
      api={fakeApi({
        accountsData: [
          { key: "personal", label: "Personal", accent: "#b05fc9" },
          { key: "work", label: "Work", accent: "#2a9d6e" },
        ],
      })}
    />,
  );
  await tick();
  assert.equal(bar("personal").style.background, "rgb(176, 95, 201)");
  assert.equal(bar("work").style.background, "rgb(42, 157, 110)");
});

test("total unread is the sum across accounts, from the junction-backed API", async () => {
  render(
    <Sidebar
      api={fakeApi({
        mailboxesData: [
          { account: "personal", id: "P-F", role: "inbox", unread: 3 },
          { account: "work", id: "P-F", role: "inbox", unread: 4 },
        ],
      })}
    />,
  );
  await tick();
  assert.equal(byTestId("total-unread").textContent, "7 unread");
});

test("🚨 the headline counts INBOX unread only -- never the archive", async () => {
  // Audit pass 4. Summing every mailbox read "774 unread" on the live
  // archive while every inbox was at zero, 598 of it from work/Archive.
  // The design's `unreadFor` filters `effFolder(t) === 'inbox'`; a number a
  // person reads as "things waiting for me" must not count filed mail.
  render(
    <Sidebar
      api={fakeApi({
        mailboxesData: [
          { account: "personal", id: "P-I", role: "inbox", unread: 2 },
          { account: "personal", id: "P-A", role: "archive", unread: 598, total: 16559 },
          { account: "personal", id: "P-T", role: "trash", unread: 77, total: 43 },
          { account: "personal", id: "P-D", role: "drafts", unread: 3, total: 3 },
        ],
      })}
    />,
  );
  await tick();
  assert.equal(byTestId("total-unread").textContent, "2 unread");
});

test("🚨 a folder's count is what it HOLDS; only the inbox shows unread", async () => {
  // The design (Wilco.dc.html ~1318) derives this per folder. Only the
  // accent rule on the line below it had been implemented, so every folder
  // showed unread: Sent rendered blank against 5,006 messages, and Drafts
  // rendered "3" meaning three drafts the server reports as READ.
  render(
    <Sidebar
      api={fakeApi({
        mailboxesData: [
          { account: "personal", id: "P-I", role: "inbox", name: "Inbox", unread: 2, total: 17 },
          { account: "personal", id: "P-S", role: "sent", name: "Sent", unread: 0, total: 5006 },
          { account: "personal", id: "P-D", role: "drafts", name: "Drafts", unread: 3, total: 3 },
          { account: "personal", id: "P-J", role: "junk", name: "Spam", unread: 0, total: 0 },
        ],
      })}
    />,
  );
  await tick();
  // Read by NAME, not by position: the sidebar renders folders in a fixed
  // role order of its own, and pinning that order here would make this test
  // fail for an unrelated reason.
  const counts: Record<string, string> = {};
  for (const row of Array.from(document.querySelectorAll(".sidebar-folder-name"))) {
    const count = row.parentElement?.querySelector(".sidebar-folder-count");
    counts[row.textContent ?? ""] = count?.textContent ?? "";
  }
  assert.deepEqual(
    counts,
    { Inbox: "2", Drafts: "3", Sent: "5,006", Spam: "" },
    "folder counts do not match the design's derivation",
  );
});

test("a hostile account name is text, not markup", async () => {
  render(
    <Sidebar
      api={fakeApi({
        accountsData: [{ key: "personal", label: "<img src=x onerror=alert(1)>" }],
      })}
    />,
  );
  await tick();
  assert.equal(document.querySelectorAll("img").length, 0);
  assert.ok(document.body.textContent!.includes("<img src=x onerror=alert(1)>"));
});

test("a custom (roleless) folder has no icon collision with the base folders and does not navigate", async () => {
  let navigated = false;
  render(
    <Sidebar
      api={fakeApi({
        mailboxesData: [{ account: "personal", id: "CUSTOM1", role: null, name: "Receipts", unread: 0 }],
      })}
      onNavigateFolder={() => {
        navigated = true;
      }}
    />,
  );
  await tick();
  const folder = byTestId("mailbox-personal-CUSTOM1");
  assert.equal(folder.hasAttribute("disabled"), true);
  folder.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(navigated, false);
});

// Design-fidelity Pass C, item 4: DESIGN.md's Sidebar section --
// "Account sync states: colored dot / spinner / error badge per account
// (auth-expired shows re-auth banner in list; Personal shows 'IMAP · soon'
// pending state)." Mapped from GET /healthz -- see Sidebar.tsx's
// `syncBadgeFor` module comment for the full state->badge reasoning.
test("an account mid-initial-walk shows the spinning sync badge", async () => {
  render(
    <Sidebar
      api={fakeApi({
        accountsData: [{ key: "work", label: "Work" }],
        healthData: [{ account: "work", state: "ok", walkComplete: false }],
      })}
    />,
  );
  await tick();
  const badge = byTestId("account-sync-work");
  assert.match(badge.title, /syncing/i);
  assert.ok(badge.querySelector("svg"), "the spinner is a Lucide icon");
});

test("an account with a caught auth failure shows the amber error badge", async () => {
  render(
    <Sidebar
      api={fakeApi({
        accountsData: [{ key: "work", label: "Work" }],
        healthData: [{ account: "work", state: "auth", message: "authentication was refused", walkComplete: true }],
      })}
    />,
  );
  await tick();
  const badge = byTestId("account-sync-work");
  assert.match(badge.title, /authentication expired/i);
});

test("an IMAP-provider account shows the 'soon' pending badge, regardless of health", async () => {
  render(
    <Sidebar
      api={fakeApi({
        accountsData: [{ key: "gmail", label: "Personal", provider: "imap" }],
        healthData: [{ account: "gmail", state: "ok", walkComplete: true }],
      })}
    />,
  );
  await tick();
  const badge = byTestId("account-sync-gmail");
  assert.equal(badge.textContent, "soon");
});

test("a healthy, fully-synced account shows no sync badge at all", async () => {
  render(
    <Sidebar
      api={fakeApi({
        accountsData: [{ key: "work", label: "Work" }],
        healthData: [{ account: "work", state: "ok", walkComplete: true, stale: false }],
      })}
    />,
  );
  await tick();
  assert.equal(byTestId("account-sync-work", { optional: true }), null);
});

// Design-fidelity Pass C, item 3: DESIGN.md's Sidebar section --
// "Saved searches section: ◎ icon + mono query + result count." The count
// is a real `api.search(...).total`, not an invented number -- see this
// task's report for the reasoning.
test("a saved search shows its real result count from api.search's total", async () => {
  const api = fakeApi({
    savedSearches: () =>
      Promise.resolve({ savedSearches: [{ id: "s1", name: "unread", query: "is:unread", position: 0, createdAt: "2026-01-01T00:00:00.000Z" }] }),
    search: () => Promise.resolve({ rows: [], total: 42, cursor: null, truncated: false }),
  });
  render(<Sidebar api={api} />);
  await tick();
  await tick();
  assert.equal(byTestId("saved-search-count-s1").textContent, "42");
  // The count query passes limit:1 -- the point is the total, not a page
  // of rows this component never renders.
  assert.deepEqual(
    api.calls.find((c) => c.method === "search")?.args,
    ["is:unread", { limit: 1 }],
  );
});

test("a saved search's count is blank, not an invented placeholder, before it resolves", async () => {
  render(
    <Sidebar
      api={fakeApi({
        savedSearches: () =>
          Promise.resolve({ savedSearches: [{ id: "s1", name: "unread", query: "is:unread", position: 0, createdAt: "2026-01-01T00:00:00.000Z" }] }),
        search: () => new Promise(() => {}), // never resolves
      })}
    />,
  );
  await tick();
  assert.equal(byTestId("saved-search-count-s1").textContent, "");
});

test("🚨 a guard on one fetch does not silence the others (audit pass 6)", async () => {
  // These four requests -- accounts, mailboxes, saved searches, health --
  // lived in ONE effect. Adding an early return so the sidebar would stop
  // re-fetching accounts a caller already had also silenced mailboxes and
  // saved searches, and the sidebar rendered no folders at all. One guard,
  // three unintended casualties; the health fetch survived only because it
  // sat after the return.
  //
  // Supplying BOTH props exercises the case where both guards fire.
  const asked: string[] = [];
  const api = fakeApi({
    accounts: () => {
      asked.push("accounts");
      return Promise.resolve([]);
    },
    health: () => {
      asked.push("health");
      return Promise.resolve({ ok: true, accounts: [] });
    },
    mailboxesData: [{ account: "personal", id: "mb-arch", role: "archive", name: "Archive" }],
  });
  render(
    <Sidebar
      api={api}
      accountSpecs={[{ key: "personal", label: "Personal", accent: "#888888", provider: "jmap", endpoint: "e", code: "PER" }]}
      health={new Map()}
    />,
  );
  await tick();

  // Both guards fired...
  assert.deepEqual(asked, [], "a supplied prop did not stop the redundant fetch");
  // ...and the folders still arrived.
  assert.ok(
    byTestId("mailbox-personal-mb-arch", { optional: true }) !== null,
    "guarding accounts/health also silenced the mailbox fetch",
  );
});

// ---------------------------------------------------------------------------
// Row 32: a folder row accepts a dropped message of ITS account and hands
// the targets up; another account's message is refused (blob-scoped ids
// aside, a cross-account move is not a move).
// ---------------------------------------------------------------------------

function dropOf(payload: { account: string; id: string }[], name: "dragover" | "drop"): Event {
  const ev = new Event(name, { bubbles: true, cancelable: true });
  const json = JSON.stringify(payload);
  const accounts = new Set(payload.map((t) => t.account));
  const types = ["application/x-wilco-messages", ...(accounts.size === 1 ? [`application/x-wilco-account-${payload[0]!.account}`] : [])];
  Object.defineProperty(ev, "dataTransfer", {
    // Protected mode, as in a real browser: the payload is readable on
    // drop only. A dragover that needs getData is the bug this models.
    value: { types, getData: () => (name === "drop" ? json : ""), dropEffect: "none" },
  });
  return ev;
}

test("dropping a message on a folder of its own account hands (mailbox, targets) up", async () => {
  const dropped: { mailboxId: string; account: string; targets: unknown }[] = [];
  render(
    <Sidebar
      api={fakeApi({
        mailboxesData: [{ account: "personal", id: "mb-arch", role: "archive", name: "Archive", unread: 0 }],
      })}
      onDropMessages={(mailboxId, account, targets) => void dropped.push({ mailboxId, account, targets })}
    />,
  );
  await tick();
  const folder = byTestId("mailbox-personal-mb-arch");
  const over = dropOf([{ account: "personal", id: "M1" }], "dragover");
  folder.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true, "dragover is accepted (preventDefault) for a same-account message");
  folder.dispatchEvent(dropOf([{ account: "personal", id: "M1" }], "drop"));
  assert.deepEqual(dropped, [{ mailboxId: "mb-arch", account: "personal", targets: [{ account: "personal", id: "M1" }] }]);

  const foreign = dropOf([{ account: "work", id: "M9" }], "dragover");
  folder.dispatchEvent(foreign);
  assert.equal(foreign.defaultPrevented, false, "another account's message is not accepted");
  folder.dispatchEvent(dropOf([{ account: "work", id: "M9" }], "drop"));
  assert.equal(dropped.length, 1, "and not dropped");
});

// ---------------------------------------------------------------------------
// Row 35: the folder counts refetch when the refresh token moves.
// ---------------------------------------------------------------------------

test("bumping mailboxesRefreshToken refetches the folder counts", async () => {
  let fetches = 0;
  const api = fakeApi({
    mailboxes: () => {
      fetches += 1;
      return Promise.resolve({
        accounts: [{ account: "personal", mailboxes: [{ id: "mb-inbox", name: "Inbox", role: "inbox", parent: null, unread: fetches, total: 5 }] }],
      });
    },
  });
  function Host(): JSX.Element {
    const [token, setToken] = useState(0);
    return (
      <div>
        <button type="button" data-testid="bump" onClick={() => setToken((v) => v + 1)} />
        <Sidebar api={api} mailboxesRefreshToken={token} />
      </div>
    );
  }
  render(<Host />);
  await tick();
  assert.equal(fetches, 1, "one fetch at mount");
  assert.match(byTestId("mailbox-personal-mb-inbox").textContent ?? "", /1/);
  click(byTestId("bump"));
  await tick();
  assert.equal(fetches, 2, "the bump refetched");
  assert.match(byTestId("mailbox-personal-mb-inbox").textContent ?? "", /2/, "and the badge shows the refetched count");
});

test("row 37: a custom folder row opens the folder by its mailbox id and is active on that route", async () => {
  const opened: [string, string][] = [];
  render(
    <Sidebar
      api={fakeApi({ mailboxesData: [{ account: "personal", id: "CUSTOM1", role: null, name: "Receipts", unread: 0 }] })}
      onNavigateFolder={() => {}}
      onOpenMailbox={(a, id) => void opened.push([a, id])}
      currentAccount="personal"
      currentMailboxId="CUSTOM1"
    />,
  );
  await tick();
  const folder = byTestId("mailbox-personal-CUSTOM1");
  assert.equal(folder.hasAttribute("disabled"), false, "openable");
  assert.ok((folder.getAttribute("class") ?? "").includes("--active"), "the open custom folder is the active row");
  click(folder);
  assert.deepEqual(opened, [["personal", "CUSTOM1"]]);
});

// ---------------------------------------------------------------------------
// Row 43: nested custom folders fold. Fastmail folders carry `parent`; the
// sidebar used to flatten them, so "Archived Folders" sat alphabetically
// among its twelve children with no way to fold them away.
// ---------------------------------------------------------------------------

const NESTED = [
  { account: "personal", id: "INBOX", role: "inbox", name: "Inbox", unread: 2, total: 9 },
  { account: "personal", id: "ARCH", role: null, name: "Archived Folders", unread: 0, total: 1 },
  { account: "personal", id: "AUS", role: null, name: "Austin 2025", unread: 0, total: 4, parent: "ARCH" },
  { account: "personal", id: "BOS", role: null, name: "Boston 2025", unread: 0, total: 5, parent: "ARCH" },
  { account: "personal", id: "LOOSE", role: null, name: "Receipts", unread: 0, total: 3 },
];

test("ROW 43: children render nested under their parent, after it, indented", async () => {
  try { window.localStorage.removeItem("wilco.folders.collapsed"); } catch {}
  render(<Sidebar api={fakeApi({ accountsData: [{ key: "personal", label: "Personal" }], mailboxesData: NESTED })} onOpenMailbox={() => {}} />);
  await tick();
  const ids = Array.from(document.querySelectorAll('[data-testid^="mailbox-personal-"]')).map((e) => e.getAttribute("data-testid")!.slice(17));
  assert.deepEqual(ids, ["INBOX", "ARCH", "AUS", "BOS", "LOOSE"], "parent, then its children, then the next root");
  assert.equal(byTestId("mailbox-personal-AUS").getAttribute("data-depth"), "1");
  assert.equal(byTestId("mailbox-personal-ARCH").getAttribute("data-depth"), "0");
  assert.equal(byTestId("mailbox-personal-LOOSE").getAttribute("data-depth"), "0");
  assert.ok(byTestId("folder-chev-personal-ARCH"), "a parent has a fold chevron");
  assert.equal(byTestId("folder-chev-personal-LOOSE", { optional: true }), null, "a childless folder has none");
  assert.equal(byTestId("folder-count-personal-ARCH").textContent, "1", "expanded: the parent shows its own count");
});

test("ROW 43: folding hides the children, rolls their count into the parent, and is remembered across a remount", async () => {
  try { window.localStorage.removeItem("wilco.folders.collapsed"); } catch {}
  const first = render(<Sidebar api={fakeApi({ accountsData: [{ key: "personal", label: "Personal" }], mailboxesData: NESTED })} onOpenMailbox={() => {}} />);
  await tick();
  click(byTestId("folder-chev-personal-ARCH"));
  await tick();
  assert.equal(byTestId("mailbox-personal-AUS", { optional: true }), null, "folded: children gone");
  assert.equal(byTestId("folder-count-personal-ARCH").textContent, "10", "folded: 1 + 4 + 5");
  assert.equal(byTestId("folder-chev-personal-ARCH").getAttribute("aria-expanded"), "false");
  assert.ok(byTestId("mailbox-personal-LOOSE"), "a sibling root is unaffected");
  first.unmount();

  render(<Sidebar api={fakeApi({ accountsData: [{ key: "personal", label: "Personal" }], mailboxesData: NESTED })} onOpenMailbox={() => {}} />);
  await tick();
  assert.equal(byTestId("mailbox-personal-AUS", { optional: true }), null, "still folded after a remount");
  click(byTestId("folder-chev-personal-ARCH"));
  await tick();
  assert.ok(byTestId("mailbox-personal-AUS"), "unfolded again");
  assert.equal(byTestId("folder-count-personal-ARCH").textContent, "1");
});

test("ROW 43: a child whose parent is not in the list is a root, never dropped", async () => {
  render(<Sidebar api={fakeApi({ accountsData: [{ key: "personal", label: "Personal" }], mailboxesData: [
    { account: "personal", id: "ORPHAN", role: null, name: "Orphan", unread: 0, total: 1, parent: "GONE" },
  ] })} onOpenMailbox={() => {}} />);
  await tick();
  assert.equal(byTestId("mailbox-personal-ORPHAN").getAttribute("data-depth"), "0");
});

test("ROW 48: an account switched out of All inboxes is out of the total, still in the sidebar", async () => {
  render(
    <Sidebar
      api={fakeApi({
        accountsData: [{ key: "personal", label: "Personal" }, { key: "test-a", label: "TEST A", showInUnified: false }],
        mailboxesData: [
          { account: "personal", id: "P-F", role: "inbox", unread: 3 },
          { account: "test-a", id: "P-F", role: "inbox", unread: 4 },
        ],
      })}
    />,
  );
  await tick();
  assert.equal(byTestId("total-unread").textContent, "3 unread");
  assert.ok(byTestId("account-block-test-a"), "hidden from All inboxes, not from the sidebar");
});

test("row 59: All inboxes is the active row only on the unified INBOX, not on every account's Archive", async () => {
  render(<Sidebar api={fakeApi()} onNavigateFolder={() => {}} currentAccount={null} currentFolder="archive" />);
  await tick();
  assert.equal((byTestId("nav-all-inboxes").getAttribute("class") ?? "").includes("--active"), false,
    "the unified Archive highlights All inboxes, which is not what is on screen");
});

test("row 59: All inboxes is active on the unified inbox", async () => {
  render(<Sidebar api={fakeApi()} onNavigateFolder={() => {}} currentAccount={null} currentFolder="inbox" />);
  await tick();
  assert.ok((byTestId("nav-all-inboxes").getAttribute("class") ?? "").includes("--active"));
});
