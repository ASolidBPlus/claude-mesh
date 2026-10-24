import { describe, it, expect, afterEach, afterAll } from 'bun:test';
import { WebSocketServer, WebSocket } from 'ws';
import { join } from 'path';
import { openDb, registerAgent, aclGrant } from '../../server/db.ts';
import { generateToken, hashToken } from '../../server/auth.ts';
import { startWsServer } from '../../server/ws-server.ts';
import { routeDirect } from '../../server/router.ts';
import { tempDirs } from '../../server/__tests__/helpers/temp-dirs.ts';
import { MeshClient, Inbound } from '../src/index.ts';

// R-335 — the SDK half of at-least-once delivery: ack after the handler
// returns (or its promise resolves), never after it throws; drop a message id
// already handled, re-acking it; pass `redelivered` through; `ack: false`
// behaves exactly as before. A stub server shows the frames; the real server
// shows the round trip.

delete process.env.MESH_SERVER_URL;
delete process.env.MESH_AGENT_ID;
delete process.env.MESH_AGENT_TOKEN;

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

let portCounter = 24400;
const nextPort = () => portCounter++;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A stub mesh: answers auth, lets the test push deliver frames, records
 *  every ack the client sends. */
async function stubMesh(): Promise<{ port: number; acks: string[]; deliver: (id: string, extra?: Record<string, unknown>) => void; close: () => Promise<void> }> {
  const port = nextPort();
  const acks: string[] = [];
  const sockets: WebSocket[] = [];
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (data) => {
      const f = JSON.parse(data.toString()) as Record<string, unknown>;
      if (f.type === 'auth') ws.send(JSON.stringify({ type: 'auth_ok', agent_id: f.agent_id, queued: 0, queued_files: 0 }));
      if (f.type === 'ack' && typeof f.msg_id === 'string') acks.push(f.msg_id);
    });
  });
  await new Promise<void>(r => wss.on('listening', () => r()));
  return {
    port, acks,
    deliver: (id, extra = {}) => sockets[sockets.length - 1]!.send(JSON.stringify({
      type: 'deliver', msg_id: id, kind: 'direct', from: 'B', to: 'A', topic: null, correlation_id: null,
      payload: `p-${id}`, content_type: 'text/plain', sent_at: 1, ...extra,
    })),
    close: () => new Promise<void>((r) => {
      for (const ws of sockets) { try { ws.terminate(); } catch { /* ignore */ } }
      let done = false;
      const finish = () => { if (!done) { done = true; r(); } };
      wss.close(finish);
      setTimeout(finish, 300);
    }),
  };
}

const clients: MeshClient[] = [];
afterEach(() => { for (const c of clients.splice(0)) { try { c.close(); } catch { /* ignore */ } } });
function client(port: number, extra: { ack?: boolean } = {}, agentId = 'A', agentToken = 'tok'): MeshClient {
  const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId, agentToken, ...extra });
  clients.push(c);
  return c;
}

