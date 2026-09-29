// @vitest-environment node
//
// Pure logic, no DOM -- matches escape.test.ts/query.test.ts's precedent
// for this client's lib/ tests. These are the brief's own Step 1 tests,
// verbatim in intent, adapted to this module's actual export names.
import { test } from "vitest";
import assert from "node:assert/strict";
import { chordState, COMMANDS, feed, resolve } from "./keymap";

test("A KEYSTROKE IN A TEXT FIELD IS TEXT, NOT A COMMAND", () => {
  for (const tag of ["input", "textarea"]) {
    assert.equal(resolve({ key: "j", targetTag: tag, isContentEditable: false }), null);
  }
  assert.equal(resolve({ key: "j", targetTag: "div", isContentEditable: true }), null);
  assert.equal(resolve({ key: "j", targetTag: "div", isContentEditable: false }), "next");
});

test("escape works even inside a text field, because it is how you leave one", () => {
  assert.equal(resolve({ key: "Escape", targetTag: "input" }), "close");
});

test("',' (settings) is inert inside a text field too -- same isTextTarget gate as every other single-key command", () => {
  // Design-fidelity Task 6 fix round 1: the guarantee was structurally
  // sound (this is the same shared gate the `j` test above already pins)
  // but never PINNED for the specific key this task added, so a future
  // change to SINGLE_KEY_MAP or isTextTarget could silently regress just
  // this one binding without any test catching it.
  for (const tag of ["input", "textarea"]) {
    assert.equal(resolve({ key: ",", targetTag: tag, isContentEditable: false }), null);
  }
  assert.equal(resolve({ key: ",", targetTag: "div", isContentEditable: true }), null);
  assert.equal(resolve({ key: ",", targetTag: "div", isContentEditable: false }), "settings");
});

test("NO COMMAND BINDS A KEY THE BROWSER OWNS", () => {
  // Spec 7.4: Ctrl+K is the address bar, Ctrl+W closes the tab. Binding
  // one is how "every shortcut died" becomes a bug report.
  const forbidden: [string, "ctrl"][] = [
    ["k", "ctrl"],
    ["w", "ctrl"],
    ["t", "ctrl"],
    ["n", "ctrl"],
    ["l", "ctrl"],
  ];
  for (const [key, mod] of forbidden) {
    assert.equal(resolve({ key, [mod]: true, targetTag: "div" }), null, `${mod}+${key} must not be bound`);
  }
});

test("g chords resolve as a sequence and time out", () => {
  const s = chordState();
  assert.equal(feed(s, "g"), null, "g alone is pending, not a command");
  assert.equal(feed(s, "i"), "goto:inbox");
  feed(s, "g");
  s.advance(2000);
  assert.equal(feed(s, "i"), null, "a stale chord does not fire late");
});

test("EVERY COMMAND IN THE OVERLAY IS EITHER WIRED OR VISIBLY DISABLED", () => {
  // The ? overlay is what makes "nothing is reachable only by key" true
  // (spec 7.3). An overlay listing a command that does nothing is worse
  // than one that admits the command is not built yet.
  for (const cmd of COMMANDS) {
    assert.ok(cmd.handler !== undefined || cmd.disabledReason, `${cmd.id} is neither wired nor explained`);
  }
});

test("the palette binds Meta+K, never bare Ctrl+K", () => {
  assert.equal(resolve({ key: "k", meta: true, targetTag: "div" }), "palette");
  assert.equal(resolve({ key: "k", ctrl: true, targetTag: "div" }), null);
});

test("the palette's non-conflicting alternative elsewhere is Ctrl+Shift+K", () => {
  assert.equal(resolve({ key: "k", ctrl: true, shift: true, targetTag: "div" }), "palette");
});

