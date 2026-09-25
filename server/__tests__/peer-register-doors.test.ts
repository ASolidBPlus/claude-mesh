import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type * as net from 'net';
import { Database } from 'bun:sqlite';
import { openDb, getPeerByAlias } from '../db.ts';
import { startHttpAdmin, type HttpAdminHandle, ROUTES, PEER_REGISTER_ROUTE } from '../http-admin.ts';
import { startWsServer, type WsServerHandle } from '../ws-server.ts';
import { loadTls } from '../tls-config.ts';
import { PEER_REGISTER_MAX_BYTES } from '../admin-peers.ts';

// POST /peers/register on the WS listener as well as the admin listener: one
// route object, two doors. The point is to move ONE route onto the port peers
// must reach — so the admin port can stay on loopback — and NOT to open the
// admin surface on the peer port.

const ADMIN = 'admin-token-for-doors';

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  const cap = (...a: unknown[]): void => { lines.push(a.map(String).join(' ')); };
  console.error = cap as typeof console.error;
  console.log = cap as typeof console.log;
  return { lines, restore: () => { console.error = origErr; console.log = origLog; } };
}

let db: Database;
let admin: HttpAdminHandle;
let wsHandle: WsServerHandle;
let adminBase: string;
let wsBase: string;

async function up(tls: Parameters<typeof startWsServer>[6] = null): Promise<void> {
  db = openDb(':memory:');
  admin = await startHttpAdmin(0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-doors-a-')), new Map());
  adminBase = `http://127.0.0.1:${(admin.server.address() as net.AddressInfo).port}`;
  const port = 26000 + Math.floor(Math.random() * 2000);
  const cap = captureConsole();
  try {
    wsHandle = await startWsServer(port, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-doors-w-')), 0, new Map(), tls);
  } finally { cap.restore(); }
  wsBase = `${tls === null ? 'http' : 'https'}://127.0.0.1:${port}`;
}

async function down(): Promise<void> {
  await wsHandle?.shutdown().catch(() => {});
  await admin?.shutdown().catch(() => {});
  db?.close();
}

async function mint(alias: string): Promise<string> {
  const res = await fetch(`${adminBase}/peer-keys`, {
    method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias, kinds: ['direct', 'topic'], rate_per_min: 120 }),
  });
  return ((await res.json()) as { key: string }).key;
}

