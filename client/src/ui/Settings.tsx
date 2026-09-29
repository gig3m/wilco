// Settings (design-fidelity plan, Task 6) -- transcribed from the design's
// own settings markup (docs/design/Wilco.dc.html, the `settingsOpen`/
// `aeOpen` blocks starting ~line 107), read directly rather than
// interpreted from prose: every px/color/weight below comes off that
// file's literal inline `style=` attributes, confirmed against a real
// screenshot of the running prototype (docs/design/RENDERING.md).
//
// "Built, unwired" here means the BACKEND is absent, not the screen --
// the same shape Task 5 established for Compose. The whole surface is
// reachable (App.tsx wires the sidebar's ⚙ button and the `,` key to
// open it) and the per-account page is real too, since *viewing* an
// already-fetched `AccountSpec` needs no backend at all. Only the
// individual controls whose backend genuinely doesn't exist yet are
// `disabled`, each with a `title` naming the plan that wires it:
//   - Theme, density and the reading-pane layout are real client state
//     `App.tsx` already owns (or now owns, for density). "＋ Add account"
//     is real too (Task 7) -- it opens AddAccount.tsx's onboarding modal,
//     which is genuinely wired to `POST /api/accounts`.
//   - Everything else -- account identity/aliases/resync/signature and
//     every global preference row -- is disabled.
//   - Remove account is a special case: `DELETE /api/accounts/:key`
//     genuinely exists, but this plan ships no confirmation flow for a
//     destructive action next to four live mailboxes, so it stays
//     disabled regardless (owner instruction, not an oversight).
//
// Data this component does NOT invent, because there is nowhere in this
// codebase for it to come from (flagged in the task report, not resolved
// here):
//   - `AccountSpec` (api.ts) has no `email` field or aliases -- the
//     design's account card's mono email address line and every alias
//     chip stay omitted outright. (Design-fidelity Pass B finding 6,
//     owner ruling: an earlier version of this file substituted
//     `PROVIDER · endpoint` into the email line's place -- ruled a
//     substitution, which invents just as much as a guess would;
//     omit-don't-invent applies to standing in a different real value as
//     much as a fake one. The endpoint is still shown, correctly
//     labeled, in the account detail page's own "Server" section.)
//   - The connected/syncing…/"auth expired"/"waiting on IMAP" status
//     label and the Reauthorize-vs-Manage branch, by contrast, are NO
//     LONGER an omission (design-fidelity F10, 2026-09-04): `GET
//     /healthz` (`AccountHealth`) is a real status signal this codebase
//     has carried since Task 8, this file just hadn't been updated to
//     read it -- see `statusLabelFor`/`AccountCard` below, which reuse
//     Sidebar.tsx's own `syncBadgeFor` bucket rather than re-deriving it.
//   - Send-as alias CHIPS render from `AccountSpec.identities` (audit pass
//     3 D2 -- the note here used to say they had "no backing data at all",
//     which was false and is why nobody looked). Add/remove has no backend
//     and stays disabled.
//   - The per-account signature textarea's default text reuses the exact
//     convention Compose.tsx already established for the same gap
//     (`— ${account.label}`, Compose.tsx line ~242) rather than inventing
//     a new placeholder.
//   - The global Composing section's "Signature" preview row has no
//     account to scope to and no stored value; it renders an em dash
//     rather than a fabricated snippet.
//   - The six accent swatches and every global preference row's DISPLAYED
//     value (Mark as read "After 2s", Density "Comfortable", etc.) are
//     transcribed verbatim from the design's own mock defaults
//     (Wilco.dc.html line 820 `prefs: {...}` and line 1372's
//     `aeColors`) -- literal design content, not invented, and inert
//     either way since every row showing one is disabled.
//
// No raw-HTML-injection API is used anywhere here: the signature
// "preview" branch only exists when signature format is HTML, and format
// is disabled at "Plain text" (the design's own default), so that branch
// never renders and this file never needs to turn a string into markup.
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { ArrowLeft, Plus } from "lucide-preact";
import type { AccountHealth, Api, AccountSpec, AccountSettings, Preferences } from "../lib/api";
import { SignaturePreview } from "./SignaturePreview";
import { text } from "../lib/escape";
import { syncBadgeFor, type SyncBadge } from "./Sidebar";

const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

/** Shared across every disabled control that belongs to account
 *  management (view is reachable now; mutating it is task 7's job) --
 *  matching Sidebar.tsx's own `ADD_ACCOUNT_REASON` wording so the two
 *  surfaces never drift into two different explanations for the same
 *  gap. */
export const ACCOUNT_MANAGE_REASON = "Not yet available -- account management arrives in task 7 of this plan.";
/** Every global (non-account) preference row on the Settings home page,
 *  other than theme/density/layout. */
const PREF_REASON = "Not yet available -- preference wiring arrives in a later plan.";
/** Deliberately distinct from `ACCOUNT_MANAGE_REASON`: the API exists,
 *  but there is no confirmation flow in this plan for a destructive
 *  action beside four live mailboxes -- see this file's module comment. */
const REMOVE_ACCOUNT_REASON =
  "Removing an account is destructive and this plan ships no confirmation flow yet -- not available.";
/** F10 (design-fidelity Pass D, 2026-09-04): the design's account card
 *  "Reauthorize" button (Wilco.dc.html line ~127) calls `a.reauth`, which
 *  in the prototype just flips its own mock status back to "syncing" --
 *  there is no real reauth FLOW in this codebase (no OAuth-style
 *  re-consent screen, no endpoint to kick a stalled JMAP session), only
 *  the account's live health state. The button renders and is reachable,
 *  disabled with this reason, rather than a live handler that would
 *  either no-op silently or need to invent a flow the brief never asked
 *  for. */
const REAUTHORIZE_REASON = "Not yet available -- there is no reauthorization flow in this codebase yet, only its health state.";

/** F10 (design-fidelity Pass D): the design's account card status label
 *  (Wilco.dc.html line ~1348's `statusLabel`) is `connected` / `syncing…`
 *  / `auth expired` / `waiting on IMAP`, driven off exactly the four
 *  buckets Sidebar.tsx's `syncBadgeFor` already computes for the SAME
 *  account -- reused here rather than re-derived, so the sidebar badge
 *  and this label can never disagree about the same account's state. */
function statusLabelFor(badge: SyncBadge | null): { label: string; amber: boolean } {
  switch (badge) {
    case "pending":
      return { label: "waiting on IMAP", amber: false };
    case "syncing":
      return { label: "syncing…", amber: false };
    case "error":
      return { label: "auth expired", amber: true };
    case null:
      return { label: "connected", amber: false };
  }
}

