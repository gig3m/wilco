import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventHub, HEARTBEAT_MS } from "../src/server/events.ts";

async function withHub(fn: (base: string, hub: EventHub) => Promise<void>) {
  const hub = new EventHub();
  const server = createServer((req, res) => {
    if (req.url === "/events") { hub.subscribe(res); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`, hub); }
  finally { hub.close(); await new Promise<void>((r) => server.close(() => r())); }
}

async function readOneEvent(base: string, hub: EventHub, trigger: () => void): Promise<string> {
  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  await reader.read();                       // the ": connected" frame written on subscribe
  // The subscriber must be registered before we publish, or the event is lost.
  while (hub.size === 0) await new Promise((r) => setTimeout(r, 5));
  trigger();
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}

test("the stream announces itself as SSE and does not buffer", async () => {
  await withHub(async (base, hub) => {
    const res = await fetch(`${base}/events`);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    await res.body!.cancel();
    hub.close();
  });
});

test("publish reaches a subscriber and names the account", async () => {
  await withHub(async (base, hub) => {
    const frame = await readOneEvent(base, hub, () => hub.publish("personal"));
    assert.match(frame, /event: change/);
    assert.match(frame, /"account":"personal"/);
  });
});

test("THE STREAM CARRIES NO MESSAGE CONTENT", async () => {
  // It is a notification to re-read, never a carrier of mail. One delivery
  // path for data keeps the cache the single source of truth.
  await withHub(async (base, hub) => {
    const frame = await readOneEvent(base, hub, () => hub.publish("personal"));
    const payload = JSON.parse(frame.split("data:")[1]!.trim());
    assert.deepEqual(Object.keys(payload).sort(), ["account", "at"],
      "an event must carry only which account changed and when");
  });
});

test("events carry a monotonic id so a reconnecting client can resume", async () => {
  await withHub(async (base, hub) => {
    const a = await readOneEvent(base, hub, () => hub.publish("personal"));
    const b = await readOneEvent(base, hub, () => hub.publish("work"));
    const idA = Number(/id: (\d+)/.exec(a)![1]);
    const idB = Number(/id: (\d+)/.exec(b)![1]);
    assert.ok(idB > idA);
  });
});

test("heartbeat writes a comment frame, which is what keeps nginx from closing the stream", async () => {
  await withHub(async (base, hub) => {
    const frame = await readOneEvent(base, hub, () => hub.heartbeat());
    assert.match(frame, /^:/m);
  });
});

test("a disconnected subscriber is dropped and does not break publish", async () => {
  await withHub(async (base, hub) => {
    const res = await fetch(`${base}/events`);
    while (hub.size === 0) await new Promise((r) => setTimeout(r, 5));
    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 50));
    hub.publish("personal");            // must not throw
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(hub.size, 0, "a dead subscriber must be reaped");
  });
});

test("the heartbeat interval is under nginx's default read timeout", () => {
  assert.ok(HEARTBEAT_MS < 60_000, "nginx closes an idle upstream at 60s by default");
});
