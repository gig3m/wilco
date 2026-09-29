// The ⌘K command palette (Task 10). Per DESIGN.md "5. Search & command
// palette": commands (compose, go-to account/folder, saved searches,
// toggles) with a mono hint column, filtered by what's typed. This
// component is deliberately dumb about WHAT the items mean -- App.tsx
// assembles the item list (commands from keymap.ts's `COMMANDS`, plus
// mailbox/account go-to entries) and this file only filters, highlights
// selection, and reports which id was chosen. Keeping the assembly in
// App.tsx is what let Task 10's ruling ("wire your components in") be
// satisfied without this file needing to know about routes or accounts.
//
// Every label/hint here can originate from server data (a mailbox or
// account name is attacker-controlled, same as Sidebar/MessageList) --
// rendered only as JSX children via `text()`, matching the rest of this
// client.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { text } from "../lib/escape";

export interface PaletteItem {
  id: string;
  label: string;
  /** The mono hint column -- a key binding ("j"), a group name
   *  ("Mailbox", "Account"), or similar. Purely decorative. */
  hint?: string;
  /** Present exactly when this item is not actually runnable -- mirrors
   *  `Command.disabledReason` from keymap.ts. Shown, not hidden, and
   *  never selectable. */
  disabledReason?: string;
}

export interface PaletteProps {
  items: PaletteItem[];
  /**
   * Live mail results for the current query (audit pass 3 D4). Appended
   * BELOW the commands, and only when fewer than `MAIL_FLOOR` of them
   * survived the filter.
   *
   * 🚨 That ordering rule is the design's own (`Wilco.dc.html:1270-1287`)
   * and it is what keeps the palette usable: typing a command must never
   * bury it under messages that happen to share a word with it.
   */
  mailItems?: PaletteItem[];
  /** Reports the query so a caller can search for `mailItems`. Debouncing
   *  is the caller's job -- this fires on every keystroke. */
  onQueryChange?: (query: string) => void;
  /** Called with the chosen item's `id`. The palette closes itself via
   *  `onClose` immediately after -- callers don't need to close it from
   *  inside `onSelect`. */
  onSelect: (id: string) => void;
  onClose: () => void;
}

function matches(item: PaletteItem, query: string): boolean {
  if (query.trim().length === 0) return true;
  const q = query.toLowerCase();
  return item.label.toLowerCase().includes(q) || (item.hint ?? "").toLowerCase().includes(q);
}

/** Below this many matching commands, mail results are worth showing; at or
 *  above it the person is clearly driving the palette as a command bar.
 *  The design's number. */
const MAIL_FLOOR = 6;

export function Palette({ items, mailItems, onQueryChange, onSelect, onClose }: PaletteProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commandMatches = useMemo(() => items.filter((i) => matches(i, query)), [items, query]);
  // Mail is appended, never interleaved, and only when the commands have
  // thinned out -- see `mailItems`' own note for why that rule matters.
  const filtered = useMemo(
    () =>
      commandMatches.length < MAIL_FLOOR && mailItems !== undefined && mailItems.length > 0
        ? [...commandMatches, ...mailItems]
        : commandMatches,
    [commandMatches, mailItems],
  );

  useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);
  const selectable = useMemo(() => filtered.filter((i) => i.disabledReason === undefined), [filtered]);

  // A query edit can shrink the selectable list out from under the
  // current highlight index -- clamp rather than let it point past the
  // end (or negative on an empty list).
  useEffect(() => {
    setHighlighted((h) => Math.max(0, Math.min(h, selectable.length - 1)));
  }, [selectable.length]);

  function choose(item: PaletteItem): void {
    if (item.disabledReason !== undefined) return;
    onSelect(item.id);
    onClose();
  }

  function handleKeyDown(e: JSX.TargetedKeyboardEvent<HTMLDivElement>): void {
    // Stop the global keymap (App.tsx's window listener) from also
    // interpreting these keys as commands while the palette owns focus --
    // e.g. "j" here must move the highlight, not the message list behind
    // it, and it must not insert into the input either since Enter/Escape
    // are handled here directly.
    e.stopPropagation();
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, Math.max(0, selectable.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = selectable[highlighted];
      if (item !== undefined) choose(item);
    }
  }

  return (
    <div data-testid="palette" class="palette-overlay" role="dialog" aria-modal="true" onKeyDown={handleKeyDown}>
      <div data-testid="palette-scrim" class="palette-scrim" onClick={onClose} />
      <input
        ref={inputRef}
        type="text"
        data-testid="palette-input"
        class="palette-panel palette-input"
        placeholder="Type a command, mailbox, or account…"
        value={query}
        onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setQuery(e.currentTarget.value)}
      />
      <ul data-testid="palette-items" class="palette-panel palette-list">
        {filtered.length === 0 ? (
          <li data-testid="palette-empty" class="palette-empty">No matches</li>
        ) : (
          filtered.map((item) => {
            const selectableIndex = selectable.indexOf(item);
            const isHighlighted = selectableIndex !== -1 && selectableIndex === highlighted;
            return (
              <li
                key={item.id}
                data-testid={`palette-item-${item.id}`}
                class="palette-item"
                aria-selected={isHighlighted ? "true" : "false"}
                aria-disabled={item.disabledReason !== undefined ? "true" : "false"}
                onClick={() => choose(item)}
                onMouseEnter={() => selectableIndex !== -1 && setHighlighted(selectableIndex)}
              >
                <span data-testid={`palette-label-${item.id}`}>{text(item.label)}</span>
                {item.hint !== undefined && (
                  <span
                    data-testid={`palette-hint-${item.id}`}
                    class="palette-hint"
                    style={{ fontFamily: "var(--font-mono, monospace)" }}
                  >
                    {text(item.hint)}
                  </span>
                )}
                {item.disabledReason !== undefined && (
                  <span data-testid={`palette-disabled-${item.id}`} class="palette-disabled">
                    {text(item.disabledReason)}
                  </span>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
