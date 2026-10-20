// R-313 — GET /messages?with=<agent>: the non-topic rows between the caller
// and one counterpart, both directions, on an index. The caller is the
// authenticated agent, or for the admin token the `agent=` it names. The
// headline: rows between two OTHER parties never come back, whatever is asked.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { join } from 'path';
import { openDb, registerAgent, insertMessage, pairMessagesQuery } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

const ADMIN = 'admin-secret';
const TOK_A = 'raw-token-a';
const TOK_B = 'raw-token-b';

describe('GET /messages?with= (R-313)', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, tmp('r313-files-'), new Map());
    base = `http://127.0.0.1:${(handle.server.address() as net.AddressInfo).port}`;
    registerAgent(db, { id: 'A', token_hash: hashToken(TOK_A), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(TOK_B), hostname: 'hB' });
    registerAgent(db, { id: 'C', token_hash: hashToken('raw-token-c'), hostname: 'hC' });

    // A <-> B, both directions, plus a file-kind row.
    insertMessage(db, { id: 'ab-1', kind: 'direct', from_agent: 'A', to_agent: 'B', payload: '1', sent_at: 10 });
    insertMessage(db, { id: 'ba-2', kind: 'direct', from_agent: 'B', to_agent: 'A', payload: '2', sent_at: 20 });
    insertMessage(db, { id: 'ab-3', kind: 'file', from_agent: 'A', to_agent: 'B', payload: '3', sent_at: 30 });
    // B's topic copy delivered to A: a B->A row, but a topic one.
    insertMessage(db, { id: 'topic-ba', kind: 'topic', from_agent: 'B', to_agent: 'A', topic: 'news', payload: 't', sent_at: 25 });
    // Third parties: A is party to none of these.
    insertMessage(db, { id: 'bc-1', kind: 'direct', from_agent: 'B', to_agent: 'C', payload: 'x', sent_at: 15 });
    insertMessage(db, { id: 'cb-2', kind: 'direct', from_agent: 'C', to_agent: 'B', payload: 'y', sent_at: 35 });
    // A <-> C, so `with=B` has another of A's own pairs to exclude.
    insertMessage(db, { id: 'ac-1', kind: 'direct', from_agent: 'A', to_agent: 'C', payload: 'z', sent_at: 12 });
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const get = (path: string, token: string) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const ids = async (res: Response) => {
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }[]).map(m => m.id);
  };

  it('returns both directions, newest first', async () => {
    expect(await ids(await get('/messages?with=B', TOK_A))).toEqual(['ab-3', 'ba-2', 'ab-1']);
    // The same pair seen from the other side.
    expect(await ids(await get('/messages?with=A', TOK_B))).toEqual(['ab-3', 'ba-2', 'ab-1']);
  });

  it('excludes topic copies, even between the same two parties', async () => {
    expect(await ids(await get('/messages?with=B', TOK_A))).not.toContain('topic-ba');
    // Positive control: without `with`, A does see that topic copy.
    expect(await ids(await get('/messages', TOK_A))).toContain('topic-ba');
  });

  it('HEADLINE: never returns rows between two other parties', async () => {
    const third = ['bc-1', 'cb-2'];
    for (const path of ['/messages?with=B', '/messages?with=C', '/messages?with=B&limit=1000', '/messages?with=C&kinds=direct']) {
      const got = await ids(await get(path, TOK_A));
      for (const id of third) expect(got).not.toContain(id);
    }
    // Admin naming A as the caller is held to A's side too.
    for (const w of ['B', 'C']) {
      const got = await ids(await get(`/messages?agent=A&with=${w}`, ADMIN));
      for (const id of third) expect(got).not.toContain(id);
    }
    expect(await ids(await get('/messages?with=C', TOK_A))).toEqual(['ac-1']);
  });

  it('an agent token can\'t use `with` to read another pair', async () => {
    const res = await get('/messages?agent=B&with=C', TOK_A);
    expect(res.status).toBe(403);
    // With no `agent=`, the caller is A, so `with=C` is the A-C pair, never B-C.
    expect(await ids(await get('/messages?with=C', TOK_A))).toEqual(['ac-1']);
  });

  it('the admin token names the caller with agent=, and needs it', async () => {
    const res = await get('/messages?with=C', ADMIN);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('agent=');
    expect(await ids(await get('/messages?agent=B&with=C', ADMIN))).toEqual(['cb-2', 'bc-1']);
  });

  it('`with` must be a well-formed id; an unknown one is just empty', async () => {
    for (const bad of ['a b', 'A%0A', 'Pod1:x', ':x', 'x:', 'a:b:c', 'pod1:a b', '%5Bfrom%5D', '']) {
      const res = await get(`/messages?with=${bad}`, TOK_A);
      expect(res.status).toBe(400);
    }
    expect(await ids(await get('/messages?with=nobody-here', TOK_A))).toEqual([]);
    expect(await ids(await get('/messages?with=pod1:nobody', TOK_A))).toEqual([]);
  });

  it('a remote counterpart (alias:agent) is matched as written', async () => {
    insertMessage(db, { id: 'a-remote', kind: 'direct', from_agent: 'A', to_agent: 'pod1:zed', payload: 'r', sent_at: 40 });
    insertMessage(db, { id: 'remote-a', kind: 'direct', from_agent: 'pod1:zed', to_agent: 'A', payload: 'r', sent_at: 41 });
    expect(await ids(await get('/messages?with=pod1:zed', TOK_A))).toEqual(['remote-a', 'a-remote']);
  });

  it('`with` and `topic` together are refused', async () => {
    expect((await get('/messages?with=B&topic=news', TOK_A)).status).toBe(400);
  });

  it('combines with kinds and since', async () => {
    expect(await ids(await get('/messages?with=B&kinds=file', TOK_A))).toEqual(['ab-3']);
    expect(await ids(await get('/messages?with=B&since=20', TOK_A))).toEqual(['ab-3', 'ba-2']);
  });

  it('pages with before/limit across both directions, with no gap or duplicate on equal sent_at', async () => {
    // 9 more rows alternating direction, three of them sharing one sent_at.
    const extra: [string, string, string, number][] = [
      ['p1', 'A', 'B', 100], ['p2', 'B', 'A', 101], ['p3', 'A', 'B', 102],
      ['p4', 'B', 'A', 103], ['p5', 'A', 'B', 103], ['p6', 'B', 'A', 103],
      ['p7', 'A', 'B', 104], ['p8', 'B', 'A', 105], ['p9', 'A', 'B', 106],
    ];
    for (const [id, from, to, at] of extra) insertMessage(db, { id, kind: 'direct', from_agent: from, to_agent: to, payload: id, sent_at: at });

    const all = await ids(await get('/messages?with=B&limit=1000', TOK_A));
    expect(all).toHaveLength(12);
    const paged: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const res = await get(`/messages?with=B&limit=4${cursor}`, TOK_A);
      const rows = (await res.json()) as { id: string; sent_at: number }[];
      if (rows.length === 0) break;
      paged.push(...rows.map(r => r.id));
      const last = rows[rows.length - 1]!;
      cursor = `&before=${last.sent_at}:${last.id}`;
    }
    expect(paged).toEqual(all);
    expect(paged.slice(0, 7)).toEqual(['p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3']);
  });

  it('a party paired with itself gets each row once', async () => {
    insertMessage(db, { id: 'aa-1', kind: 'direct', from_agent: 'A', to_agent: 'A', payload: 'note', sent_at: 50 });
    expect(await ids(await get('/messages?with=A', TOK_A))).toEqual(['aa-1']);
  });

  it('CONTROL: without `with` the response is exactly what it was', async () => {
    const want = ['ab-3', 'topic-ba', 'ba-2', 'ac-1', 'ab-1'];
    expect(await ids(await get('/messages', TOK_A))).toEqual(want);
    expect(await ids(await get('/messages?agent=A', ADMIN))).toEqual(want);
    expect(await ids(await get('/messages', ADMIN))).toEqual(['cb-2', 'ab-3', 'topic-ba', 'ba-2', 'bc-1', 'ac-1', 'ab-1']);
  });
});

