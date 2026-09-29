#!/usr/bin/env python3
"""Prove the body CSP actually blocks things (audit pass 5).

The spec's §6 invariants were asserted as a STRING in several tests. The
policy was exactly what the spec said, and every link in every email was
dead: string equality proved nothing about behaviour. This proves behaviour.

Two rules make it worth running:

  * 🚨 The policy under test is FETCHED FROM THE DEPLOYED ORIGIN, never
    copied into this file. A refusal (`/m/garbage`) carries the full policy,
    so one unauthenticated request gets the real string. A hardcoded copy
    would pass forever after production drifted away from it -- which is the
    same mistake as asserting the CSP as a literal.

  * 🚨 Every invariant is run TWICE: once under the real policy, and once
    with the directive that enforces it removed. A blocked result only means
    something if the same page is NOT blocked when the protection goes away.
    Without the second run this could not tell "the CSP blocked it" from
    "the browser never tried".

What it cannot cover, stated rather than skipped: `frame-ancestors` and the
frame's own navigation containment need real cross-origin framing, so they
are asserted against the live headers in run.py instead. This file
substitutes `frame-ancestors` for a local one and reports that it did.

    ./harness/csp-probe.sh
"""

import http.server
import json
import re
import socket
import ssl
import sys
import threading
import urllib.request

BODY_ORIGIN = "https://mailbody.example.com"

# A 1x1 transparent GIF. The positive control: if this does NOT load, the
# probe is measuring its own brokenness rather than the policy.
GIF = (
    "data:image/gif;base64,"
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
)


def live_policy() -> str:
    """The real Content-Security-Policy, off the deployed body origin."""
    req = urllib.request.Request(f"{BODY_ORIGIN}/m/garbage")
    try:
        urllib.request.urlopen(req, timeout=15)
        raise SystemExit("FATAL: /m/garbage returned 200; it must refuse")
    except urllib.error.HTTPError as err:
        if err.code != 401:
            raise SystemExit(f"FATAL: /m/garbage returned {err.code}, expected 401")
        policy = err.headers.get("content-security-policy")
    if not policy:
        raise SystemExit("FATAL: the refusal carried no CSP at all")
    return policy


class Beacons:
    """Records every request and raw TCP connection an exploit would cause."""

    def __init__(self):
        self.paths: list[str] = []
        self.connections = 0
        self.lock = threading.Lock()

    def hit(self, path: str) -> None:
        with self.lock:
            self.paths.append(path)

    def got(self, tag: str) -> bool:
        with self.lock:
            return any(tag in p for p in self.paths)

    def clear(self) -> None:
        with self.lock:
            self.paths.clear()
            self.connections = 0


BEACONS = Beacons()
CASES: dict[str, tuple[str, str]] = {}  # name -> (html, policy)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence
        pass

    def do_GET(self):
        path = self.path
        if path.startswith("/beacon"):
            BEACONS.hit(path)
            self.send_response(200)
            self.send_header("content-type", "image/gif")
            self.end_headers()
            self.wfile.write(b"GIF89a")
            return
        name = path.lstrip("/").split("?")[0]
        if name not in CASES:
            self.send_response(404)
            self.end_headers()
            return
        html, policy = CASES[name]
        body = html.encode("utf8")
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-security-policy", policy)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def raw_acceptor(sock: socket.socket) -> None:
    """Counts TCP connections. `preconnect` opens one and sends no request,
    so an HTTP handler would never see it."""
    while True:
        try:
            conn, _ = sock.accept()
        except OSError:
            return
        with BEACONS.lock:
            BEACONS.connections += 1
        try:
            conn.close()
        except OSError:
            pass


def relax(policy: str, directive: str, replacement: str | None) -> str:
    """Return `policy` with one directive replaced or dropped -- the mutation
    that must make the protection disappear."""
    parts = [p.strip() for p in policy.split(";") if p.strip()]
    out = []
    for p in parts:
        if p.split(" ")[0] == directive or p == directive:
            if replacement is not None:
                out.append(replacement)
        else:
            out.append(p)
    return "; ".join(out)


