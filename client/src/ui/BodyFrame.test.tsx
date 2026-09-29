// @vitest-environment happy-dom
import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { byTestId, click, render, tick } from "../test-utils";
import { BodyFrame, useMessageBody, FRAME_MIN_PX, FRAME_MAX_PX } from "./BodyFrame";
import type { BodyUrlResult } from "../lib/api";

// `about:blank` because happy-dom tries to NAVIGATE a real frame src, and
// under vitest that reaches the network. What this file tests is the chrome
// AROUND the frame -- the banner, the opt-in, the attachment links. The
// frame's own attributes (src on the body origin, sandbox tokens,
// tabIndex) are pinned in App.test.tsx against a real mailbody URL, and
// again at the source level in escape.test.ts.
const base: BodyUrlResult = {
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
};

// 🚨 test-utils' `render` appends a NEW container per call and never
// removes the previous one. Harmless for every other component, but each
// mount here leaves a live frame element -- a browsing context happy-dom
// keeps open -- so eight of them hold the worker's event loop and the run
// HANGS rather than failing (47ms with this cleanup, 100s+ without).
// Unmount after every test.
//
// (The frame element is not named literally anywhere in this file: the
// raw-HTML guard in escape.test.ts greps for it, and a mention in a
// comment is indistinguishable from a use. Same reason escape.ts's own
// module comment dances around the API it bans.)
const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
  // replaceChildren, not an innerHTML assignment -- the guard bans the latter.
  document.body.replaceChildren();
});

/** The hook lives outside the component now (one attachment list, in the
 *  message card), so a test drives it through a small harness. */
function Harness({ load }: { load: (a: string, i: string, o: { images?: boolean; full?: boolean }) => Promise<BodyUrlResult> }) {
  const body = useMessageBody("personal", "M1", load);
  return <BodyFrame body={body} suffix="" fallback={<div data-testid="plain">plain</div>} />;
}

function mount(result: Partial<BodyUrlResult>, onCall?: (remote: boolean) => void) {
  const load = (_a: string, _i: string, opts: { images?: boolean; full?: boolean }) => {
    onCall?.(opts.images === true);
    return Promise.resolve({ ...base, ...result, remoteImages: opts.images === true });
  };
  mounted.push(render(<Harness load={load} />));
}

test("the blocked-image count comes from the MINT RESPONSE, not the frame", async () => {
  // A page cannot read the response headers of a cross-origin frame it
  // embeds, so X-Wilco-Blocked-Images reaches nobody. The API reports the
  // same number by running the same sanitizer over the same memoised body.
  mount({ blockedRemoteImages: 3 });
  await tick();
  // v1.1 #2's wording is fixed and countless: "◻ remote images blocked".
  // The count is what decides whether the strip appears at all.
  const strip = byTestId("images-strip");
  assert.match(strip.textContent!, /◻ remote images blocked/);
  assert.ok(strip.classList.contains("body-strip"), "a strip inside the card, not a floating row");
  assert.ok(strip.classList.contains("body-strip--top"), "it divides the header from the body");
  assert.ok(byTestId("load-images"), "Load images");
  assert.ok(byTestId("always-images"), "and Always from this sender");
});

test("🚨 a null count says NOTHING rather than claiming zero", async () => {
  // null means the server could not fetch the body to count. Rendering
  // "0 blocked" there would be a claim we cannot support.
  mount({ blockedRemoteImages: null });
  await tick();
  assert.equal(byTestId("images-strip", { optional: true }), null);
});

test("no banner when nothing was blocked", async () => {
  mount({ blockedRemoteImages: 0 });
  await tick();
  assert.equal(byTestId("images-strip", { optional: true }), null);
});

test("Load images re-mints WITH the opt-in, rather than editing the URL", async () => {
  // Spec 6.6: the flag rides in the signed token, so opting in means asking
  // for a different capability, not changing a query parameter.
  const calls: boolean[] = [];
  mount({ blockedRemoteImages: 2 }, (remote) => calls.push(remote));
  await tick();
  assert.deepEqual(calls, [false], "the first load blocks");

  click(byTestId("load-images"));
  await tick();
  assert.deepEqual(calls, [false, true], "the second asks for images");
  // v1.1 #2: the SAME strip becomes the loaded confirmation, with no
  // actions left on it.
  const loaded = byTestId("images-strip");
  assert.match(loaded.textContent!, /✓ remote images loaded · this message/);
  assert.equal(byTestId("load-images", { optional: true }), null, "nothing left to offer");
});

test("the truncation notice is shown when the server truncated the body", async () => {
  mount({ truncated: true, shownBytes: 64 * 1024, totalBytes: 412 * 1024 });
  await tick();
  // v1.1 #2: "✂ message truncated · showing 64 KB of 412 KB", below the
  // body, with a Load full message action.
  const strip = byTestId("truncation-strip");
  assert.match(strip.textContent!, /✂ message truncated · showing 64 KB of 412 KB/);
  assert.ok(strip.classList.contains("body-strip--bottom"));
  assert.ok(byTestId("load-full"));
});

