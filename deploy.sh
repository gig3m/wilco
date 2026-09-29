#!/usr/bin/env bash
# The only sanctioned way to deploy Wilco. A deploy that did not go through
# this script did not happen.
#
#   ./deploy.sh              # build, gate on the harness instance, then ship
#   ./deploy.sh --no-gate    # build and bring up the HARNESS instance only,
#                            # for proving a MUTATION; never for shipping.
#
# Since 2026-09-08 the gate runs against a SEPARATE instance
# (wilco-harness, wilcotest.example.com) that holds only the two test accounts:
#
#   build  ->  up wilco-harness  ->  server suite  ->  performance budget
#          ->  every board row  ->  up wilco (production)  ->  read-only
#          smoke rows on production
#
# Production changes only after the whole board is green, so a mutant, an
# unproven build or a fixture reset never reaches the owner's client. A red
# board leaves production exactly as it was; a red smoke pass rolls it back.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

envval() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
bind="$(envval WILCO_BIND)";              bind="${bind:-127.0.0.1}"
prod_port="$(envval WILCO_HOST_PORT)";    prod_port="${prod_port:-8794}"
harness_port="$(envval WILCO_HARNESS_HOST_PORT)"; harness_port="${harness_port:-8797}"
grep -q '^COMPOSE_FILE=.*harness' .env || { echo "deploy.sh needs the harness instance: set COMPOSE_FILE in .env (see .env.example)"; exit 2; }

gate=1; [[ "${1:-}" == "--no-gate" ]] && gate=0

if docker image inspect wilco:local >/dev/null 2>&1; then
  docker tag wilco:local wilco:previous
fi

wait_healthy() {  # $1 = port, $2 = name
  local code=""
  for _ in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://$bind:$1/healthz" || true)
    [[ "$code" == "200" ]] && return 0
    sleep 3
  done
  echo "$2: healthz never returned 200 (last: $code)"; return 1
}

# A rollback across a migration must not move the database aside.
#
# Shipping migration 10 (2026-09-22) proved this: a red board retagged
# wilco:previous and restarted wilco-harness on it, but wilco-harness's
# database had ALREADY been migrated by the new image brought up minutes
# earlier. The older build's openDb() saw user_version ahead of its own
# SCHEMA_VERSION, threw, and main.ts's catch (at the time) moved the
# database aside and started empty -- wiping the harness instance's
# accounts, sealed credentials and mail. The same shape is open on
# production: a red smoke pass retags and restarts wilco on the old image
# against a database the new image already migrated.
#
# $1 is a container name that is CURRENTLY RUNNING THE NEW IMAGE (its
# database reflects whatever migrations that image just ran). Returns
# NON-ZERO (i.e. "false", safe to proceed) if rolling back to wilco:previous
# would NOT lose data -- wilco:previous's own SCHEMA_VERSION is at least the
# database's current user_version. Returns ZERO ("true", refuse the
# rollback) if it WOULD go backwards, printing why. Also returns zero (does
# not guess) if either value can't be read at all: an unreadable database or
# a broken previous image is itself a reason not to trust a rollback into
# it.
#
# Only stdout is captured into the value being compared -- an experimental
# warning, a docker/compose diagnostic, or anything else on stderr must
# never land in $current/$previous_schema and get compared as if it were a
# schema number (review fix: Important 2). On failure the same command is
# re-run capturing stderr alone, purely so the printed reason is the real
# one instead of a fixed guess.
rollback_would_lose_data() {  # $1 = container name
  local container="$1" current previous_schema err
  local read_current_js='
    import("node:sqlite").then((m) => {
      const db = new m.DatabaseSync("/data/wilco.db", { readOnly: true });
      process.stdout.write(String(db.prepare("PRAGMA user_version").get().user_version));
    }).catch((e) => { console.error(e); process.exit(1); });
  '
  local read_previous_js='
    import("./src/core/db.ts").then((m) => { process.stdout.write(String(m.SCHEMA_VERSION)); })
      .catch((e) => { console.error(e); process.exit(1); });
  '

  if ! current=$(docker exec "$container" node -e "$read_current_js" 2>/dev/null); then
    err=$(docker exec "$container" node -e "$read_current_js" 2>&1 >/dev/null || true)
    echo "could not read $container's database schema version: $err"
    return 0
  fi
  if ! [[ "$current" =~ ^[0-9]+$ ]]; then
    echo "$container's database schema version was unreadable output, not a number: $current"
    return 0
  fi

  if ! previous_schema=$(docker run --rm wilco:previous node -e "$read_previous_js" 2>/dev/null); then
    err=$(docker run --rm wilco:previous node -e "$read_previous_js" 2>&1 >/dev/null || true)
    echo "could not read wilco:previous's SCHEMA_VERSION: $err"
    return 0
  fi
  if ! [[ "$previous_schema" =~ ^[0-9]+$ ]]; then
    echo "wilco:previous's SCHEMA_VERSION was unreadable output, not a number: $previous_schema"
    return 0
  fi

  if (( current > previous_schema )); then
    echo "$container's database is at schema version $current; wilco:previous only understands $previous_schema."
    return 0
  fi
  return 1
}