describe('R-335 SDK acks (stub server)', () => {
  it('acks after the handler returns, and not when it throws', async () => {
    const mesh = await stubMesh();
    const c = client(mesh.port);
    const seen: string[] = [];
    c.onMessage((m) => { seen.push(m.msgId); if (m.msgId === 'bad') throw new Error('handler failed'); });
    await c.connect();
    mesh.deliver('ok-1');
    mesh.deliver('bad');
    mesh.deliver('ok-2');
    await wait(80);
    expect(seen).toEqual(['ok-1', 'bad', 'ok-2']);
    expect(mesh.acks).toEqual(['ok-1', 'ok-2']);
    await mesh.close();
  });

  it('an async handler is acked when its promise resolves, never when it rejects', async () => {
    const mesh = await stubMesh();
    const c = client(mesh.port);
    const ackedBeforeResolve: string[][] = [];
    c.onMessage(async (m) => {
      await wait(40);
      ackedBeforeResolve.push([...mesh.acks]);
      if (m.msgId === 'reject') throw new Error('async failure');
    });
    await c.connect();
    mesh.deliver('resolve');
    await wait(100);
    mesh.deliver('reject');
    await wait(100);
    expect(ackedBeforeResolve[0]).toEqual([]);   // not acked while still running
    expect(mesh.acks).toEqual(['resolve']);
    await mesh.close();
  });

  it('a duplicate of a handled id is dropped and re-acked; redelivered is passed through', async () => {
    const mesh = await stubMesh();
    const c = client(mesh.port);
    const got: Inbound[] = [];
    c.onMessage((m) => { got.push(m); });
    await c.connect();
    mesh.deliver('m1');
    mesh.deliver('m1', { redelivered: true });
    mesh.deliver('m2', { redelivered: true });
    await wait(80);
    expect(got.map(m => [m.msgId, m.redelivered])).toEqual([['m1', false], ['m2', true]]);
    expect(mesh.acks).toEqual(['m1', 'm1', 'm2']);
    await mesh.close();
  });

  it('a failed id is not marked handled, so its redelivery runs the handler again', async () => {
    const mesh = await stubMesh();
    const c = client(mesh.port);
    let calls = 0;
    c.onMessage(() => { calls++; if (calls === 1) throw new Error('first try fails'); });
    await c.connect();
    mesh.deliver('m1');
    mesh.deliver('m1', { redelivered: true });
    await wait(80);
    expect(calls).toBe(2);
    expect(mesh.acks).toEqual(['m1']);
    await mesh.close();
  });

  it('a redelivery that arrives while the async handler still runs is dropped without an ack', async () => {
    const mesh = await stubMesh();
    const c = client(mesh.port);
    let calls = 0;
    c.onMessage(async () => { calls++; await wait(80); });
    await c.connect();
    mesh.deliver('slow');
    await wait(10);
    mesh.deliver('slow', { redelivered: true });
    await wait(150);
    expect(calls).toBe(1);
    expect(mesh.acks).toEqual(['slow']);
    await mesh.close();
  });

  it('remembers the last 1000 handled ids: the 1001st-oldest runs again', async () => {
    const mesh = await stubMesh();
    const c = client(mesh.port);
    const counts = new Map<string, number>();
    c.onMessage((m) => { counts.set(m.msgId, (counts.get(m.msgId) ?? 0) + 1); });
    await c.connect();
    for (let i = 0; i <= 1000; i++) mesh.deliver(`id-${i}`);   // 1001 ids: id-0 is evicted
    await wait(300);
    mesh.deliver('id-1');     // still remembered
    mesh.deliver('id-0');     // forgotten
    await wait(80);
    expect(counts.get('id-1')).toBe(1);
    expect(counts.get('id-0')).toBe(2);
    await mesh.close();
  });

  it('ack: false sends no acks and does not dedupe', async () => {
    const mesh = await stubMesh();
    const c = client(mesh.port, { ack: false });
    let calls = 0;
    c.onMessage(() => { calls++; });
    await c.connect();
    mesh.deliver('m1');
    mesh.deliver('m1');
    await wait(80);
    expect(calls).toBe(2);
    expect(mesh.acks).toEqual([]);
    await mesh.close();
  });

  it('file deliveries are not acked', async () => {
    const mesh = await stubMesh();
    const c = client(mesh.port);
    const got: string[] = [];
    c.onMessage((m) => { got.push(m.kind); });
    await c.connect();
    mesh.deliver('m1');
    await wait(30);
    // A file_deliver goes through the same handler; only messages are acked.
    mesh.deliver('f1', {
      type: 'file_deliver', file_id: 'f1', filename: 'x.txt', size_bytes: 1, fetch_url: '/files/f1', caption: null, reply_to_msg_id: null, group_id: null,
    });
    await wait(80);
    expect(got).toEqual(['direct', 'file']);
    expect(mesh.acks).toEqual(['m1']);
    await mesh.close();
  });
});

describe('R-335 SDK against the real server', () => {
  it('the round trip: a thrown handler gets the message again on the next login; a handled one does not', async () => {
    const db = openDb(':memory:');
    const tokA = generateToken();
    const tokB = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokA), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokB), hostname: 'hB' });
    aclGrant(db, 'B', 'A', 'system');
    const port = nextPort();
    const handle = await startWsServer(port, db, 10_485_760, join(tmp('r335-sdk-'), 'files'), 0, new Map());
    try {
      for (const id of ['keep', 'fail']) {
        expect(routeDirect(db, new Map(), 'B', { type: 'send', msg_id: id, to: 'A', payload: id }).ok).toBe(true);
      }
      const first = client(port, {}, 'A', tokA);
      const firstGot: string[] = [];
      first.onMessage((m) => { firstGot.push(m.msgId); if (m.msgId === 'fail') throw new Error('handler failed'); });
      await first.connect();
      await wait(100);
      first.close();
      await wait(50);
      expect(firstGot).toEqual(['keep', 'fail']);

      const second = client(port, {}, 'A', tokA);
      const secondGot: [string, boolean | undefined][] = [];
      second.onMessage((m) => { secondGot.push([m.msgId, m.redelivered]); });
      await second.connect();
      await wait(100);
      expect(secondGot).toEqual([['fail', true]]);
      second.close();
      await wait(50);

      // Handled this time, so a third login gets nothing.
      const third = client(port, {}, 'A', tokA);
      const thirdGot: string[] = [];
      third.onMessage((m) => { thirdGot.push(m.msgId); });
      await third.connect();
      await wait(100);
      expect(thirdGot).toEqual([]);
    } finally {
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);
});
