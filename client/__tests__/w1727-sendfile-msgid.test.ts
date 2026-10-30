import { describe, it, expect, afterEach, afterAll } from 'bun:test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { openDb, registerAgent, aclGrant, insertFile } from '../../server/db.ts';
import { hashToken } from '../../server/auth.ts';
import { startWsServer, WsServerHandle } from '../../server/ws-server.ts';
import { tempDirs } from '../../server/__tests__/helpers/temp-dirs.ts';
import { MeshClient, type Inbound } from '../src/index.ts';

// W-1727: sendFile(to, { msgId }) for a retry-safe file send, as W-1712 gave
// send(). A retry reuses the id; the server refuses the copy as
// DUPLICATE_MSG_ID (with the first file's id, for its own sender) before it is
// stored or delivered, so a file never arrives twice. Tested against a real
// server: the refusal and the id must reach the caller.

delete process.env.MESH_SERVER_URL;
delete process.env.MESH_AGENT_ID;
delete process.env.MESH_AGENT_TOKEN;

const { tmp, cleanup } = tempDirs();
afterAll(cleanup);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
let portCounter = 24600;

let ws: WsServerHandle | undefined;
let db: ReturnType<typeof openDb>;
const clients: MeshClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) { try { c.close(); } catch { /* ignore */ } }
  await ws?.shutdown().catch(() => {});
  ws = undefined;
  db.close();
});

async function trio(ackTimeoutMs?: number): Promise<{ fred: MeshClient; eve: MeshClient; bob: MeshClient; got: Inbound[] }> {
  db = openDb(':memory:');
  for (const id of ['fred', 'eve', 'bob']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
  aclGrant(db, 'fred', 'bob', 'admin');
  aclGrant(db, 'eve', 'bob', 'admin');
  const port = portCounter++;
  const filesDir = join(tmp('w1727-'), 'f');
  mkdirSync(filesDir, { recursive: true });
  ws = await startWsServer(port, db, 10_485_760, filesDir, 0, new Map());
  const mk = (id: string, t?: number) => new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: id, agentToken: `${id}-tok`, ...(t === undefined ? {} : { ackTimeoutMs: t }) });
  const fred = mk('fred', ackTimeoutMs), eve = mk('eve'), bob = mk('bob');
  clients.push(fred, eve, bob);
  const got: Inbound[] = [];
  bob.onMessage((m) => { got.push(m); });
  await fred.connect();
  await eve.connect();
  await bob.connect();
  return { fred, eve, bob, got };
}
const failure = async (p: Promise<unknown>): Promise<{ code?: unknown; fileId?: unknown } | 'resolved'> =>
  p.then(() => 'resolved' as const, (e: { code?: unknown; fileId?: unknown }) => ({ code: e.code, fileId: e.fileId }));
