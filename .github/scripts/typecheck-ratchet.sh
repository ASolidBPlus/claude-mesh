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
#
# THE IDENTITY FILES (`.github/typecheck-identities-*.txt`) are the list behind
# the number: one line per diagnostic, `file:code:message` with a `#n` suffix
# for repeats. LINE-INDEPENDENT BY DESIGN (#177) — a line number is a property
# of everything above an error rather than of the error, so keying on one made
# every count-preserving edit churn the file while nothing was looking at it.
# They are read only when the count goes DOWN, to name what left; #80 is where
# the SET becomes the gate, and that needs identities that survive a line shift.
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
  # ONE extraction feeds BOTH the count and the identities. They used to be two
  # patterns over one population — anything matching `grep -c "error TS"` but
  # not the identity regex made the number and the list disagree, and the
  # NUMBER is the gate. A gate and its explanation must not be able to
  # describe different worlds.
  identity_file=".github/typecheck-identities-${pkg}.txt"
  # AN IDENTITY IS LINE-INDEPENDENT: file : code : message (#177).
  #
  # It used to be file:LINE:code, and a line number is not a property of the
  # error — it is a property of everything above it. F4 moved ~60 identities by
  # shifting lines while the count held, so the file was never consulted and
  # never refreshed; the first genuine fix then produced a vanished list of 61
  # entries containing 2 real ones. A warning list that is routinely wrong gets
  # skimmed, then ignored, which is the failure this script's own comment
  # predicts.
  #
  # tsc has no enclosing-symbol field, but the MESSAGE names the symbol
  # ("'touchAgent' is declared but its value is never read"), so the stable
  # anchor is already in the input. Whitespace is collapsed because tsc wraps
  # some messages.
  #
  # Measured twice: a ten-line shift at the top of db.ts churned 4 old
  # identities and 0 new ones, and rebasing this branch over a merged PR that
  # added a test file and edited two others churned 0 — the case the old scheme
  # produced 61 entries for.
  #
  # DUPLICATES GET A #n SUFFIX so the identity file keeps ONE LINE PER
  # DIAGNOSTIC — the count and the list must describe the same world, which is
  # the invariant the single extraction below exists for. Dedup runs BEFORE the
  # sort: appending "#2" after sorting can break the ordering comm depends on
  # (a space sorts before '#', so "A extra" and "A#2" would swap).
  current_ids=$(echo "$output" \
    | grep -oE '^[^(]+\([0-9]+,[0-9]+\): error TS[0-9]+: .*' \
    | sed -E 's/\(([0-9]+),[0-9]+\): error (TS[0-9]+): /:\2:/' \
    | sed -E 's/[[:space:]]+/ /g' \
    | awk '{ c[$0]++; if (c[$0] > 1) print $0 "#" c[$0]; else print $0 }' \
    | LC_ALL=C sort)
  # LC_ALL=C throughout: `comm` requires both inputs in the SAME collation, and
  # the committed files were sorted in whoever's locale generated them while CI
  # sorts in the runner's. On mismatch comm warns on stderr and STILL emits —
  # wrong — output. C collation is the one locale that is the same everywhere.
  count=$([ -z "$current_ids" ] && echo 0 || echo "$current_ids" | wc -l | tr -d ' ')

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
      # comm's STATUS IS NOT SWALLOWED. If it cannot compare (collation
      # mismatch, unsorted input), it warns and still prints a WRONG answer —
      # and the wrong answer is usually the EMPTY one, which would skip the
      # warning block below and leave a bare "errors went DOWN" on the exact
      # run where 28 errors were suppressed. Could-not-compare is a THIRD
      # STATE, not "nothing vanished" — the same discipline as never-ran.
      comm_err=$(mktemp)
      vanished=$(LC_ALL=C comm -23 "$identity_file" <(echo "$current_ids") 2>"$comm_err")
      comm_status=$?
      if [ "$comm_status" -ne 0 ] || [ -s "$comm_err" ]; then
        echo "::error::${pkg}: CANNOT DETERMINE what vanished — comm failed to compare the identity baseline (collation or sort order). Treating this as unknown, NOT as 'nothing vanished'."
        sed 's/^/    /' "$comm_err" | head -5
        rm -f "$comm_err"
        status=1
        continue
      fi
      rm -f "$comm_err"
      if [ -n "$vanished" ]; then
        echo "  these stopped being reported — CONFIRM each is a real fix, not a file that stopped being checked:"
        echo "$vanished" | sed 's/^/    - /' | head -40
        echo "$vanished" | awk -F: '{print $1}' | sort | uniq -c | sort -rn \
          | awk '{printf "    %s error(s) from %s\n", $1, $2}' | head -10
      fi
    else
      echo "  (no identity baseline recorded yet — ${identity_file} will be written the first time this is refreshed)"
    fi
    # Naming the refresh command matters more than it looks: the identity file
    # is not self-updating, so after the first legitimate fix-and-lower a stale
    # baseline reports already-fixed errors as freshly vanished — and a warning
    # list that is routinely wrong gets skimmed, then ignored. Both files move
    # together or the next run lies.
    #
    # #177 removed the OTHER source of that staleness: identities used to carry
    # a line number, so every count-preserving edit above an error rewrote its
    # identity while this file was never consulted (it is read only on a DOWN).
    # They are now file:code:message, so a line shift changes nothing and a
    # vanished entry is a vanished ERROR.
    echo "::notice::${pkg}: ${baseline} → ${count}. Do NOT lower the baseline until the disappeared list above is confirmed as real fixes; a suppressed or unchecked file looks identical to progress here. To accept: (cd ${pkg} && bunx tsc --noEmit 2>&1 | grep -oE '^[^(]+\\([0-9]+,[0-9]+\\): error TS[0-9]+: .*' | sed -E 's/\\(([0-9]+),[0-9]+\\): error (TS[0-9]+): /:\\2:/' | sed -E 's/[[:space:]]+/ /g' | awk '{ c[\$0]++; if (c[\$0] > 1) print \$0 \"#\" c[\$0]; else print \$0 }' | LC_ALL=C sort > ../${identity_file} && wc -l < ../${identity_file} > ../${baseline_file})"
  else
    echo "${pkg}: ${count} (baseline ${baseline}) ✅ held"
  fi
done
exit "$status"