// The design's own accent palette (Wilco.dc.html line 1372) -- a fixed,
// literal set of swatch colors, not per-account data. Editing an
// account's color is unwired regardless, so this is display-only.
const ACCENT_SWATCHES = ["#5b6ee0", "#2a9d6e", "#c9903a", "#b05fc9", "#4a9bb8", "#cf5f5f"];

export interface SettingsProps {
  /** Row 48: told after a per-account setting is saved, so the app can
   *  refresh what it drives (the unified list and its count). */
  onAccountSettingSaved?: (account: string, key: string, value: string) => void;
  /** Account health, when a caller already has it -- see Sidebar's identical
   *  prop and audit pass 6. Absent: this screen polls for itself, so it
   *  still renders standalone. */
  health?: Map<string, AccountHealth>;
  /** Writes an account's signature to its JMAP Identity. Omitted -> the
   *  signature textarea stays disabled. */
  onSaveSignature?: (
    account: string,
    identityId: string,
    textSignature: string,
    htmlSignature?: string,
  ) => Promise<void>;
  /** Mints the signature-preview capability URL (see SignaturePreview). */
  loadSignatureUrl?: (account: string, identityId: string) => Promise<{ url: string; hasHtml: boolean; height?: number | null }>;
  accounts: AccountSpec[];
  /** F10 (design-fidelity Pass D): source of the account card's status
   *  label (`connected`/`syncing…`/`auth expired`/`waiting on IMAP`).
   *  Optional so this file's own standalone tests, which have no server
   *  to poll, can render without one -- `statusLabelFor` treats a
   *  missing health row exactly like Sidebar.tsx already does (no
   *  `AccountHealth` fetched yet = rendered as "connected", never a
   *  fabricated "unknown" state). */
  api?: Api;
  theme?: "light" | "dark";
  density?: "comfortable" | "compact";
  layout?: "columns" | "rows";
  /** The only three real handlers this component calls. Each receives
   *  the SPECIFIC value the user picked (the design's segmented rows set
   *  a value directly, e.g. `v => this.setState({ theme: v })` --
   *  clicking "Light" while already light must not flip it TO dark, the
   *  bug a plain toggle callback would produce here). */
  onThemeChange?: (next: "light" | "dark") => void;
  onDensityChange?: (next: "comfortable" | "compact") => void;
  onLayoutChange?: (next: "columns" | "rows") => void;
  /** Row 37: the stored preferences and the one handler every wired
   *  switch/picker calls with the SPECIFIC value picked. Omitted (a
   *  standalone render) -> those rows render disabled, like any other
   *  control this component cannot act on. */
  preferences?: Preferences;
  onPreferenceChange?: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  /** "← Back to mail." Optional so a standalone render (this file's own
   *  tests) doesn't need one. */
  onClose?: () => void;
  /** Opens the add-account modal (Task 7) -- real and reachable now.
   *  Optional so this component's own tests, which don't need the modal
   *  to open, need not pass one. */
  onOpenAddAccount?: () => void;
  /** Row 34: the owner's account order, every key exactly once, first
   *  first. Omitted renders the move controls disabled. */
  onReorder?: (order: string[]) => void;
  /** Row 37: after the account page edits, resyncs or removes an account,
   *  so the caller refetches the list. Omitted -> nothing to refresh. */
  onAccountsChanged?: () => void;
}

interface SectionProps {
  title: string;
  /** `ComponentChildren`, not `JSX.Element[]`: a section legitimately holds
   *  a conditional child (`{cond && <X/>}` is `false | Element`) and a JSX
   *  comment (which is `undefined`), neither of which the narrower type
   *  admits. */
  children: ComponentChildren;
}

function Section({ title, children }: SectionProps): JSX.Element {
  return (
    <div class="settings-section">
      <h2 class="settings-section-title">{title}</h2>
      <div class="settings-card">{children}</div>
    </div>
  );
}

interface RowProps {
  label: string;
  sub?: string;
  last?: boolean;
  children: ComponentChildren;
}

function Row({ label, sub, last, children }: RowProps): JSX.Element {
  return (
    <div class={last === true ? "settings-row settings-row-last" : "settings-row"}>
      <div class="settings-row-text">
        <div class="settings-row-label">{text(label)}</div>
        {sub !== undefined && <div class="settings-row-sub">{text(sub)}</div>}
      </div>
      {children}
    </div>
  );
}

interface SegOption<T extends string> {
  value: T;
  label: string;
  /** The one option in the row that should carry the id/behavior a test
   *  or another screen needs to reach -- see this file's module comment
   *  on `switch-theme`/`switch-density` for why only one option (not the
   *  whole row) ever needs one. */
  testId?: string;
}

/** A WIRED segmented picker -- real `<button>`s, no `disabled`. Used only
 *  for the three rows this task actually wires (theme, reading-pane
 *  layout, density). */
