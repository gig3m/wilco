"""
One function per checklist row. `CHECKS[n]` is `check_NN`. A check raises
lib.Problem with a sentence a person would understand; anything else it
raises is an error in the check.

What a check must never do: write outside test-a/test-b (lib and jmap
enforce it), sleep for a fixed time when it could wait_until, or assert
that an element exists when it could measure what the element says.
"""
import base64
import calendar
import json
import os
import re
import struct
import time
import urllib.parse
import zlib
from dataclasses import dataclass
from collections.abc import Callable

from lib import Run, Problem, expect, wait_until, WRITABLE, BASE, BODY_ORIGIN
from lib import OUT
from fixtures import Fixtures, PREFIX, PDF_BYTES


@dataclass
class Ctx:
    run: Run
    J: dict          # key -> Jmap
    F: Fixtures


CHECKS: dict[int, Callable[[Ctx], None]] = {}


def check(n: int):
    def reg(fn):
        CHECKS[n] = fn
        return fn
    return reg


# -- Read ---------------------------------------------------------------

@check(1)
def check_01(c: Ctx) -> None:
    """Unified inbox = the union of per-account inboxes, by account and count."""
    r = c.run
    accounts = [a["key"] for a in r.api_get("/api/accounts")]
    per: dict[str, set] = {}
    for a in accounts:
        r.goto(f"/inbox/{a}")
        rows = r.list_rows()
        foreign = sorted({x for x, _ in rows} - {a})
        expect(not foreign, f"/inbox/{a} shows rows from other accounts: {foreign}")
        per[a] = set(rows)
    r.goto("/inbox")
    unified = set(r.list_rows())
    union = set().union(*per.values())
    # The list is capped at one page; compare on the page that exists.
    missing = union - unified
    expect(len(unified) >= min(len(union), 200), f"All inboxes shows {len(unified)} rows; the accounts' inboxes hold {len(union)}")
    expect(not missing or len(unified) >= 200, f"rows in a per-account inbox are absent from All inboxes: {sorted(missing)[:5]}")
    total = int(r.list_count().split("·")[0].strip().replace(",", ""))
    expect(total == len(union), f"All inboxes says {total}, the per-account inboxes sum to {len(union)}")
    # Merged newest-first, not grouped by account: the on-screen order must
    # match the API's receivedAt order.
    api_rows = r.api_get("/api/messages?role=inbox&limit=200")["rows"]
    expected = [(m["account"], m["id"]) for m in api_rows]
    shown = r.list_rows()
    expect(shown == expected[:len(shown)], "All inboxes is not in the API's newest-first order")
    # The header's unread half must agree with the sidebar's inbox rows.
    unread_hdr = int(r.list_count().split("·")[1].split()[0].replace(",", ""))
    boxes = r.api_get("/api/mailboxes")["accounts"]
    unread_sum = sum(m["unread"] for a in boxes for m in a["mailboxes"] if m.get("role") == "inbox")
    expect(unread_hdr == unread_sum, f"All inboxes says {unread_hdr} unread; the inboxes sum to {unread_sum}")


@check(2)
def check_02(c: Ctx) -> None:
    """Open a message from a unified view; the list must not change."""
    r = c.run
    for path in ("/inbox", "/archive"):
        r.goto(path)
        before = r.list_rows(); count_before = r.list_count()
        expect(len(before) >= 2, f"{path} has too few rows to test with")
        # A test-account row if there is one; otherwise an owner row that is
        # already READ, so the read-on-open dwell has nothing to write.
        target = next(((a, i) for a, i in before if a in WRITABLE), None)
        if target is None:
            target = next((a, i) for a, i in before if not r.api_get(f"/api/messages/{a}/{i}")["isUnread"])
        wanted = r.page.locator(f'[data-testid="row-subject-{target[0]}-{target[1]}"]').inner_text().strip()
        r.page.locator(f'[data-testid="row-{target[0]}-{target[1]}"]').click()
        r.settled()
        after = r.list_rows()
        expect(after == before, f"{path}: opening {target} changed the list from {len(before)} rows to {len(after)}")
        expect(r.list_count() == count_before, f"{path}: header went from {count_before!r} to {r.list_count()!r}")
        expect(r.reading_subject() == wanted, f"the reading pane shows {r.reading_subject()!r}, the clicked row was {wanted!r}")
        expect(r.page.locator(f'[data-testid="row-{target[0]}-{target[1]}"]').get_attribute("aria-selected") == "true",
               "the clicked row is not marked selected")


def _fullest_archive(c: Ctx) -> tuple[str, int]:
    """(account, total) of the biggest Archive: the owner's on production,
    test-a's imported corpus on the harness instance (2026-09-08)."""
    boxes = c.run.api_get("/api/mailboxes")["accounts"]
    archives = [(m.get("total") or 0, a["account"]) for a in boxes for m in a["mailboxes"] if m.get("role") == "archive"]
    expect(archives != [], "no account has an archive")
    total, acct = max(archives)
    return acct, total


@check(3)
def check_03(c: Ctx) -> None:
    """The message is fully visible: the frame is as tall as its content and
    the content is not clipped -- for the fixture HTML (2,000px+) and for
    five real messages from the archive."""
    r = c.run
    targets = [(c.F["html"]["account"], c.F["html"]["id"])]
    # Five real HTML messages, chosen by the API's own flag, and already
    # read so the dwell writes nothing to an owner account.
    # List rows do not carry hasHtml; the detail does. Probe the newest
    # read messages until five HTML ones are found.
    acct, _ = _fullest_archive(c)
    archive = r.api_get(f"/api/messages?account={acct}&role=archive&limit=200")["rows"]
    for m in archive:
        if len(targets) >= 6:
            break
        if m["isUnread"]:
            continue
        if r.api_get(f"/api/messages/{m['account']}/{m['id']}")["hasHtml"] is True:
            targets.append((m["account"], m["id"]))
    expect(len(targets) >= 4, "could not find real HTML messages to measure")
    slack = 40  # padding, border
    measured = 0
    for acct, mid in targets:
        r.goto(f"/inbox/{acct}/{mid}" if acct in WRITABLE else f"/archive/{acct}/{mid}")
        m = r.body_frame_metrics()
        expect(m is not None and "content_h" in m, f"{acct}/{mid}: an HTML message rendered no body frame at all")
        measured += 1
        expect(m["chars"] > 0, f"{acct}/{mid}: the frame rendered no text at all")
        expect(m["frame_h"] + slack >= m["content_h"],
               f"{acct}/{mid}: content is {m['content_h']}px tall inside a {m['frame_h']}px frame -- a scroll box inside a scroll pane")
        expect(m["frame_h"] <= m["content_h"] + 400,
               f"{acct}/{mid}: {m['frame_h'] - m['content_h']}px of empty frame below a {m['content_h']}px message")
    expect(measured == len(targets), "not every target was measured")


@check(4)
def check_04(c: Ctx) -> None:
    """Plaintext keeps line breaks and angle-bracketed text; HTML renders as
    HTML; the multipart fixture shows its HTML half."""
    r = c.run
    p = c.F["plain"]
    r.goto(f"/inbox/{p['account']}/{p['id']}")
    api = r.api_get(f"/api/messages/{p['account']}/{p['id']}")
    expect(api["hasHtml"] is False, "the plaintext fixture is flagged hasHtml")
    body = r.page.locator('[data-testid="body"]')
    expect(body.count() == 1, "no plaintext body rendered")
    text = body.inner_text()
    expect(text.startswith("Line one\nLine two"), f"the plaintext body is not reproduced line for line: {text[:60]!r}")
    # The angle-bracketed address is in the QUOTED part, folded behind the
    # toggle by design. Expand it; the quote is where a parser would have
    # eaten it.
    r.page.locator('[data-testid="quote-toggle"]').click(); r.settled()
    quoted = r.page.locator('[data-testid="quoted-body"]').inner_text()
    expect("<addr@example.com>" in quoted, "an address in angle brackets was eaten as a tag")
    expect("<https://example.com/x>" in quoted, "a bare URL in angle brackets was eaten as a tag")
    chip = r.page.locator('[data-testid="body-type-chip"]')
    expect(chip.count() == 1 and chip.inner_text().strip() == "text/plain", "the type chip does not say text/plain")

    h = c.F["html"]
    r.goto(f"/inbox/{h['account']}/{h['id']}")
    expect(r.api_get(f"/api/messages/{h['account']}/{h['id']}")["hasHtml"] is True, "the HTML fixture is not flagged hasHtml")
    m = r.body_frame_metrics()
    expect(m is not None and "text" in m, "no body frame for the HTML fixture")
    expect("Fixture HTML" in m["text"] and "Paragraph 39" in m["text"], "the HTML half did not render (fallback text or truncated)")
    expect("Fixture HTML fallback text" not in m["text"], "the multipart fixture rendered its PLAINTEXT half")
    # Rendered as markup, not shown as escaped text.
    expect("<h1>" not in m["text"], "the HTML arrived as escaped text, not rendered markup")
    h1 = next(fr for fr in r.page.frames if fr.url.startswith(BODY_ORIGIN)).evaluate("document.querySelectorAll('h1').length")
    expect(h1 == 1 and m["imgs"] == 1, f"the frame has {h1} h1 and {m['imgs']} img; expected one of each")


@check(5)
def check_05(c: Ctx) -> None:
    """The three-message thread shows three messages, oldest first."""
    r = c.run
    t = c.F["thread3"]
    r.goto(f"/inbox/{t['account']}/{t['id']}")
    expect(r.page.locator('[data-testid="reading-conversation"]').count() == 1, "no conversation container")
    meta = r.page.locator('[data-testid="reading-meta"]').inner_text()
    expect("3 messages" in meta, f"the header does not say 3 messages: {meta!r}")
    # Older messages render COLLAPSED by design; the latest is expanded.
    collapsed = r.page.locator('[data-testid^="collapsed-"]')
    n_collapsed = collapsed.count()
    expect(n_collapsed == 2, f"the thread shows {n_collapsed} collapsed messages plus the open one, not 2 + 1")
    for _ in range(n_collapsed):
        collapsed.first.click(); r.settled()
    bodies = r.page.locator('[data-testid^="body"]:not([data-testid^="body-frame"]):not([data-testid^="body-type"])')
    n = bodies.count()
    expect(n == 3, f"after expanding, {n} bodies are visible, not 3")
    texts = [bodies.nth(i).inner_text() for i in range(n)]
    order = [next((w for w in ("first", "second", "third") if w in t_), "?") for t_ in texts]
    expect(order == ["first", "second", "third"], f"thread order is {order}")
    # Reported day 1: opening a thread by a message that is NOT its latest
    # (All inboxes offers test-a's row for this thread, which is the reply
    # in the middle) showed first, third, second -- the open message was
    # always rendered last. The order must hold whichever message is opened,
    # with the opened one expanded IN PLACE.
    mid = c.F["thread2"]  # in test-a: the middle of the three
    r.goto(f"/inbox/{mid['account']}/{mid['id']}")
    collapsed = r.page.locator('[data-testid^="collapsed-"]')
    expect(collapsed.count() == 2, f"opened by its middle message, the thread shows {collapsed.count()} collapsed, not 2")
    for _ in range(2):
        collapsed.first.click(); r.settled()
    bodies = r.page.locator('[data-testid^="body"]:not([data-testid^="body-frame"]):not([data-testid^="body-type"])')
    texts = [bodies.nth(i).inner_text() for i in range(bodies.count())]
    order = [next((w for w in ("first", "second", "third") if w in t_), "?") for t_ in texts]
    expect(order == ["first", "second", "third"], f"opened by its middle message, the thread order is {order}")
    thread_id = r.api_get(f"/api/messages/{t['account']}/{t['id']}")["threadId"]
    api = r.api_get(f"/api/threads/{t['account']}/{thread_id}")
    n_api = len(api) if isinstance(api, list) else len(api.get("messages", []))
    expect(n_api == 3, f"the API holds {n_api} messages for this thread, not 3")


@check(6)
def check_06(c: Ctx) -> None:
    """The attachment is listed with its name and size, and downloads identical bytes."""
    r = c.run
    a = c.F["attach"]
    r.goto(f"/inbox/{a['account']}/{a['id']}")
    chip = r.page.locator('[data-testid="attachment-0"]')
    expect(chip.count() == 1, "the attachment is not listed")
    label = " ".join(chip.inner_text().split())
    expect(label == "report.pdf application/pdf 2.0 KB", f"the chip reads {label!r}, not 'report.pdf application/pdf 2.0 KB'")
    expect(r.page.locator('[data-testid^="attachment-"]').count() == 1, "the attachment is listed more than once")
    expect(r.page.locator('[data-testid^="inline-"]').count() == 0, "a real attachment is also listed as an inline part")
    # The chip IS the download link (body origin, Content-Disposition: attachment).
    with r.page.expect_download(timeout=15000) as dl:
        chip.click()
    data = open(dl.value.path(), "rb").read()
    expect(data == PDF_BYTES, f"downloaded {len(data)} bytes; they differ from what was sent")
    expect(dl.value.suggested_filename == "report.pdf", f"downloaded as {dl.value.suggested_filename!r}")


@check(7)
def check_07(c: Ctx) -> None:
    """j walks every row of a 200+ folder, crossing the page boundary; Esc closes."""
    r = c.run
    acct, total = _fullest_archive(c)
    expect(total > 200, f"the fullest archive ({acct}) holds {total} messages; paging past 200 needs more")
    r.goto(f"/archive/{acct}")
    first = r.list_rows()
    expect(len(first) == 200, f"expected a full first page, got {len(first)}")
    r.page.locator(f'[data-testid="row-{first[0][0]}-{first[0][1]}"]').click(); r.settled()
    seen = []
    for _ in range(205):
        r.page.keyboard.press("j"); r.quiet(still=40)
        seen.append(r.page.url.rsplit("/", 1)[-1])
    expect(len(set(seen)) >= 200, f"j moved through only {len(set(seen))} distinct messages in 205 presses")
    expect(len(r.list_rows()) > 200, "j reached the end of the page and the next page did not load")
    r.page.keyboard.press("k"); r.settled()
    expect(r.page.url.rsplit("/", 1)[-1] == seen[-2], "k did not go back one")
    cur = r.split_key(r.page.url.rstrip("/").split("/")[-2] + "-" + r.page.url.rsplit("/", 1)[-1]) if False else None
    acct, mid = r.page.url.split("/")[-2], r.page.url.rsplit("/", 1)[-1]
    wanted = r.page.locator(f'[data-testid="row-subject-{acct}-{mid}"]').inner_text().strip()
    expect(r.reading_subject() == wanted, f"after the walk the pane shows {r.reading_subject()!r}; the URL names {wanted!r}")
    rows_before_esc = r.list_rows()
    r.page.keyboard.press("Escape"); r.settled()
    expect(r.page.locator('[data-testid="reading-empty"]').count() == 1, "Escape did not close the message")
    expect(r.list_rows() == rows_before_esc, "Escape changed the list")


# -- Triage -------------------------------------------------------------

def _toast_says(c: Ctx, word: str) -> bool:
    t = c.run.page.locator('[data-testid="toast"]')
    return t.count() > 0 and word.lower() in t.inner_text().lower()


def _triage_key(c: Ctx, name: str, key: str, toast_word: str) -> dict:
    """Open fixture `name`, press `key`, wait for the toast, return the fixture."""
    f = c.F[name]
    c.run.guard_write([f["account"]])
    c.run.goto(f"/inbox/{f['account']}/{f['id']}")
    c.run.page.keyboard.press(key)
    wait_until(lambda: _toast_says(c, toast_word), f"a toast saying {toast_word}", timeout=10, every=0.5)
    return f


def _agree(c: Ctx, f: dict, what: str, wilco_ok, fastmail_ok) -> None:
    """Three views must agree: Wilco now, Wilco after a reload, Fastmail."""
    r = c.run
    expect(wilco_ok(r.api_get(f"/api/messages/{f['account']}/{f['id']}")), f"Wilco's API disagrees: {what}")
    r.reload()
    expect(wilco_ok(r.api_get(f"/api/messages/{f['account']}/{f['id']}")), f"after a reload Wilco disagrees: {what}")
    j = c.J[f["account"]]
    wait_until(lambda: fastmail_ok(j.state_of(f["id"])), f"Fastmail to show: {what}", timeout=90, every=3)


@check(8)
def check_08(c: Ctx) -> None:
    f = _triage_key(c, "bulk1", "s", "Flagged")
    expect(c.run.page.locator('[data-testid="act-flag-filled"]').count() == 1, "the star did not fill on screen")
    _agree(c, f, "flagged", lambda m: m["isFlagged"] is True, lambda s: s["keywords"].get("$flagged") is True)
    c.run.page.keyboard.press("s"); c.run.settled()
    _agree(c, f, "unflagged", lambda m: m["isFlagged"] is False, lambda s: not s["keywords"].get("$flagged"))

    f = c.F["unread"]
    # Read-on-open: marked read after a 1s dwell, not on arrival. The dwell
    # is MEASURED: the triage request must leave the page no sooner than
    # 900ms after it opened.
    opened_at = time.time()
    with c.run.page.expect_request(lambda q: "/api/triage" in q.url and q.method == "POST", timeout=15000) as req:
        c.run.goto(f"/inbox/{f['account']}/{f['id']}")
    dwell = time.time() - opened_at
    expect(dwell >= 0.9, f"read-on-open fired {dwell*1000:.0f}ms after opening; the dwell is 1s")
    c.run.settled()
    _agree(c, f, "read after opening", lambda m: m["isUnread"] is False, lambda s: s["keywords"].get("$seen") is True)

    f = _triage_key(c, "bulk2", "e", "Archived")
    arch = c.J[f["account"]].mailboxes()["archive"]
    _agree(c, f, "archived", lambda m: m["mailboxIds"] == [arch], lambda s: s["roles"] == {"archive"})
    c.run.goto(f"/inbox/{f['account']}")
    expect((f["account"], f["id"]) not in c.run.list_rows(), "the archived message is still in the inbox list")

    f = _triage_key(c, "bulk3", "#", "Deleted")
    trash = c.J[f["account"]].mailboxes()["trash"]
    _agree(c, f, "in trash", lambda m: m["mailboxIds"] == [trash], lambda s: s["roles"] == {"trash"})
    c.run.goto(f"/inbox/{f['account']}")
    expect((f["account"], f["id"]) not in c.run.list_rows(), "the deleted message is still in the inbox list")


@check(9)
def check_09(c: Ctx) -> None:
    f = _triage_key(c, "plain", "e", "Archived")
    inbox = _inbox_id(c, f["account"])
    c.run.page.keyboard.press("z"); c.run.settled()
    expect(_detail(c, f)["mailboxIds"] == [inbox], "undo did not restore the cache row at once (only a later sync could)")
    c.run.settled()
    _agree(c, f, "back in the inbox after undo", lambda m: m["mailboxIds"] == [inbox], lambda s: s["roles"] == {"inbox"})
    c.run.goto(f"/inbox/{f['account']}")
    expect((f["account"], f["id"]) in c.run.list_rows(), "undo did not put the message back in the list")


@check(10)
def check_10(c: Ctx) -> None:
    """Select one message in each test account from All inboxes, archive both."""
    r = c.run
    a1, b1 = c.F["bulkA1"], c.F["bulk4"]
    r.guard_write([a1["account"], b1["account"]])
    r.goto("/inbox")
    for f in (a1, b1):
        r.page.locator(f'[data-testid="checkbox-{f["account"]}-{f["id"]}"]').click(); r.settled()
    expect(_bulk_count(c) == "2 selected", f"the bulk bar says {_bulk_count(c)!r}, not '2 selected'")
    before = r.list_rows()
    # "Nothing else moved" means unchanged BY THIS ACTION: earlier checks in
    # the same run have legitimately archived bulk2 and trashed bulk3 (row
    # 8), so the comparison is against each fixture's state a moment ago,
    # not against "in the inbox".
    others = {name: c.J[fx["account"]].state_of(fx["id"])
              for name, fx in c.F.items() if name not in ("bulkA1", "bulk4") and fx["account"] in WRITABLE}
    r.page.locator('[data-testid="bulk-archive"]').click(); r.settled()
    for f in (a1, b1):
        wait_until(lambda f=f: c.J[f["account"]].state_of(f["id"])["roles"] == {"archive"},
                   f"Fastmail to show {f['account']}/{f['id']} in Archive only", timeout=90, every=3)
    r.reload()
    rows = r.list_rows()
    expect(all((f["account"], f["id"]) not in rows for f in (a1, b1)), "an archived message is still listed after reload")
    expect(len(before) - len(rows) == 2, f"the list lost {len(before) - len(rows)} rows, not exactly the 2 selected")
    # Nothing else moved.
    for name, was in others.items():
        now = c.J[c.F[name]["account"]].state_of(c.F[name]["id"])
        expect(now["exists"] and now["roles"] == was["roles"] and now["names"] == was["names"],
               f"{name} moved too: was {sorted(was['names'])}, now {sorted(now['names'])}")


