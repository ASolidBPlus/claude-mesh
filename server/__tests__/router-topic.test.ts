import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import {
  openDb,
  registerAgent,
  aclGrant,
  getOrCreateTopic,
  subscribe,
  getAgentSubscriptions,
  getPendingMessages,
  getMessage,
} from '../db.ts';
import {
  routePublish,
  routeSubscribe,
  routeUnsubscribe,
  drainQueue,
  PublishFrame,
  SubscribeFrame,
  UnsubscribeFrame,
} from '../router.ts';

function mockWsTracked(): { ws: WebSocket; calls: string[] } {
  const calls: string[] = [];
  const ws = { send: (data: string) => { calls.push(data); } } as unknown as WebSocket;
  return { ws, calls };
}

function setup(db: Database) {
  registerAgent(db, { id: 'agent-pub', token_hash: 'p'.repeat(64), hostname: 'h1' });
  registerAgent(db, { id: 'agent-sub', token_hash: 's'.repeat(64), hostname: 'h2' });
  aclGrant(db, 'agent-pub', 'agent-sub', 'system');
}

describe('routePublish', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('MESSAGE_TOO_LARGE when payload exceeds 1 MB', () => {
    setup(db);
    const result = routePublish(db, new Map(), 'agent-pub', {
      type: 'publish',
      msg_id: crypto.randomUUID(),
      topic: 'test',
      payload: 'x'.repeat(1_048_577),
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('MESSAGE_TOO_LARGE');
  });

  it('auto-creates topic if it does not exist', () => {
    setup(db);
    const result = routePublish(db, new Map(), 'agent-pub', {
      type: 'publish',
      msg_id: crypto.randomUUID(),
      topic: 'new-topic',
      payload: 'hi',
    });
    expect(result.ok).toBe(true);
    const row = db.prepare('SELECT * FROM topics WHERE name = ?').get('new-topic') as { name: string; created_by: string } | null;
    expect(row).not.toBeNull();
    expect(row!.created_by).toBe('agent-pub');
  });

  it('subscriber with ACL receives deliver frame when online', () => {
    setup(db);
    getOrCreateTopic(db, 'game:moves', 'agent-pub');
    subscribe(db, 'agent-sub', 'game:moves');

    const { ws: mockWs, calls } = mockWsTracked();
    const agentIndex = new Map<string, WebSocket>([['agent-sub', mockWs]]);

    const result = routePublish(db, agentIndex, 'agent-pub', {
      type: 'publish',
      msg_id: crypto.randomUUID(),
      topic: 'game:moves',
      payload: 'move!',
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const frame = JSON.parse(calls[0]);
    expect(frame.type).toBe('deliver');
    expect(frame.kind).toBe('topic');
    expect(frame.topic).toBe('game:moves');
    expect(frame.from).toBe('agent-pub');
    expect(frame.to).toBeNull();

    // Find the message and check delivered_at
    const msgs = db.prepare('SELECT * FROM messages WHERE to_agent = ?').all('agent-sub') as Array<{ id: string; delivered_at: number | null }>;
    expect(msgs).toHaveLength(1);
    const msg = getMessage(db, msgs[0].id);
    expect(msg).not.toBeNull();
    expect(msg!.delivered_at).not.toBeNull();
  });

  it('publisher does not receive their own message', () => {
    setup(db);
    getOrCreateTopic(db, 'game:moves', 'agent-pub');
    subscribe(db, 'agent-pub', 'game:moves');
    subscribe(db, 'agent-sub', 'game:moves');

    const { ws: pubWs, calls: pubCalls } = mockWsTracked();
    const { ws: subWs } = mockWsTracked();
    const agentIndex = new Map<string, WebSocket>([
      ['agent-pub', pubWs],
      ['agent-sub', subWs],
    ]);

    routePublish(db, agentIndex, 'agent-pub', {
      type: 'publish',
      msg_id: crypto.randomUUID(),
      topic: 'game:moves',
      payload: 'move!',
    });

    expect(pubCalls).toHaveLength(0);
  });

  it('subscriber without ACL is skipped', () => {
    setup(db);
    registerAgent(db, { id: 'agent-noacl', token_hash: 'n'.repeat(64), hostname: 'h3' });
    getOrCreateTopic(db, 'game:moves', 'agent-pub');
    subscribe(db, 'agent-noacl', 'game:moves');

    const { ws: noAclWs, calls: noAclCalls } = mockWsTracked();
    const agentIndex = new Map<string, WebSocket>([['agent-noacl', noAclWs]]);

    routePublish(db, agentIndex, 'agent-pub', {
      type: 'publish',
      msg_id: crypto.randomUUID(),
      topic: 'game:moves',
      payload: 'move!',
    });

    expect(noAclCalls).toHaveLength(0);
    const msgs = db.prepare('SELECT * FROM messages WHERE to_agent = ?').all('agent-noacl') as unknown[];
    expect(msgs).toHaveLength(0);
  });

  it('offline subscriber with ACL gets message queued in SQLite', () => {
    setup(db);
    getOrCreateTopic(db, 'game:moves', 'agent-pub');
    subscribe(db, 'agent-sub', 'game:moves');

    const result = routePublish(db, new Map(), 'agent-pub', {
      type: 'publish',
      msg_id: crypto.randomUUID(),
      topic: 'game:moves',
      payload: 'queued!',
    });

    expect(result.ok).toBe(true);
    const pending = getPendingMessages(db, 'agent-sub');
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('topic');
    expect(pending[0].topic).toBe('game:moves');
  });

  it('offline subscriber skipped when ttl_ms=0', () => {
    setup(db);
    getOrCreateTopic(db, 'game:moves', 'agent-pub');
    subscribe(db, 'agent-sub', 'game:moves');

    const result = routePublish(db, new Map(), 'agent-pub', {
      type: 'publish',
      msg_id: crypto.randomUUID(),
      topic: 'game:moves',
      payload: 'ephemeral!',
      ttl_ms: 0,
    });

    expect(result.ok).toBe(true);
    const pending = getPendingMessages(db, 'agent-sub');
    expect(pending).toHaveLength(0);
  });

  it('publish with zero subscribers returns ok', () => {
    registerAgent(db, { id: 'agent-pub', token_hash: 'p'.repeat(64), hostname: 'h1' });
    const result = routePublish(db, new Map(), 'agent-pub', {
      type: 'publish',
      msg_id: crypto.randomUUID(),
      topic: 'empty-topic',
      payload: 'nobody listening',
    });
    expect(result.ok).toBe(true);
  });

  it('pending topic messages are drained on reconnect (drainQueue covers topic kind)', () => {
    setup(db);
    getOrCreateTopic(db, 'game:moves', 'agent-pub');
    subscribe(db, 'agent-sub', 'game:moves');

    // Publish with agent-sub offline
    routePublish(db, new Map(), 'agent-pub', {
      type: 'publish',
      msg_id: crypto.randomUUID(),
      topic: 'game:moves',
      payload: 'queued for drain',
    });

    const pending = getPendingMessages(db, 'agent-sub');
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('topic');

    // Reconnect: drain queue
    const { ws: mockWs, calls } = mockWsTracked();
    const drained = drainQueue(db, 'agent-sub', mockWs);

    expect(drained).toBe(1);
    expect(calls).toHaveLength(1);
    const frame = JSON.parse(calls[0]);
    expect(frame.type).toBe('deliver');
    expect(frame.kind).toBe('topic');

    const afterDrain = getPendingMessages(db, 'agent-sub');
    expect(afterDrain).toHaveLength(0);
  });
});

describe('routeSubscribe', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('subscribe creates topic if it does not exist', () => {
    registerAgent(db, { id: 'agent-sub', token_hash: 's'.repeat(64), hostname: 'h1' });
    const result = routeSubscribe(db, 'agent-sub', { type: 'subscribe', topic: 'new-topic' });
    expect(result.ok).toBe(true);
    const row = db.prepare('SELECT * FROM topics WHERE name = ?').get('new-topic') as { created_by: string } | null;
    expect(row).not.toBeNull();
    expect(row!.created_by).toBe('agent-sub');
    const subs = getAgentSubscriptions(db, 'agent-sub');
    expect(subs).toContain('new-topic');
  });

  it('subscribe is idempotent', () => {
    registerAgent(db, { id: 'agent-sub', token_hash: 's'.repeat(64), hostname: 'h1' });
    const r1 = routeSubscribe(db, 'agent-sub', { type: 'subscribe', topic: 'test-topic' });
    const r2 = routeSubscribe(db, 'agent-sub', { type: 'subscribe', topic: 'test-topic' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const subs = getAgentSubscriptions(db, 'agent-sub');
    expect(subs).toHaveLength(1);
  });

  it('subscribe does not require ACL', () => {
    registerAgent(db, { id: 'agent-pub', token_hash: 'p'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'agent-sub', token_hash: 's'.repeat(64), hostname: 'h2' });
    // No ACL grant
    const result = routeSubscribe(db, 'agent-sub', { type: 'subscribe', topic: 'test' });
    expect(result.ok).toBe(true);
  });
});

describe('routeUnsubscribe', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('TOPIC_NOT_FOUND when topic does not exist', () => {
    registerAgent(db, { id: 'agent-sub', token_hash: 's'.repeat(64), hostname: 'h1' });
    const result = routeUnsubscribe(db, 'agent-sub', { type: 'unsubscribe', topic: 'ghost-topic' });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('TOPIC_NOT_FOUND');
  });

  it('unsubscribe removes subscription', () => {
    registerAgent(db, { id: 'agent-sub', token_hash: 's'.repeat(64), hostname: 'h1' });
    getOrCreateTopic(db, 'game:moves', 'agent-sub');
    subscribe(db, 'agent-sub', 'game:moves');
    const result = routeUnsubscribe(db, 'agent-sub', { type: 'unsubscribe', topic: 'game:moves' });
    expect(result.ok).toBe(true);
    const subs = getAgentSubscriptions(db, 'agent-sub');
    expect(subs).toHaveLength(0);
  });

  it('unsubscribe is idempotent (topic exists but agent not subscribed)', () => {
    registerAgent(db, { id: 'agent-sub', token_hash: 's'.repeat(64), hostname: 'h1' });
    getOrCreateTopic(db, 'game:moves', 'agent-sub');
    // Do NOT subscribe — unsubscribe of non-member is a no-op
    const result = routeUnsubscribe(db, 'agent-sub', { type: 'unsubscribe', topic: 'game:moves' });
    expect(result.ok).toBe(true);
  });
});
