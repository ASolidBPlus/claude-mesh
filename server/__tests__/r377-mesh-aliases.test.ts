// R-377 — Gmail-style mesh aliases. An agent logs in as `fred+x` with fred's
// own token; the alias is its own session and mailbox. A send from it is from
// `fred` by default (alias shown beside it on live delivery, so replies reach
// the plain session) or from `fred+x` with `as: 'alias'`. Every frame is
// stamped `identity: fred` by the mesh. A grant on fred covers every alias.
// The guards pinned here: an alias can't be opened with another identity's
// token; a client can't supply from/identity/alias; `+` can't be registered;
// rotating fred cuts off every alias; with no aliases nothing changes.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import { join } from 'path';
import {
  openDb, countPlusAgentIds, registerAgent, aclGrant, aclCheck, aclRelated, listAclPeers, identityOf, ownsAddress,
  deleteAgent, insertMessage, subscribe, grantObserver, getOrCreateTopic,
} from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { routeDirect } from '../router.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

let portCounter = 24700;
const nextPort = () => portCounter++;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let db: Database;
const reg = (id: string) => registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });

beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); });

describe('R-377 identity and the ACL', () => {
  it('identityOf is the part before +, and only for a local address', () => {
    expect(identityOf('fred+chat')).toBe('fred');
    expect(identityOf('fred')).toBe('fred');
    expect(identityOf('pod1:fred+x')).toBe('pod1:fred+x');
    expect(identityOf('topic:a+b')).toBe('topic:a+b');
  });

  it('a grant on fred covers every alias, in both directions, including ones never seen before', () => {
    for (const id of ['fred', 'bob']) reg(id);
    aclGrant(db, 'bob', 'fred', 'admin');
    aclGrant(db, 'fred', 'bob', 'admin');
    for (const a of ['fred+chat', 'fred+sys', 'fred+anything-new']) {
      expect(aclCheck(db, 'bob', a)).toBe(true);
      expect(aclCheck(db, a, 'bob')).toBe(true);
    }
  });

  it('NO CROSS-IDENTITY LEAK: fred\'s grant reaches no other identity, prefix look-alikes included', () => {
    for (const id of ['fred', 'freddy', 'alice', 'bob']) reg(id);
    aclGrant(db, 'bob', 'fred', 'admin');
    expect(aclCheck(db, 'bob', 'freddy+x')).toBe(false);
    expect(aclCheck(db, 'bob', 'freddy')).toBe(false);
    expect(aclCheck(db, 'bob', 'alice+fred')).toBe(false);
  });

  it('a grant naming one alias covers that alias only', () => {
    for (const id of ['fred', 'bob']) reg(id);
    aclGrant(db, 'bob', 'fred+chat', 'admin');
    expect(aclCheck(db, 'bob', 'fred+chat')).toBe(true);
    expect(aclCheck(db, 'bob', 'fred')).toBe(false);
    expect(aclCheck(db, 'bob', 'fred+sys')).toBe(false);
    // ...and an alias of an identity that doesn't exist can't be granted.
    expect(() => aclGrant(db, 'bob', 'ghost+x', 'admin')).toThrow();
  });

  it('NO ALIASES = TODAY: on a graph of plain ids, aclCheck, aclRelated and listAclPeers equal the pre-R-377 queries', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const id of ids) reg(id);
    for (const [x, y] of [['a', 'b'], ['b', 'c'], ['c', 'a'], ['d', 'e'], ['a', 'a'], ['f', 'b'], ['e', 'a']]) aclGrant(db, x!, y!, 'admin');
    aclGrant(db, 'topic:news', 'c', 'admin');
    // The old predicates, written out again on purpose: a second copy, not a call.
    const oldCheck = (x: string, y: string) => db.prepare('SELECT 1 FROM acl WHERE from_agent = ? AND to_agent = ?').get(x, y) !== null;
    const oldPeers = (x: string) => new Set((db.prepare(
      'SELECT to_agent AS peer FROM acl WHERE from_agent = ? UNION SELECT from_agent AS peer FROM acl WHERE to_agent = ?',
    ).all(x, x) as { peer: string }[]).map(r => r.peer).filter(p => p !== x));
    const all = [...ids, 'topic:news'];
    for (const x of all) {
      for (const y of all) {
        expect({ x, y, v: aclCheck(db, x, y) }).toEqual({ x, y, v: oldCheck(x, y) });
        expect({ x, y, v: aclRelated(db, x, y) }).toEqual({ x, y, v: oldCheck(x, y) || oldCheck(y, x) });
      }
      expect({ x, peers: [...listAclPeers(db, x)].sort() }).toEqual({ x, peers: [...oldPeers(x)].sort() });
    }
  });

  it('an alias session\'s presence peers are its identity\'s', () => {
    for (const id of ['fred', 'bob', 'carol']) reg(id);
    aclGrant(db, 'bob', 'fred', 'admin');
    expect([...listAclPeers(db, 'fred+x')]).toEqual(['bob']);
  });

  it('`+` can\'t be registered in an agent id', () => {
    expect(() => reg('fred+x')).toThrow();
    expect(() => reg('a+b')).toThrow();
  });

  it('ownsAddress: fred\'s token owns fred and fred+<suffix>, and nothing else', () => {
    expect(ownsAddress('fred', 'fred')).toBe(true);
    expect(ownsAddress('fred', 'fred+chat')).toBe(true);
    for (const other of ['freddy+x', 'fred+', 'fred+a+b', 'pod1:fred+x', 'bob', 'bob+fred']) expect({ other, v: ownsAddress('fred', other) }).toEqual({ other, v: false });
  });

  it('deleting fred removes what was addressed to its aliases, so a recreated fred inherits none of it', () => {
    for (const id of ['fred', 'bob']) reg(id);
    insertMessage(db, { id: 'q', kind: 'direct', from_agent: 'bob', to_agent: 'fred+x', payload: 'p', sent_at: 1, expires_at: null });
    insertMessage(db, { id: 'd', kind: 'direct', from_agent: 'bob', to_agent: 'fred+x', payload: 'p', sent_at: 2, expires_at: null });
    db.prepare("UPDATE messages SET delivered_at = 3 WHERE id = 'd'").run();
    getOrCreateTopic(db, 'news', 'bob');
    subscribe(db, 'fred+x', 'news');
    insertMessage(db, { id: 'other', kind: 'direct', from_agent: 'bob', to_agent: 'freddy+x', payload: 'p', sent_at: 1, expires_at: null });
    deleteAgent(db, 'fred');
    expect(db.prepare("SELECT id FROM messages WHERE id = 'q'").get()).toBeNull();
    expect((db.prepare("SELECT acked_at FROM messages WHERE id = 'd'").get() as { acked_at: number | null }).acked_at).not.toBeNull();
    expect(db.prepare("SELECT 1 FROM subscriptions WHERE agent_id = 'fred+x'").get()).toBeNull();
    expect(db.prepare("SELECT id FROM messages WHERE id = 'other'").get()).not.toBeNull();   // a look-alike is untouched
  });

  it('SECURITY: deleting fred removes grants naming its aliases, so a recreated fred\'s fred+chat inherits none', () => {
    for (const id of ['fred', 'freddy', 'bob']) reg(id);
    aclGrant(db, 'bob', 'fred+chat', 'admin');
    aclGrant(db, 'fred+chat', 'bob', 'admin');
    aclGrant(db, 'bob', 'freddy+chat', 'admin');   // a look-alike's grant stays
    deleteAgent(db, 'fred');
    reg('fred');
    expect(aclCheck(db, 'bob', 'fred+chat')).toBe(false);
    expect(aclCheck(db, 'fred+chat', 'bob')).toBe(false);
    expect(aclCheck(db, 'bob', 'freddy+chat')).toBe(true);
  });
});

