import { describe, it, expect, beforeEach } from 'bun:test';
import { openDb, registerAgent, getAgentByToken } from '../db.ts';
import { hashToken } from '../auth.ts';
import { Database } from 'bun:sqlite';

// #45/#13 — getAgentByToken was a full-table scan with a per-row timing-safe
// compare, on EVERY agentOrAdmin HTTP request and every WS auth. Now an
// indexed lookup. These assert the properties that make the swap safe, not
// that it is faster: correctness first, then the index is actually used, then
// the failure directions.

describe('getAgentByToken — indexed lookup (#45/#13)', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
    for (const id of ['alice', 'bob', 'carol']) {
      registerAgent(db, { id, token_hash: hashToken(`tok-${id}`), hostname: `h-${id}` });
    }
  });

  it('finds the right agent by its raw token, and only that agent', () => {
    expect(getAgentByToken(db, 'tok-bob')?.id).toBe('bob');
    expect(getAgentByToken(db, 'tok-alice')?.id).toBe('alice');
  });

  it('an unknown token is null — not "the first row"', () => {
    // The scan returned null by finding no match; the indexed lookup must not
    // accidentally return a row it merely fetched.
    expect(getAgentByToken(db, 'tok-nobody')).toBeNull();
  });

  it("a token that hashes to nothing stored is null even when the table is large", () => {
    for (let i = 0; i < 200; i++) {
      registerAgent(db, { id: `bulk-${i}`, token_hash: hashToken(`t-${i}`), hostname: 'h' });
    }
    expect(getAgentByToken(db, 'not-a-real-token')).toBeNull();
    expect(getAgentByToken(db, 't-77')?.id).toBe('bulk-77');
  });

  it('★ the query is INDEX-BACKED, not a scan — asserted on the plan, not on speed', () => {
    // A timing assertion would be flaky and would pass on a fast scan. The
    // query plan is the thing that actually changed: SQLite names the index it
    // uses, and says SCAN when it uses none.
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM agents WHERE token_hash = ? LIMIT 2')
      .all('x') as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail).toContain('idx_agents_token_hash');
    expect(detail).not.toContain('SCAN agents');
  });

  it('★ an AMBIGUOUS token_hash authenticates NOBODY', () => {
    // The index is deliberately not UNIQUE (a unique index cannot be created
    // over pre-existing duplicates, and this DDL runs on the live DB). So the
    // impossible-by-construction state is refused explicitly rather than
    // resolved by whichever row SQLite returns first — which would hand a
    // caller an identity it did not prove.
    const shared = hashToken('tok-shared');
    db.prepare(
      'INSERT INTO agents (id, token_hash, hostname, registered_at, last_seen, online) VALUES (?, ?, ?, ?, ?, 0)',
    ).run('twin-a', shared, 'h', Date.now(), Date.now());
    db.prepare(
      'INSERT INTO agents (id, token_hash, hostname, registered_at, last_seen, online) VALUES (?, ?, ?, ?, ?, 0)',
    ).run('twin-b', shared, 'h', Date.now(), Date.now());

    expect(getAgentByToken(db, 'tok-shared')).toBeNull();
    // …and the unrelated agents still authenticate: the refusal is scoped to
    // the ambiguous hash, not a global failure.
    expect(getAgentByToken(db, 'tok-alice')?.id).toBe('alice');
  });

  it('★ the final timing-safe compare is LOAD-BEARING under a NOCASE column', () => {
    // Converting a documented equivalent mutant into a killed one (reviewer's
    // catch on #75). As written against our BINARY-collation column the final
    // compare can never fail — the row was found BY `token_hash = ?`, so a
    // "two rows differing in case" test would pass trivially and assert
    // nothing. The hazard needs its world built: a column that matches
    // case-INSENSITIVELY, which is one `COLLATE NOCASE` away and exactly the
    // kind of schema edit nobody would connect to authentication.
    //
    // Verified in SQLite directly: with COLLATE NOCASE, `WHERE h = 'abcdef'`
    // returns a row stored as 'ABCDEF'. So the SQL layer hands back a row
    // whose hash is NOT the probe's hash — and only the final compare stops
    // that becoming a successful authentication as the wrong agent.
    const nocase = new Database(':memory:');
    nocase.exec(`
      CREATE TABLE agents (
        id            TEXT PRIMARY KEY,
        token_hash    TEXT NOT NULL COLLATE NOCASE,
        hostname      TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL,
        online        INTEGER NOT NULL DEFAULT 0
      );
    `);
    const ins = nocase.prepare(
      'INSERT INTO agents (id, token_hash, hostname, registered_at, last_seen, online) VALUES (?, ?, ?, ?, ?, 0)',
    );
    // Stored uppercase; the real hash is lowercase hex. Under NOCASE these are
    // "equal" to SQL and different to the compare.
    ins.run('shouty', hashToken('tok-shouty').toUpperCase(), 'h', Date.now(), Date.now());
    // Known-positive control in the SAME table: without it, "returns null"
    // would also pass against a DB that simply doesn't work.
    ins.run('exact', hashToken('tok-exact'), 'h', Date.now(), Date.now());

    expect(getAgentByToken(nocase, 'tok-exact')?.id).toBe('exact');
    expect(getAgentByToken(nocase, 'tok-shouty')).toBeNull();
    nocase.close();
  });

  it('a corrupted stored hash of the wrong length matches nothing', () => {
    db.prepare(
      'INSERT INTO agents (id, token_hash, hostname, registered_at, last_seen, online) VALUES (?, ?, ?, ?, ?, 0)',
    ).run('truncated', hashToken('tok-trunc').slice(0, 10), 'h', Date.now(), Date.now());
    expect(getAgentByToken(db, 'tok-trunc')).toBeNull();
  });
});
