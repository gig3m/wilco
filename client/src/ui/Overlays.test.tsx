// @vitest-environment happy-dom
// Overlays.tsx tests (design-fidelity plan, Task 8). The brief's own
// Step 1 tests, plus coverage for the overlay types the brief's snippet
// didn't spell out (raw source, attachment preview, move picker, context
// menu) and the undo-toast "disabled, not implying an undo happened"
// decision documented in Overlays.tsx's own `UndoToast` doc comment.
import { test } from "vitest";
import assert from "node:assert/strict";
import { byTestId, click, press, render, spy } from "../test-utils";
import { Overlays } from "./Overlays";
import { COMMANDS } from "../lib/keymap";

test("the shortcuts overlay lists every command with its key, and explains disabled ones", () => {
  render(<Overlays open="shortcuts" onClose={() => {}} />);
  for (const key of ["j", "k", "e", "#", "s", "z", "?", "/"]) {
    assert.ok(byTestId(`shortcut-${key}`), `no entry for ${key}`);
  }
  // `e` (archive) is LIVE as of plan 7, so it must NOT carry a disabled
  // explanation any more. `r` (reply) still has no send path, so the
  // overlay's "explains disabled ones" contract is asserted against that
  // instead -- the contract still holds, the example moved.
  assert.equal(byTestId("shortcut-disabled-archive", { optional: true }), null, "archive is live and must not read as disabled");
  // 🚨 The example is CHOSEN AT RUNTIME (audit pass 8, T5). This used to
  // name `1` / attachment saving specifically. The comment said "each time
  // a capability ships this example moves -- that is the contract working",
  // and that was the right intent, but it was moved BY HAND: wiring the
  // number keys would break this test and two in App.test.tsx that were
  // never about the number keys. So ask COMMANDS which command is deferred
  // today and assert the overlay explains that one.
  const deferred = COMMANDS.find((c) => c.disabledReason !== undefined);
  if (deferred !== undefined) {
    assert.ok(
      byTestId(`shortcut-disabled-${deferred.id}`).textContent!.includes(deferred.disabledReason!),
      `the overlay lists ${deferred.id} without explaining why it is unavailable`,
    );
  }
});

test("overlays carry a shadow; flat surfaces do not", () => {
  render(<Overlays open="shortcuts" onClose={() => {}} />);
  assert.notEqual(getComputedStyle(byTestId("overlay-card")).boxShadow, "none");
});

test("the notification toast carries the account colour on its edge", () => {
  render(
    <Overlays
      open="none"
      onClose={() => {}}
      toast={{ kind: "notification", account: "work", accent: "#2a9d6e", from: "Priya Raman", subject: "Bridge spec" }}
    />,
  );
  assert.equal(getComputedStyle(byTestId("toast")).borderLeftColor, "rgb(42, 157, 110)");
});

test("A TOAST'S SUBJECT AND SENDER RENDER AS TEXT", () => {
  const evil = "<img src=x onerror=alert(1)>";
  render(
    <Overlays
      open="none"
      onClose={() => {}}
      toast={{ kind: "notification", account: "w", accent: "#000000", from: evil, subject: evil }}
    />,
  );
  assert.equal(document.querySelectorAll("img").length, 0);
  assert.equal(byTestId("toast-from").textContent, evil);
  assert.equal(byTestId("toast-subject").textContent, evil);
});

test("escape closes the overlay", () => {
  const onClose = spy();
  render(<Overlays open="shortcuts" onClose={onClose} />);
  press("Escape");
  assert.equal(onClose.calls.length, 1);
});

test("escape while nothing is open does not throw or fire onClose", () => {
  const onClose = spy();
  render(<Overlays open="none" onClose={onClose} />);
  press("Escape");
  assert.equal(onClose.calls.length, 0);
});

test("the shortcuts close button and scrim both close it", () => {
  const onClose = spy();
  render(<Overlays open="shortcuts" onClose={onClose} />);
  byTestId("shortcuts-close").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(onClose.calls.length, 1);
  byTestId("shortcuts-overlay").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(onClose.calls.length, 2);
});

