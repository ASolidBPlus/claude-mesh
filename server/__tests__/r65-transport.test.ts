import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as net from 'net';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { openDb, registerAgent, getAgentById, isTlsLatched } from '../db.ts';
import { hashToken, adminTokenMatches } from '../auth.ts';
import { startWsServer, type WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, type HttpAdminHandle } from '../http-admin.ts';
import { loadTls, type ServerTls } from '../tls-config.ts';
import { MeshClient } from '../../client/src/client.ts';

// R-65 PR-A — TLS listeners BESIDE plaintext, explicit `off`, the TLS latch,
// and MESH_ADMIN_TOKEN_PREV. One describe per Done-when item in scope, plus
// the #215 compat pin and the migration.
//
// Certificates are generated per run (a committed key is what
// no-committed-secrets refuses). SANs: DNS:localhost and IP:127.0.0.1 — the
// CA tests dial the DNS NAME, so a "wrong CA refused" cannot pass on the
// runtime's IP-identity behaviour instead (measured on #215).

const dir = mkdtempSync(join(tmpdir(), 'mesh-r65-'));
const f = (n: string) => join(dir, n);
function openssl(...args: string[]): void {
  const r = Bun.spawnSync(['openssl', ...args], { cwd: dir, stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr.toString()}`);
}
let TLS: ServerTls;
let CA = '';
let OTHER_CA = '';
beforeAll(() => {
  for (const ca of ['range-ca', 'other-ca']) {
    openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', `${ca}.key`, '-out', `${ca}.pem`, '-days', '2', '-subj', `/CN=${ca}`);
  }
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'bus.key', '-out', 'bus.csr', '-subj', '/CN=bus');
  writeFileSync(f('bus.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  openssl('x509', '-req', '-in', 'bus.csr', '-CA', 'range-ca.pem', '-CAkey', 'range-ca.key', '-CAcreateserial',
    '-out', 'bus.pem', '-days', '2', '-extfile', 'bus.ext');
  const t = loadTls({ MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: f('bus.key') });
  if (!t.ok || t.server === null) throw new Error('fixture TLS did not load');
  TLS = t.server;
  CA = readFileSync(f('range-ca.pem'), 'utf8');
  OTHER_CA = readFileSync(f('other-ca.pem'), 'utf8');
});

// Below the ephemeral port range (32768+): a random listen port in it can
// collide with an outgoing connection's source port (CI flake, R-69).
const ports = () => { const b = 12000 + Math.floor(Math.random() * 2900); return [b, b + 1, b + 2, b + 3] as const; };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const ADMIN = 'admin-r65';

function quiet<T>(fn: () => Promise<T>): Promise<{ v: T; lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return fn().then(v => ({ v, lines })).finally(() => { console.log = log; });
}
const evts = (lines: string[], evt: string) => lines.flatMap(l => {
  try { const o = JSON.parse(l) as Record<string, unknown>; return o?.evt === evt ? [o] : []; } catch { return []; }
});

/** A raw socket that sends one auth frame and records every frame back. */
async function rawAuth(url: string, agentId: string, token: string, ca?: string): Promise<{ ws: WebSocket; frames: Record<string, unknown>[]; closed: () => boolean }> {
  const ws = new WebSocket(url, ca === undefined ? undefined : { tls: { ca }, ca } as never);
  const frames: Record<string, unknown>[] = [];
  let isClosed = false;
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  ws.on('close', () => { isClosed = true; });
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'auth', agent_id: agentId, token }));
  await wait(150);
  return { ws, frames, closed: () => isClosed };
}

let db: Database | undefined;
const handles: { shutdown(): Promise<void> }[] = [];
const sockets: { close(): void }[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close(); } catch { /* ignore */ } }
  for (const h of handles.splice(0)) await h.shutdown().catch(() => {});
  db?.close(); db = undefined;
});

function freshDb(): Database {
  db = openDb(':memory:');
  for (const id of ['alice', 'bob']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
  return db;
}

async function ws(port: number | 'off', tls: ServerTls | null, tlsPort?: number) {
  const { v, lines } = await quiet(() => startWsServer(port, db!, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-r65f-')), 0, new Map(), tls,
    tlsPort === undefined ? {} : { tlsPort }));
  handles.push(v);
  return { h: v as WsServerHandle, lines };
}
async function admin(port: number | 'off', opts: Parameters<typeof startHttpAdmin>[9] = {}) {
  const { v, lines } = await quiet(() => startHttpAdmin(port, db!, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-r65a-')),
    new Map(), new Map(), new Map(), {}, opts));
  handles.push(v);
  return { h: v as HttpAdminHandle, lines };
}

// ════════════════════════════════════════════════════════════════════════════

describe('compat: cert/key with NO *_TLS_PORT is #215 exactly — one TLS listener', () => {
  it('one listener, named ws, serving wss at the given port; plaintext does not connect; the boot line has no listener field', async () => {
    freshDb();
    const [p] = ports();
    const { h, lines } = await ws(p, TLS);
    expect(h.listeners.map(l => [l.name, l.scheme])).toEqual([['ws', 'wss']]);
    const ok = await rawAuth(`wss://127.0.0.1:${p}`, 'alice', 'alice-tok', CA); sockets.push(ok.ws);
    expect(ok.frames[0]?.type).toBe('auth_ok');
    const plain = await new Promise<string>(r => { const s = new WebSocket(`ws://127.0.0.1:${p}`); s.on('open', () => { r('open'); s.close(); }); s.on('error', () => r('refused')); setTimeout(() => r('timeout'), 2000); });
    expect(plain).not.toBe('open');
    const boot = evts(lines, 'ws.listening');
    expect(boot.length).toBe(1);
    expect('listener' in boot[0]!).toBe(false);
    expect(boot[0]!.tls).toBe(true);
  });
});

