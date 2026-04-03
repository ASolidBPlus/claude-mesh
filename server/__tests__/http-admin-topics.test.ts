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
      body: JSON.stringify({ name: 'game:moves' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('created_by is required');
  });

  it('404 if created_by agent not in registry', async () => {
    const res = await fetch(`${base}/topics`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'game:moves', created_by: 'ghost' }),
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
      body: JSON.stringify({ name: 'game:moves', created_by: 'agent-a' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      name: string;
      created_by: string;
      created_at: number;
      description: string;
      metadata: string;
    };
    expect(body.name).toBe('game:moves');
    expect(body.created_by).toBe('agent-a');
    expect(typeof body.created_at).toBe('number');
    expect(body.created_at).toBeGreaterThan(0);
    expect(body.description).toBe('');
    expect(body.metadata).toBe('{}');
  });

  it('idempotent — two POSTs with same payload both return 201, only one row exists', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    const payload = JSON.stringify({ name: 'game:moves', created_by: 'agent-a' });
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