type Frame = Record<string, unknown> & { type: string };

describe('R-377 sessions on the wire', () => {
  let handle: WsServerHandle | undefined;
  let port: number;
  const opened: WebSocket[] = [];
  afterEach(async () => {
    for (const w of opened.splice(0)) { try { w.close(); } catch { /* ignore */ } }
    await handle?.shutdown().catch(() => {});
    handle = undefined;
  });

  async function login(agentId: string, token: string, extra: Record<string, unknown> = {}): Promise<{ ws: WebSocket; reply: Frame; frames: Frame[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    opened.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const frames: Frame[] = [];
    const reply = await new Promise<Frame>((resolve) => {
      let first = true;
      ws.on('message', (data) => {
        const f = JSON.parse(data.toString()) as Frame;
        if (first) { first = false; resolve(f); return; }
        frames.push(f);
      });
      ws.send(JSON.stringify({ type: 'auth', agent_id: agentId, token, ...extra }));
    });
    await delay(50);
    return { ws, reply, frames };
  }
  const delivers = (frames: Frame[]) => frames.filter(f => f.type === 'deliver');

  beforeEach(async () => {
    for (const id of ['fred', 'bob', 'watcher']) reg(id);
    aclGrant(db, 'fred', 'bob', 'admin');
    aclGrant(db, 'bob', 'fred', 'admin');
    grantObserver(db, 'watcher', 'admin');
    port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, tmp('r377-files-'), 0, new Map());
  });

  it('an alias logs in with its identity\'s own token and is its own session beside the plain one', async () => {
    const plain = await login('fred', 'fred-tok');
    const alias = await login('fred', 'fred-tok', { alias: 'x' });
    expect(plain.reply).toMatchObject({ type: 'auth_ok', agent_id: 'fred' });
    expect(alias.reply).toMatchObject({ type: 'auth_ok', agent_id: 'fred+x' });
    expect([...handle!.agentIndex.keys()].sort()).toEqual(['fred', 'fred+x']);
    // A second login on the same alias displaces the first, and only it.
    const alias2 = await login('fred', 'fred-tok', { alias: 'x' });
    expect(alias.frames.some(f => f.code === 'DISPLACED')).toBe(true);
    expect(plain.frames.some(f => f.code === 'DISPLACED')).toBe(false);
    // The newer alias session is the one a message to fred+x reaches.
    expect(routeDirect(db, handle!.agentIndex, 'bob', { type: 'send', msg_id: 'to-x', to: 'fred+x', payload: 'p' }).ok).toBe(true);
    await delay(40);
    expect(delivers(alias2.frames).map(f => f.msg_id)).toEqual(['to-x']);
    expect(delivers(plain.frames)).toEqual([]);
  });

  it('SECURITY: an alias can\'t be opened with another identity\'s token, nor by naming the alias as the agent id', async () => {
    const stolen = await login('fred', 'bob-tok', { alias: 'x' });
    expect([stolen.reply.type, stolen.reply.code]).toEqual(['error', 'AUTH_FAILED']);
    const asId = await login('fred+x', 'fred-tok');
    expect([asId.reply.type, asId.reply.code]).toEqual(['error', 'AUTH_FAILED']);
    expect(handle!.agentIndex.has('fred+x')).toBe(false);
  });

  it('a malformed alias is refused at auth', async () => {
    for (const bad of ['', 'a+b', 'a:b', 'x'.repeat(65), 7, 'has space']) {
      const r = await login('fred', 'fred-tok', { alias: bad });
      expect({ bad, r: [r.reply.type, r.reply.code] }).toEqual({ bad, r: ['error', 'AUTH_FAILED'] });
    }
  });

  it('DEFAULT: a send from the alias is from fred with the alias beside it, and a reply to `from` reaches the plain session', async () => {
    const plain = await login('fred', 'fred-tok');
    const alias = await login('fred', 'fred-tok', { alias: 'out' });
    const bob = await login('bob', 'bob-tok');
    const watcher = await login('watcher', 'watcher-tok');
    alias.ws.send(JSON.stringify({ type: 'send', msg_id: 'm1', to: 'bob', payload: 'hi' }));
    await delay(60);
    const got = delivers(bob.frames)[0]!;
    expect([got.from, got.identity, got.alias]).toEqual(['fred', 'fred', 'fred+out']);
    expect(watcher.frames.filter(f => f.type === 'tap').map(f => [f.from, f.identity, f.alias])).toEqual([['fred', 'fred', 'fred+out']]);
    bob.ws.send(JSON.stringify({ type: 'send', msg_id: 'r1', to: got.from, payload: 'reply' }));
    await delay(60);
    expect(delivers(plain.frames).map(f => f.msg_id)).toEqual(['r1']);
    expect(delivers(alias.frames)).toEqual([]);
  });

  it('as:\'alias\': the send is from fred+x, still stamped identity fred, and a reply reaches the alias only', async () => {
    const plain = await login('fred', 'fred-tok');
    const alias = await login('fred', 'fred-tok', { alias: 'x' });
    const bob = await login('bob', 'bob-tok');
    alias.ws.send(JSON.stringify({ type: 'send', msg_id: 'm2', to: 'bob', payload: 'hi', as: 'alias' }));
    await delay(60);
    const got = delivers(bob.frames)[0]!;
    expect([got.from, got.identity, 'alias' in got]).toEqual(['fred+x', 'fred', false]);
    bob.ws.send(JSON.stringify({ type: 'send', msg_id: 'r2', to: got.from, payload: 'reply' }));
    await delay(60);
    expect(delivers(alias.frames).map(f => [f.msg_id, f.from, f.identity])).toEqual([['r2', 'bob', 'bob']]);
    expect(delivers(plain.frames)).toEqual([]);
  });

  it('SPOOF: from, identity and alias in a client frame are ignored', async () => {
    const fred = await login('fred', 'fred-tok');
    const bob = await login('bob', 'bob-tok');
    bob.ws.send(JSON.stringify({ type: 'send', msg_id: 's1', to: 'fred', payload: 'x', from: 'fred', identity: 'fred', alias: 'fred+z', as: 'alias' }));
    bob.ws.send(JSON.stringify({ type: 'publish', msg_id: 's2', topic: 'news', payload: 'x', from: 'fred', identity: 'fred' }));
    await delay(60);
    const got = delivers(fred.frames)[0]!;
    expect([got.from, got.identity, 'alias' in got]).toEqual(['bob', 'bob', false]);
  });

  it('topics: an alias subscribes on its own, and a default publish from an alias is from fred', async () => {
    const alias = await login('fred', 'fred-tok', { alias: 'x' });
    const bob = await login('bob', 'bob-tok');
    alias.ws.send(JSON.stringify({ type: 'subscribe', topic: 'news' }));
    bob.ws.send(JSON.stringify({ type: 'subscribe', topic: 'news' }));
    await delay(40);
    bob.ws.send(JSON.stringify({ type: 'publish', msg_id: 'p1', topic: 'news', payload: 'from bob' }));
    alias.ws.send(JSON.stringify({ type: 'publish', msg_id: 'p2', topic: 'news', payload: 'from alias' }));
    await delay(80);
    expect(delivers(alias.frames).map(f => [f.from, f.identity])).toContainEqual(['bob', 'bob']);
    expect(delivers(bob.frames).map(f => [f.from, f.identity, f.alias])).toContainEqual(['fred', 'fred', 'fred+x']);
  });

  it('files: a default send from an alias carries from fred and the alias', async () => {
    const alias = await login('fred', 'fred-tok', { alias: 'x' });
    const bob = await login('bob', 'bob-tok');
    alias.ws.send(JSON.stringify({ type: 'file_send', msg_id: 'f1', to: 'bob', filename: 'a.txt', data: Buffer.from('x').toString('base64') }));
    await delay(80);
    expect(bob.frames.filter(f => f.type === 'file_deliver').map(f => [f.from, f.identity, f.alias])).toEqual([['fred', 'fred', 'fred+x']]);
  });

  it('each alias has its own queue and R-335 redelivery', async () => {
    expect(routeDirect(db, new Map(), 'bob', { type: 'send', msg_id: 'qa', to: 'fred+x', payload: 'for x' }).ok).toBe(true);
    expect(routeDirect(db, new Map(), 'bob', { type: 'send', msg_id: 'qp', to: 'fred', payload: 'for plain' }).ok).toBe(true);
    const plain = await login('fred', 'fred-tok');
    expect(delivers(plain.frames).map(f => f.msg_id)).toEqual(['qp']);
    const a1 = await login('fred', 'fred-tok', { alias: 'x', capabilities: ['ack'] });
    expect(delivers(a1.frames).map(f => f.msg_id)).toEqual(['qa']);
    a1.ws.close();
    await delay(40);
    const a2 = await login('fred', 'fred-tok', { alias: 'x', capabilities: ['ack'] });
    expect(delivers(a2.frames).map(f => [f.msg_id, f.redelivered])).toEqual([['qa', true]]);
  });

  it('presence: only the plain session is fred online; an alias neither announces nor receives presence', async () => {
    const bob = await login('bob', 'bob-tok');
    const alias = await login('fred', 'fred-tok', { alias: 'x' });
    await delay(40);
    expect(bob.frames.filter(f => f.type === 'agent_status')).toEqual([]);
    expect((db.prepare("SELECT online FROM agents WHERE id = 'fred'").get() as { online: number }).online).toBe(0);
    await login('fred', 'fred-tok');
    await delay(40);
    expect(bob.frames.filter(f => f.type === 'agent_status').map(f => [f.agent_id, f.online])).toEqual([['fred', true]]);
    // bob's presence changes don't reach the alias session.
    const bob2 = await login('bob', 'bob-tok', { alias: 'y' });
    void bob2;
    expect(alias.frames.filter(f => f.type === 'agent_status')).toEqual([]);
  });

  it('status and reminders belong to the plain session', async () => {
    const alias = await login('fred', 'fred-tok', { alias: 'x' });
    alias.ws.send(JSON.stringify({ type: 'status', msg_id: 'st', status: null }));
    alias.ws.send(JSON.stringify({ type: 'remind', msg_id: 'rm', text: 'x', when: '+1h' }));
    alias.ws.send(JSON.stringify({ type: 'list_reminders', msg_id: 'lr' }));
    await delay(60);
    expect(alias.frames.filter(f => f.type === 'error').map(f => [f.ref, f.code])).toEqual([['st', 'NOT_ALLOWED'], ['rm', 'NOT_ALLOWED'], ['lr', 'NOT_ALLOWED']]);
  });
});

