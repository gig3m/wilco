// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";
import { byTestId, click, fakeApi, render, spy, tick, type } from "../test-utils";
import { Settings } from "./Settings";
import { DEFAULT_PREFERENCES } from "../lib/api";

test("each account renders as a card with its code, address and badge", () => {
  render(
    <Settings
      accounts={[
        { key: "work", label: "Work", code: "HAL", accent: "#2a9d6e", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" },
      ]}
    />,
  );
  assert.equal(byTestId("acct-code-work").textContent, "HAL");
  assert.match(byTestId("acct-badge-work").textContent!, /JMAP/);
});

test("toggles are squared switches, not pills", () => {
  // Fix round 1: this used to read `switch-density`, which is a SegPicker
  // OPTION button (a real segmented picker, matching the design's own
  // "isSeg" row for Density -- see Settings.tsx's module comment), not
  // the actual Switch component. It passed only because both literals
  // happen to be 2px. Point it at a real toggle row instead so the name
  // matches what it tests.
  render(<Settings accounts={[]} />);
  const knob = byTestId("reply-all-default");
  const r = getComputedStyle(knob).borderRadius;
  assert.ok(parseFloat(r) <= 3, `switch radius ${r} -- the design is squared, never pill`);
});

test("theme, density and layout actually work; everything else is disabled", () => {
  const onTheme = spy<[next: "light" | "dark"]>();
  render(<Settings accounts={[]} onThemeChange={onTheme} />);
  click(byTestId("switch-theme"));
  assert.equal(onTheme.calls.length, 1);
  for (const id of ["mark-read-timing", "remote-images", "send-delay", "reply-all-default"]) {
    assert.equal(byTestId(id).hasAttribute("disabled"), true, `${id} should be disabled`);
  }
});

test("REMOVE ACCOUNT IS DISABLED EVEN THOUGH THE API EXISTS", () => {
  // Destructive, and there is no confirmation flow in this plan. An enabled
  // remove button next to four live mailboxes is how mail gets lost.
  render(
    <Settings
      accounts={[{ key: "work", label: "Work", code: "HAL", accent: "#2a9d6e", provider: "jmap", endpoint: "https://x.test/jmap" }]}
    />,
  );
  click(byTestId("acct-manage-work"));
  assert.equal(byTestId("remove-account-work").hasAttribute("disabled"), true);
  assert.ok(
    (byTestId("remove-account-work").getAttribute("title") ?? "").trim().length > 0,
    "remove-account is disabled with no reason",
  );
});

test("density and layout also call their own real handlers, with the specific value picked", () => {
  const onDensity = spy<[next: "comfortable" | "compact"]>();
  const onLayout = spy<[next: "columns" | "rows"]>();
  render(<Settings accounts={[]} onDensityChange={onDensity} onLayoutChange={onLayout} />);
  click(byTestId("switch-density"));
  click(byTestId("switch-layout"));
  assert.deepEqual(onDensity.calls, [["compact"]]);
  assert.deepEqual(onLayout.calls, [["rows"]]);
});

test("clicking the already-active option does not fire a spurious change", () => {
  // A segmented picker sets a SPECIFIC value; clicking "Light" while
  // already light must still call the handler with "light" (idempotent),
  // never silently flip to dark the way a bare toggle would.
  const onTheme = spy<[next: "light" | "dark"]>();
  render(<Settings accounts={[]} theme="light" onThemeChange={onTheme} />);
  click(byTestId("theme-light"));
  assert.deepEqual(onTheme.calls, [["light"]]);
});

test("Settings is reachable and shows the accounts + all five global sections", () => {
  render(<Settings accounts={[]} />);
  const settings = byTestId("settings-pane");
  assert.match(settings.textContent ?? "", /Settings/);
  assert.match(settings.textContent ?? "", /Appearance/i);
  assert.match(settings.textContent ?? "", /Reading/i);
  assert.match(settings.textContent ?? "", /Composing/i);
  assert.match(settings.textContent ?? "", /Notifications/i);
  assert.match(settings.textContent ?? "", /Behavior/i);
});

test("Manage opens a per-account page; Settings link goes back", () => {
  render(
    <Settings
      accounts={[{ key: "work", label: "Work", code: "HAL", accent: "#2a9d6e", provider: "jmap", endpoint: "https://x.test/jmap" }]}
    />,
  );
  click(byTestId("acct-manage-work"));
  assert.match(byTestId("settings-pane").textContent ?? "", /Identity/);
  assert.match(byTestId("settings-pane").textContent ?? "", /Send-as aliases/);
  assert.match(byTestId("settings-pane").textContent ?? "", /Danger/);
  click(byTestId("settings-account-back"));
  assert.match(byTestId("settings-accounts").textContent ?? "", /Work/);
});

test("no email is invented for an account -- AccountSpec has no email field", () => {
  render(
    <Settings
      accounts={[{ key: "work", label: "Work", code: "HAL", accent: "#2a9d6e", provider: "jmap", endpoint: "https://x.test/jmap" }]}
    />,
  );
  assert.equal(document.body.textContent?.includes("@"), false, "no @ anywhere -- nothing that looks like a guessed email address");
});

test("a hostile account label is text, not markup", () => {
  render(
    <Settings
      accounts={[
        { key: "work", label: "<img src=x onerror=alert(1)>", code: "HAL", accent: "#2a9d6e", provider: "jmap", endpoint: "https://x.test/jmap" },
      ]}
    />,
  );
  assert.equal(document.querySelectorAll("img").length, 0);
});

test("the signature textarea holds the identity's REAL signature and saves it", async () => {
  // The design's `— <account>` placeholder is gone: showing a signature the
  // recipient will never see is a claim about outgoing mail that is false.
  const saved: { id: string; text: string; html: string | undefined }[] = [];
  render(
    <Settings
      accounts={[
        {
          key: "work",
          label: "Work",
          accent: "#5b6ee0",
          provider: "fastmail",
          endpoint: "https://api.fastmail.com",
          identities: [
            { id: "I0", email: "alias@work.test", primary: false, textSignature: "wrong one", htmlSignature: "" },
            { id: "I1", email: "me@work.test", primary: true, textSignature: "-- \nRobin", htmlSignature: "<p>Robin</p>" },
          ],
        },
      ]}
      api={fakeApi()}
      onSaveSignature={async (_a, id, text, html) => {
        saved.push({ id, text, html });
      }}
      loadSignatureUrl={() => Promise.resolve({ url: "about:blank", hasHtml: true, height: 200 })}
    />,
  );
  await tick();
  click(byTestId("acct-manage-work"));
  await tick();

  // An identity that HAS an HTML signature opens in HTML mode -- the half
  // most recipients will see. Row 38 (owner ruling 2026-09-06): that half
  // is PREVIEWED here and edited in Fastmail; there is no source textarea
  // and nothing to save in this mode.
  assert.equal(byTestId("signature-text", { optional: true }), null, "no HTML source editor");
  assert.equal(byTestId("signature-save", { optional: true }), null, "nothing to save in HTML mode");
  const link = byTestId("signature-edit-in-fastmail") as HTMLAnchorElement;
  assert.match(link.getAttribute("href")!, /^https:\/\/app\.fastmail\.com\//);
  assert.equal(link.getAttribute("target"), "_blank");

  // 🚨 The PRIMARY identity's signature, chosen by the server's
  // mayDelete-derived flag -- not identities[0], which here is the alias
  // with the wrong signature.
  click(byTestId("signature-format-text"));
  await tick();
  assert.equal((byTestId("signature-text") as HTMLTextAreaElement).value, "-- \nRobin");

  const text = byTestId("signature-text") as HTMLTextAreaElement;
  text.value = "-- \nRobin Halden ";
  text.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  assert.match(byTestId("signature-status").textContent!, /unsaved/);

  click(byTestId("signature-save"));
  await tick();
  await tick();
  // Byte for byte: the trailing space stays. The HTML half is OMITTED, not
  // blanked -- the server leaves it alone (row 38 proves it survives).
  assert.deepEqual(saved, [{ id: "I1", text: "-- \nRobin Halden ", html: undefined }]);
  assert.match(byTestId("signature-status").textContent!, /^saved \d\d:\d\d$/);
});

test("the signature textarea stays disabled when there is no way to save it", async () => {
  render(
    <Settings
      accounts={[{ key: "work", label: "Work", accent: "#5b6ee0", provider: "fastmail", endpoint: "https://api.fastmail.com" }]}
      api={fakeApi()}
    />,
  );
  await tick();
  click(byTestId("acct-manage-work"));
  await tick();
  assert.equal((byTestId("signature-text") as HTMLTextAreaElement).disabled, true);
  assert.equal(byTestId("signature-save", { optional: true }), null);
});

test("an identity with no HTML signature opens in plain-text mode", async () => {
  render(
    <Settings
      accounts={[
        {
          key: "work", label: "Work", accent: "#5b6ee0", provider: "fastmail", endpoint: "https://api.fastmail.com",
          identities: [{ id: "I1", email: "me@work.test", primary: true, textSignature: "Robin", htmlSignature: "" }],
        },
      ]}
      api={fakeApi()}
      onSaveSignature={async () => {}}
    />,
  );
  await tick();
  click(byTestId("acct-manage-work"));
  await tick();
  assert.equal((byTestId("signature-text") as HTMLTextAreaElement).value, "Robin");
});

test("row 38: the HTML half is never edited here -- a plain-text save omits it", async () => {
  // The raw-source textarea showed the owner 19,588 characters of base64
  // in a 96px box. It is gone: HTML mode previews, and points at Fastmail.
  const saved: { text: string; html: string | undefined }[] = [];
  render(
    <Settings
      accounts={[
        {
          key: "work", label: "Work", accent: "#5b6ee0", provider: "fastmail", endpoint: "https://api.fastmail.com",
          identities: [{ id: "I1", email: "me@work.test", primary: true, textSignature: "Robin", htmlSignature: '<p>Robin</p><img src="data:image/png;base64,AAAA">' }],
        },
      ]}
      api={fakeApi()}
      onSaveSignature={async (_a, _id, text, html) => {
        saved.push({ text, html });
      }}
      loadSignatureUrl={() => Promise.resolve({ url: "about:blank", hasHtml: true, height: 240 })}
    />,
  );
  await tick();
  click(byTestId("acct-manage-work"));
  await tick();
  await tick();
  // HTML mode: the preview frame takes the server's height estimate, so
  // the whole signature shows -- not the design's 110px box.
  const frame = byTestId("settings-signature-preview") as HTMLIFrameElement;
  assert.equal(frame.tagName, "IFRAME");
  assert.equal(frame.style.height, "240px", "the server estimate sizes the first paint");
  assert.equal(byTestId("signature-text", { optional: true }), null);
  // ...and the frame's own resize report (the same message BodyFrame
  // takes) replaces the estimate -- from THIS frame only, clamped.
  const from = (source: Window | null, data: unknown) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: source as Window, origin: "null" }));
  from(window, { wilcoHeight: 333 });
  await tick();
  assert.equal(frame.style.height, "240px", "a message from a stranger resized the frame");
  from(frame.contentWindow, { wilcoHeight: 333 });
  await tick();
  assert.equal(frame.style.height, "333px", "the frame did not take its own reported height");
  from(frame.contentWindow, { wilcoHeight: 1_000_000 });
  await tick();
  assert.equal(frame.style.height, "800px", "a mile-tall report was not clamped");

  click(byTestId("signature-format-text"));
  await tick();
  const box = byTestId("signature-text") as HTMLTextAreaElement;
  box.value = "Robin A.";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  click(byTestId("signature-save"));
  await tick();
  assert.deepEqual(saved, [{ text: "Robin A.", html: undefined }]);
});

