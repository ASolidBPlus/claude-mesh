// R-382 — history knows about aliases. `GET /messages?with=<identity>` also
// returns the caller's rows with that identity's aliases (`fred+*`), and every
// history row carries `identity`, the value live delivery stamps, so a
// reloaded conversation attributes a message exactly as it arrived. The
// guards: still only the caller's own pairs, and `fred` never matches
// `freddy+x`.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import { openDb, registerAgent, aclGrant, insertMessage, pairMessagesQuery, addressSet } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

let portCounter = 24900;
const nextPort = () => portCounter++;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let db: Database;
let admin: HttpAdminHandle | undefined;
let base: string;
const reg = (id: string) => registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
const row = (id: string, from: string, to: string, at: number) =>
  insertMessage(db, { id, kind: 'direct', from_agent: from, to_agent: to, payload: id, sent_at: at, expires_at: null });

beforeEach(async () => {
  db = openDb(':memory:');
  for (const id of ['fred', 'freddy', 'bob', 'carol']) reg(id);
  admin = await startHttpAdmin(0, db, 'adm', 10_485_760, tmp('r382-'), new Map());
  base = `http://127.0.0.1:${(admin.server.address() as net.AddressInfo).port}`;
});
afterEach(async () => { await admin?.shutdown().catch(() => {}); admin = undefined; db.close(); });

