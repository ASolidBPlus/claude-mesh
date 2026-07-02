import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as net from 'net';
import {
  openDb, registerAgent, aclGrant, setOnline, subscribe, getOrCreateTopic,
  insertMessage, insertReminder, countExpiredUndeliveredSince,
} from '../db.ts';
import { generateToken, hashToken } from '../auth.ts';
import {
  incMsgStatus, incSent, incReceived, incAclDenied, incError, incBytes,
  incFile, incReminderFired, incExpiredByKind,
  observePayloadBytes, observeRequestDuration,
  renderMetrics, __resetMetricsForTest,
} from '../metrics.ts';
import { routeDirect, routePublish, routeFile } from '../router.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { startReminderScheduler } from '../reminder-scheduler.ts';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function freshDb(): Database {
  return openDb(':memory:');
}

function mockWsOpen(): WebSocket {
  return { send: (..._args: unknown[]) => {}, readyState: 1 } as unknown as WebSocket;
}

function mockWsTracked(): { ws: WebSocket; calls: string[] } {
  const calls: string[] = [];
  const ws = { send: (data: string) => { calls.push(data); }, readyState: 1 } as unknown as WebSocket;
  return { ws, calls };
}

// Pull the rendered value of a single sample line by exact prefix match.
function lineValue(out: string, prefix: string): number | undefined {
  for (const line of out.split('\n')) {
    if (line.startsWith(prefix + ' ')) {
      return Number(line.slice(prefix.length + 1));
    }
  }
  return undefined;
}

function hasLine(out: string, prefix: string): boolean {
  return out.split('\n').some(l => l.startsWith(prefix + ' '));
}

let db: Database;

beforeEach(() => {
  __resetMetricsForTest();
  db = freshDb();
});

afterEach(() => {
  __resetMetricsForTest();
});

// ──────────────────────────────────────────────
// Unit tests T1–T17
// ──────────────────────────────────────────────

describe('metrics counters', () => {
  it('T1 incMsgStatus series', () => {
    incMsgStatus('direct', 'delivered');
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_messages_total{kind="direct",status="delivered"}')).toBe(1);
  });

  it('T2 status accumulation & distinct', () => {
    incMsgStatus('direct', 'delivered');
    incMsgStatus('direct', 'delivered');
    incMsgStatus('direct', 'queued');
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_messages_total{kind="direct",status="delivered"}')).toBe(2);
    expect(lineValue(out, 'mesh_messages_total{kind="direct",status="queued"}')).toBe(1);
  });

  it('T3 incSent / incReceived', () => {
    incSent('a');
    incReceived('b');
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="a"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_received_total{to_agent="b"}')).toBe(1);
  });

  it('T4 incAclDenied', () => {
    incAclDenied('m');
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_acl_denied_total{from_agent="m"}')).toBe(1);
  });

  it('T5 incError', () => {
    incError('AGENT_NOT_FOUND');
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_errors_total{error_code="AGENT_NOT_FOUND"}')).toBe(1);
  });

  it('T6 incBytes in/out', () => {
    incBytes('in', 100);
    incBytes('out', 40);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_bytes_total{direction="in"}')).toBe(100);
    expect(lineValue(out, 'mesh_bytes_total{direction="out"}')).toBe(40);
  });

  it('T7 incFile', () => {
    incFile();
    incFile();
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_files_total')).toBe(2);
  });

  it('T8 incReminderFired', () => {
    incReminderFired();
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_reminders_fired_total')).toBe(1);
  });

  it('T9 label-value escaping', () => {
    incSent('a"b\\c\nd');
    const out = renderMetrics(db);
    // " -> \" ; \ -> \\ ; newline -> \n
    expect(out).toContain('mesh_messages_sent_total{from_agent="a\\"b\\\\c\\nd"} 1');
  });

  it('T10 observePayloadBytes histogram', () => {
    observePayloadBytes(100);
    observePayloadBytes(5000);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_message_payload_bytes_bucket{le="256"}')).toBe(1);
    expect(lineValue(out, 'mesh_message_payload_bytes_bucket{le="16384"}')).toBe(2);
    expect(lineValue(out, 'mesh_message_payload_bytes_bucket{le="+Inf"}')).toBe(2);
    expect(lineValue(out, 'mesh_message_payload_bytes_count')).toBe(2);
    expect(lineValue(out, 'mesh_message_payload_bytes_sum')).toBe(5100);
  });

  it('T11 observeRequestDuration histogram', () => {
    observeRequestDuration(0.02);
    observeRequestDuration(0.3);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_request_duration_seconds_bucket{le="0.025"}')).toBe(1);
    expect(lineValue(out, 'mesh_request_duration_seconds_bucket{le="0.5"}')).toBe(2);
    expect(lineValue(out, 'mesh_request_duration_seconds_bucket{le="+Inf"}')).toBe(2);
    expect(lineValue(out, 'mesh_request_duration_seconds_count')).toBe(2);
    expect(lineValue(out, 'mesh_request_duration_seconds_sum')).toBeCloseTo(0.32, 6);
  });

  it('T12 histogram cumulative beyond top bucket', () => {
    observePayloadBytes(2_000_000);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_message_payload_bytes_bucket{le="1048576"}')).toBe(0);
    expect(lineValue(out, 'mesh_message_payload_bytes_bucket{le="+Inf"}')).toBe(1);
    expect(lineValue(out, 'mesh_message_payload_bytes_count')).toBe(1);
  });
});

