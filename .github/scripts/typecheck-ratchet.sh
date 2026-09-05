#!/usr/bin/env bash
# #18 — tsc as a gate that can actually FAIL.
#
# tsc could not gate anything here: without allowImportingTsExtensions every
# .ts import was an error (TS5097), so the tool reported 218 errors on server/
# alone, none of them real. The config fix makes the output meaningful — but
# 155 genuine errors remain across the two packages, so a blocking gate today
# would just be permanently red, and a `continue-on-error` job cannot fail at
# all, which makes it decoration rather than a guard.
#
# So: a RATCHET. The current count is recorded per package; CI fails if the
# count goes UP. New code is held to zero new type errors, and the baselines
# come down as the debt is paid — each reduction is a one-line commit that
# locks the improvement in.
#
# WHAT THIS DOES NOT CATCH, stated because a count is a proxy: introducing one
# error while fixing another keeps the total equal and passes. The ratchet
# guards the trend, not each error. Driving a baseline to 0 and switching that
# package to a strict `[ "$count" -eq 0 ]` is what closes that gap for good.
set -uo pipefail

status=0
for pkg in server client; do
  baseline_file=".github/typecheck-baseline-${pkg}.txt"
  baseline=$(cat "$baseline_file")
  count=$(cd "$pkg" && bunx tsc --noEmit 2>&1 | grep -c "error TS" || true)

  if [ "$count" -gt "$baseline" ]; then
    echo "::error::${pkg}: typecheck errors went UP — ${baseline} → ${count}. New code must not add type errors."
    (cd "$pkg" && bunx tsc --noEmit 2>&1 | grep "error TS" | head -40)
    status=1
  elif [ "$count" -lt "$baseline" ]; then
    echo "::notice::${pkg}: typecheck errors went DOWN — ${baseline} → ${count}. Lower the baseline in ${baseline_file} to lock it in."
    echo "${pkg}: ${count} (baseline ${baseline}) ✅ improved"
  else
    echo "${pkg}: ${count} (baseline ${baseline}) ✅ held"
  fi
done
exit "$status"
