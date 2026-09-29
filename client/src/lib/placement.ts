/**
 * Where a context menu goes so that all of it is on screen (2026-09-09:
 * the message card's ··· sits at the right edge, and a menu anchored to
 * the click's top-left corner ran off the side of the window). The menu
 * opens at the point asked for and is shifted left or up only as far as
 * it must be to fit, keeping `margin` from every edge. A menu bigger than
 * the viewport pins to the margin rather than going negative.
 */
export function placeMenu(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin: number = 8,
): { left: number; top: number } {
  const left = Math.max(margin, Math.min(x, viewportWidth - width - margin));
  const top = Math.max(margin, Math.min(y, viewportHeight - height - margin));
  return { left, top };
}
