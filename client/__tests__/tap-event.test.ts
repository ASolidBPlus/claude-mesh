import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { openDb, registerAgent, aclGrant, grantObserver, getOrCreateTopic, subscribe, upsertPeer } from '../../server/db.ts';
import { generateToken, hashToken } from '../../server/auth.ts';
import { startWsServer, type WsServerHandle } from '../../server/ws-server.ts';
import type { TapFrame as ServerTapFrame } from '../../server/tap.ts';
import { MeshClient, PeerClient, type TapFrame } from '../src/index.ts';

// The SDK surfaces observer tap frames as a `tap` event, the frame as-is.

// The client MIRRORS the server's TapFrame (it may not import server code,
// #131). Assignable both ways, or the typecheck ratchet reports a new error —
// so the mirror cannot drift from the frame the server builds.
const toClient = (f: ServerTapFrame): TapFrame => f;
const toServer = (f: TapFrame): ServerTapFrame => f;
void toClient; void toServer;

let db: Database;
let ws: WsServerHandle;
let port: number;
const tokens: Record<string, string> = {};
const clients: MeshClient[] = [];

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = log; });
}

beforeEach(async () => {
  db = openDb(':memory:');
  for (const id of ['alice', 'bob', 'watcher', 'bystander']) {
    tokens[id] = generateToken();
    registerAgent(db, { id, token_hash: hashToken(tokens[id]!), hostname: 'h' });
  }
  aclGrant(db, 'alice', 'bob', 'admin');
  // The grant is read at auth, so it precedes every connection. cross_border
  // is asked for explicitly — local-only is the default.
  grantObserver(db, 'watcher', 'system', true);
  upsertPeer(db, { alias: 'pod1', token_hash: hashToken('peer-token'), minted_by_key: 'k', kinds: '["direct"]', rate_per_min: 600 });
  aclGrant(db, 'pod1:carol', 'bob', 'admin');
  port = 30000 + Math.floor(Math.random() * 900);
  ws = await quiet(() => startWsServer(port, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-tap-'))));
});

afterEach(async () => {
  for (const c of clients.splice(0)) { try { c.close(); } catch { /* ignore */ } }
  await ws.shutdown().catch(() => {});
  db.close();
});

async function connect(id: string): Promise<{ c: MeshClient; taps: TapFrame[] }> {
  const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: id, agentToken: tokens[id]! });
  clients.push(c);
  const taps: TapFrame[] = [];
  c.on('tap', (f: TapFrame) => taps.push(f));
  await quiet(() => c.connect());
  return { c, taps };
}

const settle = () => new Promise(r => setTimeout(r, 150));

describe('SDK: the `tap` event', () => {
  it('(1) a local direct reaches the observer as a tap, frame as-is', async () => {
    const watcher = await connect('watcher');
    const alice = await connect('alice');
    await connect('bob');
    await alice.c.send('bob', 'hello');
    await settle();
    expect(watcher.taps.length).toBe(1);
    expect(watcher.taps[0]).toMatchObject({ type: 'tap', kind: 'direct', from: 'alice', to: 'bob', topic: null, payload: 'hello', size: 5 });
    expect(typeof watcher.taps[0]!.msg_id).toBe('string');
  });

  it('(2) a local topic post reaches the observer as a tap', async () => {
    getOrCreateTopic(db, 'ops', 'alice');
    subscribe(db, 'bob', 'ops');
    const watcher = await connect('watcher');
    const alice = await connect('alice');
    await alice.c.publish('ops', 'deploying');
    await settle();
    expect(watcher.taps.map(t => ({ kind: t.kind, from: t.from, to: t.to, topic: t.topic, payload: t.payload })))
      .toEqual([{ kind: 'topic', from: 'alice', to: null, topic: 'ops', payload: 'deploying' }]);
  });

  it('(3) with cross_border, an inbound cross-border direct reaches the observer', async () => {
    const watcher = await connect('watcher');
    await connect('bob');
    const peer = new PeerClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: 'pod1', agentToken: 'peer-token' });
    clients.push(peer);
    await quiet(() => peer.connect());
    await peer.relay({ type: 'relay', msg_id: `remote-${crypto.randomUUID()}`, kind: 'direct', from: 'carol', to: 'bob', payload: 'from afar', content_type: 'text/plain' });
    await settle();
    expect(watcher.taps.map(t => ({ kind: t.kind, from: t.from, to: t.to, payload: t.payload })))
      .toEqual([{ kind: 'direct', from: 'pod1:carol', to: 'bob', payload: 'from afar' }]);
  });

  it('CONTROL: a non-observer client gets no tap event for the same traffic', async () => {
    // The watcher is connected too, so "no tap" below is not "no taps were
    // sent at all" — it DID receive one.
    const watcher = await connect('watcher');
    const bystander = await connect('bystander');
    const alice = await connect('alice');
    const bob = await connect('bob');
    await alice.c.send('bob', 'private');
    await settle();
    expect(watcher.taps.length).toBe(1);
    expect(bystander.taps).toEqual([]);
    // Nor do the parties themselves: a tap is the observer's view, not theirs.
    expect(alice.taps).toEqual([]);
    expect(bob.taps).toEqual([]);
  });
});
