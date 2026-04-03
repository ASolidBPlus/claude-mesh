import { describe, it, expect, beforeEach } from 'bun:test';
import { openDb, registerAgent, aclGrant, getMessage, getMessageByCorrelationId } from '../db.ts';
import { routeRequest, routeResponse, PendingRequest } from '../router.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as crypto from 'crypto';

function mockWsTracked(): { ws: WebSocket; calls: string[] } {
  const calls: string[] = [];
  const ws = { send: (data: string) => { calls.push(data); } } as unknown as WebSocket;
  return { ws, calls };
}

function fakeTimer(): ReturnType<typeof setTimeout> {
  return setTimeout(() => {}, 999999);
}

let db: Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('routeRequest', () => {
  it('ACL_DENIED when no ACL row exists', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    const msgId = crypto.randomUUID();
    const corrId = crypto.randomUUID();
    const result = routeRequest(db, new Map(), 'agent-a', {
      type: 'request', msg_id: msgId, to: 'agent-b', payload: 'ping',
      correlation_id: corrId,
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('ACL_DENIED');
    expect(getMessage(db, msgId)).toBeNull();
  });

  it('AGENT_NOT_FOUND when target does not exist', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    const msgId = crypto.randomUUID();
    const corrId = crypto.randomUUID();
    const result = routeRequest(db, new Map(), 'agent-a', {
      type: 'request', msg_id: msgId, to: 'ghost', payload: 'ping',
      correlation_id: corrId,
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('AGENT_NOT_FOUND');
    expect(getMessage(db, msgId)).toBeNull();
  });

  it('MESSAGE_TOO_LARGE for payload > 1MB', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');
    const msgId = crypto.randomUUID();
    const corrId = crypto.randomUUID();
    const result = routeRequest(db, new Map(), 'agent-a', {
      type: 'request', msg_id: msgId, to: 'agent-b', payload: 'x'.repeat(1_048_577),
      correlation_id: corrId,
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('MESSAGE_TOO_LARGE');
    expect(getMessage(db, msgId)).toBeNull();
  });

  it('online delivery — stores with kind=request and correlation_id, deliver frame sent to recipient WS, message marked delivered', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');
    const { ws, calls } = mockWsTracked();
    const agentIndex = new Map<string, WebSocket>([['agent-b', ws]]);
    const msgId = crypto.randomUUID();
    const corrId = crypto.randomUUID();
    const result = routeRequest(db, agentIndex, 'agent-a', {
      type: 'request', msg_id: msgId, to: 'agent-b', payload: 'query',
      correlation_id: corrId, ttl_ms: 30_000,
    });
    expect(result.ok).toBe(true);
    // Stored with kind=request
    const stored = getMessage(db, msgId);
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('request');
    expect(stored!.correlation_id).toBe(corrId);
    expect(stored!.from_agent).toBe('agent-a');
    expect(stored!.to_agent).toBe('agent-b');
    // Marked delivered
    expect(stored!.delivered_at).not.toBeNull();
    // Deliver frame sent
    expect(calls).toHaveLength(1);
    const frame = JSON.parse(calls[0]);
    expect(frame.type).toBe('deliver');
    expect(frame.kind).toBe('request');
    expect(frame.correlation_id).toBe(corrId);
    expect(frame.from).toBe('agent-a');
    expect(frame.to).toBe('agent-b');
  });

  it('offline queuing — recipient not in agentIndex; message stored undelivered; no WS send', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');
    const msgId = crypto.randomUUID();
    const corrId = crypto.randomUUID();
    const result = routeRequest(db, new Map(), 'agent-a', {
      type: 'request', msg_id: msgId, to: 'agent-b', payload: 'query',
      correlation_id: corrId, ttl_ms: 30_000,
    });
    expect(result.ok).toBe(true);
    const stored = getMessage(db, msgId);
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('request');
    expect(stored!.delivered_at).toBeNull();
  });

  it('TTL=0 offline — message not stored, returns ok', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');
    const msgId = crypto.randomUUID();
    const corrId = crypto.randomUUID();
    const result = routeRequest(db, new Map(), 'agent-a', {
      type: 'request', msg_id: msgId, to: 'agent-b', payload: 'query',
      correlation_id: corrId, ttl_ms: 0,
    });
    expect(result.ok).toBe(true);
    expect(getMessage(db, msgId)).toBeNull();
  });
});

