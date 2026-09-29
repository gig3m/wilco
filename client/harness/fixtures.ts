// Fixture data for the fidelity harness (see ./README.md). Deliberately
// fake -- nobody named here exists, and every domain used is either the
// RFC 2606 reserved `example.test` (matching test-utils.tsx's own
// convention) or `fixture.test`. Two accounts under keys/codes already
// established by the client's own test suite (`halden`/`HAL`,
// `kai@halden.example`), plus a second account so multi-account UI (the
// sidebar's account blocks, Compose's from-select) has something to
// distinguish.
import type { AccountSpec, EmailRow, Mailbox, MessageDetail, SavedSearch } from "../src/lib/api";
import type { FakeAccountSpec, FakeMailboxSpec } from "../src/test-utils";
import type { ComposeAccount, ComposeContact } from "../src/ui/Compose";
import type { MessageListRow } from "../src/ui/MessageList";
import type { ReadingMessage } from "../src/ui/Reading";

export const FIXTURE_ACCOUNTS: FakeAccountSpec[] = [
  { key: "halden", label: "Halden", accent: "#5b6ee0", code: "HAL" },
  { key: "wilco", label: "Wilco Dev", accent: "#2a9d6e", code: "WIL" },
];

export const FIXTURE_ACCOUNT_SPECS: AccountSpec[] = FIXTURE_ACCOUNTS.map((a) => ({
  key: a.key,
  label: a.label!,
  accent: a.accent!,
  provider: "jmap",
  endpoint: `https://${a.key}.fixture.test/.well-known/jmap`,
  code: a.code,
}));

export const FIXTURE_ACCENTS: Record<string, string> = Object.fromEntries(
  FIXTURE_ACCOUNTS.map((a) => [a.key, a.accent!]),
);
export const FIXTURE_CODES: Record<string, string> = Object.fromEntries(FIXTURE_ACCOUNTS.map((a) => [a.key, a.code!]));

export const FIXTURE_MAILBOXES: FakeMailboxSpec[] = [
  { account: "halden", id: "inbox-arr", role: "inbox", name: "Inbox", unread: 12 },
  { account: "halden", id: "drafts-arr", role: "drafts", name: "Drafts", unread: 2 },
  { account: "halden", id: "sent-arr", role: "sent", name: "Sent", unread: 0 },
  { account: "halden", id: "archive-arr", role: "archive", name: "Archive", unread: 0 },
  { account: "halden", id: "spam-arr", role: "spam", name: "Spam", unread: 3 },
  { account: "halden", id: "trash-arr", role: "trash", name: "Trash", unread: 0 },
  { account: "halden", id: "projects-arr", role: null, name: "Projects", unread: 4 },
  { account: "wilco", id: "inbox-wil", role: "inbox", name: "Inbox", unread: 5 },
  { account: "wilco", id: "drafts-wil", role: "drafts", name: "Drafts", unread: 0 },
  { account: "wilco", id: "sent-wil", role: "sent", name: "Sent", unread: 0 },
];

export function fixtureMailboxByRole(account: string, role: string): Mailbox {
  const spec = FIXTURE_MAILBOXES.find((m) => m.account === account && m.role === role);
  return {
    id: spec?.id ?? `${role}-${account}`,
    name: spec?.name ?? role,
    role,
    parent: null,
    unread: spec?.unread ?? 0,
  };
}

export const FIXTURE_SAVED_SEARCHES: SavedSearch[] = [
  { id: "saved-1", name: "Unread from Priya", query: "from:priya is:unread", position: 0, createdAt: "2026-01-01T09:00:00.000Z" },
  { id: "saved-2", name: "Design review threads", query: "subject:\"design review\"", position: 1, createdAt: "2026-01-02T09:00:00.000Z" },
];

const SENDERS = [
  { name: "Priya Raman", email: "priya.raman@example.test" },
  { name: "Kai Ito", email: "kai@example.test" },
  { name: "Sable Voss", email: "sable.voss@example.test" },
  { name: "Theo Marsh", email: "theo.marsh@example.test" },
  { name: "Odalys Fenn", email: "odalys.fenn@example.test" },
];