describe('metrics gauges', () => {
  it('T13 agents_online / agent_up', () => {
    registerAgent(db, { id: 'alice', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'bob', token_hash: 'b'.repeat(64), hostname: 'h2' });
    setOnline(db, 'alice', true);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_agents_online')).toBe(1);
    expect(lineValue(out, 'mesh_agent_up{agent="alice"}')).toBe(1);
    expect(lineValue(out, 'mesh_agent_up{agent="bob"}')).toBe(0);
  });

  it('T14 topics / subscriptions', () => {
    registerAgent(db, { id: 'alice', token_hash: 'a'.repeat(64), hostname: 'h1' });
    getOrCreateTopic(db, 't1', 'alice');
    getOrCreateTopic(db, 't2', 'alice');
    subscribe(db, 'alice', 't1');
    subscribe(db, 'alice', 't2');
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_topics')).toBe(2);
    expect(lineValue(out, 'mesh_subscriptions')).toBe(2);
  });

  it('T15 pending_messages', () => {
    insertMessage(db, { id: 'm1', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'p', sent_at: 1, expires_at: null });
    const m2 = insertMessage(db, { id: 'm2', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'p', sent_at: 2, expires_at: null });
    db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ?').run(Date.now(), m2.id);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_pending_messages')).toBe(1);
  });

  it('T16 pending_requests via 2nd arg', () => {
    const out1 = renderMetrics(db, new Map([['c1', {}]]));
    expect(lineValue(out1, 'mesh_pending_requests')).toBe(1);
    const out2 = renderMetrics(db);
    expect(lineValue(out2, 'mesh_pending_requests')).toBe(0);
  });

  it('T17 reminders_pending', () => {
    registerAgent(db, { id: 'alice', token_hash: 'a'.repeat(64), hostname: 'h1' });
    insertReminder(db, { id: 'r1', agent_id: 'alice', due_at: Date.now() + 60_000, payload: 'ping', created_at: Date.now() });
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_reminders_pending')).toBe(1);
  });
});

// ──────────────────────────────────────────────
// E2E tests T18–T23, T25–T28
// ──────────────────────────────────────────────

