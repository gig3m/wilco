// @vitest-environment node
import { test } from "vitest";
import assert from "node:assert/strict";
import { subscribe, type EventSourceLike } from "./events";

// A virtual clock so the reconnect-backoff test runs in milliseconds of
// real wall time instead of an actual 60s. `sleep(ms)` parks a resolver at
// `now + ms`; `advance(ms)` fires every parked resolver due within that
// window, in order, flushing microtasks between each so the subscriber's
// synchronous "catch -> sleep again" chain gets a turn before the next
// timer is considered.
function fakeClock() {
  let now = 0;
  const timers: { at: number; resolve: () => void }[] = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: now + ms, resolve });
      }),
    advance: async (ms: number) => {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        next.resolve();
        // Let the resumed subscriber loop run its synchronous work (retry,
        // schedule the next sleep) before we look for the next timer.
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
    },
  };
}

test("SSE reconnects with backoff and does not spin", async () => {
  const attempts: number[] = [];
  const clock = fakeClock();
  const stop = subscribe(() => {}, {
    open: () => {
      attempts.push(clock.now());
      throw new Error("down");
    },
    sleep: clock.sleep,
  });
  await clock.advance(60_000);
  stop();
  assert.ok(attempts.length < 12, `reconnect spun: ${attempts.length} attempts in 60s`);
  const gaps = attempts.slice(1).map((t, i) => t - attempts[i]!);
  assert.ok(
    gaps.every((g, i) => i === 0 || g >= gaps[i - 1]!),
    "backoff must not shrink",
  );
});

test("stop() prevents any further reconnect attempt", async () => {
  const attempts: number[] = [];
  const clock = fakeClock();
  const stop = subscribe(() => {}, {
    open: () => {
      attempts.push(clock.now());
      throw new Error("down");
    },
    sleep: clock.sleep,
  });
  await clock.advance(5_000);
  const countAtStop = attempts.length;
  stop();
  await clock.advance(60_000);
  assert.equal(attempts.length, countAtStop, "no reconnect attempt after stop()");
});

test("a delivered change event is reported as an account list", async () => {
  const received: string[][] = [];
  const handlers: ((ev: MessageEvent) => void)[] = [];
  let opened = 0;
  const stop = subscribe((accounts) => received.push(accounts), {
    open: (): EventSourceLike => {
      opened++;
      return {
        close: () => {},
        addEventListener: (type: string, listener: (ev: MessageEvent) => void) => {
          if (type === "change") handlers.push(listener);
        },
        onopen: null,
        onerror: null,
      };
    },
    sleep: () => new Promise<void>(() => {}), // never used -- the connection never fails here
  });
  assert.equal(opened, 1);
  assert.equal(handlers.length, 1, "handler for the 'change' event must be registered exactly once");
  handlers[0]!({ data: JSON.stringify({ account: "acct1", at: new Date().toISOString() }) } as MessageEvent);
  assert.deepEqual(received, [["acct1"]]);
  stop();
});

// NOTE: the cancellable backoff added alongside this (events.ts's
// `wakeFromBackoff`) has NO test, deliberately.
//
// It shortens how long the reconnect loop holds its closure after
// `unsubscribe` — from up to MAX_BACKOFF_MS down to a microtask. The old
// code was not behaviourally wrong: it rechecked `stopped` after the wait
// and exited without reconnecting. So there is nothing a test can observe
// that differs, and the one written first passed with the fix REVERTED —
// a shape test dressed as a behaviour test, which is the exact defect
// audit pass 8 exists to find.
//
// Recorded as a resource-release improvement with no proof, rather than
// given a test that would only make it look proven.
