// The search UI (Task 9, spec milestone M5) -- the reason this project
// exists. Per DESIGN.md "4. Message list" / "5. Search & command
// palette": a search field with a ⌘K hint; an active search shows
// operator chips + "＋ Save search"; a recent-searches dropdown on focus;
// matches highlighted with `--sel` on matched substrings; results grouped
// by account (not Today/Earlier, unlike the folder view).
//
// Three facts this file exists to honour:
//
//   - The query NEVER reaches a URL (spec 8.3) -- `api.search()` already
//     does this correctly (POST body), so this component only ever calls
//     that, never a hand-rolled `fetch`.
//   - Every search runs its predicate TWICE server-side (count + page),
//     and the count half has no LIMIT escape -- so this debounces at
//     200ms and cancels superseded requests, rather than searching on
//     every keystroke.
//   - Search results are ATTACKER-authored (subjects, sender names,
//     snippets) rendering in the chrome, two milestones before the body
//     sandbox exists (spec §10). Every value here reaches the DOM only as
//     a JSX child (Preact-escaped) or through escape.ts's `highlight`,
//     which returns segments, never markup -- this file never sets raw
//     HTML on an element, matching the grep guard in escape.test.ts and
//     every other file in this client.
//
// `client/src/lib/query.ts` tokenises the input for DISPLAY ONLY (chips +
// highlight terms). The server owns matching -- the full, untouched input
// string is what's sent to `api.search`, exactly as typed, chips or not.
import { useEffect, useRef, useState } from "preact/hooks";
import { scrollParentOf } from "./MessageList";

/** How close to the bottom of the scroll pane fetches the next page. */
const NEAR_BOTTOM_PX = 900;
import type { ComponentChildren, JSX } from "preact";
import { Paperclip, Star } from "lucide-preact";
import type { Api, EmailRow } from "../lib/api";
import { toCssColor } from "../lib/color";
import { highlight, text } from "../lib/escape";
import { Snippet } from "./Snippet";
import { SelectBox } from "./SelectBox";
import { tokenise } from "../lib/query";
import { formatRowTime } from "../lib/time";

/** Search results have no bulk-action surface (App.tsx's `toggleSelect
 *  Opened` comment: "Search renders no checkboxes at all... nothing for
 *  x to toggle there") -- but the design's row template (Wilco.dc.html
 *  line ~318, `t.tall`) is the SAME markup for both the folder view and
 *  search results, checkbox included. Design-fidelity Pass B round 2:
 *  omitting the checkbox entirely was its own fidelity gap (a 28px
 *  single-line row instead of the real 69px three-line one). Rendered
 *  now, `disabled`, matching every other checked-but-unbacked control in
 *  this plan rather than silently missing. */
const SEARCH_CHECKBOX_REASON = "Selecting search results isn't available yet -- open a message directly, or search from a folder to select there.";

/** Matches MessageList.tsx's/Sidebar.tsx's own `FONT_MONO` literal (not
 *  `var(--font-mono)`) -- same reason: happy-dom's `getComputedStyle`
 *  doesn't resolve custom properties set via an inline `style`. */
const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

export interface SearchSelection {
  account: string;
  id: string;
}

export interface SearchProps {
  api: Api;
  /** account key -> accent color, matching MessageList/Sidebar's prop of
   *  the same name. A key missing here falls back to a neutral gray. */
  accents?: Record<string, string>;
  /** account key -> mono account code, matching MessageList's prop of the
   *  same name. A key missing here falls back to the account's own first
   *  three letters, uppercased -- same fallback MessageList uses. */
  codes?: Record<string, string>;
  /** Rendered when there is no active query -- the normal folder view
   *  (App hands in its `MessageList`). Search is a wrapper, not a
   *  replacement: it owns the toggle between "showing the folder" and
   *  "showing search results" so the folder view is never left rendering
   *  underneath a stale, empty result set. */
  children?: ComponentChildren;
  /** Called when a result row is clicked -- mirrors MessageList's
   *  `onOpen`, keyed (account, id) for the same reason (spec 4.2: ids
   *  collide across accounts). */
  onOpen?: (sel: SearchSelection) => void;
  /** Called on `api.search`/`api.addSaved` failing -- `App.tsx` routes it
   *  through the same session-expired/banner handling every other pane
   *  uses (round-11 review: neither call had a `.catch` at all). */
  onError?: (err: unknown, context: string) => void;
  /** Reports whether a search is active and, if so, its current result
   *  rows -- every time either changes. `App.tsx` needs this to make
   *  `j`/`k`/`x` operate on whichever list is ACTUALLY on screen (round-11
   *  review: they kept walking the folder's `rows` underneath an active
   *  search). This component still owns its own fetch/debounce; it just
   *  also tells the parent what it's showing. */
  onResultsChange?: (active: boolean, rows: EmailRow[]) => void;
  /** Called after a search is successfully saved -- lets `App.tsx` bump a
   *  refresh token into `Sidebar` (minor finding: "the sidebar list does
   *  not refresh afterward"). */
  onSaved?: () => void;
  /** A query pushed in from outside this component -- clicking a saved
   *  search in the sidebar (design's `ss.select`, which sets `searchQ`).
   *
   *  Carried with a `token` rather than as a bare controlled `value`
   *  because the box is otherwise uncontrolled: applying on value change
   *  alone would both re-apply a stale query on any unrelated re-render
   *  and silently do NOTHING when the same saved search is clicked twice.
   *  The token is what says "the user asked again". */
  requestedQuery?: { value: string; token: number };
}

