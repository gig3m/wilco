// The compose surface (design-fidelity plan, Task 5) -- transcribed from
// docs/design/Wilco.dc.html's Compose block (~lines 366-462), which is a
// FIRST-CLASS MAIN PANE, never a modal: it fills the space Reading
// otherwise occupies, a bordered card with a 2px accent top edge inside
// a padded background wrapper. See that file directly for the literal
// `style=` values this component's CSS class (components.css, "Compose
// (Task 5)" section) transcribes.
//
// 🚨 There is no send path anywhere in this codebase -- no `Email/set`,
// no `EmailSubmission/set`. Send, Attach and Discard are rendered exactly
// as designed but permanently `disabled`, each carrying `COMPOSE_REASON`
// (keymap.ts's shared wording for "compose/reply/forward arrive in a
// later plan," already used by Sidebar's own compose button and
// Reading's reply button) as their `title` -- never omitted, never
// silently dead. Everything else here is real: typing every field, the
// cc/bcc toggle, the markdown toolbar wrapping a text selection, the
// quoted-history toggle, attachment-chip removal, and Escape/✕ closing
// the pane. None of it touches the network -- there is nothing to call.
//
// Two data gaps this component works around rather than invents data
// for (both flagged in the task report, not resolved here):
//   - `AccountSpec` (api.ts) has no `identities`/aliases field and no
//     `email` field. `identities` is therefore an OPTIONAL prop on
//     `ComposeAccount` -- a caller with real send-as data supplies it and
//     the from-select renders "Name <email>" / "Name <email> · alias"
//     exactly as the design's `fromOptions` does; without it, the select
//     falls back to one option per account showing only the account
//     label (no address invented).
//   - There is no signature source anywhere in this codebase. The
//     design's own `sigFor()` default -- before any per-account signature
//     is ever configured -- is deterministic and account-name-derived
//     (`'— ' + accountName`, shown in new messages by default), so that
//     default is what renders here. It is a transcription of the
//     design's *default*, not an invented value, but it is still a
//     judgment call worth the owner's eyes -- see the task report.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { X } from "lucide-preact";
import { COMPOSE_REASON } from "../lib/keymap";
import { text } from "../lib/escape";
import { RichEditor, type RichEditorHandle } from "./RichEditor";
import { escapeText } from "../lib/richhtml";
import type { BodyUrlResult } from "../lib/api";

const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

export interface ComposeIdentity {
  /** The JMAP Identity id, needed to write a signature back to it. */
  id?: string;
  email: string;
  /** The display name THIS identity sends under, from Fastmail. It is what
   *  a recipient sees, and it is not the account's sidebar name (row 60:
   *  the select said "Work <robin@lumber.example>" while the message
   *  went out as "Robin Halden <robin@lumber.example>"). Absent or
   *  empty means the identity has no name and sends the bare address. */
  name?: string | null;
  /** Exactly one identity per account should carry this; if none does,
   *  the first identity in the array is treated as primary. */
  primary?: boolean;
  /** The signature stored on this JMAP Identity, byte for byte. Absent
   *  means the identities have not loaded yet; empty string means this
   *  identity genuinely has none. */
  textSignature?: string;
  /** The HTML signature. Rendered here as its PLAINTEXT rendition -- see
   *  the preview block for why. */
  htmlSignature?: string;
}

/** A looser, display-only account shape -- see the module doc comment.
 *  Every real `AccountSpec` (api.ts) already satisfies this structurally
 *  (it has `key`/`label`, and nothing here requires the fields it
 *  lacks), so `App.tsx` can pass its fetched accounts straight through. */
export interface ComposeAccount {
  key: string;
  label: string;
  /** The account's sidebar accent. Row 60: since the options now read as
   *  From headers, the account they belong to is carried by a dot rather
   *  than by prefixing its name to something a recipient never sees. */
  accent?: string;
  code?: string;
  identities?: ComposeIdentity[];
}

const CONTACT_LOOKUP_DEBOUNCE_MS = 150;

export interface ComposeContact {
  name: string;
  email: string;
  /** The accounts that know this address, most recent contact first. Shown
   *  as accent dots: the book is unified, so the account is information,
   *  never a precondition for finding someone. */
  accounts?: string[];
}

export interface ComposeAttachment {
  name: string;
  /** Pre-formatted, matching the design's own `df.size` (e.g. "84 KB") --
   *  this component does no byte-size arithmetic of its own. */
  size: string;
  /** Present once the file has been uploaded. Absent while it is still
   *  going up, or if it failed -- Send is blocked until every chip has
   *  one, because a chip without a blob would silently not be sent. */
  blobId?: string;
  type?: string;
  bytes?: number;
  /** 🚨 The account the blob was uploaded INTO. Blob ids are
   *  account-scoped (spec 11): switching the From account invalidates every
   *  blob already uploaded, and they must be re-uploaded or the send is
   *  refused. */
  account?: string;
  uploading?: boolean;
  /** 0-100 while uploading -- v1.1 #3 shows a live percent in place of the
   *  size. */
  percent?: number;
  error?: string;
}


