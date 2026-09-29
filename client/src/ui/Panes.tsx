// Building blocks of the shell (DESIGN.md "Layout"): a resizable list
// pane and a drag divider. `App.tsx` owns all the state (widths, route,
// the fetched message, the fetched rows); everything here is
// presentational. The sidebar itself lives in `Sidebar.tsx` (Task 6) --
// there used to be a placeholder `Sidebar` here too, but two same-named
// components in one directory is a trap, so the placeholder was removed
// once the real one existed and got wired in. `ListPane` used to render an
// empty `<section>` the same way, standing in for the not-yet-built
// message list -- that placeholder is gone now that `MessageList` exists
// (Task 7); `ListPane` is just the sized wrapper `App.tsx` mounts it
// inside. The reading pane had the same placeholder shape (`ReadingPane`,
// rendering only subject + from) -- it's gone now that `Reading.tsx`
// exists (Task 8) and is wired directly into `App.tsx`; this file no
// longer exports anything reading-pane-shaped.
//
// Widths are set via inline `style.width` -- never a CSS class -- on
// purpose: happy-dom does not run a layout engine, so a test can only read
// a pane's size back off the DOM if it was written there directly
// (`test-utils.tsx`'s `px()` parses exactly this).
import type { ComponentChildren, JSX } from "preact";

/** `width` omitted means "fill the space you're given" -- the compact
 *  (<1024px) layouts in `App.tsx`, where a fixed 392px list would leave
 *  either a sliver of dead space or an overflowing pane depending on the
 *  phone. A number still writes a literal `style.width` for the same
 *  reason the module comment gives: happy-dom runs no layout engine, so a
 *  test can only read a pane's size back if it was written there. */
export function ListPane({ width, children }: { width?: number; children?: ComponentChildren }): JSX.Element {
  const sizing: JSX.CSSProperties =
    width === undefined ? { width: "100%", flex: "1 1 auto" } : { width: `${width}px`, flex: `0 0 ${width}px` };
  return (
    <section
      data-testid="list"
      class="list-pane"
      style={{ ...sizing, boxSizing: "border-box", minWidth: 0, minHeight: 0, overflow: "auto" }}
    >
      {children}
    </section>
  );
}

export interface DividerProps {
  testId: string;
  /** Which axis the drag is measured on -- "x" for the columns-layout
   *  divider between the list and reading panes, "y" for the rows-layout
   *  divider between the list and reading panes stacked vertically. */
  axis: "x" | "y";
  /** Called once, at the start of a drag, so the caller can snapshot the
   *  size it's about to adjust (the clamp is computed relative to that
   *  snapshot plus the cumulative delta, not applied incrementally). */
  onDragStart: () => void;
  /** Called on every `mousemove` during a drag with the cumulative
   *  offset (in px) from where the drag started. */
  onDrag: (delta: number) => void;
}

/** A thin drag handle. Owns nothing but the mouse-event plumbing --
 *  attaching `mousemove`/`mouseup` to `document` for the duration of a
 *  drag and detaching them on release, which is what lets the drag track
 *  the pointer even once it has left the handle's own (few-px-wide)
 *  hitbox. */
export function Divider({ testId, axis, onDragStart, onDrag }: DividerProps): JSX.Element {
  function handleMouseDown(down: MouseEvent): void {
    down.preventDefault();
    onDragStart();
    const startX = down.clientX;
    const startY = down.clientY;

    function handleMouseMove(move: MouseEvent): void {
      const delta = axis === "x" ? move.clientX - startX : move.clientY - startY;
      onDrag(delta);
    }

    function handleMouseUp(): void {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }

  return (
    <div
      data-testid={testId}
      class="divider"
      onMouseDown={handleMouseDown}
      style={{
        cursor: axis === "x" ? "col-resize" : "row-resize",
        flex: axis === "x" ? "0 0 4px" : "0 0 4px",
        width: axis === "x" ? "4px" : "100%",
        height: axis === "x" ? "100%" : "4px",
      }}
    />
  );
}