test("v1.1 #6: the preview is visible in BOTH formats, labelled with the type", async () => {
  // Scoped to this render's container: test-utils' `render` appends a new
  // container per call and never removes the last one.
  const { container } = render(
    <Settings
      accounts={[
        {
          key: "work", label: "Work", accent: "#5b6ee0", provider: "fastmail", endpoint: "https://api.fastmail.com",
          identities: [{ id: "I1", email: "me@work.test", primary: true, textSignature: "Robin\nCEO", htmlSignature: "<p>Robin</p>" }],
        },
      ]}
      api={fakeApi()}
      onSaveSignature={async () => {}}
      loadSignatureUrl={() => Promise.resolve({ url: "about:blank", hasHtml: true })}
    />,
  );
  await tick();
  click(byTestId("acct-manage-work"));
  await tick();
  await tick();

  // HTML mode: the inset frame, and no source editor (row 38).
  assert.match(container.querySelector(".settings-signature-preview-label")!.textContent!, /preview · text\/html/);
  assert.ok(byTestId("settings-signature-preview"));
  assert.equal(byTestId("signature-text", { optional: true }), null);

  // Plain-text mode: still a preview, frameless, and relabelled.
  click(byTestId("signature-format-text"));
  await tick();
  assert.match(container.querySelector(".settings-signature-preview-label")!.textContent!, /preview · text\/plain/);
  const plain = byTestId("settings-signature-preview");
  assert.equal(plain.tagName, "DIV", "frameless in plain-text mode");
  assert.match(plain.textContent!, /Robin/);
});

