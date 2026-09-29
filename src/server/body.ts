import type { IncomingMessage } from "node:http";

/**
 * Thrown by readJson when the body exceeds the size cap. A distinct class
 * (not a bare Error) so the router can tell "the client sent too much
 * data" apart from every other handler failure and answer 413, not 500 --
 * a client fault is not a server fault (fix wave, finding 6).
 */
export class PayloadTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Reads and parses a JSON request body, capped so a malicious or broken
 * client cannot exhaust memory by streaming an unbounded body at us. A
 * malformed body parses to `{}` rather than throwing, so every route that
 * uses this treats a bad body the same way it treats a missing field --
 * with its own validation, not a 500 from a stray JSON.parse throw.
 *
 * Shared between main.ts and accounts-api.ts (previously copy-pasted in
 * both) so the 64 KB cap and the swallow-to-`{}` behavior can't drift
 * between the two call sites.
 */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new PayloadTooLargeError();
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