test("digits 1-9 resolve to a distinct, WIRED attachment command each", () => {
  // 🚨 This used to assert `handler === undefined` and that the reason
  // matched /not yet|later plan/i -- a test that pinned the DEFECT in place.
  // The nine keys were registered permanently disabled, blaming a body
  // pipeline that shipped on 2026-09-04, and this test made sure they kept
  // saying so. Audit pass 7 F1b called it out by name.
  for (let n = 1; n <= 9; n++) {
    assert.equal(resolve({ key: String(n), targetTag: "div" }), `attach:${n}`);
  }
  const calls: number[] = [];
  for (let n = 1; n <= 9; n++) {
    const cmd = COMMANDS.find((c) => c.id === `attach:${n}`)!;
    assert.ok(cmd.handler !== undefined, `attach:${n} has no handler`);
    cmd.handler!({ saveAttachment: (i: number) => calls.push(i) });
  }
  // Each key must reach its OWN index -- the bug a shared closure would give
  // is nine keys that all save the first attachment.
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("g alone (outside a chord) resolves to nothing -- it is a chord prefix only", () => {
  assert.equal(resolve({ key: "g", targetTag: "div" }), null);
});

test("🚨 `a` is reply-all — the reading pane already advertises that hint", () => {
  // Audit pass 3 D5: reply-all is fully built and reachable from the reading
  // pane, whose button carries the hint `a`, and the key was never bound.
  // The app told the user a shortcut existed and then ignored it.
  assert.equal(resolve({ key: "a", targetTag: "div" }), "replyAll");
  const cmd = COMMANDS.find((c) => c.id === "replyAll")!;
  assert.ok(cmd.handler !== undefined, "reply-all has no handler");
  let called = false;
  cmd.handler!({ replyAll: () => (called = true) });
  assert.equal(called, true, "the reply-all command does not call replyAll");
});

test("every key hint shown in the UI resolves to the command that claims it", () => {
  // The class of bug D5 is: a control advertises a key that nothing binds.
  // These are the single-key hints the chrome renders next to an action.
  for (const [key, id] of [
    ["r", "reply"],
    ["a", "replyAll"],
    ["f", "forward"],
    ["e", "archive"],
    ["#", "delete"],
    ["s", "flag"],
    ["x", "select"],
    ["c", "compose"],
    ["z", "undo"],
    [",", "settings"],
  ] as const) {
    assert.equal(resolve({ key, targetTag: "div" }), id, `the ${key} hint does not resolve to ${id}`);
  }
});

test("🚨 all six of the design's `g` chords resolve (audit pass 3 D5)", () => {
  // Four of these were unbound. In a keyboard-first client the shortcut
  // sheet is the contract, and `g d` was simply not in it.
  // Wilco.dc.html:1035-1044 is the design's own set; `g g` (top) is ours,
  // from spec 7.4, and additive.
  for (const [second, id] of [
    ["i", "goto:inbox"],
    ["d", "goto:drafts"],
    ["s", "goto:sent"],
    ["t", "goto:trash"],
    ["a", "goto:archive"],
    ["f", "goto:flagged"],
    ["g", "goto:top"],
  ] as const) {
    const chord = chordState();
    assert.equal(feed(chord, "g"), null, "`g` alone must not fire a command");
    assert.equal(feed(chord, second), id, `g ${second} did not resolve to ${id}`);
  }
});

test("each `g` chord reaches its OWN destination", () => {
  // The bug a shared closure would give is four chords that all open the
  // inbox -- every one wired, every one wrong.
  const folders: string[] = [];
  let flagged = 0;
  for (const id of ["goto:drafts", "goto:sent", "goto:trash", "goto:archive"] as const) {
    COMMANDS.find((c) => c.id === id)!.handler!({ gotoFolder: (r: string) => folders.push(r) });
  }
  assert.deepEqual(folders, ["drafts", "sent", "trash", "archive"]);

  // `g f` is deliberately NOT a folder: flagged mail lives in all of them,
  // so the design runs it as a search.
  COMMANDS.find((c) => c.id === "goto:flagged")!.handler!({ gotoFlagged: () => flagged++ });
  assert.equal(flagged, 1, "g f did not run the flagged search");
});
