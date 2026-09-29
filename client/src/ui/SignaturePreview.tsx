// A faithful preview of an HTML signature.
//
// 🚨 It renders in the BODY FRAME, not in this document. An earlier version
// showed a plaintext rendition instead, on the reasoning that the raw-HTML
// ban should not get an exception "just for our own HTML" -- that part was
// right, but the conclusion was wrong: the answer is not to show something
// worse, it is to use the sandboxed origin that already exists for exactly
// this. Reported from real use, where a signature containing a base64 logo
// previewed as a wall of `<img src="data:image/jpeg;base64,/9j/4AAQ...`.
//
// (That literal markup was a second bug: the tag-stripping regex was bounded
// at 2000 characters, so a data: URL ran past it and the whole tag survived
// as text. Both are gone -- there is no client-side html-to-text path here
// any more.)
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

/** Natural-height bounds (Settings, row 38). The floor covers the moment
 *  before any height is known; the ceiling keeps a runaway signature from
 *  taking the page -- past it the frame scrolls. */
export const SIGNATURE_MIN_PX = 96;
export const SIGNATURE_MAX_PX = 800;

export interface SignaturePreviewProps {
  account: string;
  identityId: string;
  /** Mints the capability URL. Omitted -> nothing renders. */
  loadUrl?: (account: string, identityId: string) => Promise<{ url: string; hasHtml: boolean; height?: number | null }>;
  /** Bumped by the caller after a save, to re-mint and re-render. */
  version?: number;
  testId?: string;
  className?: string;
  /** Compose: the geometry comes entirely from the stylesheet (v1.1 #5,
   *  a fixed 110px frame that scrolls); nothing here sizes the frame. */
  fixedHeight?: boolean;
  /** Settings (row 38, owner ruling 2026-09-06): the WHOLE signature
   *  shows, nothing scrolls inside a box. The frame starts at the server's
   *  generous estimate (so the first paint is close) and then takes the
   *  height the frame's own resize script reports -- the same message the
   *  reading pane's BodyFrame accepts, under the same rules: only from this
   *  frame's own window, and clamped. */
  naturalHeight?: boolean;
}

export function SignaturePreview({
  account,
  identityId,
  loadUrl,
  version,
  testId = "signature-preview",
  className,
  fixedHeight: _fixedHeight,
  naturalHeight,
}: SignaturePreviewProps): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (naturalHeight !== true) return;
    const onMessage = (e: MessageEvent) => {
      if (frameRef.current === null || e.source !== frameRef.current.contentWindow) return;
      const h = Number((e.data as { wilcoHeight?: unknown } | null)?.wilcoHeight);
      if (!Number.isFinite(h)) return;
      setHeight(Math.min(SIGNATURE_MAX_PX, Math.max(SIGNATURE_MIN_PX, Math.ceil(h))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [naturalHeight]);

  useEffect(() => {
    if (!loadUrl) return;
    let live = true;
    setUrl(null);
    loadUrl(account, identityId).then(
      (r) => {
        if (!live) return;
        setUrl(r.url);
        setHeight(typeof r.height === "number" && r.height > 0 ? r.height : null);
      },
      () => {
        // A preview that will not load is not worth an error banner: the
        // signature itself is unaffected.
        if (live) setUrl(null);
      },
    );
    return () => {
      live = false;
    };
  }, [account, identityId, loadUrl, version]);

  if (url === null) return null;

  return (
    <iframe
      ref={frameRef}
      data-testid={testId}
      class={className ?? "signature-frame"}
      src={url}
      style={naturalHeight === true && height !== null ? { height: `${height}px` } : undefined}
      title="Signature preview"
      // Same sandbox as a message body, for the same reasons (spec 6.3):
      // no scripts, no same-origin, popups allowed so a link in a signature
      // is not silently dead.
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      tabIndex={-1}
      referrerpolicy="no-referrer"
    />
  );
}