test("🚨 v1.1 #6: a format flip does NOT dirty the signature; a text edit does", async () => {
  render(
    <Settings
      accounts={[
        {
          key: "work", label: "Work", accent: "#5b6ee0", provider: "fastmail", endpoint: "https://api.fastmail.com",
          identities: [{ id: "I1", email: "me@work.test", primary: true, textSignature: "Robin", htmlSignature: "<p>Robin</p>" }],
        },
      ]}
      api={fakeApi()}
      onSaveSignature={async () => {}}
      loadSignatureUrl={() => Promise.resolve({ url: "about:blank", hasHtml: true })}
    />,
  );
  await tick();
  click(byTestId("acct-manage-work"));
  await tick();

  // Opens in HTML mode, where there is no Save (row 38). The flip to plain
  // text is not an edit: the status stays clean and the button is a ghost.
  click(byTestId("signature-format-text"));
  await tick();
  assert.doesNotMatch(byTestId("signature-status").textContent!, /unsaved/, "a format flip is not an edit");
  assert.ok(!byTestId("signature-save").classList.contains("settings-signature-save--dirty"), "clean: ghost button");

  const box = byTestId("signature-text") as HTMLTextAreaElement;
  box.value = "Robin Halden";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  assert.match(byTestId("signature-status").textContent!, /unsaved changes/);
  assert.ok(byTestId("signature-save").classList.contains("settings-signature-save--dirty"), "dirty: accent fill");
});

