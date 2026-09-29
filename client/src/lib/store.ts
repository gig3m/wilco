// The list/selection store. Encodes the two rules recorded in spec 7.3,
// both of them named bugs from dovetail, not hypotheticals:
//
//   1. Selection is keyed (account, id), never an index. New mail arrives
//      at the top and shifts every index; index-tracking let dovetail's
//      highlight drift onto a different message while the pane still
//      showed the one you opened. Ids collide across accounts (spec 4.2),
//      so the key must carry both fields, never just `id`.
//
//   2. The reading pane follows the highlight only when the SERVER moved a
//      message under you -- never when the list changed because you were
//      typing. That's the search-box-loses-focus-mid-word bug. `setRows`
//      takes a `reason` so the store can tell a push from a keystroke; a
//      store that can't tell the two apart can't implement this rule.

export interface Selection {
  account: string;
  id: string;
}

/** The minimal shape `setRows` needs to check whether the current
 *  selection is still present. Real rows (see api.ts's `EmailRow`) carry
 *  far more, but the store only ever looks at these two fields. */
export interface Row {
  account: string;
  id: string;
}

export type SetRowsReason = "server" | "local";

export interface SetRowsOptions {
  /** Why the row list changed. Defaults to "local" -- the fail-safe
   *  choice. The store cannot verify a caller's claim either way, so a
   *  call site that forgets to pass a reason (a search-as-you-type
   *  handler, most obviously) must NOT silently be treated as a server
   *  push that's allowed to drag the reading pane along -- that would
   *  reproduce the exact dovetail bug this task exists to prevent. Only a
   *  caller that explicitly knows a server-driven change occurred (an SSE
   *  push, a background refresh) should pass `{ reason: "server" }`. */
  reason?: SetRowsReason;
}

export interface Store {
  setRows(rows: Row[], opts?: SetRowsOptions): void;
  select(sel: Selection | null): void;
  rows(): Row[];
  selection(): Selection | null;
  /** True only when the most recent `setRows` call preserved the current
   *  selection *because the server moved it forward* -- i.e. `reason`
   *  was "server" and the selected (account, id) was still present in the
   *  new rows. False after an explicit `select`, after a local list
   *  change, and after a selection is dropped because its message is no
   *  longer present. */
  paneFollowed(): boolean;
}

function sameSelection(a: Selection, b: Row): boolean {
  return a.account === b.account && a.id === b.id;
}

export function createStore(): Store {
  let rows: Row[] = [];
  let selection: Selection | null = null;
  let followed = false;

  return {
    setRows(newRows, opts = {}) {
      const reason = opts.reason ?? "local";
      rows = newRows;

      if (selection === null) {
        followed = false;
        return;
      }

      const stillPresent = newRows.some((r) => sameSelection(selection!, r));
      if (stillPresent) {
        // Selection is keyed (account, id), so it needs no updating here
        // even though the message's position in the list may have moved.
        followed = reason === "server";
      } else {
        selection = null;
        followed = false;
      }
    },

    select(sel) {
      selection = sel;
      followed = false;
    },

    rows() {
      return rows;
    },

    selection() {
      return selection;
    },

    paneFollowed() {
      return followed;
    },
  };
}
