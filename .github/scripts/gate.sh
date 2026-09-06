#!/usr/bin/env bash
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
# The verdict-comment FORM these checks read is documented for writers in
# docs/REVIEW-VERDICTS.md; the predicates below are the authority, that page the interface.
# (Retired 2026-09-06: a retarget cycle through pinned away branches — it did not rebuild
#   the merge ref for PRs whose head had never moved, on four attempts across three pins.)
set -u
R=ASolidBPlus/claude-mesh
# The predicates below depend on GNU grep's exit semantics (a reviewer's ugrep shim gave a
# different answer for -v); use /usr/bin/grep explicitly where it exists.
[ -x /usr/bin/grep ] && grep(){ /usr/bin/grep "$@"; }
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
# ---- pure predicates: every outcome check lives here so --selftest can drive it with
# ---- known-bad input (an inventory of SOURCE STRINGS cannot tell a deleted check from a
# ---- passing one; only behaviour can — sec-reviewer, #151 finding 3)
chk_parents(){ # $1 nparents $2 p1 $3 p2 $4 maintip $5 head $6 mergeable
  [ "$1" = 2 ] && ok "merge ref has two parents" || bad "merge ref has $1 parents"
  [ "$2" = "$4" ] && ok "parent 1 = main tip ${4:0:7}" || bad "parent 1 ${2:0:7} != main tip ${4:0:7}"
  [ "$3" = "$5" ] && ok "parent 2 = head" || bad "parent 2 ${3:0:7} != head ${5:0:7} (ref predates the head move)"
  if [ "$2" = "$4" ] && [ "$3" = "$5" ]; then
    [ "$6" = true ] && ok "mergeable (ref fresh, so the flag is meaningful)" || bad "mergeable=$6 on a fresh ref (real conflict, or still computing)"
  else bad "mergeable=$6 describes a stale tree (parents ${2:0:7},${3:0:7}) — not evidence either way"; fi
}
chk_jobs(){ # $1 "name:conclusion …" — every job must be success; no jobs is not a pass
  local j; j=$(tr ' ' '\n' <<<"$1" | grep . | cut -d: -f2)
  if [ -n "$j" ] && ! grep -qv '^success$' <<<"$j"; then ok "jobs: $1"; else bad "jobs: ${1:-none}"; fi
}
chk_verdict(){ # $1 label $2 body $3 head $4 required seat or ""
  local s; s=$(seat_of "$2")
  if [ "$s" = none ]; then bad "verdict $1: first line names no seat (unattributable)"
  elif [ -z "$4" ] || [ "$s" = "$4" ]; then ok "verdict $1 from seat $s"
  else bad "verdict $1 from seat $s, SEAT=$4 required"; fi
  if grep -q "$3" <<<"$2" && grep -qP '^[\s*_\x60>-]*Verdict:\**\s*GO\b' <<<"$2" && ! grep -qP '^[\s*_\x60>-]*Verdict:\**\s*NO-GO' <<<"$2"; then
    ok "verdict $1 binds ${3:0:7} GO"
  else bad "verdict $1: head=$(grep -c "$3" <<<"$2") GO=$(grep -cP '^[\s*_\x60>-]*Verdict:\**\s*GO\b' <<<"$2") NOGO=$(grep -cP '^[\s*_\x60>-]*Verdict:\**\s*NO-GO' <<<"$2")"; fi
}
is_amend(){ grep -qiP '^[\s*_\x60>-]*Verdict:\**\s*GO[- ]WITH[- ]AMENDMENT' <<<"$1"; } # the VALUE is the amendments form; a mention later on the line is not
kw_extract(){ # GitHub's grammar: keyword, optional colon, any whitespace, #N (case-insensitive)
  grep -oiP '\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b:?\s*#[0-9]+' <<<"$1" | sort -u | tr '\n' ' '
}
if [ "${1:-}" = --selftest ]; then
  fails=0
  # structure: this block EXITS, so nothing after it is validated by running — assert the file
  # shape directly: every function defined once, one selftest guard, one of each check marker
  # (an append-instead-of-replace edit once doubled the file; the selftest passed on the first
  # third and never saw the rest — build-triage, #151)
  for fn in join_check chk_parents chk_jobs chk_verdict is_amend kw_extract seat_of read_merge_ref; do
    n=$(grep -c "^$fn()" "$0"); [ "$n" = 1 ] || { echo "SELFTEST FAIL: $fn defined $n times"; exit 1; }
  done
  [ "$(grep -c '^if \[ "\${1:-}" = --selftest' "$0")" = 1 ] || { echo "SELFTEST FAIL: more than one selftest block"; exit 1; }
  for mk in '# 1' '# 2' '# 3' '# 4' '# 6' '# 7'; do n=$(grep -c "^$mk\$\|^$mk " "$0"); [ "$n" = 1 ] || { echo "SELFTEST FAIL: marker '$mk' appears $n times"; exit 1; }; done
  # '# 5' legitimately appears TWICE (the join's header explainer at its definition, and its
  # invocation in the body) — asserted as exactly two, not omitted, so a doubled file (four)
  # and a deleted explainer (one) both fail.
  n=$(grep -c '^# 5 ' "$0"); [ "$n" = 2 ] || { echo "SELFTEST FAIL: marker '# 5' appears $n times (expected 2: definition explainer + invocation)"; exit 1; }
  # sub-markers for the checks that have no numbered line of their own
  for mk in '# 3a' '# 3b' '# 6b' '# 6c'; do n=$(grep -c "^$mk " "$0"); [ "$n" = 1 ] || { echo "SELFTEST FAIL: marker '$mk' appears $n times"; exit 1; }; done
  # INVOCATION, not just definition: a predicate defined once and called zero times still
  # "exists" (sec-reviewer's mutant on #151: the join_check call deleted, inventory quiet).
  # Each predicate must be called from the gate body exactly once, at column 0.
  #
  # COVERAGE, stated so the gaps are chosen rather than discovered. Three
  # mechanisms guard this file, and EVERY predicate is covered by at least one:
  #
  #   invocation assertions (this list)  join_check, chk_parents, chk_jobs,
  #                                      chk_verdict, kw_extract, is_amend
  #   behavioural inventory (expect)     all eight, the six above included
  #   set -u                             any unset variable, everywhere
  #
  # seat_of and read_merge_ref are absent from this list deliberately, not by
  # oversight: seat_of is called from INSIDE other predicates rather than the
  # body, and read_merge_ref is called at column 0 but takes no argument, so the
  # "name followed by its first argument" pattern this loop matches cannot
  # express it. Both are covered behaviourally.
  #
  # Adding a predicate means adding a line here OR a case in the inventory. With
  # neither, deleting its call is silent — which is exactly the mutant this
  # block exists to catch.
  for call in 'join_check "${runid' 'chk_parents "${#parents' 'chk_jobs "$jobs"' 'chk_verdict "$c"' 'kw_extract "$body"'; do
    n=$(grep -cF -- "$call" "$0"); n=$((n-1)) # minus this loop's own literal
    [ "$n" = 1 ] || { echo "SELFTEST FAIL: predicate call '$call' appears $n times in the body (expected 1)"; exit 1; }
  done
  n=$(grep -c '^  if is_amend "\$cb"; then' "$0"); [ "$n" = 1 ] || { echo "SELFTEST FAIL: is_amend invocation appears $n times"; exit 1; }
  echo "structure: single definitions, one selftest, one of each check, every predicate invoked once"
  expect(){ # $1 must-fail|must-pass  $2 label; stdin = a check's output
    local out; out=$(cat)
    if [ "$1" = must-fail ]; then grep -q '^FAIL' <<<"$out" && echo "  ok   $2 (rejected)" || { echo "  BAD  $2: known-bad input PASSED"; fails=$((fails+1)); }
    else grep -q '^FAIL' <<<"$out" && { echo "  BAD  $2: known-good input FAILED"; fails=$((fails+1)); } || echo "  ok   $2 (accepted)"; fi
  }
  T=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; H=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; X=cccccccccccccccccccccccccccccccccccccccc
  echo "behavioural inventory (each check driven with known-bad and known-good input):"
  chk_parents 2 $T $H $T $H true  | expect must-pass "parents fresh + mergeable"
  chk_parents 2 $X $H $T $H true  | expect must-fail "parent 1 stale"
  chk_parents 2 $T $X $T $H true  | expect must-fail "parent 2 stale"
  chk_parents 1 $T "" $T $H true  | expect must-fail "one parent"
  chk_parents 2 $T $H $T $H false | expect must-fail "mergeable=false on a fresh ref"
  chk_parents 2 $X $H $T $H true  | grep -q 'stale tree' && echo "  ok   mergeable ignored on a stale ref" || { echo "  BAD  mergeable read on a stale ref"; fails=$((fails+1)); }
  chk_jobs "test:success typecheck:success docker:success" | expect must-pass "all jobs success"
  chk_jobs "test:success typecheck:cancelled docker:success" | expect must-fail "a cancelled job"
  chk_jobs "" | expect must-fail "no jobs"
  V1=$(printf '**`sec-reviewer` — verdict**\n**Verdict: GO** binds %s' $H); chk_verdict t "$V1" $H ""  | expect must-pass "seat 1 GO binding the head"
  V2=$(printf '**`sec-reviewer-2` — verdict**\nVerdict: GO — binds %s' $H); chk_verdict t "$V2" $H 2 | expect must-pass "seat 2 GO with SEAT=2"
  chk_verdict t "$V2" $H 1 | expect must-fail "seat 2 verdict when SEAT=1 required"
  V3=$(printf '**`sec-reviewer` — verdict**\nVerdict: GO — binds %s' $X); chk_verdict t "$V3" $H "" | expect must-fail "GO binding a different head"
  V4=$(printf '**`sec-reviewer` — verdict**\nVerdict: NO-GO — binds %s' $H); chk_verdict t "$V4" $H "" | expect must-fail "NO-GO"
  V5=$(printf 'Some random comment\nVerdict: GO — binds %s' $H); chk_verdict t "$V5" $H "" | expect must-fail "unattributable first line"
  V6=$(printf '**`sec-reviewer` — verdict**\nwe saw no NO-GO; the Verdict: GO line is missing; binds %s' $H); chk_verdict t "$V6" $H "" | expect must-fail "GO mentioned mid-line only"
  is_amend "Verdict: GO-WITH-AMENDMENTS — binds $H" && echo "  ok   amendments verdict detected" || { echo "  BAD  amendments verdict missed"; fails=$((fails+1)); }
  is_amend "Verdict: GO. Supersedes my GO-WITH-AMENDMENTS at $X" && { echo "  BAD  a mention of a superseded amendments verdict read as one"; fails=$((fails+1)); } || echo "  ok   mention of amendments is not a verdict"
  for kw in "Closes #12" "Closes: #12" "closes:#12" "Closes  #12" "Fixed: #7" "resolves #9"; do [ -n "$(kw_extract "$kw")" ] && echo "  ok   keyword form '$kw'" || { echo "  BAD  keyword form '$kw' missed"; fails=$((fails+1)); }; done
  [ -z "$(kw_extract "see #12 and the loop closed itself")" ] && echo "  ok   non-keyword '#12' ignored" || { echo "  BAD  non-keyword matched"; fails=$((fails+1)); }
  # join fixtures: guard on the resource the test CONSUMES (run logs), not run metadata
  for f in 34026343625 34025812806; do
    [ "$(gh run view "$f" --log 2>/dev/null | wc -l)" -gt 0 ] || { echo "SELFTEST FIXTURES UNAVAILABLE (run $f has no readable log: expired, or this token cannot read logs) — not a gate fault; re-pin two current runs or use a token with Actions read"; exit 2; }
  done
  echo "positive: run 34026343625 must PASS for (c12e6dd, 6258a5c)"
  join_check 34026343625 c12e6ddd4192b4ebe3762be37d3bb82fd2ce70dc "$(gh api repos/$R/actions/runs/34026343625 --jq .head_sha)"; r1=$?
  echo "negative: run 34025812806 (head e2b788b) must FAIL for the same pair"
  join_check 34025812806 c12e6ddd4192b4ebe3762be37d3bb82fd2ce70dc "$(gh api repos/$R/actions/runs/34026343625 --jq .head_sha)"; r2=$?
  if [ $fails = 0 ] && [ $r1 = 0 ] && [ $r2 = 1 ]; then echo "SELFTEST PASS"; exit 0; else echo "SELFTEST FAIL (inventory failures=$fails, positive rc=$r1, negative rc=$r2)"; exit 1; fi
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
chk_parents "${#parents[@]}" "$p1" "$p2" "$maintip" "$HEAD" "$mergeable"
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
# 3b REACHABILITY — what merged since this head was reviewed. Two correct PRs composed into an
# unreachable feature (#147 shipped a field only loop_alive advances; #145, merged hours later,
# made the obvious way to send it displace the primary socket). No diff, suite, or range
# question asked of either alone can see that; the only vantage is merge time, with the list
# of intervening merges in front of a human. The gate cannot judge reachability; it can stop
# the question being asked from memory.
# DELIBERATELY UNFILTERED. Do not narrow this list by file overlap: overlap is a proxy for a
# relation it does not capture ("what can DRIVE this code", not "what files does it share").
# The one instance we have happened to overlap in ws-server.ts, but the missing door was in
# client.ts, which #145 never touched: had ws-server.ts not coincidentally been shared, an
# overlap filter would have reported NOTHING AT ALL. That is the filter failing, not a near miss.
# WHERE CI STOPS. CI on the merge ref already catches "something merged broke what this PR
# CALLS" — a compile or test failure. It cannot catch "something merged removed or poisoned
# what can CALL this PR", because the absence of a driver is not a failure: nothing goes red
# when a feature is merely unreachable. (The same question also catches a NEW driver
# appearing, which is the security-relevant direction.)
# DELIBERATELY KEPT. Cost: one local `git log --oneline --first-parent` per gate — no network,
# no API call; this is not the slow part of the file. Benefit: the composed-pair defect has no
# other vantage. The empty branch below prints on purpose: a check that prints nothing when
# there is nothing to say is indistinguishable from a check that is not running.
since=$(git log --oneline --first-parent "$(git merge-base "$HEAD" "$maintip")..$maintip" 2>/dev/null)
if [ -n "$since" ]; then
  note "merged since this head's merge-base with main ($(wc -l <<<"$since") commits) — ask: does any of these change what this PR can be DRIVEN BY, or make a workaround it relies on harmful?"
  while IFS= read -r l; do echo "      $l"; done <<<"$since"
else
  note "nothing merged to main since this head's merge-base — no reachability question"
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
chk_jobs "$jobs"
# 5 the join (function defined above)
join_check "${runid:-0}" "$p1" "$p2"
# 6
for c in "${VERDICTS[@]}"; do
  cb=$(gh api "repos/$R/issues/comments/$c" --jq .body) || { bad "verdict $c unreadable"; continue; }
  s=$(seat_of "$cb")
  chk_verdict "$c" "$cb" "$HEAD" "${SEAT:-}"
  if is_amend "$cb"; then
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
kw=$(kw_extract "$body")
note "closing keywords: ${kw:-none}"
for n in $(grep -oE '#[0-9]+' <<<"$kw" | tr -d '#'); do
  gh api "repos/$R/pulls/$n" >/dev/null 2>&1 && bad "closing keyword names PR #$n" || ok "closes issue #$n"
done
[ $fail = 0 ] && echo "GATE  PASS #$N @ ${HEAD:0:7}" || echo "GATE  FAIL #$N @ ${HEAD:0:7}"
exit $fail
