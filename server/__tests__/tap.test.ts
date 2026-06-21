import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  openDb, registerAgent, aclGrant, deleteAgent,
  grantObserver, revokeObserver, isObserver, listObservers,
} from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { emitTap, TapFrame, TAP_BUFFER_LIMIT_BYTES } from '../tap.ts';
import { routeDirect, routePublish, routeRequest } from '../router.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let portCounter = 19500;
function nextPort() { return portCounter++; }

const ADMIN_TOKEN = 'tap-admin-token';

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// Collect ALL frames a socket receives into an array, so gating assertions can
// check that a non-observer's array never contains a type:"tap" frame.
interface Collector {
  ws: WebSocket;
  frames: Record<string, unknown>[];
}

function attachCollector(ws: WebSocket): Collector {
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  return { ws, frames };
}

function waitForFrame(c: Collector, pred: (f: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const existing = c.frames.find(pred);
    if (existing) return resolve(existing);
    const t = setInterval(() => {
      const f = c.frames.find(pred);
      if (f) { clearInterval(t); clearTimeout(to); resolve(f); }
    }, 5);
    const to = setTimeout(() => { clearInterval(t); reject(new Error('waitForFrame timeout')); }, timeoutMs);
  });
}

// Register an agent with a known token and return its raw token.
function makeAgent(db: Database, id: string): string {
  const rawToken = `tok-${id}`;
  registerAgent(db, { id, token_hash: hashToken(rawToken), hostname: `host-${id}` });
  return rawToken;
}

// Connect + auth a WS client, returning a collector once auth_ok arrives.
async function authClient(port: number, db: Database, id: string): Promise<Collector> {
  const token = `tok-${id}`;
  const ws = await connectWs(port);
  const c = attachCollector(ws);
  ws.send(JSON.stringify({ type: 'auth', agent_id: id, token }));
  await waitForFrame(c, (f) => f.type === 'auth_ok');
  return c;
}

function tick(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// FLUSH BARRIER: a known round-trip the given client SHOULD complete, so any
// in-flight frames have been pushed before a negative "zero tap" assertion.
async function flushBarrier(c: Collector): Promise<void> {
  const ts = Date.now();
  c.ws.send(JSON.stringify({ type: 'ping', ts }));
  await waitForFrame(c, (f) => f.type === 'pong' && f.ts === ts);
  await tick(40);
}

describe('tap — observers DB helpers', () => {
  let db: Database;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });

  it('1. DB round-trip: grant/is/list/revoke', () => {
    makeAgent(db, 'x');
    grantObserver(db, 'x', 'tester');
    expect(isObserver(db, 'x')).toBe(true);
    const list = listObservers(db);
    expect(list.length).toBe(1);
    expect(list[0].agent_id).toBe('x');
    expect(list[0].granted_by).toBe('tester');
    expect(revokeObserver(db, 'x')).toBe(true);
    expect(isObserver(db, 'x')).toBe(false);
    expect(revokeObserver(db, 'x')).toBe(false);
  });

  it('2. DB idempotent grant (upsert)', () => {
    makeAgent(db, 'x');
    grantObserver(db, 'x', 'first');
    grantObserver(db, 'x', 'second');
    const list = listObservers(db);
    expect(list.length).toBe(1);
    expect(list[0].granted_by).toBe('second');
  });

  it('3. ON DELETE CASCADE removes observer row', () => {
    makeAgent(db, 'x');
    grantObserver(db, 'x', 'sys');
    expect(isObserver(db, 'x')).toBe(true);
    deleteAgent(db, 'x');
    expect(isObserver(db, 'x')).toBe(false);
    expect(listObservers(db).some(o => o.agent_id === 'x')).toBe(false);
  });
});

