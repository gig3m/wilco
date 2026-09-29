// The fidelity harness's state catalog. See ./README.md for why this
// exists and how it's used. Each entry renders a REAL component from
// `client/src/ui/` against fixture props (./fixtures.ts) -- never the
// live API, never real mail.
//
// A handful of components (Sidebar, AddAccount, and Settings' per-account
// page) own their step/view as internal state rather than a prop --
// that's a deliberate choice in those files (see their own module
// comments), not something this harness can route around with props
// alone. For those, a state's `node` is a small wrapper that drives the
// same real DOM interactions AddAccount.test.tsx/Settings.test.tsx
// already use (`click`/`type` from `../src/test-utils`, which are plain
// DOM dispatches -- nothing vitest-specific) inside a `useEffect`, so the
// screenshot lands on the target step/view rather than step 1 every time.
import { useEffect } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { click, fakeApi, spy, type } from "../src/test-utils";
import { AddAccount } from "../src/ui/AddAccount";
import { Compose } from "../src/ui/Compose";
import { MessageList } from "../src/ui/MessageList";
import { Overlays, type ContextMenuItem, type MoveFolder } from "../src/ui/Overlays";
import { ListPane } from "../src/ui/Panes";
import { Reading } from "../src/ui/Reading";
import { Search } from "../src/ui/Search";
import { Settings } from "../src/ui/Settings";
import { Sidebar } from "../src/ui/Sidebar";
import {
  FIXTURE_ACCOUNTS,
  FIXTURE_ACCOUNT_SPECS,
  FIXTURE_ACCENTS,
  FIXTURE_CODES,
  FIXTURE_COMPOSE_ACCOUNTS,
  FIXTURE_CONTACTS,
  FIXTURE_MAILBOXES,
  FIXTURE_MESSAGE,
  FIXTURE_ROWS,
  FIXTURE_SAVED_SEARCHES,
  FIXTURE_THREAD,
} from "./fixtures";

export interface HarnessState {
  id: string;
  /** CSS pixel viewport this state is meant to be shot at. */
  viewport: { width: number; height: number };
  node: JSX.Element;
  /** Overrides shoot.mjs's default "mounted" floor (`document.body
   *  .innerText.length`, normally in the hundreds -- see shoot.mjs's own
   *  comment). A handful of these states are legitimately terse: an undo
   *  toast is "Archived 3 5s Undo z", a context menu is a handful of
   *  short labels. Measured empirically (`overlay-toast-undo` mounts at
   *  ~20 chars, `overlay-move` at ~40) and set a comfortable margin below
   *  that -- NOT lowered to "whatever makes it pass". Anything unmounted
   *  (the failure this check exists to catch) still renders 0 chars, so
   *  even a small floor keeps the guarantee for these states. */
  minMountedChars?: number;
}

/** Runs `steps` in order, one per animation frame, after the wrapped node
 *  mounts -- real DOM dispatch (`click`/`type`), not Preact test
 *  internals. One frame of separation between steps gives each state
 *  update's render a chance to land before the next DOM query runs,
 *  matching how a real user's clicks are never literally the same tick. */
function Drive({ node, steps }: { node: ComponentChildren; steps: Array<() => void> }): JSX.Element {
  useEffect(() => {
    let cancelled = false;
    let i = 0;
    function next(): void {
      if (cancelled || i >= steps.length) return;
      steps[i]!();
      i += 1;
      requestAnimationFrame(next);
    }
    requestAnimationFrame(next);
    return () => {
      cancelled = true;
    };
  }, []);
  return <>{node}</>;
}

// Design review fix round 1: none of the original 17 states rendered in
// dark theme, so the +68% sidebar-icon ink regression (default Lucide
// strokeWidth at --faint) was invisible to a screenshot review -- dark
// mode's --faint (#686e75) sits on a darker background than light mode's
// (#959ba3 on #fafbfb), which is exactly where extra stroke weight reads
// worst. `data-theme` lives on `document.documentElement` in the real
// app (App.tsx's theme toggle), never as a component prop alone, so a
// dark-mode state needs to set that attribute itself -- the harness has
// no App.tsx shell to do it for these bare-component states.
function DarkRoot({ node }: { node: ComponentChildren }): JSX.Element {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    return () => document.documentElement.removeAttribute("data-theme");
  }, []);
  return <>{node}</>;
}

