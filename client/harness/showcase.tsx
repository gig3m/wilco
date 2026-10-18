// The README screenshot (docs/screenshot-light.png / -dark.png): the full
// three-pane shell with realistic-looking but entirely fake mail across
// three accounts. Shot by hand -- see README.md's "Adding a state" -- with
// `?state=showcase`, at 1440x900, once per theme.
import type { JSX } from "preact";
import { fakeApi, spy } from "../src/test-utils";
import type { EmailRow, MessageDetail } from "../src/lib/api";
import type { FakeAccountSpec, FakeMailboxSpec } from "../src/test-utils";
import { MessageList, type MessageListRow } from "../src/ui/MessageList";
import { ListPane } from "../src/ui/Panes";
import { Reading, type ReadingMessage } from "../src/ui/Reading";
import { Sidebar } from "../src/ui/Sidebar";
import { FIXTURE_SAVED_SEARCHES } from "./fixtures";

const ACCOUNTS: FakeAccountSpec[] = [
  { key: "halden", label: "Halden", accent: "#2f6bff", code: "HAL" },
  { key: "personal", label: "Personal", accent: "#ff4d8d", code: "PER" },
  { key: "wilco", label: "Wilco Dev", accent: "#00b894", code: "WIL" },
];
const ACCENTS = Object.fromEntries(ACCOUNTS.map((a) => [a.key, a.accent!]));
const CODES = Object.fromEntries(ACCOUNTS.map((a) => [a.key, a.code!]));

const MAILBOXES: FakeMailboxSpec[] = [
  { account: "halden", id: "h-in", role: "inbox", name: "Inbox", unread: 12 },
  { account: "halden", id: "h-dr", role: "drafts", name: "Drafts", unread: 0 },
  { account: "halden", id: "h-se", role: "sent", name: "Sent", unread: 0 },
  { account: "halden", id: "h-ar", role: "archive", name: "Archive", unread: 0 },
  { account: "halden", id: "h-sp", role: "spam", name: "Spam", unread: 0 },
  { account: "halden", id: "h-tr", role: "trash", name: "Trash", unread: 0 },
  { account: "halden", id: "h-pr", role: null, name: "Projects", unread: 0 },
  { account: "personal", id: "p-in", role: "inbox", name: "Inbox", unread: 3 },
  { account: "personal", id: "p-se", role: "sent", name: "Sent", unread: 0 },
  { account: "personal", id: "p-ar", role: "archive", name: "Archive", unread: 0 },
  { account: "wilco", id: "w-in", role: "inbox", name: "Inbox", unread: 5 },
  { account: "wilco", id: "w-dr", role: "drafts", name: "Drafts", unread: 0 },
  { account: "wilco", id: "w-se", role: "sent", name: "Sent", unread: 0 },
];

function today(h: number, m: number): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

type Row = MessageListRow & EmailRow;
const r = (
  i: number, account: string, fromName: string, subject: string, snippet: string, receivedAt: string,
  extra: Partial<Row> = {},
): Row => ({
  account, id: `s-${i}`, threadId: null, receivedAt, subject, fromName,
  fromEmail: `${fromName.split(" ")[0]!.toLowerCase()}@example.test`, preview: snippet, snippet,
  isUnread: false, isFlagged: false, hasAttachment: false, via: null, ...extra,
});

const ROWS: Row[] = [
  r(1, "halden", "Priya Raman", "Design review notes", "Went through the whole flow this morning. Spacing is right, and the list finally reads as one system.", today(7, 4), { isUnread: true, isFlagged: true, hasAttachment: true, threadCount: 3 }),
  r(2, "personal", "Odalys Fenn", "Saturday — still on for the lake?", "Weather looks clear. I can bring the canoe if someone grabs the cooler.", today(6, 10), { isUnread: true }),
  r(3, "wilco", "Theo Marsh", "Re: sync backfill on the big account", "Backfill finished overnight, 37k messages, FTS index rebuilt in under a minute.", today(4, 52), { isUnread: true }),
  r(4, "halden", "Sable Voss", "Q4 planning — draft agenda", "Attached a first pass. Mostly roadmap and the hiring plan; shout if I missed anything.", today(3, 22), { hasAttachment: true }),
  r(5, "personal", "Kai Ito", "Photos from the reunion", "Finally sorted them. Shared album link inside; the ones from the dock came out great.", daysAgo(1), { isFlagged: true }),
  r(6, "halden", "Priya Raman", "Re: color tokens follow-up", "Agreed on the brighter set. Let's keep the stroke at 1.5 and revisit after the beta.", daysAgo(1)),
  r(7, "wilco", "Odalys Fenn", "Release checklist for 0.9", "Container build, migration dry run, CSP probe, then tag. Owners are on each line.", daysAgo(2)),
  r(8, "halden", "Theo Marsh", "Invoice #2291 — September", "Net 30 as usual. PDF attached; let me know if the PO number needs to change.", daysAgo(2), { hasAttachment: true }),
  r(9, "personal", "Sable Voss", "Book club: October pick", "Three nominations so far. Voting closes Friday, bring snacks either way.", daysAgo(3)),
  r(10, "wilco", "Kai Ito", "Ping: still on for Thursday?", "Pushed the review to 3pm so Priya can join from the other office.", daysAgo(4)),
];