describe('tap — admin /observers endpoints', () => {
  let db: Database;
  let httpHandle: HttpAdminHandle;
  let base: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    httpHandle = await startHttpAdmin(0, db, ADMIN_TOKEN, 10_485_760, '/tmp', new Map(), new Map(), new Map());
    const port = (httpHandle.server.address() as net.AddressInfo).port;
    base = `http://localhost:${port}`;
  });
  afterEach(async () => {
    await httpHandle.shutdown().catch(() => {});
    db.close();
  });

  function admin(path: string, method: string, body?: unknown) {
    return fetch(`${base}${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it('4. POST /observers 201 + row', async () => {
    makeAgent(db, 'obs');
    const res = await admin('/observers', 'POST', { agent_id: 'obs', granted_by: 'me' });
    expect(res.status).toBe(201);
    const row = await res.json() as Record<string, unknown>;
    expect(row.agent_id).toBe('obs');
    expect(typeof row.granted_at).toBe('number');
    expect(row.granted_by).toBe('me');
  });

  it('5. POST /observers 404 unknown agent', async () => {
    const res = await admin('/observers', 'POST', { agent_id: 'ghost' });
    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>).error).toBe('agent not found');
  });

  it('6. POST /observers 400 missing agent_id', async () => {
    const res = await admin('/observers', 'POST', {});
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).error).toBe('agent_id is required');
  });

  it('7. POST /observers 401 without admin token (no self-grant path)', async () => {
    makeAgent(db, 'obs');
    const res = await fetch(`${base}/observers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'obs' }),
    });
    expect(res.status).toBe(401);
    expect((await res.json() as Record<string, unknown>).error).toBe('unauthorized');
  });

  it('8. DELETE /observers/:id 200', async () => {
    makeAgent(db, 'obs');
    await admin('/observers', 'POST', { agent_id: 'obs' });
    const res = await admin('/observers/obs', 'DELETE');
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).ok).toBe(true);
    expect(isObserver(db, 'obs')).toBe(false);
  });

  it('9. DELETE /observers/:id 404 not an observer', async () => {
    makeAgent(db, 'obs');
    const res = await admin('/observers/obs', 'DELETE');
    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>).error).toBe('not an observer');
  });

  it('10. GET /observers list (401 without token)', async () => {
    makeAgent(db, 'o1'); makeAgent(db, 'o2');
    await admin('/observers', 'POST', { agent_id: 'o1' });
    await admin('/observers', 'POST', { agent_id: 'o2' });
    const res = await admin('/observers', 'GET');
    expect(res.status).toBe(200);
    const list = await res.json() as Record<string, unknown>[];
    expect(list.length).toBe(2);

    const noauth = await fetch(`${base}/observers`);
    expect(noauth.status).toBe(401);
  });
});