const WIDE = { width: 1440, height: 900 };
const MODAL = { width: 1024, height: 800 };

function sidebarApi() {
  return fakeApi({
    accountsData: FIXTURE_ACCOUNTS,
    mailboxesData: FIXTURE_MAILBOXES,
    savedSearches: () => Promise.resolve({ savedSearches: FIXTURE_SAVED_SEARCHES }),
  });
}

// Design-fidelity Pass C, item 4: exercises all three per-account sync
// badges (spinner/error/pending) plus item 3's real saved-search counts
// in the same shot -- `halden` mid-initial-walk (spinner), `wilco`
// with a caught auth failure (amber warning), and a third IMAP-provider
// account for the "soon" pending chip DESIGN.md names for Personal.
function sidebarSyncApi() {
  return fakeApi({
    accountsData: [...FIXTURE_ACCOUNTS, { key: "personal", label: "Personal", accent: "#b05fc9", code: "PER", provider: "imap" }],
    mailboxesData: FIXTURE_MAILBOXES,
    savedSearches: () => Promise.resolve({ savedSearches: FIXTURE_SAVED_SEARCHES }),
    healthData: [
      { account: "halden", state: "ok", walkComplete: false },
      { account: "wilco", state: "auth", message: "authentication was refused", walkComplete: true },
    ],
    search: () => Promise.resolve({ rows: [], total: 37, cursor: null, truncated: false }),
  });
}

const messageListCommon = {
  rows: FIXTURE_ROWS,
  mailbox: "inbox",
  accents: FIXTURE_ACCENTS,
  codes: FIXTURE_CODES,
  opened: { account: FIXTURE_ROWS[1]!.account, id: FIXTURE_ROWS[1]!.id },
  onOpen: spy(),
  total: 428,
  hasMore: true,
  theme: "light" as const,
};

const moveFolders: MoveFolder[] = [
  { id: "inbox", name: "Inbox", icon: "▤", disabledReason: "Not yet available in this fixture." },
  { id: "archive", name: "Archive", icon: "▣", disabledReason: "Not yet available in this fixture." },
  { id: "projects", name: "Projects", icon: "▸", onSelect: () => {} },
];

// F7 (design-fidelity Pass D, 2026-09-04): all 11 of the design's row
// context-menu items, in its order, matching what `App.tsx`'s
// `openThreadMenu` now actually renders -- this fixture used to carry
// only 6, and a screenshot of it would have kept "confirming" the very
// gap F7 reported.
const contextMenuItems: ContextMenuItem[] = [
  { label: "Open", hint: "⏎", onSelect: () => {} },
  { label: "Reply", hint: "r", disabledReason: "Not yet available in this fixture." },
  { label: "Forward", hint: "f", disabledReason: "Not yet available in this fixture." },
  { label: "", divider: true },
  { label: "Mark read", disabledReason: "Not yet available in this fixture." },
  { label: "Flag", hint: "s", disabledReason: "Not yet available in this fixture." },
  { label: "Select", hint: "x", onSelect: () => {} },
  { label: "Print", disabledReason: "Not yet available in this fixture." },
  { label: "Move to…", onSelect: () => {} },
  { label: "", divider: true },
  { label: "Archive", hint: "e", disabledReason: "Not yet available in this fixture." },
  { label: "Mark spam", disabledReason: "Not yet available in this fixture." },
  { label: "Delete", hint: "#", danger: true, disabledReason: "Not yet available in this fixture." },
];

