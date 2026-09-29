#!/usr/bin/env bash
# Run the client test suite inside a KERNEL-ENFORCED memory cgroup.
#
# 🚨 WHY THIS EXISTS. On 2026-09-05 a runaway render loop in one client test
# consumed this box's 60 GB of RAM. The kernel OOM-killed the vitest worker,
# Docker began restarting containers under the pressure, and the machine --
# which also runs other services -- had to be rebooted. It then happened a SECOND time, because
# the mitigation was `--max-old-space-size` in vite.config.ts and that is a
# V8 heap hint, not a bound on the process: a loop that allocates DOM nodes,
# external buffers, or simply spawns work faster than V8 collects it sails
# straight past it.
#
# `MemoryMax` is a cgroup limit the KERNEL enforces on the whole process
# tree, including every worker vitest forks. When the tree exceeds it the
# kernel kills inside the cgroup and the rest of the box never notices.
# `MemorySwapMax=0` matters too: without it a runaway pushes 8 GB of swap
# and stalls the machine long before it dies.
#
# Use this, not `npx vitest`, for anything that runs the suite.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# Node 25+ ships its own global `localStorage`, which is undefined unless
# --localstorage-file is given and shadows happy-dom's. Without this the theme
# test throws and Sidebar.test.tsx loops until the cgroup OOM-kills it.
export NODE_OPTIONS="--no-experimental-webstorage${NODE_OPTIONS:+ $NODE_OPTIONS}"
exec systemd-run --user --scope --quiet \
  -p MemoryMax=4G -p MemorySwapMax=0 \
  -- npx vitest run "$@"