const DEBOUNCE_MS = 200;
const RECENT_LIMIT = 5;
const FALLBACK_ACCENT = "#8a8f97";

interface AccountGroup {
  account: string;
  rows: EmailRow[];
}

function groupByAccount(rows: EmailRow[]): AccountGroup[] {
  const groups: AccountGroup[] = [];
  const byAccount = new Map<string, AccountGroup>();
  for (const row of rows) {
    let group = byAccount.get(row.account);
    if (group === undefined) {
      group = { account: row.account, rows: [] };
      byAccount.set(row.account, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

export function Search({ api, accents, codes, children, onOpen, onError, onResultsChange, onSaved, requestedQuery }: SearchProps): JSX.Element {
  const [inputValue, setInputValue] = useState("");
  const [query, setQuery] = useState(""); // the query actually committed/searched
  const [rows, setRows] = useState<EmailRow[]>([]);
  /** Row 18: the SERVER's total and its cursor. The header says the total;
   *  reaching the bottom fetches the next page. The first version showed
   *  `rows.length` and had no paging, so search said "200 results" against
   *  2,917 matches and the rest were unreachable. */
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [showRecent, setShowRecent] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every search that's actually issued; a response is applied
  // only if it's still the latest one requested -- the "cancel superseded
  // requests" half of the debounce (the "don't issue the request at all"
  // half is the clearTimeout below).
  const generationRef = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  function runSearch(q: string): void {
    const generation = ++generationRef.current;
    setQuery(q);
    api
      .search(q)
      .then((result) => {
        if (generationRef.current !== generation) return; // superseded -- discard
        setRows(result.rows);
        setTotal(result.total);
        setCursor(result.cursor);
        setRecent((prev) => [q, ...prev.filter((r) => r !== q)].slice(0, RECENT_LIMIT));
      })
      .catch((err: unknown) => {
        // A superseded request's failure must not surface -- exactly the
        // same generation check the success path uses, so an old, slow,
        // now-failing request can't report an error for a query the user
        // has already moved past.
        if (generationRef.current !== generation) return;
        onError?.(err, "search");
      });
  }

  /** The next page, appended. Guarded by the generation so a page for a
   *  query the user has moved past is discarded like any stale result. */
  function loadMore(): void {
    if (cursor === null || loadingMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    api
      .search(query, { cursor })
      .then((result) => {
        if (generationRef.current !== generation) return;
        setRows((prev) => {
          const seen = new Set(prev.map((r) => `${r.account}:${r.id}`));
          return [...prev, ...result.rows.filter((r) => !seen.has(`${r.account}:${r.id}`))];
        });
        setTotal(result.total);
        setCursor(result.cursor);
      })
      .catch((err: unknown) => {
        if (generationRef.current !== generation) return;
        onError?.(err, "load more results");
      })
      .finally(() => setLoadingMore(false));
  }

  // Page on scroll, bound to the nearest SCROLLING ANCESTOR (the results
  // container itself has no overflow -- same lesson as MessageList).
  useEffect(() => {
    const el = scrollParentOf(resultsRef.current);
    if (el === null || cursor === null) return;
    const onScroll = (): void => {
      if (loadingMore) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) loadMore();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, loadingMore, rows.length, query]);

  // Apply an externally-requested query. Keyed on the token alone: see
  // the prop's own comment for why the value is not the dependency.
  const appliedTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (requestedQuery === undefined) return;
    if (appliedTokenRef.current === requestedQuery.token) return;
    appliedTokenRef.current = requestedQuery.token;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setInputValue(requestedQuery.value);
    if (requestedQuery.value.trim().length === 0) {
      generationRef.current++;
      setQuery("");
      setRows([]);
      return;
    }
    runSearch(requestedQuery.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedQuery?.token]);

  function handleInput(e: JSX.TargetedEvent<HTMLInputElement>): void {
    const value = e.currentTarget.value;
    setInputValue(value);

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (value.trim().length === 0) {
      // Cancel whatever might still be in flight and drop back to the
      // folder view immediately -- an empty box must never show a stale
      // or empty result set (it must show the folder).
      generationRef.current++;
      setQuery("");
      setRows([]);
      return;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      runSearch(value);
    }, DEBOUNCE_MS);
  }

  /** Wilco.dc.html's `clearSearch` (line 281, the `✕` inside the search
   *  box, shown while `searchActive`) -- distinct from the browser's own
   *  native input-clear affordance: it must also cancel any in-flight
   *  debounce/request and drop back to the folder view immediately, the
   *  same reset `handleInput` already does for an emptied box. */
  function handleClear(): void {
    setInputValue("");
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    generationRef.current++;
    setQuery("");
    setRows([]);
  }

  function handleSelectRecent(q: string): void {
    setInputValue(q);
    setShowRecent(false);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    runSearch(q);
  }

  const tokenised = tokenise(inputValue);
  const highlightTerms = tokenised.text.split(/\s+/).filter((t) => t.length > 0);
  const active = query.trim().length > 0;
  const groups = groupByAccount(rows);

  useEffect(() => {
    onResultsChange?.(active, rows);
    // Deliberately no `onResultsChange` in the dep array: it's a fresh
    // closure from `App.tsx` on every render (same pattern as
    // `commandContext` there), and including it would refire this on
    // every parent render instead of only when what it reports changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rows]);

  return (
    <div data-testid="search-box" class="search-box">
      {/* F4 (design-fidelity Pass D): Wilco.dc.html lines ~278-283 -- a
         bordered field (⌕ icon, borderless input, ✕ clear, a `⌘K` chip
         that stays visible even with text typed -- the design's own
         screenshot shows `bridge` typed AND `⌘K` still showing). The
         earlier version was a bare `<input>` with no icon/clear, and hid
         `⌘K` the moment `inputValue.length > 0`. */}
      <div class="search-field" style={{ position: "relative" }}>
        <span aria-hidden="true" class="search-field-icon">
          ⌕
        </span>
        <input
          type="text"
          data-testid="search"
          class="search-input"
          placeholder="Search"
          value={inputValue}
          onInput={handleInput}
          onFocus={() => setShowRecent(true)}
          onBlur={() => setShowRecent(false)}
        />
        {inputValue.length > 0 && (
          <button type="button" data-testid="search-clear" class="search-clear" onClick={handleClear} title="Clear search">
            ✕
          </button>
        )}
        <span aria-hidden="true" data-testid="search-hint" class="search-kbd">
          ⌘K
        </span>
        {showRecent && recent.length > 0 && (
          <div data-testid="recent-searches" class="search-recent" style={{ position: "absolute", top: "100%", left: 0 }}>
            {recent.map((q) => (
              // onMouseDown (not onClick) fires before the input's onBlur
              // closes this dropdown out from under the click.
              <div key={q} data-testid={`recent-${q}`} onMouseDown={() => handleSelectRecent(q)}>
                {text(q)}
              </div>
            ))}
          </div>
        )}
      </div>

      {tokenised.chips.length > 0 && (
        <div data-testid="chips" class="search-chips" style={{ display: "flex", gap: "6px" }}>
          {tokenised.chips.map((chip, i) => (
            <span key={`${chip.op}-${i}`} data-testid={`search-chip-${chip.op}`} class="search-chip">
              {chip.op}:{text(chip.value)}
            </span>
          ))}
        </div>
      )}

      {active ? (
        <div data-testid="search-active" class="search-results" ref={resultsRef}>
          {/* F5/F6 (design-fidelity Pass D): the design keeps the result
             count in the PANE HEADER, right-aligned next to the title,
             same shape as the folder-list header ('Search' 14/700 +
             '3 results' 10.5px mono `--faint`) -- not a left-aligned row
             in the body next to the save button. Wilco.dc.html line
             ~1434's `listMeta` for this case is `vis.length + ' result' +
             (vis.length === 1 ? '' : 's')` -- the count of rows actually
             ON SCREEN, not the server's unbounded `total` (which the app
             has no "load more" affordance to reach for search results at
             all, so showing it here would claim a count nothing lets the
             user get to). */}
          <div class="search-results-header">
            <h1 class="search-results-title">Search</h1>
            <span data-testid="count" class="search-results-count">
              {total.toLocaleString("en-US")} result{total === 1 ? "" : "s"}
            </span>
          </div>
          <div class="search-save-row">
            <span style={{ flex: 1 }} />
            <button
              type="button"
              data-testid="save-search"
              class="search-save"
              onClick={() => {
                api
                  .addSaved(query, query)
                  .then(() => onSaved?.())
                  .catch((err: unknown) => onError?.(err, "save that search"));
              }}
            >
              ＋ Save search
            </button>
          </div>

          {rows.length === 0 ? (
            <div data-testid="search-empty" class="search-empty">No results for {text(query)}</div>
          ) : (
            groups.map((group) => {
              return (
                <div key={group.account}>
                  {/* Same shape/class as MessageList's `.msg-group-header`
                     (design line ~317) -- search groups by account
                     instead of Today/Earlier (DESIGN.md "4. Message
                     list"), but the row underneath it is the identical
                     template, so the header should read as the same kind
                     of divider, not a differently-styled one. F6
                     (design-fidelity Pass D): Wilco.dc.html line ~1501
                     labels each group `a.name + ' · ' + hits.length` --
                     the per-account count was previously omitted. */}
                  <div data-testid={`search-group-${group.account}`} class="msg-group-header" style={{ fontFamily: FONT_MONO }}>
                    {text(group.account)} · {group.rows.length}
                  </div>
                  {group.rows.map((row, i) => {
                    const accent = accents?.[row.account] ?? FALLBACK_ACCENT;
                    const swatchColor = toCssColor(accent);
                    const code = codes?.[row.account] ?? row.account.slice(0, 3).toUpperCase();
                    const rowKey = `${row.account}-${row.id}`;
                    const segments = highlight(row.subject, highlightTerms);
                    let hitIndex = -1;
                    const senderClass = "msg-row-sender" + (row.isUnread === true ? " msg-row-sender--unread" : "");
                    const subjectClass = "msg-row-subject" + (row.isUnread === true ? " msg-row-subject--unread" : "");
                    return (
                      <div
                        key={rowKey}
                        data-testid={`search-row-${rowKey}`}
                        class="msg-row"
                        role="row"
                        onClick={() => onOpen?.({ account: row.account, id: row.id })}
                        style={{ borderLeftColor: swatchColor, borderLeftWidth: "3px" }}
                      >
                        <SelectBox
                          testId={`search-checkbox-${rowKey}`}
                          checked={false}
                          offset
                          disabled
                          disabledReason={SEARCH_CHECKBOX_REASON}
                        />
                        <div class="msg-row-body">
                          <div class="msg-row-line1">
                            <span class={senderClass} style={{ fontWeight: row.isUnread === true ? 700 : 500 }}>
                              {text(row.fromName ?? "")}
                            </span>
                            <span class="msg-row-code" title={row.account} style={{ color: swatchColor, fontFamily: FONT_MONO }}>
                              {text(code)}
                            </span>
                            <span class="msg-row-time">{formatRowTime(row.receivedAt, new Date())}</span>
                          </div>
                          <div data-testid={`search-subject-${rowKey}`} class={subjectClass}>
                            {segments.map((seg, si) => {
                              if (!seg.hit) return <span key={si}>{text(seg.text)}</span>;
                              hitIndex++;
                              return (
                                <mark
                                  key={si}
                                  data-testid={hitIndex === 0 ? `hit-${i}` : undefined}
                                  // DESIGN.md "4. Message list": "Search
                                  // matches highlighted (--sel background
                                  // on matched substrings)." An earlier
                                  // version used a custom amber pair
                                  // instead, reasoning that `--sel` +
                                  // black UA-default `mark` text is
                                  // unreadable in dark mode -- true, but
                                  // the fix is `--accent` as an explicit
                                  // ink color (design-fidelity Pass B
                                  // round 2), not a token the design
                                  // never specified. `--accent` is
                                  // already chosen for contrast against
                                  // `--sel` in both themes (it's what
                                  // marks the unread dot and selected nav
                                  // against the same background family).
                                  style={{ background: "var(--sel)", color: "var(--accent)" }}
                                >
                                  {text(seg.text)}
                                </mark>
                              );
                            })}
                          </div>
                          <div class="msg-row-line3">
                            <span class="msg-row-snippet"><Snippet value={row.snippet ?? row.preview ?? ""} /></span>
                            {row.isFlagged === true && (
                              <span aria-hidden="true" class="msg-row-star">
                                <Star size={10} fill="currentColor" stroke="none" />
                              </span>
                            )}
                            {row.hasAttachment === true && (
                              <span aria-hidden="true" class="msg-row-attach">
                                <Paperclip size={10} strokeWidth={1.5} />
                              </span>
                            )}
                            {row.isUnread === true && <span aria-hidden="true" class="msg-row-unread-dot" />}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        {cursor !== null && (
            <button type="button" data-testid="search-load-more" class="msg-list-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : `Load more — ${rows.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`}
            </button>
          )}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
