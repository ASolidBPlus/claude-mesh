import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// THE FOUR BOOT REPORTS ARE WIRED, not just written.
//
// Each of the four query helpers has a unit test proving WHAT it finds. None
// of them had a test proving `main()` CALLS it — deleting the block in
// server.ts left the whole suite green, and the reports would simply stop
// existing with nothing to say so.
//
// F4 added two of the four and inherited the gap from the other two. "Matches
// the neighbours" was the right default and the neighbours were the gap, so
// all four are pinned here rather than only the new pair.
//
// WHY A SOURCE SCAN AND NOT A BOOT. `main()` opens a database, binds three
// listeners and starts timers; driving it to observe a `console.warn` would be
// a large fixture for a small claim, and the claim is structural — that the
// helper is CALLED from the boot path, and that its output reaches a log line
// with a stable event name. What this cannot see is stated below rather than
// left for a reader to discover.

const SERVER = join(import.meta.dir, '../server.ts');

/** Source with comments stripped: every one of these names is DISCUSSED in
 *  comments, and a scan that counted prose would measure how much was written
 *  about a report rather than whether it runs. */
function code(): string {
  return readFileSync(SERVER, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('boot reports are called from the boot path', () => {
  // The four, paired with the event name each must emit. The pairing is the
  // point: a helper that is called but whose result never reaches a log line
  // is exactly as silent as one that is not called.
  const REPORTS: [helper: string, evt: string][] = [
    ['findPeerAliasCollisions', 'agents.peer_alias_collision'],
    ['findInvalidTopicNames', 'topics.invalid_names'],
    ['findTopicPrefixAgents', 'agents.topic_prefix_ids'],
  ];

  it('each report helper is CALLED, and its event name is emitted', () => {
    const src = code();
    const missing: string[] = [];
    for (const [helper, evt] of REPORTS) {
      if (!new RegExp(`\\b${helper}\\s*\\(`).test(src)) missing.push(`${helper}: never called`);
      if (!src.includes(`'${evt}'`)) missing.push(`${evt}: never emitted`);
    }
    expect(missing).toEqual([]);
  });

  // The legacy colon-id report has no helper — it is an inline query — so it
  // is pinned by its event name and by the query that backs it.
  it('the legacy colon-id report is wired too', () => {
    const src = code();
    expect(src).toContain("'agents.legacy_colon_ids'");
    expect(src).toContain("SELECT id FROM agents WHERE id LIKE '%:%'");
  });

  // POSITIVE CONTROL for the scan itself: it must say NO to a plausible name
  // that is not there. Without this, a regex that had stopped matching would
  // pass every assertion above.
  it('CONTROL: the scan rejects a helper that is not called', () => {
    const src = code();
    expect(new RegExp('\\bfindPeerAliasCollisions\\s*\\(').test(src)).toBe(true);
    expect(new RegExp('\\bfindImaginaryThings\\s*\\(').test(src)).toBe(false);
    expect(src.includes("'agents.no_such_report'")).toBe(false);
  });

  // EVERY REPORT IS NON-FATAL. A diagnostic that can stop the server from
  // starting is worse than the condition it reports — these run before
  // anything is served and describe state already on disk.
  it('every report is wrapped so it can never block boot', () => {
    const src = code();
    for (const [, evt] of [...REPORTS, ['', 'agents.legacy_colon_ids'] as const]) {
      const at = src.indexOf(`'${evt}'`);
      expect({ evt, found: at }).not.toEqual({ evt, found: -1 });
      // The nearest `try {` before the emit, and a `catch` after it — the shape
      // every one of these blocks uses.
      const before = src.lastIndexOf('try {', at);
      const after = src.indexOf('catch', at);
      expect({ evt, wrapped: before !== -1 && after !== -1 && after > at }).toEqual({ evt, wrapped: true });
    }
  });
});

// WHAT THIS FILE CANNOT SEE, said plainly because a structural test overstates
// by default: it proves the call and the event name are in the source of the
// boot path, not that a running server emits them for a given database. The
// per-helper unit tests in db.test.ts own WHAT each report finds; between the
// two, the only uncovered gap is a call sitting in a branch of `main()` that
// never executes — which no source scan can rule out.
