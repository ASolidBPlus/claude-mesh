import { describe, it, expect, afterEach, afterAll } from 'bun:test';
import { join } from 'path';
import { openDb, registerAgent, aclGrant } from '../../server/db.ts';
import { hashToken } from '../../server/auth.ts';
import { startWsServer, WsServerHandle } from '../../server/ws-server.ts';
import { tempDirs } from '../../server/__tests__/helpers/temp-dirs.ts';
import { MeshClient, type Inbound } from '../src/index.ts';

// W-1712 / R-476: send(to, text, { msgId }) for a retry-safe send. A retry
// reuses the id, and the server's DUPLICATE_MSG_ID tells the caller the first
// one already went, so nothing is delivered twice. Tested against a real
// server: the refusal must reach the caller as a typed error.

delete process.env.MESH_SERVER_URL;
delete process.env.MESH_AGENT_ID;
delete process.env.MESH_AGENT_TOKEN;

const { tmp, cleanup } = tempDirs();
afterAll(cleanup);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
let portCounter = 24400;

let ws: WsServerHandle | undefined;
let db: ReturnType<typeof openDb>;
const clients: MeshClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) { try { c.close(); } catch { /* ignore */ } }
  await ws?.shutdown().catch(() => {});
  ws = undefined;
  db.close();
});

async function pair(ackTimeoutMs?: number): Promise<{ fred: MeshClient; bob: MeshClient; got: Inbound[] }> {
  db = openDb(':memory:');
  for (const id of ['fred', 'bob']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
  aclGrant(db, 'fred', 'bob', 'admin');
  const port = portCounter++;
  ws = await startWsServer(port, db, 10_485_760, join(tmp('w1712-'), 'f'), 0, new Map());
  const fred = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: 'fred', agentToken: 'fred-tok', ...(ackTimeoutMs === undefined ? {} : { ackTimeoutMs }) });
  const bob = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: 'bob', agentToken: 'bob-tok' });
  clients.push(fred, bob);
  const got: Inbound[] = [];
  bob.onMessage((m) => { got.push(m); });
  await fred.connect();
  await bob.connect();
  return { fred, bob, got };
}
const codeOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (e: { code?: unknown }) => e.code);

describe('W-1712 send with a caller-chosen msgId', () => {
  it('the id is the message\'s id; a repeat is refused by the server as DUPLICATE_MSG_ID, and delivered once', async () => {
    const { fred, got } = await pair();
    await fred.send('bob', 'once', { msgId: 'fred:notify:42' });
    expect(await codeOf(fred.send('bob', 'once', { msgId: 'fred:notify:42' }))).toBe('DUPLICATE_MSG_ID');
    await wait(150);
    expect(got.map(m => [m.msgId, m.text])).toEqual([['fred:notify:42', 'once']]);
    // control: without msgId each send is new, as before
    await fred.send('bob', 'a');
    await fred.send('bob', 'a');
    await wait(150);
    expect(got.length).toBe(3);
  });

  it('an ACK_TIMEOUT, then a retry with the same id, is answered DUPLICATE_MSG_ID: the first one went', async () => {
    const { fred, got } = await pair(300);
    // Drop this client's acks, so the first send times out after the server
    // has already stored and delivered it.
    (fred as unknown as { onAck: (f: unknown) => void }).onAck = () => {};
    expect(await codeOf(fred.send('bob', 'hi', { msgId: 'retry-1' }))).toBe('ACK_TIMEOUT');
    delete (fred as unknown as { onAck?: unknown }).onAck;
    expect(await codeOf(fred.send('bob', 'hi', { msgId: 'retry-1' }))).toBe('DUPLICATE_MSG_ID');
    await wait(150);
    expect(got.filter(m => m.msgId === 'retry-1').length).toBe(1);
  });

  it('GUARD: a bad msgId is BAD_MSG_ID and nothing is sent', async () => {
    const { fred, got } = await pair();
    for (const bad of ['', 'has space', 'a/b', 'x'.repeat(129), 'é', 'line\nbreak', 7 as unknown as string]) {
      expect({ bad, code: await codeOf(fred.send('bob', 'no', { msgId: bad })) }).toEqual({ bad, code: 'BAD_MSG_ID' });
    }
    expect(await codeOf(fred.send('bob', 'edge', { msgId: 'x'.repeat(128) }))).toBe('resolved');
    expect(await codeOf(fred.send('bob', 'edge', { msgId: 'A-z_0.9:-' }))).toBe('resolved');
    await wait(150);
    expect(got.map(m => m.text)).toEqual(['edge', 'edge']);
  });

  it('GUARD: a second send with an id already waiting for its ack is MSG_ID_IN_FLIGHT; the first still settles', async () => {
    const { fred, got } = await pair();
    const first = fred.send('bob', 'one', { msgId: 'same' });
    const second = codeOf(fred.send('bob', 'two', { msgId: 'same' }));
    expect(await second).toBe('MSG_ID_IN_FLIGHT');
    await first;
    await wait(150);
    expect(got.map(m => m.text)).toEqual(['one']);
  });
});
