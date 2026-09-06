import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// THE GUIDE IS THE INPUT, THE SOURCE IS THE ORACLE. No literal in between.
//
// docs/FEDERATION.md cites its claims as `file.ts` + symbol rather than
// file:line, because line numbers drift on every merge — measured at 22/22
// wrong across one merge while the symbols survived 10/10. That trade only
// holds while the symbols are real, and a rename is exactly as silent as a
// merge: the guide keeps citing `handleFoo` after `handleFoo` is gone.
//
// #157's own citation test did not close this. It compared the guide's row
// against a hand-written literal 'handlePeerGet', so renaming the handler left
// the guide citing a symbol that no longer exists WITH THE TEST STILL GREEN —
// the citation could go stale silently, inside the test written to stop the
// guide going stale silently. Found by seat 1. The literal is gone; both
// checks below read the symbol out of the guide and ask the source.

const REPO_ROOT = join(import.meta.dir, '../..');
const GUIDE_PATH = join(REPO_ROOT, 'docs/FEDERATION.md');
const guide = readFileSync(GUIDE_PATH, 'utf8');

/**
 * Every `path/to/file.ts` + `symbol` pair the guide cites, in order.
 *
 * THE PATH GROUP IS NOT ANCHORED TO `server/` (seat 1). It was, which meant a
 * citation to any other tree — `client/src/client.ts`, a moved file, a typo'd
 * directory — was never EXAMINED at all: the regex skipped it and the test
 * passed on a smaller population, which is the failure mode this whole file
 * exists to prevent, one level up. Any repo-relative path ending `.ts` is
 * matched now, and an unreadable one is a REPORTED PROBLEM rather than a throw.
 */
export function citationsIn(text: string): { file: string; symbol: string }[] {
  const re = /`([A-Za-z0-9_\-./]+\.ts)`\s*`([A-Za-z_][A-Za-z0-9_]*)`/g;
  return [...text.matchAll(re)].map(m => ({ file: m[1]!, symbol: m[2]! }));
}

function citations(): { file: string; symbol: string }[] {
  return citationsIn(guide);
}

/**
 * Is `symbol` DEFINED in `file`?
 *
 * ANCHORED AT LINE START, in multiline mode, and that anchor is the whole
 * point (seat 1). Unanchored, this was satisfied by a COMMENT naming the
 * symbol in definition form — delete the handler, leave
 * `// historical: function handlePeerGet was here`, and the oracle says yes.
 * 27 of 31 citations rest on this function alone, so a comment-satisfiable
 * oracle made most of the file decorative.
 *
 * `^\s*` admits indentation but nothing else, so neither `//` nor a jsdoc `*`
 * can precede the keyword. The exclusion is asserted by a mutant in the control
 * below rather than only described here — which is what the previous version of
 * this comment did, correctly, about a property the code did not have.
 *
 * Returns false for an unreadable path; the caller reports it.
 */
