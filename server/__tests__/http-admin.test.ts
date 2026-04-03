import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant, aclCheck } from '../db.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { Database } from 'bun:sqlite';
import * as net from 'net';

describe('http-admin', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let port: number;
  let base: string;
  const token = 'test-admin-token';

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startHttpAdmin(0, db, token);
    port = (handle.server.address() as net.AddressInfo).port;
    base = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  // Auth tests
  it('401 without Authorization header on POST /acl', async () => {
    const res = await fetch(`${base}/acl`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('unauthorized');
  });

  it('401 with wrong token on POST /acl', async () => {
    const res = await fetch(`${base}/acl`, {
      method: 'POST',
      body: '{}',
      headers: { 'Authorization': 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  // POST /acl validation
  it('400 if from_agent missing', async () => {
    const res = await fetch(`${base}/acl`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_agent: 'agent-b' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('from_agent and to_agent are required');
  });

  it('400 if to_agent missing', async () => {
    const res = await fetch(`${base}/acl`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_agent: 'agent-a' }),
    });
    expect(res.status).toBe(400);
  });

  it('404 if from_agent not in registry', async () => {
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    const res = await fetch(`${base}/acl`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_agent: 'ghost', to_agent: 'agent-b' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('from_agent not found');
  });

  it('404 if to_agent not in registry', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    const res = await fetch(`${base}/acl`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_agent: 'agent-a', to_agent: 'ghost' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('to_agent not found');
  });

  it('POST /acl — 201 and creates ACL entry', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });

    const res = await fetch(`${base}/acl`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_agent: 'agent-a', to_agent: 'agent-b' }),
    });
    expect(res.status).toBe(201);

    const body = await res.json() as Record<string, unknown>;
    expect(body.from_agent).toBe('agent-a');
    expect(body.to_agent).toBe('agent-b');
    expect(typeof body.granted_at).toBe('number');
    expect(body.granted_by).toBe('system');

    expect(aclCheck(db, 'agent-a', 'agent-b')).toBe(true);
  });

  it('POST /acl — idempotent', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });

    const payload = JSON.stringify({ from_agent: 'agent-a', to_agent: 'agent-b' });
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    const res1 = await fetch(`${base}/acl`, { method: 'POST', headers, body: payload });
    const res2 = await fetch(`${base}/acl`, { method: 'POST', headers, body: payload });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
  });

  // DELETE /acl
  it('DELETE /acl — 200 and removes ACL entry', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');

    const res = await fetch(`${base}/acl`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_agent: 'agent-a', to_agent: 'agent-b' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(aclCheck(db, 'agent-a', 'agent-b')).toBe(false);
  });

  it('DELETE /acl — 200 even if entry did not exist', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });

    const res = await fetch(`${base}/acl`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_agent: 'agent-a', to_agent: 'agent-b' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  // GET /acl
  it('GET /acl — 400 if agent param missing', async () => {
    const res = await fetch(`${base}/acl`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('agent query param required');
  });

  it('GET /acl — 404 if agent not in registry', async () => {
    const res = await fetch(`${base}/acl?agent=ghost`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('agent not found');
  });

  it('GET /acl — 200 with correct inbound and outbound lists', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    registerAgent(db, { id: 'agent-c', token_hash: 'c'.repeat(64), hostname: 'host3' });

    // a→b: a can send to b (outbound for a)
    aclGrant(db, 'agent-a', 'agent-b', 'system');
    // c→a: c can send to a (inbound for a)
    aclGrant(db, 'agent-c', 'agent-a', 'system');

    const res = await fetch(`${base}/acl?agent=agent-a`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { inbound: unknown[]; outbound: unknown[] };
    expect(Array.isArray(body.inbound)).toBe(true);
    expect(Array.isArray(body.outbound)).toBe(true);

    expect(body.outbound).toHaveLength(1);
    expect((body.outbound[0] as Record<string, unknown>).from_agent).toBe('agent-a');
    expect((body.outbound[0] as Record<string, unknown>).to_agent).toBe('agent-b');

    expect(body.inbound).toHaveLength(1);
    expect((body.inbound[0] as Record<string, unknown>).from_agent).toBe('agent-c');
    expect((body.inbound[0] as Record<string, unknown>).to_agent).toBe('agent-a');
  });
});
