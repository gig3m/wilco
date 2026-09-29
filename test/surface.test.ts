import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSurface, inkVote, luminance } from "../src/core/surface.ts";

test("tier 1: a <body> background is honoured, WHICHEVER COLOUR IT IS", () => {
  // This is the tier that fixes white-on-white. Dovetail shipped a fix away
  // from "always white" on the day the spec was written, because mail
  // declaring a dark background arrived unreadable.
  const dark = chooseSurface('<html><body style="background:#111111">white ink here</body></html>');
  assert.equal(dark.background, "#111111");
  assert.equal(dark.dark, true);

  const light = chooseSurface('<html><body style="background-color:#ffffff">x</body></html>');
  assert.equal(light.dark, false);
});

test("tier 2: a wrapper may LIGHTEN the surface but never darken it", () => {
  // A dark wrapper regularly matched a button near the top of an otherwise
  // white message and painted the whole page #616161.
  const buttonNearTop = '<div style="background:#616161">Buy now</div><p>ordinary message text</p>';
  assert.equal(chooseSurface(buttonNearTop).dark, false, "a dark wrapper is NOT trusted");

  const lightWrapper = '<table style="background:#f7f7f7"><tr><td>hi</td></tr></table>';
  assert.equal(chooseSurface(lightWrapper).background, "#f7f7f7");
});

test("tier 3: light ink wins only when it clearly dominates", () => {
  const mostlyLightInk = "<p style='color:#ffffff'>a</p><p style='color:#eeeeee'>b</p><p style='color:#f5f5f5'>c</p>";
  assert.equal(chooseSurface(mostlyLightInk).dark, true);

  // 2 light vs 1 dark is not > 2x, so it stays light: the rule is
  // deliberately reluctant to flip.
  const mixed = "<p style='color:#ffffff'>a</p><p style='color:#eeeeee'>b</p><p style='color:#222222'>c</p>";
  assert.equal(chooseSurface(mixed).dark, false);
});

test("🚨 background-color is NOT counted as ink", () => {
  // Without the (?<![-\\w]) lookbehind, `background-color:` matches as ink,
  // so every message with a dark background counts as having dark ink and
  // the whole vote inverts.
  const vote = inkVote('<div style="background-color:#ffffff">x</div>');
  assert.equal(vote.light, 0, "a background is not ink");
  assert.equal(vote.dark, 0);

  assert.equal(inkVote('<div style="color:#ffffff">x</div>').light, 1, "but a real color: is");
});

test("an unparseable colour is no vote, not a guess", () => {
  assert.equal(luminance("var(--brand)"), null);
  assert.equal(luminance("transparent"), null);
  assert.equal(inkVote('<p style="color:var(--brand)">x</p>').light, 0);
});

test("luminance reads hex, short hex, rgb() and the common names", () => {
  assert.equal(luminance("#000000"), 0);
  assert.equal(luminance("#ffffff"), 1);
  assert.equal(luminance("#FFF"), 1);
  assert.equal(luminance("white"), 1);
  assert.equal(luminance("black"), 0);
  assert.ok((luminance("rgb(255, 255, 255)") ?? 0) > 0.99);
  assert.ok((luminance("rgba(0,0,0,0.5)") ?? 1) < 0.01);
});

test("a plain message with no declarations renders on white", () => {
  assert.deepEqual(chooseSurface("<p>Hello there</p>"), { background: "#ffffff", dark: false });
});
