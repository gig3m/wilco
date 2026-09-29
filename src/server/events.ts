import type { ServerResponse } from "node:http";

/**
 * nginx closes an idle upstream connection after 60s by default, and NPM's
 * proxy_read_timeout is set to 3600s for this host -- but a comment frame is
 * still what keeps every intermediary from deciding the stream is dead.
 */
export const HEARTBEAT_MS = 25_000;

/**
 * Fan-out of "something changed, re-read" notifications.
 *
 * The stream deliberately carries no message content: one delivery path for
 * data keeps the cache the single source of truth, and it means an event can
 * never leak mail to a client that should not see it.
 */
export class EventHub {
  private subscribers = new Set<ServerResponse>();
  private nextId = 1;

  get size(): number {
    return this.subscribers.size;
  }

  subscribe(res: ServerResponse): () => void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Belt and braces against a proxy that buffers despite configuration.
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    this.subscribers.add(res);

    const drop = (): void => {
      this.subscribers.delete(res);
    };
    res.on("close", drop);
    res.on("error", drop);
    return drop;
  }

  publish(account: string): void {
    const id = this.nextId++;
    const payload = JSON.stringify({ account, at: new Date().toISOString() });
    this.send(`id: ${id}\nevent: change\ndata: ${payload}\n\n`);
  }

  heartbeat(): void {
    this.send(`: keepalive\n\n`);
  }

  close(): void {
    for (const res of this.subscribers) {
      // Same reasoning as send(): a response can already be mid-teardown
      // (the client disconnected a moment ago) and res.end() can throw on
      // that, which must not stop the other subscribers from being closed
      // or abort the caller's own shutdown sequence.
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.subscribers.clear();
  }

  private send(frame: string): void {
    for (const res of [...this.subscribers]) {
      try {
        if (res.writableEnded) this.subscribers.delete(res);
        else res.write(frame);
      } catch {
        this.subscribers.delete(res);
      }
    }
  }
}
