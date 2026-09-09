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

# ── THE ANCHORS, ONE PER MEANING (#186) ─────────────────────────────────────
# The leading-marker rule was written out SIX times: four in the predicates
# (`grep -P`) and twice more inline below the guard, in jq's dialect, inside the
# `--jq` filters that scan every comment and review for a blocking NO-GO.
# Neither mechanism that checks this file can reach those two — the selftest
# drives PREDICATES and the verdict page's oracle sources FUNCTIONS, and a
# `--jq` string inside a command substitution is neither. That is the blind spot
# #183's finding named, and the merge scan is its largest occupant.
#
# LATENT, NOT LIVE, AND MEASURED SO BY SEAT 2: the two dialects agreed on all
# eight anchored and near-anchored forms they drove. What makes it worth closing
# is the DIRECTION of a future divergence — widen the class in the functions
# (#165 did once, #196 did again) and the jq copies do not follow, so a NO-GO
# written in the newly accepted form is a verdict the predicates read and the
# merge scan misses. That fails OPEN, on the check that stops merges.
#
# ONE VARIABLE PER MEANING, NOT PER SPELLING. `>` is excluded from the two
# ACCEPTANCE anchors and kept in everything that BLOCKS or REPORTS (#196:
# quoting is reproduction, and reproduction must never add approval):
#
#   GO_LINE         a GO that certifies      — the reviewer's own line
#   DISCHARGE_LINE  a discharge that counts  — the reviewer's own line
#   NOGO_LINE       a NO-GO that blocks      — quoted or not
#   ANY_GO_LINE     a GO the author WROTE    — quoted or not; the DIAGNOSTIC's
#                                              count, whose job is to describe
#                                              what was written rather than what
#                                              was accepted
#
# `is_amend`'s pattern stays inline deliberately: it has exactly one consumer,
# and a rule with one consumer has nothing to agree with. What this section
# removes is AGREEMENT, not inline regexes.
GO_LINE='^[\s*_\x60-]*\**Verdict:\**\s*GO\b'
DISCHARGE_LINE='^[\s*_\x60-]*\**Discharge:\**'
NOGO_LINE='^[\s*_\x60>-]*Verdict:\**\s*NO-GO'
ANY_GO_LINE='^[\s*_\x60>-]*\**Verdict:\**\s*GO\b'
# DERIVED, NEVER RE-AUTHORED: jq parses its program as a string literal before
# the regex engine sees it, where `\s` is an invalid escape — so every backslash
# is doubled. `(?m)` is prepended because jq uses Oniguruma with Perl syntax,
# where `^` anchors to the STRING start; jq's own `"m"` FLAG is not a substitute
# (it means dot-matches-newline). Measured both ways. `grep -P` needs no flag at
# all, because grep is line-based — two spellings of one meaning, which is the
# argument for deriving the second rather than maintaining an agreement.
NOGO_LINE_JQ="(?m)${NOGO_LINE//\\/\\\\}"
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
  # -R "$R" because `gh run view` INFERS THE REPO FROM THE CALLER'S DIRECTORY
  # otherwise. Every other call in this file goes through `gh api "repos/$R/…"`
  # and is therefore location-independent; these two were not, so run from
  # anywhere but a checkout of this repo the gate reported its fixtures as
  # unreadable — an environment fault that is really an argument fault.
  log=$(gh run view "$run" -R "$R" --log 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')
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
  # A CONJUNCTION OF MEMBERSHIP CHECKS IS NOT A RELATION.
  #
  # This read `grep -q "$3"` AND `grep -qP '…Verdict:…GO'` as separate tests:
  # the head appeared SOMEWHERE, a GO line existed SOMEWHERE, and nothing tied
  # them together. The comment above calls this the binding between a human's
  # judgement and a tree — that is a relation, this head on this GO line — and
  # three independent memberships cannot express it.
  #
  # MEASURED ON REAL DATA (sec-reviewer-2): a comment whose only verdict line
  # binds one sha, asked about a DIFFERENT sha that appears only in its prose,
  # answered PASS. No attacker is needed — naming the head you supersede is
  # good re-bind practice, and that is exactly what plants the superseded sha
  # in the body. It only has to come back: a revert, a force-push, a reused
  # branch.
  #
  # So: ONE grep, and the head must be ON the verdict line.
  #
  # NO `(?!-)` HERE, deliberately, and THE PORTED GATES DIFFER FROM THIS FILE ON
  # PURPOSE — do not tidy the two into consistency without reading this.
  #
  # Excluding the amendments form from this test makes a GO-WITH-AMENDMENTS
  # verdict FAIL here, and the caller ANDs that failure with everything else, so
  # a properly discharged amendments verdict could never merge. Measured by
  # replaying the caller's own three lines: fail=1 with a valid discharge.
  #
  # THE PREDICATE AND THE MACHINERY ARE ALTERNATIVE WAYS OF SEPARATING THE SAME
  # TWO FORMS: `is_amend` + `discharge_ok` do it here, downstream of this line.
  # A gate that lacks them — mesh-agent's port does — needs `(?!-)` instead, or
  # an UNDISCHARGED amendments verdict certifies as a plain GO. So `(?!-)` is
  # load-bearing exactly where `is_amend` is absent and harmful exactly where it
  # is present (build-triage measured both files). You may have either; you must
  # not have neither.
  # QUOTING IS REPRODUCTION, AND REPRODUCTION MUST NOT ADD APPROVAL. The leading
  # class used to include `>` on BOTH halves, so an addendum quoting an earlier
  # verdict for context — which the page tells reviewers to do — CERTIFIED it
  # again at the quoted head (seat 1, found by searching the shape not the
  # instance; reproduced here). The asymmetry is the point and it is the
  # fail-safe direction:
  #
  #   a quoted GO        must NOT certify     — `>` excluded below
  #   a quoted DISCHARGE must NOT discharge   — `>` excluded in discharge_ok
  #   a quoted NO-GO     must STILL block     — `>` kept in the scan
  #   a quoted GwA       must STILL downgrade — `>` kept in `is_amend`
  #
  # ALL FOUR HAVE A FIXTURE. The list used to name three and pin two: strip `>`
  # from `is_amend` and the selftest stayed green, so the enumeration was failing
  # on its own terms (seat 1). An enumeration in a comment is a promise about
  # what is checked.
  #
  # `-`, `*`, `_` and backticks stay in the acceptance class: those are
  # formatting a reviewer applies to their OWN line. `>` is the one marker whose
  # meaning is "these are someone else's words".
  if grep -qP "$GO_LINE[^\n]*\Q$3\E" <<<"$2" && ! grep -qP "$NOGO_LINE" <<<"$2"; then
    ok "verdict $1 binds $3 GO"
  else
    # THE DIAGNOSTIC SHIPS WITH THE FIX. The old line printed three decoupled
    # counts, so a CORRECT refusal now reads `head=1 GO=1 NOGO=0` — which looks
    # like the gate malfunctioning rather than like a bind being refused, and a
    # gate whose correct refusal reads as a bug gets overridden.
    local nlines nhead nnogo
    # THIS COUNT KEEPS `>`, DELIBERATELY, and it is the one place in the file
    # where that is right: the diagnostic's job is to describe WHAT THE AUTHOR
    # WROTE, not what the gate accepts. "1 GO line(s)" beside a refusal is the
    # information a reader needs — they wrote a GO and it was quoted — where "0"
    # would read as "your comment has no verdict at all" and send them looking
    # for the wrong mistake. Seat 1 flagged this site as uncaught by the
    # over-application mutant; it is uncaught because it is not the rule, and
    # the fixture below pins the count so the distinction is a decision.
    nlines=$(grep -cP "$ANY_GO_LINE" <<<"$2")
    nhead=$(grep -c "$3" <<<"$2")
    nnogo=$(grep -cP "$NOGO_LINE" <<<"$2")
    # WHICH CONDITION FAILED, not a list of counts the reader has to interpret.
    # The conjunction has two halves and they fail for opposite reasons, so one
    # message for both named the wrong cause whenever a NO-GO was present: the
    # GO line DID bind, and the NO-GO is what refused. My own message, one
    # commit old — the same "state the mechanism" rule it was written to serve.
    if [ "$nnogo" -gt 0 ]; then
      bad "verdict $1: a NO-GO line is present ($nnogo), so this comment refuses regardless of its GO line. Quoting an earlier NO-GO counts — refer to it by PR, comment id and sha instead."
    else
      bad "verdict $1: NO VERDICT LINE BINDS $3 — $nlines GO line(s), the head appears $nhead time(s) anywhere in the body. A sha in prose does not bind, and a QUOTED GO line does not certify; it must be your own Verdict line, with the sha on it."
    fi
  fi
}
is_amend(){ grep -qiP '^[\s*_\x60>-]*Verdict:\**\s*GO[- ]WITH[- ]AMENDMENT' <<<"$1"; } # the VALUE is the amendments form; a mention later on the line is not