export const STATES: HarnessState[] = [
  {
    id: "sidebar",
    viewport: { width: 320, height: 900 },
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <Sidebar
          api={sidebarApi()}
          theme="light"
          settingsOpen={false}
          onNavigateFolder={() => {}}
          onAllInboxes={() => {}}
          onCompose={() => {}}
          onToggleTheme={() => {}}
          onOpenSettings={() => {}}
          onOpenAddAccount={() => {}}
          onFolderMenu={() => {}}
          onSavedSearchMenu={() => {}}
          currentAccount="halden"
          currentFolder="inbox"
        />
      </div>
    ),
  },
  // Design-fidelity Pass C, item 4 (+ item 3): per-account sync badges
  // (spinner/error/pending) and real saved-search result counts, in one
  // shot -- see `sidebarSyncApi` above for exactly what each account/
  // search fixture represents.
  {
    id: "sidebar-sync-states",
    viewport: { width: 320, height: 900 },
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <Sidebar
          api={sidebarSyncApi()}
          theme="light"
          settingsOpen={false}
          onNavigateFolder={() => {}}
          onAllInboxes={() => {}}
          onCompose={() => {}}
          onToggleTheme={() => {}}
          onOpenSettings={() => {}}
          onOpenAddAccount={() => {}}
          onFolderMenu={() => {}}
          onSavedSearchMenu={() => {}}
          currentAccount="halden"
          currentFolder="inbox"
        />
      </div>
    ),
  },
  {
    id: "message-list-comfortable",
    viewport: WIDE,
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <MessageList {...messageListCommon} density="comfortable" />
      </div>
    ),
  },
  // Design-fidelity Pass C, item 1: DESIGN.md's "Trash: banner 'kept 30
  // days' + red Empty trash." Real fixture rows so the banner AND the
  // row list render in the same shot.
  {
    id: "message-list-trash",
    viewport: WIDE,
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <MessageList {...messageListCommon} mailbox="trash" density="comfortable" />
      </div>
    ),
  },
  // The OTHER Trash state, and the one that corrected this task's first
  // draft: Wilco.dc.html's own `trashMode` gate (line ~1519) withholds the
  // banner when Trash has no visible rows -- confirmed against a real
  // render of the design, not assumed from markup order. Only the ordinary
  // "Trash is empty" copy should show here, no banner.
  {
    id: "message-list-trash-empty",
    viewport: WIDE,
    // Terse on purpose: header + "Trash is empty" + its mono sub-line,
    // same reasoning as this file's other small overlay states (see
    // `HarnessState.minMountedChars`'s own doc comment) -- measured
    // empirically, not lowered to "whatever makes it pass".
    minMountedChars: 40,
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <MessageList rows={[]} mailbox="trash" accents={FIXTURE_ACCENTS} codes={FIXTURE_CODES} theme="light" density="comfortable" />
      </div>
    ),
  },
  // Design-fidelity Pass C, item 2: DESIGN.md's "Rows layout: single-line
  // table (checkbox · code · sender 168px · subject — snippet · flags ·
  // time 38px right)" -- `rowsLayout` true, the shape the app's `v` key
  // switches to.
  //
  // F1 fix verification (2026-09-04): Pass C's own screenshot missed the
  // 38px time cell wrapping because `messageListCommon`'s fixture rows
  // are all this-year ('2026-08-...'), which only ever exercises
  // `formatRowTime`'s short 'Aug 10' fallback -- never the real
  // 'Aug 10, 2025' prior-year case most of the actual 37.6k-message
  // corpus hits. This state overrides one row with a REAL prior-year
  // date (a fixed '2025-...' timestamp, not "N days ago" math that would
  // drift into this-year the moment the calendar turns) so a screenshot
  // of this state is evidence about the case that broke, not just the
  // case the design happened to mock.
  {
    id: "message-list-rows-layout",
    viewport: WIDE,
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <MessageList
          {...messageListCommon}
          rows={FIXTURE_ROWS.map((row, i) => (i === 0 ? { ...row, receivedAt: "2025-08-10T14:10:00.000Z" } : row))}
          density="comfortable"
          rowsLayout={true}
        />
      </div>
    ),
  },
  {
    id: "message-list-compact",
    viewport: WIDE,
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <MessageList {...messageListCommon} density="compact" />
      </div>
    ),
  },
  // Design-fidelity Pass B round 2: the reviewer could not screenshot
  // Search's result rows at all -- no state existed -- and had to report
  // the single-line-vs-three-line-row gap from source alone. "harness" is
  // deliberately the search term (not blank, not something that only
  // matches one account): FIXTURE_ROWS has it in one halden subject
  // ("Fixture harness — status") and one wilco subject ("Draft: harness
  // README"), so this state exercises the account grouping AND the
  // highlighted-substring rendering in the same shot. `fakeApi`'s
  // `search` override is a canned `FakeSearchSpec` (all ten fixture rows,
  // not actually filtered by the typed query) -- the point of this state
  // is the ROW rendering, not proving the debounce/fetch plumbing, which
  // Search.test.tsx already covers.
  {
    id: "search-results",
    viewport: WIDE,
    minMountedChars: 200,
    node: (
      <Drive
        steps={[() => type(document.querySelector<HTMLElement>('[data-testid="search"]')!, "harness")]}
        node={
          <div style={{ height: "100%", display: "flex" }}>
            <Search
              api={fakeApi({ search: { rows: FIXTURE_ROWS, total: FIXTURE_ROWS.length, cursor: null, truncated: false } })}
              accents={FIXTURE_ACCENTS}
              codes={FIXTURE_CODES}
              onOpen={() => {}}
            >
              <MessageList {...messageListCommon} density="comfortable" />
            </Search>
          </div>
        }
      />
    ),
  },
  {
    id: "reading",
    viewport: WIDE,
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <Reading
          message={FIXTURE_MESSAGE}
          thread={{ messages: FIXTURE_THREAD }}
          accent={FIXTURE_ACCENTS["halden"]}
          accountCode={FIXTURE_CODES["halden"]}
          accountEmail="kai@halden.example"
          onPrev={() => {}}
          onNext={() => {}}
          onMessageMenu={() => {}}
          onAttachmentClick={() => {}}
        />
      </div>
    ),
  },
  {
    id: "compose",
    viewport: WIDE,
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <Compose accounts={FIXTURE_COMPOSE_ACCOUNTS} contacts={FIXTURE_CONTACTS} onClose={() => {}} />
      </div>
    ),
  },
  {
    id: "settings-home",
    viewport: WIDE,
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <Settings
          accounts={FIXTURE_ACCOUNT_SPECS}
          theme="light"
          density="comfortable"
          layout="columns"
          onThemeChange={() => {}}
          onDensityChange={() => {}}
          onLayoutChange={() => {}}
          onClose={() => {}}
          onOpenAddAccount={() => {}}
        />
      </div>
    ),
  },
  {
    id: "settings-account",
    viewport: WIDE,
    node: (
      <Drive
        steps={[() => click(document.querySelector<HTMLElement>(`[data-testid="acct-manage-${FIXTURE_ACCOUNTS[0]!.key}"]`)!)]}
        node={
          <div style={{ height: "100%", display: "flex" }}>
            <Settings
              accounts={FIXTURE_ACCOUNT_SPECS}
              theme="light"
              density="comfortable"
              layout="columns"
              onThemeChange={() => {}}
              onDensityChange={() => {}}
              onLayoutChange={() => {}}
              onClose={() => {}}
              onOpenAddAccount={() => {}}
            />
          </div>
        }
      />
    ),
  },
  {
    id: "add-account-step1",
    viewport: MODAL,
    node: <AddAccount api={fakeApi()} onClose={() => {}} />,
  },
  {
    id: "add-account-step2",
    viewport: MODAL,
    minMountedChars: 60,
    node: (
      <Drive
        steps={[
          () => click(document.querySelector<HTMLElement>('[data-testid="proto-jmap"]')!),
          () => type(document.querySelector<HTMLElement>('[data-testid="address"]')!, "kai@halden.example"),
        ]}
        node={<AddAccount api={fakeApi()} onClose={() => {}} />}
      />
    ),
  },
  {
    id: "add-account-step3",
    viewport: MODAL,
    node: (
      <Drive
        steps={[
          () => click(document.querySelector<HTMLElement>('[data-testid="proto-jmap"]')!),
          () => type(document.querySelector<HTMLElement>('[data-testid="address"]')!, "kai@halden.example"),
          () => type(document.querySelector<HTMLElement>('[data-testid="token"]')!, "fixture-harness-token"),
          () => click(document.querySelector<HTMLElement>('[data-testid="submit"]')!),
        ]}
        node={<AddAccount api={fakeApi()} onClose={() => {}} />}
      />
    ),
  },
  {
    id: "overlay-shortcuts",
    viewport: MODAL,
    node: <Overlays open="shortcuts" onClose={() => {}} />,
  },
  {
    id: "overlay-source",
    viewport: MODAL,
    node: (
      <Overlays
        open="source"
        onClose={() => {}}
        source={{
          id: "halden:fixture-open-1",
          text: [
            "From: Priya Raman <priya.raman@example.test>",
            "Subject: Design review notes",
            "Date: 2026-08-20T15:32:00.000Z",
            "Content-Type: text/plain; charset=UTF-8",
            "",
            "Fixture body for the design-fidelity harness.",
          ].join("\n"),
        }}
      />
    ),
  },
  {
    id: "overlay-attachment",
    viewport: MODAL,
    minMountedChars: 30,
    node: (
      <Overlays
        open="attachment"
        onClose={() => {}}
        attachment={{ name: "before-after.png", type: "image/png", size: 412_000, kind: "Image" }}
      />
    ),
  },
  {
    id: "overlay-move",
    viewport: MODAL,
    minMountedChars: 20,
    node: <Overlays open="move" onClose={() => {}} move={{ account: "HAL", folders: moveFolders }} />,
  },
  {
    id: "overlay-contextmenu",
    viewport: MODAL,
    minMountedChars: 20,
    node: <Overlays open="contextmenu" onClose={() => {}} contextMenu={{ x: 420, y: 280, items: contextMenuItems }} />,
  },
  {
    id: "overlay-toast-notification",
    viewport: MODAL,
    minMountedChars: 60,
    node: (
      <Overlays
        open="none"
        onClose={() => {}}
        toast={{
          kind: "notification",
          account: "halden",
          accent: FIXTURE_ACCENTS["halden"]!,
          code: FIXTURE_CODES["halden"],
          from: "Priya Raman",
          subject: "Design review notes",
          snippet: "Fixture body for the design-fidelity harness…",
          via: "kai@halden.example",
          onOpen: () => {},
          onDismiss: () => {},
        }}
      />
    ),
  },
  {
    id: "overlay-toast-undo",
    viewport: MODAL,
    minMountedChars: 10,
    // F11 (design-fidelity Pass D): no `seconds` -- the design never
    // shows a countdown on a triage-shaped undo toast (see UndoToast's
    // own doc comment for why).
    node: <Overlays open="none" onClose={() => {}} toast={{ kind: "undo", label: "Archived 3", onUndo: () => {} }} />,
  },

  // ---------------------------------------------------------------------
  // Design review fix round 1: four states the original 17 never covered,
  // each one specifically why a real finding went unseen -- see the round-1
  // fix entry in pass-a-report.md for what each one caught or would have.
  // ---------------------------------------------------------------------

  // Dark theme, sidebar -- the densest icon area, and per the review the
  // case most likely to expose an ink-weight regression at `--faint`.
  {
    id: "sidebar-dark",
    viewport: { width: 320, height: 900 },
    node: (
      <DarkRoot
        node={
          <div style={{ height: "100%", display: "flex" }}>
            <Sidebar
              api={sidebarApi()}
              theme="dark"
              settingsOpen={false}
              onNavigateFolder={() => {}}
              onAllInboxes={() => {}}
              onCompose={() => {}}
              onToggleTheme={() => {}}
              onOpenSettings={() => {}}
              onOpenAddAccount={() => {}}
              onFolderMenu={() => {}}
              onSavedSearchMenu={() => {}}
              currentAccount="halden"
              currentFolder="inbox"
            />
          </div>
        }
      />
    ),
  },

  // 390 CSS px -- real phone width (an iPhone SE/12-mini-class viewport),
  // not the harness's existing 320px sidebar-drawer width. Targets
  // Reading's action row specifically: components.css's own comment on
  // `.reading-actions` says it wraps "at phone width" because the row
  // (Archive/Spam/Delete/Forward/Reply plus the icon buttons) is wider
  // than the viewport -- exactly the row this task's icon-squash fix
  // touched, and exactly the state that would have shown the fix (or a
  // regression of it) at the width it actually matters.
  {
    id: "reading-narrow-390",
    viewport: { width: 390, height: 700 },
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <Reading
          message={FIXTURE_MESSAGE}
          thread={{ messages: FIXTURE_THREAD }}
          accent={FIXTURE_ACCENTS["halden"]}
          accountCode={FIXTURE_CODES["halden"]}
          accountEmail="kai@halden.example"
          onPrev={() => {}}
          onNext={() => {}}
          onMessageMenu={() => {}}
          onAttachmentClick={() => {}}
        />
      </div>
    ),
  },

  // The amber reauthorize banner (MessageList's `reauth` prop) -- none of
  // the original 17 states passed it, so its TriangleAlert icon (added
  // this round) was never actually screenshotted.
  {
    id: "message-list-error-banner",
    viewport: WIDE,
    node: (
      <div style={{ height: "100%", display: "flex" }}>
        <MessageList
          {...messageListCommon}
          density="comfortable"
          reauth={{ account: "halden", message: "Authentication expired — reconnect this account to keep syncing." }}
          onReauthorize={() => {}}
        />
      </div>
    ),
  },

  // A composite 1440 shell -- Sidebar + MessageList + Reading side by
  // side at their real relative widths (App.tsx's own SIDEBAR_WIDTH/
  // LIST_WIDTH_DEFAULT constants), something none of the per-pane states
  // can show: whether icon scale and stroke weight actually read as ONE
  // system across a pane boundary, not just correct in isolation.
  {
    id: "shell-1440",
    viewport: { width: 1440, height: 900 },
    // Design-fidelity Pass B round 2: this state used two ad hoc `<div
    // style={{width, flex:"none"}}>` wrappers around MessageList and
    // Reading instead of the real `App.tsx` structure (`<ListPane>` +
    // Reading as a direct flex-row child of a `display:flex` shell,
    // `App.tsx`'s own `shellStyle`/`wideShell`) -- two real, screenshotted
    // bugs followed: (1) MessageList's plain div never carried
    // `.list-pane`, so the list column had no white background or
    // right-line seam; (2) Reading's plain `display:"block"` div (no
    // `display:"flex"`) meant Reading's own `flex:"1 1 auto"` inline
    // style had no flex FORMATTING CONTEXT to stretch within -- a
    // block-level flex container's height defaults to its content's, not
    // its parent's, so the pane measured 542px against this state's own
    // 900px viewport, with `--bg` showing through the missing 358px.
    // Rebuilt to match `App.tsx`'s actual DOM shape exactly.
    node: (
      <div class="app-shell" style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
        <div style={{ width: "242px", flex: "none" }}>
          <Sidebar
            api={sidebarApi()}
            theme="light"
            settingsOpen={false}
            onNavigateFolder={() => {}}
            onAllInboxes={() => {}}
            onCompose={() => {}}
            onToggleTheme={() => {}}
            onOpenSettings={() => {}}
            onOpenAddAccount={() => {}}
            onFolderMenu={() => {}}
            onSavedSearchMenu={() => {}}
            currentAccount="halden"
            currentFolder="inbox"
          />
        </div>
        <ListPane width={392}>
          <MessageList {...messageListCommon} density="comfortable" />
        </ListPane>
        <Reading
          message={FIXTURE_MESSAGE}
          thread={{ messages: FIXTURE_THREAD }}
          accent={FIXTURE_ACCENTS["halden"]}
          accountCode={FIXTURE_CODES["halden"]}
          accountEmail="kai@halden.example"
          onPrev={() => {}}
          onNext={() => {}}
          onMessageMenu={() => {}}
          onAttachmentClick={() => {}}
        />
      </div>
    ),
  },
];
