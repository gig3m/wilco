// @vitest-environment happy-dom
// Compose surface tests (design-fidelity plan, Task 5). See Compose.tsx's
// module doc comment for the two data gaps (`identities`, signature
// default) these tests work around rather than resolve.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { byTestId, click, render, tick, type } from "../test-utils";

/** Set a controlled field the way a user does: assign the value AND fire
 *  `input`, or Preact's state never learns about it and the component
 *  keeps rendering the old value. */
function setValue(el: HTMLElement, value: string): void {
  (el as HTMLInputElement | HTMLTextAreaElement).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
import { Compose, DRAFT_SAVE_DEBOUNCE_MS, type OutgoingDraft } from "./Compose";

/** Types into the rich editor the way a test can: a plain-text paste. */
function typeBody(el: HTMLElement, value: string): void {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { getData: (t: string) => (t === "text/plain" ? value : "") } });
  el.dispatchEvent(ev);
}

test("compose fills the reading pane as a card, not a modal", () => {
  render(<Compose accounts={[{ key: "work", label: "Work", code: "HAL" }]} />);
  const card = byTestId("compose-card");
  assert.equal(card.getAttribute("role"), null, "not a dialog — it is a pane");
  assert.equal(getComputedStyle(card).borderTopWidth, "2px");
});

test("cc and bcc are hidden until toggled", () => {
  render(<Compose accounts={[]} />);
  assert.equal(byTestId("field-cc", { optional: true }), null);
  click(byTestId("toggle-cc"));
  assert.ok(byTestId("field-cc"));
  assert.ok(byTestId("field-bcc"));
});

test("the composer is a rich editor with Fastmail's bar; nothing claims text/plain", () => {
  render(<Compose accounts={[]} />);
  const body = byTestId("compose-body");
  assert.ok(body.hasAttribute("contenteditable"), "the body is editable in place");
  assert.equal(body.getAttribute("role"), "textbox");
  for (const id of ["bold", "italic", "underline", "strike", "link", "ul", "ol", "align-center", "image"]) assert.ok(byTestId(`rt-${id}`));
  assert.equal(document.querySelector(".compose-toolbar-note"), null, "no 'sent as text/plain' footnote");
  assert.equal(byTestId("md-bold", { optional: true }), null, "the markdown bar is gone");
});

test("SEND IS DISABLED AND SAYS WHY", () => {
  // There is no EmailSubmission path in this codebase. A live-looking Send
  // button that silently does nothing is worse than one that admits it.
  render(<Compose accounts={[]} />);
  assert.equal(byTestId("send").hasAttribute("disabled"), true);
  // 🚨 Asserts a reason EXISTS, not its wording. This used to match
  // /plan|not yet/i, which pinned the phrasing rather than the
  // truth -- and so kept a false claim in place: COMPOSE_REASON
  // still said "there is no send path in this codebase yet" months
  // after send shipped, and the test enforced that it kept saying
  // something of that shape (audit pass 7 F1).
  assert.ok((byTestId("send").getAttribute("title") ?? "").trim().length > 0, "send is disabled with no reason");
});

test("attach is still unwired and says why", () => {
  render(<Compose accounts={[]} />);
  const el = byTestId("attach");
  assert.equal(el.hasAttribute("disabled"), true);
  assert.ok((el.getAttribute("title") ?? "").trim().length > 0, "attach is disabled with no reason");
});

test("discard is REAL now -- it closes the window rather than explaining itself", () => {
  let closed = 0;
  render(<Compose accounts={[]} onClose={() => (closed += 1)} />);
  const el = byTestId("discard");
  assert.equal(el.hasAttribute("disabled"), false, "discard is wired once onClose exists");
  el.click();
  assert.equal(closed, 1);
});

test("SEND: hands App exactly what was typed, and closes only on success", async () => {
  const sent: unknown[] = [];
  render(
    <Compose
      accounts={[{ key: "work", label: "Work", identities: [{ email: "robin@lumber.example", primary: true }] }]}
      onSend={(m) => {
        sent.push(m);
        return Promise.resolve();
      }}
      onClose={() => {}}
    />,
  );
  // Send is refused until there is a recipient -- an empty To must never
  // reach the server.
  assert.equal(byTestId("send").hasAttribute("disabled"), true, "no recipient yet");

  setValue(byTestId("compose-to"), "a@example.com");
  setValue(byTestId("compose-subject"), "Hello");
  typeBody(byTestId("compose-body"), "the body");
  await tick();
  assert.equal(byTestId("send").hasAttribute("disabled"), false);

  byTestId("send").click();
  await tick();
  assert.equal(sent.length, 1);
  const msg = sent[0] as { from: string; to: string; subject: string; html: string };
  assert.equal(msg.from, "work|robin@lumber.example");
  assert.equal(msg.to, "a@example.com");
  assert.equal(msg.subject, "Hello");
  assert.ok(msg.html.includes("the body"), msg.html);
  assert.ok(!("text" in msg), "the server derives the text half");
});

test("SEND FAILURE keeps the window open with the reason -- never discards the message", async () => {
  let closed = 0;
  render(
    <Compose
      accounts={[{ key: "work", label: "Work", identities: [{ email: "k@x.com", primary: true }] }]}
      onSend={() => Promise.reject(new Error("mailbox full"))}
      onClose={() => (closed += 1)}
    />,
  );
  setValue(byTestId("compose-to"), "a@example.com");
  await tick();
  byTestId("send").click();
  await tick();
  await tick();
  assert.equal(closed, 0, "a failed send must NOT close the window and lose the draft");
  assert.match(byTestId("send-error").textContent!, /mailbox full/);
});

