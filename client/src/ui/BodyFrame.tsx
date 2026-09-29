// The message body frame (spec 6, milestone 4).
//
// This is the ONE place message HTML is rendered, and it is rendered by
// putting a URL in an iframe `src` -- never by handing markup to this
// document. The SPA never receives the HTML at all: it asks the API for a
// short-lived capability URL on the BODY ORIGIN and points a frame at it.
// Spec 3.1's three privilege levels: the server holds credentials, the SPA
// holds none, the body frame holds neither and cannot run code.
//
// 🚨 Nothing of ours renders INSIDE this frame (spec 6.8). The blocked-image
// banner, the plaintext toggle, the truncation notice and the attachment
// chips are all rendered here in the CHROME, around the frame -- a message
// whose own stylesheet says `body { background: #f2f2f2 }` would otherwise
// restyle anything we injected into it into invisibility, and containing
// message CSS would mean parsing and rewriting it, which is the fragile
// work spec 6.1 exists to avoid.
//
// 🚨 The counts the banner needs come from the MINT RESPONSE, not from the
// frame. A page cannot read the response headers of a cross-origin frame it
// embeds, so `X-Wilco-Blocked-Images` on the body response reaches nobody;
// the API reports the same numbers by running the same sanitizer over the
// same memoised body.
import { useEffect, useRef, useState } from "preact/hooks";

/** The frame is sized to its content by the body origin's resize script
 *  (see bodyhost.ts RESIZE_SCRIPT). Below this the pane looks empty while
 *  a message loads; above it the frame scrolls internally rather than the
 *  page growing to a sender's mile-tall markup. */
export const FRAME_MIN_PX = 320;
export const FRAME_MAX_PX = 20000;
import type { JSX } from "preact";
import type { BodyUrlResult } from "../lib/api";
import { BlockedImagesStrip, TruncationStrip } from "./BodyStrips";

export type BodyState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; body: BodyUrlResult }
  | { kind: "failed" };

export interface MessageBodyHook {
  state: BodyState;
  showPlaintext: boolean;
  setShowPlaintext: (v: boolean) => void;
  loadImages: () => void;
  loadFull: () => void;
}

/**
 * Owns the capability mint for one message.
 *
 * Lifted OUT of the frame component because two things need the result: the
 * frame (which needs the URL) and the attachment chips (which need the
 * per-part download URLs, and are rendered in the message card so there is
 * ONE attachment list rather than two). The first version rendered chips in
 * both places and the duplicate row was visible in a screenshot.
 */
