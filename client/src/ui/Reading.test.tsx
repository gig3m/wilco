// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";
import { byTestId, click, render, tick } from "../test-utils";
import { Reading, type ReadingAttachment } from "./Reading";

test("the body renders as text and never as markup", () => {
  render(<Reading message={{ bodyText: "<b>not bold</b><script>alert(1)</script>", subject: "s" }} />);
  assert.equal(document.querySelectorAll("b,script").length, 0);
  assert.ok(byTestId("body").textContent!.includes("<b>not bold</b>"));
});

test("AN HTML MESSAGE SAYS SO RATHER THAN LOOKING BROKEN", () => {
  render(<Reading message={{ bodyText: "plain fallback", hasHtml: true, subject: "s" }} />);
  assert.match(byTestId("html-notice").textContent!, /\S/);
});

test("hasHtml null is not reported as 'no HTML'", () => {
  render(<Reading message={{ bodyText: "x", hasHtml: null, subject: "s" }} />);
  assert.equal(byTestId("html-notice", { optional: true }), null);
});

test("attachment chips show metadata and offer no download yet", () => {
  render(<Reading message={{ bodyText: "", subject: "s", attachments: [{ name: "budget.pdf", type: "application/pdf", size: 1024 }] }} />);
  assert.match(byTestId("attachment-0").textContent!, /budget\.pdf/);
  assert.equal(byTestId("attachment-0").querySelector("a"), null, "serving arrives with the body pipeline");
});

test("A LINK IN A PLAINTEXT BODY CANNOT BE A javascript: URL", () => {
  render(<Reading message={{ bodyText: "click javascript:alert(1) or https://example.test/x", subject: "s" }} />);
  const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  assert.ok(!hrefs.some((h) => (h ?? "").toLowerCase().startsWith("javascript:")));
  assert.ok(hrefs.includes("https://example.test/x"));
});

test("every external link is rel=noopener noreferrer and target=_blank", () => {
  render(<Reading message={{ bodyText: "https://example.test/x", subject: "s" }} />);
  const a = document.querySelector("a")!;
  assert.equal(a.getAttribute("target"), "_blank");
  assert.match(a.getAttribute("rel")!, /noopener/);
  assert.match(a.getAttribute("rel")!, /noreferrer/);
});

test("hasHtml null renders no notice even without any other override", () => {
  render(<Reading message={{ bodyText: "x", subject: "s" }} />);
  assert.equal(byTestId("html-notice", { optional: true }), null);
});

test("null message renders the empty state", () => {
  render(<Reading message={null} />);
  assert.ok(byTestId("reading-empty"));
});

test("earlier messages are collapsed to one line and expand on click", () => {
  render(
    <Reading
      thread={{
        messages: [
          { account: "work", id: "M1", fromName: "You", preview: "Poll closed", receivedAt: "2026-09-02T10:00:00Z" },
          { account: "work", id: "M2", fromName: "Dana Okafor", preview: "On it", receivedAt: "2026-09-03T18:02:00Z" },
        ],
      }}
      message={{ account: "work", id: "M3", subject: "Re: Lisbon", bodyText: "body" }}
    />,
  );
  assert.ok(byTestId("collapsed-work-M1"));
  assert.equal(byTestId("expanded-work-M1", { optional: true }), null);
  click(byTestId("collapsed-work-M1"));
  assert.ok(byTestId("expanded-work-M1"));
});

test("the open message shows a text/plain chip and a mono address", () => {
  render(
    <Reading
      message={{ account: "work", id: "M1", subject: "s", bodyText: "b", fromName: "Dana Okafor", fromEmail: "dana@halden.example" }}
    />,
  );
  assert.match(byTestId("body-type-chip").textContent!, /text\/plain/);
  assert.ok(getComputedStyle(byTestId("from-address")).fontFamily.includes("Plex Mono"));
});

test("quoted history is collapsed behind a toggle", () => {
  render(<Reading message={{ account: "work", id: "M1", subject: "s", bodyText: "reply\n\nOn Tue, someone wrote:\n> quoted line" }} />);
  assert.ok(!byTestId("body").textContent!.includes("> quoted line"));
  click(byTestId("quote-toggle"));
  assert.ok(byTestId("body").textContent!.includes("> quoted line"));
});