describe('metrics E2E routing', () => {
  it('T18 routeDirect online', () => {
    registerAgent(db, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(db, 'a', 'b', 'system');
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('b', mockWsOpen());
    const payload = 'hello-world';
    const r = routeDirect(db, agentIndex, 'a', { type: 'send', msg_id: crypto.randomUUID(), to: 'b', payload });
    expect(r.ok).toBe(true);
    const out = renderMetrics(db);
    const len = Buffer.byteLength(payload, 'utf8');
    expect(lineValue(out, 'mesh_messages_total{kind="direct",status="delivered"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="a"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_received_total{to_agent="b"}')).toBe(1);
    expect(lineValue(out, 'mesh_bytes_total{direction="in"}')).toBe(len);
    expect(lineValue(out, 'mesh_bytes_total{direction="out"}')).toBe(len);
    expect(lineValue(out, 'mesh_message_payload_bytes_count')).toBe(1);
  });

  it('T19 routeDirect offline queued', () => {
    registerAgent(db, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(db, 'a', 'b', 'system');
    const r = routeDirect(db, new Map(), 'a', { type: 'send', msg_id: crypto.randomUUID(), to: 'b', payload: 'queued-msg' });
    expect(r.ok).toBe(true);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_messages_total{kind="direct",status="queued"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="a"}')).toBe(1);
    expect(lineValue(out, 'mesh_bytes_total{direction="in"}')).toBeGreaterThan(0);
    expect(hasLine(out, 'mesh_messages_total{kind="direct",status="delivered"}')).toBe(false);
    expect(hasLine(out, 'mesh_messages_received_total{to_agent="b"}')).toBe(false);
  });

  it('T20 routeDirect dropped (ttl0 offline)', () => {
    registerAgent(db, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(db, 'a', 'b', 'system');
    const r = routeDirect(db, new Map(), 'a', { type: 'send', msg_id: crypto.randomUUID(), to: 'b', payload: 'x', ttl_ms: 0 });
    expect(r.ok).toBe(true);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_messages_total{kind="direct",status="dropped"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="a"}')).toBe(1);
    expect(hasLine(out, 'mesh_messages_total{kind="direct",status="delivered"}')).toBe(false);
    expect(hasLine(out, 'mesh_messages_total{kind="direct",status="queued"}')).toBe(false);
  });

  it('T21 ACL denied', () => {
    registerAgent(db, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    const r = routeDirect(db, new Map(), 'a', { type: 'send', msg_id: crypto.randomUUID(), to: 'b', payload: 'x' });
    expect(r.ok).toBe(false);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_errors_total{error_code="ACL_DENIED"}')).toBe(1);
    expect(lineValue(out, 'mesh_acl_denied_total{from_agent="a"}')).toBe(1);
    expect(hasLine(out, 'mesh_messages_sent_total{from_agent="a"}')).toBe(false);
    expect(hasLine(out, 'mesh_messages_total{kind="direct",status="delivered"}')).toBe(false);
  });

  it('T22 AGENT_NOT_FOUND', () => {
    registerAgent(db, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    const r = routeDirect(db, new Map(), 'a', { type: 'send', msg_id: crypto.randomUUID(), to: 'ghost', payload: 'x' });
    expect(r.ok).toBe(false);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_errors_total{error_code="AGENT_NOT_FOUND"}')).toBe(1);
  });

  it('T23 topic publish', () => {
    registerAgent(db, { id: 'alice', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'sub1', token_hash: 'b'.repeat(64), hostname: 'h2' });
    registerAgent(db, { id: 'sub2', token_hash: 'c'.repeat(64), hostname: 'h3' });
    aclGrant(db, 'alice', 'sub1', 'system');
    aclGrant(db, 'alice', 'sub2', 'system');
    getOrCreateTopic(db, 'news', 'alice');
    subscribe(db, 'sub1', 'news');
    subscribe(db, 'sub2', 'news');
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('sub1', mockWsOpen());
    agentIndex.set('sub2', mockWsOpen());
    const r = routePublish(db, agentIndex, 'alice', { type: 'publish', msg_id: crypto.randomUUID(), topic: 'news', payload: 'hi-all' });
    expect(r.ok).toBe(true);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_messages_total{kind="topic",status="delivered"}')).toBe(2);
    expect(lineValue(out, 'mesh_messages_received_total{to_agent="sub1"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_received_total{to_agent="sub2"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="alice"}')).toBe(1);
  });

  it('T25 file routed online', () => {
    const filesDir = mkdtempSync(join(tmpdir(), 'mesh-metrics-files-'));
    registerAgent(db, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(db, 'a', 'b', 'system');
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('b', mockWsOpen());
    const data = Buffer.from('file-contents').toString('base64');
    const frame = { type: 'file_send' as const, msg_id: crypto.randomUUID(), to: 'b', filename: 'f.txt', data };
    const r = routeFile(db, agentIndex, 'a', frame, 10_485_760, filesDir);
    expect(r.ok).toBe(true);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_files_total')).toBe(1);
    expect(lineValue(out, 'mesh_messages_total{kind="file",status="delivered"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_received_total{to_agent="b"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="a"}')).toBe(1);
  });

  it('T26 cleanup expired per-kind', () => {
    const past = Date.now() - 10_000;
    insertMessage(db, { id: 'd1', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'p', sent_at: 1, expires_at: past });
    insertMessage(db, { id: 't1', kind: 'topic', from_agent: 'a', to_agent: 'b', payload: 'p', sent_at: 2, expires_at: past });
    // #34: expiry no longer deletes; the counter is windowed over expires_at.
    const c = countExpiredUndeliveredSince(db, 0, Date.now());
    for (const [k, n] of Object.entries(c)) incExpiredByKind(k, n);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_messages_total{kind="direct",status="expired"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_total{kind="topic",status="expired"}')).toBe(1);
  });

  it('T27 reminder fired', () => {
    registerAgent(db, { id: 'alice', token_hash: 'a'.repeat(64), hostname: 'h1' });
    insertReminder(db, { id: 'r1', agent_id: 'alice', due_at: Date.now() - 1000, payload: 'wake up', created_at: Date.now() - 5000 });
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('alice', mockWsOpen());
    const scheduler = startReminderScheduler(db, agentIndex, 3_600_000);
    scheduler.tick();
    scheduler.stop();
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_reminders_fired_total')).toBe(1);
    expect(lineValue(out, 'mesh_messages_total{kind="reminder",status="delivered"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_received_total{to_agent="alice"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="mesh"}')).toBe(1);
  });

  it('T28 drainQueue on reconnect', async () => {
    const { routeDirect: rd, drainQueue } = await import('../router.ts');
    registerAgent(db, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(db, 'a', 'b', 'system');
    // enqueue while b offline
    rd(db, new Map(), 'a', { type: 'send', msg_id: crypto.randomUUID(), to: 'b', payload: 'queued-then-drained' });
    // b reconnects and drains
    const { ws } = mockWsTracked();
    const n = drainQueue(db, 'b', ws);
    expect(n).toBe(1);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_messages_total{kind="direct",status="delivered"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_received_total{to_agent="b"}')).toBe(1);
    expect(lineValue(out, 'mesh_bytes_total{direction="out"}')).toBeGreaterThan(0);
    // no double incSent — still 1 from enqueue
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="a"}')).toBe(1);
  });
});

// ──────────────────────────────────────────────
// Safety + exposition + HTTP + file error paths
// ──────────────────────────────────────────────

describe('metrics safety & exposition', () => {
  it('T29 malformed input never throws', () => {
    expect(() => incMsgStatus(undefined as any, null as any)).not.toThrow();
    expect(() => incBytes('x', NaN)).not.toThrow();
    expect(() => observeRequestDuration(NaN)).not.toThrow();
    expect(() => incExpiredByKind('k', -5)).not.toThrow();
    expect(() => renderMetrics(db, undefined)).not.toThrow();
  });

  it('T30 exposition validity (full)', () => {
    registerAgent(db, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(db, 'a', 'b', 'system');
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('b', mockWsOpen());
    routeDirect(db, agentIndex, 'a', { type: 'send', msg_id: crypto.randomUUID(), to: 'b', payload: 'mixed-traffic' });
    observeRequestDuration(0.05);
    observePayloadBytes(2048);
    const out = renderMetrics(db);
    expect(out.endsWith('\n')).toBe(true);
    const sampleRe = /^[a-zA-Z_][a-zA-Z0-9_]*(\{.*\})? .+$/;
    for (const line of out.split('\n')) {
      if (line === '') continue;
      if (line.startsWith('#')) continue;
      expect(sampleRe.test(line)).toBe(true);
    }
    expect(out).toContain('mesh_request_duration_seconds_bucket{le="+Inf"}');
    expect(out).toContain('mesh_request_duration_seconds_sum');
    expect(out).toContain('mesh_request_duration_seconds_count');
    expect(out).toContain('mesh_message_payload_bytes_bucket{le="+Inf"}');
    expect(out).toContain('mesh_message_payload_bytes_sum');
    expect(out).toContain('mesh_message_payload_bytes_count');
  });
});

describe('metrics request/response E2E (real ws-server)', () => {
  let handle: WsServerHandle;
  let edb: Database;
  let port: number;
  let tokenA: string;
  let tokenB: string;

  function connectWs(p: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }
  function waitFor(ws: WebSocket, pred: (m: any) => boolean, timeout = 4000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeout);
      const onMsg = (data: any) => {
        const m = JSON.parse(data.toString());
        if (pred(m)) { clearTimeout(timer); ws.off('message', onMsg); resolve(m); }
      };
      ws.on('message', onMsg);
    });
  }

  beforeEach(async () => {
    __resetMetricsForTest();
    edb = openDb(':memory:');
    port = 19900 + Math.floor(Math.random() * 500);
    handle = await startWsServer(port, edb);
    tokenA = generateToken();
    tokenB = generateToken();
    registerAgent(edb, { id: 'agent-a', token_hash: hashToken(tokenA), hostname: 'host-a' });
    registerAgent(edb, { id: 'agent-b', token_hash: hashToken(tokenB), hostname: 'host-b' });
    aclGrant(edb, 'agent-a', 'agent-b', 'system');
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    edb.close();
    __resetMetricsForTest();
  });

  it('T24 request+response round trip', async () => {
    const wsA = await connectWs(port);
    const wsB = await connectWs(port);
    wsA.send(JSON.stringify({ type: 'auth', agent_id: 'agent-a', token: tokenA }));
    await waitFor(wsA, (m) => m.type === 'auth_ok');
    wsB.send(JSON.stringify({ type: 'auth', agent_id: 'agent-b', token: tokenB }));
    await waitFor(wsB, (m) => m.type === 'auth_ok');

    const corrId = crypto.randomUUID();
    const reqMsgId = crypto.randomUUID();
    wsA.send(JSON.stringify({ type: 'request', msg_id: reqMsgId, to: 'agent-b', payload: '{"q":1}', ttl_ms: 5000, correlation_id: corrId }));
    await waitFor(wsB, (m) => m.type === 'deliver' && m.kind === 'request');

    const respMsgId = crypto.randomUUID();
    wsB.send(JSON.stringify({ type: 'response', msg_id: respMsgId, correlation_id: corrId, payload: '{"a":1}' }));
    await waitFor(wsA, (m) => m.type === 'deliver' && m.kind === 'response');
    await waitFor(wsB, (m) => m.type === 'ack' && m.ref === respMsgId);

    const out = renderMetrics(edb, handle.pendingRequests);
    expect(lineValue(out, 'mesh_messages_total{kind="request",status="delivered"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_total{kind="response",status="delivered"}')).toBe(1);
    expect(lineValue(out, 'mesh_request_duration_seconds_count')).toBe(1);
    expect(lineValue(out, 'mesh_request_duration_seconds_sum')!).toBeGreaterThanOrEqual(0);
    expect(lineValue(out, 'mesh_pending_requests')).toBe(0);

    wsA.close();
    wsB.close();
  });
});

describe('metrics HTTP endpoint', () => {
  let handle: HttpAdminHandle;
  let hdb: Database;
  let base: string;
  const token = 'admin-token-metrics';

  beforeEach(async () => {
    __resetMetricsForTest();
    hdb = openDb(':memory:');
    // Drive a delivery so families have samples.
    registerAgent(hdb, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(hdb, { id: 'b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(hdb, 'a', 'b', 'system');
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('b', mockWsOpen());
    routeDirect(hdb, agentIndex, 'a', { type: 'send', msg_id: crypto.randomUUID(), to: 'b', payload: 'http-metrics' });
    observeRequestDuration(0.03);
    const filesDir = mkdtempSync(join(tmpdir(), 'mesh-metrics-http-'));
    handle = await startHttpAdmin(0, hdb, token, 10_485_760, filesDir, agentIndex);
    const port = (handle.server.address() as net.AddressInfo).port;
    base = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    hdb.close();
    __resetMetricsForTest();
  });

  it('T31 /metrics unauth 200 + families; other route 401', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const body = await res.text();
    expect(body).toContain('mesh_messages_total');
    expect(body).toContain('mesh_messages_sent_total');
    expect(body).toContain('mesh_bytes_total');
    expect(body).toContain('mesh_request_duration_seconds_bucket');

    const res2 = await fetch(`${base}/agents`);
    expect(res2.status).toBe(401);
  });
});

describe('metrics file error paths', () => {
  it('T32 routeFile error paths → errors_total', () => {
    const filesDir = mkdtempSync(join(tmpdir(), 'mesh-metrics-fileerr-'));
    // (a) ACL not granted
    const dbA = freshDb();
    registerAgent(dbA, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(dbA, { id: 'b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    const agentIndexA = new Map<string, WebSocket>();
    agentIndexA.set('b', mockWsOpen());
    const dataA = Buffer.from('hi').toString('base64');
    const ra = routeFile(dbA, agentIndexA, 'a', { type: 'file_send', msg_id: crypto.randomUUID(), to: 'b', filename: 'f.txt', data: dataA }, 10_485_760, filesDir);
    expect(ra.ok).toBe(false);
    let out = renderMetrics(dbA);
    expect(lineValue(out, 'mesh_errors_total{error_code="ACL_DENIED"}')).toBe(1);
    expect(lineValue(out, 'mesh_acl_denied_total{from_agent="a"}')).toBe(1);
    expect(lineValue(out, 'mesh_files_total')).toBe(0);

    // reset between (a) and (b)
    __resetMetricsForTest();

    // (b) malformed base64, recipient online + ACL granted
    const dbB = freshDb();
    registerAgent(dbB, { id: 'a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(dbB, { id: 'b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(dbB, 'a', 'b', 'system');
    const agentIndexB = new Map<string, WebSocket>();
    agentIndexB.set('b', mockWsOpen());
    const rb = routeFile(dbB, agentIndexB, 'a', { type: 'file_send', msg_id: crypto.randomUUID(), to: 'b', filename: 'f.txt', data: '!!!not-base64!!!' }, 10_485_760, filesDir);
    expect(rb.ok).toBe(false);
    out = renderMetrics(dbB);
    expect(lineValue(out, 'mesh_errors_total{error_code="INVALID_BASE64"}')).toBe(1);
  });
});