@check(11)
def check_11(c: Ctx) -> None:
    """Spam files into the CONFIGURED folder: configure test-a's junk-role
    mailbox, mark a message as spam, and require Fastmail to show it there."""
    r = c.run
    f = c.F["bulkA2"]; acct = f["account"]
    r.guard_write([acct])
    # The configured folder is a ROLE-LESS one (fixtures' "Harness Spam"),
    # so filing into role=junk -- the fallback spec 7.6 forbids -- fails.
    from fixtures import SPAM_FOLDER
    settings = r.api_get(f"/api/accounts/{acct}/settings")
    spam_id = next((m["id"] for m in settings["mailboxes"] if m.get("name") == SPAM_FOLDER), None)
    expect(spam_id is not None, f"Wilco does not list the {SPAM_FOLDER!r} folder for {acct}")
    res = r.api_put(f"/api/accounts/{acct}/settings", {"key": "spamMailboxId", "value": spam_id})
    expect(res.ok, f"could not configure the spam folder: {res.status}")
    r.goto(f"/inbox/{acct}/{f['id']}")
    r.page.locator('[data-testid="act-spam"]').click(); r.settled()
    expect(_detail(c, f)["mailboxIds"] == [spam_id], "Wilco's cache does not show the message in the configured folder")
    wait_until(lambda: c.J[acct].state_of(f["id"])["names"] == {SPAM_FOLDER},
               f"Fastmail to show the message only in {SPAM_FOLDER!r}", timeout=90, every=3)
    r.goto(f"/inbox/{acct}")
    expect((acct, f["id"]) not in r.list_rows(), "the message marked as spam is still in the inbox list")


# -- Write --------------------------------------------------------------

def _type_body(c: Ctx, body: str) -> None:
    """Types into the rich editor's FIRST line (the empty paragraph above the
    signature block), the way a person does. `fill` is for inputs; this is a
    contenteditable (HTML compose, 2026-09-07)."""
    r = c.run
    first = r.page.locator('[data-testid="compose-body"] > p').first
    first.click(); r.page.keyboard.press("Home")
    r.page.keyboard.type(body)


def _click_send(c: Ctx) -> None:
    r = c.run
    r.page.locator('[data-testid="send"]').click()
    wait_until(lambda: r.page.locator('[data-testid="compose-card"]').count() == 0, "compose to close after send", timeout=20, every=1)
    expect(r.page.locator('[data-testid="send-error"]').count() == 0, "send reported an error")


def _compose_send(c: Ctx, subject: str, body: str) -> None:
    c.run.page.fill('[data-testid="compose-subject"]', subject)
    _type_body(c, body)
    _click_send(c)


def _editor_text(c: Ctx) -> str:
    return c.run.page.locator('[data-testid="compose-body"]').inner_text()


def _editor_order(c: Ctx) -> list[str]:
    """The editor's top-level children as p / sig / attr / quote / <tag>."""
    return c.run.page.evaluate("""Array.from(document.querySelector('[data-testid="compose-body"]').children).map(el =>
        el.hasAttribute('data-wilco-signature') ? 'sig' : el.hasAttribute('data-wilco-attribution') ? 'attr'
        : el.hasAttribute('data-wilco-quote') ? 'quote' : el.tagName.toLowerCase())""")


def _delivered(c: Ctx, j, rid: str) -> dict:
    """The delivered message's two halves and its structure, from Fastmail."""
    m = j.call([["Email/get", {"accountId": j.account_id, "ids": [rid],
                               "properties": ["textBody", "htmlBody", "bodyValues", "bodyStructure", "attachments"],
                               "fetchAllBodyValues": True}, "g"]])[0][1]["list"][0]
    values = m.get("bodyValues", {})
    def half(parts):
        return "".join(values[p["partId"]]["value"] for p in (parts or []) if p.get("partId") in values)
    return {"text": half(m.get("textBody")), "html": half(m.get("htmlBody")),
            "html_types": {p.get("type") for p in (m.get("htmlBody") or [])},
            "structure": m.get("bodyStructure"), "attachments": m.get("attachments") or []}


def _inline_parts(structure, out=None) -> list:
    """Every leaf part with a cid, walking bodyStructure."""
    out = [] if out is None else out
    if not isinstance(structure, dict):
        return out
    if structure.get("cid"):
        out.append(structure)
    for sub in structure.get("subParts") or []:
        _inline_parts(sub, out)
    return out


def _found_or_resent(c: Ctx, j, subject: str, resend, from_email: str | None = None) -> str:
    """The sent message's id at the recipient -- after ONE resend if the first
    never arrived. Fastmail silently loses a send from these accounts now
    and then (design doc: measured; accepted by EmailSubmission/set, in
    Sent, never delivered, no bounce). A person would send again; so does
    the check, once, and then asserts the outcome exactly as before. A check
    that counts copies in Sent (17, 24) first destroys the lost copy there
    -- accepted by Fastmail, never delivered, it never existed for the
    recipient -- so 'Sent holds one copy' stays what it measures."""
    try:
        return j.find(subject, from_email=from_email)
    except Problem:
        print(f"  ! {subject!r} did not arrive in 90s; resending once (Fastmail send loss)", flush=True)
        resend()
        return j.find(subject, from_email=from_email)


def _drop_lost_sent(c: Ctx, account: str, subject: str) -> None:
    """Destroy the Sent copy of a send Fastmail lost, before resending."""
    j = c.J[account]
    lost = j.query({"subject": subject, "inMailbox": j.mailboxes()["sent"]})
    if lost:
        j.set(destroy=lost)


def _rgb(value: str) -> tuple[int, int, int]:
    """A CSS colour as (r, g, b): the dot is compared by COLOUR, since the
    browser reports `rgb(...)` for a hex the API states as `#rrggbb`."""
    v = value.strip()
    if v.startswith("#"):
        h = v[1:]
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    nums = [int(float(n)) for n in re.findall(r"[\d.]+", v)[:3]]
    return (nums[0], nums[1], nums[2])


def _from_account(c: Ctx) -> str:
    return c.run.page.locator('[data-testid="from-select"]').input_value().split("|")[0]


def _compose_as(c: Ctx, account: str) -> None:
    """Open a new compose AND choose its From, before anything is typed.

    🚨 Never rely on the From default: it is alphabetical (flow 15), so a
    compose opened from /inbox/test-a defaults to `atelier`, and the page's
    own autosave then writes a draft into the owner's real account. The
    browser guard in lib.py now aborts that; this is why it should never be
    reached."""
    r = c.run
    r.page.keyboard.press("c"); r.settled()
    sel = r.page.locator('[data-testid="from-select"]')
    value = next(v for v in sel.evaluate("s => Array.from(s.options).map(o => o.value)") if v.split("|")[0] == account)
    sel.select_option(value); r.settled()
    expect(_from_account(c) == account, f"could not compose as {account}")


@check(12)
def check_12(c: Ctx) -> None:
    r = c.run
    h = c.F["html"]  # in test-b, from test-a
    r.guard_write([h["account"]])
    r.goto(f"/inbox/{h['account']}/{h['id']}")
    r.page.keyboard.press("r"); r.settled()
    frm = _from_account(c)
    expect(frm == h["account"], f"reply is from {frm!r}; the message is in {h['account']}")
    to = r.page.locator('[data-testid="compose-to"]').input_value()
    expect(c.J["test-a"].identity["email"] in to, f"reply is addressed to {to!r}")
    # Row 44: the original is IN the editor as one editable blockquote under
    # its attribution line (parity with every other client).
    q = r.page.locator('[data-testid="compose-body"] blockquote[data-wilco-quote]')
    wait_until(lambda: q.count() == 1, "the quoted original to appear in the editor", timeout=10, every=0.5)
    expect("wrote:" in _editor_text(c), "no attribution line above the quote")
    subj = r.page.locator('[data-testid="compose-subject"]').input_value()
    expect(subj == f"Re: {h['subject']}", f"the reply subject is {subj!r}")
    _compose_send(c, subj, "Replying.")
    def resend() -> None:
        r.goto(f"/inbox/{h['account']}/{h['id']}")
        r.page.keyboard.press("r"); r.settled()
        _compose_send(c, subj, "Replying.")
    rid = _found_or_resent(c, c.J["test-a"], subj, resend, from_email=c.J["test-b"].identity["email"])
    orig_msgid = c.J["test-b"].get([h["id"]], ["messageId"])[0]["messageId"][0]
    hdrs = c.J["test-a"].get([rid], ["inReplyTo", "references"])[0]
    expect(orig_msgid in (hdrs.get("inReplyTo") or []), "the reply does not carry In-Reply-To for the original")
    expect(orig_msgid in (hdrs.get("references") or []), "the reply does not carry References for the original")
    d = _delivered(c, c.J["test-a"], rid)
    expect("text/html" in d["html_types"], f"the reply arrived with htmlBody types {sorted(d['html_types'])} -- plain text only")
    expect("Replying." in d["text"] and "wrote:" in d["text"] and "> " in d["text"], f"the text half lacks the reply or the quote: {d['text'][:120]!r}")
    expect("<blockquote" in d["html"] and "Replying." in d["html"], "the HTML half lacks the reply or the quoted original")
    expect(d["html"].index("Replying.") < d["html"].index("<blockquote"), "the reply text is not above the quote")


@check(13)
def check_13(c: Ctx) -> None:
    r = c.run
    expect("cc" in c.F, "no cc fixture: test-a has no alias identity to use as the third party")
    t = c.F["cc"]  # in test-b; from test-a, cc test-a's alias
    r.goto(f"/inbox/{t['account']}/{t['id']}")
    r.page.keyboard.press("a"); r.settled()
    own = c.J[t["account"]].identity["email"]
    to = r.page.locator('[data-testid="compose-to"]').input_value()
    cc_el = r.page.locator('[data-testid="compose-cc"]')
    cc = cc_el.input_value() if cc_el.count() else ""
    expect(own not in to and own not in cc, f"reply-all includes my own address {own}: to={to!r} cc={cc!r}")
    expect(c.J["test-a"].identity["email"] in to, f"reply-all dropped the sender: to={to!r}")
    expect(c.F.alias_a in cc or c.F.alias_a in to, f"reply-all dropped the third party {c.F.alias_a}: to={to!r} cc={cc!r}")
    r.page.locator('[data-testid="discard"]').click(); r.settled()


@check(14)
def check_14(c: Ctx) -> None:
    r = c.run
    a = c.F["attach"]
    r.goto(f"/inbox/{a['account']}/{a['id']}")
    r.page.keyboard.press("f"); r.settled()
    expect(r.page.locator('[data-testid="attachment-chip-report.pdf"]').count() == 1, "the forward does not carry report.pdf")
    r.page.fill('[data-testid="compose-to"]', c.J["test-a"].identity["email"])
    subj = r.page.locator('[data-testid="compose-subject"]').input_value()
    expect(subj == f"Fwd: {a['subject']}", f"the forward subject is {subj!r}")
    # HTML compose: the original is shown read-only under its forwarded-
    # message header and attached by the server; it is not in the editor.
    q = r.page.locator('[data-testid="compose-body"] [data-wilco-quote]')
    wait_until(lambda: q.count() == 1, "the forwarded original to appear in the editor", timeout=10, every=0.5)
    expect(r.page.locator('[data-testid="compose-body"] blockquote').count() == 0, "a forward must not be a blockquote (Fastmail: inline under a header)")
    expect("Forwarded message" in r.page.locator('[data-testid="compose-body"] [data-wilco-attribution]').inner_text(), "the forward's header block is missing")
    _compose_send(c, subj, "Forwarding.")
    def resend() -> None:
        r.goto(f"/inbox/{a['account']}/{a['id']}")
        r.page.keyboard.press("f"); r.settled()
        r.page.fill('[data-testid="compose-to"]', c.J["test-a"].identity["email"])
        _compose_send(c, subj, "Forwarding.")
    rid = _found_or_resent(c, c.J["test-a"], subj, resend, from_email=c.J["test-b"].identity["email"])
    atts = c.J["test-a"].get([rid], ["attachments"])[0]["attachments"]
    expect(any(x["name"] == "report.pdf" and x["size"] == len(PDF_BYTES) for x in atts), f"forwarded attachments: {atts}")
    d = _delivered(c, c.J["test-a"], rid)
    expect("Forwarded message" in d["text"] and "See attached." in d["text"], f"the forward's text half lacks the original: {d['text'][:160]!r}")
    expect("Forwarding." in d["html"] and "See attached." in d["html"], "the forward's HTML half lacks the note or the original")


@check(15)
def check_15(c: Ctx) -> None:
    """New compose from All inboxes defaults to the FIRST account in the owner's order."""
    r = c.run
    accounts = r.api_get("/api/accounts")
    r.goto("/inbox")
    r.page.keyboard.press("c"); r.settled()
    frm = _from_account(c)
    r.page.locator('[data-testid="discard"]').click(); r.settled()
    expect(all("position" in a for a in accounts), "accounts carry no owner-chosen position; the default is alphabetical (check 34)")
    ordered = sorted(accounts, key=lambda a: a["position"])
    expect(frm == ordered[0]["key"], f"new compose defaults to {frm}; the first account in the owner's order is {ordered[0]['key']}")


@check(16)
def check_16(c: Ctx) -> None:
    r = c.run
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    subj = f"{PREFIX} draft {int(time.time())}"
    r.page.fill('[data-testid="compose-subject"]', subj)
    _type_body(c, "draft body")
    status = r.page.locator('[data-testid="compose-draft-status"]')
    saved_re = re.compile(r"draft saved \d\d:\d\d")  # "not saved · esc" must NOT match
    wait_until(lambda: saved_re.search(status.inner_text()) is not None, "the draft to autosave", timeout=15, every=1)
    r.page.locator('[data-testid="compose-close"]').click(); r.settled()
    did = c.J["test-a"].find(subj)
    st = c.J["test-a"].state_of(did)
    expect("drafts" in st["roles"], f"the draft is not in test-a's Drafts on Fastmail: {st['roles']}")
    wait_until(lambda: r.page.request.get(f"{BASE}/api/messages/test-a/{did}").status == 200, "Wilco to hold the draft", timeout=90, every=3)
    r.goto(f"/drafts/test-a/{did}")
    expect(r.page.locator('[data-testid="compose-subject"]').input_value() == subj, "resuming the draft did not restore its subject")
    expect(_from_account(c) == "test-a", "the resumed draft is not in its own account")
    # A JMAP Email is immutable, so a save REPLACES the draft: the page's
    # own POST /api/drafts answers with the NEW id. Fastmail is then asked
    # by id (Email/get is authoritative; a fresh message is not visible to
    # Email/query for longer than any sane wait -- the first two versions
    # of this check waited on the query and went red against a correct
    # save). Old id gone + new id holding the edit == exactly one draft.
    expect("draft body" in _editor_text(c), "resuming the draft did not restore its body")
    with r.page.expect_response(lambda q: q.url.endswith("/api/drafts") and q.request.method == "POST", timeout=15000) as saved:
        first = r.page.locator('[data-testid="compose-body"] > p').first
        first.click(); r.page.keyboard.press("End"); r.page.keyboard.type(" edited")
    res = saved.value
    expect(res.ok, f"the re-save answered HTTP {res.status}")
    new_id = res.json()["draftId"]
    expect(new_id != did, "the re-save answered with the OLD id -- an Email cannot be updated in place, so nothing was saved")
    j = c.J["test-a"]
    def by_id(i: str) -> dict | None:
        got = j.call([["Email/get", {"accountId": j.account_id, "ids": [i], "properties": ["subject", "bodyValues"],
                                     "fetchTextBodyValues": True}, "g"]])[0][1]["list"]
        return got[0] if got else None
    wait_until(lambda: (m := by_id(new_id)) is not None and any("draft body edited" in v["value"] for v in m["bodyValues"].values()),
               "Fastmail to hold the new draft with the edit", timeout=30, every=2)
    wait_until(lambda: by_id(did) is None, "Fastmail to no longer hold the OLD draft", timeout=30, every=2)
    status_txt = r.page.locator('[data-testid="compose-draft-status"]').inner_text()
    expect(saved_re.search(status_txt) is not None, f"the edit is on Fastmail but the header says {status_txt!r}")
    r.page.locator('[data-testid="discard"]').click(); r.settled()
    wait_until(lambda: by_id(new_id) is None, "Fastmail to no longer hold the discarded draft", timeout=60, every=3)


@check(17)
def check_17(c: Ctx) -> None:
    r = c.run
    sig = "-- \nTest A signature"
    res = r.api_put(f"/api/identities/test-a/{c.J['test-a'].identity['id']}/signature", {"textSignature": sig})
    expect(res.ok, f"could not set test-a's signature: {res.status}")
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    # HTML compose: the signature is IN the editor at open, as a block the
    # owner can edit; nothing is appended later.
    block = r.page.locator('[data-testid="compose-body"] [data-testid="compose-signature"]')
    wait_until(lambda: block.count() == 1, "the signature block to appear in the editor", timeout=10, every=0.5)
    expect("Test A signature" in block.inner_text(), "the block in the editor is not the identity's signature")
    r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
    subj = f"{PREFIX} sent-once"
    _compose_send(c, subj, "Hello from A.")
    def resend() -> None:
        _drop_lost_sent(c, "test-a", subj)
        r.goto("/inbox/test-a")
        _compose_as(c, "test-a")
        r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
        _compose_send(c, subj, "Hello from A.")
    rid = _found_or_resent(c, c.J["test-b"], subj, resend)
    body = c.J["test-b"].call([["Email/get", {"accountId": c.J["test-b"].account_id, "ids": [rid],
                                              "properties": ["textBody", "bodyValues"], "fetchTextBodyValues": True}, "g"]])[0][1]["list"][0]
    text = "".join(v["value"] for v in body.get("bodyValues", {}).values())
    expect(text.count("Test A signature") == 1, f"the signature appears {text.count('Test A signature')} times")
    expect("\n-- \nTest A signature" in text, "the RFC 3676 separator '-- ' (trailing space) did not survive byte for byte")
    sent = c.J["test-a"].query({"subject": subj, "inMailbox": c.J["test-a"].mailboxes()["sent"]})
    expect(len(sent) == 1, f"test-a's Sent holds {len(sent)} copies")
    wait_until(lambda: r.page.request.get(f"{BASE}/api/messages/test-a/{sent[0]}").status == 200, "Wilco to show it in Sent", timeout=90, every=3)


# -- Find ---------------------------------------------------------------

def _search(c: Ctx, q: str) -> None:
    r = c.run
    r.goto("/inbox")
    r.page.locator('[data-testid="search"]').click()
    r.page.keyboard.type(q, delay=40)
    wait_until(lambda: r.page.locator('[data-testid="search-active"]').count() == 1, "search results", timeout=15, every=0.5)
    r.settled()


def _search_rows(c: Ctx) -> list[str]:
    return c.run.page.evaluate("""Array.from(document.querySelectorAll('[data-testid^="search-row-"]')).map(e => e.getAttribute('data-testid').slice(11))""")


@check(18)
def check_18(c: Ctx) -> None:
    r = c.run
    server = r.api_post("/api/search", {"q": "invoice"})
    _search(c, "invoice")
    shown = r.page.locator('[data-testid="count"]').inner_text().strip()
    expect(shown == f"{server['total']:,} results", f"search says {shown!r}; the server has {server['total']:,} matches")
    first = _search_rows(c); before = len(first)
    r.page.evaluate("""(() => { const l = document.querySelector('[data-testid="list"]') || document.querySelector('[data-testid="search-active"]'); l.scrollTop = l.scrollHeight; })()""")
    r.settled()
    paged = _search_rows(c); after = len(paged)
    expect(after > before, f"search showed {before} rows and did not page: the other {server['total'] - before:,} matches are unreachable")
    # Results render GROUPED BY ACCOUNT, so a new page re-sorts earlier rows
    # into their groups; the invariants are no duplicates, nothing lost, and
    # newest-first within each account (as check 19 asserts).
    expect(len(set(paged)) == after, "paging duplicated rows")
    expect(set(first) <= set(paged), "paging dropped rows from the first page")
    when = {f"{m['account']}-{m['id']}": m["receivedAt"] for m in r.api_post("/api/search", {"q": "invoice", "limit": 200})["rows"]}
    when.update({f"{m['account']}-{m['id']}": m["receivedAt"] for m in r.api_post("/api/search", {"q": "invoice", "cursor": server["cursor"]})["rows"]})
    by_acct: dict[str, list[str]] = {}
    for k in paged:
        if k in when:
            by_acct.setdefault(r.split_key(k)[0], []).append(when[k])
    expect(all(v == sorted(v, reverse=True) for v in by_acct.values()), "results within an account are not newest-first after paging")