describe('tap — live gating end-to-end', () => {
  let db: Database;
  let wsHandle: WsServerHandle;
  let httpHandle: HttpAdminHandle;
  let wsPort: number;
  let base: string;
  let observerIndex: Map<string, WebSocket>;
  let filesDir: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    wsPort = nextPort();
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-tap-'));
    // ONE shared observerIndex passed to BOTH subsystems (mirrors server.ts).
    observerIndex = new Map<string, WebSocket>();
    wsHandle = await startWsServer(wsPort, db, 10_485_760, filesDir, 0, observerIndex);
    httpHandle = await startHttpAdmin(0, db, ADMIN_TOKEN, 10_485_760, filesDir, wsHandle.agentIndex, wsHandle.pendingRequests, observerIndex);
    base = `http://localhost:${(httpHandle.server.address() as net.AddressInfo).port}`;
    // confirm the same instance is shared
    expect(wsHandle.observerIndex).toBe(observerIndex);
  });

  afterEach(async () => {
    await wsHandle.shutdown().catch(() => {});
    await httpHandle.shutdown().catch(() => {});
    db.close();
  });

  function grantObs(agent_id: string) {
    return fetch(`${base}/observers`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id }),
    });
  }
  function revokeObs(agent_id: string) {
    return fetch(`${base}/observers/${agent_id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
    });
  }

  it('11. CRITICAL (a) observer receives foreign A→B traffic with no ACL', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'B'); makeAgent(db, 'OBS');
    aclGrant(db, 'A', 'B', 'sys');
    await grantObs('OBS');

    const A = await authClient(wsPort, db, 'A');
    const B = await authClient(wsPort, db, 'B');
    const OBS = await authClient(wsPort, db, 'OBS');

    A.ws.send(JSON.stringify({ type: 'send', msg_id: 'm1', to: 'B', payload: 'hello-foreign' }));

    const tap = await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'm1');
    expect(tap.kind).toBe('direct');
    expect(tap.from).toBe('A');
    expect(tap.to).toBe('B');
    expect(tap.payload).toBe('hello-foreign');
    expect(tap.topic).toBeNull();
    void B;
  });

  it('12. CRITICAL (b) non-observer connected agent receives ZERO taps', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'B'); makeAgent(db, 'C'); makeAgent(db, 'OBS');
    aclGrant(db, 'A', 'B', 'sys');
    await grantObs('OBS');

    const A = await authClient(wsPort, db, 'A');
    const B = await authClient(wsPort, db, 'B');
    const C = await authClient(wsPort, db, 'C');
    const OBS = await authClient(wsPort, db, 'OBS');

    A.ws.send(JSON.stringify({ type: 'send', msg_id: 'm1', to: 'B', payload: 'p' }));
    // wait for OBS to get the tap and B to get its deliver
    await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'm1');
    await waitForFrame(B, (f) => f.type === 'deliver' && f.msg_id === 'm1');

    // FLUSH BARRIER on C and B before asserting absence.
    await flushBarrier(C);
    await flushBarrier(B);

    expect(C.frames.some((f) => f.type === 'tap')).toBe(false);
    // B is a legit recipient (gets deliver) but NOT an observer → no tap.
    expect(B.frames.some((f) => f.type === 'tap')).toBe(false);
    expect(B.frames.some((f) => f.type === 'deliver' && f.msg_id === 'm1')).toBe(true);
  });

  it('13. CRITICAL (c) agent cannot self-grant observer via WS frame', async () => {
    makeAgent(db, 'A');
    const A = await authClient(wsPort, db, 'A');
    A.ws.send(JSON.stringify({ type: 'grant_observer', agent_id: 'A' }));
    const err = await waitForFrame(A, (f) => f.type === 'error' && f.code === 'NOT_IMPLEMENTED');
    expect(err.code).toBe('NOT_IMPLEMENTED');
    expect(isObserver(db, 'A')).toBe(false);
  });

  it('14. CRITICAL (d) revoke stops live taps', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'B'); makeAgent(db, 'OBS');
    aclGrant(db, 'A', 'B', 'sys');
    await grantObs('OBS');

    const A = await authClient(wsPort, db, 'A');
    await authClient(wsPort, db, 'B');
    const OBS = await authClient(wsPort, db, 'OBS');

    A.ws.send(JSON.stringify({ type: 'send', msg_id: 'm1', to: 'B', payload: 'p1' }));
    await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'm1');

    await revokeObs('OBS');

    A.ws.send(JSON.stringify({ type: 'send', msg_id: 'm2', to: 'B', payload: 'p2' }));
    // flush barrier: OBS does a round-trip so any in-flight frame settles.
    await flushBarrier(OBS);
    expect(OBS.frames.some((f) => f.type === 'tap' && f.msg_id === 'm2')).toBe(false);
    // the first tap is still there.
    expect(OBS.frames.some((f) => f.type === 'tap' && f.msg_id === 'm1')).toBe(true);
  });

  it('15. CRITICAL (e) all five kinds are tapped', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'B'); makeAgent(db, 'C'); makeAgent(db, 'OBS');
    aclGrant(db, 'A', 'B', 'sys');
    aclGrant(db, 'A', 'C', 'sys');
    aclGrant(db, 'B', 'A', 'sys');
    await grantObs('OBS');

    const A = await authClient(wsPort, db, 'A');
    const B = await authClient(wsPort, db, 'B');
    const C = await authClient(wsPort, db, 'C');
    const OBS = await authClient(wsPort, db, 'OBS');

    // direct
    A.ws.send(JSON.stringify({ type: 'send', msg_id: 'd1', to: 'B', payload: 'direct-p' }));
    const dtap = await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'd1');
    expect(dtap.kind).toBe('direct');

    // topic (once, not per-subscriber): B and C subscribe to T
    B.ws.send(JSON.stringify({ type: 'subscribe', topic: 'T' }));
    C.ws.send(JSON.stringify({ type: 'subscribe', topic: 'T' }));
    await waitForFrame(B, (f) => f.type === 'ack' && f.ref === 'T');
    await waitForFrame(C, (f) => f.type === 'ack' && f.ref === 'T');
    A.ws.send(JSON.stringify({ type: 'publish', msg_id: 'pub1', topic: 'T', payload: 'topic-p' }));
    const ttap = await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'pub1');
    expect(ttap.kind).toBe('topic');
    expect(ttap.topic).toBe('T');
    expect(ttap.to).toBeNull();
    await flushBarrier(OBS);
    expect(OBS.frames.filter((f) => f.type === 'tap' && f.msg_id === 'pub1').length).toBe(1);

    // request
    A.ws.send(JSON.stringify({ type: 'request', msg_id: 'req1', to: 'B', payload: 'req-p', correlation_id: 'corr-1' }));
    const rtap = await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'req1');
    expect(rtap.kind).toBe('request');
    expect(rtap.correlation_id).toBe('corr-1');

    // response (B responds to the request)
    await waitForFrame(B, (f) => f.type === 'deliver' && f.kind === 'request' && f.correlation_id === 'corr-1');
    B.ws.send(JSON.stringify({ type: 'response', msg_id: 'resp1', correlation_id: 'corr-1', payload: 'resp-p' }));
    const restap = await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'resp1');
    expect(restap.kind).toBe('response');
    expect(restap.from).toBe('B');
    expect(restap.to).toBe('A');
    expect(restap.correlation_id).toBe('corr-1');

    // file
    const data = Buffer.from('file-bytes-here').toString('base64');
    A.ws.send(JSON.stringify({ type: 'file_send', msg_id: 'f1', to: 'B', filename: 'note.txt', content_type: 'text/plain', data }));
    const ftap = await waitForFrame(OBS, (f) => f.type === 'tap' && f.kind === 'file');
    expect(ftap.from).toBe('A');
    expect(ftap.to).toBe('B');
    expect(ftap.filename).toBe('note.txt');
    expect(ftap.content_type).toBe('text/plain');
    expect(typeof ftap.file_id).toBe('string');
    expect((ftap.file_id as string).length).toBeGreaterThan(0);
    expect(ftap.payload).toBeNull();
    expect(ftap.size).toBe(Buffer.from('file-bytes-here').byteLength);
  });

  it('16. multiple observers both receive the tap', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'B'); makeAgent(db, 'OBS1'); makeAgent(db, 'OBS2');
    aclGrant(db, 'A', 'B', 'sys');
    await grantObs('OBS1');
    await grantObs('OBS2');

    const A = await authClient(wsPort, db, 'A');
    await authClient(wsPort, db, 'B');
    const OBS1 = await authClient(wsPort, db, 'OBS1');
    const OBS2 = await authClient(wsPort, db, 'OBS2');

    A.ws.send(JSON.stringify({ type: 'send', msg_id: 'm1', to: 'B', payload: 'fanout' }));
    const t1 = await waitForFrame(OBS1, (f) => f.type === 'tap' && f.msg_id === 'm1');
    const t2 = await waitForFrame(OBS2, (f) => f.type === 'tap' && f.msg_id === 'm1');
    expect(t1.payload).toBe('fanout');
    expect(t2.payload).toBe('fanout');
  });

  it('17. offline observer misses with no backlog/queue', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'B'); makeAgent(db, 'OBS');
    aclGrant(db, 'A', 'B', 'sys');
    await grantObs('OBS'); // granted but NOT connected

    const A = await authClient(wsPort, db, 'A');
    await authClient(wsPort, db, 'B');
    A.ws.send(JSON.stringify({ type: 'send', msg_id: 'm1', to: 'B', payload: 'p' }));
    await tick(80);

    // now connect OBS — it must NOT receive a backlogged tap.
    const OBS = await authClient(wsPort, db, 'OBS');
    await flushBarrier(OBS);
    expect(OBS.frames.some((f) => f.type === 'tap')).toBe(false);
  });

  it('18. SAFETY broken observer ws does not break delivery or other observers', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'B'); makeAgent(db, 'OBS');
    aclGrant(db, 'A', 'B', 'sys');
    await grantObs('OBS');

    const A = await authClient(wsPort, db, 'A');
    const B = await authClient(wsPort, db, 'B');
    const OBS = await authClient(wsPort, db, 'OBS');

    // Inject a throwing fake observer directly into the shared map.
    observerIndex.set('boom', { send() { throw new Error('x'); }, bufferedAmount: 0 } as unknown as WebSocket);

    A.ws.send(JSON.stringify({ type: 'send', msg_id: 'm1', to: 'B', payload: 'still-works' }));

    const deliver = await waitForFrame(B, (f) => f.type === 'deliver' && f.msg_id === 'm1');
    expect(deliver.payload).toBe('still-works');
    const tap = await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'm1');
    expect(tap.payload).toBe('still-works');
  });
});

describe('tap — MCP-path ingress is tapped via the shared observerIndex', () => {
  // These tests exercise the SECOND ingress path: the stdio MCP interface
  // (mcp-server.ts) calls routeDirect/routePublish/routeRequest directly with the
  // SAME shared observerIndex that startMcpServer is now threaded. We connect a
  // granted observer over WS (which populates the shared observerIndex through the
  // real grant path), then invoke the route fns exactly the way mcp-server does and
  // assert the observer's socket receives the tap frame. This proves MCP-originated
  // traffic reaches observers, and that a non-observer still gets ZERO taps.
  let db: Database;
  let wsHandle: WsServerHandle;
  let httpHandle: HttpAdminHandle;
  let wsPort: number;
  let base: string;
  let observerIndex: Map<string, WebSocket>;
  let agentIndex: Map<string, WebSocket>;
  let filesDir: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    wsPort = nextPort();
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-mcptap-'));
    observerIndex = new Map<string, WebSocket>();
    wsHandle = await startWsServer(wsPort, db, 10_485_760, filesDir, 0, observerIndex);
    httpHandle = await startHttpAdmin(0, db, ADMIN_TOKEN, 10_485_760, filesDir, wsHandle.agentIndex, wsHandle.pendingRequests, observerIndex);
    base = `http://localhost:${(httpHandle.server.address() as net.AddressInfo).port}`;
    agentIndex = wsHandle.agentIndex;
    // confirm the SAME instance is shared — same invariant the MCP path relies on.
    expect(wsHandle.observerIndex).toBe(observerIndex);
  });

  afterEach(async () => {
    await wsHandle.shutdown().catch(() => {});
    await httpHandle.shutdown().catch(() => {});
    db.close();
  });

  function grantObs(agent_id: string) {
    return fetch(`${base}/observers`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id }),
    });
  }

  it('21. MCP-originated direct send is tapped (shared observerIndex)', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'B'); makeAgent(db, 'OBS');
    aclGrant(db, 'A', 'B', 'sys');
    await grantObs('OBS');

    // connect the observer over WS — this is what populates the shared observerIndex.
    const OBS = await authClient(wsPort, db, 'OBS');
    expect(observerIndex.has('OBS')).toBe(true);

    // drive the route fn EXACTLY the way mcp-server's mesh_send handler does:
    // pass the shared observerIndex as the trailing arg. No WS frame from a sender.
    const result = routeDirect(db, agentIndex, 'A', {
      type: 'send', msg_id: 'mcp-d1', to: 'B', payload: 'mcp-hello',
      content_type: 'text/plain', ttl_ms: 300_000,
    }, observerIndex);
    expect(result.ok).toBe(true);

    const tap = await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'mcp-d1');
    expect(tap.kind).toBe('direct');
    expect(tap.from).toBe('A');
    expect(tap.to).toBe('B');
    expect(tap.payload).toBe('mcp-hello');
  });

  it('22. MCP-originated broadcast is tapped (shared observerIndex)', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'OBS');
    await grantObs('OBS');
    const OBS = await authClient(wsPort, db, 'OBS');

    const result = routePublish(db, agentIndex, 'A', {
      type: 'publish', msg_id: 'mcp-pub1', topic: 'MT', payload: 'mcp-topic',
      content_type: 'text/plain', ttl_ms: 300_000,
    }, observerIndex);
    expect(result.ok).toBe(true);

    const tap = await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'mcp-pub1');
    expect(tap.kind).toBe('topic');
    expect(tap.topic).toBe('MT');
    expect(tap.to).toBeNull();
    expect(tap.payload).toBe('mcp-topic');
  });

  it('23. MCP-originated request is tapped (shared observerIndex)', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'B'); makeAgent(db, 'OBS');
    aclGrant(db, 'A', 'B', 'sys');
    await grantObs('OBS');
    const OBS = await authClient(wsPort, db, 'OBS');

    const result = routeRequest(db, agentIndex, 'A', {
      type: 'request', msg_id: 'mcp-req1', to: 'B', payload: 'mcp-req',
      content_type: 'text/plain', ttl_ms: 30_000, correlation_id: 'mcp-corr-1',
    }, observerIndex);
    expect(result.ok).toBe(true);

    const tap = await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'mcp-req1');
    expect(tap.kind).toBe('request');
    expect(tap.from).toBe('A');
    expect(tap.to).toBe('B');
    expect(tap.correlation_id).toBe('mcp-corr-1');
    expect(tap.payload).toBe('mcp-req');
  });

  it('24. CRITICAL non-observer gets ZERO taps via the MCP path', async () => {
    makeAgent(db, 'A'); makeAgent(db, 'B'); makeAgent(db, 'NON'); makeAgent(db, 'OBS');
    aclGrant(db, 'A', 'B', 'sys');
    await grantObs('OBS');

    const OBS = await authClient(wsPort, db, 'OBS');
    // NON is a connected, authed agent but NOT a granted observer → not in observerIndex.
    const NON = await authClient(wsPort, db, 'NON');
    expect(observerIndex.has('NON')).toBe(false);

    routeDirect(db, agentIndex, 'A', {
      type: 'send', msg_id: 'mcp-d2', to: 'B', payload: 'mcp-secret',
      content_type: 'text/plain', ttl_ms: 300_000,
    }, observerIndex);

    // observer must see it (proves the tap actually fired on the MCP path)...
    await waitForFrame(OBS, (f) => f.type === 'tap' && f.msg_id === 'mcp-d2');
    // ...and the non-observer must NOT. Flush barrier before the negative assertion.
    await flushBarrier(NON);
    expect(NON.frames.some((f) => f.type === 'tap')).toBe(false);
  });
});

describe('tap — emitTap unit safety/backpressure', () => {
  it('19. emitTap with a circular frame never throws', () => {
    const f: Record<string, unknown> = { type: 'tap' };
    f.self = f;
    const map = new Map<string, WebSocket>();
    expect(() => emitTap(map, f as unknown as TapFrame)).not.toThrow();
  });

  it('20. backpressure: over-threshold observer is skipped, healthy one sent', () => {
    let overSends = 0;
    let healthySends = 0;
    const map = new Map<string, WebSocket>();
    map.set('over', { bufferedAmount: TAP_BUFFER_LIMIT_BYTES + 1, send() { overSends++; } } as unknown as WebSocket);
    map.set('ok', { bufferedAmount: 0, send() { healthySends++; } } as unknown as WebSocket);

    const frame: TapFrame = {
      type: 'tap', msg_id: 'm', kind: 'direct', from: 'a', to: 'b',
      topic: null, correlation_id: null, sent_at: Date.now(), size: 1, payload: 'x',
    };
    emitTap(map, frame);

    expect(overSends).toBe(0);
    expect(healthySends).toBe(1);
  });
});
