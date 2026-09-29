import { test } from "vitest";
import assert from "node:assert/strict";
import { placeMenu } from "./placement";

test("a menu that fits opens exactly where it was asked to", () => {
  assert.deepEqual(placeMenu(100, 200, 198, 160, 1440, 900), { left: 100, top: 200 });
});

test("a menu opened at the right edge is shifted left to fit; at the bottom, up; never past the margin", () => {
  // The message card's ··· is at x≈1430 in a 1440-wide window; the menu is 198 wide.
  assert.deepEqual(placeMenu(1430, 100, 198, 160, 1440, 900), { left: 1440 - 198 - 8, top: 100 });
  assert.deepEqual(placeMenu(100, 880, 198, 160, 1440, 900), { left: 100, top: 900 - 160 - 8 });
  assert.deepEqual(placeMenu(1430, 880, 198, 160, 1440, 900), { left: 1234, top: 732 });
  assert.deepEqual(placeMenu(0, 0, 198, 160, 1440, 900), { left: 8, top: 8 }, "the margin holds on the near edges too");
  assert.deepEqual(placeMenu(300, 300, 2000, 2000, 1440, 900), { left: 8, top: 8 }, "bigger than the window: pinned to the margin, not negative");
});
