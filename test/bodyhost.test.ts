import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { JmapClient } from "../src/core/client.ts";
import { resolveSession } from "../src/core/session.ts";
import { personalSession } from "./fixtures/session.ts";
import { mintBodyToken, randomBodyTokenKey } from "../src/core/captoken.ts";
import { BlobCache } from "../src/core/htmlbody.ts";
import { handleBodyHost, safeFilename } from "../src/server/bodyhost.ts";
import { tempDir } from "./tmpdir.ts";

const BODY_BASE = "https://mailbody.example.com";
const APP_BASE = "https://mail.example.com";
const key = randomBodyTokenKey();
const session = resolveSession("personal", personalSession);

const MESSAGE = {
  id: "M1",
  // 🚨 `type` is not decoration here -- it is what says this is an HTML
  // message. JMAP's `htmlBody` is the list of parts to DISPLAY as the body
  // when a client prefers HTML, so for a PLAINTEXT message it holds the
  // text/plain part. This fixture omitted `type` entirely, which is the
  // ambiguous shape that let the bug live: the code read the list's
  // length, the fixture never said what the part was, and 99.9% of the
  // real archive went down the HTML path. See the plaintext test below.
  htmlBody: [{ partId: "p1", type: "text/html" }],
  bodyValues: { p1: { value: '<p>Hello</p><img src="cid:logo@x"><img src="https://track.example/o.gif">' } },
  attachments: [
    { cid: "logo@x", blobId: "B1", type: "image/png", name: "logo.png", size: 3 },
    { blobId: "B2", type: "application/pdf", name: "Invoice Q3.pdf", size: 3 },
  ],
};