test("the plaintext toggle still works, and the frame is not rendered then", async () => {
  mount({});
  await tick();
  assert.ok(byTestId("body-frame"));
  click(document.querySelector(".reading-html-toggle")!);
  await tick();
  assert.equal(byTestId("body-frame", { optional: true }), null);
  assert.ok(byTestId("plain"), "the plaintext fallback is what shows");
});

test("a failed mint falls back to plaintext rather than an empty pane", async () => {
  mounted.push(render(<Harness load={() => Promise.reject(new Error("nope"))} />));
  await tick();
  assert.ok(byTestId("body-frame-error"));
  assert.ok(byTestId("plain"));
});

test("🚨 v1.1 #2: 'Always from this sender' grants the allowance BEFORE re-minting", async () => {
  // The mint route reads the standing allowance, so re-minting first would
  // come back saying "this message" for a decision the reader made
  // "always".
  const order: string[] = [];
  const load = (_a: string, _i: string, opts: { images?: boolean }) => {
    order.push(`mint:${opts.images === true}`);
    return Promise.resolve({ ...base, remoteImages: opts.images === true, imagesAlways: opts.images === true, blockedRemoteImages: opts.images === true ? 0 : 2 });
  };
  const allow = async () => {
    order.push("allow");
  };
  // 🚨 `load` and `allow` are defined OUTSIDE the component on purpose:
  // `loadBodyUrl` is an effect dependency, so a fresh identity per render
  // re-fires the fetch forever. App.tsx useCallbacks it for the same
  // reason; a test that inlines it hangs the worker rather than failing.
  function H() {
    const body = useMessageBody("personal", "M1", load);
    return <BodyFrame body={body} suffix="" fallback={<div data-testid="plain">plain</div>} onAlwaysAllowImages={allow} />;
  }
  mounted.push(render(<H />));
  await tick();
  click(byTestId("always-images"));
  await tick();
  await tick();
  assert.deepEqual(order, ["mint:false", "allow", "mint:true"]);
});

test("v1.1 #2: the loaded strip says which allowance is in force", async () => {
  // Not `mount`: that helper derives remoteImages from the REQUEST, which
  // is what the opt-in path needs and the wrong thing here -- this case is
  // "the server already says images are on, because of a standing
  // allowance", before any request asked for them.
  const load = () =>
    Promise.resolve({ ...base, remoteImages: true, imagesAlways: true, sender: "news@example.test", blockedRemoteImages: 0 });
  function H() {
    const body = useMessageBody("personal", "M1", load);
    return <BodyFrame body={body} suffix="" fallback={<div data-testid="plain">plain</div>} />;
  }
  mounted.push(render(<H />));
  await tick();
  assert.match(byTestId("images-strip").textContent!, /✓ remote images loaded · always for news@example\.test/);
});

test("v1.1 #2: Load full message re-mints asking for the whole body", async () => {
  const asks: boolean[] = [];
  const load = (_a: string, _i: string, opts: { full?: boolean }) => {
    asks.push(opts.full === true);
    return Promise.resolve({
      ...base,
      truncated: opts.full !== true,
      full: opts.full === true,
      shownBytes: 64 * 1024,
      totalBytes: 412 * 1024,
    });
  };
  function H() {
    const body = useMessageBody("personal", "M1", load);
    return <BodyFrame body={body} suffix="" fallback={<div data-testid="plain">plain</div>} />;
  }
  mounted.push(render(<H />));
  await tick();
  click(byTestId("load-full"));
  await tick();
  await tick();
  assert.deepEqual(asks, [false, true]);
  // Once the whole body is loaded the strip has nothing left to say.
  assert.equal(byTestId("truncation-strip", { optional: true }), null);
});

test("🚨 THE FRAME TAKES THE HEIGHT ITS OWN WINDOW REPORTS, CLAMPED -- and ignores every other sender", async () => {
  // Row 3. A message from anywhere but this frame's contentWindow must be
  // ignored: an opaque-origin frame posts with origin "null", so identity is
  // by window, and a stray page must not be able to resize the message.
  const load = () => Promise.resolve(base);
  function H() {
    const body = useMessageBody("personal", "M1", load);
    return <BodyFrame body={body} suffix="" fallback={<div data-testid="plain">plain</div>} />;
  }
  mounted.push(render(<H />));
  await tick();
  const frame = byTestId("body-frame") as HTMLIFrameElement;
  const from = (source: Window | null, data: unknown) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: source as Window, origin: "null" }));

  from(window, { wilcoHeight: 1588 });  // not the frame
  await tick();
  assert.equal(frame.style.height, `${FRAME_MIN_PX}px`, "a message from a stranger resized the frame");

  from(frame.contentWindow, { wilcoHeight: 1588 });
  await tick();
  assert.equal(frame.style.height, "1588px", "the frame did not take its own reported height");

  from(frame.contentWindow, { wilcoHeight: 10_000_000 });
  await tick();
  assert.equal(frame.style.height, `${FRAME_MAX_PX}px`, "a mile-tall report was not clamped");

  from(frame.contentWindow, { wilcoHeight: "nope" });
  await tick();
  assert.equal(frame.style.height, `${FRAME_MAX_PX}px`, "a non-number changed the height");
});
