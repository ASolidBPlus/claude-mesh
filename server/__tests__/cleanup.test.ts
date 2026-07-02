import { describe, it, expect } from 'bun:test';
import { openDb, registerAgent, aclGrant, insertMessage, markDelivered, getMessage, insertFile, getFile } from '../db.ts';
import { startCleanup } from '../cleanup.ts';
import { WebSocket } from 'ws';
import { PendingRequest } from '../router.ts';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('cleanup', () => {
  it('#34: does NOT delete on expiry when retention is unset (expiry only gates deliverability)', async () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');

    const pastExpiry = Date.now() - 5000;

    // delivered + expired (the data-loss case that used to be erased)
    const msg1 = insertMessage(db, { id: 'msg-delivered-exp', kind: 'direct', from_agent: 'agent-a', to_agent: 'agent-b', payload: 'hello', sent_at: Date.now() - 10000, expires_at: pastExpiry });
    markDelivered(db, msg1.id);
    // undelivered + expired
    const msg2 = insertMessage(db, { id: 'msg-undelivered-exp', kind: 'direct', from_agent: 'agent-a', to_agent: 'agent-b', payload: 'hello2', sent_at: Date.now() - 10000, expires_at: pastExpiry });
    // no expiry
    const msg3 = insertMessage(db, { id: 'msg-no-expiry', kind: 'direct', from_agent: 'agent-a', to_agent: 'agent-b', payload: 'hello3', sent_at: Date.now(), expires_at: null });

    const handle = startCleanup(db, new Map<string, PendingRequest>(), new Map<string, WebSocket>(), 50);
    await wait(100);
    handle.stop();

    // #34: retention unset → cleanup deletes nothing; all rows survive as history.
    expect(getMessage(db, msg1.id)).not.toBeNull();
    expect(getMessage(db, msg2.id)).not.toBeNull();
    expect(getMessage(db, msg3.id)).not.toBeNull();

    db.close();
  });

  it('#34: retention sweep removes old delivered/expired rows but keeps still-deliverable pending mail', async () => {
    const db = openDb(':memory:');
    const old = Date.now() - 100_000;

    const delivered = insertMessage(db, { id: 'ret-delivered', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'x', sent_at: old, expires_at: null });
    markDelivered(db, delivered.id);
    const expired = insertMessage(db, { id: 'ret-expired', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'y', sent_at: old, expires_at: Date.now() - 5000 });
    // undelivered ttl:null older than retention → still deliverable → must survive
    const pending = insertMessage(db, { id: 'ret-pending', kind: 'direct', from_agent: 'a', to_agent: 'b', payload: 'z', sent_at: old, expires_at: null });

    // retentionMs=1 → everything older than ~now is eligible (except deliverable)
    const handle = startCleanup(db, new Map<string, PendingRequest>(), new Map<string, WebSocket>(), 50, 1);
    await wait(100);
    handle.stop();

    expect(getMessage(db, delivered.id)).toBeNull();
    expect(getMessage(db, expired.id)).toBeNull();
    expect(getMessage(db, pending.id)).not.toBeNull();

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

  it('cleanup tick calls deleteExpiredFiles — expired file is removed from DB and disk', async () => {
    const db = openDb(':memory:');
    const pendingRequests = new Map<string, PendingRequest>();
    const agentIndex = new Map<string, WebSocket>();

    const tempDir = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    const filePath = join(tempDir, 'cleanup-expired-file');
    writeFileSync(filePath, 'x');

    const fileId = 'cleanup-expired-file';
    insertFile(db, {
      id: fileId,
      from_agent: 'a',
      to_agent: 'b',
      filename: 'old.txt',
      content_type: 'text/plain',
      size_bytes: 1,
      file_path: filePath,
      sent_at: Date.now() - 10000,
      expires_at: Date.now() - 5000,
    });

    expect(existsSync(filePath)).toBe(true);

    const handle = startCleanup(db, pendingRequests, agentIndex, 50);
    await wait(100);
    handle.stop();

    expect(getFile(db, fileId)).toBeNull();
    expect(existsSync(filePath)).toBe(false);

    db.close();
  });
});
