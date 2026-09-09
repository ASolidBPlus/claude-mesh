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
# So: a RATCHET — and since #80, one that gates on the SET of errors rather
# than on how many there are. The committed identity file is the baseline; CI
# fails if any identity appears that is not in it. New code is held to zero new
# type errors, and the baseline shrinks as the debt is paid.
#
# WHY NOT A COUNT. A count is a proxy, and the proxy was measured failing:
# fixing one error while introducing another in a different file kept the total
# at 115 and printed `✅ held`, exit 0 — a fresh type error entering the tree
# with the gate green. The set cannot be fooled that way, because the new
# identity is present whatever the total does.
#
# A RATCHET MUST BE SUSPICIOUS OF IMPROVEMENT, not only of regression (#76's
# lesson, #80's design). Every way of REDUCING what tsc checks also reduces the
# errors it reports: a file excluded, moved or deleted, or one carrying
# `@ts-nocheck`. Those look exactly like progress from here, so a vanished
# identity is CLASSIFIED rather than congratulated — see the DOWN branch below.
#
# WHAT THIS STILL DOES NOT CATCH, stated rather than papered over: a
# `@ts-expect-error` or `@ts-ignore` on ONE LINE suppresses one diagnostic and
# leaves the file both in the program and free of `@ts-nocheck`, so it reads as
# a fix. The identity names the file, which is where a reviewer looks; a
# suppression-count ratchet is the next step if that becomes the common route.
#
# THE IDENTITY FILES (`.github/typecheck-identities-*.txt`) ARE THE BASELINE:
# one line per diagnostic, `file:code:message` with a `#n` suffix for repeats.
# LINE-INDEPENDENT BY DESIGN (#177) — a line number is a property of everything
# above an error rather than of the error, so keying on one made every
# count-preserving edit churn the file while nothing read it.
#
# THE COUNT IS DERIVED AND PRINTED, NEVER STORED (#80). It used to live in
# `.github/typecheck-baseline-*.txt` beside the list it summarises, and two
# encodings of one fact drift — which is the failure this repo keeps meeting.
# `wc -l` of the identity file is the number; there is nothing to disagree with.
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
  identity_file=".github/typecheck-identities-${pkg}.txt"

  # THE BASELINE MUST EXIST. It is the gate now, not an explanation of one, so a
  # missing file is a refusal rather than a fresh start — "no baseline" and
  # "nothing wrong" must not print the same thing.
  if [ ! -f "$identity_file" ]; then
    echo "::error::${pkg}: no identity baseline at ${identity_file} — there is nothing to compare against. Refusing to report."
    status=1
    continue
  fi
  baseline=$(grep -c '' "$identity_file")

  if [ ! -d "${pkg}/node_modules" ]; then
    echo "::error::${pkg}: node_modules missing — run 'bun install' first. Refusing to report, because an unresolvable tsc emits ONE error and that reads as an improvement."
    status=1
    continue
  fi

  output=$(cd "$pkg" && bunx tsc --noEmit 2>&1)
  if echo "$output" | grep -qE "$ENV_FAULT"; then
    echo "::error::${pkg}: tsc could not resolve its types (TS2688/TS2307) — the environment is broken, not the code. Refusing to report."
    echo "$output" | grep -E "$ENV_FAULT" | head -5
    status=1
    continue
  fi
  # AN IDENTITY IS LINE-INDEPENDENT: file : code : message (#177).
  #
  # It used to be file:LINE:code, and a line number is not a property of the
  # error — it is a property of everything above it. F4 moved ~60 identities by
  # shifting lines while the count held, so the file was never consulted and
  # never refreshed; the first genuine fix then produced a vanished list of 61
  # entries containing 2 real ones.
  #
  # tsc has no enclosing-symbol field, but the MESSAGE names the symbol
  # ("'touchAgent' is declared but its value is never read"), so the stable
  # anchor is already in the input. Whitespace is collapsed because tsc wraps
  # some messages.
  #
  # DUPLICATES GET A #n SUFFIX so the file keeps ONE LINE PER DIAGNOSTIC. Dedup
  # runs BEFORE the sort: appending "#2" after sorting can break the ordering
  # comm depends on (a space sorts before '#', so "A extra" and "A#2" would
  # swap).
  current_ids=$(echo "$output" \
    | grep -oE '^[^(]+\([0-9]+,[0-9]+\): error TS[0-9]+: .*' \
    | sed -E 's/\(([0-9]+),[0-9]+\): error (TS[0-9]+): /:\2:/' \
    | sed -E 's/[[:space:]]+/ /g' \
    | awk '{ c[$0]++; if (c[$0] > 1) print $0 "#" c[$0]; else print $0 }' \
    | LC_ALL=C sort)
  count=$([ -z "$current_ids" ] && echo 0 || echo "$current_ids" | wc -l | tr -d ' ')

  # comm NEEDS A FILE, and an empty `current_ids` must be an EMPTY file rather
  # than one blank line — a blank line is an identity that matches nothing and
  # would be reported as added.
  cur_file=$(mktemp); : > "$cur_file"
  [ -n "$current_ids" ] && printf '%s\n' "$current_ids" > "$cur_file"

  # comm's STATUS IS NOT SWALLOWED. If it cannot compare (collation mismatch,
  # unsorted input) it warns and still prints a WRONG answer — usually the EMPTY
  # one, which would read as "nothing changed" on exactly the run that mattered.
  # Could-not-compare is a THIRD STATE, not agreement.
  #
  # LC_ALL=C throughout: the committed file was sorted in whoever's locale
  # generated it while CI sorts in the runner's, and C collation is the one
  # locale that is the same everywhere.
  comm_err=$(mktemp)
  added=$(LC_ALL=C comm -13 "$identity_file" "$cur_file" 2>"$comm_err"); rc=$?
  vanished=$(LC_ALL=C comm -23 "$identity_file" "$cur_file" 2>>"$comm_err"); rc2=$?
  if [ "$rc" -ne 0 ] || [ "$rc2" -ne 0 ] || [ -s "$comm_err" ]; then
    echo "::error::${pkg}: CANNOT COMPARE the identity set against ${identity_file} (collation or sort order). Treating this as unknown, NOT as agreement."
    sed 's/^/    /' "$comm_err" | head -5
    rm -f "$comm_err" "$cur_file"
    status=1
    continue
  fi
  rm -f "$comm_err" "$cur_file"

  # ── ADDED: the gate. Fails on a new identity whatever the count does ───────
  if [ -n "$added" ]; then
    n_added=$(printf '%s\n' "$added" | grep -c '')
    echo "::error::${pkg}: ${n_added} NEW type error identit(y/ies) — not in ${identity_file}. New code must not add type errors."
    printf '%s\n' "$added" | sed 's/^/    + /' | head -40
    status=1
  fi

  # ── VANISHED: classified, never congratulated ─────────────────────────────
  if [ -n "$vanished" ]; then
    # WHICH FILES DID TSC ACTUALLY CHECK? `--listFilesOnly` prints the program's
    # file set and typechecks nothing, so it is both exact and cheap (~0.4s).
    # This turns "did this file stop being checked?" from a heuristic into a
    # lookup.
    program=$(cd "$pkg" && bunx tsc --noEmit --listFilesOnly 2>/dev/null)
    unchecked=""; suppressed=""; fixed=""
    while IFS= read -r id; do
      [ -z "$id" ] && continue
      f=${id%%:*}
      abs=$(cd "$pkg" && realpath -m "$f")
      if ! grep -qxF "$abs" <<<"$program"; then
        unchecked="${unchecked}${id}"$'\n'
      # BOTH ROUTES, BECAUSE THEY NEED DIFFERENT INSTRUMENTS — measured, not
      # assumed. Excluding a file removes it from the program (the lookup above
      # catches it); `// @ts-nocheck` leaves the file LISTED and silences it
      # anyway, so the lookup alone would have missed the commoner of the two.
      elif [ -f "$abs" ] && grep -q '@ts-nocheck' "$abs"; then
        suppressed="${suppressed}${id}"$'\n'
      else
        fixed="${fixed}${id}"$'\n'
      fi
    done <<<"$vanished"

    if [ -n "$unchecked" ]; then
      # A MOVE IS NOT A SHRINK, and saying so would be false in the one case
      # where the identities are all still there: renamed, they vanish from the
      # old path and reappear in the ADDED list above under the new one. The
      # message names the state — this file is no longer checked — and points at
      # the evidence that tells the three causes apart, rather than asserting
      # the cause it cannot see (seat 2 on #191).
      echo "::error::${pkg}: errors disappeared because their FILE IS NO LONGER TYPECHECKED. Deleted or excluded means coverage shrank; MOVED means the same identities are in the added list above under the new path. Confirm which — none of the three is a fix."
      printf '%s' "$unchecked" | sed 's/^/    - /' | head -20
      status=1
    fi
    if [ -n "$suppressed" ]; then
      echo "::error::${pkg}: errors disappeared because their file carries @ts-nocheck. Suppressed, not fixed."
      printf '%s' "$suppressed" | sed 's/^/    - /' | head -20
      status=1
    fi
    if [ -n "$fixed" ]; then
      # A GENUINE FIX MUST NOT RED CI. It is reported and the baseline refresh is
      # a separate, deliberate commit — the same confirmation a legitimate
      # deletion needs, which is the point.
      n_fixed=$(printf '%s' "$fixed" | grep -c '')
      echo "${pkg}: ${n_fixed} identit(y/ies) no longer reported, and their files are still checked and unsuppressed — these look like real fixes:"
      printf '%s' "$fixed" | sed 's/^/    - /' | head -40
    fi
    echo "::notice::${pkg}: ${baseline} → ${count}. Refresh the baseline to lock this in, and ONLY after reading the list above: (cd ${pkg} && bunx tsc --noEmit 2>&1 | grep -oE '^[^(]+\([0-9]+,[0-9]+\): error TS[0-9]+: .*' | sed -E 's/\(([0-9]+),[0-9]+\): error (TS[0-9]+): /:\2:/' | sed -E 's/[[:space:]]+/ /g' | awk '{ c[\$0]++; if (c[\$0] > 1) print \$0 \"#\" c[\$0]; else print \$0 }' | LC_ALL=C sort > ../${identity_file})"
  fi

  if [ -z "$added" ] && [ -z "$vanished" ]; then
    echo "${pkg}: ${count} (baseline ${baseline}) ✅ held — identity set unchanged"
  fi
done
exit "$status"
