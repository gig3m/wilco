#!/usr/bin/env bash
# Wilco end-to-end harness. See run.py and CHECKLIST.md for what it
# asserts.
#
# The board's browser is `wilco-harness-runner:local`, built from
# `harness/Dockerfile` on first use (or `--build-runner`).
#
#   ./harness/run.sh                       # every check
#   ./harness/run.sh 3 18 22               # by number
#   ./harness/run.sh --update-checklist    # also rewrite CHECKLIST.md
#   ./harness/run.sh --smoke               # the read-only rows against PRODUCTION
#   ./harness/run.sh --build-runner        # force a rebuild of the runner image
#
# Since 2026-09-08 the board runs against the HARNESS INSTANCE
# (wilcotest.example.com, only the two test accounts); production is reached
# only by --smoke, or by setting WILCO_BASE/WILCO_BODY_BASE by hand.
#
# The login password and the two TEST-account tokens come from the keys
# service via `keys exec` when its CLI is present, so they are never written
# to disk and never reach the terminal; without `keys` they must already be
# in the environment (a contributor's own accounts).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
out="${WILCO_HARNESS_OUT:-$here/out}"
mkdir -p "$out"

# Defaults from .env (maintainer keys); explicit WILCO_BASE/WILCO_BODY_BASE win.
envval() { grep -E "^$1=" "$root/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
if [[ " $* " == *" --smoke "* ]]; then
  export WILCO_BASE="${WILCO_BASE:-$(envval WILCO_BASE_URL)}" WILCO_BODY_BASE="${WILCO_BODY_BASE:-$(envval WILCO_BODY_BASE_URL)}"
else
  export WILCO_BASE="${WILCO_BASE:-$(envval WILCO_HARNESS_BASE_URL)}" WILCO_BODY_BASE="${WILCO_BODY_BASE:-$(envval WILCO_HARNESS_BODY_BASE_URL)}"
fi
[[ -n "$WILCO_BASE" && -n "$WILCO_BODY_BASE" ]] || { echo "set WILCO_HARNESS_BASE_URL/WILCO_HARNESS_BODY_BASE_URL in .env (or WILCO_BASE/WILCO_BODY_BASE)" >&2; exit 2; }

runner="wilco-harness-runner:local"
build_runner=0
args=()
for a in "$@"; do
  if [[ "$a" == "--build-runner" ]]; then
    build_runner=1
  else
    args+=("$a")
  fi
done
set -- "${args[@]}"
if [[ "$build_runner" == "1" ]] || ! docker image inspect "$runner" >/dev/null 2>&1; then
  docker build -q -t "$runner" "$here" >/dev/null
fi

# One runner at a time: the two harness accounts are real mailboxes that
# every run RESETS; two runs at once reset each other's fixtures mid-check.
lock="$out/.runner.lock"
if ! flock -n "$lock" true; then
  echo "  another harness run holds the test accounts; waiting for it to finish" >&2
fi

# Secrets: the login password and the two TEST-account tokens. From the keys
# service when its CLI is present (never written to disk); otherwise they
# must already be in the environment (a contributor's own accounts).
#
# The board reads the password as WILCO_HARNESS_PASSWORD. A keys store that
# files it under another name maps it with WILCO_HARNESS_PASSWORD_KEY in .env
# (gitignored), so a maintainer's own naming never reaches this repo.
pw_key="${WILCO_HARNESS_PASSWORD_KEY:-$(envval WILCO_HARNESS_PASSWORD_KEY)}"
pw_key="${pw_key:-WILCO_HARNESS_PASSWORD}"
[[ "$pw_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "WILCO_HARNESS_PASSWORD_KEY is not a variable name: $pw_key" >&2; exit 2; }
tokens=(FASTMAIL_TESTA_WILCO_TOKEN FASTMAIL_TESTB_WILCO_TOKEN)
if command -v keys >/dev/null 2>&1; then
  inject=(keys exec "$pw_key" "${tokens[@]}" --)
else
  pw_key=WILCO_HARNESS_PASSWORD
  for v in WILCO_HARNESS_PASSWORD "${tokens[@]}"; do [[ -n "${!v:-}" ]] || { echo "$v is not set and no keys CLI is present" >&2; exit 2; }; done
  inject=(env)
fi

exec flock -w 3600 "$lock" "${inject[@]}" sh -c '
  WILCO_HARNESS_PASSWORD="$(printenv '"$pw_key"')"; export WILCO_HARNESS_PASSWORD
  docker run --rm --network host --memory=4g --memory-swap=4g \
    -e WILCO_HARNESS_PASSWORD -e FASTMAIL_TESTA_WILCO_TOKEN -e FASTMAIL_TESTB_WILCO_TOKEN \
    -e WILCO_BASE -e WILCO_BODY_BASE \
    -e WILCO_HARNESS_OUT=/out \
    -v "'"$here"':/h:ro" -w /h \
    -v "'"$here"'/CHECKLIST.md:/h/CHECKLIST.md" \
    -v "'"$out"':/out" \
    '"$runner"' python run.py '"$*"'
'