export const FIXTURE_ROWS: (MessageListRow & EmailRow)[] = Array.from({ length: 10 }, (_, i) => {
  const sender = SENDERS[i % SENDERS.length]!;
  const account = i % 3 === 0 ? "wilco" : "halden";
  return {
    account,
    id: `fixture-${i + 1}`,
    threadId: i % 2 === 0 ? `thread-${Math.floor(i / 2)}` : null,
    receivedAt: `2026-08-${String(10 + i).padStart(2, "0")}T14:${String(10 + i).padStart(2, "0")}:00.000Z`,
    subject: [
      "Re: Q3 planning doc",
      "Design review notes",
      "Fixture harness — status",
      "Onboarding checklist",
      "Weekly digest (fixture)",
      "Re: color tokens follow-up",
      "Draft: harness README",
      "Meeting notes — 08/12",
      "Ping: still on for Thursday?",
      "Re: Re: shipping timeline",
    ][i]!,
    fromName: sender.name,
    fromEmail: sender.email,
    preview: "This is fixture body text for the design-fidelity harness — not a real message.",
    snippet: "This is fixture body text for the design-fidelity harness…",
    isUnread: i < 4,
    isFlagged: i === 2,
    hasAttachment: i % 4 === 0,
    via: null,
  };
});

export const FIXTURE_MESSAGE: MessageDetail = {
  account: "halden",
  id: "fixture-open-1",
  threadId: "thread-fixture",
  receivedAt: "2026-08-20T15:32:00.000Z",
  subject: "Design review notes",
  fromName: "Priya Raman",
  fromEmail: "priya.raman@example.test",
  to: [{ name: "Kai Ito", email: "kai@example.test" }],
  cc: [],
  bcc: [],
  replyTo: [],
  via: null,
  isUnread: false,
  isFlagged: true,
  bodyText:
    "Fixture body for the design-fidelity harness.\n\nThis is not a real message — it exists only so Reading.tsx can be " +
    "screenshotted with a populated conversation. Notes from the review: token spacing looks right, the accent bar " +
    "reads clearly against both themes.",
  hasHtml: false,
  keywords: {},
  mailboxIds: ["inbox-arr"],
  attachments: [
    { partId: "1", name: "review-notes.pdf", type: "application/pdf", size: 84_000, cid: null },
    { partId: "2", name: "before-after.png", type: "image/png", size: 412_000, cid: null },
  ],
  inlineParts: [],
};

export const FIXTURE_THREAD: ReadingMessage[] = [
  {
    account: "halden",
    id: "fixture-thread-1",
    fromName: "Kai Ito",
    fromEmail: "kai@example.test",
    preview: "Sharing the first pass of the review doc — fixture text.",
    receivedAt: "2026-08-19T10:00:00.000Z",
    bodyText: "Sharing the first pass of the review doc. Fixture text for the harness.",
    hasHtml: false,
    attachments: [],
    inlineParts: [],
  },
  {
    account: "halden",
    id: "fixture-thread-2",
    fromName: "Priya Raman",
    fromEmail: "priya.raman@example.test",
    preview: "Left a few comments inline — fixture text.",
    receivedAt: "2026-08-19T16:45:00.000Z",
    bodyText: "Left a few comments inline. Fixture text for the harness, not a real reply.",
    hasHtml: false,
    attachments: [],
    inlineParts: [],
  },
];

export const FIXTURE_COMPOSE_ACCOUNTS: ComposeAccount[] = [
  { key: "halden", label: "Halden", code: "HAL", identities: [{ email: "kai@halden.example", primary: true }] },
  { key: "wilco", label: "Wilco Dev", code: "WIL", identities: [{ email: "kai@fixture.test", primary: true }] },
];

export const FIXTURE_CONTACTS: ComposeContact[] = [
  { name: "Priya Raman", email: "priya.raman@example.test" },
  { name: "Sable Voss", email: "sable.voss@example.test" },
];