describe('compat (#215 bus): a TLS auth does NOT latch — the plain admin listener still serves the agent', () => {
  // Review B1. On a single-listener TLS bus every auth is TLS and the admin
  // listener is plain, so latching there 401'd every agent's own /messages
  // and /files — and plain admin via MESH_HTTP_URL is fetchFile's only door.
  it('tls_seen stays null after a wss auth, and /messages with the agent token is 200 on plain admin', async () => {
    freshDb();
    const [p, , a] = ports();
    await ws(p, TLS);
    await admin(a);
    const s = await rawAuth(`wss://127.0.0.1:${p}`, 'alice', 'alice-tok', CA); sockets.push(s.ws);
    expect(s.frames[0]?.type).toBe('auth_ok');
    expect(getAgentById(db!, 'alice')!.tls_seen ?? null).toBeNull();
    const { v: res } = await quiet(() => fetch(`http://127.0.0.1:${a}/messages`, { headers: { Authorization: 'Bearer alice-tok' } }));
    expect(res.status).toBe(200);
  });
});

describe('oversize frames: the same refusal on BOTH listeners (noServer path)', () => {
  // WHAT THIS PINS, AND WHAT IT DOES NOT. maxPayload is passed to the
  // WebSocketServer, but Bun's `ws` does not enforce it — measured on main
  // e0d3793 BEFORE this change, with the identical result: a 1.2 MB frame is
  // buffered and parsed, and the ROUTER refuses it (MESSAGE_TOO_LARGE). So
  // F2b (c)'s "dropped before the parser" does not hold on Bun, on either code
  // path; that is a separate, pre-existing finding. What this PR must not do
  // is make either listener behave differently from the other or from main.
  it('a frame above the payload cap is refused MESSAGE_TOO_LARGE on plaintext and TLS, nothing is stored, and the socket keeps working', async () => {
    freshDb();
    const [p, t] = ports();
    await ws(p, TLS, t);
    for (const [url, ca] of [[`ws://127.0.0.1:${p}`, undefined], [`wss://127.0.0.1:${t}`, CA]] as const) {
      const s = await rawAuth(url, 'bob', 'bob-tok', ca); sockets.push(s.ws);
      expect(s.frames[0]?.type).toBe('auth_ok');
      s.ws.send(JSON.stringify({ type: 'send', msg_id: `big-${url}`, to: 'alice', payload: 'x'.repeat(1_200_000) }));
      await wait(400);
      expect({ url, refusal: s.frames.find(fr => fr.ref === `big-${url}`)?.code }).toEqual({ url, refusal: 'MESSAGE_TOO_LARGE' });
      expect(s.closed()).toBe(false);
    }
    expect((db!.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(0);
  });
});

describe('Done-when: TLS auth works on the TLS port while plaintext still works', () => {
  it('both listeners up; an agent on each; ONE state — newer-wins displaces across ports', async () => {
    freshDb();
    const [p, t] = ports();
    const { h, lines } = await ws(p, TLS, t);
    expect(h.listeners.map(l => [l.name, l.scheme])).toEqual([['ws', 'ws'], ['ws_tls', 'wss']]);
    expect(evts(lines, 'ws.listening').map(e => [e.listener, e.tls])).toEqual([['ws', false], ['ws_tls', true]]);

    const bobPlain = await rawAuth(`ws://127.0.0.1:${p}`, 'bob', 'bob-tok'); sockets.push(bobPlain.ws);
    expect(bobPlain.frames[0]?.type).toBe('auth_ok');
    const aliceTls = await rawAuth(`wss://127.0.0.1:${t}`, 'alice', 'alice-tok', CA); sockets.push(aliceTls.ws);
    expect(aliceTls.frames[0]?.type).toBe('auth_ok');

    // Shared indexes: bob (plaintext) re-auths over TLS and DISPLACES his own
    // plaintext socket — which is only possible if both listeners feed one
    // agentIndex.
    const bobTls = await rawAuth(`wss://127.0.0.1:${t}`, 'bob', 'bob-tok', CA); sockets.push(bobTls.ws);
    expect(bobTls.frames[0]?.type).toBe('auth_ok');
    expect(bobPlain.frames.some(fr => fr.code === 'DISPLACED')).toBe(true);
    expect(h.agentIndex.size).toBe(2);
  });
});

describe('Done-when: X latched on TLS — a plaintext auth with X\'s VALID token is refused and X is NOT displaced', () => {
  it('refused with the uniform body, logged tls_latched, and the TLS socket stays the live one', async () => {
    freshDb();
    const [p, t] = ports();
    const { h } = await ws(p, TLS, t);
    const tlsSock = await rawAuth(`wss://127.0.0.1:${t}`, 'alice', 'alice-tok', CA); sockets.push(tlsSock.ws);
    expect(tlsSock.frames[0]?.type).toBe('auth_ok');
    expect(isTlsLatched(db!, 'alice')).toBe(true);

    const { v: plain, lines } = await quiet(() => rawAuth(`ws://127.0.0.1:${p}`, 'alice', 'alice-tok'));
    sockets.push(plain.ws);
    expect(plain.frames).toEqual([{ type: 'error', code: 'AUTH_FAILED', message: 'unknown agent' }]);
    expect(evts(lines, 'agent.auth')).toMatchObject([{ agent_id: 'alice', tls: false, refused: 'tls_latched' }]);

    // NOT displaced: no DISPLACED frame, the socket is open, and it is still
    // the one the index routes to.
    expect(tlsSock.frames.some(fr => fr.code === 'DISPLACED')).toBe(false);
    expect(tlsSock.closed()).toBe(false);
    expect(h.agentIndex.get('alice')).toBeDefined();
    expect(getAgentById(db!, 'alice')!.online).toBe(1);
  });

  it('an UNLATCHED agent still authenticates over plaintext (the latch is per agent)', async () => {
    freshDb();
    const [p, t] = ports();
    await ws(p, TLS, t);
    const ok = await rawAuth(`ws://127.0.0.1:${p}`, 'bob', 'bob-tok'); sockets.push(ok.ws);
    expect(ok.frames[0]?.type).toBe('auth_ok');
    expect(isTlsLatched(db!, 'bob')).toBe(false);
  });

  it('DELETE /agents/:id/tls-latch (admin) clears it, and plaintext auth works again', async () => {
    freshDb();
    const [p, t, a] = ports();
    await ws(p, TLS, t);
    const { h: ad } = await admin(a);
    const tlsSock = await rawAuth(`wss://127.0.0.1:${t}`, 'alice', 'alice-tok', CA); tlsSock.ws.close();
    expect(isTlsLatched(db!, 'alice')).toBe(true);
    const base = `http://127.0.0.1:${(ad.server.address() as net.AddressInfo).port}`;
    expect((await fetch(`${base}/agents/alice/tls-latch`, { method: 'DELETE' })).status).toBe(401);
    const { v: res } = await quiet(() => fetch(`${base}/agents/alice/tls-latch`, { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'alice', tls_latched: false });
    expect((await quiet(() => fetch(`${base}/agents/nobody/tls-latch`, { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` } }))).v.status).toBe(404);
    const again = await rawAuth(`ws://127.0.0.1:${p}`, 'alice', 'alice-tok'); sockets.push(again.ws);
    expect(again.frames[0]?.type).toBe('auth_ok');
  });

  it('the HTTP half: a latched agent\'s token is refused on the PLAINTEXT admin listener and accepted on TLS', async () => {
    freshDb();
    const [, , a, at] = ports();
    const { h } = await admin(a, { tls: TLS, tlsPort: at });
    expect(h.servers.map(s => [s.name, s.scheme])).toEqual([['admin', 'http'], ['admin_tls', 'https']]);
    const { markTlsSeen } = await import('../db.ts');
    markTlsSeen(db!, 'alice');
    const plainGet = (tok: string) => fetch(`http://127.0.0.1:${a}/messages`, { headers: { Authorization: `Bearer ${tok}` } });
    const tlsGet = (tok: string) => fetch(`https://127.0.0.1:${at}/messages`, { headers: { Authorization: `Bearer ${tok}` }, tls: { ca: CA } } as RequestInit);
    const { v: refused, lines } = await quiet(() => plainGet('alice-tok'));
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe('{"error":"unauthorized"}');
    expect(evts(lines, 'agent.http')).toMatchObject([{ agent_id: 'alice', tls: false, refused: 'tls_latched' }]);
    expect((await quiet(() => tlsGet('alice-tok'))).v.status).not.toBe(401);
    // Controls: an unlatched agent over plaintext, and the admin token, pass.
    expect((await quiet(() => plainGet('bob-tok'))).v.status).not.toBe(401);
    expect((await quiet(() => plainGet(ADMIN))).v.status).not.toBe(401);
  });
});

describe('Done-when: with both plaintext ports off, TCP to them is refused', () => {
  const tcp = (port: number) => new Promise<'open' | 'refused'>(r => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); r('open'); });
    s.on('error', () => r('refused'));
  });

  it('plaintext numbered → TCP accepted (control); plaintext off → the same ports refuse, and only TLS listens', async () => {
    freshDb();
    const [p, t, a, at] = ports();
    await ws(p, TLS, t);
    await admin(a, { tls: TLS, tlsPort: at });
    expect([await tcp(p), await tcp(a), await tcp(t), await tcp(at)]).toEqual(['open', 'open', 'open', 'open']);
    for (const hd of handles.splice(0)) await hd.shutdown();
    await wait(100);

    const { h } = await ws('off', TLS, t);
    const { h: ad } = await admin('off', { tls: TLS, tlsPort: at });
    expect(h.listeners.map(l => l.name)).toEqual(['ws_tls']);
    expect(ad.servers.map(s => s.name)).toEqual(['admin_tls']);
    expect([await tcp(p), await tcp(a)]).toEqual(['refused', 'refused']);
    expect([await tcp(t), await tcp(at)]).toEqual(['open', 'open']);
  });
});

describe('Done-when: MESH_ADMIN_TOKEN_PREV is accepted until it is removed', () => {
  it('accepted on admin routes and /metrics while set; refused once the process runs without it', async () => {
    freshDb();
    const [, , a] = ports();
    const { h, lines } = await admin(a, { adminTokenPrev: 'old-admin', metricsToken: 'metrics-r65' });
    const base = `http://127.0.0.1:${(h.server.address() as net.AddressInfo).port}`;
    const get = (path: string, tok: string) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
    expect((await get('/agents', 'old-admin')).status).toBe(200);
    expect((await get('/agents', ADMIN)).status).toBe(200);
    expect((await get('/metrics', 'old-admin')).status).toBe(200);
    expect((await get('/messages', 'old-admin')).status).not.toBe(401);   // agentOrAdmin door
    expect((await get('/agents', 'not-a-token')).status).toBe(401);
    const boot = evts(lines, 'admin.listening')[0]!;
    expect(boot.admin_token_prev).toBe(true);
    expect(lines.join('\n')).not.toContain('old-admin');

    for (const hd of handles.splice(0)) await hd.shutdown();
    const { h: h2, lines: lines2 } = await admin(a, { metricsToken: 'metrics-r65' });
    const base2 = `http://127.0.0.1:${(h2.server.address() as net.AddressInfo).port}`;
    expect((await fetch(`${base2}/agents`, { headers: { Authorization: 'Bearer old-admin' } })).status).toBe(401);
    expect((await fetch(`${base2}/metrics`, { headers: { Authorization: 'Bearer old-admin' } })).status).toBe(401);
    expect(evts(lines2, 'admin.listening')[0]!.admin_token_prev).toBe(false);
  });

  it('adminTokenMatches: current or previous, never the empty previous', () => {
    expect(adminTokenMatches('', 'cur', '')).toBe(false);      // review N2
    expect(adminTokenMatches('cur', 'cur', '')).toBe(true);
    expect(adminTokenMatches('cur', 'cur', null)).toBe(true);
    expect(adminTokenMatches('old', 'cur', 'old')).toBe(true);
    expect(adminTokenMatches('old', 'cur', null)).toBe(false);
    expect(adminTokenMatches('x', 'cur', 'old')).toBe(false);
  });
});

describe('the ALTER is idempotent on an existing database', () => {
  it('a database that predates tls_seen gains it, keeps its rows, and reopens without error', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mesh-r65db-')), 'mesh.db');
    const d1 = openDb(file);
    registerAgent(d1, { id: 'old-agent', token_hash: hashToken('t'), hostname: 'h' });
    d1.exec('ALTER TABLE agents DROP COLUMN tls_seen');        // as it was before R-65
    expect((d1.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('agents') WHERE name = 'tls_seen'").get() as { n: number }).n).toBe(0);
    d1.close();
    const d2 = openDb(file);
    expect(getAgentById(d2, 'old-agent')!.tls_seen ?? null).toBeNull();
    d2.close();
    const d3 = openDb(file);                                   // and again: no duplicate-column failure
    expect((d3.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('agents') WHERE name = 'tls_seen'").get() as { n: number }).n).toBe(1);
    d3.close();
  }, 20_000);   // three file-backed opens: a fresh one alone measured 1.3-3.2 s on a loaded disk
});

describe('M3: the client CA — WS connect AND fetchFile, from config AND env', () => {
  // Dialled by NAME (localhost is in the SAN), so a refusal is the chain, not
  // the runtime's IP-identity behaviour.
  async function bus(): Promise<{ wsUrl: string; httpUrl: string }> {
    freshDb();
    const [, t, , at] = ports();
    await ws('off', TLS, t);
    await admin('off', { tls: TLS, tlsPort: at });
    return { wsUrl: `wss://localhost:${t}`, httpUrl: `https://localhost:${at}` };
  }
  async function connects(c: MeshClient): Promise<boolean> {
    const r = await Promise.race([c.connect().then(() => true, () => false), wait(1500).then(() => false)]);
    c.close();
    return r;
  }
  const fetchCode = (c: MeshClient) => c.fetchFile('no-such-file').then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message ?? 'error');

  it('config ca: the right CA connects and fetches; a different CA is refused on both', async () => {
    const { wsUrl, httpUrl } = await bus();
    const right = { serverUrl: wsUrl, httpUrl, agentId: 'alice', agentToken: 'alice-tok', ca: CA };
    const wrong = { ...right, ca: OTHER_CA };
    expect(await connects(new MeshClient(right))).toBe(true);
    expect(await connects(new MeshClient(wrong))).toBe(false);
    // 404 = TLS completed and the request reached the route; anything else on
    // the wrong CA is the handshake refusing.
    expect(await fetchCode(new MeshClient(right))).toBe('HTTP_404');
    expect(await fetchCode(new MeshClient(wrong))).not.toBe('HTTP_404');
  });

  it('env MESH_TLS_CA (a path, and PEM content) is used when config has no ca', async () => {
    const { wsUrl, httpUrl } = await bus();
    const saved = process.env.MESH_TLS_CA;
    try {
      for (const envVal of [f('range-ca.pem'), CA]) {
        process.env.MESH_TLS_CA = envVal;
        const cfg = { serverUrl: wsUrl, httpUrl, agentId: 'alice', agentToken: 'alice-tok' };
        expect(await connects(new MeshClient(cfg))).toBe(true);
        expect(await fetchCode(new MeshClient(cfg))).toBe('HTTP_404');
      }
      process.env.MESH_TLS_CA = f('other-ca.pem');
      const cfg = { serverUrl: wsUrl, httpUrl, agentId: 'alice', agentToken: 'alice-tok' };
      expect(await connects(new MeshClient(cfg))).toBe(false);
      expect(await fetchCode(new MeshClient(cfg))).not.toBe('HTTP_404');
    } finally {
      if (saved === undefined) delete process.env.MESH_TLS_CA; else process.env.MESH_TLS_CA = saved;
    }
  });
});

describe('end to end: the real server, both plaintext ports off', () => {
  it('boots, names every listener in mesh.listeners (off included), and only the TLS ports accept TCP', async () => {
    const [p, t, a, at] = ports();
    const dataDir = mkdtempSync(join(tmpdir(), 'mesh-r65e2e-'));
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'server.ts')], {
      env: {
        ...process.env, MESH_ADMIN_TOKEN: ADMIN, MESH_DB_PATH: join(dataDir, 'mesh.db'), MESH_FILES_DIR: join(dataDir, 'files'),
        MESH_WS_PORT: 'off', MESH_WS_TLS_PORT: String(t), MESH_ADMIN_PORT: 'off', MESH_ADMIN_TLS_PORT: String(at),
        MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: f('bus.key'),
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      let out = '';
      const reader = proc.stdout.getReader();
      const deadline = Date.now() + 15_000;
      // ONE outstanding read at a time. Racing a fresh read() against a timer
      // each loop abandons the losing read — and the chunk it later resolves
      // with is lost, which made this test flaky.
      let pending = reader.read();
      while (!out.includes('"mesh.listeners"') && Date.now() < deadline) {
        const r = await Promise.race([pending, wait(500).then(() => null)]);
        if (r === null) continue;
        if (r.done) break;
        if (r.value) out += new TextDecoder().decode(r.value);
        pending = reader.read();
      }
      const line = out.split('\n').find(l => l.includes('"mesh.listeners"'));
      expect(line).toBeDefined();
      expect(JSON.parse(line!).listeners).toEqual([
        { name: 'ws', port: 'off', scheme: 'off' },
        { name: 'ws_tls', port: t, scheme: 'wss' },
        { name: 'admin', port: 'off', scheme: 'off' },
        { name: 'admin_tls', port: at, scheme: 'https' },
      ]);
      const tcp = (port: number) => new Promise<'open' | 'refused'>(r => {
        const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); r('open'); });
        s.on('error', () => r('refused'));
      });
      // Nothing listens on the default plaintext ports or the ones we would have used.
      expect([await tcp(7384), await tcp(7385), await tcp(p), await tcp(a)]).toEqual(['refused', 'refused', 'refused', 'refused']);
      expect([await tcp(t), await tcp(at)]).toEqual(['open', 'open']);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);
});
