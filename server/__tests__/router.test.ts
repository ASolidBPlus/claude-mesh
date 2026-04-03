import { describe, it, expect, beforeEach } from 'bun:test';
import { openDb, registerAgent, aclGrant, insertMessage, getMessage, getPendingMessages } from '../db.ts';
import { routeDirect, drainQueue, buildDeliverFrame } from '../router.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as crypto from 'crypto';

function mockWs(): WebSocket {
  return { send: (..._args: unknown[]) => {} } as unknown as WebSocket;
}

function mockWsTracked(): { ws: WebSocket; calls: string[] } {
  const calls: string[] = [];
  const ws = { send: (data: string) => { calls.push(data); } } as unknown as WebSocket;
  return { ws, calls };
}

let db: Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('routeDirect', () => {
  it('AGENT_NOT_FOUND when recipient not in registry', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    const msgId = crypto.randomUUID();
    const result = routeDirect(db, new Map(), 'agent-a', {
      type: 'send', msg_id: msgId, to: 'ghost', payload: 'hi',
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('AGENT_NOT_FOUND');
    expect(getMessage(db, msgId)).toBeNull();
  });

  it('ACL_DENIED when no ACL entry', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    const msgId = crypto.randomUUID();
    const result = routeDirect(db, new Map(), 'agent-a', {
      type: 'send', msg_id: msgId, to: 'agent-b', payload: 'hi',
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('ACL_DENIED');
    expect(getMessage(db, msgId)).toBeNull();
  });

  it('MESSAGE_TOO_LARGE when payload exceeds 1 MB', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');
    const msgId = crypto.randomUUID();
    const result = routeDirect(db, new Map(), 'agent-a', {
      type: 'send', msg_id: msgId, to: 'agent-b', payload: 'x'.repeat(1_048_577),
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('MESSAGE_TOO_LARGE');
    expect(getMessage(db, msgId)).toBeNull();
  });

  it('delivers immediately when recipient is online', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');

    const { ws, calls } = mockWsTracked();
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('agent-b', ws);

    const msgId = crypto.randomUUID();
    const result = routeDirect(db, agentIndex, 'agent-a', {
      type: 'send', msg_id: msgId, to: 'agent-b', payload: 'hello',
    });

    expect(result.ok).toBe(true);
    expect(result.msg_id).toBe(msgId);
    expect(calls).toHaveLength(1);

    const frame = JSON.parse(calls[0]);
    expect(frame.type).toBe('deliver');
    expect(frame.msg_id).toBe(msgId);
    expect(frame.from).toBe('agent-a');
    expect(frame.to).toBe('agent-b');

    const msg = getMessage(db, msgId);
    expect(msg).not.toBeNull();
    expect(msg!.delivered_at).not.toBeNull();
  });

  it('stores in queue when recipient is offline', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');

    const msgId = crypto.randomUUID();
    const result = routeDirect(db, new Map(), 'agent-a', {
      type: 'send', msg_id: msgId, to: 'agent-b', payload: 'hello',
    });

    expect(result.ok).toBe(true);
    const msg = getMessage(db, msgId);
    expect(msg).not.toBeNull();
    expect(msg!.delivered_at).toBeNull();
    expect(getPendingMessages(db, 'agent-b')).toHaveLength(1);
  });

  it('ttl_ms=0 and offline recipient skips insertMessage', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');

    const msgId = crypto.randomUUID();
    const result = routeDirect(db, new Map(), 'agent-a', {
      type: 'send', msg_id: msgId, to: 'agent-b', payload: 'hello', ttl_ms: 0,
    });

    expect(result.ok).toBe(true);
    expect(getMessage(db, msgId)).toBeNull();
  });

  it('ttl_ms=0 and online recipient delivers immediately', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');

    const { ws, calls } = mockWsTracked();
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('agent-b', ws);

    const msgId = crypto.randomUUID();
    const result = routeDirect(db, agentIndex, 'agent-a', {
      type: 'send', msg_id: msgId, to: 'agent-b', payload: 'hello', ttl_ms: 0,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const frame = JSON.parse(calls[0]);
    expect(frame.type).toBe('deliver');

    const msg = getMessage(db, msgId);
    expect(msg).not.toBeNull();
    expect(msg!.delivered_at).not.toBeNull();
  });

  it('respects ttl_ms for expires_at', () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');

    const before = Date.now();
    const msgId = crypto.randomUUID();
    routeDirect(db, new Map(), 'agent-a', {
      type: 'send', msg_id: msgId, to: 'agent-b', payload: 'hello', ttl_ms: 60_000,
    });
    const after = Date.now();

    const msg = getMessage(db, msgId);
    expect(msg).not.toBeNull();
    expect(msg!.expires_at).not.toBeNull();
    expect(msg!.expires_at!).toBeGreaterThanOrEqual(before + 60_000);
    expect(msg!.expires_at!).toBeLessThanOrEqual(after + 60_000 + 200);
  });
});

describe('drainQueue', () => {
  it('sends pending messages and marks delivered', () => {
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });

    for (let i = 0; i < 3; i++) {
      insertMessage(db, {
        id: crypto.randomUUID(),
        kind: 'direct',
        from_agent: 'agent-b',
        to_agent: 'agent-b',
        payload: `msg-${i}`,
        sent_at: Date.now(),
        expires_at: null,
      });
    }

    const { ws, calls } = mockWsTracked();
    const count = drainQueue(db, 'agent-b', ws);

    expect(count).toBe(3);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const frame = JSON.parse(call);
      expect(frame.type).toBe('deliver');
    }
    expect(getPendingMessages(db, 'agent-b')).toHaveLength(0);
  });

  it('skips expired messages', () => {
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });

    insertMessage(db, {
      id: crypto.randomUUID(),
      kind: 'direct',
      from_agent: 'agent-b',
      to_agent: 'agent-b',
      payload: 'valid',
      sent_at: Date.now(),
      expires_at: null,
    });
    insertMessage(db, {
      id: crypto.randomUUID(),
      kind: 'direct',
      from_agent: 'agent-b',
      to_agent: 'agent-b',
      payload: 'expired',
      sent_at: Date.now() - 2000,
      expires_at: Date.now() - 1000,
    });

    const { ws, calls } = mockWsTracked();
    const count = drainQueue(db, 'agent-b', ws);

    expect(count).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe('buildDeliverFrame', () => {
  it('correct JSON shape', () => {
    const sample = {
      id: 'test-id',
      kind: 'direct',
      from_agent: 'agent-a',
      to_agent: 'agent-b',
      topic: null,
      correlation_id: null,
      payload: 'hello',
      content_type: 'text/plain',
      sent_at: 1743659280000,
    };

    const result = buildDeliverFrame(sample);
    const frame = JSON.parse(result);

    expect(frame.type).toBe('deliver');
    expect(frame.msg_id).toBe(sample.id);
    expect(frame.kind).toBe(sample.kind);
    expect(frame.from).toBe(sample.from_agent);
    expect(frame.to).toBe(sample.to_agent);
    expect(frame.topic).toBeNull();
    expect(frame.correlation_id).toBeNull();
    expect(frame.payload).toBe(sample.payload);
    expect(frame.content_type).toBe(sample.content_type);
    expect(frame.sent_at).toBe(sample.sent_at);
  });
});
