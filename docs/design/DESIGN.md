# Design: Wilco — Multi-Inbox Email Client (SPA)

## Overview
Wilco is a desktop-web email client built over **JMAP** (IMAP planned via a bridge). Model: **multi-inbox** — several fully separate accounts stacked in one sidebar, plus a unified "All inboxes" view. Search is first-class (operator query language, saved searches, command palette). Design goal: "standard email behavior — the wheel we want," serious/instrument feel, not consumer-cute.

## About the Design Files
The files in this bundle are **design references created in HTML** — a working prototype showing intended look and behavior, not production code. Recreate this design in the target codebase's environment and patterns (React/TS + a JMAP client library is the assumed target; if none exists yet, pick the stack that fits). `Wilco.dc.html` contains the full template (HTML w/ inline styles) and a logic class (plain JS, React-style state) that together implement every screen and interaction listed below; `support.js` is the prototype runtime and can be ignored for implementation.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and interactions are final intent. Recreate pixel-perfectly. All styling is inline in the template, so every value is readable at the point of use.

## Design Tokens

### Colors (CSS custom properties; light / dark)
| Token | Light | Dark | Use |
|---|---|---|---|
| --bg | #f3f4f5 | #121316 | app background |
| --panel | #ffffff | #1a1c1f | cards, list, reading pane |
| --panel2 | #fafbfb | #16171a | sidebar, secondary surfaces |
| --ink | #191b1e | #e6e8ea | primary text |
| --muted | #5f666e | #9aa0a7 | secondary text |
| --faint | #959ba3 | #686e75 | tertiary/meta text |
| --line | #dde0e3 | #2b2e32 | borders |
| --line2 | #eaecee | #222428 | hairline dividers |
| --accent | #5b6ee0 | #7b8cf0 | actions, unread, selection (user-tweakable) |
| --accent-ink | #ffffff | #141519 | text on accent |
| --hover | #eef0f2 | #222428 | row hover |
| --sel | #e8eafa | #262a3c | selected row / active nav |
| --scrim | rgba(18,20,24,.36) | rgba(0,0,0,.55) | overlay backdrop |

Account identity colors (left-edge on rows, avatar, settings): Halden #5b6ee0, Wilco #2a9d6e, Meridian #c9903a, Personal #b05fc9. Star/flag: #c9903a. Danger: #cf222e (light) / #cf5f5f. Success: #2a9d6e.

### Typography
- **UI**: IBM Plex Sans (400/500/600/700), fallback Helvetica/Arial.
- **Meta/mono**: IBM Plex Mono (400/500/600) — timestamps, account codes (HAL/NBU/…), counts, search queries, operators, shortcuts, technical footnotes. The mono-for-facts pattern is core to the visual identity.
- Sizes: 9–10px mono meta · 11–12.5px secondary · 12.5–13.5px body · 14–16px headings · 20px settings page titles. Print view: Georgia serif.

### Shape & depth
- Radii: 2px (chips, kbd) / 3px (buttons, inputs, rows) / 4–5px (cards, modals). Deliberately squared — no pill shapes.
- Shadows: overlays only (`0 24px 70px rgba(0,0,0,.3)` modals, `0 8px 28px .18` dropdowns, `0 16px 48px .12` compose card). Flat surfaces elsewhere; 1px borders carry structure.
- Accent top-border (2px) marks primary work surfaces: compose card, add-account modal.
- Animations: fadein .08–.1s, pop (4px rise) .1–.12s. No decorative motion.

## Layout
Root: full-viewport flex row. **Sidebar 242px** (fixed) · **message list 392px** default (drag divider, 280–620px) · **reading pane** fills rest. Alternate **rows layout** (`v`): list on top (42% default, drag 20–75%), reading below. List density: comfortable 9px / compact 5px row padding (tweak).

## Screens / Views

### 1. Sidebar (always visible)
- Header: 20px black square "N" logo, app name, total-unread mono count.
- Compose button (accent, full width, `C` kbd hint right-aligned).
- "All inboxes" row, then **4 stacked account blocks**: 3×14px color bar + uppercase name + mono code + collapse chevron. Folders per account: Inbox (unread count in accent), Drafts, Sent, Archive, Spam, Trash + custom folders (Clients, GitHub, Linear, Invoices, Travel). Active folder = --sel background, weight 600.
- "＋ Add account" row → onboarding modal.
- Saved searches section: ◎ icon + mono query + result count; right-click → Run / Remove (undoable). Defaults: from:mira, has:attachment, is:unread, is:flagged.
- Footer: ⚙ Settings, theme toggle (◐/◑), ? shortcuts.
- Account sync states: colored dot / spinner / error badge per account (auth-expired shows re-auth banner in list; Personal shows "IMAP · soon" pending state).

