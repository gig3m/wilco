// Tokenises a search-box string into operator chips and free text, FOR
// DISPLAY ONLY. The server (src/core/searchquery.ts) owns matching -- this
// module never re-implements operator semantics, it only decides which
// prefix of a word the UI should render as a chip versus leave as a term.
//
// Per spec 4.4 rule 2, an unrecognised `word:` is a search TERM, not an
// error -- mail genuinely contains "http:" and "re:" -- so CLIENT_OPERATORS
// must be exactly the server's set, no more and no less. Drift either
// direction means the UI shows a chip for something the server treats as
// free text (or the reverse), and a user sees a chip and gets full-text
// results. query.test.ts cross-checks this list against the server's own
// source file so the two can never quietly diverge.
export const CLIENT_OPERATORS = [
  "from",
  "to",
  "cc",
  "in",
  "acct",
  "is",
  "has",
  "before",
  "after",
  "newer_than",
] as const;

export type ClientOperator = (typeof CLIENT_OPERATORS)[number];

const OPERATOR_SET: ReadonlySet<string> = new Set(CLIENT_OPERATORS);

export interface Chip {
  op: ClientOperator;
  value: string;
}

export interface Tokenised {
  chips: Chip[];
  /** Whatever wasn't recognised as `op:value`, space-joined back together
   *  in its original order -- including any `word:` prefix that isn't in
   *  CLIENT_OPERATORS, which stays a term rather than becoming a chip. */
  text: string;
}

/**
 * Splits `input` on whitespace and classifies each token: `op:value` where
 * `op` is one of CLIENT_OPERATORS and `value` is non-empty becomes a chip;
 * everything else (plain words, an unrecognised `prefix:...`, or a bare
 * `op:` with nothing after the colon) is free text.
 */
export function tokenise(input: string): Tokenised {
  const chips: Chip[] = [];
  const textWords: string[] = [];

  for (const word of input.split(/\s+/)) {
    if (word.length === 0) continue;

    const colonIndex = word.indexOf(":");
    if (colonIndex > 0) {
      const op = word.slice(0, colonIndex);
      const value = word.slice(colonIndex + 1);
      if (OPERATOR_SET.has(op) && value.length > 0) {
        chips.push({ op: op as ClientOperator, value });
        continue;
      }
    }

    textWords.push(word);
  }

  return { chips, text: textWords.join(" ") };
}
