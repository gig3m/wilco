// The escaping seam. Sender-controlled text (plaintext bodies, subjects,
// sender names, previews, filenames, search snippets) becomes display text
// ONLY through the functions in this module. See spec 6.8/6.11 and
// 2026-09-04-wilco-05-spa-shell-and-search/task-2-brief.md.
//
// Preact escapes `{value}` children automatically, so the everyday path
// (just rendering a string as JSX text) is already safe. This module exists
// for the three places that are not: match highlighting (tempted toward
// markup), link detection/validation for plaintext bodies, and anywhere a
// value reaches an attribute (an href).

/**
 * Coerces `value` to a plain string (`null`/`undefined` -> `""`). This
 * escapes NOTHING by itself -- it exists only because Preact escapes JSX
 * children automatically, so `<span>{text(value)}</span>` is safe by
 * construction of the *renderer*, not of this function. It is NOT safe to
 * use in an attribute, a URL, `style`, or `srcdoc` context -- those do not
 * get Preact's child-escaping treatment. Use `safeExternalHref` for hrefs;
 * there is no equivalent helper yet for other attribute contexts because
 * none exist in this plan (see the raw-HTML-injection ban in the module doc
 * comment above -- that banned API's name is deliberately not spelled out
 * literally here so this file itself doesn't trip the grep guard in
 * escape.test.ts).
 */
export function text(value: string | null | undefined): string {
  return value ?? "";
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * Splits `value` into segments around case-insensitive occurrences of
 * `terms`, marking which segments matched. Returns SEGMENTS, never markup --
 * a caller renders `{segment.text}` as a child, which Preact escapes
 * automatically. It is structurally unable to inject.
 *
 * Deliberately does not use RegExp at all: `terms` is direct user input from
 * the search box, and a regex built from it (even escaped) risks
 * catastrophic backtracking over message-shaped data (spec 6.11). A plain
 * indexOf scan is simpler and linear in the length of `value`.
 */
export function highlight(value: string, terms: string[]): HighlightSegment[] {
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t.trim().length > 0);

  if (needles.length === 0 || value.length === 0) {
    return value.length === 0 ? [] : [{ text: value, hit: false }];
  }

  const haystack = value.toLowerCase();
  const segments: HighlightSegment[] = [];

  // Per-needle cursor: the next position (>= the current scan position) at
  // which that needle is known to match next, or -1 once it is known never
  // to match again. Re-searching a needle only when the scan position moves
  // past its cached next-hit is what keeps this O(value.length) overall --
  // without the cache, a needle that matches late (or never) gets
  // re-scanned across the *entire remaining haystack* on every iteration of
  // the outer loop, which is O(value.length * terms.length * value.length)
  // once there are 2+ terms and at least one has few/no matches.
  const nextHit = needles.map((needle) => haystack.indexOf(needle));

  let pos = 0;
  while (pos < value.length) {
    // Find the earliest match among all needles starting at or after `pos`.
    let bestIndex = -1;
    let bestLength = 0;
    for (let i = 0; i < needles.length; i++) {
      // A cached next-hit that has fallen behind the current scan position
      // (because a previous iteration consumed text past it) is stale --
      // re-search that one needle from `pos`. Needles whose cached next-hit
      // is still ahead of `pos` are left untouched, which is what keeps
      // this linear: each needle is only ever re-scanned when the position
      // actually advances past its last known match.
      if (nextHit[i]! !== -1 && nextHit[i]! < pos) {
        nextHit[i] = haystack.indexOf(needles[i]!, pos);
      }
      const idx = nextHit[i]!;
      if (idx === -1) continue;
      const len = needles[i]!.length;
      if (bestIndex === -1 || idx < bestIndex || (idx === bestIndex && len > bestLength)) {
        bestIndex = idx;
        bestLength = len;
      }
    }

    if (bestIndex === -1) {
      segments.push({ text: value.slice(pos), hit: false });
      break;
    }

    if (bestIndex > pos) {
      segments.push({ text: value.slice(pos, bestIndex), hit: false });
    }
    segments.push({ text: value.slice(bestIndex, bestIndex + bestLength), hit: true });
    pos = bestIndex + bestLength;
  }

  return segments;
}

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

// Matches C0 control characters (U+0000-U+001F) and DEL (U+007F), built from
// character codes rather than a literal control-char range in source so the
// source file itself stays free of raw control bytes.
const CONTROL_CHARS_RE = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]",
  "g",
);

