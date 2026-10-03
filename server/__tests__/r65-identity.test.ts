import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { openDb, registerAgent, getAgentById, aclGrant, aclCheck, grantObserver, markTlsSeen, updateAgent } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, type WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, type HttpAdminHandle } from '../http-admin.ts';
import { loadTls, type ServerTls } from '../tls-config.ts';
import { __resetCallersForTest } from '../connections.ts';

// R-65 PR-B — identity and visibility.
//   M4  agent.auth / observer.auth / agent.http log lines, with src_ip and tls
//   M5  POST /agents/:id/rotate
//   M6  GET /connections
// Written BEFORE the implementation; each describe maps to a Done-when item.

const dir = mkdtempSync(join(tmpdir(), 'mesh-r65b-'));
const f = (n: string) => join(dir, n);
function openssl(...args: string[]): void {
  const r = Bun.spawnSync(['openssl', ...args], { cwd: dir, stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr.toString()}`);
}
let TLS: ServerTls;
beforeAll(() => {
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=range-ca');
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'bus.key', '-out', 'bus.csr', '-subj', '/CN=bus');
  writeFileSync(f('bus.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  openssl('x509', '-req', '-in', 'bus.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'bus.pem', '-days', '2', '-extfile', 'bus.ext');
  const t = loadTls({ MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: f('bus.key') });
  if (!t.ok || t.server === null) throw new Error('fixture TLS did not load');
  TLS = t.server;
});
const ca = () => require('fs').readFileSync(f('ca.pem'), 'utf8') as string;

const ADMIN = 'admin-r65b';
const ports = () => { const b = 35000 + Math.floor(Math.random() * 3000); return [b, b + 1, b + 2, b + 3] as const; };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Capture console output for the duration of fn — the log lines ARE the M4 contract. */
async function capture<T>(fn: () => Promise<T>): Promise<{ v: T; lines: string[] }> {
  const lines: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { return { v: await fn(), lines }; } finally { console.log = log; console.error = err; }
}
const evts = (lines: string[], evt: string) => lines.flatMap(l => {
  try { const o = JSON.parse(l) as Record<string, unknown>; return o?.evt === evt ? [o] : []; } catch { return []; }
});

async function rawAuth(url: string, agentId: string, token: string, withCa = false) {
  const ws = new WebSocket(url, withCa ? { tls: { ca: ca() }, ca: ca() } as never : undefined);
  const frames: Record<string, unknown>[] = [];
  let close: { code: number; reason: string } | null = null;
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  ws.on('close', (code: number, reason: Buffer) => { close = { code, reason: String(reason) }; });
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'auth', agent_id: agentId, token }));
  await wait(150);
  return { ws, frames, closed: () => close };
}

let db: Database | undefined;
const handles: { shutdown(): Promise<void> }[] = [];
const socks: WebSocket[] = [];
afterEach(async () => {
  for (const s of socks.splice(0)) { try { s.close(); } catch { /* ignore */ } }
  for (const h of handles.splice(0)) await h.shutdown().catch(() => {});
  db?.close(); db = undefined;
  __resetCallersForTest();
});

function freshDb(): Database {
  db = openDb(':memory:');
  for (const id of ['alice', 'bob', 'watcher']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
  return db;
}
async function startWs(port: number | 'off', tlsPort?: number) {
  const { v } = await capture(() => startWsServer(port, db!, 10_485_760, mkdtempSync(join(tmpdir(), 'r65b-f-')), 0, new Map(), TLS,
    tlsPort === undefined ? {} : { tlsPort }));
  handles.push(v);
  return v as WsServerHandle;
}
async function startAdmin(port: number | 'off', wsh: WsServerHandle | null, tlsPort?: number, extra: Record<string, unknown> = {}) {
  const { v } = await capture(() => startHttpAdmin(port, db!, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'r65b-a-')),
    wsh?.agentIndex ?? new Map(), wsh?.observerIndex ?? new Map(), new Map(), {},
    { ...(tlsPort === undefined ? {} : { tls: TLS, tlsPort }), ...extra }));
  handles.push(v);
  return v as HttpAdminHandle;
}
const adminFetch = (base: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${ADMIN}`, ...(init.headers ?? {}) } });

