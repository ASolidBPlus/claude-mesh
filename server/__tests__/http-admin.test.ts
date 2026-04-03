import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant, aclCheck, setOnline, insertFile } from '../db.ts';
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

  // GET /agents
  it('GET /agents — 401 without Authorization header', async () => {
    const res = await fetch(`${base}/agents`);
    expect(res.status).toBe(401);
  });

  it('GET /agents/:id — 401 without Authorization header', async () => {
    const res = await fetch(`${base}/agents/some-agent`);
    expect(res.status).toBe(401);
  });

  it('GET /agents — 200 returns all agents with correct shape', async () => {
    registerAgent(db, { id: 'list-agent-a', token_hash: 'a'.repeat(64), hostname: 'host1', capabilities: '["file-transfer"]', metadata: '{"region":"eu"}' });
    registerAgent(db, { id: 'list-agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    setOnline(db, 'list-agent-a', true);

    const res = await fetch(`${base}/agents`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>[];
    expect(body).toHaveLength(2);
    for (const agent of body) {
      expect(typeof agent.online).toBe('boolean');
      expect(Array.isArray(agent.capabilities)).toBe(true);
      expect(typeof agent.metadata).toBe('object');
    }
  });

  it('GET /agents?online=true — 200 returns only online agents', async () => {
    registerAgent(db, { id: 'online-agent', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'offline-agent', token_hash: 'b'.repeat(64), hostname: 'host2' });
    setOnline(db, 'online-agent', true);

    const res = await fetch(`${base}/agents?online=true`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('online-agent');
  });

  it('GET /agents/:id — 200 returns the agent', async () => {
    registerAgent(db, { id: 'lookup-agent', token_hash: 'l'.repeat(64), hostname: 'hosta' });

    const res = await fetch(`${base}/agents/lookup-agent`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe('lookup-agent');
    expect(typeof body.online).toBe('boolean');
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect(typeof body.metadata).toBe('object');
  });

  it('GET /agents/:id — 404 for unknown agent', async () => {
    const res = await fetch(`${base}/agents/nonexistent`, {
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

// ──────────────────────────────────────────────
// GET /files/:id
// ──────────────────────────────────────────────

describe('GET /files/:id', () => {
  let db2: Database;
  let handle2: HttpAdminHandle;
  let port2: number;
  let base2: string;
  const token2 = 'file-admin-token';

  beforeEach(async () => {
    db2 = openDb(':memory:');
    handle2 = await startHttpAdmin(0, db2, token2);
    port2 = (handle2.server.address() as net.AddressInfo).port;
    base2 = `http://localhost:${port2}`;
  });

  afterEach(async () => {
    await handle2.shutdown().catch(() => {});
    db2.close();
  });

  it('returns raw binary with correct Content-Type and Content-Disposition headers', async () => {
    const content = 'hello from file transfer';
    const data = Buffer.from(content).toString('base64');
    insertFile(db2, {
      id: 'test-file-id',
      from_agent: 'a',
      to_agent: 'b',
      filename: 'hello.txt',
      content_type: 'text/plain',
      size_bytes: content.length,
      data,
      sent_at: Date.now(),
      expires_at: null,
    });

    const res = await fetch(`${base2}/files/test-file-id`, {
      headers: { 'Authorization': `Bearer ${token2}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="hello.txt"');

    const body = await res.text();
    expect(body).toBe(content);
  });

  it('returns 404 for unknown file id', async () => {
    const res = await fetch(`${base2}/files/no-such-file`, {
      headers: { 'Authorization': `Bearer ${token2}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('file not found');
  });

  it('returns 401 without admin token', async () => {
    const res = await fetch(`${base2}/files/any-id`);
    expect(res.status).toBe(401);
  });
});