test("the from select lists aliases with a · alias suffix", () => {
  render(
    <Compose
      accounts={[
        {
          key: "work",
          label: "Work",
          code: "HAL",
          identities: [
            { email: "kai@halden.example", primary: true, name: "Kai" },
            { email: "kai+news@halden.example", primary: false, name: "Kai" },
          ],
        },
      ]}
    />,
  );
  // The suffix marks an alias; the rest of the option is the From header
  // itself. Row 60 replaced the design's `a.name + ' <' + al + '>'` --
  // where `a.name` was the ACCOUNT's name -- with the identity's own name,
  // because the account name is never what a recipient sees.
  assert.match(byTestId("from-select").textContent!, /kai\+news@halden\.example> · alias/);
  assert.match(byTestId("from-select").textContent!, /Kai <kai@halden\.example>/);
});

test("with no identities supplied, the from select falls back to the account label alone", () => {
  render(<Compose accounts={[{ key: "work", label: "Work", code: "HAL" }]} />);
  const select = byTestId("from-select") as HTMLSelectElement;
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0]!.textContent, "Work");
});

test("closing the pane calls onClose, and it is not disabled", () => {
  let closed = 0;
  render(<Compose accounts={[]} onClose={() => (closed += 1)} />);
  const closeBtn = byTestId("compose-close");
  assert.equal(closeBtn.hasAttribute("disabled"), false);
  click(closeBtn);
  assert.equal(closed, 1);
});

