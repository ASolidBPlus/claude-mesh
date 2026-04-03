import { describe, it, expect } from 'bun:test';
import { openDb, registerAgent, aclGrant, insertMessage, getMessage } from '../db.ts';
import { startCleanup } from '../cleanup.ts';
import { WebSocket } from 'ws';
import { PendingRequest } from '../router.ts';

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('cleanup', () => {
  it('expires messages and logs count', async () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');

    const pastExpiry = Date.now() - 5000;
    const noExpiry = null;

    const msg1 = insertMessage(db, {
      id: 'msg-expired-1',
      kind: 'direct',
      from_agent: 'agent-a',
      to_agent: 'agent-b',
      payload: 'hello',
      sent_at: Date.now() - 10000,
      expires_at: pastExpiry,
    });

    const msg2 = insertMessage(db, {
      id: 'msg-expired-2',
      kind: 'direct',
      from_agent: 'agent-a',
      to_agent: 'agent-b',
      payload: 'hello2',
      sent_at: Date.now() - 10000,
      expires_at: pastExpiry,
    });

    const msg3 = insertMessage(db, {
      id: 'msg-no-expiry',
      kind: 'direct',
      from_agent: 'agent-a',
      to_agent: 'agent-b',
      payload: 'hello3',
      sent_at: Date.now(),
      expires_at: noExpiry,
    });

    const pendingRequests = new Map<string, PendingRequest>();
    const agentIndex = new Map<string, WebSocket>();

    const handle = startCleanup(db, pendingRequests, agentIndex, 50);
    await wait(100);
    handle.stop();

    expect(getMessage(db, msg1.id)).toBeNull();
    expect(getMessage(db, msg2.id)).toBeNull();
    expect(getMessage(db, msg3.id)).not.toBeNull();

    db.close();
  });

  it('fires reject on expired pending requests', async () => {
    const db = openDb(':memory:');
    const pendingRequests = new Map<string, PendingRequest>();
    const agentIndex = new Map<string, WebSocket>();

    let rejectCalled = false;
    let rejectError: Error | null = null;

    const correlationId = 'test-corr-id';
    const entry: PendingRequest = {
      correlationId,
      fromAgent: 'agent-a',
      expiresAt: Date.now() - 1000,
      msgId: 'msg-1',
      timer: setTimeout(() => {}, 999999),
      reject: (err: Error) => {
        rejectCalled = true;
        rejectError = err;
      },
    };
    pendingRequests.set(correlationId, entry);

    const handle = startCleanup(db, pendingRequests, agentIndex, 50);
    await wait(100);
    handle.stop();

    expect(rejectCalled).toBe(true);
    expect(rejectError).not.toBeNull();
    expect(rejectError!.message).toBe('REQUEST_TIMEOUT');
    expect(pendingRequests.has(correlationId)).toBe(false);

    db.close();
  });

  it('sends WS error frame on expired pending requests with open socket', async () => {
    const db = openDb(':memory:');
    const pendingRequests = new Map<string, PendingRequest>();
    const agentIndex = new Map<string, WebSocket>();

    let sendCalled = false;
    let sentData: string = '';

    const mockWs = {
      readyState: WebSocket.OPEN,
      send(data: string) {
        sendCalled = true;
        sentData = data;
      },
    } as unknown as WebSocket;

    const correlationId = 'ws-corr-id';
    const entry: PendingRequest = {
      correlationId,
      fromAgent: 'agent-a',
      expiresAt: Date.now() - 1000,
      msgId: 'msg-2',
      timer: setTimeout(() => {}, 999999),
      ws: mockWs,
    };
    pendingRequests.set(correlationId, entry);

    const handle = startCleanup(db, pendingRequests, agentIndex, 50);
    await wait(100);
    handle.stop();

    expect(sendCalled).toBe(true);
    const parsed = JSON.parse(sentData) as Record<string, unknown>;
    expect(parsed.type).toBe('error');
    expect(parsed.code).toBe('REQUEST_TIMEOUT');

    db.close();
  });

  it('stop() prevents further ticks', async () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'stop-agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'stop-agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'stop-agent-a', 'stop-agent-b', 'system');

    const pendingRequests = new Map<string, PendingRequest>();
    const agentIndex = new Map<string, WebSocket>();

    const handle = startCleanup(db, pendingRequests, agentIndex, 50);
    handle.stop();

    const msg = insertMessage(db, {
      id: 'stop-test-msg',
      kind: 'direct',
      from_agent: 'stop-agent-a',
      to_agent: 'stop-agent-b',
      payload: 'test',
      sent_at: Date.now() - 10000,
      expires_at: Date.now() - 5000,
    });

    await wait(100);

    expect(getMessage(db, msg.id)).not.toBeNull();

    db.close();
  });
});