/**
 * Returns the normalised URL if it is a well-formed http:, https: or
 * mailto: URL after normalisation; otherwise `null`. Allowlist, never
 * blocklist.
 *
 * Must normalise BEFORE judging the scheme (spec 6.11): a browser decodes
 * HTML entities and drops control characters before deciding what scheme it
 * is reading, so `j&#x61;vascript:alert(1)` and a tab inside the word both
 * walk through checks written against the text as authored. We decode
 * entities, strip control characters, trim leading whitespace, and lowercase
 * the scheme before comparing against the allowlist.
 *
 * 🚨 Returns the NORMALISED string (`trimmed`), not `raw`. An earlier
 * version validated `trimmed` but returned `raw` -- "validate string A, emit
 * string B" is exactly the parser-differential shape this module exists to
 * prevent (spec 6.11). Preact's `setAttribute` makes the raw-return variant
 * non-exploitable *today* (attribute values are never entity-decoded by the
 * browser), but any later consumer that parses differently -- a
 * server-rendered href, `window.open`, `srcdoc`, a CSS `url()` -- would
 * inherit the un-sanitised attacker string (e.g. a literal newline from
 * `"mailto:a@b.test\nBcc:c@d.test"`, or a NUL/leading space that were only
 * ever stripped from the copy used for judgment). Returning `trimmed`
 * closes that gap: what was validated is what is emitted.
 */
export function safeExternalHref(raw: string): string | null {
  const decoded = decodeHtmlEntities(raw);
  // Strip control characters (including tab/newline/CR) anywhere in the
  // string -- browsers strip these before scheme detection, and an attacker
  // can place one mid-scheme ("java\tscript:").
  const stripped = decoded.replace(CONTROL_CHARS_RE, "");
  const trimmed = stripped.trimStart();

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!schemeMatch) return null;

  const scheme = schemeMatch[1]!.toLowerCase() + ":";
  if (!ALLOWED_SCHEMES.has(scheme)) return null;

  return trimmed;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint =
        entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (Number.isNaN(codePoint)) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/**
 * The markers the server's FTS5 `snippet()` wraps around each match, mirrored
 * from `SNIPPET_OPEN`/`SNIPPET_CLOSE` in src/core/queries.ts. The two ends of
 * this contract must stay in step; there is no module shared between the
 * server and client packages to hold them in one place.
 */
export const SNIPPET_OPEN = "\uE000";
export const SNIPPET_CLOSE = "\uE001";

/**
 * Splits a server search snippet into segments around its match markers,
 * marking which segments matched -- the same `HighlightSegment[]` shape
 * `highlight` returns, so a caller renders both the same way: `{seg.text}` as
 * a JSX child, which Preact escapes. Returns SEGMENTS, never markup.
 *
 * Unlike `highlight`, which re-derives matches client-side from the search
 * box's terms, this reports the matches the SERVER actually found -- FTS5
 * tokenisation, stemming and phrase handling included -- which is why the
 * snippet is worth splitting rather than re-highlighting.
 *
 * Markers are dropped whether or not they are paired: an unpaired one is
 * ours (a PUA codepoint has no legitimate use in message text), and showing
 * it as literal text is the bug this function exists to fix. Linear in the
 * length of `value`.
 */
export function splitSnippet(value: string | null | undefined): HighlightSegment[] {
  const s = value ?? "";
  if (s.length === 0) return [];
  if (!s.includes(SNIPPET_OPEN) && !s.includes(SNIPPET_CLOSE)) {
    return [{ text: s, hit: false }];
  }

  const segments: HighlightSegment[] = [];
  const push = (t: string, hit: boolean) => {
    if (t.length > 0) segments.push({ text: t, hit });
  };

  let pos = 0;
  while (pos < s.length) {
    const open = s.indexOf(SNIPPET_OPEN, pos);
    if (open === -1) {
      push(stripMarkers(s.slice(pos)), false);
      break;
    }
    push(stripMarkers(s.slice(pos, open)), false);

    const close = s.indexOf(SNIPPET_CLOSE, open + 1);
    if (close === -1) {
      // An opener with no closer: the snippet was truncated mid-match.
      // Treat the remainder as the match rather than dropping it.
      push(stripMarkers(s.slice(open + 1)), true);
      break;
    }
    push(stripMarkers(s.slice(open + 1, close)), true);
    pos = close + 1;
  }

  return segments;
}

function stripMarkers(t: string): string {
  return t.split(SNIPPET_OPEN).join("").split(SNIPPET_CLOSE).join("");
}
