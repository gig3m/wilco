// Shared color helpers for anything that renders a per-account accent
// (`AccountSpec.accent`, a `#rrggbb` hex string -- see api.ts). Extracted
// from four copy-pasted copies (Sidebar.tsx, MessageList.tsx, Reading.tsx,
// Search.tsx) that all carried the same comment justifying "a fourth copy
// is cheaper than a shared module" -- true at three, false once a fourth
// arrived, and now false in the other direction: extracting it removes
// four maintenance sites, not one.

/** happy-dom (the test environment) never normalizes a hex `style` value
 *  the way a browser's CSSOM would, so a test reading a computed style
 *  back only matches if this converts to `rgb(...)` before assignment.
 *  Anything not a plain 6-digit hex passes through unchanged -- the
 *  server treats `accent` as an opaque string, not a validated hex color. */
export function toCssColor(accent: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(accent);
  if (!m) return accent;
  const int = parseInt(m[1]!, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgb(${r}, ${g}, ${b})`;
}

/** `#rrggbb` -> `[r, g, b]`, `null` for anything else (an opaque
 *  non-hex `accent`, which `readableForeground` below then just picks a
 *  safe default for). */
function hexToRgb(accent: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(accent);
  if (!m) return null;
  const int = parseInt(m[1]!, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/** A readable foreground (`#000000` or `#ffffff`) for text sitting on a
 *  background of `accent` -- WCAG's relative-luminance formula, not a
 *  guess. This is what makes it safe to put a per-account accent on a
 *  CHIP BACKGROUND (finding (b): light-theme hues used as inline text
 *  `color:` were near-invisible in dark mode) -- the accent is a stored,
 *  server-chosen hex Wilco never validated for contrast against either
 *  theme's panel color, so text-on-accent is the one placement that's
 *  correct in both themes by construction instead of by luck. */
function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function readableForeground(accent: string): string {
  const rgb = hexToRgb(accent);
  if (rgb === null) return "#000000";
  return relativeLuminance(rgb) > 0.55 ? "#000000" : "#ffffff";
}

/** Blends `rgb` toward `target` by `amount` (0-1) -- a plain linear mix,
 *  not a perceptual one; good enough for "nudge this a bit lighter/darker"
 *  without a full HSL round-trip. */
function blend(rgb: [number, number, number], target: [number, number, number], amount: number): [number, number, number] {
  return [
    Math.round(rgb[0] + (target[0] - rgb[0]) * amount),
    Math.round(rgb[1] + (target[1] - rgb[1]) * amount),
    Math.round(rgb[2] + (target[2] - rgb[2]) * amount),
  ];
}

function rgbToCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/** Finding (b): "Per-account accents are light-theme hues applied as
 *  inline `color:`" -- `AccountSpec.accent` was never chosen (or
 *  validated) for contrast against a near-black dark-theme panel, so a
 *  color that reads fine on `--panel` (`#ffffff`) can be near-invisible
 *  on dark's `--panel` (`#1a1c1f`), and vice versa. For anything that
 *  puts the accent itself on screen as a SWATCH (a border stripe, an
 *  unread dot) rather than as text-on-a-chip (where
 *  `readableForeground` is the right tool), this nudges the accent's
 *  luminance back into a band that's legible against the CURRENT theme's
 *  panel -- "a per-theme accent" (the review's other suggested fix),
 *  computed rather than hand-picked per account. Colors already in a
 *  reasonable band pass through unchanged, so this is a floor, not a
 *  recolor of everything. */
export function accentForTheme(accent: string, theme: "light" | "dark"): string {
  const rgb = hexToRgb(accent);
  if (rgb === null) return accent;
  const luminance = relativeLuminance(rgb);
  if (theme === "dark" && luminance < 0.35) return rgbToCss(blend(rgb, [255, 255, 255], 0.45));
  if (theme === "light" && luminance > 0.75) return rgbToCss(blend(rgb, [0, 0, 0], 0.45));
  return rgbToCss(rgb);
}
