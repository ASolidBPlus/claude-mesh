import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, insertMessage } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// #35 — node-scoped GET /messages. The (from_agent = X OR to_agent = X) scope
// is the ENTIRE privacy boundary; these are adversarial: agent A must never
// see traffic between B and C, of ANY kind — including B's copy of a topic A is
// also subscribed to. Admin behavior must be byte-identical to before.
describe('GET /messages — node-scoped auth (#35)', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  const ADMIN = 'admin-secret';
  const TOK_A = 'raw-token-a';
  const TOK_B = 'raw-token-b';
  let filesDir: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-scope-'));
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, filesDir, new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;

    registerAgent(db, { id: 'A', token_hash: hashToken(TOK_A), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(TOK_B), hostname: 'hB' });
    registerAgent(db, { id: 'C', token_hash: hashToken('raw-token-c'), hostname: 'hC' });

    // A-party traffic
    insertMessage(db, { id: 'd-ab', kind: 'direct', from_agent: 'A', to_agent: 'B', payload: 'a→b', sent_at: 10 });
    insertMessage(db, { id: 'topic-a', kind: 'topic', from_agent: 'pub', to_agent: 'A', topic: 'news', payload: 'to-A', sent_at: 20 });
    insertMessage(db, { id: 'req-ab', kind: 'request', from_agent: 'A', to_agent: 'B', correlation_id: 'c1', payload: 'q', sent_at: 30 });
    insertMessage(db, { id: 'resp-ba', kind: 'response', from_agent: 'B', to_agent: 'A', correlation_id: 'c1', payload: 'r', sent_at: 40 });

    // B↔C traffic — A is party to NONE of it
    insertMessage(db, { id: 'd-bc', kind: 'direct', from_agent: 'B', to_agent: 'C', payload: 'b→c', sent_at: 50 });
    insertMessage(db, { id: 'topic-b', kind: 'topic', from_agent: 'pub', to_agent: 'B', topic: 'news', payload: 'to-B', sent_at: 60 }); // SAME topic as A
    insertMessage(db, { id: 'req-bc', kind: 'request', from_agent: 'B', to_agent: 'C', correlation_id: 'c2', payload: 'q', sent_at: 70 });
    insertMessage(db, { id: 'resp-cb', kind: 'response', from_agent: 'C', to_agent: 'B', correlation_id: 'c2', payload: 'r', sent_at: 80 });
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  const ids = async (res: Response) => ((await res.json()) as { id: string }[]).map(m => m.id).sort();

  it('agent A sees only its own traffic (direct, topic copy, request, response)', async () => {
    const res = await get('/messages', TOK_A);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(['d-ab', 'req-ab', 'resp-ba', 'topic-a'].sort());
  });

  it('agent A never sees B↔C traffic of any kind', async () => {
    const seen = await ids(await get('/messages', TOK_A));
    for (const hidden of ['d-bc', 'topic-b', 'req-bc', 'resp-cb']) {
      expect(seen).not.toContain(hidden);
    }
  });

  it('same-topic isolation: A filtering topic=news sees ONLY its own copy, not B\'s', async () => {
    const seen = await ids(await get('/messages?topic=news', TOK_A));
    expect(seen).toEqual(['topic-a']);
    expect(seen).not.toContain('topic-b');
  });

  it('non-admin requesting another agent\'s scope → 403', async () => {
    const res = await get('/messages?agent=B', TOK_A);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden: cannot query another agent');
  });

  it('agent passing agent=<self> is allowed and self-scoped', async () => {
    const res = await get('/messages?agent=A', TOK_A);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(['d-ab', 'req-ab', 'resp-ba', 'topic-a'].sort());
  });

  it('since/limit filters apply within the agent scope', async () => {
    const res = await get('/messages?since=35', TOK_A);
    // A-party rows with sent_at >= 35: resp-ba (40) only
    expect(await ids(res)).toEqual(['resp-ba']);
  });

  it('unknown/garbage token → 401', async () => {
    const res = await get('/messages', 'not-a-real-token');
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('unauthorized');
  });

  it('no Authorization header → 401', async () => {
    const res = await get('/messages');
    expect(res.status).toBe(401);
  });

  it('admin token → full unconstrained read (all traffic)', async () => {
    const res = await get('/messages', ADMIN);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(['d-ab', 'd-bc', 'req-ab', 'req-bc', 'resp-ba', 'resp-cb', 'topic-a', 'topic-b'].sort());
  });

  it('admin token + agent=B filter still works (unchanged)', async () => {
    const res = await get('/messages?agent=B', ADMIN);
    expect(res.status).toBe(200);
    // every row B is party to
    expect(await ids(res)).toEqual(['d-ab', 'd-bc', 'req-ab', 'req-bc', 'resp-ba', 'resp-cb', 'topic-b'].sort());
  });
});
