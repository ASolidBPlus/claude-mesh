import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb, registerAgent, getAgentByToken } from '../db.ts';
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
// ALTER is missing. Constructed and run —
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

/** A database at the post-#41 / post-last_alive shape: everything before
    Phase 1, which is what production actually looks like right now. */
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
  `);
  db.prepare(
    'INSERT INTO agents (id, token_hash, hostname, registered_at, last_seen) VALUES (?,?,?,?,?)',
  ).run('prod-agent', hashToken('prod-token'), 'prod-host', 1, 1);
  db.prepare('INSERT INTO observers (agent_id, granted_at, granted_by) VALUES (?,?,?)')
    .run('prod-agent', 1, 'admin');
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
    for (const added of ['namespace', 'last_alive', 'minted_by_key', 'disabled']) {
      expect(cols).toContain(added);
    }
    // Data, not just schema: a migration that dropped and recreated would pass
    // a columns-only assertion.
    expect(getAgentByToken(db, 'legacy-token')?.id).toBe('legacy-agent');
    db.close();
  });

  it('★ the CURRENT production shape migrates, with its rows intact', () => {
    // The shape that actually boots on Hades: post-#41, pre-federation, with
    // agents and observers already in it. The assertions are explicit about
    // every column Phase 1 adds, because nothing else in the suite reads them
    // yet — an ALTER that silently never ran would otherwise be invisible
    // until the first /register.
    const path = tmpDb('prefed');
    preFederationDb(path);
    const db = openDb(path);

    expect(columns(db, 'agents')).toContain('minted_by_key');
    expect(columns(db, 'observers')).toContain('namespace');
    expect(getAgentByToken(db, 'prod-token')?.id).toBe('prod-agent');
    db.close();
  });

  it('the Phase 1 indexes exist after migrating an old database, not only a new one', () => {
    const path = tmpDb('idx');
    preFederationDb(path);
    const db = openDb(path);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
      .map((r) => r.name);
    expect(idx).toContain('idx_agents_minted_by_key');
    expect(idx).toContain('idx_registration_keys_key_hash');
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

  it('a fresh database still works — the from-empty path is not regressed', () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'new', token_hash: hashToken('new-token'), hostname: 'h' });
    expect(getAgentByToken(db, 'new-token')?.id).toBe('new');
    expect(columns(db, 'agents')).toContain('disabled');
    db.close();
  });
});