@check(19)
def check_19(c: Ctx) -> None:
    r = c.run
    a_addr = c.J["test-a"].identity["email"]
    cases = {
        "is:unread": lambda m: m["isUnread"] is True,
        "has:attachment": lambda m: r.api_get(f"/api/messages/{m['account']}/{m['id']}")["attachments"] != [],
        f"from:{a_addr}": lambda m: m["fromEmail"] == a_addr,
        "acct:test-b": lambda m: m["account"] == "test-b",
    }
    for q, ok in cases.items():
        res = r.api_post("/api/search", {"q": q})
        expect(res["total"] > 0, f"{q!r} matched nothing")
        bad = [m for m in res["rows"] if not ok(m)]
        expect(not bad, f"{q!r} returned rows that do not satisfy it: " + (f"{bad[0]['account']}/{bad[0]['id']}" if bad else ""))
        _search(c, q)
        ui = _search_rows(c)
        # Results render GROUPED BY ACCOUNT by design, so the screen's order
        # is not the API's; the rows must be the same rows, and newest-first
        # within each account.
        api_keys = [f"{m['account']}-{m['id']}" for m in res["rows"]]
        expect(0 < len(ui) <= len(api_keys) and set(ui) <= set(api_keys), f"{q!r}: the screen shows rows the API did not return")
        when = {f"{m['account']}-{m['id']}": m["receivedAt"] for m in res["rows"]}
        by_acct: dict[str, list[str]] = {}
        for k in ui:
            by_acct.setdefault(r.split_key(k)[0], []).append(when[k])
        expect(all(v == sorted(v, reverse=True) for v in by_acct.values()), f"{q!r}: results within an account are not newest-first")


# -- Live ---------------------------------------------------------------

@check(20)
def check_20(c: Ctx) -> None:
    r = c.run
    r.goto("/inbox/test-b")
    rows = r.list_rows()
    # The owner triages the harness accounts like any other (ruling
    # 2026-09-06: they stay visible); a fixture deleted mid-run is a plain
    # red with a reason, not a traceback.
    expect(len(rows) >= 2, f"test-b's inbox has only {len(rows)} rows; the check needs two")
    r.page.locator(f'[data-testid="row-{rows[1][0]}-{rows[1][1]}"]').click(); r.settled()
    opened = r.page.url; opened_subject = r.reading_subject(); count_before = int(r.list_count().split("·")[0].strip())
    subj = f"{PREFIX} live {int(time.time())}"
    c.J["test-a"].send(c.J["test-b"].identity["email"], subj, "arrived live")
    def at_top() -> bool:
        top = r.list_rows()[:3]
        return any(subj in r.page.locator(f'[data-testid="row-subject-{a}-{i}"]').inner_text() for a, i in top)
    wait_until(at_top, "the new message to appear at the top of the list without a reload", timeout=120, every=3)
    expect(r.page.url == opened and r.reading_subject() == opened_subject, "the arrival moved the reader off the open message")
    a, i = r.list_rows()[0]
    expect(r.page.locator(f'[data-testid="row-unread-{a}-{i}"]').count() == 1, "the arrival is not shown unread")
    expect(int(r.list_count().split("·")[0].strip()) == count_before + 1, "the header count did not grow by one")
    toast = r.page.locator('[data-testid="toast"]')
    expect(toast.count() == 1 and subj[:20] in toast.inner_text(), "no notification toast for the arrival")


@check(21)
def check_21(c: Ctx) -> None:
    r = c.run
    f = c.F["sync"]; j = c.J[f["account"]]
    r.goto(f"/inbox/{f['account']}")
    j.set(update={f["id"]: {"keywords/$flagged": True}})
    wait_until(lambda: r.page.locator(f'[data-testid="row-{f["account"]}-{f["id"]}"] .msg-row-star').count() == 1,
               "the flag set in Fastmail to show on the row", timeout=120, every=3)
    expect(_detail(c, f)["isFlagged"] is True, "the row shows a star but the API says unflagged")
    mb = j.mailboxes()
    j.set(update={f["id"]: {f"mailboxIds/{mb['inbox']}": None, f"mailboxIds/{mb['archive']}": True}})
    wait_until(lambda: (f["account"], f["id"]) not in r.list_rows(),
               "the message archived in Fastmail to leave the inbox list", timeout=120, every=3)
    expect(_detail(c, f)["mailboxIds"] == [mb["archive"]], "the row left the list but the API does not show Archive only")


# -- Fastmail's daily surface ---------------------------------------------

def _put(c: Ctx, path: str, body: dict):
    return c.run.api_put(path, body)


def _bulk_count(c: Ctx) -> str:
    el = c.run.page.locator('[data-testid="bulk-count"]')
    return el.inner_text().strip() if el.count() else ""


def _detail(c: Ctx, f: dict) -> dict:
    return c.run.api_get(f"/api/messages/{f['account']}/{f['id']}")


def _inbox_id(c: Ctx, account: str) -> str:
    return c.J[account].mailboxes()["inbox"]


@check(22)
def check_22(c: Ctx) -> None:
    """Move into a custom folder created for the run."""
    r = c.run
    f = c.F["thread3"]; j = c.J[f["account"]]
    folder = f"Harness {int(time.time()) % 100000}"
    created = j.call([["Mailbox/set", {"accountId": j.account_id, "create": {"m": {"name": folder, "parentId": None}}}, "mb"]])[0][1]
    fid = created["created"]["m"]["id"]; j._mailboxes = None
    def wilco_has_folder() -> bool:
        for acct in r.api_get("/api/mailboxes")["accounts"]:
            if acct["account"] == f["account"]:
                return any(m["name"] == folder for m in acct["mailboxes"])
        return False
    wait_until(wilco_has_folder, "Wilco to learn the new folder", timeout=120, every=5)
    r.goto(f"/inbox/{f['account']}/{f['id']}")
    r.page.locator('[data-testid="message-menu"]').click(); r.settled()
    item = r.page.locator('[data-testid^="contextmenu-item-"]', has_text="Move to")
    expect(item.count() == 1, "the message menu has no 'Move to…' item")
    item.first.click(); r.settled()
    expect(r.page.locator('[data-testid="move-overlay"]').count() == 1, "'Move to…' opened no picker")
    target = r.page.locator(f'[data-testid="move-folder-{fid}"]')
    listed = [t.strip() for t in r.page.locator('.move-folder-name').all_inner_texts()]
    expect(target.count() == 1, f"the picker does not list the custom folder {folder!r}; it lists {listed}")
    expect(target.is_enabled(), f"the picker lists {folder!r} but the row is disabled: {target.get_attribute('title')!r}")
    target.click(); r.settled()
    expect(_detail(c, f)["mailboxIds"] == [fid], "Wilco's cache does not show the message in the new folder")
    wait_until(lambda: j.state_of(f["id"])["names"] == {folder}, f"Fastmail to show the message only in {folder!r}", timeout=90, every=3)
    r.goto(f"/inbox/{f['account']}")
    expect((f["account"], f["id"]) not in r.list_rows(), "the moved message is still in the inbox")


@check(23)
def check_23(c: Ctx) -> None:
    r = c.run
    b_addr = c.J["test-b"].identity["email"]
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    r.page.locator('[data-testid="compose-to"]').type(b_addr[:4], delay=60)
    r.settled()
    sug = r.page.locator(f'[data-testid="to-autocomplete-{b_addr}"]')
    expect(sug.count() == 1, f"typing the first four letters offered no suggestion for a past recipient ({b_addr})")
    sug.click(); r.settled()
    expect(b_addr in r.page.locator('[data-testid="compose-to"]').input_value(), "choosing the suggestion did not fill the address")
    r.page.locator('[data-testid="discard"]').click(); r.settled()


@check(24)
def check_24(c: Ctx) -> None:
    r = c.run
    j = c.J["test-a"]
    ids = j.call([["Identity/get", {"accountId": j.account_id}, "i"]])[0][1]["list"]
    alias = next((i for i in ids if i["id"] != j.identity["id"]), None)
    expect(alias is not None, "test-a has no second identity; add an alias to it in Fastmail")
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    res = r.api_put(f"/api/identities/test-a/{alias['id']}/signature", {"textSignature": "-- \nAlias signature"})
    expect(res.ok, f"could not set the alias's signature: {res.status}")
    r.page.locator('[data-testid="from-select"]').select_option(f"test-a|{alias['email']}")
    # An untouched block follows the From: the alias's own signature replaces the primary's.
    block = r.page.locator('[data-testid="compose-body"] [data-testid="compose-signature"]')
    wait_until(lambda: block.count() == 1 and "Alias signature" in block.inner_text(), "the alias's signature to replace the primary's in the editor", timeout=10, every=0.5)
    r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
    subj = f"{PREFIX} from-alias"
    _compose_send(c, subj, "From the alias.")
    def resend() -> None:
        _drop_lost_sent(c, "test-a", subj)
        r.goto("/inbox/test-a")
        _compose_as(c, "test-a")
        r.page.locator('[data-testid="from-select"]').select_option(f"test-a|{alias['email']}")
        r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
        _compose_send(c, subj, "From the alias.")
    rid = _found_or_resent(c, c.J["test-b"], subj, resend)
    frm = c.J["test-b"].get([rid], ["from"])[0]["from"][0]["email"]
    expect(frm == alias["email"], f"arrived from {frm}, not the alias {alias['email']}")
    got = c.J["test-b"].call([["Email/get", {"accountId": c.J["test-b"].account_id, "ids": [rid],
                                             "properties": ["bodyValues"], "fetchTextBodyValues": True}, "g"]])[0][1]["list"][0]
    text = "".join(v["value"] for v in got["bodyValues"].values())
    expect("Alias signature" in text and "Test A signature" not in text, "the alias's own signature was not the one appended")
    sent = c.J["test-a"].query({"subject": subj, "inMailbox": c.J["test-a"].mailboxes()["sent"]})
    expect(len(sent) == 1, f"test-a's Sent holds {len(sent)} copies")


@check(25)
def check_25(c: Ctx) -> None:
    r = c.run
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    r.page.locator('[data-testid="attach-input"]').set_input_files({"name": "blob.bin", "mimeType": "application/octet-stream", "buffer": PDF_BYTES})
    wait_until(lambda: r.page.locator('[data-testid="attachment-chip-blob.bin"]').count() == 1, "the chip to appear", timeout=20, every=1)
    r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
    subj = f"{PREFIX} new-attach"
    _compose_send(c, subj, "With a file.")
    def resend() -> None:
        r.goto("/inbox/test-a")
        _compose_as(c, "test-a")
        r.page.locator('[data-testid="attach-input"]').set_input_files({"name": "blob.bin", "mimeType": "application/octet-stream", "buffer": PDF_BYTES})
        wait_until(lambda: r.page.locator('[data-testid="attachment-chip-blob.bin"]').count() == 1, "the chip to appear", timeout=20, every=1)
        r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
        _compose_send(c, subj, "With a file.")
    rid = _found_or_resent(c, c.J["test-b"], subj, resend)
    att = c.J["test-b"].get([rid], ["attachments"])[0]["attachments"]
    blob = next((a for a in att if a["name"] == "blob.bin"), None)
    expect(blob is not None and blob["size"] == len(PDF_BYTES), f"arrived attachments: {att}")
    expect(c.J["test-b"].download(blob["blobId"]) == PDF_BYTES, "the attachment arrived with the right size and the wrong bytes")


@check(26)
def check_26(c: Ctx) -> None:
    r = c.run
    r.goto("/inbox/test-b")
    rows = r.list_rows()
    expect(len(rows) >= 4, f"test-b's inbox has only {len(rows)} rows; the range needs 4")
    r.page.locator(f'[data-testid="row-{rows[0][0]}-{rows[0][1]}"]').click(); r.settled()
    r.page.keyboard.press("x"); r.settled()
    expect(_bulk_count(c) == "1 selected", f"x gave {_bulk_count(c)!r}, not '1 selected'")
    expect(r.page.locator(f'[data-testid="checkbox-{rows[0][0]}-{rows[0][1]}"]').is_checked(), "x selected a different row")
    r.page.locator('[data-testid="bulk-clear"]').click(); r.settled()
    r.page.locator(f'[data-testid="checkbox-{rows[0][0]}-{rows[0][1]}"]').click()
    r.page.locator(f'[data-testid="checkbox-{rows[3][0]}-{rows[3][1]}"]').click(modifiers=["Shift"]); r.settled()
    txt = _bulk_count(c)
    expect(txt == "4 selected", f"shift-click selected {txt!r}, not the range of 4")
    checked = [i for i, (a, m) in enumerate(rows) if r.page.locator(f'[data-testid="checkbox-{a}-{m}"]').is_checked()]
    expect(checked == [0, 1, 2, 3], f"the checked rows are {checked}, not the range 0-3")
    r.page.locator('[data-testid="bulk-clear"]').click()


@check(27)
def check_27(c: Ctx) -> None:
    r = c.run
    # The blocking default and "this message" on a sender that NEVER gets a
    # standing allowance (test-b's htmlB); the sticky allowance on test-a's
    # html, which keeps it across runs because nothing can revoke it.
    hits: list[str] = []
    r.page.route("https://httpbin.org/**", lambda route, req: (hits.append(req.url), route.continue_()))
    h = c.F["htmlB"]
    r.goto(f"/inbox/{h['account']}/{h['id']}")
    m = r.body_frame_metrics()
    expect(m is not None and m.get("blocked") == 1 and m.get("loaded") == 0, f"before opting in: {m}")
    expect(hits == [], f"a blocked image still reached the network: {hits}")
    r.page.locator('[data-testid="load-images"]').click(); r.settled()
    m = r.body_frame_metrics()
    expect(m["loaded"] == 1, "Load images did not load the remote image")
    strip = r.page.locator('[data-testid="images-strip"]')
    expect("this message" in strip.inner_text(), f"the strip does not say the load was for this message: {strip.inner_text()!r}")
    # "This message" means this open only: a reopen blocks again, and that
    # blocking strip is where "Always from this sender" lives.
    r.goto("/inbox"); r.goto(f"/inbox/{h['account']}/{h['id']}")
    m = r.body_frame_metrics()
    expect(m["loaded"] == 0, "'load images for this message' stuck across a reopen; it should not")
    r.page.unroute("https://httpbin.org/**")
    # Now the standing allowance, on test-a's address.
    h = c.F["html"]
    r.goto(f"/inbox/{h['account']}/{h['id']}")
    strip = r.page.locator('[data-testid="images-strip"]')
    if "always for" not in strip.inner_text():
        expect(r.body_frame_metrics()["loaded"] == 0, "no standing allowance, yet the image loaded")
        r.page.locator('[data-testid="always-images"]').click(); r.settled()
    r.goto("/inbox"); r.goto(f"/inbox/{h['account']}/{h['id']}")
    m = r.body_frame_metrics()
    expect(m["loaded"] == 1, "'always from this sender' did not stick across a reopen")
    strip = r.page.locator('[data-testid="images-strip"]')
    expect("always for" in strip.inner_text(), f"the strip does not credit the standing allowance: {strip.inner_text()!r}")


@check(28)
def check_28(c: Ctx) -> None:
    r = c.run
    r.goto("/inbox")
    for key in ("test-a", "test-b"):
        j = c.J[key]
        fm = len(j.query({"inMailbox": j.mailboxes()["inbox"], "notKeyword": "$seen"}))
        el = r.page.locator(f'[data-testid="mailbox-{key}-{j.mailboxes()["inbox"]}"]')
        expect(el.count() == 1, f"no sidebar row for {key}'s inbox")
        def ui() -> int:
            nums = re.findall(r"\d+", el.inner_text().strip())
            return int(nums[-1]) if nums else 0
        # Wilco may trail Fastmail by one sync round; they must AGREE within it.
        wait_until(lambda: ui() == fm, f"{key} inbox: sidebar shows {ui()} unread, Fastmail has {fm}", timeout=90, every=3)
    boxes = r.api_get("/api/mailboxes")["accounts"]
    inbox_sum = sum(m["unread"] for a in boxes for m in a["mailboxes"] if m.get("role") == "inbox")
    total_el = r.page.locator('[data-testid="total-unread"]').inner_text()
    total = int(re.findall(r"\d+", total_el.replace(",", ""))[0]) if re.findall(r"\d+", total_el) else 0
    expect(total == inbox_sum, f"the header total says {total} unread; the inboxes sum to {inbox_sum} (does it count other folders?)")


@check(29)
def check_29(c: Ctx) -> None:
    """The session lasts days, and the sidebar's sync warning agrees with /healthz."""
    r = c.run
    cookie = next((k for k in r.context.cookies() if k["name"] == "wilco_session"), None)
    expect(cookie is not None, "no session cookie")
    expect(cookie["expires"] - time.time() > 6 * 24 * 3600, f"the session expires in {(cookie['expires'] - time.time()) / 3600:.0f}h, not days")
    health = r.page.request.get(BASE + "/healthz").json()  # 503 when stale is still a body
    r.goto("/inbox")
    # The badge means "this account needs attention": a failure state (auth
    # refused, an HTTP error, ...) OR no sync for 15 minutes. Proven with
    # test-b's stored credential replaced by garbage and the container
    # restarted: state "auth", not yet stale, badge shown.
    for a in health["accounts"]:
        badge = r.page.locator(f'[data-testid="account-sync-{a["account"]}"]')
        flagged = badge.count() == 1 and "sidebar-account-sync--error" in (badge.get_attribute("class") or "")
        needs = a.get("state") != "ok" or bool(a.get("stale"))
        expect(flagged == needs, f"{a['account']}: healthz state={a.get('state')} stale={a.get('stale')} but the sidebar {'shows' if flagged else 'shows no'} error badge")


@check(30)
def check_30(c: Ctx) -> None:
    r = c.run
    r.goto("/inbox/test-b")
    rows = r.list_rows()
    api = {(m["account"], m["id"]): m["receivedAt"] for m in r.api_get("/api/messages?account=test-b&role=inbox")["rows"]}
    times = [api[k] for k in rows if k in api]
    expect(times == sorted(times, reverse=True), "rows are not newest-first")
    # A message from the last hour shows a relative time ("now", "12m") by
    # design; older ones today show HH:MM. Either is a time a person reads.
    shown = r.page.locator(f'[data-testid="row-time-{rows[0][0]}-{rows[0][1]}"]').inner_text().strip()
    # ...and a message from an earlier day shows its weekday. The browser
    # runs in UTC, so a run that crosses midnight sees "yesterday" here.
    expect(re.match(r"^(now|\d+m|\d+h|\d{1,2}:\d\d|Mon|Tue|Wed|Thu|Fri|Sat|Sun|[A-Z][a-z]{2} \d{1,2})$", shown) is not None,
           f"the newest message's time reads {shown!r}, not a time, a weekday or a date")
    if re.match(r"^\d{1,2}:\d\d$", shown):
        # The browser's local time is what a person compares against.
        browser_hhmm = r.page.evaluate("new Date().toTimeString().slice(0, 5)")
        expect(abs(int(shown.split(':')[0]) - int(browser_hhmm.split(':')[0])) <= 1, f"row time {shown} is not in local time ({browser_hhmm} in the browser)")
    # Every group header must agree with the API dates of the rows under it.
    layout = r.page.evaluate("""(() => { const out = []; let g = null;
        for (const e of document.querySelectorAll('[data-testid^="group-header-"], [data-testid^="row-"][role="row"]')) {
            const t = e.getAttribute('data-testid');
            if (t.startsWith('group-header-')) g = e.innerText.trim().toLowerCase(); else out.push([g, t.slice(4)]); }
        return out; })()""")
    expect(layout and all(g for g, _ in layout), "rows outside any date group")
    today = r.page.evaluate("new Date().toDateString()")
    for g, key in layout:
        a, i = r.split_key(key)
        if (a, i) not in api:
            continue
        day = r.page.evaluate("d => new Date(d).toDateString()", api[(a, i)])
        expect((g == "today") == (day == today), f"{key} received {api[(a, i)]} is under the {g!r} group")


# -- Not built yet: these assert the contract ------------------------------

