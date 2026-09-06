import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// #177 — the identity files are LINE-INDEPENDENT.
//
// They are the list behind the ratchet's number, and they are read only when
// the count goes DOWN. That is the whole problem: every count-preserving edit
// above an error rewrote its identity while nothing was looking, so the file
// rotted silently and the first genuine fix produced a "vanished" list of 61
// entries containing 2 real ones. A warning list that is routinely wrong gets
// skimmed, then ignored.
//
// A line number is a property of everything ABOVE an error, not of the error.
// `file:code:message` is, and the message names the symbol.
//
// THIS FILE IS THE ONLY THING THAT LOOKS AT THEM ON A NORMAL RUN. Without it,
// the format could revert and nobody would find out until the next DOWN — the
// same silence #177 exists to remove, one level up.

const REPO = join(import.meta.dir, '../..');
const read = (pkg: string) =>
  readFileSync(join(REPO, `.github/typecheck-identities-${pkg}.txt`), 'utf8')
    .split('\n').filter(l => l.length > 0);

describe('#177 typecheck identities are line-independent', () => {
  for (const pkg of ['server', 'client']) {
    it(`${pkg}: no identity carries a line number`, () => {
      const ids = read(pkg);
      // Control on the fixture: the file is real and non-trivial, so "none
      // matched" is not an empty list agreeing with everything.
      expect(ids.length).toBeGreaterThan(20);

      // The OLD shape was `path:LINE:TSxxxx`. Nothing may look like it.
      const lineKeyed = ids.filter(l => /:\d+:TS\d+$/.test(l));
      expect(lineKeyed).toEqual([]);
    });

    it(`${pkg}: every identity is file:code:message`, () => {
      const malformed = read(pkg).filter(l => !/^[^:]+\.ts:TS\d+:.+$/.test(l));
      expect(malformed).toEqual([]);
    });

    it(`${pkg}: the count matches the baseline, one line per diagnostic`, () => {
      const baseline = Number(readFileSync(join(REPO, `.github/typecheck-baseline-${pkg}.txt`), 'utf8').trim());
      // The invariant the `#n` suffix exists for: dedup must not COLLAPSE
      // rows, or the number and the list would describe different worlds — and
      // the number is the gate.
      expect(read(pkg).length).toBe(baseline);
    });

    it(`${pkg}: repeats are distinguished by a #n suffix, never merged`, () => {
      const ids = read(pkg);
      const bare = ids.map(l => l.replace(/#\d+$/, ''));
      // Some identity repeats in this tree — if none did, the suffix scheme
      // would be untested here and this assertion says so rather than passing
      // silently on a tree that happens to have no duplicates.
      expect(bare.length - new Set(bare).size).toBeGreaterThan(0);
      // ...and every suffixed entry has its unsuffixed original present.
      for (const id of ids.filter(l => /#\d+$/.test(l))) {
        expect(ids).toContain(id.replace(/#\d+$/, ''));
      }
    });

    it(`${pkg}: sorted in C collation, which is what comm requires`, () => {
      const ids = read(pkg);
      const sorted = [...ids].sort();   // JS string compare is code-unit order
      expect(ids).toEqual(sorted);
    });
  }
});
