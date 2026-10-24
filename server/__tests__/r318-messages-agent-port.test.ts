import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import * as net from 'net';
import { Database } from 'bun:sqlite';
import { openDb, registerAgent, insertMessage, markTlsSeen } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, type WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, type HttpAdminHandle } from '../http-admin.ts';
import { loadTls, type ServerTls } from '../tls-config.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

// R-318 — GET /messages on the WS (agent) port, through R-267's door, so the
// chat stacks can read history there and the admin port can be narrowed:
//   - the AGENT token only; the admin token gets the same 401 as no token;
//   - the same handler and node scoping as the admin port, R-313's `with=`
//     included, and `agent=<another>` is 403;
//   - the R-65 TLS latch, the agent.http line with listener 'ws', and R-271's
//     rate-limited refusal log carry over;
//   - nothing else from the admin table answers here.

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

const dir = tmp('mesh-r318-');
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

// Below the ephemeral range, and clear of r267's 21000-22900.
let portCounter = 24600;
const ports = () => { const b = portCounter; portCounter += 2; return [b, b + 1] as const; };
const ADMIN = 'admin-r318';

let db: Database | undefined;
const handles: (WsServerHandle | HttpAdminHandle)[] = [];
const realLog = console.log;
afterEach(async () => {
  console.log = realLog;
  for (const h of handles.splice(0)) await h.shutdown().catch(() => {});
  db?.close(); db = undefined;
});

/** A bus with plain + TLS WS listeners. bob's traffic: alice<->bob directs and a
 *  topic copy; carol<->alice is traffic bob is no party to. */
