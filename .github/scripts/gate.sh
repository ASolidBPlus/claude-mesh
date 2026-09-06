#!/usr/bin/env bash
#
# Repository copy of the merge gate used for every merge to main since 2026-09-06 (this
# file replaces a script that lived in the gate-holder's working directory). It reads only
# from git and the GitHub API at gate time and never moves a head: a stale merge ref is
# reported with the deliberate fix (an empty commit), because that fix lapses a reviewer's
# verdict and must be a human decision. See the header comments per check.
# Merge gate for ASolidBPlus/claude-mesh pull requests.
#   gate.sh <pr> <expected-head-sha> <verdict-comment-id>...
# Env: SEAT=1|2 (require every verdict to come from that seat; default: report)
#      DISCHARGED=<comment-id> (a seat comment discharging a GO-WITH-AMENDMENTS
#        verdict at THIS head: same seat, contains the full head SHA, no NO-GO)
# Every value is read from git or the API at gate time. Checks:
#   1 branch ref == head == PR head
#   2 open, base main, mergeable, labels reported
#   3 refs/pull/N/merge parents (cat-file, survives shallow): p1 == main tip
#     NOW, p2 == head
#   4 latest pull_request run on head: completed/success, all jobs success
#   5 THE JOIN: the run's own provenance lines ("base (parent 1)", "head
#     (parent 2)", printed by ci.yml) equal the parents from 3 in every job —
#     the green tested the tree that lands, not an older merge
#   6 verdicts: first line names the seat (seat 2 anchored BEFORE seat 1 —
#     "sec-reviewer" is a prefix of "sec-reviewer-2"), body has the full head,
#     "Verdict: GO", no "NO-GO"; GO-WITH-AMENDMENTS fails without DISCHARGED;
#     no NO-GO anywhere in issue comments or PR reviews
#   7 closing keywords name issues only
# (Retired 2026-09-06: a retarget cycle through pinned away branches — it did not rebuild
#   the merge ref for PRs whose head had never moved, on four attempts across three pins.)
set -u
R=ASolidBPlus/claude-mesh
if [ "${1:-}" != --selftest ]; then N=$1; HEAD=$2; shift 2; VERDICTS=("$@"); fi
fail=0; ok(){ echo "PASS  $1"; }; bad(){ echo "FAIL  $1"; fail=1; }; note(){ echo "NOTE  $1"; }
seat_of(){ # anchored on the first line; seat 2 first
  local first; first=$(head -1 <<<"$1")
  if grep -qE '^\**`?sec-reviewer-2`?\**' <<<"$first"; then echo 2
  elif grep -qE '^\**`?sec-reviewer`?\**([^-]|$)' <<<"$first"; then echo 1
  else echo none; fi
}