// ════════════════════════════════════════════════════════════════════════════
// M5 — Done-when: after rotate, the old token is refused and its live socket
// is closed (WS and HTTP).
// ════════════════════════════════════════════════════════════════════════════

describe('M5: POST /agents/:id/rotate', () => {
  it('returns a new token once; closes the live socket (distinct reason); the old token is refused on WS and HTTP; the new one works', async () => {
    freshDb();
    aclGrant(db!, 'alice', 'bob', 'admin');
    updateAgent(db!, 'alice', { namespace: 'team-a' });
    markTlsSeen(db!, 'alice');
    const [p, t, a] = ports();
    const wsh = await startWs(p, t);
    await startAdmin(a, wsh);
    const base = `http://127.0.0.1:${a}`;

    const live = await rawAuth(`wss://127.0.0.1:${t}`, 'alice', 'alice-tok', true); socks.push(live.ws);
    expect(live.frames[0]?.type).toBe('auth_ok');

    const { v: res, lines } = await capture(() => adminFetch(base, '/agents/alice/rotate', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; token: string };
    expect(body.id).toBe('alice');
    expect(typeof body.token).toBe('string');
    expect(body.token).not.toBe('alice-tok');
    // The latch is checked HERE, before any new auth: a later TLS auth would
    // set it again and hide a rotate that had cleared it.
    expect(getAgentById(db!, 'alice')!.tls_seen ?? null).not.toBeNull();
    await wait(150);

    // The live socket was CLOSED, with a reason that is not displacement.
    expect(live.frames.some(fr => fr.code === 'TOKEN_ROTATED')).toBe(true);
    expect(live.frames.some(fr => fr.code === 'DISPLACED')).toBe(false);
    expect(live.closed()?.reason).toBe('token rotated');
    expect(wsh.agentIndex.has('alice')).toBe(false);

    // Old token: refused on WS and on HTTP.
    const oldWs = await rawAuth(`wss://127.0.0.1:${t}`, 'alice', 'alice-tok', true); socks.push(oldWs.ws);
    expect(oldWs.frames[0]).toEqual({ type: 'error', code: 'AUTH_FAILED', message: 'unknown agent' });
    expect((await capture(() => fetch(`${base}/messages`, { headers: { Authorization: 'Bearer alice-tok' } }))).v.status).toBe(401);

    // New token works (TLS, since alice is latched).
    const fresh = await rawAuth(`wss://127.0.0.1:${t}`, 'alice', body.token, true); socks.push(fresh.ws);
    expect(fresh.frames[0]?.type).toBe('auth_ok');

    // Kept: ACL edges, namespace, the TLS latch.
    expect(aclCheck(db!, 'alice', 'bob')).toBe(true);
    expect(getAgentById(db!, 'alice')!.namespace).toBe('team-a');
    expect(getAgentById(db!, 'alice')!.tls_seen ?? null).not.toBeNull();

    // Neither token is ever logged.
    const all = lines.join('\n');
    expect(all).not.toContain(body.token);
    expect(all).not.toContain('alice-tok');
  });

  it('closes an OBSERVER socket held under the id too', async () => {
    freshDb();
    grantObserver(db!, 'watcher', 'system');
    const [p, , a] = ports();
    const wsh = await startWs(p);
    await startAdmin(a, wsh);
    const live = await rawAuth(`wss://127.0.0.1:${p}`, 'watcher', 'watcher-tok', true); socks.push(live.ws);
    expect(live.frames[0]?.type).toBe('auth_ok');
    expect(wsh.observerIndex.has('watcher')).toBe(true);
    const { v: res } = await capture(() => adminFetch(`http://127.0.0.1:${a}`, '/agents/watcher/rotate', { method: 'POST' }));
    expect(res.status).toBe(200);
    await wait(150);
    expect(live.closed()?.reason).toBe('token rotated');
    expect(wsh.observerIndex.has('watcher')).toBe(false);
  });

  it('unknown id → 404; no admin token → 401', async () => {
    freshDb();
    const [, , a] = ports();
    await startAdmin(a, null);
    const base = `http://127.0.0.1:${a}`;
    // The HANDLER's 404, not the dispatcher's unmatched-route 404 — which would
    // pass this before the route exists.
    const nf = (await capture(() => adminFetch(base, '/agents/nobody/rotate', { method: 'POST' }))).v;
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: 'agent not found' });
    expect((await fetch(`${base}/agents/alice/rotate`, { method: 'POST' })).status).toBe(401);
    expect(getAgentById(db!, 'alice')!.token_hash).toBe(hashToken('alice-tok'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// M4 — Done-when: the log lines carry the right `tls` value per listener.
// ════════════════════════════════════════════════════════════════════════════

describe('M4: agent.auth / observer.auth / agent.http', () => {
  it('agent.auth on every WS auth: src_ip from the socket, tls per listener, displaced when it displaced', async () => {
    freshDb();
    const [p, t] = ports();
    await startWs(p, t);
    const { v: first, lines: l1 } = await capture(() => rawAuth(`ws://127.0.0.1:${p}`, 'bob', 'bob-tok')); socks.push(first.ws);
    expect(evts(l1, 'agent.auth')).toMatchObject([{ agent_id: 'bob', tls: false, displaced: false }]);
    expect(String(evts(l1, 'agent.auth')[0]!.src_ip)).toMatch(/127\.0\.0\.1$/);

    const { v: second, lines: l2 } = await capture(() => rawAuth(`wss://127.0.0.1:${t}`, 'bob', 'bob-tok', true)); socks.push(second.ws);
    expect(evts(l2, 'agent.auth')).toMatchObject([{ agent_id: 'bob', tls: true, displaced: true }]);
  });

  it('src_ip is the SOCKET address — an X-Forwarded-For header is not believed', async () => {
    freshDb();
    const [p] = ports();
    await startWs(p);
    const { lines } = await capture(async () => {
      const ws = new WebSocket(`wss://127.0.0.1:${p}`, { tls: { ca: ca() }, ca: ca(), headers: { 'X-Forwarded-For': '203.0.113.9' } } as never);
      socks.push(ws);
      await new Promise<void>((res) => ws.on('open', () => res()));
      ws.send(JSON.stringify({ type: 'auth', agent_id: 'bob', token: 'bob-tok' }));
      await wait(150);
    });
    const line = evts(lines, 'agent.auth')[0]!;
    expect(String(line.src_ip)).toMatch(/127\.0\.0\.1$/);
    expect(JSON.stringify(line)).not.toContain('203.0.113.9');
  });

  it('refusals are logged too, keeping `refused`', async () => {
    freshDb();
    markTlsSeen(db!, 'alice');
    const [p, t] = ports();
    await startWs(p, t);
    const { v: bad, lines: l1 } = await capture(() => rawAuth(`ws://127.0.0.1:${p}`, 'bob', 'WRONG')); socks.push(bad.ws);
    expect(evts(l1, 'agent.auth')).toMatchObject([{ agent_id: 'bob', tls: false, refused: 'bad_token' }]);
    const { v: latched, lines: l2 } = await capture(() => rawAuth(`ws://127.0.0.1:${p}`, 'alice', 'alice-tok')); socks.push(latched.ws);
    expect(evts(l2, 'agent.auth')).toMatchObject([{ agent_id: 'alice', tls: false, refused: 'tls_latched' }]);
    expect(String(evts(l2, 'agent.auth')[0]!.src_ip)).toMatch(/127\.0\.0\.1$/);
  });

  it('an observer\'s auth is logged as observer.auth', async () => {
    freshDb();
    grantObserver(db!, 'watcher', 'system');
    const [p] = ports();
    await startWs(p);
    const { v: s, lines } = await capture(() => rawAuth(`wss://127.0.0.1:${p}`, 'watcher', 'watcher-tok', true)); socks.push(s.ws);
    expect(evts(lines, 'observer.auth')).toMatchObject([{ agent_id: 'watcher', tls: true, displaced: false }]);
    expect(evts(lines, 'agent.auth')).toEqual([]);
  });

  it('agent.http on every token-authenticated request: the route PATTERN (no ids, no query), tls per listener', async () => {
    freshDb();
    const [, , a, at] = ports();
    await startAdmin(a, null, at);
    const { lines } = await capture(async () => {
      await fetch(`http://127.0.0.1:${a}/messages?with=bob&limit=5`, { headers: { Authorization: 'Bearer alice-tok' } });
      await fetch(`https://127.0.0.1:${at}/files/secret-file-id-123`, { headers: { Authorization: 'Bearer alice-tok' }, tls: { ca: ca() } } as RequestInit);
      await fetch(`http://127.0.0.1:${a}/agents/bob`, { headers: { Authorization: `Bearer ${ADMIN}` } });
      await fetch(`http://127.0.0.1:${a}/agents`);   // unauthenticated: not a token-authenticated request
    });
    const http = evts(lines, 'agent.http');
    expect(http.map(e => ({ agent_id: e.agent_id, route: e.route, tls: e.tls }))).toEqual([
      { agent_id: 'alice', route: 'GET /messages', tls: false },
      { agent_id: 'alice', route: 'GET /files/:id', tls: true },
      { agent_id: 'admin', route: 'GET /agents/:id', tls: false },
    ]);
    for (const e of http) expect(String(e.src_ip)).toMatch(/127\.0\.0\.1$/);
    const all = JSON.stringify(http);
    expect(all).not.toContain('secret-file-id-123');
    expect(all).not.toContain('limit=5');
    expect(all).not.toContain('alice-tok');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// M6 — GET /connections
// ════════════════════════════════════════════════════════════════════════════

describe('M6: GET /connections', () => {
  it('per agent (persisted): last scheme, src_ip, auth time, and when it last used plaintext', async () => {
    freshDb();
    const [p, t, a] = ports();
    const wsh = await startWs(p, t);
    await startAdmin(a, wsh);
    const plain = await capture(() => rawAuth(`ws://127.0.0.1:${p}`, 'bob', 'bob-tok')); socks.push(plain.v.ws);
    const tls = await capture(() => rawAuth(`wss://127.0.0.1:${t}`, 'alice', 'alice-tok', true)); socks.push(tls.v.ws);
    const { v: res } = await capture(() => adminFetch(`http://127.0.0.1:${a}`, '/connections'));
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: Record<string, unknown>[]; since_boot: number };
    const byId = Object.fromEntries(body.agents.map(x => [x.id, x]));
    expect(byId.bob).toMatchObject({ last_scheme: 'ws' });
    expect(typeof byId.bob!.last_plaintext_at).toBe('number');
    expect(byId.alice).toMatchObject({ last_scheme: 'wss', last_plaintext_at: null });
    expect(String(byId.alice!.last_src_ip)).toMatch(/127\.0\.0\.1$/);
    expect(typeof byId.alice!.last_auth_at).toBe('number');
    expect(byId.watcher).toMatchObject({ last_scheme: null, last_auth_at: null });   // never connected
    // Persisted: survives in the row, not just in memory.
    expect(getAgentById(db!, 'alice')!.last_scheme).toBe('wss');
  });

  it('an agent token over the PLAINTEXT admin listener also counts as plaintext use', async () => {
    freshDb();
    const [, , a, at] = ports();
    await startAdmin(a, null, at);
    await capture(() => fetch(`https://127.0.0.1:${at}/messages`, { headers: { Authorization: 'Bearer alice-tok' }, tls: { ca: ca() } } as RequestInit));
    expect(getAgentById(db!, 'alice')!.last_plaintext_at ?? null).toBeNull();
    await capture(() => fetch(`http://127.0.0.1:${a}/messages`, { headers: { Authorization: 'Bearer alice-tok' } }));
    expect(typeof getAgentById(db!, 'alice')!.last_plaintext_at).toBe('number');
    expect(getAgentById(db!, 'alice')!.last_scheme).toBe('http');
  });

  it('per non-agent caller by src_ip, in memory since boot — and says so', async () => {
    freshDb();
    const [, , a] = ports();
    await startAdmin(a, null, undefined, { metricsToken: 'm-tok' });
    await capture(() => fetch(`http://127.0.0.1:${a}/metrics`, { headers: { Authorization: 'Bearer m-tok' } }));
    const { v: res } = await capture(() => adminFetch(`http://127.0.0.1:${a}`, '/connections'));
    const body = await res.json() as { since_boot: number; callers: Record<string, unknown>[] };
    expect(typeof body.since_boot).toBe('number');
    const kinds = body.callers.map(c => `${c.kind}/${c.last_scheme}`).sort();
    expect(kinds).toEqual(['admin/http', 'metrics/http']);
    for (const c of body.callers) expect(String(c.src_ip)).toMatch(/127\.0\.0\.1$/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Done-when: M6 lists no plaintext listener when both plaintext ports are off.
// The REAL server, so the listeners are the ones main() started.
// ════════════════════════════════════════════════════════════════════════════

describe('M6 end to end: both plaintext ports off → /connections lists no plaintext listener', () => {
  it('the listeners in /connections match the boot line, and none is plaintext', async () => {
    const [, t, , at] = ports();
    const dataDir = mkdtempSync(join(tmpdir(), 'r65b-e2e-'));
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'server.ts')], {
      env: {
        ...process.env, MESH_ADMIN_TOKEN: ADMIN, MESH_DB_PATH: join(dataDir, 'mesh.db'), MESH_FILES_DIR: join(dataDir, 'files'),
        MESH_WS_PORT: 'off', MESH_WS_TLS_PORT: String(t), MESH_ADMIN_PORT: 'off', MESH_ADMIN_TLS_PORT: String(at),
        MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: f('bus.key'),
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      let body: { listeners: { name: string; port: number | 'off'; scheme: string }[] } | null = null;
      const deadline = Date.now() + 15_000;
      while (body === null && Date.now() < deadline) {
        await wait(300);
        try {
          const r = await fetch(`https://127.0.0.1:${at}/connections`, { headers: { Authorization: `Bearer ${ADMIN}` }, tls: { ca: ca() } } as RequestInit);
          if (r.status === 200) body = await r.json() as typeof body;
        } catch { /* not up yet */ }
      }
      expect(body).not.toBeNull();
      expect(body!.listeners).toEqual([
        { name: 'ws', port: 'off', scheme: 'off' },
        { name: 'ws_tls', port: t, scheme: 'wss' },
        { name: 'admin', port: 'off', scheme: 'off' },
        { name: 'admin_tls', port: at, scheme: 'https' },
      ]);
      expect(body!.listeners.filter(l => l.scheme === 'ws' || l.scheme === 'http')).toEqual([]);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);
});

describe('the ALTER is idempotent on an existing database', () => {
  it('a database without the M6 columns gains them, keeps its rows, and reopens without error', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'r65b-db-')), 'mesh.db');
    const d1 = openDb(file);
    registerAgent(d1, { id: 'old-agent', token_hash: hashToken('t'), hostname: 'h' });
    for (const c of ['last_scheme', 'last_src_ip', 'last_auth_at', 'last_plaintext_at']) d1.exec(`ALTER TABLE agents DROP COLUMN ${c}`);
    d1.close();
    const d2 = openDb(file);
    expect(getAgentById(d2, 'old-agent')!.last_scheme ?? null).toBeNull();
    d2.close();
    const d3 = openDb(file);
    const cols = (d3.prepare("SELECT name FROM pragma_table_info('agents')").all() as { name: string }[]).map(x => x.name);
    for (const c of ['last_scheme', 'last_src_ip', 'last_auth_at', 'last_plaintext_at']) expect(cols).toContain(c);
    d3.close();
  });
});