test("a hostile account label or contact name is text, not markup", () => {
  render(
    <Compose
      accounts={[{ key: "work", label: "<img src=x onerror=alert(1)>", code: "HAL" }]}
      contacts={[{ name: "<b>Evil</b>", email: "evil@example.test" }]}
    />,
  );
  const select = byTestId("from-select") as HTMLSelectElement;
  assert.equal(select.options[0]!.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(select.querySelector("img"), null);
});

test("attachment chips can be removed", () => {
  render(<Compose accounts={[]} attachments={[{ name: "notes.pdf", size: "84 KB" }]} />);
  assert.ok(byTestId("attachment-chip-notes.pdf"));
  click(byTestId("attachment-remove-notes.pdf"));
  assert.equal(byTestId("attachment-chip-notes.pdf", { optional: true }), null);
});

// escape.test.ts already runs a project-wide grep guard banning the raw-
// HTML-injection API across every `ui/` file, `Compose.tsx` included --
// no need to duplicate it here.

// -- Attachments (milestone 7) --------------------------------------------

function file(name: string, bytes = 10, type = "application/pdf"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

test("choosing a file uploads it and the chip reports each state in turn", async () => {
  let resolve!: (v: { account: string; blobId: string; name: string; type: string; size: number }) => void;
  const onUpload = () => new Promise<{ account: string; blobId: string; name: string; type: string; size: number }>((r) => (resolve = r));

  const { container } = render(
    <Compose accounts={[{ key: "work", label: "Work", identities: [{ email: "me@work.test", primary: true }] }]} onSend={async () => {}} onUpload={onUpload} />,
  );
  const input = container.querySelector('[data-testid="attach-input"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file("Invoice.pdf")], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();

  // v1.1 #3: in flight the chip shows the spinner and a live PERCENT in
  // place of the size -- not the word "uploading", and never the size,
  // which would read as attached.
  const chip = byTestId("attachment-chip-Invoice.pdf");
  assert.match(chip.textContent!, /⟳/);
  assert.match(chip.textContent!, /\d+%/);
  assert.ok(chip.classList.contains("compose-attachment-chip--uploading"));

  resolve({ account: "work", blobId: "B1", name: "Invoice.pdf", type: "application/pdf", size: 10 });
  await tick();
  const done = byTestId("attachment-chip-Invoice.pdf");
  assert.ok(!done.classList.contains("compose-attachment-chip--uploading"));
  assert.doesNotMatch(done.textContent!, /%/, "the size replaces the percent when done");
});

test("🚨 Send is BLOCKED while an attachment is still uploading", async () => {
  // Sending now would deliver a message the user believes carries a file.
  // Blocking is the honest failure; silently dropping the chip is not.
  const onUpload = () => new Promise<never>(() => {});
  const { container } = render(
    <Compose
      accounts={[{ key: "work", label: "Work", identities: [{ email: "me@work.test", primary: true }] }]}
      initialTo="you@example.test"
      onSend={async () => {}}
      onUpload={onUpload as never}
    />,
  );
  const input = container.querySelector('[data-testid="attach-input"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file("big.bin")], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();

  const send = byTestId("send") as HTMLButtonElement;
  assert.equal(send.disabled, true);
  assert.match(send.getAttribute("title")!, /still uploading/);
});

test("a failed upload says so on the chip rather than looking attached", async () => {
  const onUpload = () => Promise.reject(new Error("too large"));
  const { container } = render(
    <Compose accounts={[{ key: "work", label: "Work", identities: [{ email: "me@work.test", primary: true }] }]} onSend={async () => {}} onUpload={onUpload as never} />,
  );
  const input = container.querySelector('[data-testid="attach-input"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file("huge.mov")], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  // v1.1 #3: failed is #cf222e with "· failed" and a bold ↻ retry.
  const failed = byTestId("attachment-chip-huge.mov");
  assert.match(failed.textContent!, /· failed/);
  assert.ok(failed.classList.contains("compose-attachment-chip--failed"));
  assert.match(failed.getAttribute("title")!, /too large/);
});

test("🚨 switching account RE-UPLOADS attachments, because blob ids are account-scoped", async () => {
  // Spec 11: a blob uploaded into one account cannot be attached to a
  // message sent from another. Dropping them silently, or letting the send
  // fail at the far end, are both worse than paying for the re-upload.
  const uploads: string[] = [];
  const onUpload = (account: string, f: File) => {
    uploads.push(`${account}:${f.name}`);
    return Promise.resolve({ account, blobId: `B-${account}`, name: f.name, type: f.type, size: f.size });
  };
  const { container } = render(
    <Compose
      accounts={[
        { key: "work", label: "Work", identities: [{ email: "me@work.test", primary: true }] },
        { key: "personal", label: "Personal", identities: [{ email: "me@home.test", primary: true }] },
      ]}
      onSend={async () => {}}
      onUpload={onUpload}
    />,
  );
  const input = container.querySelector('[data-testid="attach-input"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file("Invoice.pdf")], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  assert.deepEqual(uploads, ["work:Invoice.pdf"]);

  const select = container.querySelector("select") as HTMLSelectElement;
  select.value = "personal|me@home.test";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();

  assert.deepEqual(uploads, ["work:Invoice.pdf", "personal:Invoice.pdf"], "re-uploaded into the new account");
});

test("the sent draft carries only chips that finished uploading", async () => {
  let sent: OutgoingDraft | null = null;
  const { container } = render(
    <Compose
      accounts={[{ key: "work", label: "Work", identities: [{ email: "me@work.test", primary: true }] }]}
      initialTo="you@example.test"
      onSend={async (d) => {
        sent = d;
      }}
      onUpload={(account, f) => Promise.resolve({ account, blobId: "B1", name: f.name, type: f.type, size: f.size })}
    />,
  );
  const input = container.querySelector('[data-testid="attach-input"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file("Invoice.pdf")], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  click(byTestId("send"));
  await tick();
  assert.equal(sent!.attachments.length, 1);
  assert.equal(sent!.attachments[0]!.blobId, "B1");
  assert.equal(sent!.attachments[0]!.account, "work");
});

test("🚨 the compose chrome does not CLAIM a draft was saved", () => {
  // The design's text is "draft saved". Nothing saves drafts, so printing
  // it is a false statement about the user's message -- and unlike a
  // disabled button, there is nothing for them to notice.
  render(<Compose accounts={[{ key: "work", label: "Work" }]} />);
  const note = document.querySelector(".compose-saved-note")!;
  assert.doesNotMatch(note.textContent!, /draft saved/);
  assert.match(note.textContent!, /not saved/);
});

// -- Drafts (milestone 7) --------------------------------------------------

const ACCTS = [
  { key: "work", label: "Work", identities: [{ email: "me@work.test", primary: true }] },
  { key: "personal", label: "Personal", identities: [{ email: "me@home.test", primary: true }] },
];

function typeSubject(container: Element, value: string): void {
  const el = container.querySelector('[data-testid="compose-subject"]') as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

test("typing autosaves once, debounced, and the header tracks the real state", async () => {
  const saves: (string | null)[] = [];
  const { container } = render(
    <Compose
      accounts={ACCTS}
      onSend={async () => {}}
      onSaveDraft={async (_d, id) => {
        saves.push(id);
        return "D1";
      }}
    />,
  );
  // v1.1 #4's exact wording for the untouched state.
  assert.match(byTestId("compose-draft-status").textContent!, /^not saved · esc/, "nothing saved yet");

  typeSubject(container, "a");
  typeSubject(container, "ab");
  typeSubject(container, "abc");
  assert.equal(saves.length, 0, "debounced -- not a request per keystroke");

  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 120));
  await tick();
  assert.deepEqual(saves, [null], "one save, creating");
  // v1.1 #4: the saved state carries the clock -- "draft saved HH:MM · esc".
  assert.match(byTestId("compose-draft-status").textContent!, /^draft saved \d\d:\d\d · esc$/);
});

test("🚨 the second save UPDATES the first draft rather than creating another", async () => {
  const saves: (string | null)[] = [];
  const { container } = render(
    <Compose
      accounts={ACCTS}
      onSend={async () => {}}
      onSaveDraft={async (_d, id) => {
        saves.push(id);
        return "D1";
      }}
    />,
  );
  typeSubject(container, "one");
  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 120));
  await tick();
  typeSubject(container, "two");
  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 120));
  await tick();
  // A stale closure over the id would pass null again and leave the Drafts
  // folder with a copy per debounce.
  assert.deepEqual(saves, [null, "D1"]);
});

test("a failed save says 'not saved' rather than claiming the work is kept", async () => {
  const { container } = render(
    <Compose accounts={ACCTS} onSend={async () => {}} onSaveDraft={async () => { throw new Error("nope"); }} />,
  );
  typeSubject(container, "x");
  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 120));
  await tick();
  const status = byTestId("compose-draft-status");
  assert.match(status.textContent!, /not saved/);
  assert.match(status.getAttribute("title")!, /still here/);
});

test("Discard deletes the SERVER draft, not just the window", async () => {
  const discarded: string[] = [];
  const { container } = render(
    <Compose
      accounts={ACCTS}
      onSend={async () => {}}
      onClose={() => {}}
      onSaveDraft={async () => "D1"}
      onDiscardDraft={async (_a, id) => {
        discarded.push(id);
      }}
    />,
  );
  typeSubject(container, "x");
  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 120));
  await tick();
  click(byTestId("discard"));
  await tick();
  assert.deepEqual(discarded, ["D1"], "a draft left behind is one the user believes they discarded");
});

test("🚨 a successful send discards the saved draft", async () => {
  // The send creates and files its own message. The draft would otherwise
  // sit in Drafts as a duplicate of mail that already went out.
  const discarded: string[] = [];
  const { container } = render(
    <Compose
      accounts={ACCTS}
      initialTo="you@example.test"
      onSend={async () => {}}
      onClose={() => {}}
      onSaveDraft={async () => "D1"}
      onDiscardDraft={async (_a, id) => {
        discarded.push(id);
      }}
    />,
  );
  typeSubject(container, "x");
  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 120));
  await tick();
  click(byTestId("send"));
  await tick();
  await tick();
  assert.deepEqual(discarded, ["D1"]);
});

