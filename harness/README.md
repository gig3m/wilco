# Wilco harness

Drives the **harness instance** (`WILCO_BASE`, default
`https://wilcotest.example.com`; the two test accounts only) in a real browser
and, with `--smoke`, the read-only rows against production. It holds it to
`CHECKLIST.md`: 57 flows a mail client must do, each verified the way a person
would judge it.

```sh
./harness/run.sh                       # every check
./harness/run.sh 3 18 22               # by number
./harness/run.sh --update-checklist    # also rewrite CHECKLIST.md's State column
```

## Waiting

A check waits on the app, never on the clock. The client mirrors its
in-flight request count onto `<html data-wilco-busy>`; `r.settled()` waits
for that to read `0` and stay `0` for 150ms, then for every body frame to
finish loading, then once more. `r.goto()` and `r.reload()` do this
themselves. After a click or a key that starts a request, call `r.settled()`
rather than `wait_for_timeout(N)`.

The three fixed waits left are real time: row 36's keyboard burst (proving a
race needs presses with no pause), row 42's toast-sampling loop, and the
print window in row 33. Something DEBOUNCED longer than the quiet window
(autosave at 1.5s, the search box) is not covered by `settled()` alone --
wait for its observable (the "draft saved" status, `search-active`).

2026-09-08: 384s of a 657s board run had been sleeps -- 75 page loads at
3-5s each and 97 bare waits. The rewrite took a full run from ~11 minutes to
~6.5, of which about half is now Fastmail's own latency (rows 7, 8, 20, 21,
40 wait on a sync round or a delivery).

```
./harness/csp-probe.sh                 # the body CSP, each directive proven by removal
```

Screenshots land in `harness/out/` (gitignored): `NN.png` per check,
`RED-NN.png` on failure, `board.txt` with the table the run printed.

## Why it is shaped this way

Eight audit passes and 958 green tests reported a working app on the day the
owner found, by reading one message, that replies went out from the wrong
account and 4,478 messages rendered as a wall. The 14 browser scenarios this
replaced passed throughout: they asserted that the URL changed, that a body
element existed, that a draft saved. Nothing asserted what a person sees.

## What a check may assert

1. **The outcome a person would judge, in their terms.** "The list still shows
   13 rows," not "the URL changed."
2. **Cross-checked against a second source.** Anything that changes mail is
   confirmed on Wilco's screen, on Wilco after a reload, and on Fastmail over
   JMAP. Anything read is confirmed against the API response it came from.
3. **Measured, not detected.** Frame height against content height; row count
   before and after; server total against on-screen total. "Element exists"
   is not a measurement.
4. **Looked at.** Every check saves a screenshot, and the screenshots are read
   in review.
5. **Proven able to fail.** Break the feature, run the check, record the red
   output in `CHECKLIST.md`'s `Proven by` column. Until then the row is
   *unproven*, which is a distinct state from green.

## States

| | |
|---|---|
| **red** | the check ran and the flow is broken |
| **green** | the check passed AND its mutation is recorded |
| **unproven** | the check passed but has never been seen failing |
| **unbuilt** | no check exists yet |

A run exits non-zero on any red or unbuilt row.

## The test accounts

`test-a` and `test-b` are ordinary Wilco accounts (tokens in `keys` as
`FASTMAIL_TESTA_WILCO_TOKEN`/`FASTMAIL_TESTB_WILCO_TOKEN`). **They are the only accounts the harness may
write to**, enforced in `lib.py` (`guard_write`, and every mutating API call)
and `jmap.py` (every write, and construction itself). A violation aborts the
run.

The fixtures in them persist. `fixtures.py` resets them at the start of every
run — back to Inbox, flags restored, everything that is not a fixture
destroyed, anything missing re-sent one at a time and verified. It does not
wipe and re-send, because Fastmail silently loses part of any burst from these
accounts (measured; see the module docstring).

## Proving a check

The one time a deploy bypasses `deploy.sh`'s gate:

```sh
# apply the mutation with an edit
./deploy.sh --no-gate
./harness/run.sh <rows>          # expect exactly those rows RED
git checkout -- <files>
./deploy.sh                      # the real deploy of the reverted code
```

Then write into the row's `Proven by`: `<date> <file>: <mutation> → RED "<message>"`.

🚨 **While the board has real reds, the gate cannot pass, so `./deploy.sh` will
roll back to whatever ran before — and after a mutation build that is the
MUTANT.** Until the board is green, the clean rebuild after a mutation is
`./deploy.sh --no-gate` followed by `./harness/run.sh --update-checklist`,
and the board it prints is what proves the revert.

## Deploying

`./deploy.sh` and nothing else. It builds, brings the container up, runs the
server suite and every checklist row, and rolls back to the previous image on
any red or unbuilt row. `docker compose up -d` by hand is not a deploy.

## Requirements

No Playwright on the host and none needed: the checks run in
`wilco-harness-runner:local`, built from `harness/Dockerfile` on first use (or
`--build-runner`), which carries Chromium. Secrets come from `keys exec` when
the `keys` CLI is present, and never touch disk or the terminal.

Without the `keys` CLI, export `WILCO_HARNESS_PASSWORD` (the harness
instance's login password), `FASTMAIL_TESTA_WILCO_TOKEN` and
`FASTMAIL_TESTB_WILCO_TOKEN` yourself (the tokens of two JMAP accounts you own
and can wipe). With `keys`, a password filed under another name is mapped by
`WILCO_HARNESS_PASSWORD_KEY=<its name>` in `.env`.
