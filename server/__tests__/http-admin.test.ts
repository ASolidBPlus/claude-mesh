import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant, aclCheck, setOnline, insertFile, getAgentById, getFile, insertMessage, subscribe, getOrCreateTopic } from '../db.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { hashToken } from '../auth.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('http-admin', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let port: number;
  let base: string;
  const token = 'test-admin-token';
  let filesDir: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    handle = await startHttpAdmin(0, db, token, 10_485_760, filesDir, new Map());
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

  // GET /acl — with no selector at all it's still a 400 (message widened in #38
  // now that granted_by / granted_by_prefix are also valid selectors).
  it('GET /acl — 400 if no selector (agent / granted_by / granted_by_prefix) given', async () => {
    const res = await fetch(`${base}/acl`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('one of agent, granted_by, or granted_by_prefix is required');
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
  let filesDir2: string;

  beforeEach(async () => {
    db2 = openDb(':memory:');
    filesDir2 = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    handle2 = await startHttpAdmin(0, db2, token2, 10_485_760, filesDir2, new Map());
    port2 = (handle2.server.address() as net.AddressInfo).port;
    base2 = `http://localhost:${port2}`;
  });

  afterEach(async () => {
    await handle2.shutdown().catch(() => {});
    db2.close();
  });

  it('returns raw binary with correct Content-Type and Content-Disposition headers', async () => {
    const content = 'hello from file transfer';
    const filePath = join(filesDir2, 'test-file-id');
    writeFileSync(filePath, content);
    insertFile(db2, {
      id: 'test-file-id',
      from_agent: 'a',
      to_agent: 'b',
      filename: 'hello.txt',
      content_type: 'text/plain',
      size_bytes: content.length,
      file_path: filePath,
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

// ──────────────────────────────────────────────
// POST /files
// ──────────────────────────────────────────────

describe('POST /files', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let port: number;
  let base: string;
  const token = 'files-upload-token';
  let filesDir: string;
  let agentIndex: Map<string, WebSocket>;

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    agentIndex = new Map();
    handle = await startHttpAdmin(0, db, token, 10_485_760, filesDir, agentIndex);
    port = (handle.server.address() as net.AddressInfo).port;
    base = `http://localhost:${port}`;

    registerAgent(db, { id: 'alice', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'bob', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(db, 'alice', 'bob', 'system');
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const headers = () => ({ 'Authorization': `Bearer ${token}` });

  it('201 — file stored on disk, metadata in DB, correct response shape', async () => {
    const formData = new FormData();
    formData.append('file', new File(['hello world'], 'report.txt', { type: 'text/plain' }));
    formData.append('from_agent', 'alice');
    formData.append('to_agent', 'bob');
    formData.append('caption', 'Here is the report');

    const res = await fetch(`${base}/files`, {
      method: 'POST',
      headers: headers(),
      body: formData,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.file_id).toBeDefined();
    expect(body.from_agent).toBe('alice');
    expect(body.to_agent).toBe('bob');
    expect(body.filename).toBe('report.txt');
    expect((body.content_type as string).startsWith('text/plain')).toBe(true);
    expect(body.size_bytes).toBe(11);
    expect(body.caption).toBe('Here is the report');
    expect(typeof body.sent_at).toBe('number');

    // Verify file on disk
    const fileId = body.file_id as string;
    const bunFile = Bun.file(join(filesDir, fileId));
    expect(await bunFile.exists()).toBe(true);
    expect(await bunFile.text()).toBe('hello world');

    // Verify DB record
    const record = getFile(db, fileId);
    expect(record).not.toBeNull();
    expect(record!.from_agent).toBe('alice');
    expect(record!.file_path).toContain(filesDir);
  });

  it('400 — missing required fields (no file, no from_agent)', async () => {
    const formData = new FormData();
    formData.append('to_agent', 'bob');

    const res = await fetch(`${base}/files`, {
      method: 'POST',
      headers: headers(),
      body: formData,
    });
    expect(res.status).toBe(400);
  });

  it('413 — file too large', async () => {
    // Create a server with tiny max
    const tinyHandle = await startHttpAdmin(0, db, token, 10, filesDir, agentIndex);
    const tinyPort = (tinyHandle.server.address() as net.AddressInfo).port;
    const tinyBase = `http://localhost:${tinyPort}`;

    const formData = new FormData();
    formData.append('file', new File(['x'.repeat(100)], 'big.bin', { type: 'application/octet-stream' }));
    formData.append('from_agent', 'alice');
    formData.append('to_agent', 'bob');

    const res = await fetch(`${tinyBase}/files`, {
      method: 'POST',
      headers: headers(),
      body: formData,
    });
    expect(res.status).toBe(413);

    await tinyHandle.shutdown().catch(() => {});
  });

  it('403 — ACL denied', async () => {
    registerAgent(db, { id: 'charlie', token_hash: 'c'.repeat(64), hostname: 'h3' });
    // No ACL from charlie to bob

    const formData = new FormData();
    formData.append('file', new File(['test'], 'f.txt', { type: 'text/plain' }));
    formData.append('from_agent', 'charlie');
    formData.append('to_agent', 'bob');

    const res = await fetch(`${base}/files`, {
      method: 'POST',
      headers: headers(),
      body: formData,
    });
    expect(res.status).toBe(403);
  });

  it('404 — unknown agent', async () => {
    const formData = new FormData();
    formData.append('file', new File(['test'], 'f.txt', { type: 'text/plain' }));
    formData.append('from_agent', 'ghost');
    formData.append('to_agent', 'bob');

    const res = await fetch(`${base}/files`, {
      method: 'POST',
      headers: headers(),
      body: formData,
    });
    expect(res.status).toBe(404);
  });
});

// ──────────────────────────────────────────────
// POST /agents
// ──────────────────────────────────────────────

describe('POST /agents', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let port: number;
  let base: string;
  const token = 'post-agents-token';

  beforeEach(async () => {
    db = openDb(':memory:');
    const fd = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    handle = await startHttpAdmin(0, db, token, 10_485_760, fd, new Map());
    port = (handle.server.address() as net.AddressInfo).port;
    base = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const headers = () => ({ 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' });

  it('201 — creates agent with correct response shape', async () => {
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ id: 'new-agent', hostname: 'host-1' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe('new-agent');
    expect(body.hostname).toBe('host-1');
    expect(typeof body.token).toBe('string');
    expect((body.token as string).length).toBe(64);
    expect(body.online).toBe(false);
  });

  it('201 — returned token validates against stored hash', async () => {
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ id: 'token-check', hostname: 'host-1' }),
    });
    const body = await res.json() as Record<string, unknown>;
    const rawToken = body.token as string;
    const agent = getAgentById(db, 'token-check');
    expect(agent).not.toBeNull();
    expect(hashToken(rawToken)).toBe(agent!.token_hash);
  });

  it('201 — agent appears in GET /agents list after creation', async () => {
    await fetch(`${base}/agents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ id: 'listed-agent', hostname: 'host-1' }),
    });
    const res = await fetch(`${base}/agents`, { headers: headers() });
    const body = await res.json() as Record<string, unknown>[];
    expect(body.some(a => a.id === 'listed-agent')).toBe(true);
  });

  it('400 — missing id field', async () => {
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ hostname: 'host-1' }),
    });
    expect(res.status).toBe(400);
  });

  it('400 — missing hostname field', async () => {
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ id: 'no-host' }),
    });
    expect(res.status).toBe(400);
  });

  it('400 — id is empty string', async () => {
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ id: '', hostname: 'host-1' }),
    });
    expect(res.status).toBe(400);
  });

  it('409 — duplicate agent id', async () => {
    registerAgent(db, { id: 'dup-agent', token_hash: 'x'.repeat(64), hostname: 'host-1' });
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ id: 'dup-agent', hostname: 'host-2' }),
    });
    expect(res.status).toBe(409);
  });

  it('401 — no admin token', async () => {
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      body: JSON.stringify({ id: 'a', hostname: 'h' }),
    });
    expect(res.status).toBe(401);
  });
});

// ──────────────────────────────────────────────
// DELETE /agents/:id
// ──────────────────────────────────────────────

describe('DELETE /agents/:id', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let port: number;
  let base: string;
  const token = 'delete-agents-token';

  beforeEach(async () => {
    db = openDb(':memory:');
    const fd = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    handle = await startHttpAdmin(0, db, token, 10_485_760, fd, new Map());
    port = (handle.server.address() as net.AddressInfo).port;
    base = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const headers = () => ({ 'Authorization': `Bearer ${token}` });

  it('200 — deletes agent, getAgentById returns null after', async () => {
    registerAgent(db, { id: 'del-agent', token_hash: 'd'.repeat(64), hostname: 'host-1' });
    const res = await fetch(`${base}/agents/del-agent`, { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(getAgentById(db, 'del-agent')).toBeNull();
  });

  it('200 — cascades: ACL entries for this agent are also removed', async () => {
    registerAgent(db, { id: 'a1', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'a2', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(db, 'a1', 'a2', 'system');
    await fetch(`${base}/agents/a1`, { method: 'DELETE', headers: headers() });
    expect(aclCheck(db, 'a1', 'a2')).toBe(false);
  });

  it('200 — cascades: subscriptions for this agent are also removed', async () => {
    registerAgent(db, { id: 'topic-owner', token_hash: 't'.repeat(64), hostname: 'h0' });
    registerAgent(db, { id: 'sub-agent', token_hash: 's'.repeat(64), hostname: 'h1' });
    getOrCreateTopic(db, 'test-topic', 'topic-owner');
    subscribe(db, 'sub-agent', 'test-topic');
    await fetch(`${base}/agents/sub-agent`, { method: 'DELETE', headers: headers() });
    const rows = db.prepare('SELECT * FROM subscriptions WHERE agent_id = ?').all('sub-agent');
    expect(rows).toHaveLength(0);
  });

  it('404 — agent not found', async () => {
    const res = await fetch(`${base}/agents/ghost`, { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(404);
  });

  it('401 — no admin token', async () => {
    const res = await fetch(`${base}/agents/any`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});

// ──────────────────────────────────────────────
// GET /messages
// ──────────────────────────────────────────────

describe('GET /messages', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let port: number;
  let base: string;
  const token = 'messages-admin-token';

  beforeEach(async () => {
    db = openDb(':memory:');
    const fd = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    handle = await startHttpAdmin(0, db, token, 10_485_760, fd, new Map());
    port = (handle.server.address() as net.AddressInfo).port;
    base = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const headers = () => ({ 'Authorization': `Bearer ${token}` });

  it('200 — returns messages (no filters), array response', async () => {
    insertMessage(db, { id: 'm1', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'hi', sent_at: 1000 });
    const res = await fetch(`${base}/messages`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });

  it('200 — agent filter returns messages where agent is sender OR recipient', async () => {
    insertMessage(db, { id: 'm-sent', kind: 'direct', from_agent: 'alice', to_agent: 'bob', payload: 'hi', sent_at: 1000 });
    insertMessage(db, { id: 'm-recv', kind: 'direct', from_agent: 'bob', to_agent: 'alice', payload: 'hey', sent_at: 2000 });
    insertMessage(db, { id: 'm-other', kind: 'direct', from_agent: 'bob', to_agent: 'charlie', payload: 'x', sent_at: 3000 });
    const res = await fetch(`${base}/messages?agent=alice`, { headers: headers() });
    const body = await res.json() as Record<string, unknown>[];
    expect(body).toHaveLength(2);
  });

  it('200 — topic filter returns only topic messages matching that topic', async () => {
    insertMessage(db, { id: 'm-t1', kind: 'topic', from_agent: 'a', topic: 'news', payload: 'x', sent_at: 1000 });
    insertMessage(db, { id: 'm-t2', kind: 'topic', from_agent: 'a', topic: 'sports', payload: 'y', sent_at: 2000 });
    const res = await fetch(`${base}/messages?topic=news`, { headers: headers() });
    const body = await res.json() as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect((body[0] as Record<string, unknown>).topic).toBe('news');
  });

  it('200 — since filter returns only messages with sent_at >= since', async () => {
    insertMessage(db, { id: 'm-old', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'old', sent_at: 1000 });
    insertMessage(db, { id: 'm-new', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'new', sent_at: 5000 });
    const res = await fetch(`${base}/messages?since=3000`, { headers: headers() });
    const body = await res.json() as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect((body[0] as Record<string, unknown>).id).toBe('m-new');
  });

  it('200 — limit param caps results', async () => {
    for (let i = 0; i < 10; i++) {
      insertMessage(db, { id: `m-lim-${i}`, kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'x', sent_at: i });
    }
    const res = await fetch(`${base}/messages?limit=3`, { headers: headers() });
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(3);
  });

  it('200 — default limit is 100', async () => {
    for (let i = 0; i < 105; i++) {
      insertMessage(db, { id: `m-def-${i}`, kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'x', sent_at: i });
    }
    const res = await fetch(`${base}/messages`, { headers: headers() });
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(100);
  });

  it('200 — results sorted by sent_at DESC', async () => {
    insertMessage(db, { id: 'm-first', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'x', sent_at: 100 });
    insertMessage(db, { id: 'm-second', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'y', sent_at: 200 });
    insertMessage(db, { id: 'm-third', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'z', sent_at: 300 });
    const res = await fetch(`${base}/messages`, { headers: headers() });
    const body = await res.json() as Record<string, unknown>[];
    expect(body[0].id).toBe('m-third');
    expect(body[1].id).toBe('m-second');
    expect(body[2].id).toBe('m-first');
  });

  it('401 — no admin token', async () => {
    const res = await fetch(`${base}/messages`);
    expect(res.status).toBe(401);
  });
});

// ── Route-dispatch characterization ───────────────────────────────────────
// Pins the edges a route-table extraction is most likely to drift: the
// top-level 404 fall-through, the absence of any 405 (wrong method on a known
// path falls through to 404), and exact-vs-:id precedence. These assert the
// CURRENT behaviour and must stay green across the extraction (delta 0).
describe('http-admin route dispatch (characterization)', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  const token = 'test-admin-token';
  let filesDir: string;
  const auth = () => ({ 'Authorization': `Bearer ${token}` });

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    handle = await startHttpAdmin(0, db, token, 10_485_760, filesDir, new Map());
    const port = (handle.server.address() as net.AddressInfo).port;
    base = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('unknown path → 404 {error:"not found"}', async () => {
    const res = await fetch(`${base}/nope`, { headers: auth() });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('not found');
  });

  it('unknown nested path → 404 {error:"not found"}', async () => {
    const res = await fetch(`${base}/acl/extra/segments`, { headers: auth() });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('not found');
  });

  it('wrong method on a known path falls through to 404, NOT 405 (PUT /acl)', async () => {
    const res = await fetch(`${base}/acl`, { method: 'PUT', headers: auth(), body: '{}' });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('not found');
  });

  it('wrong method on a known path falls through to 404, NOT 405 (POST /messages)', async () => {
    const res = await fetch(`${base}/messages`, { method: 'POST', headers: auth(), body: '{}' });
    expect(res.status).toBe(404);
  });

  it('wrong method on a known path falls through to 404, NOT 405 (PUT /agents)', async () => {
    const res = await fetch(`${base}/agents`, { method: 'PUT', headers: auth(), body: '{}' });
    expect(res.status).toBe(404);
  });

  it('precedence: GET /agents (list, array) vs GET /agents/:id (single object) are distinct handlers', async () => {
    registerAgent(db, { id: 'prec-agent', token_hash: hashToken('t'), hostname: 'h1' });

    const listRes = await fetch(`${base}/agents`, { headers: auth() });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(Array.isArray(list)).toBe(true);
    expect((list as Record<string, unknown>[]).some((a) => a.id === 'prec-agent')).toBe(true);

    const oneRes = await fetch(`${base}/agents/prec-agent`, { headers: auth() });
    expect(oneRes.status).toBe(200);
    const one = await oneRes.json();
    expect(Array.isArray(one)).toBe(false);
    expect((one as Record<string, unknown>).id).toBe('prec-agent');
    expect((one as Record<string, unknown>).hostname).toBe('h1');
  });

  it('precedence: GET /agents/:id for unknown id → 404 (not the list handler)', async () => {
    const res = await fetch(`${base}/agents/ghost-xyz`, { headers: auth() });
    expect(res.status).toBe(404);
  });
});