const file = (text: string, msgId?: string) => ({ data: new TextEncoder().encode(text), filename: 'a.txt', contentType: 'text/plain', ...(msgId === undefined ? {} : { msgId }) });
const filesStored = () => (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;

describe('W-1727 sendFile with a caller-chosen msgId', () => {
  it('a resend with the same id is DUPLICATE_MSG_ID, naming the first file; the file is stored and delivered once', async () => {
    const { fred, got } = await trio();
    const fileId = (await fred.sendFile('bob', file('once', 'fred:files:42:0'))).fileId!;
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await failure(fred.sendFile('bob', file('once', 'fred:files:42:0')))).toEqual({ code: 'DUPLICATE_MSG_ID', fileId });
    await wait(150);
    expect(got.filter(m => m.kind === 'file').map(m => m.fileId)).toEqual([fileId]);
    expect(filesStored()).toBe(1);
  });

  it('an ACK_TIMEOUT, then a retry with the same id: DUPLICATE_MSG_ID with the first file\'s id; the first one went', async () => {
    const { fred, got } = await trio(300);
    // Drop this client's acks, so the first file send times out after the server stored and delivered it.
    (fred as unknown as { onAck: (f: unknown) => void }).onAck = () => {};
    expect(await failure(fred.sendFile('bob', file('hi', 'retry-f1')))).toEqual({ code: 'ACK_TIMEOUT', fileId: undefined });
    delete (fred as unknown as { onAck?: unknown }).onAck;
    const again = await failure(fred.sendFile('bob', file('hi', 'retry-f1')));
    await wait(150);
    const delivered = got.filter(m => m.kind === 'file');
    expect(delivered).toHaveLength(1);
    expect(again).toEqual({ code: 'DUPLICATE_MSG_ID', fileId: delivered[0]!.fileId });
  });

  it('GUARD: another sender reusing the id is refused too, and is not told the first file\'s id', async () => {
    const { fred, eve, got } = await trio();
    const fileId = (await fred.sendFile('bob', file('mine', 'taken-1'))).fileId!;
    expect(await failure(eve.sendFile('bob', file('theirs', 'taken-1')))).toEqual({ code: 'DUPLICATE_MSG_ID', fileId: undefined });
    await wait(150);
    expect(got.filter(m => m.kind === 'file').map(m => m.fileId)).toEqual([fileId]);
  });

  it('without msgId, each file send is new, as before', async () => {
    const { fred, got } = await trio();
    const a = await fred.sendFile('bob', file('same'));
    const b = await fred.sendFile('bob', file('same'));
    expect(a.fileId).not.toBe(b.fileId);
    await wait(150);
    expect(got.filter(m => m.kind === 'file')).toHaveLength(2);
    expect(filesStored()).toBe(2);
  });

  it('a dropped send (ttlMs 0 to an offline recipient) stores nothing, so the same id stays repeatable', async () => {
    const { fred, bob } = await trio();
    bob.close();
    await wait(150);
    expect(await fred.sendFile('bob', { ...file('gone', 'drop-1'), ttlMs: 0 })).toEqual({ fileId: null });
    expect(await fred.sendFile('bob', { ...file('gone', 'drop-1'), ttlMs: 0 })).toEqual({ fileId: null });
    expect(filesStored()).toBe(0);
  });

  it('GUARD: a bad msgId is BAD_MSG_ID and nothing is sent', async () => {
    const { fred, got } = await trio();
    for (const bad of ['', 'has space', 'a/b', 'x'.repeat(129), 'é', 7 as unknown as string]) {
      expect({ bad, r: await failure(fred.sendFile('bob', file('no', bad))) }).toEqual({ bad, r: { code: 'BAD_MSG_ID', fileId: undefined } });
    }
    await wait(150);
    expect(got).toHaveLength(0);
    expect(filesStored()).toBe(0);
  });

  it('GUARD: a second file send with an id already waiting for its ack is MSG_ID_IN_FLIGHT; the first still settles', async () => {
    const { fred, got } = await trio();
    const first = fred.sendFile('bob', file('one', 'same-f'));
    expect(await failure(fred.sendFile('bob', file('two', 'same-f')))).toEqual({ code: 'MSG_ID_IN_FLIGHT', fileId: undefined });
    await first;
    await wait(150);
    expect(got.filter(m => m.kind === 'file')).toHaveLength(1);
  });

  it('GUARD: the database refuses a second stored file with the same msg_id, under routeFile\'s check', () => {
    db = openDb(':memory:');
    const row = (id: string) => ({ id, from_agent: 'fred', to_agent: 'bob', filename: 'a', content_type: 'text/plain', size_bytes: 1, file_path: `/x/${id}`, sent_at: 1, expires_at: null, msg_id: 'dup-db' });
    insertFile(db, row('f1'));
    expect(() => insertFile(db, row('f2'))).toThrow(/UNIQUE/);
    // and files with no msg_id (rows stored before this column) never collide
    insertFile(db, { ...row('f3'), msg_id: null });
    insertFile(db, { ...row('f4'), msg_id: null });
  });
});