### 2. Message list
- Header: view title + mono count ("14 · 5 unread"); replaced by bulk action bar when any selected ("n selected" + All / Mark read / Archive / ✕).
- Search field with ⌘K hint; active search shows operator chips (from:, has:attachment, is:unread, newer_than:3d, acct:) + "＋ Save search"; recent searches dropdown on focus.
- Rows (columns layout): 3px account-color left edge, checkbox, sender (700 if unread), account code (mono, colored), time (mono), subject line, snippet + ★/📎/unread-dot. Rows layout: single-line table (checkbox · code · sender 168px · subject — snippet · flags · time 38px right).
- Group headers: Today / Earlier (mono uppercase); search in All groups by account instead.
- Search matches highlighted (--sel background on matched substrings).
- Pagination: cap 12, footer "Show N more — 12 of 20" (mono), +25 per click, resets on folder switch.
- Trash: banner "kept 30 days" + red Empty trash. Per-folder empty states ("Inbox zero — enjoy it while it lasts").
- Drag thread onto a sidebar folder to move.
- Context menu: Open / Reply / Forward / Mark read / Flag / Select / Print / Move to… / Archive / Spam / Delete.

### 3. Reading pane
- Header: subject (truncating), account color square + mono meta; actions: ↑↓ prev-next, ★, Archive, Spam, Delete, Forward, Reply (accent).
- Conversation: collapsed earlier messages (single-line: avatar, name, preview, time) → click expands. Cards: avatar (squared, account-colored), name + address (mono), time, ··· menu (View source / Copy address).
- **HTML messages render as HTML** (newsletters, receipts); remote images gated by "ask" pref banner. Plain-text kept mono-ish body 13.5px/1.65.
- Attachment chips → preview overlay (name, type badge, size, Download).
- Quoted history collapsed behind "···" toggle.
- Contact hover card on sender: name, address, thread count, Search from:x, Compose.
- Empty state: "Nothing selected · j/k to move · ⏎ to open · ⌘K for anything."

### 4. Compose (first-class, never a modal)
Fills the reading pane as a bordered card (accent top edge, shadow) over --bg. Header: title + "draft saved · esc" + ✕. Fields (52px mono labels): from (select incl. **send-as aliases**, "· alias" suffix), to (with **contact autocomplete** ≥2 chars), cc/bcc (toggle), subject. Markdown toolbar: B i <> [] > — wraps selection; footnote "markdown → sent as text/html + text/plain". Body textarea 13.5px/1.65. Signature block (per-account, text or HTML mode, dashed border preview). Attachment chips w/ remove. Reply shows collapsed quote toggle. Footer: Send (accent), Attach, Discard, "⌘⏎ send". Esc saves to Drafts; Send honors undo-send delay with live countdown toast.

### 5. Search & command palette
- Query language: `from:` `in:` `acct:` `has:attachment` `is:unread|flagged` `before:`/`after:day` `newer_than:Nd`/`older_than:Nd`, free text over sender/subject/body.
- ⌘K palette: commands (compose, go-to account/folder, saved searches, toggles, add account) + live mail results when query matches; mono hint column; `g` then key go-to chords.

### 6. Settings
Home: Accounts list (color bar, name+code, address mono, JMAP/IMAP badge, Manage) → per-account page: Identity (display name, color, code), Send-as aliases (chips + add/remove), Server (endpoint, resync), Signature (text/HTML w/ preview, use-in-new/replies toggles), Danger zone (remove account). Global sections: Appearance (theme, density, layout), Reading (mark-read timing: now/2s/manual, images ask/always, conversation grouping), Composing (send delay off/5s/10s/30s, reply-all default, quote history), Notifications (desktop, human-only filter, sound), Behavior (archive-on-reply, unified-on-launch). Squared toggle switches (32×18, square knob).

### 7. Add account onboarding (modal, 3 steps)
1) Protocol pick: JMAP card vs dimmed IMAP "soon" card. 2) Address / server (auto-derives `https://{domain}/.well-known/jmap`) / token / color + live account code. 3) Mono terminal log: resolving → session established · JMAP 1.0 → capabilities → mailboxes, spinner, then "Open inbox" (account lands in sidebar, syncing).

### 8. Overlays
Keyboard shortcuts (?), raw message source (mono, headers + body), attachment preview, move-to picker, undo toast (bottom-center, dark, action + Undo + `z` hint, 7s or live countdown for send), desktop-notification toasts (top-right, account-colored edge), context menus (thread / message / folder / saved search).

