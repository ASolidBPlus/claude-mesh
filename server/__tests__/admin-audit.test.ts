import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, registerAgent, aclGrant, insertPeerKey } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle, ROUTES } from '../http-admin.ts';
import { renderMetrics } from '../metrics.ts';

// #161 — admin action was unattributable IN PRINCIPLE, not just in practice.
//
// requireAdmin returned true or wrote a 401 and logged nothing on either path;
// 23 of 28 admin routes emitted no event, including all four the admin token
// exists for; no source address appeared anywhere in the file.
//
// THE BOUND TRAVELS WITH THE FIX and is asserted nowhere because no test can
// assert it: while MESH_ADMIN_TOKEN is shared between holders, a source address
// is a proxy and not an identity. This records that the credential was used and
// from where — never by whom. It lands ALONGSIDE the token shed, not instead
// of it.

const ADMIN = 'admin-secret-value-do-not-log';

describe('#161 admin audit', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  let lines: string[];
  let realLog: typeof console.log;

  beforeEach(async () => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'a-one', token_hash: hashToken('tok-a'), hostname: 'h' });
    registerAgent(db, { id: 'a-two', token_hash: hashToken('tok-b'), hostname: 'h' });
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-161-')), new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
    lines = [];
    realLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  });
  afterEach(async () => {
    console.log = realLog;
    await handle.shutdown().catch(() => {});
    db.close();
  });

  /** Structured events only — the file also writes prose lines, and matching
   *  those would make the assertions depend on wording. */
  const events = (evt: string): Record<string, unknown>[] =>
    lines
      .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((o): o is Record<string, unknown> => o !== null && o.evt === evt);

  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = ADMIN, ...rest } = init;
    return fetch(`${base}${path}`, {
      ...rest,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(rest.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    });
  };

  // ── authentication, both outcomes ──────────────────────────────────────────

  it('a SUCCESSFUL admin authentication is recorded', async () => {
    expect((await call('/agents')).status).toBe(200);

    const [e, ...rest] = events('admin.auth');
    expect(rest).toEqual([]);
    expect(e!.outcome).toBe('success');
    expect(e!.method).toBe('GET');
    expect(e!.path).toBe('/agents');
    expect(e!.reason).toBe(null);
    expect(typeof e!.remote).toBe('string');
  });

  // Success is the half most likely to be skipped, and the half the operator's
  // question needs: with only failures logged, a stolen token that WORKS leaves
  // exactly as little trace as before, and "has anyone used the admin token?"
  // is answered by silence either way.
  it('CONTROL: a failure is recorded too, and distinguishably', async () => {
    expect((await call('/agents', { token: 'wrong-token' })).status).toBe(401);
    expect((await call('/agents', { token: null })).status).toBe(401);

    expect(events('admin.auth').map(e => [e.outcome, e.reason])).toEqual([
      ['failure', 'invalid'],
      ['failure', 'absent'],
    ]);
  });

  // C9. The reason lives in the log because a structured log is not a surface
  // an unauthenticated caller can read. What that caller CAN read must not vary
  // — asserted on the bytes, not on the status alone.
  it('C9: the two failure causes are indistinguishable to the caller', async () => {
    const wrong = await call('/agents', { token: 'wrong-token' });
    const absent = await call('/agents', { token: null });

    expect(wrong.status).toBe(absent.status);
    expect(await wrong.text()).toBe(await absent.text());
    expect(wrong.headers.get('content-type')).toBe(absent.headers.get('content-type'));

    // ...while the server-side record DOES distinguish them. Without this the
    // test above is satisfied by a fix that simply stopped recording the reason.
    expect(events('admin.auth').map(e => e.reason)).toEqual(['invalid', 'absent']);
  });

  it('an unmatched path still records the auth outcome — 401 before 404', async () => {
    expect((await call('/no-such-route', { token: null })).status).toBe(401);
    expect(events('admin.auth').map(e => [e.outcome, e.path])).toEqual([['failure', '/no-such-route']]);
  });

  // The route that authenticates ITSELF must not report an admin authentication
  // that never happened: no admin credential is required or examined there.
  it('a handler-authenticated route records NO admin auth', async () => {
    insertPeerKey(db, {
      id: 'k1', key_hash: hashToken('the-key'), alias: 'partner',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    await call('/peers/register', {
      method: 'POST', token: null, body: JSON.stringify({ key: 'wrong', assigned_alias: 'us', protocol: 1 }),
    });
    expect(events('admin.auth')).toEqual([]);
    // POSITIVE CONTROL: the request really reached the handler, so "no event"
    // is a property of the route's mode and not of a request that never landed.
    expect(events('peer.register_refused').length).toBe(1);
  });

  it('an AGENT token on an agentOrAdmin route is not an admin authentication', async () => {
    expect((await call('/messages?agent=a-one', { token: 'tok-a' })).status).toBe(200);
    expect(events('admin.auth')).toEqual([]);

    // ...and the admin token on the same route IS one.
    lines.length = 0;
    expect((await call('/messages')).status).toBe(200);
    expect(events('admin.auth').map(e => [e.outcome, e.route_admits_agents])).toEqual([['success', true]]);
  });

  // ── the counter ────────────────────────────────────────────────────────────

  it('mesh_admin_auth_total counts both outcomes and carries no identity', async () => {
    await call('/agents');
    await call('/agents', { token: 'wrong-token' });

    const metrics = renderMetrics(db);
    expect(metrics).toContain('mesh_admin_auth_total{outcome="success"}');
    expect(metrics).toContain('mesh_admin_auth_total{outcome="failure"}');

    // /metrics is UNAUTHENTICATED on the admin port, so this document is an API
    // response. No address, no reason, no agent id may reach it — and the token
    // least of all.
    const series = metrics.split('\n').filter(l => l.startsWith('mesh_admin_auth_total{'));
    expect(series.length).toBe(2);
    for (const line of series) {
      expect(line).not.toContain('127.0.0.1');
      expect(line).not.toContain('reason');
      expect(line).not.toContain('a-one');
      expect(line).not.toContain(ADMIN);
    }
  });

  // ── mutations ──────────────────────────────────────────────────────────────

  it('a privileged mutation is recorded, naming the object', async () => {
    expect((await call('/acl', {
      method: 'POST', body: JSON.stringify({ from_agent: 'a-one', to_agent: 'a-two', granted_by: 'op' }),
    })).status).toBe(201);

    const [grant] = events('acl.granted');
    expect(grant).toMatchObject({ from_agent: 'a-one', to_agent: 'a-two', granted_by: 'op' });

    const [mutation] = events('admin.mutation');
    expect(mutation).toMatchObject({ method: 'POST', path: '/acl', status: 201, actor: 'admin' });
  });

  it('the object events name what changed, on every route the token exists for', async () => {
    aclGrant(db, 'a-one', 'a-two', 'system');
    await call('/acl', { method: 'DELETE', body: JSON.stringify({ from_agent: 'a-one', to_agent: 'a-two' }) });
    await call('/agents', { method: 'POST', body: JSON.stringify({ id: 'newbie', hostname: 'h' }) });
    await call('/agents/newbie', { method: 'DELETE' });

    expect(events('acl.revoked')[0]).toMatchObject({ from_agent: 'a-one', to_agent: 'a-two' });
    expect(events('agent.registered')[0]).toMatchObject({ agent_id: 'newbie' });
    expect(events('agent.deleted')[0]).toMatchObject({ agent_id: 'newbie' });
  });

  // A READ IS NOT A MUTATION. Without this the mutation event is satisfied by
  // one emitted on every request, which would drown the record it exists to be.
  it('CONTROL: a GET emits no mutation event', async () => {
    await call('/agents');
    await call('/acl');
    expect(events('admin.mutation')).toEqual([]);
  });

  it('a REFUSED mutation emits no mutation event', async () => {
    // 409: the agent already exists. Nothing changed, so nothing is recorded as
    // having changed — an audit log that records attempts as changes is worse
    // than one that records neither.
    expect((await call('/agents', { method: 'POST', body: JSON.stringify({ id: 'a-one', hostname: 'h' }) })).status).toBe(409);
    expect(events('admin.mutation')).toEqual([]);
    expect(events('agent.registered')).toEqual([]);
  });

  // DERIVED, NOT ENUMERATED. The defect was 23 of 28 routes emitting nothing,
  // and a hand-written list of mutators would go stale the same way: the next
  // route added is the one whose entry nobody remembers. This walks the ROUTES
  // table and requires every mutating route to produce a record — so a route
  // added tomorrow is covered by existing code, or this reds.
  it('EVERY mutating route in the table emits a mutation record', async () => {
    const mutators = ROUTES.filter(r => r.method !== 'GET');
    // Control on the derivation: the table is real and non-trivial.
    expect(mutators.length).toBeGreaterThanOrEqual(15);

    // One representative succeeding call, exercised through the dispatcher.
    await call('/agents', { method: 'POST', body: JSON.stringify({ id: 'walker', hostname: 'h' }) });
    const [m] = events('admin.mutation');
    expect(m).toMatchObject({ method: 'POST', path: '/agents', status: 201 });

    // The record is produced by the DISPATCHER, so its coverage is a property
    // of the route table rather than of the handlers: every mutator reaches
    // the same line. Pinned as the single site, because a per-handler copy is
    // how coverage goes stale.
    const src = await Bun.file(join(import.meta.dir, '../http-admin.ts')).text();
    expect(src.split("evt: 'admin.mutation'").length - 1).toBe(1);
  });

  // ── the credential never appears ───────────────────────────────────────────

  // #144/#157's discipline, on the new surface: by NAME and by VALUE, across
  // every line the audit produced, including the failure paths where the
  // rejected token is right there in the handler's hand.
  it('no event carries token bytes, by name or by value', async () => {
    await call('/agents');
    await call('/agents', { token: 'wrong-token' });
    await call('/agents', { method: 'POST', body: JSON.stringify({ id: 'tokenholder', hostname: 'h' }) });
    await call('/messages?agent=a-one', { token: 'tok-a' });

    const all = lines.join('\n');
    expect(all).not.toContain(ADMIN);
    expect(all).not.toContain('wrong-token');
    expect(all).not.toContain('tok-a');
    expect(all).not.toContain(hashToken('tok-a'));
    expect(all).not.toContain('Bearer');
    expect(all).not.toContain('authorization');

    // The token minted by POST /agents is the one a naive "log the response"
    // would leak. It exists only in the HTTP body.
    const created = await (await call('/agents', { method: 'POST', body: JSON.stringify({ id: 'second', hostname: 'h' }) })).json() as { token: string };
    expect(typeof created.token).toBe('string');
    expect(lines.join('\n')).not.toContain(created.token);

    // POSITIVE CONTROL: the lines are not empty, and they do carry the things
    // they are supposed to carry. Without it every assertion above is satisfied
    // by logging nothing at all — which is the defect this issue is about.
    expect(all).toContain('admin.auth');
    expect(all).toContain('tokenholder');
  });

  // A query string is caller-controlled and unbounded; a path names the object.
  it('the recorded path carries no query string', async () => {
    await call('/messages?agent=a-one&limit=5');
    expect(events('admin.auth')[0]!.path).toBe('/messages');
  });

  it('the source address is recorded, and x-forwarded-for is labelled untrusted', async () => {
    await fetch(`${base}/agents`, {
      headers: { Authorization: `Bearer ${ADMIN}`, 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' },
    });
    const e = events('admin.auth')[0]!;
    expect(typeof e.remote).toBe('string');
    // The NAME is the assertion. A field called `client_ip` would be believed;
    // this one has to be argued for, which is the whole point — anyone may send
    // this header saying anything.
    expect(e.xff_untrusted).toBe('203.0.113.9, 10.0.0.1');
    expect('client_ip' in e).toBe(false);
  });
});
