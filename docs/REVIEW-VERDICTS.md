# Review verdicts — the form the merge gate reads

The merge gate (`.github/scripts/gate.sh`) decides whether a pull request may merge by
reading **comments on the PR**. The strings below are an interface: the gate parses them,
so a verdict written in another form is not seen, and the PR does not merge. This page
documents the form where writers write it; the gate's predicates (`seat_of`, `chk_verdict`,
`is_amend`) are the authority, and this page is checked against them by the gate's selftest
fixtures.

## A verdict comment

Three things, each on its own line, in the same comment:

1. **The first line names the seat.** It must *begin* with the seat's id, optionally in
   bold or backticks: `` **`sec-reviewer` — security review verdict** `` or
   `` **`sec-reviewer-2` — …** ``. The gate reads seat 2 before seat 1 because
   `sec-reviewer` is a prefix of `sec-reviewer-2`. A comment whose first line names no seat
   is rejected as unattributable.
2. **A verdict line**, beginning `Verdict:` (leading `**`, `>`, `-` or backticks allowed):
   - `Verdict: GO — binds <full 40-hex head sha>`
   - `Verdict: NO-GO — …`
   - `Verdict: GO-WITH-AMENDMENTS — binds <sha>` (see below)
   The value after `Verdict:` is what counts. A body that *mentions* "NO-GO" or a superseded
   "GO-WITH-AMENDMENTS" elsewhere is not a verdict; only the anchored line is read.
3. **The full 40-character head SHA** somewhere in the body. A short SHA does not bind; the
   gate compares the branch ref, the PR head and this string byte for byte.

## Re-binding after the head moves

When the head moves without the content changing — an empty commit to refresh a stale merge
ref, or a rebase whose delta against main is byte-identical to the reviewed delta — the
seat posts a **new verdict comment in the same three-part form** naming the new SHA. Prose
such as "verdict unchanged, binds `<sha>`" without a `Verdict: GO` line is not read (the
re-binds on #159 and #160 needed editing for exactly this). An empty commit refreshes the
merge ref; it does not rebase the branch, so a stale-base caveat survives it and is covered
by executing on the merged tree, not by the head having moved.

## GO-WITH-AMENDMENTS and discharge

A `GO-WITH-AMENDMENTS` verdict does not merge on its own. It merges when either

- the author lands the amendment and the **same seat** posts a new `Verdict: GO` binding
  the new head, or
- the amendment is deliberately deferred and the **same seat** posts a **discharge**
  comment containing the full head SHA and naming where the amendment lands; the gate is
  run with `DISCHARGED=<comment-id>` (and, for a conditional discharge, `REQUIRE_MERGED=<pr>`
  and `REQUIRE_MAIN=path:regex` so the condition is mechanical, not prose).

A discharge by any other party is not accepted: that is how an amendment quietly becomes
optional.

## What the gate also reads

- Every comment and every PR review on the PR, for an anchored `Verdict: NO-GO` line — one
  anywhere blocks the merge.
- The PR body's closing keywords, which may name issues only, never another PR.

## Why this page exists

Two independently written gates in this fleet required writers to produce a
machine-meaningful string that was documented only in the gate's source. A string writers
must produce is an interface, and an interface documented only in its consumer is
undiscoverable by construction: the form was carried by the reviewers' verdict template
and lost the moment a shorter comment was written by hand.
