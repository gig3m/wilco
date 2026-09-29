// The print document (CHECKLIST row 33; DESIGN.md "Print view: Georgia
// serif"). One message, rendered on its own page with no app chrome, so
// the browser's print dialog gets the message and nothing else. Opened by
// the reading pane's Print button and the row menu's Print entry in a
// new window at /print/{account}/{id}; App renders this INSTEAD of the
// shell for that route.
//
// The body takes the same two paths Reading does: plaintext is escaped
// text (linkifyLine, the one renderer), and HTML goes through the body
// frame on the body origin -- spec 3.1 governs here as everywhere, a print
// page is not a licence to put message HTML into this origin's document.
// The browser prints a cross-origin frame's content along with the page.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Api, MessageDetail } from "../lib/api";
import { text } from "../lib/escape";
import { formatDetailTime } from "../lib/time";
import { BodyFrame, useMessageBody } from "./BodyFrame";
import { linkifyLine } from "./Reading";

const FONT_SERIF = 'Georgia, "Times New Roman", serif';
/** Long enough for the body frame to load before the dialog opens; the
 *  dialog snapshots the page as it is. */
const PRINT_DELAY_MS = 500;

export interface PrintViewProps {
  api: Api;
  account: string;
  id: string;
}

export function PrintView({ api, account, id }: PrintViewProps): JSX.Element {
  const [message, setMessage] = useState<MessageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .message(account, id)
      .then((m) => {
        if (!cancelled) setMessage(m);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the message.");
      });
    return () => {
      cancelled = true;
    };
  }, [api, account, id]);

  const body = useMessageBody(
    message?.hasHtml === true ? account : undefined,
    message?.hasHtml === true ? id : undefined,
    (a, i, opts) => api.bodyUrl(a, i, opts),
  );

  // Ask for the print dialog once the document is on screen. Guarded: a
  // test DOM has no print().
  const ready = message !== null && (message.hasHtml !== true || body.state.kind === "ready" || body.state.kind === "failed");
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      const w = window as unknown as { print?: () => void };
      if (typeof w.print === "function") w.print();
    }, PRINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  if (error !== null) {
    return (
      <div data-testid="print-view" class="print-view" style={{ fontFamily: FONT_SERIF }}>
        <p>{text(error)}</p>
      </div>
    );
  }
  if (message === null) {
    return (
      <div data-testid="print-view" class="print-view" style={{ fontFamily: FONT_SERIF }}>
        <p>Loading…</p>
      </div>
    );
  }

  const from = message.fromName !== "" ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail;
  const addrs = (list: { email: string; name: string | null }[]): string =>
    list.map((a) => (a.name !== null && a.name !== "" ? `${a.name} <${a.email}>` : a.email)).join(", ");
  const plain = (
    <div class="print-body">
      {(message.bodyText ?? "").split("\n").map((line, i) =>
        line === "" ? (
          <div key={i}>
            <br />
          </div>
        ) : (
          <div key={i}>{linkifyLine(line, `print-${i}`)}</div>
        ),
      )}
    </div>
  );

  return (
    <div data-testid="print-view" class="print-view" style={{ fontFamily: FONT_SERIF }}>
      <h1 class="print-subject">{text(message.subject !== "" ? message.subject : "(no subject)")}</h1>
      <table class="print-meta">
        <tbody>
          <tr>
            <th>From</th>
            <td>{text(from)}</td>
          </tr>
          <tr>
            <th>To</th>
            <td>{text(addrs(message.to))}</td>
          </tr>
          {message.cc.length > 0 && (
            <tr>
              <th>Cc</th>
              <td>{text(addrs(message.cc))}</td>
            </tr>
          )}
          <tr>
            <th>Date</th>
            <td>{text(formatDetailTime(message.receivedAt, new Date()))}</td>
          </tr>
        </tbody>
      </table>
      {message.hasHtml === true ? <BodyFrame body={body} fallback={plain} suffix="-print" /> : plain}
    </div>
  );
}