describe('R-377 admin: rotating or deleting fred cuts off every alias', () => {
  let handle: WsServerHandle | undefined;
  let admin: HttpAdminHandle | undefined;
  let port: number;
  let base: string;
  afterEach(async () => {
    await handle?.shutdown().catch(() => {});
    await admin?.shutdown().catch(() => {});
    handle = undefined; admin = undefined;
  });

  async function connect(alias?: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closed = new Promise<number>(r => ws.once('close', (code) => r(code)));
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    await new Promise<void>((resolve) => {
      ws.once('message', () => resolve());
      ws.send(JSON.stringify({ type: 'auth', agent_id: 'fred', token: 'fred-tok', ...(alias === undefined ? {} : { alias }) }));
    });
    return { ws, closed };
  }

  beforeEach(async () => {
    for (const id of ['fred', 'freddy']) reg(id);
    port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, tmp('r377-rot-'), 0, new Map());
    admin = await startHttpAdmin(0, db, 'adm', 10_485_760, tmp('r377-rot-admin-'), handle.agentIndex, handle.observerIndex);
    base = `http://127.0.0.1:${(admin.server.address() as net.AddressInfo).port}`;
  });

  for (const [what, method, path] of [['rotate', 'POST', '/agents/fred/rotate'], ['delete', 'DELETE', '/agents/fred']] as const) {
    it(`${what}: every fred+* session is cut off, a look-alike's isn't`, async () => {
      const a = await connect('x');
      const b = await connect('y');
      const other = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => other.once('open', () => resolve()));
      await new Promise<void>((resolve) => { other.once('message', () => resolve()); other.send(JSON.stringify({ type: 'auth', agent_id: 'freddy', token: 'freddy-tok', alias: 'x' })); });
      const res = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer adm' } });
      expect(res.status).toBe(200);
      const codes = await Promise.race([Promise.all([a.closed, b.closed]), delay(2000).then(() => 'timeout')]);
      expect(codes).not.toBe('timeout');
      await delay(50);
      expect(other.readyState).toBe(WebSocket.OPEN);
      other.close();
    });
  }
});

