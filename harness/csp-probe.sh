#!/usr/bin/env bash
# Runs the CSP enforcement prover (audit pass 5). See csp-probe.py.
#
# `--network host` so the probe's own loopback servers are reachable from
# the browser: the exploit targets ARE the harness, and a bridged container
# could not connect back to them.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker image inspect wilco-harness-runner:local >/dev/null 2>&1 || docker build -q -t wilco-harness-runner:local "$here" >/dev/null
exec docker run --rm --network host \
  -v "$here/csp-probe.py:/csp-probe.py:ro" \
  wilco-harness-runner:local python /csp-probe.py "$@"
