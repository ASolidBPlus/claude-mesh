#!/usr/bin/env bash
# A PUSH TO A CLOSED PR'S BRANCH IS INVISIBLE TO THREE READERS AT ONCE.
#
# Measured here on 2026-09-09: a fold pushed to a branch whose PR had merged two
# minutes earlier moved the remote ref and nothing else. The PR's `headRefOid`
# stayed at the old commit, `actions/runs?head_sha=<new>` returned ZERO runs (the
# `pull_request` event only fires for an open PR), and no queue or review surface
# reported a new commit. The work survived because a person noticed. It was the
# second instance that day across two repositories.
#
# Three absent readers is not something care fixes reliably, so this refuses
# rather than reminds — BUT ONLY ONCE IT IS WIRED, and that takes one command
# per clone, because git will not let a repository commit into `.git/hooks`:
#
#   git config core.hooksPath .githooks     # once per clone — then it fires on push
#
# UNTIL YOU RUN THAT, THIS IS A REMINDER, and the first version of this header
# claimed otherwise (seat 1). A claim about enforcement gets relied on rather
# than re-derived, and a reader who took it at face value would believe a class
# of push had become impossible. `.githooks/pre-push` is the two-line hook; this
# script is what it calls, and either can be run by hand:
#
#   ./.github/scripts/pre-push.sh            # check the current branch
#   ./.github/scripts/pre-push.sh --selftest # drive the decision table
#
# THE DECISION IS A PREDICATE so the selftest can drive it with literal facts.
# Every check in this repo that the selftest could not reach turned out to have
# a defect in it (#186, #188), and a pre-push guard nobody can test is exactly
# the kind of script that quietly stops working.
set -uo pipefail
R=ASolidBPlus/claude-mesh

# THE TWO REFUSALS ARE NAMED SEPARATELY, because they want different responses:
# "the PR is closed" means open a new PR (or reopen), and "the head moved" means
# fetch and rebase. A single "refused" would leave the reader guessing which.
verdict(){ # $1 pr state (OPEN|MERGED|CLOSED|none)  $2 pr head  $3 local head  $4 ancestor? (yes|no)
  case "$1" in
    none)
      echo "OK    no PR for this branch yet — the first push is how it gets one"
      return 0 ;;
    OPEN) ;;
    *)
      echo "REFUSE PR-NOT-OPEN: the PR is $1. A push to a $1 PR's branch moves the ref and"
      echo "       nothing else: the PR's head stays put, no workflow fires, and no review or"
      echo "       queue surface reports the commit. Open a new PR for this work instead."
      return 1 ;;
  esac
  if [ "$2" = "$3" ]; then
    echo "OK    nothing to push — the PR head already equals local HEAD"
    return 0
  fi
  if [ "$4" = yes ]; then
    echo "OK    fast-forward — the PR head ${2:0:7} is an ancestor of local HEAD ${3:0:7}"
    return 0
  fi
  # FULL SHAs IN THE FAILURE CASE, short only in success (seat 1). Truncated, two
  # heads sharing a 7-char prefix read as "the PR head abc1234 is not an ancestor
  # of your HEAD abc1234" — and the remedy printed is "fetch and rebase", so a
  # reader who cannot see that they DIFFER has no way to tell a real divergence
  # from a bug in this check. The tempting response to a check you distrust is
  # --no-verify, which is the one outcome this file exists to prevent.
  #
  # In failure the difference IS the payload; in success nobody is comparing.
  echo "REFUSE HEAD-MOVED: the PR head is not an ancestor of your HEAD."
  echo "       PR head:    $2"
  echo "       your HEAD:  $3"
  echo "       Someone pushed since you fetched, OR your clone lacks that object."
  echo "       Fetch and rebase onto it; do not force."
  return 1
}

