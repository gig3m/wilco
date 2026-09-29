// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";
import { byTestId, render, tick, type } from "../test-utils";
import { Palette, type PaletteItem } from "./Palette";

function items(): PaletteItem[] {
  return [
    { id: "goto-inbox", label: "Go to Inbox", hint: "g i" },
    { id: "goto-work", label: "Go to Work", hint: "Account" },
    { id: "archive", label: "Archive", hint: "e", disabledReason: "Not yet available -- triage arrives in a later plan." },
  ];
}

test("typing filters the list by label", () => {
  render(<Palette items={items()} onSelect={() => {}} onClose={() => {}} />);
  type(byTestId("palette-input"), "work");
  assert.ok(byTestId("palette-item-goto-work"));
  assert.equal(byTestId("palette-item-goto-inbox", { optional: true }), null);
});

test("a disabled item shows its reason and is not selectable", () => {
  let selected: string | null = null;
  render(<Palette items={items()} onSelect={(id) => (selected = id)} onClose={() => {}} />);
  assert.match(byTestId("palette-disabled-archive").textContent!, /not yet|later plan/i);
  byTestId("palette-item-archive").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(selected, null, "clicking a disabled item selects nothing");
});

test("clicking an enabled item selects it and closes the palette", () => {
  let selected: string | null = null;
  let closed = false;
  render(<Palette items={items()} onSelect={(id) => (selected = id)} onClose={() => (closed = true)} />);
  byTestId("palette-item-goto-inbox").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(selected, "goto-inbox");
  assert.equal(closed, true);
});

test("Escape closes without selecting anything", () => {
  let selected: string | null = null;
  let closed = false;
  render(<Palette items={items()} onSelect={(id) => (selected = id)} onClose={() => (closed = true)} />);
  byTestId("palette").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(selected, null);
  assert.equal(closed, true);
});

test("Enter selects the highlighted (first selectable) item", () => {
  let selected: string | null = null;
  render(<Palette items={items()} onSelect={(id) => (selected = id)} onClose={() => {}} />);
  byTestId("palette").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(selected, "goto-inbox");
});

test("no matches renders an empty state, not a crash", () => {
  render(<Palette items={items()} onSelect={() => {}} onClose={() => {}} />);
  type(byTestId("palette-input"), "zzz-nothing-matches");
  assert.ok(byTestId("palette-empty"));
});

test("🚨 mail results appear BELOW commands, and only when commands thin out", async () => {
  // Audit pass 3 D4: the palette advertises itself as "anything" and mail
  // was the one thing it could not find.
  //
  // The ordering rule is the design's (Wilco.dc.html:1270-1287) and it is
  // what keeps the palette usable: typing a command must never bury it
  // under messages that happen to share a word with it.
  const many: PaletteItem[] = Array.from({ length: 8 }, (_, i) => ({ id: `cmd:${i}`, label: `Compose ${i}` }));
  const mail: PaletteItem[] = [{ id: "mail:personal:M1", label: "Mira — Q4 budget", hint: "Mail" }];

  const { rerender } = render(<Palette items={many} mailItems={mail} onSelect={() => {}} onClose={() => {}} />);
  await tick();

  // Empty query: all 8 commands match, which is >= the floor of 6, so mail
  // stays out of the way.
  let labels = Array.from(document.querySelectorAll('[data-testid^="palette-item-"]')).map((e) => e.textContent ?? "");
  assert.ok(!labels.some((l) => l.includes("Mira")), "mail crowded out the commands");

  // Narrow to one command: now mail earns its place -- and comes LAST.
  type(byTestId("palette-input"), "Compose 3");
  await tick();
  labels = Array.from(document.querySelectorAll('[data-testid^="palette-item-"]')).map((e) => e.textContent ?? "");
  const mailAt = labels.findIndex((l) => l.includes("Mira"));
  assert.ok(mailAt !== -1, `mail never appeared once the commands thinned: ${JSON.stringify(labels)}`);
  assert.equal(
    mailAt,
    labels.length - 1,
    `mail must come after every command, not interleaved: ${JSON.stringify(labels)}`,
  );
  rerender(<Palette items={many} mailItems={mail} onSelect={() => {}} onClose={() => {}} />);
});

test("the palette reports its query so a caller can search", async () => {
  // The palette cannot search by itself -- it holds no `api`. Without this
  // callback there is no way for mail results to exist at all.
  const seen: string[] = [];
  render(<Palette items={[]} onQueryChange={(q) => seen.push(q)} onSelect={() => {}} onClose={() => {}} />);
  await tick();
  type(byTestId("palette-input"), "budget");
  await tick();
  assert.ok(seen.includes("budget"), `the query was never reported: ${JSON.stringify(seen)}`);
});
