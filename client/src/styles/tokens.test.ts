// @vitest-environment node
//
// This is a static-analysis assertion about the repo's own files, not a DOM
// test -- happy-dom cannot read files off disk, so this file runs in the
// plain node environment (see client/src/lib/query.test.ts for the same
// convention already established elsewhere in this package).
//
// 🚨 REWRITTEN for audit pass 8 (T4). The previous version asked, for each
// of 12 tokens, whether `tokens.css` CONTAINED the hex string. That passes
// when two values are swapped --
//
//     --panel:  #fafbfb;   /* was #ffffff */
//     --panel2: #ffffff;   /* was #fafbfb */
//
// -- because both literals still appear in the file. Every card, list and
// reading pane would render on the wrong surface and the sidebar on
// another, with the test green. Nothing bound a token NAME to its value; a
// hex in a COMMENT would have satisfied it just as well.
//
// Two further holes it had:
//   * `design.includes(light) || design.includes(name)` -- the right-hand
//     branch is true for every token, since the design defines them all in
//     its own `:root`. The design half of the assertion was vacuous.
//   * Only the light palette was named, so both DARK blocks could drift
//     freely -- which is where a live contrast defect was already
//     recorded.
//
// So: parse `--name: value` pairs out of both files and compare the maps.
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** The `--name: value` pairs from the FIRST block matching `selector`.
 *
 *  Deliberately scoped to a block rather than scanning the whole file: a
 *  declaration inside `@font-face`, a comment or another rule is not a
 *  token, and the old test's central defect was exactly this — treating the
 *  file as a bag of strings. */
function tokensIn(css: string, selector: string): Map<string, string> {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `no ${selector} block found`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  assert.ok(open !== -1 && close !== -1, `${selector} block is not closed`);
  const out = new Map<string, string>();
  for (const decl of css.slice(open + 1, close).split(";")) {
    const colon = decl.indexOf(":");
    if (colon === -1) continue;
    const name = decl.slice(0, colon).trim();
    if (!name.startsWith("--")) continue;
    out.set(name, normalise(decl.slice(colon + 1)));
  }
  return out;
}

/** Whitespace and a leading zero are the only formatting the two files
 *  legitimately differ by (`rgba(18, 20, 24, 0.36)` vs `rgba(18,20,24,.36)`).
 *  Case is folded because `#FFF` and `#fff` are the same colour. */
function normalise(value: string): string {
  return value.replace(/\s+/g, "").replace(/(^|[(,])0\./g, "$1.").toLowerCase();
}

/** The colour tokens the design is authoritative for. Sizing tokens
 *  (`--row-pad`, the radii, the font stacks) are deliberately excluded: the
 *  design defines `--row-pad` and tokens.css does not, and the radii
 *  comment in tokens.css records a considered divergence. This is about the
 *  palette. */
const PALETTE = [
  "--bg", "--panel", "--panel2", "--ink", "--muted", "--faint",
  "--line", "--line2", "--accent", "--accent-ink", "--hover", "--sel", "--scrim",
] as const;

async function files(): Promise<{ design: string; css: string }> {
  // Paths are relative to the client/ package root -- where `npm test`
  // (vitest) runs from.
  return {
    design: await readFile("../docs/design/Wilco.dc.html", "utf8"),
    css: await readFile("src/styles/tokens.css", "utf8"),
  };
}

test("🚨 EVERY LIGHT TOKEN HAS THE DESIGN'S VALUE, BY NAME", async () => {
  const { design, css } = await files();
  const ours = tokensIn(css, ":root {");
  const theirs = tokensIn(design, ":root{");
  for (const name of PALETTE) {
    assert.ok(ours.has(name), `tokens.css does not define ${name}`);
    assert.ok(theirs.has(name), `the design does not define ${name} -- is PALETTE stale?`);
    assert.equal(
      ours.get(name),
      theirs.get(name),
      `${name} is ${ours.get(name)} but the design says ${theirs.get(name)}`,
    );
  }
});

test("🚨 EVERY DARK TOKEN HAS THE DESIGN'S VALUE, BY NAME", async () => {
  // The half the old test could not see at all. The design carries a full
  // dark palette (`[data-theme="dark"]`, Wilco.dc.html line 16) and the
  // client's dark values had never been checked against it.
  const { design, css } = await files();
  const ours = tokensIn(css, ':root[data-theme="dark"] {');
  const theirs = tokensIn(design, '[data-theme="dark"]{');
  for (const name of PALETTE) {
    assert.ok(ours.has(name), `tokens.css's dark block does not define ${name}`);
    assert.equal(
      ours.get(name),
      theirs.get(name),
      `dark ${name} is ${ours.get(name)} but the design says ${theirs.get(name)}`,
    );
  }
});

test("🚨 THE TWO DARK BLOCKS AGREE", async () => {
  // tokens.css states dark twice: once under `prefers-color-scheme` (the OS
  // setting, when the user has made no explicit choice) and once under
  // `[data-theme="dark"]` (the in-app toggle). Its own comment claims
  // "Values are identical to the block above by construction" -- but
  // nothing constructs them, they are two hand-maintained copies, and
  // nothing checked. A drift here shows as the app changing colour when
  // someone touches the toggle, which reads as a bug in the toggle.
  const { css } = await files();
  const media = tokensIn(css, ':root:not([data-theme="light"]) {');
  const explicit = tokensIn(css, ':root[data-theme="dark"] {');
  assert.deepEqual(
    Object.fromEntries(media),
    Object.fromEntries(explicit),
    "the OS-dark and toggled-dark palettes have drifted apart",
  );
});