describe('R-377 HTTP: fred\'s token reads its aliases, and only its own', () => {
  let admin: HttpAdminHandle | undefined;
  afterEach(async () => { await admin?.shutdown().catch(() => {}); admin = undefined; });

  it('GET /messages?agent=fred+x with fred\'s token; bob\'s token is refused; with=fred+x', async () => {
    for (const id of ['fred', 'bob']) reg(id);
    insertMessage(db, { id: 'to-alias', kind: 'direct', from_agent: 'bob', to_agent: 'fred+x', payload: '1', sent_at: 10 });
    insertMessage(db, { id: 'as-alias', kind: 'direct', from_agent: 'fred+x', to_agent: 'bob', payload: '2', sent_at: 20 });
    insertMessage(db, { id: 'as-fred', kind: 'direct', from_agent: 'fred', to_agent: 'bob', payload: '3', sent_at: 30 });
    admin = await startHttpAdmin(0, db, 'adm', 10_485_760, tmp('r377-http-'), new Map());
    const base = `http://127.0.0.1:${(admin.server.address() as net.AddressInfo).port}`;
    const get = (q: string, tok: string) => fetch(`${base}${q}`, { headers: { Authorization: `Bearer ${tok}` } });
    const ids = async (r: Response) => { expect(r.status).toBe(200); return ((await r.json()) as { id: string }[]).map(m => m.id); };
    expect(await ids(await get('/messages?agent=fred%2Bx', 'fred-tok'))).toEqual(['as-alias', 'to-alias']);
    expect((await get('/messages?agent=fred%2Bx', 'bob-tok')).status).toBe(403);
    expect((await get('/messages?agent=freddy%2Bx', 'fred-tok')).status).toBe(403);
    // bob's history with the alias also finds what fred sent as itself.
    expect(await ids(await get('/messages?with=fred%2Bx', 'bob-tok'))).toEqual(['as-fred', 'as-alias', 'to-alias']);
  });
});

