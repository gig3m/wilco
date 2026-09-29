// Covers color.ts's two pure contrast helpers, added because neither had a
// single test before this pass (grep for `readableForeground`/
// `accentForTheme` in the test suite returned zero hits) despite being the
// exact functions the fix wave's dark-mode legibility defect lived in.
import { test } from "vitest";
import assert from "node:assert/strict";
import { accentForTheme, readableForeground } from "./color";

test("readableForeground picks black text on a light accent, white on a dark one", () => {
  assert.equal(readableForeground("#ffffff"), "#000000");
  assert.equal(readableForeground("#000000"), "#ffffff");
});

test("readableForeground falls back to black for a non-hex accent", () => {
  assert.equal(readableForeground("not-a-color"), "#000000");
});

test("accentForTheme leaves an already-legible accent unchanged", () => {
  // #bbbbbb's relative luminance is ~0.497 -- inside both bands
  // (dark's floor of 0.35, light's ceiling of 0.75) -- so neither branch
  // should touch it.
  assert.equal(accentForTheme("#bbbbbb", "dark"), "rgb(187, 187, 187)");
  assert.equal(accentForTheme("#bbbbbb", "light"), "rgb(187, 187, 187)");
});

test("accentForTheme brightens a dark accent for dark mode -- the fix wave's defect", () => {
  // A light-theme hue picked for use as a swatch/border on white -- near
  // black, near-invisible against dark's near-black panel until nudged.
  const accent = "#101010";
  const dark = accentForTheme(accent, "dark");
  assert.notEqual(dark, "rgb(16, 16, 16)", "must not pass the near-black accent through unchanged in dark mode");
  // Extract the blended RGB and prove it actually moved toward white.
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(dark);
  assert.ok(m, "accentForTheme must still return an rgb(...) string");
  const [, r] = m!;
  assert.ok(Number(r) > 16, "the channel moved toward white, not away from it");
});

test("accentForTheme darkens a light accent for light mode", () => {
  const accent = "#f5f5f5";
  const light = accentForTheme(accent, "light");
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(light);
  assert.ok(m, "accentForTheme must still return an rgb(...) string");
  const [, r] = m!;
  assert.ok(Number(r) < 245, "the channel moved toward black, not away from it");
});
