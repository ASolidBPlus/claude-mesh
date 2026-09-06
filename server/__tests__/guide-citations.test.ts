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

/** Every `path/to/file.ts` + `symbol` pair the guide cites, in order. */
function citations(): { file: string; symbol: string }[] {
  const re = /`(server\/[A-Za-z0-9_\-/]+\.ts)`\s*`([A-Za-z_][A-Za-z0-9_]*)`/g;
  return [...guide.matchAll(re)].map(m => ({ file: m[1]!, symbol: m[2]! }));
}

/** Is `symbol` DEFINED in `file`? Definition forms only — a mention in a
 *  comment or a call site is not a definition, and matching one would make the
 *  check pass on a symbol that had been deleted but was still called. */
function defines(file: string, symbol: string): boolean {
  const src = readFileSync(join(REPO_ROOT, file), 'utf8');
  return new RegExp(`\\b(?:function|const|let|class|interface|type|enum)\\s+${symbol}\\b`).test(src);
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
      .filter(c => !defines(c.file, c.symbol))
      .map(c => `${c.file} ${c.symbol}`);
    expect([...new Set(broken)]).toEqual([]);
  });

  // POSITIVE CONTROL for `defines`. Without it, a predicate that answered
  // "true" for everything would satisfy the test above, and a rename would go
  // through untouched.
  it('CONTROL: the definition check says NO to a symbol that is not there', () => {
    expect(defines('server/http-admin.ts', 'handlePeerGet')).toBe(true);
    expect(defines('server/http-admin.ts', 'handlePeerGetRenamed')).toBe(false);
    // ...and a symbol that is CALLED in the file but defined elsewhere is not
    // a definition — the case that would let a deleted-but-still-called symbol
    // pass.
    expect(defines('server/http-admin.ts', 'listPeers')).toBe(false);
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