test("🚨 changing account discards the old draft -- a draft belongs to its account", async () => {
  // Spec 11. The next save creates a fresh one in the new account.
  const discarded: { account: string; id: string }[] = [];
  const saves: (string | null)[] = [];
  const { container } = render(
    <Compose
      accounts={ACCTS}
      onSend={async () => {}}
      onSaveDraft={async (_d, id) => {
        saves.push(id);
        return "D1";
      }}
      onDiscardDraft={async (account, id) => {
        discarded.push({ account, id });
      }}
    />,
  );
  typeSubject(container, "x");
  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 120));
  await tick();

  const select = container.querySelector("select") as HTMLSelectElement;
  select.value = "personal|me@home.test";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  assert.deepEqual(discarded, [{ account: "work", id: "D1" }]);

  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 120));
  await tick();
  assert.deepEqual(saves, [null, null], "the save after the switch CREATES, it does not update a foreign id");
});

test("resuming a draft updates it rather than making a copy", async () => {
  const saves: (string | null)[] = [];
  const { container } = render(
    <Compose
      accounts={ACCTS}
      initialDraftId="EXISTING"
      initialSavedAt="09:41"
      onSend={async () => {}}
      onSaveDraft={async (_d, id) => {
        saves.push(id);
        return "EXISTING";
      }}
    />,
  );
  // v1.1 #4: the saved state carries the clock -- "draft saved HH:MM · esc".
  assert.match(byTestId("compose-draft-status").textContent!, /^draft saved \d\d:\d\d · esc$/);
  typeSubject(container, "more");
  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 120));
  await tick();
  assert.deepEqual(saves, ["EXISTING"]);
});

test("🚨 from is reconciled when the accounts arrive AFTER mount", async () => {
  // On a deep link the accounts have not loaded when Compose mounts, so
  // `from` seeds empty and every save posts an empty account -- which the
  // server correctly refuses with 503. Found by opening a draft URL against
  // the live server; the component mounts identically either way and only
  // the timing differs, which is why no existing test caught it.
  // Scoped to THIS render's container: test-utils' `render` appends a new
  // container per call and never removes the last, so a bare
  // document.querySelector finds an earlier test's select.
  const saved: string[] = [];
  const { rerender, container } = render(
    <Compose accounts={[]} onSend={async () => {}} onSaveDraft={async (d) => { saved.push(d.from); return "D1"; }} />,
  );
  rerender(
    <Compose accounts={ACCTS} onSend={async () => {}} onSaveDraft={async (d) => { saved.push(d.from); return "D1"; }} />,
  );
  await tick();
  const select = container.querySelector("select") as HTMLSelectElement;
  assert.equal(select.value, "work|me@work.test", "the first account is chosen once known");
});

test("a resumed draft opens as ITS OWN account, not whichever is first", async () => {
  // Saving under the wrong account would move the draft between accounts.
  const { rerender, container } = render(
    <Compose accounts={[]} initialAccount="personal" initialDraftId="D9" onSend={async () => {}} onSaveDraft={async () => "D9"} />,
  );
  rerender(
    <Compose accounts={ACCTS} initialAccount="personal" initialDraftId="D9" onSend={async () => {}} onSaveDraft={async () => "D9"} />,
  );
  await tick();
  assert.equal((container.querySelector("select") as HTMLSelectElement).value, "personal|me@home.test");
});

test("resolving an unknown account is not treated as the user switching accounts", async () => {
  // If it were, the very draft just resumed would be discarded.
  const discarded: string[] = [];
  const { rerender } = render(
    <Compose accounts={[]} initialAccount="work" initialDraftId="D9" onSend={async () => {}} onSaveDraft={async () => "D9"}
      onDiscardDraft={async (_a, id) => { discarded.push(id); }} />,
  );
  rerender(
    <Compose accounts={ACCTS} initialAccount="work" initialDraftId="D9" onSend={async () => {}} onSaveDraft={async () => "D9"}
      onDiscardDraft={async (_a, id) => { discarded.push(id); }} />,
  );
  await tick();
  assert.deepEqual(discarded, [], "the resumed draft survives");
});

// -- Signatures (milestone 8) ---------------------------------------------

const SIGNED = [
  {
    key: "work",
    label: "Work",
    identities: [
      { id: "I1", email: "me@work.test", primary: true, textSignature: "-- \nRobin\nLumber Co", htmlSignature: "" },
      { id: "I2", email: "alias@work.test", primary: false, textSignature: "", htmlSignature: "" },
    ],
  },
];

const SIG_HTML = '<table><tbody><tr><td><img src="data:image/png;base64,AAAA" height="60"></td></tr></tbody></table><p>ROBIN</p>';
const loadText = async () => ({ html: "", text: "-- \nRobin\nLumber Co" });
const loadHtml = async () => ({ html: SIG_HTML, text: "ROBIN" });

test("HTML compose: the signature is IN the editor at open, as an editable block after an empty first line", async () => {
  const { container } = render(<Compose accounts={SIGNED} onSend={async () => {}} loadSignature={loadHtml} />);
  await tick();
  await tick();
  const body = byTestId("compose-body");
  const block = byTestId("compose-signature");
  assert.ok(body.contains(block), "the block is inside the editable document");
  assert.equal(block.getAttribute("data-wilco-signature"), "");
  assert.equal(body.firstElementChild!.tagName, "P", "an empty line to write on comes first");
  assert.ok(container.querySelector('[data-testid="compose-signature"] img'), "the logo is rendered in place, not previewed in a box");
  assert.equal(container.querySelector('[data-testid="signature-preview"]'), null, "the preview frame is gone");
});