def main() -> int:
    policy = live_policy()
    print(f"policy under test (fetched from {BODY_ORIGIN}):")
    for d in policy.split(";"):
        print(f"    {d.strip()}")

    # frame-ancestors names the production app origin and cannot be satisfied
    # by a local page. Substituted, and said out loud.
    local_policy = relax(policy, "frame-ancestors", "frame-ancestors 'none'")
    print("\n  NOTE: frame-ancestors substituted for the local run; it is")
    print("        asserted against the live headers in run.py instead.\n")

    http_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = http_srv.server_port
    threading.Thread(target=http_srv.serve_forever, daemon=True).start()

    raw = socket.socket()
    raw.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    raw.bind(("127.0.0.1", 0))
    raw.listen(16)
    raw_port = raw.getsockname()[1]
    threading.Thread(target=raw_acceptor, args=(raw,), daemon=True).start()

    B = f"http://127.0.0.1:{port}"

    # name: (html, enforcing policy, relaxed policy, check(page, beacons))
    # Each check returns (blocked_ok, evidence).
    cases = [
        (
            "script",
            f"<title>clean</title><script>document.title='EXECUTED';"
            f"fetch('{B}/beacon/script')</script>"
            f"<img src=x onerror=\"document.title='EXECUTED'\">",
            local_policy,
            relax(local_policy, "sandbox", "script-src 'unsafe-inline'"),
            "script executed",
        ),
        (
            "remote-image",
            f"<img src='{B}/beacon/remote-img'>",
            local_policy,
            relax(local_policy, "img-src", "img-src *"),
            "remote image fetched",
        ),
        (
            "form",
            f"<form action='{B}/beacon/form' method='GET'>"
            f"<button id=go type=submit>go</button></form>",
            local_policy,
            relax(relax(local_policy, "form-action", None), "sandbox", "sandbox allow-forms"),
            "form submitted",
        ),
        (
            # 🚨 What `base-uri 'none'` actually guarantees is `document.baseURI`,
            # NOT subresource URLs. Measured here: with the directive in force
            # Chromium logs "Refused to set the document's base URI" and
            # baseURI stays the document's own -- and the <img> STILL loads
            # from the refused base, because the preload scanner resolved it
            # at parse time. So this case asserts baseURI, which is the real
            # guarantee. The subresource half is the SANITIZER's job (<base>
            # is stripped outright) and is pinned in test/sanitize.test.ts.
            #
            # An earlier version of this case asserted the image and reported
            # WEAK, then FAIL -- both times because it was measuring the wrong
            # directive. img-src is widened on both runs so nothing else can
            # account for the difference.
            "base-uri",
            f"<base href='{B}/beacon/'><img src='base-hijack'>",
            relax(local_policy, "img-src", "img-src *"),
            relax(relax(local_policy, "img-src", "img-src *"), "base-uri", None),
            "the document base URI was redirected",
        ),
        (
            # `prefetch`, not `preconnect`. See the report at the end for why.
            "link-prefetch",
            f"<link rel=prefetch href='http://127.0.0.1:{raw_port}/leak'>",
            local_policy,
            relax(local_policy, "default-src", "default-src *"),
            "a <link> reached the network",
        ),
    ]

    for name, html, enforcing, relaxed, _ in cases:
        CASES[f"{name}-on"] = (f"<!doctype html><meta charset=utf-8>{html}", enforcing)
        CASES[f"{name}-off"] = (f"<!doctype html><meta charset=utf-8>{html}", relaxed)
    CASES["control-on"] = (
        f"<!doctype html><meta charset=utf-8><img id=i src='{GIF}'>",
        local_policy,
    )

    from playwright.sync_api import sync_playwright

    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])

        def run(case: str, interact=None) -> dict:
            BEACONS.clear()
            page = browser.new_page()
            page.goto(f"{B}/{case}", wait_until="load")
            if interact:
                interact(page)
            page.wait_for_timeout(1200)
            state = {
                "title": page.title(),
                "base_uri": page.evaluate("() => document.baseURI"),
                "beacons": list(BEACONS.paths),
                "connections": BEACONS.connections,
                "img_loaded": page.evaluate(
                    "() => { const i = document.querySelector('img');"
                    " return !!(i && i.naturalWidth > 0); }"
                ),
            }
            page.close()
            return state

        def click_go(page):
            try:
                page.click("#go", timeout=2000)
            except Exception:
                pass

        # -- positive control ------------------------------------------
        ctl = run("control-on")
        if not ctl["img_loaded"]:
            failures.append(
                "CONTROL FAILED: a data: image did not load under the real policy. "
                "Every 'blocked' result below is meaningless until this passes."
            )
            print("  FAIL  control        a data: image did not load")
        else:
            print("  ok    control        a data: image loads (the probe can see success)")

        checks = [
            ("script", lambda s: s["title"] != "EXECUTED" and not any("script" in b for b in s["beacons"]), None),
            ("remote-image", lambda s: not any("remote-img" in b for b in s["beacons"]), None),
            ("form", lambda s: not any("/beacon/form" in b for b in s["beacons"]), click_go),
            ("base-uri", lambda s: "/beacon/" not in s["base_uri"], None),
            ("link-prefetch", lambda s: s["connections"] == 0, None),
        ]

        for name, blocked, interact in checks:
            on = run(f"{name}-on", interact)
            off = run(f"{name}-off", interact)
            enforced = blocked(on)
            still_blocked_when_relaxed = blocked(off)

            if not enforced:
                failures.append(f"{name}: NOT BLOCKED under the real policy -- {on}")
                print(f"  FAIL  {name:<14} not blocked under the real policy")
            elif still_blocked_when_relaxed:
                failures.append(
                    f"{name}: blocked even with the directive removed -- the test proves nothing. {off}"
                )
                print(f"  WEAK  {name:<14} still blocked with the directive REMOVED;")
                print("                       this test would pass with no protection at all")
            else:
                print(f"  ok    {name:<14} blocked, and NOT blocked once the directive is removed")

        browser.close()

    http_srv.shutdown()
    raw.close()

    print()
    print("On spec 6.4 (`<link>` is stripped because preconnect bypasses CSP):")
    print("  That claim is NOT REPRODUCIBLE here and is neither confirmed nor")
    print("  refuted by this probe. Measured: `<link rel=preconnect>` at a")
    print("  loopback http target opens no connection EVEN WITH NO POLICY AT")
    print("  ALL, so there is nothing for a policy to fail to block -- the")
    print("  spec's original probe was presumably against a real https origin,")
    print("  where Chromium speculates differently. `<link rel=prefetch>` does")
    print("  connect unpoliced and IS blocked by `default-src`, which is what")
    print("  the link-prefetch case above measures.")
    print("  Stripping <link> stays correct either way, and is covered by")
    print("  test/sanitize.test.ts. What changes is the JUSTIFICATION: it is")
    print("  defence in depth here, not a proven CSP bypass.")
    print()
    if failures:
        print(f"{len(failures)} problem(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("every invariant blocked under the real policy, and each was proven")
    print("to depend on the directive that enforces it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
