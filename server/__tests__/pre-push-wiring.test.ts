import { describe, it, expect } from 'bun:test';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// #204 — THE WIRING IS THE CLAIM, so the wiring is what this pins.
//
// The check itself refuses correctly; it refused nothing until something called
// it. As first shipped, `pre-push.sh` was a script a person had to remember to
// type, while its own header called itself "the mechanism rather than the
// reminder" — and the incident it prevents had happened twice that day because
// people forget (seat 1).
//
// WHAT THIS CAN AND CANNOT SEE, said plainly because the gap is the interesting
// part: git will not let a repository commit into `.git/hooks`, so enforcement
// needs `git config core.hooksPath .githooks` once per clone, and NO TEST CAN
// ASSERT THAT SOMEONE RAN IT — a clone's git config is not in the repository.
// What is checkable is that the hook EXISTS, is executable, calls the script,
// and that the install command is written where a reader will meet it. A check
// that claimed more than that would be the same overstatement one layer up.

const REPO = join(import.meta.dir, '../..');
const HOOK = join(REPO, '.githooks/pre-push');
const SCRIPT = join(REPO, '.github/scripts/pre-push.sh');

describe('#204 the pre-push hook is wired, not just written', () => {
  it('the hook exists and is executable', () => {
    expect(existsSync(HOOK)).toBe(true);
    // A hook git will not run is a file, not a hook. Mode checked on the owner
    // bit, which is what git requires.
    expect(statSync(HOOK).mode & 0o100).toBe(0o100);
  });

  it('the hook calls the script, and by a path that survives a subdirectory', () => {
    const hook = readFileSync(HOOK, 'utf8');
    expect(hook).toContain('.github/scripts/pre-push.sh');
    // `git rev-parse --show-toplevel` rather than a relative path: git runs
    // hooks with the working directory set to the repository root TODAY, and a
    // relative path would break silently if that ever stopped being true or if
    // the hook were invoked by hand from elsewhere.
    expect(hook).toContain('--show-toplevel');
  });

  it('the script is executable too — the hook execs it directly', () => {
    expect(statSync(SCRIPT).mode & 0o100).toBe(0o100);
  });

  // THE INSTALL STEP IS PART OF THE DELIVERABLE. It cannot be asserted as DONE,
  // so it is asserted as DOCUMENTED — in both files, because a reader arriving
  // at either one should not have to find the other.
  it('both files name the one command that wires it', () => {
    const cmd = 'core.hooksPath .githooks';
    expect(readFileSync(SCRIPT, 'utf8')).toContain(cmd);
    expect(readFileSync(HOOK, 'utf8')).toContain(cmd);
  });

  // AND THE HEADER NO LONGER CLAIMS ENFORCEMENT IT DOES NOT HAVE. This is the
  // amendment's other half: a claim about enforcement gets relied on rather
  // than re-derived, so the sentence matters as much as the hook.
  it('the script says it is a reminder until the hook is installed', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/ONLY ONCE IT IS WIRED/);
    expect(src).toMatch(/UNTIL YOU RUN THAT, THIS IS A REMINDER/);
  });
});
