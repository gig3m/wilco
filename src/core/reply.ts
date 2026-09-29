/**
 * Building a reply or forward from an existing message.
 *
 * Pure functions over already-fetched JMAP fields, so the rules that decide
 * WHO a reply goes to are testable without a live account. Getting these
 * wrong sends someone's reply to the wrong people, which is the email
 * equivalent of a data leak:
 *
 *  - `Reply-To` beats `From`. Mailing lists and no-reply senders set it
 *    precisely so replies do not go back to the envelope sender.
 *  - Reply-all must NOT include you. Otherwise every reply CCs yourself,
 *    and on a long thread you accumulate duplicates of your own address.
 *  - Reply-all must not drop the other original recipients, which is the
 *    entire point of reply-all.
 *  - A forward carries no recipients at all. Prefilling anything there
 *    risks sending someone else's mail to a person the user never chose.
 */

export interface Addr {
  name?: string | null;
  email: string;
}

export interface SourceMessage {
  subject: string;
  from: Addr[];
  to: Addr[];
  cc: Addr[];
  replyTo: Addr[];
  /** RFC 5322 Message-ID(s) of the source, as JMAP returns them. */
  messageId: string[] | null;
  references: string[] | null;
  sentAt: string | null;
  bodyText: string | null;
  /** Whether the source has a text/html part (the archive's `has_html`).
   *  A reply to an HTML message goes out as HTML (CHECKLIST row 12). */
  hasHtml: boolean;
  /** The source's REAL attachments (inline `cid:` parts excluded), by blob.
   *  A forward carries them (CHECKLIST row 14); a reply never does. */
  attachments: SourceAttachment[];
}

export interface SourceAttachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

export type ReplyMode = "reply" | "reply-all" | "forward";

export interface DraftPrefill {
  to: Addr[];
  cc: Addr[];
  subject: string;
  /** The quoted original, already prefixed. Plain text: Wilco composes no
   *  HTML (spec 3.1). */
  quoted: string;
  inReplyTo: string | null;
  references: string[] | null;
  /** Carried to the send: a reply to an HTML message asks for the
   *  text/html half, so it arrives as HTML the way every other client's
   *  reply would. Still typed as plain text -- the half is GENERATED from
   *  it (core/signature.ts's buildHtmlBody), never composed. */
  sourceHasHtml: boolean;
  /** The attribution line for the HTML composer's quote panel (HTML
   *  compose spec 3.3); the quote itself is attached by the server. */
  attribution: string;
  /** For a forward: the original's attachments, ready to attach by blob
   *  in the source account (blob ids are account-scoped, spec 11). Empty
   *  for a reply. */
  attachments: SourceAttachment[];
}

const RE_PREFIX = /^\s*(re|aw|sv|antw)\s*(\[\d+\])?\s*:\s*/i;
const FWD_PREFIX = /^\s*(fwd?|wg)\s*:\s*/i;

/** "Re: Re: x" is noise; mail clients are expected to collapse it. */
export function replySubject(subject: string): string {
  return RE_PREFIX.test(subject) ? subject.replace(RE_PREFIX, "Re: ") : `Re: ${subject}`;
}

export function forwardSubject(subject: string): string {
  return FWD_PREFIX.test(subject) ? subject.replace(FWD_PREFIX, "Fwd: ") : `Fwd: ${subject}`;
}

function norm(email: string): string {
  return email.trim().toLowerCase();
}

function dedupe(list: Addr[], exclude: Set<string>): Addr[] {
  const seen = new Set<string>();
  const out: Addr[] = [];
  for (const a of list) {
    const e = norm(a.email);
    if (e === "" || exclude.has(e) || seen.has(e)) continue;
    seen.add(e);
    out.push({ name: a.name ?? null, email: a.email.trim() });
  }
  return out;
}

/** The quoted block. Attribution line then `> `-prefixed body, which is what
 *  every other mail client produces and what recipients expect. */
/** "On <date>, <who> wrote:" -- the line above a quote in both halves. */
export function attributionLine(msg: Pick<SourceMessage, "from" | "sentAt">): string {
  const who = msg.from[0];
  const label = who ? (who.name ? `${who.name} <${who.email}>` : who.email) : "someone";
  const when = msg.sentAt ?? "";
  return when === "" ? `${label} wrote:` : `On ${when}, ${label} wrote:`;
}

export function quoteBody(msg: SourceMessage): string {
  const head = attributionLine(msg);
  const body = (msg.bodyText ?? "").split("\n").map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
  return `\n\n${head}\n${body}\n`;
}

/**
 * @param ownAddresses every address the replying account can send as, so
 *        reply-all can exclude the user. Passing an empty set is what
 *        produces the "I keep CCing myself" bug, so callers must supply it.
 */
export function buildPrefill(msg: SourceMessage, mode: ReplyMode, ownAddresses: Set<string>): DraftPrefill {
  const own = new Set([...ownAddresses].map(norm));

  if (mode === "forward") {
    return {
      // Deliberately empty: a forward's recipient is always a deliberate
      // choice, never inherited from the message being forwarded.
      to: [],
      cc: [],
      subject: forwardSubject(msg.subject),
      quoted: forwardBody(msg),
      // A forward is a NEW thread, not a continuation -- carrying the
      // original's threading headers would bury it inside the old
      // conversation in the recipient's client.
      inReplyTo: null,
      references: null,
      sourceHasHtml: msg.hasHtml,
      attribution: forwardHeader(msg),
      attachments: msg.attachments,
    };
  }

  // Reply-To wins over From when present.
  const replyTargets = msg.replyTo.length > 0 ? msg.replyTo : msg.from;
  const to = dedupe(replyTargets, new Set());

  let cc: Addr[] = [];
  if (mode === "reply-all") {
    // Everyone else who saw it, minus the user and minus whoever is
    // already in To. Bcc is deliberately absent -- we cannot know who else
    // was bcc'd, and echoing our own bcc would expose it.
    const exclude = new Set([...own, ...to.map((a) => norm(a.email))]);
    cc = dedupe([...msg.to, ...msg.cc], exclude);
  }

  const messageId = msg.messageId?.[0] ?? null;
  const references = [...(msg.references ?? []), ...(messageId ? [messageId] : [])];

  return {
    to,
    cc,
    subject: replySubject(msg.subject),
    quoted: quoteBody(msg),
    inReplyTo: messageId,
    references: references.length > 0 ? references : null,
    sourceHasHtml: msg.hasHtml,
    attribution: attributionLine(msg),
    // A reply quotes the text; it does not send the other person their
    // own files back.
    attachments: [],
  };
}

/** The header block above a forwarded original -- the HTML composer's
 *  attribution for a forward, and the head of the plain-text body. */
export function forwardHeader(msg: SourceMessage): string {
  const fmt = (list: Addr[]): string =>
    list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
  const lines = [
    "---------- Forwarded message ----------",
    `From: ${fmt(msg.from)}`,
    `Date: ${msg.sentAt ?? ""}`,
    `Subject: ${msg.subject}`,
    `To: ${fmt(msg.to)}`,
  ];
  if (msg.cc.length > 0) lines.push(`Cc: ${fmt(msg.cc)}`);
  return lines.join("\n");
}

function forwardBody(msg: SourceMessage): string {
  return ["", "", forwardHeader(msg), "", msg.bodyText ?? ""].join("\n");
}