test("🚨 a text-only signature becomes paragraphs, byte for byte within each line -- '-- ' keeps its trailing space", async () => {
  const sent: OutgoingDraft[] = [];
  render(<Compose accounts={SIGNED} onSend={async (m) => { sent.push(m); }} loadSignature={loadText} />);
  await tick();
  await tick();
  setValue(byTestId("compose-to"), "a@example.com");
  typeBody(byTestId("compose-body"), "hi");
  await tick();
  byTestId("send").click();
  await tick();
  assert.ok(sent[0]!.html.includes("<div data-wilco-signature><p>-- </p><p>Robin</p><p>Lumber Co</p></div>"), sent[0]!.html);
});

test("no signature (the switch is off, or the identity has none) inserts no block", async () => {
  render(<Compose accounts={SIGNED} onSend={async () => {}} loadSignature={async () => null} />);
  await tick();
  await tick();
  assert.equal(byTestId("compose-signature", { optional: true }), null);
});

test("🚨 an untouched compose window does not leave an empty draft behind -- a signature alone is not a message", async () => {
  const saves: number[] = [];
  render(
    <Compose accounts={SIGNED} onSend={async () => {}} loadSignature={loadHtml} onSaveDraft={async () => { saves.push(1); return "D1"; }} />,
  );
  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 150));
  await tick();
  assert.deepEqual(saves, [], "nothing typed, nothing saved");
});

test("switching From swaps an UNTOUCHED block for the new identity's, and leaves an edited one alone", async () => {
  const calls: string[] = [];
  const load = async (_a: string, id: string) => {
    calls.push(id);
    return id === "I1" ? { html: "", text: "-- \nPrimary" } : { html: "", text: "-- \nAlias" };
  };
  const { container } = render(<Compose accounts={SIGNED} onSend={async () => {}} loadSignature={load} />);
  await tick();
  await tick();
  assert.match(byTestId("compose-signature").textContent!, /Primary/);
  const select = container.querySelector("select") as HTMLSelectElement;
  select.value = "work|alias@work.test";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  await tick();
  assert.match(byTestId("compose-signature").textContent!, /Alias/, "untouched: replaced");
  assert.doesNotMatch(byTestId("compose-signature").textContent!, /Primary/);
  // Edit the block, then switch back: the owner's edit wins.
  const p = byTestId("compose-signature").querySelector("p:last-child")!;
  p.textContent = "Alias edited";
  byTestId("compose-body").dispatchEvent(new Event("input", { bubbles: true }));
  select.value = "work|me@work.test";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  await tick();
  assert.match(byTestId("compose-signature").textContent!, /Alias edited/, "edited: kept");
});

const QUOTE = { mode: "reply" as const, attribution: "On Monday, Dana wrote:", html: '<p>Original <b>text</b></p><img src="https://x/pic.png" data-wilco-blocked="1" data-wilco-src="https://x/pic.png" alt="">', text: "Original text" };

test("ROW 44: a reply puts the quoted original INTO the editor as one editable blockquote, after the signature by default", async () => {
  const sent: OutgoingDraft[] = [];
  render(<Compose accounts={SIGNED} mode="reply" onSend={async (m) => { sent.push(m); }} loadSignature={loadHtml} quote={QUOTE} />);
  await tick();
  await tick();
  const body = byTestId("compose-body");
  const bq = body.querySelector("blockquote[data-wilco-quote]");
  assert.ok(bq, "the quote is a blockquote inside the editable document");
  assert.equal(body.querySelectorAll("blockquote").length, 1, "exactly one blockquote");
  assert.match(body.querySelector("[data-wilco-attribution]")!.textContent!, /Dana wrote/);
  const order = Array.from(body.children).map((el) => el.hasAttribute("data-wilco-signature") ? "sig" : el.hasAttribute("data-wilco-attribution") ? "attr" : el.hasAttribute("data-wilco-quote") ? "quote" : el.tagName.toLowerCase());
  assert.deepEqual(order, ["p", "sig", "attr", "quote"], "empty line, signature, attribution, quote");
  assert.ok(byTestId("compose-quote-frame", { optional: true }) === null, "no read-only frame any more");
  // Editable: delete the quoted paragraph the way a person would.
  bq!.querySelector("p")!.remove();
  body.dispatchEvent(new Event("input", { bubbles: true }));
  setValue(byTestId("compose-to"), "a@example.com");
  await tick();
  byTestId("send").click();
  await tick();
  const html = sent[0]!.html;
  assert.ok(!html.includes("Original"), "the deleted quoted paragraph is gone from the send");
  assert.match(html, /<blockquote type="cite" data-wilco-quote>/);
  assert.match(html, /data-wilco-src="https:\/\/x\/pic\.png"/, "the blocked image keeps its URL for the server to restore");
});

test("ROW 44: placement 'below' puts the quote BEFORE the signature; a forward uses the header block and no blockquote", async () => {
  render(<Compose accounts={SIGNED} mode="reply" onSend={async () => {}} loadSignature={loadText} signaturePlacement="below" quote={QUOTE} />);
  await tick();
  await tick();
  const order = Array.from(byTestId("compose-body").children).map((el) => el.hasAttribute("data-wilco-signature") ? "sig" : el.hasAttribute("data-wilco-attribution") ? "attr" : el.hasAttribute("data-wilco-quote") ? "quote" : el.tagName.toLowerCase());
  assert.deepEqual(order, ["p", "attr", "quote", "sig"]);
  render(<Compose accounts={SIGNED} mode="forward" onSend={async () => {}} loadSignature={loadText}
    quote={{ mode: "forward", attribution: "---------- Forwarded message ----------\nFrom: Dana", html: null, text: "See attached." }} />);
  await tick();
  await tick();
  const bodies = document.querySelectorAll('[data-testid="compose-body"]');
  const fwd = bodies[bodies.length - 1]!;
  assert.equal(fwd.querySelectorAll("blockquote").length, 0, "a forward is not a blockquote");
  assert.match(fwd.querySelector("[data-wilco-attribution]")!.textContent!, /Forwarded message/);
  assert.match(fwd.querySelector("[data-wilco-quote]")!.textContent!, /See attached\./);
});