const MESSAGE: MessageDetail = {
  account: "halden", id: "s-1", threadId: "t-1", receivedAt: today(7, 4),
  subject: "Design review notes", fromName: "Priya Raman", fromEmail: "priya.raman@halden.example",
  to: [{ name: "Kai Ito", email: "kai@halden.example" }], cc: [], bcc: [], replyTo: [], via: null,
  isUnread: false, isFlagged: true, hasHtml: false, keywords: {}, mailboxIds: ["h-in"],
  bodyText:
    "Hi Kai,\n\nWent through the whole flow this morning, start to finish. Overall it reads as one system now — the " +
    "list and the reading pane finally feel like they belong together.\n\nTwo small things:\n\n1. The selected row " +
    "could use a touch more contrast in dark mode.\n2. Attachment chips wrap awkwardly at narrow widths; the size " +
    "should stay on the same line as the name.\n\nAnnotated screenshots attached. Happy to pair on it Thursday if " +
    "that's easier.\n\nThanks,\nPriya",
  attachments: [
    { partId: "1", name: "review-notes.pdf", type: "application/pdf", size: 84_000, cid: null },
    { partId: "2", name: "before-after.png", type: "image/png", size: 412_000, cid: null },
  ],
  inlineParts: [],
};

const THREAD: ReadingMessage[] = [
  { account: "halden", id: "t-a", fromName: "Kai Ito", fromEmail: "kai@halden.example",
    preview: "Here's the build from last night — could you give it a full pass before Thursday?",
    receivedAt: daysAgo(1), bodyText: "", hasHtml: false, attachments: [], inlineParts: [] },
  { account: "halden", id: "t-b", fromName: "Sable Voss", fromEmail: "sable@halden.example",
    preview: "I'll look at the sidebar and settings; Priya, can you take list + reading?",
    receivedAt: daysAgo(1), bodyText: "", hasHtml: false, attachments: [], inlineParts: [] },
];

export function showcase(): JSX.Element {
  const api = fakeApi({
    accountsData: ACCOUNTS,
    mailboxesData: MAILBOXES,
    savedSearches: () => Promise.resolve({ savedSearches: FIXTURE_SAVED_SEARCHES }),
  });
  const noop = (): void => {};
  return (
    <div class="app-shell" style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
      <div style={{ width: "242px", flex: "none" }}>
        <Sidebar
          api={api}
          theme="light"
          settingsOpen={false}
          onNavigateFolder={noop}
          onAllInboxes={noop}
          onCompose={noop}
          onToggleTheme={noop}
          onOpenSettings={noop}
          onOpenAddAccount={noop}
          onFolderMenu={noop}
          onSavedSearchMenu={noop}
          currentAccount={null}
          currentFolder="inbox"
        />
      </div>
      <ListPane width={392}>
        <MessageList
          rows={ROWS}
          mailbox="All inboxes"
          mailboxKey="all"
          accents={ACCENTS}
          codes={CODES}
          opened={{ account: "halden", id: "s-1" }}
          onOpen={spy()}
          total={1284}
          hasMore={true}
          theme="light"
          density="comfortable"
        />
      </ListPane>
      <Reading
        message={MESSAGE}
        thread={{ messages: THREAD }}
        accent={ACCENTS["halden"]!}
        accountCode="HAL"
        accountEmail="kai@halden.example"
        onPrev={noop}
        onNext={noop}
        onArchive={noop}
        onSpam={noop}
        onDelete={noop}
        onToggleFlag={noop}
        onReply={noop}
        onForward={noop}
        onPrint={noop}
        onFooterReply={noop}
        onMessageMenu={noop}
        onAttachmentClick={noop}
      />
    </div>
  );
}

