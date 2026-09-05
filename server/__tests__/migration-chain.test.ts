import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb, registerAgent, getAgentByToken, deleteAgent, rebuildAclFkLess } from '../db.ts';
import { hashToken } from '../auth.ts';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// openDb() runs DDL against the LIVE database on every boot, so a migration
// fault is not a test failure — it is a server that will not start, which on
// this component takes the fleet's comms with it. Every existing migration
// test starts from an EMPTY database. This one starts from databases that
// already exist, because those are what production boots.
//
// WHAT THIS CATCHES THAT FROM-EMPTY CANNOT — measured, not assumed. I first
// justified this file with the ordering bug I had just made (an index over a
// column that a later ALTER adds). That justification was WRONG, and running
// the mutant is what showed it: the existing from-empty suite fails on that
// bug too (95 fail), because the column is absent from the CREATE TABLE as
// well. Right test, wrong reason.
//
// The class that IS upgrade-only: a column added to the CREATE TABLE whose
// ALTER is missing. Constructed and run against THIS branch's code (the
// numbers were re-measured here rather than carried over from where this file
// was first written — a measurement is a claim about a specific tree) —
//
//   from-empty (db.test.ts):  95 pass, 0 fail   ← perfect, and blind
//   migration-chain:           4 pass, 1 fail   ← catches it
//
// A fresh database gets the column from CREATE TABLE; an upgraded one never
// gets it at all, and nothing that only creates fresh databases can tell the
// difference. That is this file's reason for existing, stated as measured.

/** A database as it existed before #41 — no namespace, no last_alive, and
    none of the Phase 1 columns. The oldest shape still plausibly on disk. */
function preNamespaceDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, hostname TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}',
      registered_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      online INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(
    'INSERT INTO agents (id, token_hash, hostname, registered_at, last_seen) VALUES (?,?,?,?,?)',
  ).run('legacy-agent', hashToken('legacy-token'), 'legacy-host', 1, 1);
  db.close();
}

/** A database at the post-#41 / post-last_alive shape — what production
    actually looks like right now. */
function preFederationDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, hostname TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}',
      namespace TEXT, last_alive INTEGER,
      registered_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      online INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE observers (
      agent_id TEXT PRIMARY KEY, granted_at INTEGER NOT NULL, granted_by TEXT NOT NULL
    );
    -- The acl shape as it was BEFORE F0a: with the foreign keys, which is what
    -- every database on disk still has.
    CREATE TABLE acl (
      from_agent   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      to_agent     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      granted_at   INTEGER NOT NULL,
      granted_by   TEXT NOT NULL,
      PRIMARY KEY (from_agent, to_agent)
    );
    CREATE INDEX idx_acl_reverse ON acl(to_agent, from_agent);
  `);
  db.prepare(
    'INSERT INTO agents (id, token_hash, hostname, registered_at, last_seen) VALUES (?,?,?,?,?)',
  ).run('prod-agent', hashToken('prod-token'), 'prod-host', 1, 1);
  db.prepare('INSERT INTO observers (agent_id, granted_at, granted_by) VALUES (?,?,?)')
    .run('prod-agent', 1, 'admin');
  db.prepare('INSERT INTO agents (id, token_hash, hostname, registered_at, last_seen) VALUES (?,?,?,?,?)')
    .run('peer-agent', hashToken('peer-token'), 'peer-host', 1, 1);
  db.prepare('INSERT INTO acl (from_agent, to_agent, granted_at, granted_by) VALUES (?,?,?,?)')
    .run('prod-agent', 'peer-agent', 11, 'admin');
  db.prepare('INSERT INTO acl (from_agent, to_agent, granted_at, granted_by) VALUES (?,?,?,?)')
    .run('peer-agent', 'prod-agent', 22, 'system');
  db.close();
}

const tmpDb = (name: string) => join(mkdtempSync(join(tmpdir(), `migchain-${name}-`)), 'mesh.db');
const columns = (db: Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('migration chain — openDb over databases that predate the current schema', () => {
  it('★ a pre-#41 database migrates, and its rows survive', () => {
    const path = tmpDb('prenamespace');
    preNamespaceDb(path);
    const db = openDb(path);

    const cols = columns(db, 'agents');
    for (const added of ['namespace', 'last_alive']) {
      expect(cols).toContain(added);
    }
    // Data, not just schema: a migration that dropped and recreated would pass
    // a columns-only assertion.
    expect(getAgentByToken(db, 'legacy-token')?.id).toBe('legacy-agent');
    db.close();
  });

  it('★ the CURRENT production shape migrates, with its rows intact', () => {
    // The shape that actually boots on Hades: post-#41, with agents and
    // observers already in it. Both tables' rows must survive, since a
    // migration that dropped and recreated would pass a schema-only check.
    const path = tmpDb('prefed');
    preFederationDb(path);
    const db = openDb(path);

    expect(getAgentByToken(db, 'prod-token')?.id).toBe('prod-agent');
    expect((db.prepare('SELECT agent_id FROM observers').all() as { agent_id: string }[]))
      .toEqual([{ agent_id: 'prod-agent' }]);
    db.close();
  });

  it('indexes are created on an upgraded database, not only on a fresh one', () => {
    // An index whose CREATE sits inside the from-empty DDL block, or which
    // references a column added by a later ALTER, can exist on every fresh
    // database and on none of the upgraded ones. Nothing that only builds
    // fresh databases can see the difference.
    const path = tmpDb('idx');
    preFederationDb(path);
    const db = openDb(path);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
      .map((r) => r.name);
    expect(idx).toContain('idx_agents_last_seen');
    expect(idx).toContain('idx_files_to_agent');
    db.close();
  });

  it('openDb is IDEMPOTENT — booting twice is what a restart does', () => {
    const path = tmpDb('twice');
    preFederationDb(path);
    openDb(path).close();
    const db = openDb(path); // must not throw on the second pass
    expect(getAgentByToken(db, 'prod-token')?.id).toBe('prod-agent');
    db.close();
  });

  // ── F0a: the acl FK-less rebuild ────────────────────────────────────────

  const aclRows = (db: Database) =>
    db.prepare('SELECT from_agent, to_agent, granted_at, granted_by FROM acl ORDER BY from_agent').all();

  it('★ F0a: an upgraded acl table loses its foreign keys and keeps every row', () => {
    const path = tmpDb('aclfk');
    preFederationDb(path);

    const before = (() => { const d = new Database(path); const r = aclRows(d); d.close(); return r; })();
    expect(before.length).toBe(2);

    const db = openDb(path);
    // The point of the rebuild: no foreign keys left, so an acl endpoint can
    // name something that is not a local agent row.
    expect((db.prepare('PRAGMA foreign_key_list(acl)').all() as unknown[]).length).toBe(0);
    // EDGE FOR EDGE, including granted_at/granted_by — a rebuild that kept the
    // pairs but reset the provenance would pass a count-only assertion.
    expect(aclRows(db)).toEqual(before);
    db.close();
  });

  it('★ F0a: the rebuild REFUSES to run inside a transaction', () => {
    // The precondition is that PRAGMA foreign_keys = OFF is a silent no-op
    // inside a transaction. Documented, it is the weakest form there is: a
    // future tidy-up wrapping the migration section in db.transaction() would
    // make the pragma no-op, run the DROP/RENAME under FK enforcement, and
    // produce a server that will not start on every boot. So it throws.
    const path = tmpDb('acltx');
    preFederationDb(path);
    const db = new Database(path);
    expect(() => db.transaction(() => rebuildAclFkLess(db))()).toThrow(/outside a transaction/);
    // And the table is untouched — a guard that threw halfway would be worse
    // than none.
    expect((db.prepare('PRAGMA foreign_key_list(acl)').all() as unknown[]).length).toBeGreaterThan(0);
    db.close();

    // Positive control: the SAME call outside a transaction succeeds, so the
    // throw above is the precondition and not the function being broken.
    const ok = new Database(path);
    expect(() => rebuildAclFkLess(ok)).not.toThrow();
    expect((ok.prepare('PRAGMA foreign_key_list(acl)').all() as unknown[]).length).toBe(0);
    ok.close();
  });

  // Failure injection: a Proxy on db.exec that throws when the RENAME runs —
  // i.e. process death in the window between DROP TABLE acl and the rename of
  // acl_new. No production seam; the injection is entirely in the test.
  function dbThatDiesAtRename(path: string): Database {
    const db = new Database(path);
    const realExec = db.exec.bind(db);
    (db as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (sql.includes('RENAME TO acl')) throw new Error('simulated process death after DROP');
      return realExec(sql);
    };
    return db;
  }

  it('★ F0a: a crash mid-rebuild leaves the acl table INTACT — rows and FKs', () => {
    // Un-transactioned this was TOTAL, SILENT loss, measured before the fix:
    //   grants before: 2 → grants after crash + reboot: 0, with the real rows
    //   stranded in acl_new and the server booting clean.
    // The next boot's CREATE TABLE IF NOT EXISTS recreates acl EMPTY before
    // this function runs, and the zero-FK early return then no-ops — so the
    // damage is invisible from every angle a boot check would look at.
    const path = tmpDb('aclcrash');
    preFederationDb(path);

    const dying = dbThatDiesAtRename(path);
    expect(() => rebuildAclFkLess(dying)).toThrow(/simulated process death/);
    dying.close();

    // Reopen exactly as a restart would.
    const after = openDb(path);
    expect(aclRows(after).length).toBe(2);          // every grant survived
    expect(after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='acl_new'").get())
      .toBeNull();                                   // no orphan half-table
    after.close();
  });

  it('★ F0a: positive control — the SAME injection without a transaction loses the rows', () => {
    // Without this the test above cannot distinguish "the transaction saved
    // the rows" from "the injection never fired". Runs the un-transactioned
    // sequence by hand and shows the loss the fix prevents.
    const path = tmpDb('aclcrashctl');
    preFederationDb(path);

    const db = new Database(path);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`CREATE TABLE acl_new (
      from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      granted_at INTEGER NOT NULL, granted_by TEXT NOT NULL,
      PRIMARY KEY (from_agent, to_agent));`);
    db.exec('INSERT INTO acl_new SELECT from_agent, to_agent, granted_at, granted_by FROM acl');
    db.exec('DROP TABLE acl');
    // <-- process dies here; no RENAME
    db.close();

    const after = openDb(path);
    expect(aclRows(after).length).toBe(0);           // the loss, demonstrated
    expect(after.prepare("SELECT COUNT(*) AS n FROM acl_new").get()).toEqual({ n: 2 }); // stranded
    after.close();
  });

  it('★ F0a: the rebuild restores secondary indexes — idx_acl_reverse survives', () => {
    // The table is dropped, so its indexes go with it. #11's reverse index is
    // a performance guarantee that would vanish silently: nothing fails, the
    // query just scans again. Captured DDL is replayed after the rename.
    const path = tmpDb('aclidx');
    preFederationDb(path);
    const db = openDb(path);

    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='acl'").all() as { name: string }[])
      .map(r => r.name);
    expect(idx).toContain('idx_acl_reverse');

    const plan = (db.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM acl WHERE to_agent = ?'
    ).all('x') as { detail: string }[]).map(r => r.detail).join(' | ');
    expect(plan).toContain('idx_acl_reverse');
    db.close();
  });

  it('★ F0a: a second openDb does NOT rebuild — the probe makes it idempotent', () => {
    const path = tmpDb('aclidem');
    preFederationDb(path);
    openDb(path).close();

    const db = openDb(path);
    expect((db.prepare('PRAGMA foreign_key_list(acl)').all() as unknown[]).length).toBe(0);
    expect(aclRows(db).length).toBe(2);
    // A rebuild that ran again would still LOOK correct here, so assert the
    // thing that distinguishes them: the rebuild recreates the table, which
    // resets its rootpage. Same rootpage across the second boot = untouched.
    const root = (n: string) => (db.prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name=?").get(n) as { rootpage: number }).rootpage;
    const first = root('acl');
    openDb(path).close();
    expect(root('acl')).toBe(first);
    db.close();
  });

  it('★ F0a: deleteAgent still clears the agent\'s acl rows without the cascade', () => {
    const path = tmpDb('acldel');
    preFederationDb(path);
    const db = openDb(path);

    expect(aclRows(db).length).toBe(2);
    deleteAgent(db, 'peer-agent');
    // Both directions gone: the cascade covered from_agent AND to_agent, and
    // the explicit delete must not quietly cover only one.
    expect(aclRows(db).length).toBe(0);
    expect(getAgentByToken(db, 'prod-token')?.id).toBe('prod-agent');
    db.close();
  });

  it('★ F2a: failed_code arrives on an upgraded database, and the SECOND boot survives', () => {
    // The house pattern is try/catch around ALTER, and the reason is this test:
    // a BARE exec passes a migrate-once check and throws on the second boot,
    // because the column already exists. Opening twice is the whole point.
    const path = tmpDb('failedcode');
    preFederationDb(path);

    const first = openDb(path);
    expect(columns(first, 'messages')).toContain('failed_code');
    expect(getAgentByToken(first, 'prod-token')?.id).toBe('prod-agent');
    first.close();

    const second = openDb(path);              // must not throw
    expect(columns(second, 'messages')).toContain('failed_code');
    expect(getAgentByToken(second, 'prod-token')?.id).toBe('prod-agent');
    second.close();
  });

  it('★ F2a: outbound_peers exists after migrating an old database', () => {
    const path = tmpDb('outbound');
    preFederationDb(path);
    const db = openDb(path);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map(r => r.name);
    expect(tables).toContain('outbound_peers');
    db.close();
  });

  it('a fresh database still works — the from-empty path is not regressed', () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'new', token_hash: hashToken('new-token'), hostname: 'h' });
    expect(getAgentByToken(db, 'new-token')?.id).toBe('new');
    expect(columns(db, 'agents')).toContain('last_alive');
    db.close();
  });
});
