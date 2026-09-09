# Review verdicts — the form the merge gate reads

This page describes the **claude-mesh** merge gate (`.github/scripts/gate.sh`; the
claude-spawner gate has its own vocabulary). The gate decides whether a pull request may
merge by reading **comments on the PR**. The strings below are an interface: the gate
parses them, so a verdict written in another form is not seen, and the PR does not merge.
This page documents the form where writers write it. The gate's predicates (`seat_of`,
`chk_verdict`, `is_amend`) are the authority; this page was transcribed from them by hand
and is not yet checked against them mechanically — a citations-style test that runs the
page's stated forms through the predicates is tracked as a follow-up. If the page and the
predicates disagree, the predicates win and the page is wrong.

## A verdict comment

Three things, each on its own line, in the same comment:

1. **The first line names the seat.** It must *begin* with the seat's id, optionally in
   bold or backticks: `` **`sec-reviewer` — security review verdict** `` or
   `` **`sec-reviewer-2` — …** ``. The gate reads seat 2 before seat 1 because
   `sec-reviewer` is a prefix of `sec-reviewer-2`. A comment whose first line names no seat
   is rejected as unattributable.
2. **A verdict line**, beginning `Verdict:` after optional leading whitespace, `**`, `_`,
   `>`, `-` or backticks:
   - `Verdict: GO — binds <full 40-hex head sha>`
   - `Verdict: NO-GO — …`
   - `Verdict: GO-WITH-AMENDMENTS — binds <sha>` (see below)
   The value after `Verdict:` is what counts. **Only a line whose start matches `Verdict:`
   is read.** The markers that may precede it differ by direction, and the asymmetry is
   deliberate — **quoting is reproduction, and reproduction must never ADD approval:**

   | line | leading markers read | effect |
   | --- | --- | --- |
   | `Verdict: GO` | whitespace, `-`, `*`, `_`, backticks — **not `>`** | certifies, and only as your OWN line |
   | `Verdict: NO-GO` | those **and `>`** | blocks, quoted or not |
   | `Verdict: GO-WITH-AMENDMENTS` | those **and `>`** | downgrades, quoted or not |

   So a *quoted* or *bulleted* `Verdict: NO-GO` line still counts as a NO-GO, and a quoted
   earlier `Verdict: GO-WITH-AMENDMENTS` line makes the comment read as an amendments
   verdict — while a **quoted `Verdict: GO` does NOT certify** (#196: it used to, so an
   addendum quoting your own earlier verdict for context re-certified it at the quoted
   head). Quoting a prior verdict line will block or downgrade the merge and can never
   grant one. Refer to an earlier verdict by PR number, comment id and SHA, never by
   reproducing its verdict line. Prose that mentions "NO-GO" mid-sentence is not read.
3. **The full 40-character head SHA, ON THE VERDICT LINE** — the `binds <sha>` half of the
   forms in 2, on that same line. A short SHA does not bind; the gate compares the branch ref, the PR head and this string
   byte for byte.

   **CHANGED (#195): the sha used to count anywhere in the body.** That made the gate check
   two memberships — a head appears somewhere, a GO line exists somewhere — where the
   property is a RELATION: this head, on this verdict line. Measured on a real comment
   whose verdict line bound one sha while naming the head it superseded in prose: asked
   about the superseded head, the gate said GO. Nobody has to be careless for that to
   happen — naming the head you supersede is *good* re-bind practice, and that is exactly
   what puts a stale sha in the body.

## Re-binding after the head moves

When the head moves without the content changing — an empty commit to refresh a stale merge
ref, or a rebase whose delta against main is byte-identical to the reviewed delta — the
seat posts a **new verdict comment in the same three-part form** naming the new SHA. Prose
such as "verdict unchanged, binds `<sha>`" without a `Verdict: GO` line is not read (the
re-binds on #159 and #160 needed editing for exactly this). **Naming the previous head in
prose stays good practice and binds nothing** — only the sha on the verdict line binds, so
"my previous verdict was bound to `<old sha>`" is safe to write and always was meant to be. An empty commit refreshes the
merge ref; it does not rebase the branch, so a stale-base caveat survives it and is covered
by executing on the merged tree, not by the head having moved.

## GO-WITH-AMENDMENTS and discharge

A `GO-WITH-AMENDMENTS` verdict does not merge on its own. It merges when either

- the author lands the amendment and the **same seat** posts a new `Verdict: GO` binding
  the new head, or
- the amendment is deliberately deferred and the **same seat** posts a **discharge**
  comment carrying a `Discharge:` line with the full head SHA **on it**; the gate is run
  with `DISCHARGED=<comment-id>`:

      **`sec-reviewer` — discharge**
      Discharge: amendment deferred to #NNN — binds <full 40-hex head sha>

  **CHANGED (#195): the sha used to count anywhere in that comment, and there was no
  `Discharge:` line.** A discharge had no line that WAS the claim, so the head bound by
  membership while the verdict half bound by relation — measured: a discharge whose own
  line named one head, with another in prose, was accepted for the one in prose. The
  anchored line is the same rule as the verdict's, so naming an earlier head in prose is
  safe here too and binds nothing.

  The gate enforces **three** things about that comment: the seat matches, the full head
  SHA is on the `Discharge:` line, and it does **not** itself contain an anchored
  `Verdict: NO-GO` line —
  so a discharge that reproduces the verdict it discharges is refused, which is the writer
  rule above with teeth. Naming where the amendment lands, and
  running the gate with `REQUIRE_MERGED=<pr>` / `REQUIRE_MAIN=path:regex` so a conditional
  discharge is checked mechanically, are **operator discipline** the gate does not compel —
  the gate-holder's rule is to do both.

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