@check(31)
def check_31(c: Ctx) -> None:
    """Unsubscribe. Server-side by owner ruling (2026-09-06): the one-click
    POST goes out from Wilco's server (the SPA's CSP stays connect-src
    'self'), so the harness cannot watch it land -- that half is the
    server's own report. The mailto half IS proven: the fixture sits in
    test-b with a mailto pointing at test-a, so the unsubscribe email Wilco
    sends AS test-b must arrive in test-a."""
    r = c.run

    def offer_and_click(f: dict) -> dict:
        r.guard_write([f["account"]])
        r.goto(f"/inbox/{f['account']}/{f['id']}")
        btn = r.page.locator('[data-testid="unsubscribe"]')
        expect(btn.count() == 1, "a message carrying List-Unsubscribe offers no Unsubscribe control")
        expect("unsub" in btn.inner_text().lower(), f"the control reads {btn.inner_text()!r}")
        with r.page.expect_response(lambda q: q.url.endswith("/unsubscribe") and q.request.method == "POST", timeout=30000) as resp:
            btn.click()
        return resp.value.json()

    # (a) one-click POST: the server's report, and nothing else -- said so.
    body = offer_and_click(c.F["unsub"])
    expect(body.get("method") == "post", f"the one-click path was not taken: {body}")
    expect(isinstance(body.get("status"), int), f"the one-click POST reported no status: {body}")

    # (b) mailto, proven end to end: the email arrives at the list address.
    m = c.F["unsubMailto"]
    body = offer_and_click(m)
    expect(body.get("method") == "mailto" and body.get("ok") is True, f"the mailto path did not send: {body}")
    expect(body.get("to") == c.J["test-a"].identity["email"], f"the unsubscribe went to {body.get('to')!r}, not the list address")
    rid = c.J["test-a"].find("Unsubscribe wilco-check", from_email=c.J[m["account"]].identity["email"], timeout=90)
    expect(bool(rid), "the unsubscribe email never arrived at the list address")

    # (c) a message with no List-Unsubscribe offers nothing.
    plain = c.F["plain"]
    r.goto(f"/inbox/{plain['account']}/{plain['id']}")
    expect(r.page.locator('[data-testid="unsubscribe"]').count() == 0, "a message with no List-Unsubscribe offers Unsubscribe")


@check(32)
def check_32(c: Ctx) -> None:
    r = c.run
    f = c.F["bulk1"]; j = c.J[f["account"]]
    r.goto(f"/inbox/{f['account']}")
    src = r.page.locator(f'[data-testid="row-{f["account"]}-{f["id"]}"]')
    dst = r.page.locator(f'[data-testid="mailbox-{f["account"]}-{j.mailboxes()["archive"]}"]')
    expect(src.count() == 1 and dst.count() == 1, "row or archive folder not on screen")
    src.drag_to(dst); r.settled()
    expect(_detail(c, f)["mailboxIds"] == [j.mailboxes()["archive"]], "Wilco's cache does not show the dragged message in Archive only")
    wait_until(lambda: j.state_of(f["id"])["roles"] == {"archive"}, "Fastmail to show the dragged message in Archive only", timeout=90, every=3)
    r.goto(f"/inbox/{f['account']}")  # the drop may have navigated to the folder
    expect((f["account"], f["id"]) not in r.list_rows(), "the dragged message is still in the inbox list")


@check(33)
def check_33(c: Ctx) -> None:
    r = c.run
    p = c.F["plain"]
    r.goto(f"/inbox/{p['account']}/{p['id']}")
    btn = r.page.locator('[data-testid="print"]')
    expect(btn.count() == 1, "no Print control on an open message")
    with r.context.expect_page(timeout=10000) as pw:
        btn.click()
    printable = pw.value; printable.wait_for_load_state(); printable.wait_for_timeout(800)
    printable.screenshot(path=f"{OUT}/33-print.png", full_page=True)  # the document itself, not the app behind it
    txt = printable.locator("body").inner_text()
    expect("Line one" in txt and p["subject"] in txt and c.J["test-a"].identity["email"] in txt,
           "the print view lacks the body, subject or sender")
    expect(printable.locator('[data-testid="sidebar"], [data-testid="message-list"]').count() == 0,
           "the 'print view' is the app itself, sidebar and all")
    printable.close()


@check(34)
def check_34(c: Ctx) -> None:
    r = c.run
    accounts = r.api_get("/api/accounts")
    expect(all("position" in a for a in accounts), "accounts carry no `position`; order is alphabetical and cannot be chosen")
    # Every account's badge must tell it apart: test-a and test-b both
    # derived TES for two days (2026-09-07).
    codes = [a.get("code") for a in accounts]
    expect(len(set(codes)) == len(codes), f"two accounts share a sidebar code: {codes}")
    keys = [a["key"] for a in accounts]
    reordered = keys[1:] + keys[:1]
    res = _put(c, "/api/accounts/order", {"order": reordered})
    expect(res.ok, f"PUT /api/accounts/order -> {res.status}")
    try:
        r.goto("/inbox")
        shown = r.page.evaluate("""Array.from(document.querySelectorAll('[data-testid^="account-block-"]')).map(e => e.getAttribute('data-testid').slice(14))""")
        expect(shown == reordered, f"sidebar shows {shown}, the chosen order is {reordered}")
        badges = r.page.locator('[data-testid^="account-code-"]').all_inner_texts()
        expect(len(set(badges)) == len(badges), f"the sidebar shows two accounts with the same code badge: {badges}")
        r.page.keyboard.press("c"); r.settled()
        frm = _from_account(c)
        options = r.page.locator('[data-testid="from-select"]').evaluate("s => Array.from(s.options).map(o => o.value.split('|')[0])")
        seen_order = [k for i, k in enumerate(options) if k not in options[:i]]
        r.page.locator('[data-testid="discard"]').click()
        expect(frm == reordered[0], f"new compose defaults to {frm}; first in the chosen order is {reordered[0]}")
        expect(seen_order == reordered, f"the From options are ordered {seen_order}, not {reordered}")
    finally:
        _put(c, "/api/accounts/order", {"order": keys})


# -- Reported during the week ------------------------------------------------

@check(35)
def check_35(c: Ctx) -> None:
    """Sidebar counts follow what you do, without a reload (reported day 1:
    'archived every inbox item in both harnesses and still see an inbox
    count'). Read-on-open must take one off the inbox's unread badge; an
    archive must add one to Archive's total; a reload must then show the
    same numbers, and so must Fastmail."""
    r = c.run
    u = c.F["unread"]  # in test-b, unread on purpose
    r.guard_write([u["account"]])
    j = c.J[u["account"]]
    inbox_id, arch_id = j.mailboxes()["inbox"], j.mailboxes()["archive"]
    # Check 8 reads this fixture earlier in a full run; make it unread again
    # and wait for Wilco to agree, or the click below fires no read-on-open
    # and the badge is RIGHT not to move.
    j.set(update={u["id"]: {"keywords": {}}})
    wait_until(lambda: r.api_get(f"/api/messages/{u['account']}/{u['id']}")["isUnread"] is True,
               "Wilco to show the fixture unread again", timeout=90, every=3)
    r.goto(f"/inbox/{u['account']}")
    inbox_row = r.page.locator(f'[data-testid="mailbox-{u["account"]}-{inbox_id}"]')
    arch_row = r.page.locator(f'[data-testid="mailbox-{u["account"]}-{arch_id}"]')
    def num(el) -> int:
        nums = re.findall(r"\d+", el.inner_text().replace(",", ""))
        return int(nums[-1]) if nums else 0
    unread0, arch0 = num(inbox_row), num(arch_row)
    expect(unread0 >= 1, f"the inbox badge shows {unread0} unread; the unread fixture should make it at least 1")

    row = r.page.locator(f'[data-testid="row-{u["account"]}-{u["id"]}"]')
    expect(row.count() == 1, "the unread fixture is not in the list (deleted since the reset?)")
    row.click()
    wait_until(lambda: num(inbox_row) == unread0 - 1, f"the inbox badge to drop from {unread0} after reading (it shows {num(inbox_row)})", timeout=15, every=0.5)
    r.page.keyboard.press("e")
    wait_until(lambda: num(arch_row) == arch0 + 1, f"Archive's count to rise from {arch0} after archiving (it shows {num(arch_row)})", timeout=15, every=0.5)
    expect(num(inbox_row) == unread0 - 1, f"the inbox badge changed again on archive: {num(inbox_row)}")

    r.reload()
    expect(num(inbox_row) == unread0 - 1 and num(arch_row) == arch0 + 1,
           f"after a reload the sidebar says inbox {num(inbox_row)} unread / archive {num(arch_row)}; it said {unread0 - 1} / {arch0 + 1} before")
    def fastmail_unread() -> int:
        return len(j.query({"inMailbox": inbox_id, "notKeyword": "$seen"}))
    wait_until(lambda: fastmail_unread() == num(inbox_row),
               f"Fastmail to agree: it has {fastmail_unread()} unread in the inbox, the sidebar shows {num(inbox_row)}", timeout=90, every=3)


@check(36)
def check_36(c: Ctx) -> None:
    """Rapid triage does not rubberband (reported day 1: 'rapidly
    deleting/handling messages presents rubberbanding in the ui' -- `#`
    top-down, and messages that had disappeared reappeared above the
    selected one). Four `#` presses 150ms apart from the top of test-b's
    inbox. Each press must delete a DIFFERENT message (the second used to
    hit the same one again, and the duplicate jumped the selection to the
    top), no row may come back once gone, and the four end up in Trash on
    Fastmail and off the list after a reload."""
    r = c.run
    r.guard_write(["test-b"])
    r.goto("/inbox/test-b")
    start = r.list_rows()
    expect(len(start) >= 6, f"test-b's inbox has only {len(start)} rows; the walk needs six")
    r.page.locator(f'[data-testid="row-{start[0][0]}-{start[0][1]}"]').click(); r.settled()

    posts: list = []
    # Deletes only: read-on-open marks a message read through the same
    # route a second later, and a message advanced past can still fire it.
    def on_request(q) -> None:
        if q.method == "POST" and "/api/triage" in q.url:
            body = json.loads(q.post_data or "{}")
            if body.get("action", {}).get("kind") == "move" and body["action"].get("role") == "trash":
                posts.append(body)
    r.page.on("request", on_request)
    # A burst with no pause -- key-repeat speed. At 60-150ms the next
    # render's handler sometimes won the race and the defect hid.
    for _ in range(4):
        r.page.keyboard.press("#")

    gone: set = set(); resurrected: list = []; samples = 0
    deadline = time.time() + 6
    while time.time() < deadline:
        now = set(r.list_rows()); samples += 1
        came_back = gone & now
        if came_back:
            resurrected.append(sorted(came_back))
        gone |= set(start) - now
        r.page.wait_for_timeout(100)

    targeted = [t["id"] for p in posts for t in p.get("targets", [])]
    expect(len(posts) == 4, f"four presses made {len(posts)} delete requests: {targeted}")
    expect(len(set(targeted)) == 4, f"the four presses did not delete four different messages: {targeted}")
    expect(targeted == [m for _, m in start[:4]], f"deletes were not top-down: {targeted} vs the top four {[m for _, m in start[:4]]}")
    expect(not resurrected, f"rows came back after leaving ({samples} samples): {resurrected[:3]}")
    keys = {("test-b", m) for m in targeted}
    expect(keys <= gone, f"after six seconds these are still listed: {keys - gone}")

    j = c.J["test-b"]
    for m in targeted:
        wait_until(lambda m=m: j.state_of(m)["roles"] == {"trash"}, f"Fastmail to show {m} in Trash only", timeout=90, every=3)
    r.reload()
    after = set(r.list_rows())
    expect(not (keys & after), f"after a reload the deleted rows are back: {keys & after}")
    # One row per CONVERSATION: deleting a thread's newest message surfaces
    # its older sibling as a row. Anything else new is a defect.
    deleted_threads = {_detail(c, {"account": "test-b", "id": m})["threadId"] for m in targeted}
    surfaced = after - (set(start) - keys)
    strangers = [k for k in surfaced if _detail(c, {"account": k[0], "id": k[1]})["threadId"] not in deleted_threads]
    expect(not strangers, f"after a reload these rows appeared that are no thread-mate of a deleted message: {strangers}")
    expect((set(start) - keys) <= after, f"the reload lost rows that were not deleted: {(set(start) - keys) - after}")


@check(37)
def check_37(c: Ctx) -> None:
    """Every control does what it says, or is absent (owner, day 1: "when we
    built the ui, the agent was told to build everything regardless of if it
    was wired up"). Walks Settings (every account card), the folder and
    message menus, the reading pane and the trash banner, and fails on any
    control that is disabled with a "not yet" reason -- except the two the
    owner has ruled deferred: IMAP accounts (roadmap) and the undo-send
    window (ruling 2026-09-05, commit 090d1fe)."""
    r = c.run
    RULED = {
        "proto-imap": "IMAP is on the roadmap (AddAccount.tsx IMAP_REASON)",
        "send-delay": "undo-send window deferred by owner ruling 2026-09-05",
    }
    # Controls that are legitimately disabled for a LIVE reason at scan
    # time, by test id (a prefix when the id carries an account key). The
    # rule is inverted from the first version, which flagged only a
    # "not yet" title and so let a placeholder with a benign title -- or
    # none -- through: now EVERY disabled control is a placeholder unless
    # it is ruled deferred or named here with its live reason.
    LIVE = {
        "acct-up-": "the first account cannot move up",
        "acct-down-": "the last account cannot move down",
        "settings-token-save": "nothing typed into the token field yet",
        "signature-save": "a save in flight",
        "resync-now": "a resync already requested",
        "send": "no recipient yet, or an upload in flight",
        "attach": "an upload in flight",
        "attachment-retry-": "a retry in flight",
    }

    def live_reason(tid: str) -> str | None:
        for k, why in LIVE.items():
            if tid == k or (k.endswith("-") and tid.startswith(k)):
                return why
        return None

    def placeholders(scope: str) -> list[str]:
        found = []
        els = r.page.locator(f"{scope} button[disabled], {scope} input[disabled], {scope} select[disabled], {scope} fieldset[disabled], {scope} [aria-disabled='true']")
        for i in range(els.count()):
            el = els.nth(i)
            title = (el.get_attribute("title") or "").strip()
            tid = el.get_attribute("data-testid") or ""
            label = (el.inner_text() or el.get_attribute("aria-label") or el.get_attribute("placeholder") or "").strip().replace("\n", " ")[:40]
            if tid in RULED or any(tid.startswith(k) for k in RULED):
                continue
            # An option inside a ruled group (the undo-send picker's Off/5s/...).
            if any(el.locator(f"xpath=ancestor::*[@data-testid='{k}']").count() for k in RULED):
                continue
            if live_reason(tid) is not None:
                continue
            found.append(f"{tid or label or '(unnamed)'}: disabled, title {title[:60]!r}")
        return found

    bad: list[str] = []
    # Settings, every account card opened.
    r.goto("/inbox/test-b")
    r.page.keyboard.press(","); r.settled()
    expect(r.page.locator('[data-testid="settings-pane"]').count() == 1, "Settings did not open on ,")
    bad += [f"settings: {x}" for x in placeholders('[data-testid="settings-pane"]')]
    keys = [r.page.locator('[data-testid^="acct-manage-"]').nth(i).get_attribute("data-testid").split("acct-manage-", 1)[1]
            for i in range(r.page.locator('[data-testid^="acct-manage-"]').count())]
    for key in keys:
        r.page.locator(f'[data-testid="acct-manage-{key}"]').click(); r.settled()
        bad += [f"account {key}: {x}" for x in placeholders('[data-testid="settings-pane"]')]
        back = r.page.locator('[data-testid="settings-account-back"]')
        expect(back.count() == 1, f"the account page for {key} has no back button")
        back.click(); r.settled()
    r.page.keyboard.press("Escape"); r.settled()

    # A folder's menu (a custom folder and a role folder), and the trash banner.
    j = c.J["test-b"]
    for mid in (j.mailboxes()["inbox"],):
        r.page.locator(f'[data-testid="mailbox-test-b-{mid}"]').dispatch_event("contextmenu"); r.settled()
        items = r.page.locator('[data-testid^="contextmenu-item-"]')
        for k in range(items.count()):
            it = items.nth(k)
            if it.is_disabled() and live_reason(it.get_attribute("data-testid") or "") is None:
                bad.append(f"folder menu: {it.inner_text().strip()}: disabled, title {(it.get_attribute('title') or '')[:60]!r}")
        r.page.keyboard.press("Escape"); r.settled()
    r.goto("/trash/test-b")
    bad += [f"trash: {x}" for x in placeholders('[data-testid="trash-banner"]')]

    # The reading pane and the message menu.
    p = c.F["plain"]
    r.goto(f"/inbox/{p['account']}/{p['id']}")
    bad += [f"reading: {x}" for x in placeholders('[data-testid="reading"]')]
    r.page.locator('[data-testid="message-menu"]').click(); r.settled()
    items = r.page.locator('[data-testid^="contextmenu-item-"]')
    for k in range(items.count()):
        it = items.nth(k)
        if it.is_disabled() and live_reason(it.get_attribute("data-testid") or "") is None:
            bad.append(f"message menu: {it.inner_text().strip()}: disabled, title {(it.get_attribute('title') or '')[:60]!r}")
    r.page.keyboard.press("Escape")

    # Custom folders in the sidebar must open.
    custom = r.page.locator('[data-testid^="mailbox-test-a-"][disabled], [data-testid^="mailbox-test-b-"][disabled]')
    if custom.count():
        bad.append(f"sidebar: {custom.count()} custom folder row(s) cannot be opened: {custom.first.get_attribute('title')}")

    # A preference that forgets is a placeholder in disguise: flip the
    # theme in Settings, reload, it must still be dark -- then put it back.
    # Flip from whatever the OWNER has, prove the reload, and put it back
    # exactly -- through the API, so the restore cannot depend on the same
    # control that is under test.
    prior_theme = _preference(c, "theme")
    flipped = "light" if prior_theme == "dark" else "dark"
    try:
        r.goto("/inbox/test-b")
        r.page.keyboard.press(","); r.settled()
        # The Theme row is two buttons, Light and Dark, not one toggle.
        r.page.locator(f'[data-testid="{"theme-light" if flipped == "light" else "switch-theme"}"]').click(); r.settled()
        expect(r.page.evaluate("document.documentElement.getAttribute('data-theme')") == flipped, f"the Theme control did not switch to {flipped}")
        r.reload()
        theme_after = r.page.evaluate("document.documentElement.getAttribute('data-theme')")
        expect(theme_after == flipped, f"the theme did not survive a reload (it came back as {theme_after!r})")
    finally:
        r.api_put("/api/preferences", {"key": "theme", "value": prior_theme})
    expect(_preference(c, "theme") == prior_theme, "the owner's theme was not put back")

    uniq = sorted(set(bad))
    expect(not uniq, f"{len(uniq)} placeholder control(s) still in the app:\n    " + "\n    ".join(uniq))


# -- Settings -----------------------------------------------------------

def _solid_png(w: int, h: int, rgb=(200, 30, 30)) -> bytes:
    """A real PNG, so the preview has a genuine image to decode (naturalWidth > 0)."""
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


SIG38_TEXT = "-- \nTest A signature"   # what row 17 sets, byte for byte
SIG38_LINES = ["TEST A HARNESS", "Row 38 signature", "test-a@example.com", "+1 555 0100",
               "Line five", "Line six", "Line seven", "Line eight"]


def _sig38_html() -> str:
    """The shape of the owner's real signature: a table, a base64 logo, then
    lines -- tall enough that a 110px or a browser-default 150px frame clips it."""
    b64 = base64.b64encode(_solid_png(240, 60)).decode()
    return ('<table cellpadding="0" cellspacing="0" border="0" style="max-width:315pt;border-collapse:collapse"><tbody>'
            f'<tr><td style="padding:0 0 10px"><img src="data:image/png;base64,{b64}" width="240" height="60" alt="logo"></td></tr>'
            + "".join(f'<tr><td style="font:13px Arial;padding:2px 0">{line}</td></tr>' for line in SIG38_LINES)
            + "</tbody></table>")