type Row = { id: string; from_agent: string; identity: string };
const get = async (q: string, tok: string): Promise<Row[]> => {
  const res = await fetch(`${base}${q}`, { headers: { Authorization: `Bearer ${tok}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as Row[];
};
const ids = (rows: Row[]) => rows.map(r => r.id);

describe('R-382 with=<identity> covers its aliases', () => {
  it('with=fred and with=fred+x both return bob\'s rows with fred and every fred+*', async () => {
    row('fred-to-bob', 'fred', 'bob', 10);
    row('x-to-bob', 'fred+x', 'bob', 20);
    row('bob-to-y', 'bob', 'fred+y', 30);
    row('bob-to-fred', 'bob', 'fred', 40);
    const want = ['bob-to-fred', 'bob-to-y', 'x-to-bob', 'fred-to-bob'];
    expect(ids(await get('/messages?with=fred', 'bob-tok'))).toEqual(want);
    expect(ids(await get('/messages?with=fred%2Bx', 'bob-tok'))).toEqual(want);
  });

  it('GUARD: only the caller\'s own pairs — fred+x\'s rows with a third party never appear', async () => {
    row('x-to-carol', 'fred+x', 'carol', 10);
    row('carol-to-x', 'carol', 'fred+x', 20);
    row('fred-to-carol', 'fred', 'carol', 30);
    row('x-to-bob', 'fred+x', 'bob', 40);
    expect(ids(await get('/messages?with=fred', 'bob-tok'))).toEqual(['x-to-bob']);
    expect(ids(await get('/messages?with=fred%2Bx', 'bob-tok'))).toEqual(['x-to-bob']);
  });

  it('GUARD: fred never matches freddy, freddy+x, or a look-alike sorting next to the range', async () => {
    row('freddy-x', 'bob', 'freddy+x', 10);
    row('freddy-x-back', 'freddy+x', 'bob', 20);
    row('freddy', 'bob', 'freddy', 30);
    row('fred-x', 'bob', 'fred+x', 40);
    expect(ids(await get('/messages?with=fred', 'bob-tok'))).toEqual(['fred-x']);
    expect(ids(await get('/messages?with=freddy', 'bob-tok'))).toEqual(['freddy', 'freddy-x-back', 'freddy-x']);
  });

  it('an alias caller still reads only its own address, not its siblings\'', async () => {
    row('x-bob', 'fred+x', 'bob', 10);
    row('y-bob', 'fred+y', 'bob', 20);
    expect(ids(await get('/messages?agent=fred%2Bx&with=bob', 'fred-tok'))).toEqual(['x-bob']);
  });

  it('pages across the alias arms without gaps or duplicates', async () => {
    for (let i = 0; i < 9; i++) row(`m${i}`, ['fred', 'fred+x', 'fred+y'][i % 3]!, 'bob', 100 + i);
    const all = ids(await get('/messages?with=fred&limit=100', 'bob-tok'));
    expect(all).toHaveLength(9);
    const paged: string[] = [];
    const sizes: number[] = [];
    let cursor = '';
    for (let p = 0; p < 6; p++) {
      const rows = (await (await fetch(`${base}/messages?with=fred&limit=4${cursor}`, { headers: { Authorization: 'Bearer bob-tok' } })).json()) as (Row & { sent_at: number })[];
      sizes.push(rows.length);
      if (rows.length === 0) break;
      paged.push(...rows.map(r => r.id));
      const last = rows[rows.length - 1]!;
      cursor = `&before=${last.sent_at}:${last.id}`;
    }
    expect(paged).toEqual(all);
    expect(sizes).toEqual([4, 4, 1, 0]);
  });

  it('every arm is an index search on idx_messages_pair, with no table scan', () => {
    const peer = addressSet('fred', true);
    expect(peer).toEqual({ exact: ['fred'], aliasesOf: 'fred' });
    for (const opts of [{}, { since: 5, before: { sentAt: 100, id: 'x' }, kinds: ['direct'], limit: 20 }]) {
      const { sql, params } = pairMessagesQuery('bob', peer, opts);
      const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(r => r.detail);
      expect(detail.filter(d => d.startsWith('SEARCH messages USING INDEX idx_messages_pair'))).toHaveLength(4);
      expect(detail.filter(d => /^SCAN messages\b/.test(d))).toEqual([]);
    }
  });
});

describe('R-382 history rows carry the identity live delivery stamps', () => {
  let ws: WsServerHandle | undefined;
  let port: number;
  afterEach(async () => { await ws?.shutdown().catch(() => {}); ws = undefined; });

  async function login(agentId: string, extra: Record<string, unknown> = {}): Promise<{ sock: WebSocket; frames: Record<string, unknown>[] }> {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); sock.once('error', reject); });
    const frames: Record<string, unknown>[] = [];
    await new Promise<void>((resolve) => {
      let first = true;
      sock.on('message', (d) => { const f = JSON.parse(d.toString()); if (first) { first = false; resolve(); return; } frames.push(f); });
      sock.send(JSON.stringify({ type: 'auth', agent_id: agentId, token: `${agentId}-tok`, ...extra }));
    });
    await delay(40);
    return { sock, frames };
  }

  it('default, as:"alias" and no-alias sends: identical identity live and in history, both modes, both ports', async () => {
    aclGrant(db, 'fred', 'bob', 'admin');
    aclGrant(db, 'carol', 'bob', 'admin');
    port = nextPort();
    ws = await startWsServer(port, db, 10_485_760, tmp('r382-ws-'), 0, new Map());
    const bob = await login('bob');
    const alias = await login('fred', { alias: 'x' });
    const carol = await login('carol');
    alias.sock.send(JSON.stringify({ type: 'send', msg_id: 'default', to: 'bob', payload: '1' }));
    alias.sock.send(JSON.stringify({ type: 'send', msg_id: 'as-alias', to: 'bob', payload: '2', as: 'alias' }));
    carol.sock.send(JSON.stringify({ type: 'send', msg_id: 'plain', to: 'bob', payload: '3' }));
    await delay(80);
    const live = new Map(bob.frames.filter(f => f.type === 'deliver').map(f => [f.msg_id as string, f.identity as string]));
    expect([...live].sort()).toEqual([['as-alias', 'fred'], ['default', 'fred'], ['plain', 'carol']]);

    const wsBase = `http://127.0.0.1:${port}`;
    for (const [where, q] of [[base, '/messages'], [base, '/messages?with=fred'], [wsBase, '/messages'], [wsBase, '/messages?with=fred']] as const) {
      const rows = (await (await fetch(`${where}${q}`, { headers: { Authorization: 'Bearer bob-tok' } })).json()) as Row[];
      for (const r of rows) {
        if (live.has(r.id)) expect({ where, q, id: r.id, identity: r.identity }).toEqual({ where, q, id: r.id, identity: live.get(r.id)! });
      }
      expect(rows.filter(r => live.has(r.id)).length).toBe(q.includes('with=fred') ? 2 : 3);
    }
    for (const c of [bob, alias, carol]) c.sock.close();
  });
});