export function definesIn(src: string, symbol: string): boolean {
  return new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|class|interface|type|enum)\\s+${symbol}\\b`,
    'm',
  ).test(src);
}

function defines(file: string, symbol: string): boolean {
  let src: string;
  try { src = readFileSync(join(REPO_ROOT, file), 'utf8'); } catch { return false; }
  return definesIn(src, symbol);
}

/** Does the cited file exist at all? Separated from `defines` so "the file is
 *  gone" and "the symbol is gone" are different reports — a moved file would
 *  otherwise be indistinguishable from a rename. */
function fileExists(file: string): boolean {
  try { readFileSync(join(REPO_ROOT, file), 'utf8'); return true; } catch { return false; }
}

/** The ROUTES table as (method, path, handler), parsed from the source. */
function routes(): { method: string; path: string; handler: string }[] {
  const src = readFileSync(join(REPO_ROOT, 'server/http-admin.ts'), 'utf8');
  const re = /\{\s*method:\s*'([A-Z]+)',\s*match:\s*exact\('([^']+)'\),\s*handler:\s*([A-Za-z0-9_]+)/g;
  return [...src.matchAll(re)].map(m => ({ method: m[1]!, path: m[2]!, handler: m[3]! }));
}

describe('docs/FEDERATION.md citations name real symbols', () => {
  it('every cited symbol is DEFINED in the file the guide names', () => {
    const cites = citations();
    // Positive control on the PARSER, which is the part that can silently
    // return nothing: a regex that stops matching turns this whole file into a
    // green that checks no citations at all.
    expect(cites.length).toBeGreaterThanOrEqual(20);
    expect(new Set(cites.map(c => c.file)).size).toBeGreaterThanOrEqual(4);

    const broken = cites
      .map(c => {
        // A missing FILE is reported as a missing file, not as a missing
        // symbol, and never as a thrown readFileSync — an exception here would
        // abort the walk partway and report nothing about the rest.
        if (!fileExists(c.file)) return `${c.file}: no such file (cited for ${c.symbol})`;
        if (!defines(c.file, c.symbol)) return `${c.file} ${c.symbol}`;
        return null;
      })
      .filter((p): p is string => p !== null);
    expect([...new Set(broken)]).toEqual([]);
  });

  // POSITIVE CONTROL for `defines` — the oracle 27 of the 31 citations rest on.
  // Without it, a predicate that answered "true" for everything would satisfy
  // the test above and a rename would go through untouched.
  it('CONTROL: the definition check says NO to a symbol that is not there', () => {
    expect(defines('server/http-admin.ts', 'handlePeerGet')).toBe(true);
    expect(defines('server/http-admin.ts', 'handlePeerGetRenamed')).toBe(false);
    // ...and a symbol that is CALLED in the file but defined elsewhere is not
    // a definition — the case that would let a deleted-but-still-called symbol
    // pass.
    expect(defines('server/http-admin.ts', 'listPeers')).toBe(false);
  });

  // THE MUTANT SEAT 1 NAMED, run rather than described. The unanchored version
  // of `defines` returned TRUE for every line below: a deleted handler whose
  // name survives in a comment satisfied the oracle, and the comment claiming
  // "a mention in a comment is not a definition" was describing a property the
  // code did not have.
  it('CONTROL: a symbol named only in a COMMENT is not a definition', () => {
    const notDefinitions = [
      '// historical: function handlePeerGet was here',
      '  // function handlePeerGet(ctx) — removed in #999',
      ' * function handlePeerGet used to serve this',
      '/* const handlePeerGet = … */',
      '// see also: type handlePeerGet',
    ];
    for (const line of notDefinitions) {
      const src = `import x from 'y';\n${line}\nexport const other = 1;\n`;
      // definesIn IS the predicate `defines` uses — not a copy of its regex.
      // A first draft of this control rebuilt the pattern inline, which made it
      // a literal I had typed: reverting `defines` to the unanchored form would
      // have left this green. That is the exact defect this file exists to
      // stop, committed inside the test written to stop it.
      expect({ line, matched: definesIn(src, 'handlePeerGet') }).toEqual({ line, matched: false });
    }

    // ...and the forms that ARE definitions still match, so the anchor did not
    // buy its precision by rejecting real code.
    for (const line of [
      'function handlePeerGet(ctx) {',
      'export function handlePeerGet(ctx) {',
      'export async function handlePeerGet(ctx) {',
      '  const handlePeerGet = () => {};',
      'export default function handlePeerGet() {}',
    ]) {
      expect({ line, matched: definesIn(`${line}\n`, 'handlePeerGet') }).toEqual({ line, matched: true });
    }
  });

  // The path group was anchored to `server/`, so a citation anywhere else was
  // never EXAMINED — the walk silently ran on a smaller population and passed.
  // A shrinking population that still passes is the same defect as a stale
  // oracle, one level up.
  it('CONTROL: a citation outside server/ is examined, not skipped', () => {
    // Uses the SAME parser the walk uses, by pointing it at a guide-shaped
    // string — not a re-typed copy of its regex, for the reason above.
    expect(citationsIn('cited at `client/src/client.ts` `MeshClient` today'))
      .toEqual([{ file: 'client/src/client.ts', symbol: 'MeshClient' }]);
    // And the oracle answers about it, rather than the path being unreadable.
    expect(defines('client/src/client.ts', 'MeshClient')).toBe(true);
    expect(defines('client/src/client.ts', 'NoSuchThing')).toBe(false);
    // An unreadable path is false + reported, never a throw.
    expect(fileExists('server/does-not-exist.ts')).toBe(false);
    expect(() => defines('server/does-not-exist.ts', 'anything')).not.toThrow();
  });

  // The §4 table is the one an operator reads to decide what to type, so its
  // rows are held to more than "the symbol exists somewhere": the cited
  // handler must be the handler that actually serves the path in the row.
  it('every §4 read-API row cites the handler that serves its path', () => {
    const section = guide.slice(guide.indexOf('### Read APIs'), guide.indexOf('### Metrics'));
    const rows = section.split('\n')
      .map(line => {
        const path = /`GET (\/[A-Za-z0-9_\-/]+)`/.exec(line);
        const symbol = /`(server\/[A-Za-z0-9_\-/]+\.ts)`\s*`([A-Za-z_][A-Za-z0-9_]*)`/.exec(line);
        return path === null ? null : { path: path[1]!, symbol: symbol === null ? null : symbol[2]! };
      })
      .filter((r): r is { path: string; symbol: string | null } => r !== null);

    // Control on the row parser, same reason as above.
    expect(rows.length).toBeGreaterThanOrEqual(4);

    const table = routes();
    const problems: string[] = [];
    for (const row of rows) {
      // EVERY ROW CITES. An uncited row is how the table went wrong in the
      // first place: #153's `GET /peers` row was the only one with no citation
      // beside it, and it was the only one describing a route that did not
      // exist. A citation is not decoration — it is the step that makes the
      // claim fail to be written.
      if (row.symbol === null) { problems.push(`${row.path}: no citation`); continue; }
      if (!defines('server/http-admin.ts', row.symbol)) {
        problems.push(`${row.path}: cites ${row.symbol}, which is not defined`); continue;
      }
      const entry = table.find(r => r.method === 'GET' && r.path === row.path);
      if (entry === undefined) { problems.push(`${row.path}: no GET route`); continue; }
      if (entry.handler !== row.symbol) {
        problems.push(`${row.path}: guide cites ${row.symbol}, ROUTES uses ${entry.handler}`);
      }
    }
    expect(problems).toEqual([]);
  });

  // Control on the ROUTES parser: it must actually find the table, and find
  // the entry this file was written around.
  it('CONTROL: the ROUTES parser reads the real table', () => {
    const table = routes();
    expect(table.length).toBeGreaterThanOrEqual(10);
    expect(table).toContainEqual({ method: 'GET', path: '/peers', handler: 'handlePeerGet' });
  });
});
