import { describe, it, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// #166 — THE PAGE IS AN ORACLE, NOT A DESCRIPTION.
//
// docs/REVIEW-VERDICTS.md documents the string a reviewer must produce for the
// merge gate to see their verdict. It was transcribed from `seat_of`,
// `chk_verdict` and `is_amend` by hand, and nothing checked it against them —
// the page itself says so. An interface documented only in prose drifts from
// its consumer silently, and the cost is a correct verdict that does not merge.
//
// THE PREDICATES ARE SOURCED, NEVER RE-IMPLEMENTED. Everything above gate.sh's
// selftest guard is extracted and sourced into a subshell, so these tests call
// the SHIPPED functions. A re-implementation here would be a second copy of
// exactly the thing this page already got wrong once by being a second copy.
//
// The cut point is DERIVED from the file (the selftest guard line), not a line
// number: gate.sh has grown by 150 lines this week.

const REPO = join(import.meta.dir, '../..');
const GATE = join(REPO, '.github/scripts/gate.sh');
const PAGE = join(REPO, 'docs/REVIEW-VERDICTS.md');

const page = readFileSync(PAGE, 'utf8');
const gate = readFileSync(GATE, 'utf8');

/** A full 40-hex sha, which is what the gate insists on. */
const HEAD = 'a'.repeat(40);
const SHORT = 'a'.repeat(7);

/** gate.sh up to (not including) its selftest guard: definitions only, no body. */
function predicateSource(): string {
  const lines = gate.split('\n');
  const cut = lines.findIndex(l => /^if \[ "\$\{1:-\}" = --selftest \]/.test(l));
  expect(cut).toBeGreaterThan(0);          // the guard exists, and we found it
  return lines.slice(0, cut).join('\n');
}

/** Run a snippet with the shipped predicates in scope. Returns stdout. */
function withPredicates(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-preds-'));
  const preds = join(dir, 'preds.sh');
  writeFileSync(preds, predicateSource());
  const runner = join(dir, 'run.sh');
  // `--selftest` as $1 so the argument-parsing line above the guard takes its
  // non-PR branch; `set -u` is on in gate.sh and an unset $1 would abort.
  writeFileSync(runner, `set -- --selftest\nsource ${preds}\n${script}\n`);
  const out = Bun.spawnSync(['bash', runner], { stdout: 'pipe', stderr: 'pipe' });
  return new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
}

/**
 * A verdict comment body: seat line, then the verdict line CARRYING the sha.
 *
 * #195 moved the sha ONTO that line. It used to sit on a line of its own here,
 * which the old predicate accepted because it only asked whether the sha
 * appeared somewhere — and that gap is the defect #195 fixes. This helper had
 * to follow the page, which is the oracle working as intended: the interface
 * changed, and the fixtures that claim to write it changed with it.
 */
const comment = (first: string, verdict: string, sha = HEAD) =>
  `${first}\n${verdict} binds ${sha}`;

const chk = (body: string, seat = '') =>
  withPredicates(`B=$(cat <<'EOF'\n${body}\nEOF\n)\nchk_verdict t "$B" ${HEAD} '${seat}'`);

const passes = (out: string) => !out.includes('FAIL');

describe('#166 the page\'s stated forms, run through the shipped predicates', () => {
  // The page is the INPUT: these are the strings it tells a reviewer to write.
  // Extracted from it rather than retyped, so editing the page moves the test.
  const statedVerdictForms = () =>
    [...page.matchAll(/`(Verdict: [^`]+)`/g)].map(m => m[1]!);

  it('the page states the three verdict forms, and they are found', () => {
    const forms = statedVerdictForms();
    // Control on the extractor: a page whose examples stopped being backticked
    // would silently give this file nothing to check.
    expect(forms.length).toBeGreaterThanOrEqual(3);
    expect(forms.some(f => /^Verdict: GO\b/.test(f))).toBe(true);
    expect(forms.some(f => /^Verdict: NO-GO\b/.test(f))).toBe(true);
    expect(forms.some(f => /^Verdict: GO-WITH-AMENDMENTS\b/.test(f))).toBe(true);
  });

  it('the GO form the page states is READ as a GO', () => {
    const go = statedVerdictForms().find(f => /^Verdict: GO —/.test(f))!;
    // The page writes the sha as a placeholder; a reviewer substitutes it.
    const body = comment('**`sec-reviewer` — verdict**', go.replace(/<[^>]*>/, HEAD));
    expect(passes(chk(body))).toBe(true);
  });

  it('the NO-GO form the page states BLOCKS', () => {
    const nogo = statedVerdictForms().find(f => /^Verdict: NO-GO/.test(f))!;
    const body = comment('**`sec-reviewer` — verdict**', nogo.replace(/…/, 'reasons'));
    expect(passes(chk(body))).toBe(false);
  });

  it('the GO-WITH-AMENDMENTS form the page states is read as an AMENDMENTS verdict', () => {
    const amend = statedVerdictForms().find(f => /^Verdict: GO-WITH-AMENDMENTS/.test(f))!;
    const out = withPredicates(`is_amend '${amend.replace(/<[^>]*>/, HEAD)}' && echo AMEND || echo NOT`);
    expect(out.trim()).toBe('AMEND');
  });

  // ── the page's claims about what still counts, and what does not ──────────

  it('a QUOTED verdict line still counts — the page says so, and it does', () => {
    expect(page).toContain('a *quoted* or *bulleted* `Verdict: NO-GO` line still counts');
    const body = comment('**`sec-reviewer` — verdict**', '> Verdict: NO-GO — an earlier round\nVerdict: GO — binds');
    expect(passes(chk(body))).toBe(false);
  });

  it('a BULLETED verdict line still counts', () => {
    const body = comment('**`sec-reviewer` — verdict**', '- Verdict: NO-GO — an earlier round\nVerdict: GO — binds');
    expect(passes(chk(body))).toBe(false);
  });

  it('a quoted GO-WITH-AMENDMENTS downgrades the comment, as the page warns', () => {
    expect(page).toContain('makes the comment read as an amendments\n   verdict');
    const out = withPredicates(`is_amend '> Verdict: GO-WITH-AMENDMENTS — an earlier round' && echo AMEND || echo NOT`);
    expect(out.trim()).toBe('AMEND');
  });

  // THE NEGATIVE CONTROL, and the one that makes the four above mean something:
  // if every string containing "NO-GO" blocked, the page's whole distinction
  // would be vacuous and these tests would pass anyway.
  it('CONTROL: prose that MENTIONS a verdict mid-sentence is not read', () => {
    expect(page).toContain('Prose that mentions "NO-GO" mid-sentence is not read');
    const body = comment('**`sec-reviewer` — verdict**', 'the earlier NO-GO is discharged\nVerdict: GO — binds');
    expect(passes(chk(body))).toBe(true);

    const out = withPredicates(`is_amend 'we discussed GO-WITH-AMENDMENTS earlier' && echo AMEND || echo NOT`);
    expect(out.trim()).toBe('NOT');
  });

  // ── the BIND is a relation, not a membership (#195) ──────────────────────

  it('the page says the sha goes ON the verdict line, and the gate agrees', () => {
    expect(page).toContain('ON THE VERDICT LINE');
    const body = `**\`sec-reviewer\` — verdict**\nVerdict: GO — binds ${HEAD}`;
    expect(passes(chk(body))).toBe(true);
  });

  // THE CASE THE PAGE NOW WARNS ABOUT, and the one that measured PASS before
  // #195: the head is in the body, a GO line exists, and they are on different
  // lines. The page calls naming a superseded head good practice, so this shape
  // is written deliberately by careful reviewers.
  it('a sha in PROSE does not bind, exactly as the page now says', () => {
    expect(page).toContain('binds nothing');
    const other = 'b'.repeat(40);
    const body = `**\`sec-reviewer\` — verdict**\nmy previous verdict was bound to ${HEAD}\nVerdict: GO — binds ${other}`;
    expect(passes(chk(body))).toBe(false);
  });

  // ── the seat rules the page states ───────────────────────────────────────

  it('seat 2 is read before seat 1, because one id is a prefix of the other', () => {
    expect(page).toContain('reads seat 2 before seat 1');
    expect(withPredicates(`seat_of '**\`sec-reviewer-2\` — verdict**'`).trim()).toBe('2');
    expect(withPredicates(`seat_of '**\`sec-reviewer\` — verdict**'`).trim()).toBe('1');
  });

  it('a first line naming no seat is rejected as unattributable, as the page says', () => {
    expect(page).toContain('rejected as unattributable');
    expect(withPredicates(`seat_of 'a review comment'`).trim()).toBe('none');
    const body = comment('a review comment', 'Verdict: GO — binds');
    expect(passes(chk(body))).toBe(false);
  });

  it('a SHORT sha does not bind, as the page says', () => {
    expect(page).toContain('A short SHA does not bind');
    const body = comment('**`sec-reviewer` — verdict**', 'Verdict: GO — binds', SHORT);
    expect(passes(chk(body))).toBe(false);
  });

  // ── the discharge conditions (seat 2 on #165) ────────────────────────────

  // THE PAGE OMITTED THE THIRD CONDITION. `gate.sh`'s discharge check requires
  // the seat to match, the SHA to be present, AND the discharge not to contain
  // an anchored `Verdict: NO-GO` — so a discharge that reproduces the verdict
  // it discharges fails silently. The page's writer rule prevents that; the
  // page's discharge section did not name it.
  it('the discharge section names all THREE conditions the gate enforces', () => {
    const section = page.slice(page.indexOf('## GO-WITH-AMENDMENTS and discharge'), page.indexOf('## What the gate also reads'));
    // Derived from the code, not from memory: the discharge check's own
    // conjunction is seat, head, and no anchored NO-GO.
    //
    // Read from `discharge_ok`'s BODY, since #182 lifted the conjunction out of
    // the gate's main body into a named predicate — which is what lets the
    // behavioural case below run it instead of reconstructing it. Sliced by the
    // column-0 close, the same rule the source scanner uses on TypeScript.
    const fnStart = gate.indexOf('discharge_ok(){');
    expect(fnStart).toBeGreaterThan(-1);
    const check = gate.slice(fnStart, gate.indexOf('\n}', fnStart) + 2);
    expect(check).toContain('[ "$ds" = "$2" ]');
    expect(check).toContain('grep -q "$3"');
    expect(check).toContain('Verdict:\\**\\s*NO-GO');
    // ...and all three are joined by AND. Seat 1's `&&` → `||` mutant is what
    // this line exists for; it is asserted on the SHAPE as well as driven
    // behaviourally below, because the two fail differently and a reader of a
    // failure should be told which.
    expect(check.match(/&&/g)?.length).toBe(2);

    expect(section).toMatch(/same seat/i);
    expect(section).toMatch(/full head SHA/i);
    expect(section).toMatch(/NO-GO/);
  });

  it('the three discharge conditions behave as the page now describes', () => {
    const ok = 'sec-reviewer — discharge\nthe amendment is deferred; binds ' + HEAD;
    const wrongSeat = 'sec-reviewer-2 — discharge\nbinds ' + HEAD;
    const noSha = 'sec-reviewer — discharge\nbinds ' + SHORT;
    const reproducedNoGo = 'sec-reviewer — discharge\n> Verdict: NO-GO — the earlier round\nbinds ' + HEAD;

    // RUNS THE SHIPPED PREDICATE (#182). This used to be a hand-written
    // RECONSTRUCTION of the gate's inline conjunction — the one blind spot an
    // oracle that sources functions has, and one invisible from inside its own
    // design: seat 1's `&&` → `||` mutant on the gate left this file 16/0.
    // `discharge_ok` now lives above the selftest guard, so it arrives with
    // `seat_of` and the rest.
    const discharge = (body: string) => withPredicates(
      `D=$(cat <<'EOF'\n${body}\nEOF\n)\n` +
      `discharge_ok "$D" 1 "${HEAD}" && echo DISCHARGED || echo REFUSED`,
    ).trim();

    expect({ ok: discharge(ok), wrongSeat: discharge(wrongSeat), noSha: discharge(noSha), reproducedNoGo: discharge(reproducedNoGo) })
      .toEqual({ ok: 'DISCHARGED', wrongSeat: 'REFUSED', noSha: 'REFUSED', reproducedNoGo: 'REFUSED' });
  });

  // ── the any-author NO-GO scan (build-triage on #166) ─────────────────────

  // THE SCAN HAS NO SEAT FILTER, and that is the point the page must carry:
  // ANY author's anchored `Verdict: NO-GO` line, in any comment or review,
  // blocks the merge. The spawner gate does the opposite, which is why the page
  // says which gate it describes.
  it('the NO-GO scan reads EVERY author, and the page says which gate this is', () => {
    expect(page).toContain('Every comment and every PR review on the PR');
    expect(page).toContain('the\nclaude-spawner gate has its own vocabulary');

    // The regex is EXTRACTED from the scan, not retyped — a copy here would be
    // the same second-copy defect this file exists to close.
    const scanLine = gate.split('\n').find(l => l.startsWith('nogo=$(gh api'))!;
    const re = /test\("(.+?)"\)/.exec(scanLine)![1]!.replace(/\\\\/g, '\\');

    const anchoredByAnyone = 'random-contributor writes:\nVerdict: NO-GO — I disagree';
    const proseByAnyone = 'random-contributor writes:\nI would have said NO-GO here';

    const matches = (body: string) => withPredicates(
      `B=$(cat <<'EOF'\n${body}\nEOF\n)\n` +
      `jq -n --arg b "$B" --arg re '${re}' '$b | test($re; "m")' `,
    ).trim();

    expect({ anchored: matches(anchoredByAnyone), prose: matches(proseByAnyone) })
      .toEqual({ anchored: 'true', prose: 'false' });
  });

  it('the discharge section points at the any-author scan as what makes the writer rule non-optional', () => {
    const section = page.slice(page.indexOf('## GO-WITH-AMENDMENTS and discharge'), page.indexOf('## Why this page exists'));
    // The writer rule ("never reproduce a verdict line") is not politeness: the
    // scan is what turns a reproduced line into a blocked merge.
    expect(section + page).toMatch(/anchored `Verdict: NO-GO` line — one\s*\n?\s*anywhere blocks the merge/);
  });
});

// A PAGE EDIT MUST BE ABLE TO RED THIS FILE, or the oracle is decorative.
//
// Everything above reads the page for the claim and the predicates for the
// answer, so a page that stops stating a form loses its test silently — the
// extractor simply finds one fewer. This asserts the extractor's population,
// which is the only place that silence is visible.
describe('#166 the page cannot quietly stop being an oracle', () => {
  it('the page still states each CANONICAL form exactly once', () => {
    // The canonical forms are the three the "A verdict comment" section lists
    // as what to write — distinguishable from the prose mentions by carrying a
    // placeholder or a trailing dash. Counting ALL backticked `Verdict:`
    // strings would couple this to how often the prose quotes them, which is
    // editorial and not an interface.
    const forms = [...page.matchAll(/`(Verdict: [^`]+)`/g)].map(m => m[1]!);
    const canonical = forms.filter(f => /—/.test(f));
    expect(canonical.sort()).toEqual([
      'Verdict: GO — binds <full 40-hex head sha>',
      'Verdict: GO-WITH-AMENDMENTS — binds <sha>',
      'Verdict: NO-GO — …',
    ]);
  });
});
