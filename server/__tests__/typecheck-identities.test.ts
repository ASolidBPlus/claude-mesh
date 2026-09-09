import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
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
// IT IS A TRADE, NOT A STRICT IMPROVEMENT (seat 2 on #181). The two schemes
// are stable against different things: the old one survives a RENAME and not a
// line shift; this one survives a line shift and not a rename — aliasing one
// unused import churns two entries here and none under the old scheme, with
// the count unchanged either way. Line shifts are constant and renames are
// rare, so the trade is worth making, and the script's DOWN branch says which
// causes a vanished entry can have.
//
// SINCE #80 THEY ARE THE GATE, not the list behind a number: the ratchet fails
// on any identity that is not in these files, which is what catches a
// count-preserving swap. The stored COUNT is gone — a value derivable from this
// file (`wc -l`) but kept beside it is two encodings of one fact, and two
// encodings drift.
//
// So the format matters on every run, not only on a drop, and this file is
// still the only thing that reads these as DATA rather than as a comparison
// set.

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

    // WHAT THE RETIRED COUNT FILE WAS ACTUALLY GUARDING (#80). It asserted
    // `lines === baseline`, which was a drift check between two encodings of
    // one fact; with the count derived there is nothing left to drift. The
    // invariant the `#n` suffix exists for survives and is checkable here
    // alone: dedup must never COLLAPSE two diagnostics into one line, so no
    // line may repeat.
    it(`${pkg}: one line per diagnostic — no identity appears twice`, () => {
      const ids = read(pkg);
      const dupes = ids.filter((l, i) => ids.indexOf(l) !== i);
      expect(dupes).toEqual([]);
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

    // THE SECOND ENCODING IS GONE AND MUST STAY GONE (#80). A stored count
    // beside the list it summarises is the trap this repo keeps meeting: the
    // two disagree, and the one nobody reads is the one that rots. Asserted so
    // reintroducing the file is a decision rather than a habit.
    it(`${pkg}: no stored count file shadows the identity baseline`, () => {
      expect(existsSync(join(REPO, `.github/typecheck-baseline-${pkg}.txt`))).toBe(false);
    });

    it(`${pkg}: sorted in C collation, which is what comm requires`, () => {
      const ids = read(pkg);
      const sorted = [...ids].sort();   // JS string compare is code-unit order
      expect(ids).toEqual(sorted);
    });
  }
});
