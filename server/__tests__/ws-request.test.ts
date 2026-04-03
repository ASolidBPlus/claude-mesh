import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant } from '../db.ts';
import { generateToken, hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';

let portCounter = 19600;
function nextPort() { return portCounter++; }

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// A buffered message queue — never misses messages
class MsgQueue {
  private buf: Record<string, unknown>[] = [];
  private waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      this.push(msg);
    });
  }

  private push(msg: Record<string, unknown>) {
    // Check waiting consumers
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].pred(msg)) {
        const waiter = this.waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
        return;
      }
    }
    // No consumer waiting — buffer it
    this.buf.push(msg);
  }

  next(pred: (m: Record<string, unknown>) => boolean = () => true, timeout = 4000): Promise<Record<string, unknown>> {
    // Check buffer first
    const idx = this.buf.findIndex(pred);
    if (idx !== -1) {
      return Promise.resolve(this.buf.splice(idx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex(w => w.resolve === resolve);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error(`timeout waiting for message. buf=${JSON.stringify(this.buf)}`));
      }, timeout);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }
}

async function authAgent(ws: WebSocket, q: MsgQueue, agentId: string, token: string): Promise<Record<string, unknown>> {
  ws.send(JSON.stringify({ type: 'auth', agent_id: agentId, token }));
  return q.next((m) => m.type === 'auth_ok');
}

