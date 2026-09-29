"""
Puts test-a and test-b into a KNOWN STATE at the start of every run, and
resolves each fixture to the id Wilco knows it by.

The fixtures PERSIST across runs. Each run resets them -- back to Inbox,
flags restored -- destroys everything that is not a fixture (the checks'
own sent mail, drafts, probe messages, custom folders), and re-sends only
what is genuinely missing.

🚨 Why persist rather than wipe-and-resend, which is what the design first
said: measured 2026-09-05, sending 14 fixtures in one run from these
accounts LOST a contiguous window of them every time -- 5 of 14 in a burst,
8 of 14 paced 2.5s apart -- accepted by EmailSubmission/set, present in
Sent, never delivered, no bounce, and Fastmail exposes no delivery status
to read (the submission is `notFound` on the very next call). The same
messages re-sent alone arrived within seconds. A move over JMAP never goes
through that path, so resetting is reliable where re-sending is not. What
does have to be sent is sent one at a time and VERIFIED delivered, with
retries.

What this must never do: touch any other account. Every write here goes
through Jmap, which refuses any key but test-a/test-b.
"""
import time
from datetime import datetime, timedelta, timezone

from lib import BASE, Problem, wait_until
from jmap import CORPUS_KEYWORD

PREFIX = "[wilco-check]"
PDF_BYTES = bytes(range(256)) * 8  # 2,048 bytes, every value, unambiguous on diff

# 🚨 Bump this whenever a fixture's CONTENT changes. The fixtures persist,
# so a change to SIMPLE/THREAD/_html_body alone changes nothing on Fastmail;
# the version rides in a header on every fixture and a copy carrying an
# older one is destroyed and re-sent. Found when the HTML fixture's image
# URL was changed on disk and the served body still had the old one.
def _solid_png(w: int, h: int, rgb=(30, 120, 200)) -> bytes:
    """A real PNG the viewer can decode (naturalWidth > 0), built by hand."""
    import struct, zlib
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


PNG_BYTES = _solid_png(320, 200)

FIXTURE_VERSION = "v3"
VERSION_HEADER = "X-Wilco-Fixture"

# Seconds to wait for one sent message to arrive before re-sending it.
DELIVERY_WAIT_S = 30
SEND_TRIES = 3


class Fixtures(dict):
    """name -> {"account", "id", "subject"} as WILCO sees each fixture."""

    def __init__(self):
        super().__init__()
        self.alias_a: str | None = None
        self.jmap_ids: dict[str, tuple[str, str]] = {}  # name -> (account, fastmail id)
        self.subjects: dict[str, str] = {}
        self.resent: list[str] = []

    def jmap_id(self, name: str) -> str:
        return self.jmap_ids[name][1]


def _html_body(n_paragraphs: int) -> str:
    paras = "".join(f"<p>Paragraph {i}: the quick brown fox jumps over the lazy dog.</p>" for i in range(n_paragraphs))
    return ('<html><body><h1>Fixture HTML</h1>'
            '<img src="https://httpbin.org/image/png" width="40" height="40" alt="remote">'
            '<a href="https://example.com/link">a link</a>' + paras + '</body></html>')


