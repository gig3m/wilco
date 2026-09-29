import type { DatabaseSync } from "node:sqlite";
import type { JmapClient } from "./client.ts";
import { USING_SUBMISSION } from "./client.ts";
import { MAX_METADATA_BATCH } from "./refresh.ts";

export interface Addr {
  name: string;
  email: string;
}

export interface AttachmentMeta {
  partId: string;
  name: string;
  type: string;
  size: number;
  cid: string | null;
  /** The sender's own Content-Disposition, as JMAP reports it: "attachment",
   *  "inline", or null when none was declared. 🚨 This, not the presence of
   *  a `cid`, is what decides whether a part is a file the reader can open
   *  -- Gmail gives every part a cid, so the old cid-only rule rendered real
   *  attachments as inert labels (see `isFilePart` in queries.ts). */
  disposition?: string | null;
}

export interface MessageDetails {
  id: string;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  attachments: AttachmentMeta[];
  via: string | null;
  hasHtml: boolean;
}

/**
 * The JMAP properties needed to fill in a message's details, exactly as
 * spec'd (task-2 brief, §7.2's four Via candidates). One `Email/get` per
 * batch -- see backfillDetails.
 */
// htmlBody is a list of EmailBodyPart REFERENCES -- it does not fetch body
// content, so adding it here costs nothing (task-6b brief).
//
// 🚨 A NON-EMPTY htmlBody DOES NOT MEAN THE MESSAGE HAS AN HTML PART. That
// was the premise here and it is false. Like `textBody`, `htmlBody` is the
// list of parts a client should DISPLAY as the body when it prefers HTML --
// and for a message with only a text/plain part, that list contains the
// TEXT/PLAIN part. So `htmlBody.length > 0` was true for 37,740 of 37,784
// archived messages (99.9%), and every plaintext message was then rendered
// through the HTML pipeline: newlines collapsed into one wall of text, and
// `<someone@example.com>` or `<https://...>` eaten as a tag by the
// sanitizer. Found on a real sent reply, which arrived unreadable.
//
// This is the SAME trap as the one in the other direction --
// "JMAP's textBody is NOT the text/plain parts" -- which put raw markup in
// body_text for ~15% of the archive. The fix there was to classify on the
// part's own `type` and never on which list it arrived in. `type` is what
// decides here too.
const DETAIL_PROPS = [
  "id", "to", "cc", "bcc", "replyTo", "attachments", "htmlBody",
  "header:Delivered-To:asText", "header:X-Delivered-To:asText",
  "header:X-Original-To:asText", "header:Envelope-To:asText",
];

/** Order matters: the first non-empty header wins (spec 7.2). */
const VIA_HEADERS = ["delivered-to", "x-delivered-to", "x-original-to", "envelope-to"] as const;

/**
 * Via is stored only when it is USEFUL -- that is, when none of the
 * operator's own addresses shows up in `to`/`cc`. When your address IS
 * there, Via would just repeat what the recipient line already says; when
 * it is not, Via is often the only clue which account or alias the mail
 * arrived at (about 1 archived message in 20, per the brief).
 *
 * Deliberately a pure function of its three inputs -- no client, no
 * database -- so the "1 in 20" rule is testable without either.
 */
export function deriveVia(
  msg: { to: Addr[]; cc: Addr[] },
  headers: Record<string, string | null | undefined>,
  ownAddresses: Set<string>,
): string | null {
  // Explicit, not an accident of the data (review fix, Critical 1): with no
  // addresses to compare against, "none of your addresses is in to/cc" is
  // vacuously true for EVERY message, which would store Via on nearly all
  // of them instead of the ~1-in-20 the rule intends. An empty set means
  // "we don't know who you are yet", not "you're nowhere in this message" --
  // NULL is always safe and recoverable by a later pass (resetDetails);
  // a wrong Via written to ~19-in-20 messages is not, without one.
  if (ownAddresses.size === 0) return null;

  const mine = new Set([...ownAddresses].map((e) => e.toLowerCase()));
  const haveOwnAddress = [...msg.to, ...msg.cc].some((a) => mine.has(a.email.toLowerCase()));
  if (haveOwnAddress) return null;

  for (const key of VIA_HEADERS) {
    const value = headers[key];
    if (value != null && value.trim() !== "") return value.trim();
  }
  return null;
}

