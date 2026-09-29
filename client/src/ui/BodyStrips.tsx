// The body-pipeline notice strips (handoff v1.1 #2).
//
// 🚨 These are full-width strips INSIDE the message card — mono 10.5px on
// --panel2 with hairline dividers — not floating rows around the frame.
// The v1 implementation put them outside as plain paragraphs; v1.1 is
// explicit that they belong in the card, and is authoritative over it.
//
// The blocked-images strip sits between the card header and the body
// (border-bottom); the truncation strip sits below the body (border-top).
// That difference is the whole reason they are two components rather than
// one with a flag: each attaches to the edge it divides.
import type { JSX } from "preact";
import { text } from "../lib/escape";

const FONT_MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export interface BlockedImagesStripProps {
  /** Already-loaded, and why: `false` shows the blocking state. */
  loaded: boolean;
  /** True when the load came from a standing per-sender allowance rather
   *  than this open — the loaded strip says which. */
  always: boolean;
  sender: string;
  onLoad: () => void;
  onAlways: () => void;
  suffix: string;
}

export function BlockedImagesStrip({
  loaded,
  always,
  sender,
  onLoad,
  onAlways,
  suffix,
}: BlockedImagesStripProps): JSX.Element {
  if (loaded) {
    // v1.1 #2: "✓ remote images loaded · this message" (or "· always for
    // {address}"), --faint, NO actions. There is nothing left to offer.
    return (
      <div data-testid={`images-strip${suffix}`} class="body-strip body-strip--top" style={{ fontFamily: FONT_MONO }}>
        <span class="body-strip-text body-strip-text--done">
          ✓ remote images loaded · {always ? `always for ${text(sender)}` : "this message"}
        </span>
      </div>
    );
  }

  return (
    <div data-testid={`images-strip${suffix}`} class="body-strip body-strip--top" style={{ fontFamily: FONT_MONO }}>
      <span class="body-strip-text">◻ remote images blocked</span>
      <button
        type="button"
        data-testid={`load-images${suffix}`}
        class="body-strip-btn"
        // Loading them tells the sender the message was opened, and from
        // which IP — v1 blocks rather than proxying (spec 6.6).
        title="Loads images from the sender's server, which tells them you opened this message"
        onClick={onLoad}
      >
        Load images
      </button>
      <button
        type="button"
        data-testid={`always-images${suffix}`}
        class="body-strip-link"
        title={`Always load remote images from ${sender}`}
        onClick={onAlways}
      >
        Always from this sender
      </button>
    </div>
  );
}

export interface TruncationStripProps {
  shownBytes: number;
  totalBytes: number;
  onLoadFull: () => void;
  loading: boolean;
  suffix: string;
}

export function TruncationStrip({
  shownBytes,
  totalBytes,
  onLoadFull,
  loading,
  suffix,
}: TruncationStripProps): JSX.Element {
  return (
    <div
      data-testid={`truncation-strip${suffix}`}
      class="body-strip body-strip--bottom"
      style={{ fontFamily: FONT_MONO }}
    >
      <span class="body-strip-text">
        ✂ message truncated · showing {formatKb(shownBytes)} of {formatKb(totalBytes)}
      </span>
      <button
        type="button"
        data-testid={`load-full${suffix}`}
        class="body-strip-btn"
        disabled={loading}
        onClick={onLoadFull}
      >
        {loading ? "Loading…" : "Load full message"}
      </button>
    </div>
  );
}

/** The design's own unit: "showing 64 KB of 412 KB". Whole KB, because a
 *  decimal here would read as precision the number does not have — it is
 *  the size of the HTML part, not of what is on screen. */
function formatKb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
