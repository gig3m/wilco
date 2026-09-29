// @vitest-environment happy-dom
// The busy marker needs a document; api.test.ts deliberately runs in node.
import { test } from "vitest";
import assert from "node:assert/strict";
import { makeApi } from "./api";

test("the document root says when a request is in flight, and 0 once it is done", async () => {
  let release: (v: Response) => void = () => {};
  const held = new Promise<Response>((r) => { release = r; });
  const a = makeApi(() => held);
  // Relative to whatever an earlier test in this file left in flight (a
  // mock that never settles keeps its count forever): the marker is a
  // COUNT, and this request adds exactly one and takes it away again.
  const busy = () => Number(document.documentElement.getAttribute("data-wilco-busy"));
  const base = busy();
  assert.ok(Number.isInteger(base), "the marker exists once the client does");
  const p = a.mailboxes();
  assert.equal(busy(), base + 1);
  release(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  await p;
  assert.equal(busy(), base);
});