test("ROW 44: a reply opened and closed leaves no draft -- the quote is not the owner's writing", async () => {
  const saves: number[] = [];
  render(<Compose accounts={SIGNED} mode="reply" onSend={async () => {}} loadSignature={loadHtml} quote={QUOTE} onSaveDraft={async () => { saves.push(1); return "D1"; }} />);
  await new Promise((r) => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 150));
  await tick();
  assert.deepEqual(saves, []);
});

test("a resumed draft is adopted as saved -- its own block included, no second one inserted", async () => {
  const sent: OutgoingDraft[] = [];
  render(
    <Compose
      accounts={SIGNED}
      onSend={async (m) => { sent.push(m); }}
      loadSignature={loadHtml}
      initialHtml={'<p>draft <strong>text</strong></p><div data-wilco-signature><p>-- </p><p>Edited sig</p></div>'}
      initialDraftId="D1"
    />,
  );
  await tick();
  await tick();
  assert.equal(document.querySelectorAll('[data-wilco-signature]').length, 1);
  assert.match(byTestId("compose-body").textContent!, /Edited sig/);
  assert.doesNotMatch(byTestId("compose-body").textContent!, /ROBIN/);
});

test("v1.1 #3: a failed chip offers ↻ retry, which uploads the same file again", async () => {
  let attempts = 0;
  const { container } = render(
    <Compose
      accounts={SIGNED}
      onSend={async () => {}}
      onUpload={(account, f) => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("network"))
          : Promise.resolve({ account, blobId: "B1", name: f.name, type: f.type, size: f.size });
      }}
    />,
  );
  const input = container.querySelector('[data-testid="attach-input"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file("notes.txt")], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  assert.match(byTestId("attachment-chip-notes.txt").textContent!, /· failed/);

  click(byTestId("attachment-retry-notes.txt"));
  await tick();
  assert.equal(attempts, 2, "the kept File is uploaded again");
  assert.doesNotMatch(byTestId("attachment-chip-notes.txt").textContent!, /failed/);
});

test("the live percent comes from real upload progress, not a simulation", async () => {
  // v1.1 #3 asks for a live percent; `fetch` has no upload-progress event,
  // so the API client uses XMLHttpRequest purely for this callback.
  let report!: (p: number) => void;
  const { container } = render(
    <Compose
      accounts={SIGNED}
      onSend={async () => {}}
      onUpload={(_a, _f, onProgress) => {
        report = onProgress!;
        return new Promise(() => {});
      }}
    />,
  );
  const input = container.querySelector('[data-testid="attach-input"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file("big.bin")], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  assert.match(byTestId("attachment-chip-big.bin").textContent!, /0%/);

  report(64);
  await tick();
  assert.match(byTestId("attachment-chip-big.bin").textContent!, /64%/);
});

test("🚨 A REPLY IS SENT FROM THE ACCOUNT THE MESSAGE BELONGS TO, NOT THE FIRST ONE", () => {
  // 🚨 The defect this pins was live and confirmed on delivered mail: every
  // reply in the app went out as robin@atelier.example regardless of which
  // account the message was in.
  //
  // `from` was seeded to `accounts[0]`, and the effect that applies
  // `initialAccount` was guarded on "does `from` already name a KNOWN
  // account?". On the normal path -- accounts already loaded, reader
  // presses `r` -- that was always true, so the effect returned
  // immediately and `initialAccount` was never applied. Accounts arrive
  // sorted, so `accounts[0]` is `atelier`.
  //
  // The guard was standing in for "the user has not chosen yet", and a
  // VALUE cannot answer that: a default and a deliberate choice look
  // identical. That is the general shape, and it is why this is asserted
  // on BOTH orderings below -- accounts present at mount, and accounts
  // arriving late -- since the bug only appeared in the first.
  //
  // ⚠️ Mutation note, so the next reader is not misled: the fix has TWO
  // halves (the seed prefers `initialAccount`; the reconcile guard asks
  // what WE last set rather than whether the value is a known account) and
  // EITHER ALONE makes this pass. Reverting one is therefore not expected
  // to fail it -- reverting both, which is exactly the code that shipped,
  // does. Both are kept because they answer different orderings.
  // Sorted, exactly as /api/accounts returns them -- which is why
  // `accounts[0]` was atelier in production.
  const accounts = [
    { key: "atelier", label: "Atelier", identities: [{ email: "robin@atelier.example", primary: true }] },
    { key: "personal", label: "Personal", identities: [{ email: "robin@halden.example", primary: true }] },
  ];

  const { rerender, container } = render(<Compose accounts={accounts} initialAccount="personal" onClose={() => {}} />);
  assert.match(
    (container.querySelector("select") as HTMLSelectElement).value,
    /^personal/,
    "the reply was addressed from the first account in the list, not the message's own",
  );

  // The deep-link ordering: accounts have not loaded when Compose mounts.
  const late = render(<Compose accounts={[]} initialAccount="personal" onClose={() => {}} />);
  late.rerender(<Compose accounts={accounts} initialAccount="personal" onClose={() => {}} />);
  assert.match(
    (late.container.querySelector("select") as HTMLSelectElement).value,
    /^personal/,
    "a deep link that resolved its accounts late still picked the wrong sender",
  );
});

test("🚨 A SENDER THE USER PICKED BY HAND IS NEVER OVERWRITTEN", () => {
  // The other half: the reconcile effect must not fight the reader. This
  // is what the old "is it a known account?" guard was really trying to
  // protect, and it has to keep holding now that the guard is gone.
  const accounts = [
    { key: "atelier", label: "Atelier", identities: [{ email: "robin@atelier.example", primary: true }] },
    { key: "personal", label: "Personal", identities: [{ email: "robin@halden.example", primary: true }] },
  ];
  const { rerender, container } = render(<Compose accounts={accounts} initialAccount="personal" onClose={() => {}} />);
  const select = container.querySelector("select") as HTMLSelectElement;

  select.value = fromValueFor(select, "atelier");
  select.dispatchEvent(new Event("change", { bubbles: true }));
  assert.match(select.value, /^atelier/, "the change did not take");

  // A re-render for any other reason must leave that choice alone.
  rerender(<Compose accounts={accounts} initialAccount="personal" onClose={() => {}} />);
  assert.match(
    (container.querySelector("select") as HTMLSelectElement).value,
    /^atelier/,
    "a re-render reset a sender the user had chosen deliberately",
  );
});

/** The first option value belonging to `account` -- the option values carry
 *  an identity suffix, so they cannot be spelled as bare account keys. */
function fromValueFor(select: HTMLSelectElement, account: string): string {
  const opt = Array.from(select.options).find((o) => o.value === account || o.value.startsWith(`${account}|`));
  assert.ok(opt, `no from-option for ${account}`);
  return opt!.value;
}

test("row 23: the To field looks contacts up as you type, and a suggestion fills the address", async () => {
  const asked: { account: string; q: string }[] = [];
  render(
    <Compose
      accounts={[{ key: "personal", label: "Personal", code: "PER" }]}
      lookupContacts={(account, q) => {
        asked.push({ account, q });
        return Promise.resolve([{ name: "Dana Ruiz", email: "dana@example.com" }]);
      }}
    />,
  );
  const to = byTestId("compose-to") as HTMLInputElement;
  to.dispatchEvent(new FocusEvent("focus"));
  type(to, "d");
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(asked, [], "one character asks nothing");
  type(to, "da");
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(asked, [{ account: "personal", q: "da" }], "two characters ask the server, once");
  const item = byTestId("to-autocomplete-dana@example.com");
  item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal((byTestId("compose-to") as HTMLInputElement).value, "dana@example.com, ", "picking the suggestion fills the address");
});

// -- Drop target (owner, 2026-09-08) ----------------------------------------

function dragEvent(type: string, files: File[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: { types: files.length > 0 ? ["Files"] : ["text/plain"], files, items: [] },
    configurable: true,
  });
  return ev;
}

