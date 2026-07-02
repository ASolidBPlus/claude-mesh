import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant } from '../../server/db.ts';
import { generateToken, hashToken } from '../../server/auth.ts';
import { startWsServer, WsServerHandle } from '../../server/ws-server.ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MeshClient, Inbound } from '../src/index.ts';

let portCounter = 25500;
function nextPort() { return portCounter++; }

// #60 (F4) — multi-file grouping via an OPTIONAL group_id passthrough, plus
// sendFile resolving { fileId } so the sender learns the stored id.
describe('sendFile groupId passthrough + fileId return (#60 F4)', () => {
  let db: Database;
  let handle: WsServerHandle;
  let port: number;
  let filesDir: string;
  const clients: MeshClient[] = [];
  let tokenA: string, tokenB: string;

  function newClient(agentId: string, token: string): MeshClient {
    const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId, agentToken: token });
    clients.push(c);
    return c;
  }
  const bytes = (s: string) => new TextEncoder().encode(s);

  beforeEach(async () => {
    db = openDb(':memory:');
    port = nextPort();
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-grouping-test-'));
    tokenA = generateToken(); tokenB = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokenA), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokenB), hostname: 'hB' });
    aclGrant(db, 'A', 'B', 'system');
    handle = await startWsServer(port, db, 10_485_760, filesDir);
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('sendFile resolves { fileId } and the recipient sees the same fileId; groupId null when ungrouped', async () => {
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);
    const got = new Promise<Inbound>((r) => b.onMessage(r));
    await b.connect();
    await a.connect();

    const res = await a.sendFile('B', { data: bytes('hello'), filename: 'f.bin' });
    expect(typeof res.fileId).toBe('string');

    const msg = await got;
    expect(msg.fileId).toBe(res.fileId);
    expect(msg.groupId).toBeNull();
  }, 10000);

  it('a shared groupId tags every file in a multi-file send', async () => {
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);
    const inbounds: Inbound[] = [];
    const twoReceived = new Promise<void>((resolve) => {
      b.onMessage((m) => { inbounds.push(m); if (inbounds.length === 2) resolve(); });
    });
    await b.connect();
    await a.connect();

    const gid = 'grp-abc';
    const r1 = await a.sendFile('B', { data: bytes('one'), filename: '1.bin', groupId: gid });
    const r2 = await a.sendFile('B', { data: bytes('two'), filename: '2.bin', groupId: gid });
    await twoReceived;

    expect(inbounds.map((m) => m.groupId)).toEqual([gid, gid]);
    expect(new Set(inbounds.map((m) => m.fileId))).toEqual(new Set([r1.fileId, r2.fileId]));
  }, 10000);

  it('groupId is preserved through offline queue + drain', async () => {
    const a = newClient('A', tokenA);
    await a.connect();
    await a.sendFile('B', { data: bytes('queued'), filename: 'q.bin', groupId: 'g-off' });

    const b = newClient('B', tokenB);
    const got = new Promise<Inbound>((r) => b.onMessage(r));
    await b.connect();
    const msg = await got;
    expect(msg.groupId).toBe('g-off');
  }, 10000);

  it('sendFile resolves { fileId: null } when the file is dropped (ttlMs:0 to an offline recipient)', async () => {
    const a = newClient('A', tokenA);
    await a.connect();
    // B is offline; ttlMs:0 = drop-if-offline → nothing stored → no fileId.
    const res = await a.sendFile('B', { data: bytes('ephemeral'), filename: 'x.bin', ttlMs: 0 });
    expect(res.fileId).toBeNull();
  }, 10000);
});