# name -> (sender key, recipient key, subject tail, text, extra send kwargs)
SIMPLE = {
    "plain":  ("test-a", "test-b", "plain", "Line one\nLine two\n\nOn Thu, Fred <addr@example.com> wrote:\n> quoted line\n> <https://example.com/x>\n", {}),
    "html":   ("test-a", "test-b", "html", "Fixture HTML fallback text", {"html": _html_body(40)}),
    # The same HTML from the OTHER direction. Check 27 grants test-a's
    # address a standing image allowance and there is no route to revoke
    # it, so the blocking default is asserted on a sender that never gets
    # one.
    "htmlB":  ("test-b", "test-a", "htmlB", "Fixture HTML B fallback text", {"html": _html_body(12)}),
    # Carries a Cc, so reply-all has a third party to keep (check 13).
    "cc":     ("test-a", "test-b", "cc", "With a cc.", {"cc": ["CC_ALIAS"]}),
    "attach": ("test-a", "test-b", "attach", "See attached.", {"attachments": [("report.pdf", "application/pdf", PDF_BYTES)]}),
    # A raster image as a real attachment (not inline): row 52's viewer.
    "photo":  ("test-a", "test-b", "photo", "A photo.", {"attachments": [("photo.png", "image/png", PNG_BYTES)]}),
    # 🚨 A real attachment that ALSO carries a content id -- Gmail's shape,
    # and what row 65 exists for. Wilco read the cid alone as "decoration the
    # body draws", so a file sent this way had no download link, no click
    # handler and no paperclip: reported live on 2026-09-23 against eight
    # invoice PDFs that could not be opened at all.
    "cidattach": ("test-a", "test-b", "cidattach", "Invoice attached.",
                  {"attachments": [("invoice.pdf", "application/pdf", PDF_BYTES, "f_harness01")]}),
    "unsub":  ("test-a", "test-b", "unsub", "A newsletter.",
               {"unsubscribe": ["mailto:unsub@example.com", "https://example.com/unsub"],
                "headers": {"List-Unsubscribe-Post": "List-Unsubscribe=One-Click"}}),
    # mailto ONLY. Tuples are (sender, recipient, ...): this lands in test-b,
    # and its mailto points at test-a, so the unsubscribe Wilco sends AS
    # test-b arrives where the harness can see it. Filled in by prepare()
    # once the addresses are known.
    "unsubMailto": ("test-a", "test-b", "unsub mailto", "A newsletter with a mailto unsubscribe.",
                    {"unsubscribe": ["mailto:PLACEHOLDER"]}),
    "bulk1":  ("test-a", "test-b", "bulk 1", "bulk message 1", {}),
    "bulk2":  ("test-a", "test-b", "bulk 2", "bulk message 2", {}),
    "bulk3":  ("test-a", "test-b", "bulk 3", "bulk message 3", {}),
    "bulk4":  ("test-a", "test-b", "bulk 4", "bulk message 4", {}),
    "bulkA1": ("test-b", "test-a", "bulkA 1", "bulk message A1", {}),
    "bulkA2": ("test-b", "test-a", "bulkA 2", "bulk message A2", {}),
    "unread": ("test-a", "test-b", "unread", "Left unread on purpose.", {}),
    # Owned by check 21, which flags and archives it from the Fastmail side.
    # A thread member cannot serve: the list row is keyed by the thread's
    # LATEST message, so a change to an older member has no row to show on.
    "sync":   ("test-a", "test-b", "sync", "Changed from Fastmail's side.", {}),
}
# Owned by check 11: a role-less folder to file spam into. Persistent, and
# excluded from the custom-folder sweep, so Wilco has learned it by the time
# a check needs it.
SPAM_FOLDER = "Harness Spam"
# The thread is three messages chained by Message-ID; it is rebuilt whole
# when any member is missing. (name, sender, recipient, subject tail, text)
THREAD = [("thread1", "test-a", "test-b", "thread", "first"),
          ("thread2", "test-b", "test-a", "Re: thread", "second"),
          ("thread3", "test-a", "test-b", "Re: thread", "third")]
UNREAD = {"unread"}


def _send_verified(J, sender_key: str, dest_key: str, subject: str, text: str, F: Fixtures, name: str, **kw) -> str:
    """Send, wait for delivery, re-send if it never arrives. Returns the
    RECIPIENT's copy id (that is what Wilco shows)."""
    sender, dest = J[sender_key], J[dest_key]
    kw = dict(kw)
    kw["headers"] = {**kw.get("headers", {}), VERSION_HEADER: FIXTURE_VERSION}
    for attempt in range(1, SEND_TRIES + 1):
        sender.send(dest.identity["email"], subject, text, **kw)
        try:
            rid = dest.find(subject, timeout=DELIVERY_WAIT_S, from_email=sender.identity["email"])
            if attempt > 1:
                F.resent.append(f"{name} x{attempt}")
            return rid
        except Problem:
            # Delivered late would leave a duplicate; destroy the sender's
            # copy of this attempt so Sent stays one-per-fixture too.
            for sid in sender.query({"subject": subject, "inMailbox": sender.mailboxes()["sent"]}, limit=5):
                sender.set(destroy=[sid])
    raise Problem(f"{name}: not delivered to {dest_key} after {SEND_TRIES} sends")


def _inventory(j) -> list[dict]:
    """Every message in the account that is not corpus, with what the reset
    needs to know."""
    ids = j.query({"notKeyword": CORPUS_KEYWORD}, limit=500)
    return j.get(ids, ["subject", "from", "mailboxIds", "keywords", "receivedAt", f"header:{VERSION_HEADER}:asText"])