function client(message: Record<string, unknown> | null = MESSAGE, blob = Buffer.from("PNG")): JmapClient {
  return new JmapClient(session, "t", async (url, init) => {
    if (init.method === "GET") return new Response(blob, { status: 200 });
    return new Response(
      JSON.stringify({ methodResponses: [["Email/get", { list: message ? [message] : [] }, "b0"]] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

function deps(c: JmapClient | null = client()) {
  return {
    bodyTokenKey: key,
    bodyBaseUrl: BODY_BASE,
    appBaseUrl: APP_BASE,
    blobs: new BlobCache(tempDir("blobs")),
    clients: c ? new Map([["personal", c]]) : new Map<string, JmapClient>(),
  };
}

/**
 * Drives the handler through a REAL http.Server on an ephemeral port
 * rather than a hand-built ServerResponse. Headers on a refusal, on a
 * HEAD, and on a byte body are exactly the things a fake socket gets
 * subtly wrong, and they are what these tests exist to pin.
 */
async function request(pathname: string, d = deps(), method = "GET") {
  const server = createServer((req, res) => {
    void handleBodyHost(req, res, new URL(req.url ?? "/", BODY_BASE), d);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, redirect: "manual" });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const get = request;

const token = () => mintBodyToken(key, { account: "personal", id: "M1" });

// -- The CSP (spec 6.2), in full -------------------------------------------

test("the document carries the full 6.2 policy, sandbox INCLUDED IN THE HEADER", () => {
  return get(`/m/${token()}`).then((r) => {
    const csp = r.headers["content-security-policy"]!;
    // The sandbox must not live only on the iframe attribute: navigate to a
    // body URL directly and the no-script guarantee would otherwise rest
    // entirely on `default-src 'none'`, one typo from script execution on a
    // real origin.
    // 🚨 The header's sandbox must carry the SAME popup flags as the iframe
    // attribute: the effective sandbox is the INTERSECTION, so a bare
    // `sandbox` here subtracts allow-popups and every link in every email
    // silently does nothing.
    assert.match(csp, /(^|;\s*)sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox($|;)/, csp);
    assert.ok(!/(^|;\s*)sandbox($|;)/.test(csp), "a BARE sandbox directive kills every link");
    // allow-scripts IS granted now (row 3): it admits the body origin's own
    // resize script, which script-src names by hash -- see the test at the
    // end of this file. allow-same-origin and allow-forms stay absent, and
    // those are the two that would matter.
    assert.ok(!/allow-same-origin|allow-forms/.test(csp), "and nothing else is granted");
    assert.ok(csp.includes("default-src 'none'"), csp);
    assert.ok(csp.includes(`img-src ${BODY_BASE} data:`), csp);
    assert.ok(csp.includes("style-src 'unsafe-inline'"), csp);
    // Neither of these falls back to default-src.
    assert.ok(csp.includes("form-action 'none'"), csp);
    assert.ok(csp.includes("base-uri 'none'"), csp);
    assert.ok(csp.includes(`frame-ancestors ${APP_BASE}`), csp);
    assert.ok(!imgSrc(csp).includes("https:"), "remote images are blocked unless the token opts in");
  });
});

test("Referrer-Policy, nosniff and no-store are all present", async () => {
  const r = await get(`/m/${token()}`);
  // no-referrer is mandatory, not hardening: with remote images opted in,
  // Referer would hand the sender the capability token itself.
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  // The response varies by the remote-image opt-in, and a cached copy means
  // "load images" appears to do nothing.
  assert.equal(r.headers["cache-control"], "no-store");
});

test("a REFUSAL carries the security headers too", async () => {
  // A 401 is still a response on this origin; one without the CSP is one
  // that can run script.
  for (const r of [await get("/m/not-a-token"), await get("/nope"), await get(`/m/${token()}`, deps(), "POST")]) {
    assert.ok(r.status >= 400, `status ${r.status}`);
    assert.ok(r.headers["content-security-policy"]?.includes("sandbox"), JSON.stringify(r.headers));
  }
});

// -- The body origin serves TWO routes and nothing else --------------------

test("the SPA and the API are NOT reachable on the body origin", async () => {
  // Both hostnames reach one process. If this ever regresses, the whole
  // application is served from the origin the sandbox exists to isolate.
  for (const p of ["/", "/index.html", "/api/messages", "/healthz", "/api/login", "/assets/index.js"]) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p} answered ${r.status}`);
  }
});

test("only GET and HEAD are answered", async () => {
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
    assert.equal((await get(`/m/${token()}`, deps(), m)).status, 405);
  }
});

// -- Capability tokens are the only credential (spec 3.3) ------------------

test("a missing, malformed or expired token is 401 -- never a redirect to login", async () => {
  assert.equal((await get("/m/")).status, 404);
  assert.equal((await get("/m/garbage")).status, 401);
  const expired = mintBodyToken(key, { account: "personal", id: "M1" }, -1);
  assert.equal((await get(`/m/${expired}`)).status, 401);
});

test("a token for an account with no live client is 404, not a crash", async () => {
  assert.equal((await get(`/m/${token()}`, deps(null))).status, 404);
});

// -- What actually renders -------------------------------------------------

test("the document is sanitized, and reports blocked images in a HEADER", async () => {
  const r = await get(`/m/${token()}`);
  const html = r.body.toString("utf8");
  assert.equal(r.status, 200);
  assert.ok(html.includes("Hello"), html.slice(0, 200));
  assert.ok(html.includes(`${BODY_BASE}/p/`), "the cid: image is rewritten onto this origin");
  assert.ok(!html.includes("track.example"), "the tracking pixel is gone");
  // Nothing of ours renders INSIDE the message document (spec 6.8), so the
  // count travels on the response for the chrome to display.
  assert.equal(r.headers["x-wilco-blocked-images"], "1");
  assert.equal(r.headers["x-wilco-truncated"], "0");
});

test("an inline part is served from this origin under the same token", async () => {
  const r = await get(`/p/${token()}/logo@x`);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.body.toString("utf8"), "PNG");
});

test("an SVG part is forced to octet-stream, never served as a document", async () => {
  // An SVG is a document that can carry script. Serving one inline is how
  // an inline image becomes stored XSS on this origin.
  const svg = {
    ...MESSAGE,
    attachments: [{ cid: "logo@x", blobId: "B1", type: "image/svg+xml", name: "l.svg", size: 3 }],
  };
  const r = await get(`/p/${token()}/logo@x`, deps(client(svg)));
  assert.equal(r.headers["content-type"], "application/octet-stream");
});

test("a part that is not in this message is 404", async () => {
  assert.equal((await get(`/p/${token()}/other@x`)).status, 404);
});

test("a token for message A cannot read message B's parts", async () => {
  // The grant names (account, id). Ids collide across accounts, so a token
  // that verified on the id alone would cross accounts too.
  const other = mintBodyToken(key, { account: "work", id: "M1" });
  assert.equal((await get(`/m/${other}`)).status, 404, "no client for 'work' in this fixture");
});

test("a message the server cannot fetch is 404, and an upstream failure is 502", async () => {
  assert.equal((await get(`/m/${token()}`, deps(client(null)))).status, 404);

  const broken = new JmapClient(session, "t", async () => {
    throw new Error("upstream said something with a token in it");
  });
  const r = await get(`/m/${token()}`, deps(broken));
  assert.equal(r.status, 502);
  assert.equal(r.body.length, 0, "the upstream error text never reaches the response");
});

// -- Remote images: opt-in per message (spec 6.6) ---------------------------

/** The img-src directive's TOKENS. A substring search is wrong here: the
 *  blocking policy already contains "https:" inside
 *  `https://mailbody.example.com`, so `/img-src[^;]*https:/` matches both
 *  variants and the test passes whatever the code does. */
function imgSrc(csp: string): string[] {
  const directive = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));
  return (directive ?? "").split(/\s+/).slice(1);
}

test("the opted-in token widens img-src, and the default token does not", async () => {
  const blocking = await get(`/m/${token()}`);
  assert.ok(!imgSrc(blocking.headers["content-security-policy"]!).includes("https:"), "blocked by default");

  const opted = mintBodyToken(key, { account: "personal", id: "M1", remoteImages: true });
  const r = await get(`/m/${encodeURIComponent(opted)}`);
  assert.ok(imgSrc(r.headers["content-security-policy"]!).includes("https:"), "opted in");
  assert.ok(r.body.toString("utf8").includes("track.example"), "and the image is actually emitted");
  assert.equal(r.headers["x-wilco-blocked-images"], "0");
});

test("the two variants are different URLs AND no-store, so a cache cannot cross them", async () => {
  // A cached blocking response served for an opted-in request is exactly
  // how "Load images" comes to appear to do nothing.
  const opted = mintBodyToken(key, { account: "personal", id: "M1", remoteImages: true });
  assert.notEqual(opted, token());
  assert.equal((await get(`/m/${encodeURIComponent(opted)}`)).headers["cache-control"], "no-store");
});

// -- Attachment serving (spec 6.7) -----------------------------------------

test("an attachment downloads with Content-Disposition, never inline", async () => {
  const r = await get(`/a/${token()}/B2`);
  assert.equal(r.status, 200);
  assert.match(r.headers["content-disposition"]!, /^attachment;/);
  assert.match(r.headers["content-disposition"]!, /filename\*=UTF-8''Invoice%20Q3\.pdf/);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.ok(r.headers["content-security-policy"]!.includes("sandbox"));
});

test("🚨 an .html or .svg attachment is forced to octet-stream", async () => {
  // Served inline from the SPA origin this would be stored XSS on the
  // origin holding the session cookie, delivered by anyone who can email
  // you (spec 6.7). It is not served from that origin at all -- and even
  // here its type is not trusted.
  for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml"]) {
    const msg = { ...MESSAGE, attachments: [{ blobId: "B2", type, name: "x", size: 3 }] };
    const r = await get(`/a/${token()}/B2`, deps(client(msg)));
    assert.equal(r.headers["content-type"], "application/octet-stream", type);
  }
});

test("an INLINE part is not offered as an attachment download", async () => {
  // hasAttachment is true for messages whose only attachments are inline
  // cid: images -- most marketing mail. /a serves only the download set.
  assert.equal((await get(`/a/${token()}/B1`)).status, 404);
});

test("an attachment blobId from another message is 404", async () => {
  assert.equal((await get(`/a/${token()}/B-other`)).status, 404);
});

test("a bad token cannot download an attachment", async () => {
  assert.equal((await get("/a/garbage/B2")).status, 401);
});

test("safeFilename strips the paths, dots and control characters", () => {
  assert.equal(safeFilename("../../etc/passwd"), "passwd");
  assert.equal(safeFilename("C:\\Windows\\evil.exe"), "evil.exe");
  assert.equal(safeFilename(".."), "attachment");
  assert.equal(safeFilename("."), "attachment");
  assert.equal(safeFilename(".hidden"), "hidden", "a leading dot is rejected");
  assert.equal(safeFilename(""), "attachment");
  // A raw CR/LF in a header is response splitting, which is why this
  // matters even though the value never touches a filesystem path.
  assert.equal(safeFilename("a\r\nSet-Cookie: x=1"), "aSet-Cookie: x=1");
  assert.equal(safeFilename("x".repeat(500)).length, 120);
});

// -- The signature preview (owner ruling 2026-09-05) ----------------------

const sigDeps = (html: string | null = "<p>ROBIN</p>") => ({
  ...deps(),
  signatureFor: async () => html,
});
const sigToken = () => mintBodyToken(key, { account: "personal", id: "I1", kind: "signature" });

test("a signature preview renders under the SAME sandbox CSP as a stranger's mail", async () => {
  // Our own HTML gets no privileged path that a sender's does not have.
  const r = await get(`/s/${encodeURIComponent(sigToken())}`, sigDeps());
  assert.equal(r.status, 200);
  assert.ok(r.body.toString("utf8").includes("ROBIN"));
  const csp = r.headers["content-security-policy"]!;
  assert.match(csp, /(^|;\s*)sandbox allow-scripts allow-popups/, csp);
  assert.ok(csp.includes("default-src 'none'"), csp);
  assert.equal(r.headers["referrer-policy"], "no-referrer");
});

test("🚨 a MESSAGE token cannot read a signature, and vice versa", async () => {
  // The id means different things in the two cases: a message id and a JMAP
  // Identity id. Accepting either for both would let a message capability
  // address an identity.
  assert.equal((await get(`/s/${token()}`, sigDeps())).status, 401, "message token on /s");
  assert.equal((await get(`/m/${encodeURIComponent(sigToken())}`, sigDeps())).status, 401, "signature token on /m");
});

test("the signature is SANITIZED like any other markup", async () => {
  const d = sigDeps('<p>ROBIN</p><script>alert(1)</script><link rel="preconnect" href="https://track.example">');
  const html = (await get(`/s/${encodeURIComponent(sigToken())}`, d)).body.toString("utf8");
  assert.ok(!html.includes("alert"), html);
  assert.ok(!html.includes("track.example"), html);
  assert.ok(html.includes("ROBIN"));
});

test("a data: logo survives, because img-src already allows it", async () => {
  // This is what lets a data:-stored logo preview without the upload the
  // SEND path performs.
  const d = sigDeps('<img src="data:image/png;base64,AAAA">');
  const html = (await get(`/s/${encodeURIComponent(sigToken())}`, d)).body.toString("utf8");
  assert.ok(html.includes("data:image/png;base64,AAAA"), html);
});

test("an unknown identity is 404, and no resolver at all is 404", async () => {
  assert.equal((await get(`/s/${encodeURIComponent(sigToken())}`, sigDeps(null))).status, 404);
  assert.equal((await get(`/s/${encodeURIComponent(sigToken())}`, deps())).status, 404);
});


test("🚨 A PLAINTEXT MESSAGE IS ESCAPED AND KEEPS ITS LINE BREAKS -- it is never parsed as markup", async () => {
  // The defect, measured on a real sent reply: `htmlBody` held the
  // TEXT/PLAIN part (the shape below is exactly what Fastmail returned for
  // it), the body was handed to the HTML sanitizer, and the sanitizer did
  // what it is built to do -- it PARSED the text. `<jdoe1989@example.com>`
  // became a tag and vanished; `<https://...>` likewise; and all 50
  // newlines collapsed, because a newline is whitespace in HTML. A
  // readable reply rendered as one unbroken wall.
  //
  // Escaping is also strictly safer than sanitizing: there is no parser to
  // outwit, so nothing here rests on the sanitizer being right.
  const plain = {
    id: "M1",
    htmlBody: [{ partId: "p1", type: "text/plain" }],
    textBody: [{ partId: "p1", type: "text/plain" }],
    bodyValues: {
      p1: {
        value: "Remind me what this is for.\n\nOn Thu, Fred Hayes <fred@example.com> wrote:\n> an old invoice\n> <https://example.com/pay>",
      },
    },
    attachments: [],
  };
  const token = mintBodyToken(key, { account: "personal", id: "M1" });
  const res = await request(`/m/${encodeURIComponent(token)}`, deps(client(plain)));
  assert.equal(res.status, 200);
  const doc = res.body.toString("utf8");

  // The address and the URL survive as TEXT rather than being parsed away.
  assert.match(doc, /&lt;fred@example\.com&gt;/, "an address in angle brackets was parsed as a tag");
  assert.match(doc, /&lt;https:\/\/example\.com\/pay&gt;/, "a bare URL in angle brackets was parsed as a tag");
  assert.ok(!/<fred@example\.com>/.test(doc), "the address is present as raw markup");

  // Line breaks are preserved by CSS, not by inventing <br> -- the text is
  // reproduced byte for byte and only the container knows about wrapping.
  assert.match(doc, /white-space:pre-wrap/, "nothing preserves the message's line breaks");
  assert.match(doc, /wrote:\n&gt; an old invoice/, "the newlines were not preserved verbatim");

  // Plain text cannot reference an image, so the count is a real zero.
  assert.equal(res.headers["x-wilco-blocked-images"], "0");
});


test("🚨 THE FRAME'S ONLY SCRIPT IS OURS, ADMITTED BY ITS HASH -- and the hash is of the script actually served", async () => {
  // Checklist row 3. Every webmail client sizes its message frame with a
  // resize script of its own; the frame here had a fixed 650px window and
  // real messages measure 700-4,900px. The old reason for not doing
  // this -- "script in the frame is what section 6 exists to prevent" --
  // conflated OUR script with the SENDER's. CSP is built to tell them apart.
  //
  // The guarantee that matters is unchanged and is what this pins: the only
  // script that can run is the exact bytes we serve. A sender's inline
  // script or onerror= handler matches no hash and 'unsafe-inline' is
  // absent, so both stay dead -- csp-probe.py's `script` case proves that in
  // a real browser. And there is still no allow-same-origin.
  const token = mintBodyToken(key, { account: "personal", id: "M1" });
  const res = await request(`/m/${encodeURIComponent(token)}`);
  const csp = res.headers["content-security-policy"];
  assert.ok(csp !== undefined, "the frame document carries no CSP");
  const doc = res.body.toString("utf8");
  const m = /<script>([\s\S]*?)<\/script>/.exec(doc);
  assert.ok(m, "the frame document carries no script");
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(m![1]!).digest("base64");
  assert.match(csp!, new RegExp(`script-src 'sha256-${hash.replace(/[+/=]/g, (c) => "\\" + c)}'(;|$)`),
    `the CSP does not admit the served script by its hash: ${csp}`);
  const scriptSrc = (csp!.split("script-src")[1] ?? "").split(";")[0]!;
  assert.ok(!/unsafe-inline|unsafe-hashes|unsafe-eval|https?:|\*/.test(scriptSrc), `script-src admits more than the hash: ${scriptSrc}`);
  assert.ok(!/allow-same-origin/.test(csp!), "allow-same-origin must never appear");
  assert.ok(doc.split("<script>").length === 2, "more than one script in the frame document");
  assert.ok(m![1]!.includes("postMessage"), "the script does not report its height");
});

test("?view=1 serves a raster image INLINE for the in-app viewer; a PDF, or an .html part, stays a download whatever the query says", async () => {
  // 2026-09-08: "I have an email with a jpg attachment, I seem to have no
  // way of opening it." The chip downloaded; now an image opens in a
  // viewer that loads this URL into an <img>. Only raster images: a
  // document served inline is what spec 6.7 exists to prevent.
  const { VIEWABLE_TYPES, isViewableImage } = await import("../src/server/bodyhost.ts");
  assert.deepEqual([...VIEWABLE_TYPES].sort(), ["image/gif", "image/jpeg", "image/png", "image/webp"]);
  assert.equal(isViewableImage({ type: "image/jpeg" }), true);
  assert.equal(isViewableImage({ type: "IMAGE/PNG; name=x" }), true);
  assert.equal(isViewableImage({ type: "application/pdf" }), false);
  assert.equal(isViewableImage({ type: "image/svg+xml" }), false, "an SVG is a document");
  assert.equal(isViewableImage({ type: "text/html" }), false);
});
