/**
 * The no-silently-dead-controls guard (audit pass 1, guardrail 3).
 *
 * 🚨 This is a SOURCE SCAN, not a render test, and that is deliberate. The
 * defect it exists to stop — the bulk bar's All / Mark read / Archive, which
 * shipped with no `onClick` and no `disabled` and looked entirely normal —
 * survived a component test suite that renders MessageList directly. A test
 * that clicks a button and asserts nothing happened is exactly what a dead
 * button passes. The only property that distinguishes a dead control from a
 * live one *without knowing what it should do* is structural: it has neither
 * a handler nor a disabled state.
 *
 * So the rule is: **every interactive element in the client either does
 * something, or says why it doesn't.** A control that is `disabled` is
 * honest; a control with a handler is live; a control with neither is a lie
 * told to the user, and this test fails on it.
 *
 * Comments are stripped before scanning. Prose in this codebase routinely
 * says things like "a bare `<input>` with no icon", and an earlier version
 * of this scan reported eight such sentences as dead controls — noise that
 * would have trained the next reader to ignore the failure.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const UI_ROOT = dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = join(UI_ROOT, "..");

/** Elements that a person can act on. `<a>` counts: an anchor with no
 *  `href` is the classic silently-dead control. */
const INTERACTIVE = ["button", "input", "select", "textarea", "a"];

/** Anything that makes the element do something when acted on. `href` is
 *  the anchor's handler; `form` + `type="submit"` is the button's. */
const HANDLER_ATTRS = [
  "onClick",
  "onInput",
  "onChange",
  "onSubmit",
  "onKeyDown",
  "onKeyUp",
  "onMouseDown",
  "onPointerDown",
  "onToggle",
  "href",
  'type="submit"',
];

/** Strips `//` line comments, `/* *​/` block comments and `{/* *​/}` JSX
 *  comments. Crude — it does not understand strings — but it only ever
 *  removes text, and a control accidentally removed by a `//` inside a
 *  string literal would be a false PASS on a line that is not a control
 *  anyway. */
function stripComments(source: string): string {
  // Newlines inside a stripped comment are PRESERVED, so reported line
  // numbers still point at the real file. A guard whose failure message
  // names the wrong line teaches the reader to distrust it.
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank)
    .replace(/([^:])\/\/[^\n"'`]*$/gm, (m, keep: string) => keep + blank(m.slice(1)));
}

/**
 * Returns the attribute text of every interactive JSX element opening.
 *
 * Scans forward from the tag name balancing `{}` so an attribute holding a
 * multi-line arrow function or an object literal — which is most of them —
 * does not truncate the element early. A regex cannot do this; the previous
 * attempt read `<input` in Search.tsx as attribute-less because its value
 * expressions contain nested braces.
 */
function interactiveOpenings(source: string): { tag: string; attrs: string; line: number }[] {
  const found: { tag: string; attrs: string; line: number }[] = [];
  const opening = new RegExp(`<(${INTERACTIVE.join("|")})(?=[\\s/>])`, "g");
  let match: RegExpExecArray | null;
  while ((match = opening.exec(source)) !== null) {
    const tag = match[1] as string;
    let i = opening.lastIndex;
    let depth = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
      i++;
    }
    found.push({
      tag,
      attrs: source.slice(opening.lastIndex, i),
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

test("NO INTERACTIVE CONTROL LACKS BOTH A HANDLER AND A DISABLED STATE", () => {
  const dead: string[] = [];
  for (const file of walk(CLIENT_SRC)) {
    if (!file.endsWith(".tsx")) continue;
    if (file.endsWith(".test.tsx") || file.includes("test-utils")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    for (const el of interactiveOpenings(source)) {
      // `<input type="hidden">` and a spread (`{...props}`) both make the
      // structural question unanswerable here; neither is a control a
      // person can click and get nothing from.
      if (/\btype="hidden"/.test(el.attrs)) continue;
      if (/\{\.\.\./.test(el.attrs)) continue;
      const wired = HANDLER_ATTRS.some((attr) => el.attrs.includes(attr));
      const honest = /\bdisabled\b/.test(el.attrs);
      if (!wired && !honest) {
        dead.push(`${relative(CLIENT_SRC, file)}:${el.line} <${el.tag}>`);
      }
    }
  }
  assert.deepEqual(
    dead,
    [],
    `Interactive controls with neither a handler nor a disabled state.\n` +
      `Each of these renders as a live-looking control that does nothing.\n` +
      `Wire it, or give it \`disabled\` and a \`title\` saying why:\n  ` +
      dead.join("\n  "),
  );
});