test("🚨 send-as aliases render as chips, with the primary marked (pass 3 D2)", async () => {
  // The comment here used to say aliases had "no backing data at all". They
  // did: `identities` carries every send-as address, and this same file
  // reads it a hundred lines away to resolve the primary for signatures.
  // The false comment is what stopped anyone looking.
  render(
    <Settings
      accounts={[
        {
          key: "work",
          label: "Work",
          accent: "#2a9d6e",
          provider: "jmap",
          endpoint: "https://api.example/jmap",
          code: "WOR",
          identities: [
            { id: "i1", email: "robin@work.example", primary: true, textSignature: "", htmlSignature: "" },
            { id: "i2", email: "sales@work.example", primary: false, textSignature: "", htmlSignature: "" },
          ],
        },
      ]}
      api={fakeApi()}
    />,
  );
  await tick();
  click(byTestId("acct-manage-work"));
  await tick();

  assert.ok(byTestId("alias-chips", { optional: true }) !== null, "no alias chips rendered");
  const primary = byTestId("alias-chip-robin@work.example");
  const other = byTestId("alias-chip-sales@work.example");
  assert.equal(primary.textContent, "robin@work.example");
  assert.equal(other.textContent, "sales@work.example");
  // Which one is primary has to be visible, not just true in the data --
  // it is the address replies go out from.
  assert.ok(
    primary.className.includes("primary") && !other.className.includes("primary"),
    "the primary identity is not distinguished from the other aliases",
  );

  // Add/remove genuinely has no backend and must stay honest about it.
  // (row 37 removed the alias-add control: aliases are Fastmail identities Wilco cannot create)
});

