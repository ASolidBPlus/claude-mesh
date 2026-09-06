import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { timingSafeEqual, hashToken } from '../auth.ts';

// #79 — one helper, one behaviour, for every secret comparison.
//
// The repo had THREE behaviours for one question: a plain `===` on the whole
// Authorization header (requireAdmin), a hand-rolled charCodeAt/XOR loop
// (auth.ts), and a byte-identical private copy of that loop in db.ts. Three
// behaviours for one question is drift waiting to be copied, and the copy
// nobody remembers is the one that stays weak.

const SERVER_ROOT = join(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Source with comments stripped — a rule quoted in prose is not code. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('#79 one token-comparison helper', () => {
  // The consolidation itself: two definitions became one. A second definition
  // is how this drifted in the first place, so the count is pinned rather than
  // the call sites alone.
  it('exactly ONE definition of each primitive in server/', () => {
    const defs = { timingSafeEqual: [] as string[], hashToken: [] as string[] };
    for (const f of sourceFiles(SERVER_ROOT)) {
      const src = code(f);
      if (/(?:export\s+)?function\s+timingSafeEqual\s*\(/.test(src)) defs.timingSafeEqual.push(f);
      if (/(?:export\s+)?function\s+hashToken\s*\(/.test(src)) defs.hashToken.push(f);
    }
    expect(defs.timingSafeEqual.map(f => f.slice(SERVER_ROOT.length + 1))).toEqual(['auth.ts']);
    expect(defs.hashToken.map(f => f.slice(SERVER_ROOT.length + 1))).toEqual(['auth.ts']);
  });

  // THE MUTANT-CATCHER. A plain `===` against a credential is the behaviour
  // this issue exists to remove, and it is the one that looks like ordinary
  // code — so it is scanned for by shape rather than trusted not to return.
  //
  // Reinstating `auth === \`Bearer ${adminToken}\`` at requireAdmin, or
  // `provided === configured` at the MCP door, reds this.
  it('no door compares a credential with === or !==', () => {
    // Deliberately narrow: a CREDENTIAL identifier on either side of an
    // identity comparison. An earlier, wider version matched
    // `typeof provided !== 'string'` — a type guard, not a compare — which is
    // the kind of false positive that gets a scan deleted rather than fixed.
    const CREDENTIAL = /(?:===|!==)\s*(?:`Bearer|adminToken|configured|token_hash|key_hash|storedHash)\b|\b(?:adminToken|storedHash|token_hash|key_hash)\s*(?:===|!==)/;
    const offenders: string[] = [];
    for (const f of sourceFiles(SERVER_ROOT)) {
      for (const [i, line] of code(f).split('\n').entries()) {
        if (CREDENTIAL.test(line)) offenders.push(`${f.slice(SERVER_ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The three doors named on the issue each reach the helper. Set-equal rather
  // than "at least one", so a door dropping its call is as loud as a door
  // adding a plain compare.
  it('every door that compares the admin token calls the helper', () => {
    const callers = sourceFiles(SERVER_ROOT)
      .filter(f => /\btimingSafeEqual\s*\(/.test(code(f)))
      .map(f => f.slice(SERVER_ROOT.length + 1))
      .sort();
    expect(callers).toEqual(['auth.ts', 'db.ts', 'http-admin.ts', 'mcp-server.ts']);
  });

  // Behaviour is unchanged from the loop it replaces — the point was the
  // construction, not a new answer. Equal-length, unequal-length and empty
  // cases all agree with the old semantics.
  it('the helper answers exactly as the hand-rolled loop did', () => {
    const oldLoop = (a: string, b: string): boolean => {
      if (a.length !== b.length) return false;
      let r = 0;
      for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return r === 0;
    };
    const cases: [string, string][] = [
      ['abc', 'abc'], ['abc', 'abd'], ['abc', 'abcd'], ['abcd', 'abc'],
      ['', ''], ['', 'a'], ['a', ''],
      ['a'.repeat(64), 'a'.repeat(64)], ['a'.repeat(64), 'a'.repeat(63) + 'b'],
      ['é', 'é'], ['é', 'e'],
    ];
    for (const [a, b] of cases) {
      expect({ a, b, got: timingSafeEqual(a, b) }).toEqual({ a, b, got: oldLoop(a, b) });
    }
  });

  // Unequal lengths must NOT throw. node's crypto.timingSafeEqual does, which
  // is the entire reason the prepad exists — without it this helper would
  // convert a wrong-length token into a 500.
  it('unequal lengths return false rather than throwing', () => {
    expect(() => timingSafeEqual('short', 'a'.repeat(500))).not.toThrow();
    expect(timingSafeEqual('short', 'a'.repeat(500))).toBe(false);
  });

  it('hashToken still produces the same digest it always did', () => {
    // Pinned by value: db.ts's callers match stored hashes written by earlier
    // versions, so a changed digest would silently reject every existing token.
    expect(hashToken('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