@check(38)
def check_38(c: Ctx) -> None:
    """Owner, 2026-09-06: "The signature interface is poor." The design's
    editor showed a 19,588-character HTML signature -- mostly one base64
    logo -- in a 96px textarea, over a preview cropped to the logo, next to
    a Save button with no stylesheet rule at all. Ruling: the HTML half is
    shown WHOLE here and edited in Fastmail; plain text is edited here."""
    r = c.run
    j = c.J["test-a"]
    ident = j.identity["id"]
    html = _sig38_html()
    res = r.api_put(f"/api/identities/test-a/{ident}/signature", {"textSignature": SIG38_TEXT, "htmlSignature": html})
    expect(res.ok, f"could not set test-a's signature: {res.status}")
    def identity() -> dict:
        return j.call([["Identity/get", {"accountId": j.account_id, "ids": [ident]}, "i"]])[0][1]["list"][0]
    expect(identity()["htmlSignature"] == html, "Fastmail did not store the HTML signature byte for byte")

    r.goto("/inbox/test-b")
    r.page.keyboard.press(","); r.settled()
    r.page.locator('[data-testid="acct-manage-test-a"]').click(); r.settled()
    expect("settings-seg--active" in (r.page.locator('[data-testid="signature-format-html"]').get_attribute("class") or ""),
           "an identity with an HTML signature did not open in HTML mode")
    expect(r.page.locator('[data-testid="signature-text"]').count() == 0, "HTML mode still shows a source textarea")
    link = r.page.locator('[data-testid="signature-edit-in-fastmail"]')
    expect(link.count() == 1 and (link.get_attribute("href") or "").startswith("https://app.fastmail.com/"),
           "no link to edit the HTML in Fastmail")

    # The whole signature, measured: the frame's box against the document
    # inside it (Playwright reaches the cross-origin frame; the page cannot).
    frame = r.page.locator('[data-testid="settings-signature-preview"]')
    wait_until(lambda: frame.count() == 1, "the signature preview frame to mount", timeout=15, every=0.5)
    frame.scroll_into_view_if_needed(); r.settled()
    def metrics() -> dict | None:
        box = frame.bounding_box()
        for fr in r.page.frames:
            if fr.url.startswith(BODY_ORIGIN + "/s/"):
                inner = fr.evaluate("""(() => ({content_h: document.documentElement.scrollHeight,
                    imgs: Array.from(document.querySelectorAll('img')).filter(i => i.naturalWidth > 0).length,
                    text: document.body.innerText}))()""")
                return {"frame_h": round(box["height"]) if box else 0, **inner}
        return None
    wait_until(lambda: (m := metrics()) is not None and m["imgs"] >= 1 and m["frame_h"] >= m["content_h"],
               "the preview frame to fit the signature it shows", timeout=20, every=0.5)
    m = metrics()
    expect(m is not None, "the preview frame did not load from the body origin")
    expect(m["imgs"] >= 1, "the signature's logo did not render in the preview")
    expect(SIG38_LINES[-1] in m["text"], "the last line of the signature is missing from the preview document")
    expect(m["frame_h"] >= m["content_h"], f"the preview frame is {m['frame_h']}px for {m['content_h']}px of signature: it clips")
    r.shot("38-html")

    # Plain text: editable here, a Save button that looks like one, and a
    # round trip that leaves the HTML half alone byte for byte.
    r.page.locator('[data-testid="signature-format-text"]').click(); r.settled()
    ta = r.page.locator('[data-testid="signature-text"]')
    expect(ta.count() == 1 and ta.input_value() == SIG38_TEXT, "plain-text mode does not show the stored text signature byte for byte")
    btn = r.page.locator('[data-testid="signature-save"]')
    expect(btn.count() == 1, "no Save button in plain-text mode")
    def token(name: str) -> str:
        return r.page.evaluate("""n => { const p = document.createElement('span'); p.style.backgroundColor = `var(${n})`;
            document.body.appendChild(p); const v = getComputedStyle(p).backgroundColor; p.remove(); return v; }""", name)
    def style() -> dict:
        return r.page.evaluate("e => { const s = getComputedStyle(e); return {bg: s.backgroundColor, border: s.borderTopColor}; }", btn.element_handle())
    accent, faint = token("--accent"), token("--faint")
    clean = style()
    expect(clean["border"] == faint and clean["bg"] != accent,
           f"the clean Save button is not the design's --faint ghost (border {clean['border']}, bg {clean['bg']}; --faint is {faint})")
    ta.click(); r.page.keyboard.press("Control+End"); r.page.keyboard.type("\nRow 38")
    status = r.page.locator('[data-testid="signature-status"]')
    expect(status.inner_text().strip() == "unsaved changes", f"an edit did not dirty the editor: {status.inner_text()!r}")
    dirty = style()
    expect(dirty["bg"] == accent, f"the dirty Save button is not accent-filled (bg {dirty['bg']}; --accent is {accent})")
    btn.click()
    wait_until(lambda: re.match(r"^saved \d\d:\d\d$", status.inner_text().strip()) is not None,
               "the status to read 'saved HH:MM'", timeout=15, every=0.5)
    after = identity()
    expect(after["textSignature"] == SIG38_TEXT + "\nRow 38", f"Fastmail holds {after['textSignature']!r} after the save")
    expect(after["htmlSignature"] == html, "a plain-text save changed the HTML signature; it must be left alone byte for byte")
    r.shot("38-text")

    # Back to how row 17 and the next run's reset expect it.
    res = r.api_put(f"/api/identities/test-a/{ident}/signature", {"textSignature": SIG38_TEXT, "htmlSignature": ""})
    expect(res.ok, f"could not restore test-a's signature: {res.status}")


# -- HTML compose (owner rulings 2026-09-07) --------------------------------

def _sig_html(lines: list[str]) -> str:
    b64 = base64.b64encode(_solid_png(240, 60)).decode()
    return ('<table cellpadding="0" cellspacing="0" border="0" style="max-width:315pt;border-collapse:collapse"><tbody>'
            f'<tr><td style="padding:0 0 10px"><img src="data:image/png;base64,{b64}" width="240" height="60" alt="logo"></td></tr>'
            + "".join(f'<tr><td style="font:13px Arial;padding:2px 0">{line}</td></tr>' for line in lines)
            + "</tbody></table>")


def _set_signature(c: Ctx, text: str, html: str) -> None:
    ident = c.J["test-a"].identity["id"]
    res = c.run.api_put(f"/api/identities/test-a/{ident}/signature", {"textSignature": text, "htmlSignature": html})
    expect(res.ok, f"could not set test-a's signature: {res.status}")


def _preference(c: Ctx, key: str) -> str:
    """One owner-wide preference as stored. 🚨 The preferences table is the
    OWNER's, shared with the harness: a row that writes one must put back
    what it found (2026-09-08: row 37 left the theme on light after every
    run, and the owner reported dark mode 'not persisted' -- it was being
    overwritten by the gate, four times a day)."""
    return c.run.api_get("/api/preferences")["preferences"][key]


def _set_placement(c: Ctx, value: str) -> None:
    res = c.run.api_put("/api/preferences", {"key": "signaturePlacement", "value": value})
    expect(res.ok, f"could not set signaturePlacement={value}: {res.status}")


@check(39)
def check_39(c: Ctx) -> None:
    """Compose is HTML: what I see is what arrives."""
    r = c.run
    _set_signature(c, "-- \nTest A signature", "")
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
    subj = f"{PREFIX} rich {int(time.time())}"
    r.page.fill('[data-testid="compose-subject"]', subj)
    first = r.page.locator('[data-testid="compose-body"] > p').first
    first.click(); r.page.keyboard.press("Home")
    r.page.keyboard.type("Hello ")
    r.page.locator('[data-testid="rt-bold"]').click(); r.page.keyboard.type("bold"); r.page.locator('[data-testid="rt-bold"]').click()
    r.page.keyboard.type(" and ")
    # Row 46 replaced the native colour input with the swatch grid and the
    # prompt with a popover; the row types the same message through them.
    r.page.locator('[data-testid="rt-color"]').dispatch_event("mousedown"); r.settled()
    r.page.locator('[data-testid="rt-swatch-ff0000"]').dispatch_event("mousedown"); r.settled()
    r.page.keyboard.type("red")
    r.page.keyboard.press("Enter")
    r.page.keyboard.press("Control+k"); r.settled()
    r.page.locator('[data-testid="rt-link-url"]').fill("https://example.test/")
    r.page.locator('[data-testid="rt-link-add"]').dispatch_event("mousedown"); r.settled()
    r.page.keyboard.press("End"); r.page.keyboard.press("Enter")
    r.page.locator('[data-testid="rt-ul"]').click(); r.page.keyboard.type("item one"); r.page.keyboard.press("Enter"); r.page.keyboard.press("Enter")
    r.page.locator('[data-testid="rt-align-center"]').click(); r.page.keyboard.type("centered")
    r.page.locator('[data-testid="rt-image-file"]').set_input_files({"name": "dot.png", "mimeType": "image/png", "buffer": _solid_png(24, 24, (20, 120, 220))})
    r.page.locator('[data-testid="compose-body"] img').first.wait_for(timeout=5000)
    expect(r.page.locator('[data-testid="compose-body"] img').count() >= 1, "the inserted image is not in the editor")
    _click_send(c)
    def resend() -> None:
        raise Problem("row 39's send was lost by Fastmail; rerun the row")
    rid = _found_or_resent(c, c.J["test-b"], subj, resend)
    d = _delivered(c, c.J["test-b"], rid)
    html = d["html"]
    expect("<strong>bold</strong>" in html, "bold did not arrive as <strong>")
    expect(re.search(r"color:\s*(#ff0000|rgb\(255,\s*0,\s*0\))", html, re.I) is not None, "the coloured text did not arrive with its colour")
    expect('href="https://example.test/"' in html, "the link did not arrive")
    expect("<li>item one</li>" in html, "the list item did not arrive as <li>")
    expect(re.search(r"text-align:\s*center", html) is not None, "the centred paragraph did not arrive centred")
    expect('src="cid:' in html, "the inserted image is not referenced by cid: in the HTML half")
    inline = [p for p in _inline_parts(d["structure"]) if (p.get("type") or "").startswith("image/png")]
    expect(len(inline) == 1 and inline[0].get("disposition") == "inline", f"the image did not arrive as one inline image/png part: {inline}")
    for word in ("Hello", "bold", "red", "https://example.test/", "item one", "centered"):
        expect(word in d["text"], f"the text half lacks {word!r}: {d['text'][:200]!r}")
    expect(d["text"].count("Test A signature") == 1, "the signature is not in the text half exactly once")


@check(40)
def check_40(c: Ctx) -> None:
    """The signature is mine to edit and place."""
    r = c.run
    sig_lines = ["TEST A HARNESS", "Row 40 signature", "test-a@example.com"]
    _set_signature(c, "-- \nTest A signature", _sig_html(sig_lines))
    prior_placement = _preference(c, "signaturePlacement")
    _set_placement(c, "above")
    h = c.F["htmlB"]  # in test-a, from test-b
    r.guard_write([h["account"]])
    try:
        r.goto(f"/inbox/{h['account']}/{h['id']}")
        r.page.keyboard.press("r"); r.settled()
        body = r.page.locator('[data-testid="compose-body"]')
        block = r.page.locator('[data-testid="compose-body"] [data-testid="compose-signature"]')
        wait_until(lambda: block.count() == 1, "the signature block to appear in the editor", timeout=10, every=0.5)
        expect(r.page.evaluate("document.querySelector('[data-testid=compose-body]').firstElementChild.tagName") == "P", "the first line of the reply is not an empty paragraph to write on")
        wait_until(lambda: "quote" in _editor_order(c), "the quoted original to appear in the editor", timeout=10, every=0.5)
        order = _editor_order(c)
        expect(order.index("sig") < order.index("quote"), f"above: the signature is not before the quote in the editor: {order}")
        expect(block.locator("img").count() == 1, "the logo is not rendered in the block")
        # Edit a line of the signature, in place.
        cell = block.locator("td", has_text="Row 40 signature")
        cell.click(); r.page.keyboard.press("End"); r.page.keyboard.type(" edited")
        expect("Row 40 signature edited" in block.inner_text(), "typing into the signature block did not change it")
        subj = r.page.locator('[data-testid="compose-subject"]').input_value()
        _type_body(c, "Reply above.")
        _click_send(c)
        def resend() -> None:
            raise Problem("row 40's send was lost by Fastmail; rerun the row")
        rid = _found_or_resent(c, c.J["test-b"], subj, resend, from_email=c.J["test-a"].identity["email"])
        d = _delivered(c, c.J["test-b"], rid)
        t = d["text"]
        expect(t.count("Row 40 signature edited") == 1, f"the edited signature line appears {t.count('Row 40 signature edited')} times in the text half")
        expect("Row 40 signature\n" not in t and t.count("TEST A HARNESS") == 1, "the original signature was appended as well as the edited one")
        expect("wrote:" in t and t.index("Row 40 signature edited") < t.index("wrote:"), "the signature is not ABOVE the quote in the text half")
        expect(d["html"].index("TEST A HARNESS") < d["html"].index("<blockquote"), "the signature is not above the quote in the HTML half")
        expect('src="cid:' in d["html"] and any((p.get("type") or "").startswith("image/png") and p.get("disposition") == "inline" for p in _inline_parts(d["structure"])),
               "the logo did not arrive as an inline cid: part")
        expect("Reply above." in t and t.index("Reply above.") < t.index("Row 40 signature edited"), "the reply text is not above the signature")

        # Below: the block sits under the quote, and arrives there.
        _set_placement(c, "below")
        r.goto(f"/inbox/{h['account']}/{h['id']}")
        r.page.keyboard.press("r"); r.settled()
        wait_until(lambda: "sig" in _editor_order(c) and "quote" in _editor_order(c), "the signature block and the quote in the editor", timeout=10, every=0.5)
        order = _editor_order(c)
        expect(order.index("quote") < order.index("sig"), f"below: the signature is not after the quote in the editor: {order}")
        _type_body(c, "Reply below.")
        _click_send(c)
        def resend_below() -> None:
            # Fastmail lost the send (design doc: measured, accepted by the
            # submission, never delivered). Drop the lost Sent copy and do
            # it once more, like every other sending row.
            _drop_lost_sent(c, "test-a", subj)
            r.goto(f"/inbox/{h['account']}/{h['id']}")
            r.page.keyboard.press("r"); r.settled()
            wait_until(lambda: "sig" in _editor_order(c) and "quote" in _editor_order(c), "the block and the quote (resend)", timeout=10, every=0.5)
            _type_body(c, "Reply below.")
            _click_send(c)
        rid2 = wait_for_second(c, subj, rid, resend_below)
        d2 = _delivered(c, c.J["test-b"], rid2)
        t2 = d2["text"]
        expect("wrote:" in t2 and t2.index("TEST A HARNESS") > t2.index("wrote:"), "with placement=below the signature is not below the quote in the text half")
        expect(d2["html"].index("TEST A HARNESS") > d2["html"].index("<blockquote"), "with placement=below the signature is not below the quote in the HTML half")
    finally:
        _set_placement(c, prior_placement)
        _set_signature(c, "-- \nTest A signature", "")


def wait_for_second(c: Ctx, subject: str, first_id: str, resend) -> str:
    """The id of a SECOND delivery with this subject (the first is known),
    after ONE resend if Fastmail lost the first attempt."""
    j = c.J["test-b"]
    def find():
        ids = [i for i in j.query({"subject": subject, "inMailbox": j.mailboxes()["inbox"]}) if i != first_id]
        return ids[0] if ids else None
    try:
        wait_until(lambda: find() is not None, f"the second reply {subject!r} to arrive", timeout=90, every=3)
    except Problem:
        print(f"  ! the second {subject!r} did not arrive in 90s; resending once (Fastmail send loss)", flush=True)
        resend()
        wait_until(lambda: find() is not None, f"the second reply {subject!r} to arrive after a resend", timeout=90, every=3)
    return find()


@check(41)
def check_41(c: Ctx) -> None:
    """Drafts resume as they were: formatted text, the edited signature, the quote."""
    r = c.run
    _set_signature(c, "-- \nTest A signature", _sig_html(["TEST A HARNESS", "Row 41 signature"]))
    h = c.F["htmlB"]
    r.guard_write([h["account"]])
    j = c.J["test-a"]
    try:
        r.goto(f"/inbox/{h['account']}/{h['id']}")
        r.page.keyboard.press("r"); r.settled()
        block = r.page.locator('[data-testid="compose-body"] [data-testid="compose-signature"]')
        wait_until(lambda: block.count() == 1, "the signature block to appear in the editor", timeout=10, every=0.5)
        cell = block.locator("td", has_text="Row 41 signature")
        cell.click(); r.page.keyboard.press("End"); r.page.keyboard.type(" kept")
        first = r.page.locator('[data-testid="compose-body"] > p').first
        first.click(); r.page.keyboard.press("Home")
        r.page.locator('[data-testid="rt-bold"]').click(); r.page.keyboard.type("draft words"); r.page.locator('[data-testid="rt-bold"]').click()
        subj = r.page.locator('[data-testid="compose-subject"]').input_value()
        status = r.page.locator('[data-testid="compose-draft-status"]')
        saved_re = re.compile(r"draft saved \d\d:\d\d")
        wait_until(lambda: saved_re.search(status.inner_text()) is not None, "the draft to autosave", timeout=15, every=1)
        r.page.locator('[data-testid="compose-close"]').click(); r.settled()
        did = j.find(subj)
        expect("drafts" in j.state_of(did)["roles"], "the draft is not in test-a's Drafts on Fastmail")
        wait_until(lambda: r.page.request.get(f"{BASE}/api/messages/test-a/{did}").status == 200, "Wilco to hold the draft", timeout=90, every=3)
        r.goto(f"/drafts/test-a/{did}")
        body = r.page.locator('[data-testid="compose-body"]')
        wait_until(lambda: "draft words" in body.inner_text(), "the resumed draft to show its text", timeout=15, every=0.5)
        expect(r.page.locator('[data-testid="compose-body"] strong').count() >= 1, "the bold formatting did not survive the round trip")
        blocks = r.page.locator('[data-wilco-signature]')
        expect(blocks.count() == 1, f"the resumed draft holds {blocks.count()} signature blocks; exactly one was saved")
        expect("Row 41 signature kept" in blocks.first.inner_text(), "the edited signature line did not survive the round trip")
        q = r.page.locator('[data-testid="compose-body"] [data-wilco-quote]')
        expect(q.count() == 1, "the resumed draft holds no quoted original")
        expect("Fixture HTML" in q.inner_text(), "the resumed quote is not the original's text")
        _click_send(c)
        def resend() -> None:
            raise Problem("row 41's send was lost by Fastmail; rerun the row")
        rid = _found_or_resent(c, c.J["test-b"], subj, resend, from_email=c.J["test-a"].identity["email"])
        d = _delivered(c, c.J["test-b"], rid)
        expect(d["html"].count("<blockquote") == 1, f"the sent draft carries {d['html'].count('<blockquote')} quotes; one was expected")
        expect(d["text"].count("Row 41 signature kept") == 1, "the signature is not in the sent draft exactly once")
        expect("<strong>draft words</strong>" in d["html"], "the bold text did not arrive as <strong>")
    finally:
        _set_signature(c, "-- \nTest A signature", "")


@check(42)
def check_42(c: Ctx) -> None:
    """Owner, 2026-09-07: "I just got a toast for a message I sent, not
    received." The send confirmation had been built as a new-mail
    NOTIFICATION card with the owner's own address as the sender."""
    r = c.run
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
    subj = f"{PREFIX} sent-toast {int(time.time())}"
    r.page.fill('[data-testid="compose-subject"]', subj)
    _type_body(c, "Not news.")
    _click_send(c)
    # The toast the send raises, read at once and for a few seconds after.
    seen: list[tuple[str, str]] = []
    for _ in range(8):
        for i in range(r.page.locator('[data-testid="toast"]').count()):
            t = r.page.locator('[data-testid="toast"]').nth(i)
            seen.append((t.get_attribute("data-toast-kind") or "", t.inner_text().strip()))
        r.page.wait_for_timeout(500)
    kinds = {k for k, _ in seen}
    expect("notification" not in kinds, f"a new-mail notification announced my own sent message: {[t for k, t in seen if k == 'notification'][:1]}")
    expect(any(k == "undo" and "Sent" in t and subj[:24] in t for k, t in seen), f"no plain 'Sent' confirmation appeared; toasts seen: {sorted(set(seen))[:3]}")
    r.shot("42-sent-toast")


# -- Sidebar folder tree (owner request 2026-09-07) --------------------------

def _mailboxes_of(c: Ctx, account: str) -> list[dict]:
    data = c.run.api_get("/api/mailboxes")
    entries = data.get("accounts", data) if isinstance(data, dict) else data
    for a in entries:
        if isinstance(a, dict) and a.get("account") == account:
            return a.get("mailboxes", [])
    return [m for m in entries if isinstance(m, dict) and m.get("account") == account]