describe('R-382 follow-up: the caller side is its identity and all its aliases', () => {
  beforeEach(() => {
    for (const r of [
      ['f-b', 'fred', 'bob', 10], ['fx-b', 'fred+x', 'bob', 20], ['b-fy', 'bob', 'fred+y', 30], ['f-bz', 'fred', 'bob+z', 40],
      ['bz-fx', 'bob+z', 'fred+x', 50], ['fx-c', 'fred+x', 'carol', 60], ['c-b', 'carol', 'bob', 70],
      ['fdx-b', 'freddy+x', 'bob', 80], ['b-fd', 'bob', 'freddy', 90], ['fx-fy', 'fred+x', 'fred+y', 100],
    ] as const) row(r[0], r[1], r[2], r[3]);
  });

  it('with=bob from fred\'s token pairs {fred, fred+*} with {bob, bob+*}', async () => {
    expect(ids(await get('/messages?with=bob', 'fred-tok'))).toEqual(['bz-fx', 'f-bz', 'b-fy', 'fx-b', 'f-b']);
    expect(ids(await get('/messages?agent=fred&with=bob%2Bz', 'fred-tok'))).toEqual(['bz-fx', 'f-bz', 'b-fy', 'fx-b', 'f-b']);
  });

  it('the scan, with or without agent=fred, is all of fred\'s addresses; agent=fred+x is that alias alone', async () => {
    const all = ['fx-fy', 'fx-c', 'bz-fx', 'f-bz', 'b-fy', 'fx-b', 'f-b'];
    expect(ids(await get('/messages', 'fred-tok'))).toEqual(all);
    expect(ids(await get('/messages?agent=fred', 'fred-tok'))).toEqual(all);
    expect(ids(await get('/messages?agent=fred%2Bx', 'fred-tok'))).toEqual(['fx-fy', 'fx-c', 'bz-fx', 'fx-b']);
  });

  it('GUARD: nothing from another identity, and no freddy+*, in either mode', async () => {
    for (const q of ['/messages', '/messages?with=bob', '/messages?with=carol', '/messages?with=freddy']) {
      const got = ids(await get(q, 'fred-tok'));
      for (const foreign of ['c-b', 'fdx-b', 'b-fd']) expect({ q, has: got.includes(foreign) }).toEqual({ q, has: false });
    }
    expect(ids(await get('/messages?with=freddy', 'fred-tok'))).toEqual([]);
  });

  it('GUARD: agent=<another identity> is still 403', async () => {
    for (const other of ['bob', 'bob%2Bz', 'freddy', 'freddy%2Bx']) {
      const res = await fetch(`${base}/messages?agent=${other}`, { headers: { Authorization: 'Bearer fred-tok' } });
      expect({ other, s: res.status }).toEqual({ other, s: 403 });
    }
  });

  it('with=<self> returns fred\'s traffic between its own addresses once', async () => {
    expect(ids(await get('/messages?with=fred', 'fred-tok'))).toEqual(['fx-fy']);
  });

  it('overlapping sides (agent=fred+x, with=fred): a row on both sides comes back once', async () => {
    row('fx-note', 'fred+x', 'fred+x', 110);
    expect(ids(await get('/messages?agent=fred%2Bx&with=fred', 'fred-tok'))).toEqual(['fx-note', 'fx-fy']);
  });

  it('both sides widened: eight index searches, no table scan', () => {
    const { sql, params } = pairMessagesQuery(addressSet('fred', false), addressSet('bob', true), { since: 1, kinds: ['direct'] });
    const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(r => r.detail);
    expect(detail.filter(d => d.startsWith('SEARCH messages USING INDEX idx_messages_pair'))).toHaveLength(8);
    expect(detail.filter(d => /^SCAN messages\b/.test(d))).toEqual([]);
  });

  it('the agent port answers the same', async () => {
    const port = nextPort();
    const wsh = await startWsServer(port, db, 10_485_760, tmp('r382-wsport-'), 0, new Map());
    try {
      for (const q of ['/messages', '/messages?with=bob', '/messages?agent=fred%2Bx']) {
        const viaWs = await (await fetch(`http://127.0.0.1:${port}${q}`, { headers: { Authorization: 'Bearer fred-tok' } })).text();
        const viaAdmin = await (await fetch(`${base}${q}`, { headers: { Authorization: 'Bearer fred-tok' } })).text();
        expect({ q, b: viaWs }).toEqual({ q, b: viaAdmin });
      }
    } finally { await wsh.shutdown().catch(() => {}); }
  });
});
