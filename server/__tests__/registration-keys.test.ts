import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  openDb, getRegistrationKeyBySecret, registerAgent, countLiveMintedAgents,
  getAgentById, getAgentByToken, aclGrant, aclCheck,
} from '../db.ts';
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

// ─── §5.2 POST /register + §5.4 revocation ──────────────────────────────────

describe('POST /register (§5.2) + revocation (§5.4)', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  const ADMIN = 'admin-secret';

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startHttpAdmin(0, db, ADMIN, 1024, mkdtempSync(join(tmpdir(), 'register-')), new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => { await handle.shutdown().catch(() => {}); db.close(); });

  const mintKey = async (body: Record<string, unknown> = { namespace: 'acme' }) =>
    await (await fetch(`${base}/registration-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).json() as any;

  const register = (secret: string, id: string, hostname = 'h') =>
    fetch(`${base}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, hostname }),
    });

  it('mints an agent into the key\'s tenant, returning short id AND fq_id', async () => {
    const key = await mintKey();
    const res = await register(key.key, 'worker-1');
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    // §4's short/FQ split: the bare name the caller asked for, plus the
    // server-composed FQ id. The tenant prefix is never smuggled into `id`.
    expect(body.id).toBe('worker-1');
    expect(body.fq_id).toBe('acme:worker-1');
    expect(body.tenant).toBe('acme');
    expect(body.capabilities).toEqual(['send:direct']);
    expect(typeof body.token).toBe('string');

    const agent = getAgentByToken(db, body.token);
    expect(agent?.id).toBe('acme:worker-1');
    expect(agent?.namespace).toBe('acme');
    expect(agent?.minted_by_key).toBe(key.id);
  });

  it('★ the key holder never chooses its tenant — a namespace in the body is ignored', async () => {
    const key = await mintKey();
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'worker-1', hostname: 'h', namespace: 'evil', capabilities: ['publish'] }),
    });
    const body = await res.json() as any;
    expect(body.tenant).toBe('acme');            // from the KEY (C1)
    expect(body.capabilities).toEqual(['send:direct']); // from the KEY, not the body
    expect(getAgentById(db, 'evil:worker-1')).toBeNull();
  });

  it('revoked key → 403; expired key → 403; unknown key → 403 — all identical', async () => {
    const revoked = await mintKey({ namespace: 'r1' });
    await fetch(`${base}/registration-keys/${revoked.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` } });
    const expired = await mintKey({ namespace: 'e1', expires_at: Date.now() - 1000 });

    const bodies: string[] = [];
    for (const [secret, name] of [[revoked.key, 'a'], [expired.key, 'b'], ['not-a-key', 'c']] as const) {
      const res = await register(secret, name);
      expect(res.status).toBe(403);
      bodies.push(await res.text());
    }
    // D4: no oracle. The three refusals must be BYTE-IDENTICAL to the caller —
    // a difference in wording is a probe for key state.
    expect(new Set(bodies).size).toBe(1);
  });

  it('★ 17th LIVE mint on max 16 → 403, but disable one and the next succeeds (F2)', async () => {
    const key = await mintKey({ namespace: 'acme', max_agents: 16 });
    for (let i = 0; i < 16; i++) {
      expect((await register(key.key, `w${i}`)).status).toBe(201);
    }
    expect((await register(key.key, 'w16')).status).toBe(403);

    // The cap is on LIVE agents, not lifetime mints: disabling frees a slot.
    await fetch(`${base}/agents/acme:w0`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    expect((await register(key.key, 'w16')).status).toBe(201);
  });

  it('★ re-registration rotates the token, clears disabled, PURGES conversation, KEEPS acl', async () => {
    const key = await mintKey();
    const first = await (await register(key.key, 'worker-1')).json() as any;
    const fq = 'acme:worker-1';

    // Predecessor state: an undelivered message, a pending reminder, a
    // subscription, and an ACL edge.
    registerAgent(db, { id: 'peer', token_hash: hashToken('peer-tok'), hostname: 'h' });
    db.prepare(`INSERT INTO messages (id, from_agent, to_agent, kind, payload, content_type, sent_at, delivered_at)
                VALUES ('m1','peer',?, 'direct','hi','text/plain',?,NULL)`).run(fq, Date.now());
    db.prepare(`INSERT INTO reminders (id, agent_id, due_at, schedule, payload, created_at, status, last_fired_at, tz)
                VALUES ('r1', ?, ?, NULL, 'wake', ?, 'pending', NULL, NULL)`).run(fq, Date.now() + 60_000, Date.now());
    db.prepare('INSERT INTO topics (name, created_at, created_by) VALUES (?,?,?)').run('t1', Date.now(), 'peer');
    db.prepare('INSERT INTO subscriptions (agent_id, topic, subscribed_at) VALUES (?,?,?)').run(fq, 't1', Date.now());
    aclGrant(db, 'peer', fq, 'admin');
    db.prepare('UPDATE agents SET disabled = 1 WHERE id = ?').run(fq);

    const again = await register(key.key, 'worker-1');
    expect(again.status).toBe(200); // re-registration, not a create
    const second = await again.json() as any;

    // Token rotated: the old one is dead, the new one works.
    expect(second.token).not.toBe(first.token);
    expect(getAgentByToken(db, first.token)).toBeNull();
    expect(getAgentByToken(db, second.token)?.id).toBe(fq);
    expect(getAgentById(db, fq)?.disabled).toBe(0); // disabled cleared

    // Conversation state GONE — without this a "fresh" incarnation drains its
    // predecessor's backlog on first connect (queued reminders never expire).
    expect((db.prepare('SELECT COUNT(*) n FROM messages WHERE to_agent = ?').get(fq) as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM reminders WHERE agent_id = ? AND status='pending'").get(fq) as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM subscriptions WHERE agent_id = ?').get(fq) as any).n).toBe(0);
    // Topology KEPT — ACL is admin-granted tenant shape, not conversation.
    expect(aclCheck(db, 'peer', fq)).toBe(true);
  });

  it('★ re-registration does NOT consume a cap slot', async () => {
    const key = await mintKey({ namespace: 'acme', max_agents: 1 });
    expect((await register(key.key, 'only')).status).toBe(201);
    expect((await register(key.key, 'only')).status).toBe(200); // same id, same key
    expect((await register(key.key, 'other')).status).toBe(403); // cap still 1
  });

  it('★ a DIFFERENT key cannot capture an id — no cross-key capture', async () => {
    const k1 = await mintKey({ namespace: 'acme' });
    const k2 = await mintKey({ namespace: 'acme' }); // same tenant, different key
    expect((await register(k1.key, 'shared')).status).toBe(201);
    expect((await register(k2.key, 'shared')).status).toBe(403);
    expect(getAgentById(db, 'acme:shared')?.minted_by_key).toBe(k1.id);
  });

  it('id grammar is a 400 (a property of the request), not a 403', async () => {
    const key = await mintKey();
    for (const bad of ['Worker', 'a:b', 'home', '', 'x'.repeat(64)]) {
      expect((await register(key.key, bad)).status).toBe(400);
    }
  });

  it('★ revocation cascades: key dead AND every minted agent disabled, in one call', async () => {
    const key = await mintKey();
    const a = await (await register(key.key, 'w1')).json() as any;
    const b = await (await register(key.key, 'w2')).json() as any;

    const res = await fetch(`${base}/registration-keys/${key.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).disabled_agents.sort()).toEqual(['acme:w1', 'acme:w2']);

    // The agents' tokens are dead at the HTTP auth site…
    for (const t of [a.token, b.token]) {
      const r = await fetch(`${base}/messages`, { headers: { Authorization: `Bearer ${t}` } });
      expect(r.status).toBe(401);
    }
    // …and the key can mint nothing further.
    expect((await register(key.key, 'w3')).status).toBe(403);
  });

  it('a disabled agent is refused identically to an unknown token (no oracle)', async () => {
    const key = await mintKey();
    const agent = await (await register(key.key, 'w1')).json() as any;
    const before = await fetch(`${base}/messages`, { headers: { Authorization: `Bearer ${agent.token}` } });
    expect(before.status).toBe(200);

    await fetch(`${base}/agents/acme:w1`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    const after = await fetch(`${base}/messages`, { headers: { Authorization: `Bearer ${agent.token}` } });
    const unknown = await fetch(`${base}/messages`, { headers: { Authorization: 'Bearer nonsense' } });
    expect(after.status).toBe(401);
    expect(await after.text()).toBe(await unknown.text());
  });

  it('★ PATCH cannot move a minted agent between tenants — the id/column split', async () => {
    const key = await mintKey();
    await register(key.key, 'w1');
    const res = await fetch(`${base}/agents/acme:w1`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: 'other' }),
    });
    expect(res.status).toBe(403);
    expect(getAgentById(db, 'acme:w1')?.namespace).toBe('acme');
  });

  it('★ POST /agents refuses a forged FQ id and the bare reserved words', async () => {
    const post = (id: string) => fetch(`${base}/agents`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, hostname: 'h' }),
    });
    expect((await post('acme:forged')).status).toBe(400); // would claim a tenant
    expect((await post('home')).status).toBe(400);
    expect((await post('mesh')).status).toBe(400);
    // …while the permissive grammar still admits existing fleet id shapes.
    expect((await post('mesh-builder')).status).toBe(201);
    expect((await post('spawner_backend')).status).toBe(201);
  });
});
