import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { openDb, registerAgent, aclGrant, markTlsSeen } from '../db.ts';
import { hashToken } from '../auth.ts';
import { routeFile } from '../router.ts';
import { startWsServer, type WsServerHandle } from '../ws-server.ts';
import { loadTls, type ServerTls } from '../tls-config.ts';
import { MeshClient } from '../../client/src/client.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

// R-73: every temp dir this file makes is removed when it is done.
const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

// R-267 — GET /files/:id on the WS (agent) port, beside /healthz and
// /peers/register, so an agent that can reach only the agent port can fetch
// its files. A NEW door, so its rules are pinned from outside:
//   - the AGENT token only (the admin token is refused here, so it never has
//     to cross the network to fetch a file);
//   - the existing node scoping (sender or recipient), and anything else gets
//     the SAME 404 as a missing file — no existence oracle;
//   - the R-65 TLS latch and the agent.http line carry over;
//   - nothing else from the admin table is reachable on this port.

const dir = tmp('mesh-r267-');
const f = (n: string) => join(dir, n);
let TLS: ServerTls;
let CA = '';
beforeAll(() => {
  const run = (...a: string[]) => { const r = Bun.spawnSync(['openssl', ...a], { cwd: dir, stderr: 'pipe' }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=ca');
  run('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'bus.key', '-out', 'bus.csr', '-subj', '/CN=bus');
  writeFileSync(f('bus.ext'), 'subjectAltName=IP:127.0.0.1\n');
  run('x509', '-req', '-in', 'bus.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'bus.pem', '-days', '2', '-extfile', 'bus.ext');
  const t = loadTls({ MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: f('bus.key') });
  if (!t.ok || t.server === null) throw new Error('fixture TLS did not load');
  TLS = t.server;
  CA = readFileSync(f('ca.pem'), 'utf8');
});

// Below the ephemeral port range (32768+), so a listen port cannot collide
// with an outgoing connection's source port.
const ports = () => { const b = 21000 + Math.floor(Math.random() * 1900); return [b, b + 1] as const; };
const ADMIN = 'admin-r267';   // never configured on the WS listener; used to prove it is refused there
const BYTES = Buffer.from('attachment bytes é\u0001', 'utf8');

let db: Database | undefined;
const handles: WsServerHandle[] = [];
const clients: MeshClient[] = [];
const realLog = console.log;
afterEach(async () => {
  console.log = realLog;
  for (const c of clients.splice(0)) { try { c.close(); } catch { /* ignore */ } }
  for (const h of handles.splice(0)) await h.shutdown().catch(() => {});
  db?.close(); db = undefined;
});

/** A bus with plain + TLS WS listeners and one stored file alice → bob. */
async function bus(): Promise<{ p: number; t: number; fileId: string; lines: string[] }> {
  db = openDb(':memory:');
  for (const id of ['alice', 'bob', 'carol']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
  aclGrant(db, 'alice', 'bob', 'admin');
  const filesDir = tmp('r267-files-');
  const r = routeFile(db, new Map(), 'alice', { type: 'file_send', msg_id: 'f1', to: 'bob', filename: 'a.bin', data: BYTES.toString('base64') } as never, 10_485_760, filesDir);
  if (!r.ok || r.fileId === undefined) throw new Error('fixture file not stored');
  const [p, t] = ports();
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  handles.push(await startWsServer(p, db, 10_485_760, filesDir, 0, new Map(), TLS, { tlsPort: t }));
  return { p, t, fileId: r.fileId, lines };
}

const get = (url: string, token?: string, tls = false) => fetch(url, {
  ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
  ...(tls ? { tls: { ca: CA } } : {}),
} as RequestInit);
const evts = (lines: string[], evt: string) => lines.flatMap(l => { try { const o = JSON.parse(l); return o?.evt === evt ? [o] : []; } catch { return []; } });

describe('R-267: GET /files/:id on the WS port — node scoping', () => {
  it('the RECIPIENT fetches the bytes', async () => {
    const { p, fileId } = await bus();
    const res = await get(`http://127.0.0.1:${p}/files/${fileId}`, 'bob-tok');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
  });

  it('the SENDER fetches the bytes', async () => {
    const { p, fileId } = await bus();
    const res = await get(`http://127.0.0.1:${p}/files/${fileId}`, 'alice-tok');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
  });

  it('HEADLINE: another agent\'s VALID token gets the same 404 as a missing id — no existence oracle', async () => {
    const { p, fileId } = await bus();
    const other = await get(`http://127.0.0.1:${p}/files/${fileId}`, 'carol-tok');
    const missing = await get(`http://127.0.0.1:${p}/files/no-such-file`, 'carol-tok');
    const a = { status: other.status, body: await other.text() };
    const b = { status: missing.status, body: await missing.text() };
    expect(a).toEqual({ status: 404, body: '{"error":"file not found"}' });
    expect(a).toEqual(b);
  });
});

describe('R-267: the credential on this door is the AGENT token, and only it', () => {
  it('no token and a bad token → 401, identical', async () => {
    const { p, fileId } = await bus();
    const none = await get(`http://127.0.0.1:${p}/files/${fileId}`);
    const bad = await get(`http://127.0.0.1:${p}/files/${fileId}`, 'not-a-token');
    expect({ s: none.status, b: await none.text() }).toEqual({ s: 401, b: '{"error":"unauthorized"}' });
    expect({ s: bad.status, b: await bad.text() }).toEqual({ s: 401, b: '{"error":"unauthorized"}' });
  });

  it('the ADMIN token is refused here — 401, the same body as no token', async () => {
    // The WS listener is not given the admin token at all, so this proves the
    // door does not accept one by any route; and the admin port is where it
    // belongs.
    const { p, fileId } = await bus();
    const res = await get(`http://127.0.0.1:${p}/files/${fileId}`, ADMIN);
    expect({ s: res.status, b: await res.text() }).toEqual({ s: 401, b: '{"error":"unauthorized"}' });
  });

  it('another admin route on the WS port is still 404 — the door is files plus R-318\'s /messages', async () => {
    const { p, fileId } = await bus();
    // `/messages` left this list deliberately in R-318 (r318-messages-agent-port.test.ts).
    for (const path of ['/agents', '/connections', '/files', '/topics', '/acl', '/metrics']) {
      const res = await get(`http://127.0.0.1:${p}${path}`, 'bob-tok');
      expect({ path, s: res.status }).toEqual({ path, s: 404 });
    }
    // and the method matters: only GET. A REAL file id and its recipient's own
    // token, so a door that accepted POST would answer 200 with the bytes —
    // a made-up id would 404 either way and prove nothing.
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${p}/files/${fileId}`, { method, headers: { Authorization: 'Bearer bob-tok' } });
      expect({ method, s: res.status }).toEqual({ method, s: 404 });
    }
  });
});

describe('R-267: R-65 semantics carry over', () => {
  it('a TLS-latched agent is refused on the PLAINTEXT listener and served on TLS', async () => {
    const { p, t, fileId, lines } = await bus();
    markTlsSeen(db!, 'bob');
    const plain = await get(`http://127.0.0.1:${p}/files/${fileId}`, 'bob-tok');
    expect({ s: plain.status, b: await plain.text() }).toEqual({ s: 401, b: '{"error":"unauthorized"}' });
    expect(evts(lines, 'agent.http').filter(e => e.refused === 'tls_latched')).toMatchObject([{ agent_id: 'bob', tls: false }]);
    const viaTls = await get(`https://127.0.0.1:${t}/files/${fileId}`, 'bob-tok', true);
    expect(viaTls.status).toBe(200);
  });

  it('works on the TLS WS listener, and logs agent.http with the route PATTERN, tls and listener', async () => {
    const { t, fileId, lines } = await bus();
    const res = await get(`https://127.0.0.1:${t}/files/${fileId}`, 'bob-tok', true);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
    const line = evts(lines, 'agent.http').find(e => e.route === 'GET /files/:id')!;
    expect(line).toMatchObject({ principal: 'agent', agent_id: 'bob', tls: true, listener: 'ws', src_ip: '127.0.0.1' });
    expect(JSON.stringify(line)).not.toContain(fileId);   // the pattern, never the id
  });
});

describe('R-267: the client needs no change', () => {
  it('fetchFile with NO httpUrl / MESH_HTTP_URL derives the WS URL and fetches end to end', async () => {
    const { p, fileId } = await bus();
    const saved = process.env.MESH_HTTP_URL;
    delete process.env.MESH_HTTP_URL;
    try {
      const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${p}`, agentId: 'bob', agentToken: 'bob-tok' });
      clients.push(c);
      const bytes = await c.fetchFile(fileId);
      expect(Buffer.from(bytes).equals(BYTES)).toBe(true);
    } finally {
      if (saved !== undefined) process.env.MESH_HTTP_URL = saved;
    }
  });
});
