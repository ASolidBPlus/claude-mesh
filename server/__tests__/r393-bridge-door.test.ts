// R-393 — the bridge door: four declared actions behind fleet-bridge's vouch,
// off unless configured. The guards pinned here: token_issue only ever issues
// for the vouched caller; only listed callers touch edges; a caller revokes
// only what it granted; an unvouched or mis-signed call runs nothing; no
// config, no door; the old token is refused on a new connect while an open
// socket survives.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { openDb, registerAgent, aclGrant, aclCheck, upsertPeer } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { bridgeDoor, parseBridgeDoorConfig, BRIDGE_SYSTEM } from '../bridge-door.ts';
import { signVouch, bridgeKeyText } from '../vendor/fleet-bridge-declare/index.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

let portCounter = 24850;
const nextPort = () => portCounter++;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const bridge = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const BRIDGE_KEY = bridgeKeyText(bridge.publicKey);
const ADMIN = 'admin-r393';
const SYNC = 'fleet-access';

let db: Database;
let admin: HttpAdminHandle | undefined;
let base: string;
let lines: string[];
const realLog = console.log;

async function start(withDoor: boolean): Promise<void> {
  admin = await startHttpAdmin(0, db, ADMIN, 10_485_760, tmp('r393-'), new Map(), new Map(), new Map(), {}, {
    ...(withDoor ? { bridgeDoor: bridgeDoor(db, { keys: [BRIDGE_KEY], url: 'http://127.0.0.1:7433', edgeCallers: [SYNC] }, { bootMs: Date.now() - 1000 }) } : {}),
  });
  base = `http://127.0.0.1:${(admin.server.address() as net.AddressInfo).port}`;
}