test("a file dragged over the window shows the drop box, dropping it attaches, and a text drag shows nothing", async () => {
  const uploaded: string[] = [];
  const onUpload = async (_a: string, f: File) => {
    uploaded.push(f.name);
    return { account: "work", blobId: "B1", name: f.name, type: f.type, size: f.size };
  };
  const { container } = render(
    <Compose accounts={[{ key: "work", label: "Work", identities: [{ email: "me@work.test", primary: true }] }]} onSend={async () => {}} onUpload={onUpload} />,
  );
  assert.equal(container.querySelector('[data-testid="drop-target"]'), null, "no box before a drag");

  window.dispatchEvent(dragEvent("dragenter", []));
  await tick();
  assert.equal(container.querySelector('[data-testid="drop-target"]'), null, "a text drag is not a file drag");
  window.dispatchEvent(dragEvent("dragleave", []));

  const f = file("Plan.pdf", 40);
  window.dispatchEvent(dragEvent("dragenter", [f]));
  await tick();
  const box = container.querySelector('[data-testid="drop-target"]');
  assert.ok(box, "the drop box appears while a file is over the window");

  const drop = dragEvent("drop", [f]);
  box!.dispatchEvent(drop);
  await tick();
  assert.ok(drop.defaultPrevented, "the drop is taken (the browser must not navigate to the file)");
  assert.deepEqual(uploaded, ["Plan.pdf"]);
  assert.ok(byTestId("attachment-chip-Plan.pdf"), "the dropped file is a chip");
  assert.equal(container.querySelector('[data-testid="drop-target"]'), null, "the box goes once dropped");
});

test("leaving the window (a drag that ends elsewhere) hides the box", async () => {
  const { container } = render(
    <Compose accounts={[{ key: "work", label: "Work", identities: [{ email: "me@work.test", primary: true }] }]} onSend={async () => {}} onUpload={async () => ({ account: "work", blobId: "B", name: "x", type: "", size: 0 })} />,
  );
  const f = file("a.txt");
  // Entering a child fires enter again before leave: a counter, not a flag.
  window.dispatchEvent(dragEvent("dragenter", [f]));
  window.dispatchEvent(dragEvent("dragenter", [f]));
  window.dispatchEvent(dragEvent("dragleave", [f]));
  await tick();
  assert.ok(container.querySelector('[data-testid="drop-target"]'), "still over the window");
  window.dispatchEvent(dragEvent("dragleave", [f]));
  await tick();
  assert.equal(container.querySelector('[data-testid="drop-target"]'), null);
});

// -- ⌘⏎ sends (feature audit, 2026-09-10) -----------------------------------

function keyEnter(target: Element | Window, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(ev);
  return ev;
}