export interface ComposeProps {
  accounts: ComposeAccount[];
  mode?: "new" | "reply" | "forward";
  /** The subject of the message being replied to/forwarded -- feeds the
   *  header title ("Reply — <subject>" / "Forward — <subject>"), design
   *  line 1689. Ignored when `mode` is "new" (the default). */
  replySubject?: string;
  /** Prefills the `to` field -- design's `cardCompose` handler does this
   *  from a message list row's `m.email`. */
  initialTo?: string;
  /** Prefilled by a reply/forward (GET .../draft). */
  initialCc?: string;
  initialSubject?: string;
  /** A resumed draft's own HTML, already sanitized by the server
   *  (draft-html). Adopted at mount; no signature is inserted over it. */
  initialHtml?: string | null;
  /** The identity's signature, sanitized for the editor (signature-html).
   *  null -> none inserted (the account's switch is off, or nothing there).
   *  Called again when the From changes; an untouched block is replaced,
   *  an edited one is left alone. */
  loadSignature?: (account: string, identityId: string) => Promise<{ html: string; text: string } | null>;
  /** Where the block goes in a reply (preference `signaturePlacement`). */
  signaturePlacement?: "above" | "below";
  /** The original this reply or forward quotes (row 44, owner ruling
   *  2026-09-07: parity -- the quote is IN the editor, editable). `html` is
   *  the original through the server's editor profile, adopted as nodes;
   *  `text` is used when there is no HTML. null -> no quote. */
  quote?: { mode: "reply" | "forward"; attribution: string; html: string | null; text: string | null } | null;
  /** Contact-autocomplete source for the `to` field (design's
   *  `this.contacts`). No contacts API exists in this codebase yet, so
   *  this is optional; omitted, the field is a plain input with no
   *  dropdown. */
  contacts?: ComposeContact[];
  /** Live lookup for the To field (row 23): asked, debounced, once the
   *  fragment being typed reaches two characters. Results merge with any
   *  static `contacts`.
   *
   *  🚨 The book is UNIFIED (owner ruling 2026-10-03): `from` never narrows
   *  who can be found -- that per-account scoping was the defect, and a
   *  correspondent of another account simply could not be found. `from` is
   *  passed only so the SENDING account's own addresses are left out. Your
   *  other accounts stay addressable: writing from one to another is
   *  ordinary, and excluding every account's addresses broke board row 23.
   */
  lookupContacts?: (q: string, from: string) => Promise<ComposeContact[]>;
  /** Which accounts have ever written to each address, most recently used
   *  first (`/api/contacts/habits`). Drives the mismatch note. An address
   *  mapping to an empty list has no habit and is never remarked on. */
  lookupHabits?: (emails: string[]) => Promise<Record<string, string[]>>;
  attachments?: ComposeAttachment[];
  onClose?: () => void;
  /** Sends the message. Omitted -> Send stays disabled with
   *  COMPOSE_REASON, matching every other unwired control here.
   *  Resolves on success; rejects with a message to show the user. */
  onSend?: (msg: OutgoingDraft) => Promise<void>;
  /** Uploads one file into an account and returns its blob. Omitted ->
   *  Attach stays disabled, which is what every test that predates
   *  attachments still exercises. */
  onUpload?: (
    account: string,
    file: File,
    onProgress?: (percent: number) => void,
  ) => Promise<{ account: string; blobId: string; name: string; type: string; size: number }>;
  /** Mints the signature-preview capability URL. Omitted -> an HTML
   *  signature is not previewed (there is no honest way to show it here). */
  /** Saves the current contents as a draft, creating on the first call and
   *  updating thereafter. Omitted -> no autosave, and the header says the
   *  message is not saved. */
  onSaveDraft?: (draft: OutgoingDraft, draftId: string | null) => Promise<string>;
  /** Discards a saved draft. Called on Discard, after a successful send
   *  (the send creates its own message, so the draft would linger as a
   *  duplicate of mail that already went out), and when the account
   *  changes -- a draft belongs to the account it was created in. */
  onDiscardDraft?: (account: string, draftId: string) => Promise<void>;
  /** Resuming an existing draft: its id, so the first save updates rather
   *  than creating a second copy. */
  initialDraftId?: string | null;
  /** HH:MM a resumed draft was last saved, so the v1.1 #4 status can show a
   *  real time instead of an empty one. A draft resumed from a previous
   *  session WAS saved -- just not by this window. */
  initialSavedAt?: string | null;
  /** The account a resumed draft belongs to. Without it the window opens
   *  as whichever account happens to be first, and saving would move the
   *  draft between accounts. */
  initialAccount?: string | null;
  /** Threading headers for a reply, passed straight through. */
  inReplyTo?: string | null;
  references?: string[] | null;
}

/** What Compose hands back on Send. Addresses are still RAW STRINGS as
 *  typed -- parsing them into structured addresses is App's job (it owns
 *  the api call), so Compose stays a pure form. */
export interface OutgoingDraft {
  /** The `from` select's value: "<accountKey>|<email>", or just the
   *  account key when the account has no identities loaded. */
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** The editor's constrained HTML (lib/richhtml), the signature block
   *  wherever it sits. The server derives the text half. */
  html: string;
  attachments: ComposeAttachment[];
}

/** Handoff v1.1 #4 specifies ~900ms, matching the design's own
 *  `patchDraft` timer. Was 1500 in the improvised version. */
export const DRAFT_SAVE_DEBOUNCE_MS = 900;

function primaryEmail(identities: ComposeIdentity[]): ComposeIdentity {
  return identities.find((i) => i.primary === true) ?? identities[0]!;
}

interface FromOption {
  value: string;
  label: string;
}

/** The From header this identity sends: `Name <addr>`, or the bare address
 *  when the identity has no name. Row 60 -- the select used to show the
 *  ACCOUNT's sidebar name here, which no recipient ever sees. */
function fromHeaderOf(identity: ComposeIdentity): string {
  const name = (identity.name ?? "").trim();
  return name === "" ? identity.email : `${name} <${identity.email}>`;
}

/**
 * The bare addresses in a comma-separated recipient field, lowercased.
 *
 * Only ever used to ASK which accounts have written to someone -- the
 * server does the real parsing on send. A token that is not an address
 * yields nothing to ask about, which is the right answer while the user is
 * still typing one.
 */
