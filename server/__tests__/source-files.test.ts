import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sourceFiles } from './helpers/source-files.ts';

// #199 — THE SHARED WALK, PINNED AGAINST A SYNTHETIC TREE.
//
// The property every consumer relies on is "every server module, including one
// nobody has created yet". `server/` is flat, so the recursion this depends on
// is dead code in the repository as it stands — which means no run of the suite
// exercises it, and a walk that silently stopped descending would look exactly
// like a walk with nothing to descend into.
//
// Seat 1 measured that gap on #199: `server/admin/rogue.ts` containing
// `INSERT INTO agents` left the chokepoint test 28/0 and the whole server suite
// 1056/0, because the two new derived walks were `readdirSync` alone. The
// population control ("the walk found more than ten files") could not see it
// either — 27 flat files stay 27 when a subdirectory appears. THE CONTROL
// PROVES THE WALK FOUND SOMETHING, NOT EVERYTHING.
//
// The fixtures are a temp tree, not the repo: the question is about the walker,
// and a walker tested against a directory that must keep agreeing with the
// source tree fails for someone else's reasons.

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'source-files-'));
  writeFileSync(join(root, 'flat.ts'), '');
  writeFileSync(join(root, 'notes.md'), '');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'deep.ts'), '');
  mkdirSync(join(root, 'nested', 'deeper'));
  writeFileSync(join(root, 'nested', 'deeper', 'deepest.ts'), '');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'dep.ts'), '');
  mkdirSync(join(root, '__tests__'));
  writeFileSync(join(root, '__tests__', 'a.test.ts'), '');
  return root;
}

describe('#199 the shared source walk', () => {
  it('finds nested modules, at two depths', () => {
    const root = tree();
    const rel = sourceFiles(root).map(f => f.slice(root.length + 1)).sort();
    // TWO depths, not one: a walker special-cased to one level of nesting
    // passes a single-depth fixture, and the repo's own #131 control learned
    // exactly that lesson.
    expect(rel).toEqual(['flat.ts', 'nested/deep.ts', 'nested/deeper/deepest.ts']);
  });

  it('skips node_modules and __tests__, and non-.ts files', () => {
    const root = tree();
    const rel = sourceFiles(root).map(f => f.slice(root.length + 1));
    expect(rel.some(f => f.startsWith('node_modules/'))).toBe(false);
    expect(rel.some(f => f.startsWith('__tests__/'))).toBe(false);
    expect(rel.some(f => f.endsWith('.md'))).toBe(false);
  });
});