@check(43)
def check_43(c: Ctx) -> None:
    """Fastmail folders nest (`parent`); personal's "Archived Folders" has
    twelve children. The sidebar renders the tree, a parent folds, a folded
    parent rolls up its subtree's count, and the fold survives a reload."""
    r = c.run
    r.guard_write(["test-a"])
    j = c.J["test-a"]
    parent = f"Harness Parent {int(time.time())}"
    pid = j.call([["Mailbox/set", {"accountId": j.account_id, "create": {"p": {"name": parent, "parentId": None}}}, "mb"]])[0][1]["created"]["p"]["id"]
    kids = j.call([["Mailbox/set", {"accountId": j.account_id, "create": {
        "a": {"name": "Child A", "parentId": pid}, "b": {"name": "Child B", "parentId": pid}}}, "mb2"]])[0][1]["created"]
    aid, bid = kids["a"]["id"], kids["b"]["id"]
    h = c.F["htmlB"]  # in test-a
    j.set(update={h["id"]: {"mailboxIds": {aid: True}}})
    try:
        def known() -> dict:
            return {m["id"]: m for m in _mailboxes_of(c, "test-a")}
        wait_until(lambda: {pid, aid, bid} <= set(known()), "Wilco to learn the three folders", timeout=120, every=3)
        expect(known()[aid].get("parent") == pid and known()[bid].get("parent") == pid, "the API does not report the children's parent")
        wait_until(lambda: (known()[aid].get("total") or 0) == 1, "Wilco to count the message moved into Child A", timeout=120, every=3)

        r.goto("/inbox/test-a")
        def order() -> list[str]:
            return r.page.evaluate("""Array.from(document.querySelectorAll('[data-testid^="mailbox-test-a-"]')).map(e => e.getAttribute('data-testid').slice(15))""")
        wait_until(lambda: {pid, aid, bid} <= set(order()), "the sidebar to show the three folders", timeout=30, every=1)
        ids = order()
        expect(ids.index(pid) < ids.index(aid) < ids.index(bid) or ids.index(pid) < ids.index(bid) < ids.index(aid),
               f"the children do not follow their parent in the sidebar: {[i for i in ids if i in (pid, aid, bid)]}")
        depth = lambda i: r.page.locator(f'[data-testid="mailbox-test-a-{i}"]').get_attribute("data-depth")
        expect(depth(pid) == "0" and depth(aid) == "1" and depth(bid) == "1", f"the children are not nested one level under the parent (depths {depth(pid)}, {depth(aid)}, {depth(bid)})")
        chev = r.page.locator(f'[data-testid="folder-chev-test-a-{pid}"]')
        expect(chev.count() == 1, "the parent has no fold control")
        count = r.page.locator(f'[data-testid="folder-count-test-a-{pid}"]')
        expect(count.inner_text().strip() == "", f"expanded, the empty parent shows {count.inner_text()!r}, not its own (empty) count")
        chev.click(); r.settled()
        expect(aid not in order() and bid not in order(), "folding did not hide the children")
        expect(count.inner_text().strip() == "1", f"folded, the parent shows {count.inner_text()!r}; the child's one message should roll up")
        r.shot("43-folded")
        r.reload()
        wait_until(lambda: pid in order(), "the sidebar after the reload", timeout=30, every=1)
        expect(aid not in order(), "the fold did not survive a reload")
        r.page.locator(f'[data-testid="folder-chev-test-a-{pid}"]').click(); r.settled()
        expect(aid in order() and bid in order(), "unfolding did not bring the children back")
    finally:
        j.set(update={h["id"]: {"mailboxIds": {j.mailboxes()["inbox"]: True}}})
        j.call([["Mailbox/set", {"accountId": j.account_id, "destroy": [aid, bid], "onDestroyRemoveEmails": True}, "md1"]])
        j.call([["Mailbox/set", {"accountId": j.account_id, "destroy": [pid], "onDestroyRemoveEmails": True}, "md2"]])


@check(44)
def check_44(c: Ctx) -> None:
    """Owner ruling 2026-09-07: parity with every other client -- the quoted
    original is ordinary editable text in the reply. Trim a paragraph of it;
    the reply goes out without that paragraph, with the sender's remote
    image restored and the rest of the original's markup intact."""
    r = c.run
    h = c.F["htmlB"]  # in test-a, from test-b; HTML with a remote image and a link
    r.guard_write([h["account"]])
    _set_signature(c, "-- \nTest A signature", "")
    r.goto(f"/inbox/{h['account']}/{h['id']}")
    r.page.keyboard.press("r"); r.settled()
    q = r.page.locator('[data-testid="compose-body"] blockquote[data-wilco-quote]')
    wait_until(lambda: q.count() == 1, "the quoted original to appear in the editor", timeout=10, every=0.5)
    expect(q.locator("p", has_text="Paragraph 3:").count() == 1, "the original's paragraphs are not in the quote")
    expect(q.locator('img[data-wilco-blocked][data-wilco-src^="https://"]').count() == 1, "the original's remote image is not held as a blocked placeholder with its URL")
    expect(q.locator('a[href="https://example.com/link"]').count() == 1, "the original's link is not in the quote")
    # Trim: select the third paragraph and delete it, as a person would.
    para = q.locator("p", has_text="Paragraph 3:")
    para.click(click_count=3); r.page.keyboard.press("Delete"); r.settled()
    expect("Paragraph 3:" not in q.inner_text() and "Paragraph 4:" in q.inner_text(), "deleting inside the quote did not remove just that paragraph")
    # A subject of its own: rows 40 and 41 send replies to the same fixture in
    # the same run, and `find` would hand back one of theirs.
    subj = f"Re: [wilco-check] htmlB trimmed {int(time.time())}"
    r.page.fill('[data-testid="compose-subject"]', subj)
    _type_body(c, "Trimmed reply.")
    _click_send(c)
    def resend() -> None:
        raise Problem("row 44's send was lost by Fastmail; rerun the row")
    rid = _found_or_resent(c, c.J["test-b"], subj, resend, from_email=c.J["test-a"].identity["email"])
    d = _delivered(c, c.J["test-b"], rid)
    html, text = d["html"], d["text"]
    expect("Paragraph 3:" not in html and "Paragraph 4:" in html, "the trimmed paragraph is still in the sent HTML, or the rest went too")
    expect(html.count("<blockquote") == 1 and "Paragraph 4:" in html[html.index("<blockquote"):], "the quote did not go out as one blockquote")
    expect('src="https://httpbin.org/image/png"' in html, "the original's remote image was not restored in the sent HTML")
    expect("data-wilco-src" not in html and "data-wilco-blocked" not in html, "editor markers leaked into the sent message")
    expect('href="https://example.com/link"' in html, "the original's link did not survive")
    expect("Trimmed reply." in text and "> Paragraph 4:" in text and "Paragraph 3:" not in text, f"the text half is wrong: {text[:200]!r}")
    expect(text.index("Trimmed reply.") < text.index("wrote:") < text.index("> Paragraph 4:"), "the text half is not reply, attribution, quote")


@check(45)
def check_45(c: Ctx) -> None:
    """Owner ruling 2026-09-07 (parity): a paste keeps lists, links, bold and
    italic, drops headings and inline CSS, and a pasted image goes inline --
    Fastmail's sanitiser as measured by Claude in Chrome."""
    r = c.run
    _set_signature(c, "-- \nTest A signature", "")
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
    subj = f"{PREFIX} paste {int(time.time())}"
    r.page.fill('[data-testid="compose-subject"]', subj)
    first = r.page.locator('[data-testid="compose-body"] > p').first
    first.click(); r.page.keyboard.press("Home")
    r.page.evaluate("""() => {
        const el = document.querySelector('[data-testid="compose-body"]');
        const dt = new DataTransfer();
        dt.setData('text/html', '<h2 style="color:red;font-family:Georgia">Pasted heading</h2><ul><li><strong>one</strong></li><li><em>two</em> <a href="https://example.test/p" onclick="alert(1)">a link</a></li></ul><p style="background-color:#ffff00">highlighted</p>');
        dt.setData('text/plain', 'Pasted heading\\none\\ntwo a link\\nhighlighted');
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }""")
    body = r.page.locator('[data-testid="compose-body"]')
    body.locator("ul li strong", has_text="one").first.wait_for(timeout=5000)
    expect(body.locator("ul li strong", has_text="one").count() == 1, "the pasted list did not keep its structure and bold")
    expect(body.locator('a[href="https://example.test/p"]').count() == 1, "the pasted link did not survive")
    expect(body.locator("h2").count() == 0 and "Pasted heading" in body.inner_text(), "the heading should be flattened to text, not kept as <h2>")
    expect(body.locator('ul[style], li[style], p[style], a[style], strong[style]').count() == 0, "the page's inline CSS came along with the paste")
    # An image on the clipboard goes inline.
    png_b64 = base64.b64encode(_solid_png(32, 32, (20, 120, 220))).decode()
    r.page.evaluate("""(b64) => {
        const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
        const file = new File([bytes], 'pasted.png', { type: 'image/png' });
        const dt = new DataTransfer(); dt.items.add(file);
        document.querySelector('[data-testid="compose-body"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }""", png_b64)
    wait_until(lambda: body.locator('img[src^="data:image/png"]').count() >= 1, "the pasted image to appear inline", timeout=10, every=0.3)
    _click_send(c)
    def resend() -> None:
        raise Problem("row 45's send was lost by Fastmail; rerun the row")
    rid = _found_or_resent(c, c.J["test-b"], subj, resend)
    d = _delivered(c, c.J["test-b"], rid)
    html = d["html"]
    expect("<li><strong>one</strong></li>" in html, "the pasted list did not arrive with its structure")
    expect('href="https://example.test/p"' in html, "the pasted link did not arrive")
    expect("<h2" not in html and "Pasted heading" in html, "the heading arrived as an element, or its text was lost")
    expect('src="cid:' in html and any((p.get("type") or "").startswith("image/png") and p.get("disposition") == "inline" for p in _inline_parts(d["structure"])),
           "the pasted image did not arrive as an inline cid: part")