# 5 the join — two producers of the same fact must agree: our provenance step
# ("base (parent 1)"/"head (parent 2)") and actions/checkout's own
# "HEAD is now at <merge> Merge <head> into <base>". If ours is absent but
# checkout's is present, the PARSER is broken; both absent = run predates the step.
join_check(){ # $1 run id, $2 expected base, $3 expected head -> prints, returns 0/1
  local run=$1 eb=$2 eh=$3 log njobs nb nh nco cob coh
  log=$(gh run view "$run" --log 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')
  njobs=$(grep -cP '^\S+\t.*\t[0-9T:.Z-]+ base \(parent 1\)  [0-9a-f]{40}' <<<"$log")
  nb=$(grep -cP "^\S+\t.*\t[0-9T:.Z-]+ base \(parent 1\)  $eb\$" <<<"$log")
  nh=$(grep -cP "^\S+\t.*\t[0-9T:.Z-]+ head \(parent 2\)  $eh\$" <<<"$log")
  nco=$(grep -cP 'HEAD is now at [0-9a-f]+ Merge [0-9a-f]{40} into [0-9a-f]{40}' <<<"$log")
  coh=$(grep -cP "HEAD is now at [0-9a-f]+ Merge $eh into [0-9a-f]{40}" <<<"$log")
  cob=$(grep -cP "HEAD is now at [0-9a-f]+ Merge [0-9a-f]{40} into $eb" <<<"$log")
  if [ "$nco" = 0 ] && [ "$njobs" = 0 ]; then bad "JOIN: run $run has neither checkout nor provenance merge lines (not a pull_request merge-ref run, or predates the step)"; return 1; fi
  if [ "$njobs" = 0 ] && [ "$nco" != 0 ]; then bad "JOIN: checkout printed a merge ($nco jobs) but our provenance lines are absent — PARSER or ci.yml fault, not a missing signal"; return 1; fi
  if [ "$nb" = "$njobs" ] && [ "$nh" = "$njobs" ] && [ "$cob" = "$nco" ] && [ "$coh" = "$nco" ]; then
    ok "JOIN: run $run built exactly (${eb:0:7}, ${eh:0:7}) — provenance $njobs/$njobs and checkout $nco/$nco agree"; return 0; fi
  bad "JOIN: run $run ≠ (${eb:0:7}, ${eh:0:7}) — provenance base $nb/$njobs head $nh/$njobs; checkout base $cob/$nco head $coh/$nco (older merge: re-run and gate again)"; return 1
}
if [ "${1:-}" = --selftest ]; then
  # inventory: a deleted check and a passing check print the same thing, so assert the SET
  # of checks is present in this file before testing any outcome
  for must in 'branch ref ' 'PR head = ' 'state open' 'base main' 'has two parents' 'parent 1 = main tip' 'parent 2 = head' 'mergeable (ref fresh' 'merge ref stale' 'CI run ' 'jobs: ' 'JOIN: run ' 'verdict $c binds' 'WITH[- ]AMENDMENT' 'no NO-GO in comments or reviews' 'required PR #' 'main:$f matches' 'closing keywords: ' 'closes issue #'; do
    grep -qF -- "$must" "$0" || { echo "SELFTEST FAIL: check missing from gate.sh: $must"; exit 3; }
  done
  echo "inventory: all checks present"
  for f in 34026343625 34025812806; do gh api "repos/$R/actions/runs/$f" >/dev/null 2>&1 || { echo "SELFTEST FIXTURES EXPIRED (run $f no longer retrievable) — not a gate fault; re-pin two current runs"; exit 2; }; done
  echo "positive: run 34026343625 must PASS for (c12e6dd, 6258a5c)"
  join_check 34026343625 c12e6ddd4192b4ebe3762be37d3bb82fd2ce70dc "$(gh api repos/$R/actions/runs/34026343625 --jq .head_sha)"; r1=$?
  echo "negative: run 34025812806 (head e2b788b) must FAIL for the same pair"
  join_check 34025812806 c12e6ddd4192b4ebe3762be37d3bb82fd2ce70dc "$(gh api repos/$R/actions/runs/34026343625 --jq .head_sha)"; r2=$?
  [ $r1 = 0 ] && [ $r2 = 1 ] && echo "SELFTEST PASS" || echo "SELFTEST FAIL (positive rc=$r1, negative rc=$r2)"; exit
fi

PR=$(gh api "repos/$R/pulls/$N")
state=$(jq -r .state <<<"$PR"); base=$(jq -r .base.ref <<<"$PR"); basesha=$(jq -r .base.sha <<<"$PR")
headsha=$(jq -r .head.sha <<<"$PR"); branch=$(jq -r .head.ref <<<"$PR")
mergeable=$(jq -r .mergeable <<<"$PR"); labels=$(jq -r '[.labels[].name]|join(",")' <<<"$PR")
body=$(jq -r .body <<<"$PR")

# Repair a PR a retired refresh cycle may have left on a gate/away branch.
if [[ "$base" == gate/away* ]]; then
  note "PR was left on $base by an interrupted run; restoring base main"
  gh pr edit "$N" -R "$R" --base main >/dev/null && base=main && sleep 5
fi

# 1
ref=$(git ls-remote origin "refs/heads/$branch" | cut -f1)
[ "$ref" = "$HEAD" ] && ok "branch ref $branch = ${HEAD:0:7}" || bad "branch ref ${ref:0:7} != expected ${HEAD:0:7}"
[ "$headsha" = "$HEAD" ] && ok "PR head = ${HEAD:0:7}" || bad "PR head is ${headsha:0:7}"
# 2
[ "$state" = open ] && ok "state open" || bad "state $state"
[ "$base" = main ] && ok "base main" || bad "base is $base (retarget first)"
# `mergeable` is computed from refs/pull/N/merge: on a stale ref it reports the OLD answer,
# and `null` means only "computing now", never "may be out of date". It is judged in
# check 3, after the ref's parents are known, and counts only when they are current.
[ -z "$labels" ] && ok "no labels" || note "labels: $labels"
# 3
read_merge_ref(){ # sets maintip mergec p1 p2 (refs/pull/N/merge is rebuilt only by a PR EVENT;
  # a merge to main does not rebuild it, and pulls/N base.sha is a snapshot, not live)
  git fetch -q origin main; maintip=$(git rev-parse FETCH_HEAD)
  git fetch -q origin "refs/pull/$N/merge"; mergec=$(git rev-parse FETCH_HEAD)
  mapfile -t parents < <(git cat-file -p "$mergec" | awk '/^parent /{print $2}')
  p1=${parents[0]:-}; p2=${parents[1]:-}
}
read_merge_ref
[ "${#parents[@]}" = 2 ] && ok "merge ref ${mergec:0:7} has two parents" || bad "merge ref has ${#parents[@]} parents"
[ "$p1" = "$maintip" ] && ok "parent 1 = main tip ${maintip:0:7}" || bad "parent 1 ${p1:0:7} != main tip ${maintip:0:7}"
[ "$p2" = "$HEAD" ] && ok "parent 2 = head" || bad "parent 2 ${p2:0:7} != head ${HEAD:0:7} (ref predates the head move)"
if [ "$p1" = "$maintip" ] && [ "$p2" = "$HEAD" ]; then
  [ "$mergeable" = true ] && ok "mergeable (ref fresh, so the flag is meaningful)" || bad "mergeable=$mergeable on a fresh ref (real conflict, or still computing)"
else
  bad "mergeable=$mergeable describes a stale tree (parents ${p1:0:7},${p2:0:7}) — not evidence either way"
fi
# 3a STALENESS. refs/pull/N/merge is rebuilt reliably by a HEAD change (synchronize) and
# unreliably by a BASE change (worked once on #145; failed on #139 three times and on #144,
# with the base genuinely different for 60-75 s each time). A body edit on a stale ref
# fires nothing (the `edited` event is evaluated against the OLD workflow in that ref).
# So the gate does not try to refresh: it reports a stale ref, and the deliberate fix is an
# EMPTY COMMIT on the branch (zero-byte diff, identical tree id) — a head move, so the
# seat re-binds on a tree comparison. With REFRESH=1 the gate waits for the newest
# pull_request run to complete instead of reading a stale one.
if [ "$p1" != "$maintip" ]; then
  bad "merge ref stale: parent 1 ${p1:0:7} != main ${maintip:0:7} — push an empty commit on the branch (git commit --allow-empty), then re-gate at the new head"
fi
if [ "${REFRESH:-0}" = 1 ]; then
  for i in $(seq 1 60); do nr=$(gh api "repos/$R/actions/runs?head_sha=$HEAD&event=pull_request" --jq '.workflow_runs|sort_by(.created_at)|last|"\(.id) \(.status)"'); set -- $nr; [ "${2:-}" = completed ] && break; sleep 10; done
  note "newest run: ${nr:-none}"
fi
# 4 — `event=pull_request` is deliberate and must stay: a merge_group run (the merge queue)
# prints event/ref instead of parents, which is correct there and byte-identical to the
# failure check 5 rejects. Once a queue ruleset exists, the queue's merge_group run is
# authoritative for "CI passed on the tree that lands"; this gate stays authoritative for
# what the queue cannot know (verdict bound to the head, no NO-GO, closing keywords,
# amendments discharged) and checks 3–5 become informational.
read -r runid rstatus rconc rcreated < <(gh api "repos/$R/actions/runs?head_sha=$HEAD&event=pull_request" --jq '.workflow_runs|sort_by(.created_at)|last|"\(.id) \(.status) \(.conclusion) \(.created_at)"')
if [ "${rstatus:-}" = completed ] && [ "${rconc:-}" = success ]; then ok "CI run $runid success ($rcreated)"; else bad "CI run ${runid:-none}: ${rstatus:-none}/${rconc:-none} (cancelled/in_progress = re-run)"; fi
jobs=$(gh api "repos/$R/actions/runs/${runid:-0}/jobs" --jq '.jobs[]|"\(.name):\(.conclusion)"' 2>/dev/null | tr '\n' ' ')
grep -qvE 'success' <<<"$(tr ' ' '\n' <<<"$jobs" | grep . | cut -d: -f2)" && bad "jobs: $jobs" || ok "jobs: $jobs"
# 5 the join (function defined above)
join_check "${runid:-0}" "$p1" "$p2"
# 6
for c in "${VERDICTS[@]}"; do
  cb=$(gh api "repos/$R/issues/comments/$c" --jq .body) || { bad "verdict $c unreadable"; continue; }
  s=$(seat_of "$cb")
  [ "${SEAT:-}" = "" ] || [ "$s" = "${SEAT}" ] && ok "verdict $c from seat $s" || bad "verdict $c from seat $s, SEAT=$SEAT required"
  grep -q "$HEAD" <<<"$cb" && grep -qP "^[\s*_\x60>-]*Verdict:\**\s*GO\b" <<<"$cb" && ! grep -qP "^[\s*_\x60>-]*Verdict:\**\s*NO-GO" <<<"$cb" \
    && ok "verdict $c binds ${HEAD:0:7} GO" || bad "verdict $c: head=$(grep -c "$HEAD" <<<"$cb") GO=$(grep -c 'Verdict: GO' <<<"$cb") NOGO=$(grep -cP '^[\s*_\x60>-]*Verdict:\**\s*NO-GO' <<<"$cb")"
  if grep -qiP "^[\s*_\x60>-]*Verdict:.*WITH[- ]AMENDMENT" <<<"$cb"; then
    if [ -n "${DISCHARGED:-}" ]; then
      db=$(gh api "repos/$R/issues/comments/$DISCHARGED" --jq .body 2>/dev/null) || db=""
      ds=$(seat_of "$db")
      [ "$ds" = "$s" ] && grep -q "$HEAD" <<<"$db" && ! grep -qP "^[\s*_\x60>-]*Verdict:\**\s*NO-GO" <<<"$db" \
        && ok "verdict $c GO-WITH-AMENDMENTS discharged by $DISCHARGED (seat $ds, binds ${HEAD:0:7})" \
        || bad "verdict $c GO-WITH-AMENDMENTS: discharge $DISCHARGED not by seat $s (seat $ds) or does not bind ${HEAD:0:7}"
    else bad "verdict $c is GO-WITH-AMENDMENTS at this head and no DISCHARGED comment cited"; fi
  fi
done
nogo=$(gh api "repos/$R/issues/$N/comments" --paginate --jq '[.[]|select(.body|test("(?m)^[\\s*_`>-]*Verdict:\\**\\s*NO-GO"))|.id]|join(",")')
nogor=$(gh api "repos/$R/pulls/$N/reviews" --paginate --jq '[.[]|select((.body//"")|test("(?m)^[\\s*_`>-]*Verdict:\\**\\s*NO-GO"))|.id]|join(",")')
[ -z "$nogo$nogor" ] && ok "no NO-GO in comments or reviews" || bad "NO-GO present: comments[$nogo] reviews[$nogor]"
# 6b REQUIRE_MERGED=<pr>[,<pr>]: a conditional discharge names another PR as the enforcer
# (an open PR reads identically to one that exists — #132's addendum); require it merged.
for rp in ${REQUIRE_MERGED:+${REQUIRE_MERGED//,/ }}; do
  m=$(gh api "repos/$R/pulls/$rp" --jq .merged 2>/dev/null)
  [ "$m" = true ] && ok "required PR #$rp is merged" || bad "required PR #$rp not merged (conditional discharge not satisfied)"
done
# 6c REQUIRE_MAIN="path:regex;path:regex": assert the PROPERTY a conditional discharge relies
# on, not the event that was supposed to produce it — each regex must match that file at
# main's tip (e.g. the derived publish rule and the moved cancelled note for #149).
if [ -n "${REQUIRE_MAIN:-}" ]; then
  IFS=';' read -ra reqs <<<"$REQUIRE_MAIN"
  for rq in "${reqs[@]}"; do f=${rq%%:*}; rx=${rq#*:}
    # whole-file match (-z); a leading "!" means the pattern must NOT match
    if [ "${rx:0:1}" = "!" ]; then rx=${rx:1}
      git show "$maintip:$f" 2>/dev/null | grep -zqP -- "$rx" && bad "main:$f matches forbidden /$rx/ (conditional discharge property missing)" || ok "main:$f does not match /$rx/"
    else
      git show "$maintip:$f" 2>/dev/null | grep -zqP -- "$rx" && ok "main:$f matches /$rx/" || bad "main:$f does not match /$rx/ (conditional discharge property missing)"
    fi
  done
fi
# 7
kw=$(grep -oiE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b #[0-9]+' <<<"$body" | sort -u | tr '\n' ' ')
note "closing keywords: ${kw:-none}"
for n in $(grep -oE '#[0-9]+' <<<"$kw" | tr -d '#'); do
  gh api "repos/$R/pulls/$n" >/dev/null 2>&1 && bad "closing keyword names PR #$n" || ok "closes issue #$n"
done
[ $fail = 0 ] && echo "GATE  PASS #$N @ ${HEAD:0:7}" || echo "GATE  FAIL #$N @ ${HEAD:0:7}"
exit $fail