const register = (base: string, body: string, init: RequestInit = {}) =>
  fetch(`${base}/peers/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, ...init });

describe('/peers/register: both doors, identical behaviour', () => {
  beforeEach(async () => { await up(); });
  afterEach(down);

  it('a valid key registers identically through either door', async () => {
    const viaAdmin = await register(adminBase, JSON.stringify({ key: await mint('org-a') }));
    const viaWs = await register(wsBase, JSON.stringify({ key: await mint('org-b') }));
    expect(viaAdmin.status).toBe(201);
    expect(viaWs.status).toBe(201);
    const a = await viaAdmin.json() as Record<string, unknown>;
    const w = await viaWs.json() as Record<string, unknown>;
    // Same shape and same grant; only the alias and the fresh token differ.
    const strip = (o: Record<string, unknown>) => ({ ...o, alias: '*', token: typeof o.token });
    expect(strip(w)).toEqual(strip(a));
    // And the WS door's registration is REAL — a stored, enabled peer.
    expect(getPeerByAlias(db, 'org-b')).toMatchObject({ alias: 'org-b', disabled: 0, rate_per_min: 120 });
  });

  it('every refusal is the same uniform 403 through either door', async () => {
    const cases: [string, string][] = [
      ['wrong key', JSON.stringify({ key: 'f'.repeat(64) })],
      ['missing key', JSON.stringify({})],
      ['malformed JSON', '{not json'],
      ['oversize body', JSON.stringify({ key: 'x'.repeat(PEER_REGISTER_MAX_BYTES + 1) })],
    ];
    for (const [name, body] of cases) {
      const a = await register(adminBase, body);
      const w = await register(wsBase, body);
      const got = { name, admin: [a.status, await a.text()], ws: [w.status, await w.text()] };
      expect(got).toEqual({ name, admin: [403, '{"error":"registration refused"}'], ws: [403, '{"error":"registration refused"}'] });
    }
  });

  it('the WS door leaves the same audit record, naming the door', async () => {
    const key = await mint('org-c');
    const cap = captureConsole();
    try { expect((await register(wsBase, JSON.stringify({ key }))).status).toBe(201); } finally { cap.restore(); }
    const rec = cap.lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(o => o?.evt === 'admin.mutation');
    expect(rec).toMatchObject({ method: 'POST', path: '/peers/register', status: 201, actor: 'unauthenticated', listener: 'ws' });
  });
});

describe('/peers/register: the size ceiling', () => {
  beforeEach(async () => { await up(); });
  afterEach(down);

  it('a body just under the ceiling is READ (and refused only for its content), one byte over is not read', async () => {
    // Positive control for the cap: a body at the limit reaches the key check
    // (the log says unknown_key), so the 403 for the oversize body below is
    // the ceiling speaking, not the JSON parser or the key lookup.
    const pad = (n: number) => JSON.stringify({ key: 'k', pad: 'p'.repeat(n) });
    const base = pad(0).length;
    const atLimit = pad(PEER_REGISTER_MAX_BYTES - base);
    const overLimit = pad(PEER_REGISTER_MAX_BYTES - base + 1);
    expect(Buffer.byteLength(atLimit)).toBe(PEER_REGISTER_MAX_BYTES);

    for (const door of [adminBase, wsBase]) {
      const cap = captureConsole();
      try {
        await register(door, atLimit);
        await register(door, overLimit);
      } finally { cap.restore(); }
      const reasons = cap.lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(o => o?.evt === 'peer.register_refused').map(o => o.reason);
      expect({ door, reasons }).toEqual({ door, reasons: ['unknown_key', 'body_too_large'] });
    }
  });
});

describe('the WS listener serves ONE admin route and no other', () => {
  beforeEach(async () => { await up(); });
  afterEach(down);

  /**
   * A concrete path for every route in the table, from the source. Checked
   * against ROUTES itself below, so a route the parser misses is a failure
   * rather than a route this test silently never tries.
   */
  function samplePaths(): string[] {
    const src = readFileSync(join(import.meta.dir, '../http-admin.ts'), 'utf8');
    const exacts = [...src.matchAll(/match:\s*exact\('([^']+)'\)/g)].map(m => m[1]!);
    const ids = [...src.matchAll(/match:\s*idMatch\(\/\^(.+?)\$\/\)/g)]
      .map(m => m[1]!.replace(/\(\[\^\/\]\+\)/g, 'x').replace(/\\\//g, '/'));
    return [...exacts, ...ids];
  }

  it('every route in the admin table 404s on the WS listener — even with the admin token — except /peers/register', async () => {
    const paths = samplePaths();
    const probes = ROUTES.map(r => ({ method: r.method, path: paths.find(p => r.match(p) !== null), route: r }));
    // Parser control: every route has a path its own matcher accepts.
    expect(probes.filter(p => p.path === undefined).map(p => p.method)).toEqual([]);
    expect(probes.length).toBe(ROUTES.length);
    expect(probes.length).toBeGreaterThanOrEqual(30);

    const served: string[] = [];
    for (const p of probes) {
      const res = await fetch(`${wsBase}${p.path}`, {
        method: p.method,
        headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
        ...(p.method === 'GET' ? {} : { body: '{}' }),
      });
      await res.text();
      if (res.status !== 404) served.push(`${p.method} ${p.path} -> ${res.status}`);
    }
    // Exactly the one route, and it answered as registration (a refusal of
    // `{}`), not as something else that happened to share its path.
    expect(served).toEqual(['POST /peers/register -> 403']);
    expect(PEER_REGISTER_ROUTE.auth).toBe('handler');

    // And /metrics — not in the table, special-cased on the admin port — is
    // not here either.
    expect((await fetch(`${wsBase}/metrics`)).status).toBe(404);
  });

  it('GET /peers/register is not served on the WS listener (the route is POST only)', async () => {
    expect((await fetch(`${wsBase}/peers/register`)).status).toBe(404);
  });
});

describe('/peers/register over native TLS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-doors-tls-'));
  const openssl = (...args: string[]): void => {
    const r = Bun.spawnSync(['openssl', ...args], { cwd: dir, stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr.toString()}`);
  };
  beforeAll(() => {
    openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=range-ca');
    openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', 'bus.key', '-out', 'bus.csr', '-subj', '/CN=bus');
    writeFileSync(join(dir, 'bus.ext'), 'subjectAltName=IP:127.0.0.1\n');
    openssl('x509', '-req', '-in', 'bus.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'bus.pem', '-days', '2', '-extfile', 'bus.ext');
  });
  afterEach(down);

  it('the key crosses TLS: registration succeeds over https on the WS port, and plain http there does not', async () => {
    const t = loadTls({ MESH_TLS_CERT: join(dir, 'bus.pem'), MESH_TLS_KEY: join(dir, 'bus.key') });
    if (!t.ok || t.server === null) throw new Error('fixture TLS did not load');
    await up(t.server);
    const ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
    const key = await mint('org-tls');
    const res = await register(wsBase, JSON.stringify({ key }), { tls: { ca } } as RequestInit);
    expect(res.status).toBe(201);
    const plain = await register(wsBase.replace('https://', 'http://'), JSON.stringify({ key })).then(r => r.status, () => 'refused');
    expect(plain).not.toBe(201);
  });
});