function SegPicker<T extends string>({
  options,
  value,
  onPick,
}: {
  options: SegOption<T>[];
  value: T;
  onPick: (v: T) => void;
}): JSX.Element {
  return (
    <div class="settings-seg">
      {options.map((opt) => (
        <button
          type="button"
          key={opt.value}
          data-testid={opt.testId}
          class={opt.value === value ? "settings-seg-opt settings-seg-opt-active" : "settings-seg-opt"}
          // Literal, not var(--radius-sm): happy-dom's getComputedStyle
          // doesn't resolve a custom property set via an inline style
          // (Sidebar.tsx's FONT_MONO comment explains the same trap), and
          // Settings.test.tsx's "squared, never pill" test reads this
          // back off `switch-theme`/`switch-density`.
          style={{ borderRadius: "2px" }}
          onClick={() => onPick(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** A DISABLED segmented picker -- a real `<fieldset disabled>` so every
 *  child button is genuinely inert (not just visually dimmed), and so
 *  `byTestId(id).hasAttribute("disabled")` is true on the element the id
 *  actually names, matching every other disabled-with-title control in
 *  this codebase (Sidebar's `add-account`, Compose's Send/Attach). The
 *  active option is still highlighted, matching the design's mock
 *  defaults (see module comment) even though nothing here can change it. */
function SegPickerDisabled({
  testId,
  options,
  activeValue,
}: {
  testId: string;
  options: string[];
  activeValue: string;
}): JSX.Element {
  return (
    <fieldset data-testid={testId} disabled title={PREF_REASON} class="settings-seg settings-seg-fieldset">
      {options.map((label) => (
        <button
          type="button"
          key={label}
          class={label === activeValue ? "settings-seg-opt settings-seg-opt-active" : "settings-seg-opt"}
          style={{ borderRadius: "2px" }}
          // Redundant with the enclosing `<fieldset disabled>` -- the
          // buttons were already inert. Stated on each child anyway so the
          // control is honest when read on its own, which is how the
          // no-silently-dead-controls guard (and a human skimming) reads
          // it: an ancestor's attribute is not visible at this line.
          disabled
          title={PREF_REASON}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

/** A squared switch, 32×18 with a square knob -- never a pill (this
 *  task's brief, verbatim). Wired variant: real `onClick`, never
 *  `disabled`. */
function Switch({
  testId,
  on,
  onToggle,
}: {
  testId?: string;
  on: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      class={on ? "settings-switch settings-switch-on" : "settings-switch"}
      aria-pressed={on}
      style={{ borderRadius: "2px" }}
      onClick={onToggle}
    >
      <span class="settings-switch-knob" style={{ borderRadius: "1px" }} />
    </button>
  );
}

/** Disabled switch -- same shape, permanently inert, always carries a
 *  `title`. `on` is the design's own mock default for that row (see
 *  module comment); it is never a real stored preference. */
function SwitchDisabled({ testId, on }: { testId: string; on: boolean }): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled
      title={PREF_REASON}
      class={on ? "settings-switch settings-switch-on" : "settings-switch"}
      style={{ borderRadius: "2px" }}
    >
      <span class="settings-switch-knob" style={{ borderRadius: "1px" }} />
    </button>
  );
}

function accountLabel(accounts: AccountSpec[], key: string): AccountSpec | undefined {
  return accounts.find((a) => a.key === key);
}

function accountCode(a: AccountSpec): string {
  return a.code !== undefined && a.code.length > 0 ? a.code : a.key.slice(0, 3).toUpperCase();
}

/** The "＋ Add account" row and every account card's "Manage" button
 *  share this: account management (edit identity, add an account) is
 *  task 7's backend. Viewing an account's own already-fetched data is
 *  NOT gated on that -- see this file's module comment -- so only
 *  "Manage" the ACTION would be gated; here it is repurposed as
 *  navigation into a read-only-so-far detail page, which needs nothing
 *  task 7 hasn't already shipped (`GET /api/accounts`).
 *
 *  F10 (design-fidelity Pass D, 2026-09-04): `health` is no longer
 *  unconditionally absent -- `Settings`'s own `GET /healthz` poll (see
 *  its doc comment) resolves the status label + the Reauthorize/Manage
 *  branch this comment previously said had "nowhere to come from". */
function AccountCard({
  account,
  health,
  onOpen,
  onMove,
  first,
  last,
}: {
  account: AccountSpec;
  health: AccountHealth | undefined;
  onOpen: (key: string) => void;
  /** Row 34: move this account one step up or down the sidebar. Omitted
   *  (no handler wired) renders the controls disabled with a reason, never
   *  silently absent. */
  onMove?: (key: string, dir: -1 | 1) => void;
  first: boolean;
  last: boolean;
}): JSX.Element {
  const status = statusLabelFor(syncBadgeFor(account, health));
  const moveReason = onMove === undefined ? "Reordering needs a handler, which this view was rendered without" : undefined;
  return (
    <div class="settings-account-row" data-testid={`acct-row-${account.key}`}>
      <span class="settings-account-move">
        <button type="button" data-testid={`acct-up-${account.key}`} class="settings-account-move-btn" aria-label={`Move ${account.label} up`}
          disabled={onMove === undefined || first} title={moveReason} onClick={() => onMove?.(account.key, -1)}>↑</button>
        <button type="button" data-testid={`acct-down-${account.key}`} class="settings-account-move-btn" aria-label={`Move ${account.label} down`}
          disabled={onMove === undefined || last} title={moveReason} onClick={() => onMove?.(account.key, 1)}>↓</button>
      </span>
      <span class="settings-account-bar" style={{ background: account.accent }} data-testid={`acct-color-${account.key}`} />
      <div class="settings-account-text">
        <div class="settings-account-name">
          {text(account.label)} <span class="settings-account-code" data-testid={`acct-code-${account.key}`} style={{ fontFamily: FONT_MONO }}>{text(accountCode(account))}</span>
        </div>
        {/* Design-fidelity Pass B finding 6 (owner ruling): the design's
           second line is a mono EMAIL ADDRESS, which `AccountSpec` has no
           field for. `PROVIDER · endpoint` (a real pair of fields) used
           to stand in here -- ruled a substitution, which is its own kind
           of invention. Omitted outright now; the JMAP badge to the
           right already carries the provider, and the endpoint is still
           shown, correctly labeled, in the account detail page's own
           "Server" section below. Open question for the owner: whether
           `AccountSpec` should grow a real `email` field. */}
      </div>
      <span class="settings-account-badge" data-testid={`acct-badge-${account.key}`} style={{ fontFamily: FONT_MONO }}>
        {text(account.provider.toUpperCase())}
      </span>
      <span
        data-testid={`acct-status-${account.key}`}
        class={"settings-account-status" + (status.amber ? " settings-account-status--amber" : "")}
        style={{ fontFamily: FONT_MONO }}
      >
        {status.label}
      </span>
      {status.amber ? (
        <button
          type="button"
          data-testid={`acct-reauthorize-${account.key}`}
          class="settings-account-reauthorize"
          title="Paste a new token on the account page"
          onClick={() => onOpen(account.key)}
        >
          Reauthorize
        </button>
      ) : (
        <button type="button" data-testid={`acct-manage-${account.key}`} class="settings-account-manage" onClick={() => onOpen(account.key)}>
          Manage
        </button>
      )}
    </div>
  );
}

function AccountDetail({
  account,
  onBack,
  onSaveSignature,
  loadSignatureUrl,
  loadSettings,
  onSaveSetting,
  onUpdate,
  onResync,
  onSetCredential,
  onRemove,
}: {
  account: AccountSpec;
  onBack: () => void;
  /** Row 37's account controls. Each omitted -> its control renders
   *  disabled with a reason, the same convention as the rest of this file. */
  onUpdate?: (patch: { label?: string; accent?: string; code?: string }) => Promise<void>;
  onResync?: () => Promise<{ requested: boolean; note: string }>;
  onSetCredential?: (credential: string) => Promise<void>;
  onRemove?: () => Promise<void>;
  /** Writes the signature to the account's primary JMAP Identity. Omitted
   *  -> the textarea stays disabled, as it was before signatures existed. */
  onSaveSignature?: (identityId: string, textSignature: string, htmlSignature?: string) => Promise<void>;
  loadSignatureUrl?: (account: string, identityId: string) => Promise<{ url: string; hasHtml: boolean; height?: number | null }>;
  /** Loads this account's settings and mailboxes. Omitted -> the spam
   *  picker renders disabled, the pattern every other unwired control here
   *  follows. */
  loadSettings?: (account: string) => Promise<AccountSettings>;
  onSaveSetting?: (account: string, key: string, value: string) => Promise<AccountSettings>;
  /** After a setting is saved: the app refreshes what the setting drives
   *  (row 48: the unified list and its count). */
  onAccountSettingSaved?: (account: string, key: string, value: string) => void;
}): JSX.Element {
  const code = accountCode(account);
  // Row 37's account controls.
  const [labelDraft, setLabelDraft] = useState(account.label);
  const [labelStatus, setLabelStatus] = useState<string | null>(null);
  const [resyncNote, setResyncNote] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenStatus, setTokenStatus] = useState<string | null>(null);
  const [removeStatus, setRemoveStatus] = useState<string | null>(null);
  function saveLabel(): void {
    if (onUpdate === undefined) return;
    const next = labelDraft.trim();
    if (next === "" || next === account.label) return;
    setLabelStatus("Saving…");
    onUpdate({ label: next })
      .then(() => setLabelStatus("Saved"))
      .catch((err: unknown) => setLabelStatus(err instanceof Error ? err.message : "Could not save that."));
  }

  // Per-account settings, loaded lazily with the account's mailboxes.
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [settingError, setSettingError] = useState<string | null>(null);
  useEffect(() => {
    if (loadSettings === undefined) return;
    let live = true;
    loadSettings(account.key)
      .then((s) => {
        if (live) setSettings(s);
      })
      .catch(() => {
        if (live) setSettingError("Could not load this account's settings.");
      });
    return () => {
      live = false;
    };
  }, [account.key, loadSettings]);
  // 🚨 The primary identity is the one the SERVER marked (mayDelete ===
  // false, spec 11), never `identities[0]` -- this account has five.
  const primary = account.identities?.find((i) => i.primary === true) ?? account.identities?.[0];
  const storedText = primary?.textSignature ?? "";
  const storedHtml = primary?.htmlSignature ?? "";
  const [sigText, setSigText] = useState(storedText);
  // The format decides which half is SHOWN. Plain text is edited here;
  // HTML is previewed at its natural height and edited in Fastmail (owner
  // ruling 2026-09-06, row 38): a 19KB signature with a base64 logo is not
  // something a textarea can show, let alone edit, and Wilco has no rich
  // editor. Both halves still go out on send (spec 11).
  const [format, setFormat] = useState<"text" | "html">(storedHtml !== "" ? "html" : "text");
  const [sigState, setSigState] = useState<"clean" | "dirty" | "saving" | "saved" | "error">("clean");
  const [previewVersion, setPreviewVersion] = useState(0);
  /** HH:MM of the last save -- v1.1 #6's "saved HH:MM". */
  const [sigSavedAt, setSigSavedAt] = useState<string | null>(null);

  // Adopt the stored values when the identities finish loading, but never
  // over an edit in progress.
  useEffect(() => {
    if (sigState !== "clean") return;
    setSigText(storedText);
    setFormat(storedHtml !== "" ? "html" : "text");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedText, storedHtml]);

  const canEdit = onSaveSignature !== undefined && primary?.id !== undefined;

  async function saveSignature(): Promise<void> {
    if (!canEdit) return;
    setSigState("saving");
    try {
      // Only the plaintext half is written; the HTML half is omitted (not
      // blanked) and the server leaves it alone. Row 38 proves the HTML
      // survives a plain-text save byte for byte.
      await onSaveSignature!(primary!.id!, sigText);
      setSigSavedAt(new Date().toTimeString().slice(0, 5));
      setSigState("saved");
      // Re-mint so the preview below shows what was just saved rather than
      // the previous version.
      setPreviewVersion((n) => n + 1);
    } catch {
      setSigState("error");
    }
  }
  return (
    <div>
      <button type="button" data-testid="settings-account-back" class="settings-back-link" onClick={onBack}>
        <ArrowLeft size={12} aria-hidden="true" />
        Settings
      </button>

      <div class="settings-account-header">
        <span class="settings-account-header-bar" style={{ background: account.accent }} />
        <div class="settings-account-header-text">
          <h1 class="settings-account-header-name">{text(account.label)}</h1>
          {/* Same omission as `AccountCard`'s sub line -- see that
             comment; ruling applies identically here. */}
        </div>
      </div>

      <Section title="Identity">
        <Row label="Name" sub="What Wilco calls this account; the sending name is the identity's, on Fastmail">
          <input
            data-testid="settings-display-name"
            disabled={onUpdate === undefined}
            title={onUpdate === undefined ? ACCOUNT_MANAGE_REASON : "Saved when you leave the field or press Enter"}
            value={labelDraft}
            class="settings-input"
            onInput={(e) => setLabelDraft((e.currentTarget as HTMLInputElement).value)}
            onBlur={saveLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveLabel();
            }}
          />
          {labelStatus !== null && (
            <span data-testid="settings-display-name-status" class="settings-mono-value" style={{ fontFamily: FONT_MONO }}>
              {text(labelStatus)}
            </span>
          )}
        </Row>
        <Row label="Color" sub="Edge on every row from this account" last>
          <div class="settings-swatches">
            {ACCENT_SWATCHES.map((c) => (
              <button
                type="button"
                key={c}
                data-testid={`swatch-${c.slice(1)}`}
                disabled={onUpdate === undefined}
                title={onUpdate === undefined ? ACCOUNT_MANAGE_REASON : `Use ${c}`}
                aria-label={`Colour ${c}`}
                aria-pressed={c === account.accent}
                class={c === account.accent ? "settings-swatch settings-swatch-active" : "settings-swatch"}
                style={{ background: c }}
                onClick={onUpdate === undefined ? undefined : () => void onUpdate({ accent: c }).catch(() => {})}
              />
            ))}
            <span class="settings-account-code-tag" style={{ fontFamily: FONT_MONO }}>
              code {text(code)}
            </span>
          </div>
        </Row>
      </Section>

      <Section title="Send-as aliases">
        <div class="settings-aliases">
          {/* 🚨 The comment that used to sit here -- "No email/aliases field
             exists on AccountSpec -- no primary chip, no alias chips" -- was
             false, and it was what stopped anyone looking. `identities`
             carries every send-as address, and this same file reads it a
             hundred lines above to resolve the primary for signatures;
             Compose renders the same list as its from-menu. Audit pass 3 D2.

             The chips are READ-ONLY. Add/remove genuinely has no backend --
             a JMAP Identity/set this codebase does not make -- so that row
             stays disabled, which is now the only thing on this screen still
             claiming a gap that is real. */}
          {account.identities !== undefined && account.identities.length > 0 && (
            <div class="settings-alias-chips" data-testid="alias-chips">
              {account.identities.map((identity) => (
                <span
                  key={identity.id}
                  data-testid={`alias-chip-${identity.email}`}
                  class={"settings-alias-chip" + (identity.primary ? " settings-alias-chip--primary" : "")}
                  title={identity.primary ? "The primary identity — replies default to this address" : undefined}
                  style={{ fontFamily: FONT_MONO }}
                >
                  {text(identity.email)}
                </span>
              ))}
            </div>
          )}
          {/* Row 37: no "add alias" control. Aliases are Fastmail identities
              and Wilco cannot create one; a control that pretended to was
              the kind of placeholder the row exists to remove. The list
              above is the truth, read from the server. */}
          <div class="settings-alias-add">
            <span class="settings-mono-value" style={{ fontFamily: FONT_MONO }}>
              Add or remove aliases in Fastmail; they appear here on the next sync.
            </span>
          </div>
          <div class="settings-hint">Aliases appear in the compose from-menu. The server must accept them as send-as identities.</div>
        </div>
      </Section>

      {/* 🚨 Spam training. Spec 7.6: "Fastmail only learns from the folder
          its training points at; this account uses *Identified Spam*, and a
          key bound to `role=junk` would quietly do the wrong thing. There is
          no correct default to hardcode."

          Audit pass 2 F4 measured the consequence on the live archive:
          personal and work each hold BOTH an "Identified Spam" (role null)
          and a "Spam" (role junk) mailbox, and every message ever marked
          spam went to the one the filter does not read. Nothing looked
          wrong -- the mail moved and the toast said it worked.

          So the empty state here is "Not set", and marking spam REFUSES
          until a folder is chosen rather than guessing. */}
      <Section title="Spam">
        <Row
          label="Training folder"
          sub="Fastmail only learns from the folder its training points at, so this is per account"
          last
        >
          {settings === null ? (
            <span class="settings-mono-value" style={{ fontFamily: FONT_MONO }}>
              {settingError ?? (loadSettings === undefined ? "Unavailable here" : "Loading…")}
            </span>
          ) : (
            <select
              data-testid="spam-folder"
              class="settings-select"
              disabled={onSaveSetting === undefined}
              title={onSaveSetting === undefined ? PREF_REASON : "Which folder trains this account's spam filter"}
              value={settings.settings["spamMailboxId"] ?? ""}
              onChange={(e) => {
                const value = (e.currentTarget as HTMLSelectElement).value;
                // A change that carries the value already stored is not a
                // choice and saves nothing. A browser never fires one, but
                // happy-dom dispatches `change` from the select's own value
                // SETTER (HTMLSelectElement.js, 15.7.4), so every render that
                // set the value "saved" it -- the same shape as the From
                // select's fire-on-load trap, closed the same way: compare
                // against what the component holds, not whether it fired.
                if (value === (settings.settings["spamMailboxId"] ?? "")) return;
                setSettingError(null);
                onSaveSetting?.(account.key, "spamMailboxId", value)
                  .then(setSettings)
                  .catch(() => setSettingError("Could not save that."));
              }}
            >
              {/* "Not set" is a real option, not a placeholder: clearing the
                  choice must be possible, and it is what makes the refusal
                  path reachable again. */}
              <option value="">Not set — marking spam will ask you to choose</option>
              {settings.mailboxes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.role !== null ? ` (${m.role})` : ""}
                </option>
              ))}
            </select>
          )}
        </Row>
        {settingError !== null && settings !== null && (
          <div class="settings-hint" data-testid="spam-folder-error">
            {text(settingError)}
          </div>
        )}
      </Section>

      <Section title="Server">
        <Row label={`${account.provider.toUpperCase()} session`} sub="Session endpoint">
          <span class="settings-mono-value" style={{ fontFamily: FONT_MONO }}>
            {text(account.endpoint)}
          </span>
        </Row>
        <Row label="Token" sub="Paste a new API token if Fastmail refused the old one; it takes effect on the next sync">
          <input
            data-testid="settings-token"
            type="password"
            autocomplete="off"
            disabled={onSetCredential === undefined}
            title={onSetCredential === undefined ? REAUTHORIZE_REASON : "A Fastmail API token with mail access"}
            value={tokenDraft}
            placeholder="fmu1-…"
            class="settings-input settings-input-mono"
            onInput={(e) => setTokenDraft((e.currentTarget as HTMLInputElement).value)}
          />
          <button
            type="button"
            data-testid="settings-token-save"
            class="settings-btn"
            disabled={onSetCredential === undefined || tokenDraft.trim() === ""}
            onClick={() => {
              if (onSetCredential === undefined) return;
              setTokenStatus("Saving…");
              onSetCredential(tokenDraft.trim())
                .then(() => {
                  setTokenDraft("");
                  setTokenStatus("Saved — used on the next sync");
                })
                .catch((err: unknown) => setTokenStatus(err instanceof Error ? err.message : "Could not save that."));
            }}
          >
            Save
          </button>
          {tokenStatus !== null && (
            <span data-testid="settings-token-status" class="settings-mono-value" style={{ fontFamily: FONT_MONO }}>
              {text(tokenStatus)}
            </span>
          )}
        </Row>
        <Row label="Sync" sub="Check every local message against the server on the next pass" last>
          <button
            type="button"
            data-testid="resync-now"
            disabled={onResync === undefined}
            title={onResync === undefined ? ACCOUNT_MANAGE_REASON : "Requests a full reconcile"}
            class="settings-btn"
            onClick={() =>
              void onResync?.()
                .then((r) => setResyncNote(r.requested ? `Requested — ${r.note}` : "Not requested"))
                .catch((err: unknown) => setResyncNote(err instanceof Error ? err.message : "Could not request that."))
            }
          >
            Resync now
          </button>
          {resyncNote !== null && (
            <span data-testid="resync-status" class="settings-mono-value" style={{ fontFamily: FONT_MONO }}>
              {text(resyncNote)}
            </span>
          )}
        </Row>
      </Section>

      <Section title="All inboxes">
        <Row label="Show in All inboxes" sub="Off: this account leaves the combined inbox and its count; it stays in the sidebar and its own view" last>
          {settings !== null && onSaveSetting !== undefined ? (
            <Switch
              testId="show-in-unified"
              on={(settings.settings["showInUnified"] ?? "on") !== "off"}
              onToggle={() =>
                void onSaveSetting(account.key, "showInUnified", (settings.settings["showInUnified"] ?? "on") === "off" ? "on" : "off")
                  .then(setSettings)
                  .catch(() => setSettingError("Could not save that."))
              }
            />
          ) : (
            <SwitchDisabled testId="show-in-unified" on={true} />
          )}
        </Row>
      </Section>

      <Section title="Signature">
        <Row label="Format" sub="Plain text travels everywhere; HTML carries styling">
          {/* Live: it selects which half is SHOWN below. Both are always
              SENT -- the message goes out multipart/alternative, so a
              recipient on either side gets a signature. */}
          <div class="settings-segpicker" data-testid="signature-format">
            {(["text", "html"] as const).map((f) => (
              <button
                key={f}
                type="button"
                data-testid={`signature-format-${f}`}
                class={"settings-seg" + (format === f ? " settings-seg--active" : "")}
                disabled={!canEdit}
                // v1.1 #6: "Format flips and toggles do not dirty the
                // signature; text edits do."
                onClick={() => setFormat(f)}
              >
                {f === "text" ? "Plain text" : "HTML"}
              </button>
            ))}
          </div>
        </Row>
        {format === "html" ? (
          /* 🚨 Row 38 / owner ruling 2026-09-06: the HTML half is PREVIEWED
             here, whole, at its natural height, and EDITED IN FASTMAIL. The
             design's raw-source textarea showed 19,588 characters of
             base64 in a 96px box and a preview cropped to its logo. There
             is no save in this mode because nothing here can change it. */
          <div class="settings-signature-preview">
            <div class="settings-signature-preview-label" style={{ fontFamily: FONT_MONO }}>
              preview · text/html
            </div>
            {storedHtml !== "" && primary?.id !== undefined && loadSignatureUrl !== undefined ? (
              <SignaturePreview
                account={account.key}
                identityId={primary.id}
                loadUrl={loadSignatureUrl}
                version={previewVersion}
                testId="settings-signature-preview"
                className="settings-signature-frame"
                naturalHeight
              />
            ) : (
              <div data-testid="settings-signature-empty" class="settings-signature-preview-text">
                {text("No HTML signature on this identity.")}
              </div>
            )}
            <div class="settings-signature-actions">
              <span class="settings-signature-status" style={{ fontFamily: FONT_MONO }} data-testid="signature-html-note">
                {text("edited in Fastmail")}
              </span>
              <span class="settings-signature-spacer" />
              <a
                data-testid="signature-edit-in-fastmail"
                class="settings-signature-save"
                href="https://app.fastmail.com/settings/identities"
                target="_blank"
                rel="noopener noreferrer"
              >
                Edit HTML in Fastmail
              </a>
            </div>
          </div>
        ) : (
          <>
            {/* 🚨 Live, and the value is the identity's own signature -- the
                design's `— <account>` placeholder is gone. Showing a
                signature the recipient will never see is a claim about
                outgoing mail that happens to be false.

                `value` rather than `defaultValue` so the textarea adopts the
                stored signature when the identities finish loading; the
                effect above refuses to do that over an edit in progress.
                Whitespace is never trimmed on the way in or out (spec 11). */}
            <textarea
              data-testid="signature-text"
              disabled={!canEdit}
              title={canEdit ? undefined : ACCOUNT_MANAGE_REASON}
              value={sigText}
              onInput={(e) => {
                setSigText((e.target as HTMLTextAreaElement).value);
                setSigState("dirty");
              }}
              spellcheck={false}
              class="settings-signature-textarea"
              style={{ fontFamily: FONT_MONO }}
            />
            {/* Handoff v1.1 #6: the preview is always visible, labelled
                "preview · text/plain"; plain-text mode stays frameless. */}
            <div class="settings-signature-preview">
              <div class="settings-signature-preview-label" style={{ fontFamily: FONT_MONO }}>
                preview · text/plain
              </div>
              <div data-testid="settings-signature-preview" class="settings-signature-preview-text">
                {text(sigText)}
              </div>
              <div class="settings-signature-actions">
                <span
                  data-testid="signature-status"
                  class={"settings-signature-status" + (sigState === "dirty" ? " settings-signature-status--dirty" : "")}
                  style={{ fontFamily: FONT_MONO }}
                >
                  {sigState === "dirty"
                    ? "unsaved changes"
                    : sigState === "saving"
                      ? "saving…"
                      : sigState === "error"
                        ? "not saved"
                        : sigSavedAt !== null
                          ? `saved ${sigSavedAt}`
                          : "saved"}
                </span>
                <span class="settings-signature-spacer" />
                {canEdit && (
                  <button
                    type="button"
                    data-testid="signature-save"
                    // v1.1 #6: accent fill when dirty, bordered --faint ghost
                    // when clean. The classes had no stylesheet rules until
                    // row 38 -- the button rendered as the browser default.
                    class={"settings-signature-save" + (sigState === "dirty" ? " settings-signature-save--dirty" : "")}
                    disabled={sigState === "saving"}
                    onClick={() => void saveSignature()}
                  >
                    Save signature
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        <Row label="Append to new messages">
          {settings !== null && onSaveSetting !== undefined ? (
            <Switch
              testId="signature-append-new"
              on={(settings.settings["signatureNew"] ?? "on") !== "off"}
              onToggle={() =>
                void onSaveSetting(account.key, "signatureNew", (settings.settings["signatureNew"] ?? "on") === "off" ? "on" : "off")
                  .then(setSettings)
                  .catch(() => setSettingError("Could not save that."))
              }
            />
          ) : (
            <SwitchDisabled testId="signature-append-new" on={true} />
          )}
        </Row>
        <Row label="Include in replies" last>
          {settings !== null && onSaveSetting !== undefined ? (
            <Switch
              testId="signature-include-replies"
              on={(settings.settings["signatureReplies"] ?? "on") !== "off"}
              onToggle={() =>
                void onSaveSetting(account.key, "signatureReplies", (settings.settings["signatureReplies"] ?? "on") === "off" ? "on" : "off")
                  .then(setSettings)
                  .catch(() => setSettingError("Could not save that."))
              }
            />
          ) : (
            <SwitchDisabled testId="signature-include-replies" on={true} />
          )}
        </Row>
      </Section>

      <h2 class="settings-section-title settings-danger-title">Danger</h2>
      <div class="settings-card settings-danger-row">
        <div class="settings-row-text">
          <div class="settings-row-label">Remove account</div>
          <div class="settings-row-sub">Local index is deleted; the server keeps your mail</div>
        </div>
        <button
          type="button"
          data-testid={`remove-account-${account.key}`}
          disabled={onRemove === undefined}
          title={onRemove === undefined ? REMOVE_ACCOUNT_REASON : "Removes the account and its local index; your mail stays on the server"}
          class="settings-btn settings-btn-danger"
          onClick={() => {
            if (onRemove === undefined) return;
            // A confirm, because this cannot be undone from here: the local
            // index and the stored credential go; the mail on the server
            // stays. window.confirm is the honest minimum -- a real dialog
            // is design work, and pretending the button was wired without
            // any confirm at all would be worse than either.
            if (!window.confirm(`Remove ${account.label} from Wilco? Its local index and credential are deleted; your mail on the server is untouched.`)) return;
            setRemoveStatus("Removing…");
            onRemove().catch((err: unknown) => setRemoveStatus(err instanceof Error ? err.message : "Could not remove it."));
          }}
        >
          Remove
        </button>
        {removeStatus !== null && (
          <span data-testid="remove-status" class="settings-mono-value" style={{ fontFamily: FONT_MONO }}>
            {text(removeStatus)}
          </span>
        )}
      </div>
    </div>
  );
}

export function Settings({ accounts, api, health, theme, density, layout, onThemeChange, onDensityChange, onLayoutChange, preferences, onPreferenceChange, onAccountsChanged, onClose, onOpenAddAccount, onReorder, onSaveSignature, loadSignatureUrl, onAccountSettingSaved }: SettingsProps): JSX.Element {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const curTheme = theme ?? "light";
  const curDensity = density ?? "comfortable";
  const curLayout = layout ?? "columns";

  // F10 (design-fidelity Pass D): same `GET /healthz` poll Sidebar.tsx
  // already owns for its sync badges (see that file's module comment for
  // the state->badge mapping), fetched here too rather than threaded
  // down from App.tsx -- Settings is reachable without ever mounting
  // Sidebar's own health effect having resolved yet, and a second,
  // independent poll is simpler and lower-risk pre-deploy than plumbing
  // shared state through App.tsx for one settings-page label. A failure
  // here is swallowed exactly like Sidebar's: losing the status label is
  // cosmetic, not a reason to show an error banner.
  const [fetchedHealth, setFetchedHealth] = useState<Map<string, AccountHealth>>(new Map());
  // See Sidebar's `health` prop: audit pass 6 found three independent
  // `/healthz` polls that could disagree about the same account.
  const healthByAccount = health ?? fetchedHealth;
  useEffect(() => {
    if (api === undefined || health !== undefined) return;
    let cancelled = false;
    api
      .health()
      .then((report) => {
        if (!cancelled) setFetchedHealth(new Map(report.accounts.map((a) => [a.account, a])));
      })
      .catch(() => {
        // Deliberately swallowed -- see above.
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const editing = editingKey !== null ? accountLabel(accounts, editingKey) : undefined;
  if (editingKey !== null && editing !== undefined) {
    return (
      <main class="settings" data-testid="settings-pane">
        <div class="settings-inner">
          <AccountDetail
            account={editing}
            onBack={() => setEditingKey(null)}
            onUpdate={api === undefined ? undefined : (patch) => api.updateAccount(editing.key, patch).then(() => onAccountsChanged?.())}
            onResync={api === undefined ? undefined : () => api.resyncAccount(editing.key)}
            onSetCredential={api === undefined ? undefined : (cred) => api.setCredential(editing.key, cred).then(() => onAccountsChanged?.())}
            onRemove={
              api === undefined
                ? undefined
                : () =>
                    api.removeAccount(editing.key).then(() => {
                      setEditingKey(null);
                      onAccountsChanged?.();
                    })
            }
            loadSignatureUrl={loadSignatureUrl}
            loadSettings={api === undefined ? undefined : (key) => api.accountSettings(key)}
            onSaveSetting={
              api === undefined
                ? undefined
                : (key, k, v) =>
                    api.setAccountSetting(key, k, v).then((r) => {
                      onAccountSettingSaved?.(key, k, v);
                      return r;
                    })
            }
            onSaveSignature={
              onSaveSignature === undefined
                ? undefined
                : (identityId, textSignature, htmlSignature) =>
                    onSaveSignature(editing.key, identityId, textSignature, htmlSignature)
            }
          />
        </div>
      </main>
    );
  }

  return (
    <main class="settings" data-testid="settings-pane">
      <div class="settings-inner">
        {/* At the TOP (owner, 2026-09-08): it used to trail the last
            section, a full page of scrolling away from where a person
            arrives. */}
        <button type="button" data-testid="settings-close" class="settings-back-to-mail" onClick={onClose}>
          <ArrowLeft size={12} aria-hidden="true" />
          Back to mail
        </button>
        <h1 class="settings-title">Settings</h1>
        <p class="settings-subtitle">Accounts, identity, and behavior.</p>

        <h2 class="settings-section-title">Accounts</h2>
        <div class="settings-card settings-accounts" data-testid="settings-accounts">
          {accounts.map((a, i) => (
            <AccountCard key={a.key} account={a} health={healthByAccount.get(a.key)} onOpen={setEditingKey}
              first={i === 0} last={i === accounts.length - 1}
              onMove={onReorder === undefined ? undefined : (key, dir) => {
                const keys = accounts.map((x) => x.key);
                const at = keys.indexOf(key); const to = at + dir;
                if (at === -1 || to < 0 || to >= keys.length) return;
                [keys[at], keys[to]] = [keys[to]!, keys[at]!];
                onReorder(keys);
              }} />
          ))}
        </div>
        <button type="button" data-testid="settings-add-account" class="settings-add-account" onClick={() => onOpenAddAccount?.()}>
          <Plus size={12} aria-hidden="true" />
          Add account — JMAP now, IMAP coming
        </button>

        <Section title="Appearance">
          <Row label="Theme" sub="Light or dark chrome">
            <SegPicker
              value={curTheme}
              onPick={(v) => onThemeChange?.(v)}
              options={[
                { value: "light", label: "Light", testId: "theme-light" },
                { value: "dark", label: "Dark", testId: "switch-theme" },
              ]}
            />
          </Row>
          <Row label="Reading pane" sub="Where the open message lives">
            <SegPicker
              value={curLayout}
              onPick={(v) => onLayoutChange?.(v)}
              options={[
                { value: "columns", label: "Beside list", testId: "layout-columns" },
                { value: "rows", label: "Below list", testId: "switch-layout" },
              ]}
            />
          </Row>
          <Row label="Density" sub="List row spacing" last>
            <SegPicker
              value={curDensity}
              onPick={(v) => onDensityChange?.(v)}
              options={[
                { value: "comfortable", label: "Comfortable", testId: "density-comfortable" },
                { value: "compact", label: "Compact", testId: "switch-density" },
              ]}
            />
          </Row>
        </Section>

        <Section title="Reading">
          <Row label="Mark as read" sub="When an open thread counts as read">
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <SegPicker
                value={preferences.markRead}
                onPick={(v) => onPreferenceChange("markRead", v)}
                options={[
                  { value: "instant", label: "Instantly", testId: "mark-read-instant" },
                  { value: "after2s", label: "After 2s", testId: "mark-read-after2s" },
                  { value: "manual", label: "Manually", testId: "mark-read-manual" },
                ]}
              />
            ) : (
              <SegPickerDisabled testId="mark-read-timing" options={["Instantly", "After 2s", "Manually"]} activeValue="After 2s" />
            )}
          </Row>
          <Row label="Remote images" sub="In HTML mail">
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <SegPicker
                value={preferences.remoteImages}
                onPick={(v) => onPreferenceChange("remoteImages", v)}
                options={[
                  { value: "always", label: "Always", testId: "remote-images-always" },
                  { value: "ask", label: "Ask per sender", testId: "remote-images-ask" },
                ]}
              />
            ) : (
              <SegPickerDisabled testId="remote-images" options={["Always", "Ask per sender"]} activeValue="Ask per sender" />
            )}
          </Row>
          <Row label="Group into conversations" sub="Thread replies together" last>
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <Switch
                testId="group-conversations"
                on={preferences.groupConversations === "on"}
                onToggle={() => onPreferenceChange("groupConversations", preferences.groupConversations === "on" ? "off" : "on")}
              />
            ) : (
              <SwitchDisabled testId="group-conversations" on={true} />
            )}
          </Row>
        </Section>

        <Section title="Composing">
          <Row label="Undo send window" sub="Hold outgoing mail before it leaves">
            <SegPickerDisabled testId="send-delay" options={["Off", "5s", "10s", "30s"]} activeValue="10s" />
          </Row>
          <Row label="Quote history in replies" sub="Include the chain below your reply">
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <Switch
                testId="quote-history-replies"
                on={preferences.quoteHistory === "on"}
                onToggle={() => onPreferenceChange("quoteHistory", preferences.quoteHistory === "on" ? "off" : "on")}
              />
            ) : (
              <SwitchDisabled testId="quote-history-replies" on={true} />
            )}
          </Row>
          <Row label="Signature in replies" sub="Above the quoted message, next to yours, or below it">
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <SegPicker
                value={preferences.signaturePlacement}
                onPick={(v) => onPreferenceChange("signaturePlacement", v)}
                options={[
                  { value: "above", label: "Above quote", testId: "signature-above" },
                  { value: "below", label: "Below quote", testId: "signature-below" },
                ]}
              />
            ) : (
              <SegPickerDisabled testId="pref-signature-placement" options={["Above quote", "Below quote"]} activeValue="Above quote" />
            )}
          </Row>
          <Row label="Reply all by default" sub="When a thread has multiple recipients">
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <Switch
                testId="reply-all-default"
                on={preferences.replyAllDefault === "on"}
                onToggle={() => onPreferenceChange("replyAllDefault", preferences.replyAllDefault === "on" ? "off" : "on")}
              />
            ) : (
              <SwitchDisabled testId="reply-all-default" on={false} />
            )}
          </Row>
          <Row label="Signature" sub="Per account, appended to new messages" last>
            <span class="settings-mono-value" style={{ fontFamily: FONT_MONO }}>
              {"—"}
            </span>
          </Row>
        </Section>

        <Section title="Notifications">
          <Row label="Desktop notifications" sub="New mail toasts in the corner">
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <Switch
                testId="notif-desktop"
                on={preferences.notifDesktop === "on"}
                onToggle={() => onPreferenceChange("notifDesktop", preferences.notifDesktop === "on" ? "off" : "on")}
              />
            ) : (
              <SwitchDisabled testId="notif-desktop" on={true} />
            )}
          </Row>
          <Row label="People only" sub="Mute automated senders — receipts, robots, newsletters">
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <Switch
                testId="notif-people-only"
                on={preferences.notifPeopleOnly === "on"}
                onToggle={() => onPreferenceChange("notifPeopleOnly", preferences.notifPeopleOnly === "on" ? "off" : "on")}
              />
            ) : (
              <SwitchDisabled testId="notif-people-only" on={true} />
            )}
          </Row>
          <Row label="Sound" last>
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <Switch
                testId="notif-sound"
                on={preferences.notifSound === "on"}
                onToggle={() => onPreferenceChange("notifSound", preferences.notifSound === "on" ? "off" : "on")}
              />
            ) : (
              <SwitchDisabled testId="notif-sound" on={false} />
            )}
          </Row>
        </Section>

        <Section title="Behavior">
          <Row label="Archive on reply" sub="Move thread out of inbox after replying">
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <Switch
                testId="archive-on-reply"
                on={preferences.archiveOnReply === "on"}
                onToggle={() => onPreferenceChange("archiveOnReply", preferences.archiveOnReply === "on" ? "off" : "on")}
              />
            ) : (
              <SwitchDisabled testId="archive-on-reply" on={true} />
            )}
          </Row>
          <Row label="Unified inbox on launch" sub="Open All inboxes instead of the last account" last>
            {preferences !== undefined && onPreferenceChange !== undefined ? (
              <Switch
                testId="unified-inbox-launch"
                on={preferences.unifiedInboxAtLaunch === "on"}
                onToggle={() => onPreferenceChange("unifiedInboxAtLaunch", preferences.unifiedInboxAtLaunch === "on" ? "off" : "on")}
              />
            ) : (
              <SwitchDisabled testId="unified-inbox-launch" on={true} />
            )}
          </Row>
        </Section>

      </div>
    </main>
  );
}
