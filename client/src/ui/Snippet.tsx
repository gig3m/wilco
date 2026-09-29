// Renders a server search snippet with the matched runs marked.
//
// The server's FTS5 `snippet()` wraps each match in the PUA markers declared
// in escape.ts; before this component existed those markers reached the DOM
// as literal text, so a real search result read
// "...copy of the most recent <invoice> verifying..." with visible marker
// characters around the term. Splitting them here turns them into `<mark>`
// runs instead -- and, unlike `highlight`, reports the matches the SERVER
// found (FTS5 tokenisation and all) rather than re-deriving them from the
// search box.
//
// Sender-controlled text (spec 6.8): `splitSnippet` returns segments, never
// markup, and each segment renders as a JSX child, which Preact escapes.
import type { JSX } from "preact";
import { splitSnippet, text } from "../lib/escape";

// The same pair the subject highlight uses in Search.tsx -- `--sel` is the
// design's specified highlight background (DESIGN.md "4. Message list"),
// with `--accent` as an explicit ink so the run stays readable in dark mode
// where `mark`'s UA-default black text would not be.
const MARK_STYLE = { background: "var(--sel)", color: "var(--accent)" };

export function Snippet({ value }: { value: string | null | undefined }): JSX.Element {
  const segments = splitSnippet(value);
  return (
    <>
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark key={i} style={MARK_STYLE}>
            {text(seg.text)}
          </mark>
        ) : (
          <span key={i}>{text(seg.text)}</span>
        ),
      )}
    </>
  );
}