# Refuse a rollback that would go backwards across a migration: leave the
# new image running (it already understands whatever it just did to the
# database) and say what to do instead, rather than silently discarding the
# refusal and rolling back anyway. $1 is a human description of what stays
# on the new image -- rollback_would_lose_data already printed the SPECIFIC
# reason just above, so this does not restate a fixed cause.
refuse_rollback() {  # $1 = description of what is left on the new image
  echo "== ROLLBACK REFUSED: see the reason printed above =="
  echo "   $1 is LEFT RUNNING ON THE NEW IMAGE rather than risk opening its database with a build that"
  echo "   cannot be shown to understand it. To recover: fix forward and redeploy, or restore the"
  echo "   affected database from a backup taken before this deploy and only then roll the image back."
}

echo "== build =="
docker compose build wilco
echo "== up: harness instance =="
docker compose up -d wilco-harness
wait_healthy "$harness_port" wilco-harness

if [[ $gate -eq 0 ]]; then
  echo "== NO GATE (mutation build on the harness instance; production untouched) =="
  exit 0
fi

echo "== server typecheck =="
# The client's typecheck has been in the gate since 2026-09-05; the server's
# was not, and 17 errors had accumulated by the time the 2026-09-10 feature
# audit ran it. Same treatment: a type error is a red gate.
if ! npm run --silent typecheck; then
  echo "== GATE FAILED at the server typecheck: production untouched =="
  # No retag here: wilco-harness is already up on this build and its database
  # has already been migrated by it (see rollback_would_lose_data above).
  # Nothing has been deployed to PRODUCTION yet, so there is nothing to roll
  # back -- retagging wilco:local -> wilco:previous would instead leave
  # wilco:local pointing at an image that cannot open the harness database it
  # just migrated, crash-looping the next plain `docker compose up -d`.
  exit 1
fi

echo "== server suite =="
suite=$(systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 -- npm test 2>&1 | grep -E '^# (tests|pass|fail)' || true)
echo "$suite"
if [[ -z "$suite" ]] || grep -q '^# fail [1-9]' <<<"$suite"; then
  echo "== GATE FAILED at the suite: production untouched =="
  # No retag: see the note at the typecheck gate above -- wilco-harness's
  # database has already been migrated by this build, and nothing has
  # reached production yet.
  exit 1
fi

echo "== performance budget =="
# Runs against a synthetic 200k-message corpus in a throwaway temp database
# (test/bench/corpus.ts), never against the harness or production database --
# so this needs no container up, just the host's node. Kept out of `npm test`
# (it costs ~10-15s to build the corpus alone) and run here, after the suite
# and before the board, so a return to an O(mailbox)/O(folder) read path
# fails the gate exactly like a correctness regression does. See
# test/bench/list.bench.ts for the budgets, the query-plan assertions, and
# the regression proof that the old collapsing statement trips both.
bench=$(systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 -- npm run --silent bench 2>&1 | grep -E '^# (tests|pass|fail)' || true)
echo "$bench"
if [[ -z "$bench" ]] || grep -q '^# fail [1-9]' <<<"$bench"; then
  echo "== GATE FAILED at the performance budget: production untouched =="
  # No retag: see the note at the typecheck gate above -- wilco-harness's
  # database has already been migrated by this build, and nothing has
  # reached production yet.
  exit 1
fi

echo "== checklist (harness instance) =="
if ! ./harness/run.sh --update-checklist; then
  echo "== GATE FAILED on the board: production untouched =="
  if rollback_would_lose_data wilco-harness; then
    refuse_rollback wilco-harness
  else
    docker tag wilco:previous wilco:local
    docker compose up -d wilco-harness
  fi
  exit 1
fi

echo "== up: production =="
docker compose up -d wilco
wait_healthy "$prod_port" wilco

echo "== smoke (production, read-only) =="
if ./harness/run.sh --smoke; then
  echo "== deployed =="
  exit 0
fi
echo
# The rollback below restarts BOTH wilco and wilco-harness on the old image
# (wilco-harness was already running the new one since the checklist step),
# so both of their databases must be safe to open with wilco:previous --
# checking only production and restarting the harness anyway (review fix:
# minor 6) would repeat the exact migration-10 wipe on wilco-harness.
if rollback_would_lose_data wilco || rollback_would_lose_data wilco-harness; then
  refuse_rollback "wilco and wilco-harness"
  exit 1
fi
echo "== SMOKE FAILED: rolling production back to wilco:previous =="
docker tag wilco:previous wilco:local
docker compose up -d wilco wilco-harness
sleep 15
curl -s -o /dev/null -w 'healthz after rollback: %{http_code}\n' "http://$bind:$prod_port/healthz"
exit 1
