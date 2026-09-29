/**
 * Choosing the surface colour a message is rendered on (spec 6.9).
 *
 * 🚨 This REVERSES the design's first draft, which said "HTML bodies render
 * on white, as authored". Dovetail shipped a fix *away* from that rule on
 * 2026-09-02, the day the spec was first written: mail declaring a dark
 * background was forced onto white and arrived white on white. Both
 * reported from real use. Measured over 603 real messages, three tiers
 * changed the surface on 78, of which 48 were better and none worse.
 *
 * This is a decision about OUR WRAPPER's background, not about rewriting
 * sender CSS -- so it does not violate 6.1's rule that we do not parse and
 * rewrite message CSS. Plaintext bodies are excluded entirely: those we
 * generate ourselves, so they stay in the app theme.
 */

export interface Surface {
  /** The CSS colour to paint behind the message. */
  background: string;
  /** True when that colour is dark, so the wrapper can set a light default
   *  ink for text the sender did not colour. */
  dark: boolean;
}

export const LIGHT_SURFACE: Surface = { background: "#ffffff", dark: false };
const DARK_SURFACE: Surface = { background: "#1c1c1e", dark: true };

export function chooseSurface(html: string): Surface {
  // Tier 1: a <body> background declaration is honoured, WHICHEVER COLOUR
  // IT IS. This is the tier that fixes white-on-white: a sender who says
  // the page is dark is telling the truth about their own ink.
  const bodyBg = bodyBackground(html);
  if (bodyBg !== null) {
    const lum = luminance(bodyBg);
    if (lum !== null) return lum < 0.5 ? { background: bodyBg, dark: true } : { background: bodyBg, dark: false };
  }

  // Tier 2: an outer wrapper is trusted LIGHT-ONLY. A dark wrapper
  // regularly matched a button near the top of an otherwise white message
  // and painted the whole page #616161 -- so a wrapper may lighten the
  // surface but never darken it.
  const wrapperBg = firstWrapperBackground(html);
  if (wrapperBg !== null) {
    const lum = luminance(wrapperBg);
    if (lum !== null && lum >= 0.5) return { background: wrapperBg, dark: false };
  }

  // Tier 3: declared ink luminance decides, and light ink wins only if it
  // clearly dominates.
  const ink = inkVote(html);
  if (ink.light > ink.dark * 2 && ink.light > 0) return DARK_SURFACE;
  return LIGHT_SURFACE;
}

/** The `background`/`background-color` declared on `<body>`, if any. */
function bodyBackground(html: string): string | null {
  const style = bodyStyleAttr(html);
  if (style === null) return null;
  return backgroundFrom(style);
}

function bodyStyleAttr(html: string): string | null {
  // Bounded scan rather than one regex across the document: spec 6.11's
  // linear-regex rule. Find the tag, then read its style attribute out of
  // that tag alone.
  const idx = html.toLowerCase().indexOf("<body");
  if (idx === -1) return null;
  const end = html.indexOf(">", idx);
  const tag = end === -1 ? html.slice(idx, idx + 4096) : html.slice(idx, end);
  const m = /style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
  return m ? (m[2] ?? m[3] ?? null) : null;
}

/**
 * The background of the first block-level wrapper element in the document
 * -- typically the table or div a marketing template wraps everything in.
 * Only the FIRST is considered, and only the first few thousand characters
 * are scanned, so a button halfway down the message cannot become the page.
 */
function firstWrapperBackground(html: string): string | null {
  const head = html.slice(0, 4096);
  const re = /<(?:table|div|td)\b[^<>]{0,600}?style\s*=\s*("([^"]*)"|'([^']*)')/gi;
  const m = re.exec(head);
  if (!m) return null;
  return backgroundFrom(m[2] ?? m[3] ?? "");
}

function backgroundFrom(style: string): string | null {
  const m = /background(?:-color)?\s*:\s*([^;]{1,64})/i.exec(style);
  return m ? m[1]!.trim() : null;
}

/**
 * Counts declared ink colours as light or dark.
 *
 * 🚨 The `(?<![-\w])color` lookbehind is load-bearing: without it,
 * `background-color:` matches as ink, so every message with a dark
 * background counts as having dark ink and the vote inverts.
 */
export function inkVote(html: string): { light: number; dark: number } {
  let light = 0;
  let dark = 0;
  const re = /(?<![-\w])color\s*:\s*([^;"']{1,64})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const lum = luminance(m[1]!.trim());
    if (lum === null) continue;
    if (lum >= 0.5) light += 1;
    else dark += 1;
  }
  return { light, dark };
}

const NAMED_COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  transparent: "",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
};

/** Relative luminance in 0..1, or null for anything unparseable -- which is
 *  counted as no vote rather than guessed at. */
export function luminance(value: string): number | null {
  const v = value.trim().toLowerCase();
  const named = NAMED_COLORS[v];
  if (named === "") return null;
  const color = named ?? v;

  let r: number, g: number, b: number;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})\b/.exec(color);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]! : h;
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    b = parseInt(full.slice(4, 6), 16);
  } else {
    const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(color);
    if (!rgb) return null;
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  }

  // Rec. 601 luma, which is what a human reads as "is this light or dark"
  // closely enough for a background decision.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