test("⌘⏎ and Ctrl+⏎ send, under the same conditions as the Send button; a bare Enter does not", async () => {
  let sends = 0;
  const { container } = render(
    <Compose accounts={[{ key: "work", label: "Work", identities: [{ email: "me@work.test", primary: true }] }]} onSend={async () => { sends += 1; }} />,
  );
  const body = container.querySelector('[data-testid="compose-body"]')!;
  keyEnter(body, { metaKey: true });
  await tick();
  assert.equal(sends, 0, "nobody to send to yet: the key does nothing, like the button");
  const to = container.querySelector('[data-testid="compose-to"]') as HTMLInputElement;
  to.value = "a@example.test"; to.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  keyEnter(body);
  await tick();
  assert.equal(sends, 0, "a bare Enter is a newline, not a send");
  const ev = keyEnter(body, { metaKey: true });
  await tick();
  assert.equal(sends, 1, "⌘⏎ sent");
  assert.ok(ev.defaultPrevented, "the Enter does not also land in the editor");
  keyEnter(body, { ctrlKey: true });
  await tick();
  assert.equal(sends, 2, "Ctrl+⏎ sends too");
});

// -- Row 60: the From select shows the header recipients will see, and the
// account it belongs to is shown as its accent dot (owner, 2026-09-19:
// "when replying from the work account, the from field shows Work
// <robin@lumber.example>. Is that what recipients see? from Work?").
// It was not: "Work" is Wilco's own sidebar name for the account, while the
// message goes out under the JMAP identity's name ("Robin Halden"). --

const WORK = {
  key: "work",
  label: "Work",
  accent: "#c2410c",
  identities: [
    { email: "robin@lumber.example", primary: true, name: "Robin Halden" },
    { email: "sales@lumber.example", primary: false, name: "Lumber Co Sales" },
  ],
};

test("🚨 the from select shows the identity's name and address -- the header that is sent, never the account's sidebar name", () => {
  render(<Compose accounts={[WORK]} />);
  const select = byTestId("from-select") as HTMLSelectElement;
  assert.equal(select.options[0]!.textContent, "Robin Halden <robin@lumber.example>");
  assert.equal(
    select.options[1]!.textContent,
    "Lumber Co Sales <sales@lumber.example> · alias",
    "an alias sends under its OWN name and is still marked as an alias",
  );
  assert.equal(select.textContent!.includes("Work <"), false, "the account's sidebar name is not a From header");
});

test("an identity with no name of its own shows the bare address, which is what is sent", () => {
  render(<Compose accounts={[{ key: "p", label: "Personal", accent: "#333", identities: [{ email: "k@x.test", primary: true }] }]} />);
  assert.equal((byTestId("from-select") as HTMLSelectElement).options[0]!.textContent, "k@x.test");
});

test("🚨 the account is shown as its accent dot, and the dot follows the selection", async () => {
  const PERSONAL = { key: "personal", label: "Personal", accent: "#2563eb", identities: [{ email: "k@x.test", primary: true, name: "Robin" }] };
  render(<Compose accounts={[WORK, PERSONAL]} />);
  const dot = byTestId("from-account-dot");
  assert.match(dot.getAttribute("style") ?? "", /#c2410c/i, "the dot does not carry the selected account's accent");
  assert.equal(dot.getAttribute("title"), "Work", "the dot does not name the account it stands for");
  const select = byTestId("from-select") as HTMLSelectElement;
  select.value = "personal|k@x.test";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  assert.match(byTestId("from-account-dot").getAttribute("style") ?? "", /#2563eb/i, "the dot did not follow the account switch");
  assert.equal(byTestId("from-account-dot").getAttribute("title"), "Personal");
});

test("a hostile identity name is text, not markup", () => {
  render(
    <Compose
      accounts={[{ key: "work", label: "Work", accent: "#c2410c", identities: [{ email: "k@x.test", primary: true, name: "<img src=x onerror=alert(1)>" }] }]}
    />,
  );
  const select = byTestId("from-select") as HTMLSelectElement;
  assert.equal(select.options[0]!.textContent, "<img src=x onerror=alert(1)> <k@x.test>");
  assert.equal(select.querySelector("img"), null);
});

// -- Row 61: a new message or a forward opens with the cursor in To (owner,
// 2026-09-21: "When a user chooses to forward or compose an email, the focus
// should immediately land on the to field instead of the body"). Neither has
// a recipient yet, so To is the first thing to type. A reply already has its
// recipient and keeps the cursor in the body. --

// Compared by test id, never as elements: a failing deep-equal on two DOM
// nodes makes node:assert walk happy-dom's whole object graph for its diff,
// and the worker hangs instead of reporting.
function focusedId(): string | null {
  return document.activeElement?.getAttribute("data-testid") ?? null;
}

const FOCUS_ACCOUNTS = [{ key: "work", label: "Work", identities: [{ email: "k@x.test", primary: true }] }];

test("🚨 a new message opens with the cursor in To", async () => {
  render(<Compose accounts={FOCUS_ACCOUNTS} mode="new" />);
  await tick();
  assert.equal(focusedId(), "compose-to", "the cursor is not in To");
});

test("🚨 a forward opens with the cursor in To", async () => {
  render(<Compose accounts={FOCUS_ACCOUNTS} mode="forward" replySubject="Invoice" />);
  await tick();
  assert.equal(focusedId(), "compose-to", "the cursor is not in To");
});

test("a reply keeps the cursor in the body: its recipient is already there", async () => {
  render(<Compose accounts={FOCUS_ACCOUNTS} mode="reply" replySubject="Invoice" initialTo="a@example.test" />);
  await tick();
  assert.equal(focusedId(), "compose-body", "a reply lost the body cursor");
});

test("a new message that already has a recipient opens in the body", async () => {
  render(<Compose accounts={FOCUS_ACCOUNTS} mode="new" initialTo="a@example.test" />);
  await tick();
  assert.equal(focusedId(), "compose-body");
});
