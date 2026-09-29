// @vitest-environment happy-dom
import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import { byTestId, fakeApi, render, tick } from "../test-utils";
import { PrintView } from "./PrintView";

// Row 33: a print document -- the message alone, no app chrome around it.

let printed = 0;
const realPrint = (window as unknown as { print?: () => void }).print;
afterEach(() => {
  (window as unknown as { print?: () => void }).print = realPrint;
  printed = 0;
});

test("the print view shows subject, sender, recipients, date and the body -- and nothing of the app", async () => {
  (window as unknown as { print: () => void }).print = () => void (printed += 1);
  const api = fakeApi({
    message: () =>
      Promise.resolve({
        account: "personal",
        id: "M1",
        threadId: null,
        receivedAt: "2026-09-01T14:05:00.000Z",
        subject: "Lunch plan",
        fromName: "Dana Ruiz",
        fromEmail: "dana@example.com",
        to: [{ email: "robin@example.com", name: "Robin" }],
        cc: [],
        bcc: [],
        replyTo: [],
        via: null,
        isUnread: false,
        isFlagged: false,
        hasAttachment: false,
        mailboxIds: [],
        bodyText: "Line one\nLine two <b>not markup</b>\n\nSee https://example.com/x",
        preview: "",
        hasHtml: false,
        keywords: {},
        attachments: [],
        inlineParts: [],
      }),
  });
  render(<PrintView api={api} account="personal" id="M1" />);
  await tick();
  await tick();
  const doc = byTestId("print-view");
  const txt = doc.textContent ?? "";
  assert.match(txt, /Lunch plan/);
  assert.match(txt, /Dana Ruiz/);
  assert.match(txt, /dana@example\.com/);
  assert.match(txt, /robin@example\.com/);
  assert.match(txt, /Line one/);
  assert.ok(txt.includes("<b>not markup</b>"), "plaintext is text, never markup");
  assert.equal(doc.querySelector("b"), null);
  assert.equal(byTestId("sidebar", { optional: true }), null, "no sidebar");
  assert.equal(byTestId("message-list", { optional: true }), null, "no list");
  assert.equal(byTestId("list", { optional: true }), null, "no list pane");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(printed, 1, "the print dialog is asked for once the document is on screen");
});