describe('routeResponse', () => {
  it('CORRELATION_NOT_FOUND for unknown correlation_id', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    const pendingRequests = new Map<string, PendingRequest>();
    const result = routeResponse(db, new Map(), 'agent-a', {
      type: 'response', msg_id: crypto.randomUUID(), correlation_id: crypto.randomUUID(), payload: 'pong',
    }, pendingRequests);
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('CORRELATION_NOT_FOUND');
  });

  it('ACL_DENIED on responder mismatch — agent other than original to_agent tries to respond', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    registerAgent(db, { id: 'agent-c', token_hash: 'c'.repeat(64), hostname: 'host3' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');
    aclGrant(db, 'agent-a', 'agent-c', 'system');
    // agent-a sends a request to agent-b
    const requestMsgId = crypto.randomUUID();
    const corrId = crypto.randomUUID();
    routeRequest(db, new Map(), 'agent-a', {
      type: 'request', msg_id: requestMsgId, to: 'agent-b', payload: 'query',
      correlation_id: corrId, ttl_ms: 30_000,
    });
    // Set up pending request entry
    const pendingRequests = new Map<string, PendingRequest>([
      [corrId, {
        correlationId: corrId,
        fromAgent: 'agent-a',
        expiresAt: Date.now() + 30_000,
        msgId: requestMsgId,
        timer: fakeTimer(),
      }],
    ]);
    // agent-c tries to respond (impostor)
    const result = routeResponse(db, new Map(), 'agent-c', {
      type: 'response', msg_id: crypto.randomUUID(), correlation_id: corrId, payload: 'pong',
    }, pendingRequests);
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('ACL_DENIED');
  });

  it('MESSAGE_TOO_LARGE — response payload > 1MB returns MESSAGE_TOO_LARGE', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');
    const requestMsgId = crypto.randomUUID();
    const corrId = crypto.randomUUID();
    routeRequest(db, new Map(), 'agent-a', {
      type: 'request', msg_id: requestMsgId, to: 'agent-b', payload: 'query',
      correlation_id: corrId, ttl_ms: 30_000,
    });
    const pendingRequests = new Map<string, PendingRequest>([
      [corrId, {
        correlationId: corrId,
        fromAgent: 'agent-a',
        expiresAt: Date.now() + 30_000,
        msgId: requestMsgId,
        timer: fakeTimer(),
      }],
    ]);
    const result = routeResponse(db, new Map(), 'agent-b', {
      type: 'response', msg_id: crypto.randomUUID(), correlation_id: corrId, payload: 'x'.repeat(1_048_577),
    }, pendingRequests);
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('MESSAGE_TOO_LARGE');
  });

  it('happy path — response stored with kind=response; returns ok with deliverFrame with correct kind and correlation_id', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');
    const requestMsgId = crypto.randomUUID();
    const corrId = crypto.randomUUID();
    routeRequest(db, new Map(), 'agent-a', {
      type: 'request', msg_id: requestMsgId, to: 'agent-b', payload: 'query',
      correlation_id: corrId, ttl_ms: 30_000,
    });
    const pendingRequests = new Map<string, PendingRequest>([
      [corrId, {
        correlationId: corrId,
        fromAgent: 'agent-a',
        expiresAt: Date.now() + 30_000,
        msgId: requestMsgId,
        timer: fakeTimer(),
      }],
    ]);
    const responseMsgId = crypto.randomUUID();
    const result = routeResponse(db, new Map(), 'agent-b', {
      type: 'response', msg_id: responseMsgId, correlation_id: corrId, payload: 'pong',
    }, pendingRequests);
    expect(result.ok).toBe(true);
    expect(result.deliverFrame).toBeDefined();
    const frame = JSON.parse(result.deliverFrame!);
    expect(frame.type).toBe('deliver');
    expect(frame.kind).toBe('response');
    expect(frame.correlation_id).toBe(corrId);
    expect(frame.from).toBe('agent-b');
    expect(frame.to).toBe('agent-a');
    expect(frame.payload).toBe('pong');
    // Stored in DB
    const stored = getMessage(db, responseMsgId);
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('response');
    expect(stored!.correlation_id).toBe(corrId);
    expect(stored!.delivered_at).not.toBeNull();
  });

  it('stale ws in pending — routeResponse returns ok; caller try/catch handles dead socket', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');
    const requestMsgId = crypto.randomUUID();
    const corrId = crypto.randomUUID();
    routeRequest(db, new Map(), 'agent-a', {
      type: 'request', msg_id: requestMsgId, to: 'agent-b', payload: 'query',
      correlation_id: corrId, ttl_ms: 30_000,
    });
    // A "dead" ws that throws on send
    const deadWs = { send: () => { throw new Error('connection closed'); } } as unknown as WebSocket;
    const pendingRequests = new Map<string, PendingRequest>([
      [corrId, {
        correlationId: corrId,
        fromAgent: 'agent-a',
        expiresAt: Date.now() + 30_000,
        msgId: requestMsgId,
        timer: fakeTimer(),
        ws: deadWs,
      }],
    ]);
    const responseMsgId = crypto.randomUUID();
    const result = routeResponse(db, new Map(), 'agent-b', {
      type: 'response', msg_id: responseMsgId, correlation_id: corrId, payload: 'pong',
    }, pendingRequests);
    // routeResponse itself should succeed — caller handles the dead socket
    expect(result.ok).toBe(true);
    expect(result.deliverFrame).toBeDefined();
    // Simulate caller's try/catch
    let threw = false;
    try {
      deadWs.send(result.deliverFrame!);
    } catch (_) {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
