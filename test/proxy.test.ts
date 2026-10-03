import { test } from "node:test";
import assert from "node:assert/strict";
import { clientAddress, inCidr } from "../src/server/proxy.ts";

const req = (remote: string, xff?: string): any => ({
  socket: { remoteAddress: remote },
  headers: xff === undefined ? {} : { "x-forwarded-for": xff },
});

test("inCidr covers the docker bridge range and rejects outside it", () => {
  assert.equal(inCidr("172.18.0.5", "172.16.0.0/12"), true);
  assert.equal(inCidr("172.31.255.254", "172.16.0.0/12"), true);
  assert.equal(inCidr("172.15.0.1", "172.16.0.0/12"), false);
  assert.equal(inCidr("10.0.0.5", "172.16.0.0/12"), false);
});

test("a direct client's own address is used, and its header is IGNORED", () => {
  // An untrusted peer must never be able to choose its own rate-limit bucket.
  assert.equal(clientAddress(req("10.10.10.99", "1.2.3.4")), "10.10.10.99");
});

test("behind a trusted proxy, the forwarded address is used", () => {
  assert.equal(clientAddress(req("172.18.0.3", "10.10.10.50")), "10.10.10.50");
});

test("AN APPENDED CHAIN TAKES THE RIGHTMOST ENTRY, NOT THE LEFTMOST", () => {
  // nginx's $proxy_add_x_forwarded_for APPENDS, so the leftmost value is
  // whatever the client sent. Trusting it turns a shared-bucket DoS into a
  // real bypass, because every request could claim a fresh bucket.
  assert.equal(clientAddress(req("172.18.0.3", "9.9.9.9, 10.10.10.50")), "10.10.10.50");
});

test("a spoofed header from a trusted proxy still cannot forge an arbitrary bucket", () => {
  const a = clientAddress(req("172.18.0.3", "evil, evil, 10.10.10.50"));
  assert.equal(a, "10.10.10.50");
});

test("a malformed or empty header falls back to the socket address", () => {
  assert.equal(clientAddress(req("172.18.0.3", "")), "172.18.0.3");
  assert.equal(clientAddress(req("172.18.0.3", "not-an-ip")), "172.18.0.3");
});

test("an unknown remote address never throws", () => {
  assert.equal(typeof clientAddress({ socket: {}, headers: {} } as any), "string");
});

test("inCidr rejects out-of-range or malformed prefix lengths, never widens trust", () => {
  assert.equal(inCidr("1.2.3.4", "9.9.9.9/33"), false);
  assert.equal(inCidr("1.2.3.4", "9.9.9.9/-1"), false);
  assert.equal(inCidr("1.2.3.4", "9.9.9.9/abc"), false);
  assert.equal(inCidr("1.2.3.4", "9.9.9.9"), false);
});

test("inCidr /0 matches everything and /32 matches only the exact address", () => {
  assert.equal(inCidr("1.2.3.4", "9.9.9.9/0"), true);
  assert.equal(inCidr("10.0.0.1", "10.0.0.1/32"), true);
  assert.equal(inCidr("10.0.0.2", "10.0.0.1/32"), false);
});

test("an array-valued x-forwarded-for header does not throw", () => {
  const req2: any = {
    socket: { remoteAddress: "172.18.0.3" },
    headers: { "x-forwarded-for": ["9.9.9.9", "10.10.10.50"] },
  };
  assert.doesNotThrow(() => clientAddress(req2));
  assert.equal(clientAddress(req2), "10.10.10.50");
});