if [ "${1:-}" = --selftest ]; then
  fails=0
  expect(){ # $1 want-ok|want-refuse  $2 label  $3 output  $4 rc
    local bad=0
    [ "$1" = want-ok ] && { [ "$4" = 0 ] || bad=1; } || { [ "$1" = want-refuse ] && [ "$4" = 0 ] && bad=1; }
    if [ "$bad" = 0 ]; then echo "  ok   $2"; else echo "  BAD  $2 (rc=$4)"; fails=$((fails+1)); fi
  }
  # THE REASON IS ASSERTED, NOT JUST THE OUTCOME. A refusal that cannot say which
  # condition failed sends the reader to the wrong fix, and this file exists to
  # tell them which of two very different things happened.
  why(){ # $1 label  $2 output  $3 pattern
    if grep -q -- "$3" <<<"$2"; then echo "  ok   $1 names its reason"; else echo "  BAD  $1 does not name its reason"; fails=$((fails+1)); fi
  }
  A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  # THE AXIS THAT MATTERS FOR THE MESSAGE, which the pair above cannot express:
  # A and B differ in the FIRST character, so every truncated rendering of them
  # reads correctly. These two share a 7-character prefix, which is the case a
  # reader actually has to act on (seat 1). The fixture used to vary the axis I
  # had in mind — does it refuse, and for which reason — and not the one the
  # message depends on.
  P=abc1234000000000000000000000000000000001; Q=abc1234000000000000000000000000000000002

  o=$(verdict none "" "$A" no); expect want-ok "no PR yet — a first push is allowed" "$o" $?
  o=$(verdict OPEN "$A" "$A" yes); expect want-ok "already pushed — nothing to do" "$o" $?
  o=$(verdict OPEN "$A" "$B" yes); expect want-ok "fast-forward on an open PR" "$o" $?
  o=$(verdict MERGED "$A" "$B" yes); rc=$?; expect want-refuse "a MERGED PR refuses" "$o" $rc; why "the merged refusal" "$o" "PR-NOT-OPEN"
  o=$(verdict CLOSED "$A" "$B" yes); rc=$?; expect want-refuse "a CLOSED PR refuses" "$o" $rc; why "the closed refusal" "$o" "PR-NOT-OPEN"
  o=$(verdict OPEN "$A" "$B" no); rc=$?; expect want-refuse "a moved head refuses" "$o" $rc; why "the moved-head refusal" "$o" "HEAD-MOVED"
  # The refusal must show SHAs a reader can tell apart. Asserted on the output
  # containing both in full, because that is the property — not on the absence
  # of a substring, which a different truncation would also satisfy.
  o=$(verdict OPEN "$P" "$Q" no); rc=$?; expect want-refuse "a moved head with a shared 7-char prefix refuses" "$o" $rc
  if grep -q "$P" <<<"$o" && grep -q "$Q" <<<"$o"; then echo "  ok   the refusal prints both heads in full"
  else echo "  BAD  the refusal truncates the heads it asks a reader to compare"; fails=$((fails+1)); fi
  # ...and the SUCCESS case may truncate: nobody is comparing two SHAs there.
  o=$(verdict OPEN "$P" "$Q" yes); grep -q "${P:0:7}" <<<"$o" && echo "  ok   the success line is short" || { echo "  BAD  the success line lost its head"; fails=$((fails+1)); }
  # THE TWO REFUSALS MUST NOT SHARE A REASON STRING, or naming them separately
  # buys nothing.
  m=$(verdict MERGED "$A" "$B" yes); h=$(verdict OPEN "$A" "$B" no)
  if grep -q "HEAD-MOVED" <<<"$m" || grep -q "PR-NOT-OPEN" <<<"$h"; then
    echo "  BAD  the two refusals are not distinguishable"; fails=$((fails+1))
  else echo "  ok   the two refusals name different conditions"; fi

  [ "$fails" = 0 ] && { echo "SELFTEST PASS"; exit 0; } || { echo "SELFTEST FAIL ($fails)"; exit 1; }
fi

branch=$(git rev-parse --abbrev-ref HEAD)
local_head=$(git rev-parse HEAD)
[ "$branch" = main ] && { echo "REFUSE on main: work goes on a branch in this lane"; exit 1; }

pr=$(gh pr list -R "$R" --head "$branch" --state all --limit 1 --json number,state,headRefOid 2>/dev/null)
n=$(jq -r '.[0].number // "none"' <<<"${pr:-[]}")
state=$(jq -r '.[0].state // "none"' <<<"${pr:-[]}")
pr_head=$(jq -r '.[0].headRefOid // ""' <<<"${pr:-[]}")

anc=no
if [ -n "$pr_head" ] && git cat-file -e "$pr_head^{commit}" 2>/dev/null; then
  git merge-base --is-ancestor "$pr_head" "$local_head" && anc=yes
fi

# `${var:0:7:-none}` is not a default inside a substring — it is a syntax error,
# and bash reported it while still running the rest of the script. Found by
# RUNNING this file, not by its selftest: the selftest drives the predicate, and
# a predicate cannot have a bug in the body that calls it.
pr_head_disp=${pr_head:-none}
echo "branch $branch -> PR ${n} (${state}), PR head ${pr_head_disp:0:7}, local HEAD ${local_head:0:7}"
verdict "$state" "$pr_head" "$local_head" "$anc"
rc=$?
[ "$rc" = 0 ] && echo "      push with: git push origin $branch"
exit "$rc"
