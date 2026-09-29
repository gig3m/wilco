"""
Fastmail over JMAP, as the harness's second source of truth and as the
tool that fills and empties the two test accounts.

What this must never do: write to an account whose key is not in WRITABLE.
`set`, `upload`, `send` and `wipe` check `self.key` first and raise; nothing
catches it.
"""
import json
import os
import time
import urllib.error
import urllib.request

from lib import WRITABLE, WriteRefused, Problem

SESSION_URL = "https://api.fastmail.com/jmap/session"
USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"]


# Messages the harness IMPORTED to stand in for a real archive (row 7's
# 200+ folder, row 18's 200+ search matches). They carry this keyword and
# the reset leaves them alone; everything else that is not a fixture goes.
CORPUS_KEYWORD = "wilcocorpus"


class Jmap:
    def __init__(self, key: str, token: str):  # noqa: D107
        # 🚨 Guard BEFORE the session request, so a non-writable key never
        # sends its token anywhere. jmaps() only ever builds the two test
        # accounts; this is the belt to that suspenders.
        if key not in WRITABLE:
            raise WriteRefused(f"a Jmap for {key} was constructed; only {sorted(WRITABLE)} may be reached this way")
        self.key = key
        self._auth = {"authorization": f"Bearer {token}"}
        s = self._json(SESSION_URL)
        self.api_url = s["apiUrl"]
        self.upload_url = s["uploadUrl"]
        self.download_url = s["downloadUrl"]
        self.account_id = s["primaryAccounts"]["urn:ietf:params:jmap:mail"]
        self._mailboxes: dict[str, str] | None = None
        self._role_of: dict[str, str] = {}   # mailbox id -> role
        self._name_of: dict[str, str] = {}   # mailbox id -> name
        ids = self.call([["Identity/get", {"accountId": self.account_id}, "i"]])[0][1]["list"]
        self.identity = next((i for i in ids if i.get("mayDelete") is False), ids[0])

    def _json(self, url, data=None, headers=None):
        req = urllib.request.Request(url, data=data, headers={**self._auth, **(headers or {})})
        # One retry on a transport error (a resolver miss, a reset), never
        # on an HTTP error: row 22 went ERROR on 2026-09-07 with "[Errno -5]
        # No address associated with hostname" from inside the container,
        # a lookup that passed 100/100 a minute later.
        for attempt in (1, 2):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.load(r)
            except urllib.error.HTTPError:
                raise
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                if attempt == 2:
                    raise
                print(f"  ~ JMAP transport error on {self.key}, retrying once: {e}", flush=True)
                time.sleep(2)

    def call(self, methods: list) -> list:
        body = json.dumps({"using": USING, "methodCalls": methods}).encode()
        return self._json(self.api_url, body, {"content-type": "application/json"})["methodResponses"]

    def mailboxes(self) -> dict[str, str]:
        """role -> id and name -> id, together."""
        if self._mailboxes is None:
            lst = self.call([["Mailbox/get", {"accountId": self.account_id, "ids": None}, "m"]])[0][1]["list"]
            self._mailboxes = {}
            self._role_of = {}
            self._name_of = {}
            for m in lst:
                if m.get("role"):
                    self._mailboxes[m["role"]] = m["id"]
                    self._role_of[m["id"]] = m["role"]
                self._mailboxes[m["name"]] = m["id"]
                self._name_of[m["id"]] = m["name"]
        return self._mailboxes

    def query(self, filter: dict, limit: int = 500) -> list[str]:
        r = self.call([["Email/query", {"accountId": self.account_id, "filter": filter, "limit": limit,
                                        "sort": [{"property": "receivedAt", "isAscending": False}]}, "q"]])
        return r[0][1]["ids"]

    def get(self, ids: list[str], properties: list[str]) -> list[dict]:
        if not ids:
            return []
        r = self.call([["Email/get", {"accountId": self.account_id, "ids": ids, "properties": properties}, "g"]])
        return r[0][1]["list"]

    def _guard(self):
        if self.key not in WRITABLE:
            raise WriteRefused(f"JMAP write attempted on {self.key}; only {sorted(WRITABLE)} may be changed")

    def set(self, update=None, create=None, destroy=None) -> dict:
        self._guard()
        args = {"accountId": self.account_id}
        if update: args["update"] = update
        if create: args["create"] = create
        if destroy: args["destroy"] = destroy
        r = self.call([["Email/set", args, "s"]])[0][1]
        if r.get("notUpdated") or r.get("notCreated") or r.get("notDestroyed"):
            raise Problem(f"Email/set on {self.key} refused: {json.dumps(r)[:300]}")
        return r

    def upload(self, data: bytes, mime: str) -> str:
        self._guard()
        url = self.upload_url.replace("{accountId}", self.account_id)
        return self._json(url, data, {"content-type": mime})["blobId"]

    def download(self, blob_id: str) -> bytes:
        url = (self.download_url.replace("{accountId}", self.account_id).replace("{blobId}", blob_id)
               .replace("{name}", "blob").replace("{type}", "application/octet-stream"))
        req = urllib.request.Request(url, headers=self._auth)
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()

    def send(self, to: str, subject: str, text: str, html: str | None = None,
             attachments=(), headers: dict | None = None, cc: list[str] | None = None,
             in_reply_to: list[str] | None = None, references: list[str] | None = None,
             unsubscribe: list[str] | None = None) -> str:
        """Sends from this account's primary identity. Returns the new Email id.

        Threading and List-Unsubscribe go through their FIRST-CLASS forms
        (`inReplyTo`/`references`, `header:List-Unsubscribe:asURLs`): Fastmail
        refuses `header:List-Unsubscribe:asText` on create (measured), and
        the threading properties are what Wilco's own send path uses."""
        self._guard()
        mb = self.mailboxes()
        email = {
            "from": [{"email": self.identity["email"]}], "to": [{"email": to}], "subject": subject,
            **({"cc": [{"email": c} for c in cc]} if cc else {}),
            "mailboxIds": {mb["drafts"]: True}, "keywords": {"$draft": True, "$seen": True},
            "bodyValues": {"t": {"value": text}}, "textBody": [{"partId": "t", "type": "text/plain"}],
        }
        if html is not None:
            email["bodyValues"]["h"] = {"value": html}
            email["htmlBody"] = [{"partId": "h", "type": "text/html"}]
        if attachments:
            # An entry may carry a fourth element: a CONTENT ID, sent
            # alongside `disposition: "attachment"`. That pairing is not
            # exotic -- Gmail puts an `f_...` cid on every part it sends --
            # and Wilco used to read the cid alone as "decoration the body
            # draws", so such a file could not be opened at all (row 65).
            built = []
            for entry in attachments:
                name, mime, data = entry[0], entry[1], entry[2]
                cid = entry[3] if len(entry) > 3 else None
                part = {"blobId": self.upload(data, mime), "type": mime, "name": name,
                        "disposition": "attachment"}
                if cid is not None:
                    part["cid"] = cid
                built.append(part)
            email["attachments"] = built
        for k, v in (headers or {}).items():
            email[f"header:{k}:asText"] = v
        if in_reply_to:
            email["inReplyTo"] = in_reply_to
        if references:
            email["references"] = references
        if unsubscribe:
            email["header:List-Unsubscribe:asURLs"] = unsubscribe
        r = self.call([
            ["Email/set", {"accountId": self.account_id, "create": {"e": email}}, "c"],
            ["EmailSubmission/set", {"accountId": self.account_id, "create": {"s": {
                "emailId": "#e", "identityId": self.identity["id"]}},
                "onSuccessUpdateEmail": {"#s": {f"mailboxIds/{mb['drafts']}": None,
                                                 f"mailboxIds/{mb['sent']}": True, "keywords/$draft": None}}}, "sub"],
        ])
        created = (r[0][1].get("created") or {}).get("e")
        if not created or (len(r) > 1 and r[1][1].get("notCreated")):
            raise Problem(f"send from {self.key} failed: {json.dumps(r)[:600]}")
        return created["id"]

    def import_messages(self, raw: list[tuple[bytes, dict, dict]]) -> int:
        """Email/import: each (rfc822 bytes, keywords, mailboxIds). Imported,
        not sent -- no delivery step, so nothing is lost the way a burst of
        sends is (spec, 2026-09-05). Returns how many were created."""
        self._guard()
        created = 0
        for i in range(0, len(raw), 25):
            batch = raw[i:i + 25]
            emails = {}
            for n, (bytes_, keywords, mailbox_ids) in enumerate(batch):
                blob = self.upload(bytes_, "message/rfc822")
                emails[f"i{n}"] = {"blobId": blob, "mailboxIds": mailbox_ids, "keywords": keywords}
            r = self.call([["Email/import", {"accountId": self.account_id, "emails": emails}, "imp"]])[0][1]
            if r.get("notCreated"):
                raise RuntimeError(f"Email/import refused {len(r['notCreated'])} of {len(batch)}: {list(r['notCreated'].values())[0]}")
            created += len(r.get("created") or {})
        return created

    def wipe(self) -> int:
        """Destroys every message that is not corpus, and every folder without
        a role (the ones checks create). Returns the message count."""
        self._guard()
        total = 0
        while True:
            ids = self.query({"notKeyword": CORPUS_KEYWORD}, limit=200)
            if not ids:
                break
            self.set(destroy=ids)
            total += len(ids)
        self._mailboxes = None
        self.mailboxes()
        custom = [i for i, n in self._name_of.items() if i not in self._role_of]
        if custom:
            self.call([["Mailbox/set", {"accountId": self.account_id, "destroy": custom,
                                        "onDestroyRemoveEmails": True}, "md"]])
            self._mailboxes = None
        return total

    def find(self, subject: str, timeout: float = 90, from_email: str | None = None) -> str:
        """The newest message whose subject is EXACTLY `subject`.

        JMAP's `subject` filter is a substring match, so the query alone
        returned `[wilco-check] Re: thread` for `[wilco-check] thread` and
        the thread's first message resolved to its last. The candidates are
        fetched and matched exactly."""
        deadline = time.time() + timeout
        # 🚨 Not the `subject` filter alone: that runs on Fastmail's SEARCH
        # INDEX, which lags -- on 2026-09-08 a message that arrived one
        # second after the send was invisible to it for the whole 90s wait,
        # and the row reported "send lost by Fastmail". A date-bounded query
        # on receivedAt needs no index; the subject is matched exactly on
        # the fetched candidates. The subject filter stays as a second net
        # for anything older than the window.
        since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 30 * 60))
        while time.time() < deadline:
            ids = self.query({"after": since}, limit=80)
            ids += [i for i in self.query({"subject": subject}, limit=10) if i not in ids]
            for m in self.get(ids, ["subject", "from"]):
                sender = (m.get("from") or [{}])[0].get("email")
                if m["subject"] == subject and (from_email is None or sender == from_email):
                    return m["id"]
            time.sleep(2)
        raise Problem(f"{self.key}: no message with subject {subject!r} after {timeout:.0f}s")

    def state_of(self, email_id: str) -> dict:
        """{'keywords', 'roles', 'names', 'exists'} -- what Fastmail says."""
        m = self.get([email_id], ["keywords", "mailboxIds"])
        if not m:
            return {"keywords": {}, "roles": set(), "names": set(), "exists": False}
        self.mailboxes()
        ids = m[0]["mailboxIds"]
        return {"keywords": m[0]["keywords"],
                "roles": {self._role_of[i] for i in ids if i in self._role_of},
                "names": {self._name_of.get(i, i) for i in ids},
                "exists": True}


def jmaps() -> dict[str, Jmap]:
    return {"test-a": Jmap("test-a", os.environ["WILCO_TEST_A"]),
            "test-b": Jmap("test-b", os.environ["WILCO_TEST_B"])}
