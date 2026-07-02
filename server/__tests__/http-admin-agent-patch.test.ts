import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, getAgentById } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// #37 + #41 — agent read/write surface: PATCH /agents/:id (metadata REPLACE +
// namespace) and namespace on POST /agents, both surfaced (parsed) in reads.
describe('agent metadata + namespace surface (#37 + #41)', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  const ADMIN = 'admin-secret';
  let filesDir: string;

  const patch = (id: string, body: unknown, token = ADMIN) =>
    fetch(`${base}/agents/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const getAgent = async (id: string) =>
    (await (await fetch(`${base}/agents/${id}`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()) as Record<string, any>;

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-patch-'));
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, filesDir, new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
    registerAgent(db, { id: 'a1', token_hash: hashToken('t'), hostname: 'h1' });
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('PATCH {metadata} round-trips as a parsed object', async () => {
    const res = await patch('a1', { metadata: { display: 'Alice', kind: 'human' } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).metadata).toEqual({ display: 'Alice', kind: 'human' });
    expect((await getAgent('a1')).metadata).toEqual({ display: 'Alice', kind: 'human' });
  });

  it('metadata is REPLACE, not merge', async () => {
    await patch('a1', { metadata: { a: 1, b: 2 } });
    await patch('a1', { metadata: { a: 9 } });
    expect((await getAgent('a1')).metadata).toEqual({ a: 9 }); // b is gone
  });

  it('PATCH {metadata} leaves namespace untouched (partial update)', async () => {
    await patch('a1', { namespace: 'team-x' });
    await patch('a1', { metadata: { x: 1 } });
    const a = await getAgent('a1');
    expect(a.namespace).toBe('team-x'); // NOT nulled by the metadata-only patch
    expect(a.metadata).toEqual({ x: 1 });
  });

  it('PATCH {namespace} leaves metadata untouched (partial update)', async () => {
    await patch('a1', { metadata: { keep: 1 } });
    await patch('a1', { namespace: 'ns' });
    const a = await getAgent('a1');
    expect(a.metadata).toEqual({ keep: 1 }); // NOT reset by the namespace-only patch
    expect(a.namespace).toBe('ns');
  });

  it('namespace can be set then cleared with null', async () => {
    await patch('a1', { namespace: 'ns' });
    expect((await getAgent('a1')).namespace).toBe('ns');
    await patch('a1', { namespace: null });
    expect((await getAgent('a1')).namespace).toBeNull();
  });

  it('oversized metadata (>4KB serialized) → 400, not silent truncation', async () => {
    const res = await patch('a1', { metadata: { big: 'x'.repeat(5000) } });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('4096');
    // unchanged — nothing was written
    expect((await getAgent('a1')).metadata).toEqual({});
  });

  it('non-object metadata → 400 (array / string / number)', async () => {
    for (const bad of [[1, 2], 'str', 42]) {
      expect((await patch('a1', { metadata: bad })).status).toBe(400);
    }
  });

  it('namespace wrong type → 400', async () => {
    expect((await patch('a1', { namespace: 123 })).status).toBe(400);
  });

  it('invalid JSON body → 400', async () => {
    const res = await fetch(`${base}/agents/a1`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('unknown agent → 404', async () => {
    expect((await patch('ghost', { namespace: 'x' })).status).toBe(404);
  });

  it('non-admin (no token / wrong token) → 401', async () => {
    const noTok = await fetch(`${base}/agents/a1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(noTok.status).toBe(401);
    expect((await patch('a1', { namespace: 'x' }, 'wrong-token')).status).toBe(401);
  });

  it('POST /agents accepts optional namespace; it persists and appears in reads', async () => {
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'a2', hostname: 'h2', namespace: 'tenant-7' }),
    });
    expect(res.status).toBe(201);
    expect((await res.json() as any).namespace).toBe('tenant-7');
    expect(getAgentById(db, 'a2')!.namespace).toBe('tenant-7');
    expect((await getAgent('a2')).namespace).toBe('tenant-7');
  });

  it('POST /agents without namespace → null; GET list includes namespace + parsed metadata', async () => {
    expect((await getAgent('a1')).namespace).toBeNull();
    const list = await (await fetch(`${base}/agents`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json() as any[];
    const a1 = list.find(a => a.id === 'a1');
    expect(a1.namespace).toBeNull();
    expect(a1.metadata).toEqual({});
  });
});