test("🚨 THE ACCOUNT ORDER IS THE OWNER'S: up/down hand back the whole new order, ends are disabled, no handler means disabled with a reason", () => {
  // Rows 34 and 15. Accounts were alphabetical, so compose defaulted to
  // `atelier` and every reply went out from it.
  const spec = (key: string) => ({ key, label: key, code: key.slice(0, 3).toUpperCase(), accent: "#2a9d6e", provider: "jmap", endpoint: "https://api.fastmail.com/jmap/session" });
  const orders: string[][] = [];
  render(<Settings accounts={[spec("atelier"), spec("personal"), spec("work")]} onReorder={(o) => orders.push(o)} />);
  assert.ok((byTestId("acct-up-atelier") as HTMLButtonElement).disabled, "the first account cannot move up");
  assert.ok((byTestId("acct-down-work") as HTMLButtonElement).disabled, "the last account cannot move down");
  click(byTestId("acct-down-atelier"));
  assert.deepEqual(orders, [["personal", "atelier", "work"]], "moving down swaps with the next and reports the WHOLE order");
  click(byTestId("acct-up-work"));
  assert.deepEqual(orders[1], ["atelier", "work", "personal"], "moving up swaps with the previous (from the rendered order)");

  render(<Settings accounts={[spec("a"), spec("b")]} />);
  const btn = byTestId("acct-down-a") as HTMLButtonElement;
  assert.ok(btn.disabled && /handler/.test(btn.title), "without a handler the control is disabled and says why");
});

test("row 37: the three wired preference rows call the handler with the value picked; without it they render disabled", () => {
  const calls: [string, string][] = [];
  render(
    <Settings
      accounts={[]}
      api={fakeApi()}
      preferences={{ ...DEFAULT_PREFERENCES }}
      onPreferenceChange={(k, v) => void calls.push([k, v as string])}
    />,
  );
  click(byTestId("mark-read-manual"));
  click(byTestId("remote-images-always"));
  click(byTestId("group-conversations"));
  assert.deepEqual(calls, [["markRead", "manual"], ["remoteImages", "always"], ["groupConversations", "off"]]);
  assert.equal(byTestId("mark-read-manual").hasAttribute("disabled"), false);

  render(<Settings accounts={[]} api={fakeApi()} />);
  assert.ok(byTestId("mark-read-timing"), "no handler: the disabled placeholder still explains itself");
});

test("row 37: the four behaviour switches call the handler with the flipped value", () => {
  const calls: [string, string][] = [];
  render(
    <Settings
      accounts={[]}
      api={fakeApi()}
      preferences={{ ...DEFAULT_PREFERENCES }}
      onPreferenceChange={(k, v) => void calls.push([k, v as string])}
    />,
  );
  click(byTestId("quote-history-replies"));
  click(byTestId("reply-all-default"));
  click(byTestId("archive-on-reply"));
  click(byTestId("unified-inbox-launch"));
  assert.deepEqual(calls, [["quoteHistory", "off"], ["replyAllDefault", "on"], ["archiveOnReply", "on"], ["unifiedInboxAtLaunch", "off"]]);
});

