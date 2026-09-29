// Add-account onboarding (design-fidelity plan, Task 7) -- transcribed
// from docs/design/Wilco.dc.html's "Add account" modal (~lines 567-647:
// the `obOpen` block) and its `ob*` handlers (~lines 833-863). A three-step
// modal with a 2px accent top edge: protocol (JMAP live, IMAP dimmed and
// disabled with "soon"), address/server/token/color with a live account
// code, then a mono terminal log ending in "Open inbox".
//
// 🚨 Unlike every other screen this plan touched, THIS ONE IS GENUINELY
// WIRED: `POST /api/accounts` (src/server/accounts-api.ts) verifies the
// submitted endpoint + credential BEFORE storing anything -- trying the
// domain's own `.well-known/jmap` first and falling back to Fastmail's
// session URL when that doesn't answer -- and, in the same request, really
// seals `token` into the configured credential store (see
// `AddAccountInput`'s doc comment in api.ts for why this is one call, not
// the two the route table exposes). Step 3's terminal log is driven
// ENTIRELY by that one real response: "verifying …" prints synchronously
// before the call, and nothing else prints until it settles -- the three
// "✓" lines and "Open inbox" only ever appear after a real 2xx, and report
// exactly the endpoint the server resolved and the username it verified
// (never a fabricated capability list). A real failure prints the server's
// own error text and stops there. A canned animation that always ends in
// success would be a lie about whether the account actually works; there
// is deliberately no `setTimeout`-staged fake progress anywhere in this
// file.
//
// ⚠️ One honesty note the design's own mock prototype doesn't carry,
// because its `obFinish` pretends the account is instantly live:
//   - The accounts API is session-only (accounts-api.ts's own doc
//     comment) -- this component is only ever reachable from inside the
//     already-authenticated SPA, never with a bearer token, so nothing
//     here needs to think about that split.
//   - Adding an account now takes effect immediately in the running sync
//     supervisor (no restart needed) -- but "Open inbox" still just closes
//     the modal rather than navigating into the new account's inbox,
//     because syncing has only just begun and there is nothing to show
//     yet. The step-3 log says "syncing — messages appear as they arrive"
//     rather than implying the inbox is already populated.
//
// 🚨 The token never becomes a text node anywhere in this file. It lives
// only in `token` state, a controlled `<input type="password">`'s DOM
// property, and the JSON body of the one `api.addAccount` call -- never
// interpolated into a log line, an error message, or any other rendered
// string. AddAccount.test.tsx's
// "THE TOKEN NEVER APPEARS IN THE TERMINAL LOG" test is the proof.
//
// Two derivations this file must NOT reinvent, per the plan's binding
// ruling: `key` is domain-derived (the only identity input step 2 actually
// collects -- there is no separate "key" or "display name" field in the
// design, exactly like the prototype's own `obFinish`/`obCode`), and the
// live code preview uses the SAME rule `addAccount` (src/core/accounts.ts)
// uses server-side for an omitted `code` -- first three letters of the
// key, uppercased. No `code` is ever sent in the request body; the server
// derives it identically, so there is nothing to reconcile.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { ChevronRight, RotateCw, X } from "lucide-preact";
import { ApiError, type Api, type AccountSpec } from "../lib/api";
import { text } from "../lib/escape";

const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

// Design line 1418 (`obColors`) verbatim -- a DIFFERENT six hexes than
// Settings.tsx's `ACCENT_SWATCHES` (the account-editor's own palette,
// design line 1372). The two pickers are not the same control and the
// design does not give them the same six colors; this file transcribes
// its own literally rather than reusing Settings' constant.
const OB_COLORS = ["#4a9bb8", "#cf5f5f", "#7aa843", "#8d6ac9", "#c9903a", "#5b6ee0"];

const IMAP_REASON = "Via the Wilco bridge. On the roadmap.";

interface LogLine {
  mark: string;
  color: string;
  text: string;
}

export interface AddAccountProps {
  api: Api;
  onClose: () => void;
  /** Fired once the account row (and, when a token was given, its sealed
   *  credential) really exists server-side -- so a caller can refresh its
   *  own fetched account list. Does NOT mean the account is syncing; see
   *  this file's module comment. */
  onCreated?: (spec: AccountSpec) => void;
}