def prepare(run, J) -> Fixtures:
    F = Fixtures()
    full = {name: f"{PREFIX} {tail}" for name, (_, _, tail, _, _) in SIMPLE.items()}
    full.update({name: f"{PREFIX} {tail}" for name, _, _, tail, _ in THREAD})
    F.subjects = full
    addr = {k: J[k].identity["email"] for k in J}
    recipient_of = {name: rcpt for name, (_, rcpt, _, _, _) in SIMPLE.items()}
    recipient_of.update({name: rcpt for name, _, rcpt, _, _ in THREAD})
    sender_of = {name: snd for name, (snd, _, _, _, _) in SIMPLE.items()}
    sender_of.update({name: snd for name, snd, _, _, _ in THREAD})

    # The cc fixture's third party is test-a's alias identity.
    ids_a = J["test-a"].call([["Identity/get", {"accountId": J["test-a"].account_id}, "i"]])[0][1]["list"]
    alias_a = next((i["email"] for i in ids_a if i["id"] != J["test-a"].identity["id"]), None)
    if alias_a is None:
        SIMPLE.pop("cc", None); full.pop("cc", None)
    else:
        SIMPLE["cc"] = ("test-a", "test-b", "cc", "With a cc.", {"cc": [alias_a]})
    F.alias_a = alias_a
    SIMPLE["unsubMailto"] = ("test-a", "test-b", "unsub mailto", "A newsletter with a mailto unsubscribe.",
                             {"unsubscribe": [f"mailto:{addr['test-a']}?subject=Unsubscribe%20wilco-check"]})

    # 1. Custom folders go (except the persistent spam folder, created if
    #    absent); anything that is not a fixture goes.
    known = set(full.values())
    for key, j in J.items():
        j._mailboxes = None; j.mailboxes()
        if key == "test-a" and SPAM_FOLDER not in j.mailboxes():
            j.call([["Mailbox/set", {"accountId": j.account_id, "create": {"m": {"name": SPAM_FOLDER, "parentId": None}}}, "mb"]])
            j._mailboxes = None; j.mailboxes()
        custom = [i for i, n in j._name_of.items() if i not in j._role_of and n != SPAM_FOLDER]
        if custom:
            j.call([["Mailbox/set", {"accountId": j.account_id, "destroy": custom, "onDestroyRemoveEmails": True}, "md"]])
            j._mailboxes = None; j.mailboxes()
        strays = [m["id"] for m in _inventory(j) if m["subject"] not in known]
        if strays:
            j.set(destroy=strays)
        # Rows 38, 40 and 41 put an HTML signature on test-a and take it
        # back; a run that died in between would leave it. Every run starts
        # plain -- and the clear goes THROUGH WILCO'S ROUTE, not Identity/set:
        # the server caches identities and only its own PUT invalidates
        # that cache. Cleared over JMAP alone, the editor kept inserting the
        # stale signature for a whole run (2026-09-07).
        if j.identity.get("htmlSignature"):
            res = run.api_put(f"/api/identities/{key}/{j.identity['id']}/signature",
                              {"textSignature": j.identity.get("textSignature") or "", "htmlSignature": ""})
            if not res.ok:
                raise Problem(f"could not clear {key}'s HTML signature through Wilco: HTTP {res.status}")
            j.identity["htmlSignature"] = ""

    # 2. Find each fixture's RECIPIENT copy; keep the newest, drop duplicates.
    found: dict[str, str] = {}
    for name, subject in full.items():
        j = J[recipient_of[name]]
        copies = sorted((m for m in _inventory(j)
                         if m["subject"] == subject and (m.get("from") or [{}])[0].get("email") == addr[sender_of[name]]),
                        key=lambda m: m["receivedAt"], reverse=True)
        if len(copies) > 1:
            j.set(destroy=[m["id"] for m in copies[1:]])
        if copies and (copies[0].get(f"header:{VERSION_HEADER}:asText") or "").strip() != FIXTURE_VERSION:
            # Older content. Destroy every copy (sender's Sent too) and re-send.
            for key, jj in J.items():
                stale = [m["id"] for m in _inventory(jj) if m["subject"] == subject]
                if stale:
                    jj.set(destroy=stale)
            copies = []
        if copies:
            found[name] = copies[0]["id"]

    # 3. Re-send what is missing. The thread is all-or-nothing.
    for name, (snd, rcpt, tail, text, kw) in SIMPLE.items():
        if name not in found:
            found[name] = _send_verified(J, snd, rcpt, full[name], text, F, name, **kw)
            F.resent.append(name)
    if any(name not in found for name, *_ in THREAD):
        for key, j in J.items():
            gone = [m["id"] for m in _inventory(j) if m["subject"] in {full["thread1"], full["thread2"]}]
            if gone:
                j.set(destroy=gone)
        refs: list[str] = []
        for name, snd, rcpt, tail, text in THREAD:
            # Two seconds apart: a reply's Sent copy created in the SAME
            # second as the previous message's delivery ties on receivedAt,
            # and Wilco has no finer key (sent_at is not stored) -- row 5
            # went red on such a tie on 2026-09-07. Distinct seconds are what
            # a real thread has; a same-second tie is this fixture's artefact.
            time.sleep(2)
            rid = _send_verified(J, snd, rcpt, full[name], text, F, name,
                                 in_reply_to=refs[-1:] or None, references=refs or None)
            found[name] = rid
            F.resent.append(name)
            msgid = J[rcpt].get([rid], ["messageId"])[0]["messageId"][0]
            refs.append(msgid)

    # 4. Reset every recipient copy: Inbox only, read (or unread), unflagged.
    for name, rid in found.items():
        j = J[recipient_of[name]]
        keywords = {} if name in UNREAD else {"$seen": True}
        j.set(update={rid: {"mailboxIds": {j.mailboxes()["inbox"]: True}, "keywords": keywords}})
        F.jmap_ids[name] = (recipient_of[name], rid)

    # 4b. Both accounts in All inboxes. Since 2026-09-08 the board runs
    #     against the HARNESS INSTANCE (wilcotest.example.com), which holds only
    #     these two accounts, so nothing here reaches the owner's client; the
    #     row-48 switching in and out is history. Row 48 still proves the
    #     switch itself and leaves both on.
    set_unified(run, J, "on")

    # 4c. The corpus: a 260-message archive in test-a for the rows that
    #     used to lean on the owner's (7, 18). Idempotent; imported, not sent.
    ensure_corpus(run, J)

    # 5. Wilco must agree before any check runs: the message exists, is in
    #    the inbox and only the inbox, and carries the right flags.
    inbox_id = {k: J[k].mailboxes()["inbox"] for k in J}
    # An account /healthz reports as failing cannot agree with anything --
    # that is row 29's own subject. Its fixtures are left out of the wait,
    # said so, and any check that needs them fails on its own terms.
    try:
        health = run.page.request.get(f"{BASE}/healthz").json()
        failing = {a["account"] for a in health.get("accounts", []) if a.get("state") != "ok"}
    except Exception:
        failing = set()
    if failing:
        print(f"  ! not waiting on {sorted(failing)}: /healthz reports them failing", flush=True)
    disagree: dict[str, str] = {}
    def wilco_agrees() -> bool:
        disagree.clear()
        for name, (acct, rid) in F.jmap_ids.items():
            if acct in failing:
                continue
            res = run.page.request.get(f"{BASE}/api/messages/{acct}/{rid}")
            if res.status != 200:
                disagree[name] = f"HTTP {res.status}"
                continue
            m = res.json()
            want_unread = name in UNREAD
            if m["mailboxIds"] != [inbox_id[acct]]:
                disagree[name] = f"in {m['mailboxIds']}, not the inbox {inbox_id[acct]}"
            elif m["isFlagged"]:
                disagree[name] = "flagged"
            elif m["isUnread"] != want_unread:
                disagree[name] = f"isUnread={m['isUnread']}, want {want_unread}"
        return not disagree
    try:
        # 330s: past the supervisor's 5-minute safety poll. Right after a
        # container restart a change made here is sometimes missed by push
        # for the harness accounts and arrives with that poll (measured
        # 2026-09-06: thread3 sat in Trash in Wilco for >150s while Fastmail
        # had it in the Inbox, then healed). A person would wait; so does
        # the run, saying what it waits on.
        wait_until(wilco_agrees, "Wilco to show every fixture in its inbox with the right flags", timeout=330, every=5)
    except Problem:
        # Name the fixture and the disagreement -- and what Fastmail says
        # about it, so a stuck sync and a wrong reset look different.
        detail = []
        for name, why in disagree.items():
            acct, rid = F.jmap_ids[name]
            st = J[acct].state_of(rid)
            detail.append(f"{name} ({acct}/{rid}): Wilco {why}; Fastmail has it in {sorted(st['names'])} keywords {sorted(st['keywords'])}")
        raise Problem("Wilco still disagrees with Fastmail after 330s on: " + " | ".join(detail))
    for name, (acct, rid) in F.jmap_ids.items():
        F[name] = {"account": acct, "id": rid, "subject": full[name]}
    return F