# THE DISCHARGE RULE, and it lives up here for a reason (#182). It was INLINE in
# the body below the selftest guard, which put it outside the two things that
# check this file: the selftest's behavioural inventory, and the verdict page's
# oracle — which sources the FUNCTIONS above the guard and so could only hold a
# hand-written reconstruction of it. Seat 1's mutant proved the cost: `&&` → `||`
# in the old inline conjunction, 16 pass / 0 fail.
#
# An oracle that sources functions has exactly one blind spot — inline logic —
# and it is invisible from inside the oracle's own design.
#
# THREE CONDITIONS, all required: the discharge comes from the SAME seat that
# gave the amendments verdict, it names the head, and it does not itself carry
# an anchored NO-GO on the `Discharge:` grammar's own terms — so a discharge that
# reproduces the verdict it discharges is refused.
#
# THAT IS TEETH FOR ONE HALF OF THE WRITER RULE, not for the rule. This comment
# used to claim the writer rule ("never reproduce a verdict line") had teeth
# here rather than being a rule to remember — true of a reproduced NO-GO, and
# false in the direction that matters: a reproduced GO had no teeth at all and
# CERTIFIED, until `chk_verdict` stopped accepting a quoted line. A sentence
# that is true of the half it describes and false as a general claim is exactly
# the shape that survives review (build-triage, on my own diff).
discharge_ok(){ # $1 discharge body  $2 the amending seat  $3 head sha
  # THE SAME RELATION AS `chk_verdict`, one function down (#195, build-triage).
  # This carried the byte-identical `grep -q "$3"` membership test while the
  # verdict half was being repaired for exactly that — the head only had to
  # appear SOMEWHERE in the discharge body. Measured: a discharge whose own line
  # binds one head, naming another in prose, was accepted for the head in prose.
  #
  # A DISCHARGE THEREFORE NEEDS AN ANCHORED LINE, because unlike a verdict it
  # had no line that was the claim. `Discharge:` mirrors `Verdict:`: the sha
  # must sit on it, and prose naming an earlier head binds nothing. That is a
  # change to what a reviewer WRITES, and it is documented on the page rather
  # than left to be discovered by a refusal.
  #
  # AND `>` IS EXCLUDED HERE TOO (seat 1 on #196). A DISCHARGE IS APPROVAL —
  # approval of a deferral — so the rule one function up applies unchanged:
  # quoting is reproduction, and reproduction must never ADD approval. The
  # `Discharge:` grammar arrived one commit BEFORE that rule and inherited the
  # symmetric class, so a quoted `> Discharge: … binds <head>` was accepted
  # while a quoted GO was already refused. Found by the over-application mutant
  # this PR introduced, applied to every `>` in a leading class — six sites, two
  # of them unpinned, and this was one.
  local ds; ds=$(seat_of "$1")
  [ "$ds" = "$2" ] \
    && grep -qP "$DISCHARGE_LINE[^\n]*\Q$3\E" <<<"$1" \
    && ! grep -qP "$NOGO_LINE" <<<"$1"
}
# #188 - ZERO VERDICTS IS NOT A PASS. `gate.sh <pr> <sha>` with no verdict ids
# ran to completion silently: the `for c in "${VERDICTS[@]}"` loop simply had
# nothing to iterate, so with CI green the output was indistinguishable from
# every verdict having passed. Measured on a live PR before the fix - GATE PASS
# with no verdict supplied.
#
# A PREDICATE rather than an inline test, because this file's rule is that every
# outcome check lives above the guard where --selftest can drive it.
chk_arity(){ # $1 how many verdict ids were supplied
  [ "$1" -ge 1 ] && ok "verdicts supplied: $1" || bad "no verdict supplied - with CI green, zero verdicts reads exactly like every verdict passing"
}
kw_extract(){ # GitHub's grammar: keyword, optional colon, any whitespace, #N (case-insensitive)
  grep -oiP '\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b:?\s*#[0-9]+' <<<"$1" | sort -u | tr '\n' ' '
}
if [ "${1:-}" = --selftest ]; then
  fails=0
  # structure: this block EXITS, so nothing after it is validated by running — assert the file
  # shape directly: every function defined once, one selftest guard, one of each check marker
  # (an append-instead-of-replace edit once doubled the file; the selftest passed on the first
  # third and never saw the rest — build-triage, #151)
  for fn in join_check chk_parents chk_jobs chk_verdict chk_arity is_amend discharge_ok kw_extract seat_of read_merge_ref; do
    n=$(grep -c "^$fn()" "$0"); [ "$n" = 1 ] || { echo "SELFTEST FAIL: $fn defined $n times"; exit 1; }
  done
  [ "$(grep -c '^if \[ "\${1:-}" = --selftest' "$0")" = 1 ] || { echo "SELFTEST FAIL: more than one selftest block"; exit 1; }
  # EVERY `gh run view` CARRIES -R. Without it the command infers the repo from
  # the caller's directory, so the gate's answer would depend on where it was
  # invoked — and the failure surfaced as "FIXTURES UNAVAILABLE", which reads as
  # an expired log or a token problem rather than a missing argument. The
  # pattern is written `vie[w]` so this line does not match itself.
  # COMMENTS ARE EXCLUDED, and that is the honest rule rather than a trick: the
  # property is that no CODE line reads a run log without -R. Spelling the
  # literal around (`vie[w]`) keeps the PATTERN from matching itself; excluding
  # `^N:\s*#` keeps the prose about the rule — including the paragraph above —
  # from being read as a violation of it. Both are needed: I had each in turn,
  # and each alone reported this block.
  offenders=$(grep -n 'gh run vie[w]' "$0" | grep -vE '^[0-9]+:[[:space:]]*#' | grep -v -- '-R "$R"')
  if [ -n "$offenders" ]; then
    echo "SELFTEST FAIL: a run-log read without -R \"\$R\" — its answer would depend on the caller's directory"
    echo "$offenders"
    exit 1
  fi
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
  #                                      chk_verdict, chk_arity, kw_extract;
  #                                      is_amend and
  #                                      discharge_ok by their own greps below,
  #                                      whose call shapes this loop's
  #                                      "name + first argument" pattern cannot
  #                                      express
  #   behavioural inventory (expect)     all ten, the ones above included
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
  for call in 'join_check "${runid' 'chk_parents "${#parents' 'chk_jobs "$jobs"' 'chk_verdict "$c"' 'chk_arity "${#VERDICTS' 'kw_extract "$body"'; do
    n=$(grep -cF -- "$call" "$0"); n=$((n-1)) # minus this loop's own literal
    [ "$n" = 1 ] || { echo "SELFTEST FAIL: predicate call '$call' appears $n times in the body (expected 1)"; exit 1; }
  done
  n=$(grep -c '^  if is_amend "\$cb"; then' "$0"); [ "$n" = 1 ] || { echo "SELFTEST FAIL: is_amend invocation appears $n times"; exit 1; }
  n=$(grep -c '^      discharge_ok "\$db" "\$s" "\$HEAD"' "$0"); [ "$n" = 1 ] || { echo "SELFTEST FAIL: discharge_ok invocation appears $n times"; exit 1; }
  echo "structure: single definitions, one selftest, one of each check, every predicate invoked once"
  expect(){ # $1 must-fail|must-pass  $2 label  $3 the check's OUTPUT
    # #188 - THE OUTPUT ARRIVES AS AN ARGUMENT, never on stdin. Piping a check
    # into this function ran it in a SUBSHELL, so `fails=$((fails+1))`
    # incremented a copy that was then discarded: a mutant printed `BAD ...`
    # and the selftest still exited 0 and reported SELFTEST PASS. Measured on
    # this file before the fix - chk_jobs stubbed to always pass printed two
    # BAD lines and exited 0.
    #
    # The mechanism whose whole purpose is catching checks that pass while
    # proving nothing was itself passing while proving nothing, and neither
    # reading it nor running it showed that: stdout said BAD, exit status said
    # 0. Only re-implementing it did.
    local out=$3
    if [ "$1" = must-fail ]; then grep -q '^FAIL' <<<"$out" && echo "  ok   $2 (rejected)" || { echo "  BAD  $2: known-bad input PASSED"; fails=$((fails+1)); }
    else grep -q '^FAIL' <<<"$out" && { echo "  BAD  $2: known-good input FAILED"; fails=$((fails+1)); } || echo "  ok   $2 (accepted)"; fi
  }
  # THE DIAGNOSTIC IS A CONTROL, NOT COSMETICS, so it gets a fixture too
  # (build-triage on the port's #27, pre-empted here because #195 rewrites the
  # very message in question). `expect` above reads only whether the output
  # starts with FAIL — so all four refusal texts could be replaced by the old
  # decoupled counts, or by "everything looks fine, ignore this", and this
  # selftest would still PASS. Measured on the port; the same hole is here.
  #
  # It matters because of the argument this fix rests on: a gate whose correct
  # refusal reads like a malfunction gets overridden by whoever is trying to
  # land something. A refusal that cannot say WHY is a refusal that will be
  # ignored, and an untested message rots faster than code.
  expect_why(){ # $1 label  $2 the check's OUTPUT  $3 pattern the reason must match
    if grep -qP -- "$3" <<<"$2"; then echo "  ok   $1 (reason named)"
    else echo "  BAD  $1: refusal does not name its reason"; fails=$((fails+1)); fi
  }
  T=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; H=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; X=cccccccccccccccccccccccccccccccccccccccc
  # ── #186: THE ANCHOR'S CONTENT, IN BOTH ENGINES, PER FORM ────────────────
  # Two assertions live here and they answer different questions:
  #
  #   CONTENT   does the anchor accept the right forms? Deriving one encoding
  #             from another fixes DIVERGENCE and does nothing about the anchor
  #             being wrong — and a single source is exactly what persuades a
  #             reader the audit is unnecessary (build-triage).
  #   BOTH PATHS  one shell value read by `grep -P` AND by jq is not one anchor;
  #             it is one string interpreted by two engines. Quoting, escaping,
  #             `\b`, POSIX classes and greediness are applied by the READER,
  #             not carried by the string. So each engine is asserted against
  #             the EXPECTATION separately: a mutant that reddens the shell path
  #             and is never run through jq would report the collapse complete
  #             while the jq encoding stayed free to diverge on the ninth form.
  #             Sharing a source makes two paths testable together, not tested
  #             together.
  #
  # Seat 2's eight forms, plus a GO (must not match) and a marker the class does
  # not admit (the widen-mutant's target).
  nogo_cases=(
    'Verdict: NO-GO — plain|yes'
    '> Verdict: NO-GO — blockquoted|yes'
    '**Verdict: NO-GO** — bolded|yes'
    '  Verdict: NO-GO — leading space|yes'
    '- Verdict: NO-GO — bulleted|yes'
    '_Verdict: NO-GO_ — underscored|yes'
    'Verdict:NO-GO — no space|yes'
    'the earlier Verdict: NO-GO is discharged — inline mention|no'
    'Verdict: GO — binds nothing here|no'
    '~ Verdict: NO-GO — a marker the class does not admit|no'
  )
  anchor_ok=1
  for case in "${nogo_cases[@]}"; do
    form=${case%|*}; want=${case##*|}
    g=no; j=no
    grep -qP "$NOGO_LINE" <<<"$form" && g=yes
    [ "$(jq -rn --arg b "$form" "(\$b|test(\"$NOGO_LINE_JQ\"))")" = true ] && j=yes
    [ "$g" = "$want" ] || { echo "  BAD  grep -P: $form -> $g, expected $want"; anchor_ok=0; fails=$((fails+1)); }
    [ "$j" = "$want" ] || { echo "  BAD  jq:      $form -> $j, expected $want"; anchor_ok=0; fails=$((fails+1)); }
  done
  [ "$anchor_ok" = 1 ] && echo "  ok   the NO-GO anchor answers ${#nogo_cases[@]} forms correctly, in BOTH engines"
  # The set is not vacuous by construction — it contains both answers — and the
  # loop above would report a `yes`-only or `no`-only table as failures rather
  # than agreeing with it.

  # THE COLLAPSE IS A CLAIM WITH A ONE-LINE PROOF (build-triage): each anchor's
  # literal text appears exactly once. The needles are ASSEMBLED at runtime so
  # these lines do not contain the literals they count — the same self-reference
  # trap as the run-log check above, met for the third time in this file.
  # The property is "anchor text appears ONLY where an anchor is DEFINED", not
  # "exactly once": the GO literal is written twice ON PURPOSE — `GO_LINE` (what
  # certifies) and `ANY_GO_LINE` (what the author wrote) are two MEANINGS, and
  # collapsing them to one string was the trap that would have silently changed
  # the diagnostic's count. Two definitions are a decision; a use outside one is
  # the re-typed copy this check exists to forbid.
  for needle in "Verdict:"'\**\s*'"NO-GO" "Verdict:"'\**\s*'"GO\b" "Discharge:"'\**'; do
    loose=$(grep -nF -- "$needle" "$0" | grep -vE '^[0-9]+:[A-Z_]+=' | grep -vE '^[0-9]+:[[:space:]]*#' || true)
    [ -z "$loose" ] || { echo "SELFTEST FAIL: the anchor '$needle' is written outside its definition:"; echo "$loose"; exit 1; }
  done
  # ...and no jq-DIALECT copy survives either. Its absence is why the first
  # version of this check passed a mutant that re-typed the anchor inside the
  # `--jq` filter: that copy carries DOUBLED backslashes, so the grep-dialect
  # needle does not find it. A checker that knows one spelling of a rule cannot
  # see the other spelling of the same rule — #186's own subject, reproduced
  # inside #186's fix.
  for needle in "Verdict:"'\\**\\s*'"NO-GO" "Verdict:"'\\**\\s*'"GO"; do
    n=$(grep -cF -- "$needle" "$0")
    [ "$n" = 0 ] || { echo "SELFTEST FAIL: a jq-dialect copy of the anchor ('$needle') is written $n time(s) — it must be DERIVED from the one definition, never re-typed"; exit 1; }
  done

  echo "behavioural inventory (each check driven with known-bad and known-good input):"
  expect must-pass "parents fresh + mergeable" "$(chk_parents 2 $T $H $T $H true)"
  expect must-fail "parent 1 stale" "$(chk_parents 2 $X $H $T $H true)"
  expect must-fail "parent 2 stale" "$(chk_parents 2 $T $X $T $H true)"
  expect must-fail "one parent" "$(chk_parents 1 $T "" $T $H true)"
  expect must-fail "mergeable=false on a fresh ref" "$(chk_parents 2 $T $H $T $H false)"
  chk_parents 2 $X $H $T $H true  | grep -q 'stale tree' && echo "  ok   mergeable ignored on a stale ref" || { echo "  BAD  mergeable read on a stale ref"; fails=$((fails+1)); }
  expect must-pass "all jobs success" "$(chk_jobs "test:success typecheck:success docker:success")"
  expect must-fail "a cancelled job" "$(chk_jobs "test:success typecheck:cancelled docker:success")"
  expect must-fail "no jobs" "$(chk_jobs "")"
  expect must-pass "one verdict supplied" "$(chk_arity 1)"
  expect must-fail "no verdict supplied" "$(chk_arity 0)"
  V1=$(printf '**`sec-reviewer` — verdict**\n**Verdict: GO** binds %s' $H); expect must-pass "seat 1 GO binding the head" "$(chk_verdict t "$V1" $H "")"
  V2=$(printf '**`sec-reviewer-2` — verdict**\nVerdict: GO — binds %s' $H); expect must-pass "seat 2 GO with SEAT=2" "$(chk_verdict t "$V2" $H 2)"
  expect must-fail "seat 2 verdict when SEAT=1 required" "$(chk_verdict t "$V2" $H 1)"
  V3=$(printf '**`sec-reviewer` — verdict**\nVerdict: GO — binds %s' $X); expect must-fail "GO binding a different head" "$(chk_verdict t "$V3" $H "")"
  V4=$(printf '**`sec-reviewer` — verdict**\nVerdict: NO-GO — binds %s' $H); expect must-fail "NO-GO" "$(chk_verdict t "$V4" $H "")"
  V5=$(printf 'Some random comment\nVerdict: GO — binds %s' $H); expect must-fail "unattributable first line" "$(chk_verdict t "$V5" $H "")"
  V6=$(printf '**`sec-reviewer` — verdict**\nwe saw no NO-GO; the Verdict: GO line is missing; binds %s' $H); expect must-fail "GO mentioned mid-line only" "$(chk_verdict t "$V6" $H "")"
  # #188 - THE HEADLINE PROPERTY, and nothing exercised it: every fixture above
  # supplies a FULL 40-hex sha, so `grep -q "$3"` mutated to `grep -q
  # "${3:0:7}"` - a SEVEN-CHARACTER bind, which any comment quoting a short sha
  # would satisfy - produced ZERO `BAD` lines. Measured on this file. A rule is
  # only tested by an input that distinguishes it from its weaker form.
  V7=$(printf '**`sec-reviewer` - verdict**\nVerdict: GO - binds %s' "${H:0:7}"); expect must-fail "GO binding a SHORT sha" "$(chk_verdict t "$V7" $H "")"
  # THE RELATION, which no case above could see: the head appears in the body
  # and a GO line exists, but they are on DIFFERENT lines. This is the shape
  # that measured PASS on real data, and it is produced by GOOD practice —
  # naming the head you supersede is exactly what puts a stale sha in the prose.
  V8=$(printf '**`sec-reviewer` - verdict**\nSupersedes my earlier verdict at %s.\nVerdict: GO - binds %s' $H $X); expect must-fail "head in PROSE, GO line binds another" "$(chk_verdict t "$V8" $H "")"
  # ...and the same shape the other way round, so the case above is not passing
  # because of the word "Supersedes".
  V9=$(printf '**`sec-reviewer` - verdict**\n%s was the previous head.\nVerdict: GO - binds %s' $H $X); expect must-fail "head named in an ordinary sentence, GO line binds another" "$(chk_verdict t "$V9" $H "")"
  # The house variants that MUST still bind, so the relation is not tightened
  # into a form nobody writes.
  V10=$(printf '**`sec-reviewer` - verdict**\nVerdict: GO - bound to %s' $H); expect must-pass "the 'bound to' phrasing" "$(chk_verdict t "$V10" $H "")"
  # AND THE AMENDMENTS FORM, which must still pass THIS predicate. Excluding it
  # here (the `(?!-)` in the patch as proposed) makes a properly discharged
  # GO-WITH-AMENDMENTS verdict unmergeable: the caller ANDs this failure with
  # the discharge's success. `is_amend` and `discharge_ok` separate the two
  # forms downstream; this test is what keeps that division from being undone
  # by a one-token edit here.
  V11=$(printf '**`sec-reviewer` - verdict**\nVerdict: GO-WITH-AMENDMENTS - binds %s' $H); expect must-pass "an amendments verdict binding the head" "$(chk_verdict t "$V11" $H "")"
  V12=$(printf '**`sec-reviewer` - verdict**\nVerdict: GO-WITH-AMENDMENTS - binds %s' $X); expect must-fail "an amendments verdict binding ANOTHER head" "$(chk_verdict t "$V12" $H "")"
  # QUOTED LINES, both directions, because the asymmetry IS the rule and a
  # symmetric leading class is what made a reproduced GO certify.
  V13=$(printf '**`sec-reviewer` - addendum**\nFor context, my earlier verdict said:\n> Verdict: GO - binds %s' $H); expect must-fail "a QUOTED GO line does not certify" "$(chk_verdict t "$V13" $H "")"
  V14=$(printf '**`sec-reviewer` - verdict**\n>> Verdict: GO - binds %s' $H); expect must-fail "a DOUBLY quoted GO line does not certify" "$(chk_verdict t "$V14" $H "")"
  V15=$(printf '**`sec-reviewer` - verdict**\n- Verdict: GO - binds %s' $H); expect must-pass "a BULLETED GO line is the reviewer's own line" "$(chk_verdict t "$V15" $H "")"
  V16=$(printf '**`sec-reviewer` - verdict**\n> Verdict: NO-GO - an earlier round\nVerdict: GO - binds %s' $H); expect must-fail "a quoted NO-GO still blocks" "$(chk_verdict t "$V16" $H "")"
  # A QUOTED AMENDMENTS LINE MUST STILL DOWNGRADE — the third property the
  # comment above promised and nothing pinned. Stripping `>` from `is_amend`
  # left the selftest green.
  is_amend "> Verdict: GO-WITH-AMENDMENTS — an earlier round" && echo "  ok   a QUOTED amendments verdict still downgrades" || { echo "  BAD  a quoted amendments verdict stopped being read"; fails=$((fails+1)); }
  # #188 - THE FIXTURES ABOVE ARE INVENTED FORMS. These two are the first lines
  # the seats ACTUALLY post, copied from live verdict comments, and they differ:
  # seat 1 wraps its id in backticks inside bold and continues the sentence,
  # seat 2 posts BARE - no bold, no backticks. `seat_of` is therefore a
  # TWO-CONSUMER parser, and the invented fixtures cannot see that: tightened to
  # require a backtick it would keep every case above green while every seat 2
  # verdict silently became unattributable, which reads as a fix and is a
  # regression neither seat can see from its own side.
  R1=$(printf '**`sec-reviewer` - security review verdict.** Posted by the fleet'"'"'s security reviewer; we share a GitHub account\nVerdict: GO - binds %s' $H)
  R2=$(printf 'sec-reviewer-2 - security review verdict\nVerdict: GO - binds %s' $H)
  expect must-pass "seat 1 REAL posted first line" "$(chk_verdict t "$R1" $H 1)"
  expect must-pass "seat 2 REAL posted first line" "$(chk_verdict t "$R2" $H 2)"
  is_amend "Verdict: GO-WITH-AMENDMENTS — binds $H" && echo "  ok   amendments verdict detected" || { echo "  BAD  amendments verdict missed"; fails=$((fails+1)); }
  is_amend "Verdict: GO. Supersedes my GO-WITH-AMENDMENTS at $X" && { echo "  BAD  a mention of a superseded amendments verdict read as one"; fails=$((fails+1)); } || echo "  ok   mention of amendments is not a verdict"
  # discharge_ok: one known-good and one per condition, because three conditions
  # that a test has only seen satisfied together are ONE condition to that test.
  D_OK=$(printf '**`sec-reviewer` — discharge**\nDischarge: deferred; binds %s' $H)
  D_SEAT=$(printf '**`sec-reviewer-2` — discharge**\nDischarge: deferred; binds %s' $H)
  D_SHA=$(printf '**`sec-reviewer` — discharge**\nDischarge: deferred; binds %s' $X)
  D_NOGO=$(printf '**`sec-reviewer` — discharge**\n> Verdict: NO-GO — the earlier round\nDischarge: deferred; binds %s' $H)
  # THE SIBLING OF #195's PARENT CASE: the Discharge line binds one head and the
  # prose names another. This is the shape that measured ACCEPTED before the
  # anchor, and it is written by the same good practice — naming what you
  # supersede.
  D_PROSE=$(printf '**`sec-reviewer` — discharge**\nThis supersedes my discharge at %s.\nDischarge: deferred; binds %s' $H $X)
  # ...and a discharge with no anchored line at all, which is what every
  # free-form discharge looked like before this rule.
  D_UNANCHORED=$(printf '**`sec-reviewer` — discharge**\ndeferred; binds %s' $H)
  discharge_ok "$D_OK"   1 $H && echo "  ok   discharge accepted (seat, sha, no NO-GO)" || { echo "  BAD  a valid discharge was refused"; fails=$((fails+1)); }
  discharge_ok "$D_SEAT" 1 $H && { echo "  BAD  a discharge by another seat was accepted"; fails=$((fails+1)); } || echo "  ok   discharge by another seat refused"
  discharge_ok "$D_SHA"  1 $H && { echo "  BAD  a discharge naming another head was accepted"; fails=$((fails+1)); } || echo "  ok   discharge not binding the head refused"
  # The same short-sha gap one predicate over: `discharge_ok` binds with the
  # same `grep -q "$3"`, so it needs the same distinguishing input (#188).
  D_SHORT=$(printf '**`sec-reviewer` - discharge**\nDischarge: deferred; binds %s' "${H:0:7}")
  discharge_ok "$D_SHORT" 1 $H && { echo "  BAD  a discharge binding a SHORT sha was accepted"; fails=$((fails+1)); } || echo "  ok   discharge binding a short sha refused"
  discharge_ok "$D_NOGO" 1 $H && { echo "  BAD  a discharge reproducing a NO-GO was accepted"; fails=$((fails+1)); } || echo "  ok   discharge reproducing a NO-GO refused"
  discharge_ok "$D_PROSE" 1 $H && { echo "  BAD  a discharge naming the head only in PROSE was accepted"; fails=$((fails+1)); } || echo "  ok   discharge naming the head only in prose refused"
  discharge_ok "$D_UNANCHORED" 1 $H && { echo "  BAD  a discharge with no anchored Discharge: line was accepted"; fails=$((fails+1)); } || echo "  ok   discharge with no anchored line refused"
  # A QUOTED DISCHARGE IS A REPRODUCED ONE (seat 1 on #196): it must not
  # discharge, for the same reason a quoted GO must not certify.
  D_QUOTED=$(printf '**`sec-reviewer` — discharge**\n> Discharge: deferred; binds %s' $H)
  discharge_ok "$D_QUOTED" 1 $H && { echo "  BAD  a QUOTED discharge was accepted"; fails=$((fails+1)); } || echo "  ok   a quoted discharge refused"
  # ── the refusals must DIAGNOSE, not merely refuse ────────────────────────
  # One per message a reader acts on. Each names a distinct branch, so a broken
  # message localises to the branch that rotted instead of failing the file.
  expect_why "verdict bind refusal names the relation" \
    "$(chk_verdict t "$V8" $H "")" 'NO VERDICT LINE BINDS.*must be your own Verdict line, with the sha on it'
  expect_why "verdict bind refusal reports the evidence it weighed" \
    "$(chk_verdict t "$V8" $H "")" 'GO line\(s\).*appears \d+ time\(s\)'
  expect_why "a quoted GO is named as such in the refusal" \
    "$(chk_verdict t "$V13" $H "")" 'QUOTED GO line does not certify'
  # ...and the count beside it SEES the quoted line, so the reader is told they
  # wrote a GO rather than that they wrote nothing.
  expect_why "the refusal counts the quoted GO line the author wrote" \
    "$(chk_verdict t "$V13" $H "")" '1 GO line\(s\)'
  # THE OTHER HALF OF THE CONJUNCTION, which one message used to answer with the
  # wrong cause: here the GO line DOES bind and the NO-GO is what refuses.
  expect_why "a present NO-GO is named as the cause, not the bind" \
    "$(chk_verdict t "$V16" $H "")" 'NO-GO line is present.*refuses regardless of its GO line'
  expect_why "seat refusal names the seat mismatch" \
    "$(chk_verdict t "$V2" $H 1)" 'from seat 2, SEAT=1 required'
  expect_why "arity refusal says why zero is not a pass" \
    "$(chk_arity 0)" 'zero verdicts reads exactly like every verdict passing'
  expect_why "stale-ref refusal says the flag describes a stale tree" \
    "$(chk_parents 2 $X $H $T $H true)" 'describes a stale tree.*not evidence either way'

  for kw in "Closes #12" "Closes: #12" "closes:#12" "Closes  #12" "Fixed: #7" "resolves #9"; do [ -n "$(kw_extract "$kw")" ] && echo "  ok   keyword form '$kw'" || { echo "  BAD  keyword form '$kw' missed"; fails=$((fails+1)); }; done
  [ -z "$(kw_extract "see #12 and the loop closed itself")" ] && echo "  ok   non-keyword '#12' ignored" || { echo "  BAD  non-keyword matched"; fails=$((fails+1)); }
  # join fixtures: guard on the resource the test CONSUMES (run logs), not run metadata
  for f in 34026343625 34025812806; do
    [ "$(gh run view "$f" -R "$R" --log 2>/dev/null | wc -l)" -gt 0 ] || { echo "SELFTEST FIXTURES UNAVAILABLE (run $f has no readable log: expired, or this token cannot read logs) — not a gate fault; re-pin two current runs or use a token with Actions read"; exit 2; }
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
[ "$ref" = "$HEAD" ] && ok "branch ref $branch = $HEAD" || bad "branch ref $ref != expected $HEAD"
[ "$headsha" = "$HEAD" ] && ok "PR head = $HEAD" || bad "PR head is $headsha, expected $HEAD"
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
chk_arity "${#VERDICTS[@]}"
for c in "${VERDICTS[@]}"; do
  cb=$(gh api "repos/$R/issues/comments/$c" --jq .body) || { bad "verdict $c unreadable"; continue; }
  s=$(seat_of "$cb")
  chk_verdict "$c" "$cb" "$HEAD" "${SEAT:-}"
  if is_amend "$cb"; then
    if [ -n "${DISCHARGED:-}" ]; then
      db=$(gh api "repos/$R/issues/comments/$DISCHARGED" --jq .body 2>/dev/null) || db=""
      ds=$(seat_of "$db")
      discharge_ok "$db" "$s" "$HEAD" \
        && ok "verdict $c GO-WITH-AMENDMENTS discharged by $DISCHARGED (seat $ds, binds $HEAD)" \
        || bad "verdict $c GO-WITH-AMENDMENTS: discharge $DISCHARGED not by seat $s (seat $ds), does not bind $HEAD, or reproduces a NO-GO"
    else bad "verdict $c is GO-WITH-AMENDMENTS at this head and no DISCHARGED comment cited"; fi
  fi
done
# THE MERGE SCAN READS THE DERIVED FILTER (#186). It used to carry a
# hand-written copy of the NO-GO anchor in jq's dialect — the largest occupant
# of the blind spot, since neither the selftest nor the page's oracle can reach
# a `--jq` string. Widening `$NOGO_LINE` above now widens these too, and the
# selftest drives both dialects over one fixture set as the control on that.
nogo=$(gh api "repos/$R/issues/$N/comments" --paginate --jq "[.[]|select(.body|test(\"$NOGO_LINE_JQ\"))|.id]|join(\",\")")
nogor=$(gh api "repos/$R/pulls/$N/reviews" --paginate --jq "[.[]|select((.body//\"\")|test(\"$NOGO_LINE_JQ\"))|.id]|join(\",\")")
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
# #188 — THE BIND IS PRINTED IN FULL, here and at every line that names the
# head this run is bound to (branch ref, PR head, verdict, discharge). A short
# sha is what the gate REFUSES in a verdict; printing one in the gate's own
# conclusion asks a reader to accept a weaker form of the field under dispute.
# The parent/join lines stay short: those compare two shas the gate derived
# itself and are diagnostics, not the bind.
[ $fail = 0 ] && echo "GATE  PASS #$N @ $HEAD" || echo "GATE  FAIL #$N @ $HEAD"
exit $fail