test("unwired actions are rendered, disabled and explained", () => {
  render(<Reading message={{ account: "work", id: "M1", subject: "s", bodyText: "b" }} />);
  for (const id of ["act-archive", "act-spam", "act-delete", "act-forward", "act-reply", "act-flag"]) {
    assert.equal(byTestId(id).hasAttribute("disabled"), true, `${id} should be disabled`);
    // 🚨 Asserts a reason EXISTS, not its wording. This used to match
    // /plan|not yet/i, which pinned the phrasing rather than the
    // truth -- and so kept a false claim in place: COMPOSE_REASON
    // still said "there is no send path in this codebase yet" months
    // after send shipped, and the test enforced that it kept saying
    // something of that shape (audit pass 7 F1).
    assert.ok((byTestId(id).getAttribute("title") ?? "").trim().length > 0, `${id} is disabled with no reason`);
  }
});

test("hasHtml null shows no notice; true shows one", () => {
  render(<Reading message={{ account: "w", id: "1", subject: "s", bodyText: "b", hasHtml: null }} />);
  assert.equal(byTestId("html-notice", { optional: true }), null);
});

// --- Ruling P1: structure, not geometry (happy-dom has no layout engine) ---

test("the header's action row is a block-level sibling after the subject/meta block", () => {
  render(<Reading message={{ account: "work", id: "M1", subject: "s", bodyText: "b" }} />);
  const header = byTestId("reading-subject").closest("header")!;
  const actions = byTestId("reading-actions");
  assert.equal(actions.parentElement, header);
  const children = [...header.children];
  assert.ok(children.indexOf(actions) > 0, "actions come after the subject/meta block");
});

test("the collapsed row and the open card render in thread order, oldest first", () => {
  render(
    <Reading
      thread={{ messages: [{ account: "work", id: "M1", fromName: "You", preview: "p1", receivedAt: "2026-09-02T10:00:00Z" }] }}
      message={{ account: "work", id: "M2", subject: "s", bodyText: "b", fromName: "Dana Okafor" }}
    />,
  );
  const conversation = byTestId("reading-conversation");
  const collapsed = byTestId("collapsed-work-M1");
  const bodyEl = byTestId("body");
  const collapsedIndex = [...conversation.querySelectorAll("*")].indexOf(collapsed);
  const bodyIndex = [...conversation.querySelectorAll("*")].indexOf(bodyEl);
  assert.ok(collapsedIndex < bodyIndex, "the earlier message precedes the open message's body");
});

test("the action bar has no previous/next buttons (j/k do that) and the same buttons on every message", () => {
  // Owner, 2026-09-09: buttons that come and go per message move every
  // other button, and chained actions turn into chasing.
  const { container } = render(<Reading message={{ account: "work", id: "M1", subject: "s", bodyText: "b" }} onPrev={() => {}} onNext={() => {}} />);
  assert.equal(byTestId("act-prev", { optional: true }), null);
  assert.equal(byTestId("act-next", { optional: true }), null);
  const bar = container.querySelector('[data-testid="reading-actions"]')!;
  const labels = [...bar.querySelectorAll("button")].map((b) => b.getAttribute("data-testid"));
  // No onPrint handler in this render, so no Print button: the bar shows only wired actions.
  assert.deepEqual(labels, ["act-flag", "act-archive", "act-spam", "act-delete", "act-forward", "act-reply"]);
});

test("row 37: the reply footer replies when wired", () => {
  let replied = 0;
  render(<Reading message={{ account: "work", id: "M1", subject: "s", bodyText: "b", fromName: "Dana" }} onFooterReply={() => void (replied += 1)} />);
  const btn = byTestId("reply-footer") as HTMLButtonElement;
  assert.equal(btn.disabled, false);
  click(btn);
  assert.equal(replied, 1);
});