describe('ws-server request/response', () => {
  let db: Database;
  let handle: WsServerHandle;
  let port: number;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    port = nextPort();
    handle = await startWsServer(port, db);

    tokenA = generateToken();
    tokenB = generateToken();
    registerAgent(db, { id: 'agent-a', token_hash: hashToken(tokenA), hostname: 'host-a' });
    registerAgent(db, { id: 'agent-b', token_hash: hashToken(tokenB), hostname: 'host-b' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('request → response happy path', async () => {
    const wsA = await connectWs(port);
    const wsB = await connectWs(port);
    const qA = new MsgQueue(wsA);
    const qB = new MsgQueue(wsB);

    await authAgent(wsA, qA, 'agent-a', tokenA);
    await authAgent(wsB, qB, 'agent-b', tokenB);

    const corrId = crypto.randomUUID();
    const requestMsgId = crypto.randomUUID();

    // A sends request to B
    wsA.send(JSON.stringify({
      type: 'request',
      msg_id: requestMsgId,
      to: 'agent-b',
      payload: '{"query":"status"}',
      content_type: 'application/json',
      ttl_ms: 5000,
      correlation_id: corrId,
    }));

    // A receives ack
    const aAck = await qA.next((m) => m.type === 'ack' && m.ref === requestMsgId);
    expect(aAck.type).toBe('ack');
    expect(aAck.ok).toBe(true);

    // B receives deliver with kind=request
    const bDeliver = await qB.next((m) => m.type === 'deliver' && m.kind === 'request');
    expect(bDeliver.correlation_id).toBe(corrId);
    expect(bDeliver.from).toBe('agent-a');
    expect(bDeliver.to).toBe('agent-b');

    // B sends response
    const responseMsgId = crypto.randomUUID();
    wsB.send(JSON.stringify({
      type: 'response',
      msg_id: responseMsgId,
      correlation_id: corrId,
      payload: '{"status":"running"}',
      content_type: 'application/json',
    }));

    // B receives ack for response
    const bAck = await qB.next((m) => m.type === 'ack' && m.ref === responseMsgId);
    expect(bAck.ok).toBe(true);

    // A receives deliver with kind=response
    const aDeliver = await qA.next((m) => m.type === 'deliver' && m.kind === 'response');
    expect(aDeliver.correlation_id).toBe(corrId);
    expect(aDeliver.from).toBe('agent-b');
    expect(aDeliver.to).toBe('agent-a');
    expect(aDeliver.payload).toBe('{"status":"running"}');

    wsA.close();
    wsB.close();
  }, 10000);

  it('request timeout — requester receives REQUEST_TIMEOUT error', async () => {
    const wsA = await connectWs(port);
    const qA = new MsgQueue(wsA);
    await authAgent(wsA, qA, 'agent-a', tokenA);

    const corrId = crypto.randomUUID();
    const requestMsgId = crypto.randomUUID();

    wsA.send(JSON.stringify({
      type: 'request',
      msg_id: requestMsgId,
      to: 'agent-b',
      payload: 'ping',
      ttl_ms: 200,
      correlation_id: corrId,
    }));

    // Ack first
    const ack = await qA.next((m) => m.type === 'ack');
    expect(ack.ok).toBe(true);

    // Then timeout error
    const errMsg = await qA.next((m) => m.type === 'error' && m.code === 'REQUEST_TIMEOUT', 3000);
    expect(errMsg.code).toBe('REQUEST_TIMEOUT');
    expect(errMsg.ref).toBe(corrId);

    wsA.close();
  }, 8000);

  it('missing correlation_id — returns INVALID_REQUEST', async () => {
    const wsA = await connectWs(port);
    const qA = new MsgQueue(wsA);
    await authAgent(wsA, qA, 'agent-a', tokenA);

    wsA.send(JSON.stringify({
      type: 'request',
      msg_id: crypto.randomUUID(),
      to: 'agent-b',
      payload: 'ping',
      ttl_ms: 5000,
      // no correlation_id
    }));

    const errMsg = await qA.next((m) => m.type === 'error');
    expect(errMsg.code).toBe('INVALID_REQUEST');

    wsA.close();
  });

  it('ttl_ms=0 — returns INVALID_REQUEST', async () => {
    const wsA = await connectWs(port);
    const qA = new MsgQueue(wsA);
    await authAgent(wsA, qA, 'agent-a', tokenA);

    wsA.send(JSON.stringify({
      type: 'request',
      msg_id: crypto.randomUUID(),
      to: 'agent-b',
      payload: 'ping',
      ttl_ms: 0,
      correlation_id: crypto.randomUUID(),
    }));

    const errMsg = await qA.next((m) => m.type === 'error');
    expect(errMsg.code).toBe('INVALID_REQUEST');

    wsA.close();
  });

  it('ttl_ms > 300000 — returns INVALID_REQUEST', async () => {
    const wsA = await connectWs(port);
    const qA = new MsgQueue(wsA);
    await authAgent(wsA, qA, 'agent-a', tokenA);

    wsA.send(JSON.stringify({
      type: 'request',
      msg_id: crypto.randomUUID(),
      to: 'agent-b',
      payload: 'ping',
      ttl_ms: 300_001,
      correlation_id: crypto.randomUUID(),
    }));

    const errMsg = await qA.next((m) => m.type === 'error');
    expect(errMsg.code).toBe('INVALID_REQUEST');

    wsA.close();
  });

  it('duplicate correlation_id — second request returns INVALID_REQUEST', async () => {
    const wsA = await connectWs(port);
    const qA = new MsgQueue(wsA);
    await authAgent(wsA, qA, 'agent-a', tokenA);

    const corrId = crypto.randomUUID();

    wsA.send(JSON.stringify({
      type: 'request',
      msg_id: crypto.randomUUID(),
      to: 'agent-b',
      payload: 'ping',
      ttl_ms: 10_000,
      correlation_id: corrId,
    }));

    // First ack
    const ack1 = await qA.next((m) => m.type === 'ack');
    expect(ack1.ok).toBe(true);

    // Second request with same correlation_id
    wsA.send(JSON.stringify({
      type: 'request',
      msg_id: crypto.randomUUID(),
      to: 'agent-b',
      payload: 'ping again',
      ttl_ms: 10_000,
      correlation_id: corrId,
    }));

    const errMsg = await qA.next((m) => m.type === 'error');
    expect(errMsg.code).toBe('INVALID_REQUEST');

    wsA.close();
  }, 15000);

  it('response to unknown correlation_id — CORRELATION_NOT_FOUND', async () => {
    const wsB = await connectWs(port);
    const qB = new MsgQueue(wsB);
    await authAgent(wsB, qB, 'agent-b', tokenB);

    wsB.send(JSON.stringify({
      type: 'response',
      msg_id: crypto.randomUUID(),
      correlation_id: crypto.randomUUID(),
      payload: 'pong',
    }));

    const errMsg = await qB.next((m) => m.type === 'error');
    expect(errMsg.code).toBe('CORRELATION_NOT_FOUND');

    wsB.close();
  });

  it('response from wrong agent — ACL_DENIED for impostor', async () => {
    const tokenC = generateToken();
    registerAgent(db, { id: 'agent-c', token_hash: hashToken(tokenC), hostname: 'host-c' });
    aclGrant(db, 'agent-a', 'agent-c', 'system');

    const wsA = await connectWs(port);
    const wsC = await connectWs(port);
    const qA = new MsgQueue(wsA);
    const qC = new MsgQueue(wsC);

    await authAgent(wsA, qA, 'agent-a', tokenA);
    await authAgent(wsC, qC, 'agent-c', tokenC);

    const corrId = crypto.randomUUID();

    // A sends request to B (not C)
    wsA.send(JSON.stringify({
      type: 'request',
      msg_id: crypto.randomUUID(),
      to: 'agent-b',
      payload: 'ping',
      ttl_ms: 10_000,
      correlation_id: corrId,
    }));

    const ack = await qA.next((m) => m.type === 'ack');
    expect(ack.ok).toBe(true);

    // C tries to respond (impostor — original recipient was B)
    wsC.send(JSON.stringify({
      type: 'response',
      msg_id: crypto.randomUUID(),
      correlation_id: corrId,
      payload: 'fake pong',
    }));

    const errMsg = await qC.next((m) => m.type === 'error');
    expect(errMsg.code).toBe('ACL_DENIED');

    wsA.close();
    wsC.close();
  }, 15000);
});