export function useMessageBody(
  account: string | undefined,
  id: string | undefined,
  loadBodyUrl?: (account: string, id: string, opts: { images?: boolean; full?: boolean }) => Promise<BodyUrlResult>,
  /** The remoteImages preference (row 37): true loads remote images for
   *  every message from the start; false (the default) blocks them until
   *  asked. The per-message opt-in still resets on every open. */
  defaultImages = false,
): MessageBodyHook {
  const [state, setState] = useState<BodyState>({ kind: "idle" });
  /** v1.1 #2: the `text/html` badge IS the formatted/plaintext toggle. */
  const [showPlaintext, setShowPlaintextState] = useState(false);
  // Spec 6.6: the per-open opt-in resets when you open another message. A
  // STANDING allowance now exists as well ("Always from this sender",
  // v1.1 #2) -- that one lives on the server, keyed on the address, and is
  // applied by the mint route rather than held here.
  const [remoteImages, setRemoteImages] = useState(defaultImages);
  /** v1.1 #2's "Load full message". */
  const [full, setFull] = useState(false);

  useEffect(() => {
    setShowPlaintextState(false);
    setRemoteImages(defaultImages);
    setFull(false);
  }, [account, id]);

  useEffect(() => {
    if (!loadBodyUrl || account === undefined || id === undefined) return;
    let live = true;
    setState({ kind: "loading" });
    loadBodyUrl(account, id, { images: remoteImages, full }).then(
      (body) => {
        if (live) setState({ kind: "ready", body });
      },
      () => {
        // A failed mint or fetch falls back to the plaintext we already
        // have, rather than showing an empty pane. The message is still
        // readable; only its formatting is missing.
        if (live) setState({ kind: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [account, id, loadBodyUrl, remoteImages, full]);

  return {
    state,
    showPlaintext,
    setShowPlaintext: setShowPlaintextState,
    loadImages: () => setRemoteImages(true),
    loadFull: () => setFull(true),
  };
}

export interface BodyFrameProps {
  body: MessageBodyHook;
  /** Grants a standing per-sender image allowance (v1.1 #2). Omitted ->
   *  "Always from this sender" is not offered, rather than offered inert. */
  onAlwaysAllowImages?: (sender: string) => Promise<void>;
  /** Rendered when there is no frame to show: the existing plaintext body. */
  fallback: JSX.Element;
  suffix: string;
}

export function BodyFrame({ body: hook, fallback, suffix, onAlwaysAllowImages }: BodyFrameProps): JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(FRAME_MIN_PX);
  // Row 3: the frame reports its content height; the reading column then
  // owns scrolling, which is also what spec 6.10 asked for. Accepted ONLY
  // from this frame's own window -- an opaque-origin frame posts with origin
  // "null", so identity is by window, not origin -- and clamped.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (frameRef.current === null || e.source !== frameRef.current.contentWindow) return;
      const h = Number((e.data as { wilcoHeight?: unknown } | null)?.wilcoHeight);
      if (!Number.isFinite(h)) return;
      setHeight(Math.min(FRAME_MAX_PX, Math.max(FRAME_MIN_PX, Math.ceil(h))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const { state, showPlaintext, setShowPlaintext } = hook;
  if (state.kind === "idle") return fallback;

  if (state.kind === "failed") {
    return (
      <>
        <div data-testid={`body-frame-error${suffix}`} class="reading-html-notice">
          The formatted version could not be loaded — showing the plaintext version.
        </div>
        {fallback}
      </>
    );
  }

  if (state.kind === "loading") {
    return <div data-testid={`body-frame-loading${suffix}`} class="reading-body" />;
  }

  const { body } = state;
  const blocked = body.blockedRemoteImages;

  // v1.1 #2: flipped by the header badge, which relabels itself to
  // `text/plain`. There is no notice row -- the badge IS the affordance.
  if (showPlaintext) return fallback;

  return (
    <>
      {/* v1.1 #2: strips live INSIDE the card, and this one divides the
          header from the body. `blocked === null` means the server could
          not fetch the body to count -- not zero, so say nothing rather
          than claim nothing was blocked. */}
      {(body.remoteImages || (blocked !== null && blocked > 0)) && (
        <BlockedImagesStrip
          loaded={body.remoteImages}
          always={body.imagesAlways}
          sender={body.sender}
          suffix={suffix}
          onLoad={() => hook.loadImages()}
          onAlways={() => {
            // Grant the standing allowance FIRST, then re-mint: the mint
            // route reads it, so the other order would show "this message"
            // for a decision the reader made "always".
            if (onAlwaysAllowImages === undefined) {
              hook.loadImages();
              return;
            }
            void onAlwaysAllowImages(body.sender).then(
              () => hook.loadImages(),
              () => hook.loadImages(),
            );
          }}
        />
      )}

      <iframe
        data-testid={`body-frame${suffix}`}
        class="reading-body-frame"
        src={body.url}
        title="Message"
        // 🚨 BOTH popup flags are required and neither is optional.
        // `target="_blank"` is blocked OUTRIGHT by the sandbox, so without
        // them every link in every email silently does nothing -- measured,
        // spec 6.3. `allow-same-origin` is deliberately absent: with it the
        // frame would share the body origin and the whole isolation
        // argument collapses.
        // `allow-scripts` admits the body origin's OWN resize script, which
        // the frame's CSP names by hash; sender script matches no hash and
        // stays dead. `allow-same-origin` is deliberately absent: with it
        // the frame would share the body origin and the whole isolation
        // argument collapses.
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        ref={frameRef}
        style={{ height: `${height}px` }}
        // The frame NEVER takes focus (spec 6.10). A cross-origin sandboxed
        // frame with no `allow-scripts` cannot forward keys to us and we
        // cannot script into it, so a focused frame would kill every
        // keyboard shortcut the moment a message was opened -- which is
        // listed in Dovetail's own changelog as a notable fix.
        tabIndex={-1}
        referrerpolicy="no-referrer"
        loading="lazy"
      />

      {/* v1.1 #2: below the body, border-top. */}
      {body.truncated && !body.full && (
        <TruncationStrip
          shownBytes={body.shownBytes}
          totalBytes={body.totalBytes}
          loading={false}
          suffix={suffix}
          onLoadFull={() => hook.loadFull()}
        />
      )}

      {/* Attachment chips are rendered by the message card, not here:
          one list, with the download URLs this hook supplies. */}

      <div class="reading-html-notice">
        <button type="button" class="reading-html-toggle" onClick={() => setShowPlaintext(true)}>
          Show plaintext
        </button>
      </div>
    </>
  );
}