test("a reply-to-name footer button is rendered, disabled, and explained", () => {
  render(<Reading message={{ account: "work", id: "M1", subject: "s", bodyText: "b", fromName: "Dana Okafor" }} />);
  const btn = byTestId("reply-footer");
  assert.match(btn.textContent!, /Reply to Dana Okafor/);
  assert.equal(btn.hasAttribute("disabled"), true);
  assert.ok((btn.getAttribute("title") ?? "").trim().length > 0, "the button is disabled with no reason");
});

// Task: adopt Lucide icons, round-1 finding -- the flag button hardcoded a
// filled star regardless of the open message's real flagged state. It
// stays `disabled` (no triage backend), but the STAR ITSELF must now track
// real `isFlagged` data: outline when unset/false, filled when true.
test("the flag button shows an outline star when unflagged, filled when flagged", () => {
  render(<Reading message={{ account: "work", id: "M1", subject: "s", bodyText: "b" }} />);
  assert.ok(byTestId("act-flag-outline"), "unflagged (isFlagged omitted) should show the outline star");
  assert.equal(byTestId("act-flag-filled", { optional: true }), null);
});

test("the flag button shows a filled star when the message is flagged", () => {
  render(<Reading message={{ account: "work", id: "M1", subject: "s", bodyText: "b", isFlagged: true }} />);
  assert.ok(byTestId("act-flag-filled"), "flagged message should show the filled star");
  assert.equal(byTestId("act-flag-outline", { optional: true }), null);
});

test("the body-type chip says text/html when the frame is what is on screen", async () => {
  // It was hardcoded `text/plain` when that was all this pane could
  // render. Left alone, the card asserts plaintext over a fully formatted
  // HTML message -- which is what the first deployed screenshot showed,
  // and what no test would have caught.
  render(
    <Reading
      message={{ bodyText: "plain fallback", subject: "s", account: "personal", id: "M1", hasHtml: true }}
      loadBodyUrl={() =>
        Promise.resolve({
          url: "https://mailbody.example.com/m/tok",
          expiresInMs: 600_000,
          remoteImages: false,
          imagesAlways: false,
          sender: "someone@example.test",
          blockedRemoteImages: 0,
          truncated: false,
          shownBytes: 0,
          totalBytes: 0,
          full: false,
          attachments: [],
        })
      }
    />,
  );
  await tick();
  assert.match(byTestId("body-type-chip").textContent!, /text\/html/);

  render(<Reading message={{ bodyText: "plain fallback", subject: "s", hasHtml: false }} />);
  await tick();
  assert.match(byTestId("body-type-chip").textContent!, /text\/plain/, "and plaintext when it is plaintext");
});

test("an attachment chip becomes a DOWNLOAD LINK to the body origin once minted", async () => {
  // Spec 6.7: never a link to this origin. An .html or .svg attachment
  // served from the origin holding the session cookie is stored XSS,
  // delivered by anyone who can email you. There is also exactly ONE
  // attachment list -- an earlier version rendered chips both here and in
  // the frame, and the duplicate row showed up in a screenshot.
  // Scoped to THIS render's container: test-utils' `render` appends a new
  // container per call and never removes the last one, so a bare
  // document.querySelectorAll here also sees the chips an earlier test in
  // this file rendered.
  const { container } = render(
    <Reading
      message={{
        bodyText: "plain",
        subject: "s",
        account: "personal",
        id: "M1",
        hasHtml: true,
        attachments: [{ name: "Invoice.pdf", type: "application/pdf", size: 2048 }],
      }}
      loadBodyUrl={() =>
        Promise.resolve({
          url: "https://mailbody.example.com/m/tok",
          expiresInMs: 600_000,
          remoteImages: false,
          imagesAlways: false,
          sender: "someone@example.test",
          blockedRemoteImages: 0,
          truncated: false,
          shownBytes: 0,
          totalBytes: 0,
          full: false,
          attachments: [
            { blobId: "B2", name: "Invoice.pdf", type: "application/pdf", size: 2048, url: "https://mailbody.example.com/a/tok/B2" },
          ],
        })
      }
    />,
  );
  await tick();

  const chips = container.querySelectorAll('[data-testid^="attachment-"]');
  assert.equal(chips.length, 1, "one list, not two");
  const chip = chips[0] as HTMLAnchorElement;
  assert.equal(chip.tagName, "A");
  assert.equal(chip.getAttribute("href"), "https://mailbody.example.com/a/tok/B2");
  assert.match(chip.getAttribute("rel")!, /noreferrer/);
});

