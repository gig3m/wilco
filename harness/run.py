#!/usr/bin/env python3
"""
Runs the checklist against the DEPLOYED app and prints the board.

    python run.py                    # every check
    python run.py 3 18 22            # by number
    python run.py --update-checklist # also rewrite CHECKLIST.md's State column

Exit code is non-zero on any red or unbuilt row (board.exit_code).
"""
import sys
import time
import traceback

from playwright.sync_api import sync_playwright

import board
from checks import CHECKS, Ctx
from fixtures import prepare

# Rows that read ONLY, need no fixture and no test account, and mean
# something against the owner's real data: the post-deploy smoke pass on
# production (`--smoke`). Everything else runs against the harness instance.
SMOKE_ROWS = [1, 2, 18, 29]
from jmap import jmaps
from lib import Run, Problem, WriteRefused, OUT, BASE

CHECKLIST = "CHECKLIST.md"  # run.sh sets the working directory to the harness dir


def main(argv: list[str]) -> int:
    update = "--update-checklist" in argv
    smoke = "--smoke" in argv
    rows = board.load(CHECKLIST)
    # Every row the checklist has, not a hard-coded 34: row 35 was added on
    # day 1 of the week and a full run silently skipped it, keeping the
    # file's red with no message.
    wanted = [int(a) for a in argv[1:] if a.isdigit()] or (SMOKE_ROWS if smoke else [r.n for r in rows])

    results: dict[int, str] = {}
    detail: dict[int, str] = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1440, "height": 950}, accept_downloads=True)
        page = context.new_page()
        run = Run(page, context)
        try:
            run.login()
            if smoke:
                # Production: no test accounts, no fixtures, no writes. A row
                # that reaches for c.J or c.F here is a bug in SMOKE_ROWS.
                J, F = {}, None
                print(f"  smoke pass against {BASE}: rows {wanted}, read-only")
            else:
                J = jmaps()
                started = time.time()
                F = prepare(run, J)
                print(f"  fixtures ready in {time.time() - started:.0f}s")
        except Exception as exc:
            print(f"FATAL  setup: {exc}")
            browser.close()
            return 1
        ctx = Ctx(run=run, J=J, F=F)

        for r in rows:
            if r.n not in wanted:
                results[r.n] = "skipped"
                continue
            fn = CHECKS.get(r.n)
            if fn is None:
                results[r.n] = "missing"
                continue
            run.clear()
            started = time.time()
            try:
                fn(ctx)
                noise = run.unexpected()
                if noise:
                    raise Problem("unexpected console/network errors: " + " | ".join(noise[:3]))
                results[r.n] = "pass"
                print(f"  ok    {r.n:>2}  {time.time() - started:5.1f}s")
            except WriteRefused as exc:
                print(f"  ABORT {r.n:>2}  {exc}")
                browser.close()
                return 2
            except Problem as exc:
                results[r.n] = "fail"; detail[r.n] = str(exc)
                print(f"  RED   {r.n:>2}  {time.time() - started:5.1f}s  {exc}")
                run.shot(f"RED-{r.n:02d}")
            except Exception:
                results[r.n] = "fail"; detail[r.n] = "ERROR " + traceback.format_exc(limit=2).strip().splitlines()[-1]
                print(f"  ERROR {r.n:>2}  {time.time() - started:5.1f}s")
                print("        " + traceback.format_exc(limit=3).replace("\n", "\n        "))
                run.shot(f"ERROR-{r.n:02d}")
            run.shot(f"{r.n:02d}")
            if run.blocked:
                print(f"  ABORT {r.n:>2}  the page tried to write outside the test accounts: {run.blocked}")
                run.shot(f"ABORT-{r.n:02d}")
                browser.close()
                return 2
            page.goto(BASE + "/", wait_until="load")
            page.wait_for_timeout(1000)
        browser.close()

    for r in rows:
        r.state = board.decide(r, results[r.n])
    print()
    print(board.render(rows, detail))
    open(f"{OUT}/board.txt", "w").write(board.render(rows, detail) + "\n")
    if update:
        board.save(CHECKLIST, rows)
    return board.exit_code(rows)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