## Interactions & Behavior
- **Keyboard-first**: j/k move · ⏎ open · x select · shift-click range · c/r/f compose-reply-forward · a reply-all · e archive · # delete · s flag · u all-inboxes · v layout · t theme · / search · ⌘K palette · g-chords go-to · z undo · ? shortcuts · esc close/save-draft · ⌘⏎ send.
- Mark-as-read honors pref (instant / 2s dwell / manual). Unread = accent dot + weight 700.
- All destructive actions undoable via toast (single + bulk archive/delete/spam, saved-search removal, send).
- Archive-on-reply pref moves thread after replying.
- Simulated push (`n` in prototype) shows notification toast + list insert at top.

## State Management (implementation guide)
- Server state via JMAP: Mailbox, Thread, Email, Identity (aliases), EmailSubmission (undo-send via scheduled submission), SearchSnippet for highlighting; push via EventSource/StateChange.
- Client state: selected scope (all | accountId) + folder, selection set, search query + saved searches (server-syncable), drafts (Draft mailbox), prefs (per-user), theme/layout/density (local), pane sizes (local).
- Optimistic updates with undo window; move = keyword/mailbox patch.

## Assets
None. Logo is a typographic "N" square. Icons are unicode glyphs (⌕ ◎ ★ ✎ ↗ ▤ ▣ ◐ 📎) — replace with a real icon set (e.g. Lucide) at implementation, keeping the compact 11–13px scale.

## Files
- `Wilco.dc.html` — full prototype: template (all screens, inline styles) + logic class (all behavior, mock data, search parser, JMAP-shaped account objects).
- `support.js` — prototype runtime; ignore.

## v1.1 — States specified after first implementation round

These six areas were undesigned in the original handoff; they are now fully
designed in `Wilco.dc.html`. **Treat this section as the authority over any
improvised v1 implementation.**

1. **Thread count badge** — list rows show the message count (mono 9.5px, --faint) directly after the sender when a thread has >1 message. Both layouts. No parentheses, no pill.
2. **Body-pipeline chrome (reading pane)** — notices are full-width strips INSIDE the message card, mono 10.5px on --panel2 with hairline dividers, never floating rows around the frame:
   - *Blocked images*: strip between card header and body — "◻ remote images blocked" + [Load images] (bordered, --panel bg) + "Always from this sender" (borderless, --faint). Shows on open HTML messages when the images pref is "ask".
   - *Loaded state*: same strip becomes "✓ remote images loaded · this message" (or "· always for {address}"), --faint, no actions.
   - *Truncation*: strip below the body (border-top) — "✂ message truncated · showing 64 KB of 412 KB" + [Load full message]. Loading appends the remainder in place. (See the Priya Raman IMAP-bridge message.)
   - *Formatted/plaintext toggle*: the `text/html` badge in the message header IS the toggle — click flips rendered HTML ↔ extracted plain text and the badge relabels to `text/plain`. No separate control. Non-HTML messages show an inert `text/plain` badge (default cursor).
3. **Compose attachment chip states** — three variants of the same chip geometry (mono 11px, radius 3):
   - *Uploading*: dashed border, --muted text, accent ⟳ spinning (1.1s linear), mono percent instead of size.
   - *Failed*: #cf222e border and text, "· failed", bold ↻ retry + ✕ remove.
   - *Done*: solid --line border, name + --faint size + ✕ (unchanged from v1).
4. **Compose draft status** (header, mono 10.5px): "not saved · esc" (--faint) → "saving…" (--muted) while typing (any field edit, ~900ms debounce) → "draft saved HH:MM · esc" (--faint).
5. **Compose signature block, HTML mode** — inside the dashed signature box, the rendered HTML sits in an inset frame: --bg background, 1px --line2 border, radius 3, padding 9×12, max-height 110px w/ scroll. Label reads "signature · text/html · {CODE}". Plain-text mode stays frameless (pre-line, --muted).
6. **Settings signature editor** — preview section is always visible (both formats), labelled "preview · text/html|text/plain" with the same inset frame as #5. Below it a status row: left mono status text — "unsaved changes" (#c9903a) while dirty, "saved HH:MM" (--faint) after save — and a right-aligned [Save signature] button (accent fill when dirty; bordered --faint ghost when clean). Format flips and toggles do not dirty the signature; text edits do.


## Deviations by owner ruling

- **2026-09-07 — the composer is a rich editor, not the markdown textarea.**
  Section 4's "Markdown toolbar: B i <> [] > … sent as text/html + text/plain",
  the plain body textarea, and v1.1 #5's compose signature frame are
  superseded. The owner's reference is Fastmail's composer: the signature
  rendered IN the editor at open, after an empty line, editable; Fastmail's
  formatting bar (bold, italic, underline, strikethrough, font, clear, colour,
  highlight, image, link, lists, quote in/out, four alignments); the quoted
  original read-only below in the sandboxed body frame. The
  Settings signature editor (v1.1 #6) is also superseded: HTML previewed
  whole, edited in Fastmail (ruling 2026-09-06, row 38).