describe('R-377 boot refuses an existing agent id containing +', () => {
  // A row from before the grammar refused `+` would now read as an alias of its
  // prefix. Planted directly (registerAgent would refuse it), then the real
  // server is started against the file.
  const plant = (path: string, id: string | null) => {
    const d = openDb(path);
    registerAgent(d, { id: 'fred', token_hash: hashToken('fred-tok'), hostname: 'h' });
    if (id !== null) {
      d.prepare(`INSERT INTO agents (id, token_hash, hostname, capabilities, metadata, registered_at, last_seen, online)
                 VALUES (?, ?, 'h', '[]', '{}', 1, 1, 0)`).run(id, hashToken('legacy-tok'));
    }
    expect(countPlusAgentIds(d)).toBe(id === null ? 0 : 1);
    // close(true), not close(): with prepared statements still alive, Bun's
    // close() defers the real close (and its WAL checkpoint) to when they are
    // garbage-collected, which can land while the spawned server opens the
    // file (R-478). close(true) closes now.
    d.close(true);
  };
  const boot = async (path: string, ws: number, adminPort: number) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'server.ts')], {
      env: { ...process.env, MESH_ADMIN_TOKEN: 'adm', MESH_DB_PATH: path, MESH_FILES_DIR: join(path, '..', 'files'), MESH_WS_PORT: String(ws), MESH_ADMIN_PORT: String(adminPort) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const exited = await Promise.race([proc.exited, delay(8000).then(() => null)]);
    const stderr = exited === null ? '' : await new Response(proc.stderr).text();
    if (exited === null) proc.kill();
    return { exited, stderr };
  };

  it('a + id refuses to start, naming the count and never the id', async () => {
    const path = join(tmp('r377-boot-'), 'mesh.db');
    plant(path, 'old+agent-sentinel');
    const r = await boot(path, nextPort(), nextPort());
    expect(r.exited).toBe(1);
    expect(r.stderr).toContain("1 agent id(s) contain '+'");
    expect(r.stderr).not.toContain('old+agent-sentinel');
  }, 15_000);

  it('CONTROL: the same database without it starts', async () => {
    const path = join(tmp('r377-boot-'), 'mesh.db');
    plant(path, null);
    const r = await boot(path, nextPort(), nextPort());
    expect(r.exited).toBeNull();   // still running at the deadline: it started
  }, 15_000);
});