export function addressesIn(...fields: string[]): string[] {
  const out: string[] = [];
  for (const field of fields) {
    for (const part of field.split(",")) {
      const angle = /<([^>]+)>/.exec(part);
      const candidate = (angle ? angle[1]! : part).trim().toLowerCase();
      if (candidate.includes("@") && !candidate.includes(" ") && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

function fromOptionsFor(account: ComposeAccount): FromOption[] {
  const identities = account.identities ?? [];
  if (identities.length === 0) {
    // Nothing is known about what this account sends yet, so the account's
    // own name is the honest placeholder -- it is not dressed up as a header.
    return [{ value: account.key, label: account.label }];
  }
  const primary = primaryEmail(identities);
  const options: FromOption[] = [{ value: `${account.key}|${primary.email}`, label: fromHeaderOf(primary) }];
  for (const identity of identities) {
    if (identity.email === primary.email) continue;
    options.push({ value: `${account.key}|${identity.email}`, label: `${fromHeaderOf(identity)} · alias` });
  }
  return options;
}


export function Compose({
  accounts,
  mode = "new",
  replySubject,
  initialTo,
  initialCc,
  initialSubject,
  contacts,
  lookupContacts,
  lookupHabits,
  attachments,
  onClose,
  onSend,
  onUpload,
  onSaveDraft,
  onDiscardDraft,
  initialDraftId,
  initialSavedAt,
  initialAccount,
  inReplyTo,
  references,
  initialHtml,
  loadSignature,
  signaturePlacement = "above",
  quote = null,
}: ComposeProps): JSX.Element {
  // Stable handle object: RichEditor fills `current` on mount.
  const editor = useRef<{ current: RichEditorHandle | null }>({ current: null }).current;
  /** The signature block exactly as inserted, to tell "untouched" from
   *  "edited" when the From changes. */
  const insertedSig = useRef<string | null>(null);
  const [from, setFrom] = useState<string>(() => {
    // 🚨 The account this message BELONGS TO wins over the first account in
    // the list. Seeding from `accounts[0]` was the whole defect: see the
    // reconcile effect below.
    const preferred =
      (initialAccount !== null && initialAccount !== undefined
        ? accounts.find((a) => a.key === initialAccount)
        : undefined) ?? accounts[0];
    return preferred ? fromOptionsFor(preferred)[0]!.value : "";
  });
  // Row 60: the account the selected sender belongs to. The value is
  // `<accountKey>|<email>` (or a bare key before identities load), so the
  // account is the part before the pipe.
  const fromAccount = accounts.find((a) => a.key === (from.includes("|") ? from.slice(0, from.indexOf("|")) : from));

  /**
   * The last sender THIS COMPONENT chose. Anything else in `from` was put
   * there by the reader, and the reconcile effect below must leave it
   * alone.
   *
   * 🚨 Deliberately not a "the user touched the select" flag set from
   * `onChange`. That was tried and is wrong: happy-dom (and a browser)
   * fires `change` on a select when its OPTIONS arrive and the selection
   * implicitly moves, so the flag was already true the first time the
   * accounts loaded and the reconcile never ran at all. Comparing against
   * what we last set needs no event and cannot be fooled by one.
   */
  const fromAuto = useRef<string>(from);
  const [to, setTo] = useState(initialTo ?? "");
  const toRef = useRef<HTMLInputElement>(null);
  const [cc, setCc] = useState(initialCc ?? "");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(initialSubject ?? "");
  const [showCc, setShowCc] = useState((initialCc ?? "") !== "");
  const [toFocused, setToFocused] = useState(false);
  const [chips, setChips] = useState<ComposeAttachment[]>(attachments ?? []);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The chosen Files, kept by name so an account switch can re-upload them.
  // A blob id cannot be turned back into bytes.
  const fileStore = useRef<Map<string, File>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The server-side draft this window is bound to. A ref as well as state
  // because the debounced save reads it from a timer callback, where a
  // stale closure over the state value would create a SECOND draft on every
  // keystroke after the first save.
  const draftIdRef = useRef<string | null>(initialDraftId ?? null);
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved" | "error">(
    initialDraftId ? "saved" : "idle",
  );
  /** HH:MM of the last successful save -- v1.1 #4 puts it in the label. */
  const [savedAt, setSavedAt] = useState<string | null>(initialSavedAt ?? null);
  const savingRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The value effect below runs once on mount. That is not an edit: a
   *  RESUMED draft would otherwise show "saving…" and schedule a pointless
   *  save the moment it opened, before the user had touched anything. */
  const mounted = useRef(false);
  // The textarea is UNCONTROLLED (defaultValue + ref), so its edits are
  // invisible to an effect watching state. This counter is what makes
  // typing in the body trigger the same autosave path as the other fields.
  const [bodyVersion, setBodyVersion] = useState(0);

  // Which account this message will be sent FROM. Needed by the upload
  // handlers below, so it is resolved here rather than further down.
  const accountKey = from.includes("|") ? from.slice(0, from.indexOf("|")) : from;

  /**
   * 🚨 `from` is seeded once at mount, and on a deep link the accounts have
   * not loaded yet — so it starts EMPTY and every save posts an empty
   * account, which the server correctly refuses with 503. Found by opening
   * a draft URL directly against the live server, not by any test: the
   * component mounts identically either way, only the timing differs.
   *
   * Reconcile once the accounts arrive, preferring the account this message
   * BELONGS TO -- the one a resumed draft was saved in, or the one holding
   * the message being replied to.
   *
   * 🚨 THIS GUARD USED TO ASK WHETHER `from` NAMED A KNOWN ACCOUNT, and
   * that is how every reply in the app went out from the wrong address.
   * `from` was seeded to `accounts[0]`, so on the normal path -- accounts
   * already loaded, reader presses `r` -- it ALWAYS named a known account,
   * the effect returned immediately, and `initialAccount` was never
   * applied. Accounts arrive sorted, so `accounts[0]` here is `atelier`:
   * a reply to a message in `personal` was composed, sent and filed as
   * robin@atelier.example. Confirmed on a delivered message.
   *
   * The condition was standing in for "the user has not chosen yet", and a
   * VALUE cannot answer that -- a default and a deliberate choice look
   * identical. So the choice is tracked directly.
   */
  useEffect(() => {
    if (accounts.length === 0) return;
    // A value we did not put there is the reader's choice; never touch it.
    if (from !== fromAuto.current) return;
    const preferred =
      (initialAccount !== null && initialAccount !== undefined
        ? accounts.find((a) => a.key === initialAccount)
        : undefined) ?? accounts[0]!;
    const next = fromOptionsFor(preferred)[0]!.value;
    if (next === from) return;
    fromAuto.current = next;
    setFrom(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, initialAccount]);

  // 🚨 A draft belongs to the account it was created in. Spec 11 requires
  // DISCARDING the server draft on an account change rather than trying to
  // move it, so the next save creates a fresh one in the new account.
  // Tracked separately from the attachment re-upload below because it must
  // happen even when there are no attachments.
  const previousAccount = useRef(accountKey);
  useEffect(() => {
    if (previousAccount.current === accountKey) return;
    // The first resolution of an as-yet-unknown account is not a user
    // switching accounts. Treating it as one would DISCARD the very draft
    // that was just resumed.
    if (previousAccount.current === "") {
      previousAccount.current = accountKey;
      return;
    }
    const staleDraft = draftIdRef.current;
    const staleAccount = previousAccount.current;
    previousAccount.current = accountKey;
    draftIdRef.current = null;
    setDraftStatus("idle");
    if (staleDraft !== null && onDiscardDraft !== undefined) {
      void onDiscardDraft(staleAccount, staleDraft).catch(() => {});
    }
    // The value effect above re-runs on the next edit and creates a fresh
    // draft in the new account; forcing a save here would create one
    // immediately even for a window the user is about to abandon.
    setBodyVersion((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey]);

  // 🚨 Blob ids are ACCOUNT-SCOPED (spec 11). Switching the From account
  // invalidates every blob already uploaded, and the send would be refused.
  // Re-upload each kept File into the new account instead of dropping the
  // attachments silently or letting the send fail at the far end.
  useEffect(() => {
    if (onUpload === undefined) return;
    const stale = chips.filter((c) => c.account !== undefined && c.account !== accountKey);
    for (const chip of stale) {
      const file = fileStore.current.get(chip.name);
      if (file) void uploadInto(accountKey, file);
    }
    // `chips` is deliberately not a dependency: this reacts to the ACCOUNT
    // changing, and including chips would re-run on every upload result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey]);

  async function doSend(): Promise<void> {
    if (onSend === undefined || sending) return;
    setSendError(null);
    setSending(true);
    // A debounced save that fired mid-send would recreate the draft this
    // send is about to discard.
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      await onSend({ from, to, cc, bcc, subject, html: bodyHtml(), attachments: chips });
      // The send creates and files its OWN message. A draft saved along the
      // way would otherwise sit in Drafts as a duplicate of mail that has
      // already gone out -- and be resent by anyone who found it there.
      const savedId = draftIdRef.current;
      draftIdRef.current = null;
      if (savedId !== null && onDiscardDraft !== undefined) {
        await onDiscardDraft(accountKey, savedId).catch(() => {});
      }
      onClose?.();
    } catch (err) {
      // The window stays OPEN on failure. Closing it would discard a
      // message the user believes they sent -- the one outcome worse than
      // showing an error.
      setSendError(err instanceof Error ? err.message : "Could not send.");
    } finally {
      setSending(false);
    }
  }

  // ⌘⏎ / Ctrl+⏎ sends -- the footer had SAID "⌘⏎ send" and the Send
  // button's tooltip "Send (⌘⏎)" since the first compose, with no handler
  // behind either (feature audit, 2026-09-10). Same gate as the button:
  // nothing to send to, an upload in flight, or a send already running,
  // and the key does nothing. Read through a ref so the window listener
  // sees this render's state, not the one it was registered with.
  // Inside the closure, not at render: `attachmentsPending` is declared
  // further down the component, and reading it here at render time is a
  // temporal-dead-zone ReferenceError. The closure runs on the keystroke.
  const sendKeyRef = useRef<() => void>(() => {});
  sendKeyRef.current = () => {
    if (onSend !== undefined && !sending && to.trim() !== "" && !attachmentsPending) void doSend();
  };
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose?.();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendKeyRef.current();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const title =
    mode === "reply" && replySubject !== undefined
      ? `Reply — ${replySubject}`
      : mode === "forward" && replySubject !== undefined
        ? `Forward — ${replySubject}`
        : "New message";

  // Design line 1697: a fragment shorter than 2 characters never opens
  // the dropdown -- avoids matching on a single keystroke.
  const toFragment = to.split(",").pop()!.trim().toLowerCase();
  // Server suggestions for the current fragment (row 23). Debounced so a
  // burst of keystrokes is one request; keyed by the fragment it answered
  // so a slow reply for "da" cannot land under "dan".
  const [remote, setRemote] = useState<{ q: string; items: ComposeContact[] }>({ q: "", items: [] });
  useEffect(() => {
    if (lookupContacts === undefined || !toFocused || toFragment.length < 2) return;
    const q = toFragment;
    const timer = setTimeout(() => {
      void lookupContacts(q, accountKey)
        .then((items) => setRemote({ q, items }))
        .catch(() => setRemote({ q, items: [] }));
    }, CONTACT_LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `accountKey` IS a dependency, but only because the addresses left out
    // are the sender's: switching From changes whose those are, never who
    // can be found. The answer is cheap (core/addressbook.ts, under 1ms).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toFragment, toFocused, accountKey]);
  const fetched = remote.q === toFragment ? remote.items : [];
  const local =
    contacts !== undefined
      ? contacts.filter((c) => c.name.toLowerCase().includes(toFragment) || c.email.toLowerCase().includes(toFragment))
      : [];
  const acItems: ComposeContact[] = [];
  if (toFocused && toFragment.length >= 2) {
    const seen = new Set<string>();
    for (const c of [...fetched, ...local]) {
      const key = c.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      acItems.push(c);
      if (acItems.length === 8) break;
    }
  }
  /**
   * Which accounts have ever written to each recipient (`lookupHabits`).
   * Asked for the addresses the fields actually hold, debounced, so a
   * half-typed address is not asked about on every keystroke.
   */
  const [habits, setHabits] = useState<Record<string, string[]>>({});
  const recipients = addressesIn(to, cc, bcc);
  const recipientKey = recipients.join(",");
  useEffect(() => {
    if (lookupHabits === undefined || recipients.length === 0) return;
    const timer = setTimeout(() => {
      void lookupHabits(recipients)
        .then((h) => setHabits((prev) => ({ ...prev, ...h })))
        .catch(() => {});
    }, CONTACT_LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipientKey]);

  /**
   * The mismatch note (owner ruling 2026-10-03): "you usually write to
   * Jordan from Personal", with a switch.
   *
   * 🚨 SILENT unless a habit EXISTS and the selected account is not in it.
   * An address no account has ever written to is a new correspondent, and
   * remarking on every one of those is how a warning stops being read.
   * Some people are legitimately written to from several accounts; those
   * are a match, not a mismatch.
   */
  const mismatched = recipients.filter((a) => {
    const used = habits[a];
    return used !== undefined && used.length > 0 && !used.includes(accountKey);
  });
  // The habit to offer: the account the most of the mismatched recipients
  // are written to from, preferring each one's most recent.
  const habitTarget = ((): ComposeAccount | undefined => {
    if (mismatched.length === 0) return undefined;
    const tally = new Map<string, number>();
    for (const a of mismatched) {
      for (const used of habits[a] ?? []) tally.set(used, (tally.get(used) ?? 0) + (used === habits[a]![0] ? 2 : 1));
    }
    let best: string | undefined;
    let bestScore = 0;
    for (const [key, score] of tally) {
      if (score > bestScore) {
        best = key;
        bestScore = score;
      }
    }
    // Offered only when it is a habit for EVERY mismatched recipient --
    // otherwise switching would fix one and break another, and the note
    // states the fact without pretending there is one move that helps.
    if (best === undefined || !mismatched.every((a) => (habits[a] ?? []).includes(best!))) return undefined;
    return accounts.find((acc) => acc.key === best);
  })();
  /** What the note calls the habit. With one account to offer it is that
   *  account; with several it names them all rather than picking one, since
   *  no single switch would be right. */
  const habitLabel = ((): string => {
    if (habitTarget !== undefined) return habitTarget.label;
    const keys = [...new Set(mismatched.flatMap((a) => habits[a]?.slice(0, 1) ?? []))];
    const labels = keys.map((k) => accounts.find((acc) => acc.key === k)?.label ?? k);
    return labels.length <= 1 ? (labels[0] ?? "another account") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  })();

  /** The fragment whose dropdown the user dismissed with Escape. Keyed by
   *  the fragment rather than a bare boolean so typing on reopens it, and
   *  so dismissal also covers a static `contacts` list, which no amount of
   *  clearing the fetched results would close. */
  const [acDismissed, setAcDismissed] = useState<string | null>(null);
  const acOpen = acItems.length > 0 && acDismissed !== toFragment;

  /**
   * Which suggestion the keyboard is on, or -1 for none.
   *
   * 🚨 Reset whenever the list the user is looking at changes. A new list
   * inheriting the old index means Enter sends to whoever happens to sit
   * at that position -- the worst possible failure for this control.
   */
  const [acActive, setAcActive] = useState(-1);
  /**
   * 🚨 The keys read the index from a REF, never from the render closure.
   * Preact batches, so two ArrowDown presses inside one frame both see the
   * render's `acActive` and both compute the same next index -- the
   * selection sticks on the first row however fast you press. Exactly the
   * race `openedRef` exists for on the triage keys (row 36); a burst with
   * no pause is the only thing that shows it.
   */
  const acActiveRef = useRef(-1);
  function moveActive(next: number): void {
    acActiveRef.current = next;
    setAcActive(next);
  }
  // Keyed by the addresses themselves, not by the typed fragment: the
  // index must reset when the PEOPLE change. Two fragments that match the
  // same list leave the same person highlighted, which is correct; a
  // fragment dependency would also have been redundant, since a pending
  // fetch empties the list in between and resets it anyway.
  const acKey = acItems.map((c) => c.email).join(",");
  useEffect(() => moveActive(-1), [acKey]);
  const acActiveItem = acActive >= 0 ? acItems[acActive] : undefined;

  function pickContact(email: string): void {
    const parts = to.split(",");
    parts[parts.length - 1] = ` ${email}`;
    setTo(`${parts.join(",").replace(/^ /, "")}, `);
    moveActive(-1);
  }

  /**
   * The To field's own keys. Everything here is conditional on the
   * dropdown being open, so the field behaves exactly as it always did
   * when it is not.
   *
   * 🚨 ESCAPE MUST `stopPropagation()`. The composer's own Escape handler
   * is on `window` (see the effect above), so without this the first
   * Escape -- the one meant to dismiss the suggestions -- closes the whole
   * composer to Drafts. Row 46 found the toolbar's pickers doing exactly
   * this; a dropdown is the same shape of mistake.
   */
  function onToKeyDown(e: KeyboardEvent): void {
    if (!acOpen) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // Clamped, not wrapped: a short list that silently jumps from the
      // bottom back to the top reads as the keystroke having done nothing.
      const at = acActiveRef.current;
      const next = e.key === "ArrowDown" ? Math.min(at + 1, acItems.length - 1) : Math.max(at - 1, 0);
      moveActive(next);
      return;
    }
    // Read through the ref for the same reason: Enter may arrive in the
    // same frame as the ArrowDown that chose the row.
    const active = acActiveRef.current >= 0 ? acItems[acActiveRef.current] : undefined;
    if (e.key === "Enter" && active !== undefined) {
      e.preventDefault();
      pickContact(active.email);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      moveActive(-1);
      setAcDismissed(toFragment);
    }
  }

  /** The window's current contents, as both the draft save and the send
   *  consume them. One function so the two can never describe the message
   *  differently. */
  function currentDraft(): OutgoingDraft {
    return { from, to, cc, bcc, subject, html: bodyHtml(), attachments: chips };
  }

  /**
   * Saves now. Serialised through `savingRef` rather than fired freely: two
   * overlapping saves race to CREATE, and the loser's id is written over
   * the winner's, leaving an orphaned draft the user can see in the folder
   * and never edits again.
   */
  /**
   * Whether the window holds anything worth keeping.
   *
   * Spec 11 [dovetail] calls for an `isEmpty` check that "cuts at the
   * signature so an untouched draft never lands in Drafts". The signature
   * is not in the editor here -- it is a preview, appended server-side on
   * send -- so there is nothing to cut at, and the check is simply whether
   * the user has typed anything at all. Without it, opening compose and
   * pressing Escape leaves an empty draft in the folder every time.
   */
  function hasContent(): boolean {
    return (
      to.trim() !== "" ||
      cc.trim() !== "" ||
      bcc.trim() !== "" ||
      subject.trim() !== "" ||
      !(editor.current?.isEmpty() ?? true) ||
      chips.length > 0
    );
  }

  async function saveNow(): Promise<void> {
    if (onSaveDraft === undefined || savingRef.current) return;
    savingRef.current = true;
    try {
      draftIdRef.current = await onSaveDraft(currentDraft(), draftIdRef.current);
      setSavedAt(new Date().toTimeString().slice(0, 5));
      setDraftStatus("saved");
    } catch {
      // The message is still in the textarea; the only thing lost is the
      // server copy. Say so rather than claiming a save.
      setDraftStatus("error");
    } finally {
      savingRef.current = false;
    }
  }

  /**
   * Debounced autosave, driven by an EFFECT on the field values rather than
   * called from each input handler.
   *
   * 🚨 The handler version read stale state: `setSubject` is asynchronous,
   * so a `saveNow` closure created during the same event saw the field's
   * PREVIOUS value. Harmless while nothing branched on it, and immediately
   * wrong once `hasContent()` did -- the guard saw an empty window and
   * skipped the save. An effect closes over the values after they settle.
   */
  useEffect(() => {
    if (onSaveDraft === undefined) return;
    // An empty window is not a draft. This deliberately does NOT delete an
    // already-saved draft that has been emptied: that is a destructive act
    // to take on a timer, and Discard is the control for it.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!hasContent() && draftIdRef.current === null) return;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    // v1.1 #4: "saving…" appears on the EDIT, not when the request starts.
    // The design's own patchDraft sets the state immediately and lets the
    // 900ms timer flip it to saved -- so the label tracks the user's typing
    // rather than the network.
    setDraftStatus("saving");
    saveTimer.current = setTimeout(() => void saveNow(), DRAFT_SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, bodyVersion, chips]);

  function removeChip(index: number): void {
    const gone = chips[index];
    if (gone) fileStore.current.delete(gone.name);
    setChips((prev) => prev.filter((_, i) => i !== index));
  }

  /**
   * Uploads one file into `intoAccount` and replaces its chip with the
   * result. The File itself is kept, because an account switch means every
   * blob must be uploaded again (spec 11) and there is no way to re-derive
   * the bytes from a blob id.
   */
  // -- Drop target (owner, 2026-09-08; row 51) ------------------------------
  // The Attach button's hidden input can never take a drop. While a FILE
  // drag is over the window a box appears over the card; dropping on it
  // runs the same upload path as the button. A counter, not a flag: every
  // child entered fires dragenter before the parent's dragleave.
  const [dragDepth, setDragDepth] = useState(0);
  const isFileDrag = (e: Event): boolean => {
    const types = (e as DragEvent).dataTransfer?.types;
    return types !== undefined && types !== null && Array.from(types).includes("Files");
  };
  useEffect(() => {
    const onEnter = (e: Event): void => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDragDepth((d) => d + 1);
    };
    const onOver = (e: Event): void => {
      // Without this the browser refuses the drop and navigates to the file.
      if (isFileDrag(e)) e.preventDefault();
    };
    const onLeave = (e: Event): void => {
      if (!isFileDrag(e)) return;
      setDragDepth((d) => Math.max(0, d - 1));
    };
    const onDropAnywhere = (e: Event): void => {
      // A drop that missed the box: swallow it (no navigation), show nothing.
      if (isFileDrag(e)) e.preventDefault();
      setDragDepth(0);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDropAnywhere);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDropAnywhere);
    };
  }, []);
  // Lowercase names on purpose, as the sidebar's folder rows do: Preact
  // binds `onDrop` to a camel-cased event where the element has no `ondrop`
  // property (happy-dom), so the test would exercise a listener no browser
  // fires; `ondrop` binds the plain event in both.
  const dropTargetHandlers: Record<string, (e: Event) => void> = {
    ondrop: (e: Event) => onDropFiles(e),
    ondragover: (e: Event) => e.preventDefault(),
  };
  function onDropFiles(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    setDragDepth(0);
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    for (const file of files) void uploadInto(accountKey, file);
  }

  async function uploadInto(intoAccount: string, file: File): Promise<void> {
    if (onUpload === undefined) return;
    fileStore.current.set(file.name, file);
    setChips((prev) => {
      const without = prev.filter((c) => c.name !== file.name);
      return [...without, { name: file.name, size: formatBytes(file.size), bytes: file.size, uploading: true, percent: 0 }];
    });
    try {
      const blob = await onUpload(intoAccount, file, (percent) => {
        setChips((prev) => prev.map((c) => (c.name === file.name ? { ...c, percent } : c)));
      });
      setChips((prev) =>
        prev.map((c) =>
          c.name === file.name
            ? { name: blob.name, size: formatBytes(blob.size), bytes: blob.size, blobId: blob.blobId, type: blob.type, account: blob.account }
            : c,
        ),
      );
    } catch (err) {
      setChips((prev) =>
        prev.map((c) =>
          c.name === file.name
            ? { ...c, uploading: false, percent: undefined, error: err instanceof Error ? err.message : "Upload failed" }
            : c,
        ),
      );
    }
  }

  /** v1.1 #3's ↻. The File is still in `fileStore` (kept for the
   *  account-switch re-upload), so a retry is the same call again. */
  function onRetryUpload(name: string): void {
    const file = fileStore.current.get(name);
    if (!file) return;
    void uploadInto(accountKey, file);
  }

  function onFilesChosen(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    // Reset so choosing the SAME file twice in a row still fires change.
    input.value = "";
    for (const file of files) void uploadInto(accountKey, file);
  }

  const account = accounts.find((a) => from === a.key || from.startsWith(`${a.key}|`));
  // Send is blocked while anything is still uploading or has failed: a chip
  // without a blob would silently not be attached to the sent message.
  const attachmentsPending = chips.some((c) => c.blobId === undefined && onUpload !== undefined);
  // The design's default signature (sigFor, line 829): text mode,
  // "— <account name>", shown in new messages before any per-account
  // signature has ever been configured. There is no signature source in
  // this codebase, so this is that default and nothing else -- see the
  // module doc comment.
  // The REAL signature for the selected identity, read from its JMAP
  // Identity (spec 11). The design's `sigFor()` default (`— <account>`) was
  // a placeholder for exactly this and is gone: showing a signature the
  // recipient will never see is a claim about the outgoing message that
  // happens to be false.
  //
  // An identity with no signature renders no block at all, rather than an
  // empty one captioned "signature".
  const selectedIdentity = account?.identities?.find((i) => from === `${account.key}|${i.email}`);

  /** Everything the send and the draft carry: the editor's HTML, the
   *  signature and the quoted original wherever they sit. */
  function bodyHtml(): string {
    return editor.current?.html() ?? "";
  }

  /** The quoted original as a document to adopt (row 44). A reply: the
   *  attribution line, then ONE blockquote; a forward: the header block,
   *  then the original inline with no blockquote -- Fastmail's shapes,
   *  measured 2026-09-07. `html` came through the server's editor profile;
   *  `text` is escaped here. */
  function quoteDocument(): string | null {
    if (quote === null) return null;
    const inner =
      quote.html !== null && quote.html !== ""
        ? quote.html
        : quote.text !== null && quote.text !== ""
          ? `<div style="white-space:pre-wrap">${escapeText(quote.text).replace(/\r?\n/g, "<br>")}</div>`
          : "";
    if (inner === "") return null;
    const attribution = `<div data-wilco-attribution>${escapeText(quote.attribution).replace(/\r?\n/g, "<br>")}</div>`;
    return quote.mode === "forward"
      ? `${attribution}<div data-wilco-quote>${inner}</div>`
      : `${attribution}<blockquote type="cite" data-wilco-quote>${inner}</blockquote>`;
  }

  /** The identity's signature as a document for the block (HTML compose
   *  spec 3.2). A text-only signature becomes one paragraph per line, byte
   *  for byte within each line -- RFC 3676's `-- ` keeps its trailing space. */
  function signatureDocument(sig: { html: string; text: string }): string | null {
    if (sig.html !== "") return sig.html;
    if (sig.text === "") return null;
    return sig.text
      .split(/\r?\n/)
      .map((line) => (line === "" ? "<p><br></p>" : `<p>${escapeText(line)}</p>`))
      .join("");
  }

  const sigTarget = () => editor.current;

  // Mount: a resumed draft is adopted as it was saved (its block and quote
  // included); otherwise the quote goes in and the signature block goes in
  // (if the switch allows one), in the order the placement preference
  // says: above = [line][signature][quote], below = [line][quote][signature].
  // Row 61 (owner, 2026-09-21): a new message or a forward has no recipient
  // yet, so the cursor starts in To. A reply already has one and starts in
  // the body; so does anything that arrives with To filled in.
  const focusFirst = (): void => {
    if (mode !== "reply" && (initialTo ?? "").trim() === "") toRef.current?.focus();
    else editor.current?.focusStart();
  };
  useEffect(() => {
    if (initialHtml !== undefined && initialHtml !== null && initialHtml !== "") {
      editor.current?.adopt(initialHtml, { replace: true });
      insertedSig.current = editor.current?.signatureHtml() ?? null;
      focusFirst();
      return;
    }
    focusFirst();
    const quoteDoc = quoteDocument();
    const placeQuote = () => {
      if (quoteDoc !== null) editor.current?.adopt(quoteDoc);
    };
    if (loadSignature === undefined || selectedIdentity?.id === undefined || account === undefined) {
      placeQuote();
      return;
    }
    let live = true;
    if (signaturePlacement === "below") placeQuote();
    loadSignature(account.key, selectedIdentity.id).then(
      (sig) => {
        if (!live) return;
        const doc = sig === null ? null : signatureDocument(sig);
        if (doc !== null) {
          // Above: the block goes before the quote, i.e. right after the
          // first line -- the quote is adopted after it. Below: the quote
          // is already in; the block goes last.
          editor.current?.adopt(doc, { asSignature: true });
          insertedSig.current = editor.current?.signatureHtml() ?? null;
        }
        if (signaturePlacement !== "below") placeQuote();
      },
      () => {
        if (live && signaturePlacement !== "below") placeQuote();
      },
    );
    return () => {
      live = false;
    };
    // Once, at mount: the From effect below handles changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // From changed after mount: an UNTOUCHED block is swapped for the new
  // identity's; an edited one is the owner's and stays.
  const fromMounted = useRef(false);
  useEffect(() => {
    if (!fromMounted.current) {
      fromMounted.current = true;
      return;
    }
    if (loadSignature === undefined || selectedIdentity?.id === undefined || account === undefined) return;
    const current = sigTarget()?.signatureHtml() ?? null;
    if (current !== null && current !== insertedSig.current) return;
    let live = true;
    loadSignature(account.key, selectedIdentity.id).then(
      (sig) => {
        if (!live) return;
        const t = sigTarget();
        t?.removeSignature();
        const doc = sig === null ? null : signatureDocument(sig);
        if (doc !== null) t?.adopt(doc, { asSignature: true });
        insertedSig.current = t?.signatureHtml() ?? null;
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);

  return (
    <div class="compose-wrap">
      <div data-testid="compose-card" class="compose-card" style={{ borderTopWidth: "2px", borderTopStyle: "solid", borderTopColor: "var(--accent)" }}>
        {dragDepth > 0 && (
          <div data-testid="drop-target" class="compose-drop-target" {...dropTargetHandlers}>
            Drop files to attach
          </div>
        )}
        <header class="compose-header">
          <h2 class="compose-title">{text(title)}</h2>
          {/* Handoff v1.1 #4, verbatim: "not saved · esc" (--faint) →
              "saving…" (--muted) → "draft saved HH:MM · esc" (--faint).
              The improvised version said "draft" / "draft saved" with no
              time; the design's own `composeStatus` carries the clock. */}
          <span
            data-testid="compose-draft-status"
            class={"compose-saved-note" + (draftStatus === "saving" ? " compose-saved-note--saving" : "")}
            style={{ fontFamily: FONT_MONO }}
            title={
              onSaveDraft === undefined
                ? "Drafts are not saved — closing this window discards it"
                : draftStatus === "error"
                  ? "The draft could not be saved on the server. Your text is still here."
                  : undefined
            }
          >
            {draftStatus === "saving"
              ? "saving…"
              : draftStatus === "saved" && savedAt !== null
                ? `draft saved ${savedAt} · esc`
                : "not saved · esc"}
          </span>
          <button type="button" data-testid="compose-close" class="compose-close" onClick={() => onClose?.()}>
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>

        <div class="compose-body-wrap">
          <div class="compose-field-row" data-testid="field-from">
            <span class="compose-field-label" style={{ fontFamily: FONT_MONO }}>
              from
            </span>
            <span
              data-testid="from-account-dot"
              class="compose-from-dot"
              title={fromAccount?.label ?? ""}
              aria-label={fromAccount === undefined ? "" : `${fromAccount.label} account`}
              style={{ background: fromAccount?.accent ?? "var(--faint)" }}
            />
            <select
              data-testid="from-select"
              class="compose-field-input compose-from-select"
              value={from}
              onChange={(e) => setFrom((e.target as HTMLSelectElement).value)}
            >
              {accounts.flatMap((a) =>
                fromOptionsFor(a).map((o) => (
                  <option key={o.value} value={o.value}>
                    {text(o.label)}
                  </option>
                )),
              )}
            </select>
          </div>

          {mismatched.length > 0 && (
            <div class="compose-field-row compose-habit-note" data-testid="from-habit-note">
              <span class="compose-field-label" style={{ fontFamily: FONT_MONO }} />
              <span class="compose-habit-text">
                {mismatched.length === 1
                  ? `You usually write to ${mismatched[0]} from ${habitLabel}.`
                  : `You usually write to these ${mismatched.length} recipients from ${habitLabel}.`}
                {habitTarget !== undefined && (
                  <button
                    type="button"
                    data-testid="from-habit-switch"
                    class="compose-habit-switch"
                    onClick={() => setFrom(fromOptionsFor(habitTarget)[0]!.value)}
                  >
                    {`switch to ${habitTarget.label}`}
                  </button>
                )}
              </span>
            </div>
          )}

          <div class="compose-field-row" data-testid="field-to">
            <span class="compose-field-label" style={{ fontFamily: FONT_MONO }}>
              to
            </span>
            <div class="compose-to-wrap">
              <input
                ref={toRef}
                data-testid="compose-to"
                class="compose-field-input"
                value={to}
                placeholder="name@domain.com"
                onInput={(e) => setTo((e.target as HTMLInputElement).value)}
                onFocus={() => setToFocused(true)}
                onBlur={() => setToFocused(false)}
                onKeyDown={onToKeyDown}
                role="combobox"
                aria-expanded={acOpen}
                aria-controls="compose-to-suggestions"
                aria-autocomplete="list"
                aria-activedescendant={acActiveItem === undefined ? undefined : `to-ac-${acActiveItem.email}`}
              />
              {acOpen && (
                <div
                  class="compose-autocomplete"
                  data-testid="to-autocomplete"
                  id="compose-to-suggestions"
                  role="listbox"
                  aria-activedescendant={acActiveItem === undefined ? undefined : `to-ac-${acActiveItem.email}`}
                >
                  {acItems.map((c, i) => (
                    <button
                      key={c.email}
                      type="button"
                      id={`to-ac-${c.email}`}
                      data-testid={`to-autocomplete-${c.email}`}
                      class={i === acActive ? "compose-autocomplete-item is-active" : "compose-autocomplete-item"}
                      role="option"
                      aria-selected={i === acActive}
                      // Hover drives the same index the keys do, so the
                      // highlighted row and the row Enter would pick can
                      // never be two different rows.
                      onMouseEnter={() => moveActive(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickContact(c.email);
                      }}
                    >
                      <span class="compose-autocomplete-name">{text(c.name)}</span>
                      <span class="compose-autocomplete-email" style={{ fontFamily: FONT_MONO }}>
                        {text(c.email)}
                      </span>
                      <span class="compose-autocomplete-accounts">
                        {(c.accounts ?? []).map((k) => {
                          const acc = accounts.find((a) => a.key === k);
                          return (
                            <span
                              key={k}
                              data-testid={`to-autocomplete-dot-${c.email}-${k}`}
                              class="compose-from-dot"
                              title={acc?.label ?? k}
                              aria-label={`${acc?.label ?? k} account`}
                              style={{ background: acc?.accent ?? "var(--faint)" }}
                            />
                          );
                        })}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" data-testid="toggle-cc" class="compose-cc-toggle" style={{ fontFamily: FONT_MONO }} onClick={() => setShowCc((v) => !v)}>
              cc/bcc
            </button>
          </div>

          {showCc && (
            <div>
              <div class="compose-field-row" data-testid="field-cc">
                <span class="compose-field-label" style={{ fontFamily: FONT_MONO }}>
                  cc
                </span>
                <input data-testid="compose-cc" class="compose-field-input" value={cc} onInput={(e) => setCc((e.target as HTMLInputElement).value)} />
              </div>
              <div class="compose-field-row" data-testid="field-bcc">
                <span class="compose-field-label" style={{ fontFamily: FONT_MONO }}>
                  bcc
                </span>
                <input data-testid="compose-bcc" class="compose-field-input" value={bcc} onInput={(e) => setBcc((e.target as HTMLInputElement).value)} />
              </div>
            </div>
          )}

          <div class="compose-field-row" data-testid="field-subject">
            <span class="compose-field-label" style={{ fontFamily: FONT_MONO }}>
              subject
            </span>
            <input
              data-testid="compose-subject"
              class="compose-field-input compose-subject-input"
              value={subject}
              placeholder="Subject"
              onInput={(e) => setSubject((e.target as HTMLInputElement).value)}
            />
          </div>

          <RichEditor
            testId="compose-body"
            handle={editor}
            placeholder="Write…"
            signatureTestId="compose-signature"
            onInput={() => setBodyVersion((n) => n + 1)}
          />

          {chips.length > 0 && (
            <div class="compose-attachments" data-testid="compose-attachments">
              {chips.map((f, i) => (
                <span
                  key={f.name}
                  data-testid={`attachment-chip-${f.name}`}
                  class={
                    "compose-attachment-chip" +
                    (f.error !== undefined ? " compose-attachment-chip--failed" : "") +
                    (f.uploading === true ? " compose-attachment-chip--uploading" : "")
                  }
                  title={f.error}
                >
                  {/* v1.1 #3: uploading -- dashed border, accent ⟳ spinning
                      at 1.1s linear, mono percent INSTEAD of the size. */}
                  {f.uploading === true && (
                    <span aria-hidden="true" class="compose-attachment-spinner">
                      ⟳
                    </span>
                  )}
                  {text(f.name)}
                  {f.error !== undefined ? (
                    <span>· failed</span>
                  ) : (
                    <span class="compose-attachment-size" style={{ fontFamily: FONT_MONO }}>
                      {f.uploading === true ? `${f.percent ?? 0}%` : text(f.size)}
                    </span>
                  )}
                  {/* v1.1 #3: failed carries a bold ↻ retry BEFORE the ✕. */}
                  {f.error !== undefined && onRetryUpload !== undefined && (
                    <button
                      type="button"
                      data-testid={`attachment-retry-${f.name}`}
                      class="compose-attachment-retry"
                      title="Retry upload"
                      onClick={() => onRetryUpload(f.name)}
                    >
                      ↻
                    </button>
                  )}
                  <button type="button" data-testid={`attachment-remove-${f.name}`} class="compose-attachment-remove" onClick={() => removeChip(i)}>
                    <X size={9} strokeWidth={1.5} />
                  </button>
                </span>
              ))}
            </div>
          )}

        </div>

        {/* Row 47: the footer is a CARD-level sibling of the scrolling body, not
            a child of it. Inside the scroller the editor was flex-squeezed and
            its overflow drew under a transparent bar on any long reply. */}
        <div class="compose-footer">
          <button
            type="button"
            data-testid="send"
            class="compose-send"
            onClick={() => void doSend()}
            disabled={onSend === undefined || sending || to.trim() === "" || attachmentsPending}
            title={
              onSend === undefined
                ? COMPOSE_REASON
                : to.trim() === ""
                  ? "Add a recipient first"
                  : attachmentsPending
                    ? // Sending now would deliver a message the user
                      // believes carries a file. Blocking is the honest
                      // failure; silently dropping the chip is not.
                      "An attachment is still uploading"
                    : "Send (⌘⏎)"
            }
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <button
            type="button"
            data-testid="attach"
            class="compose-attach"
            disabled={onUpload === undefined}
            title={onUpload === undefined ? COMPOSE_REASON : "Attach a file"}
            onClick={() => fileInputRef.current?.click()}
          >
            Attach
          </button>
          {/* The real input is hidden because a bare file input cannot be
              styled to match the design's button. It is still a real
              input, so the OS picker and drag-to-the-button both work. */}
          <input
            ref={fileInputRef}
            data-testid="attach-input"
            type="file"
            multiple
            hidden
            onChange={onFilesChosen}
          />
          <span class="compose-footer-spacer" />
          <button
            type="button"
            data-testid="discard"
            class="compose-discard"
            onClick={() => {
              // Delete the server copy first: closing the window without
              // it would leave a draft in the folder the user believes
              // they discarded.
              const id = draftIdRef.current;
              if (id !== null && onDiscardDraft !== undefined) {
                void onDiscardDraft(accountKey, id).catch(() => {});
              }
              onClose?.();
            }}
            disabled={onClose === undefined}
            title="Discard this draft"
          >
            Discard
          </button>
          {sendError !== null && (
            <span data-testid="send-error" class="compose-send-error" role="alert">
              {text(sendError)}
            </span>
          )}
          <span class="compose-footer-hint" style={{ fontFamily: FONT_MONO }}>
            ⌘⏎ send
          </span>
        </div>
      </div>
    </div>
  );
}

/** Bytes as the design formats them (e.g. "84 KB"). The chip prop is a
 *  preformatted string, so this is the one place that arithmetic lives. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