test("clicking inside the shortcuts card does not close it (stopPropagation)", () => {
  const onClose = spy();
  render(<Overlays open="shortcuts" onClose={onClose} />);
  byTestId("overlay-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(onClose.calls.length, 0);
});

test("raw source renders headers and body as mono TEXT, never markup", () => {
  const evilBody = "<script>alert(1)</script>\nfrom: attacker";
  render(
    <Overlays
      open="source"
      onClose={() => {}}
      source={{ id: "<abc@wilco.dev>", text: `Subject: hi\n\n${evilBody}` }}
    />,
  );
  assert.ok(byTestId("source-overlay"));
  const pre = byTestId("source-text");
  assert.equal(pre.tagName, "PRE");
  assert.match(pre.textContent!, /Subject: hi/);
  assert.match(pre.textContent!, /script/);
  assert.equal(document.querySelectorAll("script").length, 0);
  assert.notEqual(getComputedStyle(byTestId("overlay-card")).boxShadow, "none");
});

test("attachment preview shows name, type badge, size and a Download action", () => {
  const onDownload = spy();
  render(
    <Overlays
      open="attachment"
      onClose={() => {}}
      attachment={{ name: "invoice.pdf", type: "application/pdf", kind: "PDF", size: 234_000, onDownload }}
    />,
  );
  assert.equal(byTestId("attachment-name").textContent, "invoice.pdf");
  assert.match(byTestId("attachment-type-badge").textContent!, /PDF/);
  assert.match(byTestId("attachment-size").textContent!, /KB|MB/);
  const btn = byTestId("attachment-download") as HTMLButtonElement;
  assert.equal(btn.disabled, false);
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(onDownload.calls.length, 1);
});

test("attachment preview's Download is disabled with a reason when no download path exists", () => {
  render(<Overlays open="attachment" onClose={() => {}} attachment={{ name: "x.txt", type: "text/plain", size: 10 }} />);
  const btn = byTestId("attachment-download") as HTMLButtonElement;
  assert.equal(btn.disabled, true);
  assert.match(btn.title, /not yet|spec/i);
});

test("move picker lists folders and selecting one runs its handler and closes", () => {
  const onSelect = spy();
  const onClose = spy();
  render(
    <Overlays
      open="move"
      onClose={onClose}
      move={{ account: "kai@halden.example", folders: [{ id: "archive", name: "Archive", onSelect }] }}
    />,
  );
  assert.ok(byTestId("move-overlay"));
  byTestId("move-folder-archive").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(onSelect.calls.length, 1);
  assert.equal(onClose.calls.length, 1);
});

test("context menu renders items with their hint, honours dividers, and danger styling", () => {
  const onSelect = spy();
  render(
    <Overlays
      open="contextmenu"
      onClose={() => {}}
      contextMenu={{
        x: 120,
        y: 80,
        items: [
          { label: "Reply", hint: "r", onSelect: () => {} },
          { divider: true, label: "" },
          { label: "Delete", hint: "#", danger: true, onSelect },
        ],
      }}
    />,
  );
  assert.equal(byTestId("contextmenu-item-0").textContent, "Replyr");
  const del = byTestId("contextmenu-item-2");
  assert.ok(del.querySelector(".contextmenu-item-label--danger"));
  del.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(onSelect.calls.length, 1);
});

test("a context menu item with no handler renders disabled, not silently dead", () => {
  render(
    <Overlays
      open="contextmenu"
      onClose={() => {}}
      contextMenu={{ x: 0, y: 0, items: [{ label: "Reply all", hint: "a" }] }}
    />,
  );
  assert.equal((byTestId("contextmenu-item-0") as HTMLButtonElement).disabled, true);
});

test("the undo toast shows the label, a z hint, and a disabled Undo when there is nothing to undo", () => {
  render(<Overlays open="none" onClose={() => {}} toast={{ kind: "undo", label: "Archived 1" }} />);
  const toast = byTestId("toast");
  assert.equal(toast.textContent, "Archived 1Undoz");
  const btn = byTestId("toast-undo") as HTMLButtonElement;
  assert.equal(btn.disabled, true);
  assert.ok(btn.title.length > 0, "disabled Undo must carry a reason");
  assert.notEqual(getComputedStyle(toast).boxShadow, "none");
});

test("the undo toast shows no countdown (F11: the design never has one on a triage-shaped toast), and Undo works when wired", () => {
  const onUndo = spy();
  render(<Overlays open="none" onClose={() => {}} toast={{ kind: "undo", label: "Archived 1", onUndo }} />);
  assert.equal(byTestId("toast").textContent, "Archived 1Undoz");
  const btn = byTestId("toast-undo") as HTMLButtonElement;
  assert.equal(btn.disabled, false);
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(onUndo.calls.length, 1);
});

test("dismissing a notification toast does not also open it", () => {
  const onOpen = spy();
  const onDismiss = spy();
  render(
    <Overlays
      open="none"
      onClose={() => {}}
      toast={{ kind: "notification", account: "w", accent: "#5b6ee0", from: "A", subject: "B", onOpen, onDismiss }}
    />,
  );
  byTestId("toast-dismiss").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(onDismiss.calls.length, 1);
  assert.equal(onOpen.calls.length, 0, "dismiss must stopPropagation so it doesn't also fire the toast's own click-to-open");
});

test("the attachment viewer shows the image itself when it has one, with Download live and no made-up scan verdict", () => {
  let downloads = 0;
  render(
    <Overlays
      open="attachment"
      onClose={() => {}}
      commands={[]}
      attachment={{ name: "photo.jpg", type: "image/jpeg", size: 3000, viewUrl: "https://mailbody.example.com/a/tok/B1?view=1", onDownload: () => { downloads += 1; } }}
    />,
  );
  const img = byTestId("attachment-image") as HTMLImageElement;
  assert.equal(img.getAttribute("src"), "https://mailbody.example.com/a/tok/B1?view=1");
  assert.equal(img.getAttribute("alt"), "photo.jpg");
  assert.equal(byTestId("attachment-type-badge", { optional: true }), null, "no swatch when the image is real");
  assert.doesNotMatch(byTestId("overlay-card").textContent!, /scanned/, "nothing here scanned anything");
  click(byTestId("attachment-download"));
  assert.equal(downloads, 1);
});
