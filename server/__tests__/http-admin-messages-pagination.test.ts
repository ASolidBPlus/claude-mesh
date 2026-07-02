import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, insertMessage } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// #36 — backward pagination via an opaque `before` cursor ("<sent_at>:<id>",
// derived from the oldest row of the previous page). Ordering is
// `sent_at DESC, id DESC`; the composite tie-break makes "load older" tile
// without duplicates or gaps even across rows sharing one sent_at.
describe('GET /messages — backward pagination (#36)', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  const ADMIN = 'admin-secret';
  const TOK_X = 'raw-token-x';
  let filesDir: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-page-'));
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, filesDir, new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;

    registerAgent(db, { id: 'X', token_hash: hashToken(TOK_X), hostname: 'hX' });

    // Two pairs share a sent_at (100: id1,id2 — 300: id4,id5) to exercise the
    // tie-break across page boundaries. Order (sent_at DESC, id DESC):
    //   id5, id4, id3, id2, id1
    insertMessage(db, { id: 'id1', kind: 'direct', from_agent: 'X', to_agent: 'peer', payload: '1', sent_at: 100 });
    insertMessage(db, { id: 'id2', kind: 'direct', from_agent: 'X', to_agent: 'peer', payload: '2', sent_at: 100 });
    insertMessage(db, { id: 'id3', kind: 'direct', from_agent: 'X', to_agent: 'peer', payload: '3', sent_at: 200 });
    insertMessage(db, { id: 'id4', kind: 'direct', from_agent: 'X', to_agent: 'peer', payload: '4', sent_at: 300 });
    insertMessage(db, { id: 'id5', kind: 'direct', from_agent: 'X', to_agent: 'peer', payload: '5', sent_at: 300 });
    // B↔C traffic X is not party to (for the node-scope composition test)
    insertMessage(db, { id: 'bc1', kind: 'direct', from_agent: 'B', to_agent: 'C', payload: 'x', sent_at: 250 });
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const get = (path: string, token = ADMIN) =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const rows = async (res: Response) => (await res.json()) as { id: string; sent_at: number }[];
  const cursorOf = (r: { id: string; sent_at: number }) => `${r.sent_at}:${r.id}`;

  it('two limit=2 pages + before tile the history with no duplicates or gaps (incl. shared sent_at)', async () => {
    const p1 = await rows(await get('/messages?agent=X&limit=2'));
    expect(p1.map(r => r.id)).toEqual(['id5', 'id4']);

    const p2 = await rows(await get(`/messages?agent=X&limit=2&before=${cursorOf(p1[p1.length - 1])}`));
    expect(p2.map(r => r.id)).toEqual(['id3', 'id2']);

    const p3 = await rows(await get(`/messages?agent=X&limit=2&before=${cursorOf(p2[p2.length - 1])}`));
    expect(p3.map(r => r.id)).toEqual(['id1']);

    // union tiles the full history exactly once
    const all = [...p1, ...p2, ...p3].map(r => r.id);
    expect(all).toEqual(['id5', 'id4', 'id3', 'id2', 'id1']);
    expect(new Set(all).size).toBe(5);
  });

  it('before is strictly exclusive at a shared sent_at (no re-emit of the cursor row)', async () => {
    // cursor at (300, id5) → must exclude id5, include id4 (same sent_at, id<id5)
    const r = await rows(await get('/messages?agent=X&before=300:id5'));
    expect(r.map(x => x.id)).toEqual(['id4', 'id3', 'id2', 'id1']);
  });

  it('since still works and composes with before to bound a window', async () => {
    expect((await rows(await get('/messages?agent=X&since=200'))).map(r => r.id)).toEqual(['id5', 'id4', 'id3']);
    // since>=200 AND before (300,id4) → id3 only
    expect((await rows(await get('/messages?agent=X&since=200&before=300:id4'))).map(r => r.id)).toEqual(['id3']);
  });

  it('malformed before cursor → 400', async () => {
    for (const bad of ['notacursor', ':id1', '100:', 'abc:id1']) {
      const res = await get(`/messages?before=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
    }
  });

  it('pagination composes with node-scope (#35): agent X pages its own history, never sees B↔C', async () => {
    const p1 = await rows(await get('/messages?limit=2', TOK_X));
    expect(p1.map(r => r.id)).toEqual(['id5', 'id4']);
    const p2 = await rows(await get(`/messages?limit=2&before=${cursorOf(p1[p1.length - 1])}`, TOK_X));
    // id3(200) then id2(100) — bc1(250) is X-invisible so never appears
    expect(p2.map(r => r.id)).toEqual(['id3', 'id2']);
    const everything = await rows(await get('/messages?limit=100', TOK_X));
    expect(everything.map(r => r.id)).not.toContain('bc1');
  });
});
