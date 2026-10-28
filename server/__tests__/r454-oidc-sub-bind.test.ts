// R-454: the admin agent view shows `oidc_sub`, and PATCH /agents/:id takes
// `if_unbound: true` to bind a row only if nobody else holds it (spawner-web
// binds a new agent at spawn). The guards pinned here, each with a mutant in
// the PR: a row bound to another subject is a 409 OIDC_SUB_BOUND and is left
// unchanged; the same subject is a 200 no-op; an unbound row binds;
// `if_unbound` without a string oidc_sub is a 400; and `oidc_sub` appears in no
// reply an agent can get (a planted sentinel, with the admin read as the
// positive control).
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import { openDb, registerAgent, getAgentById, setOidcSub, aclGrant } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { startMcpServer, McpServerHandle } from '../mcp-server.ts';
import { createOidcVerifier, type OidcVerifier } from '../oidc.ts';
import { accessToken, makeCa, makeKey, startIssuer, type TestIssuer, type TestKey } from './helpers/test-issuer.ts';
import { tempDirs } from './helpers/temp-dirs.ts';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const { tmp, cleanup } = tempDirs();
afterAll(cleanup);
let portCounter = 24200;
const nextPort = () => portCounter++;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const SENTINEL = 'sentinel-sub-7f3a9c';

let ca: ReturnType<typeof makeCa>;
let key: TestKey;
beforeAll(async () => { ca = makeCa(tmp('r454-'), 'ca'); key = await makeKey('k1'); });

type Frame = Record<string, unknown>;
let db: Database;
let issuer: TestIssuer | undefined;
let verifier: OidcVerifier | undefined;
let ws: WsServerHandle | undefined;
let admin: HttpAdminHandle | undefined;
let base: string;
let wsPort: number;
let lines: string[];
const realLog = console.log;
const opened: WebSocket[] = [];

