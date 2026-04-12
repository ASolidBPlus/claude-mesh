import { describe, it, expect, beforeEach } from 'bun:test';
import { openDb, registerAgent, aclGrant, insertMessage, getMessage, getPendingMessages, getFile } from '../db.ts';
import { routeDirect, drainQueue, buildDeliverFrame, routeFile, drainFileQueue, FileSendFrame } from '../router.ts';
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

// ──────────────────────────────────────────────
// routeFile / drainFileQueue
// ──────────────────────────────────────────────

function makeFileSendFrame(overrides: Partial<FileSendFrame> = {}): FileSendFrame {
  const data = Buffer.from('test file content').toString('base64');
  return {
    type: 'file_send',
    msg_id: crypto.randomUUID(),
    to: 'agent-b',
    filename: 'output.log',
    content_type: 'text/plain',
    data,
    ...overrides,
  };
}

describe('routeFile', () => {
  it('happy path — recipient online: file_deliver pushed to WS and delivered_at set', () => {
    registerAgent(db, { id: 'file-sender', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'file-recv', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(db, 'file-sender', 'file-recv', 'system');

    const calls: string[] = [];
    const mockWs = { send: (d: string) => calls.push(d) } as unknown as WebSocket;
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('file-recv', mockWs);

    const frame = makeFileSendFrame({ to: 'file-recv' });
    const result = routeFile(db, agentIndex, 'file-sender', frame, 10_485_760);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const delivered = JSON.parse(calls[0]);
    expect(delivered.type).toBe('file_deliver');
    expect(delivered.filename).toBe('output.log');
    expect(delivered.from).toBe('file-sender');
    expect(delivered.to).toBe('file-recv');

    // delivered_at should be set
    const storedFile = db.prepare('SELECT * FROM files WHERE from_agent = ?').get('file-sender') as { id: string; delivered_at: number | null } | null;
    expect(storedFile).not.toBeNull();
    expect(storedFile!.delivered_at).not.toBeNull();
  });

  it('happy path — recipient offline: file stored with delivered_at = null', () => {
    registerAgent(db, { id: 'off-sender', token_hash: 'c'.repeat(64), hostname: 'h3' });
    registerAgent(db, { id: 'off-recv', token_hash: 'd'.repeat(64), hostname: 'h4' });
    aclGrant(db, 'off-sender', 'off-recv', 'system');

    const frame = makeFileSendFrame({ to: 'off-recv' });
    const result = routeFile(db, new Map(), 'off-sender', frame, 10_485_760);

    expect(result.ok).toBe(true);
    const storedFile = db.prepare('SELECT * FROM files WHERE from_agent = ?').get('off-sender') as { delivered_at: number | null } | null;
    expect(storedFile).not.toBeNull();
    expect(storedFile!.delivered_at).toBeNull();
  });

  it('ACL_DENIED when no ACL entry', () => {
    registerAgent(db, { id: 'acl-sender', token_hash: 'e'.repeat(64), hostname: 'h5' });
    registerAgent(db, { id: 'acl-recv', token_hash: 'f'.repeat(64), hostname: 'h6' });

    const frame = makeFileSendFrame({ to: 'acl-recv' });
    const result = routeFile(db, new Map(), 'acl-sender', frame, 10_485_760);

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('ACL_DENIED');
  });

  it('AGENT_NOT_FOUND when recipient not in registry', () => {
    registerAgent(db, { id: 'anf-sender', token_hash: 'g'.repeat(64), hostname: 'h7' });

    const frame = makeFileSendFrame({ to: 'ghost-agent' });
    const result = routeFile(db, new Map(), 'anf-sender', frame, 10_485_760);

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('AGENT_NOT_FOUND');
  });

  it('FILE_TOO_LARGE when decoded size exceeds maxFileBytes', () => {
    registerAgent(db, { id: 'big-sender', token_hash: 'h'.repeat(64), hostname: 'h8' });
    registerAgent(db, { id: 'big-recv', token_hash: 'i'.repeat(64), hostname: 'h9' });
    aclGrant(db, 'big-sender', 'big-recv', 'system');

    // Create data that decodes to > 10 bytes
    const bigData = Buffer.alloc(100, 'x').toString('base64');
    const frame = makeFileSendFrame({ to: 'big-recv', data: bigData });
    const result = routeFile(db, new Map(), 'big-sender', frame, 10);

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('FILE_TOO_LARGE');
  });

  it('INVALID_BASE64 when data is not valid base64', () => {
    registerAgent(db, { id: 'inv-sender', token_hash: 'j'.repeat(64), hostname: 'h10' });
    registerAgent(db, { id: 'inv-recv', token_hash: 'k'.repeat(64), hostname: 'h11' });
    aclGrant(db, 'inv-sender', 'inv-recv', 'system');

    const frame = makeFileSendFrame({ to: 'inv-recv', data: 'not!valid@base64#' });
    const result = routeFile(db, new Map(), 'inv-sender', frame, 10_485_760);

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('INVALID_BASE64');
  });

  it('ttl_ms 0 and recipient offline: file is NOT stored', () => {
    registerAgent(db, { id: 'ttl-sender', token_hash: 'l'.repeat(64), hostname: 'h12' });
    registerAgent(db, { id: 'ttl-recv', token_hash: 'm'.repeat(64), hostname: 'h13' });
    aclGrant(db, 'ttl-sender', 'ttl-recv', 'system');

    const frame = makeFileSendFrame({ to: 'ttl-recv', ttl_ms: 0 });
    const result = routeFile(db, new Map(), 'ttl-sender', frame, 10_485_760);

    expect(result.ok).toBe(true);
    const storedFile = db.prepare('SELECT * FROM files WHERE from_agent = ?').get('ttl-sender');
    expect(storedFile).toBeNull();
  });

  it('routeFile with caption — caption appears in file_deliver frame', () => {
    registerAgent(db, { id: 'cap-sender', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'cap-recv', token_hash: 'b'.repeat(64), hostname: 'h2' });
    aclGrant(db, 'cap-sender', 'cap-recv', 'system');

    const calls: string[] = [];
    const ws = { send: (d: string) => calls.push(d) } as unknown as WebSocket;
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('cap-recv', ws);

    const frame = makeFileSendFrame({ to: 'cap-recv', caption: 'my caption' });
    const result = routeFile(db, agentIndex, 'cap-sender', frame, 10_485_760);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const delivered = JSON.parse(calls[0]);
    expect(delivered.type).toBe('file_deliver');
    expect(delivered.caption).toBe('my caption');
  });

  it('routeFile with reply_to_msg_id — reply_to_msg_id appears in file_deliver frame', () => {
    registerAgent(db, { id: 'rpl-sender', token_hash: 'c'.repeat(64), hostname: 'h3' });
    registerAgent(db, { id: 'rpl-recv', token_hash: 'd'.repeat(64), hostname: 'h4' });
    aclGrant(db, 'rpl-sender', 'rpl-recv', 'system');

    const calls: string[] = [];
    const ws = { send: (d: string) => calls.push(d) } as unknown as WebSocket;
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('rpl-recv', ws);

    const replyId = crypto.randomUUID();
    const frame = makeFileSendFrame({ to: 'rpl-recv', reply_to_msg_id: replyId });
    const result = routeFile(db, agentIndex, 'rpl-sender', frame, 10_485_760);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const delivered = JSON.parse(calls[0]);
    expect(delivered.type).toBe('file_deliver');
    expect(delivered.reply_to_msg_id).toBe(replyId);
  });

  it('routeFile with caption exceeding 4096 bytes — returns CAPTION_TOO_LARGE', () => {
    registerAgent(db, { id: 'bigcap-sender', token_hash: 'e'.repeat(64), hostname: 'h5' });
    registerAgent(db, { id: 'bigcap-recv', token_hash: 'f'.repeat(64), hostname: 'h6' });
    aclGrant(db, 'bigcap-sender', 'bigcap-recv', 'system');

    const frame = makeFileSendFrame({ to: 'bigcap-recv', caption: 'x'.repeat(4097) });
    const result = routeFile(db, new Map(), 'bigcap-sender', frame, 10_485_760);

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('CAPTION_TOO_LARGE');
  });

  it('routeFile without caption — caption is null in file_deliver and DB', () => {
    registerAgent(db, { id: 'nocap-sender', token_hash: 'g'.repeat(64), hostname: 'h7' });
    registerAgent(db, { id: 'nocap-recv', token_hash: 'h'.repeat(64), hostname: 'h8' });
    aclGrant(db, 'nocap-sender', 'nocap-recv', 'system');

    const calls: string[] = [];
    const ws = { send: (d: string) => calls.push(d) } as unknown as WebSocket;
    const agentIndex = new Map<string, WebSocket>();
    agentIndex.set('nocap-recv', ws);

    const frame = makeFileSendFrame({ to: 'nocap-recv' });
    const result = routeFile(db, agentIndex, 'nocap-sender', frame, 10_485_760);

    expect(result.ok).toBe(true);
    const delivered = JSON.parse(calls[0]);
    expect(delivered.caption).toBeNull();

    const storedFile = db.prepare('SELECT caption FROM files WHERE from_agent = ?').get('nocap-sender') as { caption: string | null };
    expect(storedFile.caption).toBeNull();
  });
});

describe('drainFileQueue', () => {
  it('delivers queued files on reconnect and sets delivered_at', () => {
    registerAgent(db, { id: 'drain-sender', token_hash: 'n'.repeat(64), hostname: 'h14' });
    registerAgent(db, { id: 'drain-recv', token_hash: 'o'.repeat(64), hostname: 'h15' });
    aclGrant(db, 'drain-sender', 'drain-recv', 'system');

    // Store file while offline
    const frame = makeFileSendFrame({ to: 'drain-recv' });
    routeFile(db, new Map(), 'drain-sender', frame, 10_485_760);

    // Confirm not delivered yet
    const stored = db.prepare('SELECT * FROM files WHERE from_agent = ?').get('drain-sender') as { id: string; delivered_at: number | null };
    expect(stored.delivered_at).toBeNull();

    // Now drain
    const calls: string[] = [];
    const mockWs = { send: (d: string) => calls.push(d) } as unknown as WebSocket;
    const count = drainFileQueue(db, 'drain-recv', mockWs);

    expect(count).toBe(1);
    expect(calls).toHaveLength(1);
    const frame2 = JSON.parse(calls[0]);
    expect(frame2.type).toBe('file_deliver');

    // delivered_at now set
    const updated = getFile(db, stored.id);
    expect(updated!.delivered_at).not.toBeNull();
  });

  it('drainFileQueue includes caption and reply_to_msg_id from stored files', () => {
    registerAgent(db, { id: 'drain2-sender', token_hash: 'p'.repeat(64), hostname: 'h16' });
    registerAgent(db, { id: 'drain2-recv', token_hash: 'q'.repeat(64), hostname: 'h17' });
    aclGrant(db, 'drain2-sender', 'drain2-recv', 'system');

    const replyId = crypto.randomUUID();
    const frame = makeFileSendFrame({ to: 'drain2-recv', caption: 'drain caption', reply_to_msg_id: replyId });
    routeFile(db, new Map(), 'drain2-sender', frame, 10_485_760);

    const calls: string[] = [];
    const ws = { send: (d: string) => calls.push(d) } as unknown as WebSocket;
    const count = drainFileQueue(db, 'drain2-recv', ws);

    expect(count).toBe(1);
    const delivered = JSON.parse(calls[0]);
    expect(delivered.caption).toBe('drain caption');
    expect(delivered.reply_to_msg_id).toBe(replyId);
  });
});
