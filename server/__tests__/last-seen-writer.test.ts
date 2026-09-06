import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, registerAgent, aclGrant, getAgentById } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';

// #171 — `last_seen` is documented as "last acted" and had NO act-path writer.
//
// `touchAgent` is the only writer that means "acted", and since #67 removed its
// call from the keepalive path (correctly — a ping is the transport, not the
// agent) it had no production caller at all. The field's remaining writer is
// `setOnline`, on connect and disconnect. So "last acted" was a CONNECT STAMP,
// and every consumer reading it as activity — fleet views, orchestrator-MCP,
// mesh-chat, mesh_who — showed the fleet idle since its last reconnect.
//
// THE SHAPE THAT REVEALED IT is worth keeping: ten agents' `last_seen` inside a
// 1.1 s spread, two hours later. A writer that had DIED would show scattered
// staleness per agent; CLUSTERING is one event with ten rows attached, which is
// what a connect stamp looks like when read as a traffic stamp.
//
// WHY THE UNIT TEST DID NOT CATCH IT. `db.test.ts` asserts that `touchAgent`
// updates `last_seen` — true of the FUNCTION, and silent about whether anything
// calls it. Every test here therefore drives a SOCKET, not the function.

let portCounter = 20500;
const nextPort = () => portCounter++;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('#171 last_seen advances on an act, through the dispatch path', () => {
  let db: Database;
  let handle: WsServerHandle | undefined;
  let port: number;

  beforeEach(async () => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'actor', token_hash: hashToken('tok-a'), hostname: 'h' });
    registerAgent(db, { id: 'peer', token_hash: hashToken('tok-b'), hostname: 'h' });
    aclGrant(db, 'actor', 'peer', 'system');
    port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-171-')));
  });
  afterEach(async () => {
    await handle?.shutdown().catch(() => {});
    handle = undefined;
    db.close();
  });

  const auth = async (id: string, token: string): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    await new Promise<void>((res) => {
      const onMsg = (d: Buffer) => {
        if ((JSON.parse(d.toString()) as { type?: string }).type === 'auth_ok') { ws.off('message', onMsg); res(); }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ type: 'auth', agent_id: id, token }));
    });
    return ws;
  };
  const lastSeen = () => getAgentById(db, 'actor')!.last_seen;

  it('a delivered direct send advances it', async () => {
    const ws = await auth('actor', 'tok-a');
    await delay(60);
    const atConnect = lastSeen();
    // A stamp with millisecond resolution: without a wait, "advanced" and "did
    // not" are the same number.
    await delay(60);

    ws.send(JSON.stringify({ type: 'send', msg_id: crypto.randomUUID(), to: 'peer', payload: 'hi' }));
    await delay(150);

    expect(lastSeen()).toBeGreaterThan(atConnect);
    ws.close();
  }, 20_000);

  // THE EXISTING PROPERTY, and the reason #67 removed the old call. The
  // keepalive is answered by the mesh PLUGIN — a separate process — so a ping
  // advancing "last acted" would report every idle agent as active forever.
  it('CONTROL: a keepalive does NOT advance it', async () => {
    const ws = await auth('actor', 'tok-a');
    await delay(60);
    const atConnect = lastSeen();
    await delay(60);

    ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    await delay(150);

    expect(lastSeen()).toBe(atConnect);
    // ...and the ping DID land, so this is the exclusion and not a lost frame.
    expect(getAgentById(db, 'actor')!.last_alive).not.toBeNull();
    ws.close();
  }, 20_000);

  // #133's distinction, protected. `loop_alive` is the agent LOOP's proof of
  // life, not an act: it is emitted every turn whether the agent did anything
  // or not. Advancing `last_seen` on it would make "last acted" mean "the loop
  // is running" for every agent with the emitter — a second copy of
  // `last_responded` wearing the name of a different reading, which is the
  // exact conflation #133 exists to prevent.
  it('CONTROL: a loop_alive beat does NOT advance it', async () => {
    const ws = await auth('actor', 'tok-a');
    await delay(60);
    const atConnect = lastSeen();
    await delay(60);

    ws.send(JSON.stringify({ type: 'loop_alive' }));
    await delay(150);

    expect(lastSeen()).toBe(atConnect);
    // ...and it DID land: last_responded moved, so this is the exclusion.
    expect(getAgentById(db, 'actor')!.last_responded).not.toBeNull();
    ws.close();
  }, 20_000);

  it('connect still stamps it', async () => {
    expect(getAgentById(db, 'actor')!.last_seen).toBeGreaterThan(0);
    const before = lastSeen();
    await delay(60);
    const ws = await auth('actor', 'tok-a');
    await delay(100);
    expect(lastSeen()).toBeGreaterThan(before);
    ws.close();
  }, 20_000);

  // A REFUSED act still advances it, and that is deliberate: `last_seen` is
  // "last acted", not "last succeeded". An agent sending frames that are
  // refused is an agent doing something, and an operator asking "is this thing
  // alive and trying" needs the answer yes.
  it('a REFUSED send advances it too — the field is last acted, not last succeeded', async () => {
    const ws = await auth('actor', 'tok-a');
    await delay(60);
    const atConnect = lastSeen();
    await delay(60);

    // No ACL edge to 'nobody', so this is refused.
    ws.send(JSON.stringify({ type: 'send', msg_id: crypto.randomUUID(), to: 'nobody', payload: 'x' }));
    await delay(150);

    expect(lastSeen()).toBeGreaterThan(atConnect);
    ws.close();
  }, 20_000);

  // Several acts move it forward each time — it is a stamp, not a one-shot.
  it('each act moves it forward', async () => {
    const ws = await auth('actor', 'tok-a');
    await delay(60);
    ws.send(JSON.stringify({ type: 'list_presence' }));
    await delay(120);
    const first = lastSeen();
    await delay(60);
    ws.send(JSON.stringify({ type: 'list_presence' }));
    await delay(120);

    expect(lastSeen()).toBeGreaterThan(first);
    ws.close();
  }, 20_000);
});
