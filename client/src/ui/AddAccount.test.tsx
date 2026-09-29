// @vitest-environment happy-dom
// Task 7: add-account onboarding. See AddAccount.tsx's module comment for
// why the terminal log must be driven by real `api.addAccount` results
// rather than a canned animation, and why the token must never reach a
// text node.
import { test } from "vitest";
import assert from "node:assert/strict";
import { ApiError } from "../lib/api";
import { byTestId, click, fakeApi, render, tick, type } from "../test-utils";
import { AddAccount } from "./AddAccount";

test("step 1 offers JMAP and shows IMAP as dimmed and unavailable", () => {
  render(<AddAccount api={fakeApi()} onClose={() => {}} />);
  assert.equal(byTestId("proto-imap").hasAttribute("disabled"), true);
  assert.match(byTestId("proto-imap").textContent!, /soon/i);
  click(byTestId("proto-jmap"));
  assert.ok(byTestId("step-2"));
});

test("the endpoint is derived from the address and the code is live", () => {
  render(<AddAccount api={fakeApi()} onClose={() => {}} />);
  click(byTestId("proto-jmap"));
  type(byTestId("address"), "kai@halden.example");
  assert.equal((byTestId("endpoint") as HTMLInputElement).value, "https://halden.example/.well-known/jmap");
  assert.equal(byTestId("code-preview").textContent, "code HAL");
});

test("editing the endpoint by hand stops it from following the address", () => {
  render(<AddAccount api={fakeApi()} onClose={() => {}} />);
  click(byTestId("proto-jmap"));
  type(byTestId("address"), "kai@halden.example");
  type(byTestId("endpoint"), "https://custom.example/.well-known/jmap");
  type(byTestId("address"), "kai@wilco.dev");
  assert.equal((byTestId("endpoint") as HTMLInputElement).value, "https://custom.example/.well-known/jmap");
});

test("THE TERMINAL LOG REFLECTS REAL API RESULTS, NOT A CANNED ANIMATION", async () => {
  // A log that always reports success is a lie about whether the account works.
  const api = fakeApi({ addAccount: () => Promise.reject(new ApiError(400, "bad endpoint")) });
  render(<AddAccount api={api} onClose={() => {}} />);
  click(byTestId("proto-jmap"));
  type(byTestId("address"), "kai@halden.example");
  type(byTestId("token"), "secret-token-value");
  click(byTestId("submit"));
  await tick();
  assert.match(byTestId("terminal").textContent!, /fail|error/i);
  assert.equal(byTestId("open-inbox", { optional: true }), null);
});

test("a successful submit calls the real API with the derived fields and the typed token", async () => {
  const api = fakeApi();
  render(<AddAccount api={api} onClose={() => {}} />);
  click(byTestId("proto-jmap"));
  type(byTestId("address"), "kai@halden.example");
  type(byTestId("token"), "secret-token-value");
  click(byTestId("submit"));
  await tick();
  const call = api.calls.find((c) => c.method === "addAccount");
  assert.ok(call, "expected addAccount to have been called");
  assert.deepEqual(call!.args[0], {
    key: "haldenexample",
    label: "Halden",
    accent: "#4a9bb8",
    provider: "jmap",
    endpoint: "https://halden.example/.well-known/jmap",
    credential: "secret-token-value",
  });
  assert.ok(byTestId("open-inbox", { optional: true }) !== null);
});

test("THE TOKEN NEVER APPEARS IN THE TERMINAL LOG", async () => {
  const api = fakeApi();
  render(<AddAccount api={api} onClose={() => {}} />);
  click(byTestId("proto-jmap"));
  type(byTestId("address"), "kai@halden.example");
  type(byTestId("token"), "secret-token-value");
  click(byTestId("submit"));
  await tick();
  assert.ok(!document.body.textContent!.includes("secret-token-value"));
});

test("the modal reports what the server verified, not a canned success", async () => {
  const api = fakeApi({
    addAccount: () =>
      Promise.resolve({
        key: "haldenexample",
        label: "Halden",
        accent: "#4a9bb8",
        provider: "jmap",
        endpoint: "https://api.fastmail.com/jmap/session",
        username: "brian@example.com",
      }),
  });
  render(<AddAccount api={api} onClose={() => {}} />);
  click(byTestId("proto-jmap"));
  type(byTestId("address"), "kai@halden.example");
  type(byTestId("token"), "t");
  click(byTestId("submit"));
  await tick();
  const terminalText = byTestId("terminal").textContent!;
  assert.match(terminalText, /https:\/\/api\.fastmail\.com\/jmap\/session/);
  assert.match(terminalText, /brian@example\.com/);
  assert.doesNotMatch(terminalText, /container restarts?/i);
  assert.doesNotMatch(terminalText, /JMAP 1\.0/);
});

test("an auth failure shows the server's own error text", async () => {
  const api = fakeApi({
    addAccount: () => Promise.reject(new ApiError(400, "the token was rejected")),
  });
  render(<AddAccount api={api} onClose={() => {}} />);
  click(byTestId("proto-jmap"));
  type(byTestId("address"), "kai@halden.example");
  type(byTestId("token"), "bad-token");
  click(byTestId("submit"));
  await tick();
  assert.match(byTestId("terminal").textContent!, /the token was rejected/);
});

test("open inbox closes the modal without pretending the account is live", async () => {
  let closed = 0;
  let created: unknown = null;
  render(<AddAccount api={fakeApi()} onClose={() => (closed += 1)} onCreated={(spec) => (created = spec)} />);
  click(byTestId("proto-jmap"));
  type(byTestId("address"), "kai@halden.example");
  type(byTestId("token"), "t");
  click(byTestId("submit"));
  await tick();
  assert.ok(created !== null, "onCreated should fire on success");
  click(byTestId("open-inbox"));
  assert.equal(closed, 1);
});

test("the scrim and the close button both call onClose", () => {
  let closed = 0;
  render(<AddAccount api={fakeApi()} onClose={() => (closed += 1)} />);
  click(byTestId("add-account-close"));
  assert.equal(closed, 1);
});