test("a plaintext message's attachments are downloadable too, not just an HTML one's", async () => {
  // Gating the mint on hasHtml left a plaintext message's attachments inert
  // while an HTML message's were clickable, for no reason a reader sees.
  render(
    <Reading
      message={{
        bodyText: "plain",
        subject: "s",
        account: "personal",
        id: "M1",
        hasHtml: false,
        attachments: [{ name: "notes.txt", type: "text/plain", size: 12 }],
      }}
      loadBodyUrl={() =>
        Promise.resolve({
          url: "https://mailbody.example.com/m/tok",
          expiresInMs: 600_000,
          remoteImages: false,
          imagesAlways: false,
          sender: "someone@example.test",
          blockedRemoteImages: null,
          truncated: false,
          shownBytes: 0,
          totalBytes: 0,
          full: false,
          attachments: [
            { blobId: "B9", name: "notes.txt", type: "text/plain", size: 12, url: "https://mailbody.example.com/a/tok/B9" },
          ],
        })
      }
    />,
  );
  await tick();
  assert.equal(byTestId("body-frame", { optional: true }), null, "no frame: there is no HTML");
  assert.equal(byTestId("attachment-0").getAttribute("href"), "https://mailbody.example.com/a/tok/B9");
});

test("the conversation column takes focus so scroll keys act on the MESSAGE, not the list", async () => {
  // Measured on the deployed build before this: with focus on <body>,
  // Space/PageDown scrolled the message list 106px, because the browser
  // walks from the focused element to the nearest scrollable ancestor and
  // that was the list pane. This is unrelated to spec 6.10's rule that the
  // FRAME never takes focus -- a chrome container is not the frame.
  render(<Reading message={{ bodyText: "x", subject: "s", account: "personal", id: "M1" }} />);
  await tick();
  assert.equal(document.activeElement, byTestId("reading-conversation"));
  assert.equal(byTestId("reading-conversation").getAttribute("tabindex"), "-1");
});

test("the body frame itself is still never focused", async () => {
  render(
    <Reading
      message={{ bodyText: "x", subject: "s", account: "personal", id: "M1", hasHtml: true }}
      loadBodyUrl={() =>
        Promise.resolve({
          url: "about:blank",
          expiresInMs: 600_000,
          remoteImages: false,
          imagesAlways: false,
          sender: "someone@example.test",
          blockedRemoteImages: 0,
          truncated: false,
          shownBytes: 0,
          totalBytes: 0,
          full: false,
          attachments: [],
        })
      }
    />,
  );
  await tick();
  assert.notEqual(document.activeElement, byTestId("body-frame"));
  assert.equal(byTestId("body-frame").getAttribute("tabindex"), "-1");
});

test("row 31: the Unsubscribe control renders only when the message offers a method", () => {
  render(<Reading message={{ bodyText: "b", subject: "s" }} unsubscribe={null} onUnsubscribe={() => {}} />);
  assert.equal(byTestId("unsubscribe", { optional: true }), null, "nothing offered, no control");
  render(<Reading message={{ bodyText: "b", subject: "s" }} unsubscribe="post" onUnsubscribe={() => {}} />);
  const btn = byTestId("unsubscribe");
  assert.equal(btn.closest('[data-testid="reading-actions"]'), null, "the offer is a strip on the card, never a button in the bar");
  assert.ok(btn.closest('[data-testid="unsubscribe-strip"]'), "the strip carries it");
  assert.match(btn.textContent ?? "", /unsub/i);
});

