import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// #38 — GET /acl granted_by filter. Two shapes: agent-scoped {inbound,outbound}
// (back-compat, optionally narrowed) and the global {matches} provenance list
// (the reconciler path). Admin-only. Prefix uses LIKE with %/_/\ escaped.
describe('GET /acl — granted_by filter (#38)', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  const ADMIN = 'admin-secret';
  let filesDir: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-acl-'));
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, filesDir, new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;

    for (const id of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      registerAgent(db, { id, token_hash: hashToken(`t-${id}`), hostname: `h-${id}` });
    }
    aclGrant(db, 'A', 'B', 'spawner:lifecycle');
    aclGrant(db, 'B', 'C', 'spawner:lifecycle');
    aclGrant(db, 'A', 'C', 'mesh-chat:group:media');
    aclGrant(db, 'C', 'A', 'mesh-chat:group:media');
    aclGrant(db, 'B', 'A', 'system');
    aclGrant(db, 'A', 'D', 'ns%x');  // literal % in granted_by
    aclGrant(db, 'A', 'E', 'nsQx');  // control (no %)
    aclGrant(db, 'A', 'F', 'a_b');   // literal _ in granted_by
    aclGrant(db, 'A', 'G', 'aXb');   // control (no _)
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const get = (qs: string, token = ADMIN) =>
    fetch(`${base}/acl${qs}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  const edges = (rows: { from_agent: string; to_agent: string }[]) =>
    rows.map(r => `${r.from_agent}->${r.to_agent}`).sort();

  it('global exact granted_by → {matches} of exactly that writer\'s edges', async () => {
    const body = await (await get('?granted_by=spawner:lifecycle')).json() as { matches: any[] };
    expect(edges(body.matches)).toEqual(['A->B', 'B->C']);
  });

  it('global prefix → every edge under the namespace', async () => {
    const body = await (await get('?granted_by_prefix=mesh-chat:')).json() as { matches: any[] };
    expect(edges(body.matches)).toEqual(['A->C', 'C->A']);
    const sweep = await (await get('?granted_by_prefix=spawner:')).json() as { matches: any[] };
    expect(edges(sweep.matches)).toEqual(['A->B', 'B->C']);
  });

  it('prefix escapes LIKE metacharacters: "ns%" matches literal ns% only, not ns<any>', async () => {
    const body = await (await get('?granted_by_prefix=ns%25')).json() as { matches: any[] }; // %25 = '%'
    expect(edges(body.matches)).toEqual(['A->D']);          // ns%x, not nsQx
    expect(body.matches[0].granted_by).toBe('ns%x');
  });

  it('prefix escapes underscore: "a_" matches literal a_ only, not a<any>', async () => {
    const body = await (await get('?granted_by_prefix=a_')).json() as { matches: any[] };
    expect(edges(body.matches)).toEqual(['A->F']);          // a_b, not aXb
  });

  it('exact granted_by with a literal % round-trips', async () => {
    const body = await (await get('?granted_by=ns%25x')).json() as { matches: any[] };
    expect(edges(body.matches)).toEqual(['A->D']);
  });

  it('match rows carry from_agent, to_agent, granted_by, granted_at', async () => {
    const body = await (await get('?granted_by=system')).json() as { matches: any[] };
    expect(body.matches).toHaveLength(1);
    const row = body.matches[0];
    expect(row.from_agent).toBe('B');
    expect(row.to_agent).toBe('A');
    expect(row.granted_by).toBe('system');
    expect(typeof row.granted_at).toBe('number');
  });

  it('global query matching nothing → {matches: []} (not 404)', async () => {
    const res = await get('?granted_by=nobody');
    expect(res.status).toBe(200);
    expect((await res.json() as { matches: any[] }).matches).toEqual([]);
  });

  it('agent-scoped, composed with prefix → narrows inbound/outbound', async () => {
    const body = await (await get('?agent=A&granted_by_prefix=mesh-chat:')).json() as { inbound: any[]; outbound: any[] };
    expect(edges(body.inbound)).toEqual(['C->A']);
    expect(edges(body.outbound)).toEqual(['A->C']);
  });

  it('agent-scoped, composed with exact → narrows inbound/outbound', async () => {
    const body = await (await get('?agent=A&granted_by=system')).json() as { inbound: any[]; outbound: any[] };
    expect(edges(body.inbound)).toEqual(['B->A']);
    expect(edges(body.outbound)).toEqual([]);
  });

  it('agent only (back-compat) → full inbound/outbound, unchanged', async () => {
    const body = await (await get('?agent=A')).json() as { inbound: any[]; outbound: any[] };
    expect(edges(body.inbound)).toEqual(['B->A', 'C->A']);
    expect(edges(body.outbound)).toEqual(['A->B', 'A->C', 'A->D', 'A->E', 'A->F', 'A->G']);
  });

  it('no selector → 400', async () => {
    expect((await get('')).status).toBe(400);
  });

  it('both granted_by and granted_by_prefix → 400', async () => {
    expect((await get('?granted_by=x&granted_by_prefix=y')).status).toBe(400);
  });

  it('unknown agent → 404 (unchanged)', async () => {
    expect((await get('?agent=ghost')).status).toBe(404);
  });

  it('admin-only: no token → 401, agent token → 401 (not opened to agent tokens)', async () => {
    expect((await get('?granted_by=system', '')).status).toBe(401);
    expect((await get('?granted_by=system', 't-A')).status).toBe(401);
  });
});
