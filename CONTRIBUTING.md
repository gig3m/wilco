# Contributing

## Layout
- `src/` server: Node 26, TypeScript by type stripping, ZERO runtime
  dependencies. Nothing here may import anything but `node:` modules.
- `client/` Preact + Vite SPA; the only place `npm ci` runs (in the image build).
- `harness/` the end-to-end confidence board (see below).

## Tests
- Server: `npm run test:docker` (runs in a container; host Node may be < 26).
  It is green: `test/source-hygiene.test.ts` shells out to `git`, and the
  minimal test image has neither `git` nor a `.git` directory (excluded by
  `.dockerignore`), so that one test SKIPS itself in the container instead of
  failing. It still runs for real on the host — `deploy.sh`'s release gate
  runs the full suite there (where Node 26 and `git` are both present), and
  that is the run that must be clean, skips included nowhere.
- Server types: `npm run typecheck`.
- Client: `cd client && npm ci && npm test && npx tsc --noEmit` (`npm test`
  runs `./run-tests.sh` and does not typecheck on its own).

Those three are what a change must pass. They need no accounts and no network.

## The confidence board (maintainers)
`harness/` drives a real browser against a running Wilco holding **two
disposable JMAP accounts** it wipes on every run. To run it you need:
- a second Wilco instance (`docker-compose.harness.yml`, selected by
  `COMPOSE_FILE` in `.env`; see `.env.example`), reachable over TLS under
  its own pair of hostnames;
- two JMAP accounts you own and can empty, with tokens in
  `FASTMAIL_TESTA_WILCO_TOKEN` / `FASTMAIL_TESTB_WILCO_TOKEN`, and the instance's login password in
  `WILCO_HARNESS_PASSWORD`. These come from the `keys` CLI automatically when
  it's present; without it, export the three yourself (see `harness/README.md`);
- the harness's own runner image, `wilco-harness-runner:local`, built from
  `harness/Dockerfile` (automatic on first use, or force it with
  `./harness/run.sh --build-runner`) — it carries the browser the board drives;
- `./harness/run.sh` (about seven minutes; `./harness/run.sh 3 18` for rows).

`deploy.sh` is the maintainer's release gate: build → harness instance →
suite → every board row → production → read-only smoke. A change to the
board's rows is documented in `harness/CHECKLIST.md` and `harness/README.md`.
