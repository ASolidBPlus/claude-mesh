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
import { openDb, registerAgent, aclGrant, insertMessage, pairMessagesQuery, pairCounterparts } from '../db.ts';
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
    const { exact, aliasesOf } = pairCounterparts('bob', 'fred');
    expect({ exact, aliasesOf }).toEqual({ exact: ['fred'], aliasesOf: 'fred' });
    for (const opts of [{ aliasesOf }, { aliasesOf, since: 5, before: { sentAt: 100, id: 'x' }, kinds: ['direct'], limit: 20 }]) {
      const { sql, params } = pairMessagesQuery('bob', exact, opts);
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
