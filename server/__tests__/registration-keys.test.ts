import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, getRegistrationKeyBySecret, registerAgent, countLiveMintedAgents } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';

// DESIGN_FEDERATION §5.1 (Phase 1). Keys mint agents into ONE tenant under a
// LIVE-population cap. Phase 1 changes no enforcement: a minted agent can
// exist, and tenants gate nothing yet.

describe('POST /registration-keys (§5.1)', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  const ADMIN = 'admin-secret';

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startHttpAdmin(0, db, ADMIN, 1024, mkdtempSync(join(tmpdir(), 'regkeys-')), new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => { await handle.shutdown().catch(() => {}); db.close(); });

  const post = (body: unknown, token = ADMIN) =>
    fetch(`${base}/registration-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const list = (token = ADMIN) =>
    fetch(`${base}/registration-keys`, { headers: { Authorization: `Bearer ${token}` } });

  it('mints a key: raw secret once, defaults per D6, public fields back', async () => {
    const res = await post({ namespace: 'acme' });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.namespace).toBe('acme');
    expect(body.capabilities).toEqual(['send:direct']); // D6 default
    expect(body.max_agents).toBe(16);
    expect(body.id).toMatch(/^regk_[0-9a-f]{8}$/);
    expect(typeof body.key).toBe('string');
    expect(body.key.length).toBeGreaterThan(32);
    // The raw secret authenticates; the response never carries the hash.
    expect(body.key_hash).toBeUndefined();
    expect(getRegistrationKeyBySecret(db, body.key)?.id).toBe(body.id);
  });

  it('★ the LIST never returns hashes or secrets — an audit surface, not a corpus', async () => {
    const created = await (await post({ namespace: 'acme', note: 'first' })).json() as any;
    const rows = await (await list()).json() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.id);
    // Both absences asserted explicitly: a list that leaked hashes would turn
    // the audit endpoint into an offline-cracking corpus, and the raw secret
    // exists in exactly one response ever (the 201).
    expect(rows[0].key).toBeUndefined();
    expect(rows[0].key_hash).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain(created.key);
    expect(JSON.stringify(rows)).not.toContain(hashToken(created.key));
  });

  it('reports live_agents — the operator question the cap actually answers', async () => {
    const key = await (await post({ namespace: 'acme', max_agents: 3 })).json() as any;
    registerAgent(db, { id: 'acme:a', token_hash: hashToken('t-a'), hostname: 'h', namespace: 'acme' });
    db.prepare('UPDATE agents SET minted_by_key = ? WHERE id = ?').run(key.id, 'acme:a');
    expect((await (await list()).json() as any[])[0].live_agents).toBe(1);

    // Disabling frees a slot (§4 F2): the cap is on LIVE agents, not lifetime.
    db.prepare('UPDATE agents SET disabled = 1 WHERE id = ?').run('acme:a');
    expect((await (await list()).json() as any[])[0].live_agents).toBe(0);
    expect(countLiveMintedAgents(db, key.id)).toBe(0);
  });

  it('★ refuses the reserved tenant names — the validator applied HERE', async () => {
    for (const ns of ['home', 'mesh']) {
      const res = await post({ namespace: ns });
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.message).toMatch(/reserved/i);
    }
  });

  it('refuses tenant names outside the grammar, including a colon', async () => {
    for (const ns of ['', 'Acme', 'acme_corp', 'acme:evil', 'x'.repeat(64)]) {
      expect((await post({ namespace: ns })).status).toBe(400);
    }
  });

  it('★ refuses unknown capabilities rather than storing them inert', async () => {
    // A key whose capabilities silently mean nothing is the "configured but
    // inert" shape — refused at mint, where the operator is present to see it.
    const res = await post({ namespace: 'acme', capabilities: ['send:direct', 'rm -rf'] });
    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toContain('unknown capability');
  });

  it('accepts the full known capability set, and refuses duplicates', async () => {
    expect((await post({ namespace: 'acme', capabilities: ['send:direct', 'send:file', 'publish', 'subscribe'] })).status).toBe(201);
    expect((await post({ namespace: 'acme2', capabilities: ['publish', 'publish'] })).status).toBe(400);
    expect((await post({ namespace: 'acme3', capabilities: [] })).status).toBe(400);
  });

  it('validates max_agents and expires_at rather than coercing them', async () => {
    expect((await post({ namespace: 'acme', max_agents: 0 })).status).toBe(400);
    expect((await post({ namespace: 'acme', max_agents: 1.5 })).status).toBe(400);
    expect((await post({ namespace: 'acme', max_agents: '16' })).status).toBe(400);
    expect((await post({ namespace: 'acme', expires_at: 'tomorrow' })).status).toBe(400);
    expect((await post({ namespace: 'acme', max_agents: 1, expires_at: Date.now() + 1000 })).status).toBe(201);
  });

  it('is admin-only — an agent token cannot mint a key', async () => {
    registerAgent(db, { id: 'nosy', token_hash: hashToken('agent-token'), hostname: 'h' });
    expect((await post({ namespace: 'acme' }, 'agent-token')).status).toBe(401);
    expect((await list('agent-token')).status).toBe(401);
  });
});

describe('getRegistrationKeyBySecret — the /register auth path (#75 pattern)', () => {
  let db: Database;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => db.close());

  const insert = (id: string, secret: string, ns = 'acme') =>
    db.prepare(`INSERT INTO registration_keys
      (id, key_hash, namespace, capabilities, max_agents, expires_at, revoked_at, note, created_at)
      VALUES (?, ?, ?, '["send:direct"]', 16, NULL, NULL, NULL, ?)`)
      .run(id, hashToken(secret), ns, Date.now());

  it('finds the right key, and an unknown secret is null', () => {
    insert('regk_aaaaaaaa', 'secret-a');
    expect(getRegistrationKeyBySecret(db, 'secret-a')?.id).toBe('regk_aaaaaaaa');
    expect(getRegistrationKeyBySecret(db, 'not-a-secret')).toBeNull();
  });

  it('★ the lookup is INDEX-BACKED — asserted on the plan, not on speed', () => {
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM registration_keys WHERE key_hash = ? LIMIT 2')
      .all('x') as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail).toContain('idx_registration_keys_key_hash');
    expect(detail).not.toContain('SCAN registration_keys');
  });

  it('★ an AMBIGUOUS key_hash authenticates NOBODY', () => {
    // Two keys sharing a hash cannot say which TENANT a caller belongs to —
    // picking one would mint into the wrong tenant, which is worse than
    // refusing. Impossible by construction; refused explicitly anyway.
    const shared = hashToken('shared-secret');
    for (const id of ['regk_11111111', 'regk_22222222']) {
      db.prepare(`INSERT INTO registration_keys
        (id, key_hash, namespace, capabilities, max_agents, expires_at, revoked_at, note, created_at)
        VALUES (?, ?, 'acme', '["send:direct"]', 16, NULL, NULL, NULL, ?)`).run(id, shared, Date.now());
    }
    expect(getRegistrationKeyBySecret(db, 'shared-secret')).toBeNull();
    insert('regk_33333333', 'other-secret');
    expect(getRegistrationKeyBySecret(db, 'other-secret')?.id).toBe('regk_33333333');
  });

  it('★ the final timing-safe compare is LOAD-BEARING under a NOCASE column', () => {
    // The obligation carried from #75, applied to this table independently
    // rather than through a shared helper: a shared util that failed to build
    // the NOCASE world would pass vacuously in BOTH places and nothing would
    // say so. Two constructions, two known-positive controls.
    const nocase = new Database(':memory:');
    nocase.exec(`
      CREATE TABLE registration_keys (
        id TEXT PRIMARY KEY, key_hash TEXT NOT NULL COLLATE NOCASE, namespace TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '["send:direct"]', max_agents INTEGER NOT NULL DEFAULT 16,
        expires_at INTEGER, revoked_at INTEGER, note TEXT, created_at INTEGER NOT NULL
      );
    `);
    const ins = nocase.prepare(`INSERT INTO registration_keys
      (id, key_hash, namespace, capabilities, max_agents, created_at)
      VALUES (?, ?, 'acme', '["send:direct"]', 16, 1)`);
    ins.run('regk_shouty', hashToken('tok-shouty').toUpperCase());
    ins.run('regk_exact', hashToken('tok-exact')); // known-positive control

    expect(getRegistrationKeyBySecret(nocase, 'tok-exact')?.id).toBe('regk_exact');
    expect(getRegistrationKeyBySecret(nocase, 'tok-shouty')).toBeNull();
    nocase.close();
  });
});
