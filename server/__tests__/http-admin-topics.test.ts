import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as net from 'net';
import { openDb, registerAgent, listTopics } from '../db.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { Database } from 'bun:sqlite';

let db: Database;
let handle: HttpAdminHandle;
let base: string;
const token = 'test-admin-token';

beforeEach(async () => {
  db = openDb(':memory:');
  handle = await startHttpAdmin(0, db, token);
  const port = (handle.server.address() as net.AddressInfo).port;
  base = `http://localhost:${port}`;
});

afterEach(async () => {
  await handle.shutdown();
});

// F4: the fixture name here was `game:moves`, chosen long before ':' meant
// mesh/agent. These tests are about a missing creator, the 201 body shape and
// idempotency — the colon was incidental, and the door now refuses it for NEW
// names. Renamed rather than exempted; what the colon accidentally exercised is
// pinned deliberately by "F4 POST /topics name validation" below, including
// that an EXISTING colon topic still works.
describe('POST /topics', () => {
  it('401 without auth', async () => {
    const res = await fetch(`${base}/topics`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('400 if name missing', async () => {
    const res = await fetch(`${base}/topics`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ created_by: 'agent-a' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('name is required');
  });

  it('400 if created_by missing', async () => {
    const res = await fetch(`${base}/topics`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'game-moves' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('created_by is required');
  });

  it('404 if created_by agent not in registry', async () => {
    const res = await fetch(`${base}/topics`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'game-moves', created_by: 'ghost' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('created_by agent not found');
  });

  it('201 and creates topic', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    const res = await fetch(`${base}/topics`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'game-moves', created_by: 'agent-a' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      name: string;
      created_by: string;
      created_at: number;
      description: string;
      metadata: string;
    };
    expect(body.name).toBe('game-moves');
    expect(body.created_by).toBe('agent-a');
    expect(typeof body.created_at).toBe('number');
    expect(body.created_at).toBeGreaterThan(0);
    expect(body.description).toBe('');
    expect(body.metadata).toBe('{}');
  });

  it('idempotent — two POSTs with same payload both return 201, only one row exists', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    const payload = JSON.stringify({ name: 'game-moves', created_by: 'agent-a' });
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    const res1 = await fetch(`${base}/topics`, { method: 'POST', headers, body: payload });
    const res2 = await fetch(`${base}/topics`, { method: 'POST', headers, body: payload });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(listTopics(db)).toHaveLength(1);
  });

  it('accepts optional description and metadata', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    const res = await fetch(`${base}/topics`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 't', created_by: 'agent-a', description: 'hello', metadata: { x: 1 } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { description: string };
    expect(body.description).toBe('hello');
  });
});

describe('GET /topics', () => {
  it('401 without auth', async () => {
    const res = await fetch(`${base}/topics`);
    expect(res.status).toBe(401);
  });

  it('200 empty array when no topics', async () => {
    const res = await fetch(`${base}/topics`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it('200 with list of topics', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    await fetch(`${base}/topics`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'alpha', created_by: 'agent-a' }),
    });
    await fetch(`${base}/topics`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'beta', created_by: 'agent-a' }),
    });

    const res = await fetch(`${base}/topics`, { headers: { 'Authorization': `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(2);
  });
});

// F4 §7 — a NEW topic name may not contain ':' or exceed 256 bytes.
//
// ':' is the mesh/agent separator: a local topic called `a:b` would be
// indistinguishable from a remote topic on a mesh aliased `a`, and once an
// outbound peering named `a` exists, `isHomeTopic` would call it foreign.
//
// PRE-EXISTING NAMES ARE NEVER REJECTED — the F0b rule, the same one that
// spared legacy colon agent ids. A topic already on disk keeps working; only
// creation is refused. That asymmetry is the whole design and is pinned here,
// because the tempting simplification (refuse the name everywhere) would break
// live topics on upgrade.
describe('F4 POST /topics name validation', () => {
  const post = (body: unknown) =>
    fetch(`${base}/topics`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it("refuses a NEW topic name containing ':'", async () => {
    registerAgent(db, { id: 'creator', token_hash: 'x'.repeat(64), hostname: 'h' });
    const res = await post({ name: 'a:b', created_by: 'creator' });
    expect(res.status).toBe(400);
    // The row must not exist afterwards — a 400 that still created would be
    // worse than no check.
    expect(listTopics(db).map(t => t.name)).toEqual([]);
  });

  it('refuses a NEW topic name over 256 bytes, measured in BYTES', async () => {
    registerAgent(db, { id: 'creator', token_hash: 'x'.repeat(64), hostname: 'h' });
    // 200 characters of a 2-byte codepoint = 400 bytes but only 200 chars, so a
    // length check on the STRING would let this through.
    const wide = 'é'.repeat(200);
    expect(wide.length).toBe(200);
    expect(Buffer.byteLength(wide, 'utf8')).toBe(400);
    expect((await post({ name: wide, created_by: 'creator' })).status).toBe(400);
    expect(listTopics(db)).toEqual([]);
  });

  it('CONTROL: an ordinary new name is still accepted', async () => {
    registerAgent(db, { id: 'creator', token_hash: 'x'.repeat(64), hostname: 'h' });
    expect((await post({ name: 'trollbox', created_by: 'creator' })).status).toBe(201);
    expect(listTopics(db).map(t => t.name)).toEqual(['trollbox']);
  });

  it('an EXISTING colon topic is untouched — creation is refused, not the name', async () => {
    registerAgent(db, { id: 'creator', token_hash: 'x'.repeat(64), hostname: 'h' });
    // On disk before the rule existed.
    db.prepare('INSERT INTO topics (name, created_at, created_by) VALUES (?,?,?)')
      .run('legacy:topic', 1, 'creator');

    // Posting it again is a no-op create on an existing row, and must succeed.
    const res = await post({ name: 'legacy:topic', created_by: 'creator' });
    expect(res.status).toBe(201);
    expect(listTopics(db).map(t => t.name)).toEqual(['legacy:topic']);
  });
});