test("row 5: opened by its MIDDLE message, the conversation still reads oldest first, with the open card in place", () => {
  render(
    <Reading
      message={{ account: "a", id: "m2", subject: "s", bodyText: "second", receivedAt: "2026-09-01T10:02:00Z", fromName: "B" }}
      thread={{
        messages: [
          { account: "a", id: "m1", subject: "s", bodyText: "first", preview: "first", receivedAt: "2026-09-01T10:01:00Z", fromName: "A" },
          { account: "a", id: "m3", subject: "s", bodyText: "third", preview: "third", receivedAt: "2026-09-01T10:03:00Z", fromName: "C" },
        ],
      }}
    />,
  );
  const inner = document.querySelector(".reading-conversation-inner")!;
  const texts = Array.from(inner.children).map((el) => (el.textContent ?? "").trim());
  assert.ok(texts[0]!.includes("first") && texts[1]!.includes("second") && texts[2]!.includes("third"), `order is ${JSON.stringify(texts.map((t) => t.slice(0, 20)))}`);
  assert.ok(byTestId("collapsed-a-m1") && byTestId("collapsed-a-m3"), "the others are collapsed");
  assert.ok(byTestId("body").textContent!.includes("second"), "the open card is the expanded one");
});

test("a DRAFT never mints a body URL: it is opened for editing, not read", async () => {
  // Found by the harness once it stopped sleeping (2026-09-08): opening a
  // just-saved draft mounted the reading pane for a moment before the
  // $draft effect opened compose, and that moment minted a body URL for a
  // message the next autosave was about to replace -- a 404 in the console
  // and a wasted capability token, on every draft resume.
  let mints = 0;
  render(
    <Reading
      message={{ bodyText: "unfinished", subject: "s", account: "personal", id: "D1", hasHtml: true, keywords: { $draft: true } }}
      loadBodyUrl={() => {
        mints += 1;
        return Promise.reject(new Error("must not be called"));
      }}
    />,
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mints, 0, "a draft minted a body URL");
  assert.equal(document.querySelectorAll("iframe").length, 0, "a draft was framed");
});

test("a raster-image attachment opens the viewer with its inline URL; a PDF stays a download link", async () => {
  // 2026-09-08: "I have an email with a jpg attachment, I seem to have no
  // way of opening it." The chip was a download link that saved the file
  // somewhere and showed nothing.
  const opened: ReadingAttachment[] = [];
  render(
    <Reading
      message={{ bodyText: "", subject: "s", account: "personal", id: "M1", attachments: [
        { name: "photo.jpg", type: "image/jpeg", size: 3000 },
        { name: "notes.pdf", type: "application/pdf", size: 12 },
      ] }}
      onAttachmentClick={(a) => void opened.push(a)}
      loadBodyUrl={() =>
        Promise.resolve({
          url: "https://mailbody.example.com/m/tok", expiresInMs: 600_000, remoteImages: false, imagesAlways: false,
          sender: "x@example.test", blockedRemoteImages: null, truncated: false, shownBytes: 0, totalBytes: 0, full: false,
          attachments: [
            { blobId: "B1", name: "photo.jpg", type: "image/jpeg", size: 3000, url: "https://mailbody.example.com/a/tok/B1", viewUrl: "https://mailbody.example.com/a/tok/B1?view=1" },
            { blobId: "B2", name: "notes.pdf", type: "application/pdf", size: 12, url: "https://mailbody.example.com/a/tok/B2" },
          ],
        })
      }
    />,
  );
  await tick();
  const photo = byTestId("attachment-0");
  assert.equal(photo.tagName, "BUTTON", "an image chip is a button that opens the viewer");
  click(photo);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.viewUrl, "https://mailbody.example.com/a/tok/B1?view=1");
  assert.equal(opened[0]!.href, "https://mailbody.example.com/a/tok/B1", "the viewer's Download needs the download URL");
  const pdf = byTestId("attachment-1");
  assert.equal(pdf.tagName, "A");
  assert.equal(pdf.getAttribute("href"), "https://mailbody.example.com/a/tok/B2");
});

test("a sender with no display name is shown by address, not as a blank (2026-09-12)", () => {
  render(<Reading message={{ subject: "s", bodyText: "b", fromName: "", fromEmail: "billing@example.test" }} />);
  const card = document.querySelector(".reading-card-name")!;
  assert.equal(card.textContent, "billing@example.test");
});
