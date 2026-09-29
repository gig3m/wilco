// The rich editor (HTML compose spec 3.1, owner rulings 2026-09-07).
//
// A contenteditable region with Fastmail's formatting bar, no dependency.
// Three things may put content into it: typing; the paragraph structure
// this component builds itself; and a SANITIZED document from the server
// (the owner's signature, the owner's draft), parsed with DOMParser and
// adopted node by node. Never a string through innerHTML -- that stays
// banned client-wide (lib/escape.test.ts). A sender's HTML never comes
// here at all: the quoted original lives in QuotePanel's sandboxed frame.
//
// 🚨 This is the ONE client file allowed DOMParser + node adoption, and the
// hygiene test pins that. `adopt()` trusts its caller to hand it a document
// the server sanitized (`signature-html`, `draft-html`); App is the only
// caller. The out-path is lib/richhtml.ts's serialiser, which is what the
// server receives and re-sanitizes.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Baseline, Bold, ChevronDown, Highlighter, Image, IndentDecrease,
  Italic, Link, List, ListOrdered, RemoveFormatting, Strikethrough, TextQuote, Type, Underline,
} from "lucide-preact";

/** Fastmail's colour grid: 8 rows x 5, the CSS named colours, no custom
 *  entry (measured 2026-09-07, row 46). A parity build hardcodes them. */
export const SWATCHES: readonly string[] = [
  "#000000", "#B22222", "#FF0000", "#FFA07A", "#FFF0F5",
  "#800000", "#A52A2A", "#FF8C00", "#FFA500", "#FAEBD7",
  "#8B4513", "#DAA520", "#FFD700", "#FFFF00", "#FFFFE0",
  "#2F4F4F", "#006400", "#008000", "#00FF00", "#F0FFF0",
  "#008080", "#40E0D0", "#00FFFF", "#AFEEEE", "#F0FFFF",
  "#000080", "#0000CD", "#0000FF", "#ADD8E6", "#F0F8FF",
  "#4B0082", "#800080", "#EE82EE", "#DDA0DD", "#E6E6FA",
  "#696969", "#808080", "#A9A9A9", "#D3D3D3", "#FFFFFF",
];
export const FONTS: readonly string[] = ["Arial", "Georgia", "Helvetica", "Monospace", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"];
export const SIZES: readonly [string, string][] = [["Small", "2"], ["Medium", "3"], ["Large", "5"], ["Huge", "7"]];
/** Below this toolbar width the list, quote and alignment controls move
 *  behind More, as Fastmail's do in its narrow inline-reply pane. */
export const COMPACT_PX = 700;
import { isSignatureBlock, serialize, serializePaste } from "../lib/richhtml";

export interface RichEditorHandle {
  /** The constrained HTML of the editable document. */
  html(): string;
  /** Adopt a server-sanitized document. `asSignature` wraps it in the
   *  signature block marker; `at` places it. */
  adopt(html: string, opts?: { asSignature?: boolean; at?: "start" | "end"; replace?: boolean }): void;
  /** Remove the signature block, if any. Returns whether one was there. */
  removeSignature(): boolean;
  /** The signature block's constrained HTML, or null. */
  signatureHtml(): string | null;
  /** True when nothing but structure (and, ignored, a signature) is there. */
  isEmpty(): boolean;
  /** Caret into the first paragraph. */
  focusStart(): void;
  /** The root element, for tests and the composer's Ctrl+Enter. */
  root(): HTMLElement | null;
}

export interface RichEditorProps {
  testId: string;
  /** Receives the handle once mounted. A plain ref object, not forwardRef:
   *  the app uses preact core, not compat. */
  handle?: { current: RichEditorHandle | null };
  onInput?: () => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  /** Toolbar shown (the main body) or not (the below-the-quote region). */
  toolbar?: boolean;
  placeholder?: string;
  /** The signature block's test id, so a check can find and edit it. */
  signatureTestId?: string;
}

type Cmd = { id: string; title: string; icon: typeof Bold; run: () => void };

/** Commands whose result is a styled <span>, which the serialiser keeps
 *  (colour, highlight, font). Everything else must produce ELEMENTS --
 *  <b>/<i>/<u>/<strike>, normalised by the serialiser to strong/em/u/s --
 *  because a `font-weight` span would be unwrapped to plain text. */
const CSS_COMMANDS = new Set(["foreColor", "hiliteColor", "backColor", "fontName", "fontSize"]);

/** A typed link the way Fastmail takes it: "www.example.com" or an
 *  address, no scheme required. */
export function normaliseLink(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (/^(https?:|mailto:)/i.test(v)) return v;
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(v)) return `mailto:${v}`;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?|#)/i.test(v) || /^localhost/i.test(v)) return `https://${v}`;
  return null;
}