function toAddr(a: unknown): Addr {
  const o = (a ?? {}) as { name?: string | null; email?: string | null };
  return { name: o.name ?? "", email: o.email ?? "" };
}

function toAttachment(a: unknown): AttachmentMeta {
  const o = (a ?? {}) as {
    partId?: string | null;
    name?: string | null;
    type?: string | null;
    size?: number | null;
    cid?: string | null;
    disposition?: string | null;
  };
  return {
    partId: o.partId ?? "",
    name: o.name ?? "",
    type: o.type ?? "",
    size: o.size ?? 0,
    cid: o.cid ?? null,
    disposition: o.disposition ?? null,
  };
}

/** Raw JMAP Email/get row -> MessageDetails, including the Via derivation. */
function toMessageDetails(m: Record<string, unknown>, ownAddresses: Set<string>): MessageDetails {
  const to = ((m["to"] as unknown[]) ?? []).map(toAddr);
  const cc = ((m["cc"] as unknown[]) ?? []).map(toAddr);
  const bcc = ((m["bcc"] as unknown[]) ?? []).map(toAddr);
  const replyTo = ((m["replyTo"] as unknown[]) ?? []).map(toAddr);
  const attachments = ((m["attachments"] as unknown[]) ?? []).map(toAttachment);
  // The part's own declared type, never the list it arrived in.
  const hasHtml = ((m["htmlBody"] as { type?: string }[]) ?? []).some(
    (part) => typeof part?.type === "string" && part.type.toLowerCase().trim() === "text/html",
  );

  const headers = {
    "delivered-to": m["header:Delivered-To:asText"] as string | null | undefined,
    "x-delivered-to": m["header:X-Delivered-To:asText"] as string | null | undefined,
    "x-original-to": m["header:X-Original-To:asText"] as string | null | undefined,
    "envelope-to": m["header:Envelope-To:asText"] as string | null | undefined,
  };

  return {
    id: m["id"] as string,
    to, cc, bcc, replyTo, attachments,
    via: deriveVia({ to, cc }, headers, ownAddresses),
    hasHtml,
  };
}

/**
 * Rows still awaiting a detail backfill. Only details_at IS NULL counts --
 * same three-state rule as body_text: a genuinely empty message still gets
 * details_at set, so it must never come back here, or the backfill loop
 * never terminates (see writeDetails).
 */
