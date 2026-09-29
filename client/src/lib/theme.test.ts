// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rememberTheme, THEME_MIRROR_KEY } from "./theme";

const HEAD_SCRIPT = readFileSync(resolve(process.cwd(), "public/theme.js"), "utf8");
function runHeadScript(): void {
  new Function(HEAD_SCRIPT)();
}

test("the head script stamps the mirrored theme before the app runs, and leaves a fresh browser alone", () => {
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
  runHeadScript();
  assert.equal(document.documentElement.getAttribute("data-theme"), null, "no mirror: the OS preference applies until the server answers");
  rememberTheme("dark");
  assert.equal(window.localStorage.getItem(THEME_MIRROR_KEY), "dark");
  runHeadScript();
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
  window.localStorage.setItem(THEME_MIRROR_KEY, "sepia");
  document.documentElement.removeAttribute("data-theme");
  runHeadScript();
  assert.equal(document.documentElement.getAttribute("data-theme"), null, "only the two real values are honoured");
});

test("index.html loads the head script as a blocking file, before the app module", () => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  const head = html.indexOf('<script src="/theme.js"></script>');
  const app = html.indexOf('type="module"');
  assert.ok(head > -1 && head < app, "theme.js must run before main.tsx, as a plain script (the CSP admits no inline block)");
  assert.ok(head < html.indexOf("<body"), "and from <head>, before anything paints");
});

test("the To field fills its row: the wrap is a flex container, not a block the input shrinks inside (owner, 2026-09-08)", () => {
  // Measured live: the input was 153px wide in a 600px row. `flex: 1` on
  // the input meant nothing inside a block wrap and it fell back to a text
  // input's intrinsic width. Row 50 measures it in the browser; this pins
  // the rule that makes it so.
  const css = readFileSync(resolve(process.cwd(), "src/styles/components.css"), "utf8");
  const rule = /\.compose-to-wrap\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, ".compose-to-wrap rule exists");
  assert.match(rule![1]!, /display:\s*flex/);
});