function exec(command: string, value?: string): void {
  // execCommand is deprecated and universally supported; happy-dom lacks it,
  // so every call is guarded and the tests exercise the handle instead.
  const d = document as Document & { execCommand?: (c: string, ui: boolean, v?: string) => boolean };
  if (typeof d.execCommand !== "function") return;
  d.execCommand("styleWithCSS", false, CSS_COMMANDS.has(command) ? "true" : "false");
  d.execCommand(command, false, value);
}

export function RichEditor({ testId, handle, onInput, onKeyDown, toolbar = true, placeholder, signatureTestId }: RichEditorProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (root.childNodes.length === 0) root.appendChild(emptyParagraph());
    const api: RichEditorHandle = {
      html: () => serialize(root),
      adopt: (html, opts) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const nodes = Array.from(doc.body.childNodes);
        let target: Node[] = nodes;
        if (opts?.asSignature === true) {
          const block = document.createElement("div");
          block.setAttribute("data-wilco-signature", "");
          if (signatureTestId) block.setAttribute("data-testid", signatureTestId);
          for (const n of nodes) block.appendChild(n);
          target = [block];
        }
        // A resumed draft REPLACES the editor's own empty first line; a
        // signature goes after it, leaving the line to write on.
        if (opts?.replace === true) {
          while (root.firstChild) root.removeChild(root.firstChild);
        }
        if (opts?.at === "start") {
          const first = root.firstChild;
          for (const n of target) root.insertBefore(n, first);
        } else {
          for (const n of target) root.appendChild(n);
        }
        if (root.childNodes.length === 0) root.appendChild(emptyParagraph());
        // Silent on purpose: adopting the signature at open is not the
        // owner writing, and a reply opened and closed must not leave a
        // draft behind. Typing fires the element's own input event.
      },
      removeSignature: () => {
        const block = signatureOf(root);
        if (!block) return false;
        block.remove();
        if (root.childNodes.length === 0) root.appendChild(emptyParagraph());
        return true;
      },
      signatureHtml: () => {
        const block = signatureOf(root);
        if (!block) return null;
        const wrap = document.createElement("div");
        wrap.appendChild(block.cloneNode(true));
        return serialize(wrap);
      },
      isEmpty: () => {
        for (const child of Array.from(root.childNodes)) {
          if (child.nodeType === 1 && isSignatureBlock(child as Element)) continue;
          // The quoted original and its attribution are not the owner's
          // writing either (row 44): a reply opened and closed is no draft.
          if (child.nodeType === 1 && ((child as Element).hasAttribute("data-wilco-quote") || (child as Element).hasAttribute("data-wilco-attribution"))) continue;
          const el = child as Element;
          if ((child.textContent ?? "").trim() !== "") return false;
          if (child.nodeType === 1 && el.querySelector("img")) return false;
        }
        return true;
      },
      focusStart: () => {
        root.focus();
        const first = root.firstChild;
        const sel = window.getSelection?.();
        if (!first || !sel || typeof document.createRange !== "function") return;
        const range = document.createRange();
        range.setStart(first, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      },
      root: () => rootRef.current,
    };
    if (handle) handle.current = api;
    return () => {
      if (handle && handle.current === api) handle.current = null;
    };
    // The handle is created once per mount; callbacks read the latest
    // props through closure on each call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Inserts nodes at the caret when it is inside the editor, else at the
   *  end. Nodes, never strings: the Range API is the insertion path. */
  const insertNodes = (nodes: Node[]) => {
    const root = rootRef.current;
    if (!root || nodes.length === 0) return;
    const sel = window.getSelection?.();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (range && root.contains(range.startContainer) && typeof range.insertNode === "function") {
      range.deleteContents();
      const frag = document.createDocumentFragment();
      for (const n of nodes) frag.appendChild(n);
      const last = frag.lastChild;
      range.insertNode(frag);
      if (last) {
        range.setStartAfter(last);
        range.collapse(true);
        sel!.removeAllRanges();
        sel!.addRange(range);
      }
    } else {
      for (const n of nodes) root.appendChild(n);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    // Row 45 (Fastmail's rule, measured 2026-09-07): a paste keeps lists,
    // links, bold and italic; headings, block wrappers and inline CSS are
    // dropped; an image is inserted inline. The clipboard's HTML is parsed
    // in an inert document, reduced by the serialiser's paste mode, and
    // ONLY that output -- parsed once more into nodes -- enters the editor.
    e.preventDefault();
    const dt = e.clipboardData;
    if (!dt) return;
    const images = Array.from(dt.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (images.length > 0) {
      for (const f of images) insertImageFile(f);
      onInput?.();
      return;
    }
    const html = dt.getData("text/html");
    if (html !== "") {
      const reduced = serializePaste(new DOMParser().parseFromString(html, "text/html").body);
      const nodes = Array.from(new DOMParser().parseFromString(reduced, "text/html").body.childNodes);
      if (nodes.length > 0) {
        insertNodes(nodes);
        onInput?.();
        return;
      }
    }
    const text = dt.getData("text/plain") ?? "";
    if (text === "") return;
    const d = document as Document & { execCommand?: (c: string, ui: boolean, v?: string) => boolean };
    if (typeof d.execCommand === "function") {
      d.execCommand("insertText", false, text);
    } else {
      const lines = text.split(/\r?\n/);
      const p = document.createElement("p");
      lines.forEach((line, i) => {
        if (i > 0) p.appendChild(document.createElement("br"));
        p.appendChild(document.createTextNode(line));
      });
      insertNodes([p]);
    }
    onInput?.();
  };

  const insertImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      if (!/^data:image\//.test(url)) return;
      const img = document.createElement("img");
      img.setAttribute("src", url);
      insertNodes([img]);
      onInput?.();
    };
    reader.readAsDataURL(file);
  };

  // Row 46: pickers (colour grid, highlight grid, link popover, the More
  // menu) and the narrow-pane overflow. A picker steals no selection: its
  // buttons act on mousedown with the default prevented, and the link
  // popover saves the range before its input takes focus.
  const [picker, setPicker] = useState<"color" | "highlight" | "link" | "more" | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [compact, setCompact] = useState(false);
  const savedRange = useRef<Range | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setCompact(w < COMPACT_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const saveRange = () => {
    const sel = window.getSelection?.();
    const root = rootRef.current;
    if (sel && sel.rangeCount > 0 && root && root.contains(sel.getRangeAt(0).startContainer)) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    }
  };
  const restoreRange = () => {
    const sel = window.getSelection?.();
    if (sel && savedRange.current) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  };
  const openLink = () => {
    saveRange();
    const selText = window.getSelection?.()?.toString() ?? "";
    setLinkUrl(/^(https?:\/\/|www\.)/i.test(selText.trim()) ? selText.trim() : "");
    setPicker("link");
    setTimeout(() => linkInputRef.current?.focus(), 0);
  };
  const applyLink = () => {
    const url = normaliseLink(linkUrl);
    setPicker(null);
    if (url === null) return;
    rootRef.current?.focus();
    restoreRange();
    exec("createLink", url);
    onInput?.();
  };
  const applySwatch = (hex: string) => {
    exec(picker === "highlight" ? "hiliteColor" : "foreColor", hex);
    setPicker(null);
    onInput?.();
  };

  const cmds: Cmd[] = [
    { id: "bold", title: "Bold", icon: Bold, run: () => exec("bold") },
    { id: "italic", title: "Italic", icon: Italic, run: () => exec("italic") },
    { id: "underline", title: "Underline", icon: Underline, run: () => exec("underline") },
    { id: "strike", title: "Strikethrough", icon: Strikethrough, run: () => exec("strikeThrough") },
    { id: "color", title: "Text colour", icon: Baseline, run: () => { saveRange(); setPicker(picker === "color" ? null : "color"); } },
    { id: "highlight", title: "Text highlight", icon: Highlighter, run: () => { saveRange(); setPicker(picker === "highlight" ? null : "highlight"); } },
    { id: "image", title: "Insert image", icon: Image, run: () => fileRef.current?.click() },
    { id: "link", title: "Link (Ctrl-K)", icon: Link, run: openLink },
  ];
  const overflow: Cmd[] = [
    { id: "ul", title: "Bulleted list", icon: List, run: () => exec("insertUnorderedList") },
    { id: "ol", title: "Numbered list", icon: ListOrdered, run: () => exec("insertOrderedList") },
    { id: "quote-in", title: "Quote", icon: TextQuote, run: () => exec("formatBlock", "blockquote") },
    { id: "quote-out", title: "Unquote", icon: IndentDecrease, run: () => exec("outdent") },
    { id: "align-left", title: "Align left", icon: AlignLeft, run: () => exec("justifyLeft") },
    { id: "align-center", title: "Centre", icon: AlignCenter, run: () => exec("justifyCenter") },
    { id: "align-right", title: "Align right", icon: AlignRight, run: () => exec("justifyRight") },
    { id: "align-justify", title: "Justify", icon: AlignJustify, run: () => exec("justifyFull") },
    { id: "clear", title: "Clear formatting", icon: RemoveFormatting, run: () => exec("removeFormat") },
  ];

  const onEditorKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openLink();
      return;
    }
    if (e.key === "Escape" && picker !== null) {
      // Escape closes the picker, not the compose window: the app's own
      // Escape (save to Drafts and close) listens on window, so this must
      // not bubble. Found by row 46 -- the whole composer vanished.
      e.preventDefault();
      e.stopPropagation();
      setPicker(null);
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div class="rich-editor-wrap">
      {toolbar && (
        <div ref={toolbarRef} class="compose-toolbar rich-toolbar" data-testid={`${testId}-toolbar`} data-compact={compact ? "1" : "0"}>
          {cmds.slice(0, 4).map((c) => <ToolButton key={c.id} cmd={c} />)}
          <span class="rich-toolbar-sep" />
          <span class="rich-toolbar-font" title="Font face">
            <Type size={13} aria-hidden="true" />
            <select
              data-testid="rt-font"
              class="rich-toolbar-select"
              aria-label="Font face"
              onMouseDown={saveRange}
              onChange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                restoreRange();
                if (v !== "") exec("fontName", v === "Monospace" ? "monospace" : v);
                (e.currentTarget as HTMLSelectElement).value = "";
              }}
            >
              <option value="">Default</option>
              {FONTS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </span>
          <select
            data-testid="rt-size"
            class="rich-toolbar-select"
            aria-label="Text size"
            title="Text size"
            onMouseDown={saveRange}
            onChange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              restoreRange();
              if (v !== "") exec("fontSize", v);
              (e.currentTarget as HTMLSelectElement).value = "";
            }}
          >
            <option value="">Size</option>
            {SIZES.map(([label, v]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <span class="rich-toolbar-sep" />
          {cmds.slice(4).map((c) => <ToolButton key={c.id} cmd={c} />)}
          {!compact && (
            <>
              <span class="rich-toolbar-sep" />
              {overflow.slice(0, 4).map((c) => <ToolButton key={c.id} cmd={c} />)}
              <span class="rich-toolbar-sep" />
              {overflow.slice(4).map((c) => <ToolButton key={c.id} cmd={c} />)}
            </>
          )}
          {compact && (
            <button
              type="button"
              data-testid="rt-more"
              class="compose-toolbar-btn rich-toolbar-more"
              aria-haspopup="menu"
              aria-expanded={picker === "more"}
              onMouseDown={(e) => {
                e.preventDefault();
                setPicker(picker === "more" ? null : "more");
              }}
            >
              More <ChevronDown size={11} aria-hidden="true" />
            </button>
          )}
          {(picker === "color" || picker === "highlight") && (
            <div class="rich-popover rich-swatches" data-testid="rt-color-grid" role="listbox" aria-label={picker === "highlight" ? "Highlight colour" : "Text colour"}>
              {SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  data-testid={`rt-swatch-${hex.slice(1).toLowerCase()}`}
                  class="rich-swatch"
                  title={hex}
                  style={{ background: hex }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applySwatch(hex);
                  }}
                />
              ))}
            </div>
          )}
          {picker === "link" && (
            <div class="rich-popover rich-link" data-testid="rt-link-popover">
              <label class="rich-link-label" htmlFor={`${testId}-link-url`}>Add a link to the following URL or email:</label>
              <input
                ref={linkInputRef}
                id={`${testId}-link-url`}
                data-testid="rt-link-url"
                class="rich-link-input"
                type="text"
                placeholder="e.g. www.example.com"
                value={linkUrl}
                onInput={(e) => setLinkUrl((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); applyLink(); }
                  if (e.key === "Escape") { e.preventDefault(); setPicker(null); }
                }}
              />
              <div class="rich-link-actions">
                <button type="button" data-testid="rt-link-add" class="rich-link-add" onMouseDown={(e) => { e.preventDefault(); applyLink(); }}>Add link</button>
                <button type="button" data-testid="rt-link-cancel" class="rich-link-cancel" onMouseDown={(e) => { e.preventDefault(); setPicker(null); }}>Cancel</button>
              </div>
            </div>
          )}
          {picker === "more" && (
            <div class="rich-popover rich-more-menu" data-testid="rt-more-menu" role="menu">
              {overflow.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitem"
                  data-testid={`rt-${c.id}`}
                  class="rich-more-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    c.run();
                    setPicker(null);
                  }}
                >
                  <c.icon size={13} aria-hidden="true" /> {c.title}
                </button>
              ))}
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            data-testid="rt-image-file"
            class="rich-toolbar-hidden"
            onChange={(e) => {
              const f = (e.currentTarget as HTMLInputElement).files?.[0];
              if (f) insertImageFile(f);
              (e.currentTarget as HTMLInputElement).value = "";
            }}
          />
        </div>
      )}
      <div
        ref={rootRef}
        data-testid={testId}
        class="rich-editor"
        contenteditable="true"
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder ?? "Message"}
        data-placeholder={placeholder ?? ""}
        spellcheck
        onInput={() => onInput?.()}
        onPaste={onPaste}
        onKeyDown={onEditorKeyDown}
      />
    </div>
  );
}

function ToolButton({ cmd }: { cmd: Cmd }): JSX.Element {
  const Icon = cmd.icon;
  return (
    <button
      type="button"
      class="compose-toolbar-btn rich-toolbar-btn"
      data-testid={`rt-${cmd.id}`}
      title={cmd.title}
      aria-label={cmd.title}
      // mousedown, not click: a click steals the selection from the
      // editable region before the command runs.
      onMouseDown={(e) => {
        e.preventDefault();
        cmd.run();
      }}
      onClick={(e) => {
        // Keyboard activation (Enter/Space) arrives as a click with no
        // preceding mousedown; a mouse click already ran on mousedown.
        if ((e as MouseEvent).detail === 0) cmd.run();
      }}
    >
      <Icon size={14} aria-hidden="true" />
    </button>
  );
}

function emptyParagraph(): HTMLParagraphElement {
  const p = document.createElement("p");
  p.appendChild(document.createElement("br"));
  return p;
}

function signatureOf(root: HTMLElement): Element | null {
  for (const child of Array.from(root.children)) {
    if (isSignatureBlock(child)) return child;
  }
  return null;
}