describe('idx_messages_pair (R-313)', () => {
  const plan = (db: Database, a: string, b: string, opts: Parameters<typeof pairMessagesQuery>[2]) => {
    const { sql, params } = pairMessagesQuery(a, b, opts);
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(r => r.detail);
  };

  it('both arms are index ranges on idx_messages_pair, and nothing scans the table', () => {
    const db = openDb(':memory:');
    for (const opts of [{}, { since: 5, before: { sentAt: 100, id: 'x' }, kinds: ['direct', 'file'], limit: 50 }]) {
      const detail = plan(db, 'A', 'B', opts);
      expect(detail.filter(d => d.startsWith('SEARCH messages USING INDEX idx_messages_pair (from_agent=? AND to_agent=?'))).toHaveLength(2);
      expect(detail.filter(d => /^SCAN messages\b/.test(d))).toEqual([]);
    }
    const self = plan(db, 'A', 'A', {});
    expect(self.filter(d => d.startsWith('SEARCH messages USING INDEX idx_messages_pair'))).toHaveLength(1);
    expect(self.filter(d => /^SCAN messages\b/.test(d))).toEqual([]);
    db.close();
  });

  it('`before` bounds the range from above, not only the tie-break', () => {
    const db = openDb(':memory:');
    const detail = plan(db, 'A', 'B', { before: { sentAt: 100, id: 'x' } });
    expect(detail.filter(d => d.includes('idx_messages_pair (from_agent=? AND to_agent=? AND sent_at<?)'))).toHaveLength(2);
    db.close();
  });

  it('exists on a fresh database, is added to an existing one, and reopening is idempotent', () => {
    const path = join(tmp('r313-db-'), 'mesh.db');
    const indexes = (db: Database) =>
      (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_pair'").all() as { name: string; sql: string }[]);

    let db = openDb(path);
    expect(indexes(db)).toHaveLength(1);
    expect(indexes(db)[0]!.sql).toContain('WHERE topic IS NULL');
    insertMessage(db, { id: 'm1', kind: 'direct', from_agent: 'A', to_agent: 'B', payload: 'p', sent_at: 1 });
    // A database from before R-313: rows, no pair index.
    db.exec('DROP INDEX idx_messages_pair');
    db.close();

    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(String(a[0])); };
    try {
      db = openDb(path);
      expect(indexes(db)).toHaveLength(1);
      db.close();
      db = openDb(path);
      expect(indexes(db)).toHaveLength(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
      db.close();
    } finally { console.log = realLog; }
    // Built once, on the open that found it missing, and the boot line says how long.
    const built = logs.filter(l => l.includes('"db.index_built"')).map(l => JSON.parse(l));
    expect(built).toHaveLength(1);
    expect(built[0].index).toBe('idx_messages_pair');
    expect(typeof built[0].ms).toBe('number');
  }, 30_000);
});
