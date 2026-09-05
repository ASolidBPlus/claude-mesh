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

# ── The ratchet's own positive control ──────────────────────────────────────
# A count is only meaningful if tsc actually typechecked the code. Without
# installed deps it cannot resolve `bun-types` and emits ONE error (TS2688) —
# which is BELOW every baseline, so the naive ratchet reported "✅ improved"
# and exited 0. An environment where typechecking is broken read as an
# improvement, and would have invited someone to lower the baseline to 1 and
# permanently break the gate.
#
# Found by mesh-planner running this script in an environment without client
# deps installed — the second-reader catch that the author's own green run
# structurally could not produce.
#
# So: two failure codes are ENVIRONMENT faults, never code quality. Real runs
# have zero of both (verified on server and client at baseline). If either
# appears, the run is INVALID and reports nothing.
ENV_FAULT='error TS2688|error TS2307'

status=0
for pkg in server client; do
  baseline_file=".github/typecheck-baseline-${pkg}.txt"
  baseline=$(cat "$baseline_file")

  if [ ! -d "${pkg}/node_modules" ]; then
    echo "::error::${pkg}: node_modules missing — run 'bun install' first. Refusing to report a count, because an unresolvable tsc emits ONE error and that reads as an improvement."
    status=1
    continue
  fi

  output=$(cd "$pkg" && bunx tsc --noEmit 2>&1)
  if echo "$output" | grep -qE "$ENV_FAULT"; then
    echo "::error::${pkg}: tsc could not resolve its types (TS2688/TS2307) — the environment is broken, not the code. Refusing to report a count."
    echo "$output" | grep -E "$ENV_FAULT" | head -5
    status=1
    continue
  fi
  count=$(echo "$output" | grep -c "error TS" || true)

  if [ "$count" -gt "$baseline" ]; then
    echo "::error::${pkg}: typecheck errors went UP — ${baseline} → ${count}. New code must not add type errors."
    echo "$output" | grep "error TS" | head -40
    status=1
  elif [ "$count" -lt "$baseline" ]; then
    echo "::notice::${pkg}: typecheck errors went DOWN — ${baseline} → ${count}. Lower the baseline in ${baseline_file} to lock it in."
    echo "${pkg}: ${count} (baseline ${baseline}) ✅ improved"
  else
    echo "${pkg}: ${count} (baseline ${baseline}) ✅ held"
  fi
done
exit "$status"
