// The row selection box.
//
// 🚨 This is a BUTTON, not `<input type="checkbox">`, and that is the design's
// own choice, not a stylistic preference of ours. Wilco.dc.html lines 326 and
// 338 render a 14×14 button with an explicit border, background and a `✓`
// glyph; there is no `type="checkbox"` anywhere in the design file.
//
// The native input was the wrong element for a measurable reason: a UA
// checkbox paints its own box, and `accent-color` only tints the CHECKED
// fill. Unchecked, it stayed the browser's default white square — which on
// the dark theme's `--panel` is a bright white chip in every row, reported
// from real use. There is no styling of a native checkbox that reaches the
// design's unchecked state (transparent with a `--line` border), so the
// element had to change.
//
// State mapping, transcribed from the design's own `boxBorder`/`boxBg`/
// `boxMark`:
//   unchecked → border `--line`,   background transparent, no glyph
//   checked   → border `--accent`, background `--accent`,   `✓` in `--accent-ink`
//   hover     → border `--accent`  (both states)
import type { JSX } from "preact";

export interface SelectBoxProps {
  checked: boolean;
  onToggle?: (opts: { shift: boolean }) => void;
  testId: string;
  /** The columns layout nudges the box down to sit on the first text line;
   *  the rows layout centres it. The design carries this as an inline
   *  `margin-top:3px` on one of its two copies. */
  offset?: boolean;
  disabled?: boolean;
  /** Shown when disabled, in place of the design's "Select (x)". */
  disabledReason?: string;
}

export function SelectBox({
  checked,
  onToggle,
  testId,
  offset,
  disabled,
  disabledReason,
}: SelectBoxProps): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      class={"select-box" + (offset === true ? " select-box--offset" : "")}
      // A button standing in for a checkbox must still ANNOUNCE itself as
      // one: the design specifies the pixels, not the semantics, and
      // dropping the native element must not drop what it told a screen
      // reader.
      role="checkbox"
      aria-checked={checked}
      aria-label="Select"
      title={disabled === true ? disabledReason : "Select (x)"}
      disabled={disabled}
      // Selecting a row must not also OPEN it -- the whole row is a click
      // target.
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        // Shift rides along so the list can select a RANGE (row 26).
        onToggle?.({ shift: e.shiftKey });
      }}
    >
      {checked ? "✓" : ""}
    </button>
  );
}
