#!/usr/bin/env bash
# R-73 — a test run must leave NOTHING in the system temp dir.
#
# A container's /tmp is on its host's root disk: the R-271 suite left a 28 MB
# files dir per run until 543 runs had filled 15 GB of it. Every run now works
# inside a per-run root (server/__tests__/helpers/tmp-root.ts) removed at exit,
# and this is the check that it held: any mkdtemp-shaped directory (name, dash,
# six random characters) created in /tmp since the marker is a leak.
#
# usage: check-test-tmp.sh <marker-file>   (touch the marker before `bun test`)
set -euo pipefail
marker="${1:?usage: check-test-tmp.sh <marker-file>}"
tmp="${TMPDIR_PARENT:-/tmp}"
leaks=$(find "$tmp" -maxdepth 1 -mindepth 1 -type d -newer "$marker" \
          -regextype posix-extended -regex "$tmp/[A-Za-z0-9._-]+-[A-Za-z0-9]{6}" 2>/dev/null || true)
if [ -n "$leaks" ]; then
  echo "::error::the test run left temp directories in $tmp (R-73):"
  echo "$leaks" | sed 's/^/  /'
  exit 1
fi
echo "ok: no temp directories left in $tmp"
