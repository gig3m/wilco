// The one place every `api.*` call's `.catch` asks "was that a dead
// session, or something else?" -- api.ts's own doc comment says 401 is
// "the caller's responsibility", and until this file existed no caller
// actually took it: six `.then()` chains had no `.catch` at all, and the
// seventh (events.ts's SSE reconnect) folded a fatal failure into the
// same infinite backoff as a network blip. Centralizing the question
// means every call site routes a session expiry the same way instead of
// five slightly different re-implementations of `err.status === 401`.
import { ApiError } from "./api";

/** True for the one failure that means "route to login", never "show a
 *  retry banner" -- a 401 must never be retried in a loop (api.ts's own
 *  warning) and must never just leave a pane blank. */
export function isSessionExpired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** A short, human message for anything that ISN'T a session expiry --
 *  shown in a dismissible banner instead of an unhandled rejection.
 *  Deliberately generic for a non-`ApiError` (a network blip, a parse
 *  failure) rather than echoing `err.message`, which could be anything a
 *  browser or the fetch layer decided to throw. */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) return err.message || `Something went wrong (${err.status}).`;
  return "Something went wrong. Check your connection and try again.";
}
