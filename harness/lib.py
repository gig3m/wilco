#!/usr/bin/env python3
"""
The browser session every check runs in, plus the Wilco API as a second
source for what the screen shows.

What this must never do: write to any account outside WRITABLE. `guard_write`
is called by every check before a mutating action, and by `api_post` for
the mutating routes; a violation aborts the run, not the check.
"""
import json
import os
import re
import time
from collections.abc import Callable, Iterable

BASE = os.environ.get("WILCO_BASE", "https://wilcotest.example.com")
BODY_ORIGIN = os.environ.get("WILCO_BODY_BASE", "https://wilcotestbody.example.com")
# The body host as a regex fragment, so the noise rules below follow whichever
# instance is under test (2026-09-08: they named the old body host and row 6
# went red on the harness instance for a download the browser had aborted).
BODY_HOST = re.escape(BODY_ORIGIN.split("//", 1)[-1])
APP_HOST = re.escape(BASE.split("//", 1)[-1])
PASSWORD = os.environ["WILCO_KYLE_PASSWORD"]
OUT = os.environ.get("WILCO_HARNESS_OUT", "/out")

# The ONLY accounts a check may change. Spec: "Dedicated accounts".
WRITABLE = frozenset({"test-a", "test-b"})

# The app origin as a regex fragment, so the asset-noise rule below follows
# whichever instance is under test rather than a hardcoded hostname.
_BASE_RE = re.escape(BASE)

# Console/network noise that is expected and why. Anything not matched here
# fails the check. Keep the reasons specific.
EXPECTED_NOISE = [
    (r"Failed to load resource: the server responded with a status of 401",
     "Pre-login API probes. The SPA asks before it knows it has no session."),
    (r"because it violates the following Content Security Policy directive",
     "A sender's own remote asset refused by the body CSP -- the sandbox working."),
    (r"Blocked script execution in 'https://" + BODY_HOST,
     "Script in a message body, blocked by the sandbox."),
    (r":: csp \[in message body\]$",
     "A request from inside the BODY FRAME refused by its CSP. Scoped to the body frame; "
     "the same failure on the main origin still fails."),
    (r"^https://" + BODY_HOST + r"/(m|p|s)/[^ ]+ :: net::ERR_ABORTED \[in message body\]$",
     "A body frame's own document or inline part, abandoned because the reader moved to the next "
     "message before it finished loading. With the harness waiting on the app rather than sleeping "
     "(2026-09-08) the j-walk in row 7 does this on every press. The browser's cancellation, not a "
     "server failure: a 4xx/5xx on the same URL still fails the check."),
    (r"^https://" + APP_HOST + r"/api/[^ ]+ :: net::ERR_ABORTED$",
     "An API read the browser abandoned because the check navigated away before it answered "
     "(row 8's unsubscribe lookup, 2026-09-08, with the harness no longer sleeping after a "
     "triage key). The client hanging up, not the server failing: a 4xx/5xx on the same URL "
     "carries a status and still fails the check."),
    (r"/api/events :: net::ERR_ABORTED$",
     "Navigating away aborts the open SSE stream, and the browser reports the abort as a failed "
     "request. It is the client hanging up, not the server failing: a 4xx/5xx on /api/events "
     "does not match this and still fails the check. The first full run went red on every "
     "check for this alone, because unlike the old scenarios the checks navigate."),
    (BODY_HOST + r"/a/.* :: net::ERR_ABORTED$",
     "A download. Clicking an attachment navigates to the body origin's /a/ route, whose "
     "Content-Disposition: attachment turns the navigation into a save, and the browser "
     "reports the abandoned navigation as aborted. Check 6 verifies the bytes that arrived."),
    (r"/healthz :: HTTP 503$",
     "By design: /healthz answers 503 while any account is failing or stale, and the SPA polls "
     "it. Row 29's own scenario -- a broken credential -- makes this expected. A 5xx from any "
     "other route is recorded with its URL by the response listener and still fails the check."),
    (r"^Failed to load resource: the server responded with a status of 503 \(\)$",
     "The console's line for the /healthz 503 above; it carries no URL, so it cannot be scoped "
     "tighter here. The response listener's URL-bearing line is the one that decides."),
    (_BASE_RE + r"/(?:assets|fonts)/\S+ :: net::ERR_ABORTED$",
     "A font or stylesheet fetch the browser abandoned because the check navigated away before "
     "it finished (ERR_ABORTED is the client hanging up, as with /api/events above). Row 27, "
     "which navigates four times, went red on a .woff2 this way on 2026-09-07 with every "
     "assertion passing. An asset the server cannot serve reports an HTTP status or ERR_FAILED, "
     "and those still fail the check (ERR_FAILED is re-fetched and measured)."),
    (r"net::ERR_NETWORK_CHANGED$",
     "The host's network changed under the browser (Chromium reports it on any interface, "
     "route or address change) and the SPA's event stream and in-flight fetches failed with "
     "it; both reconnect on their own. Seen twice on 2026-09-06 in full runs, on rows that "
     "then passed alone. Only this error: a 4xx/5xx or any other failure still fails the check."),
    (r"/api/mailboxes :: net::ERR_ABORTED$",
     "The sidebar's folder-count refetch (row 35) cancelled by the check's own navigation, "
     "the same way as the list fetch below: a triage or a sync event bumps the refetch and "
     "page.goto lands before it returns. A 4xx/5xx from /api/mailboxes still fails the check; "
     "rows 28 and 35 measure the counts that do load."),
    (r"/api/messages\?.* :: net::ERR_ABORTED$",
     "A list fetch cancelled by the check's own navigation: page.goto while the previous "
     "page's /api/messages request is still in flight makes the browser abort it (the SPA "
     "holds no AbortController of its own). A 4xx/5xx from /api/messages does not match "
     "this and still fails the check; rows 1, 2 and 7 measure the list that does load."),
    (BODY_HOST + r"/m/.* :: net::ERR_ABORTED$",
     "A superseded body frame. Walking the list with j faster than a body loads (check 7 "
     "presses every 120ms) replaces the frame's src before the previous /m/ fetch completes, "
     "and the browser reports the cancelled load as aborted. A 4xx/5xx from /m/ does not "
     "match this and still fails the check; checks 3 and 4 measure the body that does load."),
]