@check(46)
def check_46(c: Ctx) -> None:
    """Toolbar parity with Fastmail (owner, 2026-09-07): text size, the
    40-swatch colour grid, a link popover on Ctrl-K, nine faces, and the
    list/quote/alignment controls behind More in a narrow pane."""
    r = c.run
    _set_signature(c, "-- \nTest A signature", "")
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
    subj = f"{PREFIX} toolbar {int(time.time())}"
    r.page.fill('[data-testid="compose-subject"]', subj)
    body = r.page.locator('[data-testid="compose-body"]')
    first = body.locator("> p").first
    first.click(); r.page.keyboard.press("Home")
    # Fonts and sizes.
    fonts = r.page.locator('[data-testid="rt-font"] option').all_inner_texts()
    expect(fonts == ["Default", "Arial", "Georgia", "Helvetica", "Monospace", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"], f"font faces: {fonts}")
    sizes = r.page.locator('[data-testid="rt-size"] option').all_inner_texts()
    expect(sizes == ["Size", "Small", "Medium", "Large", "Huge"], f"text sizes: {sizes}")
    r.page.locator('[data-testid="rt-size"]').select_option("5"); r.page.keyboard.type("large ")
    expect(body.locator('span[style*="font-size"]', has_text="large").count() >= 1, "choosing Large did not size the typed text")
    # The colour grid.
    r.page.locator('[data-testid="rt-color"]').dispatch_event("mousedown"); r.settled()
    grid = r.page.locator('[data-testid="rt-color-grid"]')
    expect(grid.count() == 1, "the colour button opened no grid")
    n = grid.locator('[data-testid^="rt-swatch-"]').count()
    expect(n == 40, f"the colour grid has {n} swatches, not Fastmail's 40")
    r.page.locator('[data-testid="rt-swatch-ff0000"]').dispatch_event("mousedown"); r.settled()
    r.page.keyboard.type("red ")
    expect(body.locator('span[style*="color"]', has_text="red").count() >= 1, "choosing a swatch did not colour the typed text")
    expect(grid.count() == 0, "the grid stayed open after a choice")
    # The link popover on Ctrl-K.
    r.page.keyboard.press("Control+k"); r.settled()
    pop = r.page.locator('[data-testid="rt-link-popover"]')
    expect(pop.count() == 1, "Ctrl-K opened no link popover")
    r.page.locator('[data-testid="rt-link-url"]').fill("www.example.test/x")
    r.page.locator('[data-testid="rt-link-add"]').dispatch_event("mousedown"); r.settled()
    expect(pop.count() == 0, "the popover stayed open after Add")
    expect(body.locator('a[href="https://www.example.test/x"]').count() == 1, "the link was not applied with https added")
    # Narrow pane: the list, quote and alignment controls go behind More.
    # 1100px: the three-pane layout holds (below 1024 the reading pane
    # overlays the list and the compose card is not rendered at all -- a
    # small-screen matter the confidence spec puts out of scope) and the
    # toolbar measures ~450px, under the 700px threshold.
    toolbar = r.page.locator('[data-testid="compose-body-toolbar"]')
    r.page.set_viewport_size({"width": 1100, "height": 900})
    try:
        wait_until(lambda: toolbar.get_attribute("data-compact") == "1", "the toolbar to go compact in a narrow pane", timeout=5, every=0.2)
        expect(r.page.locator('[data-testid="rt-more"]').count() == 1, "a narrow pane shows no More button")
        expect(r.page.locator('[data-testid="compose-body-toolbar"] > [data-testid="rt-align-center"]').count() == 0, "the alignment controls are still inline in a narrow pane")
        r.page.locator('[data-testid="rt-more"]').dispatch_event("mousedown"); r.settled()
        expect(r.page.locator('[data-testid="rt-more-menu"] [data-testid="rt-align-center"]').count() == 1, "More does not hold the alignment controls")
        r.page.keyboard.press("Escape"); r.settled()
        expect(r.page.locator('[data-testid="compose-card"]').count() == 1, "Escape on an open picker closed the whole composer")
        expect(r.page.locator('[data-testid="rt-more-menu"]').count() == 0, "Escape did not close the More menu")
    finally:
        r.page.set_viewport_size({"width": 1440, "height": 950})
    wait_until(lambda: toolbar.get_attribute("data-compact") == "0", "the toolbar to return to the full bar", timeout=5, every=0.2)
    expect(r.page.locator('[data-testid="rt-more"]').count() == 0 and r.page.locator('[data-testid="rt-align-center"]').count() == 1, "back at full width the controls did not return to the bar")
    _click_send(c)
    def resend() -> None:
        raise Problem("row 46's send was lost by Fastmail; rerun the row")
    rid = _found_or_resent(c, c.J["test-b"], subj, resend)
    d = _delivered(c, c.J["test-b"], rid)
    expect('href="https://www.example.test/x"' in d["html"], "the link did not arrive")
    expect(re.search(r"font-size:\s*[^;\"]+", d["html"]) is not None, "the text size did not arrive")
    expect(re.search(r"color:\s*(#ff0000|rgb\(255,\s*0,\s*0\))", d["html"], re.I) is not None, "the swatch colour did not arrive")


@check(47)
def check_47(c: Ctx) -> None:
    """Owner, 2026-09-07 evening (screenshot): on a long reply chain the Send
    bar floated over the message text. The footer was a child of the
    scrolling body and the editor was flex-squeezed, so its overflow drew
    under a transparent footer. The footer must sit below all of the text,
    and the text must scroll -- inside the body, not behind the bar."""
    r = c.run
    h = c.F["html"]  # in test-b: 40 paragraphs, taller than any pane
    r.page.set_viewport_size({"width": 1440, "height": 800})
    try:
        r.goto(f"/inbox/{h['account']}/{h['id']}")
        r.page.keyboard.press("r"); r.settled()
        wait_until(lambda: r.page.locator('[data-testid="compose-body"] [data-wilco-quote]').count() == 1, "the quoted original in the editor", timeout=10, every=0.5)
        m = r.page.evaluate("""(() => {
            const q = s => document.querySelector(s); const box = e => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
            const editor = q('[data-testid="compose-body"]'), footer = q('.compose-footer'), send = q('[data-testid="send"]');
            const scroller = (() => { let e = editor; while (e && e !== document.body) { const o = getComputedStyle(e).overflowY; if (o === 'auto' || o === 'scroll') return e; e = e.parentElement; } return null; })();
            const last = editor.lastElementChild;
            // Scrolled to the end: the last line must sit fully ABOVE the bar.
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
            return { editor: box(editor), editorScroll: [editor.scrollHeight, editor.clientHeight], footer: box(footer), send: box(send),
                     lastChild: box(last), scrollerBox: scroller ? box(scroller) : null,
                     scrollerHasFooter: scroller ? scroller.contains(footer) : null, scroller: scroller ? [scroller.scrollHeight, scroller.clientHeight] : null,
                     footerBg: getComputedStyle(footer).backgroundColor };
        })()""")
        expect(m["scroller"] is not None and m["scroller"][0] > m["scroller"][1], f"the reply is not tall enough to scroll, so nothing is measured: {m}")
        expect(m["scrollerHasFooter"] is False, "the Send bar is inside the scrolling body: it scrolls with the text instead of staying below it")
        expect(m["editorScroll"][0] <= m["editorScroll"][1] + 1, f"the editor hides its own overflow ({m['editorScroll']}); text beyond its box is drawn under whatever follows")
        expect(m["scrollerBox"]["bottom"] <= m["footer"]["top"] + 0.5, f"the scrolling body ({m['scrollerBox']['bottom']:.0f}px) extends under the Send bar (top {m['footer']['top']:.0f}px)")
        expect(m["lastChild"]["bottom"] <= m["footer"]["top"] + 0.5, f"scrolled to the end, the last line ({m['lastChild']['bottom']:.0f}px) still runs under the Send bar (top {m['footer']['top']:.0f}px)")
        expect(m["footerBg"] not in ("rgba(0, 0, 0, 0)", "transparent"), "the Send bar has no background, so anything behind it shows through")
        r.shot("47-footer")
    finally:
        r.page.set_viewport_size({"width": 1440, "height": 950})
        r.page.locator('[data-testid="discard"]').click(); r.settled()


@check(48)
def check_48(c: Ctx) -> None:
    """Owner, 2026-09-07 evening: "I continue to see test messages
    reappearing in the combined inbox." Every run's reset put the fixtures
    back. Ruling: a per-account 'Show in All inboxes' switch, off for the
    harness accounts between runs. Off: out of the unified list and its
    count; still in the sidebar and its own view. On: back."""
    r = c.run
    r.guard_write(["test-b"])
    def unified_accounts() -> set[str]:
        return {a for a, _ in r.list_rows()}
    def visible_total() -> int:
        return int(r.page.locator('[data-testid="total-unread"]').inner_text().split()[0].replace(",", ""))
    def inbox_unread(account: str) -> int:
        return sum(m.get("unread", 0) for m in _mailboxes_of(c, account) if m.get("role") == "inbox")
    r.goto("/inbox")
    expect("test-b" in unified_accounts(), "the run starts with test-b in All inboxes (the reset switches it in); it is missing")
    before = visible_total()
    res = r.api_put("/api/accounts/test-b/settings", {"key": "showInUnified", "value": "off"})
    expect(res.ok, f"could not switch test-b out: HTTP {res.status}")
    try:
        r.goto("/inbox")
        expect("test-b" not in unified_accounts(), "switched off, test-b's messages are still in All inboxes")
        expect("test-a" in unified_accounts(), "switching test-b off took test-a with it")
        after = visible_total()
        expect(after == before - inbox_unread("test-b"), f"the All inboxes count went {before} → {after}; test-b's inbox holds {inbox_unread('test-b')} unread and should have left the count")
        expect(r.page.locator('[data-testid="account-block-test-b"]').count() == 1, "test-b left the sidebar; it should only leave the combined inbox")
        r.goto("/inbox/test-b")
        expect(len(r.list_rows()) >= 1 and all(a == "test-b" for a, _ in r.list_rows()), "test-b's own view no longer shows its messages")
        # The switch in Settings shows the state and flips it back.
        r.page.keyboard.press(","); r.settled()
        r.page.locator('[data-testid="acct-manage-test-b"]').click(); r.settled()
        sw = r.page.locator('[data-testid="show-in-unified"]')
        expect(sw.count() == 1 and sw.get_attribute("aria-pressed") == "false", "the account page does not show the switch off")
        sw.click(); r.settled()
        expect(sw.get_attribute("aria-pressed") == "true", "the switch did not turn on")
        r.page.keyboard.press("Escape"); r.settled()
        r.goto("/inbox")
        expect("test-b" in unified_accounts(), "switched back on, test-b did not return to All inboxes")
        r.shot("48-unified")
    finally:
        r.api_put("/api/accounts/test-b/settings", {"key": "showInUnified", "value": "on"})


@check(49)
def check_49(c: Ctx) -> None:
    """Owner, 2026-09-08: "dark mode/light mode doesn't seem to be persisted".
    It was -- on the server -- and applied half a second after the page had
    painted light. The head script now stamps the mirrored choice before the
    first paint. Measured at the first frame, not after settling."""
    r = c.run
    prior = r.api_get("/api/preferences")["preferences"]["theme"]
    res = r.api_put("/api/preferences", {"key": "theme", "value": "dark"})
    expect(res.ok, f"could not set the theme: HTTP {res.status}")
    try:
        r.goto("/inbox")  # applies the loaded preference, which writes the mirror
        expect(r.page.evaluate("document.documentElement.getAttribute('data-theme')") == "dark", "the app did not apply the stored dark theme")
        # Now the reload: sample the document the moment it exists, before the
        # app's data can have arrived.
        r.page.goto(BASE + "/inbox", wait_until="commit")
        # The head has been parsed once #app exists; the app module has not
        # yet fetched anything. That is the first frame a person can see.
        r.page.wait_for_function("document.getElementById('app') !== null", timeout=10000)
        first = r.page.evaluate("[document.documentElement.getAttribute('data-theme'), document.readyState, (()=>{try{return localStorage.getItem('wilco.theme')}catch(e){return 'n/a'}})()]")
        expect(first[0] == "dark", f"the first frame of a reload is not dark: data-theme={first[0]!r} at readyState={first[1]}, mirror={first[2]!r}")
        bg = r.page.evaluate("getComputedStyle(document.body).backgroundColor")
        expect(bg != "rgb(243, 244, 245)", f"the first paint is the light palette ({bg})")
        r.settled()
        expect(r.page.evaluate("document.documentElement.getAttribute('data-theme')") == "dark", "the theme changed after the server answered; the mirror and the server disagree")
        r.shot("49-first-frame")
    finally:
        r.api_put("/api/preferences", {"key": "theme", "value": prior})


@check(50)
def check_50(c: Ctx) -> None:
    """Owner, 2026-09-08: "The to field is an input box that's hardly big
    enough for one address." Measured: 153px in a 756px row. The field must
    be as wide as the subject field beside the same label column."""
    r = c.run
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    to = r.page.locator('[data-testid="compose-to"]').bounding_box()
    subj = r.page.locator('[data-testid="compose-subject"]').bounding_box()
    row = r.page.locator('[data-testid="field-to"]').bounding_box()
    expect(to is not None and subj is not None and row is not None, "the To, subject or row box is missing")
    expect(to["width"] >= 0.8 * subj["width"], f"the To field is {to['width']:.0f}px wide; the subject field beside the same labels is {subj['width']:.0f}px")
    two = "someone.with.a.long.name@example-domain.com, another.person@example.org"
    r.page.fill('[data-testid="compose-to"]', two)
    fits = r.page.evaluate("""() => { const i = document.querySelector('[data-testid="compose-to"]'); return i.scrollWidth <= i.clientWidth + 1; }""")
    expect(fits, "two ordinary addresses do not fit in the To field without scrolling")
    r.shot("50-to-field")
    r.page.locator('[data-testid="discard"]').click(); r.settled()


@check(51)
def check_51(c: Ctx) -> None:
    """Owner, 2026-09-08: "On drop, with a file hovered on the window, show a
    box to drop it in when in compose mode." The Attach button's hidden
    input could never take a drop. Synthetic drag events carry a real File
    in a DataTransfer; the browser's own OS drag cannot be scripted."""
    r = c.run
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    expect(r.page.locator('[data-testid="drop-target"]').count() == 0, "a drop box is showing before any drag")
    b64 = base64.b64encode(PDF_BYTES).decode()
    r.page.evaluate("""(b64) => {
        const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
        const f = new File([bytes], "dropped.bin", { type: "application/octet-stream" });
        const dt = new DataTransfer(); dt.items.add(f);
        window.__wilcoDT = dt;
        window.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }""", b64)
    wait_until(lambda: r.page.locator('[data-testid="drop-target"]').count() == 1, "the drop box to appear while a file is over the window", timeout=5, every=0.2)
    r.shot("51-drop-box")
    r.page.evaluate("""() => {
        const box = document.querySelector('[data-testid="drop-target"]');
        box.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__wilcoDT }));
    }""")
    wait_until(lambda: r.page.locator('[data-testid="attachment-chip-dropped.bin"]').count() == 1, "the dropped file's chip", timeout=20, every=1)
    expect(r.page.locator('[data-testid="drop-target"]').count() == 0, "the drop box stayed after the drop")
    r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
    subj = f"{PREFIX} dropped-attach"
    _compose_send(c, subj, "Dropped a file.")
    def resend() -> None:
        raise Problem("row 51's send was lost by Fastmail; rerun the row")
    rid = _found_or_resent(c, c.J["test-b"], subj, resend)
    att = c.J["test-b"].get([rid], ["attachments"])[0]["attachments"]
    blob = next((a for a in att if a["name"] == "dropped.bin"), None)
    expect(blob is not None and blob["size"] == len(PDF_BYTES), f"arrived attachments: {att}")
    expect(c.J["test-b"].download(blob["blobId"]) == PDF_BYTES, "the dropped file arrived with the wrong bytes")


@check(52)
def check_52(c: Ctx) -> None:
    """Owner, 2026-09-08: "I have an email with a jpg attachment, I seem to
    have no way of opening it." The chip downloaded the file to a folder and
    showed nothing. A raster image now opens in a viewer inside the app."""
    r = c.run
    p = c.F["photo"]
    r.goto(f"/inbox/{p['account']}/{p['id']}")
    chip = r.page.locator('[data-testid="attachment-0"]')
    expect(chip.count() == 1, "the image attachment is not listed")
    expect(chip.evaluate("e => e.tagName") == "BUTTON", "the image chip is still a download link, not a viewer button")
    chip.click(); r.settled()
    img = r.page.locator('[data-testid="attachment-image"]')
    expect(img.count() == 1, "the viewer did not open with an image")
    wait_until(lambda: img.evaluate("i => i.complete && i.naturalWidth") == 320, "the image to load from the body origin", timeout=15, every=0.5)
    expect(img.evaluate("i => i.naturalHeight") == 200, "the image decoded to the wrong size")
    r.shot("52-viewer")
    dl = r.page.locator('[data-testid="attachment-download"]')
    expect(dl.count() == 1 and not dl.is_disabled(), "Download is missing or disabled in the viewer")
    with r.page.expect_popup(timeout=10000) as pop:
        dl.click()
    r.page.wait_for_timeout(500)
    r.page.keyboard.press("Escape"); r.settled()
    expect(r.page.locator('[data-testid="attachment-image"]').count() == 0, "Escape did not close the viewer")
    # The PDF fixture still downloads, as row 6 proves: its chip stays a link.
    a = c.F["attach"]
    r.goto(f"/inbox/{a['account']}/{a['id']}")
    expect(r.page.locator('[data-testid="attachment-0"]').evaluate("e => e.tagName") == "A", "the PDF chip should still be a download link")


@check(53)
def check_53(c: Ctx) -> None:
    """Owner, 2026-09-09: "the triple dot context menu appears offscreen over
    an email" -- the message card's ··· sits at the right edge and the menu
    was anchored to the click's top-left corner. Every menu goes through one
    overlay, so the message, folder and row menus are all measured here."""
    r = c.run
    p = c.F["plain"]
    r.goto(f"/inbox/{p['account']}/{p['id']}")
    vw, vh = r.page.evaluate("[window.innerWidth, window.innerHeight]")
    def within(what: str) -> None:
        card = r.page.locator('[data-testid="contextmenu-overlay"] [data-testid="overlay-card"]')
        expect(card.count() == 1, f"{what}: no menu opened")
        b = card.bounding_box()
        expect(b["x"] >= 0 and b["y"] >= 0 and b["x"] + b["width"] <= vw and b["y"] + b["height"] <= vh,
               f"{what}: the menu spans x {b['x']:.0f}..{b['x'] + b['width']:.0f}, y {b['y']:.0f}..{b['y'] + b['height']:.0f} in a {vw}x{vh} window")
    r.page.locator('[data-testid="message-menu"]').click(); r.settled()
    within("the message's ··· menu")
    r.shot("53-message-menu")
    r.page.keyboard.press("Escape"); r.settled()
    # A folder menu opened at the very bottom-right corner must be pulled in too.
    mid = _inbox_id(c, p["account"])
    r.page.locator(f'[data-testid="mailbox-{p["account"]}-{mid}"]').dispatch_event("contextmenu", {"clientX": vw - 2, "clientY": vh - 2, "bubbles": True})
    r.settled()
    within("a folder menu opened at the bottom-right corner")
    r.page.keyboard.press("Escape"); r.settled()


@check(54)
def check_54(c: Ctx) -> None:
    """Owner, 2026-09-09: "Depending on the unsub button the location of
    actions change in the ui, which means I have to chase buttons that move
    for chaining actions." The bar had wrapped when Unsubscribe was in it,
    and prev/next sat there too. Measured: the same buttons at the same
    coordinates on a mailing-list message and a plain one."""
    r = c.run
    def bar(msg) -> dict[str, tuple[float, float]]:
        r.goto(f"/inbox/{msg['account']}/{msg['id']}")
        out = {}
        for b in r.page.locator('[data-testid="reading-actions"] button').all():
            box = b.bounding_box(); out[b.get_attribute("data-testid") or "?"] = (round(box["x"]), round(box["y"]))
        return out
    plain = bar(c.F["plain"])
    unsub = bar(c.F["unsub"])
    expect(r.page.locator('[data-testid="reading-actions"] [data-testid="unsubscribe"]').count() == 0, "Unsubscribe is in the action bar")
    expect(r.page.locator('[data-testid="unsubscribe"]').count() == 1, "the mailing-list message offers no Unsubscribe")
    expect("act-prev" not in plain and "act-next" not in plain, "previous/next buttons are still in the bar")
    expect(set(plain) == set(unsub), f"the bar's buttons differ between messages: {sorted(set(plain) ^ set(unsub))}")
    moved = {k: (plain[k], unsub[k]) for k in plain if plain[k] != unsub[k]}
    expect(not moved, f"buttons moved between a plain message and a mailing-list one: {moved}")
    r.shot("54-bar")


@check(55)
def check_55(c: Ctx) -> None:
    """Owner, 2026-09-09: "when I mark a message as spam it disappears from the
    inbox listing, but the message stays up." Spam was not a move to the
    client, and archive/delete on the LAST row re-opened the leaving
    message. Proven on spam from the middle of the list and archive on the
    last row; both go through the one triage path every action uses."""
    from fixtures import SPAM_FOLDER
    r = c.run
    # test-a: the persistent harness spam folder lives there (row 11). Any
    # row but the last will do; every message in this inbox is a fixture
    # the next reset puts back.
    acct = "test-a"
    r.guard_write([acct])
    spam_id = next((m["id"] for m in _mailboxes_of(c, acct) if m.get("name") == SPAM_FOLDER), None)
    expect(spam_id is not None, f"Wilco does not list {SPAM_FOLDER!r} for {acct}")
    res = r.api_put(f"/api/accounts/{acct}/settings", {"key": "spamMailboxId", "value": spam_id})
    expect(res.ok, f"could not configure the spam folder: HTTP {res.status}")
    r.goto(f"/inbox/{acct}")
    rows = r.list_rows()
    expect(len(rows) >= 2, f"{acct}'s inbox holds {len(rows)} rows; the check needs a row with one below it")
    idx = 0
    target, below = rows[0], rows[1]
    r.page.locator(f'[data-testid="row-{target[0]}-{target[1]}"]').click(); r.settled()
    r.page.locator('[data-testid="act-spam"]').click(); r.settled()
    expect(target not in r.list_rows(), "the row marked as spam is still in the list")
    opened = r.page.url.rstrip("/").rsplit("/", 1)[-1]
    expect(opened == below[1], f"after Mark spam the pane shows {opened!r}; the next available message is {below[1]!r}")
    expect(r.reading_subject() != "", "the pane advanced but shows no message")
    r.shot("55-after-spam")
    # The LAST row, archived: nothing is left below or above it to show... unless there is.
    rows = r.list_rows()
    last = rows[-1]
    r.page.locator(f'[data-testid="row-{last[0]}-{last[1]}"]').click(); r.settled()
    r.page.locator('[data-testid="act-archive"]').click(); r.settled()
    expect(last not in r.list_rows(), "the archived last row is still in the list")
    after = r.page.url.rstrip("/").rsplit("/", 1)[-1]
    expect(after != last[1], f"the pane still shows the archived message {last[1]!r}")
    expect(r.page.locator('[data-testid="reading-empty"]').count() == 1 or r.reading_subject() != "", "the pane shows neither nothing nor a message")


@check(56)
def check_56(c: Ctx) -> None:
    """Feature audit, 2026-09-10: the composer's footer said "⌘⏎ send" and the
    Send button's tooltip "Send (⌘⏎)", and no handler existed. A promise in
    the UI that is false is what row 37 exists to remove; this row proves
    the key by delivery, the way row 17 proves the button."""
    r = c.run
    r.goto("/inbox/test-a")
    _compose_as(c, "test-a")
    r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
    subj = f"{PREFIX} keysend {int(time.time())}"
    r.page.fill('[data-testid="compose-subject"]', subj)
    _type_body(c, "Sent with the keyboard.")
    r.page.locator('[data-testid="compose-body"]').press("Control+Enter")
    wait_until(lambda: r.page.locator('[data-testid="compose-card"]').count() == 0, "compose to close after ⌘⏎", timeout=20, every=1)
    expect(r.page.locator('[data-testid="send-error"]').count() == 0, "the keyboard send reported an error")
    def resend() -> None:
        raise Problem("row 56's send was lost by Fastmail; rerun the row")
    rid = _found_or_resent(c, c.J["test-b"], subj, resend)
    d = _delivered(c, c.J["test-b"], rid)
    expect("Sent with the keyboard." in d["text"], "the delivered message is not the one the key sent")


@check(57)
def check_57(c: Ctx) -> None:
    """Owner, 2026-09-12: "I've got an email with no sender name." One in
    nine stored messages has none; the list and the card showed a blank.
    The harness sends its fixtures with a bare address, so every fixture
    is the case: the sender's address must stand where the name goes."""
    r = c.run
    f = c.F["plain"]
    sender = c.J["test-a"].identity["email"]
    r.goto(f"/inbox/{f['account']}")
    shown = r.page.locator(f'[data-testid="row-sender-{f["account"]}-{f["id"]}"]').inner_text().strip()
    expect(shown != "", "the list row shows no sender at all")
    expect(sender in shown or shown == c.J["test-a"].identity.get("name"), f"the list row calls the sender {shown!r}; the address is {sender}")
    r.goto(f"/inbox/{f['account']}/{f['id']}")
    name = r.page.locator(".reading-card-name").first.inner_text().strip()
    expect(name != "", "the message card shows no sender name")
    expect(sender in name or name == c.J["test-a"].identity.get("name"), f"the card calls the sender {name!r}; the address is {sender}")


@check(58)
def check_58(c: Ctx) -> None:
    """Owner, 2026-09-15: "I am trying to archive an email. Twice now I have
    archived and it reappears in the message list." The list is one row per
    CONVERSATION; archive moved one message and the row stood on its
    siblings. Ruling: "archive/move act on conversations, delete and spam
    act on the message only." Proven on the three-message thread: test-b's
    inbox holds two of its members (thread1, thread3); `e` on the row takes
    both to Archive on Fastmail and the row goes; undo brings both back;
    `#` on the same row takes ONE message to Trash and the row stays."""
    r = c.run
    a, b = c.F["thread1"], c.F["thread3"]
    acct = b["account"]
    expect(a["account"] == acct, f"the thread fixtures are not both in one account ({a['account']}, {acct})")
    r.guard_write([acct])
    j = c.J[acct]
    inbox = _inbox_id(c, acct)
    # Row 22 leaves thread3 in a custom folder: put both members back in the
    # inbox on Fastmail and wait for Wilco to see it, so the row IS a
    # conversation of two when the key is pressed.
    j.set(update={a["id"]: {"mailboxIds": {inbox: True}}, b["id"]: {"mailboxIds": {inbox: True}}})
    wait_until(lambda: all(_detail(c, f)["mailboxIds"] == [inbox] for f in (a, b)),
               "Wilco to show both thread members in the inbox", timeout=330, every=3)
    r.goto(f"/inbox/{acct}")
    rows = r.list_rows()
    expect((acct, b["id"]) in rows, "the conversation's row (its newest member) is not in the inbox list")
    expect((acct, a["id"]) not in rows, "the older member has a row of its own; the list is not one row per conversation")
    # Archive from the row: every member IN THE INBOX goes, on Fastmail too.
    r.goto(f"/inbox/{acct}/{b['id']}")
    r.page.keyboard.press("e")
    wait_until(lambda: _toast_says(c, "Archived"), "a toast saying Archived", timeout=10, every=0.5)
    r.settled()
    rows = r.list_rows()
    expect((acct, b["id"]) not in rows and (acct, a["id"]) not in rows,
           "after archiving the conversation a member of it is still in the inbox list")
    for f in (a, b):
        wait_until(lambda f=f: j.state_of(f["id"])["roles"] == {"archive"},
                   f"Fastmail to show {f['id']} in Archive only", timeout=90, every=3)
    r.shot("58-after-archive")
    # Undo restores every member the action touched, not only the one named.
    r.page.locator('[data-testid="toast-undo"]').click(); r.settled()
    for f in (a, b):
        wait_until(lambda f=f: j.state_of(f["id"])["roles"] == {"inbox"},
                   f"Fastmail to show {f['id']} back in the inbox after undo", timeout=90, every=3)
    r.goto(f"/inbox/{acct}")
    expect((acct, b["id"]) in r.list_rows(), "after undo the conversation's row is not back")
    # Delete acts on the MESSAGE: the newest goes to Trash, its sibling stays,
    # and the row stays with it.
    r.goto(f"/inbox/{acct}/{b['id']}")
    r.page.keyboard.press("#")
    wait_until(lambda: _toast_says(c, "Deleted"), "a toast saying Deleted", timeout=10, every=0.5)
    r.settled()
    wait_until(lambda: j.state_of(b["id"])["roles"] == {"trash"}, "Fastmail to show the deleted message in Trash", timeout=90, every=3)
    expect(j.state_of(a["id"])["roles"] == {"inbox"}, "delete took the conversation's other member with it; the ruling is message-only")
    r.goto(f"/inbox/{acct}")
    expect((acct, a["id"]) in r.list_rows(), "with one member still in the inbox the conversation's row is gone")
    r.shot("58-after-delete")
    # Leave the fixture as the reset expects it.
    j.set(update={b["id"]: {"mailboxIds": {inbox: True}}})


@check(59)
def check_59(c: Ctx) -> None:
    """Owner, 2026-09-16: "when I am viewing a folder for an account and then
    return to the unified view, I am not shown the correct emails. Different
    folders to start with show different folders as a result." All inboxes
    kept the folder and dropped the account. From an account's Archive, Sent
    and a custom folder, All inboxes must land on exactly what /inbox shows."""
    r = c.run
    r.goto("/inbox")
    unified = r.list_rows()
    expect(len(unified) > 0, "the unified inbox is empty; the check needs rows to compare")
    acct = "test-a"
    custom = next((m["id"] for m in _mailboxes_of(c, acct) if m.get("role") in (None, "") and m.get("name")), None)
    starts = [f"/archive/{acct}", f"/sent/{acct}"] + ([f"/folder/{acct}/{custom}"] if custom else [])
    for start in starts:
        r.goto(start)
        r.page.locator('[data-testid="nav-all-inboxes"]').click(); r.settled()
        path = "/" + r.page.url.split("://", 1)[1].split("/", 1)[1]
        expect(path.rstrip("/") == "/inbox", f"All inboxes from {start} went to {path}")
        shown = r.list_rows()
        # Compared with /inbox read right after, not a snapshot from the
        # start: earlier rows' moves are still syncing during a full run.
        r.goto("/inbox")
        fresh = r.list_rows()
        expect(set(shown) == set(fresh),
               f"All inboxes from {start} shows {len(shown)} rows; /inbox shows {len(fresh)}, differing by {sorted(set(shown) ^ set(fresh))[:4]}")
    r.shot("59-all-inboxes")


@check(60)
def check_60(c: Ctx) -> None:
    """Owner, 2026-09-19: "when replying from the work account, the from field
    shows Work <robin@lumber.example>. Is that what recipients see?" It
    was not -- "Work" is Wilco's own sidebar name for the account, while the
    message goes out under the JMAP identity's name. The From option must be
    the header that is sent, and the account it belongs to is the accent dot
    beside it."""
    r = c.run
    acct = "test-a"
    r.guard_write([acct, "test-b"])
    j = c.J[acct]
    ident = j.identity
    name = (ident.get("name") or "").strip()
    expected = f"{name} <{ident['email']}>" if name else ident["email"]
    spec = next(a for a in r.api_get("/api/accounts") if a["key"] == acct)
    r.goto(f"/inbox/{acct}")
    _compose_as(c, acct)
    sel = r.page.locator('[data-testid="from-select"]')
    shown = sel.evaluate("s => s.options[s.selectedIndex].textContent")
    expect(shown == expected, f"the From option reads {shown!r}; the header this account sends is {expected!r}")
    expect(spec["label"] not in shown or spec["label"] == name,
           f"the From option still carries the account's sidebar name {spec['label']!r}: {shown!r}")
    dot = r.page.locator('[data-testid="from-account-dot"]')
    expect(dot.count() == 1, "no account dot beside the From field")
    bg = dot.evaluate("d => getComputedStyle(d).backgroundColor")
    expect(_rgb(bg) == _rgb(spec["accent"]), f"the dot is {bg}, not {acct}'s accent {spec['accent']}")
    expect(dot.get_attribute("title") == spec["label"], f"the dot names {dot.get_attribute('title')!r}, not {spec['label']!r}")
    r.shot("60-from-field")
    # And the header really is what lands: send it and read the delivered copy.
    r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
    subj = f"{PREFIX} from-header"
    _compose_send(c, subj, "Proving the From header.")
    def resend() -> None:
        _drop_lost_sent(c, acct, subj)
        r.goto(f"/inbox/{acct}")
        _compose_as(c, acct)
        r.page.fill('[data-testid="compose-to"]', c.J["test-b"].identity["email"])
        _compose_send(c, subj, "Proving the From header.")
    rid = _found_or_resent(c, c.J["test-b"], subj, resend)
    got = c.J["test-b"].get([rid], ["from"])[0]["from"][0]
    delivered = f"{(got.get('name') or '').strip()} <{got['email']}>" if (got.get("name") or "").strip() else got["email"]
    expect(delivered == expected, f"the delivered message says From {delivered!r}; the composer promised {expected!r}")


@check(61)
def check_61(c: Ctx) -> None:
    """Owner, 2026-09-21: "When a user chooses to forward or compose an email,
    the focus should immediately land on the to field instead of the body."
    A new message (`c`) and a forward (`f`) open with the cursor in To; a
    reply (`r`), which already has its recipient, keeps it in the body.
    Nothing is typed, so no draft is saved; Escape closes each."""
    r = c.run
    f = c.F["plain"]
    r.guard_write([f["account"]])
    focused = lambda: r.page.evaluate("document.activeElement && document.activeElement.getAttribute('data-testid')")
    def opens_in(key: str, where: str, start: str) -> None:
        r.goto(start)
        r.page.keyboard.press(key); r.settled()
        wait_until(lambda: r.page.locator('[data-testid="compose-card"]').count() == 1, f"a composer to open on {key!r}", timeout=10, every=0.25)
        wait_until(lambda: focused() == where, f"the cursor to be in {where} after {key!r} (it is in {focused()!r})", timeout=10, every=0.25)
        r.page.keyboard.press("Escape"); r.settled()
    opens_in("c", "compose-to", f"/inbox/{f['account']}")
    opens_in("f", "compose-to", f"/inbox/{f['account']}/{f['id']}")
    opens_in("r", "compose-body", f"/inbox/{f['account']}/{f['id']}")


@check(62)
def check_62(c: Ctx) -> None:
    """An account added in the modal starts syncing with NO container restart
    (2026-09-22). Until Task 4 the running supervisor read its account list
    once, at boot: `POST /api/accounts` stored the row and the sealed
    credential and nothing else happened, so the new account sat in /healthz
    with no state, no cursor and no mail until someone restarted the
    container -- the modal meanwhile said the account was connected.

    The row removes test-b (the reset re-fills its fixtures at the start of
    every run, and row 62 runs last), adds it back THROUGH THE MODAL, and
    waits for /healthz to report it `ok` with a pass that happened after the
    add. Nothing here restarts anything.

    🚨 The modal collects ONE identity field, the address: `key`, `label`,
    `code` and the endpoint are all derived from its domain (AddAccount.tsx),
    and no `code` is sent at all -- the server derives it. So the address
    whose DOMAIN is the account key is what re-creates `test-b`, and the
    endpoint it derives (`https://test-b/.well-known/jmap`) is exactly the
    guess that has to fail so the server's fallback to Fastmail's session URL
    is the endpoint stored and reported. The account's label and accent are
    put back through the API afterwards, because the modal derives those too.
    """
    r = c.run
    r.guard_write(["test-b"])
    token = os.environ["FASTMAIL_TESTB_WILCO_TOKEN"]
    before = {a["key"]: a for a in r.api_get("/api/accounts")}
    spec = before.get("test-b")
    expect(spec is not None, "test-b is not configured on this instance; row 62 removes and re-adds it")
    other_codes = {a["code"] for k, a in before.items() if k != "test-b"}

    def health() -> dict:
        # NOT api_get: /healthz answers 503 by design while an account has no
        # completed pass, and that window is the very thing this row watches.
        return r.page.request.get(BASE + "/healthz").json()

    def entry(key: str) -> dict | None:
        return next((a for a in health()["accounts"] if a["account"] == key), None)

    expect(entry("test-b") is not None, "/healthz does not list test-b before the row starts")

    def readd_by_api() -> None:
        """The put-back of last resort, used only if the modal never created
        the account: the instance must not be left with one account."""
        if any(a["key"] == "test-b" for a in r.api_get("/api/accounts")):
            return
        r.api_post("/api/accounts", {"key": "test-b", "label": spec["label"], "accent": spec["accent"],
                                     "provider": "jmap", "endpoint": spec["endpoint"], "code": spec["code"],
                                     "credential": token})

    try:
        res = r.page.request.delete(BASE + "/api/accounts/test-b",
                                    headers={"origin": BASE, "x-wilco-csrf": "1"})
        expect(res.ok, f"DELETE /api/accounts/test-b -> {res.status} {res.text()[:200]}")
        wait_until(lambda: entry("test-b") is None,
                   "/healthz to stop listing test-b after it was deleted", timeout=60, every=1)
        added_after = time.time()

        r.goto("/inbox")
        r.page.locator('[data-testid="add-account"]').click(); r.settled()
        expect(r.page.locator('[data-testid="add-account-modal"]').count() == 1, "the Add account modal did not open")
        r.page.locator('[data-testid="proto-jmap"]').click()
        r.page.locator('[data-testid="address"]').fill("test-b@test-b")
        guess = r.page.locator('[data-testid="endpoint"]').input_value()
        expect(guess == "https://test-b/.well-known/jmap",
               f"the modal derived the endpoint {guess!r}, not the .well-known guess this row means to see fall back")
        expect(r.page.locator('[data-testid="code-preview"]').inner_text().strip().endswith("TES"),
               "the modal's code preview is not the first-three-letters guess")
        r.page.locator('[data-testid="token"]').fill(token)
        r.page.locator('[data-testid="submit"]').click()

        terminal = lambda: r.page.locator('[data-testid="terminal"]').inner_text()
        try:
            wait_until(lambda: r.page.locator('[data-testid="open-inbox"]').count() == 1,
                       "the modal to report the account connected", timeout=120, every=1)
        except Problem as exc:
            # The modal's own log is the diagnosis: a verification failure
            # prints the server's error text and stops there.
            raise Problem(f"{exc}; the log says:\n    " + terminal().replace("\n", "\n    ")) from None
        log = terminal()
        expect(token not in log, "the modal's log contains the token")
        expect("endpoint https://api.fastmail.com/jmap/session" in log,
               f"the modal does not report the endpoint the server resolved:\n    " + log.replace("\n", "\n    "))
        expect(re.search(r"connected as \S+@\S+", log) is not None,
               f"the modal does not report the username the server verified:\n    " + log.replace("\n", "\n    "))
        r.page.locator('[data-testid="open-inbox"]').click(); r.settled()

        created = next((a for a in r.api_get("/api/accounts") if a["key"] == "test-b"), None)
        expect(created is not None, "the modal reported success and /api/accounts does not list test-b")
        expect(created["endpoint"] == "https://api.fastmail.com/jmap/session",
               f"the stored endpoint is {created['endpoint']!r}, not the one that accepted the token")
        expect(created["code"] not in other_codes,
               f"the account was created wearing {created['code']!r}, which another account already wears")

        # The whole point: it SYNCS, and the pass is one that happened after
        # the add -- with nothing restarted. `state` is the supervisor's own
        # (main.ts clears it on remove), so "ok" here means this process
        # established a session and completed a pass for an account it
        # learned about at runtime.
        seen: dict = {}
        def synced() -> bool:
            a = entry("test-b")
            seen.clear(); seen.update(a or {})
            if a is None or a["state"] != "ok" or not a["hasEmailCursor"] or a["lastSyncAt"] is None:
                return False
            at = calendar.timegm(time.strptime(a["lastSyncAt"][:19], "%Y-%m-%dT%H:%M:%S"))
            return at >= added_after
        wait_until(synced, f"/healthz to report test-b syncing after the add, with no restart (it says {seen})",
                   timeout=330, every=5)

        # Put back what the modal derived: it collects no label, accent or
        # code, and every other row (and row 34's badge) expects test-b's own.
        put = r.api_put("/api/accounts/test-b", {"label": spec["label"], "accent": spec["accent"], "code": spec["code"]})
        expect(put.ok, f"PUT /api/accounts/test-b -> {put.status} {put.text()[:200]}")
        r.goto("/inbox")
        badge = r.page.locator('[data-testid="account-code-test-b"]')
        expect(badge.count() == 1, "the sidebar has no account block for the re-added test-b")
        expect(badge.inner_text().strip() == spec["code"],
               f"the sidebar badge reads {badge.inner_text().strip()!r}, not {spec['code']!r}")
    finally:
        readd_by_api()


# The route segment for a folder that has a role. A folder with no role --
# or one whose role has no segment of its own -- is addressed by its
# mailbox id, which `listFilters` (App.tsx) prefers over the role anyway.
ROLE_ROUTE = {"inbox", "archive", "sent", "drafts", "trash"}


@check(63)
def check_63(c: Ctx) -> None:
    """A folder of any size opens in one page's worth of work (2026-09-22).

    The list read path was rewritten to walk and dedupe over the
    denormalized membership columns instead of collapsing the whole folder
    for every page: on the 167k-message instance a page of Archive went
    3,097ms to 11ms. Speed is not what this row guards -- the performance
    budget in the gate does that. What it guards is the two SEMANTICS the
    rewrite put at risk, both invisible in a screenshot:

      1. **The cursor is taken after collapsing, not during discovery.** A
         conversation is discovered at its lowest-id member in the folder
         and represented by its highest-id one, so a cursor cut in
         discovery order can hand the next page a row the previous page
         already showed -- or, worse, skip one entirely. The row walks the
         WHOLE folder with the cursor and requires every conversation to
         appear exactly once.
      2. **The header's total is the local conversation count** (audit pass
         4) -- never JMAP's `totalThreads`, which counts a thread's members
         in every folder, and never the page's own length. The number the
         header prints must equal the number of conversations the walk
         actually yields.

    Reads only; the folder is whichever of the account's is largest.
    """
    r = c.run
    acct = "test-a"
    r.guard_write([acct])
    spec = next(a for a in r.api_get("/api/mailboxes")["accounts"] if a["account"] == acct)
    box = max(spec["mailboxes"], key=lambda b: b["total"])
    expect(box["total"] >= 50,
           f"{acct}'s largest folder is {box['name']!r} with {box['total']} messages; row 63 needs a folder worth paging")
    if box["role"] in ROLE_ROUTE:
        route, params = f"/{box['role']}/{acct}", f"account={acct}&role={box['role']}"
    else:
        route, params = f"/folder/{acct}/{box['id']}", f"account={acct}&mailbox={box['id']}"

    def page(cursor: str | None) -> dict:
        q = params + ("&cursor=" + urllib.parse.quote(cursor) if cursor else "")
        return r.api_get(f"/api/messages?{q}")

    def walk() -> tuple[list[tuple[str, str]], int, list[str]]:
        """Every page of the folder, cursor by cursor. Returns the
        conversation key of every row IN ORDER (duplicates included -- the
        duplicate is the defect), the total the first page reported, and
        the page sizes."""
        keys: list[tuple[str, str]] = []
        sizes: list[str] = []
        first = page(None)
        total, d = first["total"], first
        # `total` pages of one row each is the pathological ceiling; a real
        # folder takes total/limit. The guard is against a cursor that
        # never advances, which would otherwise spin here forever.
        for _ in range(box["total"] + 2):
            keys += [(row["account"], row["threadId"] or row["id"]) for row in d["rows"]]
            sizes.append(str(len(d["rows"])))
            cursor = d["cursor"]
            if not cursor:
                return keys, total, sizes
            d = page(cursor)
        raise Problem(f"the cursor never ran out: {len(sizes)} pages of {'+'.join(sizes)} in {box['name']!r}")

    keys, total, sizes = walk()
    # Mail can arrive in the folder between the first page and the last, and
    # that legitimately moves the total. One retry distinguishes a moving
    # folder from a wrong count; the no-duplicates rule holds either way.
    if len(set(keys)) != total:
        again = r.api_get(f"/api/messages?{params}&limit=1")["total"]
        if again != total:
            keys, total, sizes = walk()

    first_row = (lambda p: (p["rows"][0]["account"], p["rows"][0]["id"]))(page(None))
    dupes = sorted({k for k in keys if keys.count(k) > 1})
    expect(not dupes,
           f"paging {box['name']!r} with the cursor showed {len(dupes)} conversation(s) twice "
           f"({[k[1] for k in dupes[:3]]}) across pages of {'+'.join(sizes)}")
    expect(len(keys) == total,
           f"{box['name']!r} says it holds {total} conversations; paging it with the cursor yielded {len(keys)} "
           f"(pages of {'+'.join(sizes)})")

    # ...and the number a person reads in the header is that same total.
    r.goto(route)
    rows = r.page.locator('[data-testid^="row-"][role="row"]')
    wait_until(lambda: rows.count() > 0, f"rows to render in {box['name']!r}", timeout=30, every=0.5)
    top = r.split_key(rows.first.get_attribute("data-testid")[len("row-"):])
    expect(top == first_row,
           f"the top row of {box['name']!r} is {top}; the first row the API gives for the same view is {first_row}")
    shown = r.page.locator('[data-testid="list-count"]').inner_text().strip()
    m = re.match(r"^([\d,]+)", shown)
    expect(m is not None, f"the list header reads {shown!r}, with no count in it")
    expect(int(m.group(1).replace(",", "")) == total,
           f"the header of {box['name']!r} reads {shown!r}; the folder holds {total} conversations")
    r.shot("63-largest-folder")


@check(64)
def check_64(c: Ctx) -> None:
    """A custom folder stays open once its NAME arrives.

    A custom folder's route carries only the mailbox id, so the app titles
    it from /api/mailboxes and shows a placeholder until that answers. The
    title therefore lands SEPARATELY from the rows, and on a real instance
    it can land after them: Brian's, 2026-09-22, where the list read path
    returns in ~30ms and /api/mailboxes takes ~500ms. The folder rendered
    and then fell into the loading skeleton a second later, for good.

    The 1.5s delay below is what makes that ordering certain rather than a
    race: without it the name usually wins and the defect hides.
    """
    r = c.run
    j = c.J["test-a"]
    folder = f"Harness Title {int(time.time()) % 100000}"
    created = j.call([["Mailbox/set", {"accountId": j.account_id, "create": {"m": {"name": folder, "parentId": None}}}, "mb"]])[0][1]
    fid = created["created"]["m"]["id"]; j._mailboxes = None

    # A message to see in it. Kept in its own folder AS WELL AS the inbox,
    # so no other row's fixture moves.
    f = c.F["bulkA1"]
    before = j.get([f["id"]], ["mailboxIds"])[0]["mailboxIds"]
    j.call([["Email/set", {"accountId": j.account_id, "update": {f["id"]: {f"mailboxIds/{fid}": True}}}, "e"]])

    try:
        def folder_listed() -> bool:
            page = r.api_get(f"/api/messages?account=test-a&mailbox={fid}")
            return any(row["id"] == f["id"] for row in page.get("rows", []))
        wait_until(folder_listed, f"Wilco to show the message in {folder!r}", timeout=150, every=5)

        # /api/mailboxes answers AFTER the list does, every time.
        def slow(route):
            time.sleep(1.5)
            route.continue_()
        r.page.route("**/api/mailboxes", slow)

        r.goto(f"/folder/test-a/{fid}")
        title = r.page.locator('[data-testid="list-title"]')
        wait_until(lambda: title.inner_text().strip() == folder,
                   f"the header to title the folder {folder!r} (it reads {title.inner_text().strip()!r})",
                   timeout=30, every=0.5)
        # The name has arrived. The rows must still be here -- the defect
        # is that the list re-enters loading at exactly this moment and
        # never leaves, because no further rows are coming.
        r.settled()
        r.page.wait_for_timeout(1500)
        skeleton = r.page.locator('[data-testid="list-loading"]').count()
        rows = r.list_rows()
        r.shot("64-custom-folder-titled")
        expect(skeleton == 0,
               f"{folder!r} fell back into the loading skeleton once its name arrived "
               f"({len(rows)} row(s) rendered)")
        expect(("test-a", f["id"]) in rows,
               f"{folder!r} does not show the message that is in it; the list holds {rows}")
    finally:
        r.page.unroute("**/api/mailboxes")
        j.call([["Email/set", {"accountId": j.account_id, "update": {f["id"]: {"mailboxIds": {m: True for m in before}}}}, "e"]])
        j.call([["Mailbox/set", {"accountId": j.account_id, "destroy": [fid]}, "mb"]])
        j._mailboxes = None


@check(65)
def check_65(c: Ctx) -> None:
    """A file the sender declared an attachment can be opened, content id or not.

    Owner, 2026-09-23: "i am clicking the pdf chip and nothing happens." The
    message held eight invoice PDFs, every one declared
    `disposition: "attachment"` AND carrying a Gmail-style `f_...` content
    id. Wilco classified anything with a content id as decoration the body
    draws -- a signature logo -- so all eight rendered as INERT LABELS: no
    link, no click handler, and no paperclip on the list row. There was no
    way to open them at all. 6,183 messages on that server hold a
    content-id-bearing part.

    The sender's own disposition decides now (`isFilePart`, schema 13).
    """
    r = c.run
    f = c.F["cidattach"]

    # The row advertises the file.
    r.goto(f"/inbox/{f['account']}")
    row = r.page.locator(f'[data-testid="row-{f["account"]}-{f["id"]}"]')
    expect(row.count() == 1, f"the fixture message is not in {f['account']}'s inbox")
    expect(
        row.locator(".msg-row-attach").count() == 1,
        "the list row shows no paperclip for an attachment carrying a content id",
    )

    # The chip is a real download link, not an inert label.
    r.goto(f"/inbox/{f['account']}/{f['id']}")
    chip = r.page.locator('[data-testid="attachment-0"]')
    expect(chip.count() == 1, "the attachment is not listed as a file at all")
    tag = chip.evaluate("e => e.tagName")
    expect(
        tag == "A",
        f"the chip is a <{tag.lower()}>, not a download link -- clicking it does nothing",
    )
    href = chip.get_attribute("href")
    expect(href is not None and "/a/" in href, f"the chip carries no attachment URL: {href!r}")

    # And it serves the file. Fetched through the page so the capability
    # token in the URL is used exactly as a click would use it.
    res = r.page.request.get(href)
    expect(res.status == 200, f"the attachment URL answered {res.status}")
    disposition = res.headers.get("content-disposition", "")
    expect(
        "attachment" in disposition and "invoice.pdf" in disposition,
        f"the response does not offer the file as a download: {disposition!r}",
    )
    expect(len(res.body()) > 0, "the attachment served no bytes")
    r.shot("65-cid-attachment")