beforeEach(async () => {
  db = openDb(':memory:');
  lines = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  for (const id of ['fred', 'bob']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
  aclGrant(db, 'fred', 'bob', 'admin');
  aclGrant(db, 'bob', 'fred', 'admin');
  issuer = startIssuer(nextPort(), ca, [key]);
  verifier = createOidcVerifier({ issuer: issuer.url, audience: 'mesh', idClaim: 'preferred_username', caFile: ca.caFile, jwksFile: null, adminAudience: 'mesh-admin' }, { log: () => {} });
  for (let i = 0; i < 50 && !verifier.ready(); i++) await delay(20);
  const tokenAuth = { oidc: verifier, staticTokens: true };
  wsPort = nextPort();
  ws = await startWsServer(wsPort, db, 10_485_760, tmp('r454-ws-'), 0, new Map(), null, { tokenAuth });
  admin = await startHttpAdmin(0, db, 'adm', 10_485_760, tmp('r454-adm-'), ws.agentIndex, ws.observerIndex, new Map(), {}, { tokenAuth });
  base = `http://127.0.0.1:${(admin.server.address() as net.AddressInfo).port}`;
});
afterEach(async () => {
  console.log = realLog;
  for (const s of opened.splice(0)) { try { s.close(); } catch { /* ignore */ } }
  await ws?.shutdown().catch(() => {});
  await admin?.shutdown().catch(() => {});
  verifier?.stop(); issuer?.stop();
  db.close();
});

const call = async (method: string, path: string, bearer: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
};
const adminTok = (scope: string) => accessToken(key, { iss: issuer!.url, aud: 'mesh-admin', sub: 'svc-spawner', scope });

describe('R-454 the admin agent view', () => {
  it('GET /agents and /agents/:id show oidc_sub (null when unbound), with the static token or mesh:agents:read', async () => {
    setOidcSub(db, 'fred', 'u-fred');
    for (const bearer of ['adm', await adminTok('mesh:agents:read')]) {
      const one = await call('GET', '/agents/fred', bearer);
      expect(one.status).toBe(200);
      expect(one.json.oidc_sub).toBe('u-fred');
      const list = (await fetch(`${base}/agents`, { headers: { Authorization: `Bearer ${bearer}` } }).then(r => r.json())) as { id: string; oidc_sub: unknown }[];
      expect(list.find(a => a.id === 'fred')?.oidc_sub).toBe('u-fred');
      expect(list.find(a => a.id === 'bob')?.oidc_sub).toBeNull();
    }
  });
});

describe('R-454 golden shapes', () => {
  // The agent view's fields, in order: a second, deliberate copy of formatAgent's
  // shape, so a field added or dropped is a reviewed change here too.
  const VIEW_KEYS = ['id', 'hostname', 'online', 'capabilities', 'metadata', 'namespace', 'registered_at', 'last_seen', 'last_alive', 'last_responded', 'status', 'status_detail', 'status_at', 'tls_seen', 'oidc_sub'];

  it('oidc_sub is always present in admin GET replies: null when unbound, never absent', async () => {
    const unbound = await call('GET', '/agents/bob', 'adm');
    expect(Object.keys(unbound.json)).toEqual(VIEW_KEYS);
    expect(unbound.json.oidc_sub).toBeNull();
    const list = (await fetch(`${base}/agents`, { headers: { Authorization: 'Bearer adm' } }).then(r => r.json())) as Record<string, unknown>[];
    for (const a of list) {
      expect(Object.keys(a)).toEqual(VIEW_KEYS);
      expect('oidc_sub' in a).toBe(true);
    }
  });

  it('the PATCH 200 returns the updated agent in the same shape as GET /agents/:id', async () => {
    const patched = await call('PATCH', '/agents/fred', await adminTok('mesh:agents:bind'), { oidc_sub: 'u-fred', if_unbound: true });
    expect(patched.status).toBe(200);
    const got = await call('GET', '/agents/fred', 'adm');
    expect(Object.keys(patched.json)).toEqual(VIEW_KEYS);
    expect(patched.json).toEqual(got.json);
    expect(patched.json.oidc_sub).toBe('u-fred');
  });
});

describe('R-454 mesh:agents:bind', () => {
  it('GUARD: allows exactly {oidc_sub: <string>, if_unbound: true}, as a conditional bind', async () => {
    const bind = await adminTok('mesh:agents:bind');
    expect((await call('PATCH', '/agents/fred', bind, { oidc_sub: 'u-fred', if_unbound: true })).status).toBe(200);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-fred');
    const taken = await call('PATCH', '/agents/fred', bind, { oidc_sub: 'u-intruder', if_unbound: true });
    expect(taken.status).toBe(409);
    expect(taken.json.code).toBe('OIDC_SUB_BOUND');
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-fred');
  });

  it('GUARD: anything else is a 403 SCOPE_MISSING and changes nothing: no overwrite, no unbind, no other field', async () => {
    setOidcSub(db, 'fred', 'u-fred');
    const bind = await adminTok('mesh:agents:bind');
    const bodies: unknown[] = [
      { oidc_sub: 'u-other' },                                   // unconditional overwrite
      { oidc_sub: 'u-other', if_unbound: false },
      { oidc_sub: null },                                        // unbind
      { oidc_sub: null, if_unbound: true },
      { oidc_sub: 'u-fred', if_unbound: true, metadata: { a: 1 } },
      { oidc_sub: 'u-fred', if_unbound: true, namespace: 'x' },
      { metadata: { a: 1 } },
      { if_unbound: true },
      { oidc_sub: 'u-fred', if_unbound: 'true' },
      {},
    ];
    for (const body of bodies) {
      const r = await call('PATCH', '/agents/fred', bind, body);
      expect({ body, status: r.status, code: r.json.code }).toEqual({ body, status: 403, code: 'SCOPE_MISSING' });
    }
    const row = getAgentById(db, 'fred')!;
    expect(row.oidc_sub).toBe('u-fred');
    expect(row.metadata).toBe('{}');
    expect(row.namespace ?? null).toBeNull();
    expect(lines.some(l => l.includes('"evt":"admin.auth"') && l.includes('"reason":"scope_missing"') && l.includes('"sub":"svc-spawner"'))).toBe(true);
  });

  it('GUARD: reaches no other route: not DELETE, rotate, POST /agents, observers, or a read', async () => {
    const bind = await adminTok('mesh:agents:bind');
    for (const [method, path, body] of [['DELETE', '/agents/fred', undefined], ['POST', '/agents/fred/rotate', undefined], ['POST', '/agents', { id: 'zed', hostname: 'h' }], ['POST', '/observers', { agent_id: 'fred' }], ['DELETE', '/agents/fred/tls-latch', undefined], ['GET', '/agents', undefined], ['GET', '/agents/fred', undefined]] as const) {
      expect((await call(method, path, bind, body)).status).toBe(401);
    }
    expect(getAgentById(db, 'fred')).not.toBeNull();
  });

  it('control: mesh:agents:write still allows every PATCH, conditional ones included', async () => {
    const w = await adminTok('mesh:agents:write');
    expect((await call('PATCH', '/agents/fred', w, { oidc_sub: 'u-fred', if_unbound: true, metadata: { a: 1 } })).status).toBe(200);
    expect((await call('PATCH', '/agents/fred', w, { oidc_sub: null })).status).toBe(200);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBeNull();
    // Holding both, the broader one decides.
    expect((await call('PATCH', '/agents/fred', await adminTok('mesh:agents:bind mesh:agents:write'), { namespace: 'n' })).status).toBe(200);
  });
});

describe('R-454 the conditional bind', () => {
  it('GUARD: an unbound row binds; the same subject again is a 200 no-op', async () => {
    const w = await adminTok('mesh:agents:write');
    expect((await call('PATCH', '/agents/fred', w, { oidc_sub: 'u-fred', if_unbound: true })).status).toBe(200);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-fred');
    const again = await call('PATCH', '/agents/fred', w, { oidc_sub: 'u-fred', if_unbound: true });
    expect(again.status).toBe(200);
    expect(again.json.oidc_sub).toBe('u-fred');
    expect(lines.some(l => l.includes('"evt":"agent.oidc_sub_set"') && l.includes('"if_unbound":true') && l.includes('"by_sub":"svc-spawner"'))).toBe(true);
  });

  it('GUARD: a row bound to another subject is a 409 OIDC_SUB_BOUND; nothing in the PATCH is applied; the refusal is logged with the admin\'s sub', async () => {
    setOidcSub(db, 'fred', 'u-fred');
    const r = await call('PATCH', '/agents/fred', await adminTok('mesh:agents:write'), { oidc_sub: 'u-intruder', if_unbound: true, namespace: 'moved' });
    expect(r.status).toBe(409);
    // Golden: the shape promised to fleet-mesh-manager on R-454.
    expect(Object.keys(r.json).sort()).toEqual(['code', 'error']);
    expect(r.json.code).toBe('OIDC_SUB_BOUND');
    expect(typeof r.json.error).toBe('string');
    const row = getAgentById(db, 'fred')!;
    expect(row.oidc_sub).toBe('u-fred');
    expect(row.namespace ?? null).toBeNull();
    expect(lines.some(l => l.includes('"evt":"agent.oidc_sub_refused"') && l.includes('"reason":"OIDC_SUB_BOUND"') && l.includes('"by_sub":"svc-spawner"'))).toBe(true);
    expect(lines.some(l => l.includes('"evt":"agent.oidc_sub_set"'))).toBe(false);
    expect(lines.some(l => l.includes('"evt":"admin.mutation"'))).toBe(false);
  });

  it('GUARD: if_unbound needs a string oidc_sub and a boolean; anything else is a 400 and changes nothing', async () => {
    setOidcSub(db, 'fred', 'u-fred');
    for (const body of [{ oidc_sub: null, if_unbound: true }, { if_unbound: true }, { oidc_sub: 7, if_unbound: true }, { oidc_sub: 'u-x', if_unbound: 'yes' }, { oidc_sub: 'u-x', if_unbound: 1 }]) {
      expect((await call('PATCH', '/agents/fred', 'adm', body)).status).toBe(400);
    }
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-fred');
  });

  it('control: without if_unbound (or with false) the admin overwrites and unbinds, as before', async () => {
    setOidcSub(db, 'fred', 'u-fred');
    expect((await call('PATCH', '/agents/fred', 'adm', { oidc_sub: 'u-other' })).status).toBe(200);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-other');
    expect((await call('PATCH', '/agents/fred', 'adm', { oidc_sub: 'u-third', if_unbound: false })).status).toBe(200);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-third');
    expect((await call('PATCH', '/agents/fred', 'adm', { oidc_sub: null })).status).toBe(200);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBeNull();
  });

  it('the conditional bind still needs mesh:agents:write', async () => {
    expect((await call('PATCH', '/agents/fred', await adminTok('mesh:agents:read'), { oidc_sub: 'u-fred', if_unbound: true })).status).toBe(401);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBeNull();
  });
});

describe('R-454 oidc_sub never reaches an agent', () => {
  async function session(id: string): Promise<{ sock: WebSocket; frames: Frame[] }> {
    const sock = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    opened.push(sock);
    const frames: Frame[] = [];
    sock.on('message', (d) => frames.push(JSON.parse(d.toString()) as Frame));
    await new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); sock.once('error', reject); });
    sock.send(JSON.stringify({ type: 'auth', agent_id: id, token: `${id}-tok` }));
    for (let i = 0; i < 50 && !frames.some(f => f.type === 'auth_ok'); i++) await delay(20);
    return { sock, frames };
  }

  it('GUARD: a planted sentinel is in the admin view and in no WS frame or MCP reply an agent gets', async () => {
    setOidcSub(db, 'fred', SENTINEL);
    setOidcSub(db, 'bob', SENTINEL);
    // Positive control: the sentinel is reachable where it belongs.
    expect(JSON.stringify((await call('GET', '/agents/fred', 'adm')).json)).toContain(SENTINEL);

    const fred = await session('fred');
    const bob = await session('bob'); // fred sees bob's presence change
    fred.sock.send(JSON.stringify({ type: 'list_presence', msg_id: 'lp' }));
    bob.sock.send(JSON.stringify({ type: 'status', status: 'limited', msg_id: 'st' }));
    fred.sock.send(JSON.stringify({ type: 'list_reminders', msg_id: 'lr' }));
    for (let i = 0; i < 50 && !fred.frames.some(f => f.type === 'presence_list'); i++) await delay(20);
    await delay(100);
    expect(fred.frames.some(f => f.type === 'presence_list')).toBe(true);
    const wsSeen = JSON.stringify([...fred.frames, ...bob.frames]);
    expect(wsSeen).toContain('auth_ok');
    expect(wsSeen).not.toContain(SENTINEL);

    // The MCP plane's agent views.
    const mcp: McpServerHandle = await startMcpServer(db, new Map(), new Map(), 'adm');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(st);
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    await client.connect(ct);
    const replies = [
      await client.callTool({ name: 'mesh_discover', arguments: {} }),
      await client.callTool({ name: 'mesh_status', arguments: { as_agent: 'fred' } }),
    ];
    await client.close().catch(() => {});
    await mcp.shutdown().catch(() => {});
    const mcpSeen = JSON.stringify(replies);
    expect(mcpSeen).toContain('fred');
    expect(mcpSeen).not.toContain(SENTINEL);
  });
});