CORPUS_SIZE = 260
CORPUS_MARKER = "[wilco-corpus v2]"  # bump to replace an older corpus on the next run


def ensure_corpus(run, J) -> None:
    """test-a's Archive holds a 260-message corpus so the rows that need a
    real-sized folder (7: paging past 200; 18: a search with 200+ matches)
    have one on the harness instance, where the owner's archive is not
    available. Imported over Email/import, not sent (no delivery loss),
    idempotent: counted by keyword, topped up only if short, never re-sent.
    Every subject carries 'invoice' for row 18's query, and each message a
    distinct date so the list orders them."""
    j = J["test-a"]
    def wilco_has_it() -> bool:
        # Wilco's own count of test-a's Archive, not Fastmail's: a row that
        # starts while the corpus is still syncing in sees a list that grows
        # under it (2026-09-08: row 7's k landed on a message that had just
        # arrived; row 18 saw 200 of 260 matches).
        return run.api_get("/api/messages?account=test-a&role=archive&limit=1")["total"] >= CORPUS_SIZE
    current = len(j.query({"hasKeyword": CORPUS_KEYWORD, "subject": CORPUS_MARKER}, limit=1000))
    if current >= CORPUS_SIZE:
        wait_until(wilco_has_it, f"Wilco to hold the {CORPUS_SIZE}-message corpus", timeout=330, every=5)
        return
    stale = j.query({"hasKeyword": CORPUS_KEYWORD}, limit=1000)
    if stale:
        for i in range(0, len(stale), 100):
            j.set(destroy=stale[i:i + 100])
        print(f"  corpus: removed {len(stale)} messages of an older version", flush=True)
    archive = j.mailboxes()["archive"]
    raw = []
    for n in range(CORPUS_SIZE):
        # Spread across ~two years, newest last, so paging is deterministic.
        when = datetime(2024, 1, 1, 9, 0, tzinfo=timezone.utc) + timedelta(days=n * 2, minutes=n % 37)
        subject = f"{CORPUS_MARKER} Invoice {1000 + n} from vendor {n % 9}"
        text = "\r\n".join([
            f"Invoice {1000 + n} for corpus item {n}.", "",
            f"Amount due: ${(n * 7) % 900 + 100}.00",
            "This message is harness corpus: it stands in for a real archive.", ""])
        head = [
            f"From: Corpus Vendor <corpus-{n % 9}@example.test>",
            f"To: {j.identity['email']}",
            f"Subject: {subject}",
            f"Date: {when.strftime('%a, %d %b %Y %H:%M:%S +0000')}",
            f"Message-ID: <wilco-corpus-{n}@example.test>",
            "MIME-Version: 1.0"]
        if n % 4 == 0:
            # Every fourth message is HTML (row 3 measures the frame against
            # real HTML messages): tall enough to be worth measuring.
            paras = "".join(f"<p style=\"margin:0 0 14px\">Paragraph {k}: invoice {1000 + n}, line item {k}, {(n * k) % 97} units.</p>" for k in range(1, 12))
            html = f"<html><body style=\"font-family:sans-serif\"><h2>Invoice {1000 + n}</h2>{paras}<table border=\"1\"><tr><td>Total</td><td>${(n * 7) % 900 + 100}.00</td></tr></table></body></html>"
            b = "wilco-corpus-boundary"
            msg = "\r\n".join(head + [f"Content-Type: multipart/alternative; boundary=\"{b}\"", "",
                f"--{b}", "Content-Type: text/plain; charset=utf-8", "", text,
                f"--{b}", "Content-Type: text/html; charset=utf-8", "", html, f"--{b}--", ""]).encode()
        else:
            msg = "\r\n".join(head + ["Content-Type: text/plain; charset=utf-8", "", text]).encode()
        raw.append((msg, {CORPUS_KEYWORD: True, "$seen": True}, {archive: True}))
    created = j.import_messages(raw)
    print(f"  corpus: imported {created} messages into test-a's Archive", flush=True)
    wait_until(wilco_has_it, f"Wilco to hold the {CORPUS_SIZE}-message corpus", timeout=330, every=5)


def set_unified(run, J, value: str) -> None:
    """showInUnified for both harness accounts, through Wilco's own route."""
    for key in J:
        res = run.api_put(f"/api/accounts/{key}/settings", {"key": "showInUnified", "value": value})
        if not res.ok:
            raise Problem(f"could not set showInUnified={value} for {key}: HTTP {res.status}")


def hide_from_unified(run, J) -> None:
    """Back out of the owner's combined inbox at the end of a run. Best
    effort: a failure here must not turn a green run red."""
    try:
        set_unified(run, J, "off")
        print("  harness accounts switched out of All inboxes", flush=True)
    except Exception as exc:
        print(f"  ! could not switch the harness accounts out of All inboxes: {exc}", flush=True)