function domainOf(email: string): string {
  const at = email.indexOf("@");
  if (at === -1 || at === email.length - 1) return "";
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

// Mirrors ACCOUNT_KEY_PATTERN (src/core/accounts.ts): lowercase
// alphanumerics and hyphens, starting with an alphanumeric, capped at 32
// characters. A domain's dots are simply dropped rather than turned into
// hyphens -- "halden.example" -> "haldenexample" -- matching the design's own
// `obCode`, which strips everything but letters from the same string.
function deriveKey(domain: string): string {
  if (domain === "") return "";
  const cleaned = domain.replace(/[^a-z0-9-]/g, "").replace(/^-+/, "");
  return cleaned.slice(0, 32);
}

// Design line 854 (`obFinish`): the domain's first label, capitalized.
// There is no separate "display name" field anywhere in step 2.
function deriveLabel(domain: string): string {
  const first = (domain.split(".")[0] ?? "").trim();
  if (first === "") return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// The server's own default for an omitted `code` (accounts.ts's
// `addAccount`): first three letters of the key, uppercased.
function deriveCode(key: string): string {
  return key.slice(0, 3).toUpperCase();
}

export function AddAccount({ api, onClose, onCreated }: AddAccountProps): JSX.Element {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState("");
  const [endpointOverride, setEndpointOverride] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [color, setColor] = useState(OB_COLORS[0]!);
  const [log, setLog] = useState<LogLine[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const domain = domainOf(email);
  const derivedEndpoint = domain !== "" ? `https://${domain}/.well-known/jmap` : "";
  const endpointValue = endpointOverride ?? derivedEndpoint;
  const key = deriveKey(domain);
  const label = deriveLabel(domain);
  const code = deriveCode(key);
  const canConnect = email.includes("@") && key !== "";

  function stop(e: JSX.TargetedMouseEvent<HTMLElement>): void {
    e.stopPropagation();
  }

  async function handleConnect(): Promise<void> {
    if (!canConnect) return;
    setStep(3);
    setDone(false);
    setConnecting(true);
    setLog([{ mark: "·", color: "var(--faint)", text: `verifying ${endpointValue}` }]);

    try {
      const created = await api.addAccount({
        key,
        label: label !== "" ? label : key,
        accent: color,
        provider: "jmap",
        endpoint: endpointValue,
        credential: token,
      });
      setLog((prev) => [
        ...prev,
        { mark: "✓", color: "var(--success)", text: `connected as ${created.username ?? "(no username)"}` },
        { mark: "✓", color: "var(--success)", text: `endpoint ${created.endpoint}` },
        { mark: "✓", color: "var(--success)", text: "syncing — messages appear as they arrive" },
      ]);
      setConnecting(false);
      setDone(true);
      onCreated?.(created);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "connection failed";
      setLog((prev) => [...prev, { mark: "✕", color: "var(--danger)", text: `failed — ${message}` }]);
      setConnecting(false);
    }
  }

  return (
    <div class="addaccount-scrim" data-testid="add-account-modal" onClick={onClose}>
      <div class="addaccount-card" onClick={stop}>
        <div class="addaccount-header">
          <span class="addaccount-title">Add account</span>
          <span class="addaccount-step-label" style={{ fontFamily: FONT_MONO }}>
            step {step}/3 · JMAP
          </span>
          <button type="button" data-testid="add-account-close" class="addaccount-close" onClick={onClose}>
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>

        {step === 1 && (
          <div class="addaccount-step1" data-testid="step-1">
            <div class="addaccount-step1-lead">How does this account speak?</div>
            <button type="button" data-testid="proto-jmap" class="addaccount-proto addaccount-proto-jmap" onClick={() => setStep(2)}>
              <span class="addaccount-proto-badge addaccount-proto-badge-jmap" style={{ fontFamily: FONT_MONO }}>
                JMAP
              </span>
              <span class="addaccount-proto-body">
                <span class="addaccount-proto-name">Native</span>
                <span class="addaccount-proto-sub">Push, server-side search, one round trip. Fastmail and friends.</span>
              </span>
              <span class="addaccount-proto-arrow" aria-hidden="true">
                <ChevronRight size={12} strokeWidth={1.5} />
              </span>
            </button>
            <button type="button" data-testid="proto-imap" class="addaccount-proto addaccount-proto-imap" disabled title={IMAP_REASON}>
              <span class="addaccount-proto-badge addaccount-proto-badge-imap" style={{ fontFamily: FONT_MONO }}>
                IMAP
              </span>
              <span class="addaccount-proto-body">
                <span class="addaccount-proto-name">Everything else</span>
                <span class="addaccount-proto-sub">{text(IMAP_REASON)}</span>
              </span>
              <span class="addaccount-soon-badge" style={{ fontFamily: FONT_MONO }}>
                soon
              </span>
            </button>
          </div>
        )}

        {step === 2 && (
          <div class="addaccount-step2" data-testid="step-2">
            <div class="addaccount-field-row">
              <span class="addaccount-field-label" style={{ fontFamily: FONT_MONO }}>
                address
              </span>
              <input
                data-testid="address"
                class="addaccount-field-input"
                placeholder="you@domain.com"
                value={email}
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="addaccount-field-row">
              <span class="addaccount-field-label" style={{ fontFamily: FONT_MONO }}>
                server
              </span>
              <input
                data-testid="endpoint"
                class="addaccount-field-input addaccount-field-mono"
                style={{ fontFamily: FONT_MONO }}
                placeholder="https://…/.well-known/jmap (auto, falls back to Fastmail)"
                value={endpointValue}
                onInput={(e) => setEndpointOverride((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="addaccount-field-row">
              <span class="addaccount-field-label" style={{ fontFamily: FONT_MONO }}>
                token
              </span>
              <input
                data-testid="token"
                type="password"
                class="addaccount-field-input"
                placeholder="API token"
                value={token}
                onInput={(e) => setToken((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="addaccount-color-row">
              <span class="addaccount-field-label" style={{ fontFamily: FONT_MONO }}>
                color
              </span>
              {OB_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  data-testid={`ob-color-${c.slice(1)}`}
                  class="addaccount-swatch"
                  style={{ background: c, borderColor: color === c ? "var(--ink)" : "transparent" }}
                  onClick={() => setColor(c)}
                />
              ))}
              <span class="addaccount-spacer" />
              <span class="addaccount-code-preview" data-testid="code-preview" style={{ fontFamily: FONT_MONO }}>
                code {text(code)}
              </span>
            </div>
            <div class="addaccount-actions">
              <button type="button" data-testid="submit" class="addaccount-connect" disabled={!canConnect} onClick={handleConnect}>
                Connect
              </button>
              <button type="button" data-testid="ob-back" class="addaccount-back" onClick={() => setStep(1)}>
                Back
              </button>
              <span class="addaccount-spacer" />
              <span class="addaccount-discovery-hint" style={{ fontFamily: FONT_MONO }}>
                tries .well-known/jmap first, falls back to Fastmail's session URL
              </span>
            </div>
          </div>
        )}

        {step === 3 && (
          <div class="addaccount-step3" data-testid="step-3">
            {/* Task: adopt Lucide icons -- the `·`/`✓`/`✕` marks here are
             *  deliberately left as literal mono-terminal punctuation, not
             *  converted to Lucide icons. This is a CLI-transcript aesthetic
             *  (module comment: "mono terminal log"), and the handoff's own
             *  icon list (⌕ ◎ ★ ✎ ↗ ▤ ▣ ◐ 📎) never named check/x marks as
             *  part of the app's icon system -- surfacing this rather than
             *  guessing, per the plan's "the design is the design, don't
             *  interpret" rule. The spinner just below IS converted: it's a
             *  loading indicator (an icon by any reading), not a transcript
             *  character. */}
            <div class="addaccount-terminal" data-testid="terminal" style={{ fontFamily: FONT_MONO }}>
              {log.map((ln, i) => (
                <div key={i} class="addaccount-log-line">
                  <span style={{ color: ln.color }}>{ln.mark}</span>
                  <span>{text(ln.text)}</span>
                </div>
              ))}
              {connecting && (
                <div class="addaccount-log-line">
                  <span class="addaccount-spinner" aria-hidden="true">
                    <RotateCw size={12} />
                  </span>
                </div>
              )}
            </div>
            {done && (
              <button type="button" data-testid="open-inbox" class="addaccount-open-inbox" onClick={onClose}>
                Open inbox
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