/** A call through the door, vouched for `caller` by `key` (the bridge's, unless a test says otherwise). */
async function call(action: string, caller: string, input: unknown, opts: { key?: KeyObject; tamper?: boolean; headers?: Record<string, string> } = {}) {
  const body = new TextEncoder().encode(JSON.stringify(input));
  const vouch = signVouch(opts.key ?? bridge.privateKey, { system: BRIDGE_SYSTEM, action, caller, body });
  const res = await fetch(`${base}/actions/v1/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? vouch) },
    body: opts.tamper ? JSON.stringify({ ...(input as object), sneaky: 1 }) : body,
  });
  return { status: res.status, cache: res.headers.get('cache-control'), body: (await res.json()) as { ok: boolean; output?: Record<string, unknown>; error?: { code: string } } };
}
let idn = 0;
const fresh = () => `call-${++idn}`;

beforeEach(() => {
  db = openDb(':memory:');
  lines = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  for (const id of ['fred', 'bob', SYNC]) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
});
afterEach(async () => {
  console.log = realLog;
  await admin?.shutdown().catch(() => {});
  admin = undefined;
  db.close();
});

describe('R-393 configuration: off unless configured', () => {
  it('no keys = no door; half or bad config is refused', () => {
    expect(parseBridgeDoorConfig({})).toEqual({ ok: true, config: null });
    expect(parseBridgeDoorConfig({ MESH_BRIDGE_KEYS: BRIDGE_KEY, MESH_BRIDGE_URL: 'https://mesh.example', MESH_BRIDGE_EDGE_CALLERS: 'fleet-access, other' }))
      .toEqual({ ok: true, config: { keys: [BRIDGE_KEY], url: 'https://mesh.example', edgeCallers: ['fleet-access', 'other'] } });
    for (const bad of [
      { MESH_BRIDGE_URL: 'https://mesh.example' },
      { MESH_BRIDGE_EDGE_CALLERS: 'fleet-access' },
      { MESH_BRIDGE_KEYS: BRIDGE_KEY },
      { MESH_BRIDGE_KEYS: 'not-a-key', MESH_BRIDGE_URL: 'https://mesh.example' },
      { MESH_BRIDGE_KEYS: BRIDGE_KEY, MESH_BRIDGE_URL: 'http://mesh.example' },
      { MESH_BRIDGE_KEYS: BRIDGE_KEY, MESH_BRIDGE_URL: 'https://mesh.example', MESH_BRIDGE_EDGE_CALLERS: 'Bad Caller' },
    ]) expect({ bad, ok: parseBridgeDoorConfig(bad).ok }).toEqual({ bad, ok: false });
  });

  it('GUARD: unconfigured, /actions/v1 is just an unknown admin path — a valid vouch opens nothing, and the boot line says off', async () => {
    await start(false);
    const r = await call('token_issue', 'fred', { id: fresh() });
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toContain('token"');
    expect((await fetch(`${base}/actions/v1`)).status).toBe(401);
    expect(lines.map(l => { try { return JSON.parse(l); } catch { return {}; } }).find(o => o.evt === 'admin.listening')).toMatchObject({ bridge_door: 'off' });
  });

  it('configured: the declaration is served to a vouched caller, and the boot line says on', async () => {
    await start(true);
    const body = new Uint8Array();
    const res = await fetch(`${base}/actions/v1`, { headers: signVouch(bridge.privateKey, { system: BRIDGE_SYSTEM, action: '.declaration', caller: 'fred', body }) });
    expect(res.status).toBe(200);
    const d = await res.json() as { system: string; actions: { name: string }[]; allowed: string[] };
    expect([d.system, d.actions.map(a => a.name), d.allowed]).toEqual(['mesh', ['token_issue', 'acl_list', 'acl_grant', 'acl_revoke'], ['token_issue']]);
    expect(lines.map(l => { try { return JSON.parse(l); } catch { return {}; } }).find(o => o.evt === 'admin.listening')).toMatchObject({ bridge_door: 'on' });
  });
});

describe('R-393 who may call', () => {
  beforeEach(() => start(true));

  it('GUARD: an unvouched call, a stranger\'s signature, a tampered body or a replayed vouch runs nothing', async () => {
    const before = (db.prepare("SELECT token_hash FROM agents WHERE id = 'fred'").get() as { token_hash: string }).token_hash;
    expect((await call('token_issue', 'fred', { id: fresh() }, { headers: {} })).body.error?.code).toBe('NOT_A_CALLER');
    expect((await call('token_issue', 'fred', { id: fresh() }, { key: stranger.privateKey })).body.error?.code).toBe('NOT_A_CALLER');
    expect((await call('token_issue', 'fred', { id: fresh() }, { tamper: true })).body.error?.code).toBe('NOT_A_CALLER');
    // The same signed request twice: the nonce is spent.
    const headers = { 'Content-Type': 'application/json', ...signVouch(bridge.privateKey, { system: BRIDGE_SYSTEM, action: 'acl_list', caller: SYNC, body: new TextEncoder().encode('{}') }) };
    expect((await fetch(`${base}/actions/v1/acl_list`, { method: 'POST', headers, body: '{}' })).status).toBe(200);
    expect((await fetch(`${base}/actions/v1/acl_list`, { method: 'POST', headers, body: '{}' })).status).toBe(401);
    expect((db.prepare("SELECT token_hash FROM agents WHERE id = 'fred'").get() as { token_hash: string }).token_hash).toBe(before);
  });

  it('every answer is no-store', async () => {
    expect((await call('token_issue', 'fred', { id: fresh() })).cache).toBe('no-store');
    expect((await call('acl_list', 'fred', {})).cache).toBe('no-store');
  });
});

describe('R-393 token_issue', () => {
  let ws: WsServerHandle | undefined;
  let wsPort: number;
  beforeEach(async () => {
    await start(true);
    wsPort = nextPort();
    ws = await startWsServer(wsPort, db, 10_485_760, tmp('r393-ws-'), 0, new Map());
  });
  afterEach(async () => { await ws?.shutdown().catch(() => {}); ws = undefined; });

  async function login(agentId: string, token: string): Promise<{ sock: WebSocket; reply: Record<string, unknown>; frames: Record<string, unknown>[] }> {
    const sock = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); sock.once('error', reject); });
    const frames: Record<string, unknown>[] = [];
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      let first = true;
      sock.on('message', (d) => { const f = JSON.parse(d.toString()); if (first) { first = false; resolve(f); return; } frames.push(f); });
      sock.send(JSON.stringify({ type: 'auth', agent_id: agentId, token }));
    });
    return { sock, reply, frames };
  }

  it('the old token is refused on a NEW connect, an open socket survives, and the new token works', async () => {
    const open = await login('fred', 'fred-tok');
    expect(open.reply.type).toBe('auth_ok');
    const r = await call('token_issue', 'fred', { id: fresh() });
    expect(r.body).toMatchObject({ ok: true, output: { agent_id: 'fred', created: false } });
    const token = r.body.output!.token as string;
    expect((await login('fred', 'fred-tok')).reply).toMatchObject({ type: 'error', code: 'AUTH_FAILED' });
    expect(open.sock.readyState).toBe(WebSocket.OPEN);
    // ...and it still works: a send from it is accepted.
    aclGrant(db, 'fred', 'bob', 'admin');
    open.sock.send(JSON.stringify({ type: 'send', msg_id: 'still-open', to: 'bob', payload: 'x' }));
    await delay(60);
    expect(open.frames.some(f => f.type === 'ack' && f.ref === 'still-open')).toBe(true);
    // The new token logs in; the old open one was not displaced by issuing.
    expect((await login('fred', token)).reply.type).toBe('auth_ok');
    expect(lines.join('\n')).not.toContain(token);
  });

  it('an unregistered caller is created', async () => {
    const r = await call('token_issue', 'newbie', { id: fresh() });
    expect(r.body).toMatchObject({ ok: true, output: { agent_id: 'newbie', created: true } });
    expect((await login('newbie', r.body.output!.token as string)).reply.type).toBe('auth_ok');
  });

  it('GUARD: never for another id — an input naming one is refused, and nothing else changes', async () => {
    const bobBefore = (db.prepare("SELECT token_hash FROM agents WHERE id = 'bob'").get() as { token_hash: string }).token_hash;
    for (const input of [{ id: fresh(), agent_id: 'bob' }, { id: fresh(), caller: 'bob' }, { id: fresh(), to: 'bob' }]) {
      const r = await call('token_issue', 'fred', input);
      expect({ input, code: r.body.error?.code }).toEqual({ input, code: 'BAD_INPUT' });
    }
    // A vouch for fred: the issued token is fred's, never bob's.
    const r = await call('token_issue', 'fred', { id: fresh() });
    expect(r.body.output?.agent_id).toBe('fred');
    expect((db.prepare("SELECT token_hash FROM agents WHERE id = 'bob'").get() as { token_hash: string }).token_hash).toBe(bobBefore);
    expect((await login('bob', r.body.output!.token as string)).reply).toMatchObject({ type: 'error', code: 'AUTH_FAILED' });
  });

  it('an id that is reserved or a peer\'s alias is not created', async () => {
    upsertPeer(db, { alias: 'pod1', token_hash: hashToken('p'), minted_by_key: 'k', kinds: '["direct"]', rate_per_min: 600 });
    expect((await call('token_issue', 'pod1', { id: fresh() })).body.error?.code).toBe('ID_UNAVAILABLE');
    expect((await call('token_issue', 'mesh', { id: fresh() })).body.error?.code).toBe('ID_UNAVAILABLE');
    expect(db.prepare("SELECT 1 FROM agents WHERE id IN ('pod1', 'mesh')").get()).toBeNull();
  });
});

describe('R-393 the edge actions', () => {
  beforeEach(() => start(true));

  it('GUARD: a caller not on the list can\'t list, grant or revoke', async () => {
    aclGrant(db, 'fred', 'bob', 'fred');
    expect((await call('acl_list', 'fred', {})).body.error?.code).toBe('NO_ACCESS');
    expect((await call('acl_grant', 'fred', { id: fresh(), from: 'bob', to: 'fred' })).body.error?.code).toBe('NO_ACCESS');
    expect((await call('acl_revoke', 'fred', { id: fresh(), from: 'fred', to: 'bob' })).body.error?.code).toBe('NO_ACCESS');
    expect(aclCheck(db, 'bob', 'fred')).toBe(false);
    expect(aclCheck(db, 'fred', 'bob')).toBe(true);
  });

  it('a listed caller grants (granted_by = itself), lists, and an unknown endpoint is retryable', async () => {
    const g = await call('acl_grant', SYNC, { id: fresh(), from: 'fred', to: 'bob' });
    expect(g.body).toMatchObject({ ok: true, output: { from: 'fred', to: 'bob', granted_by: SYNC, created: true } });
    expect(aclCheck(db, 'fred', 'bob')).toBe(true);
    const unknown = await call('acl_grant', SYNC, { id: fresh(), from: 'fred', to: 'later' });
    expect([unknown.status, unknown.body.error?.code]).toEqual([409, 'ENDPOINT_UNKNOWN']);
    registerAgent(db, { id: 'later', token_hash: hashToken('l'), hostname: 'h' });
    expect((await call('acl_grant', SYNC, { id: fresh(), from: 'fred', to: 'later' })).body.ok).toBe(true);
    const list = await call('acl_list', SYNC, {});
    expect(list.body.output!.edges).toEqual([
      { from: 'fred', to: 'bob', granted_by: SYNC, granted_at: expect.any(Number) },
      { from: 'fred', to: 'later', granted_by: SYNC, granted_at: expect.any(Number) },
    ]);
  });

  it('an existing edge keeps who granted it, so the sync can\'t adopt it', async () => {
    aclGrant(db, 'fred', 'bob', 'admin');
    const g = await call('acl_grant', SYNC, { id: fresh(), from: 'fred', to: 'bob' });
    expect(g.body.output).toMatchObject({ granted_by: 'admin', created: false });
    expect((await call('acl_revoke', SYNC, { id: fresh(), from: 'fred', to: 'bob' })).body.error?.code).toBe('NOT_GRANTED_BY_CALLER');
    expect(aclCheck(db, 'fred', 'bob')).toBe(true);
  });

  it('GUARD: revoke removes only an edge the caller granted; anything else stays, with a stable code', async () => {
    aclGrant(db, 'bob', 'fred', 'admin');
    await call('acl_grant', SYNC, { id: fresh(), from: 'fred', to: 'bob' });
    const other = await call('acl_revoke', SYNC, { id: fresh(), from: 'bob', to: 'fred' });
    expect([other.status, other.body.error?.code]).toEqual([409, 'NOT_GRANTED_BY_CALLER']);
    expect(aclCheck(db, 'bob', 'fred')).toBe(true);
    expect((await call('acl_revoke', SYNC, { id: fresh(), from: 'nobody', to: 'fred' })).body.error?.code).toBe('NOT_GRANTED_BY_CALLER');
    const own = await call('acl_revoke', SYNC, { id: fresh(), from: 'fred', to: 'bob' });
    expect(own.body).toMatchObject({ ok: true, output: { revoked: true } });
    expect(aclCheck(db, 'fred', 'bob')).toBe(false);
  });

  it('every action is logged with action, caller and outcome', async () => {
    await call('acl_grant', SYNC, { id: fresh(), from: 'fred', to: 'bob' });
    await call('acl_revoke', SYNC, { id: fresh(), from: 'bob', to: 'fred' });
    const acts = lines.flatMap(l => { try { const o = JSON.parse(l); return o.evt === 'bridge.action' ? [[o.action, o.caller, o.outcome]] : []; } catch { return []; } });
    expect(acts).toEqual([['acl_grant', SYNC, 'granted'], ['acl_revoke', SYNC, 'NOT_GRANTED_BY_CALLER']]);
  });
});