test("row 37: the notification switches call the handler; the signature switches save per-account settings", async () => {
  const prefCalls: [string, string][] = [];
  const saved: [string, string, string][] = [];
  render(
    <Settings
      accounts={[{ key: "personal", label: "Personal", accent: "#5b6ee0", provider: "jmap", endpoint: "", code: "PER", identities: [{ id: "i1", name: null, email: "k@x.test", primary: true, textSignature: "", htmlSignature: "" }] } as never]}
      api={fakeApi({
        accountSettings: () => Promise.resolve({ settings: { signatureReplies: "off" }, mailboxes: [] }),
        setAccountSetting: (a: string, k: string, v: string) => {
          saved.push([a, k, v]);
          return Promise.resolve({ settings: { [k]: v }, mailboxes: [] });
        },
      })}
      preferences={{ ...DEFAULT_PREFERENCES }}
      onPreferenceChange={(k, v) => void prefCalls.push([k, v as string])}
    />,
  );
  click(byTestId("notif-desktop"));
  click(byTestId("notif-people-only"));
  click(byTestId("notif-sound"));
  assert.deepEqual(prefCalls, [["notifDesktop", "off"], ["notifPeopleOnly", "on"], ["notifSound", "on"]]);

  click(byTestId("acct-manage-personal"));
  await tick();
  await tick();
  assert.equal(byTestId("signature-append-new").getAttribute("aria-pressed"), "true", "absent means on");
  assert.equal(byTestId("signature-include-replies").getAttribute("aria-pressed"), "false", "stored off is off");
  click(byTestId("signature-append-new"));
  await tick();
  // Exactly one save. happy-dom's select fires `change` from its own value
  // setter, so without the handler's same-value guard an unprompted
  // ["personal", "spamMailboxId", ""] used to land here first.
  assert.deepEqual(saved, [["personal", "signatureNew", "off"]]);
});

test("row 37: the account page's name, colour, token, resync and remove controls are live, and alias-add is gone", async () => {
  const calls: string[] = [];
  let changed = 0;
  const api = fakeApi({
    updateAccount: (key: string, patch: { label?: string; accent?: string }) => { calls.push(`update ${key} ${JSON.stringify(patch)}`); return Promise.resolve({ key, label: patch.label ?? "Personal", accent: patch.accent ?? "#5b6ee0", provider: "jmap", endpoint: "", code: "PER" } as never); },
    resyncAccount: (key: string) => { calls.push(`resync ${key}`); return Promise.resolve({ requested: true, note: "runs on the next sync pass" }); },
    setCredential: (key: string, cred: string) => { calls.push(`credential ${key} ${cred.length}`); return Promise.resolve({ ok: true }); },
    removeAccount: (key: string) => { calls.push(`remove ${key}`); return Promise.resolve({ ok: true }); },
  });
  render(
    <Settings
      accounts={[{ key: "personal", label: "Personal", accent: "#5b6ee0", provider: "jmap", endpoint: "", code: "PER", identities: [] } as never]}
      api={api}
      onAccountsChanged={() => void (changed += 1)}
    />,
  );
  click(byTestId("acct-manage-personal"));
  await tick();
  assert.equal(byTestId("settings-alias-add", { optional: true }), null, "no fake alias control");
  assert.equal(byTestId("settings-alias-input", { optional: true }), null);

  const name = byTestId("settings-display-name") as HTMLInputElement;
  assert.equal(name.disabled, false);
  type(name, "Robin's mail");
  name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await tick();
  click(byTestId("swatch-2a9d6e"));
  await tick();
  type(byTestId("settings-token"), "fmu1-secret-token");
  click(byTestId("settings-token-save"));
  await tick();
  click(byTestId("resync-now"));
  await tick();
  assert.match(byTestId("resync-status").textContent ?? "", /Requested/);

  const realConfirm = window.confirm;
  window.confirm = () => false;
  click(byTestId("remove-account-personal"));
  await tick();
  window.confirm = () => true;
  click(byTestId("remove-account-personal"));
  await tick();
  window.confirm = realConfirm;

  assert.deepEqual(calls, [
    'update personal {"label":"Robin\'s mail"}',
    'update personal {"accent":"#2a9d6e"}',
    "credential personal 17",
    "resync personal",
    "remove personal",
  ]);
  assert.ok(changed >= 3, `the caller was told to refetch accounts after edits and the removal (${changed})`);
});
