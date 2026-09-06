import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { openDb, registerAgent, getAgentById, touchAlive, touchResponded } from '../db.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { hashToken } from '../auth.ts';

// #133 — last_responded: the agent LOOP's proof of life, distinct from the
// transport's.
//
// Measured 2026-09-06: an agent whose loop was blocked for 55 minutes had a
// last_alive fresh to the second, because the keepalive is answered by the mesh
// PLUGIN — a separate process with its own WebSocket client. last_alive is not
// wrong; it truthfully reports the transport. It is read as something it never
// claimed.
//
// SHIPS INERT. The emitter is spawner#346. Until it exists, last_responded is
// null everywhere, and null is the honest answer: "we do not know whether the
// loop is alive" is what the roster could truthfully have said all along.
describe('#133 last_responded', () => {
  let db: Database;
  let handle: WsServerHandle | undefined;
  let port: number;

  const auth = async (id: string, token: string): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    ws.send(JSON.stringify({ type: 'auth', agent_id: id, token }));
    await new Promise<void>((res) => {
      const onMsg = (d: Buffer) => {
        const m = JSON.parse(d.toString()) as { type?: string };
        if (m.type === 'auth_ok') { ws.off('message', onMsg); res(); }
      };
      ws.on('message', onMsg);
    });
    return ws;
  };

  beforeEach(async () => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'a-one', token_hash: hashToken('tok-a'), hostname: 'h' });
    handle = await startWsServer(0, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-133-')));
    port = (handle.wss.address() as { port: number }).port;
  });
  afterEach(async () => { await handle?.shutdown().catch(() => {}); handle = undefined; db?.close(); });

  it('is null on a fresh agent, and stays null while nothing writes it', () => {
    expect(getAgentById(db, 'a-one')!.last_responded).toBeNull();
  });

  // THE WHOLE POINT OF THE FIELD, and the only test that would have caught the
  // defect that motivated it: the transport's keepalive must NOT advance the
  // loop's liveness. If it did, this field would be a second copy of last_alive
  // wearing a name that promises more.
  it('a transport keepalive advances last_alive and NOT last_responded', async () => {
    const ws = await auth('a-one', 'tok-a');
    ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    await new Promise((r) => setTimeout(r, 120));

    const row = getAgentById(db, 'a-one')!;
    expect(row.last_alive).not.toBeNull();          // the transport answered
    expect(row.last_responded).toBeNull();          // the loop did not
    ws.close();
  }, 20_000);

  // ...and neither does ordinary traffic, for the same reason: the plugin sends
  // those on the agent's behalf while the loop is stuck.
  it('an ordinary send does not advance it either', async () => {
    const ws = await auth('a-one', 'tok-a');
    ws.send(JSON.stringify({ type: 'send', msg_id: crypto.randomUUID(), to: 'nobody', payload: 'x' }));
    await new Promise((r) => setTimeout(r, 120));

    expect(getAgentById(db, 'a-one')!.last_responded).toBeNull();
    ws.close();
  }, 20_000);

  // POSITIVE CONTROL. Without it, every assertion above is satisfied by a
  // column nothing can ever write — which is indistinguishable from a feature
  // that does not work.
  it('CONTROL: the loop_alive frame DOES advance it', async () => {
    const ws = await auth('a-one', 'tok-a');
    ws.send(JSON.stringify({ type: 'loop_alive' }));
    await new Promise((r) => setTimeout(r, 120));

    const row = getAgentById(db, 'a-one')!;
    expect(row.last_responded).not.toBeNull();
    expect(typeof row.last_responded).toBe('number');
    ws.close();
  }, 20_000);

  it('the two fields move independently', () => {
    touchAlive(db, 'a-one');
    const afterAlive = getAgentById(db, 'a-one')!;
    expect(afterAlive.last_alive).not.toBeNull();
    expect(afterAlive.last_responded).toBeNull();

    touchResponded(db, 'a-one');
    const afterBoth = getAgentById(db, 'a-one')!;
    expect(afterBoth.last_responded).not.toBeNull();
    // last_alive keeps its meaning AND its value — nothing is renamed or
    // repurposed to hide the difference between the two readings.
    expect(afterBoth.last_alive).toBe(afterAlive.last_alive);
  });

  it('is exposed beside last_alive in list_presence', async () => {
    const ws = await auth('a-one', 'tok-a');
    ws.send(JSON.stringify({ type: 'list_presence' }));
    const frame = await new Promise<Record<string, unknown>>((resolve) => {
      const onMsg = (d: Buffer) => {
        const m = JSON.parse(d.toString()) as Record<string, unknown>;
        if (m.type === 'presence_list') { ws.off('message', onMsg); resolve(m); }
      };
      ws.on('message', onMsg);
    });
    const agents = frame.agents as { id: string; last_alive: unknown; last_responded: unknown }[];
    const me = agents.find(a => a.id === 'a-one')!;
    expect('last_responded' in me).toBe(true);
    expect(me.last_responded).toBeNull();          // inert until the emitter ships
    ws.close();
  }, 20_000);
});
