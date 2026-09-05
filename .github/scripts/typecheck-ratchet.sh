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

  # Error IDENTITIES (file:line:code), sorted — the interim half of #80. The
  # gate is still the COUNT; this exists so a DROP is legible. Recorded here
  # rather than only compared, because "what vanished" cannot be reconstructed
  # from two integers.
  identity_file=".github/typecheck-identities-${pkg}.txt"
  current_ids=$(echo "$output" | grep -oE '^[^(]+\([0-9]+,[0-9]+\): error TS[0-9]+' \
    | sed -E 's/\(([0-9]+),[0-9]+\): error (TS[0-9]+)/:\1:\2/' | sort)

  if [ "$count" -gt "$baseline" ]; then
    echo "::error::${pkg}: typecheck errors went UP — ${baseline} → ${count}. New code must not add type errors."
    echo "$output" | grep "error TS" | head -40
    status=1
  elif [ "$count" -lt "$baseline" ]; then
    # ── A DROP IS NOT NEWS UNTIL YOU KNOW WHAT LEFT ────────────────────────
    # Demonstrated on the merged head: one `// @ts-nocheck` at the top of a
    # test file takes server 117 → 89, and the old version of this branch
    # printed "✅ improved" plus "lower the baseline to lock it in".
    #
    # The suppression was not the dangerous part; THE ADVICE WAS. Follow it
    # and the floor becomes 89 permanently — after which REMOVING the
    # @ts-nocheck reads as a regression (89 → 117) and fails CI. The tool
    # would then be defending the edit that made things worse, and the
    # person restoring the checking would be the one CI blames.
    #
    # So: no advice, and the disappeared identities are NAMED. "28 vanished
    # from mcp-server.test.ts" is instantly legible as suppression; "117 → 89"
    # is not. (#80 makes the identity set the GATE — comparing which errors
    # exist, which also catches an equal-count swap. This only makes the drop
    # readable, which is the part that could not wait.)
    echo "${pkg}: ${count} (baseline ${baseline}) — errors went DOWN"
    if [ -f "$identity_file" ]; then
      vanished=$(comm -23 "$identity_file" <(echo "$current_ids") || true)
      if [ -n "$vanished" ]; then
        echo "  these stopped being reported — CONFIRM each is a real fix, not a file that stopped being checked:"
        echo "$vanished" | sed 's/^/    - /' | head -40
        echo "$vanished" | awk -F: '{print $1}' | sort | uniq -c | sort -rn \
          | awk '{printf "    %s error(s) from %s\n", $1, $2}' | head -10
      fi
    else
      echo "  (no identity baseline recorded yet — ${identity_file} will be written the first time this is refreshed)"
    fi
    echo "::notice::${pkg}: ${baseline} → ${count}. Do NOT lower the baseline until the disappeared list above is confirmed as real fixes; a suppressed or unchecked file looks identical to progress here."
  else
    echo "${pkg}: ${count} (baseline ${baseline}) ✅ held"
  fi
done
exit "$status"