export function undetailedIds(db: DatabaseSync, account: string, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM emails
        WHERE account = ? AND details_at IS NULL
        ORDER BY received_at DESC
        LIMIT ?`,
    )
    .all(account, limit) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * The single write path for message details. One transaction per batch:
 * existing recipient/attachment rows are deleted before the new ones are
 * inserted, so a re-run replaces rather than duplicates, and details_at is
 * stamped in the SAME transaction as the rows it describes -- a crash
 * between them would otherwise re-fetch this message forever.
 *
 * Addresses are lowercased on write (names are stored as-is): the same
 * mailbox can arrive with different casing across messages, and a search
 * that misses on case is worse than no search.
 */
export function writeDetails(db: DatabaseSync, account: string, details: MessageDetails[]): void {
  if (details.length === 0) return;

  const delRecipients = db.prepare(`DELETE FROM email_recipients WHERE account = ? AND email_id = ?`);
  const delAttachments = db.prepare(`DELETE FROM email_attachments WHERE account = ? AND email_id = ?`);
  const insRecipient = db.prepare(
    `INSERT INTO email_recipients (account, email_id, kind, name, email) VALUES (?, ?, ?, ?, ?)`,
  );
  // OR IGNORE (review fix, Important 2): (account, email_id, part_id) is the
  // primary key, and a real message can carry two parts with the same --
  // or, worse, both an empty -- partId (toAttachment defaults a missing one
  // to ""). Without IGNORE that raises a constraint error that rolls back
  // the WHOLE batch's transaction, and since nothing about that message
  // changes between passes, it fails identically forever. Losing one
  // malformed attachment row is far cheaper than wedging every other
  // message in the same batch.
  const insAttachment = db.prepare(
    `INSERT OR IGNORE INTO email_attachments (account, email_id, part_id, name, type, size, cid, disposition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const markDetailed = db.prepare(
    `UPDATE emails SET via = ?, has_html = ?, details_at = ? WHERE account = ? AND id = ?`,
  );

  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const d of details) {
      delRecipients.run(account, d.id);
      delAttachments.run(account, d.id);

      const groups: [string, Addr[]][] = [
        ["to", d.to], ["cc", d.cc], ["bcc", d.bcc], ["reply-to", d.replyTo],
      ];
      for (const [kind, addrs] of groups) {
        for (const a of addrs) {
          insRecipient.run(account, d.id, kind, a.name, a.email.toLowerCase());
        }
      }

      for (const att of d.attachments) {
        const info = insAttachment.run(
          account,
          d.id,
          att.partId,
          att.name,
          att.type,
          att.size,
          att.cid,
          att.disposition ?? null,
        );
        // A silent drop must not be an invisible one (fix wave, finding 8):
        // OR IGNORE stays, but a dropped second part sharing a part_id is
        // now at least one log line instead of vanishing with no trace.
        // No token/query value here -- just the account and message id,
        // both already-known routing info, not secret.
        if (info.changes === 0) {
          console.error(
            `writeDetails: dropped duplicate attachment part_id=${att.partId} account=${account} email=${d.id}`,
          );
        }
      }

      // details_at is set unconditionally, even for a message with nothing
      // to write above -- a boolean "has details" cannot distinguish
      // "nothing there" from "not looked yet", and the backfill would retry
      // the empty ones on every pass, forever. Same reasoning as body_text.
      //
      // has_html is written in this SAME UPDATE, in the same transaction
      // as details_at -- a crash between them must never leave a message
      // marked detailed with an unset has_html (task-6b brief).
      markDetailed.run(d.via, d.hasHtml ? 1 : 0, now, account, d.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Operator escape hatch (review fix, Critical 1): pairs with resetWalk /
 * resetBodies / resetEmailCursor in mutations.ts and reset-account.ts's
 * `--details` flag. Puts every already-detailed row for the account back in
 * front of the next backfillDetails pass.
 *
 * `via` is cleared immediately, not left to wait for the next backfill --
 * this is the direct undo lever for a wrong Via written by an
 * `ownAddresses` that was empty or otherwise incomplete (see deriveVia).
 * `email_recipients`/`email_attachments` rows are deliberately left in
 * place: they were not wrong, and writeDetails replaces them wholesale on
 * the next successful pass regardless, so there is nothing to gain by
 * deleting them here and a live reader would briefly show no recipients
 * at all if we did.
 *
 * Returns the number of rows changed, same convention as resetBodies.
 */
export function resetDetails(db: DatabaseSync, account: string): number {
  const result = db
    .prepare(
      `UPDATE emails SET via = NULL, has_html = NULL, details_at = NULL
        WHERE account = ? AND details_at IS NOT NULL`,
    )
    .run(account);
  return Number(result.changes);
}

/**
 * Resolve "the operator's own addresses" for `deriveVia` from the account's
 * own JMAP Identity/get -- the brief made `ownAddresses` a parameter
 * specifically so deriveVia stays testable without a network call; this is
 * the caller that actually supplies it (review fix, Critical 1). One call
 * per account; callers (the supervisor, the backfill script) are expected
 * to cache the result for the life of a run rather than call this every
 * pass/batch -- Identity/get is cheap, but there is no reason to repeat it.
 *
 * Identity/get lives under the submission capability, not mail, and is
 * scoped to the submission account id, not the mail account id -- both
 * usually the same JMAP account, but not guaranteed to be.
 *
 * Never throws on a malformed/empty response -- an account with no
 * identities configured (or a server that omits `email`) just yields an
 * empty set, which deriveVia already treats as "don't know yet" (NULL,
 * never a guess).
 */
export async function fetchOwnAddresses(client: JmapClient): Promise<Set<string>> {
  const [res] = await client.request(
    [["Identity/get", { accountId: client.session.submissionAccountId, ids: null }, "c0"]],
    USING_SUBMISSION,
  );
  const list = (res?.[1] as { list?: { email?: string | null }[] } | undefined)?.list ?? [];
  const addrs = list.map((i) => (i.email ?? "").toLowerCase()).filter((e) => e !== "");
  return new Set(addrs);
}

/**
 * Fetch recipients, attachment metadata and Via for every message whose
 * details_at is still NULL, in batches, until there is nothing left (or
 * `opts.maxBatches` caps the run -- the supervisor uses this to do one
 * batch per pass so this expensive, whole-corpus backfill never starves
 * incremental sync).
 *
 * Mirrors backfillBodies' shape (corpus.ts): batch size comes from the
 * session, clamped the same way refresh.ts sizes a metadata fetch (a detail
 * fetch is metadata-shaped, not body-shaped); the progress guard snapshots
 * the unfetched ids before and after a batch and THROWS -- never breaks --
 * if a full pass left the exact same rows undetailed. A silent break would
 * make an incomplete backfill look finished, and the reader would then be
 * quietly missing recipients/attachments/Via with nothing to show for it.
 *
 * Unlike backfillBodies, a message simply absent from the response is NOT
 * written as "fetched, nothing there" by default -- only messages the
 * server actually returned in `list` get real details written. The ONE
 * exception (review fix, Critical 2): JMAP's Email/get response carries a
 * second array, `notFound`, naming ids the server explicitly says it does
 * not have (RFC 8620 5.1) -- typically a message destroyed between the
 * archive walk and this backfill reaching it. Those ids get the same empty
 * fallback the brief's own module comments describe for body_text = '':
 * writing something small and correct now, instead of leaving a
 * permanently-ungettable id to shrink into a batch of its own forever,
 * reproduce an empty response every time, and trip the guard below on
 * every single pass. A response that is empty AND says nothing about why
 * (no `notFound` either -- exactly what a broken/unreachable server looks
 * like, and what the "made no progress" test below exercises) is NOT
 * covered by this and correctly still throws.
 */
export async function backfillDetails(
  db: DatabaseSync,
  client: JmapClient,
  account: string,
  opts: {
    batchSize?: number;
    maxBatches?: number;
    ownAddresses?: Set<string>;
    signal?: AbortSignal;
    onProgress?: () => void;
  } = {},
): Promise<number> {
  const batchSize =
    opts.batchSize ?? Math.max(1, Math.min(client.session?.maxObjectsInGet ?? MAX_METADATA_BATCH, MAX_METADATA_BATCH));
  const accountId = client.session?.mailAccountId;
  const ownAddresses = opts.ownAddresses ?? new Set<string>();
  const maxBatches = opts.maxBatches ?? Infinity;

  let detailed = 0;
  let batches = 0;

  for (;;) {
    if (opts.signal?.aborted) break;
    if (batches >= maxBatches) break;

    const before = undetailedIds(db, account, batchSize);
    if (before.length === 0) break;

    const [res] = await client.request([
      ["Email/get", { accountId, ids: before, properties: DETAIL_PROPS }, "c0"],
    ]);
    const body = res?.[1] as { list?: Record<string, unknown>[]; notFound?: string[] } | undefined;
    const list = body?.list ?? [];
    const notFound = body?.notFound ?? [];

    const details: MessageDetails[] = list.map((m) => toMessageDetails(m, ownAddresses));
    // Ids the server explicitly says it doesn't have get the same empty
    // fallback as an unfetchable body -- see the doc comment above.
    //
    // `hasHtml: false` here is a deliberate, documented bend of this
    // schema's usual tri-state convention (NULL = not yet inspected, 0/1 =
    // inspected and found false/true) -- this message was never actually
    // inspected, it is gone server-side. It is benign: a message that does
    // not exist has no reachable content for the has-html distinction to
    // matter for, and there is no future pass that will come back and
    // "correct" it once markDetailed has run. Do NOT take this as
    // precedent for writing a false default anywhere else in this file
    // (fix wave, finding 7).
    for (const id of notFound) {
      details.push({ id, to: [], cc: [], bcc: [], replyTo: [], attachments: [], via: null, hasHtml: false });
    }
    writeDetails(db, account, details);
    detailed += details.length;
    batches += 1;
    opts.onProgress?.();

    const after = undetailedIds(db, account, batchSize);
    const beforeIds = new Set(before);
    const madeNoProgress = after.length === before.length && after.every((id) => beforeIds.has(id));
    if (madeNoProgress) {
      throw new Error(
        `details backfill made no progress for ${account}: ${before[0]} still undetailed after a full pass`,
      );
    }
  }

  return detailed;
}