async function bus(): Promise<{ p: number; t: number; lines: string[] }> {
  db = openDb(':memory:');
  for (const id of ['alice', 'bob', 'carol']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
  insertMessage(db, { id: 'ab-1', kind: 'direct', from_agent: 'alice', to_agent: 'bob', payload: '1', sent_at: 10 });
  insertMessage(db, { id: 'ba-2', kind: 'direct', from_agent: 'bob', to_agent: 'alice', payload: '2', sent_at: 20 });
  insertMessage(db, { id: 'topic-b', kind: 'topic', from_agent: 'alice', to_agent: 'bob', topic: 'news', payload: 't', sent_at: 30 });
  insertMessage(db, { id: 'ca-1', kind: 'direct', from_agent: 'carol', to_agent: 'alice', payload: 'x', sent_at: 40 });
  const [p, t] = ports();
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  handles.push(await startWsServer(p, db, 10_485_760, tmp('r318-files-'), 0, new Map(), TLS, { tlsPort: t }));
  return { p, t, lines };
}

const get = (url: string, token?: string, tls = false) => fetch(url, {
  ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
  ...(tls ? { tls: { ca: CA } } : {}),
} as RequestInit);
const ids = async (res: Response) => { expect(res.status).toBe(200); return ((await res.json()) as { id: string }[]).map(m => m.id); };
const evts = (lines: string[], evt: string) => lines.flatMap(l => { try { const o = JSON.parse(l); return o?.evt === evt ? [o] : []; } catch { return []; } });

describe('R-318: GET /messages on the WS port — node scoping', () => {
  it('an agent reads its own traffic, and only its own, on both listeners', async () => {
    const { p, t } = await bus();
    expect(await ids(await get(`http://127.0.0.1:${p}/messages`, 'bob-tok'))).toEqual(['topic-b', 'ba-2', 'ab-1']);
    expect(await ids(await get(`https://127.0.0.1:${t}/messages`, 'bob-tok', true))).toEqual(['topic-b', 'ba-2', 'ab-1']);
    expect(await ids(await get(`http://127.0.0.1:${p}/messages?agent=bob`, 'bob-tok'))).toEqual(['topic-b', 'ba-2', 'ab-1']);
  });

  it('another agent\'s scope is 403, as on the admin port', async () => {
    const { p } = await bus();
    const res = await get(`http://127.0.0.1:${p}/messages?agent=alice`, 'bob-tok');
    expect({ s: res.status, b: await res.text() }).toEqual({ s: 403, b: '{"error":"forbidden: cannot query another agent"}' });
  });

  it('R-313\'s with= works here, scoped to the caller', async () => {
    const { p } = await bus();
    expect(await ids(await get(`http://127.0.0.1:${p}/messages?with=alice`, 'bob-tok'))).toEqual(['ba-2', 'ab-1']);
    // carol<->alice is never bob's, whatever he asks.
    expect(await ids(await get(`http://127.0.0.1:${p}/messages?with=carol`, 'bob-tok'))).toEqual([]);
  });

  it('the same bytes as the admin port answers the same agent', async () => {
    const { p } = await bus();
    const admin = await startHttpAdmin(0, db!, ADMIN, 10_485_760, tmp('r318-admin-files-'), new Map());
    handles.push(admin);
    const a = `http://127.0.0.1:${(admin.server.address() as net.AddressInfo).port}`;
    for (const q of ['/messages', '/messages?with=alice', '/messages?limit=1&before=30:topic-b', '/messages?kinds=direct']) {
      const viaWs = await get(`http://127.0.0.1:${p}${q}`, 'bob-tok');
      const viaAdmin = await get(`${a}${q}`, 'bob-tok');
      expect({ q, s: viaWs.status, b: await viaWs.text() }).toEqual({ q, s: viaAdmin.status, b: await viaAdmin.text() });
    }
  });
});

describe('R-318: the credential on this door is the AGENT token, and only it', () => {
  it('no token, a bad token and the ADMIN token are the same 401', async () => {
    const { p } = await bus();
    for (const tok of [undefined, 'not-a-token', ADMIN]) {
      const res = await get(`http://127.0.0.1:${p}/messages`, tok);
      expect({ tok, s: res.status, b: await res.text() }).toEqual({ tok, s: 401, b: '{"error":"unauthorized"}' });
    }
  });

  it('refusals are logged with the route, at most one line per source per interval', async () => {
    const { p, lines } = await bus();
    for (let i = 0; i < 3; i++) await get(`http://127.0.0.1:${p}/messages`, 'not-a-token');
    const refused = evts(lines, 'agent.http').filter(e => e.refused !== undefined);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ refused: 'bad_token', route: 'GET /messages', listener: 'ws', suppressed_since_last: 0 });
    expect(lines.join('\n')).not.toContain('not-a-token');
  });

  it('only GET /messages and GET /files/:id answer; other routes and methods are 404', async () => {
    const { p } = await bus();
    for (const path of ['/agents', '/connections', '/topics', '/acl', '/metrics', '/messages/x']) {
      const res = await get(`http://127.0.0.1:${p}${path}`, 'bob-tok');
      expect({ path, s: res.status }).toEqual({ path, s: 404 });
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${p}/messages`, { method, headers: { Authorization: 'Bearer bob-tok' } });
      expect({ method, s: res.status }).toEqual({ method, s: 404 });
    }
  });
});

describe('R-318: R-65 semantics carry over', () => {
  it('a TLS-latched agent is refused on the PLAINTEXT listener and served on TLS', async () => {
    const { p, t, lines } = await bus();
    markTlsSeen(db!, 'bob');
    const plain = await get(`http://127.0.0.1:${p}/messages`, 'bob-tok');
    expect({ s: plain.status, b: await plain.text() }).toEqual({ s: 401, b: '{"error":"unauthorized"}' });
    expect(evts(lines, 'agent.http').filter(e => e.refused === 'tls_latched')).toMatchObject([{ agent_id: 'bob', route: 'GET /messages', tls: false, listener: 'ws' }]);
    expect(await ids(await get(`https://127.0.0.1:${t}/messages`, 'bob-tok', true))).toEqual(['topic-b', 'ba-2', 'ab-1']);
  });

  it('a served request logs agent.http with the route, tls and listener', async () => {
    const { t, lines } = await bus();
    await ids(await get(`https://127.0.0.1:${t}/messages?with=alice`, 'bob-tok', true));
    const line = evts(lines, 'agent.http').find(e => e.route === 'GET /messages')!;
    expect(line).toMatchObject({ principal: 'agent', agent_id: 'bob', tls: true, listener: 'ws', src_ip: '127.0.0.1' });
    expect(JSON.stringify(line)).not.toContain('with=');
  });
});