MUTATING_ROUTES = re.compile(r"^/api/(triage|send|drafts|attachments|senders|identities|accounts)")
# Routes whose PATH names the account: /api/drafts/:account/:id,
# /api/attachments/:account, /api/identities/:account/..., /api/senders/:account/...,
# /api/accounts/:key/...
ACCOUNT_IN_PATH = re.compile(r"^/api/(?:drafts|attachments|identities|senders|accounts)/(?!order(?:/|$))([^/?]+)")
# `/api/accounts/order` is the OWNER's sidebar order, not an account: a
# global write that check 34 makes and restores in its finally. The negative
# lookahead keeps it from being read as account "order" and refused.


class Problem(Exception):
    pass


class WriteRefused(Exception):
    """Raised, and never caught by a check: the run stops."""


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise Problem(message)


def wait_until(pred: Callable[[], bool], what: str, timeout: float = 90, every: float = 2) -> None:
    """Polls with a bound. Nothing in the harness sleeps for a fixed time
    when it could ask instead."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(every)
    raise Problem(f"timed out after {timeout:.0f}s waiting for: {what}")


class Run:
    def __init__(self, page, context):
        self.page = page
        self.context = context
        self.accounts: list[str] = []  # known keys, longest first; filled at login
        self.console: list[str] = []
        self.failed_requests: list[str] = []
        self._failed_gets: set[str] = set()
        self.blocked: list[str] = []
        page.on("console", lambda m: self.console.append(m.text) if m.type == "error" else None)
        page.on("requestfailed", self._on_request_failed)
        # A 5xx answer is recorded WITH its URL: the console's own line for it
        # ("Failed to load resource: ... 503 ()") carries none, so this is
        # what lets a by-design 503 (/healthz while an account is failing)
        # be told apart from a broken route.
        page.on("response", lambda res: self.failed_requests.append(f"{res.url} :: HTTP {res.status}") if res.status >= 500 else None)
        # 🚨 The allow-list, enforced at the BROWSER. `api_post` guards what a
        # check sends itself; this guards what the PAGE sends -- compose
        # autosave, send, triage from a keypress. The first full run relied
        # on the From default (flow 15's defect: alphabetical, so `atelier`)
        # and the page saved a draft and sent two messages from the owner's
        # real account, straight past `api_post`. Now any mutating request
        # naming a non-test account is aborted before it leaves the page,
        # and the run stops.
        page.route(re.compile(r".*/api/.*"), self._route)

    def _route(self, route, request) -> None:
        path = request.url.split("//", 1)[-1].split("/", 1)[-1]
        path = "/" + path.split("?")[0]
        if request.method in ("POST", "PUT", "DELETE") and MUTATING_ROUTES.match(path):
            accounts: list[str] = []
            m = ACCOUNT_IN_PATH.match(path)
            if m:
                accounts.append(m.group(1))
            try:
                if request.post_data:
                    accounts += _accounts_in(json.loads(request.post_data))
            except ValueError:
                pass
            bad = sorted(set(accounts) - WRITABLE)
            if bad:
                self.blocked.append(f"{request.method} {path} -> {bad}")
                route.abort("blockedbyclient")
                return
        route.continue_()

    def _on_request_failed(self, request) -> None:
        failure = request.failure if isinstance(request.failure, str) else ""
        if request.method == "GET":
            self._failed_gets.add(request.url)
        tag = ""
        try:
            if request.frame is not None and request.frame.url.startswith(BODY_ORIGIN):
                tag = " [in message body]"
        except Exception:
            pass
        self.failed_requests.append(f"{request.url} :: {failure}{tag}")

    def unexpected(self) -> list[str]:
        out: list[str] = []
        dropped_assets = 0
        for l in self.failed_requests:
            if any(re.search(p, l) for p, _ in EXPECTED_NOISE):
                continue
            if self._still_serves(l):
                dropped_assets += 1
                continue
            out.append(l)
        for l in self.console:
            if any(re.search(p, l) for p, _ in EXPECTED_NOISE):
                continue
            # The console's own line for a failed asset carries no URL; one
            # is dropped per asset the request listener already cleared.
            if dropped_assets and l == "Failed to load resource: net::ERR_FAILED":
                dropped_assets -= 1
                continue
            out.append(l)
        return out

    def clear(self) -> None:
        self.console.clear()
        self.failed_requests.clear()
        self._failed_gets.clear()

    def _still_serves(self, line: str) -> bool:
        """A GET to our own origin the browser reported as net::ERR_FAILED with
        no HTTP status behind it. Three full runs each lost exactly one such
        request (a hashed CSS file, a font, /api/saved-searches) with the
        proxy logging 200 for it in the same second and every assertion of
        the check passing. Measured on 2026-09-07 and ruled OUT: the
        container's /dev/shm (0 MB used all run), nginx's HTTP/2 connection
        limit (4,000 requests on one connection, 0 failures), and navigation
        tearing down a cross-origin body frame (40 cycles, 0 failures).
        Origin still unknown, rate ~1 in 4,000. So the line is not
        allow-listed: the harness re-fetches the SAME URL now, with the
        session, and clears it only on a 200 -- and says so, so the count
        stays visible in every run log. A URL the server cannot serve stays
        and fails the check; a POST/PUT never qualifies."""
        m = OWN_GET_FAILED.match(line)
        if not m or m.group(1) not in self._failed_gets:
            return False
        try:
            res = self.page.request.get(m.group(1), timeout=10000)
            ok = res.ok and len(res.body()) > 0
        except Exception:
            ok = False
        if ok:
            print(f"  ~ browser-side net::ERR_FAILED, re-fetched 200 just now: {m.group(1)}", flush=True)
        return ok

    # -- navigation ------------------------------------------------------

    def login(self) -> None:
        self.page.goto(BASE + "/", wait_until="load")
        self.page.wait_for_timeout(500)  # the login form has no busy marker; the app does once it mounts
        if self.page.locator("input[type=password]").count() > 0:
            self.page.fill("input[type=password]", PASSWORD)
            self.page.keyboard.press("Enter")
            self.page.wait_for_selector("html[data-wilco-busy]", timeout=15000)
            self.settled()
        expect(self.page.locator("input[type=password]").count() == 0,
               "still on the login screen after submitting the password")
        self.clear()
        self.accounts = sorted((a["key"] for a in self.api_get("/api/accounts")), key=len, reverse=True)

    def split_key(self, key: str) -> tuple[str, str]:
        """`{account}-{id}` -> (account, id). Both halves can contain hyphens
        (`test-b`, `StmtgpAHR-Vo`), so the split is by KNOWN account key,
        longest first -- never by the first hyphen. The first version did
        that and read `test-b` as account `test`."""
        for a in self.accounts:
            if key.startswith(a + "-"):
                return a, key[len(a) + 1:]
        raise Problem(f"row key {key!r} does not start with a known account")

    # -- waiting on the app, not on the clock -------------------------------
    #
    # 2026-09-08: 384s of a 657s board run was fixed sleeps -- 75 page loads
    # each followed by 3-5s, and 97 bare waits after clicks. The app mirrors
    # its in-flight request count onto <html data-wilco-busy>; `quiet()`
    # waits for that to read "0" and STAY "0", and `goto()` waits for the
    # body frame to finish loading on top. A page load now costs what it
    # costs. `settle` is accepted and ignored so old call sites read the same.

    def quiet(self, still: int = 150, timeout: int = 20000) -> None:
        """Wait until no API request has been in flight for `still` ms."""
        self.page.wait_for_function(
            """(still) => new Promise((done) => {
                 let since = null;
                 const tick = () => {
                   const v = document.documentElement.getAttribute('data-wilco-busy');
                   const now = performance.now();
                   if (v === '0') { if (since === null) since = now; if (now - since >= still) return done(true); }
                   else since = null;
                   setTimeout(tick, 25);
               };
               tick();
             })""",
            arg=still, timeout=timeout)

    def frames_loaded(self, timeout: int = 15000) -> None:
        """Every body frame on the page has finished loading."""
        for f in self.page.frames:
            if f.url.startswith(BODY_ORIGIN):
                try:
                    f.wait_for_load_state("load", timeout=timeout)
                except Exception:
                    pass  # a frame that navigated away mid-wait is not a failure

    def settled(self, still: int = 150) -> None:
        self.quiet(still=still)
        self.frames_loaded()
        # A frame that was minted in the last quiet window may only now be
        # attaching; one more short quiet catches its mint request.
        self.quiet(still=still)
        self.frames_loaded()

    def goto(self, path: str, settle: int | None = None) -> None:
        self.page.goto(BASE + path, wait_until="load")
        self.settled()

    def reload(self) -> None:
        self.page.reload(wait_until="load")
        self.settled()

    def shot(self, name: str) -> None:
        try:
            self.page.screenshot(path=f"{OUT}/{name}.png")
        except Exception:
            pass

    # -- the screen, measured ---------------------------------------------

    def list_rows(self) -> list[tuple[str, str]]:
        """(account, id) for every rendered row, in order."""
        ids = self.page.evaluate(
            """Array.from(document.querySelectorAll('[data-testid^="row-"][role="row"]'))
               .map(e => e.getAttribute('data-testid').slice(4))""")
        return [self.split_key(k) for k in ids]

    def list_count(self) -> str:
        el = self.page.locator('[data-testid="list-count"]')
        return el.inner_text().strip() if el.count() else ""

    def reading_subject(self) -> str:
        el = self.page.locator('[data-testid="reading-subject"]')
        return el.inner_text().strip() if el.count() else ""

    def body_frame_metrics(self) -> dict | None:
        """The frame's box vs. the document inside it. Playwright can reach a
        cross-origin frame's DOM because it drives the browser; the page cannot."""
        box = self.page.evaluate(
            """(() => { const f = document.querySelector('.reading-body-frame');
                if (!f) return null; const r = f.getBoundingClientRect();
                return {frame_h: Math.round(r.height), frame_w: Math.round(r.width)}; })()""")
        if box is None:
            return None
        for fr in self.page.frames:
            if fr.url.startswith(BODY_ORIGIN):
                inner = fr.evaluate(
                    """(() => ({content_h: document.documentElement.scrollHeight,
                                chars: document.body.innerText.trim().length,
                                text: document.body.innerText,
                                imgs: document.querySelectorAll('img').length,
                                blocked: document.querySelectorAll('img[data-wilco-blocked]').length,
                                loaded: Array.from(document.querySelectorAll('img')).filter(i => i.naturalWidth > 0).length}))()""")
                return {**box, **inner}
        return box

    # -- Wilco's API, as the second source ---------------------------------

    def api_get(self, path: str):
        res = self.page.request.get(BASE + path)
        expect(res.ok, f"GET {path} -> {res.status}")
        return res.json()

    def api_post(self, path: str, body: dict):
        if MUTATING_ROUTES.match(path):
            self.guard_write(_accounts_in(body))
        res = self.page.request.post(BASE + path, data=json.dumps(body),
            headers={"content-type": "application/json", "origin": BASE, "x-wilco-csrf": "1"})
        expect(res.ok, f"POST {path} -> {res.status} {res.text()[:200]}")
        return res.json()

    def api_put(self, path: str, body: dict):
        """PUT, with the same allow-list as api_post. `page.request.put`
        directly bypassed it (the review caught three callers)."""
        m = ACCOUNT_IN_PATH.match(path)
        self.guard_write(([m.group(1)] if m else []) + _accounts_in(body))
        res = self.page.request.put(BASE + path, data=json.dumps(body),
            headers={"content-type": "application/json", "origin": BASE, "x-wilco-csrf": "1"})
        return res

    def guard_write(self, accounts: Iterable[str]) -> None:
        bad = sorted(set(accounts) - WRITABLE)
        if bad:
            raise WriteRefused(f"a check tried to write to {bad}; only {sorted(WRITABLE)} may be changed")


OWN_GET_FAILED = re.compile(r"^(" + re.escape(BASE) + r"/\S+) :: net::ERR_FAILED$")


def _accounts_in(body) -> list[str]:
    """Every `account` value anywhere in a request body."""
    found: list[str] = []
    def walk(x):
        if isinstance(x, dict):
            if isinstance(x.get("account"), str):
                found.append(x["account"])
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(body)
    return found
